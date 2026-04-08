use super::types::{PermissionLevel, ToolCall};

pub(super) fn needs_confirmation(tool_name: &str, permission: &PermissionLevel) -> bool {
    match permission {
        PermissionLevel::FullAuto => false,
        PermissionLevel::AutoEdit => matches!(tool_name, "shell" | "apply_patch"),
        PermissionLevel::Suggest => matches!(tool_name, "write_file" | "shell" | "apply_patch"),
    }
}

pub(super) fn check_always_upgrade(call: &ToolCall) -> (bool, bool) {
    eprintln!();
    eprintln!("⚠️  Agent wants to call: \x1b[1;33m{}\x1b[0m", call.name);
    if let Ok(pretty) = serde_json::to_string_pretty(&call.arguments) {
        let display = if pretty.len() > 500 {
            format!("{}...", &pretty[..500])
        } else {
            pretty
        };
        eprintln!("{}", display);
    }
    eprint!("\x1b[1;36mAllow? [y/n/always]: \x1b[0m");
    let _ = std::io::Write::flush(&mut std::io::stderr());

    let mut input = String::new();
    if std::io::stdin().read_line(&mut input).is_ok() {
        match input.trim().to_lowercase().as_str() {
            "always" => (true, true),
            "y" | "yes" => (true, false),
            _ => (false, false),
        }
    } else {
        (false, false)
    }
}
