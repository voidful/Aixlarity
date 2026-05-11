import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron } from '@playwright/test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '../..');
const repoRoot = path.resolve(root, '..');
const electronPath = resolveElectronPath(root);
const aixlarityBin = resolveAixlarityBinary(repoRoot);
const screenshotsDir = path.join(root, '.build', 'aixlarity-ui-smoke');

function resolveElectronPath(rootPath) {
	const product = JSON.parse(fs.readFileSync(path.join(rootPath, 'product.json'), 'utf8'));
	if (process.platform === 'darwin') {
		return path.join(rootPath, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort);
	}
	if (process.platform === 'win32') {
		return path.join(rootPath, '.build', 'electron', `${product.nameShort}.exe`);
	}
	return path.join(rootPath, '.build', 'electron', product.applicationName);
}

function resolveAixlarityBinary(repoRootPath) {
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const candidates = [
		path.join(repoRootPath, 'target', 'release', `aixlarity${suffix}`),
		path.join(repoRootPath, 'target', 'debug', `aixlarity${suffix}`),
	];
	return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function tempDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSeedWorkspace(workspace) {
	const now = Date.now();
	fs.mkdirSync(path.join(workspace, '.aixlarity', 'state'), { recursive: true });
	fs.mkdirSync(path.join(workspace, '.aixlarity', 'commands'), { recursive: true });
	fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'src', 'demo.ts'), 'export const name = "gcd";\n');
	fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Project Rules\n\nUse Aixlarity naming.\n');
	fs.writeFileSync(path.join(workspace, '.aixlarity', 'commands', 'review.toml'), 'name = "review"\nprompt = "Review {{args}}"\n');
	fs.writeFileSync(path.join(workspace, '.aixlarity', 'MEMORY.md'), '# Memory\n\nProject was renamed to Aixlarity.\n');
	fs.writeFileSync(path.join(workspace, '.aixlarity', 'mcp.json'), JSON.stringify({ servers: {} }, null, 2));

	const diff = [
		'diff --git a/src/demo.ts b/src/demo.ts',
		'index 1111111..2222222 100644',
		'--- a/src/demo.ts',
		'+++ b/src/demo.ts',
		'@@ -1 +1 @@',
		'-export const name = "gcd";',
		'+export const name = "aixlarity";',
	].join('\n');
	const diffRound2 = [
		'diff --git a/src/demo.ts b/src/demo.ts',
		'index 2222222..3333333 100644',
		'--- a/src/demo.ts',
		'+++ b/src/demo.ts',
		'@@ -1 +1,2 @@',
		' export const name = "aixlarity";',
		'+export const tagline = "open agent IDE";',
	].join('\n');

	const state = {
		schema: 'aixlarity.mission_control_state.v1',
		version: 1,
		savedAt: now,
		workspace,
		tasks: [{
			id: 'task-ui-smoke',
			title: 'UI Smoke Task',
			status: 'waiting_review',
			progressLabel: 'Waiting for UI review.',
			artifactIds: ['diff-ui-smoke', 'diff-ui-smoke-round2', 'browser-ui-smoke', 'terminal-ui-smoke'],
			createdAt: now,
			updatedAt: now,
			timeline: [],
		}],
		artifacts: [{
			id: 'diff-ui-smoke',
			taskId: 'task-ui-smoke',
			name: 'UI Smoke Diff',
			kind: 'code_diff',
			status: 'needs_review',
			summary: 'Review the UI smoke rename diff.',
			path: path.join(workspace, 'src', 'demo.ts'),
			body: diff,
			evidence: [{ label: 'Smoke', value: 'Playwright Electron UI' }],
			attachments: [],
			comments: [],
			reviewThreads: [{
				id: 'thread-ui-seed',
				artifactId: 'diff-ui-smoke',
				anchor: { kind: 'line', label: 'src/demo.ts:1', path: 'src/demo.ts', line: 1 },
				status: 'open',
				comments: [{ id: 'comment-ui-seed', author: 'user', body: 'seeded anchored thread', createdAt: now }],
				createdAt: now,
				updatedAt: now,
			}],
			createdAt: now,
			updatedAt: now,
		}, {
			id: 'diff-ui-smoke-round2',
			taskId: 'task-ui-smoke',
			name: 'UI Smoke Diff Round 2',
			kind: 'code_diff',
			status: 'needs_review',
			summary: 'Review the second UI smoke diff round.',
			path: path.join(workspace, 'src', 'demo.ts'),
			body: diffRound2,
			evidence: [{ label: 'Smoke', value: 'Playwright Electron UI' }],
			attachments: [],
			comments: [],
			reviewThreads: [],
			createdAt: now + 1,
			updatedAt: now + 1,
		}, {
			id: 'browser-ui-smoke',
			taskId: 'task-ui-smoke',
			name: 'Browser Recording',
			kind: 'browser_recording',
			status: 'needs_review',
			summary: 'Managed browser captured DOM, console, network, and screenshot evidence.',
			body: 'Action Timeline\n- navigate http://localhost:3000\nConsole Events\n- no errors\nNetwork\n- GET / 200',
			evidence: [
				{ label: 'URL', value: 'http://localhost:3000' },
				{ label: 'Console Events', value: '0 errors' },
				{ label: 'Network Requests', value: '1' },
			],
			attachments: [],
			comments: [],
			reviewThreads: [],
			createdAt: now,
			updatedAt: now,
		}, {
			id: 'terminal-ui-smoke',
			taskId: 'task-ui-smoke',
			name: 'Terminal Transcript',
			kind: 'terminal_transcript',
			status: 'needs_review',
			summary: 'Replayable command transcript with cwd, exit code, stdout, and stderr.',
			body: '$ echo aixlarity-ui-smoke\nstdout: aixlarity-ui-smoke\nexit code: 0',
			evidence: [
				{ label: 'Command', value: 'echo aixlarity-ui-smoke' },
				{ label: 'CWD', value: workspace },
				{ label: 'Exit code', value: '0' },
			],
			attachments: [],
			comments: [],
			reviewThreads: [],
			createdAt: now,
			updatedAt: now,
		}],
	};

	fs.writeFileSync(
		path.join(workspace, '.aixlarity', 'state', 'mission_control.json'),
		JSON.stringify(state, null, 2)
	);
	fs.writeFileSync(
		path.join(workspace, '.aixlarity', 'state', 'audit.jsonl'),
		`${JSON.stringify({
			schema: 'aixlarity.audit_event.v1',
			event_id: 'audit-ui-seed',
			kind: 'artifact_review',
			artifact_id: 'diff-ui-smoke',
			artifact_name: 'UI Smoke Diff',
			artifact_kind: 'code_diff',
			status: 'needs_review',
			comment: 'seeded review event',
			created_at_ms: now,
			workspace,
		})}\n`
	);
}

