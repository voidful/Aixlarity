use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::AppPaths;
use crate::trust::TrustState;
use crate::workspace::Workspace;

// ---------------------------------------------------------------------------
// Frontmatter parsing (lightweight, no YAML dependency)
// ---------------------------------------------------------------------------

/// Metadata extracted from YAML-like frontmatter (--- delimited).
#[derive(Clone, Debug, Default)]
pub struct SkillFrontmatter {
    /// Explicit name override (max 64 chars).
    pub name: Option<String>,
    /// Short description for progressive disclosure tier 1 (max 1024 chars).
    pub description: Option<String>,
    /// Semantic version string.
    pub version: Option<String>,
    /// Platform restrictions (e.g. ["macos", "linux"]).
    pub platforms: Vec<String>,
}

/// Parse a simple YAML-like frontmatter block delimited by `---`.
/// Returns (frontmatter, body_without_frontmatter).
fn parse_frontmatter(raw: &str) -> (SkillFrontmatter, &str) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (SkillFrontmatter::default(), raw);
    }

    // Find the closing ---
    let after_open = &trimmed[3..];
    let closing = after_open.find("\n---");
    let (yaml_block, body_start) = match closing {
        Some(pos) => {
            let yaml = &after_open[..pos];
            // Skip past the closing --- and the newline after it
            let rest_start = 3 + pos + 4; // "---" (3) + yaml + "\n---" (4)
            let rest = if rest_start < trimmed.len() {
                &trimmed[rest_start..]
            } else {
                ""
            };
            (yaml, rest)
        }
        None => return (SkillFrontmatter::default(), raw),
    };

    let mut kv: HashMap<String, String> = HashMap::new();
    for line in yaml_block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim().to_string();
            kv.insert(key, value);
        }
    }

    let platforms = kv
        .get("platforms")
        .map(|v| {
            v.trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let fm = SkillFrontmatter {
        name: kv.get("name").cloned(),
        description: kv.get("description").cloned(),
        version: kv.get("version").cloned(),
        platforms,
    };

    (fm, body_start)
}

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SkillDefinition {
    pub name: String,
    /// Short description for listing (tier 1). Extracted from frontmatter
    /// description or the first non-empty line of the body.
    pub summary: String,
    /// Full SKILL.md content including frontmatter (tier 2).
    pub body: String,
    /// Parsed frontmatter metadata.
    pub frontmatter: SkillFrontmatter,
    pub source_path: PathBuf,
    /// Linked files within the skill directory (tier 3).
    pub linked_files: Vec<PathBuf>,
}

impl SkillDefinition {
    /// Check if this skill is available on the current platform.
    pub fn is_available_on_current_platform(&self) -> bool {
        if self.frontmatter.platforms.is_empty() {
            return true; // No restriction means available everywhere
        }
        let current = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            return true; // Unknown platform, allow
        };
        self.frontmatter
            .platforms
            .iter()
            .any(|p| p.eq_ignore_ascii_case(current))
    }
}

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct SkillCatalog {
    pub skills: Vec<SkillDefinition>,
}

impl SkillCatalog {
    pub fn load(paths: &AppPaths, workspace: &Workspace, trust: &TrustState) -> io::Result<Self> {
        if trust.restricts_project_config() {
            return Ok(Self::default());
        }

        let mut skills = Vec::new();
        load_skills_from_dir(&paths.global_skills_dir(), &mut skills)?;
        load_skills_from_dir(&workspace.project_skills_dir(), &mut skills)?;
        skills.sort_by(|left, right| left.name.cmp(&right.name));

        // Filter by platform
        skills.retain(|s| s.is_available_on_current_platform());

        Ok(Self { skills })
    }

    pub fn find(&self, name: &str) -> Option<&SkillDefinition> {
        self.skills.iter().find(|skill| skill.name == name)
    }

