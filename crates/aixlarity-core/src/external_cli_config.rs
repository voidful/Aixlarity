// Aixlarity — External CLI Config
//
// Detect, read, and write configuration files for external AI coding CLIs
// (Claude Code, Gemini CLI, OpenAI Codex CLI). This module powers the
// IDE's unified settings panel.
//
// Design: Each CLI stores its config in different formats and locations.
// This module abstracts the differences behind a common detect/read/write
// interface. No TOML dependency is added — Codex config is handled as
// raw text. Claude and Gemini configs are JSON and get structured handling.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Identifies one of the three supported external CLIs.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalCli {
    Claude,
    Gemini,
    Codex,
}

impl ExternalCli {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Gemini => "gemini",
            Self::Codex => "codex",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Gemini => "Gemini CLI",
            Self::Codex => "Codex CLI",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "claude" => Some(Self::Claude),
            "gemini" => Some(Self::Gemini),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

/// Config scope: user-global or workspace-local.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigScope {
    User,
    Project,
}

/// Detection result for a single CLI.
#[derive(Clone, Debug, Serialize)]
pub struct CliDetectionResult {
    pub cli: String,
    pub label: String,
    pub installed: bool,
    pub user_config_path: String,
    pub project_config_path: Option<String>,
    pub instruction_file: Option<String>,
    pub user_config_exists: bool,
    pub project_config_exists: bool,
    pub instruction_file_exists: bool,
    pub config_format: String,
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Resolve user-level config path for each CLI.
fn user_config_path(cli: &ExternalCli) -> Option<PathBuf> {
    let home = home_dir()?;
    Some(match cli {
        ExternalCli::Claude => home.join(".claude").join("settings.json"),
        ExternalCli::Gemini => home.join(".gemini").join("settings.json"),
        ExternalCli::Codex => home.join(".codex").join("config.toml"),
    })
}

/// Resolve project-level config path for each CLI.
fn project_config_path(cli: &ExternalCli, workspace_root: &Path) -> PathBuf {
    match cli {
        ExternalCli::Claude => workspace_root.join(".claude").join("settings.json"),
        ExternalCli::Gemini => workspace_root.join(".gemini").join("settings.json"),
        ExternalCli::Codex => workspace_root.join(".codex").join("config.toml"),
    }
}

/// Resolve instruction file path for each CLI.
fn instruction_file_path(cli: &ExternalCli, workspace_root: &Path) -> PathBuf {
    match cli {
        ExternalCli::Claude => workspace_root.join("CLAUDE.md"),
        ExternalCli::Gemini => workspace_root.join("GEMINI.md"),
        ExternalCli::Codex => workspace_root.join("AGENTS.md"),
    }
}

/// Config file format.
fn config_format(cli: &ExternalCli) -> &'static str {
    match cli {
        ExternalCli::Claude | ExternalCli::Gemini => "json",
        ExternalCli::Codex => "toml",
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Detect which external CLIs have config directories present.
pub fn detect_installed_clis(workspace_root: &Path) -> Vec<CliDetectionResult> {
    let clis = [ExternalCli::Claude, ExternalCli::Gemini, ExternalCli::Codex];
    let mut results = Vec::new();

    for cli in &clis {
        let user_path = user_config_path(cli);
        let proj_path = project_config_path(cli, workspace_root);
        let instr_path = instruction_file_path(cli, workspace_root);

        // A CLI is "installed" if its user-level config directory exists
        let user_dir_exists = user_path
            .as_ref()
            .and_then(|p| p.parent())
            .map(|d| d.exists())
            .unwrap_or(false);

        results.push(CliDetectionResult {
            cli: cli.as_str().to_string(),
            label: cli.label().to_string(),
            installed: user_dir_exists,
            user_config_path: user_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            project_config_path: Some(proj_path.display().to_string()),
            instruction_file: Some(instr_path.display().to_string()),
            user_config_exists: user_path.as_ref().map(|p| p.exists()).unwrap_or(false),
            project_config_exists: proj_path.exists(),
            instruction_file_exists: instr_path.exists(),
            config_format: config_format(cli).to_string(),
        });
    }

    results
}

/// Read an external CLI's config file.
/// Returns the raw content string and the format ("json" or "toml").
pub fn read_cli_config(
    cli_name: &str,
    scope: &str,
    workspace_root: &Path,
) -> Result<(String, String), String> {
    let cli =
        ExternalCli::from_str(cli_name).ok_or_else(|| format!("Unknown CLI: {}", cli_name))?;

    let path = match scope {
        "user" => {
            user_config_path(&cli).ok_or_else(|| "Cannot determine home directory".to_string())?
        }
        "project" => project_config_path(&cli, workspace_root),
        _ => return Err(format!("Unknown scope: {}", scope)),
    };

    if !path.exists() {
        // Return sensible defaults for each CLI
        let default_content = match (&cli, scope) {
            (ExternalCli::Claude, _) => "{\n  \"model\": \"\",\n  \"permissions\": {\n    \"allow\": [],\n    \"deny\": []\n  }\n}",
            (ExternalCli::Gemini, _) => "{\n  \"model\": \"\",\n  \"theme\": \"dark\"\n}",
            (ExternalCli::Codex, _) => "# Codex CLI configuration\ndefault_model = \"\"\napproval_policy = \"suggest\"\n",
        };
        return Ok((default_content.to_string(), config_format(&cli).to_string()));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    Ok((content, config_format(&cli).to_string()))
}

/// Write an external CLI's config file.
/// Creates parent directories if they don't exist.
pub fn write_cli_config(
    cli_name: &str,
    scope: &str,
    content: &str,
    workspace_root: &Path,
) -> Result<String, String> {
    let cli =
        ExternalCli::from_str(cli_name).ok_or_else(|| format!("Unknown CLI: {}", cli_name))?;

    let path = match scope {
        "user" => {
            user_config_path(&cli).ok_or_else(|| "Cannot determine home directory".to_string())?
        }
        "project" => project_config_path(&cli, workspace_root),
        _ => return Err(format!("Unknown scope: {}", scope)),
    };

    // Validate JSON before writing (for Claude and Gemini)
    if config_format(&cli) == "json" {
        serde_json::from_str::<serde_json::Value>(content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
    }

    // Create parent directory if needed
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(path.display().to_string())
}

/// Write the workspace instruction file for an external CLI.
///
/// The IDE sends the CLI identity, not an arbitrary path, so the backend keeps
/// ownership of path resolution. That mirrors the trust boundary used by the
/// rest of the harness: UI intent comes in, filesystem policy is enforced here.
pub fn write_instruction_file(
    cli_name: &str,
    content: &str,
    workspace_root: &Path,
) -> Result<String, String> {
    let cli =
        ExternalCli::from_str(cli_name).ok_or_else(|| format!("Unknown CLI: {}", cli_name))?;
    let path = instruction_file_path(&cli, workspace_root);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-external-cli-{}-{}", name, nonce))
    }

    #[test]
    fn write_instruction_file_uses_workspace_owned_path() {
        let root = temp_workspace("codex");
        fs::create_dir_all(&root).unwrap();

        let path = write_instruction_file("codex", "project rules", &root).unwrap();

        assert_eq!(PathBuf::from(&path), root.join("AGENTS.md"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "project rules");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_instruction_file_rejects_unknown_cli() {
        let root = temp_workspace("unknown");
        fs::create_dir_all(&root).unwrap();

        let err = write_instruction_file("unknown", "content", &root).unwrap_err();

        assert!(err.contains("Unknown CLI"));
        fs::remove_dir_all(root).unwrap();
    }
}
