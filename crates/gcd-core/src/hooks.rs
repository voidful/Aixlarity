// GemiClawDex — Hook System
//
// Lifecycle hooks that run shell commands before/after tool execution.
// Users configure hooks in `.gcd/hooks.json` (workspace) or `~/.gcd/hooks.json` (global).
//
// Supported hook points:
//   - PreToolUse:  runs before a tool executes; exit 0 = allow, exit 2 = deny
//   - PostToolUse: runs after a tool executes (informational, cannot block)

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

/// When in the tool lifecycle this hook fires.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookPoint {
    PreToolUse,
    PostToolUse,
}

/// A single hook entry from configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEntry {
    /// Shell command to execute.
    pub command: String,
    /// Optional: only fire for these tool names (empty = all tools).
    #[serde(default)]
    pub tools: Vec<String>,
    /// Optional timeout in seconds (default: 10).
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_timeout() -> u64 {
    10
}

/// Top-level hooks configuration.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HooksConfig {
    #[serde(default)]
    pub pre_tool_use: Vec<HookEntry>,
    #[serde(default)]
    pub post_tool_use: Vec<HookEntry>,
}

impl HooksConfig {
    /// Load hooks from global config dir and workspace `.gcd/hooks.json`.
    /// Workspace hooks are appended after global hooks (both run).
    pub fn load(global_config_dir: &Path, workspace_root: &Path) -> Self {
        let mut config = HooksConfig::default();

        // Global hooks
        let global_path = global_config_dir.join("hooks.json");
        if let Some(c) = Self::load_from_file(&global_path) {
            config.merge(c);
        }

        // Workspace hooks
        let workspace_path = workspace_root.join(".gcd").join("hooks.json");
        if let Some(c) = Self::load_from_file(&workspace_path) {
            config.merge(c);
        }

        config
    }

    fn load_from_file(path: &PathBuf) -> Option<Self> {
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<HooksConfig>(&content) {
            Ok(config) => {
                eprintln!("\x1b[2m🪝 Hooks loaded from {}\x1b[0m", path.display());
                Some(config)
            }
            Err(err) => {
                eprintln!(
                    "\x1b[33m⚠️  Failed to parse hooks {}: {}\x1b[0m",
                    path.display(),
                    err
                );
                None
            }
        }
    }

    fn merge(&mut self, other: HooksConfig) {
        self.pre_tool_use.extend(other.pre_tool_use);
        self.post_tool_use.extend(other.post_tool_use);
    }

