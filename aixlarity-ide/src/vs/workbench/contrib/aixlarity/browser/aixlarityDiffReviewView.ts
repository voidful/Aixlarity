import { append, $ } from '../../../../base/browser/dom.js';
import type { AgentArtifactState, AgentReviewThreadState } from './aixlarityArtifactModel.js';
import type {
	AiDiffFile,
	AiDiffHunk,
	AiDiffHunkReviewAction,
	AiDiffImpactMap,
	AiDiffPairRow,
	AiDiffRiskProfile,
	AiDiffSnapshot,
	AiDiffSnapshotFile,
	AiDiffSummary,
} from './aixlarityDiffModel.js';
import { renderDiffImpactMap as renderDiffImpactMapComponent } from './aixlarityUiComponents.js';

export interface DiffReviewGateState {
	label: string;
	blocked: boolean;
	reason: string;
}

export interface DiffReviewViewOptions {
	container: HTMLElement;
	diffText: string;
	artifact?: AgentArtifactState;
	parsed: AiDiffSummary;
	snapshot: AiDiffSnapshot;
	riskProfile: AiDiffRiskProfile;
	impactMap: AiDiffImpactMap;
	readReviewGate: () => DiffReviewGateState;
	buildSnapshotFile: (file: AiDiffFile) => AiDiffSnapshotFile;
	appendHighlightedText: (container: HTMLElement, text: string, compareText?: string, side?: 'old' | 'new') => void;
	hunkReviewState: (artifact: AgentArtifactState, hunkId: string) => { label: string; thread?: AgentReviewThreadState };
	recordHunkReview: (artifact: AgentArtifactState, hunk: AiDiffHunk, action: AiDiffHunkReviewAction, note: string, after?: () => void) => Promise<void>;
	copyHunkEvidence: (artifact: AgentArtifactState, hunk: AiDiffHunk) => Promise<void>;
	openDiffHunkSource: (hunk: AiDiffHunk) => void;
	openNativeDiffForFile: (artifact: AgentArtifactState | undefined, file: AiDiffFile) => void;
	createReviewReport: () => string;
	copyText: (text: string) => Promise<void>;
	recordReviewExport: (gateLabel: string, riskLevel: string) => void;
}

export class DiffReviewView {
	public static render(options: DiffReviewViewOptions): void {
		renderDiffReviewView(options);
	}
}

