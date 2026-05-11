use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;

use aixlarity_core::agent::PermissionLevel;
use aixlarity_core::config::SandboxPolicy;
use aixlarity_core::providers::ProviderScope;
use aixlarity_core::trust::TrustRuleKind;
use aixlarity_core::{App, AppCommand, ExecOptions};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use colored::Colorize;

/// Aixlarity — Efficient Terminal AI Coding Agent
#[derive(Parser, Debug)]
#[command(name = "aixlarity", version, about, long_about = None)]
struct Cli {
    /// Return output in JSON format
    #[arg(long, global = true)]
    json: bool,

    /// Return output as JSON Lines
    #[arg(long, global = true)]
    jsonl: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Show general overview of workspace and settings
    Overview,

    /// Manage language model providers
    #[command(subcommand)]
    Providers(ProviderCommands),

    /// Reload custom workspace commands and skills
    #[command(name = "commands")]
    Catalog {
        #[command(subcommand)]
        cmd: CommandOps,
    },

    /// Manage workspace trust boundaries
    #[command(subcommand)]
    Trust(TrustCommands),

    /// List prompt checkpoints
    Checkpoints {
        #[command(subcommand)]
        cmd: CheckpointOps,
    },

    /// Manage execution sessions
    #[command(subcommand)]
    Sessions(SessionCommands),

    /// Execute a coding task with the selected provider
    Exec {
        /// Provider ID to use for execution
        #[arg(long)]
        provider: Option<String>,

        /// Sandbox strictness (off, read-only, workspace-write, container)
        #[arg(long)]
        sandbox: Option<String>,

        /// Specific skill to enforce
        #[arg(long)]
        skill: Option<String>,

        /// Create a checkpoint before executing
        #[arg(long)]
        checkpoint: bool,

        /// Resume from a specific session ID
        #[arg(long, conflicts_with = "fork")]
        resume: Option<String>,

        /// Fork from a specific session ID
        #[arg(long)]
        fork: Option<String>,

        /// Do not persist this session
        #[arg(long)]
        no_session: bool,

        /// Do not print the constructed prompt
        #[arg(long)]
        no_prompt: bool,

        /// Permission level: suggest, auto-edit, full-auto
        #[arg(long, default_value = "auto-edit")]
        permission: String,

        /// Disable streaming output
        #[arg(long)]
        no_stream: bool,

        /// Auto-commit changes to git after execution
        #[arg(long)]
        git: bool,

        /// Enable planning mode: plan before executing
        #[arg(long)]
        plan: bool,

        /// The task instruction to execute
        #[arg(required = true)]
        task: Vec<String>,
    },

    /// Start a JSON-RPC daemon on stdio for IDE integration
    Serve,
}

#[derive(Subcommand, Debug)]
enum ProviderCommands {
    /// List all registered and available providers
    List,
    /// View the currently active provider
    Current,
    /// Show details of a specific provider
    Show { id: String },
    /// Set the active provider
    Use {
        id: String,
        #[arg(long)]
        global: bool,
    },
    /// Run diagnostics on a provider API setup
    Doctor { id: Option<String> },
}

#[derive(Subcommand, Debug)]
enum CommandOps {
    /// Reload commands and skills configurations
    Reload,
}

#[derive(Subcommand, Debug)]
enum TrustCommands {
    /// View current trust status
    Status { path: Option<PathBuf> },
    /// Set a trust rule for a path
    Set { kind: String, path: Option<PathBuf> },
}

#[derive(Subcommand, Debug)]
enum CheckpointOps {
    /// List saved checkpoints
    List,
}

#[derive(Subcommand, Debug)]
enum SessionCommands {
    /// List historical sessions
    List,
    /// Details about a specific session
    Show { id: String },
    /// Replay structured events from a session
    Replay {
        id: String,
        #[arg(long)]
        turn: Option<usize>,
    },
    /// Fork a session into a new branch
    Fork { id: String },
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // If no subcommand, enter REPL mode
    if cli.command.is_none() {
        return run_repl(cli.json, cli.jsonl).await;
    }

    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let app = App::new(current_dir);
    if let Commands::Serve = cli.command.as_ref().unwrap() {
        return run_server_daemon(app).await;
    }
    let app_command = map_command(cli.command.unwrap());

