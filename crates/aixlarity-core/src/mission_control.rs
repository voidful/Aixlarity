//! Durable Mission Control state for the IDE.
//!
//! Antigravity's Manager Surface treats agent work as recoverable tasks plus
//! reviewable artifacts, not as transient chat UI. Aixlarity keeps the storage
//! format intentionally plain JSON so the teaching project stays inspectable
//! offline and easy to repair by hand.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

const STATE_SCHEMA: &str = "aixlarity.mission_control_state.v1";
const ARTIFACT_SCHEMA: &str = "aixlarity.artifact.v1";
const EVIDENCE_SCHEMA: &str = "aixlarity.agent_evidence_bundle.v1";
const AUDIT_SCHEMA: &str = "aixlarity.audit_event.v1";
const AUDIT_LIST_SCHEMA: &str = "aixlarity.audit_log.v1";
const WORKSPACE_INDEX_SCHEMA: &str = "aixlarity.workspace_index.v1";
const STUDIO_SCHEMA: &str = "aixlarity.ide_studio_state.v1";
const MAX_TASKS: usize = 500;
const MAX_ARTIFACTS: usize = 1_000;
const MAX_ARTIFACT_BODY_CHARS: usize = 50_000;
const MAX_INLINE_ATTACHMENT_CHARS: usize = 256_000;
const MAX_COMMENTS: usize = 200;
const MAX_REVIEW_THREADS: usize = 400;
const MAX_REVIEW_THREAD_COMMENTS: usize = 80;
const MAX_STUDIO_ARRAY_ITEMS: usize = 500;
const MAX_STUDIO_STRING_CHARS: usize = 40_000;
const MAX_INVENTORY_PREVIEW_CHARS: usize = 8_000;
const MAX_AUDIT_STRING_CHARS: usize = 12_000;
const MAX_AUDIT_ARRAY_ITEMS: usize = 100;
const MAX_AUDIT_OBJECT_KEYS: usize = 100;
const MAX_AUDIT_DEPTH: usize = 5;
const DEFAULT_AUDIT_LIMIT: usize = 200;
const MAX_AUDIT_LIMIT: usize = 1_000;

static AUDIT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct MissionControlSaveSummary {
    pub state_path: PathBuf,
    pub artifacts_dir: PathBuf,
    pub task_count: usize,
    pub artifact_count: usize,
    pub mirrored_artifacts: usize,
}

impl MissionControlSaveSummary {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "status": "ok",
            "schema": "aixlarity.mission_control_store.v1",
            "path": self.state_path.display().to_string(),
            "artifacts_dir": self.artifacts_dir.display().to_string(),
            "task_count": self.task_count,
            "artifact_count": self.artifact_count,
            "mirrored_artifacts": self.mirrored_artifacts,
        })
    }
}

pub fn state_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(".aixlarity")
        .join("state")
        .join("mission_control.json")
}

pub fn audit_log_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(".aixlarity")
        .join("state")
        .join("audit.jsonl")
}

pub fn workspace_index_path(workspace_root: &Path) -> PathBuf {
    aixlarity_home(workspace_root)
        .join("state")
        .join("workspace_index.json")
}

pub fn studio_state_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(".aixlarity")
        .join("state")
        .join("ide_studio.json")
}

pub fn artifacts_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".aixlarity").join("artifacts")
}

pub fn load_state(workspace_root: &Path) -> io::Result<Value> {
    let path = state_path(workspace_root);
    if !path.exists() {
        return Ok(empty_state(workspace_root));
    }

    let content = fs::read_to_string(path)?;
    let parsed =
        serde_json::from_str::<Value>(&content).unwrap_or_else(|_| empty_state(workspace_root));
    Ok(normalize_state(workspace_root, &parsed))
}

pub fn save_state(
    workspace_root: &Path,
    raw_state: &Value,
) -> io::Result<MissionControlSaveSummary> {
    let state = normalize_state(workspace_root, raw_state);
    let path = state_path(workspace_root);
    let artifacts = artifacts_dir(workspace_root);
    fs::create_dir_all(path.parent().unwrap_or(workspace_root))?;
    fs::create_dir_all(&artifacts)?;

    let state_json = serde_json::to_vec_pretty(&state).map_err(json_io_error)?;
    atomic_write(&path, &state_json)?;
    let mirrored = mirror_artifacts(workspace_root, &state)?;

    Ok(MissionControlSaveSummary {
        state_path: path,
        artifacts_dir: artifacts,
        task_count: state
            .get("tasks")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        artifact_count: state
            .get("artifacts")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        mirrored_artifacts: mirrored,
    })
}

pub fn export_evidence_bundle(workspace_root: &Path, bundle: Option<&Value>) -> io::Result<Value> {
    let artifacts = artifacts_dir(workspace_root);
    fs::create_dir_all(&artifacts)?;

    let state;
    let evidence = if let Some(bundle) = bundle {
        normalize_evidence_bundle(workspace_root, bundle)
    } else {
        state = load_state(workspace_root)?;
        evidence_from_state(workspace_root, &state)
    };

    let path = artifacts.join("evidence_bundle.latest.json");
    let evidence_json = serde_json::to_vec_pretty(&evidence).map_err(json_io_error)?;
    atomic_write(&path, &evidence_json)?;

    Ok(serde_json::json!({
        "status": "ok",
        "path": path.display().to_string(),
        "schema": evidence.get("schema").and_then(Value::as_str).unwrap_or(EVIDENCE_SCHEMA),
        "task_count": evidence.get("tasks").and_then(Value::as_array).map_or(0, Vec::len),
        "artifact_count": evidence.get("artifacts").and_then(Value::as_array).map_or(0, Vec::len),
        "bundle": evidence,
    }))
}

pub fn list_artifacts(workspace_root: &Path) -> io::Result<Value> {
    let state = load_state(workspace_root)?;
    let artifacts = state
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tasks = state
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(serde_json::json!({
        "schema": "aixlarity.artifact_index.v1",
        "path": state_path(workspace_root).display().to_string(),
        "artifacts_dir": artifacts_dir(workspace_root).display().to_string(),
        "task_count": tasks.len(),
        "artifact_count": artifacts.len(),
        "tasks": tasks,
        "artifacts": artifacts,
    }))
}

