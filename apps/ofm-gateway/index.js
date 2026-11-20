/**
 * The WorkBuddy-facing OpenAI-compatible gateway.
 *
 * Speaks just enough of the OpenAI HTTP surface for WorkBuddy (and any other
 * OpenAI-compatible client) to point a base URL at it and call
 * `/v1/chat/completions`:
 *
 *   - `GET  /v1/models`                      → the auto* virtual catalog
 *   - `POST /v1/chat/completions`            → auto-routed model invocation
 *   - `GET  /health`                         → free liveness probe + dashboard JSON
 *   - `GET  /__internal/dashboard`           → JSON view of every active provider,
 *                                            sample counts, cooldowns, penalties
 *
 * Streaming follows the OpenAI SSE shape: each upstream chunk is piped through
 * with provider/model identification appended so the client can audit which
 * model actually answered. Auto-fallback on streaming is a hard problem; the
 * gateway retries on the same response object up to N times before giving up,
 * which only loses the in-flight tokens but keeps the SSE contract.
 *
 * Reference design: dsh-our-free-model (forward.js) for the OpenAI compat
 * envelope; tashfeenahmed/freellmapi (routes/proxy.ts) for the auto/router
 * integration.
 *
 * @module index.js
 */

import http from 'node:http';
import { dispatch } from './src/auto-router.js';
import { laneBody, laneDelta, laneCompletion } from './src/opencode-lane.js';
import { listAutoModels } from './src/models.js';
import { PROVIDERS } from './src/providers/index.js';
import { getAllCooldowns } from './src/cooldown.js';
import { getAllPenalties } from './src/penalty.js';
import { inspectSamples } from './src/auto-router.js';
import { listRoutableCandidates, refreshLocalModels } from './src/active-providers.js';
import { snapshot as healthSnapshot } from './src/health-probe.js';

const PORT = Number(process.env.WORKBUDDY_FREEMODEL_PORT ?? process.env.PORT ?? 18899);
const HOST = process.env.WORKBUDDY_FREEMODEL_HOST ?? '127.0.0.1';
const MAX_STREAM_FALLBACKS = 3;

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-session-id, x-conversation-id',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...cors(),
  });
  res.end(payload);
}

function sseResponse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    ...cors(),
  });
}

function readBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Execute one upstream call, streaming if the client wanted streaming.
 *
 * For streaming: pass `onDelta` so each upstream text chunk is forwarded as
 * an SSE event. For non-streaming: collect the body and return it.
 */
async function callUpstream({ providerId, modelId, url, headers, body, stream, onDelta, wire }) {
  // Strip WorkBuddy-specific fields from the body so the upstream stays naive.
  let upstreamBody = { ...body, model: modelId };
  delete upstreamBody.conversation;
  delete upstreamBody.session;
  delete upstreamBody.wire;
  const isLane = wire === 'opencode';
  if (isLane) {
    // OpenCode keyless lane: encode into the wire the model speaks, with the
    // desktop-client fingerprint (decoy tools, session ids) already in headers.
    upstreamBody = laneBody(modelId, body?.messages ?? [], stream);
  }
  const init = {
    method: 'POST',
    headers: { ...headers, accept: stream ? 'text/event-stream' : 'application/json' },
  };
  if (!isLane && stream) upstreamBody.stream = true;
  init.body = JSON.stringify(upstreamBody);
  const controller = new AbortController();
  init.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const err = new Error(`upstream HTTP ${resp.status}`);
      err.status = resp.status;
      try { err.body = JSON.parse(errBody); } catch { err.body = errBody; }
      throw err;
    }
    if (!stream) {
      const data = await resp.json();
      if (isLane) return { body: laneCompletion(modelId, data) };
      return { body: data };
    }
    // Some upstreams ignore `stream:true` and reply with a plain JSON body.
    // Detect by content-type: extract the message text and emit it as one delta.
    const ctype = String(resp.headers.get('content-type') ?? '');
    if (!ctype.includes('text/event-stream')) {
      const data = await resp.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content
        ?? (typeof data?.content?.[0]?.text === 'string' ? data.content[0].text : '');
      if (content) onDelta?.(content, { providerId, modelId, terminal: true });
      return { ttfbMs: Date.now() };
    }
    // Streaming: pipe SSE frames. Each "data: {...}\n\n" frame is parsed and the
    // `choices[0].delta.content` chunk is forwarded with model id patched in.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ttfbMs = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = event.split('\n');
        let data = '';
        for (const line of lines) if (line.startsWith('data:')) data += line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          let delta = '';
          if (isLane) {
            // laneDelta throws on in-stream error frames — a refusal inside a
            // 200 stream must count as a failure so the chain rotates.
            delta = laneDelta(parsed);
          } else {
            delta = parsed?.choices?.[0]?.delta?.content ?? '';
          }
          if (delta) onDelta?.(delta, { providerId, modelId });
        } catch (e) {
          if (isLane && e?.status) throw e; // real lane error, not noise
          // ignore non-JSON noise from upstream SSE
        }
      }
    }
    if (buffer.trim().length > 0) {
      // last partial frame: forward as-is
      onDelta?.(buffer, { providerId, modelId, terminal: true });
    }
    return { ttfbMs };
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('upstream timeout');
      err.code = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Convert upstream response into an OpenAI /v1/chat/completions completion. */
