/**
 * EUR/USD AND CNY/USD FROM THE EUROPEAN CENTRAL BANK — the daily reference
 * XML, keyless (FX programme plan §5, §6; owner brief 2026-10-08 §5).
 *
 *   GET https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 *
 * ONE fetch serves both pairs: the file states USD and CNY per 1 EUR, so
 *   E = USD per EUR          (EUR_USD, 4 decimals as the ECB publishes it)
 *   C = ceil10(USD ÷ CNY)    (CNY_USD, rounded UP so cost is never under-stated)
 *
 * NO XML PARSER (Workers have none, and a capped body read by strict regexes
 * cannot expand an entity): exactly one Cube date, exactly one USD row and
 * exactly one CNY row, each `\d+\.\d{1,6}`. A raw USD outside [0.8, 1.6] or a
 * CNY outside [5, 12] is refused. The publication is the Cube date at
 * 00:00:00.000Z. No fallback source: the ECB IS the reference.
 */
import { parseProcurementDecimal } from '@levonis/contracts/procurementCost';
import { crossRateCnyUsd } from '@levonis/pricing/fxChain';
import { providerGet } from './transport';
import type { ProviderOutcome } from './iqwealth';

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const ECB_MAX_BYTES = 65_536;

export interface EcbQuote {
  /** USD per 1 EUR, as published. */
  usdPerEur: string;
  /** CNY per 1 EUR, as published. */
  cnyPerEur: string;
  /** C = ceil10(usdPerEur ÷ cnyPerEur). */
  cnyUsd: string;
  /** The Cube date at midnight UTC, epoch milliseconds. */
  publishedAtMs: number;
}

const TIME = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g;
const rowOf = (currency: 'USD' | 'CNY') =>
  new RegExp(`<Cube\\s+currency=['"]${currency}['"]\\s+rate=['"](\\d+\\.\\d{1,6})['"]\\s*\\/>`, 'g');

const decimal = (v: string): string | null => {
  try {
    return parseProcurementDecimal(v, { maxIntDigits: 4, maxFractionDigits: 6, min: 'positive' });
  } catch {
    return null;
  }
};

const inRange = (v: string, min: number, max: number) => {
  const n = Number(v);
  return n >= min && n <= max;
};

/** The body, read strictly (plan §6). Pure. */
export function parseEcbBody(text: string): ProviderOutcome<EcbQuote> {
  const times = [...text.matchAll(TIME)];
  const usd = [...text.matchAll(rowOf('USD'))];
  const cny = [...text.matchAll(rowOf('CNY'))];
  if (times.length !== 1 || usd.length !== 1 || cny.length !== 1) return { kind: 'invalid', code: 'FX_INVALID_SHAPE' };
  const day = times[0]![1]!;
  const publishedAtMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(publishedAtMs) || new Date(publishedAtMs).toISOString().slice(0, 10) !== day) {
    return { kind: 'invalid', code: 'FX_INVALID_TIME' };
  }
  const usdPerEur = decimal(usd[0]![1]!);
  const cnyPerEur = decimal(cny[0]![1]!);
  if (usdPerEur === null || cnyPerEur === null) return { kind: 'invalid', code: 'FX_INVALID_NUMBER' };
  if (!inRange(usdPerEur, 0.8, 1.6) || !inRange(cnyPerEur, 5, 12)) return { kind: 'invalid', code: 'FX_RATE_OUT_OF_BOUNDS' };
  return { kind: 'quote', quote: { usdPerEur, cnyPerEur, cnyUsd: crossRateCnyUsd(usdPerEur, cnyPerEur), publishedAtMs } };
}

export async function fetchEcb(signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ProviderOutcome<EcbQuote>> {
  const res = await providerGet(
    ECB_URL,
    { Accept: 'application/xml, text/xml', 'User-Agent': 'Levonis-FX/1 (+https://levonis-iq.com)' },
    { signal, fetchImpl, provider: 'ecb', maxBytes: ECB_MAX_BYTES, keyed: false, maxRedirects: 0 }
  );
  if (!res.ok) return { kind: 'error', code: res.code };
  return parseEcbBody(res.text);
}
