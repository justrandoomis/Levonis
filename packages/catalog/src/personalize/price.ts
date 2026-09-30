/**
 * THE PRICE OF A CONFIGURATION (docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3
 * «Price and validation», §0 rows 5 and 24; invariants P1 and P15). ONE
 * function, run in the studio for display (zero round trips per tap) and in
 * the Worker as the truth — the price the customer watches is the price
 * charged. A configuration never carries a price (config.ts refuses any
 * price-like key); every figure below is looked up here.
 *
 *   unit = base + Σ fees
 *
 * BASE is the chosen variant's price, else the product's — worker/lib/catalog/
 * lines.ts `resolveCatalogLine`'s rule, which the CALLER applies and passes as
 * `ctx.base_iqd` (the Worker from its line row, the studio through
 * `priceContextFromPublic`). Size, look and quality are the product's own
 * variants, so they live in the base, never in a fee.
 *
 * THE FEES, one add each, keyed stably and in this order (an add's total is
 * `iqd × (qty ?? 1)`; a zero fee adds nothing):
 *   area:<id>      an area's fee — a required area always, an optional one
 *                  when it is filled; never on a piece that is not there
 *   region:<id>    an optional piece switched on (and shown)
 *   colour:<key>   the premium of a colour («gold +1,000»), summed over every
 *                  target that wears it
 *   colours:extra  per_extra_iqd × max(0, customer colours − included), `qty`
 *                  the extra count (the COUNT is defined at `customerColours`)
 *   slot:<id>      'add': the chosen option's live unit × qty; 'included':
 *                  max(0, option unit − the included option's unit) × qty —
 *                  the positive difference only, never negative; the included
 *                  option is the slot's default, else its cheapest priced one.
 *                  A fixed-choice slot is on its default and priced alike.
 *   nfc            extras.nfc.fee_iqd when the customer set a tag target
 * Fixed parts are in the price already (0). A roster entry's own colours are
 * C12's: entries whose unit would differ become lines of their own.
 *
 * THE CONTEXT: `priceContext(base, rows)` from the Worker's rows (the line's
 * resolveCatalogLine unit and worker/lib/personalize/parts.ts `loadStoreParts`
 * rows, whose shape it takes as is) or `priceContextFromPublic(pub, variant)`
 * in the studio — the same keys and figures for the same rows (pinned).
 *
 * INTEGER RULES (§0 row 24, as tests): every looked-up figure is a
 * non-negative safe integer — a negative, fractional, NaN or unsafe one throws
 * `EngineError` PRICE_INVALID at its path, it is never priced around — the unit
 * is ≤ 50,000,000 IQD (PRICE_TOO_HIGH), and `lineTotal` takes a quantity of
 * 1–9,999 (QTY_INVALID). A chosen option — or the included one it is measured
 * against — without a live price is PART_UNPRICED at `slots.<id>`: never free.
 *
 * Pure: no I/O, no DOM, no clock, no randomness.
 */
import type { Area, DesignConfig, Paint, PaletteKey, PriceBreakdown, PublicBlueprint, PublicSlot } from './types';
import type { SpecLike } from './canonical';

export const PRICE_LIMITS = { unit: 50_000_000, qty: 9_999 } as const;

export type EngineErrorCode = 'PRICE_INVALID' | 'PRICE_TOO_HIGH' | 'PART_UNPRICED' | 'QTY_INVALID' | 'VARIANT_UNKNOWN';

/**
 * A figure the engine cannot price with — never a customer's refusal code
 * (the Worker maps it: PART_UNPRICED → the part is unavailable, VARIANT_UNKNOWN
 * → the variant is, the rest are data faults). `path` names the lookup.
 */
export class EngineError extends Error {
  code: EngineErrorCode;
  path: string;
  constructor(code: EngineErrorCode, path = '') {
    super(`${code}${path ? ` at ${path}` : ''}`);
    this.name = 'EngineError';
    this.code = code;
    this.path = path;
  }
}

/** What a part costs now, by `partKey`. */
export interface PartPrice { unit_iqd: number; in_stock: boolean }
export interface PriceContext {
  /** The chosen variant's price, else the product's — resolveCatalogLine's rule, applied by the caller. */
  base_iqd: number;
  /** Every slot option's part (customer AND fixed-choice slots), by `partKey(productId, variantId)`. */
  parts: Readonly<Record<string, PartPrice>>;
}

