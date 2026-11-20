/**
 * Auto-router — the one model a WorkBuddy client should ever dial.
 *
 * - The virtual `model` names `auto`, `auto:fast`, `auto:smart`, `auto:reliable`,
 *   `auto:codex` (mirrored from freellmapi's 6 routing strategies) collapse all
 *   76 configured providers into one entry point. `auto` uses the balanced
 *   preset; the other suffixes pin a specific weight vector.
 * - A literal `provider/model` id (e.g. `groq/llama-3.3-70b-versatile`) is
 *   routed directly, with no fallback — the user asked for that one.
 * - Failure handling mirrors freellmapi `selectKeyForModel`: classify via
 *   `route/classify.js`, bench the offender (`cooldown.js`), penalize the
 *   model (`penalty.js`), rotate to the next candidate.
 * - 30-minute sticky session: within a single session the same provider/model
 *   pair wins unless it's benched. Sessions are derived from the
 *   `conversation` token passed by the client (or the user agent, as a
 *   last-resort hash).
 *
 * Reference design: tashfeenahmed/freellmapi server/src/services/router.ts.
 *
 * @module src/auto-router.js
 */

import { listRoutableCandidates, lookupApiKey, getProvider, parseProviderModelId, customChatUrl, customHeaders } from './active-providers.js';
import { chatEndpoint, defaultHeaders } from './providers/index.js';
import { laneUrl, laneHeaders } from './opencode-lane.js';
import {
  combineScore,
  DEFAULT_STRATEGY,
  expectedReliability,
  headroomFactor,
  rateLimitFactor,
  sampleReliability,
  speedScore,
  intelligenceScore,
  weightsFor,
} from './scoring.js';
import { getPenalty, recordModelFailure, recordRateLimitHit, recordSuccess as recordPenaltySuccess } from './penalty.js';
import { isOnCooldown, setCooldown } from './cooldown.js';
import { classifyFailure, shouldAdvance } from './route/classify.js';

const STICKY_MS = 30 * 60 * 1000;

/** Per-model timing & reliability samples. Window: last `MAX_SAMPLES` samples. */
const MAX_SAMPLES = 64;
const samples = new Map(); // `${providerId}::${modelId}` -> {tps:[], ttfb:[], succ:number, fail:number, lastUsed:number, stickyKey:string|null}

