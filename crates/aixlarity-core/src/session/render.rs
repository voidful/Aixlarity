use crate::config::display_path;

use super::model::{SessionRecord, SessionReuseMode};
use super::storage::summarize_task;

pub fn render_session_context(record: &SessionRecord, mode: SessionReuseMode) -> String {
    let mut lines = vec![
        "# Session Continuation".to_string(),
        format!("Mode: {}", mode.as_str()),
        format!("Session ID: {}", record.id),
        format!("Workspace: {}", display_path(&record.workspace_root)),
        format!("Existing turns: {}", record.turn_count()),
    ];

    if let Some(parent_id) = &record.parent_id {
        lines.push(format!("Parent session: {}", parent_id));
    }

    lines.push("Recent turn summaries".to_string());
    for turn in record
        .turns
        .iter()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .iter()
        .rev()
    {
        let mut summary = format!(
            "- [{}] {} | mode={} | provider={} | sandbox={}",
            turn.index,
            summarize_task(&turn.input),
            turn.mode,
            turn.provider_id,
            turn.sandbox
        );
        if let Some(command) = &turn.active_command {
            summary.push_str(&format!(" | command={}", command));
        }
        if let Some(skill) = &turn.active_skill {
            summary.push_str(&format!(" | skill={}", skill));
        }
        if turn.tool_invocation_count > 0 {
            summary.push_str(&format!(" | tools={}", turn.tool_invocation_count));
        }
        lines.push(summary);
    }

    lines.join("\n")
}