export function renderDiffReviewView(options: DiffReviewViewOptions): void {
	const {
		container,
		diffText,
		artifact,
		parsed,
		snapshot,
		riskProfile,
		impactMap,
		readReviewGate,
		buildSnapshotFile,
		appendHighlightedText,
		hunkReviewState,
		recordHunkReview,
		copyHunkEvidence,
		openDiffHunkSource,
		openNativeDiffForFile,
		createReviewReport,
		copyText,
		recordReviewExport,
	} = options;
	let selectedFileIndex = 0;
	let mode: 'split' | 'unified' | 'stats' = 'split';
	let ignoreWhitespace = false;
	let activeChangeIndex = -1;

	const viewer = append(container, $('div.aixlarity-diff-viewer'));
	const header = append(viewer, $('div.aixlarity-diff-header'));
	const titleBlock = append(header, $('div', { style: 'min-width: 0;' }));
	append(titleBlock, $('div.aixlarity-diff-title')).textContent = 'Diff Preview / Visual Diff Review';
	append(titleBlock, $('div.aixlarity-diff-subtitle')).textContent =
		`${parsed.files.length} files - +${parsed.additions} -${parsed.deletions} - ${parsed.changeBlocks} change blocks`;

	const controls = append(header, $('div.aixlarity-diff-controls'));
	const splitBtn = append(controls, $('button.aixlarity-action-button'));
	append(splitBtn, $('span.codicon.codicon-split-horizontal'));
	append(splitBtn, $('span')).textContent = 'Side-by-side';
	const unifiedBtn = append(controls, $('button.aixlarity-action-button'));
	append(unifiedBtn, $('span.codicon.codicon-list-tree'));
	append(unifiedBtn, $('span')).textContent = 'Unified';
	const statsBtn = append(controls, $('button.aixlarity-action-button'));
	append(statsBtn, $('span.codicon.codicon-graph'));
	append(statsBtn, $('span')).textContent = 'Stats';
	const whitespaceBtn = append(controls, $('button.aixlarity-action-button'));
	append(whitespaceBtn, $('span.codicon.codicon-whitespace'));
	append(whitespaceBtn, $('span')).textContent = 'Ignore Whitespace';
	const prevBtn = append(controls, $('button.aixlarity-action-button'));
	append(prevBtn, $('span.codicon.codicon-arrow-up'));
	append(prevBtn, $('span')).textContent = 'Prev';
	const nextBtn = append(controls, $('button.aixlarity-action-button'));
	append(nextBtn, $('span.codicon.codicon-arrow-down'));
	append(nextBtn, $('span')).textContent = 'Next';
	const nativeDiffBtn = append(controls, $('button.aixlarity-action-button'));
	append(nativeDiffBtn, $('span.codicon.codicon-compare-changes'));
	append(nativeDiffBtn, $('span')).textContent = 'Open Native Diff';
	const exportReviewBtn = append(controls, $('button.aixlarity-action-button'));
	append(exportReviewBtn, $('span.codicon.codicon-output'));
	append(exportReviewBtn, $('span')).textContent = 'Export Review';
	const copyBtn = append(controls, $('button.aixlarity-action-button'));
	append(copyBtn, $('span.codicon.codicon-copy'));
	append(copyBtn, $('span')).textContent = 'Copy Diff';

	const brief = append(viewer, $('div.aixlarity-diff-brief'));
	const briefTop = append(brief, $('div', { style: 'min-width: 0;' }));
	append(briefTop, $('div.aixlarity-diff-brief-title')).textContent = 'Review Brief';
	append(briefTop, $('div.aixlarity-diff-brief-summary')).textContent = riskProfile.summary;
	const riskStrip = append(brief, $('div.aixlarity-diff-risk-strip'));
	append(riskStrip, $(`span.aixlarity-diff-risk-pill.${riskProfile.level}`)).textContent = `Risk: ${riskProfile.level}`;
	append(riskStrip, $('span.aixlarity-diff-risk-pill')).textContent = `Before Snapshot ${snapshot.beforeHash}`;
	append(riskStrip, $('span.aixlarity-diff-risk-pill')).textContent = `After Snapshot ${snapshot.afterHash}`;
	const reviewGatePill = append(riskStrip, $('span.aixlarity-diff-risk-pill'));
	const updateReviewGatePill = () => {
		const gate = readReviewGate();
		reviewGatePill.textContent = gate.label || 'Review Gate';
		reviewGatePill.title = gate.reason || 'Diff review gate';
		reviewGatePill.classList.toggle('blocked', gate.blocked);
	};
	updateReviewGatePill();
	for (const label of riskProfile.labels.slice(0, 8)) {
		append(riskStrip, $('span.aixlarity-diff-risk-pill')).textContent = label;
	}
	renderDiffImpactMapComponent(brief, impactMap);

	const body = append(viewer, $('div.aixlarity-diff-body'));
	const fileList = append(body, $('div.aixlarity-diff-files'));
	const main = append(body, $('div.aixlarity-diff-main'));

	const setButtonState = () => {
		for (const [button, active] of [
			[splitBtn, mode === 'split'],
			[unifiedBtn, mode === 'unified'],
			[statsBtn, mode === 'stats'],
			[whitespaceBtn, ignoreWhitespace],
		] as Array<[HTMLElement, boolean]>) {
			button.style.background = active ? 'var(--vscode-button-background)' : '';
			button.style.color = active ? 'var(--vscode-button-foreground)' : '';
		}
	};

	const visibleRows = (file: AiDiffFile) => ignoreWhitespace
		? file.rows.filter(row => !(row.kind === 'change' && String(row.oldText || '').trim() === String(row.newText || '').trim()))
		: file.rows;

	const renderFileTabs = () => {
		fileList.textContent = '';
		parsed.files.forEach((file, index) => {
			const tab = append(fileList, $('button.aixlarity-diff-file-tab'));
			tab.classList.toggle('active', index === selectedFileIndex);
			append(tab, $('span.aixlarity-diff-file-path', { title: file.displayPath })).textContent = file.displayPath;
			const stats = append(tab, $('span.aixlarity-diff-file-stats'));
			append(stats, $('span')).textContent = file.status;
			append(stats, $('span')).textContent = `+${file.additions}`;
			append(stats, $('span')).textContent = `-${file.deletions}`;
			tab.addEventListener('click', () => {
				selectedFileIndex = index;
				activeChangeIndex = -1;
				render();
			});
		});
	};

	const appendGutter = (row: HTMLElement, value?: number) => {
		append(row, $('span.aixlarity-diff-gutter')).textContent = value ? String(value) : '';
	};
	const appendCode = (row: HTMLElement, text: string, compareText?: string, side?: 'old' | 'new', extraStyle = '') => {
		const code = append(row, $('span.aixlarity-diff-code', { style: extraStyle }));
		appendHighlightedText(code, text || ' ', compareText, side);
	};
	const markChange = (row: HTMLElement, kind: AiDiffPairRow['kind']) => {
		row.classList.add(kind);
		if (kind === 'add' || kind === 'delete' || kind === 'change') {
			row.setAttribute('data-aixlarity-change-row', 'true');
		}
	};

	const renderSplitRows = (file: AiDiffFile) => {
		const table = append(main, $('div.aixlarity-diff-table'));
		for (const rowData of visibleRows(file)) {
			const row = append(table, $('div.aixlarity-diff-row.split'));
			markChange(row, rowData.kind);
			if (rowData.kind === 'hunk' || rowData.kind === 'meta') {
				appendGutter(row);
				appendCode(row, rowData.text || '', undefined, undefined, 'grid-column: 2 / 5;');
				continue;
			}
			appendGutter(row, rowData.oldNumber);
			appendCode(row, rowData.oldText || '', rowData.newText, 'old');
			appendGutter(row, rowData.newNumber);
			appendCode(row, rowData.newText || '', rowData.oldText, 'new');
		}
	};

	const appendUnifiedRow = (table: HTMLElement, kind: AiDiffPairRow['kind'], oldNumber: number | undefined, newNumber: number | undefined, prefix: string, text: string, compareText?: string, side?: 'old' | 'new') => {
		const row = append(table, $('div.aixlarity-diff-row.unified'));
		markChange(row, kind);
		appendGutter(row, oldNumber);
		appendGutter(row, newNumber);
		appendCode(row, `${prefix}${text || ''}`, compareText ? `${prefix}${compareText}` : undefined, side);
	};

	const renderUnifiedRows = (file: AiDiffFile) => {
		const table = append(main, $('div.aixlarity-diff-table'));
		for (const rowData of visibleRows(file)) {
			if (rowData.kind === 'hunk' || rowData.kind === 'meta') {
				appendUnifiedRow(table, rowData.kind, undefined, undefined, '', rowData.text || '');
			} else if (rowData.kind === 'change') {
				appendUnifiedRow(table, 'delete', rowData.oldNumber, undefined, '-', rowData.oldText || '', rowData.newText, 'old');
				appendUnifiedRow(table, 'add', undefined, rowData.newNumber, '+', rowData.newText || '', rowData.oldText, 'new');
			} else if (rowData.kind === 'delete') {
				appendUnifiedRow(table, 'delete', rowData.oldNumber, undefined, '-', rowData.oldText || '');
			} else if (rowData.kind === 'add') {
				appendUnifiedRow(table, 'add', undefined, rowData.newNumber, '+', rowData.newText || '');
			} else {
				appendUnifiedRow(table, 'context', rowData.oldNumber, rowData.newNumber, ' ', rowData.oldText || rowData.newText || '');
			}
		}
	};

	const renderStats = () => {
		const stats = append(main, $('div.aixlarity-diff-stats'));
		const summary = append(stats, $('div.aixlarity-metric-strip'));
		for (const [label, value] of [['Files', parsed.files.length], ['Added', parsed.additions], ['Deleted', parsed.deletions], ['Blocks', parsed.changeBlocks]] as Array<[string, number]>) {
			const item = append(summary, $('div.aixlarity-metric-item'));
			append(item, $('div.aixlarity-metric-value')).textContent = String(value);
			append(item, $('div.aixlarity-metric-label')).textContent = label;
		}
		for (const file of parsed.files) {
			const total = Math.max(1, file.additions + file.deletions);
			const row = append(stats, $('div.aixlarity-diff-stat-row'));
			const left = append(row, $('div', { style: 'min-width: 0;' }));
			append(left, $('div', { style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650;' })).textContent = file.displayPath;
			const bar = append(left, $('div.aixlarity-diff-stat-bar'));
			append(bar, $('span.aixlarity-diff-stat-add', { style: `width: ${(file.additions / total) * 100}%;` }));
			append(bar, $('span.aixlarity-diff-stat-del', { style: `width: ${(file.deletions / total) * 100}%;` }));
			append(row, $('span.aixlarity-task-badge')).textContent = `+${file.additions} -${file.deletions}`;
		}
	};

	const renderHunkReview = (file: AiDiffFile) => {
		if (!artifact || file.hunks.length === 0) {
			return;
		}
		const panel = append(main, $('div.aixlarity-diff-hunk-review'));
		const top = append(panel, $('div.aixlarity-diff-hunk-review-top'));
		const hunkStates = file.hunks.map(hunk => hunkReviewState(artifact, hunk.id));
		const blocked = hunkStates.some(state => state.label === 'rejected' || state.label === 'rewrite requested');
		const approvedCount = hunkStates.filter(state => state.label === 'approved').length;
		append(top, $('div.aixlarity-diff-hunk-title')).textContent = 'Hunk Review';
		const topMeta = append(top, $('span.aixlarity-diff-snapshot-strip'));
		append(topMeta, $('span.aixlarity-task-badge')).textContent = `${file.hunks.length} hunks`;
		append(topMeta, $('span.aixlarity-task-badge')).textContent = blocked
			? 'Review Gate: blocked'
			: approvedCount === file.hunks.length
				? 'Review Gate: ready'
				: approvedCount > 0
					? `Review Gate: ${approvedCount}/${file.hunks.length} approved`
					: 'Review Gate: pending';
		for (const [index, hunk] of file.hunks.entries()) {
			const state = hunkStates[index] || hunkReviewState(artifact, hunk.id);
			const row = append(panel, $('div.aixlarity-diff-hunk-row'));
			const meta = append(row, $('div.aixlarity-diff-hunk-meta'));
			append(meta, $('code', { title: hunk.header })).textContent = hunk.header;
			append(meta, $('span.aixlarity-task-badge')).textContent = `+${hunk.additions} -${hunk.deletions}`;
			append(meta, $('span.aixlarity-task-badge')).textContent = state.label;
			const actions = append(row, $('div.aixlarity-diff-hunk-actions'));
			const noteInput = append(actions, $<HTMLInputElement>('input', { placeholder: 'Note' }));
			const addAction = (label: string, icon: string, action: AiDiffHunkReviewAction) => {
				const button = append(actions, $('button.aixlarity-action-button'));
				append(button, $(`span.codicon.${icon}`));
				append(button, $('span')).textContent = label;
				button.addEventListener('click', () => {
					const note = noteInput.value.trim();
					void recordHunkReview(artifact, hunk, action, note, () => {
						render();
						updateReviewGatePill();
					});
				});
			};
			addAction('Approve', 'codicon-check', 'approve');
			addAction('Reject', 'codicon-close', 'reject');
			addAction('Comment', 'codicon-comment', 'comment');
			addAction('Rewrite', 'codicon-edit', 'rewrite');
			const copyHunkBtn = append(actions, $('button.aixlarity-action-button'));
			append(copyHunkBtn, $('span.codicon.codicon-copy'));
			append(copyHunkBtn, $('span')).textContent = 'Copy Hunk';
			copyHunkBtn.addEventListener('click', async () => copyHunkEvidence(artifact, hunk));
			const openFileBtn = append(actions, $('button.aixlarity-action-button'));
			append(openFileBtn, $('span.codicon.codicon-go-to-file'));
			append(openFileBtn, $('span')).textContent = 'Open File';
			openFileBtn.addEventListener('click', () => openDiffHunkSource(hunk));
		}
	};

	const render = () => {
		selectedFileIndex = Math.max(0, Math.min(selectedFileIndex, parsed.files.length - 1));
		setButtonState();
		updateReviewGatePill();
		renderFileTabs();
		main.textContent = '';
		const file = parsed.files[selectedFileIndex];
		if (!file) {
			append(main, $('div.aixlarity-empty-state')).textContent = 'No diff content available.';
			return;
		}
		const fileHeader = append(main, $('div.aixlarity-diff-file-header'));
		append(fileHeader, $('span', { style: 'font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', title: file.displayPath })).textContent = file.displayPath;
		const selectedSnapshot = snapshot.files[selectedFileIndex] || buildSnapshotFile(file);
		const snapshotStrip = append(fileHeader, $('span.aixlarity-diff-snapshot-strip'));
		append(snapshotStrip, $('span.aixlarity-task-badge')).textContent = `${file.status} +${file.additions} -${file.deletions}`;
		append(snapshotStrip, $('span.aixlarity-task-badge')).textContent = `Before ${selectedSnapshot.beforeHash}`;
		append(snapshotStrip, $('span.aixlarity-task-badge')).textContent = `After ${selectedSnapshot.afterHash}`;
		renderHunkReview(file);
		if (mode === 'stats') {
			renderStats();
		} else if (mode === 'unified') {
			renderUnifiedRows(file);
		} else {
			renderSplitRows(file);
		}
	};

	const jumpChange = (delta: number) => {
		const rows = Array.from(main.querySelectorAll<HTMLElement>('[data-aixlarity-change-row="true"]'));
		if (rows.length === 0) {
			return;
		}
		activeChangeIndex = (activeChangeIndex + delta + rows.length) % rows.length;
		rows[activeChangeIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
	};

	splitBtn.addEventListener('click', () => { mode = 'split'; render(); });
	unifiedBtn.addEventListener('click', () => { mode = 'unified'; render(); });
	statsBtn.addEventListener('click', () => { mode = 'stats'; render(); });
	whitespaceBtn.addEventListener('click', () => { ignoreWhitespace = !ignoreWhitespace; activeChangeIndex = -1; render(); });
	prevBtn.addEventListener('click', () => jumpChange(-1));
	nextBtn.addEventListener('click', () => jumpChange(1));
	nativeDiffBtn.addEventListener('click', () => {
		const file = parsed.files[selectedFileIndex];
		if (file) {
			openNativeDiffForFile(artifact, file);
		}
	});
	exportReviewBtn.addEventListener('click', async () => {
		const report = createReviewReport();
		const exportGate = readReviewGate();
		await copyText(report);
		recordReviewExport(exportGate.label, riskProfile.level);
	});
	copyBtn.addEventListener('click', async () => {
		await copyText(diffText);
	});

	render();
}
