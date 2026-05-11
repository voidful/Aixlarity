use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Command;

use crate::agent::{AgentMessage, AgentRunOptions};

/// Default timeout for external CLI calls (1 hour).
/// Set high to support long-running autonomous agent tasks.
/// Prevents truly-stuck CLIs from hanging forever, but gives
/// complex multi-file tasks plenty of room to complete.
const CLI_TIMEOUT_SECS: u64 = 3600;

/// Lines from stderr that are just CLI noise and should be suppressed.
fn is_noise(line: &str) -> bool {
    let l = line.trim();
    l.contains("no stdin data received")
        || l.contains("proceeding without it")
        || l.contains("redirect stdin explicitly")
        || l.starts_with("Warning: no stdin")
}

/// Resolve the actual binary path for each CLI engine.
///
/// Desktop apps and GUI-spawned processes often lack shell-initialized PATH
/// (e.g. nvm, homebrew). This function probes well-known install locations
/// so the daemon can find binaries regardless of how it was launched.
fn resolve_binary(name: &str) -> String {
    use std::fs;
    use std::path::Path;

    let home = std::env::var("HOME").unwrap_or_default();

    let mut candidates: Vec<String> = Vec::new();

    match name {
        "claude" => {
            if !home.is_empty() {
                candidates.push(format!("{}/.local/bin/claude", home));
            }
            candidates.push("/usr/local/bin/claude".to_string());
        }
        "codex" => {
            candidates.push("/Applications/Codex.app/Contents/Resources/codex".to_string());
            candidates.push("/usr/local/bin/codex".to_string());
        }
        "gemini" => {
            candidates.push("/usr/local/bin/gemini".to_string());
        }
        _ => {}
    }

    // Automatically scan nvm versions without hardcoding a specific node version.
    // This is critical because GUI-launched processes don't source ~/.zshrc / nvm.sh.
    if !home.is_empty() {
        let nvm_dir = format!("{}/.nvm/versions/node", home);
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut paths: Vec<_> = entries
                .flatten()
                .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                .map(|e| e.path().join("bin").join(name))
                .filter(|p| p.exists())
                .collect();
            // Reverse-sort so newer versions (e.g. v22 > v18) are preferred
            paths.sort();
            paths.reverse();
            for path in paths {
                candidates.push(path.to_string_lossy().into_owned());
            }
        }
    }

    // Try absolute path candidates first
    for c in &candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }

    // Fallback: trust PATH
    name.to_string()
}

/// Build an enriched PATH that includes nvm node directories.
///
/// Node-based CLIs (gemini, codex) use `#!/usr/bin/env node` shebangs.
/// When the Aixlarity daemon is spawned from a GUI (Electron IDE), the inherited
/// PATH typically does NOT include nvm directories, causing `env: node: No
/// such file or directory`. This function prepends discovered nvm bin dirs
/// so child processes can resolve `node`.
fn build_enriched_path() -> String {
    use std::fs;

    let current_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    let mut extra_dirs: Vec<String> = Vec::new();

    // Add homebrew paths (macOS)
    for dir in &["/opt/homebrew/bin", "/usr/local/bin"] {
        if std::path::Path::new(dir).is_dir() && !current_path.contains(dir) {
            extra_dirs.push(dir.to_string());
        }
    }

    // Add nvm node bin directories
    if !home.is_empty() {
        let nvm_dir = format!("{}/.nvm/versions/node", home);
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut dirs: Vec<_> = entries
                .flatten()
                .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            dirs.reverse(); // Newest first
            for d in dirs {
                let s = d.to_string_lossy().into_owned();
                if !current_path.contains(&s) {
                    extra_dirs.push(s);
                }
            }
        }
    }

    if extra_dirs.is_empty() {
        current_path
    } else {
        format!("{}:{}", extra_dirs.join(":"), current_path)
    }
}

/// Check if a binary file has a `#!/usr/bin/env node` shebang.
/// Used to decide whether to bypass kernel shebang resolution.
fn is_node_script(path: &str) -> bool {
    use std::fs::File;
    use std::io::Read;

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = [0u8; 64];
    let n = file.read(&mut buf).unwrap_or(0);
    let header = String::from_utf8_lossy(&buf[..n]);
    header.starts_with("#!/usr/bin/env node") || header.starts_with("#!/usr/bin/env -S node")
}

