import { LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from '../../../../workbench/common/contributions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, IViewDescriptor } from '../../../../workbench/common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { AixlarityAgentViewPane } from './aixlarityView.js';

export const VIEWLET_ID = 'workbench.view.aixlarity.v2';
export const VIEW_ID = 'workbench.view.aixlarity.agent.v2';

const aixlarityViewIcon = registerIcon('aixlarity-view-icon', Codicon.robot, localize('aixlarityViewIcon', 'Icon for the Aixlarity Agent sidebar.'));

export class AixlarityIdeContextTracker extends Disposable {
	private lastContextKey = '';
	private readonly contextUpdateScheduler = this._register(new RunOnceScheduler(() => this.updateBackendContext(), 150));

	constructor(
		@IEditorService private readonly editorService: IEditorService
	) {
		super();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.editorService.onDidActiveEditorChange(() => this.contextUpdateScheduler.schedule()));
	}

	private updateBackendContext(): void {
		const activeEditorInput = this.editorService.activeEditor;
		const activeEditor = this.editorService.activeTextEditorControl;
		if (!activeEditor || !activeEditorInput) {
			return;
		}

		// Use the editor input's resource which is always typed correctly,
		// avoiding the IDiffEditorModel union which lacks .uri.
		const resource = activeEditorInput.resource;
		const position = activeEditor.getPosition();

		if (resource && position) {
			const contextKey = `${resource.toString()}:${position.lineNumber}`;
			if (contextKey === this.lastContextKey) {
				return;
			}
			this.lastContextKey = contextKey;
			// Intentionally quiet in production. When daemon context sync is wired,
			// send only after this debounce/dedupe boundary.
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(AixlarityIdeContextTracker, LifecyclePhase.Restored);

// Register Aixlarity View Container (Sidebar Icon)
const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEWLET_ID,
	title: localize2('aixlarityAgent', 'Aixlarity Agent'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	hideIfEmpty: false,
	icon: aixlarityViewIcon,
	order: 1,
}, ViewContainerLocation.AuxiliaryBar);

// Register the actual View Pane (Inside the Sidebar Container)
const viewDescriptor: IViewDescriptor = {
	id: VIEW_ID,
	name: localize2('aixlarityChat', 'Aixlarity Agent Chat'),
	containerIcon: aixlarityViewIcon,
	ctorDescriptor: new SyncDescriptor(AixlarityAgentViewPane),
	canToggleVisibility: false,
	canMoveView: true,
    collapsed: false
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);

import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISCMService } from '../../scm/common/scm.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';

async function openAixlarityAgentView(accessor: ServicesAccessor): Promise<AixlarityAgentViewPane | undefined> {
    const viewsService = accessor.get(IViewsService);
    return (await viewsService.openView<AixlarityAgentViewPane>(VIEW_ID, true)) || undefined;
}

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.generateCommitMessage',
            title: localize2('aixlarityGenerateCommitMessage', 'Generate with Aixlarity'),
            icon: aixlarityViewIcon,
            menu: {
                id: MenuId.SCMInputBox,
                group: 'navigation',
                order: 1
            }
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const scmService = accessor.get(ISCMService);
        const view = await openAixlarityAgentView(accessor);
        if (view) {
            view.generateCommitMessage(scmService);
        }
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.explainSelection',
            title: localize2('aixlarityExplainSelection', 'Aixlarity: Explain Selection'),
            category: localize2('aixlarityCategory', 'Aixlarity'),
            f1: true,
            icon: aixlarityViewIcon,
            menu: [
                { id: MenuId.EditorContext, group: 'aixlarity', order: 1 },
                { id: MenuId.MarkerHoverStatusBar, group: 'aixlarity', order: 1 }
            ]
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const view = await openAixlarityAgentView(accessor);
        view?.explainSelection();
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.fixSelection',
            title: localize2('aixlarityFixSelection', 'Aixlarity: Fix Selection'),
            category: localize2('aixlarityCategory', 'Aixlarity'),
            f1: true,
            icon: aixlarityViewIcon,
            menu: [
                { id: MenuId.EditorContext, group: 'aixlarity', order: 2 },
                { id: MenuId.MarkerHoverStatusBar, group: 'aixlarity', order: 2 }
            ]
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const view = await openAixlarityAgentView(accessor);
        view?.fixSelection();
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.draftInlineEdit',
            title: localize2('aixlarityDraftInlineEdit', 'Aixlarity: Draft Inline Edit'),
            category: localize2('aixlarityCategory', 'Aixlarity'),
            f1: true,
            icon: aixlarityViewIcon,
            menu: [
                { id: MenuId.EditorContext, group: 'aixlarity', order: 3 }
            ]
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const view = await openAixlarityAgentView(accessor);
        view?.draftInlineEdit();
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.reviewCurrentFile',
            title: localize2('aixlarityReviewCurrentFile', 'Aixlarity: Review Current File'),
            category: localize2('aixlarityCategory', 'Aixlarity'),
            f1: true,
            icon: aixlarityViewIcon,
            menu: [
                { id: MenuId.EditorTitle, group: 'navigation', order: 20 },
                { id: MenuId.EditorContext, group: 'aixlarity', order: 4 }
            ]
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const view = await openAixlarityAgentView(accessor);
        view?.reviewCurrentFile();
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'aixlarity.sendProblemsToAgent',
            title: localize2('aixlaritySendProblems', 'Aixlarity: Send Problems to Agent'),
            category: localize2('aixlarityCategory', 'Aixlarity'),
            f1: true,
            icon: aixlarityViewIcon,
            menu: {
                id: MenuId.ProblemsPanelContext,
                group: 'navigation',
                order: 0
            }
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const markerService = accessor.get(IMarkerService);
        const view = await openAixlarityAgentView(accessor);
        view?.sendProblemsToAgent(markerService);
    }
});