pub fn list_workspace_index(workspace_root: &Path) -> io::Result<Value> {
    let path = workspace_index_path(workspace_root);
    let mut entries = read_workspace_index_entries(&path)?;
    let current = workspace_index_entry(workspace_root)?;
    let current_path = current
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    entries.retain(|entry| {
        entry
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path != current_path)
    });
    entries.push(current);
    entries.sort_by(|left, right| {
        let left_at = left
            .get("updated_at_ms")
            .or_else(|| left.get("saved_at_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let right_at = right
            .get("updated_at_ms")
            .or_else(|| right.get("saved_at_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        right_at.cmp(&left_at)
    });
    entries.truncate(MAX_TASKS);

    let payload = serde_json::json!({
        "schema": WORKSPACE_INDEX_SCHEMA,
        "path": path.display().to_string(),
        "current_workspace": workspace_root.display().to_string(),
        "workspace_count": entries.len(),
        "workspaces": entries,
    });
    fs::create_dir_all(path.parent().unwrap_or(workspace_root))?;
    atomic_write(
        &path,
        &serde_json::to_vec_pretty(&payload).map_err(json_io_error)?,
    )?;
    Ok(payload)
}

pub fn load_studio_state(workspace_root: &Path) -> io::Result<Value> {
    let path = studio_state_path(workspace_root);
    let raw = if path.exists() {
        let content = fs::read_to_string(&path)?;
        serde_json::from_str::<Value>(&content).unwrap_or_else(|_| Value::Object(Map::new()))
    } else {
        Value::Object(Map::new())
    };
    Ok(normalize_studio_state(workspace_root, &raw))
}

pub fn save_studio_state(workspace_root: &Path, raw_state: &Value) -> io::Result<Value> {
    let path = studio_state_path(workspace_root);
    let state = normalize_studio_state(workspace_root, raw_state);
    fs::create_dir_all(path.parent().unwrap_or(workspace_root))?;
    atomic_write(
        &path,
        &serde_json::to_vec_pretty(&state).map_err(json_io_error)?,
    )?;
    let _ = record_audit_event(
        workspace_root,
        &serde_json::json!({
            "kind": "studio_policy_save",
            "path": path.display().to_string(),
        }),
    );
    Ok(serde_json::json!({
        "status": "ok",
        "schema": STUDIO_SCHEMA,
        "path": path.display().to_string(),
        "state": state,
    }))
}

pub fn review_artifact(
    workspace_root: &Path,
    artifact_id: &str,
    status: &str,
    comment: Option<&str>,
) -> io::Result<Value> {
    let status = normalize_review_status(status)?;
    let mut state = load_state(workspace_root)?;
    let now = unix_ms_now();
    let reviewed_artifact = {
        let artifacts = state
            .get_mut("artifacts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "artifact state is not an array")
            })?;
        let artifact = artifacts
            .iter_mut()
            .find(|artifact| artifact.get("id").and_then(Value::as_str) == Some(artifact_id))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("artifact not found: {}", artifact_id),
                )
            })?;
        let artifact_obj = artifact.as_object_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "artifact is not an object")
        })?;
        artifact_obj.insert("status".to_string(), Value::String(status.to_string()));
        artifact_obj.insert("updatedAt".to_string(), Value::Number(now.into()));
        artifact_obj.insert("reviewedAt".to_string(), Value::Number(now.into()));

        if let Some(comment) = comment.map(str::trim).filter(|comment| !comment.is_empty()) {
            let comments = artifact_obj
                .entry("comments".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !comments.is_array() {
                *comments = Value::Array(Vec::new());
            }
            if let Some(comments) = comments.as_array_mut() {
                comments.push(Value::String(comment.to_string()));
                trim_array_tail(comments, MAX_COMMENTS);
            }
        }

        Value::Object(artifact_obj.clone())
    };

    if let Some(state_object) = state.as_object_mut() {
        state_object.insert("savedAt".to_string(), Value::Number(now.into()));
        state_object.insert("saved_at_ms".to_string(), Value::Number(now.into()));
    }

    let summary = save_state(workspace_root, &state)?;
    let _ = record_audit_event(
        workspace_root,
        &serde_json::json!({
            "kind": "artifact_review",
            "artifact_id": artifact_id,
            "artifact_name": reviewed_artifact.get("name").and_then(Value::as_str).unwrap_or(""),
            "artifact_kind": reviewed_artifact.get("kind").and_then(Value::as_str).unwrap_or(""),
            "status": status,
            "comment": comment.unwrap_or(""),
        }),
    );

    Ok(serde_json::json!({
        "status": "ok",
        "artifact": reviewed_artifact,
        "summary": summary.to_json(),
    }))
}

