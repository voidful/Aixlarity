import type { AgentArtifactKind, AgentArtifactState, AgentTaskState } from './aixlarityArtifactModel.js';

export type TaskVerificationStatus = 'empty' | 'partial' | 'blocked' | 'ready';
export type TaskVerificationStepId = 'plan' | 'diff' | 'tests' | 'runtime' | 'review';

export interface TaskVerificationStep {
	id: TaskVerificationStepId;
	label: string;
	satisfied: boolean;
	blocked: boolean;
	detail: string;
}

export interface TaskVerificationPassport {
	taskId: string;
	status: TaskVerificationStatus;
	score: number;
	summary: string;
	steps: TaskVerificationStep[];
	missing: string[];
	blockers: string[];
	artifactCount: number;
	updatedAt: number;
}

const STEP_LABELS: Record<TaskVerificationStepId, string> = {
	plan: 'Plan',
	diff: 'Diff',
	tests: 'Tests',
	runtime: 'Runtime',
	review: 'Review',
};

export function createTaskVerificationPassport(task: AgentTaskState, artifacts: AgentArtifactState[]): TaskVerificationPassport {
	const taskArtifactIds = new Set(task.artifactIds);
	const taskArtifacts = artifacts.filter(artifact => artifact.taskId === task.id || taskArtifactIds.has(artifact.id));
	const rejected = taskArtifacts.filter(artifact => artifact.status === 'rejected');
	const openThreads = taskArtifacts.reduce((count, artifact) => count + artifact.reviewThreads.filter(thread => thread.status !== 'resolved').length, 0);
	const needsReview = taskArtifacts.filter(artifact => artifact.status === 'needs_review').length;
	const kinds = new Set(taskArtifacts.map(artifact => artifact.kind));
	const hasKind = (...targets: AgentArtifactKind[]) => targets.some(kind => kinds.has(kind));
	const hasTestEvidence = taskArtifacts.some(artifact =>
		artifact.kind === 'test_report'
		|| evidenceText(artifact).some(text => /\b(test|pytest|vitest|jest|cargo test|npm test|pnpm test|passed|green)\b/i.test(text))
	);
	const hasRuntimeEvidence = hasKind('browser_recording', 'screenshot', 'terminal_transcript');
	const blockers: string[] = [];
	if (task.status === 'failed') {
		blockers.push('task failed');
	}
	if (rejected.length > 0) {
		blockers.push(`${rejected.length} rejected artifact${rejected.length === 1 ? '' : 's'}`);
	}
	if (openThreads > 0) {
		blockers.push(`${openThreads} open review thread${openThreads === 1 ? '' : 's'}`);
	}

	const steps: TaskVerificationStep[] = [
		step('plan', hasKind('implementation_plan', 'task_list'), false, hasKind('implementation_plan', 'task_list') ? 'Plan evidence captured.' : 'Missing implementation plan or task list.'),
		step('diff', hasKind('code_diff', 'file_change'), false, hasKind('code_diff', 'file_change') ? 'Code change evidence captured.' : 'Missing diff or file-change artifact.'),
		step('tests', hasTestEvidence, false, hasTestEvidence ? 'Test evidence captured.' : 'Missing test report or test command evidence.'),
		step('runtime', hasRuntimeEvidence, false, hasRuntimeEvidence ? 'Runtime evidence captured.' : 'Missing browser, screenshot, terminal, or replay evidence.'),
		step('review', taskArtifacts.length > 0 && rejected.length === 0 && openThreads === 0 && needsReview === 0, blockers.length > 0, reviewDetail(taskArtifacts.length, needsReview, rejected.length, openThreads)),
	];
	const satisfiedCount = steps.filter(item => item.satisfied).length;
	const missing = steps.filter(item => !item.satisfied).map(item => item.label.toLowerCase());
	const score = Math.round((satisfiedCount / steps.length) * 100);
	const status: TaskVerificationStatus = taskArtifacts.length === 0
		? 'empty'
		: blockers.length > 0
			? 'blocked'
			: score === 100
				? 'ready'
				: 'partial';
	return {
		taskId: task.id,
		status,
		score,
		summary: verificationSummary(status, missing, blockers),
		steps,
		missing,
		blockers,
		artifactCount: taskArtifacts.length,
		updatedAt: Math.max(task.updatedAt, ...taskArtifacts.map(artifact => artifact.updatedAt), 0),
	};
}

export function createTaskVerificationMarkdown(passport: TaskVerificationPassport, task: AgentTaskState, artifacts: AgentArtifactState[]): string {
	const lines = [
		'# Aixlarity Task Verification Passport',
		'',
		`Task: ${task.title}`,
		`Status: ${passport.status}`,
		`Score: ${passport.score}%`,
		`Summary: ${passport.summary}`,
		'',
		'## Checks',
		...passport.steps.map(step => `- ${step.satisfied ? '[x]' : '[ ]'} ${step.label}: ${step.detail}`),
		'',
		'## Artifacts',
		...artifacts.map(artifact => `- ${artifact.name} (${artifact.kind}, ${artifact.status})`),
	];
	if (passport.blockers.length > 0) {
		lines.splice(8, 0, '', '## Blockers', ...passport.blockers.map(blocker => `- ${blocker}`));
	}
	return lines.join('\n');
}

function step(id: TaskVerificationStepId, satisfied: boolean, blocked: boolean, detail: string): TaskVerificationStep {
	return {
		id,
		label: STEP_LABELS[id],
		satisfied,
		blocked,
		detail,
	};
}

function evidenceText(artifact: AgentArtifactState): string[] {
	return [
		artifact.name,
		artifact.summary,
		artifact.body || '',
		...artifact.evidence.flatMap(item => [item.label, item.value]),
	];
}

function reviewDetail(artifactCount: number, needsReview: number, rejected: number, openThreads: number): string {
	if (artifactCount === 0) {
		return 'No artifacts to review yet.';
	}
	if (rejected > 0) {
		return `${rejected} artifact${rejected === 1 ? '' : 's'} rejected.`;
	}
	if (openThreads > 0) {
		return `${openThreads} open review thread${openThreads === 1 ? '' : 's'} remaining.`;
	}
	if (needsReview > 0) {
		return `${needsReview} artifact${needsReview === 1 ? '' : 's'} waiting for review.`;
	}
	return 'All reviewable artifacts are approved or informational.';
}

function verificationSummary(status: TaskVerificationStatus, missing: string[], blockers: string[]): string {
	if (status === 'ready') {
		return 'Ready to submit.';
	}
	if (status === 'blocked') {
		return `Blocked: ${blockers.join(', ')}.${missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : ''}`;
	}
	if (status === 'empty') {
		return 'No verification evidence yet.';
	}
	return `Missing: ${missing.join(', ')}.`;
}
