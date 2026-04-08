use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config::SandboxPolicy;
use crate::hooks::HooksConfig;
use crate::plugins::PluginDefinition;

const TOOL_EVENTS_KEY: &str = "__gcd_events";

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value>;

    fn take_output_events(&self, _result: &mut Value) -> Vec<crate::agent::AgentEvent> {
        Vec::new()
    }
}

#[derive(Clone, Debug)]
pub struct ToolContext {
    pub workspace_root: PathBuf,
    pub sandbox: SandboxPolicy,
    /// Provider profile for coordinator sub-agent spawning (optional)
    pub coordinator_provider: Option<crate::providers::ProviderProfile>,
    /// API key for coordinator sub-agent spawning (optional)
    pub coordinator_api_key: Option<String>,
    /// Permission level for coordinator sub-agents (optional)
    pub coordinator_permission: Option<crate::agent::PermissionLevel>,
    /// Fallback providers inherited by coordinator sub-agents.
    pub coordinator_fallback_providers: Vec<(crate::providers::ProviderProfile, String)>,
    /// Plugin definitions inherited by coordinator sub-agents.
    pub coordinator_plugin_definitions: Vec<PluginDefinition>,
    /// Current nested coordinator depth for this runtime.
    pub coordinator_depth: usize,
    /// Parent prompt context propagated to delegated sub-agents.
    pub coordinator_prompt_context: Option<String>,
    /// Hook configuration for PreToolUse/PostToolUse lifecycle hooks
    pub hooks: HooksConfig,
}

impl ToolContext {
    pub fn resolve_path(&self, raw: &str) -> PathBuf {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            self.workspace_root.join(path)
        }
    }

    pub fn is_within_workspace(&self, path: &Path) -> bool {
        self.workspace_path(path).is_ok()
    }

    pub fn workspace_path(&self, path: &Path) -> anyhow::Result<PathBuf> {
        let root = fs::canonicalize(&self.workspace_root).map_err(|error| {
            anyhow::anyhow!(
                "Failed to resolve workspace root {}: {}",
                self.workspace_root.display(),
                error
            )
        })?;
        let candidate = self.resolve_existing_ancestor(path)?;
        if candidate.starts_with(&root) {
            Ok(candidate)
        } else {
            anyhow::bail!("Path is outside the workspace: {}", path.display());
        }
    }

    fn resolve_existing_ancestor(&self, path: &Path) -> anyhow::Result<PathBuf> {
        let mut current = path.to_path_buf();
        let mut suffix = Vec::new();

        loop {
            if current.exists() {
                let mut resolved = fs::canonicalize(&current).map_err(|error| {
                    anyhow::anyhow!("Failed to resolve {}: {}", current.display(), error)
                })?;
                for component in suffix.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }

            let name = current.file_name().ok_or_else(|| {
                anyhow::anyhow!(
                    "Path cannot be resolved within the workspace: {}",
                    path.display()
                )
            })?;
            suffix.push(name.to_os_string());
            current = current
                .parent()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Path cannot be resolved within the workspace: {}",
                        path.display()
                    )
                })?
                .to_path_buf();
        }
    }
}

pub(crate) fn embed_tool_events(mut result: Value, events: Vec<crate::agent::AgentEvent>) -> Value {
    if events.is_empty() {
        return result;
    }

    if let Value::Object(object) = &mut result {
        object.insert(
            TOOL_EVENTS_KEY.to_string(),
            serde_json::to_value(events).unwrap_or_else(|_| Value::Array(Vec::new())),
        );
    }

    result
}

pub(crate) fn take_embedded_tool_events(result: &mut Value) -> Vec<crate::agent::AgentEvent> {
    let Value::Object(object) = result else {
        return Vec::new();
    };

    let Some(raw_events) = object.remove(TOOL_EVENTS_KEY) else {
        return Vec::new();
    };

    serde_json::from_value(raw_events).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{embed_tool_events, take_embedded_tool_events, ToolContext};
    use crate::agent::AgentEvent;
    use crate::config::SandboxPolicy;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_path_allows_new_files_inside_workspace() {
        let root = unique_dir("workspace-path");
        fs::create_dir_all(root.join("nested")).unwrap();
        let ctx = ToolContext {
            workspace_root: root.clone(),
            sandbox: SandboxPolicy::WorkspaceWrite,
            coordinator_provider: None,
            coordinator_api_key: None,
            coordinator_permission: None,
            coordinator_fallback_providers: Vec::new(),
            coordinator_plugin_definitions: Vec::new(),
            coordinator_depth: 0,
            coordinator_prompt_context: None,
            hooks: crate::hooks::HooksConfig::default(),
        };

        let resolved = ctx
            .workspace_path(&root.join("nested").join("new-file.txt"))
            .unwrap();
        assert!(resolved.ends_with("nested/new-file.txt"));
    }

    #[test]
    fn workspace_path_rejects_parent_escape() {
        let root = unique_dir("workspace-escape");
        fs::create_dir_all(&root).unwrap();
        let outside = root.parent().unwrap().join("outside.txt");
        let ctx = ToolContext {
            workspace_root: root.clone(),
            sandbox: SandboxPolicy::WorkspaceWrite,
            coordinator_provider: None,
            coordinator_api_key: None,
            coordinator_permission: None,
            coordinator_fallback_providers: Vec::new(),
            coordinator_plugin_definitions: Vec::new(),
            coordinator_depth: 0,
            coordinator_prompt_context: None,
            hooks: crate::hooks::HooksConfig::default(),
        };

        let error = ctx.workspace_path(&outside).unwrap_err().to_string();
        assert!(error.contains("outside the workspace"));
    }

    #[test]
    fn embedded_tool_events_round_trip_and_are_removed_from_result() {
        let result = serde_json::json!({
            "status": "ok"
        });
        let events = vec![AgentEvent::CheckpointSaved {
            path: "/tmp/checkpoint.json".to_string(),
        }];

        let mut embedded = embed_tool_events(result, events.clone());
        assert!(embedded.get("__gcd_events").is_some());

        let extracted = take_embedded_tool_events(&mut embedded);
        assert_eq!(extracted, events);
        assert!(embedded.get("__gcd_events").is_none());
        assert_eq!(embedded["status"], "ok");
    }

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gcd-tool-context-{}-{}", label, stamp))
    }
}
