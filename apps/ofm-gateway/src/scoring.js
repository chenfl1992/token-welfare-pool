/**
 * Bandit routing scoring (port + simplification of freellmapi's scoring.ts).
 *
 * Three normalized [0,1] axes (reliability / speed / intelligence) are combined
 * as a weighted convex combination (weights sum to 1) and then multiplied by two
 * guardrail factors: `headroom` (free-quota headroom, defaults to 1) and
 * `rateLimit` (live 429 penalty, defaults to 1). A model that never produced a
 * sample is graded by an optimistic prior (Beta(1,1) → 0.5 expected reliability
 * with high variance), so the router explores instead of freezing fresh models
 * out of rotation.
 *
 * Everything here is pure: no I/O, no timers, no globals. The caller passes in
 * the per-model observations and the preset it picked, and gets a single [0,1]
 * number back. Three presets the dashboard exposes:
 *
 *   - `balanced` — reliability leads, equal weight to speed and intelligence.
 *   - `smartest` — intelligence leads, but reliability still matters.
 *   - `fastest`  — speed leads, reliability guards against a flaky fast model.
 *
 * Reference design: tashfeenahmed/freellmapi server/src/services/scoring.ts.
 *
 * @module src/scoring.js
 */

/** Tunable preset weights. The router normalizes on read so callers can tweak. */
export const BANDIT_PRESETS = Object.freeze({
  // alias "balanced" → same shape, kept both for back-compat with legacy input.
  balanced:  { reliability: 0.50, speed: 0.25, intelligence: 0.25 },
  smartest:  { reliability: 0.35, speed: 0.10, intelligence: 0.55 },
  fastest:   { reliability: 0.35, speed: 0.55, intelligence: 0.10 },
  reliable:  { reliability: 0.70, speed: 0.15, intelligence: 0.15 },
  // alias "codex" as fast+balanced for now (could grow into its own preset).
  codex:     { reliability: 0.40, speed: 0.30, intelligence: 0.30 },
});

export const DEFAULT_STRATEGY = 'balanced';

/** Beta prior counts. Beta(1,1) = uniform; deliberately flat so a fresh model
 *  has no opinion rather than a default-fail that lingers after a hiccup. */
export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

/** Decay-weighted expected reliability ∈ [0,1] (caller-facing dashboard value). */
export function expectedReliability(successes, failures) {
  const s = Math.max(0, successes) + PRIOR_SUCCESS;
  const f = Math.max(0, failures) + PRIOR_FAILURE;
  return s / (s + f);
}

/** Thompson sample of the reliability posterior (used at routing time). */
export function sampleReliability(successes, failures) {
  // Marsaglia & Tsang via two Gamma draws. Production ports use a lookup table
  // for the Gamma sampler; this minimal port keeps correctness, not speed.
  const s = Math.max(0, successes) + PRIOR_SUCCESS;
  const f = Math.max(0, failures) + PRIOR_FAILURE;
  const x = sampleGamma(s);
  const y = sampleGamma(f);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

/** Saturating throughput curve; one very-fast small model can't dominate. */
export const SPEED_SCALE_TOK_S = 60;
export function speedScore(tokPerSec, ttfbMs) {
  if (tokPerSec <= 0 && ttfbMs === null) return 0.6; // prior: optimistic
  const tp = tokPerSec > 0 ? 1 - Math.exp(-tokPerSec / SPEED_SCALE_TOK_S) : 0;
  if (ttfbMs === null || ttfbMs === undefined) return tp;
  const TTFB_BEST = 300;
  const TTFB_WORST = 5000;
  const lat = ttfbMs <= TTFB_BEST ? 1 : ttfbMs >= TTFB_WORST ? 0 : 1 - (ttfbMs - TTFB_BEST) / (TTFB_WORST - TTFB_BEST);
  if (tokPerSec <= 0) return lat;
  return 0.6 * tp + 0.4 * lat;
}

/** Cross-provider tier label from the registry. Higher tier dominates. */
const TIER = { Frontier: 4, Large: 3, Medium: 2, Small: 1 };
export function intelligenceScore(sizeLabel) {
  return (TIER[sizeLabel] ?? 0) / 4; // normalize to [0,1]
}

/** Cooldown stickiness for a key — saturation around 0.6 keeps room to recover. */
export const MAX_PENALTY = 10;
export const RATE_LIMIT_MAX_DAMP = 0.4;
export function rateLimitFactor(penalty) {
  const p = Math.min(Math.max(0, penalty), MAX_PENALTY);
  return 1 - (p / MAX_PENALTY) * RATE_LIMIT_MAX_DAMP;
}

/** Headroom: 1 while comfortable, linear down to a floor near zero. */
const HEADROOM_FLOOR = 0.1;
const HEADROOM_RAMP_START = 0.2;
export function headroomFactor(usedTokens, budgetTokens) {
  if (!budgetTokens || budgetTokens <= 0) return 1;
  const remaining = Math.max(0, Math.min(1, 1 - usedTokens / budgetTokens));
  if (remaining >= HEADROOM_RAMP_START) return 1;
  return HEADROOM_FLOOR + (1 - HEADROOM_FLOOR) * (remaining / HEADROOM_RAMP_START);
}

/** Weighted convex combination × guardrail multipliers, normalized to [0,1]. */
export function combineScore({ reliability, speed, intelligence, headroom = 1, rateLimit = 1 }, weights) {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base = (weights.reliability * reliability + weights.speed * speed + weights.intelligence * intelligence) / wSum;
  return base * headroom * rateLimit;
}

/** Pick weights for a strategy name; unknown → balanced. */
export function weightsFor(strategy) {
  return BANDIT_PRESETS[strategy] ?? BANDIT_PRESETS[DEFAULT_STRATEGY];
}

// ── Marsaglia & Tsang gamma sampler ─────────────────────────────────────────
function sampleGamma(shape) {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random() || 1e-12, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = randNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randNormal() {
  const u1 = Math.random() || 1e-12;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}
