import { append, $, addDisposableListener } from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';

import { URI } from '../../../../base/common/uri.js';
import { ITextModelService, ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type {
    AgentArtifactAttachmentRef,
    AgentArtifactKind,
    AgentArtifactState,
    AgentArtifactStatus,
    AgentReviewAnchor,
    AgentReviewThreadState,
    AgentTaskState,
    AgentTaskStatus,
    PendingApprovalState,
    PersistedAgentWorkspaceState,
} from './aixlarityArtifactModel.js';
import {
    createAgentEvidenceBundle as createAgentEvidenceBundleModel,
    createPersistedAgentWorkspaceState as createPersistedAgentWorkspaceStateModel,
    normalizeArtifactKind as normalizeArtifactKindModel,
    normalizeArtifactStatus as normalizeArtifactStatusModel,
    normalizeReviewThread as normalizeReviewThreadModel,
    normalizeReviewThreads as normalizeReviewThreadsModel,
    normalizeRestoredTaskStatus as normalizeRestoredTaskStatusModel,
    normalizeTaskStatus as normalizeTaskStatusModel,
    restoredTaskProgressLabel as restoredTaskProgressLabelModel,
} from './aixlarityArtifactModel.js';
import type {
    AiDiffFile,
    AiDiffHunk,
    AiDiffHunkReviewAction,
    AiDiffImpactMap,
    AiDiffReviewGate,
    AiDiffRiskProfile,
    AiDiffSnapshot,
    AiDiffSnapshotFile,
    AiDiffSummary,
} from './aixlarityDiffModel.js';
import {
    buildDiffSnapshot as buildDiffSnapshotModel,
    buildDiffSnapshotFile as buildDiffSnapshotFileModel,
    createDiffImpactMap as createDiffImpactMapModel,
    createDiffReviewReport as createDiffReviewReportModel,
    createDiffRiskProfile as createDiffRiskProfileModel,
    createSnapshotCompareDiff as createSnapshotCompareDiffModel,
    diffReviewGate as diffReviewGateModel,
    hunkReviewState as hunkReviewStateModel,
    parseUnifiedDiff as parseUnifiedDiffModel,
} from './aixlarityDiffModel.js';
import {
    createAgentWorkspaceStateKey,
    isPersistedAgentWorkspaceState as isPersistedAgentWorkspaceStateModel,
    persistedAgentWorkspaceStateItemCount as persistedAgentWorkspaceStateItemCountModel,
    shouldPreferLocalMissionState,
} from './aixlarityMissionControlModel.js';
import {
    AIXLARITY_PROVIDER_BUNDLE_SCHEMA,
    createProviderBundle,
    normalizeProviderImportProfile as normalizeProviderImportProfileModel,
    providerExportProfile as providerExportProfileModel,
    providerIsCustom as providerIsCustomModel,
    providerMutationScope as providerMutationScopeModel,
    providerPresets as providerPresetsModel,
} from './aixlarityProviderModel.js';
import {
    artifactKindLabel,
    artifactStatusStyle,
    providerActiveLabel as providerActiveLabelComponent,
    renderArtifactChip as renderArtifactChipComponent,
    taskStatusMeta,
} from './aixlarityUiComponents.js';
import { DiffReviewView } from './aixlarityDiffReviewView.js';
import {
    createKnowledgeLedger,
    createKnowledgeLedgerBundle,
    normalizeKnowledgePolicy,
    type KnowledgePolicy,
} from './aixlarityKnowledgeModel.js';
import { renderKnowledgeLedgerCard } from './aixlarityKnowledgeView.js';
import { createTaskVerificationMarkdown, createTaskVerificationPassport } from './aixlarityVerificationModel.js';
import { renderTaskVerificationPassport } from './aixlarityVerificationView.js';

type AgentManagerTab = 'mission' | 'artifacts' | 'browser' | 'terminal' | 'studio';
type ProviderSetupIntent = 'choose-provider' | 'add-api-key' | 'select-model';

interface AixlarityStudioState {
    schema: string;
    version: number;
    savedAt: number;
    workspace: string;
    missionPolicy: Record<string, any>;
    browserPolicy: Record<string, any>;
    terminalPolicy: Record<string, any>;
    knowledgePolicy: KnowledgePolicy;
    inventory: Record<string, any[]>;
}

export class AixlarityAgentViewPane extends ViewPane {
	private aixlarityWrapper!: HTMLElement;
	private chatContainer!: HTMLElement;
	private fleetContainer!: HTMLElement;
	private settingsContainer!: HTMLElement;
	private historyContainer!: HTMLElement;
	private inputWrapper!: HTMLElement;
	private inputElement!: HTMLTextAreaElement;

    private activeStreamRole: string | null = null;
    private activeStreamNode: HTMLElement | null = null;
    private activeStreamText: string = "";
    private activeStreamRenderDisposable: any = null;

    private devMode: boolean = false;
    private daemonIncompleteLine: string = "";
    private loadingIndicator: HTMLElement | null = null;
    private daemonConnected: boolean = false;

    private isGenerating: boolean = false;
    private sendBtnRef!: HTMLElement;
    private sendIconRef!: HTMLElement;
    private inputBoxRef!: HTMLElement;

    private globalBeamEl: HTMLElement | null = null;
    private inputBeamEl: HTMLElement | null = null;
    private msTextRef: HTMLElement | null = null;
    private rebuildDropdownRef: (() => void) | null = null;
    private rebuildPersonaDropdownRef: (() => void) | null = null;
    private providerListCache: any[] = [];
    private currentProviderId: string = '';
    private activeGlobalProviderId: string = '';
    private activeWorkspaceProviderId: string = '';
    private providerSwitchScope: 'workspace' | 'global' = 'workspace';
    private pendingProviderSetupIntent: ProviderSetupIntent | null = null;
    private providerSetupIntentConsumed = false;

    private attachmentsContainer!: HTMLElement;
    private pendingAttachments: Array<{ file: File, base64: string, type: string, name: string }> = [];


    private conversations: Array<{id: string; title: string; backendSessionId?: string | null; messages: HTMLElement[]; selectedProviderId?: string; selectedProviderLabel?: string; selectedPersona?: string}> = [];
    private activeConversationId: string = '';
    private conversationBar!: HTMLElement;

    // --- Planning Mode ---
    private planningMode: boolean = false;
    private currentPersona: string = 'General';

    // --- Harness Engineering Options (mirrors CLI exec flags) ---
    private currentSandbox: string = 'workspace-write';
    private currentPermission: string = 'suggest';
    private checkpointEnabled: boolean = false;
    private autoGitEnabled: boolean = false;
    private currentSkill: string = '';

    // --- Bottom Toolbar Tracking ---
    private changedFiles: Set<string> = new Set();
    private sessionArtifacts: Array<{id?: string; name: string; type: string; status?: string; taskId?: string}> = [];
    private bottomStatusBar!: HTMLElement;
    private pendingToolActions: Map<string, any> = new Map();

    // --- Agent Manager v2 / Artifact System v2 ---
    private agentTasks: Map<string, AgentTaskState> = new Map();
    private agentArtifacts: Map<string, AgentArtifactState> = new Map();
    private pendingApprovals: Map<string, PendingApprovalState> = new Map();
    private rpcToAgentTask: Map<string, string> = new Map();
    private managerSessions: any[] = [];
    managerCheckpoints: any[] = [];
    private managerAuditEvents: any[] = [];
    private managerWorkspaceIndex: any[] = [];
    private managerTab: AgentManagerTab = 'mission';
    private studioState: AixlarityStudioState | null = null;
    private studioSaveStatus: string = '';
    private managerLoading: boolean = false;
    private managerError: string = '';
    private managerNotice: string = '';
    private managerNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    private managerSearchQuery: string = '';
    private managerStatusFilter: string = 'all';
    private managerKindFilter: string = 'all';
    private agentStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private missionControlLoadInFlight: boolean = false;
    private missionControlLoadedWorkspaceKey: string = '';
    private missionControlSaveInFlight: boolean = false;
    private missionControlSavePending: boolean = false;

    // --- Stream rendering performance ---
    private _streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
    private _streamRenderDirty: boolean = false;
    private _scrollRafPending: boolean = false;

    // --- Async RPC ---
    private pendingRequests: Map<string, {resolve: Function, reject: Function, timer?: ReturnType<typeof setTimeout>}> = new Map();
    // Maps an RPC request ID to the conversation ID that initiated it.
    // Used to route streaming responses, tool actions, and approvals
    // back to the correct conversation tab even if the user has switched.
    private rpcToConversation: Map<string, string> = new Map();
    private rpcMethodById: Map<string, string> = new Map();
	    private activeRpcId: string | null = null;
	    private stoppedRpcIds: Set<string> = new Set();
	    private lastDaemonStatus: string = '';
	    private historyTrackQueue: Map<string, string> = new Map();
	    private historyListCwdByRpcId: Map<string, string> = new Map();
	    private historyTrackTimer: ReturnType<typeof setTimeout> | null = null;
	    private daemonOutListener: ((_event: any, data: any) => void) | null = null;
	    private floatingElements: Set<HTMLElement> = new Set();
	    private managedObjectUrls: string[] = [];
	    private diffSnapshotDocuments: Map<string, { content: string; path: string }> = new Map();
	    private _lastStreamMarkdownRenderAt = 0;
	    private lastOverview: any = null;
	    private workspaceTrustSyncInFlight: boolean = false;
	    private lastInputAssistTrigger: string = '';

	    private readonly streamMarkdownLengthThreshold = 12000;
	    private readonly agentStateStorageVersion = 1;
	    private readonly agentStateStorageMaxTasks = 200;
	    private readonly agentStateStorageMaxArtifacts = 500;
	    private readonly agentStateArtifactBodyLimit = 50000;
	    private readonly agentStateAttachmentInlineLimit = 128000;
	    private readonly streamMarkdownMinIntervalMs = 1000;
	    private readonly diffSnapshotDocumentLimit = 80;
	    private readonly diffSnapshotDocumentBodyLimit = 400000;
	    private readonly historyTrackMaxQueueSize = 200;
	    private readonly historyTrackBatchSize = 25;
	    private readonly historyIgnoredPathSegments = [
	        '/.git/',
	        '/node_modules/',
	        '/target/',
	        '/dist/',
	        '/build/',
	        '/coverage/',
	        '/.cache/',
	        '/.turbo/',
	        '/.next/',
	        '/.venv/',
	        '/venv/',
	        '/__pycache__/',
	        '/vendor/',
	        '/tmp/',
	        '/logs/',
	        '/.aixlarity/',
	        '/aixlarity-ide/out/',
	        '/aixlarity-ide/node_modules/',
	    ];
	    private readonly historyIgnoredFileNames = new Set([
	        '.ds_store',
	        'thumbs.db',
	        'desktop.ini',
	        'package-lock.json',
	        'yarn.lock',
	        'pnpm-lock.yaml',
	        'cargo.lock',
	    ]);
	    private readonly historyIgnoredExtensions = new Set([
	        '.7z', '.a', '.app', '.avi', '.bin', '.bmp', '.class', '.dmg', '.dll', '.doc', '.docx',
	        '.eot', '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lock', '.mov', '.mp3',
	        '.mp4', '.o', '.obj', '.otf', '.pdf', '.png', '.pyc', '.rlib', '.so', '.sqlite',
	        '.sqlite3', '.tar', '.tgz', '.ttf', '.wasm', '.webm', '.webp', '.woff', '.woff2',
	        '.xls', '.xlsx', '.zip',
	    ]);

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileService private readonly fileService: IFileService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

        this._register(this.workspaceTrustManagementService.onDidChangeTrust(trusted => {
            void this.syncAixlarityTrustFromVsCode(trusted, 'Workspace Trust changed', true);
        }));

        // Track file saves for Local History
        this._register(this.textFileService.files.onDidSave(e => {
            if (e.model && e.model.resource && e.model.resource.scheme === 'file') {
                this.queueHistoryTrack(e.model.resource.fsPath, 'user');
            }
        }));

        // Track external file modifications (e.g. from Claude/Codex CLI tools)
        this._register(this.fileService.onDidFilesChange(e => {
            const processUris = (uris: URI[]) => {
                for (const resource of uris) {
                    if (resource && resource.scheme === 'file') {
                        const fsPath = resource.fsPath;
                        this.queueHistoryTrack(fsPath, 'external');
                    }
                }
            };
            processUris(e.rawAdded);
            processUris(e.rawUpdated);
        }));

        // Register Local History Scheme Provider & Command
        this.registerLocalHistoryFeatures(instantiationService);

        this._register({
            dispose: () => {
                this.persistAgentWorkspaceStateNow();
                if (this.agentStateSaveTimer) {
                    clearTimeout(this.agentStateSaveTimer);
                    this.agentStateSaveTimer = null;
                }
                if (this.historyTrackTimer) {
                    clearTimeout(this.historyTrackTimer);
                    this.historyTrackTimer = null;
                }
                if (this._streamRenderTimer) {
                    clearTimeout(this._streamRenderTimer);
                    this._streamRenderTimer = null;
                }
                if (this.activeStreamRenderDisposable?.dispose) {
                    this.activeStreamRenderDisposable.dispose();
                    this.activeStreamRenderDisposable = null;
                }
                this.rejectPendingRequests(new Error('Aixlarity view disposed'));
	                this.historyTrackQueue.clear();
	                this.historyListCwdByRpcId.clear();
	                this.rpcToConversation.clear();
	                this.rpcMethodById.clear();
	                this.rpcToAgentTask.clear();
	                this.pendingApprovals.clear();
	                this.agentTasks.clear();
	                this.agentArtifacts.clear();
	                this.stoppedRpcIds.clear();
	                this.diffSnapshotDocuments.clear();
	                this.removeFloatingElements();
	                this.revokeManagedObjectUrls();
	            }
	        });
		}

	    private appendFloatingElement<T extends HTMLElement>(element: T): T {
	        const host = document.querySelector('.monaco-workbench') || document.body;
	        host.appendChild(element);
	        this.floatingElements.add(element);
	        return element;
	    }

	    private removeFloatingElements(): void {
	        for (const element of this.floatingElements) {
	            element.remove();
	        }
	        this.floatingElements.clear();
	    }

	    private createManagedObjectUrl(blob: Blob): string {
	        const url = URL.createObjectURL(blob);
	        this.managedObjectUrls.push(url);
	        while (this.managedObjectUrls.length > 80) {
	            const oldest = this.managedObjectUrls.shift();
	            if (oldest) {
	                URL.revokeObjectURL(oldest);
	            }
	        }
	        return url;
	    }

	    private revokeManagedObjectUrls(): void {
	        for (const url of this.managedObjectUrls) {
	            URL.revokeObjectURL(url);
	        }
	        this.managedObjectUrls = [];
	    }

	    private stringifyForDisplay(value: unknown, maxChars: number): string {
	        const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
	        return this.truncateForDisplay(text, maxChars, 'content');
	    }

	    private truncateForDisplay(text: string, maxChars: number, label: string): string {
	        if (text.length <= maxChars) {
	            return text;
	        }
	        const omitted = text.length - maxChars;
	        return `${text.slice(0, maxChars)}\n\n[${label} truncated by Aixlarity IDE: ${omitted} chars omitted]`;
	    }

	    private addAttachment(file: File) {
	        const reader = new FileReader();
        reader.onload = (e) => {
            const result = e.target?.result as string;
            if (!result) return;

            const match = result.match(/^data:(.*?);base64,(.*)$/);
            if (!match) return;

            const type = match[1];
            const base64 = match[2];

            const attachObj = { file, base64, type, name: file.name };
            this.pendingAttachments.push(attachObj);

            const chip = append(this.attachmentsContainer, $('.aixlarity-attachment-chip', {
                style: 'display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; font-size: 11px;'
            }));

            if (type.startsWith('image/')) {
                append(chip, $<HTMLImageElement>('img', {
                    src: result,
                    style: 'width: 16px; height: 16px; object-fit: cover; border-radius: 2px;'
                }));
            } else {
                append(chip, $('span.codicon.codicon-file', { style: 'font-size: 12px;' }));
            }

            const nameEl = append(chip, $('span', { style: 'max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
            nameEl.textContent = file.name;

            const removeBtn = append(chip, $('span.codicon.codicon-close', { style: 'cursor: pointer; font-size: 12px; margin-left: 4px;' }));
            removeBtn.addEventListener('click', () => {
                const idx = this.pendingAttachments.indexOf(attachObj);
                if (idx > -1) {
                    this.pendingAttachments.splice(idx, 1);
                    chip.remove();
                }
            });
        };
        reader.readAsDataURL(file);
    }

    public submitMessage(text: string, hidden: boolean = false): void {
        if (!this.daemonConnected) return;
        if (this.isGenerating) return;

        if (!hidden) {
            this.appendMessage('user', text);
        }
        (this as any)._streamFinalized = false;
        if (this.sendToDaemon(text)) {
            this.updateSendButtonState(true);
        }
    }

    public pendingScmInput: any = null;

    public generateCommitMessage(scmService: any): void {
        if (!this.daemonConnected || this.isGenerating) return;

        const repos = Array.from(scmService.repositories);
        if (repos.length === 0) {
            this.appendMessage('system', 'No SCM repositories found.');
            return;
        }

        const repo: any = repos[0];
        this.pendingScmInput = repo.input;

        this.submitMessage("Please write a concise git commit message based on my current staged and unstaged changes. Use the run_command tool to execute `git diff --cached` (or `git diff` if empty) to inspect the changes. ONLY output the final commit message in plain text. Do NOT execute `git commit` or any other commands.", false);
    }

    public explainSelection(): void {
        const ctx = this.getActiveEditorContext();
        if (!ctx.active_file) {
            this.appendMessage('system', 'Open a file before asking Aixlarity to explain code.');
            return;
        }
        const selectionBlock = ctx.selected_text
            ? `Selected code:\n\`\`\`\n${ctx.selected_text}\n\`\`\``
            : `No selection is active. Explain the code around line ${ctx.cursor_line || 1}.`;
        this.submitMessage([
            'Explain this code clearly and concisely.',
            `File: ${ctx.active_file}`,
            ctx.cursor_line ? `Cursor line: ${ctx.cursor_line}` : '',
            selectionBlock,
            'Do not modify files.'
        ].filter(Boolean).join('\n\n'), false);
    }

    public fixSelection(): void {
        const ctx = this.getActiveEditorContext();
        if (!ctx.active_file) {
            this.appendMessage('system', 'Open a file before asking Aixlarity to fix code.');
            return;
        }
        const selectionBlock = ctx.selected_text
            ? `Selected code:\n\`\`\`\n${ctx.selected_text}\n\`\`\``
            : `No selection is active. Inspect the code around line ${ctx.cursor_line || 1}.`;
        this.submitMessage([
            'Fix the issue in this editor context. Keep the change minimal and explain the reasoning after applying it.',
            `File: ${ctx.active_file}`,
            ctx.cursor_line ? `Cursor line: ${ctx.cursor_line}` : '',
            selectionBlock,
            'Use the normal Aixlarity tool approval flow for any file edits or terminal commands.'
        ].filter(Boolean).join('\n\n'), false);
    }

    public draftInlineEdit(): void {
        const ctx = this.getActiveEditorContext();
        if (!ctx.active_file) {
            this.appendMessage('system', 'Open a file before drafting an inline edit.');
            return;
        }
        const selectionBlock = ctx.selected_text
            ? `Selected code:\n\`\`\`\n${ctx.selected_text}\n\`\`\``
            : `No selection is active. Draft an edit around line ${ctx.cursor_line || 1}.`;
        this.submitMessage([
            '[ARTIFACT: Inline Edit Draft]',
            'Draft a precise inline edit for this editor context.',
            'Do not write files yet. Return a small unified diff and a short risk note so I can approve or reject it.',
            `File: ${ctx.active_file}`,
            ctx.cursor_line ? `Cursor line: ${ctx.cursor_line}` : '',
            selectionBlock
        ].filter(Boolean).join('\n\n'), false);
    }

    public reviewCurrentFile(): void {
        const ctx = this.getActiveEditorContext();
        if (!ctx.active_file) {
            this.appendMessage('system', 'Open a file before asking Aixlarity to review it.');
            return;
        }
        this.submitMessage([
            'Review the current file for correctness, maintainability, performance, and security risks.',
            `File: ${ctx.active_file}`,
            ctx.cursor_line ? `Cursor line: ${ctx.cursor_line}` : '',
            'Use read-only inspection unless I explicitly ask you to edit.'
        ].filter(Boolean).join('\n\n'), false);
    }

    public sendProblemsToAgent(markerService: any): void {
        const diagnostics = this.collectProblemDiagnostics(markerService);
        if (!diagnostics) {
            this.appendMessage('system', 'No Problems diagnostics found for the active file or workspace.');
            return;
        }
        this.submitMessage([
            'Analyze these IDE Problems diagnostics and propose the safest fix plan.',
            'Group issues by root cause. If you edit files, use the normal Aixlarity approval flow and verify afterwards.',
            diagnostics
        ].join('\n\n'), false);
    }

    private registerLocalHistoryFeatures(instantiationService: IInstantiationService) {
        const textModelService = instantiationService.invokeFunction(accessor => accessor.get(ITextModelService));
        const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));
        const languageService = instantiationService.invokeFunction(accessor => accessor.get(ILanguageService));
        const quickInputService = instantiationService.invokeFunction(accessor => accessor.get(IQuickInputService));

        const self = this;

        // 1. Register aixlarity-history:// provider
        class AixlarityHistoryProvider implements ITextModelContentProvider {
            async provideTextContent(resource: URI): Promise<any> {
                // resource path is the hash, e.g. aixlarity-history://hash/filename.ext
                const hash = resource.authority;
                const cwd = self.historyCwdFromUri(resource);
                try {
                    const result = await self.sendRpcToDaemonAsync('history/get_blob', { hash, cwd });
                    if (result && result.content) {
                        const languageId = languageService.guessLanguageIdByFilepathOrFirstLine(resource);
                        return modelService.createModel(result.content, languageService.createById(languageId), resource);
                    }
                } catch (e) {
                    console.error("Failed to fetch historical blob:", e);
                }
                return null;
            }
        }
        this._register(textModelService.registerTextModelContentProvider('aixlarity-history', new AixlarityHistoryProvider()));

        class AixlarityDiffSnapshotProvider implements ITextModelContentProvider {
            async provideTextContent(resource: URI): Promise<any> {
                const doc = self.diffSnapshotDocuments.get(self.diffSnapshotDocumentKey(resource));
                if (!doc) {
                    return null;
                }
                const languageId = languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(doc.path));
                return modelService.createModel(doc.content, languageService.createById(languageId), resource);
            }
        }
        this._register(textModelService.registerTextModelContentProvider('aixlarity-diff-snapshot', new AixlarityDiffSnapshotProvider()));

        // 2. Register Explorer Context Menu Command
        this._register(CommandsRegistry.registerCommand({
            id: 'aixlarity.showLocalHistory',
            handler: async (accessor, resource: URI) => {
                if (!resource || resource.scheme !== 'file') return;

                try {
                    const cwd = self.workspaceFolderForFsPath(resource.fsPath);
                    const res = await self.sendRpcToDaemonAsync('history/file_revisions', { path: resource.fsPath, cwd });
                    if (!res || !res.revisions || res.revisions.length === 0) {
                        self.appendMessage('system', `No local history found for ${resource.fsPath}`);
                        return;
                    }

                    const picks = res.revisions.reverse().map((tx: any) => {
                        const date = new Date(tx.timestamp_sec * 1000).toLocaleString();
                        return {
                            label: `$(history) ${date}`,
                            description: `[${tx.source}] ${tx.tool_name}`,
                            detail: `ID: ${tx.id} | Hash: ${tx.before_hash || 'none'}`,
                            tx: tx
                        };
                    });

                    const selected: any = await quickInputService.pick(picks, { placeHolder: 'Select a revision to view diff against current file' });
                    if (selected && selected.tx.before_hash) {
                        const hash = selected.tx.before_hash;
                        const basename = resource.path.split('/').pop() || 'historical_file';

                        // Construct URIs
                        // Authority = hash, path = /basename
                        const leftUri = self.createHistoryUri(hash, basename, cwd);
                        const rightUri = resource; // Current file

                        // Open Native Diff Editor
                        const title = `${basename} (Historical vs Current)`;
                        accessor.get(IEditorService).openEditor({
                            original: { resource: leftUri },
                            modified: { resource: rightUri },
                            label: title,
                            options: { preserveFocus: true, preview: true }
                        } as any);
                    } else if (selected) {
                        self.appendMessage('system', `Revision ${selected.tx.id} has no valid before_hash (file was likely created).`);
                    }
                } catch (e) {
                    console.error("Local History Error:", e);
                    self.appendMessage('system', `Failed to load local history: ${e}`);
                }
            }
        }));

        // Add to Explorer Context Menu
        this._register(MenuRegistry.appendMenuItem(MenuId.ExplorerContext, {
            command: {
                id: 'aixlarity.showLocalHistory',
                title: 'Aixlarity: Show Local History'
            },
            group: 'navigation',
            order: 10
        }));
    }

	protected override renderBody(container: HTMLElement): void {
        try {
            this._actualRenderBody(container);
        } catch (e: any) {
            console.error("RENDER ERROR:", e);
            container.innerText = "RENDER ERROR: " + (e.stack || e.message || e);
            container.style.color = "red";
            container.style.padding = "20px";
            container.style.whiteSpace = "pre-wrap";
        }
    }

    private _actualRenderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.aixlarityWrapper = append(container, $('.aixlarity-agent-container', {
            style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; background: var(--vscode-sideBar-background); z-index: 10; min-width: 260px;'
        }));

        // Add dynamic CSS for antigravity markdown
        const styleEl = append(this.aixlarityWrapper, $<HTMLStyleElement>('style'));
        styleEl.textContent = `
            .aixlarity-message-content { user-select: text !important; -webkit-user-select: text !important; }
            .aixlarity-message-content > :first-child { margin-top: 0 !important; }
            .aixlarity-message-content > :last-child { margin-bottom: 0 !important; }
            .aixlarity-message-content pre { background: var(--vscode-textCodeBlock-background); border-radius: 6px; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 8px 0; }
            .aixlarity-message-content code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 2px 4px; }
            .aixlarity-message-content a { color: var(--vscode-textLink-foreground); text-decoration: none; }
            .aixlarity-message-content a:hover { text-decoration: underline; }
            .aixlarity-message-content ul, .aixlarity-message-content ol { padding-inline-start: 20px; margin: 8px 0; }
            .aixlarity-message-content img, .aixlarity-attachment-img { max-width: 100%; max-height: 250px; object-fit: contain; cursor: zoom-in; border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1)); display: block; margin: 8px 0; background: rgba(0,0,0,0.2); }
            .aixlarity-message-content img.expanded, .aixlarity-attachment-img.expanded { max-height: none; cursor: zoom-out; width: 100%; }
            .aixlarity-chat-history::-webkit-scrollbar, .aixlarity-chat-history *::-webkit-scrollbar, .aixlarity-input::-webkit-scrollbar { display: none !important; width: 0 !important; background: transparent !important; }
            .aixlarity-chat-history, .aixlarity-chat-history *, .aixlarity-input { -ms-overflow-style: none !important; scrollbar-width: none !important; }
            .aixlarity-msg-action-bar { position: absolute; bottom: 6px; right: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; z-index: 5; }
            .aixlarity-message:hover .aixlarity-msg-action-bar { opacity: 1; }
            .aixlarity-msg-action-btn { background: transparent !important; border: none !important; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px; border-radius: 4px; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; }
            .aixlarity-msg-action-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)) !important; color: var(--vscode-foreground); }
            .aixlarity-msg-action-btn .codicon { font-size: 13px !important; }
            .aixlarity-think-toggle { margin-bottom: 12px; }
            .aixlarity-think-toggle summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); user-select: none; display: flex; align-items: center; gap: 4px; padding: 4px 0; }
            .aixlarity-think-toggle summary:hover { color: var(--vscode-foreground); }
            .aixlarity-think-toggle .aixlarity-think-body { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.5; padding: 8px 12px; margin-top: 4px; border-left: 2px solid var(--vscode-panel-border, rgba(255,255,255,0.1)); max-height: 300px; overflow-y: auto; }
            .aixlarity-tool-action { flex-shrink: 0; background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 2px; margin-bottom: 4px; font-size: 12px; overflow: hidden; }
            .aixlarity-tool-action-header { display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--vscode-descriptionForeground); padding: 6px 10px; cursor: pointer; user-select: none; transition: background 0.15s; font-size: 12px; }
            .aixlarity-tool-action-header:hover { background: var(--vscode-list-hoverBackground); }
            .aixlarity-tool-action-header .tool-chevron { transition: transform 0.2s; font-size: 10px; }
            .aixlarity-tool-action-header .tool-chevron.expanded { transform: rotate(90deg); }
            .aixlarity-tool-action-detail { display: none; padding: 6px 10px 8px 28px; border-top: 1px solid var(--vscode-panel-border); }
            .aixlarity-tool-action-detail.open { display: block; }
            .aixlarity-tool-action pre { margin: 0; font-size: 11px; background: transparent; padding: 0; }
            .aixlarity-approval-card { flex-shrink: 0; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
            .aixlarity-approval-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px; color: var(--vscode-foreground); }
            .aixlarity-approval-header .approval-icon { font-size: 14px; }
            .aixlarity-approval-detail { padding: 4px 12px 8px 32px; font-size: 11px; color: var(--vscode-descriptionForeground); }
            .aixlarity-approval-detail pre { margin: 0; font-size: 11px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; max-height: 150px; overflow-y: auto; }
            .aixlarity-approval-actions { display: flex; gap: 6px; padding: 6px 12px 10px; }
            .aixlarity-approval-btn { padding: 4px 14px; border-radius: 2px; font-size: 11px; font-weight: 600; border: none; cursor: pointer; transition: all 0.15s; }
            .aixlarity-approval-btn:hover { filter: brightness(1.15); }
            .aixlarity-approval-btn.allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            .aixlarity-approval-btn.deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-errorForeground, #f44747); }
            .aixlarity-approval-btn.always { background: var(--vscode-button-secondaryBackground); color: var(--vscode-textLink-foreground); }
            .aixlarity-approval-resolved { padding: 6px 12px; font-size: 12px; display: flex; align-items: center; gap: 6px; }
            @keyframes aixlarity-dot-pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
            .aixlarity-loading { display: flex; align-items: center; gap: 8px; padding: 12px 0; margin-bottom: 16px; }
            .aixlarity-loading-dots { display: flex; gap: 4px; }
            .aixlarity-loading-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground, #888); animation: aixlarity-dot-pulse 1.4s ease-in-out infinite; }
            .aixlarity-loading-dots span:nth-child(2) { animation-delay: 0.2s; }
            .aixlarity-loading-dots span:nth-child(3) { animation-delay: 0.4s; }
            .aixlarity-loading-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
            .aixlarity-conv-bar { display: flex; align-items: center; gap: 3px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; overflow-x: auto; }
            .aixlarity-conv-bar::-webkit-scrollbar { display: none !important; }
            .aixlarity-conv-pill { padding: 2px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s; color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground)); background: transparent; border: 1px solid transparent; }
            .aixlarity-conv-pill:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
            .aixlarity-conv-pill.active { color: var(--vscode-foreground); background: var(--vscode-tab-activeBackground, var(--vscode-editor-background)); border-color: color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
            .aixlarity-conv-new { padding: 2px 7px; border-radius: 6px; font-size: 11px; cursor: pointer; color: var(--vscode-textLink-foreground); background: transparent; border: 1px solid var(--vscode-panel-border); transition: all 0.15s; display: flex; align-items: center; gap: 2px; }
            .aixlarity-conv-new:hover { background: var(--vscode-list-hoverBackground); }
            .aixlarity-bottom-status { padding: 0 12px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--vscode-panel-border); }
            .aixlarity-bottom-status:empty { display: none; padding: 0; border: none; }
            .aixlarity-status-section { display: flex; align-items: center; gap: 6px; padding: 6px 0; flex-wrap: wrap; }
            .aixlarity-status-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
            .aixlarity-file-pill { font-size: 11px; padding: 2px 8px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
            .aixlarity-file-pill:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
            .aixlarity-artifact-pill { font-size: 11px; padding: 2px 8px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-textLink-foreground); cursor: pointer; transition: all 0.15s; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
            .aixlarity-artifact-pill:hover { background: var(--vscode-list-hoverBackground); }
            .aixlarity-planning-active { color: var(--vscode-foreground) !important; }
            .aixlarity-welcome { align-self: stretch; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 2px; margin-bottom: 16px; padding: 10px 12px; font-size: 12px; color: var(--vscode-foreground); line-height: 1.5; flex-shrink: 0; }
            .aixlarity-provider-dropdown {
                position: fixed;
                min-width: 230px; max-height: 320px; overflow-y: auto;
                background: var(--vscode-menu-background);
                border: 1px solid var(--vscode-menu-border);
                border-radius: 4px; padding: 4px 0;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                z-index: 10000; display: none;
                color: var(--vscode-menu-foreground);
                font-family: var(--vscode-font-family);
            }
            .aixlarity-provider-dropdown::-webkit-scrollbar { display: none !important; width: 0 !important; }
            .aixlarity-provider-dropdown.open { display: block; animation: aixlarity-fade-in 0.1s ease-out; transform-origin: bottom center; }
            @keyframes aixlarity-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes aixlarity-panel-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes aixlarity-card-in { from { opacity: 0; transform: translateY(4px) scale(0.995); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @keyframes aixlarity-notice-in { 0% { opacity: 0; transform: translateY(-4px); } 100% { opacity: 1; transform: translateY(0); } }
            @keyframes aixlarity-guide-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-focusBorder) 26%, transparent); } 50% { box-shadow: 0 0 0 4px transparent; } }
            @keyframes aixlarity-fade-out { to { opacity: 0; transform: translateY(-4px); } }
            @keyframes aixlarity-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            @keyframes aixlarity-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .aixlarity-fleet-manager, .aixlarity-settings-dashboard { animation: aixlarity-panel-in 150ms ease-out; }

            .aixlarity-provider-item {
                display: flex; align-items: center; justify-content: space-between;
                padding: 6px 12px; cursor: pointer; font-size: 13px; font-weight: 400;
                color: var(--vscode-menu-foreground);
                transition: background 0.1s ease;
                margin: 0 4px 1px 4px; border-radius: 2px;
            }
            .aixlarity-provider-item:hover {
                background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
                color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
            }
            .aixlarity-provider-item.selected {
                background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
                color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
            }
            .aixlarity-provider-item .aixlarity-remove-btn {
                opacity: 0.6; cursor: pointer; padding: 2px 4px; border-radius: 2px;
                display: flex; align-items: center; transition: all 0.2s;
            }
            .aixlarity-provider-item .aixlarity-remove-btn:hover {
                opacity: 1; background: var(--vscode-inputValidation-errorBackground, rgba(255, 60, 60, 0.3)); color: var(--vscode-errorForeground);
            }
            .aixlarity-provider-separator {
                height: 1px; margin: 4px 8px;
                background: var(--vscode-panel-border);
            }
            .aixlarity-settings-card {
                background: var(--vscode-editorWidget-background, transparent);
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
                border-radius: 7px;
                padding: 8px 10px;
                margin-bottom: 6px;
                color: var(--vscode-foreground);
                transition: background 0.15s;
                animation: aixlarity-card-in 140ms ease-out both;
            }
            .aixlarity-settings-card:hover {
                background: color-mix(in srgb, var(--vscode-list-hoverBackground) 50%, transparent);
            }
            .aixlarity-provider-setup-focus {
                border-color: var(--vscode-focusBorder) !important;
                box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 0 0 5px color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent);
            }
            .aixlarity-provider-setup-steps {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 5px;
                margin-top: 8px;
            }
            .aixlarity-provider-step {
                min-width: 0;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 6px;
                padding: 6px 7px;
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-provider-step.ready {
                border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 45%, var(--vscode-panel-border));
                color: var(--vscode-foreground);
            }
            .aixlarity-provider-step-label {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                font-size: 10px;
                font-weight: 700;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .aixlarity-provider-step-status {
                margin-top: 3px;
                font-size: 9px;
                text-transform: uppercase;
                letter-spacing: 0.4px;
                opacity: 0.78;
            }
            .aixlarity-section-label {
                font-size: 10px;
                font-weight: 700;
                color: var(--vscode-descriptionForeground);
                margin: 10px 0 5px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .aixlarity-compact-select {
                width: 100%;
                box-sizing: border-box;
                background: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
                border-radius: 6px;
                padding: 4px 7px;
                font-size: 11px;
                outline: none;
            }
            .aixlarity-scope-toggle {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 4px;
                margin-top: 8px;
            }
            .aixlarity-scope-toggle button {
                justify-content: center;
            }
            .aixlarity-scope-toggle button.active {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            .aixlarity-provider-quick-list {
                display: flex;
                flex-direction: column;
                gap: 5px;
                margin-top: 8px;
            }
            .aixlarity-provider-quick-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
                padding: 6px 0;
                border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
            }
            .aixlarity-provider-quick-row:first-child {
                border-top: none;
            }
            .aixlarity-provider-quick-title {
                font-size: 11px;
                font-weight: 600;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-provider-quick-meta {
                margin-top: 2px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-provider-quick-actions {
                display: flex;
                gap: 4px;
                align-items: center;
            }
            .aixlarity-model-editor {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 6px;
                align-items: center;
                margin-top: 8px;
            }
            .aixlarity-model-input {
                min-width: 0;
                width: 100%;
                box-sizing: border-box;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
                border-radius: 6px;
                padding: 4px 7px;
                font-size: 11px;
                outline: none;
            }
            .aixlarity-model-input:focus {
                border-color: var(--vscode-focusBorder);
            }
            .aixlarity-model-hint {
                min-height: 12px;
                margin-top: 5px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-settings-card-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
            }
            .aixlarity-fleet-card {
                background: var(--vscode-editorWidget-background, transparent);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                padding: 12px 14px;
                margin-bottom: 12px;
                color: var(--vscode-foreground);
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
            }
            .aixlarity-fleet-card:hover {
                background: var(--vscode-list-hoverBackground);
                border-color: var(--vscode-focusBorder);
            }
            .aixlarity-manager-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 8px;
            }
            .aixlarity-manager-title {
                font-size: 13px;
                font-weight: 650;
                color: var(--vscode-foreground);
            }
            .aixlarity-manager-subtitle {
                margin-top: 1px;
                font-size: 10px;
                line-height: 1.25;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-manager-actions {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-wrap: wrap;
                justify-content: flex-end;
            }
            .aixlarity-metric-strip {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 1px;
                margin: 2px 0 8px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
                border-radius: 7px;
                overflow: hidden;
                background: var(--vscode-panel-border);
            }
            .aixlarity-metric-item {
                min-width: 0;
                padding: 6px 8px;
                background: var(--vscode-editorWidget-background, transparent);
                animation: aixlarity-card-in 140ms ease-out both;
            }
            .aixlarity-metric-item:nth-child(2) { animation-delay: 25ms; }
            .aixlarity-metric-item:nth-child(3) { animation-delay: 50ms; }
            .aixlarity-metric-value {
                font-size: 14px;
                font-weight: 700;
                line-height: 1;
                color: var(--vscode-foreground);
            }
            .aixlarity-metric-label {
                font-size: 9px;
                color: var(--vscode-descriptionForeground);
                margin-top: 3px;
                text-transform: uppercase;
                letter-spacing: 0.4px;
            }
            .aixlarity-segmented {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 2px;
                padding: 2px;
                margin: 6px 0 10px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
                border-radius: 8px;
                background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
            }
            .aixlarity-segment-button {
                border: none;
                border-radius: 6px;
                padding: 4px 8px;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                font-size: 11px;
                transition: background 0.14s, color 0.14s, transform 0.14s;
            }
            .aixlarity-segment-button:active { transform: scale(0.985); }
            .aixlarity-segment-button.active {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-foreground);
            }
            .aixlarity-manager-notice {
                padding: 6px 8px;
                margin: 0 0 8px;
                border-radius: 7px;
                background: color-mix(in srgb, var(--vscode-button-background) 14%, transparent);
                color: var(--vscode-foreground);
                font-size: 11px;
                line-height: 1.3;
                animation: aixlarity-notice-in 140ms ease-out;
            }
            .aixlarity-guide-card {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                padding: 8px 9px;
                margin: 0 0 8px;
                border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 38%, var(--vscode-panel-border));
                border-radius: 8px;
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
                color: var(--vscode-foreground);
                animation: aixlarity-card-in 160ms ease-out both;
            }
            .aixlarity-guide-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                margin-top: 5px;
                background: var(--vscode-focusBorder);
                animation: aixlarity-guide-pulse 1.8s ease-in-out infinite;
                flex: 0 0 auto;
            }
            .aixlarity-guide-body { min-width: 0; flex: 1; }
            .aixlarity-guide-title { font-size: 11px; font-weight: 650; margin-bottom: 5px; }
            .aixlarity-guide-steps { display: flex; flex-wrap: wrap; gap: 4px; }
            .aixlarity-guide-step {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 6px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 999px;
                color: var(--vscode-descriptionForeground);
                font-size: 10px;
                white-space: nowrap;
            }
            .aixlarity-guide-close {
                border: none;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                cursor: pointer;
                padding: 1px;
                border-radius: 5px;
                line-height: 1;
            }
            .aixlarity-guide-close:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
            .aixlarity-fade-out { animation: aixlarity-fade-out 140ms ease-in forwards; }
            .aixlarity-refresh-spinner {
                width: 11px;
                height: 11px;
                border: 1.5px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
                border-top-color: var(--vscode-focusBorder);
                border-radius: 50%;
                animation: aixlarity-spin 0.85s linear infinite;
            }
            .aixlarity-manager-grid {
                display: grid;
                grid-template-columns: minmax(0, 1fr);
                gap: 7px;
            }
            .aixlarity-manager-section-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin: 10px 0 5px;
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-task-card {
                background: var(--vscode-editorWidget-background, transparent);
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
                border-left: 2px solid var(--vscode-textLink-foreground, #4daafc);
                border-radius: 7px;
                padding: 9px 10px;
                display: flex;
                flex-direction: column;
                gap: 7px;
                color: var(--vscode-foreground);
                animation: aixlarity-card-in 150ms ease-out both;
            }
            .aixlarity-task-card[data-status="completed"] { border-left-color: var(--vscode-testing-iconPassed, #4ade80); }
            .aixlarity-task-card[data-status="failed"] { border-left-color: var(--vscode-errorForeground, #f87171); }
            .aixlarity-task-card[data-status="paused"] { border-left-color: var(--vscode-editorWarning-foreground, #fbbf24); }
            .aixlarity-task-card[data-status="stopped"] { border-left-color: var(--vscode-descriptionForeground); }
            .aixlarity-task-card[data-status="waiting_review"] { border-left-color: var(--vscode-editorWarning-foreground, #fbbf24); }
            .aixlarity-task-top {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 8px;
            }
            .aixlarity-task-title {
                font-size: 12px;
                font-weight: 650;
                line-height: 1.28;
                color: var(--vscode-foreground);
                word-break: break-word;
            }
            .aixlarity-task-meta {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-top: 3px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-task-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 1px 5px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 5px;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                white-space: nowrap;
            }
            .aixlarity-task-status {
                padding: 1px 6px;
                border-radius: 6px;
                font-size: 9px;
                font-weight: 700;
                letter-spacing: 0.4px;
                text-transform: uppercase;
                white-space: nowrap;
            }
            .aixlarity-task-progress {
                font-size: 11px;
                line-height: 1.35;
                color: var(--vscode-descriptionForeground);
                background: transparent;
                border: none;
                border-radius: 0;
                padding: 0;
            }
            .aixlarity-artifact-strip {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }
            .aixlarity-verification-passport {
                display: flex;
                flex-direction: column;
                gap: 5px;
                padding: 7px 8px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
                border-radius: 7px;
                background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
            }
            .aixlarity-verification-passport.ready { border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #4ade80) 42%, var(--vscode-panel-border)); }
            .aixlarity-verification-passport.blocked { border-color: color-mix(in srgb, var(--vscode-errorForeground, #f87171) 42%, var(--vscode-panel-border)); }
            .aixlarity-verification-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .aixlarity-verification-title {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                font-size: 11px;
                font-weight: 650;
                color: var(--vscode-foreground);
            }
            .aixlarity-verification-score {
                border: none;
                border-radius: 5px;
                padding: 1px 5px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                color: var(--vscode-descriptionForeground);
                background: transparent;
                cursor: pointer;
                font-size: 10px;
            }
            .aixlarity-verification-score:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
            .aixlarity-verification-steps {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }
            .aixlarity-verification-step {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 1px 5px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 5px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
                white-space: nowrap;
            }
            .aixlarity-verification-step.ok { color: var(--vscode-testing-iconPassed, #4ade80); }
            .aixlarity-verification-step.blocked { color: var(--vscode-errorForeground, #f87171); }
            .aixlarity-verification-summary {
                font-size: 10px;
                line-height: 1.3;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-artifact-chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 6px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 6px;
                background: transparent;
                color: var(--vscode-textLink-foreground);
                font-size: 10px;
                cursor: pointer;
                max-width: 100%;
            }
            .aixlarity-artifact-chip:hover { background: var(--vscode-list-hoverBackground); }
            .aixlarity-artifact-chip .artifact-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-edit-timeline {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin-bottom: 8px;
            }
            .aixlarity-edit-round {
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
                border-radius: 7px;
                padding: 8px 9px;
                background: var(--vscode-editorWidget-background, transparent);
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
            }
            .aixlarity-edit-round:hover {
                background: color-mix(in srgb, var(--vscode-list-hoverBackground) 55%, transparent);
            }
            .aixlarity-edit-round-title {
                font-size: 12px;
                font-weight: 650;
                color: var(--vscode-foreground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-edit-round-meta {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-top: 4px;
            }
            .aixlarity-edit-compare {
                display: grid;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
                gap: 6px;
                align-items: center;
                margin-bottom: 8px;
            }
            .aixlarity-edit-compare select {
                min-width: 0;
                background: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
                border-radius: 5px;
                padding: 5px 7px;
                font-size: 11px;
            }
            .aixlarity-diff-viewer {
                border: 1px solid var(--vscode-panel-border);
                border-radius: 7px;
                overflow: hidden;
                background: var(--vscode-textCodeBlock-background);
                flex: 0 0 auto;
            }
            .aixlarity-diff-brief {
                display: grid;
                grid-template-columns: minmax(0, 1fr);
                gap: 7px;
                padding: 8px 10px;
                border-bottom: 1px solid var(--vscode-panel-border);
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 58%, transparent);
            }
            .aixlarity-diff-brief-title {
                font-size: 10px;
                font-weight: 750;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-diff-brief-summary {
                font-size: 11px;
                color: var(--vscode-foreground);
                line-height: 1.35;
            }
            .aixlarity-diff-risk-strip {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }
            .aixlarity-diff-risk-pill {
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-radius: 6px;
                padding: 2px 6px;
                font-size: 10px;
                color: var(--vscode-foreground);
                background: transparent;
            }
            .aixlarity-diff-risk-pill.high { border-color: rgba(239,68,68,0.6); color: #fca5a5; }
            .aixlarity-diff-risk-pill.medium { border-color: rgba(234,179,8,0.62); color: #fde68a; }
            .aixlarity-diff-risk-pill.low { border-color: rgba(34,197,94,0.58); color: #86efac; }
            .aixlarity-diff-impact-map {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 7px;
            }
            .aixlarity-diff-impact-group {
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                border-radius: 6px;
                padding: 7px;
                min-width: 0;
            }
            .aixlarity-diff-impact-title {
                font-size: 10px;
                font-weight: 750;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 5px;
            }
            .aixlarity-diff-impact-item {
                display: block;
                font-size: 11px;
                line-height: 1.35;
                color: var(--vscode-foreground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-diff-header {
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                gap: 10px;
                padding: 8px 10px;
                border-bottom: 1px solid var(--vscode-panel-border);
                align-items: flex-start;
                position: sticky;
                top: 0;
                z-index: 2;
                background: var(--vscode-textCodeBlock-background);
            }
            .aixlarity-diff-title {
                font-size: 11px;
                font-weight: 750;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--vscode-foreground);
            }
            .aixlarity-diff-subtitle {
                margin-top: 3px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-diff-controls {
                display: flex;
                gap: 5px;
                flex-wrap: wrap;
                justify-content: flex-start;
            }
            .aixlarity-diff-body {
                display: grid;
                grid-template-columns: minmax(0, 1fr);
                min-height: 280px;
                max-height: min(440px, 58vh);
            }
            .aixlarity-diff-files {
                display: flex;
                border-bottom: 1px solid var(--vscode-panel-border);
                overflow-x: auto;
                overflow-y: hidden;
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 65%, transparent);
            }
            .aixlarity-diff-file-tab {
                min-width: 150px;
                max-width: 240px;
                border: 0;
                border-right: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                background: transparent;
                color: var(--vscode-foreground);
                text-align: left;
                padding: 7px 8px;
                cursor: pointer;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .aixlarity-diff-file-tab.active {
                background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            .aixlarity-diff-file-path {
                font-size: 11px;
                font-weight: 650;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-diff-file-stats {
                display: flex;
                gap: 5px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-diff-main {
                min-width: 0;
                display: flex;
                flex-direction: column;
            }
            .aixlarity-diff-file-header {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                align-items: center;
                padding: 7px 9px;
                border-bottom: 1px solid var(--vscode-panel-border);
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-diff-snapshot-strip {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                justify-content: flex-end;
            }
            .aixlarity-diff-hunk-review {
                border-bottom: 1px solid var(--vscode-panel-border);
                background: color-mix(in srgb, var(--vscode-editorWidget-background) 45%, transparent);
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 8px 9px;
            }
            .aixlarity-diff-hunk-review-top,
            .aixlarity-diff-hunk-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
            }
            .aixlarity-diff-hunk-title {
                font-size: 10px;
                font-weight: 750;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-diff-hunk-row {
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                border-radius: 6px;
                padding: 6px;
            }
            .aixlarity-diff-hunk-meta {
                min-width: 0;
                display: flex;
                gap: 5px;
                align-items: center;
                flex-wrap: wrap;
                font-size: 11px;
            }
            .aixlarity-diff-hunk-meta code {
                color: var(--vscode-foreground);
                background: transparent;
                overflow-wrap: anywhere;
            }
            .aixlarity-diff-hunk-actions {
                display: flex;
                gap: 5px;
                align-items: center;
                flex-wrap: wrap;
                justify-content: flex-end;
            }
            .aixlarity-diff-hunk-actions input {
                width: 150px;
                min-width: 120px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 5px;
                padding: 5px 7px;
                font-size: 11px;
                outline: none;
            }
            .aixlarity-diff-table {
                overflow: auto;
                font-family: var(--vscode-editor-font-family);
                font-size: 11px;
                line-height: 1.45;
                flex: 1;
                min-width: 0;
            }
            .aixlarity-diff-row {
                display: grid;
                min-height: 17px;
                border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 18%, transparent);
                min-width: 0;
            }
            .aixlarity-diff-row.split {
                grid-template-columns: 44px minmax(0, 1fr) 44px minmax(0, 1fr);
            }
            .aixlarity-diff-row.unified {
                grid-template-columns: 44px 44px minmax(0, 1fr);
            }
            .aixlarity-diff-gutter {
                color: var(--vscode-editorLineNumber-foreground);
                text-align: right;
                padding: 0 6px;
                user-select: none;
                background: color-mix(in srgb, var(--vscode-editorGutter-background) 70%, transparent);
            }
            .aixlarity-diff-code {
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                overflow: hidden;
                padding: 0 8px;
                min-width: 0;
            }
            .aixlarity-diff-row.add .aixlarity-diff-code,
            .aixlarity-diff-row.add .aixlarity-diff-gutter {
                background: rgba(34,197,94,0.13);
            }
            .aixlarity-diff-row.delete .aixlarity-diff-code,
            .aixlarity-diff-row.delete .aixlarity-diff-gutter {
                background: rgba(239,68,68,0.13);
            }
            .aixlarity-diff-row.change .aixlarity-diff-code,
            .aixlarity-diff-row.change .aixlarity-diff-gutter {
                background: rgba(234,179,8,0.11);
            }
            .aixlarity-diff-row.hunk {
                color: #93c5fd;
                background: rgba(59,130,246,0.14);
                font-weight: 650;
            }
            .aixlarity-diff-row.meta {
                color: var(--vscode-descriptionForeground);
                background: rgba(148,163,184,0.09);
            }
            .aixlarity-diff-word-add {
                background: rgba(34,197,94,0.28);
                border-radius: 2px;
            }
            .aixlarity-diff-word-delete {
                background: rgba(239,68,68,0.28);
                border-radius: 2px;
            }
            .aixlarity-diff-stats {
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                overflow: auto;
            }
            .aixlarity-diff-stat-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
                font-size: 11px;
            }
            .aixlarity-diff-stat-bar {
                height: 5px;
                border-radius: 999px;
                overflow: hidden;
                background: var(--vscode-panel-border);
                display: flex;
                margin-top: 4px;
            }
            .aixlarity-diff-stat-add { background: rgba(34,197,94,0.75); }
            .aixlarity-diff-stat-del { background: rgba(239,68,68,0.75); }
            @media (min-width: 900px) {
                .aixlarity-diff-header {
                    flex-direction: row;
                }
                .aixlarity-diff-controls {
                    justify-content: flex-end;
                }
                .aixlarity-diff-body {
                    grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
                }
                .aixlarity-diff-files {
                    display: block;
                    overflow: auto;
                    border-right: 1px solid var(--vscode-panel-border);
                    border-bottom: 0;
                }
                .aixlarity-diff-file-tab {
                    width: 100%;
                    min-width: 0;
                    max-width: none;
                    border-right: 0;
                    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                }
            }
            @media (max-width: 720px) {
                .aixlarity-edit-compare,
                .aixlarity-diff-hunk-row {
                    grid-template-columns: minmax(0, 1fr);
                }
                .aixlarity-diff-hunk-actions {
                    justify-content: flex-start;
                }
            }
            .aixlarity-timeline {
                display: flex;
                flex-direction: column;
                gap: 3px;
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
            }
            .aixlarity-timeline-row {
                display: grid;
                grid-template-columns: 52px minmax(0, 1fr);
                gap: 6px;
                align-items: start;
            }
            .aixlarity-timeline-time {
                color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
                white-space: nowrap;
            }
            .aixlarity-empty-state {
                border: 1px dashed var(--vscode-panel-border);
                border-radius: 7px;
                padding: 12px 10px;
                text-align: center;
                font-size: 11px;
                line-height: 1.35;
                color: var(--vscode-descriptionForeground);
                background: transparent;
            }
            .aixlarity-artifact-modal-body {
                display: flex;
                flex-direction: column;
                gap: 10px;
                flex: 1 1 auto;
                min-height: 0;
                max-height: min(680px, 68vh);
                overflow-y: auto;
                overflow-x: hidden;
            }
            .aixlarity-settings-badge {
                padding: 2px 8px;
                border-radius: 2px;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.5px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
            }
            .aixlarity-settings-badge.active {
                background: var(--vscode-testing-iconPassed, #388a34);
                color: #ffffff;
            }
            .aixlarity-knowledge-ledger {
                gap: 8px;
            }
            .aixlarity-knowledge-top,
            .aixlarity-knowledge-actions,
            .aixlarity-knowledge-activation {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .aixlarity-knowledge-title {
                font-size: 12px;
                font-weight: 650;
                color: var(--vscode-foreground);
            }
            .aixlarity-knowledge-subtitle,
            .aixlarity-knowledge-entry-meta {
                font-size: 10px;
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-knowledge-metrics,
            .aixlarity-knowledge-controls {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }
            .aixlarity-knowledge-switch {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
                border-radius: 6px;
                padding: 2px 6px;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                font-size: 10px;
                cursor: pointer;
            }
            .aixlarity-knowledge-switch.active {
                color: var(--vscode-foreground);
                background: var(--vscode-button-secondaryBackground);
            }
            .aixlarity-knowledge-entries {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .aixlarity-knowledge-entry {
                display: grid;
                grid-template-columns: 16px minmax(0, 1fr);
                gap: 6px;
                align-items: start;
                padding: 4px 0;
                border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 58%, transparent);
            }
            .aixlarity-knowledge-entry-title {
                font-size: 11px;
                color: var(--vscode-foreground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .aixlarity-settings-detail {
                display: none;
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid var(--vscode-panel-border);
            }
            .aixlarity-action-button {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                padding: 3px 8px;
                border-radius: 6px;
                font-size: 11px;
                cursor: pointer;
                transition: background 0.15s;
                display: flex;
                align-items: center;
                gap: 4px;
                min-height: 22px;
            }
            .aixlarity-action-button:active { transform: scale(0.98); }
            .aixlarity-action-button:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            .aixlarity-action-button:disabled {
                opacity: 0.45;
                cursor: default;
            }
            .aixlarity-action-button:disabled:hover {
                background: var(--vscode-button-secondaryBackground);
            }
            .aixlarity-action-button .codicon {
                font-size: 12px;
            }

            .aixlarity-action-button.danger {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-errorForeground, #f44747);
            }
            .aixlarity-action-button.danger:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            .aixlarity-action-button.warning {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-editorWarning-foreground, #cca700);
            }
            .aixlarity-action-button.warning:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            .aixlarity-settings-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
                padding: 3px 0;
                font-size: 11px;
                border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
            }
            .aixlarity-settings-row:last-child { border-bottom: none; }
            .aixlarity-settings-label {
                color: var(--vscode-descriptionForeground);
                font-weight: 400;
            }
            .aixlarity-settings-value {
                color: var(--vscode-foreground);
                text-align: right;
            }
            .aixlarity-action-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 400;
                cursor: pointer;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 2px;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                transition: background 0.15s;
            }
            .aixlarity-action-btn:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            @media (prefers-reduced-motion: reduce) {
                .aixlarity-fleet-manager,
                .aixlarity-settings-dashboard,
                .aixlarity-settings-card,
                .aixlarity-task-card,
                .aixlarity-metric-item,
                .aixlarity-manager-notice,
                .aixlarity-guide-card,
                .aixlarity-guide-dot,
                .aixlarity-refresh-spinner {
                    animation: none !important;
                }
                .aixlarity-action-button,
                .aixlarity-segment-button {
                    transition: none !important;
                }
            }
        `;

        // --- Conversation Switcher Bar ---
        this.conversationBar = append(this.aixlarityWrapper, $('div.aixlarity-conv-bar'));
        this.createConversation(); // Create first default conversation
        this.rebuildConversationBar();

		// Chat history area (Antigravity Replica)
		this.chatContainer = append(this.aixlarityWrapper, $('.aixlarity-chat-history', {
            style: 'flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px; display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family);'
        }));

        // Event delegation for image click-to-zoom
        this.chatContainer.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target && target.tagName === 'IMG') {
                target.classList.toggle('expanded');
                e.stopPropagation();
            }
        });

        // Fleet Manager Area (New)
        this.fleetContainer = append(this.aixlarityWrapper, $('.aixlarity-fleet-manager', {
            style: 'flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; display: none; flex-direction: column; color: var(--vscode-foreground);'
        }));
        append(this.fleetContainer, $('div', { style: 'opacity: 0.7; font-size: 13px; text-align: center; margin-top: 20px;' })).textContent = 'Agent Fleet is active. Monitoring background autonomous sessions...';

        // Settings Dashboard Area (New)
        this.settingsContainer = append(this.aixlarityWrapper, $('.aixlarity-settings-dashboard', {
            style: 'flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; display: none; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family);'
        }));

        // History Manager Area (New)
        this.historyContainer = append(this.aixlarityWrapper, $('.aixlarity-history-manager', {
            style: 'flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: none; flex-direction: column; color: var(--vscode-foreground);'
        }));

        // Welcome message (styled as info, not error)
        const welcomeEl = append(this.chatContainer, $('div.aixlarity-welcome'));
        welcomeEl.textContent = 'New conversation started.';

		// Bottom status bar (changed files + artifacts)
        this.bottomStatusBar = append(this.aixlarityWrapper, $('div.aixlarity-bottom-status'));
        this.restoreAgentWorkspaceState();
        this.updateBottomStatus();

		// Input area (Antigravity Replica)
		this.inputWrapper = append(this.aixlarityWrapper, $('.aixlarity-input-wrapper', {
            style: 'padding: 12px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border, transparent); flex-shrink: 0;'
        }));

        // Manager tab switching is handled by the Manager pill in the conv bar

		const inputBox = append(this.inputWrapper, $('.aixlarity-input-box', {
            style: 'background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 12px; overflow: visible; display: flex; flex-direction: column; position: relative;'
        }));
        this.inputBoxRef = inputBox;

		this.inputElement = append(inputBox, $<HTMLTextAreaElement>('textarea.aixlarity-input', {
            placeholder: 'Ask anything, @ to mention, / for workflows',
            style: 'width: 100%; min-height: 48px; max-height: 250px; resize: none; padding: 12px 14px; box-sizing: border-box; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5;'
        }));

        this.attachmentsContainer = append(inputBox, $('.aixlarity-input-attachments', {
            style: 'display: flex; flex-wrap: wrap; gap: 8px; padding: 0 12px; margin-bottom: 8px;'
        }));


        // Toolbar inside Input Box
        const toolbar = append(inputBox, $('.aixlarity-input-toolbar', {
            style: 'display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border-top: 1px solid transparent; color: var(--vscode-icon-foreground, #888); flex-wrap: wrap; gap: 6px;'
        }));

        const toolbarLeft = append(toolbar, $('.toolbar-left', {
            style: 'display: flex; gap: 8px; font-size: 11px; align-items: center; flex-wrap: wrap;'
        }));

        const toolbarRight = append(toolbar, $('.toolbar-right', {
            style: 'display: flex; gap: 8px; align-items: center; font-size: 11px; flex-wrap: wrap;'
        }));

        const addContext = append(toolbarLeft, $('span.toolbar-btn', { style: 'cursor: pointer;' }));
        append(addContext, $('span.codicon.codicon-add'));
        addContext.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.onchange = (e: Event) => {
                const files = (e.target as HTMLInputElement).files;
                if (files) {
                    for (let i = 0; i < files.length; i++) {
                        this.addAttachment(files[i]);
                    }
                }
            };
            input.click();
        });

        this.inputElement.addEventListener('paste', (e: ClipboardEvent) => {
            if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
                // Let the browser still paste text if it's text, but catch files
                for (let i = 0; i < e.clipboardData.files.length; i++) {
                    const file = e.clipboardData.files[i];
                    if (file.type.startsWith('image/') || file.type.startsWith('text/')) {
                        this.addAttachment(file);
                    }
                }
            }
        });

        // Note: we create planningMode but append it to toolbarRight LATER, via order or just by rearranging.
        // Let's use `order` to ensure the correct layout without heavily moving code around.
        // modelSelect (order: 1), planningMode (order: 2), sendBtn (order: 3)
        const planningMode = append(toolbarRight, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; align-items: center; gap: 4px; position: relative; order: 2;' }));
        const pmChevron = append(planningMode, $('span.codicon.codicon-chevron-up'));
        const pmText = append(planningMode, $('span'));
        pmText.textContent = ' Fast';
        pmChevron.className = 'codicon codicon-zap';

	        const planningDropdown = $('div.aixlarity-provider-dropdown');
	        this.appendFloatingElement(planningDropdown);
        planningDropdown.style.padding = '8px';

        const cmHeader = append(planningDropdown, $('div', { style: 'font-weight: 600; font-size: 11px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); padding: 0 8px;' }));
        cmHeader.textContent = 'Conversation mode';

        const createModeItem = (title: string, desc: string, isPlanning: boolean, icon: string) => {
            const item = append(planningDropdown, $('div.aixlarity-provider-item', { style: 'display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px; border-radius: 6px;' }));
            const row1 = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px; font-weight: 500;' }));
            append(row1, $(`span.codicon.codicon-${icon}`));
            append(row1, $('span')).textContent = title;
            const row2 = append(item, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); white-space: normal; line-height: 1.4;' }));
            row2.textContent = desc;

            item.addEventListener('click', () => {
                this.planningMode = isPlanning;
                Array.from(planningDropdown.children).forEach(c => c.classList.remove('selected'));
                item.classList.add('selected');
                planningDropdown.classList.remove('open');

                if (this.planningMode) {
                    planningMode.classList.add('aixlarity-planning-active');
                    pmText.textContent = ' Planning';
                    pmChevron.className = 'codicon codicon-checklist';
                } else {
                    planningMode.classList.remove('aixlarity-planning-active');
                    pmText.textContent = ' Fast';
                    pmChevron.className = 'codicon codicon-zap';
                }
            });
            return item;
        };

        createModeItem('Planning', 'Agent can plan before executing tasks. Use for deep research, complex tasks, or collaborative work', true, 'checklist');
        const fastItem = createModeItem('Fast', 'Agent will execute tasks directly. Use for simple tasks that can be completed faster', false, 'zap');

        fastItem.classList.add('selected'); // default to false

        planningMode.addEventListener('click', (e: Event) => {
            if (planningDropdown.contains(e.target as Node)) return;
            const rect = planningMode.getBoundingClientRect();
            planningDropdown.style.right = `${window.innerWidth - rect.right}px`;
            planningDropdown.style.left = 'auto';
            planningDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            planningDropdown.style.width = '260px'; // Set a fixed width to support wrapping descriptions
            planningDropdown.classList.toggle('open');
            providerDropdown.classList.remove('open');
            personaDropdown.classList.remove('open');
        });

        const modelSelect = append(toolbarRight, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; align-items: center; gap: 4px; position: relative; order: 1; max-width: 140px;' }));
        append(modelSelect, $('span.codicon.codicon-sparkle'));
        const msText = append(modelSelect, $('span', { style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
        msText.textContent = ' Loading...';
        this.msTextRef = msText;

        const personaSelect = append(toolbarLeft, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; align-items: center; gap: 4px; position: relative;', title: `Persona: ${this.currentPersona}` }));
        append(personaSelect, $('span.codicon.codicon-account'));
        const personaLabelEl = append(personaSelect, $('span', { style: 'font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px;' }));
        personaLabelEl.textContent = this.currentPersona;

	        const personaDropdown = $('div.aixlarity-provider-dropdown');
	        this.appendFloatingElement(personaDropdown);
        // Personas matching .aixlarity/personas/ files. Icons provide quick visual identification.
        const personaEntries: Array<{id: string; label: string; icon: string}> = [
            { id: 'General',         label: 'General',          icon: '🤖' },
            { id: 'Architect',       label: 'Architect',        icon: '📐' },
            { id: 'Developer',       label: 'Developer',        icon: '💻' },
            { id: 'CodeReviewer',    label: 'Code Reviewer',    icon: '🔍' },
            { id: 'TestEngineer',    label: 'Test Engineer',    icon: '🧪' },
            { id: 'SecurityAuditor', label: 'Security Auditor', icon: '🛡️' },
            { id: 'DevOps',          label: 'DevOps',           icon: '🚀' },
            { id: 'TechWriter',      label: 'Tech Writer',      icon: '📝' },
            { id: 'DataEngineer',    label: 'Data Engineer',    icon: '📊' },
        ];
        for (const pe of personaEntries) {
            const item = append(personaDropdown, $('div.aixlarity-provider-item'));
            const label = append(item, $('span'));
            label.textContent = `${pe.icon}  ${pe.label}`;
            item.dataset.personaId = pe.id;
            item.addEventListener('click', () => {
                const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                if (activeConv) {
                    activeConv.selectedPersona = pe.id;
                }
                this.currentPersona = pe.id; // fallback for new convos
                if (this.rebuildPersonaDropdownRef) {
                    this.rebuildPersonaDropdownRef();
                }
                personaDropdown.classList.remove('open');
            });
            if (pe.id === this.currentPersona) item.classList.add('selected');
        }

        this.rebuildPersonaDropdownRef = () => {
            const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
            const currentP = activeConv?.selectedPersona || this.currentPersona;
            personaSelect.title = `Persona: ${currentP}`;
            const matched = personaEntries.find(pe => pe.id === currentP);
            personaLabelEl.textContent = matched ? matched.label : currentP;

            Array.from(personaDropdown.children).forEach(c => {
                if ((c as HTMLElement).dataset.personaId === currentP) {
                    c.classList.add('selected');
                } else {
                    c.classList.remove('selected');
                }
            });
        };

        personaSelect.addEventListener('click', (e: Event) => {
            if (personaDropdown.contains(e.target as Node)) return;
            const rect = personaSelect.getBoundingClientRect();
            personaDropdown.style.left = `${rect.left}px`;
            personaDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            personaDropdown.classList.toggle('open');
            providerDropdown.classList.remove('open');
            sandboxDropdown.classList.remove('open');
            permissionDropdown.classList.remove('open');
        });

        // --- Sandbox Dropdown (mirrors CLI --sandbox flag) ---
        const sandboxSelect = append(toolbarLeft, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; align-items: center; gap: 4px; position: relative;', title: 'Sandbox: write' }));
        append(sandboxSelect, $('span.codicon.codicon-shield'));

	        const sandboxDropdown = $('div.aixlarity-provider-dropdown');
	        this.appendFloatingElement(sandboxDropdown);
        sandboxDropdown.style.padding = '8px';
        const sbHeader = append(sandboxDropdown, $('div', { style: 'font-weight: 600; font-size: 11px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); padding: 0 8px;' }));
        sbHeader.textContent = 'Sandbox policy';

        const sandboxOptions = [
            { value: 'off', label: 'Off', desc: 'No sandboxing — fastest', icon: 'unlock' },
            { value: 'read-only', label: 'Read Only', desc: 'Workspace inspection only', icon: 'eye' },
            { value: 'workspace-write', label: 'Workspace Write', desc: 'Write within workspace', icon: 'edit' },
            { value: 'container', label: 'Container', desc: 'Docker/Podman isolation', icon: 'package' },
        ];
        for (const opt of sandboxOptions) {
            const item = append(sandboxDropdown, $('div.aixlarity-provider-item', { style: 'display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px; border-radius: 6px;' }));
            const row1 = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px; font-weight: 500;' }));
            append(row1, $(`span.codicon.codicon-${opt.icon}`));
            append(row1, $('span')).textContent = opt.label;
            append(item, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground);' })).textContent = opt.desc;
            if (opt.value === this.currentSandbox) item.classList.add('selected');
            item.addEventListener('click', () => {
                this.currentSandbox = opt.value;
                const shortLabels: Record<string, string> = { 'off': 'off', 'read-only': 'ro', 'workspace-write': 'write', 'container': 'docker' };
                sandboxSelect.title = `Sandbox: ${shortLabels[opt.value] || opt.value}`;
                Array.from(sandboxDropdown.querySelectorAll('.aixlarity-provider-item')).forEach(c => c.classList.remove('selected'));
                item.classList.add('selected');
                sandboxDropdown.classList.remove('open');
            });
        }

        sandboxSelect.addEventListener('click', (e: Event) => {
            if (sandboxDropdown.contains(e.target as Node)) return;
            const rect = sandboxSelect.getBoundingClientRect();
            sandboxDropdown.style.right = `${window.innerWidth - rect.right}px`;
            sandboxDropdown.style.left = 'auto';
            sandboxDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            sandboxDropdown.style.width = '220px';
            sandboxDropdown.classList.toggle('open');
            providerDropdown.classList.remove('open');
            personaDropdown.classList.remove('open');
            planningDropdown.classList.remove('open');
            permissionDropdown.classList.remove('open');
        });

        // --- Permission Dropdown (mirrors CLI --permission flag) ---
        const permissionSelect = append(toolbarLeft, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; align-items: center; gap: 4px; position: relative;', title: 'Permission: suggest' }));
        append(permissionSelect, $('span.codicon.codicon-lock'));

	        const permissionDropdown = $('div.aixlarity-provider-dropdown');
	        this.appendFloatingElement(permissionDropdown);
        permissionDropdown.style.padding = '8px';
        const pmHeader2 = append(permissionDropdown, $('div', { style: 'font-weight: 600; font-size: 11px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); padding: 0 8px;' }));
        pmHeader2.textContent = 'Permission level';

        const permissionOptions = [
            { value: 'suggest', label: 'Suggest', desc: 'All writes require approval', icon: 'question' },
            { value: 'auto-edit', label: 'Auto Edit', desc: 'File edits auto-approved, shell needs approval', icon: 'edit' },
            { value: 'full-auto', label: 'Full Auto', desc: '⚠️ All operations auto-approved', icon: 'rocket' },
        ];
        for (const opt of permissionOptions) {
            const item = append(permissionDropdown, $('div.aixlarity-provider-item', { style: 'display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px; border-radius: 6px;' }));
            const row1 = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px; font-weight: 500;' }));
            append(row1, $(`span.codicon.codicon-${opt.icon}`));
            append(row1, $('span')).textContent = opt.label;
            append(item, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground);' })).textContent = opt.desc;
            if (opt.value === this.currentPermission) item.classList.add('selected');
            item.addEventListener('click', () => {
                this.currentPermission = opt.value;
                permissionSelect.title = `Permission: ${opt.value}`;
                Array.from(permissionDropdown.querySelectorAll('.aixlarity-provider-item')).forEach(c => c.classList.remove('selected'));
                item.classList.add('selected');
                permissionDropdown.classList.remove('open');
            });
        }

        permissionSelect.addEventListener('click', (e: Event) => {
            if (permissionDropdown.contains(e.target as Node)) return;
            const rect = permissionSelect.getBoundingClientRect();
            permissionDropdown.style.right = `${window.innerWidth - rect.right}px`;
            permissionDropdown.style.left = 'auto';
            permissionDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            permissionDropdown.style.width = '240px';
            permissionDropdown.classList.toggle('open');
            providerDropdown.classList.remove('open');
            personaDropdown.classList.remove('open');
            planningDropdown.classList.remove('open');
            sandboxDropdown.classList.remove('open');
        });

        // Custom dropdown menu — must be appended to document.body
        // to avoid being clipped by the overflow:hidden on aixlarityWrapper.
	        const providerDropdown = $('div.aixlarity-provider-dropdown');
	        this.appendFloatingElement(providerDropdown);
        let providerListCache: any[] = [];
        let currentProviderId: string = '';

        const rebuildDropdown = () => {
            providerDropdown.textContent = '';

            const renderProviderRow = (p: any, isCustom: boolean) => {
                const item = append(providerDropdown, $('div.aixlarity-provider-item'));
                item.style.display = 'flex';
                item.style.alignItems = 'center';

                const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                let isSelected = false;
                if (activeConv && activeConv.selectedProviderId) {
                    isSelected = p.id === activeConv.selectedProviderId;
                } else {
                    isSelected = p.id === currentProviderId;
                }
                if (isSelected) item.classList.add('selected');

                const label = append(item, $('span'));
                label.textContent = `${p.label || p.id} · ${providerActiveLabelComponent(p, this.activeWorkspaceProviderId, this.activeGlobalProviderId, this.currentProviderId)}`;
                label.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

                const actions = append(item, $('div', { style: 'display: flex; gap: 4px; align-items: center;' }));

                if (p.api_key_env) {
                    const keyBtn = append(actions, $('span.codicon.codicon-key', { style: 'font-size: 14px; cursor: pointer; color: var(--vscode-icon-foreground); padding: 2px; border-radius: 4px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px;' }));
                    keyBtn.title = `Setup API Key (${p.api_key_env})`;
                    keyBtn.addEventListener('mouseenter', () => { keyBtn.style.background = 'var(--vscode-toolbar-hoverBackground)'; });
                    keyBtn.addEventListener('mouseleave', () => { keyBtn.style.background = 'transparent'; });
                    keyBtn.addEventListener('click', (e: Event) => {
                        e.stopPropagation();
                        providerDropdown.classList.remove('open');
                        this.showProviderKeyDialog(p);
                    });
                }

                if (isCustom) {
                    const removeBtn = append(actions, $('span.codicon.codicon-trash', { style: 'font-size: 14px; cursor: pointer; color: var(--vscode-icon-foreground); padding: 2px; border-radius: 4px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px;' }));
                    removeBtn.title = `Remove ${p.label}`;
                    removeBtn.addEventListener('mouseenter', () => {
                        removeBtn.style.background = 'var(--vscode-toolbar-hoverBackground)';
                        removeBtn.style.color = 'var(--vscode-errorForeground)';
                    });
                    removeBtn.addEventListener('mouseleave', () => {
                        removeBtn.style.background = 'transparent';
                        removeBtn.style.color = 'var(--vscode-icon-foreground)';
                    });
                    removeBtn.addEventListener('click', async (e: Event) => {
                        e.stopPropagation();
                        providerDropdown.classList.remove('open');
                        try {
                            await this.sendRpcToDaemonAsync('providers/remove', { id: p.id, scope: this.providerMutationScope(p) });
                            const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                            if (activeConv && activeConv.selectedProviderId === p.id) {
                                activeConv.selectedProviderId = '';
                                activeConv.selectedProviderLabel = '';
                            }
                            this.appendMessage('system', `Provider ${p.label} removed.`);
                            this.sendRpcToDaemon('providers/list', {});
                        } catch (err: any) {
                            this.appendMessage('system', `Failed to remove provider: ${this.rpcErrorMessage(err)}`);
                        }
                    });
                }

                item.addEventListener('click', () => {
                    const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                    if (activeConv) {
                        activeConv.selectedProviderId = p.id;
                        activeConv.selectedProviderLabel = p.label;
                        msText.textContent = p.label;
                        rebuildDropdown();
                    } else if (ipcRenderer) {
                        this.sendRpcToDaemon('providers/use', { id: p.id, scope: this.providerSwitchScope });
                    }
                    providerDropdown.classList.remove('open');
                });
            };

            const apiProviders = providerListCache.filter((p: any) => p.family !== 'external-cli');
            const cliProviders = providerListCache.filter((p: any) => p.family === 'external-cli');

            for (const p of apiProviders) {
                renderProviderRow(p, this.providerIsCustom(p));
            }

            if (apiProviders.length > 0 && cliProviders.length > 0) {
                append(providerDropdown, $('div.aixlarity-provider-separator'));
            }

            for (const p of cliProviders) {
                renderProviderRow(p, this.providerIsCustom(p));
            }

            // separator before add custom
            append(providerDropdown, $('div.aixlarity-provider-separator'));
            const addItem = append(providerDropdown, $('div.aixlarity-provider-item'));
            addItem.style.color = 'var(--vscode-textLink-foreground)';
            addItem.style.display = 'flex';
            addItem.style.alignItems = 'center';
            const addLabel = append(addItem, $('span'));
            addLabel.textContent = 'Add Custom API...';
            addLabel.style.cssText = 'flex: 1; text-align: center;';
            addItem.addEventListener('click', () => {
                providerDropdown.classList.remove('open');
                this.showAddCustomProviderDialog(null, msText);
            });
        };
        this.rebuildDropdownRef = rebuildDropdown;

        // Toggle dropdown on click — position it above the button using fixed coords
        modelSelect.addEventListener('click', (e: Event) => {
            if (providerDropdown.contains(e.target as Node)) return;
            const rect = modelSelect.getBoundingClientRect();
            providerDropdown.style.right = `${window.innerWidth - rect.right}px`;
            providerDropdown.style.left = 'auto';
            providerDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            providerDropdown.classList.toggle('open');
            sandboxDropdown.classList.remove('open');
            permissionDropdown.classList.remove('open');
            planningDropdown.classList.remove('open');
            personaDropdown.classList.remove('open');
        });

        // Close all dropdowns when clicking elsewhere
	        this._register(addDisposableListener(document, 'click', (e: Event) => {
	            if (!modelSelect.contains(e.target as Node) && !providerDropdown.contains(e.target as Node)) {
	                providerDropdown.classList.remove('open');
	            }
            if (!personaSelect.contains(e.target as Node) && !personaDropdown.contains(e.target as Node)) {
                personaDropdown.classList.remove('open');
            }
            if (!planningMode.contains(e.target as Node) && !planningDropdown.contains(e.target as Node)) {
                planningDropdown.classList.remove('open');
            }
            if (!sandboxSelect.contains(e.target as Node) && !sandboxDropdown.contains(e.target as Node)) {
                sandboxDropdown.classList.remove('open');
            }
	            if (!permissionSelect.contains(e.target as Node) && !permissionDropdown.contains(e.target as Node)) {
	                permissionDropdown.classList.remove('open');
	            }
	        }));

        const sendBtn = append(toolbarRight, $('span.toolbar-btn', { style: 'cursor: pointer; display: flex; justify-content: center; align-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--vscode-textLink-foreground, #007acc); transition: background 0.2s; order: 3;' }));
        const sendIcon = append(sendBtn, $('span.codicon.codicon-arrow-up', { style: 'color: #ffffff !important;' }));

        this.sendBtnRef = sendBtn;
        this.sendIconRef = sendIcon;

        sendBtn.addEventListener('click', () => {
            if (!this.daemonConnected) return;

            if (this.isGenerating) {
                this.stopActiveRequest();
                return;
            }

            const text = this.inputElement.value.trim();
            if (text) {
                this.appendMessage('user', text);
                this.inputElement.value = '';
                (this as any)._streamFinalized = false; // Allow new stream
                if (this.sendToDaemon(text)) {
                    this.updateSendButtonState(true);
                }
            } else if (this.devMode) {
                this.appendMessage('system', '[DEV LOG] Send button clicked, but input is empty.');
            }
        });

        // Trigger send on enter (if not shift+enter)
        this.inputElement.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!this.daemonConnected) return;
            if (e.isComposing) return; // Prevent IME confirm from accidentally sending the message
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!this.isGenerating) {
                    sendBtn.click();
                }
            }
        });

        // Auto-resize textarea
        this.inputElement.addEventListener('input', () => {
            this.inputElement.style.height = 'auto';
            this.inputElement.style.height = Math.min(this.inputElement.scrollHeight, 250) + 'px';
            this.maybeShowInputAssist();
        });

        // (Old duplicate keydown listener removed)

        // Listen for JSON-RPC messages from the daemon
        try {
            if (ipcRenderer && ipcRenderer.on) {
                if (!this.daemonOutListener) {
                    this.daemonOutListener = (_event: any, data: any) => {
                    if (this.devMode && typeof data === 'string' && data.length > 1024) {
                        console.warn('[Aixlarity IPC] daemonOut received, type: string len:', data.length);
                    }
                    if (this.devMode) {
                        this.appendMessage('system', `[DEBUG RAW IN] ${typeof data === 'string' ? data : JSON.stringify(data)}`);
                    }
                    if (typeof data === 'string') {
                        try {
                            this.daemonIncompleteLine += data;
                            const lines = this.daemonIncompleteLine.split('\n');
                            this.daemonIncompleteLine = lines.pop() || '';

                            for (const line of lines) {
                                if (!line.trim()) continue;
                                if (line.trim().startsWith('[Aixlarity DEBUG]')) {
                                    if (this.devMode) this.appendMessage('system', line);
                                    continue;
                                }

                                let payload: any;
                                try {
                                    payload = JSON.parse(line);
                                } catch (e) {
                                    if (this.devMode) {
                                        console.warn('[Aixlarity DIAG] Failed to parse JSON line (len=' + line.length + '):', line.substring(0, 200));
                                    }
                                    continue;
                                }

                                if (payload.id && this.pendingRequests.has(payload.id)) {
                                    const pendingRpcId = String(payload.id);
                                    const p = this.pendingRequests.get(payload.id)!;
                                    this.pendingRequests.delete(payload.id);
                                    this.rpcMethodById.delete(pendingRpcId);
                                    if (p.timer) {
                                        clearTimeout(p.timer);
                                    }
                                    if (payload.error) {
                                        p.reject(new Error(payload.error.message || payload.error));
                                    } else if (payload.result?.status === 'error') {
                                        p.reject(new Error(payload.result.error || payload.result.message || 'RPC returned an error status'));
                                    } else {
                                        p.resolve(payload.result);
                                    }
                                    continue;
                                }

                                if (this.shouldIgnoreStoppedPayload(payload)) {
                                    continue;
                                }

                                if (payload.method === 'daemon_status') {
                                    this.handleDaemonStatus(payload.params || {});
                                } else if (payload.error) {
                                    const errorRpcId = payload.id ? String(payload.id) : null;
                                    const errorMethod = errorRpcId ? this.rpcMethodById.get(errorRpcId) : undefined;
                                    const errorOwnerConvId = errorRpcId ? this.rpcToConversation.get(errorRpcId) : undefined;
                                    const isBackgroundError = !!errorOwnerConvId && errorOwnerConvId !== this.activeConversationId;
                                    const isAgentError = !errorMethod || errorMethod === 'agent_chat' || !!errorOwnerConvId;
                                    if (errorRpcId) {
                                        if (this.activeRpcId === errorRpcId) {
                                            this.activeRpcId = null;
                                        }
                                        this.rpcMethodById.delete(errorRpcId);
                                        this.historyListCwdByRpcId.delete(errorRpcId);
                                    }
                                    const errMsg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
                                    this.markRpcFailed(errorRpcId, errMsg);
                                    this.withConversationContext(payload.id, () => {
                                        if (isAgentError) {
                                            if (isBackgroundError) {
                                                this.isGenerating = false;
                                            } else {
                                                this.updateSendButtonState(false);
                                            }
                                            this.removeLoadingIndicator();
                                        }
                                        if (!this.showRpcError(errorMethod, errMsg) && isAgentError) {
                                            this.appendMessage('system', `❌ Agent Execution Error:\n${errMsg}`);
                                        }
                                    });
                                    if (errorRpcId) {
                                        this.rpcToConversation.delete(errorRpcId);
                                    }
                                } else if (payload.method === 'agent_chat_stream') {
                                    // Parallel-safe: route stream chunk to owning conversation
                                    this.withConversationContext(payload.id, () => {
                                        this.handleStream('agent', payload.params.chunk);
                                    });
                                } else if (payload.method === 'agent_action') {
                                    // Parallel-safe: route action event to owning conversation
                                    this.withConversationContext(payload.id, () => {
                                        this.ingestAgentEvent(payload.id, payload.params?.event);
                                        if (this.devMode) {
                                            console.warn('[Aixlarity IPC] agent_action event:', payload.params?.event?.event, 'tool:', payload.params?.event?.tool_name, 'call_id:', payload.params?.event?.call_id);
                                        }
                                        if (payload.params.event && payload.params.event.event === 'tool_call_requested') {
                                            if (this.devMode) {
                                                console.warn('[Aixlarity IPC] → appendToolAction for', payload.params.event.tool_name);
                                            }
                                            this.appendToolAction(payload.params.event.tool_name, payload.params.event.arguments, payload.params.event.call_id);
                                        } else if (payload.params.event && payload.params.event.event === 'tool_call_completed') {
                                            if (this.devMode) {
                                                console.warn('[Aixlarity IPC] → completeToolAction, pending has call_id:', this.pendingToolActions.has(payload.params.event.call_id), 'attachments:', payload.params.event.attachments?.length);
                                            }
                                            if (payload.params.event.call_id && this.pendingToolActions.has(payload.params.event.call_id)) {
                                                this.completeToolAction(payload.params.event.call_id, payload.params.event.result, payload.params.event.attachments);
                                            }
                                            // Track changed files for bottom status bar
                                            const tn = payload.params.event.tool_name;
                                            if (tn === 'write_file' || tn === 'edit_file' || tn === 'create_file') {
                                                const args = payload.params.event.arguments || payload.params.event.result;
                                                const filePath = args?.path || args?.file_path || '';
	                                                if (filePath) {
	                                                    const basename = filePath.split('/').pop() || filePath;
	                                                    this.changedFiles.add(basename);
	                                                    while (this.changedFiles.size > 100) {
	                                                        const oldest = this.changedFiles.values().next().value;
	                                                        if (!oldest) {
	                                                            break;
	                                                        }
	                                                        this.changedFiles.delete(oldest);
	                                                    }
	                                                    this.updateBottomStatus();
	                                                }
	                                            }
	                                        } else if (payload.params.event && payload.params.event.event === 'artifact_updated') {
	                                            this.syncSessionArtifactsFromManager();
	                                            this.updateBottomStatus();
                                        } else if (payload.params.event && payload.params.event.event === 'provider_fallback') {
                                            this.appendMessage('system', `⚠️ Provider Fallback: The selected provider (${payload.params.event.from_provider}) failed. Falling back to ${payload.params.event.to_provider}.\nReason: ${payload.params.event.reason || 'Unknown error'}`);
                                        }
                                    });
                                    // turn_started is intentionally not displayed to keep the UI clean
                                } else if (payload.method === 'approval_request') {
                                    // Deep-bind: route approval to the correct conversation
                                    const approvalTask = this.getOrCreateTaskForRpc(String(payload.id || 'unknown'), { event: 'approval_request' });
                                    approvalTask.progressLabel = `Waiting for approval: ${payload.params.tool_name || 'tool'}.`;
                                    this.addTaskTimeline(approvalTask, 'approval_request', 'Approval required', payload.params.tool_name || '', 'waiting_review');
                                    this.refreshAgentManagerIfVisible();
                                    this.ensureConversationActive(payload.id);
                                    this.appendApprovalCard(
                                        payload.params.call_id,
                                        payload.params.tool_name,
                                        payload.params.arguments,
                                        String(payload.id || '')
                                    );
                                } else if (payload.result) {
                                    if (this.devMode) {
                                        console.warn('[Aixlarity DIAG] Got payload.result, keys:', Object.keys(payload.result).join(','), 'id:', payload.id);
                                    }
                                    const resultRpcId = payload.id ? String(payload.id) : null;
                                    const resultMethod = resultRpcId ? this.rpcMethodById.get(resultRpcId) : undefined;
                                    // Skip the 'accepted' ACK from non-blocking agent_chat
                                    if (payload.result.status === 'accepted') {
                                        if (this.devMode) {
                                            console.warn('[Aixlarity DIAG] Skipping accepted ACK');
                                        }
                                        continue;
                                    }
                                    if (payload.result.status === 'error') {
                                        const errMsg = payload.result.error || payload.result.message || 'RPC returned an error status';
                                        if (resultRpcId) {
                                            this.rpcMethodById.delete(resultRpcId);
                                            this.historyListCwdByRpcId.delete(resultRpcId);
                                        }
                                        this.markRpcFailed(resultRpcId, errMsg);
                                        if (!this.showRpcError(resultMethod, errMsg)) {
                                            this.appendMessage('system', `Request failed: ${errMsg}`);
                                        }
                                        continue;
                                    }
                                    if (resultRpcId && resultMethod !== 'agent_chat') {
                                        this.rpcMethodById.delete(resultRpcId);
                                    }
                                    // Only finalize the stream if this is the final agent execution result
                                    // (not another RPC returning like sessions/transactions/add)
                                    if (payload.result.final_response !== undefined || payload.result.events !== undefined) {
                                        // Parallel-safe: route final result to owning conversation
                                        this._swapToConversationForFinal(payload.id);
                                        const finalRpcId = payload.id ? String(payload.id) : null;
                                        this.ingestResultEvents(finalRpcId, payload.result.events);
                                        if (finalRpcId && payload.result.final_response !== undefined) {
                                            const task = this.getOrCreateTaskForRpc(finalRpcId, { event: 'run_completed' });
                                            if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'stopped') {
                                                task.progressLabel = 'Final response received.';
                                                this.addTaskTimeline(task, 'final_response', 'Final response received', '', 'completed');
                                                this.upsertAgentArtifact({
                                                    id: this.stableId(task.id, 'walkthrough', 'final-response'),
                                                    taskId: task.id,
                                                    name: 'Walkthrough',
                                                    kind: 'walkthrough',
                                                    status: 'draft',
                                                    summary: 'Final response captured from agent.',
                                                    body: String(payload.result.final_response || ''),
                                                });
                                            }
                                        }
                                        if (this.devMode) {
                                            console.warn('[Aixlarity DIAG] Finalizing stream. final_response type:', typeof payload.result.final_response, ', events count:', Array.isArray(payload.result.events) ? payload.result.events.length : 'N/A');
                                        }
                                        // Mark stream as finalized FIRST to prevent any
                                        // late-arriving agent_chat_stream chunks from
                                        // creating a duplicate message box.
                                        (this as any)._streamFinalized = true;
                                        if (finalRpcId && this.activeRpcId === finalRpcId) {
                                            this.activeRpcId = null;
                                        }

                                        // ⚠️ Reset the send button state IMMEDIATELY before
                                        // any code that might throw (SCM input, beam removal).
                                        // If processing a background conversation's final result,
                                        // only update the per-conversation flag — don't touch the
                                        // visible send button (it belongs to the active tab).
                                        if (this._pendingFinalSavedContainer) {
                                            this.isGenerating = false;
                                        } else {
                                            this.updateSendButtonState(false);
                                        }
                                        this.removeLoadingIndicator();

                                        // Fill SCM input if pending
                                        if (this.pendingScmInput) {
                                            const commitMsg = payload.result.final_response || this.activeStreamText;
                                            if (typeof commitMsg === 'string') {
                                                const cleaned = commitMsg.replace(/```[a-z]*\n/g, '').replace(/```/g, '').trim();
                                                try {
                                                    if (typeof this.pendingScmInput.setValue === 'function') {
                                                        this.pendingScmInput.setValue(cleaned, false);
                                                    } else {
                                                        this.pendingScmInput.value = cleaned;
                                                    }
                                                    if (this.devMode) {
                                                        console.warn('[Aixlarity DIAG] SCM input filled:', cleaned.substring(0, 80));
                                                    }
                                                } catch (e) {
                                                    console.error('[Aixlarity] Failed to set SCM input value:', e);
                                                }
                                            }
                                            this.pendingScmInput = null;
                                        }

                                        // Remove beam from the user's message box
	                                        if ((this as any).lastUserMessageNode) {
	                                            ((this as any).lastUserMessageNode as HTMLElement).classList.remove('aixlarity-generating-beam');
	                                        }
	                                        this.flushPendingStreamRender(true);
	                                        // Close current stream
	                                        if (this.activeStreamRole) {
                                            if (this.activeStreamNode && this.activeStreamNode.parentElement) {
                                                this.activeStreamNode.parentElement.style.position = '';
                                            }
                                            this.activeStreamRole = null;
                                            this.activeStreamNode = null;
                                            this.activeStreamText = "";
                                        }
                                    } else if (this.devMode) {
                                        console.warn('[Aixlarity DIAG] payload.result has no final_response/events, skipping finalization');
                                    }

                                    // See if we got a persisted_session ID back
                                    if (payload.result && payload.result.persisted_session && payload.result.persisted_session.id) {
                                        const conv = this.conversations.find(c => c.id === this.activeConversationId);
                                        if (conv) {
                                            conv.backendSessionId = payload.result.persisted_session.id;
                                        }
                                        const persistedRpcId = payload.id ? String(payload.id) : null;
                                        const persistedTaskId = persistedRpcId ? this.rpcToAgentTask.get(persistedRpcId) : undefined;
                                        const persistedTask = persistedTaskId ? this.agentTasks.get(persistedTaskId) : undefined;
                                        if (persistedTask) {
                                            persistedTask.backendSessionId = payload.result.persisted_session.id;
                                            this.refreshAgentManagerIfVisible();
                                        }
                                    }

                                    // Parallel-safe: if we swapped to a background conversation
                                    // for final-result processing, swap back to the user's tab now.
                                    if (this._pendingFinalOriginalConvId && this._pendingFinalSavedContainer) {
                                        // Save target's updated stream state
                                        const finalTargetConv = this.conversations.find(c => c.id !== this._pendingFinalOriginalConvId && (c as any)._offscreenEl === this.chatContainer) as any;
                                        if (finalTargetConv) {
                                            finalTargetConv._streamState = this.captureStreamState();
                                        }
                                        // Restore original container + stream state
                                        this.chatContainer = this._pendingFinalSavedContainer;
                                        this.restoreStreamState(this._pendingFinalSavedStream);
                                        this._pendingFinalOriginalConvId = null;

                                        this._pendingFinalSavedContainer = null;
                                        this._pendingFinalSavedStream = null;
                                    }

                                    // If this is a providers list response
                                    if (payload.result.providers) {
                                        this.daemonConnected = true;
                                        this.inputElement.disabled = false;
                                        this.inputElement.placeholder = 'Ask anything, @ to mention, / for workflows';
                                        this.flushHistoryTrackQueue();

                                        providerListCache = payload.result.providers;
                                        const current = payload.result.current;
                                        currentProviderId = current ? current.id : '';
                                        this.providerListCache = providerListCache;
                                        this.currentProviderId = currentProviderId;
                                        this.activeGlobalProviderId = payload.result.active_global || '';
                                        this.activeWorkspaceProviderId = payload.result.active_workspace || '';

                                        // Only update msText if the active conversation has no per-conversation override
                                        const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                                        if (activeConv && activeConv.selectedProviderId) {
                                            const match = providerListCache.find((pp: any) => pp.id === activeConv.selectedProviderId);
                                            if (match) {
                                                activeConv.selectedProviderLabel = match.label;
                                                msText.textContent = match.label;
                                            } else if (current) {
                                                activeConv.selectedProviderId = current.id;
                                                activeConv.selectedProviderLabel = current.label;
                                                msText.textContent = current.label;
                                            } else {
                                                activeConv.selectedProviderId = '';
                                                activeConv.selectedProviderLabel = '';
                                                msText.textContent = 'No Provider';
                                            }
                                        } else if (current) {
                                            msText.textContent = current.label;
                                            // Also set the label for the active conversation if it had no override
                                            if (activeConv && !activeConv.selectedProviderId) {
                                                activeConv.selectedProviderId = current.id;
                                                activeConv.selectedProviderLabel = current.label;
                                            }
                                        }
                                        rebuildDropdown();
                                    } else if (payload.result.provider && typeof payload.result.provider.label === 'string') {
                                        // It was a providers/use or providers/add result
                                        const providerResultId = payload.result.provider.id || '';
                                        if (resultMethod === 'providers/use') {
                                            currentProviderId = providerResultId;
                                            this.currentProviderId = currentProviderId;
                                            if (payload.result.scope === 'workspace') {
                                                this.activeWorkspaceProviderId = currentProviderId;
                                            } else if (payload.result.scope === 'global') {
                                                this.activeGlobalProviderId = currentProviderId;
                                            }
                                        }

                                        // Only update msText if the active conversation has no per-conversation override
                                        const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
                                        if (activeConv && activeConv.selectedProviderId) {
                                            const match = providerListCache.find((pp: any) => pp.id === activeConv.selectedProviderId);
                                            const resolvedLabel = match ? match.label : activeConv.selectedProviderId;
                                            activeConv.selectedProviderLabel = resolvedLabel;
                                            msText.textContent = resolvedLabel;
                                        } else if (resultMethod === 'providers/use') {
                                            msText.textContent = payload.result.provider.label;
                                        }

                                        // Refresh the full list so newly added models appear
                                        rebuildDropdown();
                                        if (ipcRenderer) {
                                                this.sendRpcToDaemon('providers/list', {});
                                        }
                                    } else if (payload.result.sessions) {
                                        if (this.devMode) {
                                            console.warn('[Aixlarity DIAG] Fleet sessions response received, count:', payload.result.sessions.length, ', fleetContainer visible:', this.fleetContainer.style.display);
                                        }
                                        this.managerSessions = payload.result.sessions || [];
                                        this.managerLoading = false;
                                        this.renderAgentManager();
                                    } else if (payload.result.schema === 'aixlarity.artifact_index.v1') {
                                        this.mergeDurableArtifactIndex(payload.result);
                                        this.managerLoading = false;
                                        this.renderAgentManager();
                                    } else if (payload.result.schema === 'aixlarity.audit_log.v1') {
                                        this.managerAuditEvents = Array.isArray(payload.result.events) ? payload.result.events : [];
                                        this.managerLoading = false;
                                        this.renderAgentManager();
                                    } else if (payload.result.schema === 'aixlarity.workspace_index.v1') {
                                        this.managerWorkspaceIndex = Array.isArray(payload.result.workspaces) ? payload.result.workspaces : [];
                                        this.managerLoading = false;
                                        this.renderAgentManager();
                                    } else if (payload.result.schema === 'aixlarity.ide_studio_state.v1') {
                                        this.studioState = this.normalizeStudioState(payload.result);
                                        this.managerLoading = false;
                                        if (this.managerVisible()) {
                                            this.renderAgentManager();
                                        }
                                        if (this.isSettingsVisible()) {
                                            this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, this.msTextRef || this.settingsContainer);
                                        }
                                    } else if (payload.result.latest_task !== undefined) {
                                        // Individual Session Show Modal
                                        const s = payload.result;
                                        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
                                            style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center;'
                                        }));
                                        const modal = append(overlay, $('.aixlarity-settings-card', {
                                            style: 'width: 85%; max-width: 500px; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 4px 16px rgba(0,0,0,0.3);'
                                        }));

                                        append(modal, $('h3', { style: 'margin: 0; font-size: 16px; color: #fff;' })).textContent = `Session Inspector`;

                                        const r1 = append(modal, $('div.aixlarity-settings-row'));
                                        append(r1, $('span.aixlarity-settings-label')).textContent = 'ID:';
                                        append(r1, $('span.aixlarity-settings-value')).textContent = s.id;

                                        const r2 = append(modal, $('div.aixlarity-settings-row'));
                                        append(r2, $('span.aixlarity-settings-label')).textContent = 'Turns:';
                                        append(r2, $('span.aixlarity-settings-value')).textContent = `${s.turn_count}`;

                                        const r4 = append(modal, $('div.aixlarity-settings-row'));
                                        append(r4, $('span.aixlarity-settings-label')).textContent = 'Mode:';
                                        append(r4, $('span.aixlarity-settings-value')).textContent = `${s.latest_mode}`;

                                        const box = append(modal, $('div', { style: 'background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px; font-size: 12px; max-height: 200px; overflow-y: auto; color: #ccc;' }));
                                        box.textContent = `Goal: ${s.latest_task}\n\nEvents (${s.latest_event_count}):\n` + JSON.stringify(s.latest_events || [], null, 2);

                                        const btnRow = append(modal, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }));

                                        const closeBtn = append(btnRow, $('button', { style: 'background: transparent; color: #bbb; border: 1px solid rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 4px; cursor: pointer;' }));
                                        closeBtn.textContent = 'Close';
                                        closeBtn.addEventListener('click', () => overlay.remove());

                                        const replayBtn = append(btnRow, $('button.aixlarity-action-btn', { style: 'width: auto; padding: 6px 16px; background: rgba(255, 160, 0, 0.15); border-color: rgba(255, 160, 0, 0.3); color: #fbbf24;' }));
                                        replayBtn.textContent = '⏪ Replay Events';
                                        replayBtn.addEventListener('click', () => {
                                            this.sendRpcToDaemon('sessions/replay', { id: s.id });
                                            overlay.remove();
                                            this.appendMessage('system', `Replaying structured events from session ${s.id.substring(0,8)}...`);
                                        });

                                        const forkBtn = append(btnRow, $('button.aixlarity-action-btn', { style: 'width: auto; padding: 6px 16px;' }));
                                        forkBtn.textContent = '🌿 Fork Context';
                                        forkBtn.addEventListener('click', () => {
                                            this.sendRpcToDaemon('sessions/fork', { id: s.id });
                                            overlay.remove();
                                            this.appendMessage('system', `Forking session ${s.id.substring(0,8)}...`);
                                        });

                                        const turnsBtn2 = append(btnRow, $('button.aixlarity-action-btn', { style: 'width: auto; padding: 6px 16px; background: rgba(77, 170, 252, 0.15); border-color: rgba(77, 170, 252, 0.3); color: #4daafc;' }));
                                        turnsBtn2.textContent = '📋 View Turns';
                                        turnsBtn2.addEventListener('click', () => {
                                            this.sendRpcToDaemon('sessions/turns', { id: s.id });
                                            overlay.remove();
                                        });

                                        const delBtn2 = append(btnRow, $('button.aixlarity-action-btn', { style: 'width: auto; padding: 6px 16px; background: rgba(255, 60, 60, 0.15); border-color: rgba(255, 60, 60, 0.3); color: #ffcccc;' }));
                                        delBtn2.textContent = '🗑️ Delete';
                                        delBtn2.addEventListener('click', () => {
                                            this.sendRpcToDaemon('sessions/remove', { id: s.id });
                                            overlay.remove();
                                            this.appendMessage('system', `Deleted session ${s.id.substring(0,8)}`);
                                        });
                                    } else if (payload.result.turns !== undefined && payload.result.selected_turn_count === undefined) {
                                        // Turns response — either restore into a conversation or show in Fleet modal
                                        const s = payload.result;
                                        const conv = this.conversations.find(c => c.backendSessionId === s.id);
                                        if (conv && conv.id === this.activeConversationId) {
                                            // Restore into active conversation
                                            this.chatContainer.textContent = '';
                                            const welcomeEl = append(this.chatContainer, $('div.aixlarity-welcome'));
                                            welcomeEl.textContent = 'History restored.';
                                            for (const turn of s.turns) {
                                                this.appendMessage('user', turn.input);
                                                if (turn.final_response) {
                                                    this.appendMessage('agent', turn.final_response);
                                                }
                                            }
                                            if (s.turns.length > 0) {
                                                const lastTurn = s.turns[s.turns.length - 1];
                                                if (lastTurn.provider_id) {
                                                    conv.selectedProviderId = lastTurn.provider_id;
                                                    const match = providerListCache.find((pp: any) => pp.id === lastTurn.provider_id);
                                                    conv.selectedProviderLabel = match ? match.label : lastTurn.provider_id;
                                                    if (this.msTextRef && this.rebuildDropdownRef) {
                                                        this.msTextRef.textContent = conv.selectedProviderLabel ?? null;
                                                        this.rebuildDropdownRef();
                                                    }
                                                }
                                            }
                                            conv.messages = Array.from(this.chatContainer.children) as HTMLElement[];
                                        } else {
                                            // No matching conversation — show turns in a modal (Fleet context)
                                            const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
                                                style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center;'
                                            }));
                                            const modal = append(overlay, $('.aixlarity-settings-card', {
                                                style: 'width: 90%; max-width: 550px; padding: 20px; display: flex; flex-direction: column; gap: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 4px 16px rgba(0,0,0,0.3); max-height: 80vh; overflow: hidden;'
                                            }));
                                            append(modal, $('h3', { style: 'margin: 0; font-size: 15px; color: #fff;' })).textContent = `Session Turns (${s.turns.length})`;
                                            append(modal, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' })).textContent = `Session: ${s.id}`;

                                            const turnsBody = append(modal, $('div', {
                                                style: 'flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0;'
                                            }));
                                            for (const turn of s.turns) {
                                                const tCard = append(turnsBody, $('div', {
                                                    style: 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; padding: 8px 10px;'
                                                }));
                                                const tHeader = append(tCard, $('div', { style: 'display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;' }));
                                                append(tHeader, $('span')).textContent = `Turn ${turn.index} · ${turn.mode}`;
                                                append(tHeader, $('span')).textContent = turn.provider_label || turn.provider_id || '';
                                                const tInput = append(tCard, $('div', { style: 'font-size: 12px; color: #4daafc; margin-bottom: 4px; white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis;' }));
                                                tInput.textContent = turn.input ? turn.input.substring(0, 300) : '';
                                                if (turn.final_response) {
                                                    const tResp = append(tCard, $('div', { style: 'font-size: 11px; color: var(--vscode-foreground); white-space: pre-wrap; max-height: 80px; overflow: hidden; opacity: 0.85;' }));
                                                    tResp.textContent = turn.final_response.substring(0, 500);
                                                }
                                            }

                                            const closeBtn = append(modal, $('button', { style: 'align-self: flex-end; background: transparent; color: #bbb; border: 1px solid rgba(255,255,255,0.2); padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 12px;' }));
                                            closeBtn.textContent = 'Close';
                                            closeBtn.addEventListener('click', () => overlay.remove());
                                            overlay.addEventListener('click', (e: Event) => { if (e.target === overlay) overlay.remove(); });
                                        }
                                    } else if (payload.result.deleted !== undefined) {
                                        // A session was removed
                                        // Cleanup if necessary
                                    } else if (payload.result.turns !== undefined && payload.result.selected_turn_count !== undefined) {
                                        // Replay Response
                                        this.switchConversation(this.activeConversationId);
                                        this.appendMessage('system', `Replay Finished! Emitted ${payload.result.selected_turn_count} historical turns globally.`);
                                    } else if (payload.result.new_id !== undefined) {
                                        // Fork response
                                        this.switchConversation(this.activeConversationId);
                                        this.appendMessage('system', `Successfully forked! New Session ID: ${payload.result.new_id}\nYou may now resume executing commands.`);
                                    } else if (payload.result.api_key_present !== undefined) {
                                        // Doctor response
                                        this.switchConversation(this.activeConversationId);
                                        const status = payload.result.api_key_present ? "OK" : "Missing API Key";
                                        const doc = payload.result;
                                        this.appendMessage('system', `🩺 Health Check [${doc.profile.id}]:\nAPI Key Found: ${status}\nMasked Key: ${doc.masked_api_key || 'null'}\nActive Scope: ${doc.active_scope}`);
                                    } else if (payload.result.transactions !== undefined) {
                                        const historyRpcId = payload.id ? String(payload.id) : '';
                                        const historyCwd = historyRpcId ? this.historyListCwdByRpcId.get(historyRpcId) : undefined;
                                        if (historyRpcId) {
                                            this.historyListCwdByRpcId.delete(historyRpcId);
                                        }
                                        this.historyContainer.textContent = ''; // Clear old transactions
                                        const header = append(this.historyContainer, $('div', { style: 'font-weight: 600; font-size: 14px; margin-bottom: 16px; color: #fff;' }));
                                        header.textContent = `Local History Transactions (${payload.result.transactions.length})`;

                                        if (payload.result.transactions.length === 0) {
                                            append(this.historyContainer, $('div', { style: 'opacity: 0.6; font-size: 12px; text-align: center; margin-top: 20px;' })).textContent = 'No local history transactions recorded yet.';
                                        } else {
                                            for (const tx of payload.result.transactions) {
                                                const card = append(this.historyContainer, $('div.aixlarity-fleet-card', {
                                                    style: 'cursor: pointer; display: flex; justify-content: space-between; align-items: center;'
                                                }));

                                                const infoRow = append(card, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
                                                append(infoRow, $('div', { style: 'font-weight: 600; font-size: 12px; color: #fff;' })).textContent = tx.file_path;
                                                append(infoRow, $('div', { style: 'font-size: 11px; opacity: 0.7;' })).textContent = `[${tx.id.substring(0,8)}] Mutated by ${tx.tool_name} at ${new Date(tx.timestamp_sec * 1000).toLocaleString()}`;

                                                const btnGroup = append(card, $('div'));
                                                const revBtn = append(btnGroup, $('button.aixlarity-action-btn', { style: 'width: auto; padding: 4px 12px; background: rgba(244, 63, 94, 0.15); border-color: rgba(244, 63, 94, 0.3); color: #f43f5e;' }));
                                                revBtn.textContent = 'Revert';
                                                revBtn.addEventListener('click', (e: Event) => {
                                                    e.stopPropagation();
                                                    this.revertHistoryTransaction(tx.id, historyCwd, revBtn);
                                                });

                                                card.addEventListener('click', (e: Event) => {
                                                    if (tx.before_hash) {
                                                        const basename = tx.file_path.split('/').pop() || 'historical_file';
                                                        const leftUri = this.createHistoryUri(tx.before_hash, basename, historyCwd);
                                                        const rightUri = URI.file(tx.file_path);
                                                        const title = `${basename} (Historical vs Current)`;

                                                        this.editorService.openEditor({
                                                            original: { resource: leftUri },
                                                            modified: { resource: rightUri },
                                                            label: title,
                                                            options: { preserveFocus: true, preview: true }
                                                        } as any);
                                                    } else {
                                                        this.appendMessage('system', `Transaction ${tx.id} has no valid before_hash (file was likely created).`);
                                                    }
                                                });
                                            }
                                        }
                                    } else if (payload.result.status === 'success' && payload.result.message && payload.result.message.includes('revert')) {
                                         // Revert response
                                         this.switchConversation(this.activeConversationId);
                                         this.appendMessage('system', payload.result.message);
                                    } else if (payload.result.models && payload.result.id) {
                                        // Model list fetched
                                        const event = new CustomEvent('aixlarity-models-fetched', { detail: payload.result });
                                        window.dispatchEvent(event);
                                    } else if (payload.result.app) {
                                        // Overview response — keep Settings intentionally small and task-oriented.
                                        this.lastOverview = payload.result;
                                        this.renderEssentialSettingsPanel(payload.result, providerListCache, currentProviderId, msText);
                                    } else if (payload.result.checkpoints) {
                                        this.managerCheckpoints = payload.result.checkpoints || [];
                                        this.managerLoading = false;
                                        this.renderAgentManager();
                                    } else if (payload.result.status !== undefined && payload.result.path !== undefined && payload.result.matched_rule !== undefined) {
                                        this.switchConversation(this.activeConversationId);
                                        this.appendMessage('system', `Trust Status: ${payload.result.status} (Matched: ${payload.result.matched_rule || 'none'})`);
                                    } else if (payload.result.rule !== undefined && payload.result.path !== undefined) {
                                        this.switchConversation(this.activeConversationId);
                                        this.appendMessage('system', `Trust Rule Updated: ${payload.result.rule} (${payload.result.path})`);
                                    } else if (payload.result.trust_enabled !== undefined) {
                                        // Trust Status Response
                                        const msg = `Trust Evaluated: ${payload.result.kind || 'unknown'} (Matched: ${payload.result.matched_path || 'none'})`;
                                        this.switchConversation(this.activeConversationId);
                                        this.appendMessage('system', msg);
                                    }
                                }
                            }
                        } catch (e) {
                            // If e is a SyntaxError, it was JSON.parse failing.
                            // If e is a TypeError, it was a bug in the UI processing code!
                            console.error('[Aixlarity UI] CRITICAL IPC HANDLER ERROR:', e);
                            if (this.devMode && typeof data === 'string' && !data.includes('ping')) {
                                this.appendMessage('system', `[DEV ERROR] Exception: ${e}\nRaw Data: ${data}`);
                            }
                            if (this.devMode && typeof data === 'string') {
                                console.warn('[Aixlarity UI] Original data that caused crash:', data.substring(0, 500));
                            }
                        }
                    }
                    };
                    ipcRenderer.on('vscode:aixlarity:daemonOut', this.daemonOutListener);
                    this._register({
                        dispose: () => {
                            if (this.daemonOutListener && ipcRenderer.removeListener) {
                                ipcRenderer.removeListener('vscode:aixlarity:daemonOut', this.daemonOutListener);
                            }
                            this.daemonOutListener = null;
                        }
                    });
                }
            } else {
                this.appendMessage('system', 'ERROR: ipcRenderer not found.');
                this.updateSendButtonState(false);
                return;
            }
        } catch (err) {
            this.appendMessage('system', 'ERROR attaching IPC: ' + err);
        }

        // Initial fetch of providers
        setTimeout(() => {
            // Check if daemon is actually running by verifying IPC handler exists
            if (!ipcRenderer || !ipcRenderer.send) {
                this.daemonConnected = false;
                msText.textContent = ' No IPC';
                if (this.inputElement) {
                    this.inputElement.disabled = true;
                    this.inputElement.placeholder = 'Daemon IPC failed to connect.';
                }
                if (this.devMode) {
                    this.appendMessage('system', '[DEV LOG] ipcRenderer not available. Cannot communicate with daemon.');
                }
                return;
            }

            if (this.devMode) {
                this.appendMessage('system', '[DEV LOG] Firing providers/list to daemon...');
            }

            // Tell the daemon which workspace the user has open so it operates
            // on the correct project, not the IDE's install dir.
            this.refreshDaemonWorkspaceAndProviders();

            // Add a timeout check — if daemon is not running, show fallback immediately
            setTimeout(() => {
            if (msText.textContent === ' Loading...' && !this.daemonConnected) {
                this.daemonConnected = false;
                msText.textContent = ' No Daemon';
                if (this.inputElement) {
                    this.inputElement.disabled = true;
                    this.inputElement.placeholder = 'Daemon did not respond. Check workspace setup.';
                }
                if (this.devMode) {
                    this.appendMessage('system', '[DEV WARN] Daemon did not respond to providers/list within 5s. Build the Aixlarity binary with `cargo build -p aixlarity` or add a custom provider via the toolbar.');
                }
            }
            }, 5000);
        }, 1000);
	}

    private renderGuidanceCard(container: HTMLElement, storageKey: string, title: string, steps: string[]): void {
        try {
            if (localStorage.getItem(storageKey) === 'hidden') {
                return;
            }
        } catch {
            // Non-essential guidance should never block the workbench.
        }

        const card = append(container, $('div.aixlarity-guide-card'));
        append(card, $('div.aixlarity-guide-dot'));
        const body = append(card, $('div.aixlarity-guide-body'));
        append(body, $('div.aixlarity-guide-title')).textContent = title;
        const stepRow = append(body, $('div.aixlarity-guide-steps'));
        for (const step of steps) {
            const item = append(stepRow, $('span.aixlarity-guide-step'));
            append(item, $('span.codicon.codicon-arrow-right', { style: 'font-size: 10px;' }));
            append(item, $('span')).textContent = step;
        }
        const close = append(card, $('button.aixlarity-guide-close', { title: 'Hide guidance' }));
        append(close, $('span.codicon.codicon-close', { style: 'font-size: 11px;' }));
        close.addEventListener('click', () => {
            try {
                localStorage.setItem(storageKey, 'hidden');
            } catch {
                // Ignore storage failures; the visual dismiss still works.
            }
            card.classList.add('aixlarity-fade-out');
            setTimeout(() => card.remove(), 160);
        });
    }

    private providerPresets(): Array<{ id: string; label: string; family: string; apiBase: string; model: string; apiKeyEnv: string; bestFor: string }> {
        return providerPresetsModel();
    }

    private providerIsCustom(provider: any): boolean {
        return providerIsCustomModel(provider);
    }

    private providerMutationScope(provider: any): 'workspace' | 'global' {
        return providerMutationScopeModel(provider);
    }

    private providerExportProfile(provider: any): any {
        return providerExportProfileModel(provider);
    }

    private normalizeProviderImportProfile(raw: any, fallbackScope: string, index: number): any {
        return normalizeProviderImportProfileModel(raw, fallbackScope, index);
    }

    private async activateProvider(provider: any, scope: 'workspace' | 'global', msText: HTMLElement): Promise<any> {
        const res = await this.sendRpcToDaemonAsync('providers/use', { id: provider.id, scope });
        const resolved = res?.provider || provider;
        const providerId = resolved.id || provider.id;
        const providerLabel = resolved.label || provider.label || providerId;
        if (scope === 'workspace') {
            this.activeWorkspaceProviderId = providerId;
        } else {
            this.activeGlobalProviderId = providerId;
        }
        const conversation = this.conversations.find(c => c.id === this.activeConversationId);
        if (conversation) {
            conversation.selectedProviderId = providerId;
            conversation.selectedProviderLabel = providerLabel;
        }
        this.currentProviderId = providerId;
        this.providerListCache = this.providerListCache.map((candidate: any) =>
            candidate.id === providerId ? { ...candidate, ...resolved } : candidate
        );
        if (!this.providerListCache.some((candidate: any) => candidate.id === providerId)) {
            this.providerListCache.push(resolved);
        }
        if (this.lastOverview?.current_provider) {
            this.lastOverview.current_provider = {
                ...this.lastOverview.current_provider,
                ...resolved,
                id: providerId,
                label: providerLabel,
            };
        }
        msText.textContent = providerLabel;
        this.sendRpcToDaemon('providers/list', {});
        return resolved;
    }

    private async copyProviderBundle(): Promise<void> {
        const bundle = createProviderBundle(this.providerListCache, this.activeGlobalProviderId || null, this.activeWorkspaceProviderId || null);
        await this.clipboardService.writeText(JSON.stringify(bundle, null, 2));
        this.appendMessage('system', `Provider bundle copied (${bundle.providers.length} custom providers, no raw API keys).`);
    }

    private async copyKnowledgeLedgerBundle(): Promise<void> {
        const state = this.ensureStudioState();
        const ledger = createKnowledgeLedger(state.inventory, state.knowledgePolicy);
        const bundle = createKnowledgeLedgerBundle(ledger);
        await this.clipboardService.writeText(JSON.stringify(bundle, null, 2));
        this.recordAuditEventToDaemon('knowledge_ledger_exported', {
            ledger_enabled: ledger.enabled,
            activation_mode: ledger.policy.activationMode,
            entry_count: ledger.summary.total,
            enabled_entry_count: ledger.summary.enabled,
        });
        this.appendMessage('system', `Knowledge ledger copied (${ledger.summary.enabled}/${ledger.summary.total} active entries).`);
    }

    private showImportProvidersDialog(msText: HTMLElement): void {
        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
            style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;'
        }));
        const modal = append(overlay, $('.aixlarity-modal', {
            style: 'background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; width: 92%; max-width: 420px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 10px;'
        }));
        append(modal, $('h3', { style: 'margin: 0; font-size: 14px; color: var(--vscode-foreground);' })).textContent = 'Import Provider Bundle';
        append(modal, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4;' })).textContent = 'Paste an Aixlarity provider bundle or a JSON object with a providers array. API key values are never imported here; only env var names are stored.';
        const scopeSelect = append(modal, $<HTMLSelectElement>('select.aixlarity-compact-select'));
        append(scopeSelect, $<HTMLOptionElement>('option', { value: 'workspace' })).textContent = 'Import to Workspace';
        append(scopeSelect, $<HTMLOptionElement>('option', { value: 'global' })).textContent = 'Import to User';
        scopeSelect.value = this.providerSwitchScope;
        const textArea = append(modal, $<HTMLTextAreaElement>('textarea', {
            placeholder: `{ "schema": "${AIXLARITY_PROVIDER_BUNDLE_SCHEMA}", "providers": [...] }`,
            style: 'min-height: 150px; resize: vertical; width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; padding: 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; outline: none;'
        }));
        const statusEl = append(modal, $('div', { style: 'font-size: 11px; min-height: 14px; color: var(--vscode-descriptionForeground);' }));
        const buttons = append(modal, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end;' }));
        const cancelBtn = append(buttons, $<HTMLButtonElement>('button.aixlarity-action-button'));
        cancelBtn.textContent = 'Cancel';
        const importBtn = append(buttons, $<HTMLButtonElement>('button.aixlarity-action-button'));
        importBtn.textContent = 'Import';
        cancelBtn.addEventListener('click', () => overlay.remove());
        importBtn.addEventListener('click', async () => {
            let parsed: any;
            try {
                parsed = JSON.parse(textArea.value);
            } catch (error) {
                statusEl.textContent = `Invalid JSON: ${this.rpcErrorMessage(error)}`;
                statusEl.style.color = '#f87171';
                return;
            }
            const providers = Array.isArray(parsed) ? parsed : parsed?.providers;
            if (!Array.isArray(providers) || providers.length === 0) {
                statusEl.textContent = 'No providers array found.';
                statusEl.style.color = '#f87171';
                return;
            }
            importBtn.disabled = true;
            cancelBtn.disabled = true;
            statusEl.textContent = `Importing ${providers.length} providers...`;
            statusEl.style.color = 'var(--vscode-descriptionForeground)';
            try {
                const normalizedProviders = providers.map((provider: any, index: number) =>
                    this.normalizeProviderImportProfile(provider, scopeSelect.value, index)
                );
                for (const provider of normalizedProviders) {
                    await this.sendRpcToDaemonAsync('providers/add', provider);
                }
                this.providerSwitchScope = scopeSelect.value as 'workspace' | 'global';
                this.sendRpcToDaemon('providers/list', {});
                msText.textContent = ' Loading...';
                overlay.remove();
            } catch (error) {
                importBtn.disabled = false;
                cancelBtn.disabled = false;
                statusEl.textContent = `Import failed: ${this.rpcErrorMessage(error)}`;
                statusEl.style.color = '#f87171';
            }
        });
    }

    private renderEssentialSettingsPanel(overview: any | null, providers: any[], currentProviderId: string, msText: HTMLElement): void {
        if (!this.settingsContainer) return;
        this.settingsContainer.textContent = '';

        const header = append(this.settingsContainer, $('div.aixlarity-manager-header'));
        const titleBlock = append(header, $('div'));
        append(titleBlock, $('div.aixlarity-manager-title')).textContent = 'Provider Setup';
        append(titleBlock, $('div.aixlarity-manager-subtitle')).textContent = 'Choose Provider / Add API Key / Select Model.';

        const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
        const selectedProviderId = activeConv?.selectedProviderId || currentProviderId || overview?.current_provider?.id || '';
        const activeProvider = providers.find((provider: any) => provider.id === selectedProviderId)
            || providers.find((provider: any) => provider.id === overview?.current_provider?.id)
            || (overview?.current_provider ? {
                id: overview.current_provider.id,
                label: overview.current_provider.id,
                model: overview.current_provider.model,
                family: overview.current_provider.family,
                api_key_env: overview.current_provider.api_key_env,
            } : null);

        this.renderGuidanceCard(
            this.settingsContainer,
            'aixlarity.settings.guidance.hidden.v1',
            'Keep the workspace ready',
            ['Choose provider', 'Trust workspace', 'Set execution']
        );

        const sectionTitle = (label: string) => {
            append(this.settingsContainer, $('div.aixlarity-section-label')).textContent = label;
        };

        const renderInfoRow = (container: HTMLElement, label: string, value: string) => {
            const row = append(container, $('div.aixlarity-settings-row'));
            append(row, $('span.aixlarity-settings-label')).textContent = label;
            append(row, $('span.aixlarity-settings-value')).textContent = value || 'none';
        };

        const renderToggleRow = (container: HTMLElement, title: string, description: string, isEnabled: () => boolean, setEnabled: (value: boolean) => void) => {
            const row = append(container, $('div', {
                style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);'
            }));
            const label = append(row, $('div', { style: 'min-width: 0;' }));
            append(label, $('div', { style: 'font-size: 12px; color: var(--vscode-foreground);' })).textContent = title;
            append(label, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px;' })).textContent = description;
            const toggle = append(row, $('button', {
                style: 'min-width: 38px; height: 20px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); cursor: pointer; font-size: 9px; font-weight: 700; transition: background 0.15s, color 0.15s;'
            }));
            const sync = () => {
                const enabled = isEnabled();
                toggle.textContent = enabled ? 'ON' : 'OFF';
                toggle.style.background = enabled ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
                toggle.style.color = enabled ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
            };
            toggle.addEventListener('click', () => {
                setEnabled(!isEnabled());
                sync();
            });
            sync();
        };

        sectionTitle('Provider');
        const providerCard = append(this.settingsContainer, $('div.aixlarity-settings-card'));
        providerCard.setAttribute('data-aixlarity-provider-setup', 'true');
        const providerTop = append(providerCard, $('div', { style: 'display: flex; align-items: center; gap: 8px; min-width: 0;' }));
        append(providerTop, $('span.codicon.codicon-sparkle', { style: 'color: var(--vscode-descriptionForeground);' }));
        const providerText = append(providerTop, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(providerText, $('div', { style: 'font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' })).textContent =
            String(activeProvider?.label || activeProvider?.id || 'No provider');
        const activeProviderModel = String(activeProvider?.model || '').trim();
        const apiProviderSelected = !!activeProvider && activeProvider.family !== 'external-cli';
        append(providerText, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;' })).textContent =
            activeProvider ? (activeProviderModel || (apiProviderSelected ? 'Model required for API' : 'External CLI model')) : 'Select a provider to run agents';

        const setupSteps = append(providerCard, $('div.aixlarity-provider-setup-steps'));
        const renderProviderStep = (label: string, iconClass: string, ready: boolean, detail: string) => {
            const step = append(setupSteps, $('div.aixlarity-provider-step'));
            step.classList.toggle('ready', ready);
            const labelRow = append(step, $('div.aixlarity-provider-step-label'));
            append(labelRow, $(`span.codicon.${iconClass}`));
            append(labelRow, $('span')).textContent = label;
            append(step, $('div.aixlarity-provider-step-status')).textContent = ready ? 'Ready' : detail;
        };
        const providerChosen = !!activeProvider;
        renderProviderStep('Choose Provider', 'codicon-server', providerChosen, 'Required');
        renderProviderStep('Add API Key', 'codicon-key', providerChosen && (!apiProviderSelected || !!activeProvider?.api_key_env), providerChosen ? 'Required' : 'After provider');
        renderProviderStep('Select Model', 'codicon-vm', providerChosen && (!apiProviderSelected || !!activeProviderModel), providerChosen ? 'Required' : 'After provider');

        const scopeToggle = append(providerCard, $('div.aixlarity-scope-toggle'));
        const workspaceScopeBtn = append(scopeToggle, $('button.aixlarity-action-button', { title: 'Switch only this workspace' }));
        append(workspaceScopeBtn, $('span.codicon.codicon-folder-active'));
        append(workspaceScopeBtn, $('span')).textContent = 'Workspace';
        const globalScopeBtn = append(scopeToggle, $('button.aixlarity-action-button', { title: 'Switch the user default provider' }));
        append(globalScopeBtn, $('span.codicon.codicon-account'));
        append(globalScopeBtn, $('span')).textContent = 'User';
        const syncScopeButtons = () => {
            workspaceScopeBtn.classList.toggle('active', this.providerSwitchScope === 'workspace');
            globalScopeBtn.classList.toggle('active', this.providerSwitchScope === 'global');
        };
        workspaceScopeBtn.addEventListener('click', () => {
            this.providerSwitchScope = 'workspace';
            syncScopeButtons();
            this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, msText);
        });
        globalScopeBtn.addEventListener('click', () => {
            this.providerSwitchScope = 'global';
            syncScopeButtons();
            this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, msText);
        });
        syncScopeButtons();

        const providerSelect = append(providerCard, $<HTMLSelectElement>('select.aixlarity-compact-select', { style: 'margin-top: 8px;' }));
        providerSelect.setAttribute('data-aixlarity-provider-select', 'true');
        if (providers.length === 0) {
            const option = append(providerSelect, $<HTMLOptionElement>('option'));
            option.textContent = 'No providers available';
            providerSelect.disabled = true;
        } else {
            for (const provider of providers) {
                const option = append(providerSelect, $<HTMLOptionElement>('option'));
                option.value = provider.id;
                option.textContent = `${provider.label || provider.id} (${provider.model || 'model'})`;
                option.selected = provider.id === selectedProviderId;
            }
        }

        let modelHint: HTMLElement | null = null;
        if (apiProviderSelected) {
            const modelEditor = append(providerCard, $('div.aixlarity-model-editor'));
            const modelInput = append(modelEditor, $<HTMLInputElement>('input.aixlarity-model-input', {
                placeholder: 'Model ID (required for API)'
            }));
            modelInput.setAttribute('data-aixlarity-model-input', 'true');
            modelInput.value = activeProviderModel;
            const saveModelBtn = append(modelEditor, $<HTMLButtonElement>('button.aixlarity-action-button', { title: 'Save model' }));
            append(saveModelBtn, $('span.codicon.codicon-save'));
            append(saveModelBtn, $('span')).textContent = 'Save Model';
            modelHint = append(providerCard, $('div.aixlarity-model-hint'));

            const syncModelSaveState = () => {
                const nextModel = modelInput.value.trim();
                saveModelBtn.disabled = !nextModel || nextModel === activeProviderModel;
                if (!nextModel) {
                    modelHint!.textContent = 'Model is required for API providers.';
                    modelHint!.style.color = '#f87171';
                } else if (nextModel === activeProviderModel) {
                    modelHint!.textContent = 'Model ready.';
                    modelHint!.style.color = 'var(--vscode-descriptionForeground)';
                } else {
                    modelHint!.textContent = 'Save to use this model for agent requests.';
                    modelHint!.style.color = 'var(--vscode-descriptionForeground)';
                }
            };

            const saveModel = async () => {
                const nextModel = modelInput.value.trim();
                if (!activeProvider?.id || !nextModel) {
                    syncModelSaveState();
                    modelInput.focus();
                    return;
                }
                saveModelBtn.disabled = true;
                modelInput.disabled = true;
                modelHint!.textContent = 'Saving model...';
                modelHint!.style.color = 'var(--vscode-descriptionForeground)';
                try {
                    const res = await this.sendRpcToDaemonAsync('providers/update', { id: activeProvider.id, model: nextModel });
                    const updatedProvider = res?.provider || { ...activeProvider, model: nextModel };
                    this.providerListCache = providers.map((provider: any) =>
                        provider.id === updatedProvider.id ? { ...provider, ...updatedProvider } : provider
                    );
                    if (!this.providerListCache.some((provider: any) => provider.id === updatedProvider.id)) {
                        this.providerListCache.push(updatedProvider);
                    }
                    if (this.lastOverview?.current_provider?.id === updatedProvider.id) {
                        this.lastOverview.current_provider = {
                            ...this.lastOverview.current_provider,
                            ...updatedProvider,
                        };
                    }
                    const conversation = this.conversations.find(c => c.id === this.activeConversationId);
                    if (conversation && conversation.selectedProviderId === updatedProvider.id) {
                        conversation.selectedProviderLabel = updatedProvider.label || conversation.selectedProviderLabel;
                    }
                    modelHint!.textContent = 'Model saved.';
                    modelHint!.style.color = 'var(--vscode-testing-iconPassed)';
                    this.sendRpcToDaemon('providers/list', {});
                    this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, msText);
                } catch (error) {
                    modelInput.disabled = false;
                    saveModelBtn.disabled = !modelInput.value.trim();
                    modelHint!.textContent = `Failed to save model: ${this.rpcErrorMessage(error)}`;
                    modelHint!.style.color = '#f87171';
                }
            };

            modelInput.addEventListener('input', syncModelSaveState);
            modelInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveModel();
                }
            });
            saveModelBtn.addEventListener('click', () => void saveModel());
            syncModelSaveState();
        }

        const providerStatus = append(providerCard, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 6px; min-height: 12px;' }));
        providerStatus.textContent = activeProvider ? 'Active provider' : 'Provider required';
        providerSelect.addEventListener('change', async () => {
            const provider = providers.find((candidate: any) => candidate.id === providerSelect.value);
            if (!provider) return;
            providerStatus.textContent = 'Applying...';
            try {
                const resolved = await this.activateProvider(provider, this.providerSwitchScope, msText);
                const providerId = resolved.id || provider.id;
                providerStatus.textContent = 'Active';
                this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, providerId, msText);
            } catch (error) {
                providerStatus.textContent = 'Failed';
                this.appendMessage('system', `Provider activation failed: ${this.rpcErrorMessage(error)}`);
            }
        });

        const providerActions = append(providerCard, $('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;' }));
        const addProviderBtn = append(providerActions, $('button.aixlarity-action-button'));
        addProviderBtn.setAttribute('data-aixlarity-add-api-key', 'true');
        append(addProviderBtn, $('span.codicon.codicon-add'));
        append(addProviderBtn, $('span')).textContent = 'Add API Key';
        addProviderBtn.addEventListener('click', () => this.showAddCustomProviderDialog(null, msText));
        const diagnoseBtn = append(providerActions, $<HTMLButtonElement>('button.aixlarity-action-button'));
        append(diagnoseBtn, $('span.codicon.codicon-pulse'));
        append(diagnoseBtn, $('span')).textContent = 'Diagnose';
        diagnoseBtn.disabled = !activeProvider;
        diagnoseBtn.addEventListener('click', () => {
            if (activeProvider?.id) {
                this.sendRpcToDaemon('providers/doctor', { id: activeProvider.id });
            }
        });
        if (activeProvider?.api_key_env) {
            const keyBtn = append(providerActions, $('button.aixlarity-action-button'));
            keyBtn.setAttribute('data-aixlarity-key-button', 'true');
            append(keyBtn, $('span.codicon.codicon-key'));
            append(keyBtn, $('span')).textContent = 'API Key';
            keyBtn.addEventListener('click', () => this.showProviderKeyDialog(activeProvider));
        }
        const exportProvidersBtn = append(providerActions, $('button.aixlarity-action-button', { title: 'Copy custom provider bundle as JSON' }));
        append(exportProvidersBtn, $('span.codicon.codicon-export'));
        append(exportProvidersBtn, $('span')).textContent = 'Export';
        exportProvidersBtn.addEventListener('click', () => void this.copyProviderBundle());
        const importProvidersBtn = append(providerActions, $('button.aixlarity-action-button', { title: 'Import provider bundle JSON' }));
        append(importProvidersBtn, $('span.codicon.codicon-cloud-upload'));
        append(importProvidersBtn, $('span')).textContent = 'Import';
        importProvidersBtn.addEventListener('click', () => this.showImportProvidersDialog(msText));

        const quickList = append(providerCard, $('div.aixlarity-provider-quick-list'));
        for (const provider of providers) {
            const row = append(quickList, $('div.aixlarity-provider-quick-row'));
            const info = append(row, $('div', { style: 'min-width: 0;' }));
            append(info, $('div.aixlarity-provider-quick-title')).textContent = provider.label || provider.id;
            const metaParts = [
                provider.model || 'model required',
                providerActiveLabelComponent(provider, this.activeWorkspaceProviderId, this.activeGlobalProviderId, this.currentProviderId),
                String(provider.scope || provider.source_kind || 'global'),
            ];
            append(info, $('div.aixlarity-provider-quick-meta')).textContent = metaParts.join(' · ');
            const actions = append(row, $('div.aixlarity-provider-quick-actions'));
            const useBtn = append(actions, $('button.aixlarity-action-button', { title: `Use for ${this.providerSwitchScope}` }));
            append(useBtn, $('span.codicon.codicon-check'));
            useBtn.addEventListener('click', async () => {
                useBtn.setAttribute('disabled', 'true');
                try {
                    await this.activateProvider(provider, this.providerSwitchScope, msText);
                    this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, msText);
                } catch (error) {
                    this.appendMessage('system', `Provider activation failed: ${this.rpcErrorMessage(error)}`);
                    useBtn.removeAttribute('disabled');
                }
            });
            const copyBtn = append(actions, $('button.aixlarity-action-button', { title: 'Copy provider config JSON' }));
            append(copyBtn, $('span.codicon.codicon-copy'));
            copyBtn.addEventListener('click', async () => {
                await this.clipboardService.writeText(JSON.stringify(this.providerExportProfile(provider), null, 2));
                this.appendMessage('system', `Provider config copied: ${provider.label || provider.id}`);
            });
            if (this.providerIsCustom(provider)) {
                const removeBtn = append(actions, $('button.aixlarity-action-button.danger', { title: `Remove ${this.providerMutationScope(provider)} provider` }));
                append(removeBtn, $('span.codicon.codicon-trash'));
                removeBtn.addEventListener('click', async () => {
                    removeBtn.setAttribute('disabled', 'true');
                    try {
                        await this.sendRpcToDaemonAsync('providers/remove', { id: provider.id, scope: this.providerMutationScope(provider) });
                        this.sendRpcToDaemon('providers/list', {});
                        this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache.filter((candidate: any) => candidate.id !== provider.id), this.currentProviderId, msText);
                    } catch (error) {
                        this.appendMessage('system', `Failed to remove provider: ${this.rpcErrorMessage(error)}`);
                        removeBtn.removeAttribute('disabled');
                    }
                });
            }
        }

        this.applyPendingProviderSetupIntent();

        sectionTitle('Trust');
        const trustCard = append(this.settingsContainer, $('div.aixlarity-settings-card'));
        renderInfoRow(trustCard, 'Workspace', String(overview?.workspace || this.workspaceEvidenceLabel()));
        renderInfoRow(trustCard, 'Aixlarity', String(overview?.trust || 'unknown'));
        renderInfoRow(trustCard, 'VS Code', this.vscodeTrustLabel());
        const trustActions = append(trustCard, $('div', { style: 'display: flex; gap: 6px; margin-top: 8px;' }));
        const checkTrustBtn = append(trustActions, $('button.aixlarity-action-button'));
        append(checkTrustBtn, $('span.codicon.codicon-shield'));
        append(checkTrustBtn, $('span')).textContent = 'Check';
        checkTrustBtn.addEventListener('click', () => void this.checkWorkspaceTrust(checkTrustBtn));
        const grantTrustBtn = append(trustActions, $('button.aixlarity-action-button'));
        append(grantTrustBtn, $('span.codicon.codicon-check'));
        append(grantTrustBtn, $('span')).textContent = 'Grant';
        grantTrustBtn.addEventListener('click', () => void this.grantWorkspaceTrust(grantTrustBtn));

        sectionTitle('Knowledge');
        const studioState = this.ensureStudioState();
        const knowledgeLedger = createKnowledgeLedger(studioState.inventory, studioState.knowledgePolicy);
        renderKnowledgeLedgerCard(this.settingsContainer, {
            ledger: knowledgeLedger,
            onPolicyChange: policy => {
                this.ensureStudioState().knowledgePolicy = policy;
                void this.saveStudioState('Knowledge policy saved.');
            },
            onExport: () => void this.copyKnowledgeLedgerBundle(),
        });

        sectionTitle('Execution');
        const execCard = append(this.settingsContainer, $('div.aixlarity-settings-card'));
        renderInfoRow(execCard, 'Sandbox', this.currentSandbox || String(overview?.default_sandbox || 'workspace-write'));
        renderInfoRow(execCard, 'Approval', this.currentPermission || 'suggest');
        renderToggleRow(execCard, 'Auto Git Commit', 'Commit changes after agent execution', () => this.autoGitEnabled, value => { this.autoGitEnabled = value; });
        renderToggleRow(execCard, 'Checkpoint Before Exec', 'Save a prompt checkpoint before execution', () => this.checkpointEnabled, value => { this.checkpointEnabled = value; });
    }

    private showAddCustomProviderDialog(_unused: any, msText: HTMLElement) {
        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
            style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;'
        }));

        const modal = append(overlay, $('.aixlarity-modal', {
            style: 'background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; width: 92%; max-width: 360px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 10px;'
        }));

        const title = append(modal, $('h3', { style: 'margin: 0; font-size: 14px; color: var(--vscode-foreground);' }));
        title.textContent = 'Add Custom API';

        const inputStyle = 'width: 100%; box-sizing: border-box; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); padding: 4px; border-radius: 4px; outline: none; margin-bottom: 2px;';

        const presets = this.providerPresets();
        const presetRow = append(modal, $('div'));
        append(presetRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'Provider Preset';
        const presetSel = append(presetRow, $<HTMLSelectElement>('select', { style: inputStyle }));
        append(presetSel, $<HTMLOptionElement>('option', { value: '' })).textContent = 'Custom';
        for (const preset of presets) {
            append(presetSel, $<HTMLOptionElement>('option', { value: preset.id })).textContent = preset.label;
        }

        const scopeRow = append(modal, $('div'));
        append(scopeRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'Save Scope';
        const scopeSel = append(scopeRow, $<HTMLSelectElement>('select', { style: inputStyle }));
        append(scopeSel, $<HTMLOptionElement>('option', { value: 'workspace' })).textContent = 'Workspace';
        append(scopeSel, $<HTMLOptionElement>('option', { value: 'global' })).textContent = 'User';
        scopeSel.value = this.providerSwitchScope;

        const labelRow = append(modal, $('div'));
        append(labelRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'Provider Name';
        const labelIn = append(labelRow, $<HTMLInputElement>('input', { style: inputStyle, placeholder: 'My DeepSeek' }));

        const familyRow = append(modal, $('div'));
        append(familyRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'API Family';
        const familySel = append(familyRow, $<HTMLSelectElement>('select', { style: inputStyle }));
        append(familySel, $<HTMLOptionElement>('option', { value: 'openai-compatible' })).textContent = 'OpenAI Compatible';
        append(familySel, $<HTMLOptionElement>('option', { value: 'anthropic' })).textContent = 'Anthropic Claude';
        append(familySel, $<HTMLOptionElement>('option', { value: 'gemini' })).textContent = 'Google Gemini';
        append(familySel, $<HTMLOptionElement>('option', { value: 'external-cli' })).textContent = 'External CLI';

        const baseRow = append(modal, $('div'));
        append(baseRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'Base URL';
        const baseIn = append(baseRow, $<HTMLInputElement>('input', { style: inputStyle, placeholder: 'https://api.deepseek.com/v1' }));

        const modelRow = append(modal, $('div'));
        append(modelRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'Model ID (required)';
        const modelIn = append(modelRow, $<HTMLInputElement>('input', { style: inputStyle, placeholder: 'deepseek-chat, gpt-4.1, claude-sonnet-4.5' }));

        const envRow = append(modal, $('div'));
        append(envRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'API Key Env Var Name';
        const envIn = append(envRow, $<HTMLInputElement>('input', { style: inputStyle, placeholder: 'DEEPSEEK_API_KEY' }));

        const keyRow = append(modal, $('div'));
        append(keyRow, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = 'OR Paste Raw API Key (sk-...)';
        const keyIn = append(keyRow, $<HTMLInputElement>('input', { type: 'password', style: inputStyle, placeholder: 'sk-...' }));
        const statusEl = append(modal, $('div', { style: 'font-size: 11px; min-height: 14px; color: var(--vscode-descriptionForeground);' }));

        const syncCredentialRows = () => {
            const isExternal = familySel.value === 'external-cli';
            baseRow.style.display = isExternal ? 'none' : '';
            envRow.style.display = isExternal ? 'none' : '';
            keyRow.style.display = isExternal ? 'none' : '';
        };
        presetSel.addEventListener('change', () => {
            const preset = presets.find(candidate => candidate.id === presetSel.value);
            if (!preset) {
                return;
            }
            labelIn.value = preset.label;
            familySel.value = preset.family;
            baseIn.value = preset.apiBase;
            modelIn.value = preset.model;
            envIn.value = preset.apiKeyEnv;
            statusEl.textContent = preset.bestFor;
            statusEl.style.color = 'var(--vscode-descriptionForeground)';
            syncCredentialRows();
        });
        familySel.addEventListener('change', syncCredentialRows);
        syncCredentialRows();

        const btnRow = append(modal, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;' }));
        const cancelBtn = append(btnRow, $<HTMLButtonElement>('button', { style: 'background: transparent; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-secondaryBackground, var(--vscode-panel-border)); padding: 4px 12px; border-radius: 4px; cursor: pointer;' }));
        cancelBtn.textContent = 'Cancel';
        const saveBtn = append(btnRow, $<HTMLButtonElement>('button', { style: 'background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;' }));
        saveBtn.textContent = 'Save';

        cancelBtn.addEventListener('click', () => {
            overlay.remove();
        });

        saveBtn.addEventListener('click', async () => {
            const label = labelIn.value.trim() || 'Custom Provider';
            const model = modelIn.value.trim();
            const rawKey = keyIn.value.trim();
            const isExternal = familySel.value === 'external-cli';
            const defaultEnv = isExternal ? '' : `${familySel.value.toUpperCase().replace(/[^A-Z]/g, '')}_API_KEY`;
            const envVarName = isExternal ? '' : (envIn.value.trim() || defaultEnv).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
            if (!model) {
                statusEl.textContent = isExternal ? 'Model ID is required.' : 'Model ID is required for API providers.';
                statusEl.style.color = '#f87171';
                modelIn.focus();
                return;
            }
            if (!isExternal && !baseIn.value.trim()) {
                statusEl.textContent = 'Base URL is required for API providers.';
                statusEl.style.color = '#f87171';
                baseIn.focus();
                return;
            }
            if (!isExternal && !envVarName) {
                statusEl.textContent = 'API key env var is required for API providers.';
                statusEl.style.color = '#f87171';
                envIn.focus();
                return;
            }
            if (rawKey.includes('\n') || rawKey.includes('\r')) {
                statusEl.textContent = 'API key must be a single line.';
                statusEl.style.color = '#f87171';
                return;
            }

            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            statusEl.textContent = '';
            msText.textContent = ` Loading...`;
            const providerId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `custom-${Date.now()}`;

            try {
                if (rawKey && envVarName) {
                    await this.sendRpcToDaemonAsync('system/set_keys', { [envVarName]: rawKey });
                }
                const res = await this.sendRpcToDaemonAsync('providers/add', {
                    id: providerId,
                    label: label,
                    family: familySel.value,
                    api_base: baseIn.value.trim(),
                    model,
                    api_key_env: envVarName,
                    scope: scopeSel.value
                });
                if (res?.provider) {
                    this.providerSwitchScope = scopeSel.value as 'workspace' | 'global';
                    this.sendRpcToDaemon('providers/list', {});
                    overlay.remove();
                    return;
                }
                throw new Error(res?.error || 'Provider was not created.');
            } catch (error: any) {
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
                saveBtn.textContent = 'Save';
                statusEl.textContent = error?.message || 'Failed to save provider.';
                statusEl.style.color = '#f87171';
            }
        });
    }




    private showProviderKeyDialog(provider: any) {
        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
            style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;'
        }));

        const modal = append(overlay, $('.aixlarity-modal', {
            style: 'background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; width: 90%; max-width: 300px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 12px;'
        }));

        const title = append(modal, $('h3', { style: 'margin: 0; font-size: 14px; color: var(--vscode-foreground);' }));
        title.textContent = `Setup ${provider.label}`;

        const inputStyle = 'width: 100%; box-sizing: border-box; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); padding: 4px; border-radius: 4px; outline: none; margin-bottom: 2px;';

        const row = append(modal, $('div'));
        append(row, $('div', { style: 'font-size: 11px; margin-bottom: 2px; color: var(--vscode-descriptionForeground);' })).textContent = `API Key (${provider.api_key_env || 'N/A'})`;
        const keyIn = append(row, $<HTMLInputElement>('input', { type: 'password', style: inputStyle, placeholder: 'Enter API key...' }));
        const statusEl = append(modal, $('div', { style: 'font-size: 11px; min-height: 14px; color: var(--vscode-descriptionForeground);' }));

        const btnRow = append(modal, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;' }));
        const cancelBtn = append(btnRow, $<HTMLButtonElement>('button', { style: 'background: transparent; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-secondaryBackground, var(--vscode-panel-border)); padding: 4px 12px; border-radius: 4px; cursor: pointer;' }));
        cancelBtn.textContent = 'Cancel';
        const saveBtn = append(btnRow, $<HTMLButtonElement>('button', { style: 'background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;' }));
        saveBtn.textContent = 'Save';

        cancelBtn.addEventListener('click', () => {
            overlay.remove();
        });

        saveBtn.addEventListener('click', async () => {
            if (!provider.api_key_env) {
                overlay.remove();
                return;
            }
            const key = keyIn.value.trim();
            if (!key) {
                statusEl.textContent = 'API key is required.';
                statusEl.style.color = '#f87171';
                return;
            }
            if (key.includes('\n') || key.includes('\r')) {
                statusEl.textContent = 'API key must be a single line.';
                statusEl.style.color = '#f87171';
                return;
            }
            const params: any = {};
            params[provider.api_key_env] = key;
            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            statusEl.textContent = '';
            try {
                const res = await this.sendRpcToDaemonAsync('system/set_keys', params);
                if (res?.status === 'success') {
                    this.appendMessage('system', `API key saved for ${provider.label}.`);
                    overlay.remove();
                    return;
                }
                throw new Error(res?.error || 'Failed to save API key.');
            } catch (error: any) {
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
                saveBtn.textContent = 'Save';
                statusEl.textContent = error?.message || 'Failed to save API key.';
                statusEl.style.color = '#f87171';
            }
        });
    }

    public handleStream(role: 'user' | 'agent' | 'system', chunk: string): void {
        // Remove loading indicator on first real response
        this.removeLoadingIndicator();

        // Guard: if the result payload already arrived, ignore late stream chunks
        // to prevent duplicate agent message boxes.
        if (role === 'agent' && (this as any)._streamFinalized) {
            return;
        }

	        if (!this.activeStreamNode || this.activeStreamRole !== role) {
	            this.activeStreamRole = role;
	            this.activeStreamText = "";
	            this._lastStreamMarkdownRenderAt = 0;

            let boxStyle = '';
            let contentStyle = 'font-size: 13px; line-height: 1.6; word-wrap: break-word; overflow-wrap: break-word;';

            if (role === 'user') {
                boxStyle = `
                    align-self: stretch;
                    position: relative;
                    background: transparent;
                    color: var(--vscode-foreground);
                    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
                    border-radius: 8px;
                    padding: 8px 12px;
                    margin-bottom: 12px;
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                `;
            } else if (role === 'agent') {
                boxStyle = `
                    align-self: stretch;
                    position: relative;
                    background: transparent;
                    color: var(--vscode-foreground);
                    border-radius: 8px;
                    padding: 4px 8px;
                    margin-bottom: 10px;
                    flex-shrink: 0;
                `;
            } else if (role === 'system') {
                boxStyle = `
                    align-self: stretch;
                    position: relative;
                    background: rgba(220, 38, 38, 0.06);
                    border: 1px solid rgba(220, 38, 38, 0.2);
                    border-radius: 8px;
                    margin-bottom: 16px;
                    overflow: hidden;
                    flex-shrink: 0;
                `;
                contentStyle = 'font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; color: var(--vscode-errorForeground, #f87171); padding: 10px 12px; overflow-x: auto; max-height: 300px; white-space: pre-wrap;';
            }

            const msgBox = append(this.chatContainer, $('.aixlarity-message', {
                style: `display: flex; flex-direction: column; ${boxStyle}`
            }));

            if (role === 'user') {
                (this as any).lastUserMessageNode = msgBox;
            }

            // Action bar setup
            if (role === 'user' || role === 'agent') {
                const actionBar = append(msgBox, $('div.aixlarity-msg-action-bar'));
                (msgBox as any)._aixlarityBoxState = { text: '' };

                // Copy button
                const copyBtn = append(actionBar, $('div.aixlarity-msg-action-btn', { title: 'Copy text' }));
                append(copyBtn, $('span.codicon.codicon-copy'));
                copyBtn.addEventListener('click', async () => {
                    const textToCopy = (msgBox as any)._aixlarityBoxState.text || '';
                    try {
                        await this.clipboardService.writeText(textToCopy);
                        const icon = copyBtn.querySelector('.codicon') as HTMLElement;
                        if (icon) {
                            icon.classList.remove('codicon-copy');
                            icon.classList.add('codicon-check');
                            copyBtn.style.color = 'var(--vscode-terminal-ansiGreen, #4ade80)';
                            setTimeout(() => {
                                icon.classList.remove('codicon-check');
                                icon.classList.add('codicon-copy');
                                copyBtn.style.color = '';
                            }, 1500);
                        }
                    } catch (err) {
                        console.error('Failed to copy text', err);
                    }
                });

                // Revert/Reply button for user messages only
                if (role === 'user') {
                    const revertBtn = append(actionBar, $('div.aixlarity-msg-action-btn', { title: 'Revert / Reply' }));
                    append(revertBtn, $('span.codicon.codicon-reply'));
                    revertBtn.addEventListener('click', () => {
                        if (this.inputElement) {
                            this.inputElement.value = (msgBox as any)._aixlarityBoxState.text || '';
                            this.inputElement.focus();
                        }
                        let nextNode = msgBox.nextSibling;
                        while (nextNode) {
                            const toRemove = nextNode;
                            nextNode = nextNode.nextSibling;
                            toRemove.remove();
                        }
                        msgBox.remove();
                    });
                }
            }

            this.activeStreamNode = append(msgBox, $('.aixlarity-message-content', {
                style: contentStyle
            }));
        }

        this.activeStreamText += chunk;
        if (this.activeStreamNode && this.activeStreamNode.parentElement) {
            const state = (this.activeStreamNode.parentElement as any)._aixlarityBoxState;
            if (state) state.text += chunk;
        }

        // Performance: throttle DOM updates to ~5fps (200ms) during streaming.
        // Full markdown re-render is expensive — we mark dirty and batch.
	        this._streamRenderDirty = true;
	        if (!this._streamRenderTimer) {
	            this._streamRenderTimer = setTimeout(() => {
	                this._streamRenderTimer = null;
	                if (this._streamRenderDirty) {
	                    this._streamRenderDirty = false;
	                    this._flushStreamRender(false);
	                }
	            }, 200);
	        }
	    }

	    private flushPendingStreamRender(forceMarkdown: boolean = false): void {
	        if (this._streamRenderTimer) {
	            clearTimeout(this._streamRenderTimer);
	            this._streamRenderTimer = null;
	        }
	        if (this._streamRenderDirty || forceMarkdown) {
	            this._streamRenderDirty = false;
	            this._flushStreamRender(forceMarkdown);
	        }
	    }

	    /** Batched render of accumulated stream text. Called at most ~5fps while streaming. */
	    private _flushStreamRender(forceMarkdown: boolean = false): void {
        if (!this.activeStreamNode) return;
        const role = this.activeStreamRole;

        if (this.activeStreamRenderDisposable) {
            this.activeStreamRenderDisposable.dispose();
        }

        if (role === 'system') {
            this.activeStreamNode.textContent = this.activeStreamText;
        } else {
            // Intercept Artifact markers
            const artifactMatch = this.activeStreamText.match(/\[ARTIFACT:\s*([^\]]+)\]/i);
            let displayString = this.activeStreamText;
            if (artifactMatch) {
                displayString = displayString.replace(artifactMatch[0], '');
            }

            // Filter out CLI noise (e.g. stdin warnings from claude cli)
            displayString = displayString.replace(/Warning: no stdin data received in \d+s.*(?:\n|$)/g, '');
            displayString = displayString.replace(/.*proceeding without it.*(?:\n|$)/g, '');
            displayString = displayString.replace(/.*redirect stdin explicitly.*(?:\n|$)/g, '');

            // Extract <think>...</think> blocks and render them as collapsible details
            let thinkContent = '';
            let visibleContent = displayString;
            // Case 1: Complete <think>...</think> block
            const thinkMatch = displayString.match(/<think>([\s\S]*?)<\/think>/);
            if (thinkMatch) {
                thinkContent = thinkMatch[1].trim();
                visibleContent = displayString.replace(thinkMatch[0], '').trim();
            } else {
                // Case 2: Streaming — <think> opened but not yet closed
                const openThinkMatch = displayString.match(/<think>([\s\S]*)$/);
                if (openThinkMatch) {
                    thinkContent = openThinkMatch[1].trim();
                    visibleContent = displayString.substring(0, openThinkMatch.index).trim();
                }
            }

            // Clear old content
            while (this.activeStreamNode.firstChild) {
                this.activeStreamNode.removeChild(this.activeStreamNode.firstChild);
            }

            // Render collapsible think block
            if (thinkContent) {
                const details = document.createElement('details');
                details.className = 'aixlarity-think-toggle';
                const summary = document.createElement('summary');
                const chevron = document.createElement('span');
                chevron.className = 'codicon codicon-chevron-right';
                chevron.style.cssText = 'transition: transform 0.2s; font-size: 10px;';
                summary.appendChild(chevron);
                const label = document.createElement('span');
                label.textContent = 'Thinking...';
                summary.appendChild(label);
                details.appendChild(summary);
                details.addEventListener('toggle', () => {
                    chevron.style.transform = details.open ? 'rotate(90deg)' : '';
                    label.textContent = details.open ? 'Thinking' : 'Thinking...';
                });
                const body = document.createElement('div');
                body.className = 'aixlarity-think-body';
                body.textContent = thinkContent;
                details.appendChild(body);
                this.activeStreamNode.appendChild(details);
            }

	            // Render main content via markdown
	            if (visibleContent) {
	                const now = Date.now();
	                const shouldRenderMarkdown = forceMarkdown
	                    || role !== 'agent'
	                    || visibleContent.length <= this.streamMarkdownLengthThreshold
	                    || now - this._lastStreamMarkdownRenderAt >= this.streamMarkdownMinIntervalMs;

	                if (shouldRenderMarkdown) {
	                    const mdString: IMarkdownString = { value: visibleContent, isTrusted: false, supportThemeIcons: true };
	                    const result = renderMarkdown(mdString, { }, undefined);
	                    this.activeStreamRenderDisposable = result;
	                    this.activeStreamNode.appendChild(result.element);
	                    this._lastStreamMarkdownRenderAt = now;
	                } else {
	                    const preview = document.createElement('div');
	                    preview.style.cssText = 'white-space: pre-wrap;';
	                    preview.textContent = visibleContent;
	                    this.activeStreamNode.appendChild(preview);
	                }
	            }

            // Render Open-Antigravity style Verifiable Artifact Card
            if (artifactMatch) {
                const artifactName = artifactMatch[1];
                const taskId = this.activeRpcId ? this.rpcToAgentTask.get(this.activeRpcId) : undefined;
                const artifact = this.upsertAgentArtifact({
                    id: this.stableId(taskId || 'inline', 'inline-artifact', artifactName),
                    taskId,
                    name: artifactName,
                    kind: this.normalizeArtifactKind(artifactName),
                    status: 'needs_review',
                    summary: visibleContent ? this.truncateForDisplay(visibleContent, 500, 'artifact summary') : `Review ${artifactName}`,
                    body: visibleContent,
                });
                const card = document.createElement('div');
                card.className = 'aixlarity-artifact-card';
                card.style.cssText = 'background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 2px; padding: 12px; margin-top: 12px; display: flex; flex-direction: column; gap: 10px;';

                const header = document.createElement('div');
                header.style.cssText = 'display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--vscode-textLink-foreground, #4daafc);';
                append(header, $('span.codicon.codicon-file-code'));
                append(header, $('span')).textContent = `Verifiable Artifact: ${artifactName}`;
                card.appendChild(header);

                const actions = document.createElement('div');
                actions.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';

                const createBtn = (label: string, icon: string, bg: string, color: string, onClick: () => void) => {
                    const btn = document.createElement('button');
                    btn.style.cssText = `background: ${bg}; color: ${color}; border: 1px solid rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; transition: all 0.2s;`;
                    append(btn, $(`span.codicon.codicon-${icon}`));
                    append(btn, $('span')).textContent = ` ${label}`;
                    btn.onmouseover = () => btn.style.filter = 'brightness(1.2)';
                    btn.onmouseout = () => btn.style.filter = 'brightness(1)';
                    btn.addEventListener('click', onClick);
                    return btn;
                };

                actions.appendChild(createBtn('Approve Plan', 'check', 'rgba(22, 163, 74, 0.8)', '#fff', () => {
                    this.markArtifactStatus(artifact.id, 'approved');
                    if (this.sendToDaemon(`I have reviewed and approved artifact: ${artifactName}. Proceed.`)) {
                        this.updateSendButtonState(true);
                    }
                }));

                actions.appendChild(createBtn('Reject / Feedback', 'edit', 'rgba(220, 38, 38, 0.8)', '#fff', () => {
                    this.markArtifactStatus(artifact.id, 'rejected');
                    if (this.sendToDaemon(`I am rejecting the artifact ${artifactName}. Please make the following corrections: `)) {
                        this.updateSendButtonState(true);
                    }
                    if (this.inputElement) this.inputElement.focus();
                }));

                card.appendChild(actions);
                this.activeStreamNode.appendChild(card);
            }
        }

        // Performance: coalesce scroll updates via rAF to avoid forced reflows.
        // Only auto-scroll if the user is near the bottom — if they scrolled up
        // to view a tool card / screenshot, don't yank them back down.
        if (!this._scrollRafPending && this._isUserNearBottom()) {
            this._scrollRafPending = true;
            requestAnimationFrame(() => {
                this._scrollRafPending = false;
                if (this.chatContainer) {
                    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
                }
            });
        }
    }

    /** Check whether the user is scrolled near the bottom of the chat. */
    private _isUserNearBottom(): boolean {
        if (!this.chatContainer) return true;
        const threshold = 150; // px tolerance
        return (this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight) < threshold;
    }

    /** Scroll to bottom only if the user hasn't manually scrolled up. */
    private _smartScroll(): void {
        if (this._isUserNearBottom() && this.chatContainer) {
            this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
        }
    }

    private completeToolAction(callId: string, result: any, attachments?: any[]): void {
        const refs = this.pendingToolActions.get(callId);
        if (!refs) return;

        let outputText = "";
        let exitCode = "";
        if (result && typeof result === 'object') {
            if (result.stdout) outputText += result.stdout;
            if (result.stderr) outputText += (outputText ? "\n" : "") + result.stderr;
            if (result.output) outputText += (outputText ? "\n" : "") + result.output;
            if (!outputText && result.message) outputText = result.message;
            if (result.exit_code !== undefined) exitCode = `Exit code ${result.exit_code}`;
	        } else {
	            outputText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
	        }
	        outputText = this.truncateForDisplay(outputText, 50000, 'tool output');

        let isBrowser = refs.titleSpan.querySelector('.codicon-browser') !== null;
        if (isBrowser) {
            // === Browser subagent: convert in-flow card to a collapsible result ===
            // Card stays in its natural DOM position (between tool call and agent
            // response). No sticky/floating — just a clean inline collapsible card.

            // Remove loading placeholder
            if ((refs.card as any)._aixlarityLoadingBar) {
                (refs.card as any)._aixlarityLoadingBar.remove();
            }

            // Hide ALL original children of the card (summary, outputWrapper, etc.)
            for (let i = 0; i < refs.card.children.length; i++) {
                (refs.card.children[i] as HTMLElement).style.display = 'none';
            }

            // Restyle the card as a compact collapsible container
            refs.card.style.cssText = `
                background: var(--vscode-editorWidget-background, #18181a);
                border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
                border-left: 3px solid #4ade80;
                border-radius: 6px;
                margin-bottom: 8px;
            `;

            // --- Header row (always visible, collapsed by default) ---
            const header = document.createElement('div');
            header.style.cssText = 'display: flex; align-items: center; padding: 8px 12px; cursor: pointer; user-select: none;';

            const chevron = document.createElement('span');
            chevron.className = 'codicon codicon-chevron-right';
            chevron.style.cssText = 'margin-right: 8px; transition: transform 0.15s; font-size: 10px; color: var(--vscode-descriptionForeground);';
            header.appendChild(chevron);

            const checkIcon = document.createElement('span');
            checkIcon.className = 'codicon codicon-check';
            checkIcon.style.cssText = 'margin-right: 5px; color: #4ade80;';
            header.appendChild(checkIcon);

            const browserIcon = document.createElement('span');
            browserIcon.className = 'codicon codicon-browser';
            browserIcon.style.cssText = 'margin-right: 6px;';
            header.appendChild(browserIcon);

            const label = document.createElement('span');
            label.style.cssText = 'font-size: 12px; color: var(--vscode-foreground);';
            label.textContent = result?.capture_level === 'screenshot_fallback' ? 'Screenshot fallback captured' : 'Browser evidence captured';
            header.appendChild(label);

            refs.card.appendChild(header);

            // --- Expandable body (hidden by default) ---
            const body = document.createElement('div');
            body.style.cssText = 'display: none; border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));';

            // Screenshot images
            if (attachments && attachments.length > 0) {
                for (const att of attachments) {
                    if (!att.mime_type || !att.mime_type.startsWith('image/')) continue;

                    const imgContainer = document.createElement('div');
                    imgContainer.style.cssText = 'padding: 8px; background: rgba(0,0,0,0.15);';

                    const img = document.createElement('img');
                    if (att.file_path) {
                        img.src = `vscode-file://vscode-app${att.file_path}`;
                    } else if (att.data_base64) {
                        try {
                            const raw = atob(att.data_base64);
	                            const arr = new Uint8Array(raw.length);
	                            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
	                            img.src = this.createManagedObjectUrl(new Blob([arr], { type: att.mime_type }));
                        } catch (_) {
                            img.src = `data:${att.mime_type};base64,${att.data_base64}`;
                        }
                    } else {
                        continue;
                    }
                    img.style.cssText = 'width: 100%; display: block; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1);';

                    imgContainer.appendChild(img);
                    body.appendChild(imgContainer);
                }
            }

            const videoPath = result?.browser_evidence?.video?.path;
            if (videoPath) {
                const videoContainer = document.createElement('div');
                videoContainer.style.cssText = 'padding: 8px; background: rgba(0,0,0,0.15); border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04));';
                const video = document.createElement('video');
                video.controls = true;
                video.src = `vscode-file://vscode-app${videoPath}`;
                video.style.cssText = 'width: 100%; max-height: 240px; display: block; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35);';
                videoContainer.appendChild(video);
                body.appendChild(videoContainer);
            }

            const evidence = result?.browser_evidence;
            if (evidence) {
                const summaryEl = document.createElement('div');
                summaryEl.style.cssText = 'padding: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04));';
                const consoleCount = Array.isArray(evidence.console) ? evidence.console.length : 0;
                const networkCount = evidence.network?.request_count ?? evidence.network?.requests?.length ?? 0;
                summaryEl.textContent = `DOM ${evidence.dom ? 'captured' : 'unavailable'} · Console ${consoleCount} · Network ${networkCount} · Video ${videoPath ? 'captured' : 'unavailable'}`;
                body.appendChild(summaryEl);
            }

            // Text output (if any)
            if (outputText.trim()) {
                const textEl = document.createElement('div');
                textEl.style.cssText = 'padding: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; max-height: 150px; overflow-y: auto;';
                textEl.textContent = outputText.trim();
                body.appendChild(textEl);
            }

            refs.card.appendChild(body);

            // Toggle expand/collapse
            header.addEventListener('click', () => {
                const isOpen = body.style.display !== 'none';
                body.style.display = isOpen ? 'none' : 'block';
                chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
            });
        } else {
            // --- Shell/other tools: standard text output ---
            refs.titleSpan.textContent = 'Ran command';
            refs.outputWrapper.style.display = 'block';
            refs.outputContent.textContent = outputText.trim() || "(no output)";

            if (attachments && attachments.length > 0) {
                const attachmentsContainer = document.createElement('div');
                attachmentsContainer.style.cssText = 'margin-top: 10px; display: flex; flex-direction: column; gap: 10px;';
                for (const att of attachments) {
                    if (att.mime_type && att.mime_type.startsWith('image/')) {
                        const img = document.createElement('img');
                        if (att.file_path) {
                            img.src = `vscode-file://vscode-app${att.file_path}`;
                        } else if (att.data_base64) {
                            try {
                                const byteCharacters = atob(att.data_base64);
                                const byteNumbers = new Array(byteCharacters.length);
                                for (let i = 0; i < byteCharacters.length; i++) {
                                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                                }
	                                const byteArray = new Uint8Array(byteNumbers);
	                                const blob = new Blob([byteArray], { type: att.mime_type });
	                                img.src = this.createManagedObjectUrl(blob);
                            } catch (e) {
                                img.src = `data:${att.mime_type};base64,${att.data_base64}`;
                            }
                        } else {
                            continue;
                        }
                        img.className = 'aixlarity-attachment-img';
                        attachmentsContainer.appendChild(img);
                    }
                }
                if (attachmentsContainer.children.length > 0) {
                    refs.outputContent.parentElement!.appendChild(attachmentsContainer);
                }
            }
        }
        refs.exitCodeSpan.textContent = exitCode;

        this.pendingToolActions.delete(callId);
        this._smartScroll();
    }

    private appendToolAction(toolName: string, args: any, callId?: string): void {
        // Insert tool action cards BEFORE the active agent stream box
        // so they appear above the response text (matching execution order).
        const insertPoint = (this.activeStreamNode && this.activeStreamNode.parentElement)
            ? this.activeStreamNode.parentElement : null;
        const insertCard = (el: HTMLElement) => {
            if (insertPoint && insertPoint.parentNode === this.chatContainer) {
                this.chatContainer.insertBefore(el, insertPoint);
            } else {
                this.chatContainer.appendChild(el);
            }
        };

        if (toolName === 'shell' || toolName === 'bash' || toolName === 'browser_subagent') {
            let parsedArgs = args;
            if (typeof args === 'string') {
                try { parsedArgs = JSON.parse(args); } catch (e) {}
            }
            const isBrowser = toolName === 'browser_subagent';
            const card = $('div.aixlarity-cmd-card', {
                style: 'background: var(--vscode-editorWidget-background, #18181a); border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08)); border-radius: 6px; margin-bottom: 8px; display: block;'
            }) as HTMLElement;
            insertCard(card);

            const summary = append(card, $('div.aixlarity-cmd-summary', {
                style: 'cursor: pointer; user-select: none;'
            }));

            const headerText = append(summary, $('div', {
                style: 'font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04)); display: flex; justify-content: space-between; align-items: center;'
            }));

            const titleSpan = append(headerText, $('span', { style: 'display: flex; align-items: center;' }));
            if (isBrowser) {
                const icon = document.createElement('span');
                icon.className = 'codicon codicon-browser';
                icon.style.cssText = 'margin-right: 6px; animation: aixlarity-pulse 1.5s ease-in-out infinite;';
                titleSpan.appendChild(icon);
                const urlText = parsedArgs?.url || '...';
                titleSpan.appendChild(document.createTextNode(` Navigating to `));
                const urlLabel = document.createElement('span');
                urlLabel.style.cssText = 'color: var(--vscode-textLink-foreground, #4daafc); margin-left: 4px;';
                urlLabel.textContent = urlText;
                titleSpan.appendChild(urlLabel);
            } else {
                titleSpan.textContent = 'Running command...';
            }

            const copyBtn = append(headerText, $('span.codicon.codicon-copy', {
                style: 'cursor: pointer; font-size: 12px;',
                title: isBrowser ? 'Copy URL' : 'Copy Command'
            }));

	            const cmdStr = isBrowser ? (parsedArgs?.url || '') : ((parsedArgs && typeof parsedArgs === 'object' && parsedArgs.command) ? parsedArgs.command : this.stringifyForDisplay(parsedArgs, 8000));

            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(cmdStr).then(() => {
                    copyBtn.className = 'codicon codicon-check';
                    setTimeout(() => copyBtn.className = 'codicon codicon-copy', 2000);
                });
            });

            const cmdLine = append(summary, $('div', {
                style: 'padding: 10px 12px; font-family: var(--vscode-editor-font-family); font-size: 11.5px; color: var(--vscode-editor-foreground, #e0e0e0); display: flex; align-items: flex-start; gap: 8px;'
            }));
            if (isBrowser) {
                append(cmdLine, $('span', { style: 'color: var(--vscode-descriptionForeground); user-select: none; font-weight: bold; white-space: nowrap;' })).textContent = 'Task:';
                append(cmdLine, $('span', { style: 'flex: 1; word-break: break-all; white-space: pre-wrap;' })).textContent = parsedArgs?.task || '';

                // Show a loading placeholder while screenshot is being taken
                const loadingBar = append(card, $('div', {
                    style: 'height: 120px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.15); border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04)); color: var(--vscode-descriptionForeground); font-size: 11px; gap: 8px;'
                }));
                const spinner = document.createElement('span');
                spinner.className = 'codicon codicon-loading';
                spinner.style.cssText = 'animation: aixlarity-spin 1s linear infinite; font-size: 16px;';
                loadingBar.appendChild(spinner);
                loadingBar.appendChild(document.createTextNode('Capturing screenshot...'));
                // Store loading bar ref so completeToolAction can remove it
                (card as any)._aixlarityLoadingBar = loadingBar;
            } else {
                append(cmdLine, $('span', { style: 'color: var(--vscode-descriptionForeground); user-select: none; font-weight: bold; white-space: nowrap;' })).textContent = 'aixlarity-ide $';
	                append(cmdLine, $('span', { style: 'flex: 1; word-break: break-all; white-space: pre-wrap;' })).textContent = this.truncateForDisplay(cmdStr, 8000, 'command');
            }

            const outputWrapper = append(card, $('div', { style: isBrowser ? 'display: block;' : 'display: none;' }));

            const outputContent = append(outputWrapper, $('div', {
                style: 'padding: 10px 12px; background: rgba(0,0,0,0.15); font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-editor-foreground, #a0a0a0); max-height: 300px; overflow-y: auto; white-space: pre-wrap; border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04));'
            }));

            const footer = append(outputWrapper, $('div', {
                style: isBrowser ? 'display: none;' : 'display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.04));'
            }));
            append(footer, $('span')).textContent = 'Always run ^';
            const exitCodeSpan = append(footer, $('span'));

            summary.addEventListener('click', () => {
                outputWrapper.style.display = outputWrapper.style.display === 'none' ? 'block' : 'none';
            });

            if (callId) {
                this.pendingToolActions.set(callId, { card, titleSpan, outputContent, exitCodeSpan, outputWrapper });
            }

            // Reset stream pointers so the agent's follow-up response
            // creates a fresh stream box BELOW this tool card.
            if (this.activeStreamNode && this.activeStreamRole === 'agent') {
                this.activeStreamNode = null;
                this.activeStreamRole = null;
                this.activeStreamText = '';
            }

            this._smartScroll();
            return;
        }

        const card = $('div.aixlarity-tool-action') as HTMLElement;
        insertCard(card);
        const header = append(card, $('div.aixlarity-tool-action-header'));
        const chevron = append(header, $('span.codicon.codicon-chevron-right.tool-chevron'));
        append(header, $('span.codicon.codicon-tools', { style: 'font-size: 12px; opacity: 0.7;' }));
        const nameSpan = append(header, $('span', { style: 'font-weight: 600; color: var(--vscode-foreground);' }));
        nameSpan.textContent = toolName;
        if (args) {
            let brief = '';
            if (typeof args === 'string') {
                brief = args.length > 60 ? args.substring(0, 60) + '...' : args;
            } else if (typeof args === 'object') {
	                const vals = Object.entries(args).map(([k, v]) => `${k}: ${this.stringifyForDisplay(v, 300)}`);
                brief = vals.join(', ');
                if (brief.length > 80) brief = brief.substring(0, 80) + '...';
            }
            if (brief) {
                const briefSpan = append(header, $('span', { style: 'opacity: 0.5; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;' }));
                briefSpan.textContent = brief;
            }
            const detail = append(card, $('div.aixlarity-tool-action-detail'));
            const pre = append(detail, $('pre'));
	            pre.textContent = this.stringifyForDisplay(args, 20000);
            pre.style.cssText = 'font-size: 11px; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); white-space: pre-wrap; max-height: 200px; overflow-y: auto;';
            header.addEventListener('click', () => {
                chevron.classList.toggle('expanded');
                detail.classList.toggle('open');
            });
        }
        this._smartScroll();
    }

    private appendApprovalCard(callId: string, toolName: string, args: any, rpcId?: string): void {
        const insertPoint = (this.activeStreamNode && this.activeStreamNode.parentElement)
            ? this.activeStreamNode.parentElement : null;
        const card = $('div.aixlarity-approval-card') as HTMLElement;
        if (insertPoint && insertPoint.parentNode === this.chatContainer) {
            this.chatContainer.insertBefore(card, insertPoint);
        } else {
            this.chatContainer.appendChild(card);
        }

        const header = append(card, $('div.aixlarity-approval-header'));
        append(header, $('span.approval-icon')).textContent = '⚠️';
        const titleSpan = append(header, $('span', { style: 'font-weight: 600;' }));
        let desc = toolName;
        if (args && typeof args === 'object') {
            if (args.path || args.file_path) {
                const p = args.path || args.file_path;
                const basename = p.split('/').pop() || p;
                desc = `${toolName} — ${basename}`;
            } else if (args.command) {
                const cmd = args.command.length > 50 ? args.command.substring(0, 50) + '...' : args.command;
                desc = `${toolName}: ${cmd}`;
            }
        }
        this.recordPendingApproval(callId, toolName, desc, args, rpcId);
        titleSpan.textContent = desc;

	        if (args) {
	            const detail = append(card, $('div.aixlarity-approval-detail'));
	            const pre = append(detail, $('pre'));
	            pre.textContent = this.stringifyForDisplay(args, 20000);
	        }

        const actions = append(card, $('div.aixlarity-approval-actions'));
        const allowBtn = append(actions, $('button.aixlarity-approval-btn.allow'));
        allowBtn.textContent = '✓ Allow';
        const denyBtn = append(actions, $('button.aixlarity-approval-btn.deny'));
        denyBtn.textContent = '✗ Deny';
        const alwaysBtn = append(actions, $('button.aixlarity-approval-btn.always'));
        alwaysBtn.textContent = '⚡ Always Allow';

        const resolveCard = (decision: string, label: string, color: string) => {
            this.resolveApprovalRequest(callId, decision, label);
            card.textContent = '';
            card.style.borderColor = color;
            card.style.background = `${color}11`;
            const resolved = append(card, $('div.aixlarity-approval-resolved'));
            (resolved as HTMLElement).style.color = color;
            const icon = decision === 'deny' ? '✗' : '✓';
            resolved.textContent = `${icon} ${toolName} — ${label}`;
        };

        allowBtn.addEventListener('click', () => resolveCard('allow', 'Allowed', 'rgba(34,197,94,0.5)'));
        denyBtn.addEventListener('click', () => resolveCard('deny', 'Denied', 'rgba(239,68,68,0.5)'));
        alwaysBtn.addEventListener('click', () => resolveCard('always', 'Always Allowed', 'rgba(59,130,246,0.5)'));

        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private recordPendingApproval(callId: string, toolName: string, description: string, args: any, rpcId?: string): void {
        const taskId = rpcId ? this.rpcToAgentTask.get(String(rpcId)) : undefined;
        const createdAt = Date.now();
        this.pendingApprovals.set(callId, {
            callId,
            rpcId,
            taskId,
            toolName,
            description,
            arguments: args,
            createdAt,
        });
        this.recordAuditEventToDaemon('approval_request', {
            call_id: callId,
            rpc_id: rpcId || '',
            task_id: taskId || '',
            tool_name: toolName,
            description,
            argument_preview: this.stringifyForDisplay(args, 2000),
            created_at_ms: createdAt,
        });
        this.refreshAgentManagerIfVisible();
    }

    private resolveApprovalRequest(callId: string, decision: string, label: string): void {
        const pending = this.pendingApprovals.get(callId);
        this.sendRpcToDaemon('approval_response', { call_id: callId, decision });
        this.pendingApprovals.delete(callId);
        this.recordAuditEventToDaemon('approval_response', {
            call_id: callId,
            rpc_id: pending?.rpcId || '',
            task_id: pending?.taskId || '',
            tool_name: pending?.toolName || '',
            description: pending?.description || '',
            decision,
            label,
            argument_preview: pending ? this.stringifyForDisplay(pending.arguments, 2000) : '',
        });
        this.showManagerNotice(`Approval ${label.toLowerCase()}`);
        if (pending?.taskId) {
            const task = this.agentTasks.get(pending.taskId);
            if (task) {
                this.addTaskTimeline(task, 'approval_response', `Approval ${label}`, pending.description, task.status);
                task.progressLabel = `Approval ${label.toLowerCase()}: ${pending.description}`;
            }
        }
        this.refreshAgentManagerIfVisible();
    }

	public appendMessage(role: 'user' | 'agent' | 'system', content: string): void {
	        this.handleStream(role, content);
	        // Flush immediately since appendMessage is a one-shot, not a stream
	        this.flushPendingStreamRender(true);
	        if (this.activeStreamNode && this.activeStreamNode.parentElement) {
            this.activeStreamNode.parentElement.classList.remove('aixlarity-generating-beam');
        }
        this.activeStreamRole = null;
        this.activeStreamNode = null;
        this.activeStreamText = "";
	}

    private updateSendButtonState(isGenerating: boolean) {
        this.isGenerating = isGenerating;
        if (!this.sendBtnRef || !this.sendIconRef) return;

        if (isGenerating) {
            this.sendBtnRef.style.background = 'var(--vscode-errorForeground, #f43f5e)';
            this.sendIconRef.className = 'aixlarity-solid-square';

            // Intentionally not showing the outer window border beam to keep UI cleaner
            // if (this.aixlarityWrapper && !this.globalBeamEl) {
            //     this.globalBeamEl = append(this.aixlarityWrapper, $('.aixlarity-anim-beam'));
            // }
            if (this.inputBoxRef) {
                this.inputBoxRef.classList.add('is-generating');
                if (!this.inputBeamEl) {
                    this.inputBeamEl = append(this.inputBoxRef, $('.aixlarity-anim-beam'));
                }
            }
            // Apply beam natively to the user's box instead of the AI
            if ((this as any).lastUserMessageNode) {
                const node = ((this as any).lastUserMessageNode as HTMLElement);
                if (!node.classList.contains('aixlarity-generating-beam')) {
                    node.classList.add('aixlarity-generating-beam');
                }
            }
        } else {
            this.sendBtnRef.style.background = 'var(--vscode-textLink-foreground, #007acc)';
            this.sendIconRef.className = 'codicon codicon-arrow-up';

            if (this.globalBeamEl) { this.globalBeamEl.remove(); this.globalBeamEl = null; }
            if (this.inputBoxRef) {
                this.inputBoxRef.classList.remove('is-generating');
            }
            if (this.inputBeamEl) { this.inputBeamEl.remove(); this.inputBeamEl = null; }

            // Remove beam natively from the user's box
            if ((this as any).lastUserMessageNode) {
                ((this as any).lastUserMessageNode as HTMLElement).classList.remove('aixlarity-generating-beam');
            }

            if (this.chatContainer) {
                const lingeringBeams = this.chatContainer.querySelectorAll('.aixlarity-anim-beam');
                lingeringBeams.forEach(el => el.remove());
            }
        }
    }

    private sendToDaemon(text: string): boolean {
        const editorContext = this.getActiveEditorContext();
        const conv = this.conversations.find(c => c.id === this.activeConversationId);

        let attachments = undefined;
        if (this.pendingAttachments.length > 0) {
            attachments = this.pendingAttachments.map(att => ({
                mime_type: att.type,
                data_base64: att.base64
            }));
        }

        const rpcId = this.sendRpcToDaemon('agent_chat', {
            prompt: text,
            plan_only: this.planningMode,
            persona: conv?.selectedPersona || this.currentPersona,
            sandbox: this.currentSandbox,
            permission: this.currentPermission,
            checkpoint: this.checkpointEnabled,
            auto_git: this.autoGitEnabled,
            skill: this.currentSkill || null,
            ide_context: { ...editorContext, open_files: null, browser_state: null },
            session_id: conv ? conv.backendSessionId : null,
            provider: conv && conv.selectedProviderId ? conv.selectedProviderId : null,
            attachments: attachments
        });
        if (!rpcId) {
            this.appendMessage('system', 'Failed to send request to daemon.');
            return false;
        }

        if (attachments) {
            this.pendingAttachments = [];
            this.attachmentsContainer.textContent = '';
        }

        // Deep-bind: associate this RPC with the active conversation
        if (this.activeConversationId) {
            this.activeRpcId = rpcId;
            this.rpcToConversation.set(rpcId, this.activeConversationId);
        }
        this.createAgentTaskForRequest(rpcId, text, conv, editorContext);
        this.showLoadingIndicator();

        // Auto-title the active conversation from the first user message
        if (conv && conv.title === 'New Chat') {
            conv.title = text.length > 30 ? text.substring(0, 30) + '...' : text;
            this.rebuildConversationBar();
        }
        return true;
    }

    private showLoadingIndicator(): void {
        this.removeLoadingIndicator();
        const el = append(this.chatContainer, $('div.aixlarity-loading'));
        const dots = append(el, $('div.aixlarity-loading-dots'));
        append(dots, $('span'));
        append(dots, $('span'));
        append(dots, $('span'));
        append(el, $('span.aixlarity-loading-label')).textContent = 'Thinking';
        this.loadingIndicator = el;
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private removeLoadingIndicator(): void {
        if (this.loadingIndicator) {
            this.loadingIndicator.remove();
            this.loadingIndicator = null;
        }
    }

    private stopActiveRequest(): void {
        const rpcId = this.activeRpcId;
        if (rpcId) {
            this.rememberStoppedRpc(rpcId);
            this.sendRpcToDaemon('agent_stop', { id: rpcId });
            this.rpcToConversation.delete(rpcId);
            const taskId = this.rpcToAgentTask.get(rpcId);
            if (taskId) {
                this.markTaskStopped(taskId, 'Stopped by user.');
            }
        } else {
            for (const runningRpcId of this.rpcToConversation.keys()) {
                this.rememberStoppedRpc(runningRpcId);
                const taskId = this.rpcToAgentTask.get(runningRpcId);
                if (taskId) {
                    this.markTaskStopped(taskId, 'Stopped by user.');
                }
            }
            this.rpcToConversation.clear();
            this.sendRpcToDaemon('agent_stop', {});
        }

        this.removeLoadingIndicator();
        this.updateSendButtonState(false);
        this.activeStreamRole = null;
        this.activeStreamNode = null;
        this.activeStreamText = '';
        this.activeRpcId = null;
        this.appendMessage('system', 'Generation stopped.');
    }

    private rememberStoppedRpc(rpcId: string): void {
        this.stoppedRpcIds.add(rpcId);
        if (this.stoppedRpcIds.size > 100) {
            const oldest = this.stoppedRpcIds.values().next().value;
            if (oldest) {
                this.stoppedRpcIds.delete(oldest);
            }
        }
    }

    private shouldIgnoreStoppedPayload(payload: any): boolean {
        const rpcId = payload?.id ? String(payload.id) : null;
        if (!rpcId || !this.stoppedRpcIds.has(rpcId)) {
            return false;
        }
        if (payload.error || payload.result?.final_response !== undefined || payload.result?.events !== undefined) {
            this.stoppedRpcIds.delete(rpcId);
        }
        return true;
    }

    private setActionButtonBusy(button: HTMLElement, text: string, busy: boolean): void {
        button.textContent = text;
        button.style.opacity = busy ? '0.6' : '1';
        if (button instanceof HTMLButtonElement) {
            button.disabled = busy;
        }
    }

    private restoreActionButton(button: HTMLElement, text: string): void {
        this.setActionButtonBusy(button, text, false);
    }

    private rpcErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }
        return typeof error === 'string' ? error : 'Unknown error';
    }

    private appendPanelError(container: HTMLElement, message: string, replaceContent: boolean = false): void {
        if (replaceContent) {
            container.textContent = '';
        }
        const errEl = document.createElement('div');
        errEl.style.cssText = 'color: #f87171; font-size: 12px; padding: 12px; opacity: 0.9; line-height: 1.4;';
        errEl.textContent = message;
        container.appendChild(errEl);
    }

    public openProviderSetup(intent: ProviderSetupIntent = 'choose-provider'): void {
        this.pendingProviderSetupIntent = intent;
        this.providerSetupIntentConsumed = false;
        this.showSettingsDashboard();
        setTimeout(() => this.applyPendingProviderSetupIntent(), 0);
    }

    private showSettingsDashboard(anchor?: HTMLElement | null): void {
        if (!this.settingsContainer || !this.chatContainer || !this.inputWrapper || !this.bottomStatusBar || !this.fleetContainer || !this.historyContainer) {
            return;
        }

        this.chatContainer.style.display = 'none';
        this.inputWrapper.style.display = 'none';
        this.bottomStatusBar.style.display = 'none';
        this.fleetContainer.style.display = 'none';
        this.historyContainer.style.display = 'none';
        this.settingsContainer.style.display = 'flex';
        this.settingsContainer.textContent = '';

        const settingsPill = anchor || (this.conversationBar?.querySelector('[data-aixlarity-nav="settings"]') as HTMLElement | null);
        settingsPill?.classList.add('active');
        const managerPill = this.conversationBar?.querySelector('[data-aixlarity-nav="fleet"]');
        managerPill?.classList.remove('active');
        const historyPill = this.conversationBar?.querySelector('[data-aixlarity-nav="history"]');
        historyPill?.classList.remove('active');

        this.conversationBar?.querySelectorAll('.aixlarity-conv-pill').forEach(pill => {
            const nav = pill.getAttribute('data-aixlarity-nav');
            if (pill !== settingsPill && nav !== 'fleet' && nav !== 'history') {
                pill.classList.remove('active');
            }
        });

        this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, this.msTextRef || settingsPill || this.settingsContainer);
        this.sendRpcToDaemon('overview', {});
        this.sendRpcToDaemon('studio/load', {});
    }

    private applyPendingProviderSetupIntent(): void {
        const intent = this.pendingProviderSetupIntent;
        if (!intent || !this.isSettingsVisible()) {
            return;
        }

        const providerCard = this.settingsContainer.querySelector('[data-aixlarity-provider-setup="true"]') as HTMLElement | null;
        providerCard?.classList.add('aixlarity-provider-setup-focus');
        providerCard?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        if (intent === 'choose-provider') {
            const providerSelect = this.settingsContainer.querySelector('[data-aixlarity-provider-select="true"]') as HTMLSelectElement | null;
            providerSelect?.focus();
            this.pendingProviderSetupIntent = null;
            return;
        }

        if (intent === 'select-model') {
            const modelInput = this.settingsContainer.querySelector('[data-aixlarity-model-input="true"]') as HTMLInputElement | null;
            const providerSelect = this.settingsContainer.querySelector('[data-aixlarity-provider-select="true"]') as HTMLSelectElement | null;
            (modelInput || providerSelect)?.focus();
            this.pendingProviderSetupIntent = null;
            return;
        }

        if (intent === 'add-api-key' && !this.providerSetupIntentConsumed) {
            this.providerSetupIntentConsumed = true;
            const keyButton = this.settingsContainer.querySelector('[data-aixlarity-key-button="true"]') as HTMLButtonElement | null;
            const addButton = this.settingsContainer.querySelector('[data-aixlarity-add-api-key="true"]') as HTMLButtonElement | null;
            const target = keyButton || addButton;
            if (target) {
                target.focus();
                target.click();
            }
            this.pendingProviderSetupIntent = null;
        }
    }

    private isSettingsVisible(): boolean {
        return !!this.settingsContainer && this.settingsContainer.style.display === 'flex';
    }

    private vscodeTrustLabel(): string {
        return this.workspaceTrustManagementService.isWorkspaceTrusted() ? 'trusted' : 'restricted';
    }

    private isAixlarityTrustedStatus(status: string | undefined): boolean {
        return status === 'trusted' || status === 'trusted-via-parent' || status === 'disabled';
    }

    private isAixlarityProjectConfigRestricted(status: string | undefined): boolean {
        return status === 'unknown' || status === 'untrusted';
    }

    private showWorkspaceNotice(message: string, tone: 'info' | 'warning' | 'error' | 'success' = 'info'): void {
        if (!this.isSettingsVisible()) {
            this.appendMessage('system', message);
            return;
        }

        const existing = this.settingsContainer.querySelector('.aixlarity-settings-notice.transient');
        existing?.remove();

        const colors: Record<typeof tone, { background: string; border: string; foreground: string }> = {
            info: { background: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.35)', foreground: 'var(--vscode-foreground)' },
            warning: { background: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.38)', foreground: 'var(--vscode-foreground)' },
            error: { background: 'rgba(244, 63, 94, 0.14)', border: 'rgba(244, 63, 94, 0.38)', foreground: 'var(--vscode-foreground)' },
            success: { background: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.35)', foreground: 'var(--vscode-foreground)' },
        };
        const palette = colors[tone];
        const notice = $('div.aixlarity-settings-card.aixlarity-settings-notice.transient', {
            style: `background: ${palette.background}; border-color: ${palette.border}; color: ${palette.foreground}; font-size: 12px; line-height: 1.45; margin-bottom: 12px;`
        });
        notice.textContent = message;

        const anchor = this.settingsContainer.children.length > 1 ? this.settingsContainer.children[1] : null;
        this.settingsContainer.insertBefore(notice, anchor);
    }

    renderWorkspaceTrustNotice(overview: any): void {
        const aixlarityTrust = typeof overview?.trust === 'string' ? overview.trust : 'unknown';
        const vscodeTrusted = this.workspaceTrustManagementService.isWorkspaceTrusted();
        const restricted = this.isAixlarityProjectConfigRestricted(aixlarityTrust);
        if (vscodeTrusted && !restricted) {
            return;
        }

        const card = append(this.settingsContainer, $('div.aixlarity-settings-card.aixlarity-settings-notice', {
            style: 'border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.10); margin-top: 12px;'
        }));
        const titleRow = append(card, $('div', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px;' }));
        append(titleRow, $('span.codicon.codicon-workspace-untrusted', { style: 'font-size: 14px; color: #f59e0b;' }));
        append(titleRow, $('span')).textContent = 'Workspace trust attention needed';

        const detail = append(card, $('div', { style: 'font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); margin-bottom: 10px;' }));
        if (!vscodeTrusted) {
            detail.textContent = 'VS Code is in Restricted Mode. Aixlarity will not load project workflows or skills until the workspace is trusted.';
        } else {
            detail.textContent = 'VS Code trusts this workspace, but Aixlarity trust is still unknown or denied. Project workflows and skills are intentionally disabled.';
        }

        const counts = overview?.counts || {};
        if (restricted && Number(counts.commands || 0) === 0 && Number(counts.skills || 0) === 0) {
            const reason = append(card, $('div', { style: 'font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); margin-bottom: 10px;' }));
            reason.textContent = 'Commands and skills show 0 because project configuration is blocked by trust, not because the files are missing.';
        }

        const actions = append(card, $('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap;' }));
        const trustBtn = append(actions, $('button.aixlarity-action-btn', { style: 'width: auto; min-width: 120px;' }));
        trustBtn.textContent = vscodeTrusted ? 'Sync Trust' : 'Trust Workspace...';
        trustBtn.addEventListener('click', () => {
            if (vscodeTrusted) {
                void this.syncAixlarityTrustFromVsCode(true, 'Manual sync', true);
            } else {
                void this.grantWorkspaceTrust(trustBtn);
            }
        });

        const checkBtn = append(actions, $('button.aixlarity-action-btn', { style: 'width: auto; min-width: 110px;' }));
        checkBtn.textContent = 'Check Trust';
        checkBtn.addEventListener('click', () => {
            void this.checkWorkspaceTrust(checkBtn);
        });
    }

    private async syncAixlarityTrustAfterDaemonReady(): Promise<void> {
        try {
            await this.workspaceTrustManagementService.workspaceTrustInitialized;
        } catch {
            // Trust initialization failures should not block the agent UI.
        }
        if (!this.daemonConnected || !this.workspaceTrustManagementService.isWorkspaceTrusted()) {
            return;
        }
        await this.syncAixlarityTrustFromVsCode(true, 'Workspace already trusted by VS Code', false);
    }

    private async syncAixlarityTrustFromVsCode(trusted: boolean, reason: string, showFeedback: boolean): Promise<void> {
        if (!this.daemonConnected || this.workspaceTrustSyncInFlight) {
            return;
        }

        this.workspaceTrustSyncInFlight = true;
        try {
            const status = await this.sendRpcToDaemonAsync('trust/status', { path: '.' });
            const current = typeof status?.status === 'string' ? status.status : 'unknown';
            const alreadySynced = trusted
                ? this.isAixlarityTrustedStatus(current)
                : current === 'untrusted' || current === 'disabled';

            let finalStatus = current;
            if (!alreadySynced) {
                const updated = await this.sendRpcToDaemonAsync('trust/set', { path: '.', kind: trusted ? 'trusted' : 'untrusted' });
                finalStatus = trusted ? 'trusted' : 'untrusted';
                if (typeof updated?.rule === 'string') {
                    finalStatus = updated.rule === 'parent' ? 'trusted-via-parent' : updated.rule;
                }
            }

            if (showFeedback) {
                const vscodeState = trusted ? 'trusted' : 'restricted';
                const action = alreadySynced ? 'already matches' : 'synced';
                this.showWorkspaceNotice(`VS Code workspace trust is ${vscodeState}; Aixlarity trust ${action} (${finalStatus}).`, trusted ? 'success' : 'warning');
            }

            this.sendRpcToDaemon('overview', {});
        } catch (error) {
            const message = `Workspace trust sync failed (${reason}): ${this.rpcErrorMessage(error)}`;
            if (showFeedback) {
                this.showWorkspaceNotice(message, 'error');
            } else {
                console.warn(message);
            }
        } finally {
            this.workspaceTrustSyncInFlight = false;
        }
    }

    private maybeShowInputAssist(): void {
        if (!this.inputElement || this.inputElement.disabled) {
            return;
        }
        const trigger = this.inputElement.value.trim();
        if (trigger !== '/' && trigger !== '@') {
            this.lastInputAssistTrigger = '';
            return;
        }
        if (this.lastInputAssistTrigger === trigger) {
            return;
        }
        this.lastInputAssistTrigger = trigger;
        void this.showInputAssist(trigger as '/' | '@');
    }

    private async showInputAssist(trigger: '/' | '@'): Promise<void> {
        if (trigger === '/') {
            await this.showWorkflowAssist();
        } else {
            await this.showMentionAssist();
        }
    }

    private async showWorkflowAssist(): Promise<void> {
        let catalog: any = null;
        let loadError = '';
        if (this.daemonConnected) {
            try {
                catalog = await this.sendRpcToDaemonAsync('commands/list', {});
            } catch (error) {
                loadError = this.rpcErrorMessage(error);
            }
        }

        const trust = typeof catalog?.trust === 'string'
            ? catalog.trust
            : (typeof this.lastOverview?.trust === 'string' ? this.lastOverview.trust : 'unknown');
        const commands = Array.isArray(catalog?.commands) ? catalog.commands : [];
        const restricted = this.isAixlarityProjectConfigRestricted(trust);

        const picks: any[] = [];
        if (!this.daemonConnected) {
            picks.push({ label: 'Aixlarity daemon is not ready', detail: 'Workflows cannot be loaded until the daemon is connected.', pickable: false, disabled: true });
        } else if (restricted) {
            picks.push({ label: 'Project workflows are disabled by trust', detail: `Aixlarity trust is ${trust}. Commands and skills are intentionally hidden.`, pickable: false, disabled: true });
            picks.push({ label: 'Trust Workspace...', description: 'Use VS Code Workspace Trust first', action: 'trust' });
            picks.push({ label: 'Reload Workflows', description: 'Refresh after trust changes', action: 'reload' });
        } else if (commands.length > 0) {
            for (const command of commands) {
                picks.push({
                    label: `/${command.name}`,
                    description: command.description || '',
                    detail: command.source_path || '',
                    action: 'insert-command',
                    command
                });
            }
        } else {
            picks.push({ label: 'No workflows found', detail: loadError || 'Add .toml files under .aixlarity/commands or your global Aixlarity commands directory.', pickable: false, disabled: true });
            picks.push({ label: 'Reload Workflows', description: 'Refresh command and skill catalog', action: 'reload' });
        }

        const selected: any = await this.quickInputService.pick(picks, {
            placeHolder: 'Select an Aixlarity workflow',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selected || selected.disabled || selected.pickable === false) {
            return;
        }

        if (selected.action === 'insert-command' && selected.command?.name) {
            this.insertInputToken(`/${selected.command.name}`);
        } else if (selected.action === 'trust') {
            await this.grantWorkspaceTrust();
        } else if (selected.action === 'reload') {
            await this.reloadWorkspaceCommands();
        }
    }

    private async showMentionAssist(): Promise<void> {
        const editorContext = this.getActiveEditorContext();
        const workspaceRoot = this.resolveRpcCwd({});
        const picks: any[] = [];

        if (editorContext.active_file) {
            const relative = this.relativeWorkspacePath(editorContext.active_file);
            picks.push({
                label: `@${relative}`,
                description: 'Active file',
                detail: editorContext.cursor_line ? `Line ${editorContext.cursor_line}` : '',
                action: 'insert',
                token: `@${relative}`
            });
        }

        if (editorContext.selected_text) {
            picks.push({
                label: '@selection',
                description: 'Current editor selection',
                detail: 'The selected text is sent as IDE context with your next message.',
                action: 'insert',
                token: '@selection'
            });
        }

        if (workspaceRoot) {
            picks.push({
                label: '@workspace',
                description: this.relativeWorkspacePath(workspaceRoot),
                detail: workspaceRoot,
                action: 'insert',
                token: '@workspace'
            });
        }

        if (picks.length === 0) {
            picks.push({ label: 'No active file or workspace context', detail: 'Open a workspace folder or editor file to mention it.', pickable: false, disabled: true });
        }

        const selected: any = await this.quickInputService.pick(picks, {
            placeHolder: 'Mention IDE context',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (selected?.action === 'insert' && selected.token) {
            this.insertInputToken(selected.token);
        }
    }

    private relativeWorkspacePath(fsPath: string): string {
        const workspaceRoot = this.resolveRpcCwd({});
        if (!workspaceRoot) {
            return fsPath;
        }
        const normalizedPath = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
        const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
        if (normalizedPath === normalizedRoot) {
            return '.';
        }
        if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
            return normalizedPath.slice(normalizedRoot.length + 1);
        }
        return fsPath;
    }

    private insertInputToken(token: string): void {
        const current = this.inputElement.value;
        const trimmed = current.trim();
        const replacement = `${token} `;
        if (trimmed === '/' || trimmed === '@') {
            this.inputElement.value = replacement;
        } else {
            const separator = current.length === 0 || /\s$/.test(current) ? '' : ' ';
            this.inputElement.value = `${current}${separator}${replacement}`;
        }
        this.lastInputAssistTrigger = '';
        this.inputElement.focus();
        const end = this.inputElement.value.length;
        this.inputElement.setSelectionRange(end, end);
        this.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }

    private showRpcError(method: string | undefined, message: string): boolean {
        if (!method) {
            return false;
        }

        if (method === 'history/track') {
            if (this.devMode) {
                this.appendMessage('system', `Local History tracking failed: ${message}`);
            }
            return true;
        }

        if (method === 'history/list' || method === 'history/get_blob' || method === 'history/file_revisions' || method === 'history/revert') {
            this.appendPanelError(this.historyContainer, `Local History Error: ${message}`, method === 'history/list');
            return true;
        }

        if (method === 'sessions/list' || method === 'checkpoints/list' || method.startsWith('sessions/')) {
            this.appendPanelError(this.fleetContainer, `Fleet Error: ${message}`);
            return true;
        }

        if (method.startsWith('providers/')) {
            if (method === 'providers/list' && this.msTextRef && this.msTextRef.textContent === ' Loading...') {
                this.msTextRef.textContent = ' Provider Error';
            }
            this.appendMessage('system', `Provider request failed: ${message}`);
            return true;
        }

        if (method === 'overview' || method === 'commands/reload' || method.startsWith('trust/')) {
            if (this.settingsContainer && this.settingsContainer.style.display === 'flex') {
                this.appendPanelError(this.settingsContainer, `Workspace request failed: ${message}`);
            } else {
                this.appendMessage('system', `Workspace request failed: ${message}`);
            }
            return true;
        }

        return false;
    }

    private async checkWorkspaceTrust(button?: HTMLElement): Promise<void> {
        const label = button?.textContent || 'Check Trust';
        if (button) {
            this.setActionButtonBusy(button, 'Checking...', true);
        }
        try {
            const res = await this.sendRpcToDaemonAsync('trust/status', { path: '.' });
            const status = res?.status || 'unknown';
            const suffix = this.isAixlarityProjectConfigRestricted(status)
                ? ' Project commands and skills are disabled until the workspace is trusted.'
                : '';
            this.showWorkspaceNotice(`Trust Status: Aixlarity ${status} (matched: ${res?.matched_rule || 'none'}); VS Code ${this.vscodeTrustLabel()}.${suffix}`, this.isAixlarityProjectConfigRestricted(status) ? 'warning' : 'info');
        } catch (error) {
            this.showWorkspaceNotice(`Trust check failed: ${this.rpcErrorMessage(error)}`, 'error');
        } finally {
            if (button) {
                this.restoreActionButton(button, label);
            }
        }
    }

    private async grantWorkspaceTrust(button?: HTMLElement): Promise<void> {
        const label = button?.textContent || 'Grant Trust';
        if (button) {
            this.setActionButtonBusy(button, 'Opening...', true);
        }
        try {
            const trusted = await this.workspaceTrustRequestService.requestWorkspaceTrust({
                message: 'Aixlarity needs workspace trust before it can load project workflows, skills, and instructions from this folder.'
            });
            if (trusted === undefined) {
                this.showWorkspaceNotice('Workspace trust request was canceled. Aixlarity project workflows and skills remain disabled.', 'warning');
                return;
            }
            if (!trusted) {
                await this.syncAixlarityTrustFromVsCode(false, 'Workspace trust denied', false);
                this.showWorkspaceNotice('VS Code remains in Restricted Mode. Aixlarity marked this workspace untrusted and will keep project workflows and skills disabled.', 'warning');
                return;
            }
            await this.syncAixlarityTrustFromVsCode(true, 'Workspace trust granted', true);
        } catch (error) {
            this.showWorkspaceNotice(`Trust grant failed: ${this.rpcErrorMessage(error)}`, 'error');
        } finally {
            if (button) {
                this.restoreActionButton(button, label);
            }
        }
    }

    private async reloadWorkspaceCommands(button?: HTMLElement): Promise<void> {
        const label = button?.textContent || 'Reload Commands';
        if (button) {
            this.setActionButtonBusy(button, 'Reloading...', true);
        }
        try {
            const res = await this.sendRpcToDaemonAsync('commands/reload', {});
            const trust = typeof res?.trust === 'string' ? res.trust : 'unknown';
            const commands = res?.commands ?? '?';
            const skills = res?.skills ?? '?';
            if (this.isAixlarityProjectConfigRestricted(trust) && Number(commands || 0) === 0 && Number(skills || 0) === 0) {
                this.showWorkspaceNotice(`Reload complete, but project workflows are disabled by trust (${trust}). Commands: ${commands}, skills: ${skills}.`, 'warning');
            } else {
                this.showWorkspaceNotice(`Reload complete: ${commands} commands, ${skills} skills.`, 'success');
            }
            this.sendRpcToDaemon('overview', {});
        } catch (error) {
            this.showWorkspaceNotice(`Reload failed: ${this.rpcErrorMessage(error)}`, 'error');
        } finally {
            if (button) {
                this.restoreActionButton(button, label);
            }
        }
    }

    private async revertHistoryTransaction(txId: string, historyCwd: string | undefined, button: HTMLElement): Promise<void> {
        const label = button.textContent || 'Revert';
        this.setActionButtonBusy(button, 'Reverting...', true);
        try {
            const res = await this.sendRpcToDaemonAsync('history/revert', { id: txId, cwd: historyCwd });
            if (res?.status === 'error') {
                throw new Error(res.error || 'History revert failed.');
            }
            const message = res?.message || `Successfully reverted history transaction ${txId}`;
            button.textContent = 'Reverted';
            button.style.opacity = '0.7';
            if (button instanceof HTMLButtonElement) {
                button.disabled = true;
            }
            this.appendMessage('system', message);

            if (this.historyContainer && this.historyContainer.style.display === 'flex') {
                const rpcId = this.sendRpcToDaemon('history/list', { limit: 50, cwd: historyCwd });
                if (rpcId && historyCwd) {
                    this.historyListCwdByRpcId.set(rpcId, historyCwd);
                }
            }
        } catch (error) {
            this.restoreActionButton(button, label);
            this.appendMessage('system', `History revert failed: ${this.rpcErrorMessage(error)}`);
        }
    }

    private withWorkspaceParams(params: any = {}): any {
        const rpcParams = params && typeof params === 'object' ? { ...params } : {};
        const cwd = typeof rpcParams.cwd === 'string' && rpcParams.cwd.trim()
            ? rpcParams.cwd.trim()
            : this.resolveRpcCwd(rpcParams);
        if (cwd) {
            rpcParams.cwd = cwd;
        }
        return rpcParams;
    }

    private refreshDaemonWorkspaceAndProviders(): void {
        const workspacePath = this.resolveRpcCwd({});
        if (workspacePath) {
            this.sendRpcToDaemon('set_workspace', { path: workspacePath });
        }
        this.sendRpcToDaemon('providers/list', {});
    }

    private async refreshDaemonWorkspaceProvidersAndState(): Promise<void> {
        const workspacePath = await this.resolveMissionControlWorkspaceCwd();
        if (workspacePath) {
            try {
                await this.sendRpcToDaemonAsync('set_workspace', { path: workspacePath });
                this.missionControlLoadedWorkspaceKey = '';
            } catch (error) {
                if (this.devMode) {
                    console.warn('[Aixlarity] Failed to sync daemon workspace before state restore:', error);
                }
            }
        }
        this.sendRpcToDaemon('providers/list', {});
        await this.restoreAgentWorkspaceStateFromDaemon();
    }

    private async resolveMissionControlWorkspaceCwd(): Promise<string | undefined> {
        const workspace = this.workspaceContextService.getWorkspace();
        if (workspace.folders.length <= 1) {
            return this.resolveRpcCwd({});
        }

        // Mission Control mirrors Antigravity's recoverable-task model. In multi-root
        // windows, prefer the folder that already owns durable task/artifact state.
        for (const folder of workspace.folders) {
            if (folder.uri.scheme !== 'file') {
                continue;
            }
            try {
                if (await this.fileService.exists(URI.joinPath(folder.uri, '.aixlarity', 'state', 'mission_control.json'))) {
                    return folder.uri.fsPath;
                }
            } catch {
                // Fall back to the normal active-file/first-folder resolution below.
            }
        }

        return this.resolveRpcCwd({});
    }

    private resolveRpcCwd(params: any = {}): string | undefined {
        const candidates: string[] = [];
        if (typeof params.path === 'string' && this.isAbsoluteFsPath(params.path)) {
            candidates.push(params.path);
        }
        const activeFile = params.ide_context?.active_file;
        if (typeof activeFile === 'string' && this.isAbsoluteFsPath(activeFile)) {
            candidates.push(activeFile);
        }
        const activeEditorPath = this.getActiveEditorFsPath();
        if (activeEditorPath) {
            candidates.push(activeEditorPath);
        }

        for (const candidate of candidates) {
            const folder = this.workspaceFolderForFsPath(candidate);
            if (folder) {
                return folder;
            }
        }

        const workspace = this.workspaceContextService.getWorkspace();
        return workspace.folders.length > 0 ? workspace.folders[0].uri.fsPath : undefined;
    }

    private isAbsoluteFsPath(path: string): boolean {
        return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
    }

    private workspaceFolderForFsPath(fsPath: string): string | undefined {
        const normalizedPath = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
        const workspace = this.workspaceContextService.getWorkspace();
        let best: string | undefined;
        for (const folder of workspace.folders) {
            const folderPath = folder.uri.fsPath;
            const normalizedFolder = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
            if (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`)) {
                if (!best || normalizedFolder.length > best.replace(/\\/g, '/').replace(/\/+$/, '').length) {
                    best = folderPath;
                }
            }
        }
        return best;
    }

    private createHistoryUri(hash: string, basename: string, cwd?: string): URI {
        return URI.from({
            scheme: 'aixlarity-history',
            authority: hash,
            path: '/' + basename,
            query: cwd ? encodeURIComponent(cwd) : undefined
        });
    }

    private createDiffSnapshotUri(kind: 'before' | 'after', artifactId: string, filePath: string, content: string): URI {
        const basename = this.basename(filePath) || 'snapshot.txt';
        const safeName = basename.replace(/[\\/:?#]+/g, '-');
        const authority = this.stableId(kind, artifactId, String(Date.now()), String(this.diffSnapshotDocuments.size));
        const uri = URI.from({
            scheme: 'aixlarity-diff-snapshot',
            authority,
            path: '/' + safeName,
        });
        this.diffSnapshotDocuments.set(this.diffSnapshotDocumentKey(uri), {
            content: this.truncateForDisplay(content, this.diffSnapshotDocumentBodyLimit, 'diff snapshot'),
            path: filePath,
        });
        while (this.diffSnapshotDocuments.size > this.diffSnapshotDocumentLimit) {
            const oldest = this.diffSnapshotDocuments.keys().next().value;
            if (!oldest) break;
            this.diffSnapshotDocuments.delete(oldest);
        }
        return uri;
    }

    private diffSnapshotDocumentKey(resource: URI): string {
        return `${resource.authority}${resource.path}`;
    }

    private historyCwdFromUri(resource: URI): string | undefined {
        if (!resource.query) {
            return undefined;
        }
        try {
            const decoded = decodeURIComponent(resource.query);
            return decoded && this.isAbsoluteFsPath(decoded) ? decoded : undefined;
        } catch {
            return undefined;
        }
    }

    private getActiveEditorFsPath(): string | undefined {
        try {
            const activeEditorPane = this.editorService.activeEditorPane;
            const control = activeEditorPane?.getControl();
            const model = control && typeof (control as any).getModel === 'function'
                ? (control as any).getModel()
                : null;
            const uri = model?.uri;
            if (uri?.scheme === 'file') {
                return uri.fsPath || uri.path;
            }
        } catch (error) {
            console.error('Failed to resolve active editor workspace', error);
        }
        return undefined;
    }

    private getActiveEditorContext(): { active_file: string | null; cursor_line: number | null; selected_text: string | null } {
        try {
            const activeEditorPane = this.editorService.activeEditorPane;
            const control = activeEditorPane?.getControl();
            const model = control && typeof (control as any).getModel === 'function'
                ? (control as any).getModel()
                : null;
            const uri = model?.uri;
            if (uri?.scheme !== 'file') {
                return { active_file: null, cursor_line: null, selected_text: null };
            }

            let cursor_line: number | null = null;
            if (control && typeof (control as any).getPosition === 'function') {
                const position = (control as any).getPosition();
                if (position) {
                    cursor_line = position.lineNumber;
                }
            }

            let selected_text: string | null = null;
            if (control && typeof (control as any).getSelection === 'function' && typeof model.getValueInRange === 'function') {
                const selection = (control as any).getSelection();
                if (selection && !selection.isEmpty()) {
                    const selectionText: string = model.getValueInRange(selection);
                    const maxSelectedTextChars = 20000;
                    selected_text = selectionText.length > maxSelectedTextChars
                        ? selectionText.slice(0, maxSelectedTextChars) + '\n[Selection truncated by Aixlarity IDE]'
                        : selectionText;
                }
            }

            return {
                active_file: uri.fsPath || uri.path,
                cursor_line,
                selected_text
            };
        } catch (error) {
            console.error('Failed to get active editor context', error);
            return { active_file: null, cursor_line: null, selected_text: null };
        }
    }

    private collectProblemDiagnostics(markerService: any): string {
        if (!markerService || typeof markerService.read !== 'function') {
            return '';
        }
        const activeResource = this.editorService.activeEditor?.resource;
        let markers: any[] = [];
        if (activeResource) {
            markers = markerService.read({ resource: activeResource, take: 80 }) || [];
        }
        if (markers.length === 0) {
            markers = markerService.read({ take: 120 }) || [];
        }
        if (markers.length === 0) {
            return '';
        }

        const lines = ['# IDE Problems'];
        for (const marker of markers.slice(0, 120)) {
            const severity = this.markerSeverityLabel(marker.severity);
            const resource = marker.resource?.fsPath || marker.resource?.path || String(marker.resource || '');
            const source = marker.source ? ` [${marker.source}]` : '';
            const code = marker.code
                ? ` (${typeof marker.code === 'string' ? marker.code : marker.code.value})`
                : '';
            lines.push(`- ${severity}${source}${code} ${resource}:${marker.startLineNumber}:${marker.startColumn} - ${marker.message}`);
        }
        if (markers.length > 120) {
            lines.push(`- [Aixlarity] ${markers.length - 120} additional diagnostics omitted.`);
        }
        return this.truncateForDisplay(lines.join('\n'), 30000, 'diagnostics');
    }

    private markerSeverityLabel(severity: number): string {
        if (severity === 8) return 'Error';
        if (severity === 4) return 'Warning';
        if (severity === 2) return 'Info';
        if (severity === 1) return 'Hint';
        return 'Problem';
    }

	    private shouldTrackHistoryPath(fsPath: string): boolean {
	        if (!fsPath) {
	            return false;
	        }
	        const normalized = fsPath.replace(/\\/g, '/');
	        if (this.historyIgnoredPathSegments.some(segment => normalized.includes(segment))) {
	            return false;
	        }
	        const fileName = (normalized.split('/').pop() || '').toLowerCase();
	        if (!fileName || this.historyIgnoredFileNames.has(fileName)) {
	            return false;
	        }
	        const dotIndex = fileName.lastIndexOf('.');
	        const extension = dotIndex > 0 ? fileName.slice(dotIndex) : '';
	        if (extension && this.historyIgnoredExtensions.has(extension)) {
	            return false;
	        }

	        const workspace = this.workspaceContextService.getWorkspace();
	        if (workspace.folders.length === 0) {
	            return true;
	        }
        return workspace.folders.some(folder => {
            const root = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
            return normalized === root || normalized.startsWith(`${root}/`);
        });
    }

    private queueHistoryTrack(fsPath: string, source: string): void {
        if (!this.shouldTrackHistoryPath(fsPath)) {
            return;
        }
	        const existing = this.historyTrackQueue.get(fsPath);
	        this.historyTrackQueue.set(fsPath, existing === 'user' ? 'user' : source);
	        while (this.historyTrackQueue.size > this.historyTrackMaxQueueSize) {
	            const oldest = this.historyTrackQueue.keys().next().value;
	            if (!oldest) {
	                break;
	            }
	            this.historyTrackQueue.delete(oldest);
	        }
	        this.scheduleHistoryTrackFlush();
	    }

    private scheduleHistoryTrackFlush(): void {
        if (this.historyTrackTimer) {
            return;
        }
        this.historyTrackTimer = setTimeout(() => {
            this.historyTrackTimer = null;
            this.flushHistoryTrackQueue();
        }, 750);
    }

    private flushHistoryTrackQueue(): void {
        if (!this.daemonConnected || this.historyTrackQueue.size === 0) {
            return;
        }
	        const batch = Array.from(this.historyTrackQueue.entries()).slice(0, this.historyTrackBatchSize);
        for (const [path, source] of batch) {
            this.historyTrackQueue.delete(path);
            this.sendRpcToDaemon('history/track', { path, source });
        }
        if (this.historyTrackQueue.size > 0) {
            this.scheduleHistoryTrackFlush();
        }
    }

    private rejectPendingRequests(error: Error): void {
        for (const request of this.pendingRequests.values()) {
            if (request.timer) {
                clearTimeout(request.timer);
            }
            request.reject(error);
        }
        this.pendingRequests.clear();
    }

    private handleDaemonStatus(params: any): void {
        const status = typeof params?.status === 'string' ? params.status : 'unknown';
        const message = typeof params?.message === 'string' ? params.message : '';
        const statusKey = `${status}:${message}`;
        const isRepeatedStatus = this.lastDaemonStatus === statusKey;
        this.lastDaemonStatus = statusKey;

        if (status === 'starting') {
            this.daemonConnected = false;
            if (this.msTextRef) {
                this.msTextRef.textContent = ' Starting...';
            }
            if (this.inputElement) {
                this.inputElement.disabled = true;
                this.inputElement.placeholder = 'Starting Aixlarity daemon...';
            }
            return;
        }

        if (status === 'ready') {
            this.daemonConnected = true;
            if (this.msTextRef && !isRepeatedStatus) {
                this.msTextRef.textContent = ' Loading...';
            }
            if (this.inputElement) {
                this.inputElement.disabled = false;
                this.inputElement.placeholder = 'Ask anything, @ to mention, / for workflows';
            }
            if (!isRepeatedStatus) {
                void this.refreshDaemonWorkspaceProvidersAndState();
                void this.syncAixlarityTrustAfterDaemonReady();
            }
            this.flushHistoryTrackQueue();
            return;
        }

        if (status === 'exited' || status === 'error') {
            this.daemonConnected = false;
            this.updateSendButtonState(false);
            this.removeLoadingIndicator();
            this.activeStreamRole = null;
            this.activeStreamNode = null;
            this.activeStreamText = '';
            this.activeRpcId = null;
            this.rpcToConversation.clear();
            this.rpcMethodById.clear();
            this.stoppedRpcIds.clear();
            this.historyListCwdByRpcId.clear();
            this.rejectPendingRequests(new Error(message || 'Aixlarity daemon is unavailable'));
            if (this.msTextRef) {
                this.msTextRef.textContent = status === 'error' ? ' Daemon Error' : ' No Daemon';
            }
            if (this.inputElement) {
                this.inputElement.disabled = true;
                this.inputElement.placeholder = message || 'Aixlarity daemon is unavailable.';
            }
            if (!isRepeatedStatus || this.devMode) {
                this.appendMessage('system', message || 'Aixlarity daemon is unavailable.');
            }
        }
    }

    private rememberRpcMethod(rpcId: string, method: string): void {
        this.rpcMethodById.set(rpcId, method);
        while (this.rpcMethodById.size > 500) {
            const oldest = this.rpcMethodById.keys().next().value;
            if (!oldest) {
                break;
            }
            this.rpcMethodById.delete(oldest);
        }
    }

    private sendRpcToDaemon(method: string, params: any = {}): string {
        if (!ipcRenderer || !ipcRenderer.send) {
            this.handleDaemonStatus({ status: 'error', message: 'Daemon IPC is unavailable.' });
            return '';
        }
        const rpcParams = this.withWorkspaceParams(params);

        const rpcId = Date.now().toString() + "_" + Math.random().toString(36).substr(2, 5);
        const payload = {
            jsonrpc: "2.0",
            method,
            params: rpcParams,
            id: rpcId
        };

        try {
            ipcRenderer.send('vscode:aixlarity:daemonIn', JSON.stringify(payload) + '\n');
            this.rememberRpcMethod(rpcId, method);
        } catch (error) {
            this.handleDaemonStatus({ status: 'error', message: error instanceof Error ? error.message : 'Failed to send RPC to daemon.' });
            return '';
        }
        return rpcId;
    }

    private sendRpcToDaemonAsync(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!ipcRenderer || !ipcRenderer.send) {
                return reject(new Error('No ipcRenderer available'));
            }
            const rpcParams = this.withWorkspaceParams(params);
            const id = Date.now().toString() + "_" + Math.random().toString(36).substr(2, 5);
            const payload = {
                jsonrpc: "2.0",
                method,
                params: rpcParams,
                id
            };
            const timeoutMs = 30000;
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    this.rpcMethodById.delete(id);
                    reject(new Error(`RPC Timeout: ${method}`));
                }
            }, timeoutMs);
            this.pendingRequests.set(id, {resolve, reject, timer});
            try {
                ipcRenderer.send('vscode:aixlarity:daemonIn', JSON.stringify(payload) + '\n');
                this.rememberRpcMethod(id, method);
            } catch (error) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                this.rpcMethodById.delete(id);
                reject(error);
            }
        });
    }

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.aixlarityWrapper) {
			this.aixlarityWrapper.style.height = `${height}px`;
			this.aixlarityWrapper.style.width = `${width}px`;
		}
	}

    // --- Conversation Management ---

    private createConversation(): string {
        const id = `conv-${Date.now()}`;
        let initialProvider = '';
        let initialLabel = '';
        if (this.activeConversationId) {
            const active = this.conversations.find(c => c.id === this.activeConversationId);
            if (active && active.selectedProviderId) {
                initialProvider = active.selectedProviderId;
                initialLabel = active.selectedProviderLabel || active.selectedProviderId;
            }
            // Save current conversation's DOM + stream state before switching away
            const currentConv = this.conversations.find(c => c.id === this.activeConversationId) as any;
            if (currentConv && this.chatContainer) {
                const offscreen = this.getConvOffscreen(currentConv);
                while (this.chatContainer.firstChild) {
                    offscreen.appendChild(this.chatContainer.firstChild);
                }
                currentConv._streamState = this.captureStreamState();
            }
        }
        // If no active conversation had a selection, use whatever the msText currently shows
        if (!initialProvider && this.msTextRef) {
            initialLabel = this.msTextRef.textContent || '';
        }
        this.conversations.push({ id, title: 'New Chat', backendSessionId: null, messages: [], selectedProviderId: initialProvider || undefined, selectedProviderLabel: initialLabel || undefined });
        this.activeConversationId = id;
        // New conversation is idle — reset stream state and send button
        this.restoreStreamState(null);
        this.updateSendButtonState(false);
        return id;
    }

    private rebuildConversationBar(): void {
        if (!this.conversationBar) return;
        this.conversationBar.textContent = '';

        for (let i = 0; i < this.conversations.length; i++) {
            const conv = this.conversations[i];
            const pill = append(this.conversationBar, $('span.aixlarity-conv-pill', { style: 'display: flex; align-items: center; gap: 4px;' }));
            append(pill, $('span')).textContent = conv.title;

            const closeBtn = append(pill, $('span.codicon.codicon-close', { style: 'font-size: 10px; opacity: 0.6; padding: 2px; border-radius: 4px;' }));
            closeBtn.onmouseover = () => { closeBtn.style.background = 'rgba(255,255,255,0.2)'; closeBtn.style.opacity = '1'; };
            closeBtn.onmouseout = () => { closeBtn.style.background = 'transparent'; closeBtn.style.opacity = '0.6'; };

            if (conv.id === this.activeConversationId) {
                pill.classList.add('active');
            }
            pill.addEventListener('click', (e) => {
                if (e.target === closeBtn) {
                   e.stopPropagation();
                   if (conv.backendSessionId) {
                       this.sendRpcToDaemon('sessions/remove', { id: conv.backendSessionId });
                   }
                   this.conversations.splice(i, 1);
                   if (this.conversations.length === 0) {
                       this.createConversation();
                       if (this.chatContainer) {
                           this.chatContainer.textContent = '';
                           const welcomeEl = append(this.chatContainer, $('div.aixlarity-welcome'));
                           welcomeEl.textContent = 'New conversation started.';
                       }
                   } else if (this.activeConversationId === conv.id) {
                       this.switchConversation(this.conversations[this.conversations.length-1].id);
                   }
                   this.rebuildConversationBar();
                   return;
                }
                this.switchConversation(conv.id);
            });
        }

        // "+" new conversation button
        const newBtn = append(this.conversationBar, $('span.aixlarity-conv-new'));
        append(newBtn, $('span.codicon.codicon-add', { style: 'font-size: 10px;' }));
        append(newBtn, $('span')).textContent = 'New';
        newBtn.addEventListener('click', () => {
            this.createConversation();
            // Clear chat for new conversation
            if (this.chatContainer) {
                this.chatContainer.textContent = '';
                const welcomeEl = append(this.chatContainer, $('div.aixlarity-welcome'));
                welcomeEl.textContent = 'New conversation started.';
            }
            // Reset tracking
            this.changedFiles.clear();
            this.sessionArtifacts = [];
            this.updateBottomStatus();
            this.rebuildConversationBar();
        });

        // Manager pill (Fleet)
        const mgrPill = append(this.conversationBar, $('span.aixlarity-conv-pill', { style: 'margin-left: auto;' }));
        mgrPill.setAttribute('data-aixlarity-nav', 'fleet');
        append(mgrPill, $('span.codicon.codicon-organization', { style: 'font-size: 11px; margin-right: 2px;' }));
        const mgrLabel = document.createElement('span');
        mgrLabel.textContent = 'Fleet';
        mgrPill.appendChild(mgrLabel);

        // Settings pill
        const setPill = append(this.conversationBar, $('span.aixlarity-conv-pill', { style: 'margin-left: 2px;' }));
        setPill.setAttribute('data-aixlarity-nav', 'settings');
        setPill.title = 'Settings';
        append(setPill, $('span.codicon.codicon-settings-gear', { style: 'font-size: 11px; margin-right: 2px;' }));

        mgrPill.addEventListener('click', () => {
            const isManager = this.fleetContainer.style.display === 'flex';
            if (isManager) {
                // Return to Chat
                this.switchConversation(this.activeConversationId);
            } else {
                this.chatContainer.style.display = 'none';
                this.inputWrapper.style.display = 'none';
                this.bottomStatusBar.style.display = 'none';
                this.settingsContainer.style.display = 'none';
                this.historyContainer.style.display = 'none';
                this.fleetContainer.style.display = 'flex';
                mgrPill.classList.add('active');
                setPill.classList.remove('active');
                const p = this.conversationBar.querySelector('.aixlarity-hist-pill');
                if (p) p.classList.remove('active');

                this.conversationBar.querySelectorAll('.aixlarity-conv-pill').forEach(pill => {
                    if (pill !== mgrPill && pill !== setPill && !pill.classList.contains('aixlarity-hist-pill')) pill.classList.remove('active');
                });

                if (this.devMode) {
                    console.warn('[Aixlarity DIAG] Opening Agent Manager v2');
                }
                this.requestAgentManagerRefresh();
            }
        });

        const histPill = append(this.conversationBar, $('span.aixlarity-conv-pill.aixlarity-hist-pill', { style: 'margin-left: 2px;' }));
        histPill.setAttribute('data-aixlarity-nav', 'history');
        append(histPill, $('span.codicon.codicon-history', { style: 'font-size: 11px; margin-right: 2px;' }));

        histPill.addEventListener('click', () => {
            const isHistory = this.historyContainer.style.display === 'flex';
            if (isHistory) {
                this.switchConversation(this.activeConversationId);
            } else {
                this.chatContainer.style.display = 'none';
                this.inputWrapper.style.display = 'none';
                this.bottomStatusBar.style.display = 'none';
                this.settingsContainer.style.display = 'none';
                this.fleetContainer.style.display = 'none';
                this.historyContainer.style.display = 'flex';
                histPill.classList.add('active');
                mgrPill.classList.remove('active');
                setPill.classList.remove('active');

                this.conversationBar.querySelectorAll('.aixlarity-conv-pill').forEach(pill => {
                    if (pill !== mgrPill && pill !== setPill && pill !== histPill) pill.classList.remove('active');
                });

                this.historyContainer.textContent = '';
                const historyLoading = append(this.historyContainer, $('div', { style: 'opacity: 0.6; font-size: 12px; text-align: center; padding: 20px;' }));
                historyLoading.textContent = 'Loading local history...';
                if (ipcRenderer) {
                    const cwd = this.resolveRpcCwd({});
                    const rpcId = this.sendRpcToDaemon('history/list', { limit: 50, cwd });
                    if (rpcId && cwd) {
                        this.historyListCwdByRpcId.set(rpcId, cwd);
                    }
                    if (!rpcId) {
                        historyLoading.style.color = '#f87171';
                        historyLoading.textContent = 'Unable to load local history. The daemon is unavailable.';
                    }
                } else {
                    historyLoading.style.color = '#f87171';
                    historyLoading.textContent = 'Unable to load local history. IPC is unavailable.';
                }
            }
        });

        setPill.addEventListener('click', () => {
            const isSettings = this.settingsContainer.style.display === 'flex';
            if (isSettings) {
                // Return to Chat
                this.switchConversation(this.activeConversationId);
            } else {
                this.showSettingsDashboard(setPill);
            }
        });
    }



    private resolveWorkspaceFilePath(path: string): string {
        if (!path.startsWith('./')) {
            return path;
        }
        const workspacePath = this.resolveRpcCwd({}) || '';
        return workspacePath ? `${workspacePath}/${path.slice(2)}` : path;
    }

    renderCliConfigDetail(container: HTMLElement, cli: any): void {
        const self = this;

        // Scope selector (User vs Project)
        const scopeRow = append(container, $('div', { style: 'display: flex; gap: 6px; margin-bottom: 10px;' }));

        const userBtn = append(scopeRow, $('button.aixlarity-action-button', { style: 'flex: 1; font-size: 11px; justify-content: center;' }));
        userBtn.textContent = '👤 User (~/)';
        userBtn.classList.add('primary');

        const projBtn = append(scopeRow, $('button.aixlarity-action-button', { style: 'flex: 1; font-size: 11px; justify-content: center;' }));
        projBtn.textContent = '📁 Project (./)';

        const contentArea = append(container, $('div'));

        const loadConfig = (scope: string) => {
            userBtn.classList.toggle('primary', scope === 'user');
            projBtn.classList.toggle('primary', scope === 'project');
            userBtn.style.opacity = scope === 'user' ? '1' : '0.6';
            projBtn.style.opacity = scope === 'project' ? '1' : '0.6';

            contentArea.textContent = '';
            const loadingEl = append(contentArea, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px;' }));
            loadingEl.textContent = '⏳ Loading config...';

            self.sendRpcToDaemonAsync('external-cli/read', { cli: cli.cli, scope }).then((res: any) => {
                contentArea.textContent = '';
                if (res && res.status === 'success') {
                    if (res.format === 'json') {
                        self.renderJsonConfigEditor(contentArea, cli, scope, res.content);
                    } else {
                        self.renderRawConfigEditor(contentArea, cli, scope, res.content);
                    }
                } else {
                    append(contentArea, $('div', { style: 'color: #ff6b6b; font-size: 11px;' })).textContent = `Error: ${res?.error || 'Unknown error'}`;
                }
            }).catch((error: unknown) => {
                contentArea.textContent = '';
                append(contentArea, $('div', { style: 'color: #ff6b6b; font-size: 11px;' })).textContent = `Failed to read config: ${self.rpcErrorMessage(error)}`;
            });
        };

        userBtn.addEventListener('click', () => loadConfig('user'));
        projBtn.addEventListener('click', () => loadConfig('project'));

        // Instruction file button
        if (cli.instruction_file) {
            append(container, $('div', { style: 'height: 8px;' }));
            const instrRow = append(container, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
            const instrBtn = append(instrRow, $('button.aixlarity-action-button'));
            const instrFileName = cli.instruction_file.split('/').pop() || 'instructions';
            instrBtn.textContent = `📄 Open ${instrFileName}`;
            instrBtn.addEventListener('click', () => {
                const uri = URI.file(self.resolveWorkspaceFilePath(cli.instruction_file));
                self.editorService.openEditor({ resource: uri });
            });

            if (!cli.instruction_file_exists) {
                const createBtn = append(instrRow, $('button.aixlarity-action-button')) as HTMLButtonElement;
                createBtn.textContent = `✨ Create ${instrFileName}`;
                createBtn.addEventListener('click', () => {
                    // Create a minimal instruction file
                    const defaultContent = cli.cli === 'claude'
                        ? '# Project Context\n\n## Coding Standards\n- Describe your coding standards here.\n\n## Common Commands\n- Build: `npm run build`\n- Test: `npm test`\n'
                        : cli.cli === 'gemini'
                        ? '# Project Context\n\n## General Instructions\n- Describe your project and coding standards here.\n\n## Context\n- Main entry point: `src/index.ts`\n'
                        : '# Project Instructions\n\n## Development\n- Describe your project conventions here.\n';

                    createBtn.disabled = true;
                    createBtn.textContent = 'Creating...';
                    self.sendRpcToDaemonAsync('external-cli/write-instruction', {
                        cli: cli.cli,
                        content: defaultContent
                    }).then((res: any) => {
                        if (res && res.status === 'success' && res.path) {
                            createBtn.textContent = '✅ Created!';
                            createBtn.style.opacity = '0.6';
                            const uri = URI.file(res.path);
                            self.editorService.openEditor({ resource: uri });
                            return;
                        }
                        createBtn.disabled = false;
                        createBtn.textContent = '❌ Failed';
                    }).catch((error: unknown) => {
                        createBtn.disabled = false;
                        createBtn.textContent = '❌ Failed';
                        createBtn.title = self.rpcErrorMessage(error);
                    });
                });
            }
        }

        // Auto-load user config on first render
        loadConfig('user');
    }

    private renderJsonConfigEditor(container: HTMLElement, cli: any, scope: string, rawContent: string): void {
        const self = this;
        let config: any = {};
        try {
            config = JSON.parse(rawContent);
        } catch {
            // Fall back to raw editor if JSON is malformed
            this.renderRawConfigEditor(container, cli, scope, rawContent);
            return;
        }

        // --- Model field (common to all JSON CLIs) ---
        const modelRow = append(container, $('div', { style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;' }));
        append(modelRow, $('label', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 50px;' })).textContent = 'Model';
        const modelInput = append(modelRow, $<HTMLInputElement>('input', {
            type: 'text',
            value: config.model || '',
            placeholder: cli.cli === 'claude' ? 'claude-4-7-opus-20260416' : cli.cli === 'gemini' ? 'gemini-3.1-pro' : 'gpt-5.5-turbo',
            style: 'flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; font-size: 11px; font-family: var(--vscode-editor-font-family); outline: none;'
        }));
        modelInput.addEventListener('change', () => {
            config.model = modelInput.value;
        });

        // --- Claude-specific: permissions ---
        if (cli.cli === 'claude') {
            append(container, $('div', { style: 'height: 6px;' }));
            const permHeader = append(container, $('div', { style: 'font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px;' }));
            permHeader.textContent = 'Permissions';

            if (!config.permissions) config.permissions = { allow: [], deny: [] };

            for (const key of ['allow', 'deny'] as const) {
                const permRow = append(container, $('div', { style: 'display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px;' }));
                const label = append(permRow, $('label', { style: `font-size: 10px; min-width: 36px; padding-top: 6px; color: ${key === 'allow' ? '#4ade80' : '#f87171'};` }));
                label.textContent = key === 'allow' ? '✅ Allow' : '🚫 Deny';
                const textarea = append(permRow, $<HTMLTextAreaElement>('textarea', {
                    style: 'flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; font-size: 10px; font-family: var(--vscode-editor-font-family); min-height: 36px; resize: vertical; outline: none;',
                    placeholder: 'e.g. Bash(npm test), Read(./src/**)'
                }));
                textarea.value = (config.permissions[key] || []).join('\n');
                textarea.addEventListener('change', () => {
                    config.permissions[key] = textarea.value.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
                });
            }
        }

        // --- Gemini-specific: theme ---
        if (cli.cli === 'gemini') {
            append(container, $('div', { style: 'height: 6px;' }));
            const themeRow = append(container, $('div', { style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;' }));
            append(themeRow, $('label', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 50px;' })).textContent = 'Theme';
            const themeSelect = append(themeRow, $<HTMLSelectElement>('select', {
                style: 'flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; font-size: 11px; outline: none;'
            }));
            for (const t of ['dark', 'light', 'auto']) {
                const opt = append(themeSelect, $<HTMLOptionElement>('option'));
                opt.value = t;
                opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
                if (config.theme === t) opt.selected = true;
            }
            themeSelect.addEventListener('change', () => {
                config.theme = themeSelect.value;
            });
        }

        // --- Save button ---
        append(container, $('div', { style: 'height: 8px;' }));
        const saveRow = append(container, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
        const saveBtn = append(saveRow, $('button.aixlarity-action-button.primary', { style: 'font-size: 11px;' }));
        saveBtn.textContent = '💾 Save Config';
        const statusEl = append(saveRow, $('span', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' }));

        saveBtn.addEventListener('click', () => {
            const jsonStr = JSON.stringify(config, null, 2);
            saveBtn.textContent = '⏳ Saving...';
            self.sendRpcToDaemonAsync('external-cli/write', {
                cli: cli.cli,
                scope: scope,
                content: jsonStr
            }).then((res: any) => {
                if (res && res.status === 'success') {
                    saveBtn.textContent = '✅ Saved!';
                    statusEl.textContent = `→ ${res.path}`;
                    setTimeout(() => { saveBtn.textContent = '💾 Save Config'; }, 2000);
                } else {
                    saveBtn.textContent = '❌ Error';
                    statusEl.textContent = res?.error || 'Unknown error';
                    statusEl.style.color = '#f87171';
                }
            }).catch((error: unknown) => {
                saveBtn.textContent = '❌ Failed';
                statusEl.textContent = self.rpcErrorMessage(error);
                statusEl.style.color = '#f87171';
            });
        });

        // --- Raw JSON toggle (for advanced users) ---
        append(container, $('div', { style: 'height: 6px;' }));
        const rawToggle = append(container, $('div', { style: 'font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; user-select: none;' }));
        rawToggle.textContent = '▶ Show raw JSON';
        const rawArea = append(container, $<HTMLTextAreaElement>('textarea', {
            style: 'display: none; width: 100%; min-height: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; font-size: 10px; font-family: var(--vscode-editor-font-family); resize: vertical; margin-top: 4px; box-sizing: border-box; outline: none;'
        }));
        rawArea.value = JSON.stringify(config, null, 2);

        rawToggle.addEventListener('click', () => {
            const isVisible = rawArea.style.display !== 'none';
            rawArea.style.display = isVisible ? 'none' : 'block';
            rawToggle.textContent = isVisible ? '▶ Show raw JSON' : '▼ Hide raw JSON';
            if (!isVisible) rawArea.value = JSON.stringify(config, null, 2);
        });
    }

    private renderRawConfigEditor(container: HTMLElement, cli: any, scope: string, content: string): void {
        const self = this;

        const formatLabel = append(container, $('div', { style: 'font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;' }));
        formatLabel.textContent = `Format: ${cli.config_format?.toUpperCase() || 'TEXT'} — Edit directly below`;

        const textarea = append(container, $<HTMLTextAreaElement>('textarea', {
            style: 'width: 100%; min-height: 160px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; font-size: 11px; font-family: var(--vscode-editor-font-family); resize: vertical; box-sizing: border-box; outline: none;',
        }));
        textarea.value = content;

        append(container, $('div', { style: 'height: 8px;' }));
        const saveRow = append(container, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
        const saveBtn = append(saveRow, $('button.aixlarity-action-button.primary', { style: 'font-size: 11px;' }));
        saveBtn.textContent = '💾 Save Config';
        const statusEl = append(saveRow, $('span', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' }));

        saveBtn.addEventListener('click', () => {
            saveBtn.textContent = '⏳ Saving...';
            self.sendRpcToDaemonAsync('external-cli/write', {
                cli: cli.cli,
                scope: scope,
                content: textarea.value
            }).then((res: any) => {
                if (res && res.status === 'success') {
                    saveBtn.textContent = '✅ Saved!';
                    statusEl.textContent = `→ ${res.path}`;
                    setTimeout(() => { saveBtn.textContent = '💾 Save Config'; }, 2000);
                } else {
                    saveBtn.textContent = '❌ Error';
                    statusEl.textContent = res?.error || 'Unknown error';
                    statusEl.style.color = '#f87171';
                }
            }).catch((error: unknown) => {
                saveBtn.textContent = '❌ Failed';
                statusEl.textContent = self.rpcErrorMessage(error);
                statusEl.style.color = '#f87171';
            });
        });
    }

    private switchConversation(id: string): void {
        // Save and restore DOM + per-conversation stream state
        if (id !== this.activeConversationId) {
            // Save current conversation: move chatContainer children to off-screen
            const currentConv = this.conversations.find(c => c.id === this.activeConversationId) as any;
            if (currentConv && this.chatContainer) {
                const offscreen = this.getConvOffscreen(currentConv);
                while (this.chatContainer.firstChild) {
                    offscreen.appendChild(this.chatContainer.firstChild);
                }
                currentConv._streamState = this.captureStreamState();
            }

            this.activeConversationId = id;

            // Restore target conversation: move off-screen children to chatContainer
            const targetConv = this.conversations.find(c => c.id === id) as any;
            if (this.chatContainer) {
                this.chatContainer.textContent = '';
                if (targetConv) {
                    const offscreen = this.getConvOffscreen(targetConv);
                    while (offscreen.firstChild) {
                        this.chatContainer.appendChild(offscreen.firstChild);
                    }
                    this.restoreStreamState(targetConv._streamState);
                } else {
                    const welcomeEl = append(this.chatContainer, $('div.aixlarity-welcome'));
                    welcomeEl.textContent = 'New conversation started.';
                    this.restoreStreamState(null);
                }
            }
        }

        // Always restore chat view (may be returning from Settings/Fleet/History)
        this.chatContainer.style.display = 'flex';
        this.inputWrapper.style.display = 'block';
        this.bottomStatusBar.style.display = '';
        this.fleetContainer.style.display = 'none';
        this.settingsContainer.style.display = 'none';
        this.historyContainer.style.display = 'none';

        // Sync send-button / input-box UI to this conversation's generating state.
        // Without this, switching away from a processing chat leaves the input
        // locked even though the new chat is idle.
        this.updateSendButtonState(this.isGenerating);

        this.rebuildConversationBar();

        if (this.msTextRef && this.rebuildDropdownRef) {
            const activeConv = this.conversations.find(c => c.id === this.activeConversationId);
            if (activeConv && activeConv.selectedProviderLabel) {
                this.msTextRef.textContent = activeConv.selectedProviderLabel;
            } else if (activeConv && activeConv.selectedProviderId) {
                this.msTextRef.textContent = activeConv.selectedProviderId;
            }
            this.rebuildDropdownRef();
        }

        if (this.rebuildPersonaDropdownRef) {
            this.rebuildPersonaDropdownRef();
        }
    }

    // --- Per-conversation stream state for parallel execution ---
    // Memory-optimized: each background conversation uses a persistent
    // off-screen div instead of expensive Array.from + DOM clear/re-append.

    /** Get or create the off-screen container for a conversation. */
    private getConvOffscreen(conv: any): HTMLDivElement {
        if (!conv._offscreenEl) {
            conv._offscreenEl = document.createElement('div');
            conv._offscreenEl.style.cssText = 'display:flex;flex-direction:column;';
            // Move any saved messages into the off-screen container
            if (conv.messages && conv.messages.length > 0) {
                for (const node of conv.messages) {
                    conv._offscreenEl.appendChild(node);
                }
                conv.messages = [];
            }
        }
        return conv._offscreenEl;
    }

    /** Snapshot stream state vars into a plain object (no DOM ops). */
    private captureStreamState(): any {
        return {
            role: this.activeStreamRole,
            node: this.activeStreamNode,
            text: this.activeStreamText,
            finalized: (this as any)._streamFinalized,
            lastUserNode: (this as any).lastUserMessageNode,
            loadingEl: this.loadingIndicator,
            isGenerating: this.isGenerating,
            activeRpcId: this.activeRpcId,
        };
    }

    /** Restore stream state vars from a snapshot (no DOM ops). */
    private restoreStreamState(s: any): void {
        this.activeStreamRole = s?.role ?? null;
        this.activeStreamNode = s?.node ?? null;
        this.activeStreamText = s?.text ?? '';
        (this as any)._streamFinalized = s?.finalized ?? false;
        (this as any).lastUserMessageNode = s?.lastUserNode ?? null;
        this.loadingIndicator = s?.loadingEl ?? null;
        this.isGenerating = s?.isGenerating ?? false;
        this.activeRpcId = s?.activeRpcId ?? null;
    }

    /**
     * Parallel-safe context swap (O(1), zero DOM mutations).
     * Temporarily points this.chatContainer to the target conversation's
     * off-screen div, runs fn(), then restores the original reference.
     */
    private withConversationContext(rpcId: any, fn: () => void): void {
        if (!rpcId) { fn(); return; }
        const ownerConvId = this.rpcToConversation.get(String(rpcId));
        if (!ownerConvId || ownerConvId === this.activeConversationId) {
            fn();
            return;
        }
        const targetConv = this.conversations.find(c => c.id === ownerConvId) as any;
        if (!targetConv) { fn(); return; }

        // Save current state (lightweight — just variable captures)
        const savedContainer = this.chatContainer;
        const savedStream = this.captureStreamState();

        // Swap to target's off-screen container
        this.chatContainer = this.getConvOffscreen(targetConv);
        this.restoreStreamState(targetConv._streamState);

        // Execute handler in the target's context
        fn();

        // If stream rendering was dirtied, flush immediately while
        // we're still in the target's context (prevents timer leaks)
        if (this._streamRenderDirty) {
            this._streamRenderDirty = false;
            if (this._streamRenderTimer) {
                clearTimeout(this._streamRenderTimer);
                this._streamRenderTimer = null;
            }
            this._flushStreamRender();
        }

        // Save target's updated stream state
        targetConv._streamState = this.captureStreamState();

        // Restore original (no DOM ops — just pointer + var restore)
        this.chatContainer = savedContainer;
        this.restoreStreamState(savedStream);
    }

    /**
     * For final-result payloads: swap context in and leave it swapped
     * until the finalization code completes (handled inline in IPC handler).
     */

    private _pendingFinalOriginalConvId: string | null = null;
    private _pendingFinalSavedContainer: HTMLElement | null = null;
    private _pendingFinalSavedStream: any = null;

    private _swapToConversationForFinal(rpcId: any): void {
        if (!rpcId) return;
        const ownerConvId = this.rpcToConversation.get(String(rpcId));
        if (ownerConvId && ownerConvId !== this.activeConversationId) {
            const targetConv = this.conversations.find(c => c.id === ownerConvId) as any;
            if (targetConv) {
                this._pendingFinalOriginalConvId = this.activeConversationId;
                this._pendingFinalSavedContainer = this.chatContainer;
                this._pendingFinalSavedStream = this.captureStreamState();
                this.chatContainer = this.getConvOffscreen(targetConv);
                this.restoreStreamState(targetConv._streamState);
            }
        }
        if (rpcId) {
            this.rpcToConversation.delete(String(rpcId));
            this.rpcMethodById.delete(String(rpcId));
        }
    }

    /**
     * Auto-switch for approval requests — the user must interact,
     * so we actually switch the visible tab.
     */
    private ensureConversationActive(rpcId: any): void {
        if (!rpcId) return;
        const ownerConvId = this.rpcToConversation.get(String(rpcId));
        if (ownerConvId && ownerConvId !== this.activeConversationId) {
            this.switchConversation(ownerConvId);
        }
    }

    // --- Agent Manager v2 / Artifact System v2 ---

    private managerVisible(): boolean {
        return !!this.fleetContainer && this.fleetContainer.style.display === 'flex';
    }

    private refreshAgentManagerIfVisible(): void {
        if (this.managerVisible()) {
            this.renderAgentManager();
        }
    }

    private showManagerNotice(message: string): void {
        this.managerNotice = message;
        if (this.managerNoticeTimer) {
            clearTimeout(this.managerNoticeTimer);
        }
        this.managerNoticeTimer = setTimeout(() => {
            this.managerNoticeTimer = null;
            if (this.managerNotice === message) {
                this.managerNotice = '';
                this.refreshAgentManagerIfVisible();
            }
        }, 4500);
        this.refreshAgentManagerIfVisible();
    }

    private requestAgentManagerRefresh(): void {
        this.managerLoading = true;
        this.managerError = '';
        this.renderAgentManager();
        if (!ipcRenderer) {
            this.managerLoading = false;
            this.managerError = 'IPC is unavailable.';
            this.renderAgentManager();
            return;
        }
        void (async () => {
            try {
                await this.refreshDaemonWorkspaceProvidersAndState();
                const artifactsRpcId = this.sendRpcToDaemon('artifacts/list', {});
                if (!artifactsRpcId) {
                    this.managerLoading = false;
                    this.managerError = 'Daemon is unavailable.';
                    this.renderAgentManager();
                }
            } catch (error) {
                this.managerLoading = false;
                this.managerError = `Unable to refresh Fleet: ${this.rpcErrorMessage(error)}`;
                this.renderAgentManager();
            }
        })();
    }

    private renderAgentManager(): void {
        if (!this.fleetContainer) return;
        this.fleetContainer.textContent = '';

        const rawLiveTasks = Array.from(this.agentTasks.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 50);
        const rawPendingApprovals = Array.from(this.pendingApprovals.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 30);
        const rawReviewArtifacts = Array.from(this.agentArtifacts.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 60);
        if (this.managerTab !== 'mission' && this.managerTab !== 'artifacts') {
            this.managerTab = 'mission';
        }
        const activeTasks = rawLiveTasks.filter(task => task.status === 'running' || task.status === 'queued' || task.status === 'waiting_review' || task.status === 'paused');
        const pendingApprovals = rawPendingApprovals;
        const reviewArtifacts = rawReviewArtifacts.filter(artifact => artifact.status === 'needs_review' || artifact.status === 'draft' || artifact.status === 'rejected');
        const runningCount = activeTasks.filter(t => t.status === 'running' || t.status === 'waiting_review' || t.status === 'queued').length;
        const reviewCount = activeTasks.filter(t => t.status === 'waiting_review').length + pendingApprovals.length + reviewArtifacts.length;
        const artifactCount = this.agentArtifacts.size;

        const header = append(this.fleetContainer, $('div.aixlarity-manager-header'));
        const titleBlock = append(header, $('div'));
        append(titleBlock, $('div.aixlarity-manager-title')).textContent = 'Fleet';
        append(titleBlock, $('div.aixlarity-manager-subtitle')).textContent = 'Tasks and evidence.';

        const actions = append(header, $('div.aixlarity-manager-actions'));
        const newTaskBtn = append(actions, $('button.aixlarity-action-button'));
        append(newTaskBtn, $('span.codicon.codicon-add'));
        append(newTaskBtn, $('span')).textContent = 'New';
        newTaskBtn.addEventListener('click', () => {
            this.switchConversation(this.activeConversationId);
            this.inputElement.focus();
        });

        const refreshBtn = append(actions, $('button.aixlarity-action-button'));
        append(refreshBtn, $('span.codicon.codicon-refresh'));
        append(refreshBtn, $('span')).textContent = this.managerLoading ? 'Refreshing' : 'Refresh';
        refreshBtn.addEventListener('click', () => this.requestAgentManagerRefresh());

        const exportBtn = append(actions, $('button.aixlarity-action-button'));
        exportBtn.title = 'Copy Evidence';
        append(exportBtn, $('span.codicon.codicon-json'));
        append(exportBtn, $('span')).textContent = 'Copy';
        exportBtn.addEventListener('click', () => {
            void this.copyAgentEvidenceBundle();
        });

        const stats = append(this.fleetContainer, $('div.aixlarity-metric-strip'));
        for (const [label, value] of [['Active', runningCount], ['Review', reviewCount], ['Evidence', artifactCount]] as Array<[string, number]>) {
            const item = append(stats, $('div.aixlarity-metric-item'));
            append(item, $('div.aixlarity-metric-value')).textContent = String(value);
            append(item, $('div.aixlarity-metric-label')).textContent = label;
        }

        this.renderFleetCoreTabs();

        this.renderGuidanceCard(
            this.fleetContainer,
            'aixlarity.fleet.guidance.hidden.v1',
            'Mission flow',
            ['Start task', 'Review queue', 'Inspect evidence']
        );

        if (this.managerNotice) {
            append(this.fleetContainer, $('div.aixlarity-manager-notice')).textContent = this.managerNotice;
        }

        if (this.managerError) {
            const error = append(this.fleetContainer, $('div.aixlarity-empty-state', {
                style: 'border-color: rgba(239,68,68,0.35); color: var(--vscode-errorForeground, #f87171);'
            }));
            error.textContent = this.managerError;
        } else if (this.managerLoading) {
            const loading = append(this.fleetContainer, $('div.aixlarity-empty-state'));
            loading.style.display = 'flex';
            loading.style.alignItems = 'center';
            loading.style.justifyContent = 'center';
            loading.style.gap = '8px';
            append(loading, $('span.aixlarity-refresh-spinner'));
            append(loading, $('span')).textContent = 'Refreshing Fleet...';
        }

        if (this.managerTab === 'artifacts') {
            this.renderArtifactWorkspace();
            return;
        }

        if (pendingApprovals.length > 0) {
            const approvalsHeader = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
            append(approvalsHeader, $('span')).textContent = 'Pending Approvals';
            append(approvalsHeader, $('span')).textContent = `${pendingApprovals.length}`;
            const approvalsGrid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
            for (const approval of pendingApprovals) {
                this.renderPendingApprovalCard(approvalsGrid, approval);
            }
        }

        const liveHeader = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(liveHeader, $('span')).textContent = 'Active Tasks';
        append(liveHeader, $('span')).textContent = `${activeTasks.length}`;

        const liveGrid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        if (activeTasks.length === 0) {
            const empty = append(liveGrid, $('div.aixlarity-empty-state'));
            empty.textContent = 'No active tasks.';
        } else {
            for (const task of activeTasks) {
                this.renderAgentTaskCard(liveGrid, task);
            }
        }

        const artifactsHeader = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(artifactsHeader, $('span')).textContent = 'Review Queue';
        append(artifactsHeader, $('span')).textContent = `${reviewArtifacts.length}`;
        const artifactsGrid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        if (reviewArtifacts.length === 0) {
            append(artifactsGrid, $('div.aixlarity-empty-state')).textContent = 'No artifacts waiting for review.';
        } else {
            for (const artifact of reviewArtifacts) {
                this.renderArtifactReviewCard(artifactsGrid, artifact);
            }
        }
    }

    private renderFleetCoreTabs(): void {
        const tabs = append(this.fleetContainer, $('div.aixlarity-segmented'));
        const items: Array<[AgentManagerTab, string, string]> = [
            ['mission', 'Tasks', 'list-unordered'],
            ['artifacts', 'Evidence', 'references'],
        ];
        for (const [tab, label, icon] of items) {
            const btn = append(tabs, $('button.aixlarity-segment-button'));
            btn.setAttribute('data-aixlarity-manager-tab', tab);
            btn.classList.toggle('active', this.managerTab === tab);
            append(btn, $(`span.codicon.codicon-${icon}`));
            append(btn, $('span')).textContent = label;
            btn.addEventListener('click', () => {
                this.managerTab = tab;
                this.renderAgentManager();
            });
        }
    }

    renderManagerControls(): void {
        const controls = append(this.fleetContainer, $('div', {
            style: 'display: grid; grid-template-columns: minmax(160px, 1fr) minmax(120px, auto) minmax(120px, auto) auto; gap: 8px; align-items: center; margin: 10px 0 4px;'
        }));
        const search = append(controls, $<HTMLInputElement>('input', {
            value: this.managerSearchQuery,
            placeholder: 'Search tasks, artifacts, approvals, audit...',
            style: 'width: 100%; min-width: 0; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; font-size: 12px; outline: none;'
        }));
        search.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                this.managerSearchQuery = search.value.trim();
                this.renderAgentManager();
            }
        });

        const status = append(controls, $<HTMLSelectElement>('select', {
            style: 'background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; padding: 5px 7px; font-size: 12px;'
        }));
        for (const [value, label] of [
            ['all', 'All status'],
            ['active', 'Active'],
            ['waiting_review', 'Review'],
            ['paused', 'Paused'],
            ['completed', 'Completed'],
            ['failed', 'Failed'],
            ['approved', 'Approved'],
            ['rejected', 'Rejected'],
        ]) {
            const option = append(status, $<HTMLOptionElement>('option'));
            option.value = value;
            option.textContent = label;
            option.selected = this.managerStatusFilter === value;
        }
        status.addEventListener('change', () => {
            this.managerStatusFilter = status.value;
            this.renderAgentManager();
        });

        const kind = append(controls, $<HTMLSelectElement>('select', {
            style: 'background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; padding: 5px 7px; font-size: 12px;'
        }));
        for (const [value, label] of [
            ['all', 'All kinds'],
            ['implementation_plan', 'Plan'],
            ['task_list', 'Tasks'],
            ['walkthrough', 'Walkthrough'],
            ['code_diff', 'Diff'],
            ['test_report', 'Tests'],
            ['terminal_transcript', 'Terminal'],
            ['browser_recording', 'Browser'],
            ['screenshot', 'Screenshot'],
            ['file_change', 'File'],
        ]) {
            const option = append(kind, $<HTMLOptionElement>('option'));
            option.value = value;
            option.textContent = label;
            option.selected = this.managerKindFilter === value;
        }
        kind.addEventListener('change', () => {
            this.managerKindFilter = kind.value;
            this.renderAgentManager();
        });

        const apply = append(controls, $('button.aixlarity-action-button'));
        append(apply, $('span.codicon.codicon-search'));
        append(apply, $('span')).textContent = 'Apply';
        apply.addEventListener('click', () => {
            this.managerSearchQuery = search.value.trim();
            this.renderAgentManager();
        });
    }

    renderManagerTabs(): void {
        const tabs = append(this.fleetContainer, $('div', {
            style: 'display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 10px;'
        }));
        const items: Array<[AgentManagerTab, string, string]> = [
            ['mission', 'Mission Control', 'organization'],
            ['artifacts', 'Artifacts', 'feedback'],
            ['browser', 'Browser', 'browser'],
            ['terminal', 'Terminal', 'terminal'],
            ['studio', 'Studio', 'settings-gear'],
        ];
        for (const [tab, label, icon] of items) {
            const btn = append(tabs, $('button.aixlarity-action-button'));
            btn.setAttribute('data-aixlarity-manager-tab', tab);
            btn.style.background = this.managerTab === tab
                ? 'var(--vscode-button-background)'
                : 'var(--vscode-button-secondaryBackground)';
            btn.style.color = this.managerTab === tab
                ? 'var(--vscode-button-foreground)'
                : 'var(--vscode-button-secondaryForeground)';
            append(btn, $(`span.codicon.codicon-${icon}`));
            append(btn, $('span')).textContent = label;
            btn.addEventListener('click', () => {
                this.managerTab = tab;
                this.renderAgentManager();
            });
        }
    }

    renderWorkspaceIndexSection(): void {
        const workspaces = this.managerWorkspaceIndex.length > 0 ? this.managerWorkspaceIndex : [{
            name: 'Current Workspace',
            path: this.workspaceEvidenceLabel(),
            task_count: this.agentTasks.size,
            artifact_count: this.agentArtifacts.size,
            active_task_count: Array.from(this.agentTasks.values()).filter(task => task.status === 'running' || task.status === 'queued' || task.status === 'waiting_review').length,
            review_count: Array.from(this.agentArtifacts.values()).filter(artifact => artifact.status === 'needs_review' || artifact.status === 'draft').length,
            updated_at_ms: Date.now(),
        }];
        const header = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(header, $('span')).textContent = 'Workspace Index';
        append(header, $('span')).textContent = `${workspaces.length}`;
        const grid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        for (const workspace of workspaces.slice(0, 24)) {
            const card = append(grid, $('div.aixlarity-task-card'));
            card.setAttribute('data-kind', 'workspace');
            const top = append(card, $('div.aixlarity-task-top'));
            const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
            append(left, $('div.aixlarity-task-title')).textContent = String(workspace.name || workspace.path || 'Workspace');
            append(left, $('div.aixlarity-task-progress')).textContent = String(workspace.path || '');
            const status = append(top, $('span.aixlarity-task-status', { style: 'background: rgba(59,130,246,0.16); color: #93c5fd;' }));
            status.textContent = workspace.exists === false ? 'missing' : 'indexed';
            const meta = append(card, $('div.aixlarity-task-meta'));
            append(meta, $('span.aixlarity-task-badge')).textContent = `${Number(workspace.task_count || 0)} tasks`;
            append(meta, $('span.aixlarity-task-badge')).textContent = `${Number(workspace.artifact_count || 0)} artifacts`;
            append(meta, $('span.aixlarity-task-badge')).textContent = `${Number(workspace.review_count || 0)} review`;
            append(meta, $('span.aixlarity-task-badge')).textContent = this.formatShortTime(Number(workspace.updated_at_ms || workspace.saved_at_ms || Date.now()));
            const actions = append(card, $('div', { style: 'display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;' }));
            const copyBtn = append(actions, $('button.aixlarity-action-button'));
            append(copyBtn, $('span.codicon.codicon-copy'));
            append(copyBtn, $('span')).textContent = 'Copy Path';
            copyBtn.addEventListener('click', async () => {
                await this.clipboardService.writeText(String(workspace.path || ''));
            });
            const openBtn = append(actions, $('button.aixlarity-action-button.warning'));
            append(openBtn, $('span.codicon.codicon-folder-opened'));
            append(openBtn, $('span')).textContent = 'Use Workspace';
            openBtn.addEventListener('click', () => {
                const path = String(workspace.path || '');
                if (path) {
                    this.sendRpcToDaemon('set_workspace', { path });
                    this.requestAgentManagerRefresh();
                }
            });
        }
    }

    private renderArtifactWorkspace(): void {
        this.renderAiEditTimeline(Array.from(this.agentArtifacts.values()));
        this.renderArtifactReviewSection('Evidence', Array.from(this.agentArtifacts.values()));
    }

    private renderAiEditTimeline(artifacts: AgentArtifactState[]): void {
        const diffArtifacts = artifacts
            .filter(artifact => artifact.kind === 'code_diff' && !!artifact.body)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20);
        if (diffArtifacts.length === 0) {
            return;
        }

        const header = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(header, $('span')).textContent = 'AI Edit Timeline';
        append(header, $('span')).textContent = `${diffArtifacts.length}`;
        if (diffArtifacts.length > 1) {
            const compare = append(this.fleetContainer, $('div.aixlarity-edit-compare'));
            const fromSelect = append(compare, $<HTMLSelectElement>('select', { 'aria-label': 'Compare from round' } as any));
            const toSelect = append(compare, $<HTMLSelectElement>('select', { 'aria-label': 'Compare to round' } as any));
            const addRoundOption = (select: HTMLSelectElement, artifact: AgentArtifactState, index: number) => {
                const option = append(select, $<HTMLOptionElement>('option'));
                option.value = artifact.id;
                option.textContent = `Round ${diffArtifacts.length - index}: ${artifact.name}`;
            };
            diffArtifacts.forEach((artifact, index) => {
                addRoundOption(fromSelect, artifact, index);
                addRoundOption(toSelect, artifact, index);
            });
            fromSelect.value = diffArtifacts[Math.min(1, diffArtifacts.length - 1)].id;
            toSelect.value = diffArtifacts[0].id;
            const compareBtn = append(compare, $('button.aixlarity-action-button'));
            append(compareBtn, $('span.codicon.codicon-compare-changes'));
            append(compareBtn, $('span')).textContent = 'Compare Rounds';
            compareBtn.addEventListener('click', () => this.openDiffRoundCompare(fromSelect.value, toSelect.value));
        }
        const timeline = append(this.fleetContainer, $('div.aixlarity-edit-timeline'));
        diffArtifacts.forEach((artifact, index) => {
            const summary = this.parseUnifiedDiff(artifact.body || '', artifact.path);
            const task = artifact.taskId ? this.agentTasks.get(artifact.taskId) : undefined;
            const round = append(timeline, $('div.aixlarity-edit-round'));
            const left = append(round, $('div', { style: 'min-width: 0;' }));
            append(left, $('div.aixlarity-edit-round-title')).textContent =
                `Round ${diffArtifacts.length - index}: ${artifact.name}`;
            const meta = append(left, $('div.aixlarity-edit-round-meta'));
            append(meta, $('span.aixlarity-task-badge')).textContent = `${summary.files.length} files`;
            append(meta, $('span.aixlarity-task-badge')).textContent = `+${summary.additions}`;
            append(meta, $('span.aixlarity-task-badge')).textContent = `-${summary.deletions}`;
            append(meta, $('span.aixlarity-task-badge')).textContent = this.formatShortTime(artifact.updatedAt);
            if (task?.title) {
                append(meta, $('span.aixlarity-task-badge', { title: task.title })).textContent = this.truncateForDisplay(task.title, 36, 'task title');
            }
            const inspectBtn = append(round, $('button.aixlarity-action-button'));
            append(inspectBtn, $('span.codicon.codicon-diff'));
            append(inspectBtn, $('span')).textContent = 'Review';
            inspectBtn.addEventListener('click', () => this.openArtifactInspector(artifact.id));
        });
    }

    private renderArtifactReviewSection(title: string, artifacts: AgentArtifactState[]): void {
        const header = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(header, $('span')).textContent = title;
        append(header, $('span')).textContent = `${artifacts.length}`;
        const grid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        if (artifacts.length === 0) {
            append(grid, $('div.aixlarity-empty-state')).textContent = 'No matching artifacts. Plans, diffs, test reports, screenshots, browser recordings, and terminal transcripts will appear here with anchored review threads.';
            return;
        }
        for (const artifact of artifacts.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)) {
            this.renderArtifactReviewCard(grid, artifact);
        }
    }

    private renderAuditLogSection(title: string, events: any[]): void {
        const filtered = events.filter(event => this.managerAuditEventMatchesFilters(event)).slice(0, 50);
        const header = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(header, $('span')).textContent = title;
        append(header, $('span')).textContent = `${filtered.length}`;
        const grid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        if (filtered.length === 0) {
            append(grid, $('div.aixlarity-empty-state')).textContent = 'No matching audit events yet.';
            return;
        }
        for (const event of filtered.slice(0, 30)) {
            this.renderAuditEventCard(grid, event);
        }
    }

    renderBrowserControlCenter(): void {
        const state = this.ensureStudioState();
        const policy = state.browserPolicy;
        this.renderBrowserPolicyEditor(policy);
        const browserArtifacts = Array.from(this.agentArtifacts.values())
            .filter(artifact => (artifact.kind === 'browser_recording' || artifact.kind === 'screenshot') && this.managerArtifactMatchesFilters(artifact));
        this.renderArtifactReviewSection('Browser Evidence Playback', browserArtifacts);
        this.renderAuditLogSection('Browser Audit', this.managerAuditEvents.filter(event => String(event?.tool_name || event?.kind || '').includes('browser')));
    }

    private renderBrowserPolicyEditor(policy: Record<string, any>): void {
        const card = append(this.fleetContainer, $('div.aixlarity-task-card'));
        card.setAttribute('data-kind', 'browser_policy');
        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = 'Managed Browser Policy';
        append(left, $('div.aixlarity-task-progress')).textContent = 'Controls DOM, console, network, screenshot, video capture, and URL allow/block lists for browser_subagent evidence.';
        const toggles = append(card, $('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;' }));
        for (const key of ['captureDom', 'captureConsole', 'captureNetwork', 'captureScreenshot', 'captureVideo']) {
            this.renderPolicyCheckbox(toggles, key, policy[key] !== false, value => policy[key] = value);
        }
        const lists = append(card, $('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;' }));
        const allowed = this.renderPolicyTextarea(lists, 'Allowed Domains', (policy.allowedDomains || []).join('\n'));
        const blocked = this.renderPolicyTextarea(lists, 'Blocked Domains', (policy.blockedDomains || []).join('\n'));
        const actions = append(card, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end;' }));
        const saveBtn = append(actions, $('button.aixlarity-action-button'));
        append(saveBtn, $('span.codicon.codicon-save'));
        append(saveBtn, $('span')).textContent = 'Save Browser Policy';
        saveBtn.addEventListener('click', () => {
            policy.allowedDomains = this.splitPolicyLines(allowed.value);
            policy.blockedDomains = this.splitPolicyLines(blocked.value);
            void this.saveStudioState('Browser policy saved.');
        });
    }

    renderTerminalReplayCenter(): void {
        const state = this.ensureStudioState();
        const policy = state.terminalPolicy;
        this.renderTerminalPolicyEditor(policy);
        const pendingShellApprovals = Array.from(this.pendingApprovals.values())
            .filter(approval => approval.toolName === 'shell' || approval.toolName === 'bash');
        if (pendingShellApprovals.length > 0) {
            const approvalsHeader = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
            append(approvalsHeader, $('span')).textContent = 'Terminal Approvals';
            append(approvalsHeader, $('span')).textContent = `${pendingShellApprovals.length}`;
            const approvalsGrid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
            for (const approval of pendingShellApprovals) {
                this.renderPendingApprovalCard(approvalsGrid, approval);
            }
        }
        const terminalArtifacts = Array.from(this.agentArtifacts.values())
            .filter(artifact => artifact.kind === 'terminal_transcript' && this.managerArtifactMatchesFilters(artifact));
        this.renderArtifactReviewSection('Terminal Replay', terminalArtifacts);
        this.renderAuditLogSection('Terminal Audit', this.managerAuditEvents.filter(event => String(event?.tool_name || event?.kind || '').includes('shell') || String(event?.tool_name || '').includes('bash')));
    }

    private renderTerminalPolicyEditor(policy: Record<string, any>): void {
        const card = append(this.fleetContainer, $('div.aixlarity-task-card'));
        card.setAttribute('data-kind', 'terminal_policy');
        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = 'Terminal Policy / Replay';
        append(left, $('div.aixlarity-task-progress')).textContent = 'Defines approval mode, capture fields, command allow/deny patterns, and transcript limits.';
        const controls = append(card, $('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;' }));
        const mode = append(controls, $<HTMLSelectElement>('select', {
            style: 'background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px 7px; font-size: 12px;'
        }));
        for (const value of ['review_all', 'review_risky', 'allow_safe', 'manual_only']) {
            const option = append(mode, $<HTMLOptionElement>('option'));
            option.value = value;
            option.textContent = value.replace(/_/g, ' ');
            option.selected = String(policy.approvalMode || 'review_risky') === value;
        }
        const timeout = append(controls, $<HTMLInputElement>('input', {
            type: 'number',
            value: String(policy.timeoutSeconds || 120),
            min: '1',
            style: 'background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 7px; font-size: 12px;'
        }));
        timeout.title = 'Timeout seconds';
        for (const key of ['captureCwd', 'captureEnv', 'captureStdout', 'captureStderr']) {
            this.renderPolicyCheckbox(controls, key, policy[key] !== false, value => policy[key] = value);
        }
        const lists = append(card, $('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;' }));
        const allow = this.renderPolicyTextarea(lists, 'Allow Patterns', (policy.allowPatterns || []).join('\n'));
        const deny = this.renderPolicyTextarea(lists, 'Deny Patterns', (policy.denyPatterns || []).join('\n'));
        const actions = append(card, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end;' }));
        const saveBtn = append(actions, $('button.aixlarity-action-button'));
        append(saveBtn, $('span.codicon.codicon-save'));
        append(saveBtn, $('span')).textContent = 'Save Terminal Policy';
        saveBtn.addEventListener('click', () => {
            policy.approvalMode = mode.value;
            policy.timeoutSeconds = Math.max(1, Number(timeout.value || 120));
            policy.allowPatterns = this.splitPolicyLines(allow.value);
            policy.denyPatterns = this.splitPolicyLines(deny.value);
            void this.saveStudioState('Terminal policy saved.');
        });
    }

    renderStudioWorkspace(): void {
        const state = this.ensureStudioState();
        if (this.studioSaveStatus) {
            const status = append(this.fleetContainer, $('div.aixlarity-empty-state'));
            status.textContent = this.studioSaveStatus;
        }
        this.renderMissionPolicyEditor(state.missionPolicy);
        this.renderInventorySection('Rules', state.inventory?.rules || [], 'root AGENTS/AIXLARITY/CLAUDE/GEMINI rules detected for effective prompt review');
        this.renderInventorySection('Workflows', state.inventory?.workflows || [], '.aixlarity/commands workflow files');
        this.renderInventorySection('Memory', state.inventory?.memories || [], 'MEMORY.md and USER.md stores visible to the agent');
        this.renderInventorySection('MCP Servers', state.inventory?.mcpServers || [], '.aixlarity/mcp.json configuration');
    }

    private renderMissionPolicyEditor(policy: Record<string, any>): void {
        const card = append(this.fleetContainer, $('div.aixlarity-task-card'));
        card.setAttribute('data-kind', 'mission_policy');
        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = 'Plan Gate / Review Policy';
        append(left, $('div.aixlarity-task-progress')).textContent = 'Controls which artifacts the agent must produce before editing or declaring a mission complete.';
        const grid = append(card, $('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px;' }));
        for (const key of ['requirePlanBeforeEdit', 'requireTaskList', 'requireTestReportBeforeComplete', 'requireEvidenceBundle', 'blockDestructiveWithoutApproval']) {
            this.renderPolicyCheckbox(grid, key, policy[key] !== false, value => policy[key] = value);
        }
        const actions = append(card, $('div', { style: 'display: flex; gap: 8px; justify-content: flex-end;' }));
        const saveBtn = append(actions, $('button.aixlarity-action-button'));
        append(saveBtn, $('span.codicon.codicon-save'));
        append(saveBtn, $('span')).textContent = 'Save Studio Policy';
        saveBtn.addEventListener('click', () => void this.saveStudioState('Mission policy saved.'));
    }

    private renderInventorySection(title: string, items: any[], description: string): void {
        const header = append(this.fleetContainer, $('div.aixlarity-manager-section-title'));
        append(header, $('span')).textContent = title;
        append(header, $('span')).textContent = `${items.length}`;
        const grid = append(this.fleetContainer, $('div.aixlarity-manager-grid'));
        if (items.length === 0) {
            append(grid, $('div.aixlarity-empty-state')).textContent = `No ${title.toLowerCase()} found. ${description}.`;
            return;
        }
        for (const item of items.slice(0, 30)) {
            const card = append(grid, $('div.aixlarity-task-card'));
            card.setAttribute('data-kind', title.toLowerCase().replace(/\s+/g, '_'));
            const top = append(card, $('div.aixlarity-task-top'));
            const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
            append(left, $('div.aixlarity-task-title')).textContent = String(item.name || item.path || title);
            append(left, $('div.aixlarity-task-progress')).textContent = String(item.path || item.absolute_path || '');
            const meta = append(card, $('div.aixlarity-task-meta'));
            append(meta, $('span.aixlarity-task-badge')).textContent = `${Number(item.bytes || 0)} bytes`;
            if (item.modified_ms) {
                append(meta, $('span.aixlarity-task-badge')).textContent = this.formatShortTime(Number(item.modified_ms));
            }
            const pre = append(card, $('pre', {
                style: 'margin: 0; padding: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap; font-size: 11px; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px;'
            }));
            pre.textContent = String(item.preview || '').trim() || '(empty)';
            const actions = append(card, $('div', { style: 'display: flex; gap: 6px; justify-content: flex-end;' }));
            const copyBtn = append(actions, $('button.aixlarity-action-button'));
            append(copyBtn, $('span.codicon.codicon-copy'));
            append(copyBtn, $('span')).textContent = 'Copy';
            copyBtn.addEventListener('click', async () => this.clipboardService.writeText(String(item.preview || '')));
        }
    }

    private renderPolicyCheckbox(container: HTMLElement, label: string, checked: boolean, onChange: (value: boolean) => void): HTMLInputElement {
        const row = append(container, $('label', {
            style: 'display: flex; align-items: center; gap: 7px; font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 7px 8px; min-width: 0;'
        }));
        const input = append(row, $<HTMLInputElement>('input', { type: 'checkbox' }));
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        append(row, $('span', { style: 'word-break: break-word;' })).textContent = this.humanizePolicyKey(label);
        return input;
    }

    private renderPolicyTextarea(container: HTMLElement, label: string, value: string): HTMLTextAreaElement {
        const wrap = append(container, $('label', { style: 'display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--vscode-descriptionForeground);' }));
        append(wrap, $('span')).textContent = label;
        const textarea = append(wrap, $<HTMLTextAreaElement>('textarea', {
            value,
            style: 'min-height: 86px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 7px; font-size: 12px; font-family: var(--vscode-editor-font-family); outline: none;'
        }));
        return textarea;
    }

    private splitPolicyLines(value: string): string[] {
        return value.split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 200);
    }

    private humanizePolicyKey(key: string): string {
        return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    }

    private ensureStudioState(): AixlarityStudioState {
        if (!this.studioState) {
            this.studioState = this.normalizeStudioState({});
        }
        return this.studioState;
    }

    private normalizeStudioState(raw: any): AixlarityStudioState {
        return {
            schema: 'aixlarity.ide_studio_state.v1',
            version: Number(raw?.version || 1),
            savedAt: Number(raw?.savedAt || raw?.saved_at_ms || Date.now()),
            workspace: String(raw?.workspace || this.workspaceEvidenceLabel()),
            missionPolicy: {
                requirePlanBeforeEdit: true,
                requireTaskList: true,
                requireTestReportBeforeComplete: true,
                requireEvidenceBundle: true,
                blockDestructiveWithoutApproval: true,
                ...(raw?.missionPolicy || raw?.mission_policy || {}),
            },
            browserPolicy: {
                managedBrowserEnabled: true,
                captureDom: true,
                captureConsole: true,
                captureNetwork: true,
                captureScreenshot: true,
                captureVideo: false,
                sessionIsolation: 'workspace',
                allowedDomains: ['localhost', '127.0.0.1'],
                blockedDomains: [],
                ...(raw?.browserPolicy || raw?.browser_policy || {}),
            },
            terminalPolicy: {
                approvalMode: 'review_risky',
                captureCwd: true,
                captureEnv: true,
                captureStdout: true,
                captureStderr: true,
                timeoutSeconds: 120,
                maxTranscriptBytes: 200000,
                allowPatterns: ['cargo test', 'npm test', 'npm run compile'],
                denyPatterns: ['rm -rf /', 'git reset --hard'],
                ...(raw?.terminalPolicy || raw?.terminal_policy || {}),
            },
            knowledgePolicy: normalizeKnowledgePolicy(raw?.knowledgePolicy || raw?.knowledge_policy || {}),
            inventory: {
                rules: Array.isArray(raw?.inventory?.rules) ? raw.inventory.rules : [],
                workflows: Array.isArray(raw?.inventory?.workflows) ? raw.inventory.workflows : [],
                memories: Array.isArray(raw?.inventory?.memories) ? raw.inventory.memories : [],
                mcpServers: Array.isArray(raw?.inventory?.mcpServers) ? raw.inventory.mcpServers : [],
            },
        };
    }

    private async saveStudioState(message: string): Promise<void> {
        const state = this.ensureStudioState();
        state.savedAt = Date.now();
        this.studioSaveStatus = 'Saving Studio policy...';
        this.renderStudioPolicySurfaces();
        try {
            if (this.daemonConnected) {
                const saved = await this.sendRpcToDaemonAsync('studio/save', { state });
                if (saved?.state) {
                    this.studioState = this.normalizeStudioState(saved.state);
                }
            }
            this.studioSaveStatus = message;
        } catch (error) {
            this.studioSaveStatus = `Failed to save Studio policy: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.renderStudioPolicySurfaces();
    }

    private renderStudioPolicySurfaces(): void {
        if (this.managerVisible()) {
            this.renderAgentManager();
        }
        if (this.isSettingsVisible()) {
            this.renderEssentialSettingsPanel(this.lastOverview, this.providerListCache, this.currentProviderId, this.msTextRef || this.settingsContainer);
        }
    }

    managerTaskMatchesFilters(task: AgentTaskState): boolean {
        if (!this.managerStatusMatches(task.status)) {
            return false;
        }
        if (this.managerKindFilter !== 'all') {
            const hasKind = task.artifactIds
                .map(id => this.agentArtifacts.get(id))
                .some(artifact => artifact?.kind === this.managerKindFilter);
            if (!hasKind) return false;
        }
        return this.managerTextMatches([
            task.title,
            task.prompt,
            task.progressLabel,
            task.lastError || '',
            task.provider || '',
            task.model || '',
            task.mode || '',
            task.workspace || '',
        ]);
    }

    managerApprovalMatchesFilters(approval: PendingApprovalState): boolean {
        if (this.managerStatusFilter !== 'all' && this.managerStatusFilter !== 'active' && this.managerStatusFilter !== 'waiting_review') {
            return false;
        }
        if (this.managerKindFilter !== 'all') {
            return false;
        }
        return this.managerTextMatches([
            approval.description,
            approval.toolName,
            this.stringifyForDisplay(approval.arguments, 2000),
        ]);
    }

    private managerArtifactMatchesFilters(artifact: AgentArtifactState): boolean {
        if (!this.managerStatusMatches(artifact.status)) {
            return false;
        }
        if (this.managerKindFilter !== 'all' && artifact.kind !== this.managerKindFilter) {
            return false;
        }
        return this.managerTextMatches([
            artifact.name,
            artifact.summary,
            artifact.path || '',
            artifact.kind,
            artifact.status,
            artifact.body || '',
            ...artifact.comments,
            ...artifact.reviewThreads.flatMap(thread => [
                thread.anchor.label,
                thread.anchor.kind,
                thread.anchor.path || '',
                String(thread.anchor.line || ''),
                thread.status,
                ...thread.comments.map(comment => comment.body),
            ]),
            ...artifact.evidence.map(item => `${item.label} ${item.value}`),
        ]);
    }

    private managerAuditEventMatchesFilters(event: any): boolean {
        const kind = String(event?.kind || '');
        const status = String(event?.status || event?.decision || '');
        if (this.managerStatusFilter !== 'all') {
            if (this.managerStatusFilter === 'active') return false;
            if (this.managerStatusFilter === 'waiting_review' && kind !== 'approval_request') return false;
            if (this.managerStatusFilter !== 'waiting_review' && status !== this.managerStatusFilter) return false;
        }
        if (this.managerKindFilter !== 'all' && String(event?.artifact_kind || event?.kind || '') !== this.managerKindFilter) {
            return false;
        }
        return this.managerTextMatches([
            kind,
            status,
            String(event?.tool_name || ''),
            String(event?.description || ''),
            String(event?.artifact_name || ''),
            String(event?.artifact_kind || ''),
            String(event?.artifact_id || ''),
            String(event?.thread_id || ''),
            String(event?.task_id || ''),
            String(event?.call_id || ''),
            String(event?.label || ''),
            String(event?.comment || ''),
            this.stringifyForDisplay(event?.anchor || {}, 1000),
            String(event?.argument_preview || ''),
        ]);
    }

    private managerStatusMatches(status: string): boolean {
        if (this.managerStatusFilter === 'all') return true;
        if (this.managerStatusFilter === 'active') {
            return status === 'running' || status === 'queued' || status === 'waiting_review';
        }
        if (this.managerStatusFilter === 'waiting_review') {
            return status === 'waiting_review' || status === 'needs_review';
        }
        return status === this.managerStatusFilter;
    }

    private managerTextMatches(parts: string[]): boolean {
        const query = this.managerSearchQuery.trim().toLowerCase();
        if (!query) return true;
        return parts.join('\n').toLowerCase().includes(query);
    }

    private recordAuditEventToDaemon(kind: string, fields: Record<string, any>): void {
        const event = {
            kind,
            created_at_ms: Date.now(),
            ...fields,
        };
        this.addManagerAuditEvent(event);
        if (!this.daemonConnected) {
            return;
        }
        this.sendRpcToDaemon('audit/record', { event });
    }

    private addManagerAuditEvent(event: Record<string, any>): void {
        const createdAt = Number(event.created_at_ms || event.createdAt || Date.now());
        const normalized = {
            schema: 'aixlarity.audit_event.v1',
            event_id: String(event.event_id || `local-audit-${createdAt}-${Math.random().toString(36).slice(2, 8)}`),
            created_at_ms: createdAt,
            ...event,
        };
        this.managerAuditEvents = [
            normalized,
            ...this.managerAuditEvents.filter(existing => String(existing?.event_id || '') !== normalized.event_id),
        ].slice(0, 200);
        this.refreshAgentManagerIfVisible();
    }

    private renderPendingApprovalCard(container: HTMLElement, approval: PendingApprovalState): void {
        const card = append(container, $('div.aixlarity-task-card'));
        card.setAttribute('data-status', 'waiting_review');

        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = approval.description;
        const meta = append(left, $('div.aixlarity-task-meta'));
        append(meta, $('span.aixlarity-task-badge')).textContent = approval.toolName;
        append(meta, $('span.aixlarity-task-badge')).textContent = this.formatShortTime(approval.createdAt);
        const status = append(top, $('span.aixlarity-task-status', {
            style: 'background: rgba(234,179,8,0.18); color: #facc15;'
        }));
        status.textContent = 'approval';

        const pre = append(card, $('pre', {
            style: 'margin: 0; padding: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 11px; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px;'
        }));
        pre.textContent = this.stringifyForDisplay(approval.arguments, 12000);

        const actions = append(card, $('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;' }));
        const allowBtn = append(actions, $('button.aixlarity-action-button'));
        append(allowBtn, $('span.codicon.codicon-check'));
        append(allowBtn, $('span')).textContent = 'Allow';
        allowBtn.addEventListener('click', () => this.resolveApprovalRequest(approval.callId, 'allow', 'Allowed'));

        const denyBtn = append(actions, $('button.aixlarity-action-button.danger'));
        append(denyBtn, $('span.codicon.codicon-close'));
        append(denyBtn, $('span')).textContent = 'Deny';
        denyBtn.addEventListener('click', () => this.resolveApprovalRequest(approval.callId, 'deny', 'Denied'));

        const alwaysBtn = append(actions, $('button.aixlarity-action-button.warning'));
        append(alwaysBtn, $('span.codicon.codicon-shield'));
        append(alwaysBtn, $('span')).textContent = 'Always';
        alwaysBtn.addEventListener('click', () => this.resolveApprovalRequest(approval.callId, 'always', 'Always Allowed'));
    }

    private renderArtifactReviewCard(container: HTMLElement, artifact: AgentArtifactState): void {
        const card = append(container, $('div.aixlarity-task-card'));
        card.setAttribute('data-status', artifact.status === 'approved' ? 'completed' : artifact.status === 'rejected' ? 'failed' : 'waiting_review');

        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = artifact.name;
        const meta = append(left, $('div.aixlarity-task-meta'));
        append(meta, $('span.aixlarity-task-badge')).textContent = artifactKindLabel(artifact.kind);
        append(meta, $('span.aixlarity-task-badge')).textContent = `${artifact.evidence.length} evidence`;
        append(meta, $('span.aixlarity-task-badge')).textContent = `${artifact.comments.length} comments`;
        append(meta, $('span.aixlarity-task-badge')).textContent = `${artifact.reviewThreads.filter(thread => thread.status !== 'resolved').length} open threads`;
        const status = append(top, $('span.aixlarity-task-status', {
            style: artifactStatusStyle(artifact.status)
        }));
        status.textContent = artifact.status.replace('_', ' ');

        const summary = append(card, $('div.aixlarity-task-progress'));
        summary.textContent = artifact.summary || artifact.path || 'Artifact captured for review.';

        if (artifact.evidence.length > 0) {
            const strip = append(card, $('div.aixlarity-artifact-strip'));
            for (const ev of artifact.evidence.slice(0, 4)) {
                const pill = append(strip, $('span.aixlarity-artifact-chip', { title: ev.value }));
                append(pill, $('span.codicon.codicon-info', { style: 'font-size: 11px;' }));
                append(pill, $('span.artifact-name')).textContent = `${ev.label}: ${this.truncateForDisplay(ev.value, 48, 'evidence')}`;
            }
        }

        const actions = append(card, $('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;' }));
        const inspectBtn = append(actions, $('button.aixlarity-action-button'));
        append(inspectBtn, $('span.codicon.codicon-eye'));
        append(inspectBtn, $('span')).textContent = 'Inspect';
        inspectBtn.addEventListener('click', () => this.openArtifactInspector(artifact.id));

        const approveBtn = append(actions, $('button.aixlarity-action-button'));
        append(approveBtn, $('span.codicon.codicon-check'));
        append(approveBtn, $('span')).textContent = 'Approve';
        approveBtn.addEventListener('click', () => this.approveArtifactWithReviewGate(artifact));

        const rejectBtn = append(actions, $('button.aixlarity-action-button.warning'));
        append(rejectBtn, $('span.codicon.codicon-comment'));
        append(rejectBtn, $('span')).textContent = 'Feedback';
        rejectBtn.addEventListener('click', () => this.openArtifactInspector(artifact.id));
    }

    private renderAuditEventCard(container: HTMLElement, event: any): void {
        const kind = String(event?.kind || 'event');
        const status = String(event?.status || event?.decision || '');
        const createdAt = Number(event?.created_at_ms || event?.createdAt || Date.now());
        const artifactId = String(event?.artifact_id || '');
        const toolName = String(event?.tool_name || '');
        const description = String(event?.description || event?.comment || event?.artifact_name || '');

        const card = append(container, $('div.aixlarity-task-card'));
        card.setAttribute('data-status', status === 'approved' ? 'completed' : status === 'rejected' || status === 'deny' ? 'failed' : 'waiting_review');

        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = this.auditEventLabel(kind, status);
        const meta = append(left, $('div.aixlarity-task-meta'));
        append(meta, $('span.aixlarity-task-badge')).textContent = kind.replace(/_/g, ' ');
        if (status) append(meta, $('span.aixlarity-task-badge')).textContent = status.replace(/_/g, ' ');
        if (toolName) append(meta, $('span.aixlarity-task-badge')).textContent = toolName;
        if (artifactId) append(meta, $('span.aixlarity-task-badge')).textContent = artifactId;
        append(meta, $('span.aixlarity-task-badge')).textContent = this.formatShortTime(createdAt);

        const badge = append(top, $('span.aixlarity-task-status', {
            style: status === 'approved' || status === 'allow' || status === 'always'
                ? 'background: rgba(34,197,94,0.18); color: #86efac;'
                : status === 'rejected' || status === 'deny'
                    ? 'background: rgba(239,68,68,0.18); color: #fca5a5;'
                    : 'background: rgba(234,179,8,0.18); color: #facc15;'
        }));
        badge.textContent = status || 'recorded';

        if (description) {
            const detail = append(card, $('div.aixlarity-task-progress'));
            detail.textContent = this.truncateForDisplay(description, 500, 'audit detail');
        }

        const rows = [
            ['Call', event?.call_id],
            ['RPC', event?.rpc_id],
            ['Task', event?.task_id],
            ['Artifact', artifactId],
            ['Thread', event?.thread_id],
            ['Anchor', event?.anchor ? this.stringifyForDisplay(event.anchor, 300) : undefined],
            ['Comment', event?.comment],
        ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
        if (rows.length > 0) {
            const rowBox = append(card, $('div', {
                style: 'display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 8px; font-size: 11px; color: var(--vscode-descriptionForeground);'
            }));
            for (const [label, value] of rows) {
                append(rowBox, $('span', { style: 'font-weight: 650;' })).textContent = String(label);
                append(rowBox, $('span', { style: 'word-break: break-word; color: var(--vscode-foreground);' })).textContent =
                    this.truncateForDisplay(String(value), 240, 'audit field');
            }
        }

        const actions = append(card, $('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;' }));
        if (artifactId && this.agentArtifacts.has(artifactId)) {
            const inspectBtn = append(actions, $('button.aixlarity-action-button'));
            append(inspectBtn, $('span.codicon.codicon-eye'));
            append(inspectBtn, $('span')).textContent = 'Inspect';
            inspectBtn.addEventListener('click', () => this.openArtifactInspector(artifactId));
        }
        const copyBtn = append(actions, $('button.aixlarity-action-button'));
        append(copyBtn, $('span.codicon.codicon-json'));
        append(copyBtn, $('span')).textContent = 'Copy JSON';
        copyBtn.addEventListener('click', async () => {
            await this.clipboardService.writeText(JSON.stringify(event, null, 2));
        });
    }

    private auditEventLabel(kind: string, status: string): string {
        if (kind === 'approval_request') return 'Approval requested';
        if (kind === 'approval_response') return `Approval ${status || 'resolved'}`;
        if (kind === 'artifact_review') return `Artifact ${status || 'reviewed'}`;
        return kind.replace(/_/g, ' ');
    }

    private renderAgentTaskCard(container: HTMLElement, task: AgentTaskState): void {
        const statusMeta = taskStatusMeta(task.status);
        const card = append(container, $('div.aixlarity-task-card'));
        card.setAttribute('data-status', task.status);

        const top = append(card, $('div.aixlarity-task-top'));
        const left = append(top, $('div', { style: 'min-width: 0; flex: 1;' }));
        append(left, $('div.aixlarity-task-title')).textContent = task.title;
        const meta = append(left, $('div.aixlarity-task-meta'));
        append(meta, $('span.aixlarity-task-badge')).textContent = task.provider || 'provider pending';
        if (task.model) append(meta, $('span.aixlarity-task-badge')).textContent = task.model;
        if (task.mode) append(meta, $('span.aixlarity-task-badge')).textContent = task.mode;
        append(meta, $('span.aixlarity-task-badge')).textContent = `${task.turnCount} turns`;
        append(meta, $('span.aixlarity-task-badge')).textContent = `${task.toolCallCount} tools`;

        const status = append(top, $('span.aixlarity-task-status', {
            style: `background:${statusMeta.background}; color:${statusMeta.foreground};`
        }));
        status.textContent = statusMeta.label;

        const progress = append(card, $('div.aixlarity-task-progress'));
        progress.textContent = task.lastError || task.progressLabel || 'Waiting for agent activity.';

        const taskArtifacts = task.artifactIds
            .map(id => this.agentArtifacts.get(id))
            .filter((artifact): artifact is AgentArtifactState => !!artifact);
        const artifacts = taskArtifacts.slice(-10);
        const strip = append(card, $('div.aixlarity-artifact-strip'));
        if (artifacts.length === 0) {
            const empty = append(strip, $('span', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' }));
            empty.textContent = 'No artifacts yet';
        } else {
            for (const artifact of artifacts) {
                renderArtifactChipComponent(strip, artifact, id => this.openArtifactInspector(id));
            }
        }
        const passport = createTaskVerificationPassport(task, taskArtifacts);
        renderTaskVerificationPassport(card, passport, () => {
            void this.clipboardService.writeText(createTaskVerificationMarkdown(passport, task, taskArtifacts));
            this.recordAuditEventToDaemon('task_verification_passport_copied', {
                task_id: task.id,
                task_title: task.title,
                verification_status: passport.status,
                verification_score: passport.score,
                missing: passport.missing.join(', '),
                blockers: passport.blockers.join(', '),
            });
        });

        const recent = task.timeline.slice(-2);
        if (recent.length > 0) {
            const timeline = append(card, $('div.aixlarity-timeline'));
            for (const item of recent) {
                const row = append(timeline, $('div.aixlarity-timeline-row'));
                append(row, $('span.aixlarity-timeline-time')).textContent = this.formatShortTime(item.timestamp);
                const text = append(row, $('span', { style: 'min-width: 0; white-space: pre-wrap;' }));
                text.textContent = item.detail ? `${item.label}: ${item.detail}` : item.label;
            }
        }

        const actions = append(card, $('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;' }));
        const openBtn = append(actions, $('button.aixlarity-action-button'));
        append(openBtn, $('span.codicon.codicon-comment-discussion'));
        append(openBtn, $('span')).textContent = 'Open';
        openBtn.addEventListener('click', () => {
            if (task.conversationId) {
                this.switchConversation(task.conversationId);
            }
            if (task.backendSessionId) {
                this.sendRpcToDaemon('sessions/turns', { id: task.backendSessionId });
            }
        });

        if (task.status === 'running' || task.status === 'waiting_review' || task.status === 'queued') {
            const pauseBtn = append(actions, $('button.aixlarity-action-button'));
            append(pauseBtn, $('span.codicon.codicon-debug-pause'));
            append(pauseBtn, $('span')).textContent = 'Pause';
            pauseBtn.addEventListener('click', () => this.pauseAgentTask(task));

            const stopBtn = append(actions, $('button.aixlarity-action-button.danger'));
            append(stopBtn, $('span.codicon.codicon-debug-stop'));
            append(stopBtn, $('span')).textContent = 'Cancel';
            stopBtn.addEventListener('click', () => this.cancelAgentTask(task, 'Canceled by user from Agent Manager.'));
        } else if (task.status === 'paused') {
            const resumeBtn = append(actions, $('button.aixlarity-action-button'));
            append(resumeBtn, $('span.codicon.codicon-debug-continue'));
            append(resumeBtn, $('span')).textContent = 'Resume';
            resumeBtn.addEventListener('click', () => this.resumeAgentTask(task));

            const cancelBtn = append(actions, $('button.aixlarity-action-button.danger'));
            append(cancelBtn, $('span.codicon.codicon-debug-stop'));
            append(cancelBtn, $('span')).textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => this.cancelAgentTask(task, 'Canceled while paused from Agent Manager.'));
        } else if (task.prompt) {
            const retryBtn = append(actions, $('button.aixlarity-action-button'));
            append(retryBtn, $('span.codicon.codicon-debug-rerun'));
            append(retryBtn, $('span')).textContent = 'Retry';
            retryBtn.addEventListener('click', () => {
                if (task.conversationId) {
                    this.switchConversation(task.conversationId);
                }
                this.inputElement.value = task.prompt;
                this.inputElement.focus();
            });
        }
    }

    renderSavedSessionCard(container: HTMLElement, session: any): void {
        const card = append(container, $('div.aixlarity-fleet-card'));
        const topRow = append(card, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;' }));
        append(topRow, $('span', { style: 'font-weight: 650; font-size: 12px; color: var(--vscode-foreground);' })).textContent =
            `Session ${String(session.id || '').substring(0, 8)}`;
        append(topRow, $('span.aixlarity-task-badge')).textContent = `${session.turn_count || 0} turns`;
        append(card, $('div', { style: 'font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); white-space: pre-wrap;' })).textContent =
            session.latest_summary || 'No summary available.';

        const actions = append(card, $('div', { style: 'display: flex; gap: 6px; margin-top: 10px; justify-content: flex-end; flex-wrap: wrap;' }));
        const openBtn = append(actions, $('button.aixlarity-action-button'));
        append(openBtn, $('span.codicon.codicon-comment-discussion'));
        append(openBtn, $('span')).textContent = 'Open';
        openBtn.addEventListener('click', () => {
            let conv = this.conversations.find(c => c.backendSessionId === session.id);
            if (!conv) {
                const newConvId = this.createConversation();
                conv = this.conversations.find(c => c.id === newConvId);
                if (conv) {
                    conv.backendSessionId = session.id;
                    conv.title = `Session ${String(session.id || '').substring(0, 8)}`;
                }
            }
            if (conv) {
                this.switchConversation(conv.id);
                this.sendRpcToDaemon('sessions/turns', { id: session.id });
            }
        });
        const inspectBtn = append(actions, $('button.aixlarity-action-button'));
        append(inspectBtn, $('span.codicon.codicon-eye'));
        append(inspectBtn, $('span')).textContent = 'Inspect';
        inspectBtn.addEventListener('click', () => this.sendRpcToDaemon('sessions/show', { id: session.id }));
        const delBtn = append(actions, $('button.aixlarity-action-button.danger'));
        append(delBtn, $('span.codicon.codicon-trash'));
        append(delBtn, $('span')).textContent = 'Delete';
        delBtn.addEventListener('click', () => {
            this.sendRpcToDaemon('sessions/remove', { id: session.id });
            this.managerSessions = this.managerSessions.filter(s => s.id !== session.id);
            this.renderAgentManager();
        });
    }

    renderCheckpointCard(container: HTMLElement, checkpoint: any): void {
        const card = append(container, $('div.aixlarity-fleet-card'));
        const topRow = append(card, $('div', { style: 'display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px;' }));
        append(topRow, $('span', { style: 'font-weight: 650; font-size: 12px; color: var(--vscode-textLink-foreground); word-break: break-word;' })).textContent =
            checkpoint.file_name || 'checkpoint';
        append(card, $('div', { style: 'font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); white-space: pre-wrap;' })).textContent =
            checkpoint.summary || 'Context checkpoint';
    }

    private createAgentTaskForRequest(rpcId: string, prompt: string, conv: any, editorContext: any): void {
        const now = Date.now();
        const taskId = `task-${rpcId}`;
        const task: AgentTaskState = {
            id: taskId,
            rpcId,
            conversationId: this.activeConversationId || undefined,
            backendSessionId: conv?.backendSessionId ?? null,
            title: this.makeTaskTitle(prompt),
            prompt,
            workspace: this.resolveRpcCwd({}) || editorContext?.active_file || 'workspace',
            provider: conv?.selectedProviderLabel || conv?.selectedProviderId || undefined,
            mode: this.planningMode ? 'Planning' : 'Fast',
            status: 'running',
            progressLabel: 'Request accepted by daemon.',
            createdAt: now,
            updatedAt: now,
            artifactIds: [],
            timeline: [],
            seenEventKeys: new Set(),
            turnCount: 0,
            toolCallCount: 0,
            tokenCount: 0,
        };
        this.agentTasks.set(taskId, task);
        this.rpcToAgentTask.set(rpcId, taskId);
        this.addTaskTimeline(task, 'request', 'Request accepted', prompt.substring(0, 180), 'running');
        this.trimAgentManagerState();
        this.refreshAgentManagerIfVisible();
    }

    private ingestResultEvents(rpcId: string | null, events: any[]): void {
        if (!rpcId || !Array.isArray(events)) return;
        for (const event of events) {
            this.ingestAgentEvent(rpcId, event);
        }
    }

    private ingestAgentEvent(rpcId: any, event: any): void {
        if (!event || !event.event) return;
        const task = this.getOrCreateTaskForRpc(String(rpcId || 'unknown'), event);
        const eventKey = this.agentEventKey(event);
        if (task.seenEventKeys.has(eventKey)) return;
        task.seenEventKeys.add(eventKey);
        task.updatedAt = Date.now();

        switch (event.event) {
            case 'execution_prepared':
                task.workspace = event.workspace || task.workspace;
                task.provider = event.provider_label || event.provider_id || task.provider;
                task.mode = event.mode || task.mode;
                task.progressLabel = `Prepared ${event.mode || 'execution'} in ${event.trust || 'unknown'} trust.`;
                this.addTaskTimeline(task, event.event, 'Execution prepared', `${task.provider || ''} ${event.sandbox || ''}`.trim(), 'running');
                break;
            case 'run_started':
                task.provider = event.provider_id || task.provider;
                task.model = event.model || task.model;
                task.mode = event.planning ? 'Planning' : (task.mode || 'Fast');
                task.progressLabel = `Running with ${task.model || task.provider || 'selected model'}.`;
                this.updateTaskStatus(task, 'running');
                this.addTaskTimeline(task, event.event, 'Run started', task.progressLabel, 'running');
                break;
            case 'turn_started':
                task.turnCount = Math.max(task.turnCount, Number(event.turn || 0));
                task.progressLabel = `Turn ${event.turn || task.turnCount} of ${event.max_turns || '?'}.`;
                this.addTaskTimeline(task, event.event, 'Turn started', task.progressLabel, 'running');
                break;
            case 'provider_called':
                task.progressLabel = `Calling ${event.protocol || 'provider'} with ${event.message_count || 0} messages.`;
                this.addTaskTimeline(task, event.event, 'Provider called', task.progressLabel, 'running');
                break;
            case 'tool_call_requested':
                task.toolCallCount += 1;
                task.progressLabel = `Requested tool: ${event.tool_name || 'unknown'}.`;
                this.addTaskTimeline(task, event.event, 'Tool requested', this.toolEventLabel(event), 'running');
                break;
            case 'tool_call_denied':
                task.progressLabel = `Tool denied: ${event.tool_name || 'unknown'}.`;
                this.addTaskTimeline(task, event.event, 'Tool denied', this.toolEventLabel(event), 'waiting_review');
                this.updateTaskStatus(task, 'waiting_review');
                break;
            case 'tool_call_completed':
                task.progressLabel = `Completed tool: ${event.tool_name || 'unknown'}.`;
                this.addTaskTimeline(task, event.event, 'Tool completed', this.toolEventLabel(event), 'running');
                this.captureToolArtifact(task, event);
                this.updateTaskStatus(task, 'running');
                break;
            case 'artifact_updated':
                this.upsertAgentArtifact({
                    id: this.stableId(task.id, event.artifact_type || 'artifact', event.path || event.summary || 'artifact'),
                    taskId: task.id,
                    name: event.summary || this.basename(event.path) || 'Artifact',
                    kind: this.normalizeArtifactKind(event.artifact_type),
                    status: 'needs_review',
                    summary: event.summary || event.path || 'Artifact updated',
                    path: event.path,
                    evidence: event.path ? [{ label: 'Path', value: event.path }] : [],
                });
                task.progressLabel = `Artifact updated: ${event.summary || event.path || 'artifact'}.`;
                this.addTaskTimeline(task, event.event, 'Artifact updated', event.summary || event.path || '', 'waiting_review');
                break;
            case 'checkpoint_saved':
                this.upsertAgentArtifact({
                    id: this.stableId(task.id, 'checkpoint', event.path || 'checkpoint'),
                    taskId: task.id,
                    name: this.basename(event.path) || 'Checkpoint',
                    kind: 'checkpoint',
                    status: 'draft',
                    summary: event.path || 'Prompt checkpoint saved.',
                    path: event.path,
                    evidence: event.path ? [{ label: 'Path', value: event.path }] : [],
                });
                this.addTaskTimeline(task, event.event, 'Checkpoint saved', event.path || '', 'running');
                break;
            case 'assistant_message':
                task.progressLabel = `Assistant response with ${event.tool_call_count || 0} tool calls.`;
                this.addTaskTimeline(task, event.event, 'Assistant message', task.progressLabel, 'running');
                break;
            case 'provider_fallback':
                task.progressLabel = `Fallback from ${event.from_provider} to ${event.to_provider}.`;
                this.addTaskTimeline(task, event.event, 'Provider fallback', event.reason || '', 'running');
                break;
            case 'session_persisted':
                task.backendSessionId = event.id || task.backendSessionId;
                task.progressLabel = `Session ${event.action || 'persisted'} (${event.turn_count || 0} turns).`;
                this.addTaskTimeline(task, event.event, 'Session persisted', String(event.id || ''), task.status);
                break;
            case 'coordinator_started':
            case 'coordinator_batch_started':
            case 'coordinator_task_started':
            case 'coordinator_task_completed':
            case 'coordinator_completed':
                task.progressLabel = this.coordinatorProgressLabel(event);
                this.addTaskTimeline(task, event.event, this.eventLabel(event.event), task.progressLabel, 'running');
                break;
            case 'merge_gate_started':
            case 'patch_scope_validated':
            case 'patch_applied':
            case 'patch_conflict':
            case 'merge_gate_completed':
            case 'worktree_created':
            case 'worktree_collected':
                task.progressLabel = this.mergeProgressLabel(event);
                this.addTaskTimeline(task, event.event, this.eventLabel(event.event), task.progressLabel, 'running');
                break;
            case 'run_completed':
                task.turnCount = event.turns_used || task.turnCount;
                task.toolCallCount = event.tool_invocation_count || task.toolCallCount;
                task.tokenCount = event.total_tokens || task.tokenCount;
                task.progressLabel = `Completed in ${task.turnCount} turns with ${task.toolCallCount} tool calls.`;
                this.upsertAgentArtifact({
                    id: this.stableId(task.id, 'walkthrough', 'final'),
                    taskId: task.id,
                    name: 'Walkthrough',
                    kind: 'walkthrough',
                    status: 'draft',
                    summary: task.progressLabel,
                    body: event.final_response || '',
                    evidence: [
                        { label: 'Turns', value: String(task.turnCount) },
                        { label: 'Tool calls', value: String(task.toolCallCount) },
                        { label: 'Tokens', value: String(task.tokenCount || 0) },
                    ],
                });
                this.addTaskTimeline(task, event.event, 'Run completed', task.progressLabel, 'completed');
                this.updateTaskStatus(task, 'completed');
                break;
            default:
                this.addTaskTimeline(task, event.event, this.eventLabel(event.event), '', task.status);
                break;
        }
        this.refreshAgentManagerIfVisible();
    }

    private captureToolArtifact(task: AgentTaskState, event: any): void {
        const toolName = event.tool_name || 'tool';
        if (toolName === 'shell' || toolName === 'bash') {
            const output = this.extractToolOutput(event.result);
            const command = event.result?.command || event.arguments?.command || '';
            const cwd = event.result?.cwd || '';
            this.upsertAgentArtifact({
                id: this.stableId(task.id, 'terminal', event.result?.command_id || event.call_id || `${Date.now()}`),
                taskId: task.id,
                name: command ? `Terminal: ${this.truncateForDisplay(command, 80, 'command').split('\n')[0]}` : 'Terminal Transcript',
                kind: 'terminal_transcript',
                status: 'draft',
                summary: output.exitCode !== undefined ? `Command exited with ${output.exitCode}.` : 'Command completed.',
                path: cwd || undefined,
                body: this.formatTerminalTranscript(event.result, event.arguments),
                evidence: this.terminalEvidenceRows(event.result, event.arguments),
            });
            return;
        }
        if (toolName === 'browser_subagent') {
            const attachments = this.normalizeAttachmentRefs(event.attachments);
            const browserEvidence = event.result?.browser_evidence || null;
            const videoPath = browserEvidence?.video?.path || event.result?.video_file_path || '';
            if (videoPath) {
                attachments.push({
                    mimeType: browserEvidence?.video?.mimeType || browserEvidence?.video?.mime_type || 'video/webm',
                    filePath: videoPath
                });
            }
            const evidenceRows = this.browserEvidenceRows(event.result, browserEvidence);
            const body = this.formatBrowserEvidenceBody(event.result, browserEvidence);
            const captureLevel = browserEvidence?.capture_level || event.result?.capture_level || 'browser';
            const consoleCount = Array.isArray(browserEvidence?.console) ? browserEvidence.console.length : 0;
            const networkCount = browserEvidence?.network?.request_count ?? browserEvidence?.network?.requests?.length ?? 0;
            this.upsertAgentArtifact({
                id: this.stableId(task.id, 'browser', event.call_id || `${Date.now()}`),
                taskId: task.id,
                name: videoPath ? 'Browser Recording' : (attachments.length > 0 ? 'Browser Evidence' : 'Browser Result'),
                kind: videoPath ? 'browser_recording' : (attachments.length > 0 ? 'screenshot' : 'other'),
                status: 'draft',
                summary: `${captureLevel}: ${consoleCount} console events, ${networkCount} network requests, ${attachments.length} media artifact(s).`,
                body,
                attachments,
                evidence: evidenceRows,
            });
            return;
        }
        if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_file' || toolName === 'apply_patch') {
            const args = event.arguments || {};
            const path = args.path || args.file_path || event.result?.path;
            this.upsertAgentArtifact({
                id: this.stableId(task.id, 'file', path || event.call_id || `${Date.now()}`),
                taskId: task.id,
                name: this.basename(path) || `${toolName} change`,
                kind: 'file_change',
                status: 'needs_review',
                summary: path ? `Changed ${path}` : `${toolName} completed.`,
                path,
                body: event.result?.diff_preview || event.result?.diff || '',
                evidence: path ? [{ label: 'Path', value: path }] : [{ label: 'Tool', value: toolName }],
            });
        }
    }

    private upsertAgentArtifact(input: Partial<AgentArtifactState> & { id: string; name: string; kind: AgentArtifactKind; taskId?: string }): AgentArtifactState {
        const now = Date.now();
        const existing = this.agentArtifacts.get(input.id);
        const artifact: AgentArtifactState = {
            id: input.id,
            taskId: input.taskId ?? existing?.taskId,
            name: input.name || existing?.name || 'Artifact',
            kind: input.kind || existing?.kind || 'other',
            status: input.status || existing?.status || 'draft',
            summary: input.summary ?? existing?.summary ?? '',
            path: input.path ?? existing?.path,
            body: input.body ?? existing?.body,
            evidence: input.evidence ?? existing?.evidence ?? [],
            attachments: input.attachments ?? existing?.attachments ?? [],
            comments: input.comments ?? existing?.comments ?? [],
            reviewThreads: input.reviewThreads ?? existing?.reviewThreads ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        this.agentArtifacts.set(artifact.id, artifact);

        if (artifact.taskId) {
            const task = this.agentTasks.get(artifact.taskId);
            if (task && !task.artifactIds.includes(artifact.id)) {
                task.artifactIds.push(artifact.id);
                task.updatedAt = now;
            }
        }

        this.syncSessionArtifactsFromManager();
        this.updateBottomStatus();
        this.refreshAgentManagerIfVisible();
        this.scheduleAgentWorkspaceStateSave();
        return artifact;
    }

    private syncSessionArtifactsFromManager(): void {
        this.sessionArtifacts = Array.from(this.agentArtifacts.values())
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(-100)
            .map(a => ({ id: a.id, name: a.name, type: a.kind, status: a.status, taskId: a.taskId }));
    }

    private mergeDurableArtifactIndex(index: any): void {
        if (!index || !Array.isArray(index.artifacts)) {
            return;
        }

        for (const raw of index.artifacts) {
            if (!raw?.id || !raw?.name) continue;
            const existing = this.agentArtifacts.get(String(raw.id));
            const artifact: AgentArtifactState = {
                id: String(raw.id),
                taskId: raw.taskId ? String(raw.taskId) : undefined,
                name: String(raw.name),
                kind: this.normalizeArtifactKind(raw.kind),
                status: this.normalizeArtifactStatus(raw.status),
                summary: String(raw.summary || existing?.summary || ''),
                path: raw.path ? String(raw.path) : existing?.path,
                body: typeof raw.body === 'string' ? raw.body : existing?.body,
                evidence: Array.isArray(raw.evidence) ? raw.evidence.map((item: any) => ({
                    label: String(item?.label || ''),
                    value: String(item?.value || ''),
                })).filter((item: any) => item.label) : existing?.evidence || [],
                attachments: Array.isArray(raw.attachments) ? raw.attachments.map((item: any) => ({
                    mimeType: String(item?.mimeType || item?.mime_type || 'application/octet-stream'),
                    filePath: item?.filePath ? String(item.filePath) : item?.file_path ? String(item.file_path) : undefined,
                    dataBase64: item?.dataBase64 ? String(item.dataBase64) : item?.data_base64 ? String(item.data_base64) : undefined,
                })) : existing?.attachments || [],
                comments: Array.isArray(raw.comments) ? raw.comments.map((comment: any) => String(comment)).slice(-50) : existing?.comments || [],
                reviewThreads: this.normalizeReviewThreads(raw.reviewThreads || raw.review_threads || existing?.reviewThreads || [], String(raw.id)),
                createdAt: Number(raw.createdAt || existing?.createdAt || Date.now()),
                updatedAt: Number(raw.updatedAt || raw.reviewedAt || existing?.updatedAt || Date.now()),
            };
            this.agentArtifacts.set(artifact.id, artifact);
        }

        if (Array.isArray(index.tasks)) {
            for (const raw of index.tasks) {
                if (!raw?.id || !raw?.title || this.agentTasks.has(String(raw.id))) continue;
                const status = this.normalizeRestoredTaskStatus(raw.status);
                this.agentTasks.set(String(raw.id), {
                    id: String(raw.id),
                    rpcId: undefined,
                    conversationId: raw.conversationId ? String(raw.conversationId) : undefined,
                    backendSessionId: raw.backendSessionId ?? null,
                    title: String(raw.title),
                    prompt: String(raw.prompt || ''),
                    workspace: raw.workspace ? String(raw.workspace) : undefined,
                    provider: raw.provider ? String(raw.provider) : undefined,
                    model: raw.model ? String(raw.model) : undefined,
                    mode: raw.mode ? String(raw.mode) : undefined,
                    status,
                    progressLabel: this.restoredTaskProgressLabel(raw, status),
                    createdAt: Number(raw.createdAt || Date.now()),
                    updatedAt: Number(raw.updatedAt || Date.now()),
                    artifactIds: Array.isArray(raw.artifactIds)
                        ? raw.artifactIds.map((id: any) => String(id)).filter((id: string) => this.agentArtifacts.has(id)).slice(-50)
                        : [],
                    timeline: Array.isArray(raw.timeline) ? raw.timeline.map((item: any) => ({
                        id: String(item?.id || this.stableId(String(raw.id), 'durable', String(Date.now()))),
                        kind: String(item?.kind || 'event'),
                        label: String(item?.label || 'Event'),
                        detail: item?.detail ? String(item.detail) : undefined,
                        status: item?.status ? this.normalizeTaskStatus(item.status) : undefined,
                        timestamp: Number(item?.timestamp || Date.now()),
                    })).slice(-120) : [],
                    seenEventKeys: new Set(Array.isArray(raw.seenEventKeys) ? raw.seenEventKeys.map((item: any) => String(item)) : []),
                    turnCount: Number(raw.turnCount || 0),
                    toolCallCount: Number(raw.toolCallCount || 0),
                    tokenCount: Number(raw.tokenCount || 0),
                    lastError: raw.lastError ? String(raw.lastError) : undefined,
                });
            }
        }

        this.syncSessionArtifactsFromManager();
        this.updateBottomStatus();
    }

    private openArtifactInspector(artifactId: string): void {
        const artifact = this.agentArtifacts.get(artifactId);
        if (!artifact) return;
        const task = artifact.taskId ? this.agentTasks.get(artifact.taskId) : undefined;

        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
            style: 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box;'
        }));
        const modal = append(overlay, $('.aixlarity-settings-card', {
            style: 'width: min(1080px, 94vw); max-height: 88vh; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 8px 28px rgba(0,0,0,0.45);'
        }));

        const header = append(modal, $('div', { style: 'display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;' }));
        const titleBlock = append(header, $('div', { style: 'min-width: 0;' }));
        append(titleBlock, $('div', { style: 'font-size: 15px; font-weight: 700; color: var(--vscode-foreground); word-break: break-word;' })).textContent = artifact.name;
        append(titleBlock, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px;' })).textContent =
            `${artifactKindLabel(artifact.kind)} - ${artifact.status.replace('_', ' ')}`;
        const closeBtn = append(header, $('button.aixlarity-action-button'));
        append(closeBtn, $('span.codicon.codicon-close'));
        append(closeBtn, $('span')).textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());

        const body = append(modal, $('div.aixlarity-artifact-modal-body'));
        if (artifact.summary) {
            const summary = append(body, $('div.aixlarity-task-progress'));
            summary.textContent = artifact.summary;
        }

        if (artifact.path) {
            const pathRow = append(body, $('div', { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;' }));
            append(pathRow, $('span.aixlarity-task-badge')).textContent = artifact.path;
            const openPathBtn = append(pathRow, $('button.aixlarity-action-button'));
            append(openPathBtn, $('span.codicon.codicon-go-to-file'));
            append(openPathBtn, $('span')).textContent = 'Open File';
            openPathBtn.addEventListener('click', () => {
                const resolved = this.resolveWorkspaceFilePath(artifact.path!);
                this.editorService.openEditor({ resource: URI.file(resolved) });
            });
        }

        if (artifact.evidence.length > 0) {
            const evidenceCard = append(body, $('div', { style: 'border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px;' }));
            append(evidenceCard, $('div', { style: 'font-size: 11px; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);' })).textContent = 'Evidence';
            for (const ev of artifact.evidence) {
                const row = append(evidenceCard, $('div', { style: 'display: flex; justify-content: space-between; gap: 12px; font-size: 11px; padding: 3px 0;' }));
                append(row, $('span', { style: 'color: var(--vscode-descriptionForeground);' })).textContent = ev.label;
                append(row, $('span', { style: 'color: var(--vscode-foreground); text-align: right; word-break: break-word;' })).textContent = ev.value;
            }
        }

        if (artifact.attachments.length > 0) {
            const media = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
            for (const att of artifact.attachments) {
                if (att.mimeType.startsWith('image/')) {
                    const img = append(media, $<HTMLImageElement>('img', {
                        style: 'width: 100%; max-height: 420px; object-fit: contain; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: rgba(0,0,0,0.2);'
                    }));
                    if (att.filePath) {
                        img.src = `vscode-file://vscode-app${att.filePath}`;
                    } else if (att.dataBase64) {
                        img.src = `data:${att.mimeType};base64,${att.dataBase64}`;
                    }
                } else if (att.mimeType.startsWith('video/')) {
                    const video = append(media, $<HTMLVideoElement>('video', {
                        controls: 'true',
                        style: 'width: 100%; max-height: 420px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: rgba(0,0,0,0.35);'
                    } as any));
                    if (att.filePath) {
                        video.src = `vscode-file://vscode-app${att.filePath}`;
                    } else if (att.dataBase64) {
                        video.src = `data:${att.mimeType};base64,${att.dataBase64}`;
                    }
                } else if (att.mimeType.startsWith('text/') || att.mimeType.includes('json')) {
                    const attachmentPre = append(media, $('pre', {
                        style: 'margin: 0; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; border: 1px solid var(--vscode-panel-border); max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 11px; font-family: var(--vscode-editor-font-family);'
                    }));
                    attachmentPre.textContent = att.dataBase64 ? this.decodeBase64Text(att.dataBase64) : (att.filePath || att.mimeType);
                }
            }
        }

        if (artifact.body) {
            if (artifact.kind === 'code_diff') {
                this.renderArtifactDiffViewer(body, artifact.body, artifact);
            } else {
                const bodyPre = append(body, $('pre', {
                    style: 'margin: 0; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; border: 1px solid var(--vscode-panel-border); max-height: 260px; overflow: auto; white-space: pre-wrap; font-size: 11px; font-family: var(--vscode-editor-font-family);'
                }));
                bodyPre.textContent = this.truncateForDisplay(artifact.body, 30000, 'artifact body');
            }
        }

        const comments = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
        append(comments, $('div', { style: 'font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);' })).textContent = 'Review Comments';
        const commentsList = append(comments, $('div', { style: 'display: flex; flex-direction: column; gap: 5px;' }));
        const renderComments = () => {
            commentsList.textContent = '';
            if (artifact.comments.length === 0) {
                append(commentsList, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' })).textContent = 'No comments yet.';
            } else {
                for (const comment of artifact.comments) {
                    append(commentsList, $('div', { style: 'font-size: 11px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; white-space: pre-wrap;' })).textContent = comment;
                }
            }
        };
        renderComments();

        const feedbackInput = append(comments, $<HTMLTextAreaElement>('textarea', {
            placeholder: 'Add focused review feedback for the agent...',
            style: 'width: 100%; min-height: 64px; box-sizing: border-box; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; font-size: 12px; font-family: var(--vscode-font-family); outline: none;'
        }));

        const threadBox = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px;' }));
        append(threadBox, $('div', { style: 'font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);' })).textContent = 'Anchored Review Threads';
        const threadList = append(threadBox, $('div', { style: 'display: flex; flex-direction: column; gap: 7px;' }));
        const renderThreads = () => {
            threadList.textContent = '';
            if (artifact.reviewThreads.length === 0) {
                append(threadList, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground);' })).textContent = 'No anchored threads yet.';
                return;
            }
            for (const thread of artifact.reviewThreads.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
                const row = append(threadList, $('div', { style: 'border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; display: flex; flex-direction: column; gap: 5px;' }));
                const rowTop = append(row, $('div', { style: 'display: flex; justify-content: space-between; gap: 8px; align-items: center;' }));
                append(rowTop, $('span', { style: 'font-size: 12px; font-weight: 650; color: var(--vscode-foreground); word-break: break-word;' })).textContent =
                    `${thread.anchor.kind}: ${thread.anchor.label}`;
                const badge = append(rowTop, $('span.aixlarity-task-badge'));
                badge.textContent = thread.status;
                for (const comment of thread.comments) {
                    append(row, $('div', { style: 'font-size: 11px; white-space: pre-wrap; color: var(--vscode-foreground);' })).textContent = comment.body;
                }
                if (thread.status !== 'resolved') {
                    const resolveBtn = append(row, $('button.aixlarity-action-button'));
                    append(resolveBtn, $('span.codicon.codicon-check'));
                    append(resolveBtn, $('span')).textContent = 'Resolve Thread';
                    resolveBtn.addEventListener('click', () => {
                        void this.updateArtifactReviewThread(artifact, {
                            threadId: thread.id,
                            status: 'resolved',
                        }, renderThreads);
                    });
                }
            }
        };
        renderThreads();

        const anchorRow = append(threadBox, $('div', { style: 'display: grid; grid-template-columns: minmax(110px, auto) minmax(150px, 1fr); gap: 8px;' }));
        const anchorKind = append(anchorRow, $<HTMLSelectElement>('select', {
            style: 'background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px 7px; font-size: 12px;'
        }));
        for (const value of ['artifact', 'line', 'file', 'screenshot', 'video', 'dom', 'console', 'network']) {
            const option = append(anchorKind, $<HTMLOptionElement>('option'));
            option.value = value;
            option.textContent = value;
        }
        const anchorTarget = append(anchorRow, $<HTMLInputElement>('input', {
            placeholder: 'Anchor label, path:line, selector, URL, or video time',
            style: 'background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 7px; font-size: 12px; outline: none; min-width: 0;'
        }));
        const threadInput = append(threadBox, $<HTMLTextAreaElement>('textarea', {
            placeholder: 'Add an anchored comment for this artifact...',
            style: 'width: 100%; min-height: 58px; box-sizing: border-box; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; font-size: 12px; font-family: var(--vscode-font-family); outline: none;'
        }));
        const addThreadBtn = append(threadBox, $('button.aixlarity-action-button'));
        append(addThreadBtn, $('span.codicon.codicon-comment-add'));
        append(addThreadBtn, $('span')).textContent = 'Add Anchored Thread';
        addThreadBtn.addEventListener('click', () => {
            const comment = threadInput.value.trim();
            if (!comment) return;
            const anchor = this.createReviewAnchor(anchorKind.value, anchorTarget.value.trim(), artifact);
            void this.updateArtifactReviewThread(artifact, { anchor, comment }, () => {
                threadInput.value = '';
                anchorTarget.value = '';
                renderThreads();
            });
        });

        const actionRow = append(modal, $('div', { style: 'display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;' }));
        const copyJsonBtn = append(actionRow, $('button.aixlarity-action-button'));
        append(copyJsonBtn, $('span.codicon.codicon-json'));
        append(copyJsonBtn, $('span')).textContent = 'Copy JSON';
        copyJsonBtn.addEventListener('click', async () => {
            await this.clipboardService.writeText(JSON.stringify(this.createAgentEvidenceBundle(artifact), null, 2));
        });

        if (artifact.kind === 'terminal_transcript') {
            const command = this.artifactEvidenceValue(artifact, 'Command');
            const cwd = this.artifactEvidenceValue(artifact, 'CWD');
            const copyCommandBtn = append(actionRow, $('button.aixlarity-action-button'));
            append(copyCommandBtn, $('span.codicon.codicon-copy'));
            append(copyCommandBtn, $('span')).textContent = 'Copy Command';
            copyCommandBtn.addEventListener('click', async () => {
                await this.clipboardService.writeText(command || artifact.body || '');
            });

            const replayBtn = append(actionRow, $('button.aixlarity-action-button.warning'));
            append(replayBtn, $('span.codicon.codicon-debug-rerun'));
            append(replayBtn, $('span')).textContent = 'Replay';
            replayBtn.addEventListener('click', () => {
                const instruction = [
                    'Replay this terminal command through the normal Aixlarity approval flow.',
                    cwd ? `Working directory: ${cwd}` : '',
                    'Command:',
                    '```sh',
                    command || '',
                    '```',
                    'Capture stdout, stderr, exit code, and explain any failure.'
                ].filter(Boolean).join('\n');
                if (task) {
                    this.continueTaskWithInstruction(task, instruction);
                } else if (this.sendToDaemon(instruction)) {
                    this.updateSendButtonState(true);
                }
                overlay.remove();
            });
        }
        const approveBtn = append(actionRow, $('button.aixlarity-action-button'));
        append(approveBtn, $('span.codicon.codicon-check'));
        append(approveBtn, $('span')).textContent = 'Approve';
        approveBtn.addEventListener('click', () => {
            const approved = this.approveArtifactWithReviewGate(artifact);
            if (approved && task) {
                this.continueTaskWithInstruction(task, `I have reviewed and approved artifact: ${artifact.name}. Proceed.`);
            }
            if (approved) {
                overlay.remove();
            }
        });

        const feedbackBtn = append(actionRow, $('button.aixlarity-action-button.warning'));
        append(feedbackBtn, $('span.codicon.codicon-comment'));
        append(feedbackBtn, $('span')).textContent = 'Send Feedback';
        feedbackBtn.addEventListener('click', () => {
            const feedback = feedbackInput.value.trim();
            if (!feedback) return;
            this.markArtifactStatus(artifact.id, 'rejected', feedback);
            renderComments();
            if (task) {
                this.continueTaskWithInstruction(task, `Please revise artifact "${artifact.name}" using this review feedback:\n${feedback}`);
            }
            overlay.remove();
        });

        overlay.addEventListener('click', (event: Event) => {
            if (event.target === overlay) overlay.remove();
        });
    }

    private createReviewAnchor(kind: string, target: string, artifact: AgentArtifactState): AgentReviewAnchor {
        const label = target || artifact.path || artifact.name;
        const anchor: AgentReviewAnchor = { kind: kind || 'artifact', label };
        if (artifact.path && (kind === 'line' || kind === 'file')) {
            anchor.path = artifact.path;
        }
        const pathLine = target.match(/^(.+):(\d+)(?::(\d+))?$/);
        if (pathLine) {
            anchor.path = pathLine[1];
            anchor.line = Number(pathLine[2]);
            if (pathLine[3]) anchor.column = Number(pathLine[3]);
        } else if (/^\d+$/.test(target) && kind === 'line') {
            anchor.line = Number(target);
            if (artifact.path) anchor.path = artifact.path;
        } else if (kind === 'video' && /^\d+(\.\d+)?$/.test(target)) {
            anchor.timeMs = Math.round(Number(target) * 1000);
        } else if (kind === 'dom') {
            anchor.selector = target;
        } else if (kind === 'network') {
            anchor.url = target;
        }
        return anchor;
    }

    private async updateArtifactReviewThread(
        artifact: AgentArtifactState,
        update: { threadId?: string; status?: 'open' | 'resolved'; anchor?: AgentReviewAnchor; comment?: string },
        after?: () => void
    ): Promise<void> {
        const now = Date.now();
        let thread = update.threadId
            ? artifact.reviewThreads.find(item => item.id === update.threadId)
            : undefined;
        if (!thread) {
            thread = {
                id: update.threadId || `local-thread-${now}-${Math.random().toString(36).slice(2, 7)}`,
                artifactId: artifact.id,
                anchor: update.anchor || { kind: 'artifact', label: artifact.name },
                status: 'open',
                comments: [],
                createdAt: now,
                updatedAt: now,
            };
            artifact.reviewThreads.unshift(thread);
        }
        if (update.status) {
            thread.status = update.status;
        }
        if (update.anchor) {
            thread.anchor = update.anchor;
        }
        if (update.comment && update.comment.trim()) {
            thread.comments.push({
                id: `local-comment-${now}-${thread.comments.length + 1}`,
                author: 'user',
                body: update.comment.trim(),
                createdAt: now,
            });
            thread.comments = thread.comments.slice(-80);
        }
        thread.updatedAt = now;
        artifact.updatedAt = now;
        this.addManagerAuditEvent({
            kind: 'artifact_review_thread',
            artifact_id: artifact.id,
            artifact_name: artifact.name,
            artifact_kind: artifact.kind,
            task_id: artifact.taskId || '',
            thread_id: thread.id,
            status: thread.status,
            anchor: thread.anchor,
            comment: update.comment || '',
            created_at_ms: now,
        });
        this.scheduleAgentWorkspaceStateSave();
        this.refreshAgentManagerIfVisible();

        if (this.daemonConnected) {
            try {
                const result = await this.sendRpcToDaemonAsync('artifacts/review_thread', {
                    artifact_id: artifact.id,
                    thread_id: update.threadId,
                    status: update.status,
                    anchor: update.anchor,
                    comment: update.comment,
                });
                if (result?.thread) {
                    this.mergeArtifactReviewThread(artifact, result.thread);
                }
            } catch (error) {
                if (this.devMode) {
                    console.warn('[Aixlarity] Failed to persist review thread:', error);
                }
            }
        }
        after?.();
    }

    private mergeArtifactReviewThread(artifact: AgentArtifactState, rawThread: any): void {
        const thread = this.normalizeReviewThread(rawThread, artifact.id);
        const existingIndex = artifact.reviewThreads.findIndex(item => item.id === thread.id);
        if (existingIndex >= 0) {
            artifact.reviewThreads[existingIndex] = thread;
        } else {
            artifact.reviewThreads.unshift(thread);
        }
        artifact.reviewThreads = artifact.reviewThreads
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 400);
    }

    private renderArtifactDiffViewer(container: HTMLElement, diffText: string, artifact?: AgentArtifactState): void {
        const parsed = this.parseUnifiedDiff(diffText, artifact?.path);
        const snapshot = this.buildDiffSnapshot(artifact, parsed);
        const riskProfile = this.createDiffRiskProfile(parsed, artifact);
        const impactMap = this.createDiffImpactMap(parsed);

        DiffReviewView.render({
            container,
            diffText,
            artifact,
            parsed,
            snapshot,
            riskProfile,
            impactMap,
            readReviewGate: () => artifact ? this.diffReviewGate(artifact, parsed) : { label: 'Review Gate: transient', blocked: false, reason: 'No persisted artifact.' },
            buildSnapshotFile: file => this.buildDiffSnapshotFile(file),
            appendHighlightedText: (target, text, compareText, side) => this.appendDiffHighlightedText(target, text, compareText, side),
            hunkReviewState: (targetArtifact, hunkId) => this.hunkReviewState(targetArtifact, hunkId),
            recordHunkReview: (targetArtifact, hunk, action, note, after) => this.recordHunkReview(targetArtifact, hunk, action, note, after),
            copyHunkEvidence: (targetArtifact, hunk) => this.copyHunkEvidence(targetArtifact, hunk),
            openDiffHunkSource: hunk => this.openDiffHunkSource(hunk),
            openNativeDiffForFile: (targetArtifact, file) => this.openNativeDiffForFile(targetArtifact, file),
            createReviewReport: () => this.createDiffReviewReport(artifact, parsed, snapshot, riskProfile, impactMap),
            copyText: text => this.clipboardService.writeText(text),
            recordReviewExport: (gateLabel, riskLevel) => this.recordAuditEventToDaemon('diff_review_exported', {
                artifact_id: artifact?.id || '',
                artifact_name: artifact?.name || 'transient diff',
                artifact_kind: artifact?.kind || 'code_diff',
                review_gate: gateLabel,
                risk_level: riskLevel,
            }),
        });
    }

    private parseUnifiedDiff(diffText: string, fallbackPath?: string): AiDiffSummary {
        return parseUnifiedDiffModel(diffText, fallbackPath);
    }

    private buildDiffSnapshot(artifact: AgentArtifactState | undefined, parsed: AiDiffSummary): AiDiffSnapshot {
        return buildDiffSnapshotModel(artifact, parsed);
    }

    private buildDiffSnapshotFile(file: AiDiffFile): AiDiffSnapshotFile {
        return buildDiffSnapshotFileModel(file);
    }

    private createDiffRiskProfile(parsed: AiDiffSummary, artifact?: AgentArtifactState): AiDiffRiskProfile {
        return createDiffRiskProfileModel(parsed, artifact);
    }

    private createDiffImpactMap(parsed: AiDiffSummary): AiDiffImpactMap {
        return createDiffImpactMapModel(parsed);
    }

    private createDiffReviewReport(
        artifact: AgentArtifactState | undefined,
        parsed: AiDiffSummary,
        snapshot: AiDiffSnapshot,
        riskProfile: AiDiffRiskProfile,
        impactMap: AiDiffImpactMap
    ): string {
        return createDiffReviewReportModel(artifact, parsed, snapshot, riskProfile, impactMap);
    }

    private diffReviewGate(artifact: AgentArtifactState, parsed: AiDiffSummary): AiDiffReviewGate {
        return diffReviewGateModel(artifact, parsed);
    }

    private openNativeDiffForFile(artifact: AgentArtifactState | undefined, file: AiDiffFile): void {
        const snapshot = this.buildDiffSnapshotFile(file);
        const artifactId = artifact?.id || this.stableId('native-diff', file.displayPath, String(Date.now()));
        const beforeUri = this.createDiffSnapshotUri('before', artifactId, snapshot.path, snapshot.before);
        const afterUri = this.createDiffSnapshotUri('after', artifactId, snapshot.path, snapshot.after);
        this.recordAuditEventToDaemon('native_diff_opened', {
            artifact_id: artifact?.id || '',
            artifact_name: artifact?.name || 'transient diff',
            file_path: file.displayPath,
        });
        void this.editorService.openEditor({
            original: { resource: beforeUri },
            modified: { resource: afterUri },
            label: `${this.basename(snapshot.path) || snapshot.path} (AI Before / After)`,
            options: { preserveFocus: false, preview: true }
        } as any);
    }

    private hunkReviewState(artifact: AgentArtifactState, hunkId: string): { label: string; thread?: AgentReviewThreadState } {
        return hunkReviewStateModel(artifact, hunkId);
    }

    private async recordHunkReview(
        artifact: AgentArtifactState,
        hunk: AiDiffHunk,
        action: AiDiffHunkReviewAction,
        note: string,
        after?: () => void
    ): Promise<void> {
        const tags: Record<AiDiffHunkReviewAction, string> = {
            approve: '[hunk-approved]',
            reject: '[hunk-rejected]',
            comment: '[hunk-comment]',
            rewrite: '[hunk-rewrite]',
        };
        const thread = this.hunkReviewState(artifact, hunk.id).thread;
        const anchor: AgentReviewAnchor = {
            kind: 'hunk',
            label: `${hunk.filePath} ${hunk.header}`,
            path: hunk.filePath,
            line: hunk.newStart || hunk.oldStart || undefined,
            selector: hunk.id,
        };
        const comment = `${tags[action]} ${note || hunk.header}`;
        await this.updateArtifactReviewThread(artifact, {
            threadId: thread?.id,
            status: action === 'approve' ? 'resolved' : 'open',
            anchor,
            comment,
        }, after);

        if (action === 'rewrite') {
            const task = artifact.taskId ? this.agentTasks.get(artifact.taskId) : undefined;
            const instruction = [
                `Rewrite only this hunk in ${hunk.filePath}.`,
                `Hunk: ${hunk.header}`,
                note ? `Reviewer note: ${note}` : '',
                'Return an updated diff and explain the risk delta.'
            ].filter(Boolean).join('\n');
            if (task) {
                this.continueTaskWithInstruction(task, instruction);
            } else if (this.sendToDaemon(instruction)) {
                this.updateSendButtonState(true);
            }
        }
    }

    private async copyHunkEvidence(artifact: AgentArtifactState, hunk: AiDiffHunk): Promise<void> {
        const text = this.createHunkEvidenceText(artifact, hunk);
        await this.clipboardService.writeText(text);
        this.recordAuditEventToDaemon('diff_hunk_copied', {
            artifact_id: artifact.id,
            artifact_name: artifact.name,
            artifact_kind: artifact.kind,
            hunk_id: hunk.id,
            file_path: hunk.filePath,
        });
    }

    private createHunkEvidenceText(artifact: AgentArtifactState, hunk: AiDiffHunk): string {
        const lines = [
            `Artifact: ${artifact.name}`,
            `File: ${hunk.filePath}`,
            `Hunk: ${hunk.header}`,
            `Status: ${this.hunkReviewState(artifact, hunk.id).label}`,
            '',
            hunk.header,
        ];
        for (const row of hunk.rows) {
            if (row.kind === 'change') {
                lines.push(`-${row.oldText || ''}`);
                lines.push(`+${row.newText || ''}`);
            } else if (row.kind === 'delete') {
                lines.push(`-${row.oldText || ''}`);
            } else if (row.kind === 'add') {
                lines.push(`+${row.newText || ''}`);
            } else if (row.kind === 'context') {
                lines.push(` ${row.oldText || row.newText || ''}`);
            }
        }
        return lines.join('\n');
    }

    private openDiffHunkSource(hunk: AiDiffHunk): void {
        const fsPath = this.resolveDiffSourceFile(hunk.filePath);
        if (!fsPath) {
            this.appendMessage('system', `Unable to resolve source file for ${hunk.filePath}`);
            return;
        }
        void this.editorService.openEditor({
            resource: URI.file(fsPath),
            options: {
                preserveFocus: false,
                preview: true,
                selection: { startLineNumber: Math.max(1, hunk.newStart || hunk.oldStart || 1), startColumn: 1 }
            }
        } as any);
    }

    private resolveDiffSourceFile(filePath: string): string | undefined {
        if (!filePath || filePath === '/dev/null') {
            return undefined;
        }
        if (this.isAbsoluteFsPath(filePath)) {
            return filePath;
        }
        const workspacePath = this.resolveRpcCwd({});
        if (!workspacePath) {
            return filePath;
        }
        return `${workspacePath.replace(/\/+$/, '')}/${filePath.replace(/^\.?\//, '')}`;
    }

    private openDiffRoundCompare(fromArtifactId: string, toArtifactId: string): void {
        const fromArtifact = this.agentArtifacts.get(fromArtifactId);
        const toArtifact = this.agentArtifacts.get(toArtifactId);
        if (!fromArtifact || !toArtifact || !fromArtifact.body || !toArtifact.body) {
            this.appendMessage('system', 'Cannot compare selected AI edit rounds because one diff artifact is missing.');
            return;
        }
        const fromSnapshot = this.buildDiffSnapshot(fromArtifact, this.parseUnifiedDiff(fromArtifact.body, fromArtifact.path));
        const toSnapshot = this.buildDiffSnapshot(toArtifact, this.parseUnifiedDiff(toArtifact.body, toArtifact.path));
        const compareDiff = this.createSnapshotCompareDiff(fromSnapshot, toSnapshot);

        const overlay = append(this.aixlarityWrapper, $('.aixlarity-modal-overlay', {
            style: 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box;'
        }));
        const modal = append(overlay, $('.aixlarity-settings-card', {
            style: 'width: min(1080px, 94vw); max-height: 88vh; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 8px 28px rgba(0,0,0,0.45);'
        }));
        const header = append(modal, $('div', { style: 'display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;' }));
        const titleBlock = append(header, $('div', { style: 'min-width: 0;' }));
        append(titleBlock, $('div', { style: 'font-size: 15px; font-weight: 700; color: var(--vscode-foreground); word-break: break-word;' })).textContent = 'Compare Rounds';
        append(titleBlock, $('div', { style: 'font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px;' })).textContent =
            `${fromSnapshot.name} -> ${toSnapshot.name}`;
        const closeBtn = append(header, $('button.aixlarity-action-button'));
        append(closeBtn, $('span.codicon.codicon-close'));
        append(closeBtn, $('span')).textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());

        const body = append(modal, $('div.aixlarity-artifact-modal-body'));
        if (compareDiff.trim()) {
            this.renderArtifactDiffViewer(body, compareDiff);
        } else {
            append(body, $('div.aixlarity-empty-state')).textContent = 'No snapshot differences between selected rounds.';
        }
        overlay.addEventListener('click', (event: Event) => {
            if (event.target === overlay) overlay.remove();
        });
    }

    private createSnapshotCompareDiff(fromSnapshot: AiDiffSnapshot, toSnapshot: AiDiffSnapshot): string {
        return createSnapshotCompareDiffModel(fromSnapshot, toSnapshot, path => this.diffPathForPatch(path));
    }

    private diffPathForPatch(path: string): string {
        const displayPath = this.relativeWorkspacePath(path || 'changes').replace(/\\/g, '/');
        return (displayPath.replace(/^\/+/, '').replace(/\s+/g, '_') || 'changes');
    }

    private appendDiffHighlightedText(container: HTMLElement, text: string, compareText?: string, side?: 'old' | 'new'): void {
        if (!compareText || side === undefined || text === compareText) {
            container.textContent = text || ' ';
            return;
        }

        let prefix = 0;
        const minLength = Math.min(text.length, compareText.length);
        while (prefix < minLength && text[prefix] === compareText[prefix]) {
            prefix++;
        }
        let suffix = 0;
        while (
            suffix < minLength - prefix
            && text[text.length - 1 - suffix] === compareText[compareText.length - 1 - suffix]
        ) {
            suffix++;
        }

        const before = text.slice(0, prefix);
        const changed = text.slice(prefix, suffix ? text.length - suffix : text.length);
        const after = suffix ? text.slice(text.length - suffix) : '';
        if (before) append(container, $('span')).textContent = before;
        if (changed) {
            const span = append(container, $(side === 'old' ? 'span.aixlarity-diff-word-delete' : 'span.aixlarity-diff-word-add'));
            span.textContent = changed;
        }
        if (after) append(container, $('span')).textContent = after;
        if (!before && !changed && !after) {
            container.textContent = ' ';
        }
    }

    private approveArtifactWithReviewGate(artifact: AgentArtifactState): boolean {
        if (artifact.kind === 'code_diff' && artifact.body) {
            const parsed = this.parseUnifiedDiff(artifact.body, artifact.path);
            const gate = this.diffReviewGate(artifact, parsed);
            if (gate.blocked) {
                const comment = `${gate.label}: ${gate.reason}`;
                artifact.comments.push(comment);
                artifact.comments = artifact.comments.slice(-50);
                artifact.updatedAt = Date.now();
                this.recordAuditEventToDaemon('artifact_review_gate_blocked', {
                    artifact_id: artifact.id,
                    artifact_name: artifact.name,
                    artifact_kind: artifact.kind,
                    status: artifact.status,
                    comment,
                });
                this.scheduleAgentWorkspaceStateSave();
                this.refreshAgentManagerIfVisible();
                return false;
            }
            this.recordAuditEventToDaemon('artifact_review_gate_passed', {
                artifact_id: artifact.id,
                artifact_name: artifact.name,
                artifact_kind: artifact.kind,
                review_gate: gate.label,
            });
        }
        this.markArtifactStatus(artifact.id, 'approved');
        return true;
    }

    private markArtifactStatus(artifactId: string, status: AgentArtifactStatus, comment?: string): void {
        const artifact = this.agentArtifacts.get(artifactId);
        if (!artifact) return;
        artifact.status = status;
        artifact.updatedAt = Date.now();
        if (comment && comment.trim()) {
            artifact.comments.push(comment.trim());
            artifact.comments = artifact.comments.slice(-50);
        }
        if (artifact.taskId) {
            const task = this.agentTasks.get(artifact.taskId);
            if (task) {
                this.addTaskTimeline(task, 'artifact_review', `Artifact ${status.replace('_', ' ')}`, artifact.name, task.status);
            }
        }
        this.addManagerAuditEvent({
            kind: 'artifact_review',
            artifact_id: artifact.id,
            artifact_name: artifact.name,
            artifact_kind: artifact.kind,
            task_id: artifact.taskId || '',
            status,
            comment: comment || '',
            created_at_ms: artifact.updatedAt,
        });
        this.syncSessionArtifactsFromManager();
        this.updateBottomStatus();
        this.refreshAgentManagerIfVisible();
        this.scheduleAgentWorkspaceStateSave();
        void this.persistArtifactReviewToDaemon(artifact, status, comment);
    }

    private async persistArtifactReviewToDaemon(artifact: AgentArtifactState, status: AgentArtifactStatus, comment?: string): Promise<void> {
        if (!this.daemonConnected) {
            return;
        }
        try {
            const reviewed = await this.sendRpcToDaemonAsync('artifacts/review', {
                artifact_id: artifact.id,
                status,
                comment: comment || undefined,
            });
            if (reviewed?.artifact) {
                this.mergeReviewedArtifact(reviewed.artifact);
            }
        } catch (error) {
            if (this.devMode) {
                console.warn('[Aixlarity] Failed to persist artifact review:', error);
            }
        }
    }

    private mergeReviewedArtifact(rawArtifact: any): void {
        if (!rawArtifact?.id || !this.agentArtifacts.has(String(rawArtifact.id))) {
            return;
        }
        const existing = this.agentArtifacts.get(String(rawArtifact.id))!;
        existing.status = this.normalizeArtifactStatus(rawArtifact.status);
        existing.updatedAt = Number(rawArtifact.updatedAt || rawArtifact.reviewedAt || existing.updatedAt);
        existing.comments = Array.isArray(rawArtifact.comments)
            ? rawArtifact.comments.map((comment: any) => String(comment)).slice(-50)
            : existing.comments;
        existing.reviewThreads = this.normalizeReviewThreads(rawArtifact.reviewThreads || rawArtifact.review_threads || existing.reviewThreads, existing.id);
        this.syncSessionArtifactsFromManager();
        this.refreshAgentManagerIfVisible();
    }

    private artifactEvidenceValue(artifact: AgentArtifactState, label: string): string {
        return artifact.evidence.find(item => item.label === label)?.value || '';
    }

    private continueTaskWithInstruction(task: AgentTaskState, instruction: string): void {
        if (task.conversationId) {
            this.switchConversation(task.conversationId);
        }
        if (this.sendToDaemon(instruction)) {
            this.updateSendButtonState(true);
        }
    }

    private pauseAgentTask(task: AgentTaskState): void {
        if (task.rpcId) {
            this.rememberStoppedRpc(task.rpcId);
            this.sendRpcToDaemon('agent_stop', { id: task.rpcId, reason: 'pause' });
            this.rpcToConversation.delete(task.rpcId);
            this.rpcToAgentTask.delete(task.rpcId);
            if (this.activeRpcId === task.rpcId) {
                this.activeRpcId = null;
                this.removeLoadingIndicator();
                this.updateSendButtonState(false);
            }
            task.rpcId = undefined;
        }
        this.markTaskPaused(task.id, 'Paused by user from Agent Manager.');
    }

    private resumeAgentTask(task: AgentTaskState): void {
        if (task.conversationId) {
            this.switchConversation(task.conversationId);
        }

        const instruction = [
            'Resume this paused Aixlarity task.',
            task.prompt ? `Original task:\n${task.prompt}` : '',
            task.lastError ? `Last error:\n${task.lastError}` : '',
            'Recent timeline:',
            task.timeline.slice(-8).map(item => {
                const detail = item.detail ? ` - ${item.detail}` : '';
                return `- ${item.label}${detail}`;
            }).join('\n') || '- No timeline events recorded yet.',
            'Continue from the latest known state. Re-check files and terminal/browser evidence before making further changes.'
        ].filter(Boolean).join('\n\n');

        if (this.sendInstructionForExistingTask(task, instruction)) {
            this.updateSendButtonState(true);
        }
    }

    private cancelAgentTask(task: AgentTaskState, message: string): void {
        if (task.rpcId) {
            this.rememberStoppedRpc(task.rpcId);
            this.sendRpcToDaemon('agent_stop', { id: task.rpcId });
            this.rpcToConversation.delete(task.rpcId);
            this.rpcToAgentTask.delete(task.rpcId);
            if (this.activeRpcId === task.rpcId) {
                this.activeRpcId = null;
                this.removeLoadingIndicator();
                this.updateSendButtonState(false);
            }
            task.rpcId = undefined;
        }
        this.markTaskStopped(task.id, message);
    }

    private sendInstructionForExistingTask(task: AgentTaskState, text: string): boolean {
        const editorContext = this.getActiveEditorContext();
        const conv = task.conversationId
            ? this.conversations.find(c => c.id === task.conversationId)
            : this.conversations.find(c => c.id === this.activeConversationId);
        const rpcId = this.sendRpcToDaemon('agent_chat', {
            prompt: text,
            plan_only: this.planningMode,
            persona: conv?.selectedPersona || this.currentPersona,
            sandbox: this.currentSandbox,
            permission: this.currentPermission,
            checkpoint: this.checkpointEnabled,
            auto_git: this.autoGitEnabled,
            skill: this.currentSkill || null,
            ide_context: { ...editorContext, open_files: null, browser_state: null },
            session_id: conv?.backendSessionId ?? task.backendSessionId ?? null,
            provider: conv && conv.selectedProviderId ? conv.selectedProviderId : null,
            attachments: undefined
        });
        if (!rpcId) {
            this.appendMessage('system', 'Failed to resume task through daemon.');
            return false;
        }

        task.rpcId = rpcId;
        task.conversationId = task.conversationId || this.activeConversationId || undefined;
        task.backendSessionId = conv?.backendSessionId ?? task.backendSessionId ?? null;
        task.lastError = undefined;
        task.progressLabel = 'Resume request accepted by daemon.';
        this.rpcToAgentTask.set(rpcId, task.id);
        if (task.conversationId) {
            this.rpcToConversation.set(rpcId, task.conversationId);
            this.activeRpcId = rpcId;
        }
        this.addTaskTimeline(task, 'resume', 'Task resumed', text.substring(0, 180), 'running');
        this.showLoadingIndicator();
        this.trimAgentManagerState();
        this.refreshAgentManagerIfVisible();
        return true;
    }

    private getOrCreateTaskForRpc(rpcId: string, event: any): AgentTaskState {
        const existingId = this.rpcToAgentTask.get(rpcId);
        if (existingId) {
            const existing = this.agentTasks.get(existingId);
            if (existing) return existing;
        }
        const now = Date.now();
        const taskId = `task-${rpcId || now}`;
        const task: AgentTaskState = {
            id: taskId,
            rpcId,
            conversationId: this.rpcToConversation.get(rpcId) || this.activeConversationId || undefined,
            title: this.eventLabel(event?.event || 'Background task'),
            prompt: '',
            workspace: event?.workspace,
            provider: event?.provider_label || event?.provider_id,
            status: 'running',
            progressLabel: 'Receiving agent events.',
            createdAt: now,
            updatedAt: now,
            artifactIds: [],
            timeline: [],
            seenEventKeys: new Set(),
            turnCount: 0,
            toolCallCount: 0,
            tokenCount: 0,
        };
        this.agentTasks.set(taskId, task);
        this.rpcToAgentTask.set(rpcId, taskId);
        return task;
    }

    private addTaskTimeline(task: AgentTaskState, kind: string, label: string, detail: string = '', status?: AgentTaskStatus): void {
        task.timeline.push({
            id: this.stableId(task.id, kind, String(Date.now()), String(task.timeline.length)),
            kind,
            label,
            detail,
            status,
            timestamp: Date.now(),
        });
        if (task.timeline.length > 120) {
            task.timeline.splice(0, task.timeline.length - 120);
        }
        if (status) {
            task.status = status;
        }
        task.updatedAt = Date.now();
        this.scheduleAgentWorkspaceStateSave();
    }

    private updateTaskStatus(task: AgentTaskState, status: AgentTaskStatus, detail?: string): void {
        task.status = status;
        task.updatedAt = Date.now();
        if (detail) {
            task.progressLabel = detail;
        }
        this.scheduleAgentWorkspaceStateSave();
    }

    private markRpcFailed(rpcId: string | null, message: string): void {
        if (!rpcId) return;
        const taskId = this.rpcToAgentTask.get(rpcId);
        if (!taskId) return;
        const task = this.agentTasks.get(taskId);
        if (!task) return;
        task.lastError = message;
        task.progressLabel = message;
        this.addTaskTimeline(task, 'error', 'Task failed', message, 'failed');
        this.refreshAgentManagerIfVisible();
    }

    private markTaskStopped(taskId: string, message: string): void {
        const task = this.agentTasks.get(taskId);
        if (!task) return;
        task.rpcId = undefined;
        task.progressLabel = message;
        this.addTaskTimeline(task, 'stopped', 'Task stopped', message, 'stopped');
        this.refreshAgentManagerIfVisible();
    }

    private markTaskPaused(taskId: string, message: string): void {
        const task = this.agentTasks.get(taskId);
        if (!task) return;
        task.progressLabel = message;
        this.addTaskTimeline(task, 'paused', 'Task paused', message, 'paused');
        this.refreshAgentManagerIfVisible();
    }

    private trimAgentManagerState(): void {
        const tasks = Array.from(this.agentTasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
        for (const oldTask of tasks.slice(200)) {
            this.agentTasks.delete(oldTask.id);
            if (oldTask.rpcId) this.rpcToAgentTask.delete(oldTask.rpcId);
        }
        const artifacts = Array.from(this.agentArtifacts.values()).sort((a, b) => b.updatedAt - a.updatedAt);
        for (const oldArtifact of artifacts.slice(500)) {
            this.agentArtifacts.delete(oldArtifact.id);
        }
        this.syncSessionArtifactsFromManager();
        this.scheduleAgentWorkspaceStateSave();
    }

    private agentWorkspaceStateKey(): string {
        const workspace = this.workspaceContextService.getWorkspace();
        const workspaceId = workspace.id || workspace.folders.map(folder => folder.uri.toString()).join('|') || 'empty-window';
        return createAgentWorkspaceStateKey(this.agentStateStorageVersion, workspaceId);
    }

    private workspaceEvidenceLabel(): string {
        const workspace = this.workspaceContextService.getWorkspace();
        const folders = workspace.folders.map(folder => folder.uri.fsPath || folder.uri.toString());
        return folders.join(', ') || workspace.id || 'empty-window';
    }

    private scheduleAgentWorkspaceStateSave(): void {
        if (this.agentStateSaveTimer) {
            clearTimeout(this.agentStateSaveTimer);
        }
        this.agentStateSaveTimer = setTimeout(() => {
            this.agentStateSaveTimer = null;
            this.persistAgentWorkspaceStateNow();
        }, 350);
    }

    private persistAgentWorkspaceStateNow(): void {
        try {
            const state = this.createPersistedAgentWorkspaceState();
            localStorage.setItem(this.agentWorkspaceStateKey(), JSON.stringify(state));
            void this.persistAgentWorkspaceStateToDaemon(state);
        } catch (error) {
            if (this.devMode) {
                console.warn('[Aixlarity] Failed to persist agent workspace state:', error);
            }
        }
    }

    private async persistAgentWorkspaceStateToDaemon(state: PersistedAgentWorkspaceState): Promise<void> {
        if (!this.daemonConnected) {
            return;
        }
        if (this.missionControlSaveInFlight) {
            this.missionControlSavePending = true;
            return;
        }

        this.missionControlSaveInFlight = true;
        try {
            await this.sendRpcToDaemonAsync('mission_control/save', { state });
            this.missionControlLoadedWorkspaceKey = this.agentWorkspaceStateKey();
        } catch (error) {
            if (this.devMode) {
                console.warn('[Aixlarity] Failed to save Mission Control state to daemon:', error);
            }
        } finally {
            this.missionControlSaveInFlight = false;
            if (this.missionControlSavePending) {
                this.missionControlSavePending = false;
                const latest = this.createPersistedAgentWorkspaceState();
                localStorage.setItem(this.agentWorkspaceStateKey(), JSON.stringify(latest));
                void this.persistAgentWorkspaceStateToDaemon(latest);
            }
        }
    }

    private async restoreAgentWorkspaceStateFromDaemon(): Promise<void> {
        if (!this.daemonConnected || this.missionControlLoadInFlight) {
            return;
        }
        const workspaceKey = this.agentWorkspaceStateKey();
        if (this.missionControlLoadedWorkspaceKey === workspaceKey) {
            return;
        }

        this.missionControlLoadInFlight = true;
        try {
            const result = await this.sendRpcToDaemonAsync('mission_control/load', {});
            const daemonState = result?.state as PersistedAgentWorkspaceState | undefined;
            if (!this.isPersistedAgentWorkspaceState(daemonState)) {
                return;
            }

            const localState = this.readLocalAgentWorkspaceState();
            const daemonCount = this.persistedAgentWorkspaceStateItemCount(daemonState);

            if (shouldPreferLocalMissionState(localState, daemonState)) {
                await this.sendRpcToDaemonAsync('mission_control/save', { state: localState });
                this.missionControlLoadedWorkspaceKey = workspaceKey;
                return;
            }

            if (daemonCount > 0 || !localState) {
                localStorage.setItem(workspaceKey, JSON.stringify(daemonState));
                this.restoreAgentWorkspaceState();
                this.refreshAgentManagerIfVisible();
                this.updateBottomStatus();
            }
            this.missionControlLoadedWorkspaceKey = workspaceKey;
        } catch (error) {
            if (this.devMode) {
                console.warn('[Aixlarity] Failed to restore Mission Control state from daemon:', error);
            }
        } finally {
            this.missionControlLoadInFlight = false;
        }
    }

    private readLocalAgentWorkspaceState(): PersistedAgentWorkspaceState | undefined {
        try {
            const raw = localStorage.getItem(this.agentWorkspaceStateKey());
            if (!raw) return undefined;
            const state = JSON.parse(raw) as PersistedAgentWorkspaceState;
            return this.isPersistedAgentWorkspaceState(state) ? state : undefined;
        } catch {
            return undefined;
        }
    }

    private isPersistedAgentWorkspaceState(state: any): state is PersistedAgentWorkspaceState {
        return isPersistedAgentWorkspaceStateModel(state, this.agentStateStorageVersion);
    }

    private persistedAgentWorkspaceStateItemCount(state: PersistedAgentWorkspaceState | undefined): number {
        return persistedAgentWorkspaceStateItemCountModel(state);
    }

    private restoreAgentWorkspaceState(): void {
        try {
            const raw = localStorage.getItem(this.agentWorkspaceStateKey());
            if (!raw) return;
            const state = JSON.parse(raw) as PersistedAgentWorkspaceState;
            if (!state || state.version !== this.agentStateStorageVersion || !Array.isArray(state.tasks) || !Array.isArray(state.artifacts)) {
                return;
            }

            this.agentTasks.clear();
            this.agentArtifacts.clear();
            this.rpcToAgentTask.clear();

            for (const artifact of state.artifacts.slice(0, this.agentStateStorageMaxArtifacts)) {
                if (!artifact?.id || !artifact?.name) continue;
                this.agentArtifacts.set(String(artifact.id), {
                    id: String(artifact.id),
                    taskId: artifact.taskId ? String(artifact.taskId) : undefined,
                    name: String(artifact.name),
                    kind: this.normalizeArtifactKind(artifact.kind),
                    status: this.normalizeArtifactStatus(artifact.status),
                    summary: String(artifact.summary || ''),
                    path: artifact.path ? String(artifact.path) : undefined,
                    body: typeof artifact.body === 'string' ? artifact.body : undefined,
                    evidence: Array.isArray(artifact.evidence) ? artifact.evidence.map((item: any) => ({
                        label: String(item?.label || ''),
                        value: String(item?.value || ''),
                    })).filter((item: any) => item.label) : [],
                    attachments: Array.isArray(artifact.attachments) ? artifact.attachments.map((item: any) => ({
                        mimeType: String(item?.mimeType || item?.mime_type || 'application/octet-stream'),
                        filePath: item?.filePath ? String(item.filePath) : undefined,
                        dataBase64: item?.dataBase64 ? String(item.dataBase64) : undefined,
                    })) : [],
                    comments: Array.isArray(artifact.comments) ? artifact.comments.map((comment: any) => String(comment)).slice(-50) : [],
                    reviewThreads: this.normalizeReviewThreads(artifact.reviewThreads || artifact.review_threads || [], String(artifact.id)),
                    createdAt: Number(artifact.createdAt || Date.now()),
                    updatedAt: Number(artifact.updatedAt || Date.now()),
                });
            }

            for (const task of state.tasks.slice(0, this.agentStateStorageMaxTasks)) {
                if (!task?.id || !task?.title) continue;
                const restoredStatus = this.normalizeRestoredTaskStatus(task.status);
                this.agentTasks.set(String(task.id), {
                    id: String(task.id),
                    rpcId: undefined,
                    conversationId: task.conversationId ? String(task.conversationId) : undefined,
                    backendSessionId: task.backendSessionId ?? null,
                    title: String(task.title),
                    prompt: String(task.prompt || ''),
                    workspace: task.workspace ? String(task.workspace) : undefined,
                    provider: task.provider ? String(task.provider) : undefined,
                    model: task.model ? String(task.model) : undefined,
                    mode: task.mode ? String(task.mode) : undefined,
                    status: restoredStatus,
                    progressLabel: this.restoredTaskProgressLabel(task, restoredStatus),
                    createdAt: Number(task.createdAt || Date.now()),
                    updatedAt: Number(task.updatedAt || Date.now()),
                    artifactIds: Array.isArray(task.artifactIds)
                        ? task.artifactIds.map((id: any) => String(id)).filter((id: string) => this.agentArtifacts.has(id)).slice(-50)
                        : [],
                    timeline: Array.isArray(task.timeline) ? task.timeline.map((item: any) => ({
                        id: String(item?.id || this.stableId(String(task.id), 'restored', String(Date.now()))),
                        kind: String(item?.kind || 'event'),
                        label: String(item?.label || 'Event'),
                        detail: item?.detail ? String(item.detail) : undefined,
                        status: item?.status ? this.normalizeTaskStatus(item.status) : undefined,
                        timestamp: Number(item?.timestamp || Date.now()),
                    })).slice(-120) : [],
                    seenEventKeys: new Set(Array.isArray(task.seenEventKeys) ? task.seenEventKeys.map((item: any) => String(item)) : []),
                    turnCount: Number(task.turnCount || 0),
                    toolCallCount: Number(task.toolCallCount || 0),
                    tokenCount: Number(task.tokenCount || 0),
                    lastError: task.lastError ? String(task.lastError) : undefined,
                });
            }

            this.syncSessionArtifactsFromManager();
        } catch (error) {
            if (this.devMode) {
                console.warn('[Aixlarity] Failed to restore agent workspace state:', error);
            }
        }
    }

    private createPersistedAgentWorkspaceState(): PersistedAgentWorkspaceState {
        return createPersistedAgentWorkspaceStateModel({
            version: this.agentStateStorageVersion,
            workspace: this.workspaceEvidenceLabel(),
            tasks: Array.from(this.agentTasks.values()),
            artifacts: Array.from(this.agentArtifacts.values()),
            maxTasks: this.agentStateStorageMaxTasks,
            maxArtifacts: this.agentStateStorageMaxArtifacts,
            bodyLimit: this.agentStateArtifactBodyLimit,
            attachmentInlineLimit: this.agentStateAttachmentInlineLimit,
            truncateText: (text, maxChars, label) => this.truncateForDisplay(text, maxChars, label),
        });
    }

    private normalizeTaskStatus(status: any): AgentTaskStatus {
        return normalizeTaskStatusModel(status);
    }

    private normalizeRestoredTaskStatus(status: any): AgentTaskStatus {
        return normalizeRestoredTaskStatusModel(status);
    }

    private normalizeArtifactStatus(status: any): AgentArtifactStatus {
        return normalizeArtifactStatusModel(status);
    }

    private normalizeReviewThreads(raw: any, artifactId: string): AgentReviewThreadState[] {
        return normalizeReviewThreadsModel(raw, artifactId);
    }

    private normalizeReviewThread(raw: any, artifactId: string): AgentReviewThreadState {
        return normalizeReviewThreadModel(raw, artifactId);
    }

    private restoredTaskProgressLabel(task: any, status: AgentTaskStatus): string {
        return restoredTaskProgressLabelModel(task, status);
    }

    private createAgentEvidenceBundle(artifact?: AgentArtifactState): any {
        return createAgentEvidenceBundleModel({
            workspace: this.workspaceEvidenceLabel(),
            tasks: Array.from(this.agentTasks.values()),
            artifacts: Array.from(this.agentArtifacts.values()),
            selectedArtifact: artifact,
            bodyLimit: this.agentStateArtifactBodyLimit,
            attachmentInlineLimit: this.agentStateAttachmentInlineLimit,
            truncateText: (text, maxChars, label) => this.truncateForDisplay(text, maxChars, label),
        });
    }

    private async copyAgentEvidenceBundle(artifact?: AgentArtifactState): Promise<void> {
        const bundle = this.createAgentEvidenceBundle(artifact);
        await this.clipboardService.writeText(JSON.stringify(bundle, null, 2));
        let savedSuffix = '';
        if (this.daemonConnected) {
            try {
                const exported = await this.sendRpcToDaemonAsync('artifacts/export', { bundle });
                if (exported?.path) {
                    savedSuffix = ` Saved durable bundle: ${exported.path}`;
                }
            } catch (error) {
                if (this.devMode) {
                    console.warn('[Aixlarity] Failed to export evidence bundle:', error);
                }
            }
        }
        this.appendMessage('system', `Copied ${bundle.summary.artifactCount} artifact(s) and ${bundle.summary.taskCount} task(s) as Aixlarity evidence JSON.${savedSuffix}`);
        this.showManagerNotice('Evidence copied');
    }

    private extractToolOutput(result: any): { text: string; exitCode?: number } {
        let text = '';
        let exitCode: number | undefined;
        if (result && typeof result === 'object') {
            if (typeof result.stdout === 'string') text += result.stdout;
            if (typeof result.stderr === 'string') text += (text ? '\n' : '') + result.stderr;
            if (typeof result.output === 'string') text += (text ? '\n' : '') + result.output;
            if (typeof result.exit_code === 'number') exitCode = result.exit_code;
        } else if (typeof result === 'string') {
            text = result;
        } else if (result !== undefined) {
            text = JSON.stringify(result, null, 2);
        }
        return { text: text.trim() || '(no output)', exitCode };
    }

    private terminalEvidenceRows(result: any, args: any): Array<{ label: string; value: string }> {
        const rows: Array<{ label: string; value: string }> = [{ label: 'Tool', value: 'shell' }];
        const add = (label: string, value: unknown) => {
            if (value === undefined || value === null || value === '') return;
            rows.push({ label, value: String(value) });
        };
        add('Command ID', result?.command_id);
        add('Command', result?.command || args?.command);
        add('CWD', result?.cwd);
        add('Shell', result?.shell);
        add('Sandbox', result?.sandbox);
        add('Container', result?.container);
        add('Exit code', result?.exit_code);
        add('Duration', result?.duration_ms !== undefined ? `${result.duration_ms}ms` : undefined);
        add('Started', result?.started_at_ms ? new Date(Number(result.started_at_ms)).toLocaleString() : undefined);
        add('Finished', result?.finished_at_ms ? new Date(Number(result.finished_at_ms)).toLocaleString() : undefined);
        add('Risk', result?.risk?.level);
        add('Requires review', result?.risk?.requires_review);
        if (Array.isArray(result?.risk?.reasons) && result.risk.reasons.length > 0) {
            add('Risk reasons', result.risk.reasons.join(' | '));
        }
        add('Env policy', result?.env?.value_policy);
        if (Array.isArray(result?.env?.keys)) {
            add('Env keys', result.env.keys.join(', '));
        }
        return rows;
    }

    private formatTerminalTranscript(result: any, args: any): string {
        const command = result?.command || args?.command || '';
        const cwd = result?.cwd || '';
        const stdout = typeof result?.stdout === 'string' ? result.stdout : result?.transcript?.stdout || '';
        const stderr = typeof result?.stderr === 'string' ? result.stderr : result?.transcript?.stderr || '';
        const exitCode = result?.exit_code ?? result?.transcript?.exit_code ?? 'unknown';
        const duration = result?.duration_ms !== undefined ? `${result.duration_ms}ms` : 'unknown';
        const envKeys = Array.isArray(result?.env?.keys) ? result.env.keys.join(', ') : 'not captured';
        const riskLevel = result?.risk?.level || 'unknown';
        const riskReasons = Array.isArray(result?.risk?.reasons) ? result.risk.reasons.join('; ') : '';
        const lines = [
            '# Terminal Transcript',
            '',
            `Command ID: ${result?.command_id || 'unknown'}`,
            `CWD: ${cwd || 'unknown'}`,
            `Shell: ${result?.shell || 'unknown'}`,
            `Sandbox: ${result?.sandbox || 'unknown'}`,
            `Duration: ${duration}`,
            `Exit code: ${exitCode}`,
            `Risk: ${riskLevel}`,
            riskReasons ? `Risk reasons: ${riskReasons}` : 'Risk reasons: none',
            `Env keys: ${envKeys}`,
            `Env policy: ${result?.env?.value_policy || 'Environment values omitted.'}`,
            '',
            '$ ' + command,
            '',
            '## stdout',
            stdout || '(empty)',
            '',
            '## stderr',
            stderr || '(empty)',
        ];
        return this.truncateForDisplay(lines.join('\n'), 50000, 'terminal transcript');
    }

    private browserEvidenceRows(result: any, evidence: any): Array<{ label: string; value: string }> {
        const rows: Array<{ label: string; value: string }> = [{ label: 'Tool', value: 'browser_subagent' }];
        const source = evidence || {};
        const add = (label: string, value: unknown) => {
            if (value === undefined || value === null || value === '') return;
            rows.push({ label, value: String(value) });
        };
        add('Capture level', source.capture_level || result?.capture_level);
        add('URL', result?.url || source.url);
        add('Final URL', result?.final_url || source.final_url);
        add('Title', result?.title || source.title);
        add('Main response', result?.main_response?.status);
        add('Duration', source.duration_ms !== undefined ? `${source.duration_ms}ms` : undefined);
        add('Actions', source.action_count ?? source.actions?.length);
        add('DOM text', source.dom?.bodyTextLength !== undefined ? `${source.dom.bodyTextLength} chars` : undefined);
        add('HTML', source.dom?.htmlLength !== undefined ? `${source.dom.htmlLength} chars` : undefined);
        add('Console events', Array.isArray(source.console) ? source.console.length : undefined);
        add('Network requests', source.network?.request_count ?? source.network?.requests?.length);
        add('Failed requests', source.network?.failed_count ?? source.network?.failed?.length);
        add('Screenshot bytes', source.screenshot?.sizeBytes ?? source.screenshot?.size_bytes);
        add('Video bytes', source.video?.sizeBytes ?? source.video?.size_bytes);
        add('Video path', source.video?.path);
        if (result?.navigation_error) {
            add('Navigation error', result.navigation_error);
        }
        if (result?.action_error) {
            add('Action error', result.action_error);
        }
        if (result?.fallback_error) {
            add('Fallback reason', result.fallback_error);
        }
        return rows;
    }

    private formatBrowserEvidenceBody(result: any, evidence: any): string {
        const source = evidence || {};
        const lines: string[] = [];
        lines.push(`# Browser Evidence`);
        lines.push('');
        lines.push(`Task: ${source.task || 'browser verification'}`);
        lines.push(`URL: ${result?.url || source.url || ''}`);
        lines.push(`Final URL: ${result?.final_url || source.final_url || ''}`);
        lines.push(`Title: ${result?.title || source.title || ''}`);
        lines.push(`Capture: ${source.capture_level || result?.capture_level || 'browser'}`);
        if (result?.navigation_error) {
            lines.push(`Navigation error: ${result.navigation_error}`);
        }
        if (result?.action_error) {
            lines.push(`Action error: ${result.action_error}`);
        }
        if (result?.fallback_error) {
            lines.push(`Fallback reason: ${result.fallback_error}`);
        }

        if (Array.isArray(source.actions) && source.actions.length > 0) {
            lines.push('');
            lines.push('## Action Timeline');
            for (const action of source.actions.slice(0, 80)) {
                const selector = action.selector ? ` ${action.selector}` : '';
                const detail = action.error ? ` - ${action.error}` : '';
                lines.push(`- #${action.index ?? '?'} ${action.type || 'action'}${selector}: ${action.status || 'unknown'} (${action.duration_ms ?? '?'}ms)${detail}`);
            }
        }

        if (source.dom) {
            lines.push('');
            lines.push('## DOM Summary');
            lines.push(`HTML length: ${source.dom.htmlLength ?? 0}`);
            lines.push(`Body text length: ${source.dom.bodyTextLength ?? 0}`);
            if (Array.isArray(source.dom.headings) && source.dom.headings.length > 0) {
                lines.push('');
                lines.push('Headings:');
                for (const heading of source.dom.headings.slice(0, 30)) {
                    lines.push(`- ${heading.level || 'h'} ${heading.text || ''}`);
                }
            }
            if (Array.isArray(source.dom.buttons) && source.dom.buttons.length > 0) {
                lines.push('');
                lines.push('Buttons:');
                for (const button of source.dom.buttons.slice(0, 40)) {
                    lines.push(`- ${button.text || button.type || 'button'}${button.disabled ? ' (disabled)' : ''}`);
                }
            }
            if (Array.isArray(source.dom.inputs) && source.dom.inputs.length > 0) {
                lines.push('');
                lines.push('Inputs:');
                for (const input of source.dom.inputs.slice(0, 40)) {
                    lines.push(`- ${input.tag || 'input'} ${input.type || ''} ${input.name || ''} ${input.placeholder || ''}`.trim());
                }
            }
            if (source.dom.bodyTextPreview) {
                lines.push('');
                lines.push('Text preview:');
                lines.push(source.dom.bodyTextPreview);
            }
        }

        if (Array.isArray(source.console) && source.console.length > 0) {
            lines.push('');
            lines.push('## Console');
            for (const item of source.console.slice(0, 80)) {
                lines.push(`- [${item.type || 'log'}] ${item.text || ''}`);
            }
        }

        const network = source.network || {};
        if (Array.isArray(network.failed) && network.failed.length > 0) {
            lines.push('');
            lines.push('## Failed Network Requests');
            for (const req of network.failed.slice(0, 60)) {
                lines.push(`- ${req.method || 'GET'} ${req.url || ''} - ${req.errorText || 'failed'}`);
            }
        }
        if (Array.isArray(network.responses) && network.responses.length > 0) {
            lines.push('');
            lines.push('## Network Responses');
            for (const response of network.responses.slice(0, 80)) {
                lines.push(`- ${response.status || '?'} ${response.requestMethod || ''} ${response.url || ''}`);
            }
        }

        return this.truncateForDisplay(lines.join('\n'), 50000, 'browser evidence');
    }

    private decodeBase64Text(dataBase64: string): string {
        try {
            return decodeURIComponent(escape(atob(dataBase64)));
        } catch {
            try {
                return atob(dataBase64);
            } catch {
                return '[Unable to decode attachment]';
            }
        }
    }

    private normalizeAttachmentRefs(attachments: any[] | undefined): AgentArtifactAttachmentRef[] {
        if (!Array.isArray(attachments)) return [];
        return attachments.map(att => ({
            mimeType: att.mime_type || att.mimeType || 'application/octet-stream',
            filePath: att.file_path || att.filePath,
            dataBase64: att.data_base64 || att.dataBase64,
        }));
    }

    private normalizeArtifactKind(kind: string | undefined): AgentArtifactKind {
        return normalizeArtifactKindModel(kind);
    }

    private formatShortTime(timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    private makeTaskTitle(prompt: string): string {
        const compact = prompt.replace(/\s+/g, ' ').trim();
        return compact.length > 80 ? `${compact.slice(0, 77)}...` : (compact || 'Agent task');
    }

    private basename(path: string | undefined): string {
        if (!path) return '';
        return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path);
    }

    private stableId(...parts: string[]): string {
        return parts.join(':').replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 180);
    }

    private agentEventKey(event: any): string {
        return JSON.stringify([
            event.event,
            event.turn,
            event.call_id,
            event.tool_name,
            event.path,
            event.task_name,
            event.summary,
            event.id,
        ]);
    }

    private eventLabel(eventName: string): string {
        return String(eventName || 'event')
            .split('_')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    private toolEventLabel(event: any): string {
        const tool = event.tool_name || 'tool';
        const args = event.arguments || {};
        if (args.command) return `${tool}: ${String(args.command).slice(0, 160)}`;
        if (args.path || args.file_path) return `${tool}: ${args.path || args.file_path}`;
        if (args.url) return `${tool}: ${args.url}`;
        return tool;
    }

    private coordinatorProgressLabel(event: any): string {
        if (event.event === 'coordinator_started') return `Coordinator started ${event.task_count || 0} tasks.`;
        if (event.event === 'coordinator_task_completed') return `${event.task_name || 'Task'} completed: ${event.status || 'done'}.`;
        if (event.event === 'coordinator_completed') return `Coordinator completed ${event.completed_count || 0}, failed ${event.failed_count || 0}.`;
        return event.task_name || this.eventLabel(event.event);
    }

    private mergeProgressLabel(event: any): string {
        if (event.event === 'patch_conflict') return `${event.task_name || 'Patch'} conflict: ${event.error || ''}`;
        if (event.event === 'patch_applied') return `${event.task_name || 'Patch'} applied to ${(event.changed_files || []).length} files.`;
        if (event.event === 'worktree_created') return `Worktree created: ${event.worktree_path || ''}`;
        if (event.event === 'worktree_collected') return `Collected ${event.changed_file_count || 0} changed files.`;
        return this.eventLabel(event.event);
    }

    // --- Bottom Status Bar ---

    private updateBottomStatus(): void {
        if (!this.bottomStatusBar) return;
        this.bottomStatusBar.textContent = '';

	        // Changed files section
	        if (this.changedFiles.size > 0) {
	            const section = append(this.bottomStatusBar, $('div.aixlarity-status-section'));
	            append(section, $('span.aixlarity-status-section-label')).textContent = 'Changed';
	            const files = Array.from(this.changedFiles);
	            const visibleFiles = files.slice(-8);
	            for (const file of visibleFiles) {
	                const pill = append(section, $('span.aixlarity-file-pill'));
	                pill.textContent = file;
	                pill.title = `Modified: ${file}`;
	            }
	            if (files.length > visibleFiles.length) {
	                const more = append(section, $('span.aixlarity-file-pill'));
	                more.textContent = `+${files.length - visibleFiles.length} more`;
	                more.title = `${files.length - visibleFiles.length} additional changed files`;
	            }
	        }

	        // Artifacts section
	        if (this.sessionArtifacts.length > 0) {
	            const section = append(this.bottomStatusBar, $('div.aixlarity-status-section'));
	            append(section, $('span.aixlarity-status-section-label')).textContent = 'Artifacts';
	            const visibleArtifacts = this.sessionArtifacts.slice(-8);
	            for (const artifact of visibleArtifacts) {
	                const pill = append(section, $('span.aixlarity-artifact-pill'));
	                append(pill, $('span.codicon.codicon-file-code', { style: 'font-size: 10px;' }));
	                append(pill, $('span')).textContent = artifact.name;
	                pill.title = `Type: ${artifact.type}${artifact.status ? ` · ${artifact.status}` : ''}`;
	                if (artifact.id) {
	                    pill.addEventListener('click', () => this.openArtifactInspector(artifact.id!));
	                }
	            }
	            if (this.sessionArtifacts.length > visibleArtifacts.length) {
	                const more = append(section, $('span.aixlarity-artifact-pill'));
	                append(more, $('span.codicon.codicon-ellipsis', { style: 'font-size: 10px;' }));
	                append(more, $('span')).textContent = `+${this.sessionArtifacts.length - visibleArtifacts.length} more`;
	            }
	        }
	    }
}
