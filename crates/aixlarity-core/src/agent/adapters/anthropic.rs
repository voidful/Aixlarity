use serde_json::{json, Value};

use crate::tools::Tool;

use super::super::types::{AgentMessage, AgentRunOptions, ToolCall};

pub(crate) async fn call_anthropic_api(
    options: &AgentRunOptions,
    messages: &[AgentMessage],
    tools: &[Box<dyn Tool>],
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let body = json!({
        "model": options.provider.model,
        "messages": anthropic_messages_payload(messages),
        "tools": anthropic_tool_defs(tools),
        "max_tokens": 8192,
    });

    if options.streaming {
        return call_anthropic_streaming(options, &body).await;
    }

    let url = format!("{}/v1/messages", options.provider.api_base);
    let client = super::http_client();
    let response = client
        .post(&url)
        .header("x-api-key", &options.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let response_text = response.text().await?;

    if !status.is_success() {
        anyhow::bail!("Anthropic API error ({}): {}", status, response_text);
    }

    let response_json: Value = serde_json::from_str(&response_text)?;
    let prompt_tokens = response_json["usage"]["input_tokens"].as_u64().unwrap_or(0) as usize;
    let completion_tokens = response_json["usage"]["output_tokens"]
        .as_u64()
        .unwrap_or(0) as usize;

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();
    if let Some(content) = response_json["content"].as_array() {
        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(text) = block["text"].as_str() {
                        text_parts.push(text.to_string());
                    }
                }
                Some("tool_use") => {
                    let id = block["id"].as_str().unwrap_or("").to_string();
                    let name = block["name"].as_str().unwrap_or("").to_string();
                    let input = block["input"].clone();
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments: input,
                    });
                }
                _ => {}
            }
        }
    }

    Ok((
        AgentMessage {
            role: "assistant".to_string(),
            content: text_parts.join(""),
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            tool_call_id: None,
            attachments: None,
        },
        (prompt_tokens, completion_tokens),
        None,
    ))
}

async fn call_anthropic_streaming(
    options: &AgentRunOptions,
    body: &Value,
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!("{}/v1/messages", options.provider.api_base);

    let mut streaming_body = body.clone();
    streaming_body["stream"] = json!(true);

    let client = super::http_client();
    let response = client
        .post(&url)
        .header("x-api-key", &options.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&streaming_body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await?;
        anyhow::bail!("Anthropic streaming API error ({}): {}", status, text);
    }

    let mut full_text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut prompt_tokens = 0usize;
    let mut completion_tokens = 0usize;

    // Track the current content block being streamed
    let mut current_tool_id = String::new();
    let mut current_tool_name = String::new();
    let mut current_tool_json = String::new();

    super::sse::process_sse_stream(response.bytes_stream(), "Anthropic", |event| {
        match event["type"].as_str() {
            Some("message_start") => {
                if let Some(usage) = event["message"]["usage"].as_object() {
                    prompt_tokens = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                }
            }
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block["type"].as_str() == Some("tool_use") {
                    current_tool_id = block["id"].as_str().unwrap_or("").to_string();
                    current_tool_name = block["name"].as_str().unwrap_or("").to_string();
                    current_tool_json.clear();
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = delta["text"].as_str() {
                            if let Some(handler) = &options.stream_handler {
                                (handler.0)(text.to_string());
                            } else if !options.quiet {
                                eprint!("{}", text);
                            }
                            full_text.push_str(text);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(json_fragment) = delta["partial_json"].as_str() {
                            current_tool_json.push_str(json_fragment);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") if !current_tool_name.is_empty() => {
                let arguments: Value = serde_json::from_str(&current_tool_json)
                    .unwrap_or(Value::Object(Default::default()));
                tool_calls.push(ToolCall {
                    id: current_tool_id.clone(),
                    name: current_tool_name.clone(),
                    arguments,
                });
                current_tool_id.clear();
                current_tool_name.clear();
                current_tool_json.clear();
            }
            Some("message_delta") => {
                if let Some(usage) = event["usage"].as_object() {
                    completion_tokens = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                }
            }
            _ => {}
        }
    })
    .await;

    if !full_text.is_empty()
        && !full_text.ends_with('\n')
        && options.stream_handler.is_none()
        && !options.quiet
    {
        eprintln!();
    }

    Ok((
        AgentMessage {
            role: "assistant".to_string(),
            content: full_text,
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            tool_call_id: None,
            attachments: None,
        },
        (prompt_tokens, completion_tokens),
        None,
    ))
}

fn anthropic_messages_payload(messages: &[AgentMessage]) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();

    for message in messages {
        let (role, mut content_blocks) = match message.role.as_str() {
            "user" => {
                let mut blocks = vec![json!({ "type": "text", "text": message.content })];
                if let Some(attachments) = &message.attachments {
                    for att in attachments {
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": att.mime_type,
                                "data": att.data_base64
                            }
                        }));
                    }
                }
                ("user", blocks)
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": message.content }));
                }
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": call.id,
                            "name": call.name,
                            "input": call.arguments
                        }));
                    }
                }
                ("assistant", blocks)
            }
            "tool" => {
                let mut inner_content = vec![json!({ "type": "text", "text": message.content })];
                if let Some(attachments) = &message.attachments {
                    for att in attachments {
                        inner_content.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": att.mime_type,
                                "data": att.data_base64
                            }
                        }));
                    }
                }
                (
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                        "content": inner_content
                    })],
                )
            }
            _ => continue,
        };

        if let Some(last) = merged.last_mut() {
            if last["role"].as_str() == Some(role) {
                // Merge content blocks into the existing message
                if let Some(existing_content) = last["content"].as_array_mut() {
                    existing_content.append(&mut content_blocks);
                }
                continue;
            }
        }

        merged.push(json!({
            "role": role,
            "content": content_blocks
        }));
    }

    merged
}

fn anthropic_tool_defs(tools: &[Box<dyn Tool>]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name(),
                "description": tool.description(),
                "input_schema": tool.parameters_schema()
            })
        })
        .collect()
}
