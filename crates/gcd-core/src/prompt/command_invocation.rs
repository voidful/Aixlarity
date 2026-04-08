use std::io;

use crate::commands::CustomCommand;
use crate::config::display_path;
use crate::workspace::Workspace;

pub(super) fn render_command_prompt(
    command: &CustomCommand,
    args: &str,
    full_invocation: &str,
    workspace: &Workspace,
) -> io::Result<String> {
    let prompt = substitute_command_args(&command.prompt, args, full_invocation);
    let header = format!(
        "# Custom Command\nName: {}\nDescription: {}\nSource: {}\nWorkspace: {}\n",
        command.name,
        command.description,
        display_path(&command.source_path),
        display_path(&workspace.root),
    );
    Ok(format!("{}\n{}", header, prompt))
}

pub(super) fn parse_command_invocation(input: &str) -> Option<(String, String, String)> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }

    let mut parts = trimmed[1..].splitn(2, char::is_whitespace);
    let name = parts.next()?.trim();
    let args = parts.next().unwrap_or("").trim().to_string();
    Some((name.to_string(), args, trimmed.to_string()))
}

fn substitute_command_args(template: &str, args: &str, full_invocation: &str) -> String {
    if template.contains("{{args}}") {
        return template.replace("{{args}}", args);
    }

    if args.trim().is_empty() {
        return template.to_string();
    }

    format!(
        "{}\n\nRaw command: {}",
        template.trim_end(),
        full_invocation
    )
}
