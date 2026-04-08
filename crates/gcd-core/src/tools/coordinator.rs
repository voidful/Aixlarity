// GemiClawDex — Coordinator Tool
//
// Delegates bounded sub-tasks to nested agents. Inspired by Claude Code's
// sub-agents and open-multi-agent's dependency-aware orchestration, while
// keeping the Rust core small and offline-testable.

use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;

use crate::agent::{run_agent, AgentEvent, AgentRunOptions, PermissionLevel, TokenUsage};
use crate::plugins::plugin_tools_from_definitions;

use super::{embed_tool_events, take_embedded_tool_events, Tool, ToolContext};

/// Default turns per delegated sub-agent.
const DEFAULT_SUB_AGENT_MAX_TURNS: usize = 5;
/// Maximum turns a sub-agent can take.
const SUB_AGENT_MAX_TURNS: usize = 10;
/// Maximum nested delegation depth.
const MAX_DEPTH: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
enum CoordinatorStrategy {
    Auto,
    Sequential,
    Parallel,
}

impl CoordinatorStrategy {
    fn parse(raw: Option<&str>) -> anyhow::Result<Self> {
        match raw.unwrap_or("auto") {
            "auto" => Ok(Self::Auto),
            "sequential" => Ok(Self::Sequential),
            "parallel" => Ok(Self::Parallel),
            other => anyhow::bail!(
                "strategy must be one of: auto, sequential, parallel (got {})",
                other
            ),
        }
    }

    fn uses_parallel_batches(&self, task_count: usize) -> bool {
        match self {
            Self::Auto => task_count > 1,
            Self::Sequential => false,
            Self::Parallel => task_count > 1,
        }
    }

