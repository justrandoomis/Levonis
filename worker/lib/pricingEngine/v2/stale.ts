/**
 * PRICING V2 — WHEN A V2 PRICE IS STALE (spec §3.1, §3.4 autoReprice; FX-5's
 * rule applied to the V2 results). A stored V2 result names the rates it was
 * computed at; one that moved since makes the product stale, and the automatic
 * repricing (autoReprice.ts) works through it exactly as it does V1's list:
 *   - 'USD'  — U moved: EVERY V2 row, both methods (a price-first product's
 *              dollars are re-read at the new U; a cost-first one's minimum
 *              profit T × U moves);
 *   - the supplier currency — its IQD rate moved: cost-first rows only;
 *   - the shipping profile — its central rate moved: cost-first rows only (the
 *              stock route and each pre-order route's own profile).
 * A price-first product's optional cost never makes it stale: its price does
 * not depend on it.
 *   - 'STOCK' — the shelf moved (DECISIONS row 244, shelf.ts): a cost-first
 *              product's shelf signature is not the one its prices were
 *              written at — a costlier batch arrived, the costliest sold out,
 *              a shelf emptied or refilled.
 *
 * Codes only, never a rate (the reasons ride in pricing_audit summaries and
 * audit_log details).
 */
import { compareProcurementExact, procurementExact } from '@levonis/contracts/procurementCost';
import { isMissingV2Schema } from '../../productOverlay';
import type { PricingRates } from '../rates';
import { V2_RESULT_COLUMNS, type StoredV2Result } from './store';

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  try {
    return compareProcurementExact(procurementExact(a), procurementExact(b)) === 0;
  } catch {
    return a === b;
  }
};

/**
 * What moved since the stored V2 results were computed (sorted codes; empty = current). `shelf`: the
 * product's stored shelf signature and today's (row 244), read only for a cost-first product.
 */
export function staleReasonsV2(rows: readonly StoredV2Result[], rates: PricingRates, shelf?: { stored: string | null; current: string | null }): string[] {
  const out = new Set<string>();
  if (shelf && rows.length && rows.every((r) => r.method === 'cost') && (shelf.stored ?? null) !== (shelf.current ?? null)) out.add('STOCK');
  for (const r of rows) {
    if (!same(r.usd_iqd_rate, rates.usd_iqd)) out.add('USD');
    if (r.method !== 'cost') continue;
    if (r.supplier_currency && r.fx_rate !== null) {
      const fx = rates.central.fx[r.supplier_currency as 'USD' | 'EUR' | 'CNY']?.rate ?? null;
      if (!same(r.fx_rate, fx)) out.add(r.supplier_currency);
    }
    if (r.shipping_profile && r.shipping_rate !== null) {
      const ship = rates.central.shipping[r.shipping_profile as 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA']?.rate ?? null;
      if (!same(r.shipping_rate, ship)) out.add(r.shipping_profile);
    }
  }
  return [...out].sort();
}

/**
 * The stored V2 results of the products named (one statement), only while
 * their state is still V2. Empty on a database without 0189.
 */
export async function loadStoredV2Results(db: D1Database, ids: readonly string[]): Promise<StoredV2Result[]> {
  if (!ids.length) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT ${V2_RESULT_COLUMNS.map((c) => `r.${c}`).join(', ')}
           FROM pricing_v2_sku_results r
           JOIN product_pricing_state s ON s.product_id = r.product_id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
          WHERE r.product_id IN (SELECT value FROM json_each(?)) ORDER BY r.product_id, r.combo_key, r.channel`
      )
      .bind(JSON.stringify([...new Set(ids)]))
      .all<StoredV2Result>();
    return (results ?? []).map((r) => ({ ...r, combo_key: String(r.combo_key ?? '') }));
  } catch (e) {
    if (isMissingV2Schema(e)) return [];
    throw e;
  }
}
