/**
 * Per-key cooldown table.
 *
 * Inspired by freellmapi's ratelimit store (`getProbeableCooldowns`,
 * `clearCooldownEarly`, `clearAllCooldowns`) but kept minimal: a Map indexed by
 * `providerId::modelId::apiKeyId`, holding the moment the cooldown expires.
 * Cooldown verdicts come from `src/route/classify.js` (already a 1:1 port of the
 * 9router / FCC combined vocabulary). The health-probe module is responsible for
 * pruning expired cooldowns and clearing them early when a probe succeeds.
 *
 * @module src/cooldown.js
 */

/** @type {Map<string, {expiresAt: number, kind: string, hits: number}>} */
const cooldowns = new Map();

function keyFor(providerId, modelId, apiKeyId) {
  return `${providerId}::${modelId}::${apiKeyId ?? '-'}`;
}

export function setCooldown(providerId, modelId, apiKeyId, ms, kind = 'unknown', now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const key = keyFor(providerId, modelId, apiKeyId);
  const existing = cooldowns.get(key);
  cooldowns.set(key, {
    expiresAt: now + ms,
    kind: existing?.kind ?? kind,
    hits: (existing?.hits ?? 0) + 1,
  });
}

export function isOnCooldown(providerId, modelId, apiKeyId, now = Date.now()) {
  const c = cooldowns.get(keyFor(providerId, modelId, apiKeyId));
  return c !== undefined && c.expiresAt > now;
}

export function getCooldown(providerId, modelId, apiKeyId, now = Date.now()) {
  const c = cooldowns.get(keyFor(providerId, modelId, apiKeyId));
  return c === undefined || c.expiresAt <= now ? undefined : c;
}

export function clearCooldown(providerId, modelId, apiKeyId) {
  return cooldowns.delete(keyFor(providerId, modelId, apiKeyId));
}

export function getAllCooldowns(now = Date.now()) {
  const out = [];
  for (const [k, v] of cooldowns) {
    if (v.expiresAt <= now) {
      cooldowns.delete(k);
      continue;
    }
    const [providerId, modelId, apiKeyId] = k.split('::');
    out.push({ providerId, modelId, apiKeyId: apiKeyId === '-' ? null : Number(apiKeyId), expiresAtMs: v.expiresAt, kind: v.kind, hits: v.hits });
  }
  return out.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

/** Drop one cooldown in particular (used by cooldown-probe when a probe passes). */
export function clearCooldownEarly(providerId, modelId, apiKeyId) {
  return clearCooldown(providerId, modelId, apiKeyId);
}

export function clearAllCooldowns() {
  const count = cooldowns.size;
  cooldowns.clear();
  return count;
}
