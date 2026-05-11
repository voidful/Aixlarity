use std::process::Command;

pub(crate) const SHELL_OUTPUT_LIMIT: usize = 10 * 1024;

pub(crate) fn truncate_output(raw: &[u8], limit: usize) -> String {
    let rendered = String::from_utf8_lossy(raw);
    if rendered.len() <= limit {
        rendered.to_string()
    } else {
        // Find a safe char boundary to avoid panicking on multi-byte UTF-8
        let boundary = rendered
            .char_indices()
            .take_while(|(i, _)| *i <= limit)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(rendered.len());
        format!(
            "{}

... [truncated: {} bytes total, showing first {}]",
            &rendered[..boundary],
            rendered.len(),
            boundary
        )
    }
}

pub(crate) fn simple_diff(old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut diff = String::new();

    let max_len = old_lines.len().max(new_lines.len());
    for index in 0..max_len {
        let old_line = old_lines.get(index).copied().unwrap_or("");
        let new_line = new_lines.get(index).copied().unwrap_or("");

        if index >= old_lines.len() {
            diff.push_str(&format!("+{}\n", new_line));
        } else if index >= new_lines.len() {
            diff.push_str(&format!("-{}\n", old_line));
        } else if old_line != new_line {
            diff.push_str(&format!("-{}\n", old_line));
            diff.push_str(&format!("+{}\n", new_line));
        }
    }

    diff
}

pub(crate) fn which_exists(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
