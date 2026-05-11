import type { AgentArtifactState, AgentReviewThreadState } from './aixlarityArtifactModel.js';

export type AiDiffLineKind = 'context' | 'add' | 'delete' | 'hunk' | 'meta';

export interface AiDiffLine {
    kind: AiDiffLineKind;
    text: string;
    oldNumber?: number;
    newNumber?: number;
}

export interface AiDiffPairRow {
    kind: 'context' | 'add' | 'delete' | 'change' | 'hunk' | 'meta';
    oldNumber?: number;
    newNumber?: number;
    oldText?: string;
    newText?: string;
    text?: string;
}

export interface AiDiffHunk {
    id: string;
    fileIndex: number;
    hunkIndex: number;
    filePath: string;
    header: string;
    oldStart: number;
    newStart: number;
    additions: number;
    deletions: number;
    rows: AiDiffPairRow[];
}

export interface AiDiffFile {
    oldPath: string;
    newPath: string;
    displayPath: string;
    status: 'added' | 'deleted' | 'modified' | 'renamed';
    additions: number;
    deletions: number;
    lines: AiDiffLine[];
    rows: AiDiffPairRow[];
    hunks: AiDiffHunk[];
}

export interface AiDiffSummary {
    files: AiDiffFile[];
    additions: number;
    deletions: number;
    changeBlocks: number;
}

export interface AiDiffSnapshotFile {
    path: string;
    before: string;
    after: string;
    beforeHash: string;
    afterHash: string;
    additions: number;
    deletions: number;
    status: AiDiffFile['status'];
}

export interface AiDiffSnapshot {
    artifactId: string;
    name: string;
    files: AiDiffSnapshotFile[];
    beforeHash: string;
    afterHash: string;
    createdAt: number;
}

export interface AiDiffRiskProfile {
    level: 'low' | 'medium' | 'high';
    summary: string;
    labels: string[];
}

export type AiDiffHunkReviewAction = 'approve' | 'reject' | 'comment' | 'rewrite';

export interface AiDiffImpactMap {
    symbols: string[];
    testCommands: string[];
    riskFiles: string[];
    reviewCues: string[];
}

export interface AiDiffReviewGate {
    label: string;
    blocked: boolean;
    reason: string;
}

export function stableId(...parts: string[]): string {
    return parts.join(':').replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 180);
}