    /// Get hooks that apply to a given hook point and tool name.
    pub fn matching_hooks(&self, point: &HookPoint, tool_name: &str) -> Vec<&HookEntry> {
        let entries = match point {
            HookPoint::PreToolUse => &self.pre_tool_use,
            HookPoint::PostToolUse => &self.post_tool_use,
        };
        entries
            .iter()
            .filter(|entry| entry.tools.is_empty() || entry.tools.iter().any(|t| t == tool_name))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

/// Result of running pre-tool hooks.
#[derive(Debug)]
pub enum PreToolHookResult {
    /// All hooks passed — proceed with tool execution.
    Allow,
    /// A hook denied execution (exit code 2).
    Deny {
        hook_command: String,
        stderr: String,
    },
    /// A hook failed (non-zero, non-2 exit) — treat as allow with warning.
    Error { hook_command: String, error: String },
}

/// Run all matching PreToolUse hooks. Returns Deny if any hook exits with code 2.
pub fn run_pre_tool_hooks(
    config: &HooksConfig,
    tool_name: &str,
    arguments: &Value,
    workspace_root: &Path,
) -> PreToolHookResult {
    let hooks = config.matching_hooks(&HookPoint::PreToolUse, tool_name);
    if hooks.is_empty() {
        return PreToolHookResult::Allow;
    }

    let env_vars = hook_env_vars(tool_name, arguments, None);

    for hook in hooks {
        match run_hook_command(&hook.command, &env_vars, workspace_root, hook.timeout_secs) {
            Ok(output) => {
                if output.status.code() == Some(2) {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    eprintln!(
                        "\x1b[31m🪝 PreToolUse hook denied '{}': {}\x1b[0m",
                        tool_name,
                        stderr.trim()
                    );
                    return PreToolHookResult::Deny {
                        hook_command: hook.command.clone(),
                        stderr,
                    };
                }
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    eprintln!(
                        "\x1b[33m⚠️  PreToolUse hook failed (exit {}): {}\x1b[0m",
                        output.status.code().unwrap_or(-1),
                        stderr.trim()
                    );
                    return PreToolHookResult::Error {
                        hook_command: hook.command.clone(),
                        error: stderr,
                    };
                }
            }
            Err(err) => {
                eprintln!(
                    "\x1b[33m⚠️  PreToolUse hook '{}' error: {}\x1b[0m",
                    hook.command, err
                );
                return PreToolHookResult::Error {
                    hook_command: hook.command.clone(),
                    error: err.to_string(),
                };
            }
        }
    }

    PreToolHookResult::Allow
}

/// Run all matching PostToolUse hooks (fire-and-forget, cannot block).
pub fn run_post_tool_hooks(
    config: &HooksConfig,
    tool_name: &str,
    arguments: &Value,
    result: &Value,
    workspace_root: &Path,
) {
    let hooks = config.matching_hooks(&HookPoint::PostToolUse, tool_name);
    if hooks.is_empty() {
        return;
    }

    let env_vars = hook_env_vars(tool_name, arguments, Some(result));

    for hook in hooks {
        match run_hook_command(&hook.command, &env_vars, workspace_root, hook.timeout_secs) {
            Ok(output) => {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!(
                        "\x1b[33m⚠️  PostToolUse hook failed (exit {}): {}\x1b[0m",
                        output.status.code().unwrap_or(-1),
                        stderr.trim()
                    );
                }
            }
            Err(err) => {
                eprintln!(
                    "\x1b[33m⚠️  PostToolUse hook '{}' error: {}\x1b[0m",
                    hook.command, err
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn hook_env_vars(
    tool_name: &str,
    arguments: &Value,
    result: Option<&Value>,
) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    vars.insert("GCD_TOOL_NAME".to_string(), tool_name.to_string());
    vars.insert(
        "GCD_TOOL_ARGS".to_string(),
        serde_json::to_string(arguments).unwrap_or_default(),
    );
    if let Some(result) = result {
        vars.insert(
            "GCD_TOOL_RESULT".to_string(),
            serde_json::to_string(result).unwrap_or_default(),
        );
    }
    vars
}

fn run_hook_command(
    command: &str,
    env_vars: &HashMap<String, String>,
    cwd: &Path,
    timeout_secs: u64,
) -> std::io::Result<std::process::Output> {
    use std::process::Stdio;

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.current_dir(cwd);
    cmd.envs(env_vars);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let timeout = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();

    // Poll until completion or timeout
    loop {
        match child.try_wait()? {
            Some(_) => {
                // Process finished — collect output (stdout/stderr already piped)
                return child.wait_with_output();
            }
            None => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("Hook '{}' timed out after {}s", command, timeout_secs),
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_config_defaults_to_empty() {
        let config = HooksConfig::default();
        assert!(config.pre_tool_use.is_empty());
        assert!(config.post_tool_use.is_empty());
    }

    #[test]
    fn matching_hooks_filters_by_tool_name() {
        let config = HooksConfig {
            pre_tool_use: vec![
                HookEntry {
                    command: "echo all".to_string(),
                    tools: vec![],
                    timeout_secs: 10,
                },
                HookEntry {
                    command: "echo shell_only".to_string(),
                    tools: vec!["shell".to_string()],
                    timeout_secs: 10,
                },
            ],
            post_tool_use: vec![],
        };

        let matches = config.matching_hooks(&HookPoint::PreToolUse, "shell");
        assert_eq!(matches.len(), 2);

        let matches = config.matching_hooks(&HookPoint::PreToolUse, "read_file");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].command, "echo all");
    }

    #[test]
    fn parses_hooks_json() {
        let json_str = r#"{
            "pre_tool_use": [
                { "command": "echo pre", "tools": ["shell"], "timeout_secs": 5 }
            ],
            "post_tool_use": [
                { "command": "echo post" }
            ]
        }"#;
        let config: HooksConfig = serde_json::from_str(json_str).unwrap();
        assert_eq!(config.pre_tool_use.len(), 1);
        assert_eq!(config.pre_tool_use[0].tools, vec!["shell"]);
        assert_eq!(config.post_tool_use.len(), 1);
        assert_eq!(config.post_tool_use[0].timeout_secs, 10); // default
    }

    #[test]
    fn hook_env_vars_includes_tool_info() {
        let vars = hook_env_vars(
            "read_file",
            &serde_json::json!({"path": "foo.rs"}),
            Some(&serde_json::json!({"content": "hello"})),
        );
        assert_eq!(vars["GCD_TOOL_NAME"], "read_file");
        assert!(vars["GCD_TOOL_ARGS"].contains("foo.rs"));
        assert!(vars["GCD_TOOL_RESULT"].contains("hello"));
    }

    #[test]
    fn pre_tool_hooks_allow_when_empty() {
        let config = HooksConfig::default();
        let result =
            run_pre_tool_hooks(&config, "shell", &serde_json::json!({}), Path::new("/tmp"));
        assert!(matches!(result, PreToolHookResult::Allow));
    }
}
