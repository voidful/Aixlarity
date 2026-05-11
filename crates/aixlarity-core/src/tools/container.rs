// Aixlarity — Container Sandbox
//
// Provides Docker/Podman-based isolation for shell commands
// when sandbox policy is set to "container".

use std::process::Command;

use super::common::which_exists;

/// Supported container runtimes.
#[derive(Clone, Debug, PartialEq)]
pub enum ContainerRuntime {
    Docker,
    Podman,
}

impl ContainerRuntime {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
        }
    }
}

/// Default container image for sandbox execution.
const DEFAULT_IMAGE: &str = "ubuntu:22.04";

/// Maximum execution time in seconds.
const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// Detect available container runtime (prefer Podman over Docker).
pub fn detect_runtime() -> Option<ContainerRuntime> {
    if which_exists("podman") {
        Some(ContainerRuntime::Podman)
    } else if which_exists("docker") {
        Some(ContainerRuntime::Docker)
    } else {
        None
    }
}

/// Build the container run command arguments.
pub fn build_container_args(
    _runtime: &ContainerRuntime,
    workspace: &str,
    command: &str,
    image: Option<&str>,
    timeout: Option<u64>,
    network: bool,
) -> Vec<String> {
    let image = image.unwrap_or(DEFAULT_IMAGE);
    let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT_SECS);

    let mut args: Vec<String> = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--interactive".to_string(),
        // Mount workspace
        "-v".to_string(),
        format!("{}:/workspace:rw", workspace),
        "-w".to_string(),
        "/workspace".to_string(),
    ];

    // Network isolation
    if !network {
        args.push("--network=none".to_string());
    }

    // Resource limits
    args.push("--memory=512m".to_string());
    args.push("--cpus=1.0".to_string());

    // Timeout via `timeout` command inside container
    args.push(image.to_string());
    args.push("timeout".to_string());
    args.push(format!("{}", timeout));
    args.push("sh".to_string());
    args.push("-c".to_string());
    args.push(command.to_string());

    args
}

/// Execute a shell command inside a container.
/// Returns (exit_code, stdout, stderr).
pub fn run_in_container(
    workspace: &std::path::Path,
    command: &str,
) -> anyhow::Result<(i32, Vec<u8>, Vec<u8>)> {
    let runtime = detect_runtime().ok_or_else(|| {
        anyhow::anyhow!(
            "Container sandbox requires Docker or Podman to be installed. \
             Install one and retry, or switch to sandbox=workspace-write."
        )
    })?;

    let image = std::env::var("AIXLARITY_CONTAINER_IMAGE")
        .ok()
        .filter(|v| !v.is_empty());
    let timeout = std::env::var("AIXLARITY_CONTAINER_TIMEOUT")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let network = std::env::var("AIXLARITY_CONTAINER_NETWORK")
        .ok()
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    let workspace_str = workspace
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Workspace path is not valid UTF-8"))?;

    let args = build_container_args(
        &runtime,
        workspace_str,
        command,
        image.as_deref(),
        timeout,
        network,
    );

    eprintln!(
        "\x1b[2m🐳 Running in {} container...\x1b[0m",
        runtime.as_str()
    );

    let output = Command::new(runtime.as_str())
        .args(&args)
        .output()
        .map_err(|err| anyhow::anyhow!("Failed to run {} container: {}", runtime.as_str(), err))?;

    let exit_code = output.status.code().unwrap_or(-1);
    Ok((exit_code, output.stdout, output.stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_runtime_returns_option() {
        // This test just verifies the function doesn't panic
        let _ = detect_runtime();
    }

    #[test]
    fn build_container_args_generates_correct_command() {
        let args = build_container_args(
            &ContainerRuntime::Docker,
            "/home/user/project",
            "ls -la",
            None,
            None,
            false,
        );

        assert!(args.contains(&"run".to_string()));
        assert!(args.contains(&"--rm".to_string()));
        assert!(args.contains(&"--network=none".to_string()));
        assert!(args.contains(&"--memory=512m".to_string()));
        assert!(args.contains(&"/home/user/project:/workspace:rw".to_string()));
        assert!(args.contains(&"ubuntu:22.04".to_string()));
        assert!(args.contains(&"ls -la".to_string()));
    }

    #[test]
    fn build_container_args_with_custom_image() {
        let args = build_container_args(
            &ContainerRuntime::Podman,
            "/workspace",
            "echo hello",
            Some("node:20-slim"),
            Some(30),
            true,
        );

        assert!(args.contains(&"node:20-slim".to_string()));
        assert!(args.contains(&"30".to_string()));
        // network=true means no --network=none
        assert!(!args.contains(&"--network=none".to_string()));
    }
}
