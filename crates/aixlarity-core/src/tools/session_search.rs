// Aixlarity — Session Search Tool
//
// Searches past session transcripts stored as JSONL files in ~/.aixlarity/sessions/.
// Inspired by Hermes Agent's FTS5-based session search, but implemented as
// a lightweight file-based search (no SQLite dependency) suitable for a
// single-binary Rust agent.
//
// Flow:
//   1. Scan session JSONL files in ~/.aixlarity/sessions/
//   2. Search message content for keyword matches
//   3. Return matched snippets with session metadata
//   4. Agent can use this to recall how it solved similar problems before

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::{Tool, ToolContext};
use crate::config::AppPaths;

const MAX_RESULTS: usize = 5;
const SNIPPET_CONTEXT_CHARS: usize = 200;

pub struct SessionSearchTool;

#[async_trait::async_trait]
impl Tool for SessionSearchTool {
    fn name(&self) -> &str {
        "session_search"
    }

    fn description(&self) -> &str {
        "Search past session transcripts for relevant context. \
         Use this when facing a task similar to something done before, \
         or when the user references a previous conversation. \
         Returns matched snippets with session metadata."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keywords to search for in past sessions (space-separated, all must match)."
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matching snippets to return (default: 5)."
                }
            },
            "required": ["query"]
        })
    }

    async fn execute(&self, params: Value, _ctx: &ToolContext) -> anyhow::Result<Value> {
        let query = params["query"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'query' parameter"))?;

        let max = params["max_results"]
            .as_u64()
            .map(|v| v as usize)
            .unwrap_or(MAX_RESULTS)
            .min(10);

        let keywords: Vec<String> = query
            .split_whitespace()
            .map(|s| s.to_lowercase())
            .filter(|s| s.len() >= 2)
            .collect();

        if keywords.is_empty() {
            return Ok(serde_json::json!({
                "error": "Query must contain at least one keyword (2+ characters)."
            }));
        }

        let sessions_dir =
            AppPaths::detect(std::env::current_dir().unwrap_or_default()).sessions_dir();

        if !sessions_dir.exists() {
            return Ok(serde_json::json!({
                "results": [],
                "message": "No session history found."
            }));
        }

        let mut results: Vec<Value> = Vec::new();

        // Collect and sort session files by modification time (newest first)
        let mut session_files: Vec<PathBuf> = fs::read_dir(&sessions_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext == "jsonl" || ext == "json")
                    .unwrap_or(false)
            })
            .collect();

        session_files.sort_by(|a, b| {
            let ma = a.metadata().and_then(|m| m.modified()).ok();
            let mb = b.metadata().and_then(|m| m.modified()).ok();
            mb.cmp(&ma) // newest first
        });

        // Search through sessions
        for session_path in session_files {
            if results.len() >= max {
                break;
            }

            let session_name = session_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            let content = match fs::read_to_string(&session_path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Parse JSONL: each line is a JSON object with role/content
            for line in content.lines() {
                if results.len() >= max {
                    break;
                }

                let parsed: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let role = parsed["role"].as_str().unwrap_or("unknown");
                let msg_content = parsed["content"].as_str().unwrap_or("");
                let lower_content = msg_content.to_lowercase();

                // Check if all keywords match
                if keywords
                    .iter()
                    .all(|kw| lower_content.contains(kw.as_str()))
                {
                    // Find the first keyword match position for snippet extraction
                    let first_match_pos = keywords
                        .iter()
                        .filter_map(|kw| lower_content.find(kw.as_str()))
                        .min()
                        .unwrap_or(0);

                    let snippet = extract_snippet(msg_content, first_match_pos);

                    let modified = session_path
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    results.push(serde_json::json!({
                        "session": session_name,
                        "role": role,
                        "snippet": snippet,
                        "modified_unix": modified
                    }));
                }
            }
        }

        Ok(serde_json::json!({
            "results": results,
            "query": query,
            "total_matches": results.len()
        }))
    }
}

fn extract_snippet(text: &str, match_pos: usize) -> String {
    let start = match_pos.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let end = (match_pos + SNIPPET_CONTEXT_CHARS).min(text.len());

    // Adjust to char boundaries
    let start = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= start)
        .unwrap_or(0);
    let end = text
        .char_indices()
        .map(|(i, _)| i)
        .rev()
        .find(|&i| i <= end)
        .unwrap_or(text.len());

    let mut snippet = String::new();
    if start > 0 {
        snippet.push_str("...");
    }
    snippet.push_str(&text[start..end]);
    if end < text.len() {
        snippet.push_str("...");
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_snippet_with_context() {
        let text = "The quick brown fox jumps over the lazy dog. And then some more text follows after that.";
        let snippet = extract_snippet(text, 16); // "fox"
        assert!(snippet.contains("fox"));
        assert!(snippet.contains("brown"));
    }

    #[test]
    fn extract_snippet_at_start() {
        let text = "Hello world this is a test";
        let snippet = extract_snippet(text, 0);
        assert!(snippet.starts_with("Hello"));
    }
}