pub fn review_artifact_thread(
    workspace_root: &Path,
    artifact_id: &str,
    thread_id: Option<&str>,
    status: Option<&str>,
    anchor: Option<&Value>,
    comment: Option<&str>,
) -> io::Result<Value> {
    let mut state = load_state(workspace_root)?;
    let now = unix_ms_now();
    let touched_thread: Value;
    let artifact_name: String;
    let artifact_kind: String;

    {
        let artifacts = state
            .get_mut("artifacts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "artifact state is not an array")
            })?;
        let artifact = artifacts
            .iter_mut()
            .find(|artifact| artifact.get("id").and_then(Value::as_str) == Some(artifact_id))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("artifact not found: {}", artifact_id),
                )
            })?;
        artifact_name = artifact
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        artifact_kind = artifact
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let artifact_obj = artifact.as_object_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "artifact is not an object")
        })?;
        let threads_value = artifact_obj
            .entry("reviewThreads".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !threads_value.is_array() {
            *threads_value = Value::Array(Vec::new());
        }
        let threads = threads_value.as_array_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "reviewThreads is not an array")
        })?;

        let requested_thread_id = thread_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut index = requested_thread_id.as_ref().and_then(|id| {
            threads
                .iter()
                .position(|thread| thread.get("id").and_then(Value::as_str) == Some(id.as_str()))
        });

        if index.is_none() {
            let generated_id = requested_thread_id
                .unwrap_or_else(|| format!("review-thread-{}-{}", now, threads.len() + 1));
            threads.push(serde_json::json!({
                "id": generated_id,
                "artifactId": artifact_id,
                "anchor": sanitize_review_anchor(anchor),
                "status": "open",
                "createdAt": now,
                "updatedAt": now,
                "comments": [],
            }));
            index = Some(threads.len() - 1);
        }

        let index = index.unwrap_or_default();
        let thread = threads
            .get_mut(index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "review thread is not an object")
            })?;
        thread.insert("updatedAt".to_string(), Value::Number(now.into()));
        if let Some(status) = status {
            thread.insert(
                "status".to_string(),
                Value::String(normalize_thread_status(status)?.to_string()),
            );
        }
        if let Some(anchor) = anchor {
            thread.insert("anchor".to_string(), sanitize_review_anchor(Some(anchor)));
        }
        if let Some(comment) = comment.map(str::trim).filter(|value| !value.is_empty()) {
            let comments = thread
                .entry("comments".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !comments.is_array() {
                *comments = Value::Array(Vec::new());
            }
            if let Some(comments) = comments.as_array_mut() {
                comments.push(serde_json::json!({
                    "id": format!("review-comment-{}-{}", now, comments.len() + 1),
                    "author": "user",
                    "body": truncate_chars(comment, MAX_STUDIO_STRING_CHARS),
                    "createdAt": now,
                }));
                trim_array_tail(comments, MAX_REVIEW_THREAD_COMMENTS);
            }
        }

        touched_thread = Value::Object(thread.clone());
        trim_array_tail(threads, MAX_REVIEW_THREADS);
        artifact_obj.insert("updatedAt".to_string(), Value::Number(now.into()));
    }

    if let Some(state_object) = state.as_object_mut() {
        state_object.insert("savedAt".to_string(), Value::Number(now.into()));
        state_object.insert("saved_at_ms".to_string(), Value::Number(now.into()));
    }
    let summary = save_state(workspace_root, &state)?;
    let _ = record_audit_event(
        workspace_root,
        &serde_json::json!({
            "kind": "artifact_review_thread",
            "artifact_id": artifact_id,
            "artifact_name": artifact_name,
            "artifact_kind": artifact_kind,
            "thread_id": touched_thread.get("id").and_then(Value::as_str).unwrap_or(""),
            "status": touched_thread.get("status").and_then(Value::as_str).unwrap_or("open"),
            "anchor": touched_thread.get("anchor").cloned().unwrap_or(Value::Null),
            "comment": comment.unwrap_or(""),
        }),
    );

    Ok(serde_json::json!({
        "status": "ok",
        "artifact_id": artifact_id,
        "thread": touched_thread,
        "summary": summary.to_json(),
    }))
}

pub fn record_audit_event(workspace_root: &Path, raw_event: &Value) -> io::Result<Value> {
    let path = audit_log_path(workspace_root);
    fs::create_dir_all(path.parent().unwrap_or(workspace_root))?;

    let event = normalize_audit_event(workspace_root, raw_event);
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    serde_json::to_writer(&mut file, &event).map_err(json_io_error)?;
    file.write_all(b"\n")?;
    file.flush()?;

    Ok(serde_json::json!({
        "status": "ok",
        "schema": AUDIT_SCHEMA,
        "path": path.display().to_string(),
        "event": event,
    }))
}

pub fn list_audit_events(workspace_root: &Path, limit: Option<usize>) -> io::Result<Value> {
    let path = audit_log_path(workspace_root);
    let limit = limit
        .unwrap_or(DEFAULT_AUDIT_LIMIT)
        .clamp(1, MAX_AUDIT_LIMIT);
    let events = if path.exists() {
        fs::read_to_string(&path)?
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let total_count = events.len();
    let start = total_count.saturating_sub(limit);
    let mut events = events.into_iter().skip(start).collect::<Vec<_>>();
    events.reverse();

    Ok(serde_json::json!({
        "schema": AUDIT_LIST_SCHEMA,
        "path": path.display().to_string(),
        "total_count": total_count,
        "events": events,
    }))
}

fn normalize_state(workspace_root: &Path, raw_state: &Value) -> Value {
    let raw = raw_state.get("state").unwrap_or(raw_state);
    let now = unix_ms_now();
    let saved_at = raw
        .get("savedAt")
        .or_else(|| raw.get("saved_at_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(now);
    let mut object = Map::new();

    object.insert(
        "schema".to_string(),
        Value::String(STATE_SCHEMA.to_string()),
    );
    object.insert("version".to_string(), Value::Number(1.into()));
    object.insert("savedAt".to_string(), Value::Number(saved_at.into()));
    object.insert("saved_at_ms".to_string(), Value::Number(saved_at.into()));
    object.insert(
        "workspace".to_string(),
        Value::String(
            raw.get("workspace")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| workspace_root.display().to_string()),
        ),
    );

    let artifacts = raw
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(sanitize_artifact)
        .take(MAX_ARTIFACTS)
        .collect::<Vec<_>>();
    let artifact_ids = artifacts
        .iter()
        .filter_map(|artifact| artifact.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();

    let tasks = raw
        .get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|task| sanitize_task(task, &artifact_ids))
        .take(MAX_TASKS)
        .collect::<Vec<_>>();

    object.insert("tasks".to_string(), Value::Array(tasks));
    object.insert("artifacts".to_string(), Value::Array(artifacts));
    Value::Object(object)
}

fn read_workspace_index_entries(path: &Path) -> io::Result<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)?;
    let parsed = serde_json::from_str::<Value>(&content).unwrap_or(Value::Null);
    let entries = parsed
        .get("workspaces")
        .and_then(Value::as_array)
        .or_else(|| parsed.as_array())
        .into_iter()
        .flatten()
        .filter_map(sanitize_workspace_index_entry)
        .collect();
    Ok(entries)
}

