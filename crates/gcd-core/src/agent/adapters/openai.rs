use serde_json::{json, Value};

use crate::tools::Tool;

use super::super::types::{AgentMessage, AgentRunOptions, ToolCall};

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

pub(crate) async fn call_openai_responses_api(
    options: &AgentRunOptions,
    messages: &[AgentMessage],
    tools: &[Box<dyn Tool>],
    previous_response_id: Option<&str>,
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!("{}/responses", options.provider.api_base);
    let mut body = json!({
        "model": options.provider.model,
        "input": openai_response_input(messages, previous_response_id),
        "tools": openai_response_tool_defs(tools),
        "parallel_tool_calls": false
    });

    if let Some(id) = previous_response_id {
        body["previous_response_id"] = Value::String(id.to_string());
    }

    if options.streaming {
        body["stream"] = json!(true);
        return call_openai_responses_streaming(options, &body).await;
    }

    let client = super::http_client();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", options.api_key))
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let response_text = response.text().await?;

    if !status.is_success() {
        anyhow::bail!("OpenAI Responses API error ({}): {}", status, response_text);
    }

    let response_json: Value = serde_json::from_str(&response_text)?;
    let prompt_tokens = response_json["usage"]["input_tokens"].as_u64().unwrap_or(0) as usize;
    let completion_tokens = response_json["usage"]["output_tokens"]
        .as_u64()
        .unwrap_or(0) as usize;
    let response_id = response_json["id"].as_str().map(str::to_string);
    let message = parse_openai_response(&response_json)?;

    Ok((message, (prompt_tokens, completion_tokens), response_id))
}

async fn call_openai_responses_streaming(
    options: &AgentRunOptions,
    body: &Value,
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!("{}/responses", options.provider.api_base);

    let client = super::http_client();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", options.api_key))
        .json(body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await?;
        anyhow::bail!("OpenAI Responses streaming error ({}): {}", status, text);
    }

    let mut full_text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut prompt_tokens = 0usize;
    let mut completion_tokens = 0usize;
    let mut response_id: Option<String> = None;

    // Track in-progress function call
    let mut current_call_id = String::new();
    let mut current_fn_name = String::new();
    let mut current_fn_args = String::new();

    super::sse::process_sse_stream(
        response.bytes_stream(),
        "OpenAI Responses",
        |event| match event["type"].as_str() {
            Some("response.created") => {
                response_id = event["response"]["id"].as_str().map(str::to_string);
            }
            Some("response.output_item.added") => {
                let item = &event["item"];
                if item["type"].as_str() == Some("function_call") {
                    current_call_id = item["call_id"].as_str().unwrap_or("").to_string();
                    current_fn_name = item["name"].as_str().unwrap_or("").to_string();
                    current_fn_args.clear();
                }
            }
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    eprint!("{}", delta);
                    full_text.push_str(delta);
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    current_fn_args.push_str(delta);
                }
            }
            Some("response.function_call_arguments.done") | Some("response.output_item.done") => {
                if !current_fn_name.is_empty() {
                    let arguments: Value = serde_json::from_str(&current_fn_args)
                        .unwrap_or(Value::Object(Default::default()));
                    tool_calls.push(ToolCall {
                        id: current_call_id.clone(),
                        name: current_fn_name.clone(),
                        arguments,
                    });
                    current_call_id.clear();
                    current_fn_name.clear();
                    current_fn_args.clear();
                }
            }
            Some("response.completed") => {
                if let Some(usage) = event["response"]["usage"].as_object() {
                    prompt_tokens = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                    completion_tokens = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                }
            }
            _ => {}
        },
    )
    .await;

    if !full_text.is_empty() && !full_text.ends_with('\n') {
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
        },
        (prompt_tokens, completion_tokens),
        response_id,
    ))
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API
// ---------------------------------------------------------------------------

