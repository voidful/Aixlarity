export type AgentTaskStatus = 'queued' | 'running' | 'waiting_review' | 'paused' | 'completed' | 'failed' | 'stopped';
export type AgentArtifactStatus = 'draft' | 'needs_review' | 'approved' | 'rejected';
export type AgentArtifactKind =
    | 'task_list'
    | 'implementation_plan'
    | 'walkthrough'
    | 'code_diff'
    | 'screenshot'
    | 'browser_recording'
    | 'terminal_transcript'
    | 'test_report'
    | 'file_change'
    | 'checkpoint'
    | 'other';

export interface AgentTaskTimelineEvent {
    id: string;
    kind: string;
    label: string;
    detail?: string;
    status?: AgentTaskStatus;
    timestamp: number;
}

export interface AgentArtifactAttachmentRef {
    mimeType: string;
    filePath?: string;
    dataBase64?: string;
}

export interface AgentReviewThreadComment {
    id: string;
    author: string;
    body: string;
    createdAt: number;
}

export interface AgentReviewAnchor {
    kind: string;
    label: string;
    path?: string;
    line?: number;
    column?: number;
    startLine?: number;
    endLine?: number;
    selector?: string;
    url?: string;
    timeMs?: number;
    region?: any;
}

export interface AgentReviewThreadState {
    id: string;
    artifactId: string;
    anchor: AgentReviewAnchor;
    status: 'open' | 'resolved';
    comments: AgentReviewThreadComment[];
    createdAt: number;
    updatedAt: number;
}

export interface AgentArtifactState {
    id: string;
    taskId?: string;
    name: string;
    kind: AgentArtifactKind;
    status: AgentArtifactStatus;
    summary: string;
    path?: string;
    body?: string;
    evidence: Array<{ label: string; value: string }>;
    attachments: AgentArtifactAttachmentRef[];
    comments: string[];
    reviewThreads: AgentReviewThreadState[];
    createdAt: number;
    updatedAt: number;
}

export interface AgentTaskState {
    id: string;
    rpcId?: string;
    conversationId?: string;
    backendSessionId?: string | null;
    title: string;
    prompt: string;
    workspace?: string;
    provider?: string;
    model?: string;
    mode?: string;
    status: AgentTaskStatus;
    progressLabel: string;
    createdAt: number;
    updatedAt: number;
    artifactIds: string[];
    timeline: AgentTaskTimelineEvent[];
    seenEventKeys: Set<string>;
    turnCount: number;
    toolCallCount: number;
    tokenCount: number;
    lastError?: string;
}

export interface PersistedAgentWorkspaceState {
    version: number;
    savedAt: number;
    workspace: string;
    tasks: any[];
    artifacts: any[];
}

export interface PendingApprovalState {
    callId: string;
    rpcId?: string;
    taskId?: string;
    toolName: string;
    description: string;
    arguments: any;
    createdAt: number;
}

export function normalizeArtifactKind(kind: string | undefined): AgentArtifactKind {
    const value = String(kind || '').toLowerCase().replace(/[-\s]+/g, '_');
    if (value.includes('task')) return 'task_list';
    if (value.includes('implementation') || value.includes('plan')) return 'implementation_plan';
    if (value.includes('walkthrough') || value.includes('summary')) return 'walkthrough';
    if (value.includes('diff')) return 'code_diff';
    if (value.includes('screen')) return 'screenshot';
    if (value.includes('record') || value.includes('video')) return 'browser_recording';
    if (value.includes('terminal') || value.includes('shell')) return 'terminal_transcript';
    if (value.includes('test')) return 'test_report';
    if (value.includes('checkpoint')) return 'checkpoint';
    if (value.includes('file')) return 'file_change';
    return 'other';
}

export function normalizeArtifactStatus(status: any): AgentArtifactStatus {
    const value = String(status || '');
    if (value === 'draft' || value === 'needs_review' || value === 'approved' || value === 'rejected') {
        return value;
    }
    return 'draft';
}

export function normalizeTaskStatus(status: any): AgentTaskStatus {
    const value = String(status || '');
    if (value === 'queued' || value === 'running' || value === 'waiting_review' || value === 'paused' || value === 'completed' || value === 'failed' || value === 'stopped') {
        return value;
    }
    return 'paused';
}

