import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ideRoot = path.join(root, 'aixlarity-ide');

const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath));

const absentPaths = [
	'.gcd',
	'gcd-ide',
	'crates/gcd-core',
	'crates/gcd-cli',
];

for (const relativePath of absentPaths) {
	assert(!fs.existsSync(path.join(root, relativePath)), `${relativePath} must not exist in the Aixlarity repo`);
}

const communityHealthFiles = [
	'.github/ISSUE_TEMPLATE/bug_report.yml',
	'.github/ISSUE_TEMPLATE/feature_request.yml',
	'.github/ISSUE_TEMPLATE/config.yml',
	'.github/PULL_REQUEST_TEMPLATE.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
];

for (const relativePath of communityHealthFiles) {
	assert(fs.existsSync(path.join(root, relativePath)), `${relativePath} is required for open-source launch readiness`);
}

const cargoToml = read('Cargo.toml');
assert(cargoToml.includes('crates/aixlarity-core'), 'Cargo workspace must include aixlarity-core');
assert(cargoToml.includes('crates/aixlarity-cli'), 'Cargo workspace must include aixlarity-cli');
assert(!cargoToml.includes('crates/gcd-'), 'Cargo workspace must not reference legacy gcd crates');

const ci = read('.github/workflows/ci.yml');
assert(ci.includes('ide-product-quality'), 'CI must expose the IDE product quality job');
assert(ci.includes('npm run test-aixlarity-quality'), 'CI must run the CI-safe IDE product quality gate');
assert(ci.includes('node docs/validate.mjs'), 'CI must run the docs and IDE landing page validator');
assert(ci.includes('.aixlarity/skills/*/SKILL.md'), 'CI must validate Aixlarity skill frontmatter');

const pkg = readJson('aixlarity-ide/package.json');
for (const script of [
	'test-aixlarity-quality',
	'test-aixlarity-contracts',
	'test-aixlarity-submission',
	'test-aixlarity-ui',
	'test-aixlarity-docs',
]) {
	assert(pkg.scripts?.[script], `aixlarity-ide/package.json must expose ${script}`);
}

const submissionSuite = read('aixlarity-ide/test/aixlarity/submission-suite.mjs');
assert(submissionSuite.includes('product-quality-suite.mjs'), 'Submission suite must include the CI-safe product quality suite');
assert(submissionSuite.includes('artifact-readiness.mjs'), 'Submission suite must include Electron artifact readiness');

const publicFiles = [
	'README.md',
	'README.en.md',
	'AGENTS.md',
	'CONTRIBUTING.md',
	'docs/architecture.md',
	'docs/index.html',
	'aixlarity-ide/product.json',
];
const legacyPatterns = [
	/\bGemiClawDex\b/,
	/\bGCD\b/,
	/\.gcd\b/,
	/\bgcd-core\b/,
	/\bgcd-cli\b/,
	/\bgcd-ide\b/,
];

for (const relativePath of publicFiles) {
	const text = read(relativePath);
	for (const pattern of legacyPatterns) {
		assert(!pattern.test(text), `${relativePath} must not expose legacy identity ${pattern}`);
	}
}

console.log(JSON.stringify({
	ok: true,
	checks: [
		'legacy GCD entry directories are absent',
		'open-source community health templates are present',
		'Cargo workspace points at Aixlarity crates',
		'CI runs docs and IDE product quality gates',
		'IDE package exposes quality, submission, UI, and docs scripts',
		'public identity files do not expose legacy product names',
	],
	ideRoot,
}, null, 2));
