use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryTransaction {
    pub id: String,
    pub timestamp_sec: u64,
    pub tool_name: String,
    pub source: String, // "agent" or "user"
    pub file_path: String,
    // The hash of the file blob in `.aixlarity/history/blobs/` before this change.
    // If the file did not exist, this is None.
    pub before_hash: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryLog {
    transactions: Vec<HistoryTransaction>,
}

pub struct HistoryStore {
    base_dir: PathBuf,
    workspace_root: PathBuf,
}

impl HistoryStore {
    pub fn new(workspace_root: &Path) -> Self {
        let workspace =
            crate::workspace::Workspace::discover(workspace_root).unwrap_or_else(|_| {
                crate::workspace::Workspace {
                    root: workspace_root.to_path_buf(),
                    current_dir: workspace_root.to_path_buf(),
                    detected_by: "fallback".to_string(),
                }
            });
        let workspace_root =
            fs::canonicalize(&workspace.root).unwrap_or_else(|_| workspace.root.clone());
        let base_dir = workspace.local_data_dir().join("history");
        Self {
            base_dir,
            workspace_root,
        }
    }

    fn blobs_dir(&self) -> PathBuf {
        self.base_dir.join("blobs")
    }

    fn log_path(&self) -> PathBuf {
        self.base_dir.join("transactions.json")
    }

    /// Captures the state of a file BEFORE mutating it, returning a transaction ID.
    pub fn snapshot_before(&self, tool_name: &str, file_path: &Path) -> std::io::Result<String> {
        fs::create_dir_all(self.blobs_dir())?;

        let before_hash = if file_path.exists() && file_path.is_file() {
            let content = fs::read(file_path)?;
            let hash = Self::compute_hash(&content);
            let blob_path = self.blobs_dir().join(&hash);
            if !blob_path.exists() {
                fs::write(&blob_path, content)?;
            }
            Some(hash)
        } else {
            None
        };

        let tx_id = format!(
            "tx_{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let tx = HistoryTransaction {
            id: tx_id.clone(),
            timestamp_sec: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            tool_name: tool_name.to_string(),
            source: "agent".to_string(),
            file_path: file_path.display().to_string(),
            before_hash,
        };

        self.append_transaction(tx)?;
        Ok(tx_id)
    }

    /// Captures the CURRENT state of a file, returning a transaction ID.
    /// Useful for tracking user saves or post-mutation states.
    pub fn snapshot_current(
        &self,
        source: &str,
        tool_name: &str,
        file_path: &Path,
    ) -> std::io::Result<String> {
        fs::create_dir_all(self.blobs_dir())?;

        let before_hash = if file_path.exists() && file_path.is_file() {
            let content = fs::read(file_path)?;
            let hash = Self::compute_hash(&content);
            let blob_path = self.blobs_dir().join(&hash);
            if !blob_path.exists() {
                fs::write(&blob_path, content)?;
            }
            Some(hash)
        } else {
            None
        };

        let tx_id = format!(
            "tx_{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let tx = HistoryTransaction {
            id: tx_id.clone(),
            timestamp_sec: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            tool_name: tool_name.to_string(),
            source: source.to_string(),
            file_path: file_path.display().to_string(),
            before_hash,
        };

        self.append_transaction(tx)?;
        Ok(tx_id)
    }

    /// Read the recent top N transactions
    pub fn get_recent_transactions(
        &self,
        limit: usize,
    ) -> std::io::Result<Vec<HistoryTransaction>> {
        let log = self.load_log()?;
        let tail: Vec<_> = log.transactions.into_iter().rev().take(limit).collect();
        Ok(tail)
    }

    /// Read all transactions for a specific file path
    pub fn get_file_revisions(&self, file_path: &str) -> std::io::Result<Vec<HistoryTransaction>> {
        let log = self.load_log()?;
        let revisions: Vec<_> = log
            .transactions
            .into_iter()
            .filter(|tx| tx.file_path == file_path)
            .collect();
        Ok(revisions)
    }

    /// Get the content of a specific blob hash
    pub fn get_blob(&self, hash: &str) -> std::io::Result<String> {
        if !Self::is_valid_blob_hash(hash) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid blob hash",
            ));
        }
        let blob_path = self.blobs_dir().join(hash);
        if blob_path.exists() {
            let content = fs::read_to_string(&blob_path)?;
            Ok(content)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Blob not found",
            ))
        }
    }

    /// Physically replaces the current file with the state identified by `tx_id`.
    pub fn revert_transaction(&self, tx_id: &str) -> anyhow::Result<()> {
        let log = self.load_log()?;
        let tx = log
            .transactions
            .iter()
            .find(|t| t.id == tx_id)
            .ok_or_else(|| anyhow::anyhow!("Transaction {} not found", tx_id))?;

        let target_path = self.resolve_workspace_file_path(&tx.file_path)?;

        match &tx.before_hash {
            Some(hash) => {
                if !Self::is_valid_blob_hash(hash) {
                    anyhow::bail!("Invalid blob hash {}", hash);
                }
                let blob_path = self.blobs_dir().join(hash);
                if !blob_path.exists() {
                    anyhow::bail!("Blob {} missing, cannot revert!", hash);
                }
                let blob_content = fs::read(&blob_path)?;
                if let Some(parent) = target_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&target_path, blob_content)?;
            }
            None => {
                // It didn't exist before, so we must delete it to revert.
                if target_path.exists() {
                    fs::remove_file(&target_path)?;
                }
            }
        }

        // Remove from log since we reverted it?
        // Actually, let's keep it in the log for now, or maybe append an Undo transaction.
        // For strictness, let's just leave the log as a permanent append-only audit trail.

        Ok(())
    }

    fn resolve_workspace_file_path(&self, file_path: &str) -> anyhow::Result<PathBuf> {
        let raw = PathBuf::from(file_path);
        let target_path = if raw.is_absolute() {
            raw
        } else {
            self.workspace_root.join(raw)
        };

        if !target_path.starts_with(&self.workspace_root) {
            anyhow::bail!("Refusing to revert path outside workspace: {}", file_path);
        }

        if target_path.exists() {
            let canonical_target = fs::canonicalize(&target_path)?;
            if !canonical_target.starts_with(&self.workspace_root) {
                anyhow::bail!("Refusing to follow path outside workspace: {}", file_path);
            }
        } else if let Some(parent) = target_path.parent() {
            if parent.exists() {
                let canonical_parent = fs::canonicalize(parent)?;
                if !canonical_parent.starts_with(&self.workspace_root) {
                    anyhow::bail!("Refusing to write outside workspace: {}", file_path);
                }
            }
        }

        Ok(target_path)
    }

    fn load_log(&self) -> std::io::Result<HistoryLog> {
        let path = self.log_path();
        if path.exists() {
            let data = fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&data).unwrap_or_default())
        } else {
            Ok(HistoryLog::default())
        }
    }

    fn append_transaction(&self, tx: HistoryTransaction) -> std::io::Result<()> {
        fs::create_dir_all(&self.base_dir)?;
        let mut log = self.load_log()?;

        // Deduplicate: If the exact same file content hash was recorded most recently, skip it.
        if let Some(last_tx) = log
            .transactions
            .iter()
            .rev()
            .find(|t| t.file_path == tx.file_path)
        {
            if last_tx.before_hash == tx.before_hash {
                return Ok(());
            }
        }

        log.transactions.push(tx);

        // GC limit to 500 entries
        if log.transactions.len() > 500 {
            log.transactions.drain(0..(log.transactions.len() - 500));
        }

        let json = serde_json::to_string_pretty(&log).unwrap();
        fs::write(self.log_path(), json)
    }

    fn compute_hash(data: &[u8]) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        data.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }

    fn is_valid_blob_hash(hash: &str) -> bool {
        hash.len() == 16 && hash.chars().all(|c| c.is_ascii_hexdigit())
    }
}

