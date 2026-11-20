/**
 * Per-model runtime penalty tracking.
 *
 * Each model accumulates penalty points when its upstream refuses; penalty is
 * decayed back over time so a single bad incident does not lock a model out.
 *
 * Inspired by freellmapi's `recordModelFailure` / `recordSuccess` / `getAllPenalties`
 * (server/src/services/router.ts lines around the "model failure/success rate
 * dynamic penalty" section):
 *
 *   - `PENALTY_PER_429 = 3`, `PENALTY_PER_FAIL = 1`, `MAX_PENALTY = 10`.
 *   - `DECAY_INTERVAL_MS = 120s`, `DECAY_AMOUNT = 1`.
 *
 * Re-implemented here as in-memory state — a restart losing it costs nothing
 * but a fresh sample window — because this gateway runs as a single process.
 *
 * @module src/penalty.js
 */

const PENALTY_PER_429 = 3;
const PENALTY_PER_FAIL = 1;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 120_000;
const DECAY_AMOUNT = 1;

/** @type {Map<string, {value: number, lastDecayAt: number, hits: number}>} */
const penalties = new Map();

function keyFor(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

function decay(state, now) {
  if (state.value <= 0) return;
  while (state.value > 0 && now - state.lastDecayAt >= DECAY_INTERVAL_MS) {
    state.value = Math.max(0, state.value - DECAY_AMOUNT);
    state.lastDecayAt += DECAY_INTERVAL_MS;
  }
}

/** Add weight to one model's penalty. Weight 3 = 429, 1 = generic fail. */
export function recordModelFailure(providerId, modelId, weight = PENALTY_PER_FAIL, now = Date.now()) {
  const key = keyFor(providerId, modelId);
  let state = penalties.get(key);
  if (state === undefined) {
    state = { value: 0, lastDecayAt: now, hits: 0 };
    penalties.set(key, state);
  }
  decay(state, now);
  state.value = Math.min(MAX_PENALTY, state.value + weight);
  state.hits++;
  return state.value;
}

/** Decay one step from a 429 specifically. */
export function recordRateLimitHit(providerId, modelId, now = Date.now()) {
  return recordModelFailure(providerId, modelId, PENALTY_PER_429, now);
}

/** A successful turn subtracts one penalty point (but never below zero). */
export function recordSuccess(providerId, modelId, now = Date.now()) {
  const key = keyFor(providerId, modelId);
  const state = penalties.get(key);
  if (state === undefined) return 0;
  decay(state, now);
  state.value = Math.max(0, state.value - 1);
  if (state.value === 0) penalties.delete(key);
  return state.value;
}

/** Current penalty (already decayed to `now`). */
export function getPenalty(providerId, modelId, now = Date.now()) {
  const state = penalties.get(keyFor(providerId, modelId));
  if (state === undefined) return 0;
  decay(state, now);
  return state.value;
}

/** Snapshot for /health or the dashboard endpoint. */
export function getAllPenalties(now = Date.now()) {
  const out = [];
  for (const [k, state] of penalties) {
    decay(state, now);
    const [providerId, modelId] = k.split('::');
    out.push({ providerId, modelId, penalty: state.value, hits: state.hits });
  }
  return out.sort((a, b) => b.penalty - a.penalty || b.hits - a.hits);
}

/** Operator-clearable (kept simple — this is in-memory). */
export function clearAllPenalties() {
  const count = penalties.size;
  penalties.clear();
  return count;
}