async function openAixlarityView(page) {
	const commandShortcut = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
	await page.keyboard.press(commandShortcut);
	const input = page.locator('.quick-input-widget input');
	await input.waitFor({ timeout: 30_000 });
	await input.fill('Aixlarity Agent Chat');
	await page.keyboard.press('Enter');
	await page.waitForSelector('.aixlarity-agent-container', { timeout: 60_000 });
}

async function emitApprovalRequest(app) {
	const payload = {
		jsonrpc: '2.0',
		method: 'approval_request',
		id: 'ui-smoke-rpc',
		params: {
			call_id: 'ui-smoke-call',
			tool_name: 'shell',
			arguments: {
				command: 'echo aixlarity-ui-smoke',
				cwd: '/tmp',
			},
		},
	};
	await app.evaluate(({ BrowserWindow }, message) => {
		const win = BrowserWindow.getAllWindows()[0];
		win.webContents.send('vscode:aixlarity:daemonOut', `${JSON.stringify(message)}\n`);
	}, payload);
}

async function primeSeededMissionState(page) {
	await page.locator('.aixlarity-conv-pill').filter({ hasText: 'Fleet' }).click();
	await page.waitForSelector('.aixlarity-manager-title', { timeout: 60_000 });
	const refresh = page.locator('.aixlarity-manager-actions button').filter({ hasText: /Refresh|Refreshing/ }).first();
	for (let attempt = 0; attempt < 3; attempt++) {
		await refresh.click();
		try {
			await page.waitForFunction(
				() => document.querySelector('.aixlarity-fleet-manager')?.textContent?.toLowerCase().includes('ui smoke diff'),
				null,
				{ timeout: 10_000 }
			);
			await page.locator('.aixlarity-conv-pill').filter({ hasText: 'Fleet' }).click();
			return;
		} catch {
			// The manager restore path is async; retrying here keeps the smoke test focused on UI behavior.
		}
	}
	await assertVisibleText(page, '.aixlarity-fleet-manager', 'UI Smoke Diff');
	await page.locator('.aixlarity-conv-pill').filter({ hasText: 'Fleet' }).click();
}