    fn label(&self, task_count: usize, has_dependencies: bool) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::Parallel if has_dependencies => "parallel_batches",
            Self::Parallel => "parallel",
            Self::Auto if task_count <= 1 => "single",
            Self::Auto if has_dependencies => "parallel_batches",
            Self::Auto => "parallel",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CoordinatorTaskSpec {
    name: String,
    task: String,
    depends_on: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CoordinatorRequest {
    tasks: Vec<CoordinatorTaskSpec>,
    max_turns: usize,
    strategy: CoordinatorStrategy,
    shared_context: Option<String>,
    max_concurrency: usize,
}

#[derive(Clone, Debug)]
struct DelegationRuntime {
    provider: crate::providers::ProviderProfile,
    api_key: String,
    permission: PermissionLevel,
    fallback_providers: Vec<(crate::providers::ProviderProfile, String)>,
    plugin_definitions: Vec<crate::plugins::PluginDefinition>,
    workspace_root: std::path::PathBuf,
    sandbox: crate::config::SandboxPolicy,
    parent_context: Option<String>,
    next_depth: usize,
}

impl DelegationRuntime {
    fn from_context(ctx: &ToolContext) -> anyhow::Result<Self> {
        if ctx.coordinator_depth >= MAX_DEPTH {
            anyhow::bail!(
                "Maximum coordinator depth ({}) reached. Sub-agents cannot spawn further sub-agents at this depth.",
                MAX_DEPTH
            );
        }

        let provider = ctx.coordinator_provider.as_ref().cloned().ok_or_else(|| {
            anyhow::anyhow!("Coordinator requires provider configuration in context")
        })?;
        let api_key = ctx
            .coordinator_api_key
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Coordinator requires API key in context"))?;

        Ok(Self {
            provider,
            api_key,
            permission: ctx
                .coordinator_permission
                .clone()
                .unwrap_or(PermissionLevel::AutoEdit),
            fallback_providers: ctx.coordinator_fallback_providers.clone(),
            plugin_definitions: ctx.coordinator_plugin_definitions.clone(),
            workspace_root: ctx.workspace_root.clone(),
            sandbox: ctx.sandbox.clone(),
            parent_context: ctx.coordinator_prompt_context.clone(),
            next_depth: ctx.coordinator_depth + 1,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
struct DelegatedTaskResult {
    name: String,
    task: String,
    status: String,
    depends_on: Vec<String>,
    response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    turns_used: usize,
    tool_calls: Vec<String>,
    token_usage: TokenUsage,
}

pub struct CoordinatorTool;

#[async_trait::async_trait]
impl Tool for CoordinatorTool {
    fn name(&self) -> &str {
        "spawn_agent"
    }

    fn description(&self) -> &str {
        "Spawn one or more sub-agents for bounded delegation. Supports single tasks, dependency-aware task batches, and parallel execution for independent work."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "A clear, self-contained task description for a single sub-agent"
                },
                "tasks": {
                    "type": "array",
                    "description": "Optional task batch. Each task may depend on earlier task names.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "Stable task name used by depends_on" },
                            "task": { "type": "string", "description": "Delegated task description" },
                            "depends_on": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Names of prerequisite tasks"
                            }
                        },
                        "required": ["task"]
                    }
                },
                "strategy": {
                    "type": "string",
                    "enum": ["auto", "sequential", "parallel"],
                    "description": "Execution strategy for task batches"
                },
                "shared_context": {
                    "type": "string",
                    "description": "Additional coordination context shared with every sub-agent"
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Maximum turns per sub-agent (default: 5, max: 10)"
                },
                "max_concurrency": {
                    "type": "integer",
                    "description": "Maximum concurrent sub-agents to run in a ready batch"
                }
            }
        })
    }

    fn take_output_events(&self, result: &mut Value) -> Vec<AgentEvent> {
        take_embedded_tool_events(result)
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let request = parse_request(&params)?;
        let runtime = DelegationRuntime::from_context(ctx)?;
        let has_dependencies = request.tasks.iter().any(|task| !task.depends_on.is_empty());
        let execution_mode = request
            .strategy
            .label(request.tasks.len(), has_dependencies)
            .to_string();
        let batches = build_batches(
            &request.tasks,
            request.strategy.uses_parallel_batches(request.tasks.len()),
        )?;

        eprintln!(
            "\x1b[35m🤖 Delegating {} task(s) with {} strategy (depth {}/{})...\x1b[0m",
            request.tasks.len(),
            execution_mode,
            runtime.next_depth,
            MAX_DEPTH
        );

        let mut completed_results = HashMap::new();
        let mut ordered_results = Vec::new();
        let mut unavailable_tasks = HashSet::new();
        let mut aggregate_usage = TokenUsage::default();
        let mut emitted_events = vec![AgentEvent::CoordinatorStarted {
            depth: runtime.next_depth,
            execution_mode: execution_mode.clone(),
            task_count: request.tasks.len(),
            max_concurrency: request.max_concurrency,
        }];

        for (batch_index, batch) in batches.iter().enumerate() {
            let batch_number = batch_index + 1;
            let batch_task_names = batch
                .iter()
                .map(|task| task.name.clone())
                .collect::<Vec<_>>();
            eprintln!(
                "\x1b[2m[Coordinator batch {}/{}] {}\x1b[0m",
                batch_number,
                batches.len(),
                batch_task_names.join(", ")
            );
            emitted_events.push(AgentEvent::CoordinatorBatchStarted {
                depth: runtime.next_depth,
                batch: batch_number,
                total_batches: batches.len(),
                tasks: batch_task_names,
            });

            let mut runnable = Vec::new();
            for task in batch {
                let blockers = task
                    .depends_on
                    .iter()
                    .filter(|dep| unavailable_tasks.contains(dep.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();

                if blockers.is_empty() {
                    runnable.push(task.clone());
                    continue;
                }

                let result = blocked_result(task, blockers);
                emitted_events.push(AgentEvent::CoordinatorTaskBlocked {
                    depth: runtime.next_depth,
                    batch: batch_number,
                    task_name: task.name.clone(),
                    blocked_by: result
                        .error
                        .as_deref()
                        .map(parse_blocked_dependencies)
                        .unwrap_or_default(),
                });
                unavailable_tasks.insert(task.name.clone());
                completed_results.insert(task.name.clone(), result.clone());
                ordered_results.push(result);
            }

            if runnable.is_empty() {
                continue;
            }

            emitted_events.extend(
                runnable
                    .iter()
                    .map(|task| AgentEvent::CoordinatorTaskStarted {
                        depth: runtime.next_depth,
                        batch: batch_number,
                        task_name: task.name.clone(),
                        depends_on: task.depends_on.clone(),
                    }),
            );

            for chunk in runnable.chunks(request.max_concurrency) {
                let futures = chunk.iter().map(|task| {
                    let dependency_context = build_dependency_context(task, &completed_results);
                    run_delegated_task(
                        task.clone(),
                        dependency_context,
                        request.shared_context.clone(),
                        request.max_turns,
                        runtime.clone(),
                    )
                });

                for result in join_all(futures).await {
                    if result.status != "completed" {
                        unavailable_tasks.insert(result.name.clone());
                    }

                    accumulate_usage(&mut aggregate_usage, &result.token_usage);
                    emitted_events.push(AgentEvent::CoordinatorTaskCompleted {
                        depth: runtime.next_depth,
                        batch: batch_number,
                        task_name: result.name.clone(),
                        status: result.status.clone(),
                        turns_used: result.turns_used,
                        tool_call_count: result.tool_calls.len(),
                        total_tokens: result.token_usage.total_tokens,
                        summary: delegated_result_summary(&result),
                    });
                    completed_results.insert(result.name.clone(), result.clone());
                    ordered_results.push(result);
                }
            }
        }

        let completed_count = ordered_results
            .iter()
            .filter(|result| result.status == "completed")
            .count();
        let failed_count = ordered_results
            .iter()
            .filter(|result| result.status == "failed")
            .count();
        let blocked_count = ordered_results
            .iter()
            .filter(|result| result.status == "blocked")
            .count();

        emitted_events.push(AgentEvent::CoordinatorCompleted {
            depth: runtime.next_depth,
            execution_mode: execution_mode.clone(),
            completed_count,
            failed_count,
            blocked_count,
            total_tokens: aggregate_usage.total_tokens,
            api_calls: aggregate_usage.api_calls,
        });

        Ok(embed_tool_events(
            serde_json::json!({
                "status": if failed_count == 0 && blocked_count == 0 {
                    "completed"
                } else {
                    "completed_with_issues"
                },
                "execution_mode": execution_mode,
                "depth": runtime.next_depth,
                "task_count": request.tasks.len(),
                "completed_count": completed_count,
                "failed_count": failed_count,
                "blocked_count": blocked_count,
                "batches": batches
                    .iter()
                    .map(|batch| batch.iter().map(|task| task.name.clone()).collect::<Vec<_>>())
                    .collect::<Vec<_>>(),
                "tasks": ordered_results,
                "response": render_aggregate_response(&completed_results, &request.tasks),
                "token_usage": aggregate_usage,
                "inherited_runtime": {
                    "fallback_provider_count": runtime.fallback_providers.len(),
                    "plugin_tool_count": runtime.plugin_definitions.len(),
                    "has_parent_context": runtime.parent_context.is_some(),
                }
            }),
            emitted_events,
        ))
    }
}

fn parse_request(params: &Value) -> anyhow::Result<CoordinatorRequest> {
    let strategy = CoordinatorStrategy::parse(params.get("strategy").and_then(Value::as_str))?;
    let shared_context = params
        .get("shared_context")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let max_turns = params
        .get("max_turns")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_SUB_AGENT_MAX_TURNS)
        .min(SUB_AGENT_MAX_TURNS);

    let tasks = match (
        params.get("task").and_then(Value::as_str),
        params.get("tasks").and_then(Value::as_array),
    ) {
        (Some(_), Some(_)) => {
            anyhow::bail!("Provide either 'task' or 'tasks', not both");
        }
        (Some(task), None) => vec![CoordinatorTaskSpec {
            name: params
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("task_1")
                .to_string(),
            task: task.trim().to_string(),
            depends_on: Vec::new(),
        }],
        (None, Some(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| parse_task_spec(item, index))
            .collect::<anyhow::Result<Vec<_>>>()?,
        (None, None) => anyhow::bail!("Either 'task' or 'tasks' is required"),
    };

    validate_tasks(&tasks)?;

    let max_concurrency = params
        .get("max_concurrency")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(tasks.len().max(1))
        .clamp(1, tasks.len().max(1));

    Ok(CoordinatorRequest {
        tasks,
        max_turns,
        strategy,
        shared_context,
        max_concurrency,
    })
}

fn parse_task_spec(item: &Value, index: usize) -> anyhow::Result<CoordinatorTaskSpec> {
    let object = item
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("tasks[{}] must be an object", index))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| object.get("title").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("task_{}", index + 1));
    let task = object
        .get("task")
        .and_then(Value::as_str)
        .or_else(|| object.get("description").and_then(Value::as_str))
        .or_else(|| object.get("prompt").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("tasks[{}].task is required", index))?
        .to_string();

    let depends_value = object
        .get("depends_on")
        .or_else(|| object.get("dependsOn"))
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let depends_on = depends_value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("tasks[{}].depends_on must be an array", index))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| {
                    anyhow::anyhow!("tasks[{}].depends_on values must be strings", index)
                })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(CoordinatorTaskSpec {
        name,
        task,
        depends_on,
    })
}

