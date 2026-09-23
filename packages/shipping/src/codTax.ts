/**
 * Cash-on-delivery tax policy. Pure, integer-only, and shared by checkout tests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RATE IS THE ADMINISTRATOR'S NOW — «اجعلها 3 الف لكل 500 الف وتكون قابله
 * للتغير من قبل الادارة».
 *
 * It used to be two module constants, which meant the courier's own charge
 * could only be changed by a deploy. It is an `admin_settings` row
 * (`codTaxPerBlockIqd` / `codTaxBlockIqd`, worker/lib/settings.ts) that this
 * module receives as an ARGUMENT, so this file stays pure and the tests stay
 * able to pin a rate without touching a database.
 *
 * THE CONSTANTS BELOW ARE THE DEFAULT, NOT THE TRUTH. They are what an
 * unconfigured shop charges and what the argument falls back to; a caller that
 * has the settings in hand must pass them, and a caller that quotes the rate
 * in a SENTENCE must quote the configured one. A sentence that says «6,000»
 * beside a charge of 3,000 is worse than no sentence.
 *
 * WHAT A CHANGED RATE MUST NOT DO IS REACH BACKWARDS. `orders.cod_tax_iqd` is
 * a stored column written at placement, and every read of a past order takes
 * that number. Nothing here is ever used to re-derive what somebody was
 * already charged — an owner lowering the rate today must not rewrite last
 * month's invoices.
 */

/** The block the tax is charged per. */
export const COD_TAX_BLOCK_IQD = 500_000;
/**
 * 3,000 IQD per block, by the owner's decision. It was 6,000 until they
 * halved it; the figure lives here only as the default for a shop that has
 * not set one.
 */
export const COD_TAX_PER_BLOCK_IQD = 3_000;

export interface CodTaxRate {
  /** The block size the charge is counted in. */
  blockIqd: number;
  /** What one whole block costs. */
  perBlockIqd: number;
}

/**
 * A rate AS IT ARRIVES FROM A SETTINGS ROW, where either side may be missing.
 *
 * `admin_settings` returns `null` for a key the owner has never set, and the
 * SPA's own `PublicSettings` types these two as `number | null | undefined`.
 * `normalizeCodTaxRate` has always handled that — `Number(null)` is 0 and
 * `Number(undefined)` is NaN, and both fail its guards and fall back — but the
 * parameter said `Partial<CodTaxRate>`, which does not admit `null`, so the
 * one honest caller could not type-check. This is the type the function has
 * always really accepted.
 */
export interface CodTaxRateInput {
  blockIqd?: number | null;
  perBlockIqd?: number | null;
}

export const DEFAULT_COD_TAX_RATE: CodTaxRate = {
  blockIqd: COD_TAX_BLOCK_IQD,
  perBlockIqd: COD_TAX_PER_BLOCK_IQD,
};

/**
 * A configured rate, made safe to divide by.
 *
 * A zero or negative block is the dangerous one: `Math.floor(x / 0)` is
 * `Infinity`, and an Infinity reaching a total is a number nobody can pay and
 * a page nobody can read. A non-positive or non-finite value on either side
 * falls back to the default rather than propagating; a per-block of exactly 0
 * is LEGAL and means "no tax", which is a thing an owner may genuinely want.
 */
export function normalizeCodTaxRate(rate?: CodTaxRateInput | null): CodTaxRate {
  const block = Number(rate?.blockIqd);
  const per = Number(rate?.perBlockIqd);
  return {
    blockIqd: Number.isFinite(block) && block > 0 ? Math.trunc(block) : COD_TAX_BLOCK_IQD,
    perBlockIqd: Number.isFinite(per) && per >= 0 ? Math.trunc(per) : COD_TAX_PER_BLOCK_IQD,
  };
}

/** The configured charge for every COMPLETE block payable at the door. */
export function calculateCodTaxIqd(
  codPayableBeforeTaxIqd: number,
  rate?: CodTaxRateInput | null
): number {
  const { blockIqd, perBlockIqd } = normalizeCodTaxRate(rate);
  const base = Math.max(0, Math.trunc(codPayableBeforeTaxIqd));
  return Math.floor(base / blockIqd) * perBlockIqd;
}

/** Tax applies only to COD delivered to an address, never store pickup. */
export function codDeliveryTaxIqd(
  input: {
    paymentMethodId: string;
    deliveryMethodId: string;
    payableBeforeTaxIqd: number;
  },
  rate?: CodTaxRateInput | null
): number {
  const payment = input.paymentMethodId.trim().toLowerCase();
  const delivery = input.deliveryMethodId.trim().toLowerCase();
  const isCod = payment === 'cash' || payment === 'cod' || payment === 'cash_on_delivery';
  const isDelivery = delivery === 'standard' || delivery === 'personal';
  return isCod && isDelivery ? calculateCodTaxIqd(input.payableBeforeTaxIqd, rate) : 0;
}
