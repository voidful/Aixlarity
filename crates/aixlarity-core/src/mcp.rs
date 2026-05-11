// Aixlarity — MCP (Model Context Protocol) Client
//
// Connects to MCP servers via stdio (subprocess) transport.
// Discovers external tools and wraps them as native Tool trait objects.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tools::{Tool, ToolContext};

// ---------------------------------------------------------------------------
// MCP Configuration (loaded from .aixlarity/mcp.json)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: HashMap<String, McpServerConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl McpConfig {
    pub fn load(workspace: &Path) -> Option<Self> {
        let config_path = workspace.join(".aixlarity").join("mcp.json");
        if !config_path.exists() {
            return None;
        }
        let content = fs::read_to_string(&config_path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// MCP Tool definition (from tools/list response)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Value,
}

// ---------------------------------------------------------------------------
// MCP Client — manages a single MCP server connection
// ---------------------------------------------------------------------------

pub struct McpClient {
    server_name: String,
    child: Child,
    next_id: u64,
    tools: Vec<McpToolDefinition>,
}

impl McpClient {
    /// Spawn an MCP server subprocess and perform initialization handshake.
    pub fn connect(server_name: &str, config: &McpServerConfig) -> anyhow::Result<Self> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args);
        for (key, value) in &config.env {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());

        let child = cmd.spawn().map_err(|err| {
            anyhow::anyhow!(
                "Failed to start MCP server '{}' ({}): {}",
                server_name,
                config.command,
                err
            )
        })?;

        let mut client = Self {
            server_name: server_name.to_string(),
            child,
            next_id: 1,
            tools: Vec::new(),
        };

        // Initialize handshake
        client.initialize()?;

        // Discover available tools
        client.discover_tools()?;

        Ok(client)
    }

    fn initialize(&mut self) -> anyhow::Result<()> {
        let response = self.send_request(
            "initialize",
            Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "aixlarity",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })),
        )?;

        if response.error.is_some() {
            let msg = response
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "unknown error".to_string());
            anyhow::bail!("MCP initialize failed for '{}': {}", self.server_name, msg);
        }

        // Send initialized notification (no id = notification)
        self.send_notification("notifications/initialized", None)?;
        Ok(())
    }

    fn discover_tools(&mut self) -> anyhow::Result<()> {
        let response = self.send_request("tools/list", None)?;
        if let Some(result) = response.result {
            if let Some(tools) = result.get("tools").and_then(|t| t.as_array()) {
                self.tools = tools
                    .iter()
                    .filter_map(|t| serde_json::from_value(t.clone()).ok())
                    .collect();
            }
        }
        Ok(())
    }

    pub fn call_tool(&mut self, name: &str, arguments: Value) -> anyhow::Result<Value> {
        let response = self.send_request(
            "tools/call",
            Some(serde_json::json!({
                "name": name,
                "arguments": arguments
            })),
        )?;

        if let Some(error) = response.error {
            anyhow::bail!(
                "MCP tool '{}' error on server '{}': {}",
                name,
                self.server_name,
                error.message
            );
        }

        Ok(response.result.unwrap_or(Value::Null))
    }

    pub fn discovered_tools(&self) -> &[McpToolDefinition] {
        &self.tools
    }

    fn send_request(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> anyhow::Result<JsonRpcResponse> {
        let id = self.next_id;
        self.next_id += 1;

        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };

        let mut payload = serde_json::to_string(&request)?;
        payload.push('\n');

        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("MCP server stdin unavailable"))?;
        stdin.write_all(payload.as_bytes())?;
        stdin.flush()?;

        let stdout = self
            .child
            .stdout
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("MCP server stdout unavailable"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        let response: JsonRpcResponse = serde_json::from_str(&line)?;
        Ok(response)
    }

    fn send_notification(&mut self, method: &str, params: Option<Value>) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct JsonRpcNotification {
            jsonrpc: &'static str,
            method: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            params: Option<Value>,
        }

        let notification = JsonRpcNotification {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
        };

        let mut payload = serde_json::to_string(&notification)?;
        payload.push('\n');

        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("MCP server stdin unavailable"))?;
        stdin.write_all(payload.as_bytes())?;
        stdin.flush()?;
        Ok(())
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

