import { append, $ } from '../../../../base/browser/dom.js';
import type { AgentArtifactKind, AgentArtifactState, AgentArtifactStatus, AgentTaskStatus } from './aixlarityArtifactModel.js';
import type { AiDiffImpactMap } from './aixlarityDiffModel.js';

export function providerActiveLabel(provider: any, activeWorkspaceProviderId: string, activeGlobalProviderId: string, currentProviderId: string): string {
    const id = String(provider?.id || '');
    if (!id) {
        return 'not active';
    }
    if (id === activeWorkspaceProviderId) {
        return 'workspace active';
    }
    if (id === activeGlobalProviderId) {
        return 'user active';
    }
    if (id === currentProviderId) {
        return 'current';
    }
    return 'ready';
}

export function taskStatusMeta(status: AgentTaskStatus): { label: string; background: string; foreground: string } {
    switch (status) {
        case 'queued': return { label: 'Queued', background: 'rgba(148,163,184,0.18)', foreground: 'var(--vscode-descriptionForeground)' };
        case 'running': return { label: 'Running', background: 'rgba(77,170,252,0.18)', foreground: 'var(--vscode-textLink-foreground, #4daafc)' };
        case 'waiting_review': return { label: 'Review', background: 'rgba(251,191,36,0.18)', foreground: 'var(--vscode-editorWarning-foreground, #fbbf24)' };
        case 'paused': return { label: 'Paused', background: 'rgba(251,191,36,0.18)', foreground: 'var(--vscode-editorWarning-foreground, #fbbf24)' };
        case 'completed': return { label: 'Done', background: 'rgba(74,222,128,0.18)', foreground: 'var(--vscode-testing-iconPassed, #4ade80)' };
        case 'failed': return { label: 'Failed', background: 'rgba(248,113,113,0.18)', foreground: 'var(--vscode-errorForeground, #f87171)' };
        case 'stopped': return { label: 'Stopped', background: 'rgba(148,163,184,0.16)', foreground: 'var(--vscode-descriptionForeground)' };
    }
}

export function artifactStatusStyle(status: AgentArtifactStatus): string {
    switch (status) {
        case 'approved': return 'background: rgba(74,222,128,0.18); color: var(--vscode-testing-iconPassed, #4ade80);';
        case 'rejected': return 'background: rgba(248,113,113,0.18); color: var(--vscode-errorForeground, #f87171);';
        case 'needs_review': return 'background: rgba(251,191,36,0.18); color: var(--vscode-editorWarning-foreground, #fbbf24);';
        case 'draft':
        default: return 'background: rgba(148,163,184,0.16); color: var(--vscode-descriptionForeground);';
    }
}

export function artifactIconClass(kind: AgentArtifactKind): string {
    switch (kind) {
        case 'implementation_plan':
        case 'task_list': return 'codicon-checklist';
        case 'walkthrough': return 'codicon-book';
        case 'code_diff': return 'codicon-diff';
        case 'screenshot':
        case 'browser_recording': return 'codicon-browser';
        case 'terminal_transcript': return 'codicon-terminal';
        case 'test_report': return 'codicon-beaker';
        case 'file_change': return 'codicon-file-code';
        case 'checkpoint': return 'codicon-save';
        default: return 'codicon-file';
    }
}

export function artifactKindLabel(kind: AgentArtifactKind): string {
    return kind.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function renderArtifactChip(container: HTMLElement, artifact: AgentArtifactState, onOpen: (artifactId: string) => void): HTMLElement {
    const chip = append(container, $('span.aixlarity-artifact-chip', {
        title: `${artifactKindLabel(artifact.kind)} - ${artifact.status}`
    }));
    append(chip, $(`span.codicon.${artifactIconClass(artifact.kind)}`, { style: 'font-size: 11px;' }));
    const name = append(chip, $('span.artifact-name'));
    name.textContent = artifact.name;
    const badge = append(chip, $('span', {
        style: `font-size: 9px; padding: 1px 4px; border-radius: 2px; ${artifactStatusStyle(artifact.status)}`
    }));
    badge.textContent = artifact.status.replace('_', ' ');
    chip.addEventListener('click', () => onOpen(artifact.id));
    return chip;
}

export function renderDiffImpactMap(container: HTMLElement, impactMap: AiDiffImpactMap): HTMLElement {
    const map = append(container, $('div.aixlarity-diff-impact-map'));
    const groups: Array<[string, string[]]> = [
        ['Impact Map', impactMap.symbols],
        ['Test Hints', impactMap.testCommands],
        ['Risk Paths', impactMap.riskFiles],
        ['Review Cues', impactMap.reviewCues],
    ];
    for (const [title, items] of groups) {
        const group = append(map, $('div.aixlarity-diff-impact-group'));
        append(group, $('div.aixlarity-diff-impact-title')).textContent = title;
        for (const item of items.slice(0, 4)) {
            append(group, $('span.aixlarity-diff-impact-item', { title: item })).textContent = item;
        }
    }
    return map;
}
