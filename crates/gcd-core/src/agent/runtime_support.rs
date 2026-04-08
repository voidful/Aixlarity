use std::path::Path;
use std::process::Command;

use super::types::{AgentMessage, TokenUsage};

pub(super) const CONTEXT_WINDOW_BUDGET: usize = 100_000;

pub(super) fn estimate_total_tokens(messages: &[AgentMessage]) -> usize {
    messages
        .iter()
        .map(|message| {
            let content_tokens = TokenUsage::estimate_tokens(&message.content);
            let tool_tokens = message
                .tool_calls
                .as_ref()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| TokenUsage::estimate_tokens(&call.arguments.to_string()))
                        .sum::<usize>()
                })
                .unwrap_or(0);
            content_tokens + tool_tokens
        })
        .sum()
}

pub(super) fn compact_messages(messages: &mut Vec<AgentMessage>) {
    if messages.len() < 6 {
        return;
    }

    let first = messages[0].clone();
    let keep_last = 4;
    let middle_count = messages.len() - 1 - keep_last;

    let mut summary_parts = Vec::new();
    for message in &messages[1..=middle_count] {
        match message.role.as_str() {
            "assistant" => {
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        summary_parts.push(format!("- Called tool `{}` ", call.name));
                    }
                }
                if !message.content.is_empty() {
                    let truncated: String = message.content.chars().take(100).collect();
                    summary_parts.push(format!("- Assistant: {}...", truncated));
                }
            }
            "tool" => {
                summary_parts.push("- (tool result)".to_string());
            }
            _ => {}
        }
    }

    let summary = format!(
        "[Context compacted: {} messages summarized]\n{}",
        middle_count,
        summary_parts.join("\n")
    );

    let tail = messages.split_off(messages.len() - keep_last);
    messages.clear();
    messages.push(first);
    messages.push(AgentMessage {
        role: "user".to_string(),
        content: summary,
        tool_calls: None,
        tool_call_id: None,
    });
    messages.extend(tail);
}

// ---------------------------------------------------------------------------
// Undercover Mode — sanitize commit messages for public repos
// ---------------------------------------------------------------------------

/// Patterns that may leak sensitive information in commit messages.
const SENSITIVE_PATTERNS: &[&str] = &[
    "api_key", "API_KEY", "apikey", "secret", "SECRET", "token", "TOKEN", "password", "PASSWORD",
    "auth", "bearer", "sk-", "AIza",
];

/// Check if the workspace has any remote URLs configured (public repo indicator).
fn has_public_remote(workspace: &Path) -> bool {
    Command::new("git")
        .args(["remote", "-v"])
        .current_dir(workspace)
        .output()
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // If there's any remote configured, treat as potentially public
            !stdout.trim().is_empty()
        })
        .unwrap_or(false)
}

/// Sanitize a commit message by removing potentially sensitive content.
pub(super) fn sanitize_commit_message(msg: &str) -> String {
    let mut result = msg.to_string();

    // Remove anything that looks like an API key or secret
    for pattern in SENSITIVE_PATTERNS {
        if result.contains(pattern) {
            // Replace the line containing the sensitive pattern
            result = result
                .lines()
                .map(|line| {
                    if line.to_lowercase().contains(&pattern.to_lowercase()) {
                        "[redacted]"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }

    // Remove absolute paths (e.g., /Users/username/... or /home/username/...)
    let path_prefixes = ["/Users/", "/home/", "/root/", "C:\\Users\\"];
    for prefix in &path_prefixes {
        if result.contains(prefix) {
            result = result
                .lines()
                .map(|line| {
                    if line.contains(prefix) {
                        // Replace absolute paths with relative paths
                        let mut sanitized = line.to_string();
                        while let Some(start) = sanitized.find(prefix) {
                            // Find the end of the path (next space or end of string)
                            let rest = &sanitized[start..];
                            let end = rest
                                .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
                                .unwrap_or(rest.len());
                            let path = &sanitized[start..start + end];
                            // Keep only the last 2 components
                            let short = path
                                .rsplit('/')
                                .take(2)
                                .collect::<Vec<_>>()
                                .into_iter()
                                .rev()
                                .collect::<Vec<_>>()
                                .join("/");
                            sanitized = format!(
                                "{}.../{}{}",
                                &sanitized[..start],
                                short,
                                &sanitized[start + end..]
                            );
                        }
                        sanitized
                    } else {
                        line.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }

    result
}

/// Git auto-commit with undercover mode.
/// If the repo has remote URLs, sanitize the commit message.
pub(super) fn git_auto_commit_safe(workspace: &Path, summary: &str) {
    let is_git = Command::new("git")
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .current_dir(workspace)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !is_git {
        return;
    }

    let has_changes = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace)
        .output()
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(false);
    if !has_changes {
        return;
    }

    let truncated = if summary.len() > 72 {
        &summary[..72]
    } else {
        summary
    };

    // Apply undercover mode: sanitize for public repos
    let commit_msg = if has_public_remote(workspace) {
        let sanitized = sanitize_commit_message(truncated);
        eprintln!("\x1b[2m🕵️ Undercover mode: commit message sanitized for public repo\x1b[0m");
        format!("gcd: {}", sanitized)
    } else {
        format!("gcd: {}", truncated)
    };

    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(workspace)
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", &commit_msg])
        .current_dir(workspace)
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_api_keys() {
        let msg = "Updated config with api_key=sk-12345 for testing";
        let result = sanitize_commit_message(msg);
        assert!(result.contains("[redacted]"));
        assert!(!result.contains("sk-12345"));
    }

    #[test]
    fn sanitize_removes_absolute_paths() {
        let msg = "Modified /Users/john/project/src/main.rs";
        let result = sanitize_commit_message(msg);
        assert!(!result.contains("/Users/john"));
        assert!(result.contains("src/main.rs"));
    }

    #[test]
    fn sanitize_preserves_clean_messages() {
        let msg = "Refactored error handling in tools module";
        let result = sanitize_commit_message(msg);
        assert_eq!(result, msg);
    }

    #[test]
    fn sanitize_handles_multiple_sensitive_lines() {
        let msg = "Line 1 is clean\nLine 2 has SECRET=abc\nLine 3 is clean";
        let result = sanitize_commit_message(msg);
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines[0], "Line 1 is clean");
        assert_eq!(lines[1], "[redacted]");
        assert_eq!(lines[2], "Line 3 is clean");
    }
}
