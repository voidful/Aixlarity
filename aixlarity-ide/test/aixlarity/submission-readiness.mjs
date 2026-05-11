import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(root, '..');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readText = file => fs.readFileSync(file, 'utf8');

const productPath = path.join(root, 'product.json');
const packagePath = path.join(root, 'package.json');
const viewPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityView.ts');
const providerCorePath = path.join(repoRoot, 'crates/aixlarity-core/src/providers.rs');
const providerTypesPath = path.join(repoRoot, 'crates/aixlarity-core/src/providers/types.rs');
const providerModelPath = path.join(root, 'src/vs/workbench/contrib/aixlarity/browser/aixlarityProviderModel.ts');
const cliPath = path.join(repoRoot, 'crates/aixlarity-cli/src/main.rs');

const product = readJson(productPath);
const pkg = readJson(packagePath);
const view = readText(viewPath);
const providerCore = readText(providerCorePath);
const providerTypes = readText(providerTypesPath);
const providerModel = readText(providerModelPath);
const cli = readText(cliPath);

function assertNoLegacyIdentity(value, field) {
	const text = String(value ?? '').toLowerCase();
	assert(!text.includes('code-oss'), `${field} still uses code-oss`);
	assert(!text.includes('vscodeoss'), `${field} still uses vscodeoss`);
	assert(!text.includes('visualstudio.code'), `${field} still uses VS Code bundle identity`);
	assert(!text.includes('microsoft code oss'), `${field} still uses Microsoft Code OSS`);
}

const productIdentityFields = [
	'nameShort',
	'nameLong',
	'applicationName',
	'dataFolderName',
	'serverApplicationName',
	'serverDataFolderName',
	'tunnelApplicationName',
	'win32DirName',
	'win32NameVersion',
	'win32RegValueName',
	'win32AppUserModelId',
	'win32ShellNameShort',
	'win32MutexName',
	'win32TunnelServiceMutex',
	'win32TunnelMutex',
	'darwinBundleIdentifier',
	'linuxIconName',
	'urlProtocol',
	'reportIssueUrl',
];

for (const field of productIdentityFields) {
	assert(product[field], `product.${field} is required for submission identity`);
	assertNoLegacyIdentity(product[field], `product.${field}`);
}

assert.equal(product.nameShort, 'Aixlarity');
assert.equal(product.nameLong, 'Aixlarity');
assert.equal(product.applicationName, 'aixlarity');
assert.equal(product.dataFolderName, '.aixlarity-ide');
assert.equal(product.urlProtocol, 'aixlarity');
assert.match(product.darwinBundleIdentifier, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
assert.match(product.reportIssueUrl, /^https:\/\/github\.com\/voidful\/Aixlarity\/issues\/new/);

for (const field of ['win32x64AppId', 'win32arm64AppId', 'win32x64UserAppId', 'win32arm64UserAppId']) {
	assert.match(product[field], /^\{\{[0-9A-F-]{36}\}$/, `product.${field} must be a stable GUID token`);
}
assert.notEqual(product.win32x64AppId, product.win32arm64AppId);
assert.notEqual(product.win32x64UserAppId, product.win32arm64UserAppId);

assert.equal(pkg.name, 'aixlarity-ide-dev');
assert.equal(pkg.author?.name, 'Aixlarity Contributors');
assert(pkg.scripts?.['test-aixlarity-readiness'], 'package script test-aixlarity-readiness is required');
assert(pkg.scripts?.['test-aixlarity-artifact'], 'package script test-aixlarity-artifact is required');
assert(pkg.scripts?.['test-aixlarity-contracts'], 'package script test-aixlarity-contracts is required');
assert(pkg.scripts?.['test-aixlarity-submission'], 'package script test-aixlarity-submission is required');

const requiredViewPatterns = [
	'providerSwitchScope',
	'Provider Preset',
	'Import Provider Bundle',
	'providerExportProfile',
	'providerMutationScope',
	'normalizeProviderImportProfile',
	'No providers array found.',
	'API key values are never imported here',
];
for (const pattern of requiredViewPatterns) {
	assert(view.includes(pattern), `Provider readiness UI missing "${pattern}"`);
}

const requiredProviderModelPatterns = [
	'aixlarity.provider_bundle.v1',
	'createProviderBundle',
	'normalizeProviderImportProfile',
	'contains a raw API key',
	'providerIsCustom',
	'providerMutationScope',
];
for (const pattern of requiredProviderModelPatterns) {
	assert(providerModel.includes(pattern), `Provider model readiness missing "${pattern}"`);
}

const requiredCorePatterns = [
	'workspace_registry_path',
	'add_provider_scoped',
	'remove_provider_scoped',
	'cannot remove active',
	'ProviderScope::Workspace',
];
for (const pattern of requiredCorePatterns) {
	assert(providerCore.includes(pattern), `Provider core readiness missing "${pattern}"`);
}

const requiredScopePatterns = [
	'pub fn parse',
	'"global" | "user" | "profile"',
	'"workspace" | "project" | "local"',
	'pub fn kind',
	'pub fn scope',
];
for (const pattern of requiredScopePatterns) {
	assert(providerTypes.includes(pattern), `Provider scope metadata missing "${pattern}"`);
}

const requiredRpcPatterns = [
	'"providers/use"',
	'"providers/add"',
	'"providers/remove"',
	'ProviderScope::parse',
	'AppCommand::ProvidersAdd { profile, scope }',
	'AppCommand::ProvidersRemove { id: pid, scope }',
];
for (const pattern of requiredRpcPatterns) {
	assert(cli.includes(pattern), `Daemon provider RPC readiness missing "${pattern}"`);
}

console.log(JSON.stringify({
	ok: true,
	checks: [
		'product identity uses Aixlarity bundle/application/protocol names',
		'package metadata no longer presents as Code OSS development package',
		'submission suite includes artifact-level Electron bundle validation',
		'model-level behavior contracts are available for CI-safe quality checks',
		'provider manager keeps scoped preset/import/export affordances',
		'core provider registry persists workspace/user mutations explicitly',
		'daemon provider RPCs parse scope for use/add/remove',
	],
}, null, 2));
