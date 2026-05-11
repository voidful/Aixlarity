import type { PersistedAgentWorkspaceState } from './aixlarityArtifactModel.js';

export function createAgentWorkspaceStateKey(version: number, workspaceId: string): string {
    return `aixlarity.agentWorkspaceState.v${version}:${workspaceId || 'empty-window'}`;
}

export function isPersistedAgentWorkspaceState(state: any, version: number): state is PersistedAgentWorkspaceState {
    return !!state
        && Number(state.version || 0) === version
        && Array.isArray(state.tasks)
        && Array.isArray(state.artifacts);
}

export function persistedAgentWorkspaceStateItemCount(state: PersistedAgentWorkspaceState | undefined): number {
    if (!state) return 0;
    return (Array.isArray(state.tasks) ? state.tasks.length : 0)
        + (Array.isArray(state.artifacts) ? state.artifacts.length : 0);
}

export function shouldPreferLocalMissionState(
    localState: PersistedAgentWorkspaceState | undefined,
    daemonState: PersistedAgentWorkspaceState | undefined
): boolean {
    const localCount = persistedAgentWorkspaceStateItemCount(localState);
    const daemonCount = persistedAgentWorkspaceStateItemCount(daemonState);
    const localSavedAt = Number((localState as any)?.savedAt || (localState as any)?.saved_at_ms || 0);
    const daemonSavedAt = Number((daemonState as any)?.savedAt || (daemonState as any)?.saved_at_ms || 0);
    return !!localState && localCount > 0 && (daemonCount === 0 || localSavedAt > daemonSavedAt);
}
