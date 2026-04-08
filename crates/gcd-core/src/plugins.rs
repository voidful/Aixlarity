// GemiClawDex — Plugin System
//
// Dynamic tool loading from JSON definitions.
// Users place plugin JSON files in .gcd/plugins/ to extend agent capabilities.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::AppPaths;
use crate::tools::{Tool, ToolContext};
use crate::trust::TrustState;
use crate::workspace::Workspace;

// ---------------------------------------------------------------------------
// Plugin Definition (loaded from JSON files)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginDefinition {
    /// Tool name (must be unique across all tools)
    pub name: String,
    /// Human-readable description shown to the LLM
    pub description: String,
    /// JSON Schema for the tool's parameters
    #[serde(default = "default_schema")]
    pub parameters: Value,
    /// Shell command template. Use {{param_name}} for parameter substitution.
    pub command: String,
    /// Optional working directory override (relative to workspace)
    #[serde(default)]
    pub cwd: Option<String>,
    /// Maximum output size in bytes (default: 10KB)
    #[serde(default = "default_output_limit")]
    pub max_output_bytes: usize,
}

fn default_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {}
    })
}

fn default_output_limit() -> usize {
    10 * 1024
}

// ---------------------------------------------------------------------------
// Plugin Catalog
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct PluginCatalog {
    pub plugins: Vec<PluginDefinition>,
}

impl PluginCatalog {
    /// Load plugins from global and workspace directories.
    pub fn load(paths: &AppPaths, workspace: &Workspace, trust: &TrustState) -> io::Result<Self> {
        let mut plugins = Vec::new();

        // Global plugins (always loaded)
        load_plugins_from_dir(&paths.plugins_dir(), &mut plugins)?;

        // Workspace plugins (only if trusted)
        if !trust.restricts_project_config() {
            load_plugins_from_dir(&workspace.root.join(".gcd").join("plugins"), &mut plugins)?;
        }

        Ok(Self { plugins })
    }

    /// Convert all loaded plugins into Tool trait objects.
    pub fn into_tools(self) -> Vec<Box<dyn Tool>> {
        plugin_tools_from_definitions(&self.plugins)
    }
}

/// Convert plugin definitions into executable Tool trait objects.
pub fn plugin_tools_from_definitions(definitions: &[PluginDefinition]) -> Vec<Box<dyn Tool>> {
    definitions
        .iter()
        .cloned()
        .map(|plugin| Box::new(PluginTool(plugin)) as Box<dyn Tool>)
        .collect()
}

fn load_plugins_from_dir(dir: &Path, plugins: &mut Vec<PluginDefinition>) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort();

    for path in paths {
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<PluginDefinition>(&content) {
                Ok(plugin) => {
                    eprintln!(
                        "\x1b[2m🔧 Plugin loaded: {} (from {})\x1b[0m",
                        plugin.name,
                        path.file_name().unwrap_or_default().to_string_lossy()
                    );
                    plugins.push(plugin);
                }
                Err(err) => {
                    eprintln!(
                        "\x1b[33m⚠️  Failed to parse plugin {}: {}\x1b[0m",
                        path.display(),
                        err
                    );
                }
            },
            Err(err) => {
                eprintln!(
                    "\x1b[33m⚠️  Failed to read plugin {}: {}\x1b[0m",
                    path.display(),
                    err
                );
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// PluginTool — wraps a PluginDefinition to implement the Tool trait
// ---------------------------------------------------------------------------

struct PluginTool(PluginDefinition);

#[async_trait::async_trait]
impl Tool for PluginTool {
    fn name(&self) -> &str {
        &self.0.name
    }

    fn description(&self) -> &str {
        &self.0.description
    }

    fn parameters_schema(&self) -> Value {
        self.0.parameters.clone()
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let cwd = match &self.0.cwd {
            Some(relative) => ctx.workspace_root.join(relative),
            None => ctx.workspace_root.clone(),
        };

        // Build arguments safely: split command into program + args, then append
        // parameter values as separate arguments (never interpolated into a shell string).
        let parts = shell_split(&self.0.command);
        if parts.is_empty() {
            anyhow::bail!("Plugin '{}' has an empty command", self.0.name);
        }

        let program = &parts[0];
        let mut cmd = std::process::Command::new(program);
        cmd.current_dir(&cwd);

        // Substitute {{param}} placeholders in each argument token individually.
        // Values are substituted as literal strings — no shell interpretation.
        for part in &parts[1..] {
            let mut arg = part.clone();
            if let Some(obj) = params.as_object() {
                for (key, value) in obj {
                    let placeholder = format!("{{{{{}}}}}", key);
                    let replacement = match value {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    arg = arg.replace(&placeholder, &replacement);
                }
            }
            cmd.arg(&arg);
        }

        // Append any parameter values that were not referenced by placeholders
        // as trailing positional arguments (convenient for simple one-arg plugins).
        if let Some(obj) = params.as_object() {
            let template = &self.0.command;
            for (key, value) in obj {
                let placeholder = format!("{{{{{}}}}}", key);
                if !template.contains(&placeholder) {
                    let val = match value {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    cmd.arg(&val);
                }
            }
        }

        let output = cmd
            .output()
            .map_err(|err| anyhow::anyhow!("Plugin '{}' execution failed: {}", self.0.name, err))?;

        let stdout = truncate_bytes(&output.stdout, self.0.max_output_bytes);
        let stderr = truncate_bytes(&output.stderr, self.0.max_output_bytes);

        Ok(serde_json::json!({
            "exit_code": output.status.code().unwrap_or(-1),
            "stdout": stdout,
            "stderr": stderr,
        }))
    }
}

/// Split a command string into tokens respecting simple quoting rules.
/// Does NOT invoke a shell — the result is used with `Command::new(program).args(rest)`.
fn shell_split(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' if !in_single => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn truncate_bytes(raw: &[u8], limit: usize) -> String {
    let rendered = String::from_utf8_lossy(raw);
    if rendered.len() <= limit {
        rendered.to_string()
    } else {
        format!(
            "{}... [truncated: {} bytes total]",
            &rendered[..limit],
            rendered.len()
        )
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plugin_definition() {
        let json = r#"{
            "name": "lint_code",
            "description": "Run ESLint on a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "File to lint" }
                },
                "required": ["file"]
            },
            "command": "npx eslint {{file}}"
        }"#;

        let plugin: PluginDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(plugin.name, "lint_code");
        assert_eq!(plugin.command, "npx eslint {{file}}");
        assert_eq!(plugin.max_output_bytes, 10 * 1024);
    }

    #[test]
    fn parses_minimal_plugin_definition() {
        let json = r#"{
            "name": "hello",
            "description": "Say hello",
            "command": "echo hello"
        }"#;

        let plugin: PluginDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(plugin.name, "hello");
        assert!(plugin.cwd.is_none());
        assert_eq!(plugin.parameters["type"], "object");
    }

    #[test]
    fn shell_split_handles_quotes_and_escapes() {
        let tokens = super::shell_split("npx eslint '{{file}}' --format \"{{format}}\"");
        assert_eq!(
            tokens,
            vec!["npx", "eslint", "{{file}}", "--format", "{{format}}"]
        );
    }

    #[test]
    fn shell_split_handles_simple_command() {
        let tokens = super::shell_split("echo hello world");
        assert_eq!(tokens, vec!["echo", "hello", "world"]);
    }

    #[test]
    fn plugin_catalog_empty_when_dir_missing() {
        let catalog = PluginCatalog::default();
        assert!(catalog.plugins.is_empty());
        let tools = catalog.into_tools();
        assert!(tools.is_empty());
    }
}
