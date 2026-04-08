use std::fs;

use serde_json::Value;

use super::{Tool, ToolContext};

pub struct ListDirTool;

#[async_trait::async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "list_dir"
    }

    fn description(&self) -> &str {
        "List files and subdirectories in a directory, subject to the active sandbox policy."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path to list" }
            },
            "required": ["path"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let path_str = params["path"].as_str().unwrap_or(".");
        let path = if matches!(ctx.sandbox, crate::config::SandboxPolicy::Off) {
            ctx.resolve_path(path_str)
        } else {
            ctx.workspace_path(&ctx.resolve_path(path_str))?
        };

        if !path.is_dir() {
            anyhow::bail!("Path is not a directory: {}", path.display());
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type()?;
            entries.push(serde_json::json!({
                "name": name,
                "is_dir": file_type.is_dir(),
                "is_file": file_type.is_file(),
            }));
        }

        Ok(serde_json::json!({
            "path": path.display().to_string(),
            "entries": entries
        }))
    }
}