export function stableTextHash(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseUnifiedDiff(diffText: string, fallbackPath?: string): AiDiffSummary {
    const files: AiDiffFile[] = [];
    let current: AiDiffFile | null = null;
    let oldLine = 0;
    let newLine = 0;

    const cleanPath = (value: string) => {
        const trimmed = value.trim().replace(/^"|"$/g, '');
        if (trimmed === '/dev/null') return trimmed;
        return trimmed.replace(/^[ab]\//, '') || fallbackPath || 'changes';
    };
    const fileStatus = (oldPath: string, newPath: string): AiDiffFile['status'] => {
        if (oldPath === '/dev/null') return 'added';
        if (newPath === '/dev/null') return 'deleted';
        if (oldPath !== newPath) return 'renamed';
        return 'modified';
    };
    const ensureFile = () => {
        if (!current) {
            const path = fallbackPath || 'AI changes';
            current = {
                oldPath: path,
                newPath: path,
                displayPath: path,
                status: 'modified',
                additions: 0,
                deletions: 0,
                lines: [],
                rows: [],
                hunks: [],
            };
            files.push(current);
        }
        return current;
    };
    const startFile = (oldPath: string, newPath: string) => {
        current = {
            oldPath,
            newPath,
            displayPath: newPath === '/dev/null' ? oldPath : newPath,
            status: fileStatus(oldPath, newPath),
            additions: 0,
            deletions: 0,
            lines: [],
            rows: [],
            hunks: [],
        };
        files.push(current);
    };

    for (const rawLine of diffText.split(/\r?\n/)) {
        const diffMatch = rawLine.match(/^diff --git\s+(.+?)\s+(.+)$/);
        if (diffMatch) {
            startFile(cleanPath(diffMatch[1]), cleanPath(diffMatch[2]));
            current!.lines.push({ kind: 'meta', text: rawLine });
            continue;
        }

        const file = ensureFile();
        if (rawLine.startsWith('--- ')) {
            file.oldPath = cleanPath(rawLine.slice(4));
            file.status = fileStatus(file.oldPath, file.newPath);
            file.displayPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
            file.lines.push({ kind: 'meta', text: rawLine });
            continue;
        }
        if (rawLine.startsWith('+++ ')) {
            file.newPath = cleanPath(rawLine.slice(4));
            file.status = fileStatus(file.oldPath, file.newPath);
            file.displayPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
            file.lines.push({ kind: 'meta', text: rawLine });
            continue;
        }
        const hunkMatch = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
            oldLine = Number(hunkMatch[1]);
            newLine = Number(hunkMatch[2]);
            file.lines.push({ kind: 'hunk', text: rawLine });
            continue;
        }
        if (rawLine.startsWith('+')) {
            file.lines.push({ kind: 'add', text: rawLine.slice(1), newNumber: newLine++ });
            file.additions++;
            continue;
        }
        if (rawLine.startsWith('-')) {
            file.lines.push({ kind: 'delete', text: rawLine.slice(1), oldNumber: oldLine++ });
            file.deletions++;
            continue;
        }
        if (rawLine.startsWith(' ')) {
            file.lines.push({ kind: 'context', text: rawLine.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
            continue;
        }
        file.lines.push({ kind: 'meta', text: rawLine });
    }

    if (files.length === 0) {
        ensureFile();
    }
    files.forEach((file, index) => {
        file.rows = pairDiffRows(file.lines);
        file.hunks = buildDiffHunks(file, index);
    });
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const changeBlocks = files.reduce((sum, file) => sum + file.rows.filter(row => row.kind === 'add' || row.kind === 'delete' || row.kind === 'change').length, 0);
    return { files, additions, deletions, changeBlocks };
}

export function pairDiffRows(lines: AiDiffLine[]): AiDiffPairRow[] {
    const rows: AiDiffPairRow[] = [];
    let deletes: AiDiffLine[] = [];
    let adds: AiDiffLine[] = [];
    const flush = () => {
        const count = Math.max(deletes.length, adds.length);
        for (let index = 0; index < count; index++) {
            const del = deletes[index];
            const add = adds[index];
            if (del && add) {
                rows.push({
                    kind: 'change',
                    oldNumber: del.oldNumber,
                    newNumber: add.newNumber,
                    oldText: del.text,
                    newText: add.text,
                });
            } else if (del) {
                rows.push({ kind: 'delete', oldNumber: del.oldNumber, oldText: del.text });
            } else if (add) {
                rows.push({ kind: 'add', newNumber: add.newNumber, newText: add.text });
            }
        }
        deletes = [];
        adds = [];
    };

    for (const line of lines) {
        if (line.kind === 'delete') {
            deletes.push(line);
            continue;
        }
        if (line.kind === 'add') {
            adds.push(line);
            continue;
        }
        flush();
        if (line.kind === 'context') {
            rows.push({
                kind: 'context',
                oldNumber: line.oldNumber,
                newNumber: line.newNumber,
                oldText: line.text,
                newText: line.text,
            });
        } else {
            rows.push({ kind: line.kind, text: line.text });
        }
    }
    flush();
    return rows;
}

export function buildDiffHunks(file: AiDiffFile, fileIndex: number): AiDiffHunk[] {
    const hunks: AiDiffHunk[] = [];
    let current: AiDiffHunk | null = null;
    const startHunk = (header: string, oldStart: number, newStart: number) => {
        if (current) {
            hunks.push(current);
        }
        const hunkIndex = hunks.length + 1;
        current = {
            id: stableId(file.displayPath, 'hunk', String(hunkIndex), String(oldStart), String(newStart)),
            fileIndex,
            hunkIndex,
            filePath: file.displayPath,
            header,
            oldStart,
            newStart,
            additions: 0,
            deletions: 0,
            rows: [],
        };
    };

    for (const row of file.rows) {
        if (row.kind === 'hunk') {
            const header = row.text || `@@ ${file.displayPath} @@`;
            const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/);
            startHunk(header, match ? Number(match[1]) : 0, match ? Number(match[2]) : 0);
            continue;
        }
        if (!current && (row.kind === 'add' || row.kind === 'delete' || row.kind === 'change')) {
            startHunk(`@@ ${file.displayPath} @@`, row.oldNumber || 0, row.newNumber || 0);
        }
        if (!current) {
            continue;
        }
        const activeHunk = current as AiDiffHunk;
        activeHunk.rows.push(row);
        if (row.kind === 'add') {
            activeHunk.additions++;
        } else if (row.kind === 'delete') {
            activeHunk.deletions++;
        } else if (row.kind === 'change') {
            activeHunk.additions++;
            activeHunk.deletions++;
        }
    }
    if (current) {
        hunks.push(current);
    }
    return hunks;
}

export function buildDiffSnapshot(artifact: AgentArtifactState | undefined, parsed: AiDiffSummary, now = Date.now()): AiDiffSnapshot {
    const files = parsed.files.map(file => buildDiffSnapshotFile(file));
    return {
        artifactId: artifact?.id || stableId('transient-diff', String(now)),
        name: artifact?.name || 'Diff Snapshot',
        files,
        beforeHash: stableTextHash(files.map(file => `${file.path}:${file.beforeHash}`).join('\n')),
        afterHash: stableTextHash(files.map(file => `${file.path}:${file.afterHash}`).join('\n')),
        createdAt: artifact?.createdAt || now,
    };
}

export function buildDiffSnapshotFile(file: AiDiffFile): AiDiffSnapshotFile {
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const line of file.lines) {
        if (line.kind === 'context') {
            beforeLines.push(line.text);
            afterLines.push(line.text);
        } else if (line.kind === 'delete') {
            beforeLines.push(line.text);
        } else if (line.kind === 'add') {
            afterLines.push(line.text);
        }
    }
    const before = beforeLines.join('\n');
    const after = afterLines.join('\n');
    return {
        path: file.displayPath,
        before,
        after,
        beforeHash: stableTextHash(before),
        afterHash: stableTextHash(after),
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
    };
}

export function createDiffRiskProfile(parsed: AiDiffSummary, artifact?: AgentArtifactState): AiDiffRiskProfile {
    const paths = parsed.files.map(file => file.displayPath);
    const body = parsed.files.flatMap(file => file.lines.map(line => line.text)).join('\n');
    const labels: string[] = [];
    let score = 0;
    const totalChanges = parsed.additions + parsed.deletions;
    const publicApiTouched = /\b(export|interface|class|function|pub\s+(fn|struct|enum|trait)|trait\s+\w+)/.test(body);
    const configTouched = paths.some(path => /(^|\/)(package\.json|Cargo\.toml|tsconfig|vite\.config|webpack|rollup|eslint|prettier|config|settings)/i.test(path));
    const testsTouched = paths.some(path => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\./i.test(path));
    const deleteHeavy = parsed.deletions > Math.max(8, parsed.additions * 1.6);

    if (parsed.files.length > 8) score += 2;
    else if (parsed.files.length > 3) score += 1;
    if (totalChanges > 300) score += 2;
    else if (totalChanges > 80) score += 1;
    if (publicApiTouched) score += 1;
    if (configTouched) score += 1;
    if (deleteHeavy) score += 1;
    if (!testsTouched && totalChanges > 20) score += 1;

    if (publicApiTouched) labels.push('Public API');
    if (configTouched) labels.push('Config');
    if (testsTouched) labels.push('Tests touched');
    else labels.push('No tests changed');
    if (deleteHeavy) labels.push('Delete-heavy');
    if (artifact?.taskId) labels.push('Task-linked');

    const level: AiDiffRiskProfile['level'] = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
    const topPaths = paths.slice(0, 3).join(', ') || 'changes';
    const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
    return {
        level,
        labels,
        summary: `${parsed.files.length} files, +${parsed.additions}/-${parsed.deletions}. ${topPaths}${more}.`,
    };
}

export function createDiffImpactMap(parsed: AiDiffSummary): AiDiffImpactMap {
    const paths = parsed.files.map(file => file.displayPath);
    const changedText = parsed.files
        .flatMap(file => file.lines.filter(line => line.kind === 'add' || line.kind === 'delete').map(line => line.text))
        .join('\n');
    const symbols = Array.from(new Set(Array.from(changedText.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|trait|struct|fn)\s+([A-Za-z_][\w]*)/g))
        .map(match => match[1])
        .filter(Boolean)))
        .slice(0, 12);
    const riskFiles = paths.filter(path =>
        /(^|\/)(package\.json|Cargo\.toml|Cargo\.lock|pnpm-lock|yarn\.lock|package-lock|tsconfig|vite\.config|webpack|rollup|eslint|prettier|config|settings|auth|security|migration|schema)/i.test(path)
    ).slice(0, 10);
    const testCommands = suggestDiffTestCommands(paths);
    const reviewCues: string[] = [];
    if (parsed.deletions > Math.max(8, parsed.additions * 1.6)) reviewCues.push('Deletion-heavy change');
    if (!paths.some(path => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\./i.test(path))) reviewCues.push('No test files changed');
    if (symbols.length > 0) reviewCues.push('Symbol-level API surface touched');
    if (riskFiles.length > 0) reviewCues.push('Config or security-sensitive file touched');
    if (reviewCues.length === 0) reviewCues.push('Low structural impact');
    return {
        symbols: symbols.length > 0 ? symbols : ['No named symbols detected'],
        testCommands,
        riskFiles: riskFiles.length > 0 ? riskFiles : ['No high-risk paths detected'],
        reviewCues,
    };
}

