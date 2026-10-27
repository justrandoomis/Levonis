/**
 * THE PROVIDER ADAPTER — the Creative Studio's only door to Anthropic
 * (docs/CREATIVE_STUDIO.md §4; spec §27, §28; DECISIONS row 270).
 *
 * THE ONLY READER OF A PROVIDER KEY. This module is the one place that reads
 * `env.ANTHROPIC_API_KEY` and the one place that reads the sealed key column
 * (`creative_provider_settings.key_sealed`). The plain key goes from the vault
 * straight into one request header and is never returned, logged, stored or
 * put in an error: callers get results and codes, never the key.
 *
 * RAW `fetch`, THROUGH AN INJECTABLE TRANSPORT. No SDK (it reads
 * `process.env` under nodejs_compat, adds weight, and the test runner has no
 * network — scripts/test-no-network.mjs): every call takes `fetchImpl`, so
 * tests drive the real code against a stub. The rest is the transport rule
 * the FX providers already follow (worker/lib/fx/providers/transport.ts):
 *   - one host, `api.anthropic.com`, checked on every URL built here;
 *   - `redirect: 'manual'` — a 3xx is PROVIDER_ERROR, never followed, so the
 *     key header can never reach a second host;
 *   - an AbortSignal deadline per attempt (test 20 s, models 15 s, edit 45 s,
 *     ideas/compose/review/carousel 110 s — just under the client's 120 s, so
 *     a long answer with adaptive thinking has room and the client still hears
 *     the server's own verdict) and a response body capped at 512 KB;
 *   - every failure is a CODE. A thrown error is mapped from its `name` only;
 *     no provider body, prompt or output reaches a log line.
 *
 * WHAT IS SENT (API version 2026-10-21): `model` (the owner's choice from the
 * live list — no model id is written anywhere in this repository), `max_tokens`
 * (ideas/compose/carousel 16,000, edit/review 8,000 — adaptive thinking spends
 * from it), `system`, `messages`, and `output_config` with the structured-output
 * schema from packages/creativeDoc/src/aiContracts.ts plus `effort` only when
 * the model's listed capabilities support it and the owner chose one. NEVER
 * `temperature`/`top_p`/`top_k` (a 400 on 2026-10-21), `tools`, `tool_choice`,
 * `stream` or an assistant prefill.
 *
 * RETRIES, AND WHY SO FEW. 429 is retried once, only when the provider asks
 * for 5 seconds or less; 503/529 once after a short backoff (the request was
 * not processed). A TIMEOUT IS NEVER RETRIED: the provider may have processed
 * and billed it, and the brief forbids re-sending a costly request blindly
 * when its outcome is unknown (spec §29).
 */
import type { AiTask, Effort } from '../../../packages/creativeDoc/src/api';
import type { Env } from '../types';
import { openProviderKey } from './keyVault';
import { readBodyCapped } from './readBody';
import type { Capabilities } from './settings';

export const PROVIDER_HOST = 'api.anthropic.com';
const API_BASE = `https://${PROVIDER_HOST}`;
export const ANTHROPIC_VERSION = '2026-10-21';
export const RESPONSE_CAP_BYTES = 512 * 1024;

export const TIMEOUTS_MS: Readonly<Record<AiTask | 'models', number>> = Object.freeze({
  test: 20_000,
  models: 15_000,
  edit: 45_000,
  ideas: 110_000,
  compose: 110_000,
  review: 110_000,
  carousel: 110_000,
  chat: 60_000,
});

export const MAX_TOKENS: Readonly<Record<AiTask, number>> = Object.freeze({
  test: 2_000,
  ideas: 16_000,
  compose: 16_000,
  carousel: 16_000,
  edit: 8_000,
  review: 8_000,
  chat: 4_000,
});

/** How long a 429's retry-after may ask for and still get the one retry. */
const MAX_RETRY_AFTER_MS = 5_000;
/** The one backoff before re-sending a 503/529 (the request was not processed). */
const OVERLOAD_BACKOFF_MS = 1_200;