function wrapAsCompletion({ providerId, modelId, upstreamBody }) {
  // Most providers echo the OpenAI shape. If the body has no `choices[]`, treat
  // it as Anthropic-shaped and re-emit a minimal OpenAI envelope.
  if (Array.isArray(upstreamBody?.choices)) return upstreamBody;
  if (typeof upstreamBody?.content?.[0]?.text === 'string') {
    return {
      id: upstreamBody.id ?? `chatcmpl-${Math.random().toString(36).slice(2)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${providerId}/${modelId}`,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: upstreamBody.content[0].text },
        finish_reason: upstreamBody.stop_reason ?? 'stop',
      }],
      usage: upstreamBody.usage ?? {},
    };
  }
  // Fallback: pass through as-is with provider/model provenance added.
  return { ...upstreamBody, _provider: providerId, _model: modelId };
}

async function handleChatCompletions(req, res, body) {
  const wantsStream = Boolean(body.stream);
  if (wantsStream) sseResponse(res);
  // The dispatch wrapper needs a `body` we set up. Strip workbuddy-only fields.
  const dispatchReq = {
    body,
    headers: req.headers,
  };
  const execute = async (attempt) => {
    if (wantsStream) {
      // Stream chunks via SSE, with model id patched in.
      let firstDeltaAt = null;
      const onDelta = (chunk, meta) => {
        if (firstDeltaAt === null) firstDeltaAt = Date.now();
        const payload = {
          id: `chatcmpl-${attempt.providerId}-${Math.random().toString(36).slice(2)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: `${attempt.providerId}/${attempt.modelId}`,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const result = await callUpstream({ ...attempt, stream: true, onDelta });
      res.write('data: [DONE]\n\n');
      return { ttfbMs: firstDeltaAt };
    }
    const result = await callUpstream({ ...attempt, stream: false });
    const wrapped = wrapAsCompletion({
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      upstreamBody: result.body,
    });
    // Inject provenance so the client can audit which lane answered.
    wrapped._provider = attempt.providerId;
    wrapped._model = attempt.modelId;
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors() });
    res.end(JSON.stringify(wrapped));
    return { body: wrapped };
  };

  const result = await dispatch(dispatchReq, execute);
  if (result.error !== undefined) {
    if (wantsStream && !res.headersSent) {
      // SSE-already-started streaming can't switch to JSON; send a final frame.
      sseResponse(res);
    }
    return jsonResponse(res, 502, {
      error: {
        message: result.message,
        type: 'workbuddy-freemodel_error',
        code: result.error,
        ...(result.attempts ? { attempts: result.attempts } : {}),
      },
    });
  }
  // For streaming, the call path already wrote the response and end.
  if (wantsStream && !res.writableEnded) res.end();
}

async function handleModels(_req, res) {
  const data = listAutoModels();
  // Surfacing the user-defined custom endpoint(s) as directly-dialable ids.
  for (const c of listRoutableCandidates()) {
    if (c.custom) {
      data.push({
        id: `custom/${c.modelId}`,
        object: 'model',
        created: 1700000000,
        owned_by: 'workbuddy-freemodel-custom',
        description: `User-defined custom endpoint routed to ${c.baseUrl}. Dial directly or let 'auto' pick it.`,
      });
    }
  }
  jsonResponse(res, 200, { object: 'list', data });
}

function handleHealth(_req, res) {
  const candidates = listRoutableCandidates();
  jsonResponse(res, 200, {
    ok: true,
    providers_with_keys: candidates.length,
    candidates: candidates.length,
    cooldowns: getAllCooldowns().length,
    penalties: getAllPenalties().length,
    recent_probes: healthSnapshot().slice(0, 50),
  });
}

function handleDashboard(_req, res) {
  const all = listRoutableCandidates();
  jsonResponse(res, 200, {
    candidates: all,
    samples: inspectSamples(),
    cooldowns: getAllCooldowns(),
    penalties: getAllPenalties(),
    probes: healthSnapshot(),
    registry_size: PROVIDERS.length,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      return res.end();
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // Browser-friendly landing page at /: a quick status view.
    if (req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors() });
      return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>workbuddy-freemodel</title>
<style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#222}
h1{font-size:20px} code{background:#f4f4f4;padding:2px 6px;border-radius:4px}
li{margin:6px 0} .ok{color:#0a0}</style></head><body>
<h1>workbuddy-freemodel <span class="ok">● 运行中</span></h1>
<p>OpenAI 兼容网关。WorkBuddy 配置：</p>
<ul>
<li><code>base_url</code>：<code>http://127.0.0.1:18899/v1</code></li>
<li><code>api_key</code>：随便填</li>
<li><code>model</code>：<code>auto</code>（所有模型自动路由/回退）</li>
</ul>
<p><a href="/__internal/dashboard">运维 Dashboard（penalty / cooldown / samples）</a>
· <a href="/v1/models">/v1/models</a> · <a href="/health">/health</a></p>
</body></html>`);
    }
    // Accept base_url with or without the /v1 prefix — some clients append
    // "/v1" themselves, others don't. Normalize both to the canonical paths.
    const path = url.pathname.replace(/\/+$/, '');
    const p = path === '/chat/completions' ? '/v1/chat/completions'
      : path === '/models' ? '/v1/models'
      : path;
    if (req.method === 'GET' && p === '/v1/models') return handleModels(req, res);
    if (req.method === 'GET' && p === '/health') return handleHealth(req, res);
    if (req.method === 'GET' && p === '/__internal/dashboard') return handleDashboard(req, res);
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return jsonResponse(res, 400, { error: { message: e?.message ?? 'bad request', type: 'bad_request' } }); }
      return handleChatCompletions(req, res, body);
    }
    return jsonResponse(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    console.error('[workbuddy-freemodel] handler error', e);
    if (!res.headersSent) jsonResponse(res, 500, { error: { message: e?.message ?? 'internal error' } });
  }
});

export function start() {
  server.listen(PORT, HOST, () => {
    console.log(`[workbuddy-freemodel] listening on http://${HOST}:${PORT}`);
    console.log(`[workbuddy-freemodel] env-based provider list:`);
    for (const c of listRoutableCandidates()) {
      console.log(`  - ${c.providerId} :: ${c.modelId}  (${c.modelName})`);
    }
    // Discover models on local servers (ollama / lmstudio / llamacpp), then
    // keep the discovery fresh every minute.
    refreshLocalModels().then(() => {
      const found = listRoutableCandidates().filter(c => c.providerId !== 'custom');
      console.log(`[workbuddy-freemodel] routable after local discovery: ${found.length} models`);
    }).catch(() => {});
    setInterval(() => refreshLocalModels().catch(() => {}), 60_000);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
