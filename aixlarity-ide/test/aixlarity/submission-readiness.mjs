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
const welcomeContentPath = path.join(root, 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts');
const welcomeContributionPath = path.join(root, 'src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts');
const releaseWorkflowPath = path.join(repoRoot, '.github/workflows/release.yml');
const gulpVscodePath = path.join(root, 'build/gulpfile.vscode.ts');
const gulpExtensionsPath = path.join(root, 'build/gulpfile.extensions.ts');
const electronMainPath = path.join(root, 'src/vs/code/electron-main/app.ts');
const cliPath = path.join(repoRoot, 'crates/aixlarity-cli/src/main.rs');

const product = readJson(productPath);
const pkg = readJson(packagePath);
const view = readText(viewPath);
const providerCore = readText(providerCorePath);
const providerTypes = readText(providerTypesPath);
const providerModel = readText(providerModelPath);
const welcomeContent = readText(welcomeContentPath);
const welcomeContribution = readText(welcomeContributionPath);
const releaseWorkflow = readText(releaseWorkflowPath);
const gulpVscode = readText(gulpVscodePath);
const gulpExtensions = readText(gulpExtensionsPath);
const electronMain = readText(electronMainPath);
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
	'openProviderSetup',
	'Provider Setup',
	'Choose Provider / Add API Key / Select Model',
	'data-aixlarity-provider-select',
	'data-aixlarity-model-input',
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

const requiredFirstRunPatterns = [
	'aixlarityChooseProvider',
	'aixlarityAddApiKey',
	'aixlaritySelectModel',
	'command:aixlarity.chooseProvider',
	'command:aixlarity.addApiKey',
	'command:aixlarity.selectModel',
	'Set up Aixlarity',
	'This is local configuration, not an account sign-in flow.',
];
for (const pattern of requiredFirstRunPatterns) {
	assert(welcomeContent.includes(pattern), `First-run provider setup missing "${pattern}"`);
}
assert(!welcomeContent.includes('command:welcome.newWorkspaceChat'), 'First-run should not route primary users into chat sign-in setup');
assert(welcomeContribution.includes('Aixlarity starts with local provider setup'), 'First-run onboarding default should explain provider-first rationale');
assert(welcomeContribution.includes('default: false'), 'Experimental account onboarding must not be the default first-run path');

const requiredReleaseProfilePatterns = [
	'AIXLARITY_RELEASE_PROFILE: slim',
	'vscode-darwin-${VSCODE_ARCH}-min',
	'vscode-win32-$($env:VSCODE_ARCH)-min',
	'vscode-linux-${VSCODE_ARCH}-min',
];
for (const pattern of requiredReleaseProfilePatterns) {
	assert(releaseWorkflow.includes(pattern), `Release workflow missing slim profile contract "${pattern}"`);
}
assert(gulpVscode.includes('aixlaritySlimReleaseProfile'), 'Desktop packaging must understand the Aixlarity slim release profile');
assert(gulpVscode.includes('stripSourceMapsInPackagingTasks = isCI || aixlaritySlimReleaseProfile'), 'Slim release must strip packaged sourcemaps outside CI too');
assert(gulpVscode.includes('skipping extension shims'), 'Slim release must skip Copilot extension shims when the extension is not bundled');
assert(gulpExtensions.includes('Slim release: skipping bundled Copilot Chat extension'), 'Slim release must skip the bundled Copilot Chat extension');
assert(gulpVscode.includes("file.dirname = 'bin'"), 'Desktop packaging must embed the Aixlarity daemon binary under resources/app/bin');
assert(gulpVscode.includes('target\', \'release\', aixlarityCliName'), 'Desktop packaging must source the release Aixlarity daemon binary');
assert(electronMain.includes("this.environmentMainService.appRoot, 'bin', executableName"), 'Daemon resolver must prefer the embedded app binary');
assert(electronMain.includes('No Aixlarity daemon binary found'), 'Daemon resolver must report missing embedded/PATH binary clearly');
assert(releaseWorkflow.includes('APP_DAEMON="$APP_PATH/Contents/Resources/app/bin/aixlarity"'), 'macOS release validation must check the embedded daemon binary');
assert(releaseWorkflow.includes('VSCode-win32-$env:VSCODE_ARCH/resources/app/bin/aixlarity.exe'), 'Windows release validation must check the embedded daemon binary');
assert(releaseWorkflow.includes('VSCode-linux-${VSCODE_ARCH}/resources/app/bin/aixlarity'), 'Linux release validation must check the embedded daemon binary');

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
		'first-run routes provider setup before any account sign-in flow',
		'slim release profile uses minified IDE builds and excludes bundled Copilot Chat',
		'desktop release embeds the Aixlarity daemon binary for first-run startup',
		'core provider registry persists workspace/user mutations explicitly',
		'daemon provider RPCs parse scope for use/add/remove',
	],
}, null, 2));
