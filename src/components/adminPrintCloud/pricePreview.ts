/**
 * A PREVIEW OF A VARIANT'S PRICE TIERS, BEFORE THEY ARE SAVED.
 *
 * The same arithmetic as `priceMaterial` in worker/lib/printCloud/pricing.ts
 * (an exact pack quantity costs the pack price; any other quantity takes the
 * highest bracket it reaches, in milli-IQD per unit, rounded half up to the
 * dinar, then UP to the rounding step, and — with the next-pack cap — never
 * above the smallest pack that covers it). It exists so the owner can type a
 * quantity and see what these tiers would charge; it is labelled a preview,
 * and every real price is the server's (quotes are priced there and frozen).
 * tests/printCloudAdminUi.test.ts runs both over the same cases.
 *
 * Pure, no React.
 */

export interface TierInput {
  mode: 'pack' | 'bracket';
  min_qty: number;
  pack_price_iqd?: number | null;
  unit_price_milli_iqd?: number | null;
}

export interface PricePreview {
  price_iqd: number;
  rule: 'pack' | 'bracket';
  /** The tier that priced it: the pack quantity, or the bracket's from-quantity. */
  tier_qty: number;
  /** Set when the next pack was cheaper and capped the bracket price. */
  capped_by_pack_qty: number | null;
}

/** a × b / c rounded half up, exactly (util.ts `mulDivRound`). */
export function mulDivRound(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  return Number((n * 2n + d) / (d * 2n));
}

/** Round UP to a multiple of `step` (util.ts `roundUpTo`). */
export function roundUpTo(amount: number, step: number): number {
  if (!step || step <= 1) return amount;
  return Math.ceil(amount / step) * step;
}

/** What `qty` base units would cost under `tiers`, or null when no tier prices that quantity. */
export function previewMaterialPrice(qty: number, tiers: readonly TierInput[], opts: { rounding: number; capAtNextPack: boolean }): PricePreview | null {
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  const packs = tiers.filter((t) => t.mode === 'pack' && typeof t.pack_price_iqd === 'number').sort((a, b) => a.min_qty - b.min_qty);
  const brackets = tiers.filter((t) => t.mode === 'bracket' && typeof t.unit_price_milli_iqd === 'number').sort((a, b) => a.min_qty - b.min_qty);
  const exact = packs.find((p) => p.min_qty === qty);
  if (exact) return { price_iqd: Number(exact.pack_price_iqd), rule: 'pack', tier_qty: exact.min_qty, capped_by_pack_qty: null };
  const bracket = [...brackets].reverse().find((b) => b.min_qty <= qty);
  if (!bracket) return null;
  const raw = mulDivRound(Number(bracket.unit_price_milli_iqd), qty, 1000);
  const out: PricePreview = { price_iqd: roundUpTo(raw, opts.rounding), rule: 'bracket', tier_qty: bracket.min_qty, capped_by_pack_qty: null };
  if (opts.capAtNextPack) {
    const cover = packs.find((p) => p.min_qty >= qty);
    if (cover && Number(cover.pack_price_iqd) < out.price_iqd) {
      out.price_iqd = Number(cover.pack_price_iqd);
      out.capped_by_pack_qty = cover.min_qty;
    }
  }
  return out;
}
