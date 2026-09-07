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
 * to price a row: a FIXED number that replaces the level beneath, or an
 * ADJUSTMENT that follows it (pricing.ts, `pick`). Both resolve to a number at
 * checkout. This module re-expresses a product in the owner's form — lowest
 * resolved regular price as the base, every other regular price as an
 * adjustment — and the resolved price of EVERY sellable option × colour × tier
 * is identical before and after (tests/cheapestBase.test.ts proves it against
 * resolveUnitPrice). It is a change of representation, not of what anyone
 * pays.
 *
 * MEMBER PRICES ARE OFFSETS FROM THE BASE (pricing.ts memberAtRung: every
 * rung's regular surcharge is carried onto PRIME and PRO). So when the base
 * moves by Δ, the product's PRIME and PRO move by the same Δ — that is what
 * keeps every member price where it was once the options are rewritten
 * relative to the new base. Rows that state their own member price or
 * adjustment keep it; cost keeps its mode.
 *
 * WHERE EACH ROW'S ANCHOR IS — the fact the whole rewrite turns on:
 *  - An OPTION anchors on the base. When the base moves by Δ, every option
 *    that inherited or adjusted must move by -Δ to keep its price, and a
 *    fixed option becomes (its price − new base). Exact, always.
 *  - A COLOUR anchors on the OPTION the customer picked (pricing.ts walks
 *    base → option → colour). Options keep their resolved prices through the
 *    rewrite, so on a product WITH options a colour's anchor does not move and
 *    an inheriting or adjusting colour is left exactly as it is. A fixed
 *    colour becomes an increase only when there is ONE number it could be an
 *    increase to and that number is the base itself — then the write-time
 *    validator, which measures a colour against the base, reads the same
 *    figure the resolver charges. Otherwise it stays fixed and says why.
 *  - On a product WITHOUT options a colour anchors on the base, and moves
 *    with it like an option does.
 *
 * WHEN IT HOLDS BACK, AND SAYS SO:
 *  - The base is never RAISED. A base below every option is the owner's
 *    "starting from" number; it is a candidate for the minimum like any row.
 *  - The base is not lowered where the write-time ladder (productModel
 *    priceRules) would then refuse the document: under the product's own
 *    PRIME/PRO price, onto its cost, or under a fixed PRIME/PRO price carried
 *    by a colour that keeps inheriting (the validator measures that colour
 *    against the base). A warning names what to change first.
 *
 * Pure: no DB, no I/O. Used by the TXT export (so the file the owner reads is
 * in this form) and by the TXT apply when the file carries the option or
 * colour rows (so what the file says is what is stored — and never on a file
 * that would leave the stored rows untouched). Idempotent.
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

export interface CheapestBaseOptions {
  /**
   * §11: whether the reader may see cost. When false, no warning names or
   * implies the cost figure — an assistant admin reads these in the export's
   * comments and in the apply preview.
   */
  money?: boolean;
}

export interface CheapestBaseResult<T extends CheapestBaseDoc> {
  doc: T;
  base_before: number;
  base_after: number;
  /** Rows whose REPRESENTATION changed (never their resolved price). */
  changed: string[];
  /** Arabic-first, for the apply preview; colour notes are prefixed `colors.N.regular_price_iqd:` by INPUT index. */
  warnings: string[];
  /** The same colour notes keyed by colour id, for a writer that numbers rows its own way. */
  colorNotes: Array<{ id: string; text: string }>;
}

const iqd = (n: number): string => n.toLocaleString('en-US');

/** The regular price one row resolves to, given the number beneath it. Mirrors pricing.ts `pick`. */
function regularOf(row: { regular_price_iqd: number | null; regular_adjust_iqd?: number | null }, beneath: number): number {
  if (row.regular_price_iqd !== null && row.regular_price_iqd !== undefined) return row.regular_price_iqd;
  const adj = row.regular_adjust_iqd;
  if (adj !== null && adj !== undefined && Number.isFinite(adj)) return Math.max(0, Math.round(beneath + adj));
  return beneath;
}

const isFixed = (row: { regular_price_iqd: number | null }): boolean =>
  row.regular_price_iqd !== null && row.regular_price_iqd !== undefined;

/** Writes a regular price as "this many dinars over the number beneath". */
function asAdjustment<T extends { regular_price_iqd: number | null; regular_adjust_iqd?: number | null }>(row: T, over: number): T {
  return { ...row, regular_price_iqd: null, regular_adjust_iqd: over === 0 ? null : over };
}

const sameShape = (row: { regular_price_iqd: number | null; regular_adjust_iqd?: number | null }, over: number): boolean =>
  !isFixed(row) && (row.regular_adjust_iqd ?? null) === (over === 0 ? null : over);

export function normalizeCheapestBase<T extends CheapestBaseDoc>(
  input: T,
  opts: CheapestBaseOptions = {}
): CheapestBaseResult<T> {
  const money = opts.money !== false;
  const base = input.price_iqd;
  const warnings: string[] = [];
  const colorNotes: Array<{ id: string; text: string }> = [];
  const changed: string[] = [];

  const options = input.options ?? [];
  const colors = input.colors ?? [];
  const activeOptions = options.filter((o) => o.active !== false);
  const hasOptions = activeOptions.length > 0;
  const activeIds = new Set(activeOptions.map((o) => o.id));
  // What every option costs TODAY — the numbers that must survive untouched.
  const optionRegular = new Map(options.map((o) => [o.id, regularOf(o, base)]));

  /** The active options a colour can be bought with (its link set, else all). */
  const optionsFor = (c: ColorV2): string[] => {
    const declared = c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : [];
    return declared.length > 0 ? declared.filter((id) => activeIds.has(id)) : [...activeIds];
  };
  /** What a colour's anchor resolves to, one entry per option it can go with. */
  const anchorsOf = (c: ColorV2): number[] =>
    hasOptions ? optionsFor(c).map((id) => optionRegular.get(id) as number) : [base];

  /**
   * EVERY OPTION SWITCHED OFF. The colours then anchor on the base today and
   * on an option the day one is switched back on — and that is the flow the
   * export exists for («options.1.active=true» is a one-word edit). No single
   * rewrite is right before AND after that edit, so the base is left where it
   * is and the colours untouched; the options themselves are still written
   * relative to the base.
   */
  const frozen = options.length > 0 && !hasOptions;

  // ---- the cheapest sellable regular price -------------------------------
  const candidates: number[] = [base];
  for (const o of activeOptions) candidates.push(optionRegular.get(o.id) as number);
  const colourCandidates: number[] = [];
  for (const c of colors) {
    if (c.active === false) continue;
    const anchors = anchorsOf(c);
    if (anchors.length === 0) continue; // linked only to switched-off options: not sellable
    if (isFixed(c)) colourCandidates.push(c.regular_price_iqd as number);
    else for (const a of anchors) colourCandidates.push(regularOf(c, a));
  }
  if (frozen) {
    if (colourCandidates.some((v) => v < base)) {
      warnings.push(
        `price_iqd: بقي السعر الأساسي ${iqd(base)} مع أن لونًا يُباع بأقل منه، لأن كل خيارات المنتج معطّلة — يُعاد النظر في الأرخص عند تفعيل خيار.`
      );
    }
  } else {
    candidates.push(...colourCandidates);
  }
  let newBase = Math.min(...candidates);

  // ---- never onto a number the ladder refuses ------------------------------
  if (newBase < base) {
    // The product's own member prices move WITH the base (they are offsets),
    // so the only thing that can stop the move is one of them reaching zero…
    const drop = base - newBase;
    let floor = 0;
    let floorName = '';
    for (const [name, v] of [['PRIME للمنتج', input.prime_price_iqd], ['PRO للمنتج', input.pro_price_iqd]] as const) {
      if (v !== null && v - drop <= 0 && base - v + 1 > floor) {
        // base − v is the offset; the base may not go below offset + 1
        floor = base - v + 1;
        floorName = name;
      }
    }
    // …and a fixed member price on a colour that keeps following the base
    // through an option: the validator measures it against base + its own
    // adjustment, so lowering the base under it refuses the document.
    if (hasOptions) {
      for (const c of colors) {
        if (isFixed(c)) continue;
        const member = Math.max(c.pro_price_iqd ?? 0, c.prime_price_iqd ?? 0);
        if (member === 0) continue;
        const need = member - (c.regular_adjust_iqd ?? 0);
        if (need > floor) {
          floor = need;
          floorName = `${(c.prime_price_iqd ?? 0) >= (c.pro_price_iqd ?? 0) ? 'PRIME' : 'PRO'} للون «${c.name_ar || c.name_en}»`;
        }
      }
    }
    if (newBase < floor) {
      warnings.push(
        `price_iqd: أرخص صنف هو ${iqd(newBase)} د.ع، لكن خفض الأساسي إليه يُنزل سعر ${floorName} إلى الصفر أو أقل ` +
          `(فرقه عن الأساسي ${iqd(floor - 1)}) — بقي السعر الأساسي ${iqd(base)}؛ عدّل سعر العضوية أولًا.`
      );
      newBase = base;
    } else if (input.product_cost_iqd !== null && newBase === input.product_cost_iqd) {
      warnings.push(
        money
          ? `price_iqd: أرخص صنف (${iqd(newBase)} د.ع) يساوي كلفة المنتج، ولا يجوز أن يساوي سعر البيع الكلفة — بقي السعر الأساسي ${iqd(base)}.`
          : `price_iqd: تعذّر جعل الأساسي هو الأرخص (${iqd(newBase)} د.ع) بسبب قاعدة تسعير داخلية — بقي السعر الأساسي ${iqd(base)}؛ يراجعها مدير مالي.`
      );
      newBase = base;
    }
  }

  // ---- options: every one becomes "so much over the base" ----------------
  const nextOptions = options.map((o, i) => {
    const over = (optionRegular.get(o.id) as number) - newBase;
    if (sameShape(o, over)) return o;
    changed.push(`options.${i + 1}.regular_price_iqd`);
    return asAdjustment(o, over);
  });

  // ---- colours -----------------------------------------------------------
  const note = (i: number, c: ColorV2, text: string) => {
    warnings.push(`colors.${i + 1}.regular_price_iqd: ${text}`);
    colorNotes.push({ id: c.id, text });
  };
  // What EVERY active option resolves to. A fixed colour converts only when
  // all of them sit at the base: its link set (option_ids) is honoured by the
  // relational cart, but a legacy JSON-column product — which is what a TXT
  // create produces — sells the colour with any option, so the link set is
  // not enough to make one increase right for every line.
  const allActive = activeOptions.map((o) => optionRegular.get(o.id) as number);
  const allActiveAtBase = allActive.every((a) => a === newBase);
  const nextColors = colors.map((c, i) => {
    const name = c.name_ar || c.name_en;
    if (frozen) return c;
    if (!hasOptions) {
      // Anchored on the base, which may just have moved: keep the price.
      const over = regularOf(c, base) - newBase;
      if (sameShape(c, over)) return c;
      changed.push(`colors.${i + 1}.regular_price_iqd`);
      return asAdjustment(c, over);
    }
    // Anchored on the option the customer picks — unchanged by the rewrite.
    if (!isFixed(c)) return c;
    const anchors = anchorsOf(c);
    const fixed = c.regular_price_iqd as number;
    if (anchors.length === 0) {
      note(i, c, `أُبقي سعر اللون «${name}» ثابتًا (${iqd(fixed)}) لأنه لا يتوفر لأي خيار فعّال، فلا شيء يُقاس الفرق عنه.`);
      return c;
    }
    if (allActiveAtBase) {
      changed.push(`colors.${i + 1}.regular_price_iqd`);
      return asAdjustment(c, fixed - newBase);
    }
    if (!allActive.every((a) => a === allActive[0])) {
      note(i, c, `أُبقي سعر اللون «${name}» ثابتًا (${iqd(fixed)}) لأن خيارات المنتج تختلف في السعر، فلا توجد زيادة واحدة تعبّر عنه.`);
      return c;
    }
    note(
      i, c,
      allActive[0] > newBase
        ? `أُبقي سعر اللون «${name}» ثابتًا (${iqd(fixed)}) لأن الخيارات تُسعَّر فوق الأساسي (${iqd(allActive[0])})؛ زيادة اللون تُقاس عند التحقق من السعر الأساسي، فرقم ثابت هنا هو الصادق.`
        : `أُبقي سعر اللون «${name}» ثابتًا (${iqd(fixed)}) لأن الخيارات تُسعَّر تحت الأساسي (${iqd(allActive[0])}) والأساسي بقي أعلى منها بسبب حد سعر العضوية.`
    );
    return c;
  });

  if (newBase !== base) changed.unshift('price_iqd');
  // The member offsets travel with the base (see the header): PRIME and PRO
  // drop by exactly what the base dropped, so an inheriting option's carried
  // member price (base member + its new surcharge) is the number it was.
  const shift = newBase - base;
  const shifted = (v: number | null) => (v === null || shift === 0 ? v : Math.max(0, v + shift));
  const doc: T = {
    ...input,
    price_iqd: newBase,
    prime_price_iqd: shifted(input.prime_price_iqd),
    pro_price_iqd: shifted(input.pro_price_iqd),
    options: nextOptions,
    colors: nextColors,
  };
  if (shift !== 0 && (input.prime_price_iqd !== null || input.pro_price_iqd !== null)) {
    changed.push('member_prices');
  }
  if (changed.length > 0) {
    const rows = changed.filter((k) => k !== 'price_iqd' && k !== 'member_prices').length;
    warnings.push(
      newBase !== base
        ? `الأسعار أُعيد التعبير عنها: السعر الأساسي = أرخص صنف (${iqd(newBase)} بدل ${iqd(base)} د.ع)، و${rows} من الخيارات/الألوان صار زيادة فوقه — ما يدفعه الزبون لم يتغير.`
        : `${rows} من أسعار الخيارات/الألوان الثابتة أُعيد التعبير عنها كزيادة فوق السعر الأساسي — ما يدفعه الزبون لم يتغير.`
    );
  }
  return { doc, base_before: base, base_after: newBase, changed, warnings, colorNotes };
}