export function suggestDiffTestCommands(paths: string[]): string[] {
    const commands: string[] = [];
    const add = (command: string) => {
        if (!commands.includes(command)) commands.push(command);
    };
    if (paths.some(path => /\.(ts|tsx|js|jsx)$|package\.json$|tsconfig/i.test(path))) {
        add('npm run compile-check-ts-native');
    }
    if (paths.some(path => /aixlarity-ide\/|src\/vs\/workbench\/contrib\/aixlarity|test\/aixlarity/i.test(path))) {
        add('npm run test-aixlarity-ui');
    }
    if (paths.some(path => /\.rs$|Cargo\.toml$|Cargo\.lock$/i.test(path))) {
        add('cargo test');
    }
    if (paths.some(path => /\.py$/i.test(path))) {
        add('pytest');
    }
    if (commands.length === 0) {
        add('Run the nearest changed-package test suite');
    }
    return commands.slice(0, 5);
}

export function hunkReviewState(artifact: AgentArtifactState, hunkId: string): { label: string; thread?: AgentReviewThreadState } {
    const thread = artifact.reviewThreads.find(item => item.anchor.selector === hunkId || item.anchor.label.includes(hunkId));
    if (!thread) {
        return { label: 'pending' };
    }
    const body = thread.comments.map(comment => comment.body.toLowerCase()).join('\n');
    if (body.includes('[hunk-approved]')) return { label: 'approved', thread };
    if (body.includes('[hunk-rejected]')) return { label: 'rejected', thread };
    if (body.includes('[hunk-rewrite]')) return { label: 'rewrite requested', thread };
    if (body.includes('[hunk-comment]')) return { label: 'commented', thread };
    return { label: thread.status, thread };
}