/** `${productId}|${variantId ?? ''}` — the one spelling of a part's price key. */
export const partKey = (productId: string, variantId: string | null | undefined): string => `${productId}|${variantId ?? ''}`;

/** The context from the rows the Worker holds (the product line's unit and `loadStoreParts` rows) — also what the studio's comes from. */
export function priceContext(
  baseIqd: number,
  parts: Iterable<{ product_id: string; variant_id: string | null; unit_iqd: number; in_stock: boolean }>
): PriceContext {
  const out: Record<string, PartPrice> = {};
  for (const p of parts) out[partKey(p.product_id, p.variant_id)] = { unit_iqd: p.unit_iqd, in_stock: p.in_stock };
  return { base_iqd: baseIqd, parts: out };
}

/**
 * The studio's context: the variant's price from the public variants (the
 * Worker writes each `price_iqd` by resolveCatalogLine's rule) or the
 * product's when it sells none, and every slot option's live unit. A variant
 * the product does not sell — or none on a product that has variants — is
 * VARIANT_UNKNOWN, as the add door refuses it.
 */
export function priceContextFromPublic(pub: PublicBlueprint, variantId: string | null): PriceContext {
  const v = pub.variants.find((x) => x.id === variantId);
  if (variantId === null ? pub.variants.length > 0 : !v) throw new EngineError('VARIANT_UNKNOWN', 'variant');
  return priceContext(v ? v.price_iqd : pub.product.price_iqd, Object.values(pub.slot_options).flat());
}

/** A looked-up figure: a non-negative safe integer, or EngineError. */
function money(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new EngineError('PRICE_INVALID', path);
  return v;
}

/** The option a slot is on: the customer's choice (absent = its default), or a fixed-choice slot's default. */
export function slotChoice(slot: PublicSlot, config: DesignConfig): string | null {
  const own = slot.choice === 'customer' ? config.slots[slot.id] : undefined;
  return own ? own.option : slot.default ?? null;
}

/**
 * Whether a region is part of the piece as configured: an optional piece
 * switched on (absent = its default), and its `shown_by` satisfied — a slot
 * with any option (`slot`), one option (`slot:option`) or an icon
 * (`iconArea:icon`).
 */
export function regionShown(spec: SpecLike, config: DesignConfig, id: string): boolean {
  const r = spec.regions.find((x) => x.id === id);
  if (!r || (r.optional && !(config.parts[id] ?? r.optional.on))) return false;
  if (!r.shown_by) return true;
  const [by, key] = r.shown_by.split(':');
  const slot = spec.slots.find((s) => s.id === by);
  const on = slot ? slotChoice(slot, config) : config.icon[by] ?? null;
  return key === undefined ? on !== null : on === key;
}

/** Whether the customer filled an area. */
export const areaFilled = (a: Area, config: DesignConfig): boolean =>
  a.kind === 'text' ? (config.texts[a.id]?.value.length ?? 0) > 0 : config[a.kind][a.id] != null;

export interface PaintTarget {
  /** A region id, or a text area's id (the text's own colour). */
  id: string;
  paint: Paint;
  key: PaletteKey;
  /** The region it is printed on (itself for a region). */
  region: string;
  /** The customer picks it: its paint offers more than one colour. */
  choice: boolean;
}

/** Every colour printed on the piece as configured: shown regions, then filled text areas on shown regions — spec order. */
export function paintTargets(spec: SpecLike, config: DesignConfig): PaintTarget[] {
  const out: PaintTarget[] = [];
  const push = (id: string, paint: Paint, region: string) =>
    out.push({ id, paint, key: config.colors[id] ?? paint.default, region, choice: !Array.isArray(paint.allowed) || paint.allowed.length > 1 });
  for (const r of spec.regions) if (regionShown(spec, config, r.id)) push(r.id, r.paint, r.id);
  for (const a of spec.areas) if (a.text && areaFilled(a, config) && regionShown(spec, config, a.region)) push(a.id, a.text.paint, a.region);
  return out;
}