fn workspace_index_entry(workspace_root: &Path) -> io::Result<Value> {
    let state = load_state(workspace_root)?;
    let tasks = state
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let artifacts = state
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let task_count = tasks.len();
    let artifact_count = artifacts.len();
    let active_task_count = tasks
        .iter()
        .filter(|task| {
            matches!(
                task.get("status").and_then(Value::as_str),
                Some("queued" | "running" | "waiting_review" | "paused")
            )
        })
        .count();
    let review_count = artifacts
        .iter()
        .filter(|artifact| {
            matches!(
                artifact.get("status").and_then(Value::as_str),
                Some("needs_review" | "draft")
            )
        })
        .count();
    let last_saved = state
        .get("savedAt")
        .or_else(|| state.get("saved_at_ms"))
        .and_then(Value::as_u64)
        .unwrap_or_else(unix_ms_now);
    let name = workspace_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| workspace_root.to_str().unwrap_or("workspace"));

    Ok(serde_json::json!({
        "path": workspace_root.display().to_string(),
        "name": name,
        "task_count": task_count,
        "artifact_count": artifact_count,
        "active_task_count": active_task_count,
        "review_count": review_count,
        "saved_at_ms": last_saved,
        "updated_at_ms": unix_ms_now(),
        "state_path": state_path(workspace_root).display().to_string(),
        "artifacts_dir": artifacts_dir(workspace_root).display().to_string(),
        "exists": workspace_root.exists(),
    }))
}

fn sanitize_workspace_index_entry(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let path = source.get("path").and_then(Value::as_str)?.trim();
    if path.is_empty() {
        return None;
    }
    let mut object = Map::new();
    object.insert("path".to_string(), Value::String(path.to_string()));
    for key in [
        "name",
        "state_path",
        "artifacts_dir",
        "exists",
        "task_count",
        "artifact_count",
        "active_task_count",
        "review_count",
        "saved_at_ms",
        "updated_at_ms",
    ] {
        if let Some(value) = source.get(key) {
            object.insert(key.to_string(), sanitize_audit_value(value, 0));
        }
    }
    Some(Value::Object(object))
}

fn normalize_studio_state(workspace_root: &Path, raw_state: &Value) -> Value {
    let raw = raw_state.get("state").unwrap_or(raw_state);
    let saved_at = raw
        .get("savedAt")
        .or_else(|| raw.get("saved_at_ms"))
        .and_then(Value::as_u64)
        .unwrap_or_else(unix_ms_now);
    let mut object = Map::new();
    object.insert(
        "schema".to_string(),
        Value::String(STUDIO_SCHEMA.to_string()),
    );
    object.insert("version".to_string(), Value::Number(1.into()));
    object.insert("savedAt".to_string(), Value::Number(saved_at.into()));
    object.insert("saved_at_ms".to_string(), Value::Number(saved_at.into()));
    object.insert(
        "workspace".to_string(),
        Value::String(workspace_root.display().to_string()),
    );

    object.insert(
        "missionPolicy".to_string(),
        sanitize_studio_object(
            raw.get("missionPolicy")
                .or_else(|| raw.get("mission_policy")),
            default_mission_policy(),
        ),
    );
    object.insert(
        "browserPolicy".to_string(),
        sanitize_studio_object(
            raw.get("browserPolicy")
                .or_else(|| raw.get("browser_policy")),
            default_browser_policy(),
        ),
    );
    object.insert(
        "terminalPolicy".to_string(),
        sanitize_studio_object(
            raw.get("terminalPolicy")
                .or_else(|| raw.get("terminal_policy")),
            default_terminal_policy(),
        ),
    );
    object.insert(
        "knowledgePolicy".to_string(),
        sanitize_studio_object(
            raw.get("knowledgePolicy")
                .or_else(|| raw.get("knowledge_policy")),
            default_knowledge_policy(),
        ),
    );
    object.insert(
        "inventory".to_string(),
        workspace_studio_inventory(workspace_root),
    );
    Value::Object(object)
}

fn sanitize_studio_object(raw: Option<&Value>, defaults: Value) -> Value {
    let mut object = defaults.as_object().cloned().unwrap_or_default();
    if let Some(raw_object) = raw.and_then(Value::as_object) {
        for (key, value) in raw_object.iter().take(MAX_STUDIO_ARRAY_ITEMS) {
            object.insert(
                truncate_chars(key.trim(), 160),
                sanitize_studio_value(value, 0),
            );
        }
    }
    Value::Object(object)
}

fn sanitize_studio_value(value: &Value, depth: usize) -> Value {
    if depth >= 4 {
        return match value {
            Value::String(text) => Value::String(truncate_chars(text, MAX_STUDIO_STRING_CHARS)),
            Value::Bool(_) | Value::Number(_) | Value::Null => value.clone(),
            Value::Array(items) => serde_json::json!({
                "omitted": true,
                "reason": "studio_depth_limit",
                "item_count": items.len(),
            }),
            Value::Object(object) => serde_json::json!({
                "omitted": true,
                "reason": "studio_depth_limit",
                "key_count": object.len(),
            }),
        };
    }
    match value {
        Value::String(text) => Value::String(truncate_chars(text, MAX_STUDIO_STRING_CHARS)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(MAX_STUDIO_ARRAY_ITEMS)
                .map(|item| sanitize_studio_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, child) in object.iter().take(MAX_STUDIO_ARRAY_ITEMS) {
                sanitized.insert(
                    truncate_chars(key.trim(), 160),
                    sanitize_studio_value(child, depth + 1),
                );
            }
            Value::Object(sanitized)
        }
        _ => value.clone(),
    }
}

fn default_mission_policy() -> Value {
    serde_json::json!({
        "requirePlanBeforeEdit": true,
        "requireTaskList": true,
        "requireTestReportBeforeComplete": true,
        "requireEvidenceBundle": true,
        "blockDestructiveWithoutApproval": true,
    })
}

fn default_browser_policy() -> Value {
    serde_json::json!({
        "managedBrowserEnabled": true,
        "captureDom": true,
        "captureConsole": true,
        "captureNetwork": true,
        "captureScreenshot": true,
        "captureVideo": false,
        "sessionIsolation": "workspace",
        "allowedDomains": ["localhost", "127.0.0.1"],
        "blockedDomains": [],
    })
}

fn default_terminal_policy() -> Value {
    serde_json::json!({
        "approvalMode": "review_risky",
        "captureCwd": true,
        "captureEnv": true,
        "captureStdout": true,
        "captureStderr": true,
        "timeoutSeconds": 120,
        "maxTranscriptBytes": 200000,
        "allowPatterns": ["cargo test", "npm test", "npm run compile"],
        "denyPatterns": ["rm -rf /", "git reset --hard"],
    })
}

