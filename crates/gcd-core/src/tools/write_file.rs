use std::fs;

use serde_json::Value;

use crate::config::SandboxPolicy;

use super::common::simple_diff;
use super::{Tool, ToolContext};

pub struct WriteFileTool;

#[async_trait::async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Create or overwrite a file, subject to the active sandbox policy. Returns a diff of changes."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative or absolute path to write" },
                "content": { "type": "string", "description": "Content to write" }
            },
            "required": ["path", "content"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        if matches!(ctx.sandbox, SandboxPolicy::ReadOnly) {
            anyhow::bail!("write_file is blocked by read-only sandbox policy");
        }

        let path_str = params["path"].as_str().unwrap_or("");
        let content = params["content"].as_str().unwrap_or("");
        let path = if matches!(ctx.sandbox, SandboxPolicy::Off) {
            ctx.resolve_path(path_str)
        } else {
            ctx.workspace_path(&ctx.resolve_path(path_str))?
        };

        let diff = if path.exists() {
            let old = fs::read_to_string(&path).unwrap_or_default();
            simple_diff(&old, content)
        } else {
            format!("+++ new file: {}\n", path.display())
        };

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;

        Ok(serde_json::json!({
            "path": path.display().to_string(),
            "bytes_written": content.len(),
            "diff_preview": diff
        }))
    }
}
