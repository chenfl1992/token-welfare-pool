import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, refreshStatsCache, setRoutingStrategy, setExploreEnabled,
  recordRateLimitHit, recordSuccess, applyAvailabilityGate, splitByAvailability,
  type ChainRow,
} from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function addModel(opts: {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; sizeLabel: string; priority: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, 1, ?, '', 1, 0, 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.intelligenceRank, opts.sizeLabel);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority);
  addToActiveChain(id, opts.priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

function pickCounts(runs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

describe('availability-first ranking (#dsh-integration)', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    setExploreEnabled(false); // exploration probes would muddy the group assertions
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('a model carrying a 429 penalty ranks behind a callable, weaker model', () => {
    // "frontier" is the smartest model on paper but just 429'd; "small" is
    // weaker AND slower. The availability gate must still put small first.
    const frontier = addModel({ platform: 'google', modelId: 'frontier', name: 'Frontier', intelligenceRank: 1, sizeLabel: 'Frontier', priority: 1 });
    const small = addModel({ platform: 'groq', modelId: 'small', name: 'Small', intelligenceRank: 40, sizeLabel: 'Small', priority: 2 });
    recordRateLimitHit(frontier); // PENALTY_PER_429 penalty > 0 → constrained
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);

    const counts = pickCounts(30);
    expect(counts['small']).toBe(30);       // free group always wins
    expect(counts['frontier'] ?? 0).toBe(0); // constrained group never picked while free exists
  });

  it('once the penalty decays, the smarter model returns to the head', () => {
    const frontier = addModel({ platform: 'google', modelId: 'frontier', name: 'Frontier', intelligenceRank: 1, sizeLabel: 'Frontier', priority: 1 });
    addModel({ platform: 'groq', modelId: 'small', name: 'Small', intelligenceRank: 40, sizeLabel: 'Small', priority: 2 });
    recordRateLimitHit(frontier);
    // Simulate recovery: every served success decays the penalty (recordSuccess
    // decrements by 1 per call) until the model is free again.
    for (let i = 0; i < 20; i++) recordSuccess(frontier);
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(30);
    expect(counts['frontier'] ?? 0).toBeGreaterThan(0);
  });

  it('an active cooldown also marks a route constrained', () => {
    (ratelimit.isOnCooldown as any).mockImplementation((_p: string, m: string) => m === 'cool');
    addModel({ platform: 'google', modelId: 'cool', name: 'Cool', intelligenceRank: 1, sizeLabel: 'Frontier', priority: 1 });
    addModel({ platform: 'groq', modelId: 'warm', name: 'Warm', intelligenceRank: 40, sizeLabel: 'Small', priority: 2 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(20);
    expect(counts['warm']).toBe(20);
  });

  it('all-constrained pools keep their original order (never empty)', () => {
    (ratelimit.isOnCooldown as any).mockReturnValue(true);
    const a = addModel({ platform: 'google', modelId: 'a', name: 'A', intelligenceRank: 1, sizeLabel: 'Frontier', priority: 1 });
    const b = addModel({ platform: 'groq', modelId: 'b', name: 'B', intelligenceRank: 2, sizeLabel: 'Large', priority: 2 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    // Both constrained → gate is a no-op; the walk still attempts them and the
    // failure path reports exhaustion honestly rather than a dead route.
    const { free, constrained } = splitByAvailability([a, b].map(id => ({ model_db_id: id } as unknown as ChainRow)));
    // splitByAvailability works off penalty + isOnCooldown; both mocked true here
    expect(free.length).toBe(0);
    expect(constrained.length).toBe(2);
  });

  it('applyAvailabilityGate is a stable partition', () => {
    const rows = [{ model_db_id: 1 }, { model_db_id: 2 }, { model_db_id: 3 }] as unknown as ChainRow[];
    recordRateLimitHit(2); // model_db_id 2 carries a 429 penalty → constrained
    const gated = applyAvailabilityGate(rows);
    expect(gated.map(e => e.model_db_id)).toEqual([1, 3, 2]); // free first, relative order kept
  });

  it('priority strategy also respects the availability gate', () => {
    const frontier = addModel({ platform: 'google', modelId: 'frontier', name: 'Frontier', intelligenceRank: 1, sizeLabel: 'Frontier', priority: 1 });
    addModel({ platform: 'groq', modelId: 'small', name: 'Small', intelligenceRank: 40, sizeLabel: 'Small', priority: 2 });
    recordRateLimitHit(frontier);
    setRoutingStrategy('priority');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(20);
    expect(counts['small']).toBe(20); // manual priority 1 loses to the availability gate
  });
});