    /// Progressive disclosure tier 1: return only metadata (name + description).
    /// This avoids injecting full skill bodies into the system prompt when
    /// only the catalog listing is needed.
    pub fn metadata_listing(&self) -> Vec<(&str, &str)> {
        self.skills
            .iter()
            .map(|s| (s.name.as_str(), s.summary.as_str()))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

fn load_skills_from_dir(root: &Path, skills: &mut Vec<SkillDefinition>) -> io::Result<()> {
    if !root.exists() {
        return Ok(());
    }

    let mut files = walk_markdown_files(root)?;
    files.sort();
    for file in files {
        let relative = file.strip_prefix(root).unwrap_or(file.as_path());
        let file_name = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let dir_name = if file_name.eq_ignore_ascii_case("SKILL.md") {
            relative
                .parent()
                .map(path_to_skill_name)
                .unwrap_or_else(|| "skill".to_string())
        } else {
            path_to_skill_name(relative.with_extension("").as_path())
        };

        let raw_body = fs::read_to_string(&file)?;
        let (frontmatter, body_content) = parse_frontmatter(&raw_body);

        // Name priority: frontmatter.name > directory-derived name
        let name = frontmatter.name.clone().unwrap_or_else(|| dir_name.clone());

        // Summary priority: frontmatter.description > first non-empty line of body
        let summary = frontmatter
            .description
            .clone()
            .unwrap_or_else(|| first_non_empty_line(body_content));

        // Discover linked files within the skill directory
        let linked_files = if file_name.eq_ignore_ascii_case("SKILL.md") {
            discover_linked_files(file.parent().unwrap_or(Path::new(".")))
        } else {
            Vec::new()
        };

        skills.push(SkillDefinition {
            name,
            summary,
            body: raw_body,
            frontmatter,
            source_path: file,
            linked_files,
        });
    }

    Ok(())
}

/// Discover non-SKILL.md files within a skill directory for tier 3 disclosure.
fn discover_linked_files(skill_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![skill_dir.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                let fname = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                if !fname.eq_ignore_ascii_case("SKILL.md") {
                    if let Ok(relative) = path.strip_prefix(skill_dir) {
                        files.push(relative.to_path_buf());
                    }
                }
            }
        }
    }

    files.sort();
    files
}

fn walk_markdown_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("md")
            {
                files.push(path);
            }
        }
    }

    Ok(files)
}

fn path_to_skill_name(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        parts.push(component.as_os_str().to_string_lossy().into_owned());
    }
    parts.join(":")
}

fn first_non_empty_line(body: &str) -> String {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let without_prefix = trimmed.trim_start_matches('#').trim();
        return without_prefix.to_string();
    }
    "Reusable skill".to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter_basic() {
        let input = r#"---
name: my-skill
description: A skill that does things
version: 1.0.0
platforms: [macos, linux]
---

# My Skill

Instructions here.
"#;
        let (fm, body) = parse_frontmatter(input);
        assert_eq!(fm.name.as_deref(), Some("my-skill"));
        assert_eq!(fm.description.as_deref(), Some("A skill that does things"));
        assert_eq!(fm.version.as_deref(), Some("1.0.0"));
        assert_eq!(fm.platforms, vec!["macos", "linux"]);
        assert!(body.contains("# My Skill"));
    }

    #[test]
    fn parse_frontmatter_missing() {
        let input = "# No Frontmatter\n\nJust content.";
        let (fm, body) = parse_frontmatter(input);
        assert!(fm.name.is_none());
        assert_eq!(body, input);
    }

    #[test]
    fn platform_filtering() {
        let skill = SkillDefinition {
            name: "test".into(),
            summary: "test".into(),
            body: String::new(),
            frontmatter: SkillFrontmatter {
                platforms: vec!["windows".into()],
                ..Default::default()
            },
            source_path: PathBuf::new(),
            linked_files: Vec::new(),
        };

        // On Linux/macOS CI, a windows-only skill should be filtered
        if cfg!(not(target_os = "windows")) {
            assert!(!skill.is_available_on_current_platform());
        }
    }

    #[test]
    fn no_platform_restriction_means_available_everywhere() {
        let skill = SkillDefinition {
            name: "test".into(),
            summary: "test".into(),
            body: String::new(),
            frontmatter: SkillFrontmatter::default(),
            source_path: PathBuf::new(),
            linked_files: Vec::new(),
        };
        assert!(skill.is_available_on_current_platform());
    }
}
