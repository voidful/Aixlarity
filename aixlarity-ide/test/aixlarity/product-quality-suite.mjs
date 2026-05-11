import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const scripts = [
	{
		file: 'test/aixlarity/p1-acceptance.mjs',
		check: 'P1 Antigravity-style IDE capability source gate passed',
	},
	{
		file: 'test/aixlarity/p2-acceptance.mjs',
		check: 'P2 diff review and review-gate source gate passed',
	},
	{
		args: ['--experimental-strip-types', 'test/aixlarity/model-contracts.mjs'],
		check: 'model-level behavior contracts passed',
	},
	{
		file: 'test/aixlarity/submission-readiness.mjs',
		check: 'product identity and provider readiness source gate passed',
	},
	{
		file: 'test/aixlarity/repository-hygiene.mjs',
		check: 'repository identity and CI hygiene gate passed',
	},
	{
		file: '../docs/validate.mjs',
		check: 'documentation homepage and teaching-site quality gate passed',
	},
];

for (const script of scripts) {
	const result = spawnSync(process.execPath, script.args ?? [script.file], {
		cwd: root,
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

console.log(JSON.stringify({
	ok: true,
	scope: 'ci-safe',
	checks: scripts.map(script => script.check),
	releaseGate: 'Run npm run test-aixlarity-submission after building Electron artifacts and the Aixlarity release binary.',
}, null, 2));