fn default_knowledge_policy() -> Value {
    serde_json::json!({
        "ledgerEnabled": true,
        "rulesEnabled": true,
        "memoryEnabled": true,
        "autoCaptureEnabled": false,
        "reviewRequired": true,
        "activationMode": "manual",
        "globPattern": "**/*",
        "exportPreviews": true,
    })
}

fn workspace_studio_inventory(workspace_root: &Path) -> Value {
    serde_json::json!({
        "rules": collect_named_files(
            workspace_root,
            &[
                "AGENTS.md",
                "AIXLARITY.md",
                "CLAUDE.md",
                "GEMINI.md",
                ".aixlarity/rules.md",
                ".aixlarity/AGENTS.md",
            ],
        ),
        "workflows": collect_dir_files(&workspace_root.join(".aixlarity").join("commands")),
        "memories": collect_named_files(
            workspace_root,
            &[
                ".aixlarity/MEMORY.md",
                ".aixlarity/USER.md",
                ".aixlarity/memory/MEMORY.md",
                ".aixlarity/memory/USER.md",
            ],
        ),
        "mcpServers": collect_named_files(workspace_root, &[".aixlarity/mcp.json"]),
    })
}

fn collect_named_files(workspace_root: &Path, relative_paths: &[&str]) -> Value {
    let files = relative_paths
        .iter()
        .filter_map(|relative| file_inventory_item(workspace_root, &workspace_root.join(relative)))
        .collect::<Vec<_>>();
    Value::Array(files)
}

fn collect_dir_files(dir: &Path) -> Value {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten().take(MAX_STUDIO_ARRAY_ITEMS) {
            let path = entry.path();
            if path.is_file() {
                if let Some(item) = file_inventory_item(dir.parent().unwrap_or(dir), &path) {
                    files.push(item);
                }
            }
        }
    }
    files.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .cmp(&right.get("path").and_then(Value::as_str))
    });
    Value::Array(files)
}

fn file_inventory_item(base: &Path, path: &Path) -> Option<Value> {
    if !path.exists() || !path.is_file() {
        return None;
    }
    let content = fs::read_to_string(path).unwrap_or_default();
    let relative = path
        .strip_prefix(base)
        .unwrap_or(path)
        .display()
        .to_string();
    let metadata = fs::metadata(path).ok();
    Some(serde_json::json!({
        "name": path.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
        "path": relative,
        "absolute_path": path.display().to_string(),
        "bytes": metadata.as_ref().map(|m| m.len()).unwrap_or(0),
        "modified_ms": metadata
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64),
        "preview": truncate_chars(&content, MAX_INVENTORY_PREVIEW_CHARS),
    }))
}

fn normalize_audit_event(workspace_root: &Path, raw_event: &Value) -> Value {
    let now = unix_ms_now();
    let mut object = Map::new();
    if let Some(raw_object) = raw_event.as_object() {
        for (key, value) in raw_object.iter().take(MAX_AUDIT_OBJECT_KEYS) {
            let normalized_key = truncate_chars(key.trim(), 160);
            if normalized_key.is_empty() {
                continue;
            }
            object.insert(normalized_key, sanitize_audit_value(value, 0));
        }
    }
    object.insert(
        "schema".to_string(),
        Value::String(AUDIT_SCHEMA.to_string()),
    );
    object
        .entry("event_id".to_string())
        .or_insert_with(|| Value::String(audit_event_id(now)));
    object
        .entry("created_at_ms".to_string())
        .or_insert_with(|| Value::Number(now.into()));
    object
        .entry("workspace".to_string())
        .or_insert_with(|| Value::String(workspace_root.display().to_string()));
    object
        .entry("kind".to_string())
        .or_insert_with(|| Value::String("event".to_string()));
    Value::Object(object)
}

fn audit_event_id(now: u64) -> String {
    let sequence = AUDIT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("audit-{}-{}-{}", now, std::process::id(), sequence)
}

fn sanitize_audit_value(value: &Value, depth: usize) -> Value {
    if depth >= MAX_AUDIT_DEPTH {
        return match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(text) => Value::String(truncate_chars(text, MAX_AUDIT_STRING_CHARS)),
            Value::Array(items) => serde_json::json!({
                "omitted": true,
                "reason": "audit_depth_limit",
                "item_count": items.len(),
            }),
            Value::Object(object) => serde_json::json!({
                "omitted": true,
                "reason": "audit_depth_limit",
                "key_count": object.len(),
            }),
        };
    }

    match value {
        Value::String(text) => Value::String(truncate_chars(text, MAX_AUDIT_STRING_CHARS)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(MAX_AUDIT_ARRAY_ITEMS)
                .map(|item| sanitize_audit_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, child) in object.iter().take(MAX_AUDIT_OBJECT_KEYS) {
                sanitized.insert(
                    truncate_chars(key.trim(), 160),
                    sanitize_audit_value(child, depth + 1),
                );
            }
            Value::Object(sanitized)
        }
        _ => value.clone(),
    }
}

fn normalize_review_status(status: &str) -> io::Result<&'static str> {
    match status {
        "draft" => Ok("draft"),
        "needs_review" => Ok("needs_review"),
        "approved" => Ok("approved"),
        "rejected" => Ok("rejected"),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid artifact review status: {}", other),
        )),
    }
}

fn sanitize_task(task: &Value, artifact_ids: &std::collections::HashSet<String>) -> Option<Value> {
    let source = task.as_object()?;
    let id = source.get("id").and_then(Value::as_str)?.trim();
    let title = source.get("title").and_then(Value::as_str)?.trim();
    if id.is_empty() || title.is_empty() {
        return None;
    }

    let mut object = source.clone();
    object.insert("id".to_string(), Value::String(id.to_string()));
    object.insert("title".to_string(), Value::String(title.to_string()));
    if let Some(ids) = object.get_mut("artifactIds").and_then(Value::as_array_mut) {
        ids.retain(|value| {
            value
                .as_str()
                .is_some_and(|id| artifact_ids.is_empty() || artifact_ids.contains(id))
        });
        ids.truncate(200);
    }
    if let Some(timeline) = object.get_mut("timeline").and_then(Value::as_array_mut) {
        trim_array_tail(timeline, 250);
    }
    if let Some(seen) = object
        .get_mut("seenEventKeys")
        .and_then(Value::as_array_mut)
    {
        trim_array_tail(seen, 500);
    }
    Some(Value::Object(object))
}

