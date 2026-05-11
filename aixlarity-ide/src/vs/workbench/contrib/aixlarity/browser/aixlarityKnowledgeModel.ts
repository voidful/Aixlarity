export type KnowledgeLedgerKind = 'rule' | 'workflow' | 'memory' | 'mcp';
export type KnowledgeActivationMode = 'always_on' | 'manual' | 'model_decision' | 'glob';

export interface KnowledgePolicy {
	ledgerEnabled: boolean;
	rulesEnabled: boolean;
	memoryEnabled: boolean;
	autoCaptureEnabled: boolean;
	reviewRequired: boolean;
	activationMode: KnowledgeActivationMode;
	globPattern: string;
	exportPreviews: boolean;
}

export interface KnowledgeLedgerEntry {
	id: string;
	kind: KnowledgeLedgerKind;
	name: string;
	path: string;
	activationMode: KnowledgeActivationMode | 'disabled';
	enabled: boolean;
	reviewRequired: boolean;
	bytes: number;
	modifiedAt: number;
	preview: string;
}

export interface KnowledgeLedger {
	schema: 'aixlarity.knowledge_ledger.v1';
	version: number;
	enabled: boolean;
	policy: KnowledgePolicy;
	summary: {
		total: number;
		enabled: number;
		rules: number;
		workflows: number;
		memories: number;
		mcpServers: number;
	};
	entries: KnowledgeLedgerEntry[];
}

export function normalizeKnowledgePolicy(raw: any): KnowledgePolicy {
	const activationMode = normalizeActivationMode(raw?.activationMode || raw?.activation_mode);
	return {
		ledgerEnabled: raw?.ledgerEnabled !== false && raw?.ledger_enabled !== false,
		rulesEnabled: raw?.rulesEnabled !== false && raw?.rules_enabled !== false,
		memoryEnabled: raw?.memoryEnabled !== false && raw?.memory_enabled !== false,
		autoCaptureEnabled: raw?.autoCaptureEnabled === true || raw?.auto_capture_enabled === true,
		reviewRequired: raw?.reviewRequired !== false && raw?.review_required !== false,
		activationMode,
		globPattern: String(raw?.globPattern || raw?.glob_pattern || '**/*').trim() || '**/*',
		exportPreviews: raw?.exportPreviews !== false && raw?.export_previews !== false,
	};
}

export function createKnowledgeLedger(inventory: Record<string, any[]> | undefined, policy: KnowledgePolicy): KnowledgeLedger {
	const rules = asArray(inventory?.rules).map(item => entryFromInventory('rule', item, policy.rulesEnabled, policy.activationMode, policy));
	const workflows = asArray(inventory?.workflows).map(item => entryFromInventory('workflow', item, policy.ledgerEnabled, 'manual', policy));
	const memories = asArray(inventory?.memories).map(item => entryFromInventory('memory', item, policy.memoryEnabled, 'always_on', policy));
	const mcpServers = asArray(inventory?.mcpServers).map(item => entryFromInventory('mcp', item, policy.ledgerEnabled, 'manual', policy));
	const entries = [...rules, ...workflows, ...memories, ...mcpServers]
		.map(entry => policy.ledgerEnabled ? entry : { ...entry, enabled: false, activationMode: 'disabled' as const });
	return {
		schema: 'aixlarity.knowledge_ledger.v1',
		version: 1,
		enabled: policy.ledgerEnabled,
		policy,
		summary: {
			total: entries.length,
			enabled: entries.filter(entry => entry.enabled).length,
			rules: rules.length,
			workflows: workflows.length,
			memories: memories.length,
			mcpServers: mcpServers.length,
		},
		entries,
	};
}

export function createKnowledgeLedgerBundle(ledger: KnowledgeLedger, nowIso = new Date().toISOString()): any {
	return {
		schema: ledger.schema,
		version: ledger.version,
		exportedAt: nowIso,
		enabled: ledger.enabled,
		policy: ledger.policy,
		summary: ledger.summary,
		entries: ledger.entries.map(entry => ({
			id: entry.id,
			kind: entry.kind,
			name: entry.name,
			path: entry.path,
			activationMode: entry.activationMode,
			enabled: entry.enabled,
			reviewRequired: entry.reviewRequired,
			bytes: entry.bytes,
			modifiedAt: entry.modifiedAt,
			...(ledger.policy.exportPreviews ? { preview: entry.preview } : {}),
		})),
	};
}

function entryFromInventory(kind: KnowledgeLedgerKind, item: any, sourceEnabled: boolean, activationMode: KnowledgeActivationMode, policy: KnowledgePolicy): KnowledgeLedgerEntry {
	const path = String(item?.path || item?.absolute_path || item?.name || kind);
	return {
		id: `${kind}:${path}`,
		kind,
		name: String(item?.name || path.split('/').pop() || kind),
		path,
		activationMode: sourceEnabled ? activationMode : 'disabled',
		enabled: policy.ledgerEnabled && sourceEnabled,
		reviewRequired: policy.reviewRequired,
		bytes: Number(item?.bytes || 0),
		modifiedAt: Number(item?.modified_ms || item?.modifiedAt || 0),
		preview: String(item?.preview || ''),
	};
}

function normalizeActivationMode(value: any): KnowledgeActivationMode {
	const mode = String(value || '').toLowerCase().replace(/[-\s]+/g, '_');
	if (mode === 'always_on' || mode === 'manual' || mode === 'model_decision' || mode === 'glob') {
		return mode;
	}
	return 'manual';
}

function asArray(value: any): any[] {
	return Array.isArray(value) ? value : [];
}