/**
 * THE COLOUR COUNT (the fee's and `colors.max`'s): the distinct palette keys
 * over the targets the CUSTOMER colours — a shown region or a filled text
 * area whose paint offers more than one colour ('stocked', 'all', or a list
 * of two or more). A colour the merchant fixed (a one-colour list) is not the
 * customer's and is not counted. First-seen order.
 */
export const customerColours = (spec: SpecLike, config: DesignConfig): PaletteKey[] =>
  [...new Set(paintTargets(spec, config).filter((t) => t.choice).map((t) => t.key))];

/**
 * The unit price of `config` and its adds. Throws EngineError on a figure it
 * cannot price with — PART_UNPRICED when a chosen option (or the included one
 * it is measured against) has no live price in `ctx.parts`.
 */
export function priceConfig(spec: SpecLike, config: DesignConfig, ctx: PriceContext): PriceBreakdown {
  const base = money(ctx.base_iqd, 'base_iqd');
  const adds: PriceBreakdown['adds'] = [];
  let unit = base;
  const add = (key: string, iqd: number, qty = 1): void => {
    if (iqd <= 0 || qty <= 0) return;
    adds.push(qty > 1 ? { key, iqd, qty } : { key, iqd });
    unit += iqd * qty;
  };

  spec.areas.forEach((a, i) => {
    const fee = money(a.fee_iqd, `areas.${i}.fee_iqd`);
    if (regionShown(spec, config, a.region) && (a.required || areaFilled(a, config))) add(`area:${a.id}`, fee);
  });
  spec.regions.forEach((r, i) => {
    if (r.optional && regionShown(spec, config, r.id)) add(`region:${r.id}`, money(r.optional.fee_iqd, `regions.${i}.optional.fee_iqd`));
  });

  const premium = new Map<string, number>();
  for (const t of paintTargets(spec, config)) {
    const p = t.paint.premium?.[t.key];
    if (p !== undefined) premium.set(t.key, (premium.get(t.key) ?? 0) + money(p, `colors.${t.id}`));
  }
  for (const [key, iqd] of premium) add(`colour:${key}`, iqd);
  const { included, per_extra_iqd } = spec.colors;
  add('colours:extra', money(per_extra_iqd, 'colors.per_extra_iqd'), customerColours(spec, config).length - money(included, 'colors.included'));

  const partUnit = (s: PublicSlot, key: string): number => {
    const o = s.options.find((x) => x.key === key);
    const p = o && ctx.parts[partKey(o.part.p, o.part.v)];
    if (!p) throw new EngineError('PART_UNPRICED', `slots.${s.id}`);
    return money(p.unit_iqd, `slots.${s.id}.${key}`);
  };
  for (const s of spec.slots) {
    const qty = s.qty;
    if (!Number.isSafeInteger(qty) || qty < 1) throw new EngineError('QTY_INVALID', `slots.${s.id}.qty`);
    const chosen = slotChoice(s, config);
    if (chosen === null) continue;
    const unitOf = partUnit(s, chosen);
    // 'included': measured against the default, else the cheapest option the store prices.
    const inc = s.pricing === 'add' ? 0
      : s.default !== undefined ? partUnit(s, s.default)
      : Math.min(...s.options.flatMap((o) => (ctx.parts[partKey(o.part.p, o.part.v)] ? [partUnit(s, o.key)] : [])));
    add(`slot:${s.id}`, Math.max(0, unitOf - inc), qty);
  }

  if (spec.extras.nfc && config.nfc) add('nfc', money(spec.extras.nfc.fee_iqd, 'extras.nfc.fee_iqd'));
  if (!(unit <= PRICE_LIMITS.unit)) throw new EngineError('PRICE_TOO_HIGH', 'unit_iqd');
  return { unit_iqd: unit, base_iqd: base, adds };
}

/** unit × qty for a cart line: a unit the engine could price, a quantity of 1–9,999. */
export function lineTotal(unit: number, qty: number): number {
  if (money(unit, 'unit_iqd') > PRICE_LIMITS.unit) throw new EngineError('PRICE_TOO_HIGH', 'unit_iqd');
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > PRICE_LIMITS.qty) throw new EngineError('QTY_INVALID', 'qty');
  return unit * qty;
}
