use std::path::PathBuf;

use crate::agent::AgentEvent;

#[derive(Clone, Debug)]
pub struct CheckpointRecord {
    pub file_name: String,
    pub summary: String,
}

#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub workspace_root: PathBuf,
    pub created_at_secs: u64,
    pub updated_at_secs: u64,
    pub turns: Vec<SessionTurnRecord>,
}

impl SessionRecord {
    pub fn turn_count(&self) -> usize {
        self.turns.len()
    }

    pub fn latest_turn(&self) -> Option<&SessionTurnRecord> {
        self.turns.last()
    }
}

#[derive(Clone, Debug)]
pub struct SessionTurnRecord {
    pub index: usize,
    pub timestamp_secs: u64,
    pub mode: String,
    pub provider_id: String,
    pub provider_label: String,
    pub sandbox: String,
    pub trust_label: String,
    pub active_command: Option<String>,
    pub active_skill: Option<String>,
    pub input: String,
    pub prompt: String,
    pub final_response: Option<String>,
    pub turns_used: usize,
    pub tool_invocation_count: usize,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub total_tokens: usize,
    pub api_calls: usize,
    pub events: Vec<AgentEvent>,
}

#[derive(Clone, Debug, Default)]
pub struct SessionExecutionData {
    pub final_response: Option<String>,
    pub turns_used: usize,
    pub tool_invocation_count: usize,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub total_tokens: usize,
    pub api_calls: usize,
    pub events: Vec<AgentEvent>,
}

#[derive(Clone, Debug)]
pub struct SessionListEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub workspace_root: PathBuf,
    pub created_at_secs: u64,
    pub updated_at_secs: u64,
    pub turn_count: usize,
    pub latest_provider_id: String,
    pub latest_summary: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionReuseMode {
    Resume,
    Fork,
}

impl SessionReuseMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Resume => "resume",
            Self::Fork => "fork",
        }
    }
}