pub(crate) async fn call_openai_chat_api(
    options: &AgentRunOptions,
    messages: &[AgentMessage],
    tools: &[Box<dyn Tool>],
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!("{}/chat/completions", options.provider.api_base);
    let mut body = json!({
        "model": options.provider.model,
        "messages": openai_chat_messages(messages),
        "tools": openai_chat_tool_defs(tools),
        "temperature": 0.2,
        "max_tokens": 8192,
    });

    if options.streaming {
        body["stream"] = json!(true);
        body["stream_options"] = json!({"include_usage": true});
        return call_openai_chat_streaming(options, &body).await;
    }

    let client = super::http_client();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", options.api_key))
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let response_text = response.text().await?;

    if !status.is_success() {
        anyhow::bail!(
            "OpenAI Chat Completions API error ({}): {}",
            status,
            response_text
        );
    }

    let response_json: Value = serde_json::from_str(&response_text)?;
    let prompt_tokens = response_json["usage"]["prompt_tokens"]
        .as_u64()
        .unwrap_or(0) as usize;
    let completion_tokens = response_json["usage"]["completion_tokens"]
        .as_u64()
        .unwrap_or(0) as usize;
    let choice = &response_json["choices"][0]["message"];
    let content = choice["content"].as_str().unwrap_or("").to_string();

    let tool_calls = if let Some(items) = choice["tool_calls"].as_array() {
        let calls: Vec<ToolCall> = items
            .iter()
            .map(|item| {
                let id = item["id"].as_str().unwrap_or("").to_string();
                let name = item["function"]["name"].as_str().unwrap_or("").to_string();
                let args_str = item["function"]["arguments"].as_str().unwrap_or("{}");
                let arguments =
                    serde_json::from_str(args_str).unwrap_or(Value::Object(Default::default()));
                ToolCall {
                    id,
                    name,
                    arguments,
                }
            })
            .collect();
        if calls.is_empty() {
            None
        } else {
            Some(calls)
        }
    } else {
        None
    };

    Ok((
        AgentMessage {
            role: "assistant".to_string(),
            content,
            tool_calls,
            tool_call_id: None,
        },
        (prompt_tokens, completion_tokens),
        None,
    ))
}

async fn call_openai_chat_streaming(
    options: &AgentRunOptions,
    body: &Value,
) -> anyhow::Result<(AgentMessage, (usize, usize), Option<String>)> {
    let url = format!("{}/chat/completions", options.provider.api_base);

    let client = super::http_client();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", options.api_key))
        .json(body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await?;
        anyhow::bail!("OpenAI Chat streaming error ({}): {}", status, text);
    }

    let mut full_text = String::new();
    // Map from tool-call index -> (id, name, accumulated arguments)
    let mut tool_map: std::collections::BTreeMap<u64, (String, String, String)> =
        std::collections::BTreeMap::new();
    let mut prompt_tokens = 0usize;
    let mut completion_tokens = 0usize;

    super::sse::process_sse_stream(response.bytes_stream(), "OpenAI Chat", |event| {
        // Usage chunk (sent with stream_options.include_usage)
        if let Some(usage) = event.get("usage").filter(|u| !u.is_null()) {
            prompt_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0) as usize;
            completion_tokens = usage["completion_tokens"].as_u64().unwrap_or(0) as usize;
        }

        if let Some(delta) = event["choices"][0]["delta"].as_object() {
            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                eprint!("{}", content);
                full_text.push_str(content);
            }

            if let Some(tc_deltas) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tc_deltas {
                    let index = tc["index"].as_u64().unwrap_or(0);
                    let entry = tool_map
                        .entry(index)
                        .or_insert_with(|| (String::new(), String::new(), String::new()));
                    if let Some(id) = tc["id"].as_str() {
                        entry.0 = id.to_string();
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        entry.1 = name.to_string();
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        entry.2.push_str(args);
                    }
                }
            }
        }
    })
    .await;

    if !full_text.is_empty() && !full_text.ends_with('\n') {
        eprintln!();
    }

    let tool_calls: Vec<ToolCall> = tool_map
        .into_values()
        .map(|(id, name, args_str)| {
            let arguments =
                serde_json::from_str(&args_str).unwrap_or(Value::Object(Default::default()));
            ToolCall {
                id,
                name,
                arguments,
            }
        })
        .collect();

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
        },
        (prompt_tokens, completion_tokens),
        None,
    ))
}

