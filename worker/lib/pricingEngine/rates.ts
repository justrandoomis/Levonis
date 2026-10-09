/**
 * THE VERSIONED RATE READER OF EVERY ENGINE WRITE (USD design §2.6; critique
 * M5, fit #22). Read only.
 *
 * ONE `db.batch` of two reads — a D1 batch is one transaction, so both see
 * one snapshot:
 *   1. the effective IQD rates E1 multiplies by (`pricing_fx_rates`: USD = U,
 *      EUR = E × U, CNY = C × U) joined to the pair each one is built from
 *      (`fx_rate_pairs`: the effective rate, its version, a held candidate);
 *   2. the central shipping rates (`pricing_shipping_rates`).
 *
 * It answers E1's `CentralRates` with REAL versions (`pricing_fx_rates.version`,
 * the staleness key of `pricing_sku_costs.fx_version`), U, E and C as text,
 * the pair versions, the shipping versions and, per pair, whether a candidate
 * waits for the owner (REVIEW_REQUIRED — owner decision 11: the effective rate
 * does not move while it is held, so owner saves keep pricing at it).
 *
 * THE ASSERTION. `composeIqdRates(U, E, C)` must equal every non-null
 * `rate_iqd` exactly. The FX commit writes the derived rows in the batch that
 * moves a pair (and skips only an unchanged value), so on a sound database it
 * always holds; a mismatch sets `derived_stale`, every write refuses with
 * FX_DERIVED_STALE, and previews show a banner.
 *
 * Writes never use the procurement-screen fallback of `load.ts`: a rate that
 * is not central is missing here. P1's previews keep their own reader.
 * Null on a database without migration 0179.
 */
import type { CentralRate, CentralRates, SupplierCurrency } from '@levonis/pricing/costToPrice';
import { composeIqdRates, sameRate } from '@levonis/pricing/fxChain';
import { SHIPPING_PROFILES, type ShippingProfile } from '@levonis/pricing/skuChannel';
import { isMissingTable, type FxPairId } from '../fx/pairs';

export interface PricingRates {
  /** E1's input: the central rates with their real versions; a rate is confirmed exactly when present. */
  central: CentralRates;
  /** U = USD_IQD effective rate (IQD per 1 USD), E = EUR_USD, C = CNY_USD — exact text or null. */
  usd_iqd: string | null;
  eur_usd: string | null;
  cny_usd: string | null;
  /** fx_rate_pairs.effective_version per pair. */
  pair_versions: Record<FxPairId, number>;
  /** pricing_fx_rates.version per currency (the `pricing_sku_costs.fx_version` key). */
  fx_versions: Record<SupplierCurrency, number>;
  /** pricing_shipping_rates.version per profile. */
  shipping_versions: Record<ShippingProfile, number>;
  /** A candidate waits for the owner's approval (REVIEW_REQUIRED); the effective rate stays. */
  review_pending: Record<FxPairId, boolean>;
  /** The derived IQD rates disagree with the pairs: every write refuses (FX_DERIVED_STALE). */
  derived_stale: boolean;
}

interface FxJoinRow {
  currency: string;
  rate_iqd: string | null;
  version: number;
  pair: string;
  effective_rate: string | null;
  effective_version: number;
  status: string | null;
  pending_effective_rate: string | null;
}

const PAIR_OF: Readonly<Record<SupplierCurrency, FxPairId>> = { USD: 'USD_IQD', EUR: 'EUR_USD', CNY: 'CNY_USD' };

const FX_SQL = `SELECT r.currency, r.rate_iqd, r.version, p.pair, p.effective_rate, p.effective_version, p.status, p.pending_effective_rate
  FROM pricing_fx_rates r
  JOIN fx_rate_pairs p ON p.pair = CASE r.currency WHEN 'USD' THEN 'USD_IQD' WHEN 'EUR' THEN 'EUR_USD' ELSE 'CNY_USD' END`;
const SHIP_SQL = 'SELECT profile, rate_iqd, version FROM pricing_shipping_rates';

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The rates every engine write and the procurement preview price at (see the file header). */
export async function loadPricingRates(db: D1Database): Promise<PricingRates | null> {
  let fxRows: FxJoinRow[];
  let shipRows: Array<{ profile: string; rate_iqd: string | null; version: number }>;
  try {
    const [fx, ship] = await db.batch([db.prepare(FX_SQL), db.prepare(SHIP_SQL)]);
    fxRows = ((fx as D1Result<FxJoinRow>).results ?? []) as FxJoinRow[];
    shipRows = ((ship as D1Result<{ profile: string; rate_iqd: string | null; version: number }>).results ?? []) as typeof shipRows;
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
  const byCurrency = new Map(fxRows.map((r) => [r.currency, r]));
  const pairRow = (c: SupplierCurrency) => byCurrency.get(c);
  const effective = (c: SupplierCurrency) => text(pairRow(c)?.effective_rate);
  const usd = effective('USD');
  const eur = effective('EUR');
  const cny = effective('CNY');

  const fx: Partial<Record<SupplierCurrency, CentralRate>> = {};
  const fxVersions = { USD: 0, EUR: 0, CNY: 0 } as Record<SupplierCurrency, number>;
  const pairVersions = { USD_IQD: 0, EUR_USD: 0, CNY_USD: 0 } as Record<FxPairId, number>;
  const review = { USD_IQD: false, EUR_USD: false, CNY_USD: false } as Record<FxPairId, boolean>;
  for (const c of ['USD', 'EUR', 'CNY'] as const) {
    const r = pairRow(c);
    const rate = text(r?.rate_iqd);
    const version = Number(r?.version ?? 0);
    fx[c] = { rate, version, confirmed: rate !== null };
    fxVersions[c] = version;
    pairVersions[PAIR_OF[c]] = Number(r?.effective_version ?? 0);
    review[PAIR_OF[c]] = r?.status === 'REVIEW_REQUIRED' || text(r?.pending_effective_rate) !== null;
  }

  // The assertion: the derived IQD rates are exactly U, E × U and C × U.
  let stale = false;
  try {
    const composed = composeIqdRates(usd, eur, cny);
    for (const c of ['USD', 'EUR', 'CNY'] as const) {
      const stored = fx[c]!.rate;
      if (stored === null) continue;
      const expected = composed[c];
      if (expected === null || !sameRate(stored, expected)) stale = true;
    }
  } catch {
    stale = true;
  }

  const shipping: Partial<Record<ShippingProfile, CentralRate>> = {};
  const shipVersions = { GERMANY_LAND: 0, CHINA_AIR: 0, CHINA_SEA: 0 } as Record<ShippingProfile, number>;
  for (const p of SHIPPING_PROFILES) {
    const r = shipRows.find((s) => s.profile === p);
    const rate = text(r?.rate_iqd);
    shipping[p] = { rate, version: Number(r?.version ?? 0), confirmed: rate !== null };
    shipVersions[p] = Number(r?.version ?? 0);
  }

  return {
    central: { fx, shipping },
    usd_iqd: usd,
    eur_usd: eur,
    cny_usd: cny,
    pair_versions: pairVersions,
    fx_versions: fxVersions,
    shipping_versions: shipVersions,
    review_pending: review,
    derived_stale: stale,
  };
}
