use serde_json::Value;

use super::{Tool, ToolContext};

pub struct FetchUrlTool;

#[async_trait::async_trait]
impl Tool for FetchUrlTool {
    fn name(&self) -> &str {
        "fetch_url"
    }

    fn description(&self) -> &str {
        "Fetch the contents of a URL and return the response body as text (max 32KB)."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "The URL to fetch" }
            },
            "required": ["url"]
        })
    }

    async fn execute(&self, params: Value, _ctx: &ToolContext) -> anyhow::Result<Value> {
        let url = params["url"].as_str().unwrap_or("");
        if url.is_empty() {
            anyhow::bail!("url parameter is required");
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?;

        let response = client.get(url).send().await?;
        let status = response.status().as_u16();
        let body = response.text().await?;
        let content = if body.len() > 32 * 1024 {
            format!(
                "{}\n\n... [truncated: {} bytes total]",
                &body[..32 * 1024],
                body.len()
            )
        } else {
            body
        };

        Ok(serde_json::json!({
            "url": url,
            "status": status,
            "content": content,
            "size_bytes": content.len()
        }))
    }
}
