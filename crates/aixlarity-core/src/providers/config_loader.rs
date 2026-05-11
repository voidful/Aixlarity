use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use super::profiles::{fallback_model, normalize_provider_id};
use super::types::{ProviderFamily, ProviderProfile, ProviderProtocol, ProviderSource};

pub(super) fn read_optional_trimmed(path: &Path) -> io::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub(super) fn parse_provider_config(
    path: &Path,
    source: ProviderSource,
) -> io::Result<Vec<ProviderProfile>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[Aixlarity DEBUG] Failed to read provider config at {:?}: {}",
                path, e
            );
            return Err(e);
        }
    };
    eprintln!(
        "[Aixlarity DEBUG] Loaded config from {:?}, size: {}",
        path,
        content.len()
    );
    let mut providers = Vec::new();
    let mut current_id: Option<String> = None;
    let mut current_values = BTreeMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(id) = parse_provider_section(trimmed) {
            eprintln!("[Aixlarity DEBUG] Found provider section: {}", id);
            if let Some(previous_id) = current_id.take() {
                match build_profile(previous_id.clone(), &current_values, source.clone()) {
                    Ok(p) => providers.push(p),
                    Err(e) => {
                        eprintln!(
                            "[Aixlarity DEBUG] Failed to build profile {}: {}",
                            previous_id, e
                        )
                    }
                }
                current_values.clear();
            }
            current_id = Some(id);
            continue;
        }

        if let Some((key, value)) = parse_key_value(trimmed) {
            current_values.insert(key.to_string(), value);
        }
    }

    if let Some(id) = current_id {
        match build_profile(id.clone(), &current_values, source) {
            Ok(p) => providers.push(p),
            Err(e) => eprintln!(
                "[Aixlarity DEBUG] Failed to build final profile {}: {}",
                id, e
            ),
        }
    }

    eprintln!(
        "[Aixlarity DEBUG] parse_provider_config yielding {} providers",
        providers.len()
    );
    Ok(providers)
}

fn parse_provider_section(line: &str) -> Option<String> {
    if !line.starts_with("[provider ") || !line.ends_with(']') {
        return None;
    }
    let inner = line
        .trim_start_matches("[provider ")
        .trim_end_matches(']')
        .trim();
    parse_string_literal(inner)
}

fn parse_key_value(line: &str) -> Option<(&str, String)> {
    let mut parts = line.splitn(2, '=');
    let key = parts.next()?.trim();
    let raw_value = parts.next()?.trim();
    Some((key, parse_value(raw_value)))
}

fn parse_value(raw: &str) -> String {
    parse_string_literal(raw).unwrap_or_else(|| raw.to_string())
}

fn parse_string_literal(raw: &str) -> Option<String> {
    if !raw.starts_with('"') || !raw.ends_with('"') || raw.len() < 2 {
        return None;
    }
    let mut output = String::new();
    let mut escaped = false;
    for ch in raw[1..raw.len() - 1].chars() {
        if escaped {
            match ch {
                'n' => output.push('\n'),
                't' => output.push('\t'),
                '\\' => output.push('\\'),
                '"' => output.push('"'),
                other => output.push(other),
            }
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
        } else {
            output.push(ch);
        }
    }
    Some(output)
}

fn build_profile(
    id: String,
    values: &BTreeMap<String, String>,
    source: ProviderSource,
) -> io::Result<ProviderProfile> {
    let family = values
        .get("family")
        .and_then(|value| ProviderFamily::parse(value))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("provider {} is missing a valid family", id),
            )
        })?;
    let protocol = values
        .get("protocol")
        .and_then(|value| ProviderProtocol::parse(value))
        .unwrap_or_else(|| family.default_protocol());
    let label = values
        .get("label")
        .cloned()
        .unwrap_or_else(|| id.replace('-', " "));
    let api_base = values.get("api_base").cloned().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("provider {} is missing api_base", id),
        )
    })?;
    let api_key_env = values
        .get("api_key_env")
        .cloned()
        .unwrap_or_else(|| family.default_key_env().to_string());
    let model = values
        .get("model")
        .cloned()
        .unwrap_or_else(|| fallback_model(&family).to_string());
    let best_for = values
        .get("best_for")
        .cloned()
        .unwrap_or_else(|| "custom provider profile".to_string());
    let supports_multimodal = values
        .get("supports_multimodal")
        .and_then(|value| parse_bool(value))
        .unwrap_or_else(|| family.default_multimodal());
    let supports_grounding = values
        .get("supports_grounding")
        .and_then(|value| parse_bool(value))
        .unwrap_or_else(|| family.default_grounding());
    let strengths = values
        .get("strengths")
        .map(|value| {
            value
                .split('|')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ProviderProfile {
        id: normalize_provider_id(&id),
        family,
        protocol,
        label,
        api_base,
        api_key_env,
        model,
        best_for,
        strengths,
        supports_multimodal,
        supports_grounding,
        source,
    })
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn escape_string_literal(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

pub(super) fn write_provider_config(path: &Path, profiles: &[&ProviderProfile]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut buffer = String::new();
    let mut first = true;
    for profile in profiles {
        if !first {
            buffer.push('\n');
        }
        first = false;

        buffer.push_str(&format!(
            "[provider {}]\n",
            escape_string_literal(&profile.id)
        ));

        if !profile.label.is_empty() {
            buffer.push_str(&format!(
                "label = {}\n",
                escape_string_literal(&profile.label)
            ));
        }
        buffer.push_str(&format!(
            "family = {}\n",
            escape_string_literal(profile.family.as_str())
        ));
        if profile.protocol != profile.family.default_protocol() {
            buffer.push_str(&format!(
                "protocol = {}\n",
                escape_string_literal(profile.protocol.as_str())
            ));
        }
        if !profile.api_base.is_empty() {
            buffer.push_str(&format!(
                "api_base = {}\n",
                escape_string_literal(&profile.api_base)
            ));
        }
        if !profile.api_key_env.is_empty()
            && profile.api_key_env != profile.family.default_key_env()
        {
            buffer.push_str(&format!(
                "api_key_env = {}\n",
                escape_string_literal(&profile.api_key_env)
            ));
        }
        if !profile.model.is_empty() {
            buffer.push_str(&format!(
                "model = {}\n",
                escape_string_literal(&profile.model)
            ));
        }
        if !profile.best_for.is_empty() && profile.best_for != "custom provider profile" {
            buffer.push_str(&format!(
                "best_for = {}\n",
                escape_string_literal(&profile.best_for)
            ));
        }
        if profile.supports_multimodal != profile.family.default_multimodal() {
            buffer.push_str(&format!(
                "supports_multimodal = {}\n",
                profile.supports_multimodal
            ));
        }
        if profile.supports_grounding != profile.family.default_grounding() {
            buffer.push_str(&format!(
                "supports_grounding = {}\n",
                profile.supports_grounding
            ));
        }
        if !profile.strengths.is_empty() {
            buffer.push_str(&format!(
                "strengths = {}\n",
                escape_string_literal(&profile.strengths.join(" | "))
            ));
        }
    }

    fs::write(path, buffer)
}
