// Aixlarity — Agent Loop
//
// Core execution loop: prompt → API → parse tool calls → execute → loop.
// Supports Gemini, OpenAI, and Anthropic with full tool calling.
// Features: permission prompt, streaming, context window management,
// token tracking, git integration, planning mode, MCP, plugins,
// coordinator sub-agents, provider fallback, and undercover mode.

mod adapters;
pub mod memory;
mod permissions;
mod runtime_support;
mod types;

use crate::mcp;
use crate::tools::{all_tools, ToolContext};
use adapters::{call_provider_api, execute_tool_call};
use permissions::{check_always_upgrade, needs_confirmation};
use runtime_support::{
    compact_messages, estimate_total_tokens, git_auto_commit_safe, CONTEXT_WINDOW_BUDGET,
};

pub use types::{
    AgentAttachment, AgentEvent, AgentMessage, AgentRunOptions, AgentRunResult, ApprovalHandler,
    EventCallback, IdeContext, PermissionLevel, StreamCallback, TokenUsage, ToolCall,
    ToolInvocationRecord,
};

/// Run the agent loop to completion.
///
/// `plugin_tools` are dynamically loaded from `.aixlarity/plugins/` and passed by the caller.
pub async fn run_agent(
    mut options: AgentRunOptions,
    plugin_tools: Vec<Box<dyn crate::tools::Tool>>,
) -> anyhow::Result<AgentRunResult> {
    macro_rules! track_event {
        ($events_ident:expr, $opts_ident:expr, $ev:expr) => {{
            let ev = $ev;
            if let Some(eh) = &$opts_ident.event_handler {
                (eh.0)(ev.clone());
            }
            $events_ident.push(ev);
        }};
    }

    // Load MCP tools from workspace configuration
    let mcp_tools = mcp::load_mcp_tools(&options.workspace_root);

    // Merge builtin + plugin + MCP tools
    let mut tools = all_tools(plugin_tools, mcp_tools);

    // Persona-based tool restriction: if the active persona defines
    // `allowed_tools` in its frontmatter, filter the tool list to only
    // include those tools. This enforces role boundaries at the engine
    // level — e.g., a CodeReviewer physically cannot call write_file.
    // Design: Inspired by agent-skills' principle that personas have
    // different "VS Code capabilities" mapped to their role.
    if let Some(persona_name) = &options.persona {
        let allowed =
            crate::instructions::get_persona_allowed_tools(&options.workspace_root, persona_name);
        if let Some(allowed_names) = allowed {
            tools.retain(|tool| allowed_names.iter().any(|a| a == tool.name()));
        }
    }

    let hooks_config = crate::hooks::HooksConfig::load(
        &options.workspace_root.join(".config").join("aixlarity"),
        &options.workspace_root,
    );

    let tool_ctx = ToolContext {
        workspace_root: options.workspace_root.clone(),
        sandbox: options.sandbox.clone(),
        coordinator_provider: Some(options.provider.clone()),
        coordinator_api_key: Some(options.api_key.clone()),
        coordinator_permission: Some(options.permission.clone()),
        coordinator_fallback_providers: options.fallback_providers.clone(),
        coordinator_plugin_definitions: options.plugin_definitions.clone(),
        coordinator_depth: options.coordinator_depth,
        coordinator_prompt_context: inherited_prompt_context(&options.initial_prompt),
        hooks: hooks_config,
        // No path ACL for the main agent — only sub-agents get scoped.
        allowed_write_paths: None,
        forbidden_write_paths: None,
    };

    let initial_prompt = if options.planning {
        format!(
            "You are in PLAN MODE (Agent-First Architecture). Your primary goal is to safely orchestrate complex system changes without hallucination. Before making any code modifications or executing terminal commands, you MUST adhere to the following strict protocol:\n\
             \n\
             1. TASK DECOMPOSITION (DAG): Deconstruct the user's request into atomic, modular task nodes. You must understand the topological dependencies (e.g., Schema must exist before API, API before UI).\n\
             2. VERIFIABLE ARTIFACTS: Generate an Implementation Plan document (e.g., `docs/TASK_...md`). Each task must specify its Input Contract, Output Contract, and Implementation Constraints.\n\
             3. BROWSER & MCP: If applicable, use MCP skills to read existing schemas. Use the Browser Subagent to perform visual or DOM verification later.\n\
             4. MANDATORY APPROVAL: You must halt and explicitly ask for human `Approve Plan` authorization before taking destructive actions or writing code. Do not proceed until approved.\n\
             \n\
             Task:\n{}",
            options.initial_prompt
        )
    } else {
        format!(
            "You are in FAST MODE (Agent-First Architecture). You are optimized for low-latency, low-blast-radius execution. Skip extensive planning and execute immediately.\n\
             \n\
             CRITICAL CONSTRAINTS:\n\
             - VISUAL EXCELLENCE: If designing UI, mandate a 'Wow factor'. Enforce Dark Mode, Glassmorphism, Google Fonts, and HSL-based palettes. Reject basic/plain layouts.\n\
             - LIGHTWEIGHT STACK: Prioritize Vanilla HTML/CSS/JS. Do not use TailwindCSS unless explicitly requested. Do not use blank image placeholders; ALWAYS use `generate_image` dynamically.\n\
             - SEO & SEMANTICS: Automatically inject SEO best practices (single <h1>, meta tags, semantic HTML5).\n\
             - TOOL CALLING: Use absolute paths ONLY. Execute // turbo workflows swiftly if requested (e.g., // turbo-all for git commits, port cleanup, docker prune) without hesitation.\n\
             \n\
             Task:\n{}",
            options.initial_prompt
        )
    };

    let mut messages = Vec::new();

    // Antigravity Request Mapper: Reconstruct structured history from a
    // previous session so the new model sees exact tool call traces rather
    // than a lossy text summary.  Design note: inspired by Google
    // Antigravity's "Protocol Proxy Middleware" which translates message
    // histories across heterogeneous provider APIs.
    if let Some(record) = &options.source_session {
        for session_turn in &record.turns {
            // Use `input` (the user's actual request) rather than `prompt`
            // (the full assembled system prompt).  Injecting the entire
            // system prompt for every historical turn would waste enormous
            // token budget and confuse the new model with stale instructions.
            messages.push(AgentMessage {
                role: "user".to_string(),
                content: session_turn.input.clone(),
                tool_calls: None,
                tool_call_id: None,
                attachments: None,
            });

            for i in 0..session_turn.events.len() {
                let event = &session_turn.events[i];
                match event {
                    AgentEvent::AssistantMessage { content, turn, .. } => {
                        // Look ahead to gather all ToolCallRequested for
                        // this exact LLM turn so we can attach them to the
                        // assistant message (required by every provider).
                        let mut tool_calls_for_turn = Vec::new();
                        for j in (i + 1)..session_turn.events.len() {
                            match &session_turn.events[j] {
                                AgentEvent::ToolCallRequested {
                                    call_id,
                                    tool_name,
                                    arguments,
                                    turn: t,
                                } if *t == *turn => {
                                    tool_calls_for_turn.push(ToolCall {
                                        id: call_id.clone(),
                                        name: tool_name.clone(),
                                        arguments: arguments.clone(),
                                    });
                                }
                                // Stop scanning when the next LLM turn begins.
                                AgentEvent::TurnStarted { turn: t, .. } if *t > *turn => break,
                                _ => {}
                            }
                        }

                        messages.push(AgentMessage {
                            role: "assistant".to_string(),
                            content: content.clone(),
                            tool_calls: if tool_calls_for_turn.is_empty() {
                                None
                            } else {
                                Some(tool_calls_for_turn)
                            },
                            tool_call_id: None,
                            attachments: None,
                        });
                    }
                    AgentEvent::ToolCallCompleted {
                        call_id, result, ..
                    } => {
                        // Context Compression (L1/L2): truncate large tool
                        // outputs to prevent blowing the context window on
                        // the new model.
                        let result_str = serde_json::to_string(result).unwrap_or_default();
                        let compressed = if result_str.len() > 4000 {
                            // Safe UTF-8 truncation: find the last char
                            // boundary at or before 4000 bytes.
                            let truncation_point = result_str
                                .char_indices()
                                .take_while(|(idx, _)| *idx < 4000)
                                .last()
                                .map(|(idx, ch)| idx + ch.len_utf8())
                                .unwrap_or(0);
                            format!(
                                "{}... [Tool output compressed for context budget (original length: {})]",
                                &result_str[..truncation_point],
                                result_str.len()
                            )
                        } else {
                            result_str
                        };
                        messages.push(AgentMessage {
                            role: "tool".to_string(),
                            content: compressed,
                            tool_calls: None,
                            tool_call_id: Some(call_id.clone()),
                            attachments: None,
                        });
                    }
                    AgentEvent::ToolCallDenied { call_id, .. } => {
                        messages.push(AgentMessage {
                            role: "tool".to_string(),
                            content: serde_json::json!({"error": "User denied this tool call"})
                                .to_string(),
                            tool_calls: None,
                            tool_call_id: Some(call_id.clone()),
                            attachments: None,
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    messages.push(AgentMessage {
        role: "user".to_string(),
        content: initial_prompt,
        tool_calls: None,
        tool_call_id: None,
        attachments: options.initial_attachments.clone(),
    });
    let mut tool_records = Vec::new();
    let mut final_response = String::new();
    let mut token_usage = TokenUsage::default();
    let mut previous_response_id: Option<String> = None;
    let start_event = AgentEvent::RunStarted {
        provider_id: options.provider.id.clone(),
        model: options.provider.model.clone(),
        protocol: options.provider.protocol.as_str().to_string(),
        sandbox: options.sandbox.as_str().to_string(),
        permission: options.permission.as_str().to_string(),
        max_turns: options.max_turns,
        planning: options.planning,
        streaming: options.streaming,
    };
    if let Some(eh) = &options.event_handler {
        (eh.0)(start_event.clone());
    }
    let mut events = vec![start_event];

    let mut turns_executed = 0usize;
    for turn in 0..options.max_turns {
        let turn_number = turn + 1;
        turns_executed = turn_number;
        if !options.quiet {
            eprintln!(
                "\x1b[2m[Turn {}/{}] Calling {} ({})...\x1b[0m",
                turn_number,
                options.max_turns,
                options.provider.model,
                options.provider.family.as_str(),
            );
        }
        track_event!(
            events,
            options,
            AgentEvent::TurnStarted {
                turn: turn_number,
                max_turns: options.max_turns,
                message_count: messages.len(),
            }
        );

        let estimated_tokens = estimate_total_tokens(&messages);
        if estimated_tokens > CONTEXT_WINDOW_BUDGET {
            if !options.quiet {
                eprintln!(
                    "\x1b[33m⚡ Context window near limit (~{} tokens). Compacting...\x1b[0m",
                    estimated_tokens
                );
            }
            compact_messages(&mut messages);
            track_event!(
                events,
                options,
                AgentEvent::ContextCompacted {
                    turn: turn_number,
                    estimated_tokens,
                    budget: CONTEXT_WINDOW_BUDGET,
                }
            );
        }

        track_event!(
            events,
            options,
            AgentEvent::ProviderCalled {
                turn: turn_number,
                protocol: options.provider.protocol.as_str().to_string(),
                message_count: messages.len(),
            }
        );

        // call_provider_api now supports fallback
        let (response, usage, response_id) = call_provider_api(
            &options,
            &messages,
            &tools,
            previous_response_id.as_deref(),
            turn_number,
            &mut events,
        )
        .await?;
        token_usage.add(usage.0, usage.1);
        previous_response_id = response_id;
        track_event!(
            events,
            options,
            AgentEvent::AssistantMessage {
                turn: turn_number,
                content: response.content.clone(),
                tool_call_count: response.tool_calls.as_ref().map_or(0, Vec::len),
            }
        );

        if let Some(calls) = &response.tool_calls {
            messages.push(response.clone());

            for call in calls {
                track_event!(
                    events,
                    options,
                    AgentEvent::ToolCallRequested {
                        turn: turn_number,
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    }
                );
                if needs_confirmation(&call.name, &options.permission) {
                    let (allowed, upgrade) = if let Some(handler) = &options.approval_handler {
                        handler.request_approval(call).await
                    } else {
                        check_always_upgrade(call)
                    };
                    if upgrade {
                        options.permission = PermissionLevel::FullAuto;
                    }
                    if !allowed {
                        if !options.quiet {
                            eprintln!("\x1b[31m✗ Denied: {}\x1b[0m", call.name);
                        }
                        track_event!(
                            events,
                            options,
                            AgentEvent::ToolCallDenied {
                                turn: turn_number,
                                call_id: call.id.clone(),
                                tool_name: call.name.clone(),
                            }
                        );
                        messages.push(AgentMessage {
                            role: "tool".to_string(),
                            content: serde_json::json!({"error": "User denied this tool call"})
                                .to_string(),
                            tool_calls: None,
                            tool_call_id: Some(call.id.clone()),
                            attachments: None,
                        });
                        continue;
                    }
                }

                // Run PreToolUse hooks
                let hook_result = crate::hooks::run_pre_tool_hooks(
                    &tool_ctx.hooks,
                    &call.name,
                    &call.arguments,
                    &tool_ctx.workspace_root,
                );
                if let crate::hooks::PreToolHookResult::Deny { stderr, .. } = hook_result {
                    if !options.quiet {
                        eprintln!("\x1b[31m🪝 Hook denied: {}\x1b[0m", call.name);
                    }
                    track_event!(
                        events,
                        options,
                        AgentEvent::ToolCallDenied {
                            turn: turn_number,
                            call_id: call.id.clone(),
                            tool_name: call.name.clone(),
                        }
                    );
                    messages.push(AgentMessage {
                        role: "tool".to_string(),
                        content:
                            serde_json::json!({"error": format!("Hook denied: {}", stderr.trim())})
                                .to_string(),
                        tool_calls: None,
                        tool_call_id: Some(call.id.clone()),
                        attachments: None,
                    });
                    continue;
                }

                if !options.quiet {
                    eprintln!("\x1b[32m⚡ Executing: {}\x1b[0m", call.name);
                }
                let tool_outcome = execute_tool_call(call, &tools, &tool_ctx).await;

                // Run PostToolUse hooks
                crate::hooks::run_post_tool_hooks(
                    &tool_ctx.hooks,
                    &call.name,
                    &call.arguments,
                    &tool_outcome.result,
                    &tool_ctx.workspace_root,
                );

                for ev in tool_outcome.emitted_events.clone() {
                    track_event!(events, options, ev);
                }

                track_event!(
                    events,
                    options,
                    AgentEvent::ToolCallCompleted {
                        turn: turn_number,
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        result: tool_outcome.result.clone(),
                        attachments: if tool_outcome.emitted_attachments.is_empty() {
                            None
                        } else {
                            Some(tool_outcome.emitted_attachments.clone())
                        },
                    }
                );

                tool_records.push(ToolInvocationRecord {
                    turn,
                    tool_name: call.name.clone(),
                    arguments: call.arguments.clone(),
                    result: tool_outcome.result.clone(),
                });

                messages.push(AgentMessage {
                    role: "tool".to_string(),
                    content: serde_json::to_string(&tool_outcome.result).unwrap_or_default(),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                    attachments: if tool_outcome.emitted_attachments.is_empty() {
                        None
                    } else {
                        Some(tool_outcome.emitted_attachments.clone())
                    },
                });
            }
        } else {
            final_response = response.content.clone();
            messages.push(response);
            break;
        }
    }

    // Git auto-commit with undercover mode (sanitizes commit messages for public repos)
    if options.auto_git {
        git_auto_commit_safe(&options.workspace_root, &final_response);
    }

    if !options.quiet {
        eprintln!();
        eprintln!(
            "\x1b[2m📊 Token usage: {} prompt + {} completion = {} total ({} API calls)\x1b[0m",
            token_usage.prompt_tokens,
            token_usage.completion_tokens,
            token_usage.total_tokens,
            token_usage.api_calls,
        );
    }
    track_event!(
        events,
        options,
        AgentEvent::RunCompleted {
            turns_used: turns_executed,
            tool_invocation_count: tool_records.len(),
            total_tokens: token_usage.total_tokens,
            api_calls: token_usage.api_calls,
            final_response: final_response.clone(),
        }
    );

    Ok(AgentRunResult {
        turns_used: turns_executed,
        final_response,
        messages,
        tool_invocations: tool_records,
        token_usage,
        events,
    })
}

fn inherited_prompt_context(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((prefix, _)) = trimmed.split_once("\n\n# Task\n") {
        let prefix = prefix.trim();
        if !prefix.is_empty() {
            return Some(prefix.to_string());
        }
    }

    Some(trimmed.to_string())
}
