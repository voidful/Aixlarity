use std::process::Command;

use serde_json::Value;

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
            let (exit_code, stdout, stderr) =
                container::run_in_container(&ctx.workspace_root, command)?;
            return Ok(serde_json::json!({
                "exit_code": exit_code,
                "stdout": truncate_output(&stdout, SHELL_OUTPUT_LIMIT),
                "stderr": truncate_output(&stderr, SHELL_OUTPUT_LIMIT),
                "container": true,
            }));
        }

        let output = Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&ctx.workspace_root)
            .output()?;

        Ok(serde_json::json!({
            "exit_code": output.status.code().unwrap_or(-1),
            "stdout": truncate_output(&output.stdout, SHELL_OUTPUT_LIMIT),
            "stderr": truncate_output(&output.stderr, SHELL_OUTPUT_LIMIT),
        }))
    }
}
