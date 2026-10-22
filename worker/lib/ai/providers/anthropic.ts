/**
 * THE TEXT AND VISION PROVIDER (push B plan §6.6, §7).
 *
 * THE ONLY READER OF `env.ANTHROPIC_API_KEY` (tests/aiSingleReaders.test.ts).
 * The key travels in exactly one place, the `x-api-key` header of a request
 * to the allowlisted host (../transport.ts). It is never logged, stored,
 * returned or measured: the rest of the code asks `anthropicAvailable(env)`,
 * a boolean.
 *
 * THE REQUEST IS PORTABLE AND PINNED (tests/aiAnthropicRequest.test.ts). Only
 * `model`, `max_tokens`, `system`, `messages` and `output_config` are ever
 * sent; `output_config` carries the JSON schema and, only when the owner's
 * chosen model lists low effort, `effort: 'low'`. Never sent: sampling
 * settings, thinking settings, tools, a prefill, metadata, cache control or
 * streaming. The model id is a D1 row (the owner's pick from the live list);
 * no model is named in this repository.
 *
 * THE ANSWER IS A CODE OR A PARSED VALUE. A status, an error TYPE and a stop
 * reason map to `FailCode`s; the provider's error text is never read past its
 * `type` field, and nothing here writes to the console.
 */
import type { Env } from '../../types';
import { providerRequest } from '../transport';
import { bytesToBase64 } from '../jpeg';
import { NO_USAGE, type FailCode, type ListedModel, type ProviderResult, type StructuredRequest, type Transport, type Usage } from '../types';

const API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
/** The one text block a structured answer may carry. */
export const ANSWER_MAX_BYTES = 2048;
/** The shape every stored model id must have (admin PUT checks the same). */
export const MODEL_ID_SHAPE = /^[A-Za-z0-9@/._:-]{1,128}$/;
const LIST_PAGES = 5;

const keyOf = (env: Env): string => (env.ANTHROPIC_API_KEY ?? '').trim();

export function anthropicAvailable(env: Env): boolean {
  return keyOf(env).length > 0;
}

const headersFor = (key: string): Record<string, string> => ({
  'x-api-key': key,
  'anthropic-version': VERSION,
  'content-type': 'application/json',
});

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function usageOf(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    speechMs: 0,
  };
}

function errorTypeOf(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { type?: unknown } };
    return typeof j?.error?.type === 'string' ? j.error.type : '';
  } catch {
    return '';
  }
}

/** A non-200 answer → a code, from the status and the error TYPE only (§7 table). */
export function codeOfStatus(status: number, errorType: string): FailCode {
  if (status === 401 || status === 403) return 'KEY_REJECTED';
  if (status === 402 || errorType === 'billing_error') return 'QUOTA';
  if (status === 529 || errorType === 'overloaded_error') return 'OVERLOADED';
  if (status === 404) return 'MODEL_GONE';
  if (status === 413) return 'TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'HTTP_4XX';
  if (status >= 500 && status < 600) return 'HTTP_5XX';
  if (status >= 200 && status < 300) return 'BAD_OUTPUT';
  return 'NETWORK';
}

/** The exact request body (tests pin its key set). */
export function structuredBody(modelId: string, req: StructuredRequest): Record<string, unknown> {
  const content: unknown[] = (req.jpegs ?? []).map((b) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: bytesToBase64(b) },
  }));
  content.push({ type: 'text', text: req.userText });
  return {
    model: modelId,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content }],
    output_config: {
      format: { type: 'json_schema', schema: req.schema },
      ...(req.effortLow ? { effort: 'low' } : {}),
    },
  };
}