// ---------------------------------------------------------------------------
// Shared OpenAI helpers
// ---------------------------------------------------------------------------

pub(super) fn openai_response_input(
    messages: &[AgentMessage],
    previous_response_id: Option<&str>,
) -> Vec<Value> {
    if previous_response_id.is_some() {
        let tool_outputs = trailing_tool_outputs(messages);
        if !tool_outputs.is_empty() {
            return tool_outputs;
        }
    }

    messages
        .iter()
        .filter_map(openai_response_message_item)
        .collect()
}

fn trailing_tool_outputs(messages: &[AgentMessage]) -> Vec<Value> {
    let start = messages
        .iter()
        .rposition(|message| message.role != "tool")
        .map_or(0, |index| index + 1);
    messages[start..]
        .iter()
        .filter_map(openai_response_tool_output)
        .collect()
}

fn openai_response_message_item(message: &AgentMessage) -> Option<Value> {
    match message.role.as_str() {
        "tool" => openai_response_tool_output(message),
        "assistant" if message.content.trim().is_empty() => None,
        "assistant" => Some(openai_response_text_message("assistant", &message.content)),
        "user" => Some(openai_response_text_message("user", &message.content)),
        other if !message.content.trim().is_empty() => {
            Some(openai_response_text_message(other, &message.content))
        }
        _ => None,
    }
}

fn openai_response_tool_output(message: &AgentMessage) -> Option<Value> {
    message.tool_call_id.as_ref().map(|call_id| {
        json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": message.content
        })
    })
}

fn openai_response_text_message(role: &str, content: &str) -> Value {
    json!({
        "role": role,
        "content": [{
            "type": "input_text",
            "text": content
        }]
    })
}

fn openai_response_tool_defs(tools: &[Box<dyn Tool>]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name(),
                "description": tool.description(),
                "parameters": tool.parameters_schema()
            })
        })
        .collect()
}

pub(super) fn parse_openai_response(response: &Value) -> anyhow::Result<AgentMessage> {
    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    if let Some(items) = response["output"].as_array() {
        for item in items {
            match item["type"].as_str() {
                Some("message") => {
                    if let Some(content) = item["content"].as_array() {
                        for part in content {
                            match part["type"].as_str() {
                                Some("output_text") => {
                                    if let Some(text) = part["text"].as_str() {
                                        text_parts.push(text.to_string());
                                    }
                                }
                                Some("refusal") => {
                                    if let Some(text) = part["refusal"].as_str() {
                                        text_parts.push(text.to_string());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    let args_str = item["arguments"].as_str().unwrap_or("{}");
                    let arguments = serde_json::from_str(args_str)
                        .unwrap_or(Value::String(args_str.to_string()));
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments,
                    });
                }
                _ => {}
            }
        }
    }

    if text_parts.is_empty() && tool_calls.is_empty() {
        anyhow::bail!("OpenAI Responses API returned no assistant content or tool calls");
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
    })
}

fn openai_chat_messages(messages: &[AgentMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut payload = json!({
                "role": match message.role.as_str() {
                    "tool" => "tool",
                    "assistant" => "assistant",
                    _ => "user",
                },
                "content": message.content,
            });

            if let Some(calls) = &message.tool_calls {
                let tool_calls: Vec<Value> = calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": serde_json::to_string(&call.arguments)
                                    .unwrap_or_default()
                            }
                        })
                    })
                    .collect();
                payload["tool_calls"] = Value::Array(tool_calls);
            }

            if let Some(id) = &message.tool_call_id {
                payload["tool_call_id"] = Value::String(id.clone());
            }

            payload
        })
        .collect()
}

fn openai_chat_tool_defs(tools: &[Box<dyn Tool>]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name(),
                    "description": tool.description(),
                    "parameters": tool.parameters_schema()
                }
            })
        })
        .collect()
}
