use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Simple glob matching for path ACL enforcement.
/// Supports `*` (single segment) and `**` (recursive) patterns.
/// Design: Hand-rolled to avoid adding a dependency (per AGENTS.md rule #1).
fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern_parts: Vec<&str> = pattern.split('/').collect();
    let path_parts: Vec<&str> = path.split('/').collect();
    glob_match_parts(&pattern_parts, &path_parts)
}

fn glob_match_parts(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() && path.is_empty() {
        return true;
    }
    if pattern.is_empty() {
        return false;
    }

    let p = pattern[0];
    if p == "**" {
        // `**` matches zero or more path segments
        for i in 0..=path.len() {
            if glob_match_parts(&pattern[1..], &path[i..]) {
                return true;
            }
        }
        return false;
    }

    if path.is_empty() {
        return false;
    }

    if p == "*" || p == path[0] {
        return glob_match_parts(&pattern[1..], &path[1..]);
    }

    // Support `*.ext` style patterns within a single segment
    if p.contains('*') {
        let sub_parts: Vec<&str> = p.splitn(2, '*').collect();
        if sub_parts.len() == 2 {
            let (prefix, suffix) = (sub_parts[0], sub_parts[1]);
            if path[0].starts_with(prefix) && path[0].ends_with(suffix) {
                return glob_match_parts(&pattern[1..], &path[1..]);
            }
        }
    }

    false
}

/// Check if a path (relative to workspace root) matches any of the given glob patterns.
pub fn path_matches_any_glob(path_str: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|pattern| glob_matches(pattern, path_str))
}

use crate::config::SandboxPolicy;
use crate::hooks::HooksConfig;
use crate::plugins::PluginDefinition;

const TOOL_EVENTS_KEY: &str = "__aixlarity_events";
const TOOL_ATTACHMENTS_KEY: &str = "__aixlarity_attachments";

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value>;

    fn take_output_events(&self, _result: &mut Value) -> Vec<crate::agent::AgentEvent> {
        Vec::new()
    }

    fn take_output_attachments(&self, result: &mut Value) -> Vec<crate::agent::AgentAttachment> {
        take_embedded_tool_attachments(result)
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
    /// If set, write operations are restricted to these glob patterns.
    /// Design: Enforces path-level ACL so sub-agents in multi-agent
    /// coordination cannot write outside their assigned scope.
    /// Inspired by Kimi Agent Swarm's scope isolation principle.
    pub allowed_write_paths: Option<Vec<String>>,
    /// If set, these paths are always forbidden for writes.
    pub forbidden_write_paths: Option<Vec<String>>,
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

    /// Check path-level write ACL for multi-agent isolation.
    /// Converts the absolute path to a workspace-relative path and checks
    /// it against `allowed_write_paths` (allowlist) and `forbidden_write_paths`
    /// (denylist). The denylist is checked first (deny wins over allow).
    ///
    /// Returns Ok(()) if the write is permitted, Err with a descriptive
    /// message if blocked. When neither list is set, all writes are allowed
    /// (backward compatible with single-agent mode).
    pub fn check_write_acl(&self, path: &Path) -> anyhow::Result<()> {
        // Compute workspace-relative path for glob matching
        let relative = path
            .strip_prefix(&self.workspace_root)
            .unwrap_or(path)
            .to_string_lossy();

        // Denylist check first (deny always wins)
        if let Some(ref forbidden) = self.forbidden_write_paths {
            if path_matches_any_glob(&relative, forbidden) {
                anyhow::bail!(
                    "Write blocked by forbidden_paths ACL: {} matches a forbidden pattern. \
                     This sub-agent is not allowed to write to this path.",
                    relative
                );
            }
        }

        // Allowlist check (if set, path must match at least one pattern)
        if let Some(ref allowed) = self.allowed_write_paths {
            if !path_matches_any_glob(&relative, allowed) {
                anyhow::bail!(
                    "Write blocked by allowed_paths ACL: {} does not match any allowed pattern {:?}. \
                     This sub-agent can only write to its assigned scope.",
                    relative,
                    allowed
                );
            }
        }

        Ok(())
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

pub(crate) fn embed_tool_attachments(
    mut result: Value,
    attachments: Vec<crate::agent::AgentAttachment>,
) -> Value {
    if attachments.is_empty() {
        return result;
    }

    if let Value::Object(object) = &mut result {
        object.insert(
            TOOL_ATTACHMENTS_KEY.to_string(),
            serde_json::to_value(attachments).unwrap_or_else(|_| Value::Array(Vec::new())),
        );
    }

    result
}

pub(crate) fn take_embedded_tool_attachments(
    result: &mut Value,
) -> Vec<crate::agent::AgentAttachment> {
    let Value::Object(object) = result else {
        return Vec::new();
    };

    let Some(raw_attachments) = object.remove(TOOL_ATTACHMENTS_KEY) else {
        return Vec::new();
    };

    serde_json::from_value(raw_attachments).unwrap_or_default()
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
            allowed_write_paths: None,
            forbidden_write_paths: None,
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
            allowed_write_paths: None,
            forbidden_write_paths: None,
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
        assert!(embedded.get("__aixlarity_events").is_some());

        let extracted = take_embedded_tool_events(&mut embedded);
        assert_eq!(extracted, events);
        assert!(embedded.get("__aixlarity_events").is_none());
        assert_eq!(embedded["status"], "ok");
    }

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-tool-context-{}-{}", label, stamp))
    }
}