/** A 200 body → the parsed answer, or the code that says why not. */
export function readAnswer(text: string): ProviderResult<unknown> {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'BAD_OUTPUT' };
    msg = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'BAD_OUTPUT' };
  }
  const usage = usageOf(msg.usage);
  if (msg.stop_reason === 'max_tokens') return { ok: false, code: 'TRUNCATED', usage };
  if (msg.stop_reason !== 'end_turn') return { ok: false, code: 'REFUSAL', usage };
  const blocks = Array.isArray(msg.content) ? (msg.content as unknown[]) : null;
  if (!blocks) return { ok: false, code: 'BAD_OUTPUT', usage };
  const texts: string[] = [];
  for (const b of blocks) {
    const type = b && typeof b === 'object' ? (b as { type?: unknown }).type : undefined;
    // A reasoning block may precede the answer on models that always reason; it is
    // never read. Any other kind of block (a tool call, anything new) is refused.
    if (type === 'thinking' || type === 'redacted_thinking') continue;
    if (type !== 'text') return { ok: false, code: 'BAD_OUTPUT', usage };
    const t = (b as { text?: unknown }).text;
    if (typeof t !== 'string') return { ok: false, code: 'BAD_OUTPUT', usage };
    texts.push(t);
  }
  if (texts.length !== 1 || new TextEncoder().encode(texts[0]).byteLength > ANSWER_MAX_BYTES) {
    return { ok: false, code: 'BAD_OUTPUT', usage };
  }
  try {
    return { ok: true, value: JSON.parse(texts[0]!) as unknown, usage: usage ?? { ...NO_USAGE } };
  } catch {
    return { ok: false, code: 'BAD_OUTPUT', usage };
  }
}

export async function anthropicStructured(
  env: Env,
  modelId: string,
  req: StructuredRequest,
  t?: Transport
): Promise<ProviderResult<unknown>> {
  const key = keyOf(env);
  if (!key) return { ok: false, code: 'NOT_CONFIGURED' };
  if (!MODEL_ID_SHAPE.test(modelId)) return { ok: false, code: 'NOT_CONFIGURED' };
  const res = await providerRequest(
    `${API}/v1/messages`,
    { method: 'POST', headers: headersFor(key), body: JSON.stringify(structuredBody(modelId, req)), signal: req.signal },
    t
  );
  if (!res.ok) return { ok: false, code: res.code };
  if (res.status !== 200) return { ok: false, code: codeOfStatus(res.status, errorTypeOf(res.body)) };
  return readAnswer(res.body);
}

interface RawModel {
  id?: unknown;
  display_name?: unknown;
  lifecycle?: unknown;
  capabilities?: unknown;
}

const supported = (v: unknown): boolean => !!v && typeof v === 'object' && (v as { supported?: unknown }).supported === true;

/** One live-list entry → a model the task can use, or null (§7 "Anthropic model list"). */
export function listedFor(task: 'understand' | 'vision', m: RawModel): ListedModel | null {
  if (typeof m.id !== 'string' || !MODEL_ID_SHAPE.test(m.id)) return null;
  if (m.lifecycle !== undefined && m.lifecycle !== null && m.lifecycle !== 'active') return null;
  const caps = m.capabilities;
  if (!caps || typeof caps !== 'object') return null;
  const c = caps as Record<string, unknown>;
  if (!supported(c.structured_outputs)) return null;
  if (task === 'vision' && !supported(c.image_input)) return null;
  const effort = c.effort as Record<string, unknown> | undefined;
  const effortLow = supported(effort) && supported(effort?.low);
  const label = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim().slice(0, 80) : m.id;
  return { id: m.id, label, effortLow };
}

/** The provider's live list for one task, never cached; null when it cannot be read. */
export async function anthropicListModels(
  env: Env,
  task: 'understand' | 'vision',
  signal: AbortSignal,
  t?: Transport
): Promise<ListedModel[] | null> {
  const key = keyOf(env);
  if (!key) return null;
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < LIST_PAGES; page++) {
    const q = new URLSearchParams({ limit: '100' });
    if (after) q.set('after_id', after);
    const res = await providerRequest(`${API}/v1/models?${q.toString()}`, { method: 'GET', headers: headersFor(key), signal }, t);
    if (!res.ok || res.status !== 200) return null;
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      body = JSON.parse(res.body) as typeof body;
    } catch {
      return null;
    }
    if (!Array.isArray(body?.data)) return null;
    for (const raw of body.data as RawModel[]) {
      const m = raw && typeof raw === 'object' ? listedFor(task, raw) : null;
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id) break;
    after = body.last_id;
  }
  return out;
}