export type ProviderErrorCode =
  | 'KEY_NOT_CONFIGURED'
  | 'KEY_REJECTED'
  | 'MODEL_GONE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_OVERLOADED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_REFUSED'
  | 'OUTPUT_TRUNCATED'
  | 'INVALID_OUTPUT';

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * How the failed call is to be accounted for:
 *   none     the provider did not process it (4xx, 5xx, a redirect) — the reservation is released
 *   usage    it answered 200 and reported usage (a refusal, a truncation, an unreadable answer) — settled with it
 *   unknown  the outcome is ambiguous (a timeout, a dropped connection) — settled at the reserved worst case
 */
export type Billing = 'none' | 'usage' | 'unknown';

export type MessagesResult =
  | { ok: true; json: unknown; usage: ProviderUsage; model: string }
  | { ok: false; code: ProviderErrorCode; usage: ProviderUsage | null; billing: Billing };

export interface Transport {
  fetchImpl?: typeof fetch;
  /** Tests replace the backoff sleep; production waits for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests shorten the deadline; production uses TIMEOUTS_MS. */
  timeoutMs?: number;
}

type KeyEnv = Pick<Env, 'DB' | 'ANTHROPIC_API_KEY' | 'CREATIVE_STUDIO_ENC_KEY'>;
export type KeySource = 'stored' | 'worker_secret' | 'none';

// ---------------------------------------------------------------------------
// The key — read here and nowhere else
// ---------------------------------------------------------------------------

/** A key's shape, loosely: printable ASCII without spaces, a plausible length. Nothing about its content is assumed. */
export function validProviderKeyShape(v: unknown): v is string {
  return typeof v === 'string' && /^[\x21-\x7e]{20,400}$/.test(v);
}

/** The 4-character hint the settings page shows instead of the key. */
export function keyHintOf(key: string): string {
  return key.slice(-4);
}

async function storedSealedKey(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare(`SELECT key_sealed FROM creative_provider_settings WHERE id = 'anthropic'`).first<{ key_sealed: string | null }>();
    return row?.key_sealed ?? null;
  } catch (e) {
    if (/no such table|no such column/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/**
 * The key in force, in the decided order: the owner's stored key when it
 * opens, else the Worker secret. Private to this module — callers ask
 * `keyState` (which says where a key would come from) and the call functions
 * below (which use it), never for the key itself.
 */
async function resolveKey(env: KeyEnv): Promise<{ key: string; source: Exclude<KeySource, 'none'> } | null> {
  const sealed = await storedSealedKey(env.DB);
  if (sealed) {
    const opened = await openProviderKey(env, sealed);
    if (opened && validProviderKeyShape(opened)) return { key: opened, source: 'stored' };
  }
  const secret = env.ANTHROPIC_API_KEY;
  if (validProviderKeyShape(secret)) return { key: secret, source: 'worker_secret' };
  return null;
}

/**
 * Where the key in force comes from, and whether a stored key failed to open
 * (the vault secret was removed or rotated away) — for the settings page. The
 * key itself never leaves this module.
 */
export async function keyState(env: KeyEnv): Promise<{ source: KeySource; stored_unreadable: boolean }> {
  const sealed = await storedSealedKey(env.DB);
  let storedUnreadable = false;
  if (sealed) {
    const opened = await openProviderKey(env, sealed);
    if (opened && validProviderKeyShape(opened)) return { source: 'stored', stored_unreadable: false };
    storedUnreadable = true;
  }
  if (validProviderKeyShape(env.ANTHROPIC_API_KEY)) return { source: 'worker_secret', stored_unreadable: storedUnreadable };
  return { source: 'none', stored_unreadable: storedUnreadable };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

function endpoint(path: string): string {
  const url = new URL(path, API_BASE);
  // The allow-list: one scheme, one host, no port, no credentials in the URL.
  if (url.protocol !== 'https:' || url.hostname !== PROVIDER_HOST || url.port !== '' || url.username || url.password) {
    throw new Error('PROVIDER_HOST_REFUSED');
  }
  return url.toString();
}

function headers(key: string, json: boolean): Record<string, string> {
  return json
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }
    : { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
}

const isTimeout = (e: unknown, signal: AbortSignal) =>
  signal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));

/** A code-only log line: never a body, a header, a prompt or a key. */
function logFailure(op: string, code: string, status: number | null): void {
  console.warn('creative_provider_failure', JSON.stringify({ op, code, status }));
}

function retryAfterMs(h: Headers): number | null {
  const raw = h.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RawAttempt {
  status: number;
  text: string | null;
  headers: Headers;
}

type AttemptOutcome = { kind: 'response'; res: RawAttempt } | { kind: 'failed'; code: 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR'; billing: Billing };

async function attempt(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<AttemptOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal });
  } catch (e) {
    // A timeout or a dropped connection: the request may have reached the provider and been billed.
    return { kind: 'failed', code: isTimeout(e, signal) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', billing: 'unknown' };
  }
  if ((res.type as string) === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'response', res: { status: res.status || 302, text: null, headers: res.headers } };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'response', res: { status: res.status, text: null, headers: res.headers } };
  }
  const body = await readBodyCapped(res, RESPONSE_CAP_BYTES, signal);
  if (!body.ok) {
    // A 200 whose body could not be read whole: it was processed (billed), its usage is unknown.
    return { kind: 'failed', code: body.code === 'TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', billing: 'unknown' };
  }
  return { kind: 'response', res: { status: 200, text: body.text, headers: res.headers } };
}

