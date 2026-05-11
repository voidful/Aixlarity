use std::env;

use super::types::{ProviderFamily, ProviderProfile, ProviderProtocol, ProviderSource};

pub(super) const DEFAULT_PROVIDER_ID: &str = "openai-codex";

pub fn builtin_provider(id: &str) -> Option<ProviderProfile> {
    let normalized = normalize_provider_id(id);
    built_in_profiles()
        .into_iter()
        .find(|profile| profile.id == normalized)
}

pub(super) fn built_in_profiles() -> Vec<ProviderProfile> {
    vec![
        ProviderProfile {
            id: "openai-codex".to_string(),
            family: ProviderFamily::OpenAiCompatible,
            protocol: ProviderProtocol::OpenAiResponses,
            label: "Codex API".to_string(),
            api_base: "https://api.openai.com/v1".to_string(),
            api_key_env: "OPENAI_API_KEY".to_string(),
            model: "codex-latest".to_string(),
            best_for: "agentic coding, repository instructions, and patch planning".to_string(),
            strengths: vec![
                "Great default for coding-agent workflows".to_string(),
                "Natural fit for AGENTS.md-style repository instructions".to_string(),
                "Strong foundation for edit-and-verify loops".to_string(),
            ],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::BuiltIn,
        },
        ProviderProfile {
            id: "gemini-official".to_string(),
            family: ProviderFamily::Gemini,
            protocol: ProviderProtocol::GeminiGenerateContent,
            label: "Gemini API".to_string(),
            api_base: "https://generativelanguage.googleapis.com".to_string(),
            api_key_env: "GEMINI_API_KEY".to_string(),
            model: "gemini-2.5-pro".to_string(),
            best_for: "multimodal coding workflows, huge context, and search-grounded planning"
                .to_string(),
            strengths: vec![
                "Large context for repo-wide prompt assembly".to_string(),
                "Strong multimodal support".to_string(),
                "Grounding-friendly design".to_string(),
            ],
            supports_multimodal: true,
            supports_grounding: true,
            source: ProviderSource::BuiltIn,
        },
        ProviderProfile {
            id: "claude-official".to_string(),
            family: ProviderFamily::Anthropic,
            protocol: ProviderProtocol::AnthropicMessages,
            label: "Claude API".to_string(),
            api_base: "https://api.anthropic.com".to_string(),
            api_key_env: "ANTHROPIC_API_KEY".to_string(),
            model: "claude-sonnet-4.5".to_string(),
            best_for: "deep code review, long edits, and skill-driven orchestration".to_string(),
            strengths: vec![
                "Very strong code review quality".to_string(),
                "Pairs well with reusable skill packs".to_string(),
                "Good at long-form reasoning across files".to_string(),
            ],
            supports_multimodal: true,
            supports_grounding: false,
            source: ProviderSource::BuiltIn,
        },
        ProviderProfile {
            id: "engine-claude-code".to_string(),
            family: ProviderFamily::ExternalCli,
            protocol: ProviderProtocol::ExternalCliStream,
            label: "Claude CLI".to_string(),
            api_base: "local".to_string(),
            api_key_env: "".to_string(),
            model: "claude".to_string(),
            best_for: "Delegating execution to Anthropic's official Claude Code CLI".to_string(),
            strengths: vec![
                "Uses native Claude Code npm binary".to_string(),
                "Bridged directly into Aixlarity".to_string(),
            ],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::BuiltIn,
        },
        ProviderProfile {
            id: "engine-openai-codex".to_string(),
            family: ProviderFamily::ExternalCli,
            protocol: ProviderProtocol::ExternalCliStream,
            label: "Codex CLI".to_string(),
            api_base: "local".to_string(),
            api_key_env: "".to_string(),
            model: "codex".to_string(),
            best_for: "Delegating execution to OpenAI Codex CLI".to_string(),
            strengths: vec!["Runs Codex exec in headless mode".to_string()],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::BuiltIn,
        },
        ProviderProfile {
            id: "engine-google-gemini".to_string(),
            family: ProviderFamily::ExternalCli,
            protocol: ProviderProtocol::ExternalCliStream,
            label: "Gemini CLI".to_string(),
            api_base: "local".to_string(),
            api_key_env: "".to_string(),
            model: "gemini".to_string(),
            best_for: "Delegating execution to Gemini CLI".to_string(),
            strengths: vec!["Spawns Google Gemini in the background".to_string()],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::BuiltIn,
        },
    ]
}

pub(super) fn env_profiles() -> Vec<ProviderProfile> {
    let mut profiles = Vec::new();

    if let Some(profile) = openai_env_profile() {
        profiles.push(profile);
    }
    if let Some(profile) = gemini_env_profile() {
        profiles.push(profile);
    }
    if let Some(profile) = anthropic_env_profile() {
        profiles.push(profile);
    }

    profiles
}

