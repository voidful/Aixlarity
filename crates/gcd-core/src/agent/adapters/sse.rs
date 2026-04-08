// GemiClawDex — Shared SSE (Server-Sent Events) Parser
//
// Extracts JSON events from an SSE byte stream, handling:
// - Line buffering across TCP chunk boundaries
// - `data: ` prefix stripping
// - `[DONE]` sentinel
// - JSON parse errors with logging

use futures_util::StreamExt;
use serde_json::Value;

/// Process an SSE byte stream, calling `on_event` for each successfully parsed JSON event.
pub(super) async fn process_sse_stream<F>(
    response: impl futures_util::Stream<Item = Result<impl AsRef<[u8]>, impl std::fmt::Display>> + Unpin,
    provider_name: &str,
    mut on_event: F,
) where
    F: FnMut(&Value),
{
    let mut stream = response;
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                eprintln!(
                    "\x1b[33m⚠️  {} SSE stream error: {}\x1b[0m",
                    provider_name, e
                );
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(bytes.as_ref()));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(json_str) = line.strip_prefix("data: ") {
                if json_str.trim() == "[DONE]" {
                    continue;
                }
                match serde_json::from_str::<Value>(json_str) {
                    Ok(event) => on_event(&event),
                    Err(e) => {
                        eprintln!(
                            "\x1b[33m⚠️  {} SSE parse error: {}\x1b[0m",
                            provider_name, e
                        );
                    }
                }
            }
        }
    }
}