fn sanitize_artifact(artifact: &Value) -> Option<Value> {
    let source = artifact.as_object()?;
    let id = source.get("id").and_then(Value::as_str)?.trim();
    let name = source.get("name").and_then(Value::as_str)?.trim();
    if id.is_empty() || name.is_empty() {
        return None;
    }

    let mut object = source.clone();
    object.insert("id".to_string(), Value::String(id.to_string()));
    object.insert("name".to_string(), Value::String(name.to_string()));

    if let Some(body) = object
        .get("body")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        let truncated = truncate_chars(&body, MAX_ARTIFACT_BODY_CHARS);
        if truncated != body {
            object.insert("body".to_string(), Value::String(truncated));
            object.insert("body_truncated".to_string(), Value::Bool(true));
        }
    }

    if let Some(comments) = object.get_mut("comments").and_then(Value::as_array_mut) {
        trim_array_tail(comments, MAX_COMMENTS);
    }

    if !object.contains_key("reviewThreads") {
        if let Some(legacy_threads) = object.remove("review_threads") {
            object.insert("reviewThreads".to_string(), legacy_threads);
        }
    }

    if let Some(threads) = object
        .get_mut("reviewThreads")
        .and_then(Value::as_array_mut)
    {
        for thread in threads.iter_mut() {
            sanitize_review_thread(thread, id);
        }
        trim_array_tail(threads, MAX_REVIEW_THREADS);
    }

    if let Some(attachments) = object.get_mut("attachments").and_then(Value::as_array_mut) {
        for attachment in attachments {
            if let Some(attachment) = attachment.as_object_mut() {
                sanitize_attachment(attachment);
            }
        }
    }

    Some(Value::Object(object))
}

fn sanitize_review_thread(thread: &mut Value, artifact_id: &str) {
    let now = unix_ms_now();
    let Some(object) = thread.as_object_mut() else {
        *thread = serde_json::json!({
            "id": format!("review-thread-{}", now),
            "artifactId": artifact_id,
            "status": "open",
            "anchor": sanitize_review_anchor(None),
            "comments": [],
            "createdAt": now,
            "updatedAt": now,
        });
        return;
    };

    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("review-thread-{}", now));
    object.insert("id".to_string(), Value::String(id));
    object.insert(
        "artifactId".to_string(),
        Value::String(
            object
                .get("artifactId")
                .or_else(|| object.get("artifact_id"))
                .and_then(Value::as_str)
                .unwrap_or(artifact_id)
                .to_string(),
        ),
    );
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .and_then(|status| normalize_thread_status(status).ok())
        .unwrap_or("open");
    object.insert("status".to_string(), Value::String(status.to_string()));
    let anchor = object.get("anchor").cloned();
    object.insert(
        "anchor".to_string(),
        sanitize_review_anchor(anchor.as_ref()),
    );
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| Value::Number(now.into()));
    object
        .entry("updatedAt".to_string())
        .or_insert_with(|| Value::Number(now.into()));

    let comments = object
        .entry("comments".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !comments.is_array() {
        *comments = Value::Array(Vec::new());
    }
    if let Some(comments) = comments.as_array_mut() {
        for comment in comments.iter_mut() {
            sanitize_review_comment(comment);
        }
        trim_array_tail(comments, MAX_REVIEW_THREAD_COMMENTS);
    }
}

fn sanitize_review_comment(comment: &mut Value) {
    let now = unix_ms_now();
    if let Some(text) = comment.as_str() {
        *comment = serde_json::json!({
            "id": format!("review-comment-{}", now),
            "author": "user",
            "body": truncate_chars(text, MAX_STUDIO_STRING_CHARS),
            "createdAt": now,
        });
        return;
    }
    let Some(object) = comment.as_object_mut() else {
        *comment = serde_json::json!({
            "id": format!("review-comment-{}", now),
            "author": "user",
            "body": "",
            "createdAt": now,
        });
        return;
    };
    object
        .entry("id".to_string())
        .or_insert_with(|| Value::String(format!("review-comment-{}", now)));
    object
        .entry("author".to_string())
        .or_insert_with(|| Value::String("user".to_string()));
    let body = object
        .get("body")
        .or_else(|| object.get("comment"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    object.insert(
        "body".to_string(),
        Value::String(truncate_chars(&body, MAX_STUDIO_STRING_CHARS)),
    );
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| Value::Number(now.into()));
}

fn sanitize_review_anchor(anchor: Option<&Value>) -> Value {
    let Some(source) = anchor.and_then(Value::as_object) else {
        return serde_json::json!({
            "kind": "artifact",
            "label": "Entire artifact",
        });
    };
    let kind = source
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("artifact");
    let label = source
        .get("label")
        .and_then(Value::as_str)
        .or_else(|| source.get("target").and_then(Value::as_str))
        .unwrap_or("Anchor");
    let mut object = Map::new();
    object.insert("kind".to_string(), Value::String(truncate_chars(kind, 64)));
    object.insert(
        "label".to_string(),
        Value::String(truncate_chars(label, 500)),
    );
    for key in [
        "path",
        "line",
        "column",
        "startLine",
        "endLine",
        "selector",
        "url",
        "timeMs",
        "region",
    ] {
        if let Some(value) = source.get(key) {
            object.insert(key.to_string(), sanitize_studio_value(value, 0));
        }
    }
    Value::Object(object)
}

fn normalize_thread_status(status: &str) -> io::Result<&'static str> {
    match status {
        "open" => Ok("open"),
        "resolved" => Ok("resolved"),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid review thread status: {}", other),
        )),
    }
}

fn sanitize_attachment(attachment: &mut Map<String, Value>) {
    let Some(inline_len) = attachment
        .get("dataBase64")
        .or_else(|| attachment.get("data_base64"))
        .and_then(Value::as_str)
        .map(str::len)
    else {
        return;
    };

    if inline_len <= MAX_INLINE_ATTACHMENT_CHARS {
        return;
    }

    attachment.remove("dataBase64");
    attachment.remove("data_base64");
    attachment.insert(
        "omittedReason".to_string(),
        Value::String(
            "Inline attachment exceeded durable state limit; use filePath evidence.".to_string(),
        ),
    );
}

