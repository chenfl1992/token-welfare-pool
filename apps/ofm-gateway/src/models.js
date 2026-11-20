/**
 * The virtual model catalog the gateway advertises.
 *
 * `GET /v1/models` returns the same five entries every time the dashboard
 * fetches it: a stable `auto` plus the four widely-recognised strategy
 * variants. The actual provider/model list lives behind `/health` so operators
 * can see what `auto` is actually picking.
 *
 * Each entry intentionally shadows how an OpenAI-compatible client (WorkBuddy,
 * Claude Code, Codex CLI, …) decides what to call: a single stable id per
 * intent, with `created`/`owned_by` set so older clients do not error out.
 *
 * @module src/models.js
 */

const CREATED = 1700000000; // arbitrary but stable across the gateway's lifetime

export function listAutoModels() {
  return [
    {
      id: 'auto',
      object: 'model',
      created: CREATED,
      owned_by: 'workbuddy-freemodel',
      description: 'Bandit-balanced auto-routing across all configured providers. Falls back to the next-best on any 429/5xx/timeout.',
    },
    {
      id: 'auto:fast',
      object: 'model',
      created: CREATED,
      owned_by: 'workbuddy-freemodel',
      description: 'Speed-led routing. Same fallback policy, but favors throughput over depth.',
    },
    {
      id: 'auto:smart',
      object: 'model',
      created: CREATED,
      owned_by: 'workbuddy-freemodel',
      description: 'Intelligence-led routing. Heavier model, slower but stronger; same fallback safety net.',
    },
    {
      id: 'auto:reliable',
      object: 'model',
      created: CREATED,
      owned_by: 'workbuddy-freemodel',
      description: 'Reliability-led routing. Picks proven winners first; useful when uptime matters more than cleverness.',
    },
    {
      id: 'auto:codex',
      object: 'model',
      created: CREATED,
      owned_by: 'workbuddy-freemodel',
      description: 'Coding-flavored routing — slightly intelligence-biased but not extreme. Good default for IDE/CI workloads.',
    },
  ];
}

export function isAutoModel(name) {
  if (typeof name !== 'string') return false;
  if (name === 'auto') return true;
  if (name.startsWith('auto:')) return true;
  return false;
}
