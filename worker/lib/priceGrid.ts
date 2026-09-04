/**
 * THE PRICE GRID — one flat table of every price a product can charge, and the
 * arithmetic for changing many of them at once.
 *
 * WHY THIS EXISTS. A product like "Bambu Lab A1" carries two models × two
 * fulfilment routes × four price fields × however many colours. Changing the
 * supplier cost meant opening the full product form and retyping dozens of
 * numbers one by one, which is slow enough that prices simply stop being kept
 * up to date. The owner's ask: "أريد أن أعدّل سعر أو تكلفة أي منتج خلال ثوانٍ".
 *
 * WHAT THIS IS NOT. It is not a second pricing system. Every number here is
 * read from, and written back to, the columns worker/lib/pricing.ts already
 * resolves from — the same four nullable price fields at product, option and
 * colour level, plus the adjustments added in 0044. `effective` below is
 * computed by the SAME ladder rules the resolver uses, so the admin preview and
 * the customer's cart cannot disagree (§30). Nothing derived is ever stored.
 *
 * Everything in this file is pure: no database, no request, no clock. That is
 * what lets the preview the admin approves and the write that follows be the
 * same computation rather than two implementations of one intention.
 */

import { ADJUST_OF, priceMode, type PriceKey, type PriceMode, type PriceFields } from './pricing';
import { effectiveAvailability, type AvailabilityType } from './availability';

// --------------------------------------------------------------- vocabulary

/** The short names the UI and the API speak; `PriceKey` is the column name. */
export type Field = 'regular' | 'prime' | 'pro' | 'cost';
export const FIELDS: Field[] = ['regular', 'prime', 'pro', 'cost'];
export const COLUMN_OF: Record<Field, PriceKey> = {
  regular: 'regular_price_iqd',
  prime: 'prime_price_iqd',
  pro: 'pro_price_iqd',
  cost: 'cost_iqd',
};
export const FIELD_OF: Record<PriceKey, Field> = {
  regular_price_iqd: 'regular',
  prime_price_iqd: 'prime',
  pro_price_iqd: 'pro',
  cost_iqd: 'cost',
};

export type Level = 'product' | 'option' | 'color';

// ------------------------------------------------------ §25 amount shorthand

export interface Amount {
  value: number | null;
  error: string | null;
}

/**
 * §25: "اقبل اختصارات آمنة مثل 950K أو 1.25M ... لكن لا تخمّن إذا كان الإدخال
 * غامضًا".
 *
 * Accepted: digits, one decimal point, thousands separators (Latin or Arabic),
 * Arabic-Indic digits, a leading sign, and a single k/m/ألف/مليون suffix.
 *
 * REFUSED RATHER THAN GUESSED — and this is the part that matters, because a
 * guess here overcharges a customer:
 *   - "950.5" as a price. Dinars have no minor unit; a fractional dinar is a
 *     typo, not an amount. (A fraction WITH a suffix is fine: 1.25M is exact.)
 *   - two suffixes, a suffix in the middle, or anything left over after the
 *     number.
 *   - a suffix whose result is not a whole dinar (1.0005K).
 * An empty string is not an error: it is how the UI says "clear this cell".
 */
