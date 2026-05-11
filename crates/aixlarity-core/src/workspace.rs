use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Workspace {
    pub root: PathBuf,
    pub current_dir: PathBuf,
    pub detected_by: String,
}

impl Workspace {
    pub fn discover(start: &Path) -> io::Result<Self> {
        let start = if start.exists() {
            fs::canonicalize(start)?
        } else {
            start.to_path_buf()
        };

        let mut current = start.as_path();
        // Detect the home directory so we can skip ~/.aixlarity as a project marker.
        // ~/.aixlarity is the global config directory, not a project workspace marker.
        let home_dir = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from);

        loop {
            // Skip .aixlarity marker at $HOME since ~/.aixlarity is global config, not a project.
            let is_home = home_dir.as_ref().is_some_and(|h| current == h.as_path());
            if let Some(marker) = detect_marker(current) {
                if !(is_home && marker == ".aixlarity") {
                    return Ok(Self {
                        root: current.to_path_buf(),
                        current_dir: start.clone(),
                        detected_by: marker.to_string(),
                    });
                }
            }

            match current.parent() {
                Some(parent) => current = parent,
                None => {
                    return Ok(Self {
                        root: start.clone(),
                        current_dir: start,
                        detected_by: "cwd-fallback".to_string(),
                    })
                }
            }
        }
    }

    pub fn project_commands_dir(&self) -> PathBuf {
        self.root.join(".aixlarity").join("commands")
    }

    pub fn project_skills_dir(&self) -> PathBuf {
        self.root.join(".aixlarity").join("skills")
    }

    pub fn local_data_dir(&self) -> PathBuf {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&self.root.to_string_lossy(), &mut hasher);
        let hash = std::hash::Hasher::finish(&hasher);

        let home_dir = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));

        let name = self
            .root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace");

        home_dir
            .join(".aixlarity")
            .join("workspaces")
            .join(format!("{}-{:016x}", name, hash))
    }
}

fn detect_marker(path: &Path) -> Option<&'static str> {
    let markers = [
        (".aixlarity", ".aixlarity"),
        (".git", ".git"),
        ("Cargo.toml", "Cargo.toml"),
        ("package.json", "package.json"),
    ];
    for (entry, label) in markers.iter() {
        if path.join(entry).exists() {
            return Some(*label);
        }
    }
    None
}
