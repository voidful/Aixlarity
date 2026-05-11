// Aixlarity — Application facade
//
// Routes CLI commands to the appropriate subsystem.
// Rewritten to use serde-based output and thiserror for errors.

use std::env;
use std::io;
use std::path::{Path, PathBuf};

use crate::agent::memory::read_memory;
use crate::agent::{run_agent, AgentEvent, AgentRunOptions, PermissionLevel};
use crate::commands::CommandCatalog;
use crate::config::{display_path, AppPaths, RuntimePreferences, SandboxPolicy};
use crate::instructions::InstructionBundle;
use crate::output::{
    render_exec_output, render_provider_output, truncate_text, AppOutput, CatalogCommandJson,
    CatalogListJson, CatalogSkillJson, CheckpointEntryJson, CheckpointListJson, CountsJson,
    OverviewJson, ProviderDoctorJson, ProviderJson, ProviderListJson, ProviderModelsJson,
    ReloadJson, SessionEntryJson, SessionListJson, TrustSetJson, TrustStatusJson,
};
use crate::plugins::PluginCatalog;
use crate::prompt::{assemble_prompt, PromptAssembly, PromptRequest};
use crate::providers::{ProviderRegistry, ProviderScope};
use crate::session::{
    append_session_turn, fork_session, history::HistoryStore, list_checkpoints, list_sessions,
    load_session, save_checkpoint, save_new_session, SessionExecutionData, SessionRecord,
    SessionReuseMode,
};
use crate::skills::SkillCatalog;
use crate::tools::build_memory_prompt_block;
use crate::trust::{TrustRule, TrustRuleKind, TrustStore};
use crate::workspace::Workspace;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Runtime(#[from] anyhow::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Clone)]
pub struct App {
    paths: AppPaths,
    preferences: RuntimePreferences,
}

impl App {
    pub fn new(current_dir: PathBuf) -> Self {
        Self {
            paths: AppPaths::detect(current_dir),
            preferences: RuntimePreferences::default(),
        }
    }

    pub fn current_dir(&self) -> &Path {
        &self.paths.current_dir
    }

    pub async fn handle(&self, command: AppCommand) -> AppResult<AppOutput> {
        match command {
            AppCommand::Overview => self.overview(),
            AppCommand::ProvidersList => self.providers_list(),
            AppCommand::ProvidersCurrent => self.providers_current(),
            AppCommand::ProvidersShow { id } => self.providers_show(id),
            AppCommand::ProvidersUse { id, scope } => self.providers_use(id, scope),
            AppCommand::ProvidersAdd { profile, scope } => self.providers_add(profile, scope),
            AppCommand::ProvidersRemove { id, scope } => self.providers_remove(id, scope),
            AppCommand::ProvidersModels { id } => self.providers_models(id).await,
            AppCommand::ProvidersUpdate { id, model } => self.providers_update(id, model),
            AppCommand::ProvidersDoctor { id } => self.providers_doctor(id),
            AppCommand::CommandsList => self.commands_list(),
            AppCommand::CommandsReload => self.commands_reload(),
            AppCommand::TrustStatus { path } => self.trust_status(path),
            AppCommand::TrustSet { path, kind } => self.trust_set(path, kind),
            AppCommand::CheckpointsList => self.checkpoints_list(),
            AppCommand::SessionsList => self.sessions_list(),
            AppCommand::SessionsShow { id } => self.sessions_show(id),
            AppCommand::SessionsTurns { id } => self.sessions_turns(id),
            AppCommand::SessionsRemove { id } => self.sessions_remove(id),
            AppCommand::SessionsFork { id } => self.sessions_fork(id),
            AppCommand::SessionsReplay { id, turn } => self.sessions_replay(id, turn),
            AppCommand::HistoryList { limit } => self.history_list(limit),
            AppCommand::HistoryRevert { id } => self.history_revert(id),
            AppCommand::HistoryTrack { path, source } => self.history_track(path, source),
            AppCommand::HistoryFileRevisions { path } => self.history_file_revisions(path),
            AppCommand::HistoryGetBlob { hash } => self.history_get_blob(hash),
            AppCommand::ExternalCliDetect => self.external_cli_detect(),
            AppCommand::ExternalCliRead { cli, scope } => self.external_cli_read(cli, scope),
            AppCommand::ExternalCliWrite {
                cli,
                scope,
                content,
            } => self.external_cli_write(cli, scope, content),
            AppCommand::ExternalCliWriteInstruction { cli, content } => {
                self.external_cli_write_instruction(cli, content)
            }
            AppCommand::Exec(options) => self.exec(options).await,
        }
    }

    fn overview(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let current_provider =
            providers.current_profile(self.preferences.default_provider_id.as_deref())?;
        let commands = CommandCatalog::load(&self.paths, &workspace, &trust)?;
        let skills = SkillCatalog::load(&self.paths, &workspace, &trust)?;
        let instructions = InstructionBundle::load(&workspace, &trust, None)?;
        let sessions = list_sessions(&self.paths.sessions_dir())?;

        let lines = vec![
            "Aixlarity".to_string(),
            format!("Workspace: {}", display_path(&workspace.root)),
            format!("Detected by: {}", workspace.detected_by),
            format!("Trust: {}", trust.status_label()),
            format!(
                "Current provider: {} ({})",
                current_provider.id, current_provider.label
            ),
            format!(
                "Sandbox default: {}",
                self.preferences.default_sandbox.as_str()
            ),
            format!("Registered providers: {}", providers.profiles().len()),
            format!("Instructions loaded: {}", instructions.sources.len()),
            format!("Custom commands loaded: {}", commands.commands.len()),
            format!("Skills loaded: {}", skills.skills.len()),
            format!("Saved sessions: {}", sessions.len()),
            "Use `aixlarity exec ...` to run a coding task.".to_string(),
        ];

        let json = OverviewJson {
            app: "Aixlarity".to_string(),
            workspace: display_path(&workspace.root),
            detected_by: workspace.detected_by,
            trust: trust.status_label().to_string(),
            current_provider: ProviderJson::from(&current_provider),
            default_sandbox: self.preferences.default_sandbox.as_str().to_string(),
            counts: CountsJson {
                providers: providers.profiles().len(),
                instructions: instructions.sources.len(),
                commands: commands.commands.len(),
                skills: skills.skills.len(),
                sessions: sessions.len(),
            },
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn providers_list(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let current = providers.current_profile(self.preferences.default_provider_id.as_deref())?;

        let mut lines = vec![
            "Available providers".to_string(),
            format!("Current: {} ({})", current.id, current.label),
        ];
        for p in providers.profiles() {
            lines.push(format!(
                "  {} {} :: {} ({})",
                if p.id == current.id { "*" } else { " " },
                p.id,
                p.label,
                p.model
            ));
        }

        let json = ProviderListJson {
            current: ProviderJson::from(&current),
            active_global: providers.active_global().map(|s| s.to_string()),
            active_workspace: providers.active_workspace().map(|s| s.to_string()),
            providers: providers
                .profiles()
                .iter()
                .map(ProviderJson::from)
                .collect(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn providers_current(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let provider =
            providers.current_profile(self.preferences.default_provider_id.as_deref())?;
        Ok(render_provider_output(
            "Current provider",
            &provider,
            providers.active_global(),
            providers.active_workspace(),
        ))
    }

    fn providers_show(&self, id: String) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let provider = providers
            .find(&id)
            .cloned()
            .ok_or_else(|| AppError::Message(format!("unknown provider: {}", id)))?;
        Ok(render_provider_output(
            "Provider details",
            &provider,
            providers.active_global(),
            providers.active_workspace(),
        ))
    }

    fn providers_use(&self, id: String, scope: ProviderScope) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        if scope == ProviderScope::Workspace && trust.restricts_project_config() {
            return Err(AppError::Message(
                "workspace-scoped provider switching is blocked for untrusted workspaces"
                    .to_string(),
            ));
        }
        let mut providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let provider = providers.set_active(&id, scope)?;

        let lines = vec![
            "Provider updated".to_string(),
            format!("Scope: {}", scope.as_str()),
            format!("Provider: {} ({})", provider.id, provider.label),
        ];

        #[derive(serde::Serialize)]
        struct ProviderUseJson {
            scope: String,
            provider: ProviderJson,
        }
        let json = ProviderUseJson {
            scope: scope.as_str().to_string(),
            provider: ProviderJson::from(&provider),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn providers_add(
        &self,
        profile: crate::providers::ProviderProfile,
        scope: ProviderScope,
    ) -> AppResult<AppOutput> {
        let normalized_id = profile.id.trim().to_ascii_lowercase();
        let valid_id = !normalized_id.is_empty()
            && normalized_id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !valid_id {
            return Err(AppError::Message(
                "provider id must contain only lowercase letters, numbers, '-' or '_'".to_string(),
            ));
        }
        if profile.label.trim().is_empty() {
            return Err(AppError::Message(
                "provider label must not be empty".to_string(),
            ));
        }
        if profile.model.trim().is_empty() {
            return Err(AppError::Message(
                "provider model must not be empty".to_string(),
            ));
        }
        if profile.family.as_str() != "external-cli" {
            if profile.api_base.trim().is_empty() {
                return Err(AppError::Message(
                    "provider API base must not be empty".to_string(),
                ));
            }
            if profile.api_key_env.trim().is_empty()
                || !profile
                    .api_key_env
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(AppError::Message(
                    "provider API key env must contain only uppercase letters, numbers or '_'"
                        .to_string(),
                ));
            }
        }

        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        if scope == ProviderScope::Workspace && trust.restricts_project_config() {
            return Err(AppError::Message(
                "workspace-scoped provider creation is blocked for untrusted workspaces"
                    .to_string(),
            ));
        }
        let mut providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let stored = providers.add_provider_scoped(profile, scope)?;

        let lines = vec![
            "Provider added".to_string(),
            format!("Scope: {}", scope.as_str()),
            format!("Provider: {} ({})", stored.id, stored.label),
        ];

        #[derive(serde::Serialize)]
        struct ProviderAddJson {
            scope: String,
            provider: ProviderJson,
        }
        let json = ProviderAddJson {
            scope: scope.as_str().to_string(),
            provider: ProviderJson::from(&stored),
        };

        Ok(AppOutput::new(lines, &json))
    }

    async fn providers_models(&self, id: String) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;

        let models = providers.list_models(&id).await?;

        let lines = vec![
            format!("Available models for {}:", id),
            format!("  {}", models.join(", ")),
        ];

        let json = ProviderModelsJson { id, models };

        Ok(AppOutput::new(lines, &json))
    }

    fn providers_update(&self, id: String, model: String) -> AppResult<AppOutput> {
        let model = model.trim().to_string();
        if model.is_empty() {
            return Err(AppError::Message(
                "provider model must not be empty".to_string(),
            ));
        }

        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let mut providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let stored = providers.update_model(&id, &model)?;

        let lines = vec![
            "Provider model updated".to_string(),
            format!("Provider: {} ({})", stored.id, stored.label),
            format!("New Model: {}", stored.model),
        ];

        #[derive(serde::Serialize)]
        struct ProviderUpdateJson {
            provider: ProviderJson,
        }
        let json = ProviderUpdateJson {
            provider: ProviderJson::from(&stored),
        };

        Ok(AppOutput::new(lines, &json))
    }
    fn providers_remove(&self, id: String, scope: ProviderScope) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        if scope == ProviderScope::Workspace && trust.restricts_project_config() {
            return Err(AppError::Message(
                "workspace-scoped provider removal is blocked for untrusted workspaces".to_string(),
            ));
        }
        let mut providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        providers.remove_provider_scoped(&id, scope)?;

        let lines = vec![
            "Provider removed".to_string(),
            format!("Scope: {}", scope.as_str()),
            format!("Provider: {}", id),
        ];

        #[derive(serde::Serialize)]
        struct ProviderRemoveJson {
            scope: String,
            removed: String,
        }
        let json = ProviderRemoveJson {
            scope: scope.as_str().to_string(),
            removed: id.clone(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn providers_doctor(&self, id: Option<String>) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let report = providers.doctor(
            id.as_deref(),
            self.preferences.default_provider_id.as_deref(),
        )?;

        let mut lines = vec![
            "Provider doctor".to_string(),
            format!("Provider: {} ({})", report.profile.id, report.profile.label),
            format!("API key present: {}", report.api_key_present),
            format!("Active scope: {}", report.active_scope),
        ];
        if let Some(masked) = &report.masked_api_key {
            lines.push(format!("Masked key: {}", masked));
        }

        let json = ProviderDoctorJson {
            profile: ProviderJson::from(&report.profile),
            active_scope: report.active_scope.to_string(),
            api_key_present: report.api_key_present,
            masked_api_key: report.masked_api_key.clone(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn commands_reload(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let commands = CommandCatalog::load(&self.paths, &workspace, &trust)?;
        let skills = SkillCatalog::load(&self.paths, &workspace, &trust)?;

        let lines = vec![
            "Reload complete".to_string(),
            format!("Workspace: {}", display_path(&workspace.root)),
            format!("Commands: {}", commands.commands.len()),
            format!("Skills: {}", skills.skills.len()),
        ];

        let json = ReloadJson {
            workspace: display_path(&workspace.root),
            trust: trust.status_label().to_string(),
            commands: commands.commands.len(),
            skills: skills.skills.len(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn commands_list(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let commands = CommandCatalog::load(&self.paths, &workspace, &trust)?;
        let skills = SkillCatalog::load(&self.paths, &workspace, &trust)?;

        let lines = vec![
            "Catalog".to_string(),
            format!("Workspace: {}", display_path(&workspace.root)),
            format!("Trust: {}", trust.status_label()),
            format!("Commands: {}", commands.commands.len()),
            format!("Skills: {}", skills.skills.len()),
        ];

        let json = CatalogListJson {
            workspace: display_path(&workspace.root),
            trust: trust.status_label().to_string(),
            commands: commands
                .commands
                .iter()
                .map(CatalogCommandJson::from)
                .collect(),
            skills: skills.skills.iter().map(CatalogSkillJson::from).collect(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn trust_status(&self, path: Option<PathBuf>) -> AppResult<AppOutput> {
        let target = match path {
            Some(p) => self.resolve_current_dir_path(p)?,
            None => Workspace::discover(&self.paths.current_dir)?.root,
        };
        let trust = self.current_trust_state(&target)?;

        let lines = vec![
            "Trust status".to_string(),
            format!("Path: {}", display_path(&target)),
            format!("Status: {}", trust.status_label()),
        ];

        let json = TrustStatusJson {
            path: display_path(&target),
            status: trust.status_label().to_string(),
            matched_rule: trust.matched_path.as_ref().map(|p| display_path(p)),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn trust_set(&self, path: PathBuf, kind: TrustRuleKind) -> AppResult<AppOutput> {
        let path = self.resolve_current_dir_path(path)?;
        let mut store = TrustStore::load(&self.paths.trust_store_path())?;
        store.upsert(TrustRule {
            kind: kind.clone(),
            path: path.clone(),
        });
        store.save(&self.paths.trust_store_path())?;

        let lines = vec![
            "Trust rule updated".to_string(),
            format!("Path: {}", display_path(&path)),
            format!("Rule: {}", kind.as_str()),
        ];

        let json = TrustSetJson {
            path: display_path(&path),
            rule: kind.as_str().to_string(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn checkpoints_list(&self) -> AppResult<AppOutput> {
        let checkpoints = list_checkpoints(&self.paths.checkpoints_dir())?;
        let mut lines = vec!["Checkpoints".to_string()];
        if checkpoints.is_empty() {
            lines.push("No checkpoints saved yet.".to_string());
        } else {
            for c in &checkpoints {
                lines.push(format!("- {} :: {}", c.file_name, c.summary));
            }
        }

        let json = CheckpointListJson {
            checkpoints: checkpoints.iter().map(CheckpointEntryJson::from).collect(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_list(&self) -> AppResult<AppOutput> {
        let sessions = list_sessions(&self.paths.sessions_dir())?;
        let mut lines = vec!["Sessions".to_string()];
        if sessions.is_empty() {
            lines.push("No sessions saved yet.".to_string());
        } else {
            for s in &sessions {
                lines.push(format!(
                    "- {} :: {} :: {} turns",
                    s.id, s.latest_summary, s.turn_count
                ));
            }
        }

        let json = SessionListJson {
            sessions: sessions.iter().map(SessionEntryJson::from).collect(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_show(&self, id: String) -> AppResult<AppOutput> {
        let record = load_session(&self.paths.sessions_dir(), &id)?;
        let latest = record
            .latest_turn()
            .ok_or_else(|| AppError::Message("session has no turns".to_string()))?;

        let lines = vec![
            "Session".to_string(),
            format!("ID: {}", record.id),
            format!("Workspace: {}", display_path(&record.workspace_root)),
            format!("Turns: {}", record.turn_count()),
            format!("Latest mode: {}", latest.mode),
            format!("Latest task: {}", truncate_text(&latest.input, 120)),
        ];
        let mut lines = lines;
        if let Some(final_response) = &latest.final_response {
            lines.push(format!(
                "Latest response: {}",
                truncate_text(final_response, 120)
            ));
        }
        if latest.tool_invocation_count > 0 {
            lines.push(format!(
                "Latest tool calls: {}",
                latest.tool_invocation_count
            ));
        }
        if !latest.events.is_empty() {
            lines.push(format!("Latest events: {}", latest.events.len()));
        }

        #[derive(serde::Serialize)]
        struct SessionShowJson {
            id: String,
            workspace: String,
            turn_count: usize,
            latest_mode: String,
            latest_task: String,
            latest_response: Option<String>,
            latest_tool_invocation_count: usize,
            latest_total_tokens: usize,
            latest_api_calls: usize,
            latest_event_count: usize,
            latest_events: Vec<AgentEvent>,
        }
        let json = SessionShowJson {
            id: record.id.clone(),
            workspace: display_path(&record.workspace_root),
            turn_count: record.turn_count(),
            latest_mode: latest.mode.clone(),
            latest_task: latest.input.clone(),
            latest_response: latest.final_response.clone(),
            latest_tool_invocation_count: latest.tool_invocation_count,
            latest_total_tokens: latest.total_tokens,
            latest_api_calls: latest.api_calls,
            latest_event_count: latest.events.len(),
            latest_events: latest.events.clone(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_turns(&self, id: String) -> AppResult<AppOutput> {
        let record = load_session(&self.paths.sessions_dir(), &id)?;

        #[derive(serde::Serialize)]
        struct TurnSummary {
            index: usize,
            timestamp_secs: u64,
            mode: String,
            provider_id: String,
            provider_label: String,
            sandbox: String,
            trust_label: String,
            input: String,
            final_response: Option<String>,
            tool_invocation_count: usize,
            total_tokens: usize,
        }

        #[derive(serde::Serialize)]
        struct SessionTurnsJson {
            id: String,
            turns: Vec<TurnSummary>,
        }

        let json = SessionTurnsJson {
            id: record.id.clone(),
            turns: record
                .turns
                .iter()
                .map(|t| TurnSummary {
                    index: t.index,
                    timestamp_secs: t.timestamp_secs,
                    mode: t.mode.clone(),
                    provider_id: t.provider_id.clone(),
                    provider_label: t.provider_label.clone(),
                    sandbox: t.sandbox.clone(),
                    trust_label: t.trust_label.clone(),
                    input: t.input.clone(),
                    final_response: t.final_response.clone(),
                    tool_invocation_count: t.tool_invocation_count,
                    total_tokens: t.total_tokens,
                })
                .collect(),
        };

        let lines = vec![format!(
            "{} turns found for session {}",
            record.turn_count(),
            id
        )];
        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_remove(&self, id: String) -> AppResult<AppOutput> {
        crate::session::delete_session(&self.paths.sessions_dir(), &id)?;
        let lines = vec![format!("Deleted session {}", id)];

        #[derive(serde::Serialize)]
        struct SessionRemoveJson {
            id: String,
            deleted: bool,
        }
        let json = SessionRemoveJson {
            id: id.clone(),
            deleted: true,
        };
        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_fork(&self, id: String) -> AppResult<AppOutput> {
        let forked = fork_session(&self.paths.sessions_dir(), &id)?;

        let lines = vec![
            "Session forked".to_string(),
            format!("Source: {}", id),
            format!("New session: {}", forked.id),
            format!("Turns copied: {}", forked.turn_count()),
        ];

        #[derive(serde::Serialize)]
        struct ForkJson {
            source_id: String,
            new_id: String,
            turn_count: usize,
        }
        let json = ForkJson {
            source_id: id,
            new_id: forked.id.clone(),
            turn_count: forked.turn_count(),
        };

        Ok(AppOutput::new(lines, &json))
    }

    fn sessions_replay(&self, id: String, turn: Option<usize>) -> AppResult<AppOutput> {
        let loaded = load_session(&self.paths.sessions_dir(), &id)?;
        let mut lines = vec![format!("Replay Session: {}", id)];
        let target_turn = turn.unwrap_or_else(|| loaded.turn_count().saturating_sub(1));
        if let Some(turn_data) = loaded.turns.get(target_turn) {
            lines.push(format!("Turn Context: {}", turn_data.input));
            for ev in &turn_data.events {
                lines.push(format!("- {:?}", ev));
            }
        }

        let json = serde_json::json!({
            "id": id,
            "target_turn": target_turn,
            "turn_data": loaded.turns.get(target_turn).map(|t| {
                serde_json::json!({
                    "index": t.index,
                    "mode": t.mode,
                    "input": t.input,
                    "event_count": t.events.len()
                })
            })
        });
        Ok(AppOutput::new(lines, &json))
    }

    fn history_list(&self, limit: usize) -> AppResult<AppOutput> {
        let root = &self.paths.current_dir;
        let history = HistoryStore::new(root);
        let transactions = history.get_recent_transactions(limit).unwrap_or_default();
        let mut lines = vec![format!("Recent History Transactions (Limit: {})", limit)];
        for tx in &transactions {
            lines.push(format!("- [{}] {}: {}", tx.id, tx.tool_name, tx.file_path));
        }
        let json = serde_json::json!({ "transactions": transactions });
        Ok(AppOutput::new(lines, &json))
    }

    fn history_revert(&self, id: String) -> AppResult<AppOutput> {
        let root = &self.paths.current_dir;
        let history = HistoryStore::new(root);
        match history.revert_transaction(&id) {
            Ok(_) => {
                let msg = format!("Successfully reverted history transaction {}", id);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "success", "message": msg }),
                ))
            }
            Err(e) => {
                let msg = format!("Failed to revert transaction {}: {}", id, e);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ))
            }
        }
    }

    fn resolve_history_file_path(&self, file_path: &str) -> AppResult<(PathBuf, PathBuf)> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let root = std::fs::canonicalize(&workspace.root).unwrap_or(workspace.root);
        let raw_path = PathBuf::from(file_path);
        let path = if raw_path.is_absolute() {
            raw_path
        } else {
            root.join(raw_path)
        };
        let canonical_path = std::fs::canonicalize(&path)?;

        if !canonical_path.starts_with(&root) {
            return Err(AppError::Message("path is outside workspace".to_string()));
        }

        Ok((root, canonical_path))
    }

    fn history_track(&self, file_path: String, source: String) -> AppResult<AppOutput> {
        let (root, canonical_path) = match self.resolve_history_file_path(&file_path) {
            Ok(resolved) => resolved,
            Err(e) => {
                let msg = format!("Failed to track history for {}: {}", file_path, e);
                return Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ));
            }
        };

        let history = HistoryStore::new(&root);

        // Use the default tool name "User Save" for tracking user actions
        let tool_name = if source == "user" {
            "User Save"
        } else {
            "System Tracking"
        };

        match history.snapshot_current(&source, tool_name, &canonical_path) {
            Ok(tx_id) => {
                let msg = format!("Tracked history transaction {} for {}", tx_id, file_path);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "success", "id": tx_id }),
                ))
            }
            Err(e) => {
                let msg = format!("Failed to track history for {}: {}", file_path, e);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ))
            }
        }
    }

    fn history_file_revisions(&self, file_path: String) -> AppResult<AppOutput> {
        let (root, canonical_path) = match self.resolve_history_file_path(&file_path) {
            Ok(resolved) => resolved,
            Err(e) => {
                let msg = format!("Failed to get revisions for {}: {}", file_path, e);
                return Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ));
            }
        };
        let history = HistoryStore::new(&root);
        let canonical_file_path = canonical_path.to_string_lossy().to_string();
        match history.get_file_revisions(&canonical_file_path) {
            Ok(revisions) => {
                let mut lines = vec![format!("Revisions for {}", file_path)];
                for tx in &revisions {
                    lines.push(format!(
                        "- [{}] {} (Source: {})",
                        tx.id, tx.tool_name, tx.source
                    ));
                }
                Ok(AppOutput::new(
                    lines,
                    &serde_json::json!({ "path": canonical_file_path, "revisions": revisions }),
                ))
            }
            Err(e) => {
                let msg = format!("Failed to get revisions: {}", e);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ))
            }
        }
    }

    fn history_get_blob(&self, hash: String) -> AppResult<AppOutput> {
        let root = &self.paths.current_dir;
        let history = HistoryStore::new(root);
        match history.get_blob(&hash) {
            Ok(content) => {
                // Return the content directly in the json
                Ok(AppOutput::new(
                    vec![format!("Fetched blob {}", hash)],
                    &serde_json::json!({ "status": "success", "content": content }),
                ))
            }
            Err(e) => {
                let msg = format!("Failed to fetch blob {}: {}", hash, e);
                Ok(AppOutput::new(
                    vec![msg.clone()],
                    &serde_json::json!({ "status": "error", "error": msg }),
                ))
            }
        }
    }

    // --- External CLI Config Handlers ---
    // Design: These handlers let the IDE read/write config files for external
    // AI coding CLIs (Claude Code, Gemini CLI, Codex CLI) through a unified
    // interface. This avoids users having to manually locate and edit files.

    fn external_cli_detect(&self) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let results = crate::external_cli_config::detect_installed_clis(&workspace.root);

        let lines = vec![
            "External CLI Detection".to_string(),
            format!(
                "Found {} CLI(s)",
                results.iter().filter(|r| r.installed).count()
            ),
        ];

        Ok(AppOutput::new(
            lines,
            &serde_json::json!({ "clis": results }),
        ))
    }

    fn external_cli_read(&self, cli: String, scope: String) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        match crate::external_cli_config::read_cli_config(&cli, &scope, &workspace.root) {
            Ok((content, format)) => Ok(AppOutput::new(
                vec![format!("Read {} config ({})", cli, scope)],
                &serde_json::json!({
                    "status": "success",
                    "cli": cli,
                    "scope": scope,
                    "format": format,
                    "content": content,
                }),
            )),
            Err(e) => Ok(AppOutput::new(
                vec![format!("Failed to read {} config: {}", cli, e)],
                &serde_json::json!({
                    "status": "error",
                    "error": e,
                }),
            )),
        }
    }

    fn external_cli_write(
        &self,
        cli: String,
        scope: String,
        content: String,
    ) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        match crate::external_cli_config::write_cli_config(&cli, &scope, &content, &workspace.root)
        {
            Ok(path) => Ok(AppOutput::new(
                vec![format!("Wrote {} config to {}", cli, path)],
                &serde_json::json!({
                    "status": "success",
                    "cli": cli,
                    "scope": scope,
                    "path": path,
                }),
            )),
            Err(e) => Ok(AppOutput::new(
                vec![format!("Failed to write {} config: {}", cli, e)],
                &serde_json::json!({
                    "status": "error",
                    "error": e,
                }),
            )),
        }
    }

    fn external_cli_write_instruction(&self, cli: String, content: String) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        match crate::external_cli_config::write_instruction_file(&cli, &content, &workspace.root) {
            Ok(path) => Ok(AppOutput::new(
                vec![format!("Wrote {} instruction file to {}", cli, path)],
                &serde_json::json!({
                    "status": "success",
                    "cli": cli,
                    "path": path,
                }),
            )),
            Err(e) => Ok(AppOutput::new(
                vec![format!("Failed to write {} instruction file: {}", cli, e)],
                &serde_json::json!({
                    "status": "error",
                    "error": e,
                }),
            )),
        }
    }

    async fn exec(&self, options: ExecOptions) -> AppResult<AppOutput> {
        let workspace = Workspace::discover(&self.paths.current_dir)?;
        let trust = self.current_trust_state(&workspace.root)?;
        let providers = ProviderRegistry::load(&self.paths, &workspace, &trust)?;
        let commands = CommandCatalog::load(&self.paths, &workspace, &trust)?;
        let skills = SkillCatalog::load(&self.paths, &workspace, &trust)?;
        let instructions = InstructionBundle::load(&workspace, &trust, options.persona.as_deref())?;
        let plugins = PluginCatalog::load(&self.paths, &workspace, &trust)?;
        let provider = providers.resolve_profile(
            options.provider.as_deref(),
            self.preferences.default_provider_id.as_deref(),
        )?;
        let sandbox = options
            .sandbox
            .unwrap_or_else(|| self.preferences.default_sandbox.clone());

        let session_source = match (
            options.resume_session.as_deref(),
            options.fork_session.as_deref(),
        ) {
            (Some(id), None) => Some((
                SessionReuseMode::Resume,
                self.load_session_for_workspace(&workspace.root, id)?,
            )),
            (None, Some(id)) => Some((
                SessionReuseMode::Fork,
                self.load_session_for_workspace(&workspace.root, id)?,
            )),
            (None, None) => None,
            (Some(_), Some(_)) => {
                return Err(AppError::Message(
                    "resume and fork modes are mutually exclusive".to_string(),
                ))
            }
        };

        // Dual memory: try new tool-based memory (MEMORY.md + USER.md via §-delimited
        // entries) first, fall back to legacy section-based MEMORY.md.
        let memory_content =
            build_memory_prompt_block(&workspace.root).or_else(|| read_memory(&workspace.root));

        let assembly = assemble_prompt(PromptRequest {
            workspace: &workspace,
            trust: &trust,
            sandbox,
            provider,
            instructions: &instructions,
            commands: &commands,
            skills: &skills,
            selected_skill: options.skill.as_deref(),
            user_input: &options.input,
            memory_content: memory_content.as_deref(),
            ide_context: options.ide_context.as_ref(),
        })?;

        // Legacy text injection removed for Antigravity Request Mapper.
        // Full history will be passed via AgentRunOptions::source_session instead.

        let checkpoint_path = if options.checkpoint {
            Some(save_checkpoint(&self.paths.checkpoints_dir(), &assembly)?)
        } else {
            None
        };

        let source_session_meta = session_source
            .as_ref()
            .map(|(mode, record)| (mode.as_str().to_string(), record.id.clone()));

        if options.plan_only {
            let planned_events = build_execution_events(
                "plan",
                &assembly,
                checkpoint_path.as_deref(),
                source_session_meta.as_ref(),
                &[],
                None,
            );
            let execution = SessionExecutionData {
                events: planned_events.clone(),
                ..Default::default()
            };
            let plan_saved_session = if options.persist_session {
                match &session_source {
                    Some((SessionReuseMode::Resume, record)) => Some((
                        "updated",
                        append_session_turn(
                            &self.paths.sessions_dir(),
                            &record.id,
                            &options.input,
                            &assembly,
                            "plan",
                            Some(&execution),
                        )?,
                    )),
                    Some((SessionReuseMode::Fork, record)) => {
                        let forked = fork_session(&self.paths.sessions_dir(), &record.id)?;
                        Some((
                            "forked",
                            append_session_turn(
                                &self.paths.sessions_dir(),
                                &forked.id,
                                &options.input,
                                &assembly,
                                "plan",
                                Some(&execution),
                            )?,
                        ))
                    }
                    None => Some((
                        "created",
                        save_new_session(
                            &self.paths.sessions_dir(),
                            &workspace.root,
                            None,
                            &options.input,
                            &assembly,
                            "plan",
                            Some(&execution),
                        )?,
                    )),
                }
            } else {
                None
            };
            let persisted_session_meta = plan_saved_session
                .as_ref()
                .map(|(action, record)| (action.to_string(), record.clone()));
            let output_events = build_execution_events(
                "plan",
                &assembly,
                checkpoint_path.as_deref(),
                source_session_meta.as_ref(),
                &[],
                plan_saved_session
                    .as_ref()
                    .map(|(action, record)| (*action, record)),
            );
            return Ok(render_exec_output(
                &assembly,
                checkpoint_path,
                source_session_meta,
                persisted_session_meta,
                &output_events,
                options.print_prompt,
                None,
            ));
        }

        let api_key = self.read_provider_api_key(&assembly.provider)?;
        let mut agent_options = AgentRunOptions::with_defaults(
            assembly.provider.clone(),
            workspace.root.clone(),
            assembly.final_prompt.clone(),
            api_key.clone(),
        );
        agent_options.sandbox = assembly.sandbox.clone();
        agent_options.persona = options.persona.clone();
        agent_options.permission = options.permission.clone();
        agent_options.streaming = options.stream;
        agent_options.auto_git = options.auto_git;
        agent_options.planning = false;
        agent_options.stream_handler = options.stream_handler;
        agent_options.event_handler = options.event_handler;
        agent_options.ide_context = options.ide_context.clone();
        agent_options.initial_attachments = options.attachments.clone();
        agent_options.approval_handler = options.approval_handler;
        if let Some((_, record)) = &session_source {
            agent_options.source_session = Some(record.clone());
        }

        // Build fallback provider list from same-family providers
        let fallback_providers = Vec::new(); // Disabling fallback completely
                                             // for profile in providers.profiles() {
                                             //     if profile.id != assembly.provider.id {
                                             //         if let Ok(key) = self.read_provider_api_key(profile) {
                                             //             fallback_providers.push((profile.clone(), key));
                                             //         }
                                             //     }
                                             // }
        agent_options.fallback_providers = fallback_providers;
        agent_options.plugin_definitions = plugins.plugins.clone();

        let result = run_agent(agent_options, plugins.into_tools()).await?;
        let stored_events = build_execution_events(
            "live",
            &assembly,
            checkpoint_path.as_deref(),
            source_session_meta.as_ref(),
            &result.events,
            None,
        );
        let execution = SessionExecutionData {
            final_response: if result.final_response.is_empty() {
                None
            } else {
                Some(result.final_response.clone())
            },
            turns_used: result.turns_used,
            tool_invocation_count: result.tool_invocations.len(),
            prompt_tokens: result.token_usage.prompt_tokens,
            completion_tokens: result.token_usage.completion_tokens,
            total_tokens: result.token_usage.total_tokens,
            api_calls: result.token_usage.api_calls,
            events: stored_events,
        };

        let saved_session = if options.persist_session {
            match &session_source {
                Some((SessionReuseMode::Resume, record)) => Some((
                    "updated",
                    append_session_turn(
                        &self.paths.sessions_dir(),
                        &record.id,
                        &options.input,
                        &assembly,
                        "live",
                        Some(&execution),
                    )?,
                )),
                Some((SessionReuseMode::Fork, record)) => {
                    let forked = fork_session(&self.paths.sessions_dir(), &record.id)?;
                    Some((
                        "forked",
                        append_session_turn(
                            &self.paths.sessions_dir(),
                            &forked.id,
                            &options.input,
                            &assembly,
                            "live",
                            Some(&execution),
                        )?,
                    ))
                }
                None => Some((
                    "created",
                    save_new_session(
                        &self.paths.sessions_dir(),
                        &workspace.root,
                        None,
                        &options.input,
                        &assembly,
                        "live",
                        Some(&execution),
                    )?,
                )),
            }
        } else {
            None
        };
        let persisted_session_meta = saved_session
            .as_ref()
            .map(|(action, record)| (action.to_string(), record.clone()));
        let output_events = build_execution_events(
            "live",
            &assembly,
            checkpoint_path.as_deref(),
            source_session_meta.as_ref(),
            &result.events,
            saved_session
                .as_ref()
                .map(|(action, record)| (*action, record)),
        );

        Ok(render_exec_output(
            &assembly,
            checkpoint_path,
            source_session_meta,
            persisted_session_meta,
            &output_events,
            options.print_prompt,
            Some(&result),
        ))
    }

    fn current_trust_state(&self, path: &Path) -> AppResult<crate::trust::TrustState> {
        let store = TrustStore::load(&self.paths.trust_store_path())?;
        Ok(store.evaluate(path, self.preferences.trust_enabled))
    }

    fn resolve_current_dir_path(&self, path: PathBuf) -> AppResult<PathBuf> {
        let path = if path.is_absolute() {
            path
        } else {
            self.paths.current_dir.join(path)
        };

        if path.exists() {
            Ok(std::fs::canonicalize(path)?)
        } else {
            Ok(path)
        }
    }

    fn load_session_for_workspace(
        &self,
        workspace_root: &Path,
        session_id: &str,
    ) -> AppResult<SessionRecord> {
        let record = load_session(&self.paths.sessions_dir(), session_id)?;
        if record.workspace_root != workspace_root {
            return Err(AppError::Message(format!(
                "session {} belongs to {} instead of {}",
                session_id,
                display_path(&record.workspace_root),
                display_path(workspace_root)
            )));
        }
        Ok(record)
    }

    fn read_provider_api_key(
        &self,
        provider: &crate::providers::ProviderProfile,
    ) -> AppResult<String> {
        // External CLI engines manage their own API keys — no env var needed.
        if provider.family == crate::providers::ProviderFamily::ExternalCli {
            return Ok(String::new());
        }
        env::var(&provider.api_key_env)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::Message(format!(
                    "provider {} requires {} to be set before live execution",
                    provider.id, provider.api_key_env
                ))
            })
    }
}

#[derive(Clone, Debug)]
pub struct ExecOptions {
    pub input: String,
    pub skill: Option<String>,
    pub persona: Option<String>,
    pub provider: Option<String>,
    pub sandbox: Option<SandboxPolicy>,
    pub checkpoint: bool,
    pub persist_session: bool,
    pub resume_session: Option<String>,
    pub fork_session: Option<String>,
    pub print_prompt: bool,
    pub permission: PermissionLevel,
    pub stream: bool,
    pub auto_git: bool,
    pub plan_only: bool,
    pub ide_context: Option<crate::agent::IdeContext>,
    pub attachments: Option<Vec<crate::agent::AgentAttachment>>,
    pub stream_handler: Option<crate::agent::StreamCallback>,
    pub event_handler: Option<crate::agent::EventCallback>,
    pub approval_handler: Option<std::sync::Arc<dyn crate::agent::ApprovalHandler>>,
}

#[derive(Clone, Debug)]
pub enum AppCommand {
    Overview,
    ProvidersList,
    ProvidersCurrent,
    ProvidersShow {
        id: String,
    },
    ProvidersUse {
        id: String,
        scope: ProviderScope,
    },
    ProvidersRemove {
        id: String,
        scope: ProviderScope,
    },
    ProvidersModels {
        id: String,
    },
    ProvidersUpdate {
        id: String,
        model: String,
    },
    ProvidersAdd {
        profile: crate::providers::ProviderProfile,
        scope: ProviderScope,
    },
    ProvidersDoctor {
        id: Option<String>,
    },
    CommandsList,
    CommandsReload,
    TrustStatus {
        path: Option<PathBuf>,
    },
    TrustSet {
        path: PathBuf,
        kind: TrustRuleKind,
    },
    CheckpointsList,
    SessionsList,
    SessionsShow {
        id: String,
    },
    SessionsTurns {
        id: String,
    },
    SessionsRemove {
        id: String,
    },
    SessionsFork {
        id: String,
    },
    SessionsReplay {
        id: String,
        turn: Option<usize>,
    },
    HistoryList {
        limit: usize,
    },
    HistoryRevert {
        id: String,
    },
    HistoryTrack {
        path: String,
        source: String,
    },
    HistoryFileRevisions {
        path: String,
    },
    HistoryGetBlob {
        hash: String,
    },
    ExternalCliDetect,
    ExternalCliRead {
        cli: String,
        scope: String,
    },
    ExternalCliWrite {
        cli: String,
        scope: String,
        content: String,
    },
    ExternalCliWriteInstruction {
        cli: String,
        content: String,
    },
    Exec(ExecOptions),
}

fn build_execution_events(
    mode: &str,
    assembly: &PromptAssembly,
    checkpoint_path: Option<&Path>,
    source_session: Option<&(String, String)>,
    runtime_events: &[AgentEvent],
    persisted_session: Option<(&str, &SessionRecord)>,
) -> Vec<AgentEvent> {
    let mut events = vec![AgentEvent::ExecutionPrepared {
        mode: mode.to_string(),
        workspace: display_path(&assembly.workspace_root),
        provider_id: assembly.provider.id.clone(),
        provider_label: assembly.provider.label.clone(),
        protocol: assembly.provider.protocol.as_str().to_string(),
        sandbox: assembly.sandbox.as_str().to_string(),
        trust: assembly.trust_label.clone(),
        active_command: assembly.active_command.clone(),
        active_skill: assembly.active_skill.clone(),
        prompt: assembly.final_prompt.clone(),
        attachment_count: assembly.attachments.len(),
        pending_shell_command_count: assembly.pending_shell_commands.len(),
        source_session_id: source_session.map(|(_, id)| id.clone()),
        source_mode: source_session.map(|(source_mode, _)| source_mode.clone()),
    }];

    if let Some(path) = checkpoint_path {
        events.push(AgentEvent::CheckpointSaved {
            path: display_path(path),
        });
    }

    events.extend(runtime_events.iter().cloned());

    if let Some((action, record)) = persisted_session {
        events.push(AgentEvent::SessionPersisted {
            action: action.to_string(),
            id: record.id.clone(),
            turn_count: record.turn_count(),
        });
    }

    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppPaths, RuntimePreferences, SandboxPolicy};
    use crate::providers::{ProviderFamily, ProviderProfile, ProviderSource};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-app-{}-{}", label, stamp))
    }

    fn test_app(label: &str) -> (App, PathBuf) {
        let root = unique_dir(label);
        fs::create_dir_all(root.join(".aixlarity")).unwrap();
        let config_home = root.join("home");
        fs::create_dir_all(&config_home).unwrap();
        let app = App {
            paths: AppPaths {
                current_dir: root.clone(),
                config_home,
            },
            preferences: RuntimePreferences {
                default_provider_id: None,
                default_sandbox: SandboxPolicy::WorkspaceWrite,
                trust_enabled: true,
            },
        };
        (app, root)
    }

    fn provider_profile(family: ProviderFamily) -> ProviderProfile {
        ProviderProfile {
            id: "custom-provider".to_string(),
            family,
            protocol: family.default_protocol(),
            label: "Custom Provider".to_string(),
            api_base: "https://api.example.test/v1".to_string(),
            api_key_env: "CUSTOM_API_KEY".to_string(),
            model: "model-1".to_string(),
            best_for: "testing".to_string(),
            strengths: vec![],
            supports_multimodal: family.default_multimodal(),
            supports_grounding: family.default_grounding(),
            source: ProviderSource::GlobalConfig(PathBuf::new()),
        }
    }

    #[test]
    fn trust_paths_are_resolved_from_app_current_dir() {
        let (app, root) = test_app("trust-relative");

        app.trust_set(PathBuf::from("."), TrustRuleKind::Trusted)
            .unwrap();
        let content = fs::read_to_string(app.paths.trust_store_path()).unwrap();
        let expected = fs::canonicalize(&root).unwrap();
        assert!(content.contains(&expected.to_string_lossy().to_string()));
        assert!(!content.contains("\t."));

        let status = app.trust_status(Some(PathBuf::from("."))).unwrap();
        let json: serde_json::Value = serde_json::from_str(&status.render_json()).unwrap();
        assert_eq!(json["status"], "trusted");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn providers_add_rejects_invalid_api_key_env() {
        let (app, root) = test_app("provider-validation");
        let mut profile = provider_profile(ProviderFamily::OpenAiCompatible);
        profile.api_key_env = "bad-key".to_string();

        let err = app
            .providers_add(profile, ProviderScope::Global)
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("provider API key env must contain only uppercase letters"));
        assert!(!app.paths.global_provider_registry_path().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn providers_add_allows_external_cli_without_api_credentials() {
        let (app, root) = test_app("external-provider");
        let mut profile = provider_profile(ProviderFamily::ExternalCli);
        profile.id = "Codex_CLI".to_string();
        profile.api_base.clear();
        profile.api_key_env.clear();
        profile.model = "codex".to_string();

        let output = app.providers_add(profile, ProviderScope::Global).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output.render_json()).unwrap();

        assert_eq!(json["provider"]["id"], "codex_cli");
        let content = fs::read_to_string(app.paths.global_provider_registry_path()).unwrap();
        assert!(content.contains("[provider \"codex_cli\"]"));
        assert!(content.contains("family = \"external-cli\""));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn providers_update_rejects_empty_model() {
        let (app, root) = test_app("provider-empty-model-update");

        let err = app
            .providers_update("custom-provider".to_string(), "  ".to_string())
            .unwrap_err();

        assert!(err.to_string().contains("provider model must not be empty"));
        assert!(!app.paths.global_provider_registry_path().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_track_rejects_paths_outside_workspace() {
        let (app, root) = test_app("history-boundary");
        let outside_root = unique_dir("history-outside");
        fs::create_dir_all(&outside_root).unwrap();
        let outside_file = outside_root.join("note.txt");
        fs::write(&outside_file, "outside").unwrap();

        let output = app
            .history_track(
                outside_file.to_string_lossy().to_string(),
                "user".to_string(),
            )
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&output.render_json()).unwrap();

        assert_eq!(json["status"], "error");
        assert!(json["error"]
            .as_str()
            .unwrap()
            .contains("outside workspace"));

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside_root).unwrap();
    }

    #[test]
    fn history_file_revisions_resolves_relative_workspace_paths() {
        let (app, root) = test_app("history-revisions-relative");
        let file = root.join("src").join("note.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "revision one").unwrap();

        app.history_track("src/note.txt".to_string(), "user".to_string())
            .unwrap();

        let output = app
            .history_file_revisions("src/note.txt".to_string())
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&output.render_json()).unwrap();

        assert_eq!(json["revisions"].as_array().unwrap().len(), 1);
        assert_eq!(
            json["path"],
            std::fs::canonicalize(&file)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_file_revisions_rejects_paths_outside_workspace() {
        let (app, root) = test_app("history-revisions-boundary");
        let outside_root = unique_dir("history-revisions-outside");
        fs::create_dir_all(&outside_root).unwrap();
        let outside_file = outside_root.join("note.txt");
        fs::write(&outside_file, "outside").unwrap();

        let output = app
            .history_file_revisions(outside_file.to_string_lossy().to_string())
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&output.render_json()).unwrap();

        assert_eq!(json["status"], "error");
        assert!(json["error"]
            .as_str()
            .unwrap()
            .contains("outside workspace"));

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside_root).unwrap();
    }
}
