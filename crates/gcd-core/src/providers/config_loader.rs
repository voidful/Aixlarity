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

    let content = fs::read_to_string(path)?;
    let mut providers = Vec::new();
    let mut current_id: Option<String> = None;
    let mut current_values = BTreeMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(id) = parse_provider_section(trimmed) {
            if let Some(previous_id) = current_id.take() {
                providers.push(build_profile(previous_id, &current_values, source.clone())?);
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
        providers.push(build_profile(id, &current_values, source)?);
    }

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
