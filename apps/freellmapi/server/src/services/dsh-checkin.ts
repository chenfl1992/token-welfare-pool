import { NodeScheduler } from '../lib/scheduler.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { clearCooldownsForKey } from './ratelimit.js';
import { claimDshDailyCredits, dshGatewayBaseUrl } from '../providers/dsh-gateway.js';
import { syncAfterCheckin } from './dsh-model-sync.js';

/**
 * Daily auto check-in for the DSH free-channels gateway (#dsh-integration).
 *
 * dsh-our-free-model's account channels (lobsterai, qoder, trae, cline, loomy,
 * raccoon, minimax, zcode, gemini, …) hand out a recurring daily credit grant
 * that must be CLAIMED — the plugin's own UI does it through
 * `usage.autoCheckin` / `credits.claimAll`. This service keeps freellmapi-side
 * quotas topped up without opening the plugin UI:
 *
 *  1. Every DSH key in api_keys (enabled, any health) is claimed once a day
 *     through the gateway's management endpoint.
 *  2. On a successful claim the key's rate-limit cooldowns are cleared — a
 *     channel that 429'd yesterday must not stay benched into a day it has
 *     fresh credits for. This is the generalized
 *     clearApinexCheckinCooldownsForKey pattern: check-in success is a stronger
 *     freshness signal than any heuristic cooldown.
 *  3. Results are recorded for the dashboard (GET /api/dsh/status) and logged.
 *
 * Schedule: one claim run shortly after local midnight (credits reset at the
 * provider's local day boundary) plus one shortly after boot, so a server that
 * only runs during the day still claims. Idempotent per day per key — the
 * gateway dedupes claims for already-checked-in channels, and a repeat claim
 * answers the same success without double-crediting.
 */

export interface DshCheckinEntry {
  keyId: number;
  label: string;
  ok: boolean;
  detail: string;
  cooldownsCleared: number;
  at: string;
}

export interface DshCheckinRunReport {
  ranAt: string;
  gatewayUrl: string;
  keysConsidered: number;
  succeeded: number;
  failed: number;
  entries: DshCheckinEntry[];
}

const CHECKIN_AFTER_MIDNIGHT_MS = 5 * 60_000;   // 00:05 local
const BOOT_CLAIM_DELAY_MS = 30_000;             // give the gateway time to come up
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000; // retry a failed run at noon-ish cadence

let lastReport: DshCheckinRunReport | null = null;
let lastRunDayKey = '';

export function getLastDshCheckinReport(): DshCheckinRunReport | null {
  return lastReport;
}

/** Local-day key so "once per day per process" is honest across DST shifts. */
function dayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function collectDshKeys(): Array<{ id: number; label: string; apiKey: string }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, label, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'dsh' AND enabled = 1",
  ).all() as Array<{ id: number; label: string; encrypted_key: string; iv: string; auth_tag: string }>;
  return rows.map(row => ({
    id: row.id,
    label: row.label || `dsh key #${row.id}`,
    apiKey: decrypt(row.encrypted_key, row.iv, row.auth_tag),
  }));
}

/** Run one check-in pass over every configured DSH key. Never throws: a
 *  gateway that is not running is an expected state, not a boot failure. */
export async function runDshCheckin(): Promise<DshCheckinRunReport> {
  const keys = collectDshKeys();
  const gatewayUrl = dshGatewayBaseUrl();
  const entries: DshCheckinEntry[] = [];

  for (const key of keys) {
    const result = await claimDshDailyCredits(key.apiKey, gatewayUrl);
    // A successful claim means the channel pools have fresh daily credits:
    // lift any bench left over from yesterday so routing can use them NOW.
    const cooldownsCleared = result.ok ? clearCooldownsForKey(key.id) : 0;
    entries.push({
      keyId: key.id,
      label: key.label,
      ok: result.ok,
      detail: result.detail,
      cooldownsCleared,
      at: new Date().toISOString(),
    });
    if (cooldownsCleared > 0) {
      console.log(`[dsh-checkin] ${key.label}: claim ok, cleared ${cooldownsCleared} cooldown(s)`);
    }
  }

  lastReport = {
    ranAt: new Date().toISOString(),
    gatewayUrl,
    keysConsidered: keys.length,
    succeeded: entries.filter(e => e.ok).length,
    failed: entries.filter(e => !e.ok).length,
    entries,
  };
  lastRunDayKey = dayKey();
  console.log(`[dsh-checkin] run complete: ${lastReport.succeeded}/${keys.length} key(s) claimed via ${gatewayUrl}`);
  // 签到成功通常伴随新渠道/新额度解锁 → 顺手同步一次模型清单。
  if (lastReport.succeeded > 0) {
    void syncAfterCheckin();
  }
  return lastReport;
}

/**
 * Start the daily schedule. One 24h ticker claims once per local day
 * (day-key dedupe makes a midnight-shifted tick harmless) and a boot run
 * covers servers that start mid-day. Returns a disposer for tests.
 */
export function startDshCheckin(scheduler: NodeScheduler): () => void {
  const disposers: Array<() => void> = [];

  // Boot claim: useful when the server runs only during the day, and harmless
  // later in the day (the gateway dedupes already-claimed channels).
  disposers.push(scheduler.after(BOOT_CLAIM_DELAY_MS, () => { void runDshCheckin(); }));

  // Every 6h attempt a claim; the day-key makes it once-per-day effective, and
  // the extra ticks give a failed run (gateway briefly down) same-day recovery
  // without a bespoke retry state machine.
  disposers.push(scheduler.every(RETRY_AFTER_FAILURE_MS, async () => {
    if (lastRunDayKey === dayKey()) return;
    await runDshCheckin();
  }));

  // The 00:05 slot: the common case where credits reset at local midnight.
  const msUntilNextMidnight = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.getTime() - now.getTime() + CHECKIN_AFTER_MIDNIGHT_MS;
  };
  const scheduleMidnight = (): void => {
    disposers.push(scheduler.after(msUntilNextMidnight(), async () => {
      if (lastRunDayKey !== dayKey()) await runDshCheckin();
      scheduleMidnight();
    }));
  };
  scheduleMidnight();

  return () => { for (const d of disposers) d(); };
}