/// Find the `node` binary from an enriched PATH string.
/// Falls back to "node" if nothing is found (will rely on system PATH).
fn resolve_node_binary(enriched_path: &str) -> String {
    use std::path::Path;

    for dir in enriched_path.split(':') {
        let candidate = Path::new(dir).join("node");
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

pub(super) async fn call_external_cli(
    options: &AgentRunOptions,
    messages: &[AgentMessage],
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    // Get the latest user message
    let latest_message = messages
        .iter()
        .rfind(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_else(|| options.initial_prompt.clone());

    // Parse model field: "engine" or "engine:submodel"
    // Examples: "claude", "claude:opus", "claude:sonnet", "gemini:gemini-2.5-flash"
    let (engine, sub_model) = if let Some(pos) = options.provider.model.find(':') {
        let e = &options.provider.model[..pos];
        let m = options.provider.model[pos + 1..].trim();
        (
            e.to_string(),
            if m.is_empty() {
                None
            } else {
                Some(m.to_string())
            },
        )
    } else {
        (options.provider.model.clone(), None)
    };

    let mut args = Vec::new();
    let binary = match engine.as_str() {
        "claude" => {
            args.push("-p".to_string());
            args.push(latest_message);

            // Pass --model if a sub-model is specified (e.g. "opus", "sonnet", "claude-sonnet-4-20250514")
            if let Some(ref m) = sub_model {
                args.push("--model".to_string());
                args.push(m.clone());
            }

            // Resume the most recent conversation in the current directory to maintain context
            args.push("--continue".to_string());

            if options.planning {
                args.push("--permission-mode".to_string());
                args.push("plan".to_string());
            } else {
                // When Claude CLI runs headlessly (stdin = /dev/null) as an external engine,
                // ANY terminal prompt (trust, bash, edit) will cause it to instantly fail.
                // We MUST use bypassPermissions to allow it to run autonomously.
                // Users wanting IDE permission prompts must use the internal API provider instead.
                args.push("--permission-mode".to_string());
                args.push("bypassPermissions".to_string());
            }
            resolve_binary("claude")
        }
        "codex" => {
            args.push("exec".to_string());

            // Codex CLI supports --model for model selection
            if let Some(ref m) = sub_model {
                args.push("--model".to_string());
                args.push(m.clone());
            }

            // When running as a sub-engine, the workspace may not be in
            // Codex's own trust store. Skip the check to avoid blocking.
            args.push("--skip-git-repo-check".to_string());

            args.push(latest_message);
            resolve_binary("codex")
        }
        "gemini" => {
            args.push("-p".to_string());
            args.push(latest_message);

            // Gemini CLI supports --model for model selection
            if let Some(ref m) = sub_model {
                args.push("--model".to_string());
                args.push(m.clone());
            }

            // Resume latest session to maintain context and avoid whole-repo searches
            args.push("--resume".to_string());
            args.push("latest".to_string());

            if options.planning {
                args.push("--approval-mode".to_string());
                args.push("plan".to_string());
            } else {
                match options.permission {
                    crate::agent::PermissionLevel::FullAuto => args.push("--yolo".to_string()),
                    crate::agent::PermissionLevel::AutoEdit => {
                        args.push("--approval-mode".to_string());
                        args.push("auto_edit".to_string());
                    }
                    crate::agent::PermissionLevel::Suggest => {
                        args.push("--approval-mode".to_string());
                        args.push("default".to_string());
                    }
                }
            }

            if matches!(options.sandbox, crate::config::SandboxPolicy::Off) {
                args.push("--sandbox".to_string());
                args.push("false".to_string());
            }

            resolve_binary("gemini")
        }
        _ => {
            args.push("Unsupported external CLI engine".to_string());
            "echo".to_string()
        }
    };

    // Build an enriched PATH so child processes can find `node` even when
    // the daemon was launched from a GUI without shell initialization.
    let enriched_path = build_enriched_path();

    eprintln!("[external-cli] spawning: {} {:?}", binary, args);

    // Node-based CLIs (gemini, codex) use `#!/usr/bin/env node` shebangs.
    // When spawned from a GUI, the kernel resolves the shebang using its own
    // PATH which does NOT include nvm directories — causing "env: node: No
    // such file or directory". We bypass this by running `node <script>`
    // directly when the binary is a node script.
    let (actual_binary, actual_args) = if is_node_script(&binary) {
        let node_bin = resolve_node_binary(&enriched_path);
        let mut full_args = vec![binary.clone()];
        full_args.extend(args.iter().cloned());
        eprintln!(
            "[external-cli] detected node script, using: {} {:?}",
            node_bin, full_args
        );
        (node_bin, full_args)
    } else {
        (binary.clone(), args.clone())
    };

    let mut child = Command::new(&actual_binary)
        .args(&actual_args)
        .current_dir(&options.workspace_root)
        // Inject enriched PATH so child processes can resolve dependencies
        .env("PATH", &enriched_path)
        // Pipe /dev/null into stdin to suppress "no stdin data" warnings
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to spawn {}: {}", actual_binary, e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut final_response = String::new();
    let mut stderr_buffer = String::new();

    let mut child_exited = false;
    let mut grace_period_started = false;
    let grace_duration = std::time::Duration::from_millis(150);
    let mut grace_sleep = Box::pin(tokio::time::sleep(std::time::Duration::from_secs(86400))); // Sleep forever initially

    // Wrap the read loop in a timeout to prevent the daemon from hanging
    // indefinitely when a CLI is stuck (e.g. Claude connecting to a dead
    // auth proxy, or Gemini waiting for interactive input).
    let read_result =
        tokio::time::timeout(std::time::Duration::from_secs(CLI_TIMEOUT_SECS), async {
            loop {
                tokio::select! {
                    Ok(Some(line)) = stdout_reader.next_line() => {
                        // Filter noise from stdout too (some CLIs write warnings to stdout)
                        if is_noise(&line) {
                            continue;
                        }
                        final_response.push_str(&line);
                        final_response.push('\n');

                        if let Some(cb) = &options.stream_handler {
                            (cb.0)(format!("{}\n", line));
                        }
                    }
                    Ok(Some(line)) = stderr_reader.next_line() => {
                        // Only forward meaningful stderr lines, suppress noise
                        if !is_noise(&line) {
                            eprintln!("[external-cli stderr] {}", line);
                            stderr_buffer.push_str(&line);
                            stderr_buffer.push('\n');
                        }
                    }
                    _ = child.wait(), if !child_exited => {
                        child_exited = true;
                    }
                    _ = &mut grace_sleep, if grace_period_started => {
                        // Grace period ended. Break the loop even if stdout is still open.
                        break;
                    }
                    else => break, // EOF reached on both streams
                }

                if child_exited && !grace_period_started {
                    grace_period_started = true;
                    // Reset the sleep to the grace duration
                    grace_sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + grace_duration);
                }
            }
        })
        .await;

    if read_result.is_err() {
        // Timeout — kill the child process
        let _ = child.kill().await;
        let timeout_msg = format!(
            "\n⚠️ External CLI `{}` timed out after {}s with no response.\n\
             Possible causes:\n\
             • Claude: check ~/.claude/settings.json — if ANTHROPIC_BASE_URL points to a local proxy, make sure it is running\n\
             • Gemini: ensure you are authenticated (`gemini auth login`)\n\
             • Network connectivity issues\n",
            binary, CLI_TIMEOUT_SECS
        );
        if let Some(cb) = &options.stream_handler {
            (cb.0)(timeout_msg.clone());
        }
        final_response.push_str(&timeout_msg);
    } else {
        let status = child.wait().await?;
        if !status.success() {
            final_response.push_str(&format!("\n[Process exited with status {}]\n", status));
            if !stderr_buffer.trim().is_empty() {
                final_response.push_str("\n### 🚨 CLI Error Logs:\n```\n");
                final_response.push_str(&stderr_buffer);
                final_response.push_str("```\n");

                // Ensure the error is streamed back to the UI immediately
                if let Some(cb) = &options.stream_handler {
                    (cb.0)(format!(
                        "\n\n### 🚨 CLI Error Logs:\n```\n{}\n```\n",
                        stderr_buffer
                    ));
                }
            }
        }
    }

    // If response is completely empty, provide a diagnostic message
    let content = if final_response.trim().is_empty() {
        format!(
            "⚠️ `{}` produced no output.\n\n\
             **Troubleshooting:**\n\
             • **Claude**: Check `~/.claude/settings.json`. If `ANTHROPIC_BASE_URL` is set to a local proxy (e.g. `http://127.0.0.1:15721`), that proxy must be running. Remove the setting or set `ANTHROPIC_API_KEY` directly.\n\
             • **Gemini**: Run `gemini auth login` in a terminal first. Also ensure `node` is accessible.\n\
             • **Codex**: Run `codex auth login` in a terminal first.\n",
            binary
        )
    } else {
        final_response
    };

    let message = AgentMessage {
        role: "assistant".to_string(),
        content,
        tool_calls: None,
        tool_call_id: None,
        attachments: None,
    };

    Ok((message, (0, 0), None))
}
