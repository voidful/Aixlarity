"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NpmUpToDateFeature = void 0;
const cp = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class NpmUpToDateFeature extends vscode.Disposable {
    _output;
    _statusBarItem;
    _disposables = [];
    _watchers = [];
    _terminal;
    _stateContentsFile;
    _root;
    static _scheme = 'npm-dep-state';
    constructor(_output) {
        const disposables = [];
        super(() => {
            disposables.forEach(d => d.dispose());
            for (const w of this._watchers) {
                w.close();
            }
        });
        this._output = _output;
        this._disposables = disposables;
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
        this._statusBarItem.name = 'npm Install State';
        this._statusBarItem.text = '$(warning) node_modules is stale - run npm i';
        this._statusBarItem.tooltip = 'Dependencies are out of date. Click to run npm install.';
        this._statusBarItem.command = 'vscode-extras.runNpmInstall';
        this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this._disposables.push(this._statusBarItem);
        this._disposables.push(vscode.workspace.registerTextDocumentContentProvider(NpmUpToDateFeature._scheme, {
            provideTextDocumentContent: (uri) => {
                const params = new URLSearchParams(uri.query);
                const source = params.get('source');
                const file = uri.path.slice(1); // strip leading /
                if (source === 'saved') {
                    return this._readSavedContent(file);
                }
                return this._readCurrentContent(file);
            }
        }));
        this._disposables.push(vscode.commands.registerCommand('vscode-extras.runNpmInstall', () => this._runNpmInstall()));
        this._disposables.push(vscode.commands.registerCommand('vscode-extras.showDependencyDiff', (file) => this._showDiff(file)));
        this._disposables.push(vscode.window.onDidCloseTerminal(t => {
            if (t === this._terminal) {
                this._terminal = undefined;
                this._check();
            }
        }));
        this._check();
    }
    _runNpmInstall() {
        if (this._terminal) {
            this._terminal.dispose();
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            return;
        }
        this._terminal = vscode.window.createTerminal({ name: 'npm install', cwd: workspaceRoot });
        this._terminal.sendText('node build/npm/fast-install.ts --force');
        this._terminal.show();
        this._statusBarItem.text = '$(loading~spin) npm i';
        this._statusBarItem.tooltip = 'npm install is running...';
        this._statusBarItem.backgroundColor = undefined;
        this._statusBarItem.command = 'vscode-extras.runNpmInstall';
    }
    _queryState() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return undefined;
        }
        try {
            const script = path.join(workspaceRoot, 'build', 'npm', 'installStateHash.ts');
            const output = cp.execFileSync(process.execPath, [script, '--ignore-node-version'], {
                cwd: workspaceRoot,
                timeout: 10_000,
                encoding: 'utf8',
            });
            const parsed = JSON.parse(output.trim());
            this._output.trace('raw output:', output.trim());
            return parsed;
        }
        catch (e) {
            this._output.error('_queryState error:', e);
            return undefined;
        }
    }
    _check() {
        const state = this._queryState();
        this._output.trace('state:', JSON.stringify(state, null, 2));
        if (!state) {
            this._output.trace('no state, hiding');
            this._statusBarItem.hide();
            return;
        }
        this._stateContentsFile = state.stateContentsFile;
        this._root = state.root;
        this._setupWatcher(state);
        const changedFiles = this._getChangedFiles(state);
        this._output.trace('changedFiles:', JSON.stringify(changedFiles));
        if (changedFiles.length === 0) {
            this._statusBarItem.hide();
        }
        else {
            this._statusBarItem.text = '$(warning) node_modules is stale - run npm i';
            const tooltip = new vscode.MarkdownString();
            tooltip.isTrusted = true;
            tooltip.supportHtml = true;
            tooltip.appendMarkdown('**Dependencies are out of date.** Click to run npm install.\n\nChanged files:\n\n');
            for (const entry of changedFiles) {
                if (entry.isFile) {
                    const args = encodeURIComponent(JSON.stringify(entry.label));
                    tooltip.appendMarkdown(`- [${entry.label}](command:vscode-extras.showDependencyDiff?${args})\n`);
                }
                else {
                    tooltip.appendMarkdown(`- ${entry.label}\n`);
                }
            }
            this._statusBarItem.tooltip = tooltip;
            this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this._statusBarItem.show();
        }
    }
    _showDiff(file) {
        const cacheBuster = Date.now().toString();
        const savedUri = vscode.Uri.from({
            scheme: NpmUpToDateFeature._scheme,
            path: `/${file}`,
            query: new URLSearchParams({ source: 'saved', t: cacheBuster }).toString(),
        });
        const currentUri = vscode.Uri.from({
            scheme: NpmUpToDateFeature._scheme,
            path: `/${file}`,
            query: new URLSearchParams({ source: 'current', t: cacheBuster }).toString(),
        });
        vscode.commands.executeCommand('vscode.diff', savedUri, currentUri, `${file} (last install ↔ current)`);
    }
    _readSavedContent(file) {
        if (!this._stateContentsFile) {
            return '';
        }
        try {
            const contents = JSON.parse(fs.readFileSync(this._stateContentsFile, 'utf8'));
            return contents[file] ?? '';
        }
        catch {
            return '';
        }
    }
    _readCurrentContent(file) {
        if (!this._root) {
            return '';
        }
        try {
            const script = path.join(this._root, 'build', 'npm', 'installStateHash.ts');
            return cp.execFileSync(process.execPath, [script, '--normalize-file', path.join(this._root, file)], {
                cwd: this._root,
                timeout: 10_000,
                encoding: 'utf8',
            });
        }
        catch {
            return '';
        }
    }
    _getChangedFiles(state) {
        if (!state.saved) {
            return [{ label: '(no postinstall state found)', isFile: false }];
        }
        const changed = [];
        if (state.saved.nodeVersion !== state.current.nodeVersion) {
            changed.push({ label: `Node.js version (${state.saved.nodeVersion} → ${state.current.nodeVersion})`, isFile: false });
        }
        const allKeys = new Set([...Object.keys(state.current.fileHashes), ...Object.keys(state.saved.fileHashes)]);
        for (const key of allKeys) {
            if (state.current.fileHashes[key] !== state.saved.fileHashes[key]) {
                changed.push({ label: key, isFile: true });
            }
        }
        return changed;
    }
    _setupWatcher(state) {
        for (const w of this._watchers) {
            w.close();
        }
        this._watchers = [];
        let debounceTimer;
        const scheduleCheck = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => this._check(), 500);
        };
        for (const file of state.files) {
            try {
                const watcher = fs.watch(file, scheduleCheck);
                this._watchers.push(watcher);
            }
            catch {
                // file may not exist yet
            }
        }
    }
}
exports.NpmUpToDateFeature = NpmUpToDateFeature;
//# sourceMappingURL=npmUpToDateFeature.js.map