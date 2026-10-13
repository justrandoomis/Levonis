/**
 * THE PURCHASE DOCUMENT'S RATE, DECIDED BY THE SERVER (Pricing V2 stage V2-0,
 * finding F4; docs/DECISIONS.md row 224).
 *
 * Before this, a new purchase document and every currency switch started at
 * `exchange_rate: 1`, and the server accepted any rate ≥ 0.000001: a USD
 * purchase saved with the prefilled 1 booked one dinar per dollar into an
 * immutable lot. Now:
 *
 *   1. THE SOURCE. The approved central rates are the ones every engine write
 *      prices at — `loadPricingRates` (worker/lib/pricingEngine/rates.ts),
 *      `pricing_fx_rates.rate_iqd`: USD = U, EUR = E × U, CNY = C × U, each in
 *      dinars per one unit, the shape of the document's own rate. Never the
 *      purchase profiles' saved rate, which is no rate source here.
 *   2. NO APPROVED RATE, NO SAVE. A USD, EUR or CNY document is refused with
 *      PURCHASE_RATE_NOT_APPROVED while its currency has no approved central
 *      rate (and on a database without migration 0179): the screen leaves the
 *      field empty rather than default to 1.
 *   3. THE 6% GUARD. A rate more than 6% away from the approved one is refused
 *      with PURCHASE_RATE_CONFIRM_REQUIRED unless the body says
 *      `confirm_rate: true` (the owner's tick «هذا هو السعر المدفوع فعلًا») —
 *      the anchor guard of row 189 (5) applied to the document.
 *
 * The refusals carry the code only: no rate, no figure (the screen already
 * holds the approved rates from `/config`, an owner-only answer).
 */
import { HttpError } from '../http';
import { serverMessage } from '../../../packages/contracts/src/costRefusals';
import {
  PROCUREMENT_RATE_CURRENCIES,
  isProcurementRateCurrency,
  procurementRateFar,
  type ApprovedProcurementRate,
} from '../../../packages/contracts/src/procurementRate';
import { loadPricingRates } from './rates';

/**
 * The approved central rate of each supplier currency, as the engine reads
 * it; a currency without one is absent. Empty on a database without 0179.
 */
export async function approvedProcurementRates(db: D1Database): Promise<ApprovedProcurementRate[]> {
  const rates = await loadPricingRates(db);
  if (!rates) return [];
  const out: ApprovedProcurementRate[] = [];
  for (const currency of PROCUREMENT_RATE_CURRENCIES) {
    const rate = rates.central.fx[currency]?.rate ?? null;
    if (rate === null || !(Number(rate) > 0)) continue;
    out.push({
      currency,
      rate_iqd: rate,
      usd_iqd_rate: rates.usd_iqd,
      cross_rate: currency === 'EUR' ? rates.eur_usd : currency === 'CNY' ? rates.cny_usd : null,
    });
  }
  return out;
}

/**
 * Refuse a document rate the owner has not confirmed (see the file header).
 * `currency` and `rate` are the parsed draft's; IQD needs no rate.
 */
export async function requireApprovedDocumentRate(
  db: D1Database,
  currency: string,
  rate: number,
  confirmed: boolean,
): Promise<void> {
  if (currency === 'IQD') return;
  const approved = isProcurementRateCurrency(currency)
    ? (await approvedProcurementRates(db)).find((r) => r.currency === currency)
    : undefined;
  if (!approved) throw new HttpError(409, serverMessage('PURCHASE_RATE_NOT_APPROVED'), 'PURCHASE_RATE_NOT_APPROVED');
  if (!confirmed && procurementRateFar(rate, Number(approved.rate_iqd)))
    throw new HttpError(409, serverMessage('PURCHASE_RATE_CONFIRM_REQUIRED'), 'PURCHASE_RATE_CONFIRM_REQUIRED');
}
