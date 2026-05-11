use serde_json::Value;

use crate::config::SandboxPolicy;
use crate::session::history::HistoryStore;

use super::{Tool, ToolContext};

pub struct ReadRecentHistoryTool;

#[async_trait::async_trait]
impl Tool for ReadRecentHistoryTool {
    fn name(&self) -> &str {
        "read_recent_history"
    }

    fn description(&self) -> &str {
        "Read the recent file mutation transactions recorded by the agent. Useful to understand recent context and find transaction IDs to revert."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "description": "Number of recent transactions to view. Max 20." }
            }
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let limit = params["limit"].as_i64().unwrap_or(5).clamp(1, 20) as usize;
        let history = HistoryStore::new(&ctx.workspace_root);
        let transactions = history.get_recent_transactions(limit)?;

        Ok(serde_json::json!({
            "transactions": transactions
        }))
    }
}

pub struct RevertTransactionTool;

#[async_trait::async_trait]
impl Tool for RevertTransactionTool {
    fn name(&self) -> &str {
        "revert_transaction"
    }

    fn description(&self) -> &str {
        "Revert a specific file mutation using its transaction ID."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "transaction_id": { "type": "string", "description": "The transaction ID (e.g. 'tx_12345_abcde') to revert." }
            },
            "required": ["transaction_id"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        if matches!(ctx.sandbox, SandboxPolicy::ReadOnly) {
            anyhow::bail!("revert_transaction is blocked by read-only sandbox policy");
        }

        let tx_id = params["transaction_id"].as_str().unwrap_or("");
        if tx_id.is_empty() {
            anyhow::bail!("transaction_id is required");
        }

        let history = HistoryStore::new(&ctx.workspace_root);
        history.revert_transaction(tx_id)?;

        Ok(serde_json::json!({
            "status": "success",
            "message": format!("Reverted transaction {}", tx_id)
        }))
    }
}
