export const AIXLARITY_PROVIDER_BUNDLE_SCHEMA = 'aixlarity.provider_bundle.v1';

export interface ProviderPreset {
    id: string;
    label: string;
    family: string;
    apiBase: string;
    model: string;
    apiKeyEnv: string;
    bestFor: string;
}

export function providerPresets(): ProviderPreset[] {
    return [
        { id: 'custom-openai-compatible', label: 'OpenAI Compatible', family: 'openai-compatible', apiBase: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKeyEnv: 'OPENAI_API_KEY', bestFor: 'OpenAI-compatible API endpoint' },
        { id: 'custom-anthropic', label: 'Anthropic Claude', family: 'anthropic', apiBase: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY', bestFor: 'Claude Messages API' },
        { id: 'custom-gemini', label: 'Google Gemini', family: 'gemini', apiBase: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-pro', apiKeyEnv: 'GEMINI_API_KEY', bestFor: 'Gemini GenerateContent API' },
        { id: 'custom-openrouter', label: 'OpenRouter', family: 'openai-compatible', apiBase: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.5', apiKeyEnv: 'OPENROUTER_API_KEY', bestFor: 'Router for multiple model vendors' },
        { id: 'custom-deepseek', label: 'DeepSeek', family: 'openai-compatible', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', bestFor: 'Cost-efficient OpenAI-compatible coding model' },
        { id: 'custom-local-proxy', label: 'Local Proxy', family: 'openai-compatible', apiBase: 'http://127.0.0.1:4000/v1', model: 'local-model', apiKeyEnv: 'LOCAL_PROXY_API_KEY', bestFor: 'Local gateway, proxy, or self-hosted model server' },
        { id: 'custom-external-cli', label: 'External CLI', family: 'external-cli', apiBase: '', model: 'external-cli', apiKeyEnv: '', bestFor: 'Delegates execution to a configured local CLI tool' },
    ];
}

export function providerIsCustom(provider: any): boolean {
    const sourceKind = String(provider?.source_kind || '').toLowerCase();
    if (sourceKind === 'global' || sourceKind === 'workspace') {
        return true;
    }
    if (sourceKind === 'built-in' || sourceKind === 'environment') {
        return false;
    }
    const standardProviderIds = new Set([
        'claude-official', 'openai-codex', 'gemini-official',
        'engine-claude-code', 'engine-google-gemini', 'engine-openai-codex',
        'openrouter-codex', 'anthropic-claude',
        'openai-env', 'gemini-env', 'anthropic-env'
    ]);
    return !!provider?.id && !standardProviderIds.has(String(provider.id));
}

export function providerMutationScope(provider: any): 'workspace' | 'global' {
    return String(provider?.scope || provider?.source_kind || '').toLowerCase() === 'workspace' ? 'workspace' : 'global';
}

export function providerExportProfile(provider: any): any {
    return {
        id: provider.id,
        label: provider.label,
        family: provider.family,
        protocol: provider.protocol,
        api_base: provider.api_base,
        api_key_env: provider.api_key_env,
        model: provider.model,
        best_for: provider.best_for,
        strengths: Array.isArray(provider.strengths) ? provider.strengths : [],
        supports_multimodal: !!provider.supports_multimodal,
        supports_grounding: !!provider.supports_grounding,
        scope: providerMutationScope(provider),
    };
}

export function normalizeProviderImportProfile(raw: any, fallbackScope: string, index: number): any {
    const label = String(raw?.label || raw?.name || raw?.id || '').trim();
    const id = String(raw?.id || label)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const family = String(raw?.family || 'openai-compatible').trim();
    const model = String(raw?.model || '').trim();
    const apiBase = String(raw?.api_base || raw?.apiBase || '').trim();
    const apiKeyEnv = String(raw?.api_key_env || raw?.apiKeyEnv || '').trim().replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const scope = raw?.scope === 'global' || raw?.scope === 'workspace' ? raw.scope : fallbackScope;
    const isExternal = family === 'external-cli';

    if (!id) {
        throw new Error(`provider ${index + 1} is missing id or label`);
    }
    if (!model) {
        throw new Error(`provider ${id} is missing model`);
    }
    if (!isExternal && !apiBase) {
        throw new Error(`provider ${id} is missing api_base`);
    }
    if (!isExternal && !apiKeyEnv) {
        throw new Error(`provider ${id} is missing api_key_env`);
    }
    if (raw?.api_key || raw?.apiKey || raw?.key) {
        throw new Error(`provider ${id} contains a raw API key; import only env var names`);
    }

    return {
        id,
        label: label || id,
        family,
        api_base: apiBase,
        model,
        api_key_env: isExternal ? '' : apiKeyEnv,
        scope,
    };
}

export function createProviderBundle(providers: any[], activeGlobal: string | null, activeWorkspace: string | null, exportedAt = new Date().toISOString()): any {
    return {
        schema: AIXLARITY_PROVIDER_BUNDLE_SCHEMA,
        exportedAt,
        activeGlobal,
        activeWorkspace,
        providers: providers
            .filter(provider => providerIsCustom(provider))
            .map(provider => providerExportProfile(provider)),
    };
}
