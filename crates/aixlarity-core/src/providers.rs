use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

use crate::config::AppPaths;
use crate::trust::TrustState;
use crate::workspace::Workspace;

mod config_loader;
mod profiles;
mod types;

use config_loader::{parse_provider_config, read_optional_trimmed, write_provider_config};
use profiles::{
    built_in_profiles, env_profiles, mask_secret, normalize_provider_id, DEFAULT_PROVIDER_ID,
};

pub use profiles::builtin_provider;
pub use types::{
    ProviderDoctor, ProviderFamily, ProviderProfile, ProviderProtocol, ProviderScope,
    ProviderSource,
};

fn source_matches(left: &ProviderSource, right: &ProviderSource) -> bool {
    match (left, right) {
        (ProviderSource::GlobalConfig(left), ProviderSource::GlobalConfig(right))
        | (ProviderSource::WorkspaceConfig(left), ProviderSource::WorkspaceConfig(right)) => {
            left == right
        }
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub struct ProviderRegistry {
    profiles: Vec<ProviderProfile>,
    active_global: Option<String>,
    active_workspace: Option<String>,
    global_active_path: PathBuf,
    workspace_active_path: PathBuf,
    global_registry_path: PathBuf,
    workspace_registry_path: PathBuf,
}

impl ProviderRegistry {
    pub fn load(paths: &AppPaths, workspace: &Workspace, trust: &TrustState) -> io::Result<Self> {
        let global_registry_path = paths.global_provider_registry_path();
        let workspace_registry_path = workspace.local_data_dir().join("providers.conf");
        let global_active_path = paths.global_active_provider_path();
        let workspace_active_path = workspace.local_data_dir().join("active-provider.txt");

        let mut providers = BTreeMap::new();
        for profile in built_in_profiles() {
            providers.insert(profile.id.clone(), profile);
        }
        for profile in env_profiles() {
            providers.insert(profile.id.clone(), profile);
        }
        for profile in parse_provider_config(
            &global_registry_path,
            ProviderSource::GlobalConfig(global_registry_path.clone()),
        )? {
            providers.insert(profile.id.clone(), profile);
        }

        if !trust.restricts_project_config() {
            for profile in parse_provider_config(
                &workspace_registry_path,
                ProviderSource::WorkspaceConfig(workspace_registry_path.clone()),
            )? {
                providers.insert(profile.id.clone(), profile);
            }
        }

        let profiles = providers.into_values().collect::<Vec<_>>();
        let active_global = read_optional_trimmed(&global_active_path)?;
        let active_workspace = if trust.restricts_project_config() {
            None
        } else {
            read_optional_trimmed(&workspace_active_path)?
        };

        Ok(Self {
            profiles,
            active_global,
            active_workspace,
            global_active_path,
            workspace_active_path,
            global_registry_path,
            workspace_registry_path,
        })
    }

    pub fn profiles(&self) -> &[ProviderProfile] {
        &self.profiles
    }

    pub fn current_profile(&self, preferred_id: Option<&str>) -> io::Result<ProviderProfile> {
        self.resolve_profile(None, preferred_id)
    }

    pub fn resolve_profile(
        &self,
        explicit_id: Option<&str>,
        preferred_id: Option<&str>,
    ) -> io::Result<ProviderProfile> {
        let candidates = [
            explicit_id,
            preferred_id,
            self.active_workspace.as_deref(),
            self.active_global.as_deref(),
            Some(DEFAULT_PROVIDER_ID),
        ];

        for value in candidates.iter().flatten() {
            if let Some(profile) = self.find(value) {
                return Ok(profile.clone());
            }
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no provider profiles are available",
        ))
    }

    pub fn find(&self, id: &str) -> Option<&ProviderProfile> {
        let normalized = normalize_provider_id(id);
        self.profiles
            .iter()
            .find(|profile| profile.id == normalized)
    }

    pub fn set_active(&mut self, id: &str, scope: ProviderScope) -> io::Result<ProviderProfile> {
        let profile = self.find(id).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("unknown provider: {}", id))
        })?;
        let normalized = profile.id.clone();
        let target = match scope {
            ProviderScope::Global => &self.global_active_path,
            ProviderScope::Workspace => &self.workspace_active_path,
        };

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, format!("{}\n", normalized))?;

        match scope {
            ProviderScope::Global => self.active_global = Some(normalized),
            ProviderScope::Workspace => self.active_workspace = Some(normalized),
        }

        Ok(profile)
    }

    pub fn doctor(
        &self,
        id: Option<&str>,
        preferred_id: Option<&str>,
    ) -> io::Result<ProviderDoctor> {
        let profile = match id {
            Some(id) => self.find(id).cloned().ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, format!("unknown provider: {}", id))
            })?,
            None => self.current_profile(preferred_id)?,
        };
        let key = env::var(&profile.api_key_env)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Ok(ProviderDoctor {
            profile,
            active_scope: if self.active_workspace.is_some() {
                "workspace"
            } else if self.active_global.is_some() {
                "global"
            } else {
                "default"
            },
            api_key_present: key.is_some(),
            masked_api_key: key.as_ref().map(|value| mask_secret(value)),
        })
    }

    pub fn active_global(&self) -> Option<&str> {
        self.active_global.as_deref()
    }

    pub fn active_workspace(&self) -> Option<&str> {
        self.active_workspace.as_deref()
    }

    pub fn add_provider(&mut self, profile: ProviderProfile) -> io::Result<ProviderProfile> {
        self.add_provider_scoped(profile, ProviderScope::Global)
    }

    pub fn add_provider_scoped(
        &mut self,
        mut profile: ProviderProfile,
        scope: ProviderScope,
    ) -> io::Result<ProviderProfile> {
        profile.id = normalize_provider_id(&profile.id);

        if let Some(existing) = self.profiles.iter().find(|p| p.id == profile.id) {
            match existing.source {
                ProviderSource::BuiltIn | ProviderSource::Environment => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "cannot override built-in or environment provider: {}",
                            profile.id
                        ),
                    ));
                }
                _ => {}
            }
        }

        let (target_registry_path, target_source) = match scope {
            ProviderScope::Global => (
                self.global_registry_path.clone(),
                ProviderSource::GlobalConfig(self.global_registry_path.clone()),
            ),
            ProviderScope::Workspace => (
                self.workspace_registry_path.clone(),
                ProviderSource::WorkspaceConfig(self.workspace_registry_path.clone()),
            ),
        };
        profile.source = target_source.clone();

        let mut existing_targets: Vec<ProviderProfile> = self
            .profiles
            .iter()
            .filter(|p| source_matches(&p.source, &target_source))
            .cloned()
            .collect();

        let mut replaced = false;
        for entry in existing_targets.iter_mut() {
            if entry.id == profile.id {
                *entry = profile.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            existing_targets.push(profile.clone());
        }

        let refs: Vec<&ProviderProfile> = existing_targets.iter().collect();
        write_provider_config(&target_registry_path, &refs)?;

        for slot in self.profiles.iter_mut() {
            if slot.id == profile.id {
                *slot = profile.clone();
                return Ok(profile);
            }
        }
        // New provider — add to in-memory list so subsequent operations
        // (remove, find, set_active) work without reloading from disk.
        self.profiles.push(profile.clone());
        Ok(profile)
    }

    pub fn update_model(&mut self, id: &str, model: &str) -> io::Result<ProviderProfile> {
        let model = model.trim();
        if model.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "provider model must not be empty",
            ));
        }

        let profile = self.find(id).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("unknown provider: {}", id))
        })?;

        let mut new_profile = profile.clone();
        new_profile.model = model.to_string();
        let (target_registry_path, target_source) = match &profile.source {
            ProviderSource::WorkspaceConfig(path) => {
                (path.clone(), ProviderSource::WorkspaceConfig(path.clone()))
            }
            ProviderSource::GlobalConfig(path) => {
                (path.clone(), ProviderSource::GlobalConfig(path.clone()))
            }
            ProviderSource::BuiltIn | ProviderSource::Environment => (
                self.global_registry_path.clone(),
                ProviderSource::GlobalConfig(self.global_registry_path.clone()),
            ),
        };
        new_profile.source = target_source.clone();

        let mut existing_targets: Vec<ProviderProfile> = self
            .profiles
            .iter()
            .filter(|p| source_matches(&p.source, &target_source))
            .cloned()
            .collect();

        let mut replaced = false;
        for entry in existing_targets.iter_mut() {
            if entry.id == new_profile.id {
                *entry = new_profile.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            existing_targets.push(new_profile.clone());
        }

        let refs: Vec<&ProviderProfile> = existing_targets.iter().collect();
        write_provider_config(&target_registry_path, &refs)?;

        for slot in self.profiles.iter_mut() {
            if slot.id == new_profile.id {
                *slot = new_profile.clone();
                return Ok(new_profile);
            }
        }
        self.profiles.push(new_profile.clone());
        Ok(new_profile)
    }

    pub async fn list_models(&self, id: &str) -> io::Result<Vec<String>> {
        let profile = self.find(id).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("unknown provider: {}", id))
        })?;

        let key = env::var(&profile.api_key_env).unwrap_or_default();
        if key.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("missing API key in {}", profile.api_key_env),
            ));
        }

        let client = reqwest::Client::new();

        match profile.family {
            ProviderFamily::OpenAiCompatible => {
                // OpenAI Models API: GET /v1/models
                // Auth: Bearer token. Returns all models in a single response (no pagination).
                // Response shape: { object: "list", data: [{id, ...}, ...] }
                // Reference: https://developers.openai.com/api/reference/resources/models/methods/list
                let url = if profile.api_base.ends_with("/v1") {
                    format!("{}/models", profile.api_base)
                } else if profile.api_base.ends_with('/') {
                    format!("{}models", profile.api_base)
                } else {
                    format!("{}/models", profile.api_base)
                };

                let resp = client
                    .get(&url)
                    .bearer_auth(key)
                    .send()
                    .await
                    .map_err(|e| io::Error::other(e.to_string()))?;

                if !resp.status().is_success() {
                    return Err(io::Error::other(format!("API error: {}", resp.status())));
                }

                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| io::Error::other(e.to_string()))?;
                let mut models = Vec::new();
                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                    for item in data {
                        if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                            models.push(id.to_string());
                        }
                    }
                }
                models.sort();
                Ok(models)
            }
            ProviderFamily::Gemini => {
                let url = if profile.api_base.ends_with('/') {
                    format!("{}v1beta/models?key={}", profile.api_base, key)
                } else {
                    format!("{}/v1beta/models?key={}", profile.api_base, key)
                };

                let resp = client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|e| io::Error::other(e.to_string()))?;

                if !resp.status().is_success() {
                    return Err(io::Error::other(format!("API error: {}", resp.status())));
                }

                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| io::Error::other(e.to_string()))?;
                let mut models = Vec::new();
                if let Some(data) = json.get("models").and_then(|d| d.as_array()) {
                    for item in data {
                        if let Some(name) = item.get("name").and_then(|i| i.as_str()) {
                            let clean_name = name.strip_prefix("models/").unwrap_or(name);
                            models.push(clean_name.to_string());
                        }
                    }
                }
                models.sort();
                Ok(models)
            }
            ProviderFamily::Anthropic => {
                // Anthropic Models API: GET /v1/models
                // Uses cursor-based pagination with `limit`, `after_id`, and `before_id`.
                // Response shape: { data: [{id, ...}], has_more: bool, first_id, last_id }
                // Reference: https://docs.anthropic.com/en/api/models-list
                let base_url = if profile.api_base.ends_with("/v1") {
                    format!("{}/models", profile.api_base)
                } else if profile.api_base.ends_with('/') {
                    format!("{}v1/models", profile.api_base)
                } else {
                    format!("{}/v1/models", profile.api_base)
                };

                let mut models = Vec::new();
                let mut after_id: Option<String> = None;

                loop {
                    let mut url = format!("{}?limit=100", base_url);
                    if let Some(ref cursor) = after_id {
                        url.push_str(&format!("&after_id={}", cursor));
                    }

                    let resp = client
                        .get(&url)
                        .header("x-api-key", &key)
                        .header("anthropic-version", "2023-06-01")
                        .send()
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;

                    if !resp.status().is_success() {
                        return Err(io::Error::other(format!("API error: {}", resp.status())));
                    }

                    let json: serde_json::Value = resp
                        .json()
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                        for item in data {
                            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                                models.push(id.to_string());
                            }
                        }
                    }

                    // Check if there are more pages
                    let has_more = json
                        .get("has_more")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if has_more {
                        after_id = json
                            .get("last_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        if after_id.is_none() {
                            break;
                        }
                    } else {
                        break;
                    }
                }

                models.sort();
                Ok(models)
            }
            ProviderFamily::ExternalCli => {
                // External CLIs don't have an API to list models, return the configured model
                Ok(vec![profile.model.clone()])
            }
        }
    }

    pub fn remove_provider(&mut self, id: &str) -> io::Result<()> {
        self.remove_provider_scoped(id, ProviderScope::Global)
    }

    pub fn remove_provider_scoped(&mut self, id: &str, scope: ProviderScope) -> io::Result<()> {
        let normalized = normalize_provider_id(id);
        let (target_registry_path, target_source, active_id) = match scope {
            ProviderScope::Global => (
                self.global_registry_path.clone(),
                ProviderSource::GlobalConfig(self.global_registry_path.clone()),
                self.active_global.as_deref(),
            ),
            ProviderScope::Workspace => (
                self.workspace_registry_path.clone(),
                ProviderSource::WorkspaceConfig(self.workspace_registry_path.clone()),
                self.active_workspace.as_deref(),
            ),
        };

        if active_id == Some(normalized.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "cannot remove active {} provider {}; switch providers first",
                    scope.as_str(),
                    normalized
                ),
            ));
        }

        let matches_target = self
            .profiles
            .iter()
            .any(|p| p.id == normalized && source_matches(&p.source, &target_source));
        if !matches_target {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "no custom {} provider with id {}; built-in and env providers cannot be removed",
                    scope.as_str(),
                    normalized
                ),
            ));
        }

        let remaining: Vec<ProviderProfile> = self
            .profiles
            .iter()
            .filter(|p| source_matches(&p.source, &target_source) && p.id != normalized)
            .cloned()
            .collect();

        let refs: Vec<&ProviderProfile> = remaining.iter().collect();
        write_provider_config(&target_registry_path, &refs)?;

        self.profiles
            .retain(|p| !(source_matches(&p.source, &target_source) && p.id == normalized));

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_provider_config, ProviderFamily, ProviderProfile, ProviderProtocol, ProviderRegistry,
        ProviderScope, ProviderSource,
    };
    use crate::config::AppPaths;
    use crate::trust::TrustState;
    use crate::workspace::Workspace;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_custom_provider_config() {
        let root = unique_dir("providers");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("providers.conf");
        fs::write(
            &path,
            "[provider \"openrouter-codex\"]\nlabel = \"OpenRouter Codex\"\nfamily = \"openai-compatible\"\nprotocol = \"openai-responses\"\napi_base = \"https://openrouter.ai/api/v1\"\napi_key_env = \"OPENROUTER_API_KEY\"\nmodel = \"openai/codex-mini-latest\"\nstrengths = \"relay routing | one key for multiple vendors\"\n",
        )
        .unwrap();

        let profiles =
            parse_provider_config(&path, ProviderSource::GlobalConfig(path.clone())).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "openrouter-codex");
        assert_eq!(profiles[0].family, ProviderFamily::OpenAiCompatible);
        assert_eq!(profiles[0].protocol, ProviderProtocol::OpenAiResponses);
        assert_eq!(profiles[0].strengths.len(), 2);
    }

    #[test]
    fn workspace_active_provider_overrides_global() {
        let root = unique_dir("active");
        let workspace_root = root.clone();
        let workspace = Workspace {
            root: workspace_root.clone(),
            current_dir: workspace_root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        fs::create_dir_all(workspace.local_data_dir()).unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();

        fs::write(home.join("active-provider.txt"), "claude-official\n").unwrap();
        fs::write(
            workspace.local_data_dir().join("active-provider.txt"),
            "gemini-official\n",
        )
        .unwrap();

        let registry = ProviderRegistry::load(
            &AppPaths {
                current_dir: root,
                config_home: home,
            },
            &Workspace {
                root: workspace_root.clone(),
                current_dir: workspace_root,
                detected_by: ".aixlarity".to_string(),
            },
            &TrustState {
                kind: None,
                matched_path: None,
                trust_enabled: false,
            },
        )
        .unwrap();

        let current = registry.current_profile(None).unwrap();
        assert_eq!(current.id, "gemini-official");
    }

    #[test]
    fn set_active_persists_workspace_provider() {
        let root = unique_dir("persist");
        let workspace_root = root.clone();
        let workspace = Workspace {
            root: workspace_root.clone(),
            current_dir: workspace_root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        fs::create_dir_all(workspace.local_data_dir()).unwrap();
        fs::write(
            workspace.local_data_dir().join("providers.conf"),
            "[provider \"openrouter-codex\"]\nlabel = \"OpenRouter Codex\"\nfamily = \"openai-compatible\"\napi_base = \"https://openrouter.ai/api/v1\"\napi_key_env = \"OPENROUTER_API_KEY\"\nmodel = \"openai/codex-mini-latest\"\n",
        )
        .unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root,
            config_home: home,
        };
        let workspace = Workspace {
            root: workspace_root.clone(),
            current_dir: workspace_root,
            detected_by: ".aixlarity".to_string(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        registry
            .set_active("openrouter-codex", ProviderScope::Workspace)
            .unwrap();

        let reloaded = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let current = reloaded.current_profile(None).unwrap();
        assert_eq!(current.id, "openrouter-codex");
    }

    #[test]
    fn update_model_preserves_workspace_provider_source() {
        let root = unique_dir("update-workspace-provider");
        let workspace_root = root.clone();
        let workspace = Workspace {
            root: workspace_root.clone(),
            current_dir: workspace_root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        fs::create_dir_all(workspace.local_data_dir()).unwrap();
        let workspace_registry_path = workspace.local_data_dir().join("providers.conf");
        fs::write(
            &workspace_registry_path,
            "[provider \"openrouter-codex\"]\nlabel = \"OpenRouter Codex\"\nfamily = \"openai-compatible\"\napi_base = \"https://openrouter.ai/api/v1\"\napi_key_env = \"OPENROUTER_API_KEY\"\nmodel = \"openai/codex-mini-latest\"\n",
        )
        .unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root.clone(),
            config_home: home,
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let updated = registry
            .update_model("openrouter-codex", "openai/codex-large")
            .unwrap();

        assert_eq!(updated.model, "openai/codex-large");
        let workspace_content = fs::read_to_string(&workspace_registry_path).unwrap();
        assert!(workspace_content.contains("model = \"openai/codex-large\""));
        assert!(!paths.global_provider_registry_path().exists());
        let reloaded = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        assert_eq!(
            reloaded.find("openrouter-codex").unwrap().model,
            "openai/codex-large"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_model_rejects_empty_model() {
        let root = unique_dir("update-empty-model");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root.clone(),
            config_home: home,
        };
        let workspace = Workspace {
            root: root.clone(),
            current_dir: root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let err = registry.update_model("openai-codex", "  ").unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("provider model must not be empty"));
        assert!(!paths.global_provider_registry_path().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_provider_writes_config_file() {
        let root = unique_dir("add-provider");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root.clone(),
            config_home: home.clone(),
        };
        let workspace = Workspace {
            root: root.clone(),
            current_dir: root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let profile = ProviderProfile {
            id: "test-provider".to_string(),
            family: ProviderFamily::Gemini,
            protocol: ProviderProtocol::GeminiGenerateContent,
            label: "Test Provider".to_string(),
            api_base: "https://test.example.com".to_string(),
            api_key_env: "TEST_API_KEY".to_string(),
            model: "gemini-2.0-flash".to_string(),
            best_for: "testing".to_string(),
            strengths: vec!["fast".to_string()],
            supports_multimodal: true,
            supports_grounding: false,
            source: ProviderSource::GlobalConfig(PathBuf::new()),
        };
        registry.add_provider(profile).unwrap();

        let config_path = paths.global_provider_registry_path();
        let content = fs::read_to_string(&config_path).unwrap();
        assert!(content.contains("[provider \"test-provider\"]"));
        assert!(content.contains("family = \"gemini\""));
        assert!(content.contains("api_base = \"https://test.example.com\""));
    }

    #[test]
    fn add_provider_scoped_writes_workspace_config_file() {
        let root = unique_dir("add-workspace-provider");
        let workspace = Workspace {
            root: root.clone(),
            current_dir: root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        let workspace_data_dir = workspace.local_data_dir();
        let workspace_config_path = workspace_data_dir.join("providers.conf");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root.clone(),
            config_home: home.clone(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let profile = ProviderProfile {
            id: "team-provider".to_string(),
            family: ProviderFamily::OpenAiCompatible,
            protocol: ProviderProtocol::OpenAiResponses,
            label: "Team Provider".to_string(),
            api_base: "https://team.example.com/v1".to_string(),
            api_key_env: "TEAM_API_KEY".to_string(),
            model: "team-model".to_string(),
            best_for: "workspace team config".to_string(),
            strengths: vec![],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::GlobalConfig(PathBuf::new()),
        };

        let stored = registry
            .add_provider_scoped(profile, ProviderScope::Workspace)
            .unwrap();

        assert_eq!(stored.source.scope(), "workspace");
        assert!(workspace_config_path.exists());
        assert!(!paths.global_provider_registry_path().exists());
        let content = fs::read_to_string(&workspace_config_path).unwrap();
        assert!(content.contains("[provider \"team-provider\"]"));
        assert!(content.contains("api_base = \"https://team.example.com/v1\""));

        let _ = fs::remove_dir_all(workspace_data_dir);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_provider_removes_from_config() {
        let root = unique_dir("remove-provider");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            current_dir: root.clone(),
            config_home: home.clone(),
        };
        let workspace = Workspace {
            root: root.clone(),
            current_dir: root.clone(),
            detected_by: ".aixlarity".to_string(),
        };
        let trust = TrustState {
            kind: None,
            matched_path: None,
            trust_enabled: false,
        };

        // Add first
        let mut registry = ProviderRegistry::load(&paths, &workspace, &trust).unwrap();
        let profile = ProviderProfile {
            id: "temp-provider".to_string(),
            family: ProviderFamily::OpenAiCompatible,
            protocol: ProviderProtocol::OpenAiResponses,
            label: "Temp".to_string(),
            api_base: "https://temp.example.com".to_string(),
            api_key_env: "TEMP_KEY".to_string(),
            model: "temp-model".to_string(),
            best_for: "test".to_string(),
            strengths: vec![],
            supports_multimodal: false,
            supports_grounding: false,
            source: ProviderSource::GlobalConfig(PathBuf::new()),
        };
        registry.add_provider(profile).unwrap();

        let config_path = paths.global_provider_registry_path();
        let after_add = fs::read_to_string(&config_path).unwrap();
        assert!(after_add.contains("temp-provider"));

        // Remove
        registry.remove_provider("temp-provider").unwrap();
        let after_remove = fs::read_to_string(&config_path).unwrap();
        assert!(!after_remove.contains("temp-provider"));
        // No orphan lines left
        assert!(!after_remove.contains("api_base"));
    }

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-{}-{}", label, stamp))
    }
}