fn mirror_artifacts(workspace_root: &Path, state: &Value) -> io::Result<usize> {
    let artifacts = state
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tasks = state
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let dir = artifacts_dir(workspace_root);
    let mut mirrored = 0usize;

    for artifact in artifacts {
        let Some(id) = artifact.get("id").and_then(Value::as_str) else {
            continue;
        };
        let file_name = format!("{}.json", safe_file_stem(id));
        let task = artifact
            .get("taskId")
            .and_then(Value::as_str)
            .and_then(|task_id| {
                tasks
                    .iter()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
            })
            .cloned();
        let payload = serde_json::json!({
            "schema": ARTIFACT_SCHEMA,
            "savedAt": unix_ms_now(),
            "workspace": state.get("workspace").cloned().unwrap_or(Value::Null),
            "artifact": artifact,
            "task": task,
        });
        let json = serde_json::to_vec_pretty(&payload).map_err(json_io_error)?;
        atomic_write(&dir.join(file_name), &json)?;
        mirrored += 1;
    }

    Ok(mirrored)
}

fn normalize_evidence_bundle(workspace_root: &Path, raw: &Value) -> Value {
    let mut object = raw.as_object().cloned().unwrap_or_default();
    object.insert(
        "schema".to_string(),
        Value::String(EVIDENCE_SCHEMA.to_string()),
    );
    object.insert("exportedAt".to_string(), Value::String(rfc3339ish_now()));
    object
        .entry("workspace".to_string())
        .or_insert_with(|| Value::String(workspace_root.display().to_string()));
    if !object.get("tasks").is_some_and(Value::is_array) {
        object.insert("tasks".to_string(), Value::Array(Vec::new()));
    }
    if !object.get("artifacts").is_some_and(Value::is_array) {
        object.insert("artifacts".to_string(), Value::Array(Vec::new()));
    }
    Value::Object(object)
}

fn evidence_from_state(workspace_root: &Path, state: &Value) -> Value {
    serde_json::json!({
        "schema": EVIDENCE_SCHEMA,
        "exportedAt": rfc3339ish_now(),
        "workspace": state
            .get("workspace")
            .and_then(Value::as_str)
            .unwrap_or_else(|| workspace_root.to_str().unwrap_or("")),
        "summary": {
            "taskCount": state.get("tasks").and_then(Value::as_array).map_or(0, Vec::len),
            "artifactCount": state.get("artifacts").and_then(Value::as_array).map_or(0, Vec::len),
        },
        "tasks": state.get("tasks").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "artifacts": state.get("artifacts").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    })
}

fn empty_state(workspace_root: &Path) -> Value {
    let now = unix_ms_now();
    serde_json::json!({
        "schema": STATE_SCHEMA,
        "version": 1,
        "savedAt": now,
        "saved_at_ms": now,
        "workspace": workspace_root.display().to_string(),
        "tasks": [],
        "artifacts": [],
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), unix_ms_now()));
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

fn trim_array_tail(values: &mut Vec<Value>, max_len: usize) {
    if values.len() <= max_len {
        return;
    }
    let keep_from = values.len() - max_len;
    values.drain(0..keep_from);
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

fn safe_file_stem(id: &str) -> String {
    let mut stem = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if stem.is_empty() {
        stem = "artifact".to_string();
    }
    stem.truncate(120);
    stem
}

#[cfg(not(test))]
fn aixlarity_home(workspace_root: &Path) -> PathBuf {
    if let Some(home) = std::env::var_os("AIXLARITY_HOME") {
        return PathBuf::from(home);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".aixlarity");
    }
    workspace_root.join(".aixlarity")
}

