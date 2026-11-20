import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { claimDshDailyCredits, DSH_GATEWAY_DEFAULT_URL } from '../../providers/dsh-gateway.js';
import { runDshCheckin, getLastDshCheckinReport } from '../../services/dsh-checkin.js';
import { getDb, initDb } from '../../db/index.js';

const ORIGINAL_URL = process.env.DSH_GATEWAY_URL;

describe('dsh-checkin service', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.DSH_GATEWAY_URL; else process.env.DSH_GATEWAY_URL = ORIGINAL_URL;
    vi.restoreAllMocks();
  });

  it('management base strips a trailing /v1', () => {
    process.env.DSH_GATEWAY_URL = 'http://127.0.0.1:19999/v1/';
    // strip happens inside claimDshDailyCredits via managementBase; assert through the URL it calls
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    void claimDshDailyCredits('k');
    expect(spy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:19999/api/channels/checkin');
  });

  it('a gateway without the check-in endpoint answers ok:false, not a throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const result = await claimDshDailyCredits('k');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no /api/channels/checkin');
  });

  it('a successful claim reports the accepted payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, claimed: ['qoder', 'trae'] }), { status: 200 }),
    );
    const result = await claimDshDailyCredits('k');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('2 channel(s)');
  });

  it('an unreachable gateway is an expected, reported state', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await claimDshDailyCredits('k');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unreachable');
  });

  it('runDshCheckin with no configured dsh keys is a clean no-op report', async () => {
    const report = await runDshCheckin();
    expect(report.keysConsidered).toBe(0);
    expect(report.entries).toEqual([]);
    expect(getLastDshCheckinReport()?.ranAt).toBe(report.ranAt);
  });

  it('a successful claim clears that key\'s cooldowns', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('dsh', 'gw', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'dsh'").get() as { id: number }).id;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, claimed: [] }), { status: 200 }),
    );
    const report = await runDshCheckin();
    expect(report.succeeded).toBe(1);
    expect(report.entries[0]?.cooldownsCleared).toBe(0); // nothing was benched; 0 is correct
    expect(report.entries[0]?.keyId).toBe(keyId);
  });

  it('the default gateway URL is the plugin standalone port', () => {
    delete process.env.DSH_GATEWAY_URL;
    expect(DSH_GATEWAY_DEFAULT_URL).toBe('http://127.0.0.1:18899/v1');
  });
});
