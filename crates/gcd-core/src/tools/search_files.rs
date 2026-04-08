use std::process::Command;

use serde_json::Value;

use super::common::which_exists;
use super::{Tool, ToolContext};

pub struct SearchFilesTool;

#[async_trait::async_trait]
impl Tool for SearchFilesTool {
    fn name(&self) -> &str {
        "search_files"
    }

    fn description(&self) -> &str {
        "Search for a text pattern in files using rg or grep, subject to the active sandbox policy."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Search pattern (regex supported)" },
                "path": { "type": "string", "description": "Directory to search in (default: workspace root)" },
                "include": { "type": "string", "description": "Glob pattern to filter files (e.g. '*.rs')" }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let pattern = params["pattern"].as_str().unwrap_or("");
        let search_path = params["path"].as_str().unwrap_or(".");
        let include = params["include"].as_str();
        let resolved = if matches!(ctx.sandbox, crate::config::SandboxPolicy::Off) {
            ctx.resolve_path(search_path)
        } else {
            ctx.workspace_path(&ctx.resolve_path(search_path))?
        };

        if pattern.trim().is_empty() {
            anyhow::bail!("pattern parameter is required");
        }

        let mut command = if which_exists("rg") {
            let mut value = Command::new("rg");
            value
                .arg("--no-heading")
                .arg("--line-number")
                .arg("--max-count=50");
            if let Some(glob) = include {
                value.arg("--glob").arg(glob);
            }
            value.arg(pattern).arg(&resolved);
            value
        } else {
            let mut value = Command::new("grep");
            value.arg("-rn").arg("--max-count=50");
            if let Some(glob) = include {
                value.arg("--include").arg(glob);
            }
            value.arg(pattern).arg(&resolved);
            value
        };

        let output = command.output()?;
        if !output.status.success() && output.status.code() != Some(1) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("search command failed: {}", stderr.trim());
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let matches: Vec<Value> = stdout
            .lines()
            .take(50)
            .map(|line| serde_json::json!(line))
            .collect();

        Ok(serde_json::json!({
            "pattern": pattern,
            "match_count": matches.len(),
            "matches": matches,
        }))
    }
}
