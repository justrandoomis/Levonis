/**
 * USD/IQD FROM THE IRAQI PARALLEL MARKET — IQWealth's keyed API (FX programme
 * plan §3, §6; owner brief 2026-10-08 §3).
 *
 *   GET https://iraqsm.com/api/v1/fx   X-API-Key: <IRAQ_PARALLEL_FX_API_KEY>
 *
 * THE KEY HAS ONE READER: THIS FILE (critique F6). `iqwealthRequest`:
 *   1. trims the Worker secret and checks it against /^[\x21-\x7e]{16,256}$/ —
 *      anything else is KEY_MALFORMED and NO request is made (a value with a
 *      CR or LF makes `fetch` throw an error whose message carries the whole
 *      value, and that message must never exist);
 *   2. takes no URL and no budget from its callers: the URL is the constant
 *      below, its protocol and host are asserted, `maxRedirects: 0` is set
 *      here (the default follows three hops and re-sends every header);
 *   3. sends the key in the X-API-Key header only — never in the URL — and
 *      maps every failure to a CODE (transport.ts), never a message.
 * No fallback source: the open file is not used, so a refused key shows up as
 * KEY_REJECTED instead of being papered over (plan §6). The last known good
 * rate covers an outage.
 */
import { parseProcurementDecimal } from '@levonis/contracts/procurementCost';
import { providerGet } from './transport';

export const IQWEALTH_URL = 'https://iraqsm.com/api/v1/fx';
export const IQWEALTH_MAX_BYTES = 32_768;
const KEY_SHAPE = /^[\x21-\x7e]{16,256}$/;

/** What the panel may know about the key: whether it is there and well formed. Never the key. */
export function iqwealthKeyState(env: { IRAQ_PARALLEL_FX_API_KEY?: string }): 'missing' | 'malformed' | 'ok' {
  const raw = env.IRAQ_PARALLEL_FX_API_KEY;
  if (typeof raw !== 'string' || raw.trim() === '') return 'missing';
  return KEY_SHAPE.test(raw.trim()) ? 'ok' : 'malformed';
}

/** One USD/IQD reading, validated for shape (the decision checks bounds, age and order). */
export interface IqwealthQuote {
  /** Parallel-market SELL, canonical decimal text (at most 4 decimals). */
  market: string;
  buy: string | null;
  official: string | null;
  /** The provider's own publication time, normalised to epoch milliseconds. */
  publishedAtMs: number;
}

export type ProviderOutcome<Q> =
  | { kind: 'quote'; quote: Q }
  /** A fetch that did not produce a figure (§5.2 step 2). */
  | { kind: 'error'; code: string }
  /** A figure that failed validation (§5.2 step 3): INVALID with this code. */
  | { kind: 'invalid'; code: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON number → canonical decimal text, or null. A string, an exponent, ±Infinity or ≤ 0 is refused. */
export function rateText(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  try {
    return parseProcurementDecimal(v.toFixed(4), { maxIntDigits: 9, maxFractionDigits: 4, min: 'positive' });
  } catch {
    return null;
  }
}

/** A provider time: a string of at most 40 characters that parses; kept only as milliseconds (F7). */
export function providerTimeMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The body, read strictly (plan §6). Pure. */
export function parseIqwealthBody(text: string): ProviderOutcome<IqwealthQuote> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'error', code: 'PARSE' };
  }
  if (!isObject(parsed)) return { kind: 'error', code: 'PARSE' };
  // The document itself, or the same document under a `data` envelope.
  const data = parsed.unit === undefined && isObject(parsed.data) ? parsed.data : parsed;
  if (data.unit !== 'IQD per 1 USD') return { kind: 'invalid', code: 'FX_UNIT_CHANGED' };
  const parallel = data.parallel;
  if (!isObject(parallel)) return { kind: 'invalid', code: 'FX_INVALID_SHAPE' };
  if (parallel.stale === true) return { kind: 'error', code: 'STALE' };
  const market = rateText(parallel.sell);
  if (market === null) return { kind: 'invalid', code: 'FX_INVALID_NUMBER' };
  const publishedAtMs = providerTimeMs(parallel.publishedAt);
  if (publishedAtMs === null) return { kind: 'invalid', code: 'FX_INVALID_TIME' };
  const official = isObject(data.official) ? rateText(data.official.cbi) : null;
  return { kind: 'quote', quote: { market, buy: rateText(parallel.buy), official, publishedAtMs } };
}

/**
 * THE ONE CALL. No key → KEY_MISSING, a malformed key → KEY_MALFORMED, and in
 * both cases no request at all.
 */
export async function iqwealthRequest(
  env: { IRAQ_PARALLEL_FX_API_KEY?: string },
  signal: AbortSignal,
  fetchImpl?: typeof fetch
): Promise<ProviderOutcome<IqwealthQuote>> {
  const raw = env.IRAQ_PARALLEL_FX_API_KEY;
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'error', code: 'KEY_MISSING' };
  const key = raw.trim();
  if (!KEY_SHAPE.test(key)) return { kind: 'error', code: 'KEY_MALFORMED' };
  const url = new URL(IQWEALTH_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'iraqsm.com' || url.search !== '' || url.username !== '') {
    return { kind: 'error', code: 'NETWORK' };
  }
  const res = await providerGet(
    url.toString(),
    { 'X-API-Key': key, Accept: 'application/json', 'User-Agent': 'Levonis-FX/1 (+https://levonis-iq.com)' },
    { signal, fetchImpl, provider: 'iqwealth', maxBytes: IQWEALTH_MAX_BYTES, keyed: true, maxRedirects: 0 }
  );
  if (!res.ok) return { kind: 'error', code: res.code };
  return parseIqwealthBody(res.text);
}
