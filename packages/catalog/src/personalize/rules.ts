/**
 * THE MERCHANT'S RULES AND THE BUILD VOLUME (docs/LEVO_PROJECT_PROGRAMME.md
 * §B.1 hop 3, P15; the merchant track's Role C rules; the brief's «smart
 * constraints»: prevent, auto-adjust when safe, explain simply, suggest).
 *
 * A rule is `if` → `then` (types.ts): when a text is longer than n graphemes
 * (its longest entry, roster names included), a slot is on an option, a QR is
 * filled, or the chosen variant carries an axis value — then the size is at
 * least a value (sizeOrder ranks), a slot is (or is not) on an option, a
 * colour target stays inside a list, or the customer's colours are at most n.
 *
 * `evaluateRules` answers every rule whose `if` holds, satisfied or not. An
 * unsatisfied one carries the ONE configuration that satisfies it, when there
 * is one, with its price delta — `auto` only when the merchant said auto AND
 * the delta is 0 (P15); any priced fix is a one-tap suggestion:
 *   size_at_least  the smallest size from that value up that fits the
 *                  printer and is sold in stock with the same look and tier
 *   requires       the slot on that option, when it is in stock
 *   excludes       an optional slot emptied; a required one on its default,
 *                  else on its first other option in stock
 *   only_colors    the target on the nearest colour it may wear
 *                  (`nearestColour`, CIEDE2000)
 *   max_colors     the nearest colours merged (`mergeColours`)
 *
 * WHAT A COLOUR TARGET MAY WEAR (`colourChoices`): its paint's list ('stocked'
 * and 'all' = every key) — for a 'stocked' paint only the SHELF: the keys the
 * chosen look's stock map (color.ts `lookStock`: the look's, else `default`)
 * marks `in`, plus every key a `sub:` points at; a list or 'all' may also be
 * made to order — inside every only_colors rule in force for it. No map = the
 * shop tracks nothing and nothing is refused.
 *
 * Sizes above the printer are never offered (`sizeValuesInBuild`, any
 * orientation). `evaluateRules` (and check.ts `checkConfig`) complete a
 * context from a PublicBlueprint by themselves; the lower helpers here
 * (`stockedKeys`, `colourChoices`, `mergeColours`, `withSize`, `axisValue`)
 * take one `withPublic` already completed.
 *
 * Pure: no I/O, no DOM, no clock, no randomness.
 */
import type { DesignConfig, PaletteKey, PublicBlueprint, PublicVariant, RuleIf, RuleThen, SayCode, Vec3 } from './types';
import type { SpecLike } from './canonical';
import { PAINT_KEYS } from './vocab';
import { graphemeCount } from './config';
import { sizeOrder } from './spec';
import { PALETTE_RGB, deltaE2000, lookStock, rgbToLab } from './color';
import { EngineError, customerColours, paintTargets, partKey, priceConfig, slotChoice, type PriceContext } from './price';

export interface RulesContext {
  /** The price of the configuration being judged — a fix's delta is measured from it. */
  price: PriceContext;
  /** The product's variants (`price_iqd` by resolveCatalogLine's rule); a PublicBlueprint brings its own. */
  variants?: ReadonlyArray<PublicVariant>;
  /** The largest build volume; null = unknown (nothing is refused for size). A PublicBlueprint brings its own. */
  printer?: { max_mm: Vec3 } | null;
  /** The shop's shelf per look; a PublicBlueprint brings its own. */
  stock?: PublicBlueprint['stock'];
  stock_rgb?: PublicBlueprint['stock_rgb'];
}

export interface RuleFix { kind: 'auto' | 'suggest'; config: DesignConfig; delta_iqd: number }
export interface RuleOutcome { rule: string; satisfied: boolean; say: SayCode; fix?: RuleFix }

/** The context with a PublicBlueprint's own variants, printer and shelf wherever the caller left them out. */
export function withPublic<C extends RulesContext>(spec: SpecLike, ctx: C): C {
  if (!('product' in spec)) return ctx;
  return {
    ...ctx,
    variants: ctx.variants ?? spec.variants,
    printer: ctx.printer !== undefined ? ctx.printer : spec.printer,
    stock: ctx.stock !== undefined ? ctx.stock : spec.stock,
    stock_rgb: ctx.stock_rgb ?? spec.stock_rgb,
  };
}

// ------------------------------------------------------------ the printer

/** Whether a box fits a build volume in any of its six axis-aligned orientations (sorted sides, side by side). */
export function fitsInBuild(dims_mm: readonly number[], max_mm: readonly number[]): boolean {
  const a = [...dims_mm].sort((x, y) => x - y);
  const b = [...max_mm].sort((x, y) => x - y);
  return a.length === 3 && b.length === 3 && a.every((x, i) => x >= 0 && x <= b[i]);
}

/** The size values the shop can print, smallest first; all of them when the printer is unknown. */
export function sizeValuesInBuild(spec: Pick<SpecLike, 'axes'>, printer: { max_mm: Vec3 } | null | undefined): string[] {
  const values = spec.axes.size?.values ?? {};
  return sizeOrder(spec).filter((id) => !printer || fitsInBuild(values[id].dims_mm, printer.max_mm));
}

