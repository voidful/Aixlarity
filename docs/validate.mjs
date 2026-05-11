#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(docsDir);
const chaptersDir = path.join(docsDir, 'chapters');
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

function count(text, pattern) {
  return (text.match(pattern) || []).length;
}

function assertBalanced(file, text, tag) {
  const open = count(text, new RegExp(`<${tag}\\b`, 'g'));
  const close = count(text, new RegExp(`</${tag}>`, 'g'));
  if (open !== close) {
    fail(`${file}: unbalanced <${tag}> tags (${open} open, ${close} close)`);
  }
}

const manifestPath = path.join(chaptersDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ids = manifest.nav.flatMap((section) => section.items.map((item) => item.id));

for (const id of ids) {
  const chapterPath = path.join(chaptersDir, `${id}.html`);
  if (!fs.existsSync(chapterPath)) {
    fail(`manifest references missing chapter: ${id}`);
  }
}

for (const id of ids) {
  if (ids.indexOf(id) !== ids.lastIndexOf(id)) {
    fail(`manifest contains duplicate chapter id: ${id}`);
  }
}

for (const id of ids) {
  const chapterPath = path.join(chaptersDir, `${id}.html`);
  if (!fs.existsSync(chapterPath)) continue;
  const text = fs.readFileSync(chapterPath, 'utf8');
  for (const match of text.matchAll(/navigateTo\('([^']+)'\)/g)) {
    if (!ids.includes(match[1])) {
      fail(`${id}.html navigates to unknown chapter: ${match[1]}`);
    }
  }
}

for (const file of fs.readdirSync(chaptersDir).filter((name) => name.endsWith('.html'))) {
  const text = fs.readFileSync(path.join(chaptersDir, file), 'utf8');
  for (const tag of ['section', 'div', 'article', 'table', 'tbody', 'tr', 'pre']) {
    assertBalanced(file, text, tag);
  }
}

const corpus = [
  'README.md',
  'README.en.md',
  'docs/index.html',
  'docs/style.css',
  'docs/script.js',
  ...fs.readdirSync(chaptersDir).filter((name) => name.endsWith('.html')).map((name) => `docs/chapters/${name}`),
].map((relativePath) => [relativePath, read(relativePath)]);

const bannedPatterns = [
  /\bGemiClawDex\b/,
  /\bGCD\b/,
  /\.gcd\b/,
  /\bgcd\b/,
  /AI AI/,
  /仍屬 。/,
  /標 。/,
  /標  的/,
  /容易容易/,
];

for (const [relativePath, text] of corpus) {
  for (const pattern of bannedPatterns) {
    if (pattern.test(text)) {
      fail(`${relativePath}: banned legacy or broken text matched ${pattern}`);
    }
  }
}

const indexHtml = read('docs/index.html');
const homeHtml = read('docs/chapters/home.html');
const styleCss = read('docs/style.css');
const scriptJs = read('docs/script.js');
const readmeZh = read('README.md');
const readmeEn = read('README.en.md');
const releaseWorkflow = read('.github/workflows/release.yml');

const homepageChecks = [
  ['docs/assets/aixlarity-icon.ai source exists', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-icon.ai'))],
  ['docs/assets/aixlarity-icon.png exists', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-icon.png'))],
  ['docs/favicon.ico exists for root browser favicon requests', fs.existsSync(path.join(docsDir, 'favicon.ico'))],
  ['docs/apple-touch-icon.png exists for mobile home screen icons', fs.existsSync(path.join(docsDir, 'apple-touch-icon.png'))],
  ['docs/site.webmanifest exists for installable site icons', fs.existsSync(path.join(docsDir, 'site.webmanifest'))],
  ['docs manifest icons exist', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-icon-192.png')) && fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-icon-512.png'))],
  ['docs/assets/aixlarity-ide-mission-control.png exists', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-ide-mission-control.png'))],
  ['docs/assets/aixlarity-ide-diff-review.png exists', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-ide-diff-review.png'))],
  ['docs/assets/aixlarity-ide-knowledge-ledger.png exists', fs.existsSync(path.join(docsDir, 'assets', 'aixlarity-ide-knowledge-ledger.png'))],
  ['index uses Aixlarity icon asset', indexHtml.includes('assets/aixlarity-icon.png')],
  ['index exposes root favicon, apple touch icon, and web manifest', indexHtml.includes('href="favicon.ico"') && indexHtml.includes('href="apple-touch-icon.png"') && indexHtml.includes('href="site.webmanifest"')],
  ['index social preview uses Aixlarity domain icon', indexHtml.includes('https://aixlarity.com/assets/aixlarity-icon-512.png')],
  ['home includes IDE product hero', homeHtml.includes('ide-product-hero')],
  ['home includes brand lockup icon', homeHtml.includes('ide-brand-lockup') && homeHtml.includes('assets/aixlarity-icon.png')],
  ['home includes release download panel', homeHtml.includes('id="download-aixlarity"') && homeHtml.includes('releases/latest/download/Aixlarity-darwin-arm64.dmg')],
  ['home exposes macOS, Windows, Linux downloads', homeHtml.includes('Aixlarity-darwin-x64.dmg') && homeHtml.includes('Aixlarity-win32-x64-user-setup.exe') && homeHtml.includes('Aixlarity-linux-x64.deb')],
  ['home exposes release checksums', homeHtml.includes('SHASUMS256.txt')],
  ['home includes visual capability board', homeHtml.includes('ide-capability-board')],
  ['home includes IDE screenshot showcase', homeHtml.includes('ide-interface-showcase') && homeHtml.includes('aixlarity-ide-mission-control.png')],
  ['home includes animated workflow rail', homeHtml.includes('ide-flow-visual')],
  ['home styles platform download cards', styleCss.includes('.download-panel') && styleCss.includes('.download-card') && styleCss.includes('.platform-mark')],
  ['home styles screenshot cards', styleCss.includes('ide-screenshot-card')],
  ['release workflow builds native macOS, Windows, and Linux artifacts', releaseWorkflow.includes('macos-15-intel') && releaseWorkflow.includes('windows-11-arm') && releaseWorkflow.includes('ubuntu-24.04-arm')],
  ['release workflow publishes exact homepage artifact name templates', releaseWorkflow.includes('Aixlarity-darwin-${VSCODE_ARCH}.dmg') && releaseWorkflow.includes('Aixlarity-win32-$env:VSCODE_ARCH-user-setup.exe') && releaseWorkflow.includes('Aixlarity-linux-${VSCODE_ARCH}.deb')],
  ['release workflow emits combined SHA-256 checksums', releaseWorkflow.includes('SHASUMS256.txt') && releaseWorkflow.includes('sha256sum Aixlarity-* aixlarity-cli-*')],
  ['release workflow archives VS Code build output from repo root', releaseWorkflow.includes('"VSCode-darwin-${VSCODE_ARCH}/Aixlarity.app"') && releaseWorkflow.includes('"VSCode-win32-$env:VSCODE_ARCH/*"') && releaseWorkflow.includes('-C . "VSCode-linux-${VSCODE_ARCH}"')],
  ['release workflow provides build commit to Windows installer', releaseWorkflow.includes('BUILD_SOURCEVERSION: ${{ github.sha }}')],
  ['release workflow has tracked IDE build scripts', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'build', 'gulpfile.vscode.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'build', 'npm', 'preinstall.ts'))],
  ['release workflow has tracked Copilot extension postinstall helpers', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'script', 'build', 'compressTikToken.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'script', 'build', 'copyStaticAssets.ts'))],
  ['release workflow has tracked Copilot bundle env sources', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'platform', 'env', 'common', 'envService.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'platform', 'env', 'vscode', 'envServiceImpl.ts'))],
  ['release workflow has tracked Copilot simulation extension sources', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', '.vscode', 'extensions', 'test-extension', 'main.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', '.vscode', 'extensions', 'visualization-runner', 'entry.js'))],
  ['release workflow has tracked Copilot esbuild entrypoints', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'extension', 'extension', 'vscode-node', 'extension.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'extension', 'extension', 'vscode-worker', 'extension.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'platform', 'parser', 'node', 'parserWorker.ts'))],
  ['release workflow has tracked Copilot test and server plugin entrypoints', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'test', 'simulationMain.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'test', 'simulation', 'workbench', 'simulationWorkbench.tsx')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'extension', 'typescriptContext', 'serverPlugin', 'src', 'node', 'main.ts'))],
  ['release workflow has tracked Copilot webview entrypoint', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'src', 'extension', 'completions-core', 'vscode-node', 'extension', 'src', 'copilotPanel', 'webView', 'suggestionsPanelWebview.ts'))],
  ['release workflow has tracked selfhost extension package dirs', fs.existsSync(path.join(rootDir, 'aixlarity-ide', '.vscode', 'extensions', 'vscode-selfhost-import-aid', 'package.json')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', '.vscode', 'extensions', 'vscode-selfhost-test-provider', 'package.json')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', '.vscode', 'extensions', 'vscode-extras', 'package.json'))],
  ['release workflow has tracked terminal suggest env sources', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'terminal-suggest', 'src', 'env', 'pathExecutableCache.ts'))],
  ['release workflow has tracked VS Code parts sources', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'src', 'vs', 'base', 'parts', 'ipc', 'common', 'ipc.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'src', 'vs', 'workbench', 'browser', 'parts', 'views', 'viewPane.ts')) && fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'editorPane.ts'))],
  ['release workflow tolerates missing tunnel binary in Linux dependency scan', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'build', 'linux', 'dependencies-generator.ts')) && fs.readFileSync(path.join(rootDir, 'aixlarity-ide', 'build', 'linux', 'dependencies-generator.ts'), 'utf8').includes('fs.existsSync(tunnelPath)')],
  ['release workflow warns on Linux dependency drift instead of blocking packages', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'build', 'linux', 'dependencies-generator.ts')) && fs.readFileSync(path.join(rootDir, 'aixlarity-ide', 'build', 'linux', 'dependencies-generator.ts'), 'utf8').includes('FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = false')],
  ['release workflow filters Copilot native prebuilds by target platform', fs.existsSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'script', 'postinstall.ts')) && fs.readFileSync(path.join(rootDir, 'aixlarity-ide', 'extensions', 'copilot', 'script', 'postinstall.ts'), 'utf8').includes('const platformDir = `${process.platform}-${process.arch}`')],
  ['release workflow passes GitHub token to dependency postinstall scripts', releaseWorkflow.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')],
  ['release workflow prepares Windows updater before setup', releaseWorkflow.includes('vscode-win32-$($env:VSCODE_ARCH)-inno-updater')],
  ['README zh uses product icon and IDE screenshot', readmeZh.includes('docs/assets/aixlarity-icon.png') && readmeZh.includes('docs/assets/aixlarity-ide-mission-control.png')],
  ['README en uses product icon and IDE screenshot', readmeEn.includes('docs/assets/aixlarity-icon.png') && readmeEn.includes('docs/assets/aixlarity-ide-mission-control.png')],
  ['README links the public product domain', readmeZh.includes('https://aixlarity.com') && readmeEn.includes('https://aixlarity.com')],
  ['README highlights Knowledge Ledger selling point', readmeZh.includes('Knowledge Ledger') && readmeEn.includes('Knowledge Ledger')],
  ['home removed old text-only audience cards', !/For builders|For reviewers|For learners/.test(homeHtml)],
  ['home hides chapter rail for product landing page', styleCss.includes('body[data-current-chapter="home"] .chapter-rail')],
  ['script exposes current chapter on body', scriptJs.includes('document.body.dataset.currentChapter = id')],
];

for (const [label, ok] of homepageChecks) {
  if (!ok) fail(`homepage quality check failed: ${label}`);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    `${ids.length} manifest chapters exist and have valid navigation targets`,
    'chapter HTML container tags are balanced',
    'legacy project naming and broken text fragments are absent',
    'IDE landing page icon, release downloads, screenshot showcase, visual capability board, and workflow rail are wired',
    'release workflow builds native macOS, Windows, and Linux artifacts with checksums',
    'README product hero assets, Aixlarity domain, and Knowledge Ledger selling point are wired',
  ],
}, null, 2));
