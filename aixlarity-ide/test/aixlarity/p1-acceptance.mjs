import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const files = {
	view: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityView.ts'),
	contribution: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarity.contribution.ts'),
	browserTool: path.resolve(root, '../crates/aixlarity-core/src/tools/browser_subagent.rs'),
	shellTool: path.resolve(root, '../crates/aixlarity-core/src/tools/shell.rs'),
	missionControl: path.resolve(root, '../crates/aixlarity-core/src/mission_control.rs'),
	artifactModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityArtifactModel.ts'),
	diffModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityDiffModel.ts'),
	providerModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityProviderModel.ts'),
	missionControlModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityMissionControlModel.ts'),
	uiComponents: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityUiComponents.ts'),
	diffReviewView: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityDiffReviewView.ts'),
	knowledgeModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityKnowledgeModel.ts'),
	knowledgeView: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityKnowledgeView.ts'),
	verificationModel: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityVerificationModel.ts'),
	verificationView: path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityVerificationView.ts'),
	providerCore: path.resolve(root, '../crates/aixlarity-core/src/providers.rs'),
	providerTypes: path.resolve(root, '../crates/aixlarity-core/src/providers/types.rs'),
	output: path.resolve(root, '../crates/aixlarity-core/src/output.rs'),
	cli: path.resolve(root, '../crates/aixlarity-cli/src/main.rs'),
};

const read = file => fs.readFileSync(file, 'utf8');
const source = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, read(file)]));