// ----------------------------------------------------------- the variant

const variantOf = (cx: RulesContext, c: DesignConfig): PublicVariant | undefined => cx.variants?.find((v) => v.id === c.variant);

/** The chosen variant's value of an axis (a value id), if the product has that axis. */
export function axisValue(spec: SpecLike, cx: RulesContext, c: DesignConfig, axis: 'size' | 'look' | 'tier'): string | undefined {
  const a = spec.axes[axis];
  return a && variantOf(cx, c)?.values[a.group];
}

/** `c` on the in-stock variant that keeps every other axis value and has size `value`, or null. */
export function withSize(spec: SpecLike, c: DesignConfig, cx: RulesContext, value: string): DesignConfig | null {
  const size = spec.axes.size;
  const now = variantOf(cx, c)?.values ?? {};
  const v = size && cx.variants?.find((x) => x.in_stock && x.values[size.group] === value && Object.keys(now).every((g) => g === size.group || x.values[g] === now[g]));
  return v ? { ...c, variant: v.id } : null;
}

/** `cx.price` (the price context of `baseVariant`) moved to `variant`'s price; null when the product does not sell it. */
export function rebase(cx: RulesContext, baseVariant: string | null, variant: string | null): PriceContext | null {
  if (variant === baseVariant) return cx.price;
  const v = cx.variants?.find((x) => x.id === variant);
  return v ? { ...cx.price, base_iqd: v.price_iqd } : null;
}

/**
 * A pricer for configurations of one product: `cx.price` prices `baseVariant`;
 * another variant is priced from `cx.variants`. Null = it cannot be priced (a
 * part without a price, a variant the product does not sell).
 */
export function unitPricer(spec: SpecLike, cx: RulesContext, baseVariant: string | null): (c: DesignConfig) => number | null {
  return (c) => {
    const p = rebase(cx, baseVariant, c.variant);
    try {
      return p && priceConfig(spec, c, p).unit_iqd;
    } catch (e) {
      if (e instanceof EngineError && e.code === 'PART_UNPRICED') return null;
      throw e;
    }
  };
}

// ------------------------------------------------------------ the colours

/** The shop's shelf for the chosen look — every key marked `in` and every `sub:` target — with the look's map; null when it tracks nothing. */
export function stockedKeys(spec: SpecLike, c: DesignConfig, cx: RulesContext): { shelf: Set<string>; map: Partial<Record<string, string>> } | null {
  const map = lookStock({ axes: spec.axes, variants: (cx.variants ?? []) as PublicVariant[], stock: cx.stock ?? null }, c.variant);
  if (!map) return null;
  const shelf = new Set<string>();
  for (const [k, s] of Object.entries(map)) if (s === 'in' || s?.startsWith('sub:')) shelf.add(s === 'in' ? k : s.slice(4));
  return { shelf, map };
}

const setColour = (c: DesignConfig, id: string, key: PaletteKey): DesignConfig => ({ ...c, colors: { ...c.colors, [id]: key } });

/** What a colour target may wear now (see the header), in palette order. */
export function colourChoices(spec: SpecLike, c: DesignConfig, cx: RulesContext, id: string): PaletteKey[] {
  const paint = (spec.regions.find((r) => r.id === id) ?? spec.areas.find((a) => a.id === id)?.text)?.paint;
  if (!paint) return [];
  const st = stockedKeys(spec, c, cx);
  const lists = spec.rules.flatMap((r) => ('only_colors' in r.then && r.then.only_colors.target === id && ruleApplies(spec, c, cx, r.if) ? [r.then.only_colors.keys] : []));
  return PAINT_KEYS.filter(
    (k) => (!Array.isArray(paint.allowed) || paint.allowed.includes(k)) && (!st || paint.allowed !== 'stocked' || st.shelf.has(k)) && lists.every((l) => l.includes(k))
  );
}

const lab = (k: PaletteKey) => rgbToLab(PALETTE_RGB[k]);
/** How far apart two palette colours look (CIEDE2000). */
const apart = (a: PaletteKey, b: PaletteKey): number => deltaE2000(lab(a), lab(b));

/** The key of `list` that looks nearest to `key` (CIEDE2000 over the palette's colours); the first on a tie; null for none. */
export function nearestColour(key: PaletteKey, list: readonly PaletteKey[]): PaletteKey | null {
  let best: PaletteKey | null = null;
  let d = Infinity;
  for (const k of list) {
    const x = apart(key, k);
    if (x < d) [best, d] = [k, x];
  }
  return best;
}

/**
 * The customer's colours brought down to `max`: while there are more, the
 * nearest two (CIEDE2000) become one — the key moves where every target wearing it may
 * wear the other (fewer targets moved on a tie). Null when no merge is possible.
 */
