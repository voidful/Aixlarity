use std::collections::HashMap;
use std::fs;
use std::io;

use crate::trust::TrustState;
use crate::workspace::Workspace;

#[derive(Clone, Debug)]
pub struct InstructionSource {
    pub label: String,
    pub content: String,
}

#[derive(Clone, Debug, Default)]
pub struct InstructionBundle {
    pub sources: Vec<InstructionSource>,
}

impl InstructionBundle {
    pub fn load(
        workspace: &Workspace,
        trust: &TrustState,
        persona: Option<&str>,
    ) -> io::Result<Self> {
        if trust.restricts_project_config() {
            return Ok(Self::default());
        }

        let mut sources = Vec::new();
        for name in &["AGENTS.md", "GEMINI.md", "CLAUDE.md", "AIXLARITY.md"] {
            let path = workspace.root.join(name);
            if path.exists() {
                let content = fs::read_to_string(&path)?;
                sources.push(InstructionSource {
                    label: (*name).to_string(),
                    content,
                });
            }
        }

        if let Some(p) = persona {
            if !p.is_empty() && p.to_lowercase() != "general" {
                let persona_file = format!("{}.md", p);
                let persona_path = workspace
                    .root
                    .join(".aixlarity")
                    .join("personas")
                    .join(&persona_file);

                let content = if persona_path.exists() {
                    fs::read_to_string(&persona_path).unwrap_or_default()
                } else {
                    // Fallback to built-in persona definitions when no file exists.
                    // These are intentionally richer than one-liners to provide
                    // meaningful guidance even without .aixlarity/personas/ files.
                    let default_persona = match p.to_lowercase().as_str() {
                        "architect" => "You are a System Architect. Your role is to design systems, plan architectures, and write technical design documents. Focus on module boundaries, dependency direction, interface contracts, and scalability. Never write implementation code — output designs and ADRs. Prefer extending existing modules over creating new ones. Flag circular dependencies as Critical issues. Design for testability.",
                        "developer" => "You are a Senior Developer. Your role is to write clean, performant, and production-ready code using incremental vertical slices. Follow existing code patterns. Every behavior change must have a corresponding test. Keep aixlarity-core free of unnecessary dependencies. Preserve offline testability. Reference the source product when a design pattern comes from Claude Code, Gemini CLI, Codex, or Hermes.",
                        "codereviewer" | "code-reviewer" | "code_reviewer" | "reviewer" => "You are a Senior Staff Engineer conducting code review. Evaluate changes across five dimensions: correctness, readability, architecture, security, and performance. Categorize findings as Critical (must fix), Important (should fix), or Suggestion (consider). Never write code — only review. Always include at least one positive observation.",
                        "testengineer" | "test-engineer" | "test_engineer" | "qa_engineer" | "qa" => "You are a Test Engineer focused on test strategy and quality assurance. Design test suites, write tests, analyze coverage gaps. Follow the Prove-It pattern for bugs: write a failing test first, confirm it fails, then report readiness. Test behavior not implementation. Each test verifies one concept. Mock at boundaries, not between internal functions.",
                        "securityauditor" | "security-auditor" | "security_auditor" | "security" => "You are a Security Engineer conducting security review. Focus on exploitable vulnerabilities, not theoretical risks. Check OWASP Top 10 as minimum baseline. Classify findings by severity (Critical/High/Medium/Low/Info). Every finding must include an actionable recommendation. Provide proof of concept for Critical/High findings. Never suggest disabling security controls.",
                        "devops" => "You are a DevOps and Platform Engineer. Design build systems, CI/CD pipelines, deployment configurations, and container environments. Shift left: move testing and security checks early. Faster is safer: small frequent deployments over large batches. Infrastructure as code: every config change is version controlled. Always have a rollback plan.",
                        "techwriter" | "tech-writer" | "tech_writer" | "writer" => "You are a Technical Writer and Documentation Engineer. Create clear, accurate, and maintainable documentation. Document the 'why', not just the 'what'. Use honest status labels (Implemented, Partially Wired, Stub, Planned). Write Architecture Decision Records for significant decisions. Code examples must compile. Update existing docs when code changes.",
                        "dataengineer" | "data-engineer" | "data_engineer" | "data_analyst" | "data" => "You are a Data Engineer and Scientist. Priorities: data integrity, statistical accuracy, pipeline robustness, clean transformations. Validate before transforming. Design idempotent pipelines. Never modify source data. Use parameterized queries. Handle encoding explicitly (default UTF-8). Log row counts at every pipeline stage.",
                        _ => "You are a specialized Agent operating under a custom persona. Follow the user's instructions carefully and stay within the assigned scope.",
                    };
                    default_persona.to_string()
                };

                if !content.is_empty() {
                    sources.push(InstructionSource {
                        label: format!("Active Persona: {}", p),
                        content,
                    });
                }
            }
        }

        Ok(Self { sources })
    }
}

/// Parse the `allowed_tools` field from a persona file's YAML frontmatter.
///
/// Expects a line like: `allowed_tools: [read_file, search_files, list_dir]`
/// within `---` delimited frontmatter. Returns `None` if the field is absent
/// or the list is empty, meaning "all tools allowed".
pub fn parse_persona_allowed_tools(raw: &str) -> Option<Vec<String>> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }

    let after_open = &trimmed[3..];
    let closing = after_open.find("\n---");
    let yaml_block = match closing {
        Some(pos) => &after_open[..pos],
        None => return None,
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

    kv.get("allowed_tools").and_then(|v| {
        let tools: Vec<String> = v
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if tools.is_empty() {
            None
        } else {
            Some(tools)
        }
    })
}

