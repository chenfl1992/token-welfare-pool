import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { runDshCheckin, getLastDshCheckinReport } from '../services/dsh-checkin.js';
import { syncDshModels, getLastDshModelSyncReport } from '../services/dsh-model-sync.js';
import { dshGatewayBaseUrl, DSH_GATEWAY_DEFAULT_URL } from '../providers/dsh-gateway.js';

export const dshRouter = Router();

/**
 * DSH free-channels integration endpoints (#dsh-integration).
 * Mounted at /api/dsh behind the dashboard auth (see app.ts).
 */

// Integration status: configured keys, gateway URL, last check-in report.
dshRouter.get('/status', (_req: Request, res: Response) => {
  const db = getDb();
  const keys = db.prepare(
    "SELECT id, label, enabled, status FROM api_keys WHERE platform = 'dsh' ORDER BY id",
  ).all() as Array<{ id: number; label: string; enabled: number; status: string }>;
  const models = db.prepare(
    "SELECT model_id, display_name, enabled FROM models WHERE platform = 'dsh' ORDER BY model_id",
  ).all() as Array<{ model_id: string; display_name: string; enabled: number }>;

  res.json({
    ok: true,
    gatewayUrl: dshGatewayBaseUrl(),
    gatewayDefault: DSH_GATEWAY_DEFAULT_URL,
    keys,
    models: models.length,
    lastCheckin: getLastDshCheckinReport(),
    lastModelSync: getLastDshModelSyncReport(),
  });
});

// Manual check-in trigger (the scheduler also runs daily; this is for "claim now").
dshRouter.post('/checkin', async (_req: Request, res: Response) => {
  try {
    const report = await runDshCheckin();
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});

// Manual model-sync trigger: pull the gateway's current model list now.
dshRouter.post('/models/sync', async (_req: Request, res: Response) => {
  try {
    const report = await syncDshModels();
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});
