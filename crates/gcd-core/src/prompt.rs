use std::io;
use std::path::PathBuf;

use crate::commands::CommandCatalog;
use crate::config::{display_path, SandboxPolicy};
use crate::instructions::InstructionBundle;
use crate::providers::ProviderProfile;
use crate::skills::{SkillCatalog, SkillDefinition};
use crate::trust::TrustState;
use crate::workspace::Workspace;

mod command_invocation;
mod expansion;

use command_invocation::{parse_command_invocation, render_command_prompt};
use expansion::{expand_file_injections, sanitize_shell_blocks};

const TEXT_INJECTION_LINE_LIMIT: usize = 400;
const TEXT_INJECTION_BYTE_LIMIT: usize = 32 * 1024;
const DIRECTORY_LIST_LIMIT: usize = 200;

#[derive(Clone, Debug)]
pub enum PromptAttachment {
    FileText {
        path: PathBuf,
        preview: String,
    },
    DirectoryListing {
        path: PathBuf,
        entries: Vec<String>,
    },
    BinaryReference {
        path: PathBuf,
        media_type: &'static str,
    },
}

#[derive(Clone, Debug)]
pub struct PromptAssembly {
    pub provider: ProviderProfile,
    pub workspace_root: PathBuf,
    pub trust_label: String,
    pub sandbox: SandboxPolicy,
    pub active_command: Option<String>,
    pub active_skill: Option<String>,
    pub attachments: Vec<PromptAttachment>,
    pub pending_shell_commands: Vec<String>,
    pub final_prompt: String,
}

pub struct PromptRequest<'a> {
    pub workspace: &'a Workspace,
    pub trust: &'a TrustState,
    pub sandbox: SandboxPolicy,
    pub provider: ProviderProfile,
    pub instructions: &'a InstructionBundle,
    pub commands: &'a CommandCatalog,
    pub skills: &'a SkillCatalog,
    pub selected_skill: Option<&'a str>,
    pub user_input: &'a str,
    /// Persistent memory content from MEMORY.md (if present).
    pub memory_content: Option<&'a str>,
}

pub fn assemble_prompt(request: PromptRequest<'_>) -> io::Result<PromptAssembly> {
    let invocation = parse_command_invocation(request.user_input);
    let (active_command, command_text) = match invocation {
        Some((name, args, full_invocation)) => {
            let command = request.commands.find(&name).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("unknown command: {}", name),
                )
            })?;
            let rendered =
                render_command_prompt(command, &args, &full_invocation, request.workspace)?;
            (Some(command.name.clone()), rendered)
        }
        None => (None, request.user_input.to_string()),
    };

    let active_skill = match request.selected_skill {
        Some(name) => Some(
            request
                .skills
                .find(name)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, format!("unknown skill: {}", name))
                })?
                .clone(),
        ),
        None => None,
    };

    let mut attachments = Vec::new();
    let mut prompt_body = command_text;
    let injection = expand_file_injections(&prompt_body, request.workspace)?;
    attachments.extend(injection.attachments);

    let shell = sanitize_shell_blocks(&injection.segments);
    prompt_body = shell
        .expanded
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join("");

    let mut sections = Vec::new();
    sections.push(format!(
        "# Runtime\nProvider: {} ({})\nProvider ID: {}\nProtocol: {}\nAPI Base: {}\nSandbox: {}\nTrust: {}\nWorkspace: {}",
        request.provider.label,
        request.provider.model,
        request.provider.id,
        request.provider.protocol.as_str(),
        request.provider.api_base,
        request.sandbox.as_str(),
        request.trust.status_label(),
        display_path(&request.workspace.root),
    ));

    if !request.instructions.sources.is_empty() {
        let mut instruction_text = String::from("# Repository Instructions");
        for source in &request.instructions.sources {
            instruction_text.push_str("\n\n## ");
            instruction_text.push_str(&source.label);
            instruction_text.push('\n');
            instruction_text.push_str(source.content.trim());
        }
        sections.push(instruction_text);
    }

    if let Some(memory) = request.memory_content {
        let trimmed = memory.trim();
        if !trimmed.is_empty() {
            sections.push(format!("# Persistent Memory\n{}", trimmed));
        }
    }

    if let Some(skill) = &active_skill {
        sections.push(render_skill_section(skill));
    }

    sections.push(format!("# Task\n{}", prompt_body.trim()));

    if !shell.pending.is_empty() {
        let mut shell_section = String::from("# Pending Shell Commands\n");
        for pending in &shell.pending {
            shell_section.push_str("- ");
            shell_section.push_str(pending);
            shell_section.push('\n');
        }
        sections.push(shell_section.trim_end().to_string());
    }

    Ok(PromptAssembly {
        provider: request.provider,
        workspace_root: request.workspace.root.clone(),
        trust_label: request.trust.status_label().to_string(),
        sandbox: request.sandbox,
        active_command,
        active_skill: active_skill.map(|skill| skill.name),
        attachments,
        pending_shell_commands: shell.pending,
        final_prompt: sections.join("\n\n"),
    })
}

fn render_skill_section(skill: &SkillDefinition) -> String {
    format!(
        "# Loaded Skill\nName: {}\nSummary: {}\n\n{}",
        skill.name,
        skill.summary,
        skill.body.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::{assemble_prompt, PromptRequest};
    use crate::commands::{CommandCatalog, CustomCommand};
    use crate::instructions::InstructionBundle;
    use crate::providers::builtin_provider;
    use crate::skills::SkillCatalog;
    use crate::trust::TrustState;
    use crate::workspace::Workspace;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn command_prompt_expands_files_and_shells() {
        let root = unique_test_dir("prompt");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("guide.txt"),
            "alpha\nliteral !{echo nope}\nbeta\n",
        )
        .unwrap();

        let workspace = Workspace {
            root: root.clone(),
            current_dir: root.clone(),
            detected_by: ".gcd".to_string(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };
        let commands = CommandCatalog {
            commands: vec![CustomCommand {
                name: "review".to_string(),
                description: "Review a file".to_string(),
                prompt: "Use @{guide.txt}\nTask: {{args}}\nRun !{git status}".to_string(),
                source_path: root.join("review.toml"),
            }],
        };

        let assembly = assemble_prompt(PromptRequest {
            workspace: &workspace,
            trust: &trust,
            sandbox: crate::config::SandboxPolicy::WorkspaceWrite,
            provider: builtin_provider("openai-codex").unwrap(),
            instructions: &InstructionBundle::default(),
            commands: &commands,
            skills: &SkillCatalog::default(),
            selected_skill: None,
            user_input: "/review src/main.rs",
            memory_content: None,
        })
        .unwrap();

        assert!(assembly.final_prompt.contains("Task: src/main.rs"));
        assert!(assembly.final_prompt.contains("<injected-file"));
        assert!(assembly
            .final_prompt
            .contains("<shell-approval required=\"true\">git status</shell-approval>"));
        assert_eq!(
            assembly.pending_shell_commands,
            vec!["git status".to_string()]
        );
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gcd-{}-{}", label, unique))
    }
}
