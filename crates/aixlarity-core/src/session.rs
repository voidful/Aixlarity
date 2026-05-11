pub mod history;
mod model;
mod render;
mod storage;

pub use model::{
    CheckpointRecord, SessionExecutionData, SessionListEntry, SessionRecord, SessionReuseMode,
    SessionTurnRecord,
};
pub use render::render_session_context;
pub use storage::{
    append_session_turn, delete_session, fork_session, list_checkpoints, list_sessions,
    load_session, save_checkpoint, save_new_session,
};

#[cfg(test)]
mod tests {
    use super::{
        append_session_turn, fork_session, list_sessions, load_session, render_session_context,
        save_new_session, SessionExecutionData, SessionReuseMode,
    };
    use crate::agent::AgentEvent;
    use crate::config::SandboxPolicy;
    use crate::prompt::PromptAssembly;
    use crate::providers::builtin_provider;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn saves_and_loads_session_round_trip() {
        let root = unique_dir("session-round-trip");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let record = save_new_session(
            &root,
            &workspace,
            None,
            "/review src/app.rs",
            &sample_assembly(&workspace, "first prompt"),
            "plan",
            None,
        )
        .unwrap();

        let loaded = load_session(&root, &record.id).unwrap();
        assert_eq!(loaded.id, record.id);
        assert_eq!(loaded.turn_count(), 1);
        assert_eq!(loaded.latest_turn().unwrap().input, "/review src/app.rs");
        assert_eq!(loaded.latest_turn().unwrap().prompt, "first prompt");
        assert_eq!(loaded.latest_turn().unwrap().mode, "plan");
    }

    #[test]
    fn appends_turns_and_lists_latest_first() {
        let root = unique_dir("session-list");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let record = save_new_session(
            &root,
            &workspace,
            None,
            "first task",
            &sample_assembly(&workspace, "prompt one"),
            "plan",
            None,
        )
        .unwrap();
        append_session_turn(
            &root,
            &record.id,
            "second task",
            &sample_assembly(&workspace, "prompt two"),
            "plan",
            None,
        )
        .unwrap();

        let sessions = list_sessions(&root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].turn_count, 2);
        assert_eq!(sessions[0].latest_summary, "second task");
    }

    #[test]
    fn forks_session_and_preserves_parent_link() {
        let root = unique_dir("session-fork");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let original = save_new_session(
            &root,
            &workspace,
            None,
            "review providers",
            &sample_assembly(&workspace, "prompt one"),
            "plan",
            None,
        )
        .unwrap();
        let forked = fork_session(&root, &original.id).unwrap();
        let loaded = load_session(&root, &forked.id).unwrap();
        assert_eq!(loaded.parent_id.as_deref(), Some(original.id.as_str()));
        assert_eq!(loaded.turn_count(), 1);

        let context = render_session_context(&loaded, SessionReuseMode::Fork);
        assert!(context.contains("Mode: fork"));
        assert!(context.contains("review providers"));
    }

    #[test]
    fn preserves_execution_metadata_in_session_turns() {
        let root = unique_dir("session-runtime");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let execution = SessionExecutionData {
            final_response: Some("done".to_string()),
            turns_used: 3,
            tool_invocation_count: 2,
            prompt_tokens: 120,
            completion_tokens: 80,
            total_tokens: 200,
            api_calls: 2,
            events: vec![AgentEvent::RunCompleted {
                turns_used: 3,
                tool_invocation_count: 2,
                total_tokens: 200,
                api_calls: 2,
                final_response: "done".to_string(),
            }],
        };

        let record = save_new_session(
            &root,
            &workspace,
            None,
            "ship it",
            &sample_assembly(&workspace, "runtime prompt"),
            "live",
            Some(&execution),
        )
        .unwrap();

        let loaded = load_session(&root, &record.id).unwrap();
        let turn = loaded.latest_turn().unwrap();
        assert_eq!(turn.mode, "live");
        assert_eq!(turn.final_response.as_deref(), Some("done"));
        assert_eq!(turn.tool_invocation_count, 2);
        assert_eq!(turn.total_tokens, 200);
        assert_eq!(turn.events.len(), 1);
    }

    fn sample_assembly(workspace_root: &Path, prompt: &str) -> PromptAssembly {
        PromptAssembly {
            provider: builtin_provider("openai-codex").unwrap(),
            workspace_root: workspace_root.to_path_buf(),
            trust_label: "trusted".to_string(),
            sandbox: SandboxPolicy::WorkspaceWrite,
            active_command: Some("review".to_string()),
            active_skill: Some("code-review".to_string()),
            attachments: Vec::new(),
            pending_shell_commands: Vec::new(),
            final_prompt: prompt.to_string(),
        }
    }

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-{}-{}", label, stamp))
    }
}