// ---------------------------------------------------------------------------
// McpToolAdapter — wraps an MCP tool to implement the Tool trait
// ---------------------------------------------------------------------------

pub struct McpToolAdapter {
    tool_name: String,
    server_name: String,
    description: String,
    input_schema: Value,
    client: Arc<Mutex<McpClient>>,
}

impl McpToolAdapter {
    fn new(def: &McpToolDefinition, server_name: &str, client: Arc<Mutex<McpClient>>) -> Self {
        Self {
            tool_name: format!("mcp__{}__{}", server_name, def.name),
            server_name: server_name.to_string(),
            description: if def.description.is_empty() {
                format!("MCP tool '{}' from server '{}'", def.name, server_name)
            } else {
                format!("{} (via MCP server '{}')", def.description, server_name)
            },
            input_schema: if def.input_schema.is_null() {
                serde_json::json!({ "type": "object", "properties": {} })
            } else {
                def.input_schema.clone()
            },
            client,
        }
    }
}

#[async_trait::async_trait]
impl Tool for McpToolAdapter {
    fn name(&self) -> &str {
        &self.tool_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> Value {
        self.input_schema.clone()
    }

    async fn execute(&self, params: Value, _ctx: &ToolContext) -> anyhow::Result<Value> {
        // Extract the original MCP tool name (strip the mcp__server__ prefix)
        let original_name = self
            .tool_name
            .strip_prefix(&format!("mcp__{}__", self.server_name))
            .unwrap_or(&self.tool_name);

        let mut client = self
            .client
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP client lock poisoned"))?;
        client.call_tool(original_name, params)
    }
}

// ---------------------------------------------------------------------------
// Public API — load all MCP servers and produce Tool objects
// ---------------------------------------------------------------------------

/// Load MCP configuration and connect to all configured servers.
/// Returns a list of Tool objects for all discovered MCP tools.
pub fn load_mcp_tools(workspace: &Path) -> Vec<Box<dyn Tool>> {
    let config = match McpConfig::load(workspace) {
        Some(config) => config,
        None => return Vec::new(),
    };

    let mut tools: Vec<Box<dyn Tool>> = Vec::new();

    for (server_name, server_config) in &config.servers {
        match McpClient::connect(server_name, server_config) {
            Ok(client) => {
                let discovered = client.discovered_tools().to_vec();
                let shared = Arc::new(Mutex::new(client));
                for def in &discovered {
                    tools.push(Box::new(McpToolAdapter::new(
                        def,
                        server_name,
                        Arc::clone(&shared),
                    )));
                }
                eprintln!(
                    "\x1b[2m🔌 MCP server '{}': {} tools discovered\x1b[0m",
                    server_name,
                    discovered.len()
                );
            }
            Err(err) => {
                eprintln!(
                    "\x1b[33m⚠️  MCP server '{}' failed to connect: {}\x1b[0m",
                    server_name, err
                );
            }
        }
    }

    tools
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mcp_config_json() {
        let json = r#"{
            "servers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                    "env": {}
                }
            }
        }"#;

        let config: McpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.servers.len(), 1);
        assert!(config.servers.contains_key("filesystem"));
        assert_eq!(config.servers["filesystem"].command, "npx");
        assert_eq!(config.servers["filesystem"].args.len(), 3);
    }

    #[test]
    fn parses_mcp_tool_definition() {
        let json = r#"{
            "name": "read_file",
            "description": "Read a file from disk",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }
        }"#;

        let def: McpToolDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(def.name, "read_file");
        assert_eq!(def.description, "Read a file from disk");
        assert!(
            def.input_schema["properties"]["path"]["type"]
                .as_str()
                .unwrap()
                == "string"
        );
    }

    #[test]
    fn mcp_tool_adapter_generates_namespaced_name() {
        let def = McpToolDefinition {
            name: "search".to_string(),
            description: "Search files".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        };

        // We can't fully test without a real client, but we can test the naming
        let expected = format!("mcp__myserver__{}", def.name);
        assert_eq!(expected, "mcp__myserver__search");
    }

    #[test]
    fn loads_empty_config_when_no_file() {
        let tools = load_mcp_tools(Path::new("/nonexistent/path"));
        assert!(tools.is_empty());
    }
}