export function parseAmount(raw: unknown): Amount {
  if (raw === null || raw === undefined) return { value: null, error: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: null, error: 'AMOUNT_NOT_A_NUMBER' };
    if (!Number.isInteger(raw)) return { value: null, error: 'AMOUNT_NOT_WHOLE_DINARS' };
    return { value: raw, error: null };
  }
  if (typeof raw !== 'string') return { value: null, error: 'AMOUNT_NOT_A_NUMBER' };

  // Arabic-Indic and Eastern-Arabic digits, so a number typed on an Arabic
  // keyboard is the same number.
  let s = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, '.')
    .replace(/[٬,\u00a0\u202f \s_]/g, '')
    .trim();
  if (s === '') return { value: null, error: null };

  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-') || s.startsWith('−')) {
    sign = -1;
    s = s.slice(1);
  }

  const m = /^(\d+(?:\.\d+)?)(k|m|ك|م|الف|ألف|مليون)?$/i.exec(s);
  if (!m) return { value: null, error: 'AMOUNT_UNPARSEABLE' };
  const digits = m[1];
  const suffix = (m[2] ?? '').toLowerCase();

  const MULT: Record<string, number> = {
    '': 1,
    k: 1_000,
    ك: 1_000,
    الف: 1_000,
    ألف: 1_000,
    m: 1_000_000,
    م: 1_000_000,
    مليون: 1_000_000,
  };
  const mult = MULT[suffix];
  if (mult === undefined) return { value: null, error: 'AMOUNT_UNPARSEABLE' };

  if (mult === 1 && digits.includes('.')) return { value: null, error: 'AMOUNT_NOT_WHOLE_DINARS' };
  const scaled = Number(digits) * mult;
  if (!Number.isFinite(scaled)) return { value: null, error: 'AMOUNT_UNPARSEABLE' };
  // A suffix that lands between dinars is as ambiguous as a bare fraction.
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return { value: null, error: 'AMOUNT_NOT_WHOLE_DINARS' };
  const value = sign * Math.round(scaled);
  if (Math.abs(value) > 1_000_000_000) return { value: null, error: 'AMOUNT_OUT_OF_RANGE' };
  return { value, error: null };
}

// ------------------------------------------------------------- §12 profit

export interface Profit {
  cost_iqd: number | null;
  price_iqd: number | null;
  profit_iqd: number | null;
  /** Gross margin on the SELLING price, one decimal place. null when unknowable. */
  margin_percent: number | null;
}

/**
 * §12. Margin is profit over PRICE (the retail convention), not over cost —
 * "ربح 50%" from a shop means half the money taken, and reporting markup under
 * the word margin is how a guard set at 20% silently permits 16%.
 *
 * A missing cost yields nulls, never zeros: "we do not know the profit" and
 * "the profit is nothing" are different facts, and only one of them should
 * light up a warning.
 */
export function profitOf(price: number | null, cost: number | null): Profit {
  if (price === null || price === undefined || cost === null || cost === undefined) {
    return { cost_iqd: cost ?? null, price_iqd: price ?? null, profit_iqd: null, margin_percent: null };
  }
  const profit = price - cost;
  const margin = price === 0 ? null : Math.round((profit / price) * 1000) / 10;
  return { cost_iqd: cost, price_iqd: price, profit_iqd: profit, margin_percent: margin };
}

export type GuardCode = 'BELOW_COST' | 'THIN_MARGIN';

export interface Guard {
  code: GuardCode;
  where: string;
  field: Field;
  price_iqd: number;
  cost_iqd: number;
  margin_percent: number | null;
  min_margin_percent: number | null;
}

/**
 * Which selling prices a change to these fields can put under water.
 *
 * A guard must speak about the change being made, not about everything else
 * that happens to be true of the row. Warning that a row's PRIME price is thin
 * when the admin only touched its PRO price is how a warning becomes noise, and
 * a warning that is always there is one that is always clicked through.
 *
 * A COST change is the exception, and deliberately so: raising a cost can put
 * every selling price on that row under water at once, so it re-checks all of
 * them.
 */
export function guardedFields(changed: Iterable<Field>): Field[] {
  const set = new Set(changed);
  if (set.has('cost')) return ['regular', 'prime', 'pro'];
  return (['regular', 'prime', 'pro'] as Field[]).filter((f) => set.has(f));
}

/**
 * §13. A guard WARNS; it does not veto. "اعرض تحذيرًا ... مع طلب تأكيد صريح
 * ولا تمنع دائمًا" — a launch sold at cost and a clearance sold below it are
 * both real decisions, and a shop that cannot express them is broken in a way
 * that costs more than the mistake it prevents. The caller requires an explicit
 * confirmation flag before writing; that is where the friction belongs.
 */
