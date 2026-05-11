import assert from 'node:assert/strict';

import {
	buildDiffSnapshot,
	createDiffImpactMap,
	createDiffReviewReport,
	createDiffRiskProfile,
	createSnapshotCompareDiff,
	diffReviewGate,
	parseUnifiedDiff,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityDiffModel.ts';
import {
	createAgentEvidenceBundle,
	createPersistedAgentWorkspaceState,
	normalizeArtifactKind,
	serializeTaskState,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityArtifactModel.ts';
import {
	createAgentWorkspaceStateKey,
	isPersistedAgentWorkspaceState,
	shouldPreferLocalMissionState,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityMissionControlModel.ts';
import {
	AIXLARITY_PROVIDER_BUNDLE_SCHEMA,
	createProviderBundle,
	normalizeProviderImportProfile,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityProviderModel.ts';
import {
	createKnowledgeLedger,
	createKnowledgeLedgerBundle,
	normalizeKnowledgePolicy,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityKnowledgeModel.ts';
import {
	createTaskVerificationMarkdown,
	createTaskVerificationPassport,
} from '../../src/vs/workbench/contrib/aixlarity/browser/aixlarityVerificationModel.ts';

const diffText = [
	'diff --git a/src/api.ts b/src/api.ts',
	'index 1111111..2222222 100644',
	'--- a/src/api.ts',
	'+++ b/src/api.ts',
	'@@ -1,2 +1,3 @@',
	' export function keep() {}',
	'-export const name = "gcd";',
	'+export const name = "aixlarity";',
	'+export class Harness {}',
	'diff --git a/package.json b/package.json',
	'index 3333333..4444444 100644',
	'--- a/package.json',
	'+++ b/package.json',
	'@@ -1 +1 @@',
	'-{"name":"old"}',
	'+{"name":"aixlarity"}',
].join('\n');

const parsed = parseUnifiedDiff(diffText);
assert.equal(parsed.files.length, 2);
assert.equal(parsed.additions, 3);
assert.equal(parsed.deletions, 2);
assert.equal(parsed.files[0].displayPath, 'src/api.ts');
assert.equal(parsed.files[0].hunks.length, 1);
assert.equal(parsed.files[0].hunks[0].rows.some(row => row.kind === 'change'), true);

const impactMap = createDiffImpactMap(parsed);
assert(impactMap.symbols.includes('Harness'));
assert(impactMap.riskFiles.includes('package.json'));
assert(impactMap.reviewCues.includes('Symbol-level API surface touched'));
assert(impactMap.testCommands.includes('npm run compile-check-ts-native'));

const artifact = {
	id: 'artifact-diff',
	taskId: 'task-1',
	name: 'API rename diff',
	kind: 'code_diff',
	status: 'needs_review',
	summary: 'Rename API surface.',
	path: 'src/api.ts',
	body: diffText,
	evidence: [{ label: 'Command', value: 'npm test' }],
	attachments: [],
	comments: [],
	reviewThreads: parsed.files.flatMap(file => file.hunks).map(hunk => ({
		id: `thread-${hunk.id}`,
		artifactId: 'artifact-diff',
		anchor: { kind: 'hunk', label: hunk.id, selector: hunk.id },
		status: 'resolved',
		comments: [{ id: `comment-${hunk.id}`, author: 'reviewer', body: '[hunk-approved] ok', createdAt: 1 }],
		createdAt: 1,
		updatedAt: 1,
	})),
	createdAt: 1,
	updatedAt: 2,
};

assert.equal(diffReviewGate(artifact, parsed).label, 'Review Gate: ready');
const blockedArtifact = {
	...artifact,
	reviewThreads: [{
		...artifact.reviewThreads[0],
		status: 'open',
		comments: [{ id: 'reject', author: 'reviewer', body: '[hunk-rejected] breaks contract', createdAt: 2 }],
	}],
};
assert.equal(diffReviewGate(blockedArtifact, parsed).blocked, true);

const snapshot = buildDiffSnapshot(artifact, parsed, 10);
const nextParsed = parseUnifiedDiff([
	'diff --git a/src/api.ts b/src/api.ts',
	'--- a/src/api.ts',
	'+++ b/src/api.ts',
	'@@ -1,3 +1,4 @@',
	' export function keep() {}',
	' export const name = "aixlarity";',
	' export class Harness {}',
	'+export const extra = true;',
].join('\n'));
const nextSnapshot = buildDiffSnapshot({ ...artifact, id: 'artifact-diff-2', name: 'Round 2', createdAt: 20 }, nextParsed, 20);
const roundDiff = createSnapshotCompareDiff(snapshot, nextSnapshot);
assert(roundDiff.includes('diff --git a/src/api.ts b/src/api.ts'));
assert(roundDiff.includes('+export const extra = true;'));

const risk = createDiffRiskProfile(parsed, artifact);
const report = createDiffReviewReport(artifact, parsed, snapshot, risk, impactMap);
assert(report.includes('Aixlarity Diff Review Report'));
assert(report.includes('Review Gate: ready'));

const normalizedProvider = normalizeProviderImportProfile({
	label: 'My DeepSeek',
	family: 'openai-compatible',
	apiBase: 'https://api.deepseek.com/v1',
	apiKeyEnv: 'deepseek-key',
	model: 'deepseek-chat',
}, 'workspace', 0);
assert.equal(normalizedProvider.id, 'my-deepseek');
assert.equal(normalizedProvider.api_key_env, 'DEEPSEEK_KEY');
assert.equal(normalizedProvider.scope, 'workspace');
assert.throws(() => normalizeProviderImportProfile({
	id: 'unsafe',
	api_base: 'https://example.test/v1',
	api_key_env: 'UNSAFE_KEY',
	api_key: 'sk-secret',
	model: 'unsafe-model',
}, 'global', 1), /raw API key/);
const external = normalizeProviderImportProfile({ label: 'Codex CLI', family: 'external-cli', model: 'codex' }, 'global', 2);
assert.equal(external.api_key_env, '');
const bundle = createProviderBundle([
	{ id: 'openai-env', source_kind: 'environment', label: 'Env OpenAI' },
	{ ...normalizedProvider, source_kind: 'workspace' },
], null, 'my-deepseek', '2026-05-11T00:00:00.000Z');
assert.equal(bundle.schema, AIXLARITY_PROVIDER_BUNDLE_SCHEMA);
assert.equal(bundle.providers.length, 1);
assert(!JSON.stringify(bundle).includes('sk-secret'));

const task = {
	id: 'task-1',
	title: 'Ship review',
	prompt: 'review diff',
	status: 'running',
	progressLabel: 'Running tests',
	createdAt: 1,
	updatedAt: 2,
	artifactIds: ['artifact-diff', 'missing-artifact'],
	timeline: [{ id: 't1', kind: 'run', label: 'Run', timestamp: 1 }],
	seenEventKeys: new Set(['a', 'b']),
	turnCount: 1,
	toolCallCount: 2,
	tokenCount: 3,
};
const persistedTask = serializeTaskState(task, new Set(['artifact-diff']));
assert.equal(persistedTask.status, 'paused');
assert.deepEqual(persistedTask.artifactIds, ['artifact-diff']);

const bigAttachmentArtifact = {
	...artifact,
	kind: normalizeArtifactKind('Browser Recording'),
	id: 'artifact-browser',
	attachments: [{ mimeType: 'text/plain', dataBase64: 'x'.repeat(20) }],
};
const state = createPersistedAgentWorkspaceState({
	version: 1,
	workspace: '/workspace',
	tasks: [task],
	artifacts: [bigAttachmentArtifact],
	maxTasks: 20,
	maxArtifacts: 20,
	bodyLimit: 10_000,
	attachmentInlineLimit: 5,
	now: 42,
	truncateText: text => text,
});
assert.equal(state.savedAt, 42);
assert.equal(state.artifacts[0].attachments[0].dataBase64, undefined);
assert.equal(isPersistedAgentWorkspaceState(state, 1), true);
assert.equal(createAgentWorkspaceStateKey(1, 'workspace-id'), 'aixlarity.agentWorkspaceState.v1:workspace-id');
assert.equal(shouldPreferLocalMissionState({ ...state, savedAt: 50 }, { ...state, savedAt: 10, artifacts: [] }), true);

const evidenceBundle = createAgentEvidenceBundle({
	workspace: '/workspace',
	tasks: [task],
	artifacts: [artifact, bigAttachmentArtifact],
	selectedArtifact: artifact,
	bodyLimit: 10_000,
	attachmentInlineLimit: 100,
	nowIso: '2026-05-11T00:00:00.000Z',
	truncateText: text => text,
});
assert.equal(evidenceBundle.summary.selectedArtifactId, 'artifact-diff');
assert.equal(evidenceBundle.summary.taskCount, 1);
assert.equal(evidenceBundle.artifacts.length, 1);

const diffWithoutTestEvidence = {
	...artifact,
	evidence: [],
};
const runtimeWithoutTestEvidence = {
	...bigAttachmentArtifact,
	evidence: [{ label: 'Browser', value: 'recording captured' }],
};
const partialPassport = createTaskVerificationPassport(task, [diffWithoutTestEvidence, runtimeWithoutTestEvidence]);
assert.equal(partialPassport.status, 'partial');
assert(partialPassport.missing.includes('plan'));
assert(partialPassport.missing.includes('tests'));
assert(partialPassport.missing.includes('review'));

const planArtifact = {
	...artifact,
	id: 'artifact-plan',
	name: 'Implementation Plan',
	kind: 'implementation_plan',
	status: 'approved',
	summary: 'Plan approved.',
	body: 'Plan the change.',
	reviewThreads: [],
};
const testArtifact = {
	...artifact,
	id: 'artifact-test',
	name: 'Test Report',
	kind: 'test_report',
	status: 'approved',
	summary: 'All tests passed.',
	body: 'npm test passed',
	reviewThreads: [],
};
const browserArtifact = {
	...bigAttachmentArtifact,
	id: 'artifact-browser-ready',
	kind: 'browser_recording',
	status: 'approved',
	reviewThreads: [],
};
const approvedDiffArtifact = {
	...artifact,
	status: 'approved',
};
const readyArtifacts = [planArtifact, approvedDiffArtifact, testArtifact, browserArtifact];
const readyPassport = createTaskVerificationPassport({
	...task,
	status: 'completed',
	artifactIds: readyArtifacts.map(item => item.id),
}, readyArtifacts);
assert.equal(readyPassport.status, 'ready');
assert.equal(readyPassport.score, 100);
assert(createTaskVerificationMarkdown(readyPassport, task, readyArtifacts).includes('Aixlarity Task Verification Passport'));

const blockedPassport = createTaskVerificationPassport(task, [{ ...artifact, status: 'rejected' }]);
assert.equal(blockedPassport.status, 'blocked');
assert(blockedPassport.blockers.some(blocker => blocker.includes('rejected')));

const knowledgePolicy = normalizeKnowledgePolicy({
	activationMode: 'glob',
	globPattern: 'src/**/*.ts',
	ledgerEnabled: true,
	rulesEnabled: true,
	memoryEnabled: false,
	reviewRequired: true,
});
const knowledgeLedger = createKnowledgeLedger({
	rules: [{ name: 'AGENTS.md', path: 'AGENTS.md', bytes: 120, preview: 'Use tests.' }],
	workflows: [{ name: 'review.toml', path: 'commands/review.toml', bytes: 80 }],
	memories: [{ name: 'MEMORY.md', path: '.aixlarity/MEMORY.md', bytes: 64 }],
	mcpServers: [{ name: 'mcp.json', path: '.aixlarity/mcp.json', bytes: 32 }],
}, knowledgePolicy);
assert.equal(knowledgeLedger.schema, 'aixlarity.knowledge_ledger.v1');
assert.equal(knowledgeLedger.summary.total, 4);
assert.equal(knowledgeLedger.summary.enabled, 3);
assert.equal(knowledgeLedger.entries.find(entry => entry.kind === 'rule')?.activationMode, 'glob');
assert.equal(knowledgeLedger.entries.find(entry => entry.kind === 'memory')?.enabled, false);
const disabledLedger = createKnowledgeLedger({ rules: [{ name: 'AGENTS.md', path: 'AGENTS.md' }] }, normalizeKnowledgePolicy({ ledgerEnabled: false }));
assert.equal(disabledLedger.summary.enabled, 0);
const knowledgeBundle = createKnowledgeLedgerBundle(knowledgeLedger, '2026-05-11T00:00:00.000Z');
assert.equal(knowledgeBundle.exportedAt, '2026-05-11T00:00:00.000Z');
assert.equal(knowledgeBundle.entries[0].reviewRequired, true);

console.log(JSON.stringify({
	ok: true,
	checks: [
		'diff parser computes files, hunks, impact map, snapshots, reports, and review gates',
		'provider import/export normalizes scopes and rejects raw API keys',
		'artifact persistence pauses live tasks and omits oversized inline attachments',
		'mission control state selection and storage keys are deterministic',
		'task verification passports compute readiness, missing evidence, and blockers',
		'knowledge ledger policies produce reviewable, exportable, disableable learning state',
	],
}, null, 2));