    match app.handle(app_command).await {
        Ok(output) => {
            if cli.jsonl {
                println!("{}", output.render_jsonl());
            } else if cli.json {
                println!("{}", output.render_json());
            } else {
                println!("{}", output.render());
            }
        }
        Err(error) => {
            eprintln!("{}: {}", "error".red().bold(), error);
            process::exit(1);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Server Daemon — JSON-RPC over stdio
// ---------------------------------------------------------------------------

/// Pending IDE approval plus the agent request that owns it.
#[derive(Debug)]
struct PendingIdeApproval {
    request_id: String,
    sender: tokio::sync::oneshot::Sender<(bool, bool)>,
}

/// IDE-based approval handler that sends approval requests to the frontend
/// and waits for responses via an async oneshot channel.
/// Design pattern from Claude Code's permission system — every write/shell
/// operation is presented to the user for explicit approval.
#[derive(Debug)]
struct IdeApprovalHandler {
    /// Shared pending-approval map: call_id → approval owner + oneshot sender.
    pending:
        std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, PendingIdeApproval>>>,
    /// The agent_chat JSON-RPC id that owns this approval request.
    request_id: serde_json::Value,
    /// String form of request_id for ownership comparisons.
    request_key: String,
    /// Shared daemon stdout writer. Approval requests must use the same
    /// line-serialized channel as stream chunks and final results.
    stdout_tx: tokio::sync::mpsc::UnboundedSender<String>,
}

fn app_for_rpc_request(
    json: &serde_json::Value,
    fallback: &aixlarity_core::App,
) -> Result<aixlarity_core::App, String> {
    let Some(cwd) = json
        .get("params")
        .and_then(|p| p.get("cwd"))
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
    else {
        return Ok(fallback.clone());
    };

    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!("Invalid cwd: {}", cwd));
    }

    Ok(aixlarity_core::App::new(
        std::fs::canonicalize(&path).unwrap_or(path),
    ))
}

fn api_key_env_name(raw: &str) -> String {
    match raw {
        "openai" => "OPENAI_API_KEY".to_string(),
        "anthropic" => "ANTHROPIC_API_KEY".to_string(),
        "gemini" => "GEMINI_API_KEY".to_string(),
        other => other.to_string(),
    }
}

fn is_valid_api_key_env(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn parse_api_key_updates(
    params: &serde_json::Map<String, serde_json::Value>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    if params.is_empty() {
        return Err("No API keys provided".to_string());
    }

    let mut updates = std::collections::BTreeMap::new();
    let mut errors = Vec::new();
    for (raw_key, value) in params {
        let target_key = api_key_env_name(raw_key);
        if !is_valid_api_key_env(&target_key) {
            errors.push(format!("invalid API key env name: {}", raw_key));
            continue;
        }

        let Some(value) = value.as_str() else {
            errors.push(format!("{} must be a string", target_key));
            continue;
        };

        let value = value.trim();
        if value.is_empty() {
            errors.push(format!("{} must not be empty", target_key));
        } else if value.contains('\n') || value.contains('\r') {
            errors.push(format!("{} must be a single-line value", target_key));
        } else {
            updates.insert(target_key, value.to_string());
        }
    }

    if errors.is_empty() {
        Ok(updates)
    } else {
        Err(errors.join("; "))
    }
}

fn write_api_key_env_file(
    env_path: &std::path::Path,
    env_map: &std::collections::BTreeMap<String, String>,
) -> std::io::Result<()> {
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let new_content = env_map
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(env_path, new_content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(env_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl aixlarity_core::agent::ApprovalHandler for IdeApprovalHandler {
    async fn request_approval(&self, call: &aixlarity_core::agent::ToolCall) -> (bool, bool) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            pending.insert(
                call.id.clone(),
                PendingIdeApproval {
                    request_id: self.request_key.clone(),
                    sender: tx,
                },
            );
        }
        // Send approval request to IDE via stdout
        let msg = serde_json::json!({
            "id": self.request_id.clone(),
            "method": "approval_request",
            "params": {
                "call_id": call.id,
                "tool_name": call.name,
                "arguments": call.arguments,
            }
        });
        let mut line = serde_json::to_string(&msg).unwrap();
        line.push('\n');
        let _ = self.stdout_tx.send(line);

        // Wait for IDE response with 5-minute timeout
        match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                eprintln!("[Aixlarity DEBUG] Approval channel closed for {}", call.id);
                (false, false)
            }
            Err(_) => {
                eprintln!("[Aixlarity DEBUG] Approval timed out for {}", call.id);
                (false, false)
            }
        }
    }
}

async fn run_server_daemon(mut app: aixlarity_core::App) -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // Load persisted API keys on startup so users don't have to re-enter keys
    // after every IDE restart. The Aixlarity-owned path is preferred; the old
    // Antigravity-compatible path is read as a migration fallback.
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(home);
        let env_paths = [
            home.join(".aixlarity").join("keys.env"),
            home.join(".gemini/antigravity/.env"),
        ];
        for env_path in env_paths {
            if let Ok(content) = std::fs::read_to_string(&env_path) {
                for raw_line in content.lines() {
                    let raw_line = raw_line.trim();
                    if raw_line.is_empty() || raw_line.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = raw_line.split_once('=') {
                        let k = k.trim();
                        let v = v.trim();
                        if !k.is_empty() && !v.is_empty() {
                            // Only set if not already present in the environment
                            // (explicit shell exports take precedence)
                            if std::env::var(k).map_or(true, |existing| existing.is_empty()) {
                                std::env::set_var(k, v);
                            }
                        }
                    }
                }
                // Keep serve-mode startup quiet: the IDE treats daemon stderr as
                // errors, and secret file paths should not appear in production logs.
            }
        }
    }

    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut line = String::new();

    // ---------- Unified stdout writer ----------
    // All JSON-RPC output (streaming chunks, events, final results, ACKs)
    // MUST go through this single channel.  Previously, stream/event
    // callbacks used `println!` (std::io::Stdout) while the main loop
    // used `tokio::io::stdout()`.  Because piped stdout is fully-buffered,
    // the two separate buffers could interleave at the byte level,
    // corrupting JSON lines and preventing the IDE from parsing the
    // final result — which kept the UI stuck in "generating" state.
    let (stdout_tx, mut stdout_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdout_writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = stdout_rx.recv().await {
            let _ = out.write_all(line.as_bytes()).await;
            let _ = out.flush().await;
        }
    });

    // Shared approval pending map — routes approval responses to waiting agent tasks
    let pending_approvals: std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, PendingIdeApproval>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    // Active agent tasks keyed by the originating agent_chat JSON-RPC id.
    // This lets the IDE stop a running turn without killing the daemon.
    let active_agent_tasks: std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    // Channel for receiving agent_chat results from spawned tasks
    let (result_tx, mut result_rx) =
        tokio::sync::mpsc::channel::<(serde_json::Value, serde_json::Value)>(8);

    // Non-blocking loop: process stdin RPCs and agent task results
    loop {
        // Drain completed agent task results
        while let Ok((finished_id, response)) = result_rx.try_recv() {
            let finished_key = finished_id
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| finished_id.to_string());
            active_agent_tasks.lock().unwrap().remove(&finished_key);
            let mut out = serde_json::to_string(&response).unwrap_or_default();
            out.push('\n');
            let _ = stdout_tx.send(out);
        }

        line.clear();
        // Short timeout so we check for agent results frequently
        let read_result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            stdin.read_line(&mut line),
        )
        .await;

        match read_result {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => continue, // Timeout — loop back to drain results
        }

        let input = line.trim();
        if input.is_empty() {
            continue;
        }

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(input) {
            let id = json.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let method = json.get("method").and_then(|v| v.as_str()).unwrap_or("");

            // Handle approval responses immediately — route to waiting agents
            if method == "approval_response" {
                let call_id = json
                    .get("params")
                    .and_then(|p| p.get("call_id"))
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
                let decision = json
                    .get("params")
                    .and_then(|p| p.get("decision"))
                    .and_then(|p| p.as_str())
                    .unwrap_or("deny")
                    .to_string();
                let (allowed, upgrade) = match decision.as_str() {
                    "allow" => (true, false),
                    "always" => (true, true),
                    _ => (false, false),
                };
                let sender = {
                    let mut pending = pending_approvals.lock().unwrap();
                    pending.remove(&call_id)
                };
                if let Some(approval) = sender {
                    let _ = approval.sender.send((allowed, upgrade));
                    eprintln!(
                        "[Aixlarity DEBUG] Approval response for {}: allowed={} upgrade={}",
                        call_id, allowed, upgrade
                    );
                }
                let ack =
                    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"status": "ok"}});
                let mut out = serde_json::to_string(&ack)?;
                out.push('\n');
                let _ = stdout_tx.send(out);
                continue;
            }

            let request_app = if method == "set_workspace" || method == "agent_stop" {
                app.clone()
            } else {
                match app_for_rpc_request(&json, &app) {
                    Ok(request_app) => request_app,
                    Err(message) => {
                        let response = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32602,
                                "message": message,
                            }
                        });
                        let mut out = serde_json::to_string(&response)?;
                        out.push('\n');
                        let _ = stdout_tx.send(out);
                        continue;
                    }
                }
            };

            let response = match method {
                "ping" => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": "pong"}),
                "set_workspace" => {
                    // Allow the IDE to dynamically switch the daemon's working directory
                    // to match the workspace the user has opened.
                    if let Some(dir) = json
                        .get("params")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str())
                    {
                        let path = std::path::PathBuf::from(dir);
                        if path.is_dir() {
                            eprintln!("[Aixlarity DEBUG] Switching workspace to: {:?}", path);
                            app = aixlarity_core::App::new(path);
                            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"status": "ok", "message": format!("Workspace set to {}", dir)}})
                        } else {
                            serde_json::json!({"jsonrpc": "2.0", "id": id, "error": format!("Directory does not exist: {}", dir)})
                        }
                    } else {
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": "Missing params.path"})
                    }
                }
                "overview" => handle_rpc(&request_app, AppCommand::Overview, id).await,
                "providers/list" => handle_rpc(&request_app, AppCommand::ProvidersList, id).await,
                "providers/doctor" => {
                    let pid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string());
                    handle_rpc(&request_app, AppCommand::ProvidersDoctor { id: pid }, id).await
                }
                "providers/use" => {
                    let pid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let scope_str = json
                        .get("params")
                        .and_then(|p| p.get("scope"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("global");
                    let scope = aixlarity_core::providers::ProviderScope::parse(scope_str)
                        .unwrap_or(aixlarity_core::providers::ProviderScope::Global);
                    handle_rpc(
                        &request_app,
                        AppCommand::ProvidersUse { id: pid, scope },
                        id,
                    )
                    .await
                }
                "providers/remove" => {
                    let pid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let scope = json
                        .get("params")
                        .and_then(|p| p.get("scope"))
                        .and_then(|p| p.as_str())
                        .and_then(aixlarity_core::providers::ProviderScope::parse)
                        .unwrap_or(aixlarity_core::providers::ProviderScope::Global);
                    handle_rpc(
                        &request_app,
                        AppCommand::ProvidersRemove { id: pid, scope },
                        id,
                    )
                    .await
                }
                "providers/add" => {
                    if let Some(p) = json.get("params") {
                        let id_val = p
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let label = p
                            .get("label")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let family_raw =
                            p.get("family").and_then(|v| v.as_str()).unwrap_or("openai");
                        let family = aixlarity_core::providers::ProviderFamily::parse(family_raw)
                            .unwrap_or(aixlarity_core::providers::ProviderFamily::OpenAiCompatible);
                        let api_base = p
                            .get("api_base")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let model = p
                            .get("model")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let api_key_env = p
                            .get("api_key_env")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let scope = p
                            .get("scope")
                            .and_then(|v| v.as_str())
                            .and_then(aixlarity_core::providers::ProviderScope::parse)
                            .unwrap_or(aixlarity_core::providers::ProviderScope::Workspace);

                        let profile = aixlarity_core::providers::ProviderProfile {
                            id: id_val,
                            family,
                            protocol: family.default_protocol(),
                            label,
                            api_base,
                            api_key_env,
                            model,
                            best_for: "Custom provider via IDE".to_string(),
                            strengths: vec![],
                            supports_multimodal: family.default_multimodal(),
                            supports_grounding: family.default_grounding(),
                            source: aixlarity_core::providers::ProviderSource::WorkspaceConfig(
                                std::path::PathBuf::from(".aixlarity/providers.conf"),
                            ),
                        };
                        handle_rpc(
                            &request_app,
                            AppCommand::ProvidersAdd { profile, scope },
                            id,
                        )
                        .await
                    } else {
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "Invalid params for providers/add"}})
                    }
                }
                "providers/models" => {
                    let pid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::ProvidersModels { id: pid }, id).await
                }
                "providers/update" => {
                    if let Some(p) = json.get("params") {
                        let pid = p
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let model = p
                            .get("model")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        handle_rpc(
                            &request_app,
                            AppCommand::ProvidersUpdate { id: pid, model },
                            id,
                        )
                        .await
                    } else {
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "Invalid params for providers/update"}})
                    }
                }
                "system/set_keys" => {
                    if let Some(p) = json.get("params").and_then(|v| v.as_object()) {
                        match parse_api_key_updates(p) {
                            Ok(updates) => {
                                let home =
                                    std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                                let env_path = std::path::PathBuf::from(home)
                                    .join(".aixlarity")
                                    .join("keys.env");

                                let mut env_map = std::collections::BTreeMap::new();
                                if let Ok(content) = std::fs::read_to_string(&env_path) {
                                    for line in content.lines() {
                                        if let Some((k, v)) = line.split_once('=') {
                                            env_map
                                                .insert(k.trim().to_string(), v.trim().to_string());
                                        }
                                    }
                                }

                                for (target_key, value) in &updates {
                                    std::env::set_var(target_key, value);
                                    env_map.insert(target_key.clone(), value.clone());
                                }

                                if let Err(error) = write_api_key_env_file(&env_path, &env_map) {
                                    serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "error": {
                                            "code": -32000,
                                            "message": format!("Failed to save API keys: {}", error),
                                        }
                                    })
                                } else {
                                    serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "status": "success",
                                            "message": "Keys updated",
                                            "updated": updates.keys().cloned().collect::<Vec<_>>(),
                                        }
                                    })
                                }
                            }
                            Err(message) => serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {
                                    "code": -32602,
                                    "message": message,
                                }
                            }),
                        }
                    } else {
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32602,
                                "message": "Invalid params for system/set_keys",
                            }
                        })
                    }
                }
                "sessions/list" => handle_rpc(&request_app, AppCommand::SessionsList, id).await,
                "sessions/show" => {
                    let sid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::SessionsShow { id: sid }, id).await
                }
                "sessions/turns" => {
                    let sid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::SessionsTurns { id: sid }, id).await
                }
                "sessions/remove" => {
                    let sid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::SessionsRemove { id: sid }, id).await
                }
                "sessions/fork" => {
                    let sid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::SessionsFork { id: sid }, id).await
                }
                "sessions/replay" => {
                    let sid = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let turn = json
                        .get("params")
                        .and_then(|p| p.get("turn"))
                        .and_then(|p| p.as_u64())
                        .map(|u| u as usize);
                    handle_rpc(
                        &request_app,
                        AppCommand::SessionsReplay { id: sid, turn },
                        id,
                    )
                    .await
                }
                "checkpoints/list" => {
                    handle_rpc(&request_app, AppCommand::CheckpointsList, id).await
                }
                "commands/list" => handle_rpc(&request_app, AppCommand::CommandsList, id).await,
                "commands/reload" => handle_rpc(&request_app, AppCommand::CommandsReload, id).await,
                "external-cli/detect" => {
                    handle_rpc(&request_app, AppCommand::ExternalCliDetect, id).await
                }
                "external-cli/read" => {
                    let cli = json
                        .get("params")
                        .and_then(|p| p.get("cli"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let scope = json
                        .get("params")
                        .and_then(|p| p.get("scope"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::ExternalCliRead { cli, scope }, id).await
                }
                "external-cli/write" => {
                    let cli = json
                        .get("params")
                        .and_then(|p| p.get("cli"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let scope = json
                        .get("params")
                        .and_then(|p| p.get("scope"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let content = json
                        .get("params")
                        .and_then(|p| p.get("content"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(
                        &request_app,
                        AppCommand::ExternalCliWrite {
                            cli,
                            scope,
                            content,
                        },
                        id,
                    )
                    .await
                }
                "external-cli/write-instruction" => {
                    let cli = json
                        .get("params")
                        .and_then(|p| p.get("cli"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let content = json
                        .get("params")
                        .and_then(|p| p.get("content"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(
                        &request_app,
                        AppCommand::ExternalCliWriteInstruction { cli, content },
                        id,
                    )
                    .await
                }
                "trust/status" => {
                    let p_str = json
                        .get("params")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str());
                    let path = p_str.map(std::path::PathBuf::from);
                    handle_rpc(&request_app, AppCommand::TrustStatus { path }, id).await
                }
                "trust/set" => {
                    let path = json
                        .get("params")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str())
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| std::path::PathBuf::from("."));
                    let kind = json
                        .get("params")
                        .and_then(|p| p.get("kind"))
                        .and_then(|p| p.as_str())
                        .and_then(aixlarity_core::trust::TrustRuleKind::parse);
                    if let Some(kind) = kind {
                        handle_rpc(&request_app, AppCommand::TrustSet { path, kind }, id).await
                    } else {
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "Invalid trust kind"}})
                    }
                }
                "history/list" => {
                    let limit = json
                        .get("params")
                        .and_then(|p| p.get("limit"))
                        .and_then(|p| p.as_u64())
                        .map(|u| u as usize)
                        .unwrap_or(20);
                    handle_rpc(&request_app, AppCommand::HistoryList { limit }, id).await
                }
                "history/revert" => {
                    let tx_id = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::HistoryRevert { id: tx_id }, id).await
                }
                "history/track" => {
                    let path = json
                        .get("params")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let source = json
                        .get("params")
                        .and_then(|p| p.get("source"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::HistoryTrack { path, source }, id).await
                }
                "history/get_blob" => {
                    let hash = json
                        .get("params")
                        .and_then(|p| p.get("hash"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::HistoryGetBlob { hash }, id).await
                }
                "history/file_revisions" => {
                    let path = json
                        .get("params")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    handle_rpc(&request_app, AppCommand::HistoryFileRevisions { path }, id).await
                }
                "mission_control/load" => {
                    let workspace_root = request_app.current_dir();
                    match aixlarity_core::mission_control::load_state(workspace_root) {
                        Ok(state) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "schema": "aixlarity.mission_control_store.v1",
                                "state": state,
                                "path": aixlarity_core::mission_control::state_path(workspace_root).display().to_string(),
                                "artifacts_dir": aixlarity_core::mission_control::artifacts_dir(workspace_root).display().to_string(),
                            }
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to load Mission Control state: {}", error),
                            }
                        }),
                    }
                }
                "mission_control/save" => {
                    let workspace_root = request_app.current_dir();
                    let raw_state = json
                        .get("params")
                        .and_then(|p| p.get("state"))
                        .cloned()
                        .unwrap_or_else(|| {
                            json.get("params")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        });
                    match aixlarity_core::mission_control::save_state(workspace_root, &raw_state) {
                        Ok(summary) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": summary.to_json(),
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to save Mission Control state: {}", error),
                            }
                        }),
                    }
                }
                "artifacts/export" | "mission_control/export_evidence" => {
                    let workspace_root = request_app.current_dir();
                    let bundle = json.get("params").and_then(|p| p.get("bundle"));
                    match aixlarity_core::mission_control::export_evidence_bundle(
                        workspace_root,
                        bundle,
                    ) {
                        Ok(exported) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": exported,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to export artifact evidence: {}", error),
                            }
                        }),
                    }
                }
                "artifacts/list" => {
                    let workspace_root = request_app.current_dir();
                    match aixlarity_core::mission_control::list_artifacts(workspace_root) {
                        Ok(listed) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": listed,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to list artifacts: {}", error),
                            }
                        }),
                    }
                }
                "artifacts/review" => {
                    let workspace_root = request_app.current_dir();
                    let artifact_id = json
                        .get("params")
                        .and_then(|p| p.get("artifact_id").or_else(|| p.get("id")))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let status = json
                        .get("params")
                        .and_then(|p| p.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let comment = json
                        .get("params")
                        .and_then(|p| p.get("comment"))
                        .and_then(|v| v.as_str());
                    match aixlarity_core::mission_control::review_artifact(
                        workspace_root,
                        artifact_id,
                        status,
                        comment,
                    ) {
                        Ok(reviewed) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": reviewed,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to review artifact: {}", error),
                            }
                        }),
                    }
                }
                "artifacts/review_thread" => {
                    let workspace_root = request_app.current_dir();
                    let params = json.get("params").cloned().unwrap_or_default();
                    let artifact_id = params
                        .get("artifact_id")
                        .or_else(|| params.get("artifactId"))
                        .or_else(|| params.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let thread_id = params
                        .get("thread_id")
                        .or_else(|| params.get("threadId"))
                        .and_then(|v| v.as_str());
                    let status = params.get("status").and_then(|v| v.as_str());
                    let anchor = params.get("anchor");
                    let comment = params.get("comment").and_then(|v| v.as_str());
                    match aixlarity_core::mission_control::review_artifact_thread(
                        workspace_root,
                        artifact_id,
                        thread_id,
                        status,
                        anchor,
                        comment,
                    ) {
                        Ok(reviewed) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": reviewed,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to update artifact review thread: {}", error),
                            }
                        }),
                    }
                }
                "mission_control/workspaces" => {
                    let workspace_root = request_app.current_dir();
                    match aixlarity_core::mission_control::list_workspace_index(workspace_root) {
                        Ok(listed) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": listed,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to list Mission Control workspaces: {}", error),
                            }
                        }),
                    }
                }
                "studio/load" => {
                    let workspace_root = request_app.current_dir();
                    match aixlarity_core::mission_control::load_studio_state(workspace_root) {
                        Ok(state) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": state,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to load IDE studio state: {}", error),
                            }
                        }),
                    }
                }
                "studio/save" => {
                    let workspace_root = request_app.current_dir();
                    let state = json
                        .get("params")
                        .and_then(|p| p.get("state"))
                        .cloned()
                        .unwrap_or_else(|| json.get("params").cloned().unwrap_or_default());
                    match aixlarity_core::mission_control::save_studio_state(workspace_root, &state)
                    {
                        Ok(saved) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": saved,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to save IDE studio state: {}", error),
                            }
                        }),
                    }
                }
                "audit/list" => {
                    let workspace_root = request_app.current_dir();
                    let limit = json
                        .get("params")
                        .and_then(|p| p.get("limit"))
                        .and_then(|v| v.as_u64())
                        .map(|value| value as usize);
                    match aixlarity_core::mission_control::list_audit_events(workspace_root, limit)
                    {
                        Ok(listed) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": listed,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to list audit log: {}", error),
                            }
                        }),
                    }
                }
                "audit/record" => {
                    let workspace_root = request_app.current_dir();
                    let event = json
                        .get("params")
                        .and_then(|p| p.get("event"))
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    match aixlarity_core::mission_control::record_audit_event(
                        workspace_root,
                        &event,
                    ) {
                        Ok(recorded) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": recorded,
                        }),
                        Err(error) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("Failed to record audit event: {}", error),
                            }
                        }),
                    }
                }
                "agent_stop" => {
                    let target_id = json
                        .get("params")
                        .and_then(|p| p.get("id"))
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string());

                    let stopped = if let Some(target_id) = target_id.as_deref() {
                        let task = active_agent_tasks.lock().unwrap().remove(target_id);
                        if let Some(task) = task {
                            task.abort();
                            pending_approvals
                                .lock()
                                .unwrap()
                                .retain(|_, approval| approval.request_id != target_id);
                            1usize
                        } else {
                            0usize
                        }
                    } else {
                        let mut tasks = active_agent_tasks.lock().unwrap();
                        let stopped = tasks.len();
                        for (_, task) in tasks.drain() {
                            task.abort();
                        }
                        stopped
                    };

                    if target_id.is_none() && stopped > 0 {
                        pending_approvals.lock().unwrap().clear();
                    }

                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "status": "stopped",
                            "stopped": stopped,
                        }
                    })
                }
                "agent_chat" => {
                    let prompt = json
                        .get("params")
                        .and_then(|p| p.get("prompt"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let plan_only = json
                        .get("params")
                        .and_then(|p| p.get("plan_only"))
                        .and_then(|p| p.as_bool())
                        .unwrap_or(false);
                    let ide_context = json
                        .get("params")
                        .and_then(|p| p.get("ide_context"))
                        .and_then(|c| {
                            serde_json::from_value::<aixlarity_core::agent::IdeContext>(c.clone())
                                .ok()
                        });
                    let persona = json
                        .get("params")
                        .and_then(|p| p.get("persona"))
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string());
                    let session_id = json
                        .get("params")
                        .and_then(|p| p.get("session_id"))
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string());

                    // IDE-configurable harness options — previously hardcoded, now
                    // exposed through the frontend toolbar so every CLI exec flag
                    // is available in the IDE as well.
                    let sandbox = json
                        .get("params")
                        .and_then(|p| p.get("sandbox"))
                        .and_then(|p| p.as_str())
                        .and_then(aixlarity_core::config::SandboxPolicy::parse);
                    let permission = json
                        .get("params")
                        .and_then(|p| p.get("permission"))
                        .and_then(|p| p.as_str())
                        .and_then(aixlarity_core::agent::PermissionLevel::parse)
                        .unwrap_or(aixlarity_core::agent::PermissionLevel::Suggest);
                    let skill = json
                        .get("params")
                        .and_then(|p| p.get("skill"))
                        .and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let provider_override = json
                        .get("params")
                        .and_then(|p| p.get("provider"))
                        .and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let checkpoint = json
                        .get("params")
                        .and_then(|p| p.get("checkpoint"))
                        .and_then(|p| p.as_bool())
                        .unwrap_or(false);
                    let auto_git = json
                        .get("params")
                        .and_then(|p| p.get("auto_git"))
                        .and_then(|p| p.as_bool())
                        .unwrap_or(false);

                    let attachments: Option<Vec<aixlarity_core::agent::AgentAttachment>> = json
                        .get("params")
                        .and_then(|p| p.get("attachments"))
                        .and_then(|a| serde_json::from_value(a.clone()).ok());

                    // Build the IDE approval handler for permission prompts
                    let approval_handler = std::sync::Arc::new(IdeApprovalHandler {
                        pending: pending_approvals.clone(),
                        request_id: id.clone(),
                        request_key: id
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| id.to_string()),
                        stdout_tx: stdout_tx.clone(),
                    });

                    let opts = aixlarity_core::app::ExecOptions {
                        input: prompt,
                        skill,
                        persona,
                        provider: provider_override,
                        sandbox,
                        checkpoint,
                        persist_session: true,
                        resume_session: session_id,
                        fork_session: None,
                        print_prompt: false,
                        permission,
                        stream: true,
                        auto_git,
                        plan_only,
                        ide_context,
                        attachments,
                        stream_handler: Some(aixlarity_core::agent::StreamCallback({
                            let tx = stdout_tx.clone();
                            let req_id = id.clone();
                            std::sync::Arc::new(move |chunk| {
                                let msg = serde_json::json!({
                                    "id": req_id,
                                    "method": "agent_chat_stream",
                                    "params": { "chunk": chunk }
                                });
                                let mut s = serde_json::to_string(&msg).unwrap();
                                s.push('\n');
                                let _ = tx.send(s);
                            })
                        })),
                        event_handler: Some(aixlarity_core::agent::EventCallback({
                            let tx = stdout_tx.clone();
                            let req_id = id.clone();
                            std::sync::Arc::new(move |ev| {
                                // Serialize the event to a mutable JSON Value so we can
                                // strip large binary attachments before sending over the
                                // line-based IPC protocol.  A 465 KB single-line JSON
                                // message routinely corrupts the Electron renderer's
                                // line-buffer, causing the entire UI to hang.
                                let mut ev_value =
                                    serde_json::to_value(&ev).unwrap_or(serde_json::Value::Null);

                                // Extract attachments from ToolCallCompleted events and
                                // write them to temp files.  The frontend will read the
                                // files instead of parsing inline base64.
                                if let Some(obj) = ev_value.as_object_mut() {
                                    if obj.get("event").and_then(|v| v.as_str())
                                        == Some("tool_call_completed")
                                    {
                                        if let Some(attachments) = obj.get("attachments").cloned() {
                                            if let Some(arr) = attachments.as_array() {
                                                let mut file_refs = Vec::new();
                                                for att in arr {
                                                    let mime = att
                                                        .get("mime_type")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("application/octet-stream");
                                                    let ext = if mime.contains("png") {
                                                        "png"
                                                    } else if mime.contains("jpeg")
                                                        || mime.contains("jpg")
                                                    {
                                                        "jpg"
                                                    } else {
                                                        "bin"
                                                    };
                                                    if let Some(b64) = att
                                                        .get("data_base64")
                                                        .and_then(|v| v.as_str())
                                                    {
                                                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                                                            let path = format!("/tmp/aix_att_{}.{}", uuid::Uuid::new_v4(), ext);
                                                            if std::fs::write(&path, &bytes).is_ok() {
                                                                file_refs.push(serde_json::json!({
                                                                    "mime_type": mime,
                                                                    "file_path": path
                                                                }));
                                                                continue;
                                                            }
                                                        }
                                                    }
                                                    // Fallback: keep original (should not happen normally)
                                                    file_refs.push(att.clone());
                                                }
                                                obj.insert(
                                                    "attachments".to_string(),
                                                    serde_json::json!(file_refs),
                                                );
                                            }
                                        }
                                    }
                                }

                                let msg = serde_json::json!({
                                    "id": req_id,
                                    "method": "agent_action",
                                    "params": { "event": ev_value }
                                });
                                let mut s = serde_json::to_string(&msg).unwrap();
                                s.push('\n');
                                let _ = tx.send(s);
                            })
                        })),
                        approval_handler: Some(approval_handler),
                    };

                    // Spawn agent as a background task so the stdin loop stays free
                    // to process approval_response RPCs while the agent is waiting.
                    let app_clone = request_app.clone();
                    let result_sender = result_tx.clone();
                    let rpc_id = id.clone();
                    let rpc_key = rpc_id
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| rpc_id.to_string());
                    let handle = tokio::spawn(async move {
                        let response = handle_rpc(
                            &app_clone,
                            aixlarity_core::app::AppCommand::Exec(opts),
                            rpc_id.clone(),
                        )
                        .await;
                        let _ = result_sender.send((rpc_id, response)).await;
                    });
                    active_agent_tasks.lock().unwrap().insert(rpc_key, handle);

                    // Send an immediate ACK so the IDE knows the request was accepted
                    let ack = serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"status": "accepted"}});
                    let mut out = serde_json::to_string(&ack)?;
                    out.push('\n');
                    let _ = stdout_tx.send(out);
                    continue; // Don't send a second response below
                }
                _ => serde_json::json!({"jsonrpc": "2.0", "id": id, "error": "method not found"}),
            };

            let mut out = serde_json::to_string(&response)?;
            out.push('\n');
            let _ = stdout_tx.send(out);
        }
    }

    let aborted_tasks = {
        let mut tasks = active_agent_tasks.lock().unwrap();
        tasks.drain().map(|(_, task)| task).collect::<Vec<_>>()
    };
    for task in aborted_tasks {
        task.abort();
        let _ = task.await;
    }
    pending_approvals.lock().unwrap().clear();
    drop(stdout_tx);
    let _ = stdout_writer.await;

    Ok(())
}

