/**
 * ONE PRICE, THEN SURCHARGES — the owner's rule for how a product's prices
 * are written down:
 *
 *   «سعر المنتج يوضع الأرخص ليكون الخيارات والألوان والتوفر عبارة عن زيادة»
 *
 * The base price is the CHEAPEST thing a customer can buy, and every option
 * and colour is an INCREASE over it. Direct-sale immediacy is an increase too
 * (direct_surcharge_iqd), and so is each pre-order route (the transport
 * commission) — those two already live at product level and are added on top
 * of whatever option the customer picks, so they need nothing here.
 *
 * WHAT THIS CHANGES AND WHAT IT NEVER CHANGES. The stored model has two ways
 * to price a row: a FIXED number that replaces the base, or an ADJUSTMENT
 * that follows it (pricing.ts, `pick`). Both resolve to a number at checkout.
 * This module re-expresses a product in the owner's form — lowest resolved
 * regular price as the base, every other regular price as an adjustment —
 * and the resolved price of EVERY option × colour × tier is identical before
 * and after (tests/cheapestBase.test.ts proves it against resolveUnitPrice).
 * It is a change of representation, not of what anyone pays.
 *
 * Only the REGULAR ladder is touched. PRIME, PRO and cost keep whatever mode
 * they have: a member price is a discount, not a surcharge, and the owner
 * did not ask for it to move.
 *
 * WHEN IT HOLDS BACK, AND SAYS SO:
 *  - The base is never RAISED. A base below every option is the owner's
 *    "starting from" number; raising it silently would change the listing
 *    price. It is a candidate for the minimum like everything else.
 *  - The base is not lowered below the product's own PRIME/PRO price or
 *    onto its cost: the write-time ladder (productModel priceRules) would
 *    refuse the result. A warning names the member price to fix first.
 *  - A colour's fixed price is turned into an adjustment only when there is
 *    ONE number it could be an adjustment to — no options, or options that
 *    all inherit the base. A colour on a product whose options price
 *    differently keeps its fixed price: an adjustment there would be right
 *    for one option and wrong for the rest.
 *
 * Pure: no DB, no I/O. Used by the TXT export (so the file the owner reads is
 * in this form) and by the TXT apply (so what the file says is what is
 * stored). Idempotent: normalizing twice is the same as once.
 */

import type { ColorV2, OptionV2 } from './pricing';

/** The slice of a product document this module reads and rewrites. */
export interface CheapestBaseDoc {
  price_iqd: number;
  pro_price_iqd: number | null;
  prime_price_iqd: number | null;
  product_cost_iqd: number | null;
  options: OptionV2[];
  colors: ColorV2[];
}

export interface CheapestBaseResult<T extends CheapestBaseDoc> {
  doc: T;
  base_before: number;
  base_after: number;
  /** Rows whose REPRESENTATION changed (never their resolved price). */
  changed: string[];
  /** Arabic-first, for the apply preview and the export's comments. */
  warnings: string[];
}

const iqd = (n: number): string => n.toLocaleString('en-US');

/** The regular price one row resolves to, given the number beneath it. Mirrors pricing.ts `pick`. */
function regularOf(row: { regular_price_iqd: number | null; regular_adjust_iqd?: number | null }, beneath: number): number {
  if (row.regular_price_iqd !== null && row.regular_price_iqd !== undefined) return row.regular_price_iqd;
  const adj = row.regular_adjust_iqd;
  if (adj !== null && adj !== undefined && Number.isFinite(adj)) return Math.max(0, Math.round(beneath + adj));
  return beneath;
}

/** Writes a regular price as "this many dinars over the number beneath". */
function asAdjustment<T extends { regular_price_iqd: number | null; regular_adjust_iqd?: number | null }>(row: T, over: number): T {
  return { ...row, regular_price_iqd: null, regular_adjust_iqd: over === 0 ? null : over };
}

