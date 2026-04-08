// GemiClawDex — Output rendering
//
// All output structs derive Serialize for clean JSON output via serde_json.
// This replaces the previous hand-written JsonValue builder (400+ lines → ~120).

use std::path::PathBuf;

use crate::agent::{AgentEvent, AgentRunResult, TokenUsage, ToolInvocationRecord};
use crate::config::display_path;
use crate::prompt::{PromptAssembly, PromptAttachment};
use crate::providers::ProviderProfile;
use crate::session::{CheckpointRecord, SessionListEntry, SessionRecord};
use serde::Serialize;

// ---------------------------------------------------------------------------
// AppOutput — the single type returned by every App::handle() method
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct AppOutput {
    lines: Vec<String>,
    json_value: serde_json::Value,
    jsonl_values: Vec<serde_json::Value>,
}

impl AppOutput {
    pub fn new<T: Serialize>(lines: Vec<String>, data: &T) -> Self {
        let json_value = serde_json::to_value(data).unwrap_or(serde_json::Value::Null);
        Self {
            lines,
            json_value: json_value.clone(),
            jsonl_values: vec![json_value],
        }
    }

    pub fn new_with_jsonl<T: Serialize>(
        lines: Vec<String>,
        data: &T,
        jsonl_values: Vec<serde_json::Value>,
    ) -> Self {
        Self {
            lines,
            json_value: serde_json::to_value(data).unwrap_or(serde_json::Value::Null),
            jsonl_values,
        }
    }

    pub fn render(&self) -> String {
        self.lines.join("\n")
    }