const checks = [
	{
		name: 'Agent Manager persists workspace state',
		file: 'view',
		patterns: [
			'agentWorkspaceStateKey',
			'persistAgentWorkspaceStateNow',
			'restoreAgentWorkspaceState',
			'createPersistedAgentWorkspaceState',
			'localStorage.setItem',
			'localStorage.getItem',
		],
	},
	{
		name: 'Agent Manager supports pause resume cancel retry',
		file: 'view',
		patterns: [
			'pauseAgentTask',
			'resumeAgentTask',
			'cancelAgentTask',
			'Retry',
			'Resume',
			'Cancel',
		],
	},
	{
		name: 'Agent Manager shows task verification passports',
		file: 'view',
		patterns: [
			'createTaskVerificationPassport',
			'renderTaskVerificationPassport',
			'createTaskVerificationMarkdown',
			'task_verification_passport_copied',
		],
	},
	{
		name: 'Task verification passport computes product readiness',
		file: 'verificationModel',
		patterns: [
			'createTaskVerificationPassport',
			'createTaskVerificationMarkdown',
			'TaskVerificationPassport',
			'Plan',
			'Diff',
			'Tests',
			'Runtime',
			'Review',
			'Ready to submit',
			'Missing:',
		],
	},
	{
		name: 'Task verification passport renders compact UI',
		file: 'verificationView',
		patterns: [
			'renderTaskVerificationPassport',
			'Verification Passport',
			'aixlarity-verification-passport',
			'aixlarity-verification-step',
			'aixlarity-verification-score',
		],
	},
	{
		name: 'Agent Manager status and artifact models are extracted',
		file: 'artifactModel',
		patterns: [
			"export type AgentTaskStatus = 'queued' | 'running' | 'waiting_review' | 'paused'",
			'export interface AgentArtifactState',
			'createPersistedAgentWorkspaceState',
			'createAgentEvidenceBundle',
		],
	},
	{
		name: 'Artifact evidence can be exported and inspected',
		file: 'view',
		patterns: [
			'createAgentEvidenceBundle',
			'copyAgentEvidenceBundle',
			'Copy Evidence',
			'Copy JSON',
			'openArtifactInspector',
			'renderArtifactDiffViewer',
			'Approve',
			'Send Feedback',
		],
	},
	{
		name: 'Editor-native actions are registered in editor hover and Problems panel',
		file: 'contribution',
		patterns: [
			'aixlarity.explainSelection',
			'aixlarity.fixSelection',
			'MenuId.MarkerHoverStatusBar',
			'aixlarity.sendProblemsToAgent',
			'MenuId.ProblemsPanelContext',
		],
	},
	{
		name: 'Integrated browser agent emits DOM console network screenshot video evidence',
		file: 'browserTool',
		patterns: [
			'browser_evidence',
			'playwright_evidence_v2',
			'actionTimeline',
			'consoleEvents',
			'network',
			'screenshot',
			'video',
			'live_playwright_capture_collects_browser_evidence',
		],
	},
	{
		name: 'Terminal manager emits replayable transcript evidence',
		file: 'shellTool',
		patterns: [
			'command_id',
			'shell_command_risk',
			'started_at_ms',
			'finished_at_ms',
			'duration_ms',
			'transcript',
			'shell_env_evidence_omits_values',
		],
	},
	{
		name: 'IDE ingests terminal and browser evidence into artifacts',
		file: 'view',
		patterns: [
			'terminalEvidenceRows',
			'formatTerminalTranscript',
			'browserEvidenceRows',
			'formatBrowserEvidenceBody',
			'Action Timeline',
			'Risk reasons',
			'Browser Recording',
			'terminal_transcript',
		],
	},
	{
		name: 'Mission Control persists durable task and artifact state through the daemon',
		file: 'missionControl',
		patterns: [
			'aixlarity.mission_control_state.v1',
			'state_path',
			'artifacts_dir',
			'load_state',
			'save_state',
			'mirror_artifacts',
			'export_evidence_bundle',
			'list_artifacts',
			'review_artifact',
			'audit_log_path',
			'record_audit_event',
			'list_audit_events',
			'aixlarity.audit_log.v1',
		],
	},
	{
		name: 'Daemon exposes durable Mission Control and artifact evidence RPCs',
		file: 'cli',
		patterns: [
			'mission_control/load',
			'mission_control/save',
			'artifacts/export',
			'artifacts/list',
			'artifacts/review',
			'mission_control/export_evidence',
			'audit/list',
			'audit/record',
		],
	},
	{
		name: 'IDE syncs Agent Manager state with daemon-backed Mission Control',
		file: 'view',
		patterns: [
			'restoreAgentWorkspaceStateFromDaemon',
			'persistAgentWorkspaceStateToDaemon',
			'resolveMissionControlWorkspaceCwd',
			'mission_control.json',
			'mission_control/load',
			'mission_control/save',
			'artifacts/export',
			'artifacts/list',
			'artifacts/review',
		],
	},
	{
		name: 'Manager Surface exposes pending approvals and artifact review workspace',
		file: 'view',
		patterns: [
			'PendingApprovalState',
			'pendingApprovals',
			'renderPendingApprovalCard',
			'renderArtifactReviewCard',
			'Review Queue',
			'mergeDurableArtifactIndex',
			'persistArtifactReviewToDaemon',
		],
	},
	{
		name: 'Manager implementation keeps filters and durable audit recording',
		file: 'view',
		patterns: [
			'managerSearchQuery',
			'managerStatusFilter',
			'managerKindFilter',
			'renderManagerControls',
			'managerAuditEvents',
			'renderAuditLogSection',
			'renderAuditEventCard',
			'recordAuditEventToDaemon',
			'audit/record',
		],
	},
	{
		name: 'Fleet presents a simplified Tasks and Evidence surface',
		file: 'view',
		patterns: [
			'managerWorkspaceIndex',
			'renderFleetCoreTabs',
			'Workspace Index',
			"['mission', 'Tasks'",
			"['artifacts', 'Evidence'",
			'renderWorkspaceIndexSection',
		],
	},
	{
		name: 'Provider settings require editable API model selection',
		file: 'view',
		patterns: [
			'aixlarity-model-editor',
			'Model ID (required for API)',
			'providers/update',
			'Model is required for API providers.',
			'Model ID is required for API providers.',
		],
	},
	{
		name: 'Provider manager supports scoped presets and import export',
		file: 'view',
		patterns: [
			'providerSwitchScope',
			'Provider Preset',
			'Import Provider Bundle',
			'AIXLARITY_PROVIDER_BUNDLE_SCHEMA',
			'providerMutationScope',
			'providerExportProfile',
			'copyProviderBundle',
			'providers/add',
			'scope: scopeSel.value',
			'providers/remove',
		],
	},
	{
		name: 'Provider import export behavior is extracted into model',
		file: 'providerModel',
		patterns: [
			'aixlarity.provider_bundle.v1',
			'createProviderBundle',
			'normalizeProviderImportProfile',
			'contains a raw API key',
		],
	},
	{
		name: 'Core provider registry persists workspace and user provider changes explicitly',
		file: 'providerCore',
		patterns: [
			'workspace_registry_path',
			'add_provider_scoped',
			'remove_provider_scoped',
			'cannot remove active',
			'add_provider_scoped_writes_workspace_config_file',
		],
	},
	{
		name: 'Daemon provider RPCs parse scope and expose provider source metadata',
		file: 'cli',
		patterns: [
			'ProviderScope::parse',
			'AppCommand::ProvidersAdd { profile, scope }',
			'AppCommand::ProvidersRemove { id: pid, scope }',
		],
	},
	{
		name: 'Provider JSON exposes source kind and scope for reliable IDE rendering',
		file: 'output',
		patterns: [
			'source_kind',
			'scope',
			'p.source.kind()',
			'p.source.scope()',
		],
	},
	{
		name: 'Provider scope parser accepts user and workspace terminology',
		file: 'providerTypes',
		patterns: [
			'pub fn parse',
			'"user"',
			'"workspace"',
			'pub fn kind',
			'pub fn scope',
		],
	},
	{
		name: 'Artifact Review v3 supports anchored review threads',
		file: 'view',
		patterns: [
			'AgentReviewThreadState',
			'Anchored Review Threads',
			'Add Anchored Thread',
			'createReviewAnchor',
			'updateArtifactReviewThread',
			'artifacts/review_thread',
			'artifact_review_thread',
		],
	},
	{
		name: 'Reusable UI components render artifact and diff review surfaces',
		file: 'uiComponents',
		patterns: [
			'renderArtifactChip',
			'renderDiffImpactMap',
			'artifactStatusStyle',
			'artifactIconClass',
			'taskStatusMeta',
			'providerActiveLabel',
			'Impact Map',
			'Test Hints',
			'Risk Paths',
			'Review Cues',
		],
	},
	{
		name: 'AI edit review wires extracted diff review surface',
		file: 'view',
		patterns: [
			'AI Edit Timeline',
			'renderArtifactDiffViewer',
			'DiffReviewView.render',
			'parseUnifiedDiff',
			'appendDiffHighlightedText',
			'Compare Rounds',
			'buildDiffSnapshot',
			'openDiffRoundCompare',
			'recordHunkReview',
			'openNativeDiffForFile',
			'createSnapshotCompareDiff',
		],
	},
	{
		name: 'DiffReviewView visualizes each code diff round',
		file: 'diffReviewView',
		patterns: [
			'export class DiffReviewView',
			'Visual Diff Review',
			'Side-by-side',
			'Ignore Whitespace',
			'aixlarity-diff-viewer',
			'Open Native Diff',
			'Review Brief',
			'Hunk Review',
			'Before Snapshot',
			'After Snapshot',
			'Export Review',
			'Review Gate',
			'Copy Hunk',
			'Open File',
			'renderDiffImpactMapComponent',
		],
	},
	{
		name: 'AI edit review diff behavior is extracted into model',
		file: 'diffModel',
		patterns: [
			'parseUnifiedDiff',
			'pairDiffRows',
			'buildDiffHunks',
			'buildDiffSnapshot',
			'createDiffImpactMap',
			'createDiffReviewReport',
			'diffReviewGate',
			'createSnapshotCompareDiff',
		],
	},
	{
		name: 'Browser Control Center exposes managed browser evidence policy',
		file: 'view',
		patterns: [
			'renderBrowserControlCenter',
			'Managed Browser Policy',
			'Browser Evidence Playback',
			'captureDom',
			'captureConsole',
			'captureNetwork',
			'allowedDomains',
			'blockedDomains',
		],
	},
	{
		name: 'Terminal Replay Center exposes command policy and replay artifacts',
		file: 'view',
		patterns: [
			'renderTerminalReplayCenter',
			'Terminal Policy / Replay',
			'Terminal Approvals',
			'approvalMode',
			'allowPatterns',
			'denyPatterns',
			'timeoutSeconds',
		],
	},
	{
		name: 'Rules Workflows Memory MCP Studio persists IDE policy',
		file: 'view',
		patterns: [
			'renderStudioWorkspace',
			'Plan Gate / Review Policy',
			'renderKnowledgeLedgerCard',
			'Rules',
			'Workflows',
			'Memory',
			'MCP Servers',
			'knowledgePolicy',
			'studio/save',
		],
	},
	{
		name: 'Knowledge Ledger exposes reviewable activation policy',
		file: 'knowledgeModel',
		patterns: [
			'aixlarity.knowledge_ledger.v1',
			'normalizeKnowledgePolicy',
			'createKnowledgeLedger',
			'createKnowledgeLedgerBundle',
			'ledgerEnabled',
			'rulesEnabled',
			'memoryEnabled',
			'reviewRequired',
			'activationMode',
			'globPattern',
		],
	},
	{
		name: 'Knowledge Ledger renders compact Settings control',
		file: 'knowledgeView',
		patterns: [
			'renderKnowledgeLedgerCard',
			'Knowledge Ledger',
			'Rules Activation',
			'Export Ledger',
			'Ledger',
			'Rules',
			'Memory',
			'Review',
		],
	},
	{
		name: 'Core and daemon expose new production control-plane RPCs',
		file: 'missionControl',
		patterns: [
			'aixlarity.workspace_index.v1',
			'aixlarity.ide_studio_state.v1',
			'default_knowledge_policy',
			'knowledgePolicy',
			'list_workspace_index',
			'load_studio_state',
			'save_studio_state',
			'review_artifact_thread',
			'workspace_studio_inventory',
		],
	},
	{
		name: 'CLI routes new production control-plane RPCs',
		file: 'cli',
		patterns: [
			'mission_control/workspaces',
			'artifacts/review_thread',
			'studio/load',
			'studio/save',
		],
	},
];

const failures = [];
for (const check of checks) {
	const text = source[check.file];
	for (const pattern of check.patterns) {
		if (!text.includes(pattern)) {
			failures.push(`${check.name}: missing "${pattern}" in ${files[check.file]}`);
		}
	}
}

if (failures.length > 0) {
	console.error('Aixlarity P1 acceptance failed:');
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log(`Aixlarity P1 acceptance passed (${checks.length} capability groups).`);
