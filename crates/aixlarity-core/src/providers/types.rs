use std::path::PathBuf;

use crate::config::display_path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderFamily {
    Gemini,
    OpenAiCompatible,
    Anthropic,
    ExternalCli,
}

impl ProviderFamily {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gemini" | "google-gemini" => Some(Self::Gemini),
            "openai" | "codex" | "openai-compatible" | "openai_compatible" => {
                Some(Self::OpenAiCompatible)
            }
            "anthropic" | "claude" => Some(Self::Anthropic),
            "external-cli" | "external_cli" | "cli" | "engine" => Some(Self::ExternalCli),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::OpenAiCompatible => "openai-compatible",
            Self::Anthropic => "anthropic",
            Self::ExternalCli => "external-cli",
        }
    }

    pub fn default_protocol(&self) -> ProviderProtocol {
        match self {
            Self::Gemini => ProviderProtocol::GeminiGenerateContent,
            Self::OpenAiCompatible => ProviderProtocol::OpenAiResponses,
            Self::Anthropic => ProviderProtocol::AnthropicMessages,
            Self::ExternalCli => ProviderProtocol::ExternalCliStream,
        }
    }

    pub(crate) fn default_key_env(&self) -> &'static str {
        match self {
            Self::Gemini => "GEMINI_API_KEY",
            Self::OpenAiCompatible => "OPENAI_API_KEY",
            Self::Anthropic => "ANTHROPIC_API_KEY",
            Self::ExternalCli => "",
        }
    }

    pub fn default_multimodal(&self) -> bool {
        match self {
            Self::Gemini => true,
            Self::OpenAiCompatible => false,
            Self::Anthropic => true,
            Self::ExternalCli => true,
        }
    }

    pub fn default_grounding(&self) -> bool {
        matches!(self, Self::Gemini)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderProtocol {
    GeminiGenerateContent,
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
    ExternalCliStream,
}

impl ProviderProtocol {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gemini" | "gemini-generate-content" | "generate-content" => {
                Some(Self::GeminiGenerateContent)
            }
            "openai-responses" | "responses" => Some(Self::OpenAiResponses),
            "openai-chat" | "chat-completions" | "openai-chat-completions" => {
                Some(Self::OpenAiChatCompletions)
            }
            "anthropic" | "anthropic-messages" | "messages" => Some(Self::AnthropicMessages),
            "external" | "cli" | "external-cli-stream" => Some(Self::ExternalCliStream),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GeminiGenerateContent => "gemini-generate-content",
            Self::OpenAiResponses => "openai-responses",
            Self::OpenAiChatCompletions => "openai-chat-completions",
            Self::AnthropicMessages => "anthropic-messages",
            Self::ExternalCliStream => "external-cli-stream",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderScope {
    Global,
    Workspace,
}

impl ProviderScope {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "global" | "user" | "profile" => Some(Self::Global),
            "workspace" | "project" | "local" => Some(Self::Workspace),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace => "workspace",
        }
    }
}

#[derive(Clone, Debug)]
pub enum ProviderSource {
    BuiltIn,
    Environment,
    GlobalConfig(PathBuf),
    WorkspaceConfig(PathBuf),
}

impl ProviderSource {
    pub fn label(&self) -> String {
        match self {
            Self::BuiltIn => "built-in".to_string(),
            Self::Environment => "environment overrides".to_string(),
            Self::GlobalConfig(path) => format!("global config ({})", display_path(path)),
            Self::WorkspaceConfig(path) => format!("workspace config ({})", display_path(path)),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::BuiltIn => "built-in",
            Self::Environment => "environment",
            Self::GlobalConfig(_) => "global",
            Self::WorkspaceConfig(_) => "workspace",
        }
    }

    pub fn scope(&self) -> &'static str {
        match self {
            Self::WorkspaceConfig(_) => "workspace",
            Self::BuiltIn | Self::Environment | Self::GlobalConfig(_) => "global",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProviderProfile {
    pub id: String,
    pub family: ProviderFamily,
    pub protocol: ProviderProtocol,
    pub label: String,
    pub api_base: String,
    pub api_key_env: String,
    pub model: String,
    pub best_for: String,
    pub strengths: Vec<String>,
    pub supports_multimodal: bool,
    pub supports_grounding: bool,
    pub source: ProviderSource,
}

#[derive(Clone, Debug)]
pub struct ProviderDoctor {
    pub profile: ProviderProfile,
    pub active_scope: &'static str,
    pub api_key_present: bool,
    pub masked_api_key: Option<String>,
}