async fn handle_rpc(
    app: &aixlarity_core::App,
    cmd: AppCommand,
    id: serde_json::Value,
) -> serde_json::Value {
    match app.handle(cmd).await {
        Ok(out) => {
            let val: serde_json::Value =
                serde_json::from_str(&out.render_json()).unwrap_or(serde_json::Value::Null);
            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": val})
        }
        Err(e) => serde_json::json!({"jsonrpc": "2.0", "id": id, "error": e.to_string()}),
    }
}

// ---------------------------------------------------------------------------
// REPL — Interactive mode with rustyline
// ---------------------------------------------------------------------------

async fn run_repl(json: bool, jsonl: bool) -> anyhow::Result<()> {
    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let app = App::new(current_dir.clone());

    // Print welcome banner
    println!(
        "{}",
        "╔══════════════════════════════════════════════╗".cyan()
    );
    println!("{}", "║       Aixlarity Interactive Mode      ║".cyan());
    println!(
        "{}",
        "║    Type your task, or /help for commands       ║".cyan()
    );
    println!(
        "{}",
        "╚══════════════════════════════════════════════╝".cyan()
    );
    println!();

    // Show overview on start
    match app.handle(AppCommand::Overview).await {
        Ok(output) => println!("{}", output.render()),
        Err(e) => eprintln!("{}: {}", "warning".yellow(), e),
    }
    println!();

    // Setup rustyline
    let history_path = dirs_home().join(".aixlarity").join("history.txt");
    let mut rl = match rustyline::DefaultEditor::new() {
        Ok(editor) => editor,
        Err(_) => {
            eprintln!(
                "{}: rustyline init failed, falling back to basic input",
                "warning".yellow()
            );
            return run_repl_basic(json, jsonl).await;
        }
    };

    // Load history
    if history_path.exists() {
        let _ = rl.load_history(&history_path);
    }

    loop {
        let readline = rl.readline(&format!("{} ", "aixlarity>".green().bold()));

        match readline {
            Ok(line) => {
                let input = line.trim();
                if input.is_empty() {
                    continue;
                }

                let _ = rl.add_history_entry(input);

                match input {
                    "/quit" | "/exit" | "/q" => {
                        println!("{}", "Goodbye!".dimmed());
                        break;
                    }
                    "/help" | "/h" => {
                        print_repl_help();
                        continue;
                    }
                    "/clear" => {
                        print!("\x1B[2J\x1B[H");
                        let _ = io::stdout().flush();
                        continue;
                    }
                    "/providers" => {
                        handle_repl_command(&app, AppCommand::ProvidersList, json, jsonl).await;
                        continue;
                    }
                    "/trust" => {
                        handle_repl_command(
                            &app,
                            AppCommand::TrustStatus { path: None },
                            json,
                            jsonl,
                        )
                        .await;
                        continue;
                    }
                    "/sessions" => {
                        handle_repl_command(&app, AppCommand::SessionsList, json, jsonl).await;
                        continue;
                    }
                    "/overview" => {
                        handle_repl_command(&app, AppCommand::Overview, json, jsonl).await;
                        continue;
                    }
                    _ => {}
                }

                // Treat everything else as an exec task
                let exec_options = ExecOptions {
                    input: input.to_string(),
                    skill: None,
                    persona: None,
                    attachments: None,
                    provider: None,
                    sandbox: None,
                    checkpoint: false,
                    persist_session: true,
                    resume_session: None,
                    fork_session: None,
                    print_prompt: true,
                    permission: PermissionLevel::AutoEdit,
                    stream: true,
                    auto_git: false,
                    plan_only: false,
                    ide_context: None,
                    event_handler: None,
                    stream_handler: None,
                    approval_handler: None,
                };

                handle_repl_command(&app, AppCommand::Exec(exec_options), json, jsonl).await;
                println!();
            }
            Err(rustyline::error::ReadlineError::Interrupted) => {
                println!("{}", "\nInterrupted. Type /quit to exit.".dimmed());
                continue;
            }
            Err(rustyline::error::ReadlineError::Eof) => {
                println!("{}", "\nGoodbye!".dimmed());
                break;
            }
            Err(err) => {
                eprintln!("{}: {:?}", "readline error".red(), err);
                break;
            }
        }
    }

    // Save history
    if let Some(parent) = history_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = rl.save_history(&history_path);

    Ok(())
}