export function mergeColours(spec: SpecLike, c: DesignConfig, cx: RulesContext, max: number): DesignConfig | null {
  let cur = c;
  for (;;) {
    const ts = paintTargets(spec, cur).filter((t) => t.choice);
    const keys = [...new Set(ts.map((t) => t.key))];
    if (keys.length <= max) return cur;
    let best: { from: PaletteKey; to: PaletteKey; d: number; n: number } | null = null;
    for (const from of keys) {
      const moving = ts.filter((t) => t.key === from);
      for (const to of keys) {
        if (to === from || !moving.every((t) => colourChoices(spec, cur, cx, t.id).includes(to))) continue;
        const d = apart(from, to);
        if (!best || d < best.d || (d === best.d && moving.length < best.n)) best = { from, to, d, n: moving.length };
      }
    }
    if (!best) return null;
    const { from, to } = best;
    for (const t of ts) if (t.key === from) cur = setColour(cur, t.id, to);
  }
}

// ------------------------------------------------------------- the rules

/** The longest entry of a text area, in graphemes — roster names included. */
function longest(c: DesignConfig, id: string): number {
  const all = [...(c.texts[id]?.value ?? []), ...(c.roster ?? []).flatMap((r) => r.texts?.[id] ?? [])];
  return Math.max(0, ...all.map(graphemeCount));
}

const choiceOf = (spec: SpecLike, c: DesignConfig, slotId: string): string | null => {
  const s = spec.slots.find((x) => x.id === slotId);
  return s ? slotChoice(s, c) : null;
};

/** Whether a rule's `if` holds for `c`. */
export function ruleApplies(spec: SpecLike, c: DesignConfig, cx: RulesContext, w: RuleIf): boolean {
  if ('text' in w) return longest(c, w.text) > w.longer_than;
  if ('slot' in w) return choiceOf(spec, c, w.slot) === w.is;
  if ('qr' in w) return c.qr[w.qr] != null;
  return Object.values(variantOf(cx, c)?.values ?? {}).includes(w.value);
}

function ruleHolds(spec: SpecLike, c: DesignConfig, cx: RulesContext, t: RuleThen): boolean {
  if ('size_at_least' in t) {
    const order = sizeOrder(spec);
    const v = axisValue(spec, cx, c, 'size');
    return v !== undefined && order.indexOf(v) >= order.indexOf(t.size_at_least);
  }
  if ('requires' in t) return choiceOf(spec, c, t.requires.slot) === t.requires.is;
  if ('excludes' in t) return choiceOf(spec, c, t.excludes.slot) !== t.excludes.is;
  if ('only_colors' in t) {
    const x = paintTargets(spec, c).find((p) => p.id === t.only_colors.target);
    return !x || t.only_colors.keys.includes(x.key);
  }
  return customerColours(spec, c).length <= t.max_colors;
}

function ruleFix(spec: SpecLike, c: DesignConfig, cx: RulesContext, t: RuleThen): DesignConfig | null {
  if ('size_at_least' in t) {
    const order = sizeOrder(spec);
    const fits = sizeValuesInBuild(spec, cx.printer);
    for (const v of order.slice(Math.max(0, order.indexOf(t.size_at_least)))) {
      const next = fits.includes(v) ? withSize(spec, c, cx, v) : null;
      if (next) return next;
    }
    return null;
  }
  if ('requires' in t || 'excludes' in t) {
    const { slot: id, is } = 'requires' in t ? t.requires : t.excludes;
    const s = spec.slots.find((x) => x.id === id);
    if (!s || s.choice !== 'customer') return null;
    const inStock = (key: string | undefined) => {
      const o = s.options.find((x) => x.key === key);
      return !!o && cx.price.parts[partKey(o.part.p, o.part.v)]?.in_stock === true;
    };
    const to = 'requires' in t ? (inStock(is) ? is : undefined) : !s.required ? null : [s.default, ...s.options.map((o) => o.key)].find((k) => k !== is && inStock(k));
    return to === undefined ? null : { ...c, slots: { ...c.slots, [id]: { option: to } } };
  }
  if ('only_colors' in t) {
    const id = t.only_colors.target;
    const now = paintTargets(spec, c).find((p) => p.id === id);
    const to = now && nearestColour(now.key, colourChoices(spec, c, cx, id));
    return to ? setColour(c, id, to) : null;
  }
  return mergeColours(spec, c, cx, t.max_colors);
}

/**
 * Every rule whose `if` holds for `config`, satisfied or not; an unsatisfied
 * one carries its fix when there is one (see the header). `ctx.price` must be
 * the price context of `config` itself.
 */
export function evaluateRules(spec: SpecLike, config: DesignConfig, ctx: RulesContext): RuleOutcome[] {
  const cx = withPublic(spec, ctx);
  const unit = unitPricer(spec, cx, config.variant);
  const now = unit(config);
  return spec.rules
    .filter((r) => ruleApplies(spec, config, cx, r.if))
    .map((r) => {
      const out: RuleOutcome = { rule: r.id, satisfied: ruleHolds(spec, config, cx, r.then), say: r.say };
      const next = out.satisfied || now === null ? null : ruleFix(spec, config, cx, r.then);
      const then = next && unit(next);
      if (next && then != null && now !== null) out.fix = { kind: r.fix === 'auto' && then === now ? 'auto' : 'suggest', config: next, delta_iqd: then - now };
      return out;
    });
}