/// Retrieve the allowed tools for a given persona.
/// It first checks if there's a `.aixlarity/personas/{name}.md` file with a frontmatter definition.
/// If not, it falls back to built-in defaults for known personas.
pub fn get_persona_allowed_tools(
    workspace_root: &std::path::Path,
    persona_name: &str,
) -> Option<Vec<String>> {
    let persona_file = format!("{}.md", persona_name);
    let persona_path = workspace_root
        .join(".aixlarity")
        .join("personas")
        .join(&persona_file);

    if persona_path.exists() {
        if let Ok(raw) = fs::read_to_string(&persona_path) {
            return parse_persona_allowed_tools(&raw);
        }
    }

    // Fallbacks if no physical file exists, ensuring engine-level tool restrictions
    // match the fallback prompt definitions.
    match persona_name.to_lowercase().as_str() {
        "architect" => Some(vec![
            "read_file".to_string(),
            "search_files".to_string(),
            "list_dir".to_string(),
            "fetch_url".to_string(),
            "spawn_agent".to_string(),
        ]),
        "codereviewer" | "code-reviewer" | "code_reviewer" | "reviewer" => Some(vec![
            "read_file".to_string(),
            "search_files".to_string(),
            "list_dir".to_string(),
            "shell".to_string(),
        ]),
        "securityauditor" | "security-auditor" | "security_auditor" | "security" => Some(vec![
            "read_file".to_string(),
            "search_files".to_string(),
            "list_dir".to_string(),
            "shell".to_string(),
            "fetch_url".to_string(),
        ]),
        "techwriter" | "tech-writer" | "tech_writer" | "writer" => Some(vec![
            "read_file".to_string(),
            "search_files".to_string(),
            "list_dir".to_string(),
            "write_file".to_string(),
            "apply_patch".to_string(),
        ]),
        // These roles get full access (None means no restriction)
        "developer" | "testengineer" | "test-engineer" | "test_engineer" | "qa_engineer" | "qa"
        | "devops" | "dataengineer" | "data-engineer" | "data_engineer" | "data_analyst"
        | "data" => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_allowed_tools_basic() {
        let input = r#"---
name: code-reviewer
allowed_tools: [read_file, search_files, list_dir]
---

# Code Reviewer
"#;
        let tools = parse_persona_allowed_tools(input);
        assert_eq!(
            tools,
            Some(vec![
                "read_file".to_string(),
                "search_files".to_string(),
                "list_dir".to_string(),
            ])
        );
    }

    #[test]
    fn parse_allowed_tools_empty_means_none() {
        let input = r#"---
name: developer
allowed_tools: []
---

# Developer
"#;
        let tools = parse_persona_allowed_tools(input);
        assert!(tools.is_none());
    }

    #[test]
    fn parse_allowed_tools_missing_means_none() {
        let input = r#"---
name: developer
---

# Developer
"#;
        let tools = parse_persona_allowed_tools(input);
        assert!(tools.is_none());
    }

    #[test]
    fn parse_allowed_tools_no_frontmatter() {
        let input = "# Just a regular markdown file";
        let tools = parse_persona_allowed_tools(input);
        assert!(tools.is_none());
    }

    #[test]
    fn parse_allowed_tools_with_quoted_names() {
        let input = r#"---
name: test-persona
allowed_tools: ["read_file", "search_files"]
---

# Test
"#;
        let tools = parse_persona_allowed_tools(input);
        assert_eq!(
            tools,
            Some(vec!["read_file".to_string(), "search_files".to_string()])
        );
    }

    #[test]
    fn parse_allowed_tools_ignores_composition_key() {
        // The `composition:` key has nested values that shouldn't interfere
        // with `allowed_tools` parsing. This tests that our simple YAML
        // parser handles multi-line structures gracefully.
        let input = r#"---
name: code-reviewer
allowed_tools: [read_file, shell]
composition:
  invoke_via: ["/review", "/ship"]
---

# Code Reviewer
"#;
        let tools = parse_persona_allowed_tools(input);
        assert_eq!(
            tools,
            Some(vec!["read_file".to_string(), "shell".to_string()])
        );
    }

    #[test]
    fn parse_allowed_tools_whitespace_only_value() {
        let input = concat!(
            "---\n",
            "name: test\n",
            "allowed_tools:   \n",
            "---\n\n",
            "# Test\n",
        );
        let tools = parse_persona_allowed_tools(input);
        assert!(tools.is_none());
    }

    #[test]
    fn get_persona_allowed_tools_fallback_architect() {
        let empty_workspace = std::path::PathBuf::from("/non/existent/path/12345");
        let tools = get_persona_allowed_tools(&empty_workspace, "architect").unwrap();
        assert!(tools.contains(&"spawn_agent".to_string()));
        assert!(tools.contains(&"read_file".to_string()));
    }

    #[test]
    fn get_persona_allowed_tools_fallback_developer() {
        let empty_workspace = std::path::PathBuf::from("/non/existent/path/12345");
        let tools = get_persona_allowed_tools(&empty_workspace, "developer");
        // Developer has no restrictions by default
        assert!(tools.is_none());
    }

    #[test]
    fn get_persona_allowed_tools_fallback_reviewer_alias() {
        let empty_workspace = std::path::PathBuf::from("/non/existent/path/12345");
        let tools1 = get_persona_allowed_tools(&empty_workspace, "codereviewer").unwrap();
        let tools2 = get_persona_allowed_tools(&empty_workspace, "code-reviewer").unwrap();
        assert_eq!(tools1, tools2);
        assert!(tools1.contains(&"shell".to_string()));
        assert!(!tools1.contains(&"write_file".to_string()));
    }
}
