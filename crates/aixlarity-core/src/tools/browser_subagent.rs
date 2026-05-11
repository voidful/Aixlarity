use super::{embed_tool_attachments, Tool, ToolContext};
use crate::agent::AgentAttachment;
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

const PLAYWRIGHT_CAPTURE_SCRIPT: &str = r#"
const fs = require('fs');

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const outputPath = process.argv[3];

  let pw;
  try {
    pw = require('playwright');
  } catch (_) {
    pw = require('playwright-core');
  }

  const consoleEvents = [];
  const requestEvents = [];
  const responseEvents = [];
  const failedRequests = [];
  const width = input.viewport?.width || 1280;
  const height = input.viewport?.height || 1080;
  const startedAt = Date.now();

  const launchOptions = {
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check']
  };
  if (input.executablePath) {
    launchOptions.executablePath = input.executablePath;
  }

  const browser = await pw.chromium.launch(launchOptions);
  const contextOptions = {
    viewport: { width, height },
    ignoreHTTPSErrors: true
  };
  if (input.recordVideo) {
    contextOptions.recordVideo = {
      dir: input.videoDir,
      size: { width, height }
    };
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const actionTimeline = [];

  async function runAction(action, index) {
    const kind = String(action.type || action.action || '').trim();
    const startedAt = Date.now();
    const entry = {
      index,
      type: kind,
      selector: action.selector || null,
      key: action.key || null,
      valueLength: action.text || action.value ? String(action.text || action.value).length : undefined,
      started_at_ms: startedAt,
      status: 'running'
    };
    try {
      const timeout = Math.max(250, Math.min(Number(action.timeoutMs || action.timeout_ms || 5000), input.timeoutMs));
      if (kind === 'click') {
        if (!action.selector) throw new Error('click action requires selector');
        await page.click(action.selector, { timeout });
      } else if (kind === 'fill' || kind === 'type') {
        if (!action.selector) throw new Error(`${kind} action requires selector`);
        const value = String(action.text ?? action.value ?? '');
        if (kind === 'fill') {
          await page.fill(action.selector, value, { timeout });
        } else {
          await page.type(action.selector, value, { timeout });
        }
      } else if (kind === 'press') {
        const key = String(action.key || '');
        if (!key) throw new Error('press action requires key');
        await page.press(action.selector || 'body', key, { timeout });
      } else if (kind === 'scroll') {
        if (action.selector) {
          await page.locator(action.selector).scrollIntoViewIfNeeded({ timeout });
        } else {
          await page.mouse.wheel(Number(action.x || 0), Number(action.y || 600));
        }
      } else if (kind === 'wait') {
        await page.waitForTimeout(Math.max(0, Math.min(Number(action.ms || action.waitMs || 1000), 30000)));
      } else if (kind === 'wait_for_selector') {
        if (!action.selector) throw new Error('wait_for_selector action requires selector');
        await page.waitForSelector(action.selector, { timeout });
      } else {
        throw new Error(`Unsupported browser action: ${kind || '(empty)'}`);
      }
      entry.status = 'success';
    } catch (error) {
      entry.status = 'error';
      entry.error = error && error.message ? error.message : String(error);
      if (!action.continueOnError && !action.continue_on_error) {
        throw error;
      }
    } finally {
      entry.finished_at_ms = Date.now();
      entry.duration_ms = entry.finished_at_ms - startedAt;
      actionTimeline.push(entry);
    }
  }

  page.on('console', msg => {
    if (consoleEvents.length >= input.maxConsoleEvents) return;
    consoleEvents.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location()
    });
  });
  page.on('request', request => {
    if (requestEvents.length >= input.maxNetworkEvents) return;
    requestEvents.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType()
    });
  });
  page.on('response', response => {
    if (responseEvents.length >= input.maxNetworkEvents) return;
    responseEvents.push({
      status: response.status(),
      url: response.url(),
      requestMethod: response.request().method(),
      resourceType: response.request().resourceType()
    });
  });
  page.on('requestfailed', request => {
    if (failedRequests.length >= input.maxNetworkEvents) return;
    const failure = request.failure();
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: failure ? failure.errorText : 'unknown'
    });
  });

  let navigationError = null;
  let mainResponse = null;
  try {
    mainResponse = await page.goto(input.url, {
      waitUntil: 'domcontentloaded',
      timeout: input.timeoutMs
    });
    try {
      await page.waitForLoadState('networkidle', { timeout: input.networkIdleTimeoutMs });
    } catch (_) {
      // Dynamic apps often keep sockets open. DOM + screenshot are still useful evidence.
    }
    if (input.waitMs > 0) {
      await page.waitForTimeout(input.waitMs);
    }
  } catch (error) {
    navigationError = error && error.message ? error.message : String(error);
  }

  let actionError = null;
  if (!navigationError && Array.isArray(input.actions)) {
    const actions = input.actions.slice(0, input.maxActions);
    for (let i = 0; i < actions.length; i++) {
      try {
        await runAction(actions[i] || {}, i);
      } catch (error) {
        actionError = error && error.message ? error.message : String(error);
        break;
      }
    }
  }

  let dom = null;
  if (input.captureDom) {
    dom = await page.evaluate(({ maxTextChars, maxHtmlChars, maxItems }) => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const itemText = node => clean(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '');
      const attr = (node, name) => node.getAttribute(name) || '';
      const list = (selector, mapper) => Array.from(document.querySelectorAll(selector)).slice(0, maxItems).map(mapper);
      const bodyText = clean(document.body ? document.body.innerText : '');
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      return {
        title: document.title || '',
        url: location.href,
        htmlLength: html.length,
        bodyTextLength: bodyText.length,
        bodyTextPreview: bodyText.slice(0, maxTextChars),
        htmlPreview: html.slice(0, maxHtmlChars),
        headings: list('h1,h2,h3', node => ({
          level: node.tagName.toLowerCase(),
          text: itemText(node)
        })).filter(item => item.text),
        links: list('a[href]', node => ({
          text: itemText(node).slice(0, 180),
          href: attr(node, 'href')
        })).filter(item => item.href),
        buttons: list('button,[role="button"],input[type="button"],input[type="submit"]', node => ({
          text: itemText(node).slice(0, 180),
          type: attr(node, 'type') || node.tagName.toLowerCase(),
          disabled: !!node.disabled || attr(node, 'aria-disabled') === 'true'
        })),
        inputs: list('input,textarea,select', node => ({
          tag: node.tagName.toLowerCase(),
          type: attr(node, 'type'),
          name: attr(node, 'name'),
          placeholder: attr(node, 'placeholder'),
          label: itemText(node.closest('label') || node).slice(0, 180)
        })),
        forms: list('form', node => ({
          action: attr(node, 'action'),
          method: attr(node, 'method') || 'get',
          text: itemText(node).slice(0, 240)
        })),
        landmarks: list('main,nav,header,footer,aside,[role="main"],[role="navigation"],[role="dialog"]', node => ({
          tag: node.tagName.toLowerCase(),
          role: attr(node, 'role'),
          text: itemText(node).slice(0, 220)
        }))
      };
    }, {
      maxTextChars: input.maxTextChars,
      maxHtmlChars: input.maxHtmlChars,
      maxItems: input.maxDomItems
    });
  }

  let screenshot = null;
  await page.screenshot({
    path: input.screenshotPath,
    fullPage: true,
    animations: 'disabled'
  });
  const screenshotStat = fs.statSync(input.screenshotPath);
  screenshot = {
    path: input.screenshotPath,
    mimeType: 'image/png',
    sizeBytes: screenshotStat.size,
    fullPage: true,
    viewport: { width, height }
  };

  const video = page.video();
  await context.close();
  await browser.close();

  let videoEvidence = null;
  if (video) {
    try {
      const videoPath = await video.path();
      const videoStat = fs.statSync(videoPath);
      videoEvidence = {
        path: videoPath,
        mimeType: 'video/webm',
        sizeBytes: videoStat.size,
        viewport: { width, height }
      };
    } catch (error) {
      videoEvidence = {
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  const finishedAt = Date.now();
  const degraded = navigationError || actionError;
  const result = {
    status: degraded ? 'partial_success' : 'success',
    capture_level: 'playwright_evidence_v2',
    message: degraded ? `Browser evidence captured with degraded execution: ${navigationError || actionError}` : 'Browser evidence captured.',
    output: degraded ? `Browser execution issue: ${navigationError || actionError}` : 'Browser evidence captured. Review DOM, action timeline, console, network, screenshot, and video evidence.',
    url: input.url,
    final_url: dom?.url || page.url(),
    title: dom?.title || '',
    main_response: mainResponse ? {
      status: mainResponse.status(),
      ok: mainResponse.ok(),
      url: mainResponse.url()
    } : null,
    navigation_error: navigationError,
    action_error: actionError,
    browser_evidence: {
      capture_level: 'playwright_evidence_v2',
      task: input.task,
      url: input.url,
      final_url: dom?.url || page.url(),
      title: dom?.title || '',
      started_at_ms: startedAt,
      finished_at_ms: finishedAt,
      duration_ms: finishedAt - startedAt,
      actions: actionTimeline,
      action_count: actionTimeline.length,
      screenshot,
      video: videoEvidence,
      dom,
      console: consoleEvents,
      network: {
        requests: requestEvents,
        responses: responseEvents,
        failed: failedRequests,
        request_count: requestEvents.length,
        response_count: responseEvents.length,
        failed_count: failedRequests.length
      }
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
}

main().catch(error => {
  const outputPath = process.argv[3];
  fs.writeFileSync(outputPath, JSON.stringify({
    status: 'error',
    capture_level: 'playwright_evidence_v1',
    error: error && error.stack ? error.stack : String(error)
  }, null, 2));
  process.exit(1);
});
"#;

pub struct BrowserSubagentTool;

#[derive(Clone, Debug)]
struct BrowserCapturePaths {
    dir: PathBuf,
    script: PathBuf,
    input: PathBuf,
    output: PathBuf,
    screenshot: PathBuf,
    video_dir: PathBuf,
}

impl BrowserCapturePaths {
    fn new() -> anyhow::Result<Self> {
        let dir = std::env::temp_dir().join(format!("aixlarity_browser_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir)?;
        let video_dir = dir.join("video");
        fs::create_dir_all(&video_dir)?;
        Ok(Self {
            script: dir.join("capture.js"),
            input: dir.join("input.json"),
            output: dir.join("output.json"),
            screenshot: dir.join("screenshot.png"),
            video_dir,
            dir,
        })
    }
}

#[async_trait::async_trait]
impl Tool for BrowserSubagentTool {
    fn name(&self) -> &str {
        "browser_subagent"
    }

    fn description(&self) -> &str {
        "Integrated Browser Agent v2. Navigates to a URL, can perform deterministic browser actions, and captures verifiable evidence: action timeline, DOM summary, console events, network requests/responses, full-page screenshot, and a short browser recording when supported. Use this whenever a task needs browser verification or visual UI evidence."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The browser verification task to perform, e.g. 'Verify the login page renders and capture evidence'."
                },
                "url": {
                    "type": "string",
                    "description": "Required starting URL. Must start with http:// or https://."
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "Optional extra wait after navigation for client-rendered UI. Defaults to 1000ms."
                },
                "record_video": {
                    "type": "boolean",
                    "description": "Capture a WebM browser recording artifact when Playwright is available. Defaults to true."
                },
                "capture_dom": {
                    "type": "boolean",
                    "description": "Capture a structured DOM summary and text/html previews. Defaults to true."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Navigation timeout. Defaults to 30000ms."
                },
                "actions": {
                    "type": "array",
                    "description": "Optional deterministic browser action sequence to perform before final evidence capture.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "description": "click, fill, type, press, scroll, wait, or wait_for_selector." },
                            "selector": { "type": "string", "description": "CSS selector for element-targeted actions." },
                            "text": { "type": "string", "description": "Input text for fill/type actions. Text is not stored in evidence, only its length." },
                            "value": { "type": "string", "description": "Alternative input value for fill/type actions." },
                            "key": { "type": "string", "description": "Keyboard key for press actions, e.g. Enter." },
                            "x": { "type": "integer", "description": "Horizontal wheel delta for page-level scroll." },
                            "y": { "type": "integer", "description": "Vertical wheel delta for page-level scroll." },
                            "ms": { "type": "integer", "description": "Wait duration for wait actions." },
                            "timeout_ms": { "type": "integer", "description": "Per-action timeout." },
                            "continue_on_error": { "type": "boolean", "description": "Record the action error and continue to later actions." }
                        }
                    }
                }
            },
            "required": ["task", "url"]
        })
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> anyhow::Result<Value> {
        let task = params["task"].as_str().unwrap_or("").trim();
        let url = params["url"].as_str().unwrap_or("").trim();

        validate_url(url)?;

        let wait_ms = params["wait_ms"].as_u64().unwrap_or(1000).min(30_000);
        let record_video = params["record_video"].as_bool().unwrap_or(true);
        let capture_dom = params["capture_dom"].as_bool().unwrap_or(true);
        let timeout_ms = params["timeout_ms"]
            .as_u64()
            .unwrap_or(30_000)
            .clamp(5_000, 120_000);
        let actions = params
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let capture = tokio::task::spawn_blocking({
            let workspace_root = ctx.workspace_root.clone();
            let task = task.to_string();
            let url = url.to_string();
            let actions = actions.clone();
            move || {
                capture_with_playwright(BrowserCaptureRequest {
                    workspace_root: &workspace_root,
                    task: &task,
                    url: &url,
                    wait_ms,
                    record_video,
                    capture_dom,
                    timeout_ms,
                    actions,
                })
            }
        })
        .await?;

        match capture {
            Ok((result, screenshot_bytes)) => {
                let attachments = vec![AgentAttachment {
                    mime_type: "image/png".to_string(),
                    data_base64: base64.encode(&screenshot_bytes),
                }];
                Ok(embed_tool_attachments(result, attachments))
            }
            Err(playwright_error) => {
                let (result, screenshot_bytes) = tokio::task::spawn_blocking({
                    let task = task.to_string();
                    let url = url.to_string();
                    move || capture_screenshot_fallback(&task, &url, &playwright_error)
                })
                .await??;
                let attachments = vec![AgentAttachment {
                    mime_type: "image/png".to_string(),
                    data_base64: base64.encode(&screenshot_bytes),
                }];
                Ok(embed_tool_attachments(result, attachments))
            }
        }
    }
}

struct BrowserCaptureRequest<'a> {
    workspace_root: &'a Path,
    task: &'a str,
    url: &'a str,
    wait_ms: u64,
    record_video: bool,
    capture_dom: bool,
    timeout_ms: u64,
    actions: Vec<Value>,
}

