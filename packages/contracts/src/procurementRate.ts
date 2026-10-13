/**
 * THE PURCHASE DOCUMENT'S EXCHANGE RATE AGAINST THE APPROVED CENTRAL RATE
 * (Pricing V2 stage V2-0, finding F4; docs/DECISIONS.md row 224).
 *
 * A purchase in USD, EUR or CNY carries ONE rate: dinars per one unit of the
 * document's currency (`purchase_orders.exchange_rate`, the rate actually
 * paid). The approved central rate it is checked against is the one the
 * pricing engine prices at (`pricing_fx_rates.rate_iqd`): USD = U, EUR = E × U,
 * CNY = C × U. A typed rate more than 6% away from it — either side — is
 * accepted only with the owner's explicit confirmation: the same 6% as the
 * anchor guard of the central rates themselves (row 189 (5)). Exactly 6% is
 * not "more than".
 *
 * Pure data and one comparison, no imports: the Worker decides (it refuses a
 * save without the confirmation), the procurement screen only asks for the
 * tick before the server has to refuse.
 */

/** The currencies a purchase document converts from (IQD needs no rate). */
export const PROCUREMENT_RATE_CURRENCIES = ['USD', 'EUR', 'CNY'] as const;
export type ProcurementRateCurrency = (typeof PROCUREMENT_RATE_CURRENCIES)[number];

/** More than this percentage away from the approved central rate needs the owner's confirmation. */
export const PROCUREMENT_RATE_DRIFT_PCT = 6;

export function isProcurementRateCurrency(value: unknown): value is ProcurementRateCurrency {
  return typeof value === 'string' && (PROCUREMENT_RATE_CURRENCIES as readonly string[]).includes(value);
}

/**
 * True when `typed` (IQD per unit) is more than 6% away from `central` (IQD
 * per unit), or when either is not a usable positive number — an unreadable
 * rate is never "close enough".
 */
export function procurementRateFar(typed: number, central: number): boolean {
  if (!Number.isFinite(typed) || typed <= 0 || !Number.isFinite(central) || central <= 0) return true;
  return Math.abs(typed - central) * 100 > central * PROCUREMENT_RATE_DRIFT_PCT;
}

/**
 * The approved central rates the procurement screen prefills from, as
 * `GET /api/admin/procurement/config` answers them (owner-only, like every
 * purchase route). `rate_iqd` is the document-shaped rate (IQD per unit);
 * `usd_iqd_rate` and `cross_rate` show the chain it is built from (U, and E
 * or C). Every name is one the cost net knows (FINANCIAL_FIELDS).
 */
export interface ApprovedProcurementRate {
  currency: ProcurementRateCurrency;
  rate_iqd: string;
  usd_iqd_rate: string | null;
  cross_rate: string | null;
}