pub(super) fn normalize_provider_id(id: &str) -> String {
    match id.trim().to_ascii_lowercase().as_str() {
        "openai" | "codex" | "openai-codex" => "openai-codex".to_string(),
        "openai-env" => "openai-env".to_string(),
        "gemini" | "gemini-official" => "gemini-official".to_string(),
        "gemini-env" => "gemini-env".to_string(),
        "claude" | "anthropic" | "claude-official" => "claude-official".to_string(),
        "anthropic-env" => "anthropic-env".to_string(),
        other => other.to_string(),
    }
}

pub(super) fn mask_secret(value: &str) -> String {
    if value.len() <= 8 {
        return "********".to_string();
    }
    format!("{}...{}", &value[..4], &value[value.len() - 4..])
}

pub(super) fn fallback_model(family: &ProviderFamily) -> &'static str {
    match family {
        ProviderFamily::Gemini => "gemini-2.5-pro",
        ProviderFamily::OpenAiCompatible => "codex-latest",
        ProviderFamily::Anthropic => "claude-sonnet-4.5",
        ProviderFamily::ExternalCli => "",
    }
}

fn openai_env_profile() -> Option<ProviderProfile> {
    if !env_flag("CLAUDE_CODE_USE_OPENAI")
        && !any_env_present(&[
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_API_BASE",
            "OPENAI_MODEL",
            "CODEANY_API_KEY",
            "CODEANY_BASE_URL",
            "CODEANY_MODEL",
        ])
    {
        return None;
    }

    let api_base = first_env_value(&["OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEANY_BASE_URL"])
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let api_key_env = if env_has_value("CODEANY_API_KEY") {
        "CODEANY_API_KEY"
    } else if api_base.contains("openrouter.ai") && env_has_value("OPENROUTER_API_KEY") {
        "OPENROUTER_API_KEY"
    } else {
        "OPENAI_API_KEY"
    };
    let model = first_env_value(&["OPENAI_MODEL", "CODEANY_MODEL"])
        .unwrap_or_else(|| "codex-latest".to_string());

    Some(ProviderProfile {
        id: "openai-env".to_string(),
        family: ProviderFamily::OpenAiCompatible,
        protocol: ProviderProtocol::OpenAiResponses,
        label: "OpenAI Compatible (Env)".to_string(),
        api_base,
        api_key_env: api_key_env.to_string(),
        model,
        best_for: "environment-driven OpenAI-compatible routing and Codex-style agent workflows"
            .to_string(),
        strengths: vec![
            "Compatible with OPENAI_* and CODEANY_* environment variables".to_string(),
            "Helpful for headless scripting and provider swaps".to_string(),
        ],
        supports_multimodal: false,
        supports_grounding: false,
        source: ProviderSource::Environment,
    })
}

fn gemini_env_profile() -> Option<ProviderProfile> {
    if !any_env_present(&[
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_BASE_URL",
        "GEMINI_MODEL",
    ]) {
        return None;
    }

    Some(ProviderProfile {
        id: "gemini-env".to_string(),
        family: ProviderFamily::Gemini,
        protocol: ProviderProtocol::GeminiGenerateContent,
        label: "Gemini API (Env)".to_string(),
        api_base: first_env_value(&["GEMINI_BASE_URL"])
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string()),
        api_key_env: if env_has_value("GOOGLE_API_KEY") {
            "GOOGLE_API_KEY".to_string()
        } else {
            "GEMINI_API_KEY".to_string()
        },
        model: first_env_value(&["GEMINI_MODEL"]).unwrap_or_else(|| "gemini-2.5-pro".to_string()),
        best_for: "environment-driven Gemini workflows with multimodal and long-context prompts"
            .to_string(),
        strengths: vec![
            "Picks up common Gemini environment variables automatically".to_string(),
            "Good fit for large prompt assemblies and multimodal review".to_string(),
        ],
        supports_multimodal: true,
        supports_grounding: true,
        source: ProviderSource::Environment,
    })
}

fn anthropic_env_profile() -> Option<ProviderProfile> {
    if !any_env_present(&["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]) {
        return None;
    }

    Some(ProviderProfile {
        id: "anthropic-env".to_string(),
        family: ProviderFamily::Anthropic,
        protocol: ProviderProtocol::AnthropicMessages,
        label: "Claude API (Env)".to_string(),
        api_base: first_env_value(&["ANTHROPIC_BASE_URL"])
            .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
        api_key_env: "ANTHROPIC_API_KEY".to_string(),
        model: first_env_value(&["ANTHROPIC_MODEL"])
            .unwrap_or_else(|| "claude-sonnet-4.5".to_string()),
        best_for: "environment-driven Claude review and long-edit workflows".to_string(),
        strengths: vec![
            "Picks up common Anthropic environment variables automatically".to_string(),
            "Useful for review-heavy and skill-driven sessions".to_string(),
        ],
        supports_multimodal: true,
        supports_grounding: false,
        source: ProviderSource::Environment,
    })
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| parse_bool(&value).unwrap_or(false))
        .unwrap_or(false)
}

fn env_has_value(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn any_env_present(names: &[&str]) -> bool {
    names.iter().any(|name| env_has_value(name))
}

fn first_env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}