#[cfg(test)]
fn aixlarity_home(workspace_root: &Path) -> PathBuf {
    // Unit tests should not read or mutate the developer's real global
    // workspace index. Keep Mission Control fixtures fully offline and local.
    workspace_root.join(".aixlarity")
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn rfc3339ish_now() -> String {
    // Keep the core dependency-free; millisecond epoch is still stable and
    // machine-sortable for evidence bundles.
    format!("{}ms-since-unix-epoch", unix_ms_now())
}

fn json_io_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aixlarity-mission-control-{}-{}",
            name,
            unix_ms_now()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_state_loads_empty_workspace_state() {
        let workspace = temp_workspace("empty");
        let state = load_state(&workspace).unwrap();

        assert_eq!(state["schema"], STATE_SCHEMA);
        assert_eq!(state["tasks"].as_array().unwrap().len(), 0);
        assert_eq!(state["artifacts"].as_array().unwrap().len(), 0);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn save_state_round_trips_tasks_and_mirrors_artifacts() {
        let workspace = temp_workspace("roundtrip");
        let state = serde_json::json!({
            "workspace": "sample-workspace",
            "tasks": [{
                "id": "task-1",
                "title": "Build durable manager",
                "artifactIds": ["artifact/1"]
            }],
            "artifacts": [{
                "id": "artifact/1",
                "taskId": "task-1",
                "name": "Implementation Plan",
                "kind": "implementation_plan",
                "body": "Plan body"
            }]
        });

        let summary = save_state(&workspace, &state).unwrap();
        let loaded = load_state(&workspace).unwrap();

        assert_eq!(summary.task_count, 1);
        assert_eq!(summary.artifact_count, 1);
        assert_eq!(summary.mirrored_artifacts, 1);
        assert_eq!(loaded["tasks"][0]["id"], "task-1");
        assert_eq!(loaded["artifacts"][0]["id"], "artifact/1");
        assert!(artifacts_dir(&workspace).join("artifact_1.json").exists());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn save_state_omits_oversized_inline_attachments() {
        let workspace = temp_workspace("attachments");
        let large_inline = "a".repeat(MAX_INLINE_ATTACHMENT_CHARS + 1);
        let state = serde_json::json!({
            "tasks": [],
            "artifacts": [{
                "id": "screenshot",
                "name": "Screenshot",
                "attachments": [{
                    "mimeType": "image/png",
                    "dataBase64": large_inline
                }]
            }]
        });

        save_state(&workspace, &state).unwrap();
        let loaded = load_state(&workspace).unwrap();
        let attachment = &loaded["artifacts"][0]["attachments"][0];

        assert!(attachment.get("dataBase64").is_none());
        assert!(attachment.get("omittedReason").is_some());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn export_evidence_bundle_writes_latest_bundle() {
        let workspace = temp_workspace("bundle");
        let state = serde_json::json!({
            "tasks": [{"id": "task-1", "title": "Verify"}],
            "artifacts": [{"id": "report", "name": "Test Report"}]
        });
        save_state(&workspace, &state).unwrap();

        let exported = export_evidence_bundle(&workspace, None).unwrap();

        assert_eq!(exported["status"], "ok");
        assert_eq!(exported["task_count"], 1);
        assert!(artifacts_dir(&workspace)
            .join("evidence_bundle.latest.json")
            .exists());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn list_and_review_artifacts_are_durable() {
        let workspace = temp_workspace("review");
        let state = serde_json::json!({
            "tasks": [{"id": "task-1", "title": "Review task", "artifactIds": ["plan"]}],
            "artifacts": [{"id": "plan", "taskId": "task-1", "name": "Implementation Plan", "status": "needs_review"}]
        });
        save_state(&workspace, &state).unwrap();

        let listed = list_artifacts(&workspace).unwrap();
        assert_eq!(listed["artifact_count"], 1);

        let reviewed =
            review_artifact(&workspace, "plan", "approved", Some("Looks good.")).unwrap();
        assert_eq!(reviewed["artifact"]["status"], "approved");

        let loaded = load_state(&workspace).unwrap();
        assert_eq!(loaded["artifacts"][0]["status"], "approved");
        assert_eq!(loaded["artifacts"][0]["comments"][0], "Looks good.");
        let audit = list_audit_events(&workspace, Some(10)).unwrap();
        assert_eq!(audit["events"][0]["kind"], "artifact_review");
        assert_eq!(audit["events"][0]["artifact_id"], "plan");

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn audit_events_are_append_only_and_listed_newest_first() {
        let workspace = temp_workspace("audit");

        record_audit_event(
            &workspace,
            &serde_json::json!({
                "kind": "approval_request",
                "tool_name": "shell"
            }),
        )
        .unwrap();
        record_audit_event(
            &workspace,
            &serde_json::json!({
                "kind": "approval_response",
                "decision": "allow"
            }),
        )
        .unwrap();

        let audit = list_audit_events(&workspace, Some(10)).unwrap();
        assert_eq!(audit["schema"], AUDIT_LIST_SCHEMA);
        assert_eq!(audit["total_count"], 2);
        assert_eq!(audit["events"][0]["kind"], "approval_response");
        assert_eq!(audit["events"][1]["kind"], "approval_request");
        assert!(audit_log_path(&workspace).exists());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn workspace_index_tracks_current_workspace_stats() {
        let workspace = temp_workspace("workspace-index");
        let state = serde_json::json!({
            "tasks": [{"id": "task-1", "title": "Running task", "status": "running"}],
            "artifacts": [{"id": "plan", "name": "Plan", "status": "needs_review"}]
        });
        save_state(&workspace, &state).unwrap();

        let index = list_workspace_index(&workspace).unwrap();

        assert_eq!(index["schema"], WORKSPACE_INDEX_SCHEMA);
        assert_eq!(index["workspace_count"], 1);
        assert_eq!(index["workspaces"][0]["task_count"], 1);
        assert_eq!(index["workspaces"][0]["review_count"], 1);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn artifact_review_threads_are_durable_and_anchored() {
        let workspace = temp_workspace("review-thread");
        let state = serde_json::json!({
            "tasks": [{"id": "task-1", "title": "Review task", "artifactIds": ["diff"]}],
            "artifacts": [{"id": "diff", "taskId": "task-1", "name": "Code Diff", "kind": "code_diff", "status": "needs_review"}]
        });
        save_state(&workspace, &state).unwrap();

        let reviewed = review_artifact_thread(
            &workspace,
            "diff",
            None,
            None,
            Some(&serde_json::json!({
                "kind": "line",
                "path": "src/lib.rs",
                "line": 42,
                "label": "src/lib.rs:42"
            })),
            Some("Please simplify this branch."),
        )
        .unwrap();

        assert_eq!(reviewed["status"], "ok");
        assert_eq!(reviewed["thread"]["anchor"]["kind"], "line");
        assert_eq!(
            reviewed["thread"]["comments"][0]["body"],
            "Please simplify this branch."
        );

        let loaded = load_state(&workspace).unwrap();
        assert_eq!(
            loaded["artifacts"][0]["reviewThreads"][0]["anchor"]["path"],
            "src/lib.rs"
        );

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn studio_state_round_trips_policies_and_inventories_project_files() {
        let workspace = temp_workspace("studio");
        fs::write(workspace.join("AGENTS.md"), "project rules").unwrap();
        fs::create_dir_all(workspace.join(".aixlarity").join("commands")).unwrap();
        fs::write(
            workspace
                .join(".aixlarity")
                .join("commands")
                .join("review.toml"),
            "name = \"review\"",
        )
        .unwrap();

        save_studio_state(
            &workspace,
            &serde_json::json!({
                "browserPolicy": {"captureVideo": true, "allowedDomains": ["localhost", "example.com"]},
                "terminalPolicy": {"timeoutSeconds": 300},
                "knowledgePolicy": {"ledgerEnabled": false, "activationMode": "glob", "globPattern": "src/**/*.rs"}
            }),
        )
        .unwrap();
        let loaded = load_studio_state(&workspace).unwrap();

        assert_eq!(loaded["schema"], STUDIO_SCHEMA);
        assert_eq!(loaded["browserPolicy"]["captureVideo"], true);
        assert_eq!(loaded["terminalPolicy"]["timeoutSeconds"], 300);
        assert_eq!(loaded["knowledgePolicy"]["ledgerEnabled"], false);
        assert_eq!(loaded["knowledgePolicy"]["activationMode"], "glob");
        assert_eq!(loaded["knowledgePolicy"]["globPattern"], "src/**/*.rs");
        assert_eq!(loaded["inventory"]["rules"][0]["path"], "AGENTS.md");
        assert_eq!(
            loaded["inventory"]["workflows"][0]["path"],
            "commands/review.toml"
        );

        fs::remove_dir_all(workspace).unwrap();
    }
}