function sampleKey(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

function recordSuccess(providerId, modelId, ms, ttfbMs) {
  const key = sampleKey(providerId, modelId);
  let s = samples.get(key);
  if (s === undefined) {
    s = { tps: [], ttfb: [], succ: 0, fail: 0, lastUsed: 0, stickyKey: null };
    samples.set(key, s);
  }
  s.succ++;
  s.lastUsed = Date.now();
  if (ttfbMs != null && Number.isFinite(ttfbMs)) pushBounded(s.ttfb, ttfbMs);
  // rough throughput approximation: at least 1 completion returned; a zero
  // completion won't reach this branch, so we use elapsed as a lower bound.
  if (ms > 0) pushBounded(s.tps, 1000 / ms); // extremely rough; see readTps.
  return s;
}

function recordFailure(providerId, modelId) {
  const key = sampleKey(providerId, modelId);
  let s = samples.get(key);
  if (s === undefined) {
    s = { tps: [], ttfb: [], succ: 0, fail: 0, lastUsed: 0, stickyKey: null };
    samples.set(key, s);
  }
  s.fail++;
  s.lastUsed = Date.now();
  return s;
}

function pushBounded(arr, value) {
  arr.push(value);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

function readAvg(arr) {
  if (arr.length === 0) return null;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

/** Parse a `model` field into either an auto-strategy or a literal pair. */
export function parseModelRequest(modelField) {
  if (typeof modelField !== 'string' || modelField === '') return { kind: 'auto', strategy: DEFAULT_STRATEGY };
  const lower = modelField.toLowerCase().trim();
  if (lower === 'auto') return { kind: 'auto', strategy: DEFAULT_STRATEGY };
  if (lower.startsWith('auto:')) {
    const strat = lower.slice(5);
    return { kind: 'auto', strategy: BANDIT_ALIASES[strat] ?? strat };
  }
  const parsed = parseProviderModelId(modelField);
  if (parsed !== null) return { kind: 'literal', providerId: parsed.providerId, modelId: parsed.modelId };
  return { kind: 'auto', strategy: DEFAULT_STRATEGY };
}

const BANDIT_ALIASES = Object.freeze({
  fast: 'fastest',
  fastest: 'fastest',
  smart: 'smartest',
  smartest: 'smartest',
  reliable: 'reliable',
  balanced: 'balanced',
  codex: 'codex',
  cheap: 'fastest',
  budget: 'fastest',
});

/**
 * Score every candidate against the strategy; return the highest.
 * Returns null when no candidate is currently routable.
 */
function pickCandidate(strategy, stickySession, candidates, now) {
  const weights = weightsFor(strategy);
  const sticky = stickySession?.providerId ? stickySession : null;
  // Sticky override: if a sticky session is current and that provider/model is
  // not cooled down, use it first. This skips scoring noise mid-conversation.
  if (sticky !== null) {
    const c = candidates.find(c => c.providerId === sticky.providerId && c.modelId === sticky.modelId);
    if (c !== undefined && !isOnCooldown(c.providerId, c.modelId, 'env', now)) return c;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (isOnCooldown(c.providerId, c.modelId, 'env', now)) continue;
    const s = samples.get(sampleKey(c.providerId, c.modelId));
    const succ = s?.succ ?? 0;
    const fail = s?.fail ?? 0;
    const tpsAvg = readAvg(s?.tps ?? []);
    const ttfbAvg = readAvg(s?.ttfb ?? []);
    const reliability = expectedReliability(succ, fail);
    const reliabilitySample = sampleReliability(succ, fail);
    const speed = speedScore(tpsAvg ?? 0, ttfbAvg);
    const intel = intelligenceScore(c.sizeLabel);
    const penalty = getPenalty(c.providerId, c.modelId, now);
    const rateLimit = rateLimitFactor(penalty);
    const headroom = headroomFactor(0, 0); // per-key RPM/RPD would go here
    const score = combineScore(
      { reliability: reliabilitySample, speed, intelligence: intel, headroom, rateLimit },
      weights,
    );
    // Bootstrap: an unmeasured candidate (no tps, no ttfb) gets a small bonus so
    // it gets one honest try; otherwise the bandit never gets cold-start data.
    const coldStart = (s === undefined || (s.tps.length === 0 && s.ttfb.length === 0)) ? 0.05 : 0;
    if (score + coldStart > bestScore) {
      bestScore = score + coldStart;
      best = c;
    }
  }
  return best;
}

/** Refresh the candidates list against the current process env. */
function candidates(now) {
  return listRoutableCandidates();
}

/** Active sticky session per chat key. */
const sticky = new Map();
const stickyTouched = new Map(); // sessionKey -> lastTouch

function stickyKeyFor(req) {
  const body = req.body ?? {};
  return (
    body.conversation ??
    body.session ??
    body.user ??
    req.headers?.['x-session-id'] ??
    req.headers?.['x-conversation-id'] ??
    null
  );
}

function getStickySession(sessionKey, providerId, modelId) {
  if (!sessionKey) return null;
  const touched = stickyTouched.get(sessionKey) ?? 0;
  if (Date.now() - touched > STICKY_MS) {
    sticky.delete(sessionKey);
    stickyTouched.delete(sessionKey);
    return null;
  }
  const cur = sticky.get(sessionKey);
  if (cur === undefined) {
    sticky.set(sessionKey, { providerId, modelId });
    stickyTouched.set(sessionKey, Date.now());
    return null;
  }
  if (cur.providerId === providerId && cur.modelId === modelId) return cur;
  return null;
}

function setStickySession(sessionKey, providerId, modelId) {
  if (!sessionKey) return;
  sticky.set(sessionKey, { providerId, modelId });
  stickyTouched.set(sessionKey, Date.now());
}

/** The single export a WorkBuddy client talks to. */
export async function dispatch(req, executor) {
  const modelField = req.body?.model;
  const parsed = parseModelRequest(modelField);
  const sessionKey = stickyKeyFor(req);
  const candidatesList = candidates(Date.now());
  if (candidatesList.length === 0) {
    return {
      error: 'no_routable_models',
      message: 'No provider has its API key set. Set at least one of the env vars documented in src/providers/registry.json.',
    };
  }

  let attempts = [];
  let effective = parsed;
  if (parsed.kind === 'literal') {
    const c = candidatesList.find(c => c.providerId === parsed.providerId && c.modelId === parsed.modelId);
    if (c !== undefined) {
      attempts.push(c);
    } else {
      // Unknown literal name (e.g. the client's own default like "gpt-4o").
      // All models are "auto" underneath, so silently fall back to auto
      // routing instead of erroring — keeps arbitrary clients working.
      effective = { kind: 'auto', strategy: DEFAULT_STRATEGY };
    }
  }
  if (effective.kind === 'auto') {
    // Auto: list, sort, try in order. Up to 3 distinct (provider,model) tries.
    const stickySession = getStickySession(sessionKey, null, null);
    let pick = pickCandidate(effective.strategy, stickySession, candidatesList, Date.now());
    if (pick === null) {
      return { error: 'all_models_cooled', message: 'Every candidate is currently on cooldown. Retry shortly.' };
    }
    const ordered = [];
    const seen = new Set();
    while (pick !== null && ordered.length < 3) {
      const k = sampleKey(pick.providerId, pick.modelId);
      if (seen.has(k)) break;
      seen.add(k);
      ordered.push(pick);
      const rest = candidatesList.filter(c => !seen.has(sampleKey(c.providerId, c.modelId)));
      pick = pickCandidate(parsed.strategy, null, rest, Date.now());
    }
    if (ordered.length === 0) {
      return { error: 'all_models_cooled', message: 'Every candidate is currently on cooldown. Retry shortly.' };
    }
    attempts = ordered;
  }

  let lastErr = null;
  for (const candidate of attempts) {
    const provider = getProvider(candidate.providerId);
    const apiKey = lookupApiKey(provider);
    const isCustom = provider?.id === 'custom';
    const isLane = provider?.id === 'opencode'; // keyless OpenCode free lane
    const url = isCustom ? customChatUrl(provider)
      : isLane ? laneUrl(candidate.modelId)
      : chatEndpoint(provider, candidate.modelId);
    if (url === null) continue;
    const headers = isCustom ? customHeaders(provider, apiKey)
      : isLane ? laneHeaders(candidate.modelId, { stream: Boolean(req.body?.stream) })
      : defaultHeaders(provider, apiKey ?? undefined);
    const startedAt = Date.now();
    try {
      const result = await executor({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        url,
        headers,
        body: req.body,
        stream: Boolean(req.body?.stream),
        wire: isLane ? 'opencode' : undefined,
      });
      // Streaming: caller may set `ttfbMs` directly. Non-streaming: `ttfbMs` undefined.
      const elapsed = Date.now() - startedAt;
      recordSuccess(candidate.providerId, candidate.modelId, elapsed, result?.ttfbMs ?? null);
      recordPenaltySuccess(candidate.providerId, candidate.modelId);
      setStickySession(sessionKey, candidate.providerId, candidate.modelId);
      return {
        ok: true,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        strategy: effective.kind === 'auto' ? effective.strategy : 'literal',
        attempts: attempts.indexOf(candidate) + 1,
        ...result,
      };
    } catch (error) {
      recordFailure(candidate.providerId, candidate.modelId);
      const verdict = classifyFailure({
        status: error?.status,
        code: error?.code,
        message: typeof error?.message === 'string' ? error.message : undefined,
        body: error?.body,
        retryAfterMs: error?.retryAfterMs,
      });
      // 429/5xx → big penalty (3). All other failures → small penalty (1). Auth
      // failures (401 etc.) only decay the slot; they don't accumulate
      // forever the way transient blips would.
      if (verdict.kind === 'rate_limit') {
        recordRateLimitHit(candidate.providerId, candidate.modelId);
      } else if (verdict.kind !== 'auth' && verdict.kind !== 'billing') {
        recordModelFailure(candidate.providerId, candidate.modelId);
      }
      const advance = shouldAdvance(verdict);
      setCooldown(candidate.providerId, candidate.modelId, 'env', verdict.cooldownMs ?? 0, verdict.kind, Date.now());
      lastErr = { providerId: candidate.providerId, modelId: candidate.modelId, verdict, advance, cause: error?.message ?? 'unknown' };
      if (!advance) break; // 4xx; do not rotate
    }
  }
  // Every attempt exhausted.
  return {
    error: 'all_attempts_failed',
    message: 'All candidate models in the auto chain refused this turn.',
    attempts: lastErr === null ? [] : [lastErr],
  };
}

/** Inspect-side helpers used by /health and the in-process dashboard. */
export function inspectSamples() {
  const out = [];
  for (const c of listRoutableCandidates()) {
    const s = samples.get(sampleKey(c.providerId, c.modelId));
    out.push({
      providerId: c.providerId,
      modelId: c.modelId,
      modelName: c.modelName,
      success: s?.succ ?? 0,
      fail: s?.fail ?? 0,
      avgTps: readAvg(s?.tps ?? []) ?? null,
      avgTtfb: readAvg(s?.ttfb ?? []) ?? null,
      reliability: expectedReliability(s?.succ ?? 0, s?.fail ?? 0),
      lastUsed: s?.lastUsed ?? 0,
    });
  }
  return out;
}
