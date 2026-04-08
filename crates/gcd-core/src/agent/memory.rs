use std::fs;
use std::path::Path;

#[allow(dead_code)]
pub fn update_memory(workspace: &Path, key: &str, value: &str) {
    let memory_dir = workspace.join(".gcd");
    let _ = fs::create_dir_all(&memory_dir);
    let memory_file = memory_dir.join("MEMORY.md");

    let mut content = if memory_file.exists() {
        fs::read_to_string(&memory_file).unwrap_or_default()
    } else {
        "# GCD Memory\n\nPersistent knowledge from past sessions.\n\n".to_string()
    };

    let section_header = format!("## {}", key);
    if content.contains(&section_header) {
        if let Some(start) = content.find(&section_header) {
            let end = content[start + section_header.len()..]
                .find("\n## ")
                .map(|offset| start + section_header.len() + offset)
                .unwrap_or(content.len());
            content = format!(
                "{}{}\n\n{}\n\n{}",
                &content[..start],
                section_header,
                value,
                &content[end..]
            );
        }
    } else {
        content.push_str(&format!("\n{}\n\n{}\n", section_header, value));
    }

    let _ = fs::write(&memory_file, content);
}

pub fn read_memory(workspace: &Path) -> Option<String> {
    let memory_file = workspace.join(".gcd").join("MEMORY.md");
    if memory_file.exists() {
        fs::read_to_string(&memory_file).ok()
    } else {
        None
    }
}
