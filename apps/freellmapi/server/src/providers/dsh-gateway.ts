import { OpenAICompatProvider } from './openai-compat.js';
import type { KeyValidationResult } from './base.js';

/**
 * DSH free-channels gateway (Ebony-Vinyl/dsh-our-free-model).
 *
 * The plugin mounts every account channel (lobsterai, qoder, qodercn, trae,
 * cline, loomy, raccoon, minimax, zcode, gemini) plus its keyless pools
 * (OpenCode free lane, Kilo free pool) behind ONE local OpenAI-compatible
 * gateway: GET /v1/models lists the pooled models, POST /v1/chat/completions
 * routes to whichever channel serves the model. freellmapi therefore only
 * needs a single platform ('dsh') pointed at that gateway — the per-channel
 * wire formats stay inside the plugin's channel pack, where they are
 * maintained against the vendors' client fingerprinting.
 *
 * Config:
 *  - DSH_GATEWAY_URL  — gateway base URL (default http://127.0.0.1:18899/v1,
 *    the plugin's standalone management/gateway port).
 *  - The key is the gateway's own relay credential (the plugin issues one per
 *    home; paste it into the Keys page for platform 'dsh').
 *
 * validateUrl probes /v1/models: the gateway answers 200 with its model list
 * when it is running and rejects bad relay credentials, so the default
 * key-validation path is a real check.
 */

export const DSH_GATEWAY_DEFAULT_URL = 'http://127.0.0.1:18899/v1';

export function dshGatewayBaseUrl(): string {
  const raw = process.env.DSH_GATEWAY_URL?.trim();
  if (!raw) return DSH_GATEWAY_DEFAULT_URL;
  return raw.replace(/\/+$/, '');
}

export class DshGatewayProvider extends OpenAICompatProvider {
  constructor(baseUrl = dshGatewayBaseUrl()) {
    super({
      platform: 'dsh',
      name: 'DSH Free Channels',
      baseUrl,
      validateUrl: `${baseUrl}/models`,
      // Channel upstreams authenticate through browser-session handoffs and
      // can take tens of seconds on cold start; match the reasoning-host
      // timeout rather than the default.
      timeoutMs: 120_000,
    });
  }

  /** The management plane (check-in, channel status) lives NEXT TO the
   *  OpenAI-compatible /v1: strip a trailing /v1 for the plugin's own
   *  endpoints. Shared with services/dsh-checkin.ts. */
  static managementBase(baseUrl = dshGatewayBaseUrl()): string {
    return baseUrl.replace(/\/v1\/?$/, '') || baseUrl;
  }
}

/** A parsed claim result from the plugin's check-in endpoint. */
export interface DshClaimResult {
  ok: boolean;
  detail: string;
}

/** The account channels the dsh-our-free-model standalone service bundles.
 *  Each exposes `credits.claimAll` over the channel-pack RPC bridge for its
 *  daily credit grant (verified against the standalone 2.2.0 frontend:
 *  `credits.claimAll` with `{ provider }`, plus `usage.autoCheckin`). The
 *  first two are legacy keys present in older dsh channel packs; the last two
 *  are the ones the standalone service persists. All are claimed when they
 *  exist — claimAll is a "grant the daily free credits" call, safe to run
 *  once a day per channel. */
export const DSH_CLAIMABLE_CHANNELS = [
  'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy',
  'raccoon', 'minimax', 'zcode', 'gemini', 'buddy',
] as const;

/**
 * Claim daily credits for every logged-in channel through the standalone
 * gateway's channel-pack RPC bridge (POST /api/management/channels/rpc with
 * method `credits.claimAll`, payload `{ provider }` — the exact shape the
 * standalone web frontend uses). The old /api/channels/checkin endpoint does
 * not exist on the standalone build, so this is the correct integration point.
 *
 * A gateway that answers 404 for the RPC bridge (pre-2.2 or the DSH-plugin
 * build) surfaces as { ok: false, detail } rather than throwing — a missing
 * claim API must not break the daily service.
 */
export async function claimDshDailyCredits(apiKey: string, baseUrl = dshGatewayBaseUrl()): Promise<DshClaimResult> {
  const url = `${DshGatewayProvider.managementBase(baseUrl)}/api/management/channels/rpc`;
  const claimed: string[] = [];
  const skipped: string[] = [];
  try {
    for (const provider of DSH_CLAIMABLE_CHANNELS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ method: 'credits.claimAll', payload: { provider } }),
        });
        // 404 on the bridge or on the channel → channel not present; not an error.
        if (res.status === 404) { skipped.push(`${provider}:not-found`); continue; }
        const body = await res.json().catch(() => null) as {
          ok?: unknown; error?: unknown; claimed?: unknown; summary?: unknown;
        } | null;
        const summary = body?.summary ?? body?.claimed;
        if (body?.ok === false || body?.error) {
          skipped.push(`${provider}:${String((body?.error as any)?.message ?? body?.error).slice(0, 60)}`);
        } else {
          const n = typeof summary === 'number' ? summary : Array.isArray(summary) ? summary.length : 0;
          claimed.push(`${provider}${n ? `(+${n})` : ''}`);
        }
      } catch {
        skipped.push(`${provider}:unreachable`);
      }
    }
    if (claimed.length === 0) {
      return { ok: false, detail: `no channel claimed (${skipped.join(', ') || 'none available'})` };
    }
    return { ok: true, detail: `claimed: ${claimed.join(', ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}` };
  } catch (err) {
    return { ok: false, detail: `gateway unreachable: ${(err as Error)?.message ?? err}` };
  }
}

export type { KeyValidationResult };