/// Fallback REPL without rustyline (basic stdin)
async fn run_repl_basic(json: bool, jsonl: bool) -> anyhow::Result<()> {
    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let app = App::new(current_dir);

    let stdin = io::stdin();
    let mut line = String::new();

    loop {
        print!("{} ", "aixlarity>".green().bold());
        io::stdout().flush()?;
        line.clear();

        if io::BufRead::read_line(&mut stdin.lock(), &mut line)? == 0 {
            println!("\nGoodbye!");
            break;
        }

        let input = line.trim();
        if input.is_empty() {
            continue;
        }

        match input {
            "/quit" | "/exit" | "/q" => {
                println!("Goodbye!");
                break;
            }
            "/help" | "/h" => {
                print_repl_help();
                continue;
            }
            _ => {}
        }

        let exec_options = ExecOptions {
            input: input.to_string(),
            skill: None,
            persona: None,
            attachments: None,
            provider: None,
            sandbox: None,
            checkpoint: false,
            persist_session: true,
            resume_session: None,
            fork_session: None,
            print_prompt: true,
            permission: PermissionLevel::AutoEdit,
            stream: true,
            auto_git: false,
            plan_only: false,
            ide_context: None,
            event_handler: None,
            stream_handler: None,
            approval_handler: None,
        };

        handle_repl_command(&app, AppCommand::Exec(exec_options), json, jsonl).await;
        println!();
    }

    Ok(())
}