export function normalizeCheapestBase<T extends CheapestBaseDoc>(input: T): CheapestBaseResult<T> {
  const base = input.price_iqd;
  const warnings: string[] = [];
  const changed: string[] = [];

  const options = input.options ?? [];
  const colors = input.colors ?? [];
  const activeOptions = options.filter((o) => o.active !== false);
  const activeIds = new Set(activeOptions.map((o) => o.id));
  // What every option costs TODAY — the numbers that must survive untouched.
  const optionRegular = new Map(options.map((o) => [o.id, regularOf(o, base)]));

  /** The active options a colour can be bought with (its link set, else all). */
  const optionsFor = (c: ColorV2): string[] => {
    const declared = c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : [];
    const linked = declared.filter((id) => activeIds.has(id));
    return declared.length > 0 ? linked : [...activeIds];
  };

  // ---- the cheapest sellable regular price -------------------------------
  const candidates: number[] = [base];
  for (const o of activeOptions) candidates.push(optionRegular.get(o.id) as number);
  for (const c of colors) {
    if (c.active === false) continue;
    if (c.regular_price_iqd !== null && c.regular_price_iqd !== undefined) {
      candidates.push(c.regular_price_iqd);
      continue;
    }
    const anchors = activeOptions.length ? optionsFor(c).map((id) => optionRegular.get(id) as number) : [base];
    if (anchors.length === 0) continue; // linked only to switched-off options: not sellable
    for (const a of anchors) candidates.push(regularOf(c, a));
  }
  let newBase = Math.min(...candidates);

  // ---- never onto a number the ladder refuses ------------------------------
  const memberFloor = Math.max(input.pro_price_iqd ?? 0, input.prime_price_iqd ?? 0);
  if (newBase < base && newBase < memberFloor) {
    const which = (input.prime_price_iqd ?? 0) >= (input.pro_price_iqd ?? 0) ? 'PRIME' : 'PRO';
    warnings.push(
      `price_iqd: أرخص صنف هو ${iqd(newBase)} د.ع، لكن سعر ${which} للمنتج (${iqd(memberFloor)}) أعلى منه — ` +
        `بقي السعر الأساسي ${iqd(base)}؛ اخفض سعر ${which} أولًا ليصبح الأساسي هو الأرخص.`
    );
    newBase = base;
  } else if (newBase < base && input.product_cost_iqd !== null && newBase === input.product_cost_iqd) {
    warnings.push(
      `price_iqd: أرخص صنف (${iqd(newBase)} د.ع) يساوي كلفة المنتج، ولا يجوز أن يساوي سعر البيع الكلفة — بقي السعر الأساسي ${iqd(base)}.`
    );
    newBase = base;
  }

  // ---- options: every one becomes "so much over the base" ----------------
  const nextOptions = options.map((o, i) => {
    const resolved = optionRegular.get(o.id) as number;
    const over = resolved - newBase;
    const already =
      (o.regular_price_iqd === null || o.regular_price_iqd === undefined) &&
      ((o.regular_adjust_iqd ?? null) === (over === 0 ? null : over));
    if (already) return o;
    changed.push(`options.${i + 1}.regular_price_iqd`);
    return asAdjustment(o, over);
  });

  // ---- colours: an adjustment only when there is one number to adjust ----
  // The anchor of a colour is the option the customer picked. Only when every
  // option it can be bought with inherits the base — or there are no options
  // — is that anchor a single known number (the base itself).
  const nextColors = colors.map((c, i) => {
    const anchorsResolved = activeOptions.length
      ? optionsFor(c).map((id) => optionRegular.get(id) as number)
      : [base];
    const singleAnchor = anchorsResolved.length > 0 && anchorsResolved.every((a) => a === anchorsResolved[0]);
    const anchorIsBase = singleAnchor && anchorsResolved[0] === base;
    if (c.regular_price_iqd !== null && c.regular_price_iqd !== undefined) {
      if (!anchorIsBase) {
        if (!singleAnchor) {
          warnings.push(
            `colors.${i + 1}.regular_price_iqd: أُبقي سعر اللون «${c.name_ar || c.name_en}» ثابتًا (${iqd(c.regular_price_iqd)}) ` +
              'لأن الخيارات التي يتوفر لها تختلف في السعر، فلا توجد زيادة واحدة تعبّر عنه.'
          );
        }
        return c;
      }
      changed.push(`colors.${i + 1}.regular_price_iqd`);
      return asAdjustment(c, c.regular_price_iqd - newBase);
    }
    // Inheriting or adjusting FROM THE BASE: keep the same resolved number
    // when the base moved beneath it.
    if (anchorIsBase && newBase !== base) {
      const resolved = regularOf(c, base);
      changed.push(`colors.${i + 1}.regular_adjust_iqd`);
      return asAdjustment(c, resolved - newBase);
    }
    return c;
  });

  if (newBase !== base) changed.unshift('price_iqd');
  const doc: T = { ...input, price_iqd: newBase, options: nextOptions, colors: nextColors };
  if (changed.length > 0) {
    const rows = changed.filter((k) => k !== 'price_iqd').length;
    warnings.push(
      newBase !== base
        ? `الأسعار أُعيد التعبير عنها: السعر الأساسي = أرخص صنف (${iqd(newBase)} بدل ${iqd(base)} د.ع)، و${rows} من الخيارات/الألوان صار زيادة فوقه — ما يدفعه الزبون لم يتغير.`
        : `${rows} من أسعار الخيارات/الألوان الثابتة أُعيد التعبير عنها كزيادة فوق السعر الأساسي — ما يدفعه الزبون لم يتغير.`
    );
  }
  return { doc, base_before: base, base_after: newBase, changed, warnings };
}
