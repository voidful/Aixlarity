use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::display_path;
use crate::workspace::Workspace;

use super::{
    PromptAttachment, DIRECTORY_LIST_LIMIT, TEXT_INJECTION_BYTE_LIMIT, TEXT_INJECTION_LINE_LIMIT,
};

pub(super) struct FileInjectionResult {
    pub segments: Vec<PromptSegment>,
    pub attachments: Vec<PromptAttachment>,
}

pub(super) fn expand_file_injections(
    text: &str,
    workspace: &Workspace,
) -> io::Result<FileInjectionResult> {
    let spans = find_balanced_spans(text, "@{");
    if spans.is_empty() {
        return Ok(FileInjectionResult {
            segments: vec![PromptSegment {
                text: text.to_string(),
                injected: false,
            }],
            attachments: Vec::new(),
        });
    }

    let mut segments = Vec::new();
    let mut attachments = Vec::new();
    let mut cursor = 0usize;

    for span in spans {
        push_segment(&mut segments, &text[cursor..span.start], false);
        let raw_path = span.body.trim();
        let resolved = resolve_injected_path(raw_path, workspace)?;
        let rendered = render_injected_path(&resolved)?;
        push_segment(&mut segments, &rendered.rendered, true);
        attachments.extend(rendered.attachments);
        cursor = span.end;
    }

    push_segment(&mut segments, &text[cursor..], false);

    Ok(FileInjectionResult {
        segments,
        attachments,
    })
}

pub(super) struct ShellSanitization {
    pub expanded: Vec<PromptSegment>,
    pub pending: Vec<String>,
}

pub(super) fn sanitize_shell_blocks(segments: &[PromptSegment]) -> ShellSanitization {
    if segments.is_empty() {
        return ShellSanitization {
            expanded: Vec::new(),
            pending: Vec::new(),
        };
    }

    let mut expanded = Vec::new();
    let mut pending = Vec::new();

    for segment in segments {
        if segment.injected {
            expanded.push(segment.clone());
            continue;
        }

        let spans = find_balanced_spans(&segment.text, "!{");
        if spans.is_empty() {
            expanded.push(segment.clone());
            continue;
        }

        let mut cursor = 0usize;
        let mut rendered = String::new();
        for span in spans {
            rendered.push_str(&segment.text[cursor..span.start]);
            let command = span.body.trim().to_string();
            pending.push(command.clone());
            rendered.push_str(&format!(
                "<shell-approval required=\"true\">{}</shell-approval>",
                command
            ));
            cursor = span.end;
        }
        rendered.push_str(&segment.text[cursor..]);
        expanded.push(PromptSegment {
            text: rendered,
            injected: false,
        });
    }

    ShellSanitization { expanded, pending }
}

#[derive(Clone, Debug)]
pub(super) struct PromptSegment {
    pub text: String,
    pub injected: bool,
}

struct InjectedRender {
    rendered: String,
    attachments: Vec<PromptAttachment>,
}

fn render_injected_path(path: &Path) -> io::Result<InjectedRender> {
    let metadata = fs::metadata(path)?;
    if metadata.is_dir() {
        let entries = collect_directory_entries(path)?;
        let rendered = format!(
            "<injected-directory path=\"{}\">\n{}\n</injected-directory>",
            display_path(path),
            entries.join("\n")
        );
        return Ok(InjectedRender {
            rendered,
            attachments: vec![PromptAttachment::DirectoryListing {
                path: path.to_path_buf(),
                entries,
            }],
        });
    }

    if let Some(media_type) = detect_binary_media_type(path) {
        let rendered = format!(
            "<attached-file path=\"{}\" media_type=\"{}\">binary reference reserved for provider adapter</attached-file>",
            display_path(path),
            media_type,
        );
        return Ok(InjectedRender {
            rendered,
            attachments: vec![PromptAttachment::BinaryReference {
                path: path.to_path_buf(),
                media_type,
            }],
        });
    }

    let preview = read_text_preview(path)?;
    let rendered = format!(
        "<injected-file path=\"{}\">\n{}\n</injected-file>",
        display_path(path),
        preview
    );
    Ok(InjectedRender {
        rendered,
        attachments: vec![PromptAttachment::FileText {
            path: path.to_path_buf(),
            preview,
        }],
    })
}

fn resolve_injected_path(raw: &str, workspace: &Workspace) -> io::Result<PathBuf> {
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        if candidate.starts_with(&workspace.root) || candidate.starts_with(&workspace.current_dir) {
            return Ok(candidate);
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("injected path is outside workspace: {}", raw),
        ));
    }

    let current_candidate = workspace.current_dir.join(raw);
    if current_candidate.exists() {
        return Ok(current_candidate);
    }

    let workspace_candidate = workspace.root.join(raw);
    if workspace_candidate.exists() {
        return Ok(workspace_candidate);
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("unable to resolve injected path: {}", raw),
    ))
}

fn read_text_preview(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    if looks_binary(&bytes) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "binary file is not supported as text injection: {}",
                display_path(path)
            ),
        ));
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut output = String::new();
    let mut total_bytes = 0usize;
    for (index, line) in text.lines().take(TEXT_INJECTION_LINE_LIMIT).enumerate() {
        total_bytes += line.len();
        if total_bytes > TEXT_INJECTION_BYTE_LIMIT {
            break;
        }
        output.push_str(&format!("{}\t{}\n", index + 1, line));
    }
    Ok(output.trim_end().to_string())
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    let sample_len = bytes.len().min(1024);
    let sample = &bytes[..sample_len];
    let mut suspicious = 0usize;
    for byte in sample {
        if *byte == 0 {
            return true;
        }
        if (*byte < 7) || (*byte > 14 && *byte < 32) {
            suspicious += 1;
        }
    }
    suspicious * 10 > sample_len
}

fn detect_binary_media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension().and_then(|ext| ext.to_str())?;
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

fn collect_directory_entries(root: &Path) -> io::Result<Vec<String>> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                if entry.file_name().to_string_lossy() != ".git" {
                    stack.push(path);
                }
                continue;
            }

            if file_type.is_file() {
                let relative = path.strip_prefix(root).unwrap_or(path.as_path());
                entries.push(relative.to_string_lossy().replace('\\', "/"));
                if entries.len() >= DIRECTORY_LIST_LIMIT {
                    return Ok(entries);
                }
            }
        }
    }

    entries.sort();
    Ok(entries)
}

fn push_segment(segments: &mut Vec<PromptSegment>, text: &str, injected: bool) {
    if text.is_empty() {
        return;
    }

    if let Some(last) = segments.last_mut() {
        if last.injected == injected {
            last.text.push_str(text);
            return;
        }
    }

    segments.push(PromptSegment {
        text: text.to_string(),
        injected,
    });
}

#[derive(Clone, Debug)]
struct Span {
    start: usize,
    end: usize,
    body: String,
}

fn find_balanced_spans(text: &str, opener: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let bytes = text.as_bytes();
    let opener_bytes = opener.as_bytes();
    let mut index = 0usize;

    while index + opener_bytes.len() <= bytes.len() {
        if &bytes[index..index + opener_bytes.len()] != opener_bytes {
            index += 1;
            continue;
        }

        let start = index;
        index += opener_bytes.len();
        let body_start = index;
        let mut depth = 1i32;

        while index < bytes.len() {
            match bytes[index] as char {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        spans.push(Span {
                            start,
                            end: index + 1,
                            body: text[body_start..index].to_string(),
                        });
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }

        if depth != 0 {
            break;
        }

        index += 1;
    }

    spans
}
