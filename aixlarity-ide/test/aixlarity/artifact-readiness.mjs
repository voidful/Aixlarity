import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(root, '..');
const artifactRoot = path.join(root, '.build/electron');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const product = readJson(path.join(root, 'product.json'));

function assertExists(file, message = `${file} must exist`) {
	assert(fs.existsSync(file), message);
	return file;
}

function assertExecutable(file, message = `${file} must be executable`) {
	assertExists(file);
	if (process.platform !== 'win32') {
		fs.accessSync(file, fs.constants.X_OK);
	}
	return file;
}

function assertNoLegacyIdentity(value, field) {
	const text = String(value ?? '').toLowerCase();
	assert(!text.includes('code-oss'), `${field} still uses code-oss`);
	assert(!text.includes('vscodeoss'), `${field} still uses vscodeoss`);
	assert(!text.includes('visualstudio.code'), `${field} still uses VS Code bundle identity`);
	assert(!text.includes('microsoft code oss'), `${field} still uses Microsoft Code OSS`);
}

function assertLargeEnough(file, minBytes, field) {
	const stat = fs.statSync(assertExists(file));
	assert(stat.size >= minBytes, `${field} is too small: ${stat.size} bytes`);
	return stat.size;
}

function findAgentBinary() {
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const candidates = [
		{ mode: 'release', file: path.join(repoRoot, 'target/release', `aixlarity${suffix}`) },
		{ mode: 'debug', file: path.join(repoRoot, 'target/debug', `aixlarity${suffix}`) },
	];
	return candidates.find(candidate => fs.existsSync(candidate.file));
}

const compiledEntrypoints = [
	'out/main.js',
	'out/vs/code/electron-main/main.js',
	'out/vs/workbench/workbench.desktop.main.js',
];
for (const relativePath of compiledEntrypoints) {
	assertLargeEnough(path.join(root, relativePath), 1024, relativePath);
}

assertExists(artifactRoot, 'Electron artifact directory is missing. Run `npm run electron` first.');

const checks = [
	'compiled desktop entrypoints exist',
	'Electron artifact directory exists',
];
const warnings = [];
let appSummary;

if (process.platform === 'darwin') {
	const appPath = path.join(artifactRoot, `${product.nameLong}.app`);
	const contentsPath = path.join(appPath, 'Contents');
	const resourcesPath = path.join(contentsPath, 'Resources');
	const infoPlistPath = path.join(contentsPath, 'Info.plist');
	const executablePath = path.join(contentsPath, 'MacOS', product.nameShort);
	const iconPath = path.join(resourcesPath, `${product.nameShort}.icns`);
	const defaultAppAsarPath = path.join(resourcesPath, 'default_app.asar');

	assertExists(appPath, `Expected macOS app artifact at ${appPath}`);
	assertExecutable(executablePath, `Expected executable app binary at ${executablePath}`);
	assertLargeEnough(iconPath, 10_000, 'macOS app icon');
	assertLargeEnough(defaultAppAsarPath, 10_000, 'Electron default_app.asar');

	const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', infoPlistPath], { encoding: 'utf8' }));
	assert.equal(plist.CFBundleName, product.nameShort);
	assert.equal(plist.CFBundleDisplayName, product.nameLong);
	assert.equal(plist.CFBundleExecutable, product.nameShort);
	assert.equal(plist.CFBundleIdentifier, product.darwinBundleIdentifier);
	assert.equal(plist.CFBundleIconFile, `${product.nameShort}.icns`);

	const urlSchemes = (plist.CFBundleURLTypes ?? []).flatMap(entry => entry.CFBundleURLSchemes ?? []);
	assert(urlSchemes.includes(product.urlProtocol), `Info.plist must register ${product.urlProtocol} URL scheme`);

	for (const [field, value] of Object.entries({
		CFBundleName: plist.CFBundleName,
		CFBundleDisplayName: plist.CFBundleDisplayName,
		CFBundleExecutable: plist.CFBundleExecutable,
		CFBundleIdentifier: plist.CFBundleIdentifier,
		CFBundleIconFile: plist.CFBundleIconFile,
		CFBundleURLSchemes: urlSchemes.join(','),
	})) {
		assertNoLegacyIdentity(value, `Info.plist.${field}`);
	}

	appSummary = {
		platform: 'darwin',
		appPath,
		bundleIdentifier: plist.CFBundleIdentifier,
		urlSchemes,
	};
	checks.push('macOS app bundle identity matches product.json');
	checks.push('macOS URL protocol no longer exposes legacy code-oss scheme');
	checks.push('macOS executable/icon/default_app resources exist');
} else if (process.platform === 'win32') {
	const executablePath = path.join(artifactRoot, `${product.nameShort}.exe`);
	assertExists(executablePath, `Expected Windows Electron executable at ${executablePath}`);
	appSummary = { platform: 'win32', executablePath };
	checks.push('Windows Electron executable exists');
} else {
	const executablePath = path.join(artifactRoot, product.applicationName);
	assertExecutable(executablePath, `Expected Linux Electron executable at ${executablePath}`);
	appSummary = { platform: process.platform, executablePath };
	checks.push('Linux Electron executable exists');
}

const agentBinary = findAgentBinary();
assert(agentBinary, 'Aixlarity agent binary is missing. Run `cargo build -p aixlarity` or `cargo build --release -p aixlarity`.');
assertExecutable(agentBinary.file, `Aixlarity agent binary is not executable: ${agentBinary.file}`);
if (agentBinary.mode !== 'release') {
	warnings.push('Release agent binary is not present; artifact validation used target/debug/aixlarity.');
}
checks.push('Aixlarity agent binary is available for IDE launch validation');

console.log(JSON.stringify({
	ok: true,
	checks,
	warnings,
	app: appSummary,
	agentBinary,
}, null, 2));