export function diffReviewGate(artifact: AgentArtifactState, parsed: AiDiffSummary): AiDiffReviewGate {
    if (artifact.kind !== 'code_diff') {
        return { label: 'Review Gate: open', blocked: false, reason: 'Non-diff artifact.' };
    }
    const hunks = parsed.files.flatMap(file => file.hunks);
    if (hunks.length === 0) {
        return { label: 'Review Gate: open', blocked: false, reason: 'No hunks detected.' };
    }
    const states = hunks.map(hunk => hunkReviewState(artifact, hunk.id).label);
    const taggedHunkThreads = artifact.reviewThreads.filter(thread =>
        thread.anchor.kind === 'hunk'
        || thread.comments.some(comment => /\[hunk-(approved|rejected|rewrite|comment)\]/i.test(comment.body))
    );
    const taggedBodies = taggedHunkThreads.map(thread => thread.comments.map(comment => comment.body.toLowerCase()).join('\n'));
    const blocked = states.some(state => state === 'rejected' || state === 'rewrite requested')
        || taggedBodies.some(body => body.includes('[hunk-rejected]') || body.includes('[hunk-rewrite]'));
    if (blocked) {
        return { label: 'Review Gate: blocked', blocked: true, reason: 'Rejected or rewrite-requested hunks remain.' };
    }
    const approvedThreadCount = taggedBodies.filter(body => body.includes('[hunk-approved]')).length;
    const approved = Math.max(states.filter(state => state === 'approved').length, approvedThreadCount);
    if (approved === hunks.length) {
        return { label: 'Review Gate: ready', blocked: false, reason: 'All hunks approved.' };
    }
    if (approved > 0) {
        return { label: `Review Gate: ${approved}/${hunks.length} approved`, blocked: false, reason: 'Partial hunk approval.' };
    }
    return { label: 'Review Gate: pending', blocked: false, reason: 'No blocking hunk decisions.' };
}