fn capture_with_playwright(request: BrowserCaptureRequest<'_>) -> anyhow::Result<(Value, Vec<u8>)> {
    let paths = BrowserCapturePaths::new()?;
    fs::write(&paths.script, PLAYWRIGHT_CAPTURE_SCRIPT)?;

    let input = serde_json::json!({
        "task": request.task,
        "url": request.url,
        "screenshotPath": paths.screenshot,
        "videoDir": paths.video_dir,
        "recordVideo": request.record_video,
        "captureDom": request.capture_dom,
        "waitMs": request.wait_ms,
        "timeoutMs": request.timeout_ms,
        "networkIdleTimeoutMs": 5000,
        "maxTextChars": 12000,
        "maxHtmlChars": 8000,
        "maxDomItems": 80,
        "maxConsoleEvents": 120,
        "maxNetworkEvents": 160,
        "maxActions": 50,
        "actions": request.actions,
        "viewport": { "width": 1280, "height": 1080 },
        "executablePath": find_native_chrome()
    });
    fs::write(&paths.input, serde_json::to_vec_pretty(&input)?)?;

    let mut command = Command::new("node");
    command
        .arg(&paths.script)
        .arg(&paths.input)
        .arg(&paths.output)
        .current_dir(request.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(node_path) = find_playwright_node_path(request.workspace_root) {
        merge_node_path(&mut command, &node_path);
    }

    let output = command.output()?;
    let result_text = fs::read_to_string(&paths.output).unwrap_or_default();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary = if result_text.is_empty() {
            stderr.to_string()
        } else {
            result_text
        };
        cleanup_non_recording_files(&paths, false);
        anyhow::bail!("Playwright evidence capture failed: {}", summary.trim());
    }

    let mut result: Value = serde_json::from_str(&result_text)?;
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "message".to_string(),
            Value::String(format!("Browser subagent completed task: {}", request.task)),
        );
        object.insert(
            "output".to_string(),
            Value::String(
                "Browser evidence captured. Review DOM, console, network, screenshot, and video evidence."
                    .to_string(),
            ),
        );
    }

    let screenshot_bytes = fs::read(&paths.screenshot)?;
    cleanup_non_recording_files(&paths, has_video_path(&result));
    Ok((result, screenshot_bytes))
}