/** Status → code for everything that is not a 200. */
function codeOfStatus(status: number): ProviderErrorCode {
  if (status >= 300 && status < 400) return 'PROVIDER_ERROR';
  if (status === 401 || status === 403) return 'KEY_REJECTED';
  if (status === 404) return 'MODEL_GONE';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 503 || status === 529) return 'PROVIDER_OVERLOADED';
  return 'PROVIDER_ERROR';
}

/**
 * One request with the retry policy above. Returns the 200's text, or a code.
 */
async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  transport: Transport,
  op: string
): Promise<{ ok: true; text: string } | { ok: false; code: ProviderErrorCode; billing: Billing }> {
  const fetchImpl = transport.fetchImpl ?? fetch;
  const sleep = transport.sleep ?? defaultSleep;
  for (let i = 0; i < 2; i++) {
    const out = await attempt(url, init, timeoutMs, fetchImpl);
    if (out.kind === 'failed') {
      logFailure(op, out.code, null);
      return { ok: false, code: out.code, billing: out.billing };
    }
    const { status, text, headers: h } = out.res;
    if (status === 200 && text !== null) return { ok: true, text };
    const code = codeOfStatus(status);
    if (i === 0 && status === 429) {
      const wait = retryAfterMs(h);
      if (wait !== null && wait <= MAX_RETRY_AFTER_MS) {
        await sleep(wait);
        continue;
      }
    }
    if (i === 0 && (status === 503 || status === 529)) {
      await sleep(OVERLOAD_BACKOFF_MS);
      continue;
    }
    logFailure(op, code, status);
    return { ok: false, code, billing: 'none' };
  }
  // Both attempts answered a retryable status.
  return { ok: false, code: 'PROVIDER_ERROR', billing: 'none' };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } };

export interface MessagesRequest {
  task: AiTask;
  model: string;
  system: string;
  /** User turns only: an assistant prefill is a 400 on current models and is never built. */
  content: ContentBlock[];
  schema: Record<string, unknown>;
  /** The owner's effort; sent only when `capabilities` say the model supports that level. */
  effort: Effort | null;
  capabilities: Capabilities;
}

/** The exact JSON body sent — exported for the tests that prove what is (and is not) in it. */
export function messagesBody(req: MessagesRequest): Record<string, unknown> {
  const effortOk =
    req.effort !== null &&
    req.capabilities.effort === true &&
    (req.capabilities.effort_levels.length === 0 || req.capabilities.effort_levels.includes(req.effort));
  return {
    model: req.model,
    max_tokens: MAX_TOKENS[req.task],
    system: req.system,
    messages: [{ role: 'user', content: req.content }],
    output_config: {
      format: { type: 'json_schema', schema: req.schema },
      ...(effortOk ? { effort: req.effort } : {}),
    },
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

function usageOf(raw: unknown): ProviderUsage {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
  };
}

/** A 200's body → the structured object, or the code that says why not. Exported for tests. */
export function parseMessage(text: string): MessagesResult {
  let body: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'PROVIDER_ERROR', usage: null, billing: 'unknown' };
    body = v as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'PROVIDER_ERROR', usage: null, billing: 'unknown' };
  }
  const usage = usageOf(body.usage);
  const model = typeof body.model === 'string' ? body.model : '';
  if (body.stop_reason === 'refusal') return { ok: false, code: 'PROVIDER_REFUSED', usage, billing: 'usage' };
  if (body.stop_reason === 'max_tokens') return { ok: false, code: 'OUTPUT_TRUNCATED', usage, billing: 'usage' };
  if (body.stop_reason !== 'end_turn') return { ok: false, code: 'INVALID_OUTPUT', usage, billing: 'usage' };
  // The text blocks, joined; thinking blocks (empty or summarised) are not the answer and are ignored.
  const blocks = Array.isArray(body.content) ? body.content : [];
  const joined = blocks
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
  if (!joined.trim()) return { ok: false, code: 'INVALID_OUTPUT', usage, billing: 'usage' };
  try {
    return { ok: true, json: JSON.parse(joined), usage, model };
  } catch {
    return { ok: false, code: 'INVALID_OUTPUT', usage, billing: 'usage' };
  }
}

