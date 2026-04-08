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

use config_loader::{parse_provider_config, read_optional_trimmed};
use profiles::{
    built_in_profiles, env_profiles, mask_secret, normalize_provider_id, DEFAULT_PROVIDER_ID,
};

pub use profiles::builtin_provider;
pub use types::{
    ProviderDoctor, ProviderFamily, ProviderProfile, ProviderProtocol, ProviderScope,
    ProviderSource,
};

#[derive(Clone, Debug)]
pub struct ProviderRegistry {
    profiles: Vec<ProviderProfile>,
    active_global: Option<String>,
    active_workspace: Option<String>,
    global_active_path: PathBuf,
    workspace_active_path: PathBuf,
}

impl ProviderRegistry {
    pub fn load(paths: &AppPaths, workspace: &Workspace, trust: &TrustState) -> io::Result<Self> {
        let global_registry_path = paths.global_provider_registry_path();
        let workspace_registry_path = workspace.root.join(".gcd").join("providers.conf");
        let global_active_path = paths.global_active_provider_path();
        let workspace_active_path = workspace.root.join(".gcd").join("active-provider.txt");

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
}

#[cfg(test)]
mod tests {
    use super::{
        parse_provider_config, ProviderFamily, ProviderProtocol, ProviderRegistry, ProviderScope,
        ProviderSource,
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
        fs::create_dir_all(root.join(".gcd")).unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let workspace_root = root.clone();

        fs::write(home.join("active-provider.txt"), "claude-official\n").unwrap();
        fs::write(
            root.join(".gcd").join("active-provider.txt"),
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
                detected_by: ".gcd".to_string(),
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
        fs::create_dir_all(root.join(".gcd")).unwrap();
        fs::write(
            root.join(".gcd").join("providers.conf"),
            "[provider \"openrouter-codex\"]\nlabel = \"OpenRouter Codex\"\nfamily = \"openai-compatible\"\napi_base = \"https://openrouter.ai/api/v1\"\napi_key_env = \"OPENROUTER_API_KEY\"\nmodel = \"openai/codex-mini-latest\"\n",
        )
        .unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let workspace_root = root.clone();
        let paths = AppPaths {
            current_dir: root,
            config_home: home,
        };
        let workspace = Workspace {
            root: workspace_root.clone(),
            current_dir: workspace_root,
            detected_by: ".gcd".to_string(),
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

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gcd-{}-{}", label, stamp))
    }
}