fn capture_screenshot_fallback(
    task: &str,
    url: &str,
    playwright_error: &anyhow::Error,
) -> anyhow::Result<(Value, Vec<u8>)> {
    let temp_png = std::env::temp_dir().join(format!("aixlarity_browser_{}.png", Uuid::new_v4()));

    let status = if let Some(chrome) = find_native_chrome() {
        Command::new(chrome)
            .arg("--headless")
            .arg("--disable-gpu")
            .arg("--window-size=1280,1080")
            .arg(format!("--screenshot={}", temp_png.display()))
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        Command::new("npx")
            .arg("-y")
            .arg("playwright")
            .arg("screenshot")
            .arg("--full-page")
            .arg(url)
            .arg(&temp_png)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    }?;

    if cfg!(target_os = "macos") && temp_png.exists() {
        let _ = Command::new("sips")
            .arg("-Z")
            .arg("1080")
            .arg(&temp_png)
            .status();
    }

    if !status.success() {
        anyhow::bail!(
            "Browser evidence capture failed, and screenshot fallback failed (exit status: {}). Playwright error: {}",
            status,
            playwright_error
        );
    }

    let image_bytes = fs::read(&temp_png)?;
    let _ = fs::remove_file(&temp_png);

    let result = serde_json::json!({
        "status": "partial_success",
        "capture_level": "screenshot_fallback",
        "message": format!("Browser subagent completed task with screenshot fallback: {}", task),
        "output": "Screenshot captured, but DOM/console/network/video evidence was unavailable. See fallback_error.",
        "url": url,
        "final_url": url,
        "title": "",
        "fallback_error": playwright_error.to_string(),
        "browser_evidence": {
            "capture_level": "screenshot_fallback",
            "task": task,
            "url": url,
            "final_url": url,
            "screenshot": {
                "mimeType": "image/png",
                "sizeBytes": image_bytes.len(),
                "fullPage": false,
                "viewport": { "width": 1280, "height": 1080 }
            },
            "video": null,
            "dom": null,
            "console": [],
            "network": {
                "requests": [],
                "responses": [],
                "failed": [],
                "request_count": 0,
                "response_count": 0,
                "failed_count": 0
            }
        }
    });

    Ok((result, image_bytes))
}

