import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityView.ts');
const diffModelPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityDiffModel.ts');
const uiComponentsPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityUiComponents.ts');
const diffReviewViewPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityDiffReviewView.ts');
const packagePath = path.join(root, 'package.json');
const view = fs.readFileSync(viewPath, 'utf8');
const diffModel = fs.readFileSync(diffModelPath, 'utf8');
const uiComponents = fs.readFileSync(uiComponentsPath, 'utf8');
const diffReviewView = fs.readFileSync(diffReviewViewPath, 'utf8');
const diffSurface = `${view}\n${diffModel}\n${uiComponents}\n${diffReviewView}`;
const pkg = fs.readFileSync(packagePath, 'utf8');

const checks = [
	{
		name: 'P1 diff review ergonomics are wired',
		text: diffSurface,
		patterns: [
			'Export Review',
			'Copy Hunk',
			'Open File',
			'copyHunkEvidence',
			'createHunkEvidenceText',
			'openDiffHunkSource',
			'diff_hunk_copied',
		],
	},
	{
		name: 'P2 impact map and verification guidance are wired',
		text: diffSurface,
		patterns: [
			'Impact Map',
			'Test Hints',
			'Risk Paths',
			'Review Cues',
			'createDiffImpactMap',
			'suggestDiffTestCommands',
			'renderDiffImpactMap',
			'Symbol-level API surface touched',
		],
	},
	{
		name: 'P2 review report and gate evidence are wired',
		text: diffSurface,
		patterns: [
			'createDiffReviewReport',
			'Aixlarity Diff Review Report',
			'diffReviewGate',
			'Review Gate: blocked',
			'Review Gate: ready',
			'approveArtifactWithReviewGate',
			'artifact_review_gate_blocked',
			'artifact_review_gate_passed',
			'diff_review_exported',
			'native_diff_opened',
		],
	},
	{
		name: 'P2 acceptance command is exposed',
		text: pkg,
		patterns: [
			'test-aixlarity-p2',
			'test-aixlarity-contracts',
			'p2-acceptance.mjs',
		],
	},
	{
		name: 'P2 behavior contracts are exposed',
		text: fs.readFileSync(path.join(root, 'test/aixlarity/model-contracts.mjs'), 'utf8'),
		patterns: [
			'parseUnifiedDiff',
			'diffReviewGate',
			'normalizeProviderImportProfile',
			'createPersistedAgentWorkspaceState',
			'shouldPreferLocalMissionState',
		],
	},
];

const failures = [];
for (const check of checks) {
	for (const pattern of check.patterns) {
		if (!check.text.includes(pattern)) {
			failures.push(`${check.name}: missing "${pattern}"`);
		}
	}
}

if (failures.length > 0) {
	console.error('Aixlarity P2 acceptance failed:');
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log(`Aixlarity P2 acceptance passed (${checks.length} capability groups).`);
