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
exports.Extension = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const npmUpToDateFeature_1 = require("./npmUpToDateFeature");
class Extension extends vscode.Disposable {
    _output;
    _npmFeature;
    constructor(_context) {
        const disposables = [];
        super(() => disposables.forEach(d => d.dispose()));
        this._output = vscode.window.createOutputChannel('VS Code Extras', { log: true });
        disposables.push(this._output);
        this._updateNpmFeature();
        disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscode-extras.npmUpToDateFeature.enabled')) {
                this._updateNpmFeature();
            }
        }));
    }
    _updateNpmFeature() {
        const enabled = vscode.workspace.getConfiguration('vscode-extras').get('npmUpToDateFeature.enabled', true);
        if (enabled && !this._npmFeature) {
            this._npmFeature = new npmUpToDateFeature_1.NpmUpToDateFeature(this._output);
        }
        else if (!enabled && this._npmFeature) {
            this._npmFeature.dispose();
            this._npmFeature = undefined;
        }
    }
}
exports.Extension = Extension;
let extension;
function activate(context) {
    extension = new Extension(context);
    context.subscriptions.push(extension);
}
function deactivate() {
    extension = undefined;
}
//# sourceMappingURL=extension.js.map