    pub fn render_json(&self) -> String {
        serde_json::to_string(&self.json_value).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn render_jsonl(&self) -> String {
        self.jsonl_values
            .iter()
            .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// ---------------------------------------------------------------------------
// Serializable view structs (replace hand-built JsonValue trees)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct OverviewJson {
    pub app: String,
    pub workspace: String,
    pub detected_by: String,
    pub trust: String,
    pub current_provider: ProviderJson,
    pub default_sandbox: String,
    pub counts: CountsJson,
}

#[derive(Serialize)]
pub(crate) struct CountsJson {
    pub providers: usize,
    pub instructions: usize,
    pub commands: usize,
    pub skills: usize,
    pub sessions: usize,
}

#[derive(Serialize, Clone)]
pub struct ProviderJson {
    pub id: String,
    pub label: String,
    pub family: String,
    pub protocol: String,
    pub model: String,
    pub api_base: String,
    pub api_key_env: String,
    pub best_for: String,
    pub supports_multimodal: bool,
    pub supports_grounding: bool,
    pub source: String,
    pub strengths: Vec<String>,
}

impl From<&ProviderProfile> for ProviderJson {
    fn from(p: &ProviderProfile) -> Self {
        Self {
            id: p.id.clone(),
            label: p.label.clone(),
            family: p.family.as_str().to_string(),
            protocol: p.protocol.as_str().to_string(),
            model: p.model.clone(),
            api_base: p.api_base.clone(),
            api_key_env: p.api_key_env.clone(),
            best_for: p.best_for.clone(),
            supports_multimodal: p.supports_multimodal,
            supports_grounding: p.supports_grounding,
            source: p.source.label(),
            strengths: p.strengths.clone(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ProviderListJson {
    pub current: ProviderJson,
    pub active_global: Option<String>,
    pub active_workspace: Option<String>,
    pub providers: Vec<ProviderJson>,
}

#[derive(Serialize)]
pub(crate) struct ProviderDetailJson {
    pub provider: ProviderJson,
    pub active_global: Option<String>,
    pub active_workspace: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ProviderDoctorJson {
    pub profile: ProviderJson,
    pub active_scope: String,
    pub api_key_present: bool,
    pub masked_api_key: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct TrustStatusJson {
    pub path: String,
    pub status: String,
    pub matched_rule: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct TrustSetJson {
    pub path: String,
    pub rule: String,
}

#[derive(Serialize)]
pub(crate) struct ReloadJson {
    pub workspace: String,
    pub trust: String,
    pub commands: usize,
    pub skills: usize,
}

#[derive(Serialize)]
pub(crate) struct CheckpointListJson {
    pub checkpoints: Vec<CheckpointEntryJson>,
}

#[derive(Serialize)]
pub(crate) struct CheckpointEntryJson {
    pub file_name: String,
    pub summary: String,
}

impl From<&CheckpointRecord> for CheckpointEntryJson {
    fn from(c: &CheckpointRecord) -> Self {
        Self {
            file_name: c.file_name.clone(),
            summary: c.summary.clone(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct SessionListJson {
    pub sessions: Vec<SessionEntryJson>,
}

#[derive(Serialize)]
pub(crate) struct SessionEntryJson {
    pub id: String,
    pub parent_id: Option<String>,
    pub workspace: String,
    pub created_at_secs: u64,
    pub updated_at_secs: u64,
    pub turn_count: usize,
    pub latest_provider_id: String,
    pub latest_summary: String,
}

impl From<&SessionListEntry> for SessionEntryJson {
    fn from(s: &SessionListEntry) -> Self {
        Self {
            id: s.id.clone(),
            parent_id: s.parent_id.clone(),
            workspace: display_path(&s.workspace_root),
            created_at_secs: s.created_at_secs,
            updated_at_secs: s.updated_at_secs,
            turn_count: s.turn_count,
            latest_provider_id: s.latest_provider_id.clone(),
            latest_summary: s.latest_summary.clone(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ExecJson {
    pub mode: String,
    pub workspace: String,
    pub provider: ProviderJson,
    pub sandbox: String,
    pub trust: String,
    pub active_command: Option<String>,
    pub active_skill: Option<String>,
    pub attachments: Vec<AttachmentJson>,
    pub pending_shell_commands: Vec<String>,
    pub prompt: String,
    pub checkpoint_path: Option<String>,
    pub source_session: Option<SessionSourceJson>,
    pub persisted_session: Option<PersistedSessionJson>,
    pub events: Vec<AgentEvent>,
    pub result: Option<ExecResultJson>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum AttachmentJson {
    FileText {
        path: String,
        preview: String,
    },
    DirectoryListing {
        path: String,
        entries: Vec<String>,
    },
    BinaryReference {
        path: String,
        media_type: &'static str,
    },
}

impl From<&PromptAttachment> for AttachmentJson {
    fn from(value: &PromptAttachment) -> Self {
        match value {
            PromptAttachment::FileText { path, preview } => Self::FileText {
                path: display_path(path),
                preview: preview.clone(),
            },
            PromptAttachment::DirectoryListing { path, entries } => Self::DirectoryListing {
                path: display_path(path),
                entries: entries.clone(),
            },
            PromptAttachment::BinaryReference { path, media_type } => Self::BinaryReference {
                path: display_path(path),
                media_type,
            },
        }
    }
}

#[derive(Serialize)]
pub(crate) struct SessionSourceJson {
    pub mode: String,
    pub id: String,
}

#[derive(Serialize)]
pub(crate) struct PersistedSessionJson {
    pub action: String,
    pub id: String,
    pub turn_count: usize,
}

#[derive(Serialize)]
pub(crate) struct ExecResultJson {
    pub final_response: String,
    pub turns_used: usize,
    pub message_count: usize,
    pub tool_invocation_count: usize,
    pub tool_invocations: Vec<ToolInvocationJson>,
    pub token_usage: TokenUsageJson,
    pub events: Vec<AgentEvent>,
}

#[derive(Serialize)]
pub(crate) struct ToolInvocationJson {
    pub turn: usize,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub result: serde_json::Value,
}

impl From<&ToolInvocationRecord> for ToolInvocationJson {
    fn from(value: &ToolInvocationRecord) -> Self {
        Self {
            turn: value.turn,
            tool_name: value.tool_name.clone(),
            arguments: value.arguments.clone(),
            result: value.result.clone(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct TokenUsageJson {
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub total_tokens: usize,
    pub api_calls: usize,
}

impl From<&TokenUsage> for TokenUsageJson {
    fn from(value: &TokenUsage) -> Self {
        Self {
            prompt_tokens: value.prompt_tokens,
            completion_tokens: value.completion_tokens,
            total_tokens: value.total_tokens,
            api_calls: value.api_calls,
        }
    }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

pub(crate) fn render_exec_output(
    assembly: &PromptAssembly,
    checkpoint_path: Option<PathBuf>,
    source_session: Option<(String, String)>,
    persisted_session: Option<(String, SessionRecord)>,
    execution_events: &[AgentEvent],
    print_prompt: bool,
    agent_result: Option<&AgentRunResult>,
) -> AppOutput {
    let mut lines = vec![
        if agent_result.is_some() {
            "Execution result".to_string()
        } else {
            "Execution plan".to_string()
        },
        format!("Workspace: {}", display_path(&assembly.workspace_root)),
        format!(
            "Provider: {} ({})",
            assembly.provider.id, assembly.provider.label
        ),
        format!("Sandbox: {}", assembly.sandbox.as_str()),
        format!("Trust: {}", assembly.trust_label),
    ];
    if !assembly.attachments.is_empty() {
        lines.push(format!("Attachments: {}", assembly.attachments.len()));
    }
    if !assembly.pending_shell_commands.is_empty() {
        lines.push(format!(
            "Pending shell commands: {}",
            assembly.pending_shell_commands.len()
        ));
    }

    if let Some((mode, session_id)) = &source_session {
        lines.push(format!("Session source: {} ({})", session_id, mode));
    }
    if let Some(path) = &checkpoint_path {
        lines.push(format!("Checkpoint saved: {}", display_path(path)));
    }
    if let Some((action, record)) = &persisted_session {
        lines.push(format!(
            "Session {}: {} ({} turns)",
            action,
            record.id,
            record.turn_count()
        ));
    }
    if print_prompt {
        lines.push(String::new());
        lines.push("Prompt preview".to_string());
        lines.push(assembly.final_prompt.clone());
    }
    if let Some(result) = agent_result {
        lines.push(String::new());
        lines.push("Assistant response".to_string());
        if result.final_response.trim().is_empty() {
            lines.push("(empty response)".to_string());
        } else {
            lines.push(result.final_response.clone());
        }
        lines.push(String::new());
        lines.push(format!(
            "Runtime summary: {} turns, {} tool calls, {} total tokens across {} API calls",
            result.turns_used,
            result.tool_invocations.len(),
            result.token_usage.total_tokens,
            result.token_usage.api_calls
        ));
    }

    let json_data = ExecJson {
        mode: if agent_result.is_some() {
            "live".to_string()
        } else {
            "plan".to_string()
        },
        workspace: display_path(&assembly.workspace_root),
        provider: ProviderJson::from(&assembly.provider),
        sandbox: assembly.sandbox.as_str().to_string(),
        trust: assembly.trust_label.clone(),
        active_command: assembly.active_command.clone(),
        active_skill: assembly.active_skill.clone(),
        attachments: assembly
            .attachments
            .iter()
            .map(AttachmentJson::from)
            .collect(),
        pending_shell_commands: assembly.pending_shell_commands.clone(),
        prompt: assembly.final_prompt.clone(),
        checkpoint_path: checkpoint_path.as_ref().map(|path| display_path(path)),
        source_session: source_session.as_ref().map(|(mode, id)| SessionSourceJson {
            mode: mode.clone(),
            id: id.clone(),
        }),
        persisted_session: persisted_session.as_ref().map(|(action, record)| {
            PersistedSessionJson {
                action: action.clone(),
                id: record.id.clone(),
                turn_count: record.turn_count(),
            }
        }),
        events: execution_events.to_vec(),
        result: agent_result.map(|result| ExecResultJson {
            final_response: result.final_response.clone(),
            turns_used: result.turns_used,
            message_count: result.messages.len(),
            tool_invocation_count: result.tool_invocations.len(),
            tool_invocations: result
                .tool_invocations
                .iter()
                .map(ToolInvocationJson::from)
                .collect(),
            token_usage: TokenUsageJson::from(&result.token_usage),
            events: result.events.clone(),
        }),
    };

    let jsonl_values = execution_events
        .iter()
        .map(|event| serde_json::to_value(event).unwrap_or(serde_json::Value::Null))
        .collect();

    AppOutput::new_with_jsonl(lines, &json_data, jsonl_values)
}

pub(crate) fn render_provider_output(
    title: &str,
    provider: &ProviderProfile,
    active_global: Option<&str>,
    active_workspace: Option<&str>,
) -> AppOutput {
    let mut lines = vec![
        title.to_string(),
        format!("ID: {}", provider.id),
        format!("Label: {}", provider.label),
        format!("Family: {}", provider.family.as_str()),
        format!("Model: {}", provider.model),
        format!("API base: {}", provider.api_base),
    ];
    if !provider.strengths.is_empty() {
        for s in &provider.strengths {
            lines.push(format!("  - {}", s));
        }
    }

    let json = ProviderDetailJson {
        provider: ProviderJson::from(provider),
        active_global: active_global.map(|s| s.to_string()),
        active_workspace: active_workspace.map(|s| s.to_string()),
    };

    AppOutput::new(lines, &json)
}

pub(crate) fn inject_section_before_task(prompt: &str, section: &str) -> String {
    if let Some((head, tail)) = prompt.split_once("\n\n# Task\n") {
        format!("{}\n\n{}\n\n# Task\n{}", head, section, tail)
    } else {
        format!("{}\n\n{}", prompt, section)
    }
}

pub(crate) fn truncate_text(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit.saturating_sub(3)).collect();
    out.push_str("...");
    out
}