#[cfg(test)]
mod tests {
    use super::{HistoryStore, HistoryTransaction};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!("aixlarity-history-{}-{}", label, stamp))
    }

    fn cleanup(store: &HistoryStore, root: PathBuf) {
        if let Some(workspace_dir) = store.base_dir.parent() {
            let _ = fs::remove_dir_all(workspace_dir);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn get_blob_rejects_path_traversal_hash() {
        let root = unique_dir("invalid-hash");
        fs::create_dir_all(&root).unwrap();
        let store = HistoryStore::new(&root);

        let err = store.get_blob("../secret").unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        cleanup(&store, root);
    }

    #[test]
    fn revert_rejects_transactions_outside_workspace() {
        let root = unique_dir("outside-revert");
        fs::create_dir_all(&root).unwrap();
        let outside = unique_dir("outside-target").join("file.txt");
        let store = HistoryStore::new(&root);
        store
            .append_transaction(HistoryTransaction {
                id: "tx_outside".to_string(),
                timestamp_sec: 0,
                tool_name: "test".to_string(),
                source: "test".to_string(),
                file_path: outside.to_string_lossy().to_string(),
                before_hash: None,
            })
            .unwrap();

        let err = store.revert_transaction("tx_outside").unwrap_err();

        assert!(err.to_string().contains("outside workspace"));
        cleanup(&store, root);
    }

    #[test]
    fn revert_rejects_invalid_blob_hash() {
        let root = unique_dir("invalid-revert-hash");
        fs::create_dir_all(&root).unwrap();
        let store = HistoryStore::new(&root);
        let target = store.workspace_root.join("file.txt");
        fs::write(&target, "current").unwrap();
        store
            .append_transaction(HistoryTransaction {
                id: "tx_bad_hash".to_string(),
                timestamp_sec: 0,
                tool_name: "test".to_string(),
                source: "test".to_string(),
                file_path: target.to_string_lossy().to_string(),
                before_hash: Some("../secret".to_string()),
            })
            .unwrap();

        let err = store.revert_transaction("tx_bad_hash").unwrap_err();

        assert!(err.to_string().contains("Invalid blob hash"));
        cleanup(&store, root);
    }
}