/**
 * POST /v1/messages with the key in force. Every outcome is a result, never a
 * throw (a URL refused by the allow-list is the one throw, and it is a bug).
 */
export async function createMessage(env: KeyEnv, req: MessagesRequest, transport: Transport = {}): Promise<MessagesResult> {
  const key = await resolveKey(env);
  if (!key) return { ok: false, code: 'KEY_NOT_CONFIGURED', usage: null, billing: 'none' };
  const out = await send(
    endpoint('/v1/messages'),
    { method: 'POST', headers: headers(key.key, true), body: JSON.stringify(messagesBody(req)) },
    transport.timeoutMs ?? TIMEOUTS_MS[req.task],
    transport,
    req.task
  );
  if (!out.ok) return { ok: false, code: out.code, usage: null, billing: out.billing };
  const parsed = parseMessage(out.text);
  if (!parsed.ok) logFailure(req.task, parsed.code, 200);
  return parsed;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ProviderModel {
  id: string;
  display_name: string;
  created_at: string | null;
  structured_outputs: boolean | null;
  vision: boolean | null;
  effort: boolean | null;
  effort_levels: Effort[];
}

/** A capability leaf: `{supported: boolean}` → the boolean; anything else (absent, renamed) → null, never a guess. */
function supported(v: unknown): boolean | null {
  if (!v || typeof v !== 'object') return null;
  const s = (v as { supported?: unknown }).supported;
  return typeof s === 'boolean' ? s : null;
}

/** One model object of the list → our shape, defensively (exported for tests). */
export function modelOf(raw: unknown): ProviderModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id || m.id.length > 120) return null;
  const caps = m.capabilities && typeof m.capabilities === 'object' ? (m.capabilities as Record<string, unknown>) : null;
  const effortCaps = caps?.effort && typeof caps.effort === 'object' ? (caps.effort as Record<string, unknown>) : null;
  const levels = (['low', 'medium', 'high'] as const).filter((l) => supported(effortCaps?.[l]) === true);
  return {
    id: m.id,
    display_name: typeof m.display_name === 'string' && m.display_name ? m.display_name.slice(0, 120) : m.id,
    created_at: typeof m.created_at === 'string' ? m.created_at : null,
    structured_outputs: caps ? supported(caps.structured_outputs) : null,
    vision: caps ? supported(caps.image_input) : null,
    effort: caps ? supported(caps.effort) : null,
    effort_levels: levels,
  };
}

const MAX_MODEL_PAGES = 10;

/** GET /v1/models, every page (`has_more` / `last_id`), at most ten pages. */
export async function listModels(
  env: KeyEnv,
  transport: Transport = {}
): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; code: ProviderErrorCode }> {
  const key = await resolveKey(env);
  if (!key) return { ok: false, code: 'KEY_NOT_CONFIGURED' };
  const models: ProviderModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const path: string = after ? `/v1/models?limit=100&after_id=${encodeURIComponent(after)}` : '/v1/models?limit=100';
    const out = await send(endpoint(path), { method: 'GET', headers: headers(key.key, false) }, transport.timeoutMs ?? TIMEOUTS_MS.models, transport, 'models');
    if (!out.ok) return { ok: false, code: out.code === 'MODEL_GONE' ? 'PROVIDER_ERROR' : out.code };
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(out.text) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' };
    }
    for (const raw of Array.isArray(body.data) ? body.data : []) {
      const m = modelOf(raw);
      if (m && !models.some((x) => x.id === m.id)) models.push(m);
    }
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id) break;
    after = body.last_id;
  }
  return { ok: true, models };
}
