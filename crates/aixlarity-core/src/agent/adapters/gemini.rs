use serde_json::{json, Value};

use crate::tools::Tool;

use super::super::types::{AgentMessage, AgentRunOptions, ToolCall};

pub(crate) async fn call_gemini_api(
    options: &AgentRunOptions,
    messages: &[AgentMessage],
    tools: &[Box<dyn Tool>],
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let mut contents: Vec<Value> = Vec::new();

    for message in messages {
        let role = match message.role.as_str() {
            "user" | "tool" => "user",
            "assistant" | "model" => "model",
            _ => "user",
        };

        let mut parts = Vec::new();

        if message.role == "tool" {
            if let Some(call_id) = &message.tool_call_id {
                let fn_name = messages
                    .iter()
                    .rev()
                    .filter_map(|m| m.tool_calls.as_ref())
                    .flatten()
                    .find(|tc| tc.id == *call_id)
                    .map(|tc| tc.name.as_str())
                    .unwrap_or(call_id.as_str());
                parts.push(json!({
                    "functionResponse": {
                        "name": fn_name,
                        "response": serde_json::from_str::<Value>(&message.content)
                            .unwrap_or(Value::String(message.content.clone()))
                    }
                }));
            }
            if let Some(attachments) = &message.attachments {
                for attachment in attachments {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": attachment.mime_type,
                            "data": attachment.data_base64
                        }
                    }));
                }
            }
        } else {
            if !message.content.is_empty() {
                parts.push(json!({ "text": message.content }));
            }
            if let Some(calls) = &message.tool_calls {
                for call in calls {
                    parts.push(json!({
                        "functionCall": {
                            "name": call.name,
                            "args": call.arguments
                        }
                    }));
                }
            }
            if let Some(attachments) = &message.attachments {
                for attachment in attachments {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": attachment.mime_type,
                            "data": attachment.data_base64
                        }
                    }));
                }
            }
        }

        if let Some(last) = contents.last_mut() {
            if last["role"].as_str() == Some(role) {
                if let Some(existing_parts) = last["parts"].as_array_mut() {
                    existing_parts.append(&mut parts);
                }
                continue;
            }
        }

        contents.push(json!({
            "role": role,
            "parts": parts
        }));
    }

    let tool_decls: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name(),
                "description": tool.description(),
                "parameters": tool.parameters_schema()
            })
        })
        .collect();

    let body = json!({
        "contents": contents,
        "tools": [{ "functionDeclarations": tool_decls }],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192
        }
    });

    if options.streaming {
        return call_gemini_streaming(options, &body).await;
    }

    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        options.provider.api_base, options.provider.model
    );
    let client = super::http_client();
    let response = client
        .post(&url)
        .query(&[("key", &options.api_key)])
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let response_text = response.text().await?;

    if !status.is_success() {
        anyhow::bail!("Gemini API error ({}): {}", status, response_text);
    }

    let response_json: Value = serde_json::from_str(&response_text)?;
    let prompt_tokens = response_json["usageMetadata"]["promptTokenCount"]
        .as_u64()
        .unwrap_or(0) as usize;
    let completion_tokens = response_json["usageMetadata"]["candidatesTokenCount"]
        .as_u64()
        .unwrap_or(0) as usize;

    let message = parse_gemini_response(&response_json)?;
    Ok((message, (prompt_tokens, completion_tokens), None))
}

async fn call_gemini_streaming(
    options: &AgentRunOptions,
    body: &Value,
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent",
        options.provider.api_base, options.provider.model
    );

    let client = super::http_client();
    let response = client
        .post(&url)
        .query(&[("alt", "sse"), ("key", &options.api_key)])
        .json(body)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await?;
        anyhow::bail!("Gemini streaming API error ({}): {}", status, text);
    }

    let mut full_text = String::new();
    let mut tool_calls = Vec::new();
    let mut prompt_tokens = 0usize;
    let mut completion_tokens = 0usize;

    super::sse::process_sse_stream(response.bytes_stream(), "Gemini", |value| {
        if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
            for (index, part) in parts.iter().enumerate() {
                if let Some(delta) = part["text"].as_str() {
                    if let Some(handler) = &options.stream_handler {
                        (handler.0)(delta.to_string());
                    } else if !options.quiet {
                        eprint!("{}", delta);
                    }
                    full_text.push_str(delta);
                }
                if let Some(function_call) = part.get("functionCall") {
                    let name = function_call["name"].as_str().unwrap_or("").to_string();
                    let args = function_call
                        .get("args")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    tool_calls.push(ToolCall {
                        id: format!("call_{}", index),
                        name,
                        arguments: args,
                    });
                }
            }
        }

        if let Some(usage) = value.get("usageMetadata") {
            prompt_tokens = usage["promptTokenCount"].as_u64().unwrap_or(0) as usize;
            completion_tokens = usage["candidatesTokenCount"].as_u64().unwrap_or(0) as usize;
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

fn parse_gemini_response(response: &Value) -> anyhow::Result<AgentMessage> {
    let candidate = &response["candidates"][0];
    let parts = candidate["content"]["parts"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("No parts in Gemini response"))?;

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    for (index, part) in parts.iter().enumerate() {
        if let Some(text) = part["text"].as_str() {
            text_parts.push(text.to_string());
        }
        if let Some(function_call) = part.get("functionCall") {
            let name = function_call["name"].as_str().unwrap_or("").to_string();
            let args = function_call
                .get("args")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            tool_calls.push(ToolCall {
                id: format!("call_{}", index),
                name,
                arguments: args,
            });
        }
    }

    Ok(AgentMessage {
        role: "assistant".to_string(),
        content: text_parts.join(""),
        tool_calls: if tool_calls.is_empty() {
            None
        } else {
            Some(tool_calls)
        },
        tool_call_id: None,
        attachments: None,
    })
}