export function createDiffReviewReport(
    artifact: AgentArtifactState | undefined,
    parsed: AiDiffSummary,
    snapshot: AiDiffSnapshot,
    riskProfile: AiDiffRiskProfile,
    impactMap: AiDiffImpactMap
): string {
    const hunkRows = parsed.files.flatMap(file => file.hunks.map(hunk => {
        const state = artifact ? hunkReviewState(artifact, hunk.id).label : 'transient';
        return `- ${hunk.filePath} ${hunk.header}: ${state} (+${hunk.additions}/-${hunk.deletions})`;
    }));
    return [
        `# Aixlarity Diff Review Report`,
        ``,
        `Artifact: ${artifact?.name || snapshot.name}`,
        `Status: ${artifact?.status || 'transient'}`,
        `Risk: ${riskProfile.level}`,
        `Summary: ${riskProfile.summary}`,
        `Before Snapshot: ${snapshot.beforeHash}`,
        `After Snapshot: ${snapshot.afterHash}`,
        `Review Gate: ${artifact ? diffReviewGate(artifact, parsed).label : 'transient'}`,
        ``,
        `## Files`,
        ...parsed.files.map(file => `- ${file.displayPath}: ${file.status} +${file.additions}/-${file.deletions}`),
        ``,
        `## Hunks`,
        ...(hunkRows.length > 0 ? hunkRows : ['- No hunks detected']),
        ``,
        `## Impact Map`,
        `Symbols: ${impactMap.symbols.join(', ')}`,
        `Risk Paths: ${impactMap.riskFiles.join(', ')}`,
        `Review Cues: ${impactMap.reviewCues.join(', ')}`,
        ``,
        `## Suggested Verification`,
        ...impactMap.testCommands.map(command => `- ${command}`),
    ].join('\n');
}

export function createSnapshotCompareDiff(
    fromSnapshot: AiDiffSnapshot,
    toSnapshot: AiDiffSnapshot,
    pathForPatch: (path: string) => string = defaultDiffPathForPatch
): string {
    const fromFiles = new Map(fromSnapshot.files.map(file => [file.path, file]));
    const toFiles = new Map(toSnapshot.files.map(file => [file.path, file]));
    const paths = Array.from(new Set([...fromFiles.keys(), ...toFiles.keys()])).sort();
    const diff: string[] = [];
    for (const path of paths) {
        const fromFile = fromFiles.get(path);
        const toFile = toFiles.get(path);
        const before = fromFile?.after || '';
        const after = toFile?.after || '';
        if (before === after) {
            continue;
        }
        const diffPath = pathForPatch(path);
        diff.push(`diff --git a/${diffPath} b/${diffPath}`);
        diff.push(fromFile ? `--- a/${diffPath}` : '--- /dev/null');
        diff.push(toFile ? `+++ b/${diffPath}` : '+++ /dev/null');
        appendSnapshotCompareHunk(diff, before, after);
    }
    return diff.join('\n');
}

export function appendSnapshotCompareHunk(diff: string[], before: string, after: string): void {
    const beforeLines = splitSnapshotLines(before);
    const afterLines = splitSnapshotLines(after);
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < beforeLines.length - prefix
        && suffix < afterLines.length - prefix
        && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
        suffix++;
    }
    const context = 3;
    const oldChangeEnd = beforeLines.length - suffix;
    const newChangeEnd = afterLines.length - suffix;
    const start = Math.max(0, prefix - context);
    const oldEnd = Math.min(beforeLines.length, oldChangeEnd + context);
    const newEnd = Math.min(afterLines.length, newChangeEnd + context);
    const oldCount = oldEnd - start;
    const newCount = newEnd - start;
    diff.push(`@@ -${oldCount === 0 ? 0 : start + 1},${oldCount} +${newCount === 0 ? 0 : start + 1},${newCount} @@`);
    for (let index = start; index < prefix; index++) {
        diff.push(` ${beforeLines[index]}`);
    }
    for (let index = prefix; index < oldChangeEnd; index++) {
        diff.push(`-${beforeLines[index]}`);
    }
    for (let index = prefix; index < newChangeEnd; index++) {
        diff.push(`+${afterLines[index]}`);
    }
    for (let index = oldChangeEnd; index < oldEnd; index++) {
        diff.push(` ${beforeLines[index]}`);
    }
}

export function splitSnapshotLines(text: string): string[] {
    if (!text) {
        return [];
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function defaultDiffPathForPatch(path: string): string {
    return (String(path || 'changes').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\s+/g, '_') || 'changes');
}