async function assertVisibleText(page, selector, text) {
	try {
		await page.waitForFunction(
			({ selector: cssSelector, text: expected }) => document.querySelector(cssSelector)?.textContent?.toLowerCase().includes(expected.toLowerCase()),
			{ selector, text },
			{ timeout: 30_000 }
		);
	} catch (error) {
		const currentText = await page.locator(selector).innerText().catch(() => '');
		throw new Error(`Missing UI text "${text}" in "${selector}". Current text:\n${currentText.slice(0, 4000)}`, { cause: error });
	}
}

async function run() {
	if (!fs.existsSync(electronPath)) {
		throw new Error(`Cannot find Electron app at ${electronPath}. Run npm run electron from aixlarity-ide first.`);
	}
	if (!fs.existsSync(aixlarityBin)) {
		throw new Error(`Cannot find Aixlarity binary at ${aixlarityBin}. Run cargo build -p aixlarity first.`);
	}

	fs.rmSync(screenshotsDir, { recursive: true, force: true });
	fs.mkdirSync(screenshotsDir, { recursive: true });

	const workspace = tempDir('aixlarity-ui-workspace-');
	const userDataDir = tempDir('aixlarity-ui-user-');
	const extensionsDir = tempDir('aixlarity-ui-ext-');
	const logsPath = tempDir('aixlarity-ui-logs-');
	const crashesPath = tempDir('aixlarity-ui-crash-');
	writeSeedWorkspace(workspace);

	const app = await _electron.launch({
		executablePath: electronPath,
		args: [
			root,
			workspace,
			'--skip-release-notes',
			'--skip-welcome',
			'--disable-telemetry',
			'--disable-experiments',
			'--disable-updates',
			'--disable-workspace-trust',
			'--disable-extension=vscode.vscode-api-tests',
			'--enable-smoke-test-driver',
			'--no-cached-data',
			`--user-data-dir=${userDataDir}`,
			`--extensions-dir=${extensionsDir}`,
			`--logsPath=${logsPath}`,
			`--crash-reporter-directory=${crashesPath}`,
		],
		env: {
			...process.env,
			NODE_ENV: 'development',
			VSCODE_DEV: '1',
			VSCODE_CLI: '1',
			ELECTRON_ENABLE_LOGGING: '1',
		},
	});

	try {
		const page = await app.firstWindow();
		const pageErrors = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
		await page.waitForFunction(() => Boolean(globalThis.driver), null, { timeout: 60_000 });
		await openAixlarityView(page);

		await primeSeededMissionState(page);
		await emitApprovalRequest(app);
		await page.waitForSelector('.aixlarity-approval-card', { timeout: 30_000 });
		await page.screenshot({ path: path.join(screenshotsDir, 'approval-request.png'), fullPage: true });

		await page.locator('.aixlarity-conv-pill').filter({ hasText: 'Fleet' }).click();
		await page.waitForSelector('.aixlarity-manager-title', { timeout: 60_000 });
		await page.locator('.aixlarity-manager-actions button').filter({ hasText: /Refresh|Refreshing/ }).first().click();
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'UI Smoke Diff');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'shell: echo aixlarity-ui-smoke');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Verification Passport');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Missing: plan, tests, review');
		await page.screenshot({ path: path.join(screenshotsDir, 'manager-pending.png'), fullPage: true });

		await page.locator('[data-aixlarity-nav="settings"]').click();
		await assertVisibleText(page, '.aixlarity-settings-dashboard', 'Knowledge Ledger');
		await assertVisibleText(page, '.aixlarity-settings-dashboard', 'Rules Activation');
		await assertVisibleText(page, '.aixlarity-settings-dashboard', 'AGENTS.md');
		await assertVisibleText(page, '.aixlarity-settings-dashboard', 'Export Ledger');
		await page.locator('.aixlarity-settings-dashboard button').filter({ hasText: 'Export Ledger' }).click();
		await page.screenshot({ path: path.join(screenshotsDir, 'knowledge-ledger-settings.png'), fullPage: true });
		await page.locator('.aixlarity-conv-pill').filter({ hasText: 'Fleet' }).click();

		await page.locator('button[data-aixlarity-manager-tab="artifacts"]').click();
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Evidence');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'AI Edit Timeline');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Compare Rounds');
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'open threads');
		const artifactReviewCard = page.locator('.aixlarity-task-card')
			.filter({ hasText: 'UI Smoke Diff' })
			.filter({ hasText: 'Review the UI smoke rename diff.' })
			.filter({ hasText: 'Code Diff' })
			.first();
		await artifactReviewCard.locator('button').filter({ hasText: 'Inspect' }).click();
		await page.waitForSelector('.aixlarity-artifact-modal-body', { timeout: 30_000 });
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Anchored Review Threads');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'seeded anchored thread');
		await page.locator('.aixlarity-modal-overlay input[placeholder^="Anchor"]').fill('src/demo.ts:1');
		await page.locator('.aixlarity-modal-overlay textarea[placeholder^="Add an anchored"]').fill('new anchored smoke comment');
		await page.locator('.aixlarity-modal-overlay button').filter({ hasText: 'Add Anchored Thread' }).click();
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'new anchored smoke comment');
		await page.screenshot({ path: path.join(screenshotsDir, 'artifact-anchored-thread.png'), fullPage: true });
		await page.locator('.aixlarity-modal-overlay button').filter({ hasText: 'Close' }).click();

		await page.locator('button[data-aixlarity-manager-tab="mission"]').click();
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Pending Approvals');

		const pendingApproval = page.locator('.aixlarity-task-card').filter({ hasText: 'shell: echo aixlarity-ui-smoke' });
		await pendingApproval.locator('button').filter({ hasText: 'Allow' }).click();
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'Approval allowed');

		const artifactCard = page.locator('.aixlarity-task-card')
			.filter({ hasText: 'UI Smoke Diff' })
			.filter({ hasText: 'Review the UI smoke rename diff.' })
			.filter({ hasText: 'Code Diff' })
			.first();
		await artifactCard.locator('button').filter({ hasText: 'Inspect' }).click();
		await page.waitForSelector('.aixlarity-artifact-modal-body', { timeout: 30_000 });
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Diff Preview');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Visual Diff Review');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Review Brief');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Impact Map');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Test Hints');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Risk Paths');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Review Cues');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Hunk Review');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Review Gate');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Before Snapshot');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'After Snapshot');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Open Native Diff');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Export Review');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Copy Hunk');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Open File');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Side-by-side');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Ignore Whitespace');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'src/demo.ts');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'export const name = "gcd";');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'export const name = "aixlarity";');
		await page.locator('.aixlarity-modal-overlay .aixlarity-diff-controls button').filter({ hasText: 'Unified' }).click();
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', '-export const name = "gcd";');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', '+export const name = "aixlarity";');
		await page.locator('.aixlarity-modal-overlay .aixlarity-diff-hunk-actions button').filter({ hasText: 'Copy Hunk' }).first().click();
		await page.locator('.aixlarity-modal-overlay .aixlarity-diff-hunk-actions button').filter({ hasText: 'Approve' }).first().click();
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'approved');
		await assertVisibleText(page, '.aixlarity-artifact-modal-body', 'Review Gate: ready');
		await page.locator('.aixlarity-modal-overlay .aixlarity-diff-controls button').filter({ hasText: 'Export Review' }).click();
		await page.screenshot({ path: path.join(screenshotsDir, 'artifact-diff-inspector.png'), fullPage: true });
		await page.locator('.aixlarity-modal-overlay button').filter({ hasText: 'Close' }).click();

		await page.locator('button[data-aixlarity-manager-tab="artifacts"]').click();
		await artifactCard.locator('button').filter({ hasText: 'Approve' }).click();
		await assertVisibleText(page, '.aixlarity-fleet-manager', 'APPROVED');
		await page.screenshot({ path: path.join(screenshotsDir, 'artifact-approved-evidence.png'), fullPage: true });

		assert.deepEqual(pageErrors, []);
		console.log(JSON.stringify({
			ok: true,
			checks: [
				'opened Aixlarity Agent Chat in Electron',
				'displayed live approval request card',
				'opened simplified Fleet UI',
				'exported reviewable Knowledge Ledger from Settings',
				'added anchored artifact review thread',
				'approved pending command from Manager',
				'inspected code_diff artifact with Diff Preview',
				'reviewed AI edit hunk and verified snapshot controls',
				'approved artifact in Evidence view',
			],
			screenshotsDir,
		}, null, 2));
	} finally {
		await app.close().catch(() => {});
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(userDataDir, { recursive: true, force: true });
		fs.rmSync(extensionsDir, { recursive: true, force: true });
		fs.rmSync(logsPath, { recursive: true, force: true });
		fs.rmSync(crashesPath, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
