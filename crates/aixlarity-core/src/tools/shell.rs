use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use uuid::Uuid;

use crate::config::SandboxPolicy;

use super::common::{truncate_output, SHELL_OUTPUT_LIMIT};
use super::container;
use super::{Tool, ToolContext};

pub struct ShellTool;

#[async_trait::async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }

    fn description(&self) -> &str {
        "Execute a shell command in the workspace directory. Output truncated to 10KB. When sandbox=container, runs inside Docker/Podman."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute" }
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        if matches!(ctx.sandbox, SandboxPolicy::ReadOnly) {
            anyhow::bail!(
                "shell is blocked by sandbox policy: {}",
                ctx.sandbox.as_str()
            );
        }

        let command = params["command"].as_str().unwrap_or("");
        if command.is_empty() {
            anyhow::bail!("command parameter is required");
        }

        // Route through container sandbox if policy requires it
        if matches!(ctx.sandbox, SandboxPolicy::Container) {
            let command_id = Uuid::new_v4().to_string();
            let risk = shell_command_risk(command);
            let started_at_ms = unix_ms_now();
            let timer = Instant::now();
            let (exit_code, stdout, stderr) =
                container::run_in_container(&ctx.workspace_root, command)?;
            let finished_at_ms = unix_ms_now();
            return Ok(serde_json::json!({
                "command_id": command_id,
                "command": command,
                "cwd": ctx.workspace_root.display().to_string(),
                "shell": "container",
                "sandbox": ctx.sandbox.as_str(),
                "started_at_ms": started_at_ms,
                "finished_at_ms": finished_at_ms,
                "duration_ms": timer.elapsed().as_millis() as u64,
                "exit_code": exit_code,
                "stdout": truncate_output(&stdout, SHELL_OUTPUT_LIMIT),
                "stderr": truncate_output(&stderr, SHELL_OUTPUT_LIMIT),
                "container": true,
                "env": shell_env_evidence(),
                "risk": risk,
                "transcript": {
                    "command": command,
                    "cwd": ctx.workspace_root.display().to_string(),
                    "stdout": truncate_output(&stdout, SHELL_OUTPUT_LIMIT),
                    "stderr": truncate_output(&stderr, SHELL_OUTPUT_LIMIT),
                    "exit_code": exit_code,
                }
            }));
        }

        let command_id = Uuid::new_v4().to_string();
        let risk = shell_command_risk(command);
        let started_at_ms = unix_ms_now();
        let timer = Instant::now();
        let output = Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&ctx.workspace_root)
            .output()?;
        let finished_at_ms = unix_ms_now();

        let stdout = truncate_output(&output.stdout, SHELL_OUTPUT_LIMIT);
        let stderr = truncate_output(&output.stderr, SHELL_OUTPUT_LIMIT);
        let exit_code = output.status.code().unwrap_or(-1);

        Ok(serde_json::json!({
            "command_id": command_id,
            "command": command,
            "cwd": ctx.workspace_root.display().to_string(),
            "shell": "sh",
            "sandbox": ctx.sandbox.as_str(),
            "started_at_ms": started_at_ms,
            "finished_at_ms": finished_at_ms,
            "duration_ms": timer.elapsed().as_millis() as u64,
            "exit_code": exit_code,
            "stdout": stdout.clone(),
            "stderr": stderr.clone(),
            "container": false,
            "env": shell_env_evidence(),
            "risk": risk,
            "transcript": {
                "command": command,
                "cwd": ctx.workspace_root.display().to_string(),
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": exit_code,
            }
        }))
    }
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn shell_env_evidence() -> Value {
    let mut keys = [
        "SHELL",
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "PWD",
        "RUST_LOG",
        "CI",
        "GITHUB_ACTIONS",
    ]
    .into_iter()
    .filter(|key| std::env::var_os(key).is_some())
    .collect::<Vec<_>>();
    keys.sort_unstable();

    serde_json::json!({
        "captured": "keys_only",
        "keys": keys,
        "value_policy": "Environment values are intentionally omitted to avoid leaking secrets.",
    })
}

fn shell_command_risk(command: &str) -> Value {
    let lower = command.to_ascii_lowercase();
    let mut level = "low";
    let mut reasons: Vec<&str> = Vec::new();

    if shell_command_targets_root_delete(&lower)
        || lower.contains("mkfs")
        || lower.contains("diskutil erase")
        || lower.contains("format ")
        || lower.contains("del /f /s /q")
    {
        bump_shell_risk(
            &mut level,
            &mut reasons,
            "high",
            "Command appears capable of deleting or reformatting broad system paths.",
        );
    }

    if lower.contains("rm -rf")
        || lower.contains("rm -fr")
        || lower.contains("git clean")
        || lower.contains("docker system prune")
        || lower.contains("podman system prune")
        || lower.contains("chmod -r 777")
        || lower.contains("chown -r")
    {
        bump_shell_risk(
            &mut level,
            &mut reasons,
            "medium",
            "Command performs recursive destructive or permission-changing work.",
        );
    }

    if lower.contains("sudo ") || lower.starts_with("sudo") {
        bump_shell_risk(
            &mut level,
            &mut reasons,
            "medium",
            "Command requests elevated privileges.",
        );
    }

    if (lower.contains("curl ") || lower.contains("wget ")) && lower.contains("| sh") {
        bump_shell_risk(
            &mut level,
            &mut reasons,
            "medium",
            "Command pipes downloaded network content into a shell.",
        );
    }

    serde_json::json!({
        "level": level,
        "requires_review": level != "low",
        "reasons": reasons,
        "policy": "Risk is evidence only. Approval policy remains enforced by the active Aixlarity permission layer.",
    })
}

fn shell_command_targets_root_delete(lower_command: &str) -> bool {
    let parts = lower_command.split_whitespace().collect::<Vec<_>>();
    parts.windows(3).any(|window| {
        window[0] == "rm"
            && (window[1].contains('r') && window[1].contains('f'))
            && (window[2] == "/" || window[2] == "/*")
    })
}

fn bump_shell_risk(
    level: &mut &'static str,
    reasons: &mut Vec<&'static str>,
    candidate_level: &'static str,
    reason: &'static str,
) {
    if *level == "low" || (*level == "medium" && candidate_level == "high") {
        *level = candidate_level;
    }
    reasons.push(reason);
}

#[cfg(test)]
mod tests {
    use super::{shell_command_risk, shell_env_evidence};

    #[test]
    fn shell_env_evidence_omits_values() {
        let evidence = shell_env_evidence();
        assert_eq!(evidence["captured"], "keys_only");
        assert!(evidence["value_policy"]
            .as_str()
            .unwrap_or_default()
            .contains("omitted"));
        assert!(evidence
            .get("keys")
            .and_then(|keys| keys.as_array())
            .is_some());
    }

    #[test]
    fn shell_command_risk_flags_destructive_commands() {
        let safe = shell_command_risk("cargo test");
        assert_eq!(safe["level"], "low");
        assert_eq!(safe["requires_review"], false);

        let risky = shell_command_risk("sudo rm -rf /tmp/build-cache");
        assert_eq!(risky["level"], "medium");
        assert_eq!(risky["requires_review"], true);

        let severe = shell_command_risk("rm -rf /");
        assert_eq!(severe["level"], "high");
        assert_eq!(severe["requires_review"], true);
    }
}
