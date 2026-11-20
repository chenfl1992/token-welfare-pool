import type { NodeScheduler } from '../lib/scheduler.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { dshGatewayBaseUrl } from '../providers/dsh-gateway.js';
import { registerDiscoveredModels, type DiscoveredEntry } from './builtin-model-discovery.js';

/**
 * DSH 模型同步服务（#dsh-integration）。
 *
 * ofm 改造版网关（127.0.0.1:18899）的模型池是动态的——上游渠道新增模型、
 * 清单刷新、账号渠道解锁新模型后，/v1/models 会出现新 id。本服务定期拉取
 * 网关模型清单，把新出现的模型注册进 freellmapi：
 *
 *  - 复用平台标准的 registerDiscoveredModels：INSERT-only（已存在的不动，
 *    operator 手工调过的行也不动），新模型写入 fallback_config 并自动进入
 *    auto_include_new_models=1 的 profile（Default）。
 *  - 只增不减：网关暂时不可用或某模型临时下架不会误删本地行（路由的
 *    429/404 冷却自会处理失效模型），避免每次同步把链子打乱。
 *
 * 周期：启动 20s 后首刷一次（网关此时已就绪），此后每 6h 增量同步（可
 * 用 DSH_MODEL_SYNC_HOURS 覆盖）。签到服务成功领额度后也会顺手触发一次，
 * 因为签到往往跟在新渠道/新额度之后。
 */

const BOOT_SYNC_DELAY_MS = 20_000;
const DEFAULT_SYNC_HOURS = 6;

export interface DshModelSyncReport {
  syncedAt: string;
  gatewayUrl: string;
  checked: number;
  created: string[];
  existing: number;
  skipped: string[];
}

let lastReport: DshModelSyncReport | null = null;
let syncInFlight: Promise<DshModelSyncReport | null> | null = null;

export function getLastDshModelSyncReport(): DshModelSyncReport | null {
  return lastReport;
}

/** 网关同步间隔（小时），DSH_MODEL_SYNC_HOURS 可覆盖（0 则关闭周期同步）。 */
export function dshModelSyncHours(): number {
  const raw = Number(process.env.DSH_MODEL_SYNC_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SYNC_HOURS;
}

function dshKeys(): Array<{ id: number; label: string; apiKey: string }> {
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

/** 拉取网关模型清单并增量注册。返回 null 表示没有 dsh key 或网关不可达。 */
export async function syncDshModels(): Promise<DshModelSyncReport | null> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doSync(): Promise<DshModelSyncReport | null> {
  const keys = dshKeys();
  const gatewayUrl = dshGatewayBaseUrl();
  if (keys.length === 0) {
    lastReport = { syncedAt: new Date().toISOString(), gatewayUrl, checked: 0, created: [], existing: 0, skipped: ['no-dsh-key'] };
    return lastReport;
  }

  let models: Array<{ id: string; context_window?: number | null }>;
  try {
    const res = await fetch(`${gatewayUrl}/models`, {
      headers: { Authorization: `Bearer ${keys[0].apiKey}` },
    });
    if (!res.ok) {
      lastReport = { syncedAt: new Date().toISOString(), gatewayUrl, checked: 0, created: [], existing: 0, skipped: [`gateway HTTP ${res.status}`] };
      return lastReport;
    }
    const body = await res.json() as { data?: Array<{ id?: string; context_window?: number | null }> };
    models = (body.data ?? [])
      .filter((m): m is { id: string; context_window?: number | null } => typeof m?.id === 'string' && m.id.length > 0)
      .map(m => ({ id: m.id, context_window: m.context_window }));
  } catch (err) {
    lastReport = { syncedAt: new Date().toISOString(), gatewayUrl, checked: 0, created: [], existing: 0, skipped: [`unreachable: ${(err as Error)?.message ?? err}`] };
    return lastReport;
  }

  const entries: DiscoveredEntry[] = models.map(m => ({
    modelId: m.id,
    contextWindow: m.context_window ?? undefined,
    // 网关 /v1/models 的 owned_by / id 前缀已含渠道信息；视觉模型按 id 启发式标记
    vision: /vl|vision|visual|llava|gemma-4-31b|minicpm-v|oc-v/i.test(m.id),
  }));

  const db = getDb();
  const result = registerDiscoveredModels(db, 'dsh', entries, { explicit: false });

  lastReport = {
    syncedAt: new Date().toISOString(),
    gatewayUrl,
    checked: models.length,
    created: result.created,
    existing: result.existing.length,
    skipped: result.tombstoned,
  };
  if (result.created.length > 0) {
    console.log(`[dsh-model-sync] +${result.created.length} 新模型: ${result.created.slice(0, 10).join(', ')}${result.created.length > 10 ? '…' : ''}`);
  } else {
    console.log(`[dsh-model-sync] 无新增（${result.existing.length} 已存在）`);
  }
  return lastReport;
}

/** 启动周期同步。返回 disposer（测试用）。 */
export function startDshModelSync(scheduler: NodeScheduler): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(scheduler.after(BOOT_SYNC_DELAY_MS, () => { void syncDshModels(); }));

  const hours = dshModelSyncHours();
  if (hours > 0) {
    disposers.push(scheduler.every(hours * 3_600_000, () => { void syncDshModels(); }));
  }

  return () => { for (const d of disposers) d(); };
}

/** 签到成功后调用：新额度通常伴随新渠道/新模型解锁。 */
export async function syncAfterCheckin(): Promise<void> {
  try {
    await syncDshModels();
  } catch (err) {
    console.warn(`[dsh-model-sync] checkin-triggered sync failed: ${(err as Error)?.message ?? err}`);
  }
}