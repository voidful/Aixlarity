use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::config::SandboxPolicy;

use super::{Tool, ToolContext};

pub struct ApplyPatchTool;

#[async_trait::async_trait]
impl Tool for ApplyPatchTool {
    fn name(&self) -> &str {
        "apply_patch"
    }

    fn description(&self) -> &str {
        "Apply a unified diff patch to an existing file, subject to the active sandbox policy."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path to patch" },
                "patch": { "type": "string", "description": "Unified diff patch content" }
            },
            "required": ["path", "patch"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        if matches!(ctx.sandbox, SandboxPolicy::ReadOnly) {
            anyhow::bail!("apply_patch is blocked by read-only sandbox policy");
        }

        let path_str = params["path"].as_str().unwrap_or("");
        let patch = params["patch"].as_str().unwrap_or("");
        if path_str.trim().is_empty() {
            anyhow::bail!("path parameter is required");
        }
        if patch.trim().is_empty() {
            anyhow::bail!("patch parameter is required");
        }

        let path = if matches!(ctx.sandbox, SandboxPolicy::Off) {
            ctx.resolve_path(path_str)
        } else {
            ctx.workspace_path(&ctx.resolve_path(path_str))?
        };

        if !path.exists() {
            anyhow::bail!("Cannot patch missing file: {}", path.display());
        }
        if !path.is_file() {
            anyhow::bail!("Can only patch files: {}", path.display());
        }

        let old_content = fs::read_to_string(&path)
            .map_err(|error| anyhow::anyhow!("Cannot read file to patch: {}", error))?;
        let hunks = parse_patch(path.as_path(), patch)?;
        let new_content = apply_hunks(&old_content, &hunks)?;
        fs::write(&path, &new_content)?;

        Ok(serde_json::json!({
            "path": path.display().to_string(),
            "lines_before": line_count(&old_content),
            "lines_after": line_count(&new_content),
            "hunk_count": hunks.len(),
            "patch_applied": true
        }))
    }
}

#[derive(Debug, PartialEq)]
struct PatchHunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    lines: Vec<PatchLine>,
}

#[derive(Debug, PartialEq)]
enum PatchLine {
    Context(String),
    Add(String),
    Remove(String),
}

fn parse_patch(path: &Path, patch: &str) -> anyhow::Result<Vec<PatchHunk>> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<PatchHunk> = None;

    for raw_line in patch.lines() {
        if raw_line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                validate_hunk(&hunk)?;
                hunks.push(hunk);
            }
            current_hunk = Some(parse_hunk_header(raw_line)?);
            continue;
        }

        if raw_line.starts_with("--- ")
            || raw_line.starts_with("+++ ")
            || raw_line.starts_with("diff --git ")
            || raw_line.starts_with("index ")
        {
            continue;
        }

        if raw_line == "\\ No newline at end of file" {
            continue;
        }

        let hunk = current_hunk.as_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "Patch for {} must include unified diff hunks with @@ headers",
                path.display()
            )
        })?;
        let (marker, content) = raw_line.split_at(1);
        let patch_line = match marker {
            " " => PatchLine::Context(content.to_string()),
            "+" => PatchLine::Add(content.to_string()),
            "-" => PatchLine::Remove(content.to_string()),
            _ => anyhow::bail!("Unsupported patch line: {}", raw_line),
        };
        hunk.lines.push(patch_line);
    }

    if let Some(hunk) = current_hunk.take() {
        validate_hunk(&hunk)?;
        hunks.push(hunk);
    }

    if hunks.is_empty() {
        anyhow::bail!(
            "Patch for {} did not contain any unified diff hunks",
            path.display()
        );
    }

    Ok(hunks)
}

fn parse_hunk_header(line: &str) -> anyhow::Result<PatchHunk> {
    let trimmed = line.trim_start_matches("@@").trim_end_matches("@@").trim();
    let mut parts = trimmed.split_whitespace();
    let old = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing old range in hunk header: {}", line))?;
    let new = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing new range in hunk header: {}", line))?;
    let (old_start, old_count) = parse_hunk_range(old, '-')?;
    let (new_start, new_count) = parse_hunk_range(new, '+')?;

    Ok(PatchHunk {
        old_start,
        old_count,
        new_start,
        new_count,
        lines: Vec::new(),
    })
}

fn parse_hunk_range(raw: &str, prefix: char) -> anyhow::Result<(usize, usize)> {
    let value = raw
        .strip_prefix(prefix)
        .ok_or_else(|| anyhow::anyhow!("Invalid hunk range {}, expected prefix {}", raw, prefix))?;
    let mut parts = value.splitn(2, ',');
    let start = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing start line in hunk range: {}", raw))?
        .parse::<usize>()?;
    let count = parts
        .next()
        .map(str::parse::<usize>)
        .transpose()?
        .unwrap_or(1);
    Ok((start, count))
}