export function normalizeRestoredTaskStatus(status: any): AgentTaskStatus {
    const value = normalizeTaskStatus(status);
    return (value === 'running' || value === 'queued' || value === 'waiting_review') ? 'paused' : value;
}

export function normalizeAttachmentRefs(attachments: any[] | undefined): AgentArtifactAttachmentRef[] {
    if (!Array.isArray(attachments)) return [];
    return attachments.map(att => ({
        mimeType: att.mime_type || att.mimeType || 'application/octet-stream',
        filePath: att.file_path || att.filePath,
        dataBase64: att.data_base64 || att.dataBase64,
    }));
}

export function normalizeReviewThreads(raw: any, artifactId: string): AgentReviewThreadState[] {
    const threads = Array.isArray(raw) ? raw : [];
    return threads
        .map(thread => normalizeReviewThread(thread, artifactId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 400);
}

export function normalizeReviewThread(raw: any, artifactId: string): AgentReviewThreadState {
    const now = Date.now();
    const anchorRaw = raw?.anchor || {};
    const anchor: AgentReviewAnchor = {
        kind: String(anchorRaw.kind || 'artifact'),
        label: String(anchorRaw.label || anchorRaw.target || 'Entire artifact'),
        path: anchorRaw.path ? String(anchorRaw.path) : undefined,
        line: anchorRaw.line !== undefined ? Number(anchorRaw.line) : undefined,
        column: anchorRaw.column !== undefined ? Number(anchorRaw.column) : undefined,
        startLine: anchorRaw.startLine !== undefined ? Number(anchorRaw.startLine) : undefined,
        endLine: anchorRaw.endLine !== undefined ? Number(anchorRaw.endLine) : undefined,
        selector: anchorRaw.selector ? String(anchorRaw.selector) : undefined,
        url: anchorRaw.url ? String(anchorRaw.url) : undefined,
        timeMs: anchorRaw.timeMs !== undefined ? Number(anchorRaw.timeMs) : undefined,
        region: anchorRaw.region,
    };
    const status = String(raw?.status || 'open') === 'resolved' ? 'resolved' : 'open';
    const comments = Array.isArray(raw?.comments) ? raw.comments : [];
    return {
        id: String(raw?.id || `thread-${now}-${Math.random().toString(36).slice(2, 7)}`),
        artifactId: String(raw?.artifactId || raw?.artifact_id || artifactId),
        anchor,
        status,
        comments: comments.map((comment: any) => ({
            id: String(comment?.id || `comment-${now}-${Math.random().toString(36).slice(2, 7)}`),
            author: String(comment?.author || 'user'),
            body: String(comment?.body || comment?.comment || comment || ''),
            createdAt: Number(comment?.createdAt || comment?.created_at_ms || now),
        })).filter((comment: AgentReviewThreadComment) => comment.body).slice(-80),
        createdAt: Number(raw?.createdAt || raw?.created_at_ms || now),
        updatedAt: Number(raw?.updatedAt || raw?.updated_at_ms || now),
    };
}

export function restoredTaskProgressLabel(task: any, status: AgentTaskStatus): string {
    const label = String(task?.progressLabel || '');
    if (status === 'paused' && (task?.status === 'running' || task?.status === 'queued' || task?.status === 'waiting_review')) {
        return 'Task was restored from a previous IDE session. Use Resume to continue with fresh verification.';
    }
    return label || 'Task restored from prior IDE state.';
}

export function serializeTaskState(task: AgentTaskState, artifactIds?: Set<string>): any {
    const status = (task.status === 'running' || task.status === 'queued' || task.status === 'waiting_review') ? 'paused' : task.status;
    return {
        id: task.id,
        conversationId: task.conversationId,
        backendSessionId: task.backendSessionId ?? null,
        title: task.title,
        prompt: task.prompt,
        workspace: task.workspace,
        provider: task.provider,
        model: task.model,
        mode: task.mode,
        status,
        progressLabel: status === task.status ? task.progressLabel : 'Task was interrupted by IDE shutdown. Use Resume to continue.',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        artifactIds: task.artifactIds.filter(id => !artifactIds || artifactIds.has(id)),
        timeline: task.timeline.slice(-120),
        seenEventKeys: Array.from(task.seenEventKeys).slice(-400),
        turnCount: task.turnCount,
        toolCallCount: task.toolCallCount,
        tokenCount: task.tokenCount,
        lastError: task.lastError,
    };
}

export interface SerializeArtifactOptions {
    forPersistence: boolean;
    bodyLimit: number;
    attachmentInlineLimit: number;
    truncateText: (text: string, maxChars: number, label: string) => string;
}

export function serializeArtifactState(artifact: AgentArtifactState, options: SerializeArtifactOptions): any {
    return {
        id: artifact.id,
        taskId: artifact.taskId,
        name: artifact.name,
        kind: artifact.kind,
        status: artifact.status,
        summary: artifact.summary,
        path: artifact.path,
        body: artifact.body ? options.truncateText(artifact.body, options.bodyLimit, 'artifact body') : undefined,
        evidence: artifact.evidence,
        attachments: artifact.attachments.map(attachment => ({
            mimeType: attachment.mimeType,
            filePath: attachment.filePath,
            dataBase64: !options.forPersistence || (attachment.dataBase64 && attachment.dataBase64.length <= options.attachmentInlineLimit)
                ? attachment.dataBase64
                : undefined,
        })),
        comments: artifact.comments.slice(-50),
        reviewThreads: artifact.reviewThreads.slice(0, 400),
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
    };
}

export interface WorkspaceStateOptions {
    version: number;
    workspace: string;
    tasks: AgentTaskState[];
    artifacts: AgentArtifactState[];
    maxTasks: number;
    maxArtifacts: number;
    bodyLimit: number;
    attachmentInlineLimit: number;
    now?: number;
    truncateText: (text: string, maxChars: number, label: string) => string;
}

export function createPersistedAgentWorkspaceState(options: WorkspaceStateOptions): PersistedAgentWorkspaceState {
    const artifacts = options.artifacts
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, options.maxArtifacts)
        .map(artifact => serializeArtifactState(artifact, {
            forPersistence: true,
            bodyLimit: options.bodyLimit,
            attachmentInlineLimit: options.attachmentInlineLimit,
            truncateText: options.truncateText,
        }));
    const artifactIds = new Set(artifacts.map((artifact: any) => artifact.id));
    const tasks = options.tasks
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, options.maxTasks)
        .map(task => serializeTaskState(task, artifactIds));
    return {
        version: options.version,
        savedAt: options.now ?? Date.now(),
        workspace: options.workspace,
        tasks,
        artifacts,
    };
}

