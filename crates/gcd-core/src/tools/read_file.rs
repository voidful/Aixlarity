use std::fs;

use serde_json::Value;

use super::{Tool, ToolContext};

pub struct ReadFileTool;

#[async_trait::async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read the full contents of a file, subject to the active sandbox policy."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative or absolute path to read" }
            },
            "required": ["path"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let path_str = params["path"].as_str().unwrap_or("");
        let path = if matches!(ctx.sandbox, crate::config::SandboxPolicy::Off) {
            ctx.resolve_path(path_str)
        } else {
            ctx.workspace_path(&ctx.resolve_path(path_str))?
        };

        let content = fs::read_to_string(&path)
            .map_err(|error| anyhow::anyhow!("Failed to read {}: {}", path.display(), error))?;

        Ok(serde_json::json!({
            "path": path.display().to_string(),
            "content": content,
            "size_bytes": content.len()
        }))
    }
}
