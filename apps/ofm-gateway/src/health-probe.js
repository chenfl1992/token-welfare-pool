/**
 * Periodic availability probing for a single provider.
 *
 * A single KEY probe is enough: the API key that makes one model callable
 * makes them all callable on the same connection, so we only ask one cheap
 * `models` endpoint per provider. The result drives the "currently routable"
 * view in /health and the auto-router's start-up "scrubbing" pass. Live
 * health (per-turn) is handled by penalty.js / cooldown.js; this module only
 * owns the boot-time and once-an-hour scrubbing pass that lets an operator
 * see at a glance which providers to fix.
 *
 * Reference design: tashfeenahmed/freellmapi server/src/services/health.ts.
 *
 * @module src/health-probe.js
 */

const PROBE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 4;

const lastByProvider = new Map(); // providerId -> {ok: bool, ts, latencyMs, detail?}
let cancelTimer = null;

/** One cheap availability probe against the provider's /v1/models endpoint. */
async function probeOne(provider, env = process.env) {
  const started = Date.now();
  const baseUrl = (provider.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, detail: 'no baseUrl' };
  const url = `${baseUrl}/models`;
  const envName = provider.auth?.env;
  const key = envName && envName.length ? env[envName] : null;
  if (!key && provider.auth?.kind === 'apiKey') return { ok: false, detail: `env ${envName} unset` };
  const headers = { accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}`, latencyMs: Date.now() - started };
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, detail: e?.message ?? String(e), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Walk all configured providers with concurrency. */
export async function probeAll(PROVIDERS, env = process.env) {
  const targets = PROVIDERS.filter(p => p.category === 'apikey' && p.baseUrl);
  let cursor = 0;
  const results = new Map();
  const workers = Array.from({ length: Math.max(1, Math.min(PROBE_CONCURRENCY, targets.length)) }, async () => {
    while (cursor < targets.length) {
      const i = cursor++;
      const p = targets[i];
      const r = await probeOne(p, env);
      const prev = lastByProvider.get(p.id) ?? {};
      lastByProvider.set(p.id, { ...r, ts: Date.now(), prev });
      results.set(p.id, r);
    }
  });
  await Promise.all(workers);
  return results;
}

export function start(PROVIDERS, env = process.env, runOnce = true) {
  if (cancelTimer !== null) return;
  if (runOnce) probeAll(PROVIDERS, env).catch(err => console.error('[health-probe] initial pass failed', err?.message ?? err));
  cancelTimer = setInterval(() => {
    probeAll(PROVIDERS, env).catch(err => console.error('[health-probe] periodic pass failed', err?.message ?? err));
  }, PROBE_INTERVAL_MS);
  cancelTimer.unref?.();
}

export function stop() {
  if (cancelTimer !== null) {
    clearInterval(cancelTimer);
    cancelTimer = null;
  }
}

export function snapshot() {
  const out = [];
  for (const [id, v] of lastByProvider) out.push({ providerId: id, ...v });
  return out.sort((a, b) => a.providerId.localeCompare(b.providerId));
}