fn validate_hunk(hunk: &PatchHunk) -> anyhow::Result<()> {
    let old_lines = hunk
        .lines
        .iter()
        .filter(|line| !matches!(line, PatchLine::Add(_)))
        .count();
    let new_lines = hunk
        .lines
        .iter()
        .filter(|line| !matches!(line, PatchLine::Remove(_)))
        .count();

    if old_lines != hunk.old_count {
        anyhow::bail!(
            "Hunk old range expected {} lines but contained {}",
            hunk.old_count,
            old_lines
        );
    }
    if new_lines != hunk.new_count {
        anyhow::bail!(
            "Hunk new range expected {} lines but contained {}",
            hunk.new_count,
            new_lines
        );
    }

    Ok(())
}

fn apply_hunks(content: &str, hunks: &[PatchHunk]) -> anyhow::Result<String> {
    let had_trailing_newline = content.ends_with('\n');
    let source_lines = split_lines(content);
    let mut output = Vec::new();
    let mut cursor = 0usize;

    for hunk in hunks {
        let hunk_start = hunk.old_start.saturating_sub(1);
        if hunk_start < cursor {
            anyhow::bail!("Patch hunks overlap or are out of order");
        }
        if hunk_start > source_lines.len() {
            anyhow::bail!(
                "Hunk starts at line {} but file only has {} lines",
                hunk.old_start,
                source_lines.len()
            );
        }

        output.extend_from_slice(&source_lines[cursor..hunk_start]);
        cursor = hunk_start;

        for line in &hunk.lines {
            match line {
                PatchLine::Context(expected) => {
                    match_source_line(&source_lines, cursor, expected, "context")?;
                    output.push(expected.clone());
                    cursor += 1;
                }
                PatchLine::Remove(expected) => {
                    match_source_line(&source_lines, cursor, expected, "removed")?;
                    cursor += 1;
                }
                PatchLine::Add(added) => output.push(added.clone()),
            }
        }
    }

    output.extend_from_slice(&source_lines[cursor..]);
    Ok(join_lines(&output, had_trailing_newline))
}

fn match_source_line(
    source_lines: &[String],
    cursor: usize,
    expected: &str,
    kind: &str,
) -> anyhow::Result<()> {
    let actual = source_lines.get(cursor).ok_or_else(|| {
        anyhow::anyhow!(
            "Patch {} line {} is beyond the end of the file",
            kind,
            cursor + 1
        )
    })?;
    if actual != expected {
        anyhow::bail!(
            "Patch {} mismatch at line {}: expected {:?}, found {:?}",
            kind,
            cursor + 1,
            expected,
            actual
        );
    }
    Ok(())
}

fn split_lines(content: &str) -> Vec<String> {
    content.lines().map(str::to_string).collect()
}

fn join_lines(lines: &[String], had_trailing_newline: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }

    let mut result = lines.join("\n");
    if had_trailing_newline {
        result.push('\n');
    }
    result
}

fn line_count(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.lines().count()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{apply_hunks, parse_patch, ApplyPatchTool, PatchLine};
    use crate::config::SandboxPolicy;
    use crate::tools::{Tool, ToolContext};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parse_patch_extracts_unified_hunks() {
        let patch =
            "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,3 @@\n alpha\n-beta\n+bravo\n+charlie\n";
        let path = PathBuf::from("demo.txt");

        let hunks = parse_patch(&path, patch).unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_start, 1);
        assert_eq!(hunks[0].new_count, 3);
        assert_eq!(hunks[0].lines[1], PatchLine::Remove("beta".to_string()));
    }

    #[test]
    fn apply_hunks_rejects_mismatched_context() {
        let patch = parse_patch(
            PathBuf::from("demo.txt").as_path(),
            "@@ -1,2 +1,2 @@\n alpha\n-beta\n+bravo\n",
        )
        .unwrap();
        let error = apply_hunks("alpha\nwrong\n", &patch)
            .unwrap_err()
            .to_string();
        assert!(error.contains("mismatch"));
    }

    #[tokio::test]
    async fn apply_patch_tool_updates_file_with_strict_hunks() {
        let root = unique_dir("apply-patch");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("demo.txt");
        fs::write(&path, "alpha\nbeta\n").unwrap();
        let ctx = ToolContext {
            workspace_root: root.clone(),
            sandbox: SandboxPolicy::WorkspaceWrite,
            coordinator_provider: None,
            coordinator_api_key: None,
            coordinator_permission: None,
            coordinator_fallback_providers: Vec::new(),
            coordinator_plugin_definitions: Vec::new(),
            coordinator_depth: 0,
            coordinator_prompt_context: None,
            hooks: crate::hooks::HooksConfig::default(),
        };

        let result = ApplyPatchTool
            .execute(
                json!({
                    "path": "demo.txt",
                    "patch": "@@ -1,2 +1,3 @@\n alpha\n-beta\n+bravo\n+charlie\n"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert_eq!(result["patch_applied"], json!(true));
        assert_eq!(fs::read_to_string(path).unwrap(), "alpha\nbravo\ncharlie\n");
    }

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gcd-apply-patch-{}-{}", label, stamp))
    }
}