export function guardsFor(
  where: string,
  field: Field,
  price: number | null,
  cost: number | null,
  minMarginPercent: number | null
): Guard[] {
  if (price === null || cost === null) return [];
  const p = profitOf(price, cost);
  const base = { where, field, price_iqd: price, cost_iqd: cost, margin_percent: p.margin_percent, min_margin_percent: minMarginPercent };
  if (price < cost) return [{ code: 'BELOW_COST', ...base }];
  if (
    minMarginPercent !== null &&
    minMarginPercent > 0 &&
    p.margin_percent !== null &&
    p.margin_percent < minMarginPercent
  ) {
    return [{ code: 'THIN_MARGIN', ...base }];
  }
  return [];
}

// --------------------------------------------------------------- the grid

export interface Cell {
  mode: PriceMode;
  /** The typed fixed price, when mode is 'fixed'. */
  value: number | null;
  /** The signed move, when mode is 'adjust'. */
  adjust: number | null;
  /** What this row would charge if the customer picked exactly it. */
  effective: number | null;
  /** What it would have charged with this cell left on inherit — the number an
   *  'inherit' click lands on, shown as the placeholder so the admin can see
   *  what they are overriding before they override it. */
  inherited: number | null;
}

export interface GridRow {
  level: Level;
  id: string;
  label_ar: string;
  label_en: string;
  active: boolean;
  /** Options only: which model and which fulfilment route this row is. */
  variant_key: string;
  variant_label: string;
  availability_type: AvailabilityType;
  /** Colours only: the option this colour is tied to, '' when it is universal. */
  option_id: string;
  hex: string;
  stock: number | null;
  cells: Record<Field, Cell>;
  profit: Profit;
}

