/**
 * Build the active provider/model catalog at boot.
 *
 * Walk `src/providers/registry.json` (the 76-vendor list shipped with this
 * project) and produce the routable set: every provider with its `auth.env`
 * set in the current process is included with each model declared under it.
 *
 * - Provider `id` becomes the route prefix (e.g. `groq`).
 * - Each model id becomes a routable (provider, model) pair.
 * - `kind: 'none'` providers would be auto-included (the registry has none
 *   today, but the schema permits them).
 *
 * The set is hot-reloaded by reading `process.env` on every call; the HTTP
 * server only calls this once at boot, then re-evaluates when a request asks
 * the `auto` strategy to refresh its view.
 *
 * @module src/active-providers.js
 */

import { PROVIDERS, getProvider as regGetProvider, parseProviderModelId as regParse } from './providers/index.js';

/**
 * Custom provider — a user-defined OpenAI-compatible endpoint that is NOT in the
 * 76-vendor registry. This is the "接入自定义模型" hook: point `CUSTOM_BASE_URL`
 * at any server speaking the OpenAI chat/responses wire and it becomes routable
 * exactly like a built-in provider — addressable as `auto` (bandit picks it) or
 * literally as `custom/<modelId>`.
 *
 * Env contract:
 *   CUSTOM_BASE_URL     (required) e.g. http://127.0.0.1:8000/v1  or  https://my.host/openai/v1
 *   CUSTOM_API_KEY      (optional) bearer token; omit for keyless/local servers
 *   CUSTOM_MODEL_ID     (optional, comma-separated) model ids, e.g. qwen2.5-72b,my-model
 *   CUSTOM_MODEL_NAME   (optional) display names, parallel to CUSTOM_MODEL_ID
 *   CUSTOM_FORMAT       (optional) openai-chat (default) | openai-responses | anthropic-messages
 *   CUSTOM_AUTH_SCHEME  (optional) authorization scheme, default "Bearer"
 *   CUSTOM_EXTRA_HEADERS(optional) JSON object of extra headers to send
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null}
 */
export function readCustomProvider(env = process.env) {
  const baseUrl = (env.CUSTOM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl === '') return null;

  const apiKey = (env.CUSTOM_API_KEY ?? '').trim();
  const format = (env.CUSTOM_FORMAT ?? 'openai-chat').trim();
  const scheme = (env.CUSTOM_AUTH_SCHEME ?? 'Bearer').trim();
  const modelIds = (env.CUSTOM_MODEL_ID ?? 'custom-model')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const modelNames = (env.CUSTOM_MODEL_NAME ?? '')
    .split(',')
    .map(s => s.trim());

  const models = modelIds.map((id, i) => ({
    id,
    name: modelNames[i] || id,
    contextWindow: 128000,
    vision: false,
    reasoning: false,
  }));

  let extraHeaders = {};
  if (env.CUSTOM_EXTRA_HEADERS) {
    try { extraHeaders = JSON.parse(env.CUSTOM_EXTRA_HEADERS); }
    catch { extraHeaders = {}; }
  }

  return {
    id: 'custom',
    name: 'Custom Model',
    category: apiKey ? 'apikey' : 'local',
    auth: {
      kind: apiKey ? 'apiKey' : 'none',
      env: apiKey ? 'CUSTOM_API_KEY' : undefined,
    },
    baseUrl,
    format,
    models,
    headers: extraHeaders,
    notes: `User-defined endpoint (${scheme}).`,
    website: baseUrl,
    local: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'),
    source: 'custom',
    _authScheme: scheme,
  };
}

/** The active custom provider for this process, or null. */
export function getCustomProvider(env = process.env) {
  return readCustomProvider(env);
}

/** Wire suffix per format — mirrors providers/index.js CHAT_PATHS for the custom record. */
const CHAT_SUFFIX = Object.freeze({
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
});

/** Full chat URL for the custom provider record. */
export function customChatUrl(provider) {
  if (provider?.id !== 'custom') return null;
  const base = (provider.baseUrl ?? '').trim().replace(/\/+$/, '');
  const suffix = CHAT_SUFFIX[provider.format];
  if (base === '' || suffix === undefined) return null;
  return `${base}${suffix}`;
}