fn validate_tasks(tasks: &[CoordinatorTaskSpec]) -> anyhow::Result<()> {
    if tasks.is_empty() {
        anyhow::bail!("At least one delegated task is required");
    }

    let mut seen = HashSet::new();
    for task in tasks {
        if task.task.trim().is_empty() {
            anyhow::bail!("Task '{}' cannot be empty", task.name);
        }
        if !seen.insert(task.name.clone()) {
            anyhow::bail!("Duplicate delegated task name '{}'", task.name);
        }
        if task.depends_on.iter().any(|dep| dep == &task.name) {
            anyhow::bail!("Task '{}' cannot depend on itself", task.name);
        }
    }

    let available = tasks
        .iter()
        .map(|task| task.name.as_str())
        .collect::<HashSet<_>>();
    for task in tasks {
        for dependency in &task.depends_on {
            if !available.contains(dependency.as_str()) {
                anyhow::bail!(
                    "Task '{}' depends on unknown task '{}'",
                    task.name,
                    dependency
                );
            }
        }
    }

    Ok(())
}

fn build_batches(
    tasks: &[CoordinatorTaskSpec],
    parallel_batches: bool,
) -> anyhow::Result<Vec<Vec<CoordinatorTaskSpec>>> {
    let mut batches = Vec::new();
    let mut emitted = HashSet::new();
    let mut remaining_dependencies = tasks
        .iter()
        .map(|task| task.depends_on.iter().cloned().collect::<HashSet<_>>())
        .collect::<Vec<_>>();

    while emitted.len() < tasks.len() {
        let ready = tasks
            .iter()
            .enumerate()
            .filter(|(index, _)| {
                !emitted.contains(index) && remaining_dependencies[*index].is_empty()
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();

        if ready.is_empty() {
            anyhow::bail!("Delegated task graph contains a cycle");
        }

        let selected = if parallel_batches {
            ready
        } else {
            vec![ready[0]]
        };

        for index in &selected {
            emitted.insert(*index);
            let finished_name = &tasks[*index].name;
            for dependencies in &mut remaining_dependencies {
                dependencies.remove(finished_name);
            }
        }

        batches.push(
            selected
                .into_iter()
                .map(|index| tasks[index].clone())
                .collect(),
        );
    }

    Ok(batches)
}

async fn run_delegated_task(
    task: CoordinatorTaskSpec,
    dependency_context: Option<String>,
    shared_context: Option<String>,
    max_turns: usize,
    runtime: DelegationRuntime,
) -> DelegatedTaskResult {
    let prompt = build_sub_agent_prompt(
        &task,
        runtime.parent_context.as_deref(),
        shared_context.as_deref(),
        dependency_context.as_deref(),
    );

    let mut sub_options = AgentRunOptions::with_defaults(
        runtime.provider.clone(),
        runtime.workspace_root.clone(),
        prompt,
        runtime.api_key.clone(),
    );
    sub_options.max_turns = max_turns;
    sub_options.sandbox = runtime.sandbox.clone();
    sub_options.permission = runtime.permission.clone();
    sub_options.streaming = false;
    sub_options.auto_git = false;
    sub_options.fallback_providers = runtime.fallback_providers.clone();
    sub_options.plugin_definitions = runtime.plugin_definitions.clone();
    sub_options.coordinator_depth = runtime.next_depth;
    sub_options.quiet = true;

    let plugin_tools = plugin_tools_from_definitions(&runtime.plugin_definitions);
    match run_agent(sub_options, plugin_tools).await {
        Ok(result) => {
            let response = if result.final_response.trim().is_empty() {
                "Sub-agent completed without a final narrative response.".to_string()
            } else {
                result.final_response.clone()
            };

            DelegatedTaskResult {
                name: task.name,
                task: task.task,
                status: "completed".to_string(),
                depends_on: task.depends_on,
                response,
                error: None,
                turns_used: result.turns_used,
                tool_calls: tool_call_summary(&result),
                token_usage: result.token_usage,
            }
        }
        Err(error) => DelegatedTaskResult {
            name: task.name,
            task: task.task,
            status: "failed".to_string(),
            depends_on: task.depends_on,
            response: String::new(),
            error: Some(error.to_string()),
            turns_used: 0,
            tool_calls: Vec::new(),
            token_usage: TokenUsage::default(),
        },
    }
}

fn build_sub_agent_prompt(
    task: &CoordinatorTaskSpec,
    parent_context: Option<&str>,
    shared_context: Option<&str>,
    dependency_context: Option<&str>,
) -> String {
    let mut sections = vec![
        "You are a delegated sub-agent helping complete a parent coding task. Stay within the assigned scope, make concrete progress, and report exact files touched plus blockers.".to_string(),
    ];

    if let Some(parent_context) = parent_context {
        let parent_context = parent_context.trim();
        if !parent_context.is_empty() {
            sections.push(format!("# Parent Context\n{}", parent_context));
        }
    }

    if let Some(shared_context) = shared_context {
        let shared_context = shared_context.trim();
        if !shared_context.is_empty() {
            sections.push(format!("# Shared Coordination Context\n{}", shared_context));
        }
    }

    if let Some(dependency_context) = dependency_context {
        let dependency_context = dependency_context.trim();
        if !dependency_context.is_empty() {
            sections.push(dependency_context.to_string());
        }
    }

    sections.push(format!(
        "# Delegated Task [{}]\n{}",
        task.name,
        task.task.trim()
    ));
    sections.push(
        "When you finish, summarize: what you completed, which files you changed, and any follow-up or blocker.".to_string(),
    );

    sections.join("\n\n")
}

fn build_dependency_context(
    task: &CoordinatorTaskSpec,
    results: &HashMap<String, DelegatedTaskResult>,
) -> Option<String> {
    if task.depends_on.is_empty() {
        return None;
    }

    let mut sections = vec!["# Dependency Results".to_string()];
    for dependency in &task.depends_on {
        if let Some(result) = results.get(dependency) {
            sections.push(format!("## {} [{}]", result.name, result.status));
            if let Some(error) = &result.error {
                sections.push(format!("Error: {}", error));
            }
            if !result.response.trim().is_empty() {
                sections.push(result.response.trim().to_string());
            }
        }
    }

    Some(sections.join("\n"))
}

fn blocked_result(task: &CoordinatorTaskSpec, blockers: Vec<String>) -> DelegatedTaskResult {
    DelegatedTaskResult {
        name: task.name.clone(),
        task: task.task.clone(),
        status: "blocked".to_string(),
        depends_on: task.depends_on.clone(),
        response: String::new(),
        error: Some(format!(
            "Blocked by failed dependency: {}",
            blockers.join(", ")
        )),
        turns_used: 0,
        tool_calls: Vec::new(),
        token_usage: TokenUsage::default(),
    }
}

fn parse_blocked_dependencies(error: &str) -> Vec<String> {
    error
        .strip_prefix("Blocked by failed dependency: ")
        .map(|suffix| {
            suffix
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn tool_call_summary(result: &crate::agent::AgentRunResult) -> Vec<String> {
    result
        .tool_invocations
        .iter()
        .map(|invocation| format!("{}({})", invocation.tool_name, invocation.arguments))
        .take(10)
        .collect()
}

fn delegated_result_summary(result: &DelegatedTaskResult) -> String {
    if let Some(error) = &result.error {
        return truncate_text(error, 160);
    }

    if !result.response.trim().is_empty() {
        return truncate_text(result.response.trim(), 160);
    }

    format!("status={}", result.status)
}

fn render_aggregate_response(
    results: &HashMap<String, DelegatedTaskResult>,
    task_order: &[CoordinatorTaskSpec],
) -> String {
    let mut sections = Vec::new();
    for task in task_order {
        if let Some(result) = results.get(&task.name) {
            sections.push(format!("## {} [{}]", result.name, result.status));
            if !result.depends_on.is_empty() {
                sections.push(format!("Depends on: {}", result.depends_on.join(", ")));
            }
            if let Some(error) = &result.error {
                sections.push(format!("Error: {}", error));
            }
            if !result.response.trim().is_empty() {
                sections.push(result.response.trim().to_string());
            }
            sections.push(String::new());
        }
    }

    sections.join("\n").trim().to_string()
}

fn accumulate_usage(total: &mut TokenUsage, usage: &TokenUsage) {
    total.prompt_tokens += usage.prompt_tokens;
    total.completion_tokens += usage.completion_tokens;
    total.total_tokens += usage.total_tokens;
    total.api_calls += usage.api_calls;
}

fn truncate_text(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= limit {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..limit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_tool_has_correct_name() {
        let tool = CoordinatorTool;
        assert_eq!(tool.name(), "spawn_agent");
    }

    #[test]
    fn schema_supports_single_and_batch_tasks() {
        let tool = CoordinatorTool;
        let schema = tool.parameters_schema();
        assert!(schema["properties"].get("task").is_some());
        assert!(schema["properties"].get("tasks").is_some());
        assert!(schema["properties"].get("strategy").is_some());
    }

    #[test]
    fn parse_request_supports_reference_style_task_specs() {
        let params = serde_json::json!({
            "tasks": [
                {
                    "title": "architect",
                    "description": "Design the module split"
                },
                {
                    "name": "implement",
                    "task": "Implement the design",
                    "dependsOn": ["architect"]
                }
            ],
            "strategy": "parallel",
            "max_concurrency": 2
        });

        let request = parse_request(&params).unwrap();
        assert_eq!(request.tasks.len(), 2);
        assert_eq!(request.tasks[0].name, "architect");
        assert_eq!(request.tasks[1].depends_on, vec!["architect".to_string()]);
        assert_eq!(request.max_concurrency, 2);
    }

    #[test]
    fn build_batches_parallelizes_ready_work() {
        let tasks = vec![
            CoordinatorTaskSpec {
                name: "research".to_string(),
                task: "Research".to_string(),
                depends_on: Vec::new(),
            },
            CoordinatorTaskSpec {
                name: "design".to_string(),
                task: "Design".to_string(),
                depends_on: Vec::new(),
            },
            CoordinatorTaskSpec {
                name: "implement".to_string(),
                task: "Implement".to_string(),
                depends_on: vec!["research".to_string(), "design".to_string()],
            },
        ];

        let batches = build_batches(&tasks, true).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(
            batches[0]
                .iter()
                .map(|task| task.name.as_str())
                .collect::<Vec<_>>(),
            vec!["research", "design"]
        );
        assert_eq!(batches[1][0].name, "implement");
    }

    #[test]
    fn build_batches_detects_cycles() {
        let tasks = vec![
            CoordinatorTaskSpec {
                name: "a".to_string(),
                task: "Task A".to_string(),
                depends_on: vec!["b".to_string()],
            },
            CoordinatorTaskSpec {
                name: "b".to_string(),
                task: "Task B".to_string(),
                depends_on: vec!["a".to_string()],
            },
        ];

        let error = build_batches(&tasks, true).unwrap_err().to_string();
        assert!(error.contains("cycle"));
    }

    #[test]
    fn dependency_context_includes_completed_outputs() {
        let task = CoordinatorTaskSpec {
            name: "implement".to_string(),
            task: "Implement feature".to_string(),
            depends_on: vec!["research".to_string()],
        };
        let mut results = HashMap::new();
        results.insert(
            "research".to_string(),
            DelegatedTaskResult {
                name: "research".to_string(),
                task: "Research".to_string(),
                status: "completed".to_string(),
                depends_on: Vec::new(),
                response: "Use module X.".to_string(),
                error: None,
                turns_used: 1,
                tool_calls: Vec::new(),
                token_usage: TokenUsage::default(),
            },
        );

        let context = build_dependency_context(&task, &results).unwrap();
        assert!(context.contains("research [completed]"));
        assert!(context.contains("Use module X."));
    }
}