export interface GridProductInput {
  price_iqd: number;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  product_cost_iqd: number | null;
  name_ar?: string;
  name_en?: string;
  selling_type?: string;
  sale_types?: string[];
  options: Array<PriceFields & {
    id: string;
    name_ar?: string;
    name_en?: string;
    active?: boolean;
    stock?: number | null;
    variant_key?: string;
    variant_label?: string;
    availability_type?: string;
  }>;
  colors: Array<PriceFields & {
    id: string;
    name_ar?: string;
    name_en?: string;
    active?: boolean;
    stock?: number | null;
    hex?: string;
    option_id?: string | null;
  }>;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** One rung of the ladder, applied exactly as worker/lib/pricing.ts does. */
function step(inherited: number | null, row: PriceFields | null, field: Field, regularHere: number | null): number | null {
  if (!row) return inherited;
  const col = COLUMN_OF[field];
  const mode = priceMode(row, col);
  if (mode === 'fixed') return num(row[col]);
  if (mode === 'adjust') {
    const adj = num(row[ADJUST_OF[col]]);
    if (adj === null) return inherited;
    const anchor = inherited !== null ? inherited : field === 'prime' || field === 'pro' ? regularHere : null;
    if (anchor === null) return inherited;
    return Math.max(0, Math.round(anchor + adj));
  }
  return inherited;
}

function cellOf(row: PriceFields | null, field: Field, inherited: number | null, regularHere: number | null): Cell {
  const col = COLUMN_OF[field];
  const mode = row ? priceMode(row, col) : 'inherit';
  return {
    mode,
    value: row ? num(row[col]) : null,
    adjust: row ? num(row[ADJUST_OF[col]]) : null,
    effective: step(inherited, row, field, regularHere),
    inherited,
  };
}

/**
 * The whole product as one flat table: the base row, then one row per option
 * (which is one model × one fulfilment route), then one per colour.
 *
 * The base row's cells are always 'fixed' for regular — products.price_iqd is
 * NOT NULL, there is nothing above it to inherit from, and pretending otherwise
 * would put an "inherit" button on a cell with no parent.
 */
export function buildGrid(p: GridProductInput): GridRow[] {
  const saleTypes = p.sale_types && p.sale_types.length ? p.sale_types : [p.selling_type ?? 'direct_sale'];
  const baseOf = (f: Field): number | null =>
    f === 'regular' ? p.price_iqd : f === 'prime' ? p.prime_price_iqd : f === 'pro' ? p.pro_price_iqd : p.product_cost_iqd;

  const rows: GridRow[] = [];

  const baseCells = {} as Record<Field, Cell>;
  for (const f of FIELDS) {
    const v = baseOf(f);
    baseCells[f] = {
      mode: f === 'regular' || v !== null ? 'fixed' : 'inherit',
      value: v,
      adjust: null,
      effective: v,
      inherited: null,
    };
  }
  rows.push({
    level: 'product',
    id: '',
    label_ar: (p.name_ar ?? '').trim() || 'السعر الأساسي',
    label_en: (p.name_en ?? '').trim() || 'Base price',
    active: true,
    variant_key: '',
    variant_label: '',
    availability_type: '',
    option_id: '',
    hex: '',
    stock: null,
    cells: baseCells,
    profit: profitOf(baseCells.regular.effective, baseCells.cost.effective),
  });

  const optionById = new Map<string, (typeof p.options)[number]>();
  const optionEffective = new Map<string, Record<Field, number | null>>();

  for (const o of p.options) {
    optionById.set(o.id, o);
    const regular = step(baseOf('regular'), o, 'regular', null);
    const eff = {} as Record<Field, number | null>;
    const cells = {} as Record<Field, Cell>;
    for (const f of FIELDS) {
      const c = cellOf(o, f, baseOf(f), regular);
      cells[f] = c;
      eff[f] = c.effective;
    }
    optionEffective.set(o.id, eff);
    rows.push({
      level: 'option',
      id: o.id,
      label_ar: (o.name_ar ?? '').trim() || (o.name_en ?? '').trim() || o.id,
      label_en: (o.name_en ?? '').trim() || (o.name_ar ?? '').trim() || o.id,
      active: o.active !== false,
      variant_key: (o.variant_key ?? '').trim(),
      variant_label: (o.variant_label ?? '').trim(),
      availability_type: effectiveAvailability(
        { availability_type: o.availability_type as AvailabilityType | undefined },
        saleTypes
      ),
      option_id: '',
      hex: '',
      stock: o.stock ?? null,
      cells,
      profit: profitOf(cells.regular.effective, cells.cost.effective),
    });
  }

  for (const c of p.colors) {
    const parent = c.option_id ? optionById.get(c.option_id) ?? null : null;
    const parentEff = c.option_id ? optionEffective.get(c.option_id) ?? null : null;
    const inheritedOf = (f: Field): number | null => (parentEff ? parentEff[f] : baseOf(f));
    const regular = step(inheritedOf('regular'), c, 'regular', null);
    const cells = {} as Record<Field, Cell>;
    for (const f of FIELDS) cells[f] = cellOf(c, f, inheritedOf(f), regular);
    rows.push({
      level: 'color',
      id: c.id,
      label_ar: (c.name_ar ?? '').trim() || (c.name_en ?? '').trim() || c.id,
      label_en: (c.name_en ?? '').trim() || (c.name_ar ?? '').trim() || c.id,
      active: c.active !== false,
      variant_key: (parent?.variant_key ?? '').trim(),
      variant_label: (parent?.variant_label ?? '').trim(),
      availability_type: parent
        ? effectiveAvailability({ availability_type: parent.availability_type as AvailabilityType | undefined }, saleTypes)
        : '',
      option_id: c.option_id ?? '',
      hex: (c.hex ?? '').trim(),
      stock: c.stock ?? null,
      cells,
      profit: profitOf(cells.regular.effective, cells.cost.effective),
    });
  }

  return rows;
}

// ------------------------------------------------------------- §9 bulk edit

export type BulkOp = 'add' | 'subtract' | 'add_percent' | 'subtract_percent' | 'set' | 'inherit' | 'adjust';

export interface BulkScope {
  /** Empty = every level. */
  levels?: Level[];
  /** Empty = every fulfilment route; otherwise only rows on these routes. */
  availability?: AvailabilityType[];
  /** Empty = every model; otherwise only rows whose variant_key is listed. */
  variant_keys?: string[];
  /** Empty = every row; otherwise exactly these "<level>:<id>" rows. §14/§15. */
  row_ids?: string[];
  /** Default false: a deactivated row reactivated months later at a stale price
   *  is the failure pinnedPrices.ts documents, so it moves with the rest. */
  active_only?: boolean;
}

export interface BulkRequest {
  op: BulkOp;
  fields: Field[];
  /** Dinars for add/subtract/set/adjust; percent for the two percent ops. */
  value: number | null;
  scope?: BulkScope;
}

export interface CellChange {
  level: Level;
  id: string;
  label_ar: string;
  label_en: string;
  field: Field;
  from_mode: PriceMode;
  to_mode: PriceMode;
  /** The EFFECTIVE price before and after — what a customer would be charged. */
  from_iqd: number | null;
  to_iqd: number | null;
  /** The stored value that actually changes, so the writer needs no second pass. */
  write_value: number | null;
  write_adjust: number | null;
}

export interface BulkPreview {
  changes: CellChange[];
  guards: Guard[];
  /** Rows the scope matched but where nothing would move, and why. */
  skipped: Array<{ level: Level; id: string; field: Field; reason: string }>;
}

const rowKey = (r: { level: Level; id: string }) => `${r.level}:${r.id}`;

export function inScope(row: GridRow, scope: BulkScope | undefined): boolean {
  const s = scope ?? {};
  if (s.row_ids && s.row_ids.length) return s.row_ids.includes(rowKey(row));
  if (s.levels && s.levels.length && !s.levels.includes(row.level)) return false;
  if (s.active_only && !row.active) return false;
  // The base row has no fulfilment route and no model of its own, so a filter
  // on either is a statement about variants and must not silently move the
  // product's base price along with them.
  if (s.availability && s.availability.length) {
    if (row.level === 'product') return false;
    if (!s.availability.includes(row.availability_type)) return false;
  }
  if (s.variant_keys && s.variant_keys.length) {
    if (row.level === 'product') return false;
    if (!s.variant_keys.includes(row.variant_key)) return false;
  }
  return true;
}

/**
 * What a bulk request would do, cell by cell, WITHOUT touching anything (§9:
 * "أضف Preview قبل التطبيق").
 *
 * The arithmetic works on the EFFECTIVE price — what the customer pays today —
 * and writes the result as a FIXED value on the row it landed on. That is the
 * honest reading of "raise everything by 10,000": a row that inherits its price
 * and a row that pins its own both end up 10,000 dearer, and the admin sees
 * exactly which rows stopped inheriting as a result.
 *
 * The exceptions, both deliberate:
 *   - `inherit` clears the row (value and adjustment both null) so it follows
 *     its parent again. This is the operation that UNDOES pinning.
 *   - `adjust` writes the adjustment instead of a price, which is how "this
 *     model is always 60,000 above the base" is expressed once and then
 *     survives every future base change.
 */
export function previewBulk(
  rows: GridRow[],
  req: BulkRequest,
  minMarginPercent: number | null
): BulkPreview {
  const changes: CellChange[] = [];
  const skipped: BulkPreview['skipped'] = [];
  const guards: Guard[] = [];
  const fields = req.fields.length ? req.fields : FIELDS;

  for (const row of rows) {
    if (!inScope(row, req.scope)) continue;
    // The base regular price is the product's only unconditional number; a
    // scoped bulk that would blank it is refused rather than obeyed.
    for (const field of fields) {
      const cell = row.cells[field];
      const before = cell.effective;

      let toMode: PriceMode = 'fixed';
      let writeValue: number | null = null;
      let writeAdjust: number | null = null;
      let after: number | null = null;

      if (req.op === 'inherit') {
        if (row.level === 'product') {
          if (field === 'regular') {
            skipped.push({ level: row.level, id: row.id, field, reason: 'BASE_PRICE_REQUIRED' });
            continue;
          }
          toMode = 'inherit';
          after = null;
        } else {
          toMode = 'inherit';
          after = cell.inherited;
        }
      } else if (req.op === 'adjust') {
        if (req.value === null) {
          skipped.push({ level: row.level, id: row.id, field, reason: 'VALUE_REQUIRED' });
          continue;
        }
        if (row.level === 'product') {
          skipped.push({ level: row.level, id: row.id, field, reason: 'BASE_HAS_NOTHING_TO_ADJUST' });
          continue;
        }
        const anchor = cell.inherited !== null ? cell.inherited : field === 'prime' || field === 'pro' ? row.cells.regular.inherited : null;
        if (anchor === null) {
          skipped.push({ level: row.level, id: row.id, field, reason: 'NOTHING_TO_ADJUST' });
          continue;
        }
        toMode = 'adjust';
        writeAdjust = req.value;
        after = Math.max(0, anchor + req.value);
      } else {
        if (req.value === null) {
          skipped.push({ level: row.level, id: row.id, field, reason: 'VALUE_REQUIRED' });
          continue;
        }
        if (req.op === 'set') {
          after = Math.max(0, Math.round(req.value));
        } else {
          if (before === null) {
            // Moving "nothing" by a percentage or an amount has no answer that
            // is not invented. §11's cost update hits this on products that
            // never recorded a cost, and inventing one would poison §12.
            skipped.push({ level: row.level, id: row.id, field, reason: 'NO_CURRENT_VALUE' });
            continue;
          }
          const delta =
            req.op === 'add' ? req.value
            : req.op === 'subtract' ? -req.value
            : req.op === 'add_percent' ? (before * req.value) / 100
            : -(before * req.value) / 100;
          after = Math.max(0, Math.round(before + delta));
        }
        writeValue = after;
      }

      if (before === after && cell.mode === toMode) {
        skipped.push({ level: row.level, id: row.id, field, reason: 'NO_CHANGE' });
        continue;
      }

      changes.push({
        level: row.level,
        id: row.id,
        label_ar: row.label_ar,
        label_en: row.label_en,
        field,
        from_mode: cell.mode,
        to_mode: toMode,
        from_iqd: before,
        to_iqd: after,
        write_value: writeValue,
        write_adjust: writeAdjust,
      });
    }
  }

  // Guards are computed on the RESULT, pairing each row's new selling prices
  // against its new cost — including a cost the same request just raised.
  const afterOf = new Map<string, Partial<Record<Field, number | null>>>();
  for (const ch of changes) {
    const k = `${ch.level}:${ch.id}`;
    const bag = afterOf.get(k) ?? {};
    bag[ch.field] = ch.to_iqd;
    afterOf.set(k, bag);
  }
  for (const row of rows) {
    const bag = afterOf.get(rowKey(row));
    if (!bag) continue;
    const cost = bag.cost !== undefined ? bag.cost : row.cells.cost.effective;
    for (const f of guardedFields(Object.keys(bag) as Field[])) {
      const price = bag[f] !== undefined ? bag[f] : row.cells[f].effective;
      guards.push(...guardsFor(row.label_ar || row.label_en || row.id, f, price ?? null, cost ?? null, minMarginPercent));
    }
  }

  return { changes, guards, skipped };
}

// ---------------------------------------------------------- §16 quick copy

export interface CopyRequest {
  /** Copy FROM rows on this route/model TO the matching rows on that one. */
  from: { availability?: AvailabilityType; variant_key?: string };
  to: { availability?: AvailabilityType; variant_key?: string };
  fields: Field[];
}

/**
 * §16: "Pre-order → Direct", "A1 → A1 Combo", "copy the PRO price only".
 *
 * Rows are paired by what is NOT being copied across: copying between routes
 * pairs by model, copying between models pairs by route. A source with no
 * counterpart is reported rather than guessed at, because creating the missing
 * row would be inventing a product the owner never configured.
 *
 * The copy carries the MODE too, not just the number — copying a row that is
 * "+60,000 above base" as a frozen number would quietly convert an adjustment
 * into a pin, which is the exact failure this whole feature exists to end.
 */
export function previewCopy(
  rows: GridRow[],
  req: CopyRequest,
  minMarginPercent: number | null
): BulkPreview & { unmatched: Array<{ id: string; label_ar: string; label_en: string }> } {
  const fields = req.fields.length ? req.fields : FIELDS;
  const changes: CellChange[] = [];
  const skipped: BulkPreview['skipped'] = [];
  const unmatched: Array<{ id: string; label_ar: string; label_en: string }> = [];

  const matches = (row: GridRow, sel: { availability?: AvailabilityType; variant_key?: string }) =>
    (sel.availability === undefined || row.availability_type === sel.availability) &&
    (sel.variant_key === undefined || row.variant_key === sel.variant_key);

  const options = rows.filter((r) => r.level === 'option');
  const sources = options.filter((r) => matches(r, req.from));
  const targets = options.filter((r) => matches(r, req.to));

  // Pair on the axis the copy does not move.
  const pairKey = (r: GridRow) =>
    req.from.availability !== undefined && req.to.availability !== undefined && req.from.availability !== req.to.availability
      ? r.variant_key
      : r.availability_type;

  const targetsByKey = new Map<string, GridRow>();
  for (const t of targets) if (!targetsByKey.has(pairKey(t))) targetsByKey.set(pairKey(t), t);

  for (const src of sources) {
    const dst = targetsByKey.get(pairKey(src));
    if (!dst || dst.id === src.id) {
      unmatched.push({ id: src.id, label_ar: src.label_ar, label_en: src.label_en });
      continue;
    }
    for (const field of fields) {
      const from = src.cells[field];
      const to = dst.cells[field];
      if (from.mode === to.mode && from.value === to.value && from.adjust === to.adjust) {
        skipped.push({ level: dst.level, id: dst.id, field, reason: 'NO_CHANGE' });
        continue;
      }
      const writeValue = from.mode === 'fixed' ? from.value : null;
      const writeAdjust = from.mode === 'adjust' ? from.adjust : null;
      const after =
        from.mode === 'fixed'
          ? from.value
          : from.mode === 'adjust'
            ? Math.max(0, (to.inherited ?? dst.cells.regular.inherited ?? 0) + (from.adjust ?? 0))
            : to.inherited;
      changes.push({
        level: dst.level,
        id: dst.id,
        label_ar: dst.label_ar,
        label_en: dst.label_en,
        field,
        from_mode: to.mode,
        to_mode: from.mode,
        from_iqd: to.effective,
        to_iqd: after,
        write_value: writeValue,
        write_adjust: writeAdjust,
      });
    }
  }

  const afterOf = new Map<string, Partial<Record<Field, number | null>>>();
  for (const ch of changes) {
    const k = `${ch.level}:${ch.id}`;
    const bag = afterOf.get(k) ?? {};
    bag[ch.field] = ch.to_iqd;
    afterOf.set(k, bag);
  }
  const guards: Guard[] = [];
  for (const row of rows) {
    const bag = afterOf.get(rowKey(row));
    if (!bag) continue;
    const cost = bag.cost !== undefined ? bag.cost : row.cells.cost.effective;
    for (const f of guardedFields(Object.keys(bag) as Field[])) {
      const price = bag[f] !== undefined ? bag[f] : row.cells[f].effective;
      guards.push(...guardsFor(row.label_ar || row.label_en || row.id, f, price ?? null, cost ?? null, minMarginPercent));
    }
  }

  return { changes, guards, skipped, unmatched };
}