export interface EvidenceBundleOptions {
    workspace: string;
    tasks: AgentTaskState[];
    artifacts: AgentArtifactState[];
    selectedArtifact?: AgentArtifactState;
    bodyLimit: number;
    attachmentInlineLimit: number;
    nowIso?: string;
    truncateText: (text: string, maxChars: number, label: string) => string;
}

export function createAgentEvidenceBundle(options: EvidenceBundleOptions): any {
    const selectedArtifactIds = options.selectedArtifact ? new Set([options.selectedArtifact.id]) : undefined;
    const artifacts = options.artifacts
        .filter(item => !selectedArtifactIds || selectedArtifactIds.has(item.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(item => serializeArtifactState(item, {
            forPersistence: false,
            bodyLimit: options.bodyLimit,
            attachmentInlineLimit: options.attachmentInlineLimit,
            truncateText: options.truncateText,
        }));
    const artifactIds = new Set(artifacts.map((item: any) => item.id));
    const tasks = options.tasks
        .filter(task => !selectedArtifactIds || task.artifactIds.some(id => artifactIds.has(id)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(task => serializeTaskState(task, artifactIds));
    return {
        schema: 'aixlarity.agent_evidence_bundle.v1',
        exportedAt: options.nowIso ?? new Date().toISOString(),
        workspace: options.workspace,
        summary: {
            taskCount: tasks.length,
            artifactCount: artifacts.length,
            selectedArtifactId: options.selectedArtifact?.id,
        },
        tasks,
        artifacts,
    };
}
