import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const scripts = [
	'test/aixlarity/product-quality-suite.mjs',
	'test/aixlarity/artifact-readiness.mjs',
];

for (const script of scripts) {
	const result = spawnSync(process.execPath, [script], {
		cwd: root,
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

console.log(JSON.stringify({
	ok: true,
	checks: [
		'CI-safe product quality gate passed',
		'artifact-level submission readiness passed',
	],
}, null, 2));