fn validate_url(url: &str) -> anyhow::Result<()> {
    if url.is_empty() {
        anyhow::bail!("Browser subagent requires a starting URL.");
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        anyhow::bail!("Browser subagent URL must start with http:// or https://.");
    }
    Ok(())
}

fn find_native_chrome() -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
    } else {
        vec![
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/snap/bin/chromium",
        ]
    };

    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
}

fn find_playwright_node_path(workspace_root: &Path) -> Option<PathBuf> {
    for var in ["AIXLARITY_PLAYWRIGHT_NODE_PATH", "AIXLARITY_NODE_MODULES"] {
        if let Ok(value) = std::env::var(var) {
            let path = PathBuf::from(value);
            if path.join("playwright").exists() || path.join("playwright-core").exists() {
                return Some(path);
            }
        }
    }

    for ancestor in workspace_root.ancestors() {
        for candidate in [
            ancestor.join("node_modules"),
            ancestor.join("aixlarity-ide").join("node_modules"),
        ] {
            if candidate.join("playwright").exists() || candidate.join("playwright-core").exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn merge_node_path(command: &mut Command, node_path: &Path) {
    let mut merged = OsString::new();
    merged.push(node_path.as_os_str());
    if let Some(existing) = std::env::var_os("NODE_PATH") {
        merged.push(if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        });
        merged.push(existing);
    }
    command.env("NODE_PATH", merged);
}

fn cleanup_non_recording_files(paths: &BrowserCapturePaths, keep_video_dir: bool) {
    let _ = fs::remove_file(&paths.script);
    let _ = fs::remove_file(&paths.input);
    let _ = fs::remove_file(&paths.output);
    let _ = fs::remove_file(&paths.screenshot);
    if !keep_video_dir {
        let _ = fs::remove_dir_all(&paths.dir);
    }
}

fn has_video_path(result: &Value) -> bool {
    result
        .get("browser_evidence")
        .and_then(|e| e.get("video"))
        .and_then(|v| v.get("path"))
        .and_then(|p| p.as_str())
        .map(|path| !path.is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{capture_with_playwright, has_video_path, validate_url, BrowserCaptureRequest};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn validate_url_rejects_non_http_targets() {
        assert!(validate_url("").is_err());
        assert!(validate_url("file:///tmp/index.html").is_err());
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://localhost:3000").is_ok());
    }

    #[test]
    fn detects_video_path_in_result() {
        let with_video = serde_json::json!({
            "browser_evidence": {
                "video": { "path": "/tmp/video.webm" }
            }
        });
        let without_video = serde_json::json!({
            "browser_evidence": {
                "video": { "error": "disabled" }
            }
        });
        assert!(has_video_path(&with_video));
        assert!(!has_video_path(&without_video));
    }

    #[test]
    #[ignore = "requires local Node.js, Playwright, and a headless Chromium/Chrome browser"]
    fn live_playwright_capture_collects_browser_evidence() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
        let addr = listener.local_addr().expect("local addr");
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer);
                let body = r#"<!doctype html>
<html>
<head><title>Aixlarity Browser Evidence</title></head>
<body>
  <main>
    <h1>Evidence Ready</h1>
    <button id="primary">Ship it</button>
    <a href="/next">Next</a>
  </main>
  <script>
    console.log('browser evidence console marker');
    fetch('/api/ping').catch(() => {});
  </script>
</body>
</html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let cwd = std::env::current_dir().expect("cwd");
        let url = format!("http://{}", addr);
        let (result, screenshot) = capture_with_playwright(BrowserCaptureRequest {
            workspace_root: &cwd,
            task: "capture local evidence",
            url: &url,
            wait_ms: 250,
            record_video: true,
            capture_dom: true,
            timeout_ms: 10_000,
            actions: vec![serde_json::json!({
                "type": "click",
                "selector": "#primary",
                "continue_on_error": true
            })],
        })
        .expect("playwright capture");

        let evidence = result
            .get("browser_evidence")
            .expect("browser evidence result");
        assert!(!screenshot.is_empty());
        assert_eq!(evidence["title"], "Aixlarity Browser Evidence");
        assert!(evidence["dom"]["bodyTextPreview"]
            .as_str()
            .unwrap_or_default()
            .contains("Evidence Ready"));
        assert!(evidence["network"]["request_count"].as_u64().unwrap_or(0) > 0);
        assert_eq!(evidence["action_count"].as_u64().unwrap_or(0), 1);
        assert!(has_video_path(&result));
        let _ = server.join();
    }
}