fn print_repl_help() {
    println!("{}", "Available commands:".bold());
    println!("  {}       — Show this help", "/help, /h".cyan());
    println!("  {}  — Exit the REPL", "/quit, /exit".cyan());
    println!("  {}        — Clear the screen", "/clear".cyan());
    println!("  {}     — Show workspace overview", "/overview".cyan());
    println!("  {}   — List available providers", "/providers".cyan());
    println!("  {}        — Show trust status", "/trust".cyan());
    println!("  {}     — List saved sessions", "/sessions".cyan());
    println!();
    println!("Anything else is treated as a coding task for the agent.");
    println!();
    println!("{}", "Exec flags (use with `aixlarity exec`):".bold());
    println!(
        "  {} — Permission: suggest | auto-edit | full-auto",
        "--permission".cyan()
    );
    println!("  {}  — Disable streaming output", "--no-stream".cyan());
    println!("  {}         — Auto-commit changes to git", "--git".cyan());
    println!("  {}        — Enable planning mode", "--plan".cyan());
}

async fn handle_repl_command(app: &App, command: AppCommand, json: bool, jsonl: bool) {
    match app.handle(command).await {
        Ok(output) => {
            if jsonl {
                println!("{}", output.render_jsonl());
            } else if json {
                println!("{}", output.render_json());
            } else {
                println!("{}", output.render());
            }
        }
        Err(e) => eprintln!("{}: {}", "error".red(), e),
    }
}

