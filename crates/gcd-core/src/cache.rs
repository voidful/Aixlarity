// GemiClawDex — Token Cache
//
// File-based prompt/response caching using content hashing.
// Cache keys are derived from (provider_id, model, prompt_hash, tool_names).
// Stored in `.gcd/cache/` with automatic TTL-based expiration.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Default cache TTL: 24 hours
const DEFAULT_TTL_SECS: u64 = 86400;

/// Maximum cache entries before cleanup
const MAX_CACHE_ENTRIES: usize = 500;

/// A cached response entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub cache_key: String,
    pub provider_id: String,
    pub model: String,
    pub prompt_hash: u64,
    pub response: String,
    pub created_at: u64,
    pub ttl_secs: u64,
}

impl CacheEntry {
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now > self.created_at + self.ttl_secs
    }
}

/// Build a deterministic cache key from request parameters.
pub fn build_cache_key(
    provider_id: &str,
    model: &str,
    prompt: &str,
    tool_names: &[String],
) -> String {
    let mut hasher = DefaultHasher::new();
    provider_id.hash(&mut hasher);
    model.hash(&mut hasher);
    prompt.hash(&mut hasher);
    for name in tool_names {
        name.hash(&mut hasher);
    }
    let hash = hasher.finish();
    format!("gcd-cache-{:016x}", hash)
}

/// Compute a hash of the prompt content for storage.
pub fn prompt_hash(prompt: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    prompt.hash(&mut hasher);
    hasher.finish()
}

/// Look up a cached response. Returns `None` if not found or expired.
pub fn cache_lookup(cache_dir: &Path, key: &str) -> Option<CacheEntry> {
    let path = cache_dir.join(format!("{}.json", key));
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let entry: CacheEntry = serde_json::from_str(&content).ok()?;
    if entry.is_expired() {
        let _ = fs::remove_file(&path);
        return None;
    }
    Some(entry)
}

/// Store a response in the cache.
pub fn cache_store(
    cache_dir: &Path,
    key: &str,
    provider_id: &str,
    model: &str,
    prompt: &str,
    response: &str,
) -> io::Result<()> {
    fs::create_dir_all(cache_dir)?;

    let entry = CacheEntry {
        cache_key: key.to_string(),
        provider_id: provider_id.to_string(),
        model: model.to_string(),
        prompt_hash: prompt_hash(prompt),
        response: response.to_string(),
        created_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        ttl_secs: DEFAULT_TTL_SECS,
    };

    let content = serde_json::to_string_pretty(&entry).map_err(|err| {
        io::Error::new(io::ErrorKind::InvalidData, format!("serialize cache: {}", err))
    })?;
    fs::write(cache_dir.join(format!("{}.json", key)), content)
}

/// Remove expired entries and enforce max cache size.
pub fn cache_cleanup(cache_dir: &Path) -> io::Result<usize> {
    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut entries: Vec<(PathBuf, u64)> = Vec::new();
    let mut removed = 0usize;

    for entry in fs::read_dir(cache_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        match fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<CacheEntry>(&c).ok())
        {
            Some(cached) if cached.is_expired() => {
                let _ = fs::remove_file(&path);
                removed += 1;
            }
            Some(cached) => {
                entries.push((path, cached.created_at));
            }
            None => {
                let _ = fs::remove_file(&path);
                removed += 1;
            }
        }
    }

    // Enforce max entries by removing oldest
    if entries.len() > MAX_CACHE_ENTRIES {
        entries.sort_by_key(|(_, ts)| *ts);
        let to_remove = entries.len() - MAX_CACHE_ENTRIES;
        for (path, _) in entries.iter().take(to_remove) {
            let _ = fs::remove_file(path);
            removed += 1;
        }
    }

    Ok(removed)
}

/// Get the default cache directory for a workspace.
pub fn workspace_cache_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".gcd").join("cache")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_cache_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gcd-cache-test-{}", unique))
    }

    #[test]
    fn cache_key_is_deterministic() {
        let key1 = build_cache_key("gemini", "gemini-2.5-pro", "hello", &["read_file".into()]);
        let key2 = build_cache_key("gemini", "gemini-2.5-pro", "hello", &["read_file".into()]);
        assert_eq!(key1, key2);
    }

    #[test]
    fn cache_key_differs_for_different_inputs() {
        let key1 = build_cache_key("gemini", "gemini-2.5-pro", "hello", &[]);
        let key2 = build_cache_key("gemini", "gemini-2.5-pro", "world", &[]);
        assert_ne!(key1, key2);
    }

    #[test]
    fn cache_store_and_lookup_round_trip() {
        let dir = test_cache_dir();
        let key = "test-key-001";
        cache_store(&dir, key, "openai", "gpt-4o", "prompt text", "response text").unwrap();
        let entry = cache_lookup(&dir, key).expect("should find cached entry");
        assert_eq!(entry.response, "response text");
        assert_eq!(entry.provider_id, "openai");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_lookup_returns_none_for_missing_key() {
        let dir = test_cache_dir();
        assert!(cache_lookup(&dir, "nonexistent").is_none());
    }

    #[test]
    fn cache_cleanup_removes_expired_entries() {
        let dir = test_cache_dir();
        fs::create_dir_all(&dir).unwrap();
        // Write an expired entry manually
        let expired = CacheEntry {
            cache_key: "expired".to_string(),
            provider_id: "test".to_string(),
            model: "test".to_string(),
            prompt_hash: 0,
            response: "old".to_string(),
            created_at: 0, // epoch = definitely expired
            ttl_secs: 1,
        };
        let content = serde_json::to_string(&expired).unwrap();
        fs::write(dir.join("expired.json"), content).unwrap();
        let removed = cache_cleanup(&dir).unwrap();
        assert_eq!(removed, 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