/** Minimal headers for the custom provider, honoring its auth scheme. */
export function customHeaders(provider, apiKey) {
  if (provider?.id !== 'custom') return {};
  const headers = { 'content-type': 'application/json', ...(provider.headers ?? {}) };
  if (provider.format === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key !== '' && provider.auth?.kind === 'apiKey') {
    if (provider.format === 'anthropic-messages') headers['x-api-key'] = key;
    else headers['authorization'] = `${provider._authScheme ?? 'Bearer'} ${key}`;
  }
  return headers;
}

/**
 * Build the flat (provider, model) list of routable entries.
 *
 * A provider is routable when its credentials are satisfied in this process:
 *   - auth.kind === 'none'  → always (keyless lanes, e.g. the OpenCode free pool)
 *   - auth.kind === 'apiKey' with its `auth.env` set → included
 *   - oauth / adc providers need browser sign-in — not supported here, skipped
 *
 * Local servers (ollama / lmstudio / llamacpp) declare no model ids in the
 * registry; whatever `refreshLocalModels()` discovered from their /models
 * endpoint is used instead.
 *
 * @returns {Array<{providerId: string, providerName: string, modelId: string, modelName: string, format: string, baseUrl: string|null}>}
 */
export function listRoutableCandidates(env = process.env) {
  const out = [];
  for (const provider of PROVIDERS) {
    if (!providerEnvSatisfied(provider, env)) continue;
    const declared = provider.models ?? [];
    const models = declared.length > 0
      ? declared
      : (localDiscovered.get(provider.id) ?? []).map(id => ({ id, name: id }));
    for (const model of models) {
      out.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        format: provider.format,
        baseUrl: provider.baseUrl,
        envName: provider.auth?.env,
        sizeLabel: 'Medium',
      });
    }
  }
  // Custom user-defined endpoint(s) — the "接入自定义模型" hook.
  const custom = readCustomProvider(env);
  if (custom !== null) {
    for (const model of custom.models ?? []) {
      out.push({
        providerId: custom.id,
        providerName: custom.name,
        modelId: model.id,
        modelName: model.name,
        format: custom.format,
        baseUrl: custom.baseUrl,
        envName: custom.auth?.env,
        sizeLabel: 'Medium',
        custom: true,
      });
    }
  }
  return out;
}

function providerEnvSatisfied(provider, env) {
  if (provider.auth?.kind === 'none') return true;
  if (provider.auth?.kind !== 'apiKey') return false;
  const name = provider.auth?.env;
  return typeof name === 'string' && name !== '' && Boolean(env[name]);
}

/**
 * Runtime model discovery for `local` category providers (ollama / lmstudio /
 * llamacpp). The registry ships no ids for them — their model list is whatever
 * the user has loaded. Probe each server's /models endpoint and cache the ids.
 */
const localDiscovered = new Map(); // providerId -> [modelId, ...]

export async function refreshLocalModels(env = process.env) {
  const locals = PROVIDERS.filter(p => p.category === 'local');
  await Promise.all(locals.map(async p => {
    try {
      const base = (p.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (base === '') return;
      const resp = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) { localDiscovered.delete(p.id); return; }
      const data = await resp.json();
      const ids = (data?.data ?? data?.models ?? [])
        .map(m => m.id ?? m.name)
        .filter(x => typeof x === 'string' && x !== '');
      if (ids.length > 0) localDiscovered.set(p.id, ids);
      else localDiscovered.delete(p.id);
    } catch {
      localDiscovered.delete(p.id); // server not running
    }
  }));
}

/** Provider id → API key lookup. Returns null when no key is set. */
export function lookupApiKey(provider, env = process.env) {
  if (provider.auth?.kind !== 'apiKey') return null;
  const name = provider.auth?.env;
  return typeof name === 'string' && name !== '' ? env[name] ?? null : null;
}

/** Read one provider record by id; null when unknown. Wraps the custom provider. */
export function getProvider(id) {
  if (id === 'custom') return readCustomProvider();
  return regGetProvider(id);
}

/** Parse a `provider/model` composite id, aware of the custom prefix. */
export function parseProviderModelId(composite) {
  if (typeof composite === 'string' && composite.toLowerCase().startsWith('custom/')) {
    const modelId = composite.slice('custom/'.length).trim();
    if (modelId !== '') return { providerId: 'custom', modelId };
    return null;
  }
  return regParse(composite);
}
