import { append, $ } from '../../../../base/browser/dom.js';
import type { KnowledgeActivationMode, KnowledgeLedger, KnowledgePolicy } from './aixlarityKnowledgeModel.js';

export interface KnowledgeLedgerViewOptions {
	ledger: KnowledgeLedger;
	onPolicyChange: (policy: KnowledgePolicy) => void;
	onExport: () => void;
}

export function renderKnowledgeLedgerCard(container: HTMLElement, options: KnowledgeLedgerViewOptions): HTMLElement {
	const { ledger } = options;
	const policy = { ...ledger.policy };
	const card = append(container, $('div.aixlarity-settings-card.aixlarity-knowledge-ledger'));
	const top = append(card, $('div.aixlarity-knowledge-top'));
	const title = append(top, $('div', { style: 'min-width: 0;' }));
	append(title, $('div.aixlarity-knowledge-title')).textContent = 'Knowledge Ledger';
	append(title, $('div.aixlarity-knowledge-subtitle')).textContent = ledger.enabled ? 'Reviewable learning and rules.' : 'Learning is off.';
	const status = append(top, $('span.aixlarity-settings-badge'));
	status.textContent = ledger.enabled ? 'ON' : 'OFF';
	status.classList.toggle('active', ledger.enabled);

	const metrics = append(card, $('div.aixlarity-knowledge-metrics'));
	for (const [label, value] of [
		['Rules', ledger.summary.rules],
		['Workflows', ledger.summary.workflows],
		['Memory', ledger.summary.memories],
		['MCP', ledger.summary.mcpServers],
	] as Array<[string, number]>) {
		const item = append(metrics, $('span.aixlarity-task-badge'));
		item.textContent = `${label} ${value}`;
	}

	const controls = append(card, $('div.aixlarity-knowledge-controls'));
	renderSwitch(controls, 'Ledger', policy.ledgerEnabled, value => {
		policy.ledgerEnabled = value;
		options.onPolicyChange({ ...policy });
	});
	renderSwitch(controls, 'Rules', policy.rulesEnabled, value => {
		policy.rulesEnabled = value;
		options.onPolicyChange({ ...policy });
	});
	renderSwitch(controls, 'Memory', policy.memoryEnabled, value => {
		policy.memoryEnabled = value;
		options.onPolicyChange({ ...policy });
	});
	renderSwitch(controls, 'Auto', policy.autoCaptureEnabled, value => {
		policy.autoCaptureEnabled = value;
		options.onPolicyChange({ ...policy });
	});
	renderSwitch(controls, 'Review', policy.reviewRequired, value => {
		policy.reviewRequired = value;
		options.onPolicyChange({ ...policy });
	});

	const activation = append(card, $('div.aixlarity-knowledge-activation'));
	append(activation, $('span')).textContent = 'Rules Activation';
	const select = append(activation, $<HTMLSelectElement>('select.aixlarity-compact-select'));
	for (const [value, label] of [
		['manual', 'Manual'],
		['always_on', 'Always On'],
		['model_decision', 'Model Decision'],
		['glob', 'Glob'],
	] as Array<[KnowledgeActivationMode, string]>) {
		const option = append(select, $<HTMLOptionElement>('option'));
		option.value = value;
		option.textContent = label;
		option.selected = policy.activationMode === value;
	}
	select.addEventListener('change', () => {
		policy.activationMode = select.value as KnowledgeActivationMode;
		options.onPolicyChange({ ...policy });
	});

	if (policy.activationMode === 'glob') {
		const glob = append(card, $<HTMLInputElement>('input.aixlarity-model-input', { placeholder: '**/*.{ts,tsx,rs}' }));
		glob.value = policy.globPattern;
		glob.addEventListener('change', () => {
			policy.globPattern = glob.value.trim() || '**/*';
			options.onPolicyChange({ ...policy });
		});
	}

	const entries = append(card, $('div.aixlarity-knowledge-entries'));
	for (const entry of ledger.entries.slice(0, 5)) {
		const row = append(entries, $('div.aixlarity-knowledge-entry'));
		append(row, $(`span.codicon.codicon-${entry.kind === 'memory' ? 'book' : entry.kind === 'workflow' ? 'run' : entry.kind === 'mcp' ? 'plug' : 'symbol-key'}`));
		const text = append(row, $('div', { style: 'min-width: 0;' }));
		append(text, $('div.aixlarity-knowledge-entry-title')).textContent = entry.name;
		append(text, $('div.aixlarity-knowledge-entry-meta')).textContent = `${entry.activationMode} · ${entry.path}`;
	}
	if (ledger.entries.length === 0) {
		append(entries, $('div.aixlarity-knowledge-entry-meta')).textContent = 'No rules, workflows, memories, or MCP files found.';
	}

	const actions = append(card, $('div.aixlarity-knowledge-actions'));
	const exportBtn = append(actions, $('button.aixlarity-action-button'));
	append(exportBtn, $('span.codicon.codicon-export'));
	append(exportBtn, $('span')).textContent = 'Export Ledger';
	exportBtn.addEventListener('click', () => options.onExport());
	return card;
}

function renderSwitch(container: HTMLElement, label: string, enabled: boolean, onChange: (value: boolean) => void): void {
	const button = append(container, $('button.aixlarity-knowledge-switch'));
	button.classList.toggle('active', enabled);
	append(button, $('span')).textContent = label;
	append(button, $('span')).textContent = enabled ? 'ON' : 'OFF';
	button.addEventListener('click', () => onChange(!enabled));
}