/// Get home directory
fn dirs_home() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

// ---------------------------------------------------------------------------
// Command mapping
// ---------------------------------------------------------------------------

fn map_command(cmd: Commands) -> AppCommand {
    match cmd {
        Commands::Overview => AppCommand::Overview,

        Commands::Providers(sub) => match sub {
            ProviderCommands::List => AppCommand::ProvidersList,
            ProviderCommands::Current => AppCommand::ProvidersCurrent,
            ProviderCommands::Show { id } => AppCommand::ProvidersShow { id },
            ProviderCommands::Use { id, global } => AppCommand::ProvidersUse {
                id,
                scope: if global {
                    ProviderScope::Global
                } else {
                    ProviderScope::Workspace
                },
            },
            ProviderCommands::Doctor { id } => AppCommand::ProvidersDoctor { id },
        },

        Commands::Catalog { cmd } => match cmd {
            CommandOps::Reload => AppCommand::CommandsReload,
        },

        Commands::Trust(sub) => match sub {
            TrustCommands::Status { path } => AppCommand::TrustStatus { path },
            TrustCommands::Set { kind, path } => {
                let rule_kind = TrustRuleKind::parse(&kind).unwrap_or_else(|| {
                    eprintln!("Invalid trust kind. Allowed: trust, untrusted, parent.");
                    process::exit(1);
                });
                let p = path
                    .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
                AppCommand::TrustSet {
                    path: p,
                    kind: rule_kind,
                }
            }
        },

        Commands::Checkpoints { cmd } => match cmd {
            CheckpointOps::List => AppCommand::CheckpointsList,
        },

        Commands::Sessions(sub) => match sub {
            SessionCommands::List => AppCommand::SessionsList,
            SessionCommands::Show { id } => AppCommand::SessionsShow { id },
            SessionCommands::Replay { id, turn } => AppCommand::SessionsReplay { id, turn },
            SessionCommands::Fork { id } => AppCommand::SessionsFork { id },
        },

        Commands::Exec {
            provider,
            sandbox,
            skill,
            checkpoint,
            resume,
            fork,
            no_session,
            no_prompt,
            permission,
            no_stream,
            git,
            plan,
            task,
        } => {
            let permission_level = PermissionLevel::parse(&permission).unwrap_or_else(|| {
                eprintln!("Invalid permission level. Allowed: suggest, auto-edit, full-auto.");
                process::exit(1);
            });
            AppCommand::Exec(ExecOptions {
                input: task.join(" "),
                skill,
                persona: None,
                attachments: None,
                provider,
                sandbox: sandbox.as_deref().and_then(SandboxPolicy::parse),
                checkpoint,
                persist_session: !no_session,
                resume_session: resume,
                fork_session: fork,
                print_prompt: !no_prompt,
                permission: permission_level,
                stream: !no_stream,
                auto_git: git,
                plan_only: plan,
                ide_context: None,
                event_handler: None,
                stream_handler: None,
                approval_handler: None,
            })
        }
        Commands::Serve => unreachable!("Serve command handled in main"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        app_for_rpc_request, map_command, parse_api_key_updates, Commands, SessionCommands,
    };
    use aixlarity_core::agent::PermissionLevel;
    use aixlarity_core::{App, AppCommand, ExecOptions};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-cli-{}-{}", label, stamp))
    }

    #[test]
    fn exec_flags_are_wired_into_exec_options() {
        let command = Commands::Exec {
            provider: Some("gemini-official".to_string()),
            sandbox: Some("read-only".to_string()),
            skill: Some("code-review".to_string()),
            checkpoint: true,
            resume: Some("session-1".to_string()),
            fork: None,
            no_session: true,
            no_prompt: true,
            permission: "full-auto".to_string(),
            no_stream: true,
            git: true,
            plan: true,
            task: vec!["review".to_string(), "src/main.rs".to_string()],
        };

        let AppCommand::Exec(ExecOptions {
            input,
            skill,
            provider,
            checkpoint,
            persist_session,
            resume_session,
            print_prompt,
            permission,
            stream,
            auto_git,
            plan_only,
            ..
        }) = map_command(command)
        else {
            panic!("expected exec command");
        };

        assert_eq!(input, "review src/main.rs");
        assert_eq!(skill.as_deref(), Some("code-review"));
        assert_eq!(provider.as_deref(), Some("gemini-official"));
        assert!(checkpoint);
        assert!(!persist_session);
        assert_eq!(resume_session.as_deref(), Some("session-1"));
        assert!(!print_prompt);
        assert_eq!(permission, PermissionLevel::FullAuto);
        assert!(!stream);
        assert!(auto_git);
        assert!(plan_only);
    }

    #[test]
    fn session_replay_maps_turn_filter() {
        let command = Commands::Sessions(SessionCommands::Replay {
            id: "session-42".to_string(),
            turn: Some(3),
        });

        let AppCommand::SessionsReplay { id, turn } = map_command(command) else {
            panic!("expected session replay command");
        };

        assert_eq!(id, "session-42");
        assert_eq!(turn, Some(3));
    }

    #[test]
    fn rpc_request_app_accepts_valid_cwd() {
        let root = unique_dir("rpc-cwd");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let fallback = App::new(root.clone());
        let request = serde_json::json!({
            "params": {
                "cwd": workspace.to_string_lossy(),
            }
        });

        assert!(app_for_rpc_request(&request, &fallback).is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rpc_request_app_rejects_invalid_cwd() {
        let root = unique_dir("rpc-cwd-invalid");
        fs::create_dir_all(&root).unwrap();
        let fallback = App::new(root.clone());
        let missing = root.join("missing");
        let request = serde_json::json!({
            "params": {
                "cwd": missing.to_string_lossy(),
            }
        });

        let err = match app_for_rpc_request(&request, &fallback) {
            Ok(_) => panic!("expected invalid cwd to fail"),
            Err(err) => err,
        };

        assert!(err.contains("Invalid cwd"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn api_key_updates_accept_aliases_and_env_names() {
        let params = serde_json::json!({
            "openai": " sk-openai ",
            "CUSTOM_API_KEY": "custom",
        });
        let updates = parse_api_key_updates(params.as_object().unwrap()).unwrap();

        assert_eq!(
            updates.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-openai")
        );
        assert_eq!(
            updates.get("CUSTOM_API_KEY").map(String::as_str),
            Some("custom")
        );
    }

    #[test]
    fn api_key_updates_reject_invalid_input() {
        let params = serde_json::json!({
            "bad-key": "secret",
            "OPENAI_API_KEY": "line1\nline2",
            "GEMINI_API_KEY": "",
        });

        let err = parse_api_key_updates(params.as_object().unwrap()).unwrap_err();

        assert!(err.contains("invalid API key env name"));
        assert!(err.contains("single-line"));
        assert!(err.contains("must not be empty"));
    }
}
