/**
 * Adapter for the OpenCode keyless free lane (registry id `opencode`).
 *
 * The lane only serves requests that fingerprint as a genuine OpenCode
 * desktop client: a fixed `Bearer public` credential, a client UA, session /
 * request ids, and the four decoy tools (bash / glob / grep / read). All of
 * that machinery already lives in `src/upstream.js` — this module adapts it to
 * the gateway's call shape: URL, headers, body encoding per wire, and delta /
 * payload parsing per wire.
 *
 * Per-model wires (9router registry comments):
 *   - muse-spark-1.2/1.3-contributor-free → /zen/v1/responses
 *   - union-alpha                         → /zen/v1/messages (Anthropic)
 *   - everything else                     → /zen/v1/chat/completions
 *
 * @module src/opencode-lane.js
 */

import {
  UPSTREAM_BASE,
  applyFingerprint,
  endpointFor,
  gatewayHeaders,
  mintRequestId,
  sessionForConversation,
  wireFor,
} from './upstream.js';

/** Full URL for one model on the lane. */
export function laneUrl(modelId) {
  return `${UPSTREAM_BASE}${endpointFor(modelId)}`;
}

/** Desktop-fingerprint headers for one request. */
export function laneHeaders(modelId, { stream = false, accept } = {}) {
  return gatewayHeaders({
    session: sessionForConversation('workbuddy-freemodel'),
    requestId: mintRequestId(),
    stream,
    accept,
  });
}

/** Flatten one client message's content to plain text. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

/**
 * Encode the client's OpenAI chat `messages` into the wire the model speaks.
 * Mutates nothing on the input; the returned body carries the decoy-tool
 * fingerprint the lane expects.
 */
export function laneBody(modelId, messages, stream) {
  const wire = wireFor(modelId);
  const msgs = Array.isArray(messages) ? messages : [];

  if (wire === 'responses') {
    const system = msgs.filter(m => m?.role === 'system').map(textOf).join('\n\n');
    const input = msgs
      .filter(m => m?.role === 'user' || m?.role === 'assistant')
      .map(m => ({
        type: 'message',
        role: m.role,
        content: [{
          type: m.role === 'assistant' ? 'output_text' : 'input_text',
          text: textOf(m),
        }],
      }));
    const body = {
      model: modelId,
      input,
      stream: Boolean(stream),
      store: false,
      max_output_tokens: 8192,
    };
    if (system !== '') body.instructions = system;
    applyFingerprint(body, true); // flat responses-style tools
    return body;
  }

  if (wire === 'messages') {
    const system = msgs.filter(m => m?.role === 'system').map(textOf).join('\n\n');
    const body = {
      model: modelId,
      messages: msgs
        .filter(m => m?.role === 'user' || m?.role === 'assistant')
        .map(m => ({ role: m.role, content: textOf(m) })),
      stream: Boolean(stream),
      max_tokens: 8192,
    };
    if (system !== '') body.system = system;
    applyFingerprint(body, 'claude');
    return body;
  }

  const body = {
    model: modelId,
    messages: msgs.map(m => ({ role: m?.role, content: m?.content })),
    stream: Boolean(stream),
    max_tokens: 8192,
  };
  applyFingerprint(body, false); // openai nested tools
  return body;
}

/** Extract the streamed text delta from one SSE frame, per wire. '' when none. */
export function laneDelta(frame) {
  // Refusals can arrive inside a 200 stream as an error frame.
  if (frame?.type === 'error' || frame?.error) {
    const err = frame.error ?? frame;
    const e = new Error(typeof err.message === 'string' ? err.message : 'lane error frame');
    e.status = 502;
    e.body = frame;
    throw e;
  }
  switch (frame?.type) {
    case 'response.output_text.delta':
      return typeof frame.delta === 'string' ? frame.delta : '';
    case 'content_block_delta':
      return typeof frame.delta?.text === 'string' ? frame.delta.text : '';
    default: {
      // chat wire has no `type`; responses/messages frames we don't match fall here
      const chatDelta = frame?.choices?.[0]?.delta?.content;
      return typeof chatDelta === 'string' ? chatDelta : '';
    }
  }
}

/** Normalize a non-streaming lane response into an OpenAI chat.completion shape. */
export function laneCompletion(modelId, body) {
  if (body?.error) {
    const err = body.error;
    const e = new Error(typeof err.message === 'string' ? err.message : 'lane error');
    e.status = err?.type === 'FreeTierError' ? 403 : 502;
    e.body = body;
    throw e;
  }
  let content = '';
  if (wireFor(modelId) === 'responses') {
    if (typeof body?.output_text === 'string') content = body.output_text;
    else if (Array.isArray(body?.output)) {
      for (const item of body.output) {
        if (item?.type !== 'message') continue;
        for (const part of item.content ?? []) {
          if (typeof part?.text === 'string') content += part.text;
        }
      }
    }
  } else if (wireFor(modelId) === 'messages') {
    for (const part of body?.content ?? []) {
      if (typeof part?.text === 'string') content += part.text;
    }
  } else {
    content = body?.choices?.[0]?.message?.content ?? '';
  }
  return {
    id: body?.id ?? `chatcmpl-opencode-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `opencode/${modelId}`,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: body?.usage ?? {},
  };
}
