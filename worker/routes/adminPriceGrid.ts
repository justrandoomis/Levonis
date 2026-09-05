import { Hono } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { requireAdmin, badRequest, notFound, forbidden, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import { getSetting } from '../lib/settings';
import { normalizeAvailability, deriveSaleTypes, type AvailabilityType } from '../lib/availability';
import { normalizeSaleTypes } from '../lib/productModel';
import { ADJUST_OF } from '../lib/pricing';
import {
  buildGrid,
  previewBulk,
  previewCopy,
  parseAmount,
  profitOf,
  guardsFor,
  guardedFields,
  COLUMN_OF,
  FIELDS,
  type BulkRequest,
  type BulkOp,
  type CellChange,
  type CopyRequest,
  type Field,
  type Guard,
  type GridProductInput,
  type GridRow,
  type Level,
} from '../lib/priceGrid';
import type { PriceMode } from '../lib/pricing';

/**
 * QUICK EDIT — one product's whole price table, read and written in a single
 * round trip.
 *
 * THE PROBLEM. The owner asked to be able to change any product's price or
 * cost in seconds. A product with two models x two fulfilment routes x colours
 * has dozens of price fields spread across the full product form, and changing
 * a supplier cost meant visiting every one of them. The form is not the wrong
 * tool for BUILDING a product; it is the wrong tool for changing a number.
 *
 * WHAT THIS IS BUILT ON, RATHER THAN BESIDE.
 *   - The numbers are the SAME columns worker/lib/pricing.ts resolves from.
 *     There is no second price store and no cache: the grid is a projection,
 *     and `effective` is computed by worker/lib/priceGrid.ts using the ladder
 *     rules of the resolver itself, so the admin preview and the customer's
 *     cart cannot disagree.
 *   - History is `price_history`, which has existed since 0003 and is what the
 *     seven-day price protection already reads. Every write here appends to it,
 *     so a quick edit is as visible to a refund claim as a full save is.
 *   - Undo is that same table read backwards over one `batch_id` (0044) — not a
 *     snapshot table, and not a "previous value" column that remembers one step.
 *
 * WHAT IS WRITTEN. Only the cells the client marks dirty, and only the columns
 * those cells name. A quick edit never touches names, images, stock,
 * classification or any other part of the product, so it cannot clobber an edit
 * someone else is making elsewhere in it.
 *
 * The financial-scope rule applies here as everywhere: an assistant admin sees
 * no cost, no adjustment to a cost, and no profit — and cannot write one.
 */

export const adminPriceGridRoutes = new Hono<AppContext>();
adminPriceGridRoutes.use('*', requireAdmin);

// ------------------------------------------------------------------ loading

interface LoadedProduct {
  input: GridProductInput;
  /** Where the option/colour rows the RESOLVER uses actually live. */
  relational: boolean;
  /** The raw JSON arrays, so a JSON-store write puts back what it read. */
  jsonOptions: Array<Record<string, unknown>>;
  jsonColors: Array<Record<string, unknown>>;
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const readArr = (v: unknown): Array<Record<string, unknown>> => {
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(x) ? (x as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
};

const readStrArr = (v: unknown): string[] => {
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Reads the product and whichever option/colour store the resolver reads.
 *
 * WHY `has_relations` DECIDES, and not "whichever store has rows": that is the
 * rule worker/lib/productOverlay.ts applies when it builds the document the
 * cart prices from. A grid that picked differently would show the admin numbers
 * no customer is charged — the single failure this whole feature exists to
 * prevent.
 *
 * INACTIVE ROWS ARE INCLUDED, unlike in the customer-facing projection. A
 * deactivated option is one click from being sold again, and reactivating it at
 * a price from before two rounds of increases is the exact failure documented
 * in worker/lib/pinnedPrices.ts.
 */
async function loadProduct(db: D1Database, productId: string): Promise<LoadedProduct> {
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');

  const [values, colors, groups, images] = await Promise.all([
    db
      .prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<Record<string, unknown>>(),
    db
      .prepare('SELECT * FROM product_colors WHERE product_id = ? ORDER BY sort, name_en')
      .bind(productId)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT id FROM product_option_groups WHERE product_id = ? LIMIT 1').bind(productId).all<{ id: string }>(),
    db.prepare('SELECT id FROM product_images WHERE product_id = ? LIMIT 1').bind(productId).all<{ id: string }>(),
  ]);

  const relational =
    (groups.results?.length ?? 0) > 0 ||
    (values.results?.length ?? 0) > 0 ||
    (colors.results?.length ?? 0) > 0 ||
    (images.results?.length ?? 0) > 0;

  const linkOf = new Map<string, string[]>();
  if (relational && (colors.results?.length ?? 0) > 0) {
    const { results } = await db
      .prepare(
        `SELECT l.color_id, l.option_value_id FROM product_color_option_links l
           JOIN product_colors c ON c.id = l.color_id WHERE c.product_id = ?`
      )
      .bind(productId)
      .all<{ color_id: string; option_value_id: string }>();
    for (const l of results ?? []) {
      const arr = linkOf.get(l.color_id);
      if (arr) arr.push(l.option_value_id);
      else linkOf.set(l.color_id, [l.option_value_id]);
    }
  }

  const jsonOptions = readArr(row.options);
  const jsonColors = readArr(row.colors);

  const priceBits = (r: Record<string, unknown>) => ({
    regular_price_iqd: numOrNull(r.regular_price_iqd),
    prime_price_iqd: numOrNull(r.prime_price_iqd),
    pro_price_iqd: numOrNull(r.pro_price_iqd),
    cost_iqd: numOrNull(r.cost_iqd),
    regular_adjust_iqd: numOrNull(r.regular_adjust_iqd),
    prime_adjust_iqd: numOrNull(r.prime_adjust_iqd),
    pro_adjust_iqd: numOrNull(r.pro_adjust_iqd),
    cost_adjust_iqd: numOrNull(r.cost_adjust_iqd),
  });

  const options: GridProductInput['options'] = relational
    ? (values.results ?? []).map((v) => ({
        id: String(v.id),
        name_ar: String(v.name_en ?? ''),
        name_en: String(v.name_en ?? ''),
        active: v.active !== 0 && v.active !== false,
        stock: numOrNull(v.stock),
        variant_key: String(v.variant_key ?? ''),
        variant_label: String(v.variant_label ?? ''),
        availability_type: String(v.availability_type ?? ''),
        ...priceBits(v),
      }))
    : jsonOptions.map((o) => ({
        id: String(o.id ?? ''),
        name_ar: String(o.name_ar ?? o.name_en ?? ''),
        name_en: String(o.name_en ?? o.name_ar ?? ''),
        active: o.active !== false,
        stock: numOrNull(o.stock),
        variant_key: String(o.variant_key ?? ''),
        variant_label: String(o.variant_label ?? ''),
        availability_type: String(o.availability_type ?? ''),
        ...priceBits(o),
      }));

  const colorRows: GridProductInput['colors'] = relational
    ? (colors.results ?? []).map((x) => {
        const linked = linkOf.get(String(x.id)) ?? [];
        return {
          id: String(x.id),
          name_ar: String(x.name_en ?? ''),
          name_en: String(x.name_en ?? ''),
          active: x.active !== 0 && x.active !== false,
          stock: numOrNull(x.stock),
          hex: String(x.hex ?? ''),
          option_id: linked.length === 1 ? linked[0] : null,
          ...priceBits(x),
        };
      })
    : jsonColors.map((x) => ({
        id: String(x.id ?? ''),
        name_ar: String(x.name_ar ?? x.name_en ?? ''),
        name_en: String(x.name_en ?? x.name_ar ?? ''),
        active: x.active !== false,
        stock: numOrNull(x.stock),
        hex: String(x.hex ?? ''),
        option_id: (x.option_id as string | null) ?? null,
        ...priceBits(x),
      }));

  return {
    input: {
      price_iqd: Number(row.price_iqd ?? 0),
      prime_price_iqd: numOrNull(row.prime_price_iqd),
      pro_price_iqd: numOrNull(row.pro_price_iqd),
      product_cost_iqd: numOrNull(row.product_cost_iqd),
      name_ar: String(row.name_ar ?? ''),
      name_en: String(row.name ?? ''),
      selling_type: String(row.selling_type ?? 'direct_sale'),
      sale_types: readStrArr(row.sale_types),
      options,
      colors: colorRows,
    },
    relational,
    jsonOptions,
    jsonColors,
  };
}

// ------------------------------------------------------------------ writing

/** One column on one row, ready to be written. */
interface Write {
  level: Level;
  id: string;
  column: string;
  /**
   * Traits widened this from `number | null`: availability is a string and
   * `active` is a boolean.
   *
   * A BOOLEAN IS CARRIED AS A BOOLEAN ON PURPOSE. The two stores disagree about
   * how "off" is spelled: the relational tables hold INTEGER 0/1, while the
   * JSON column is read with `o.active !== false`, under which the integer 0 is
   * TRUTHY and an option switched off would come back on. So the value stays a
   * boolean here and each branch of {@link applyWrites} spells it its own way.
   */
  value: number | string | boolean | null;
}

/** A history row, in the shape price_history has held since 0003. */
interface HistoryRow {
  variant_key: string;
  field: Field;
  old_iqd: number | null;
  new_iqd: number | null;
  /** 0046 — what the cell WAS, so undo restores it rather than guessing. */
  old_mode: PriceMode;
  old_adjust_iqd: number | null;
}

const historyKeyOf = (level: Level, id: string) => (level === 'product' ? '' : `${level}:${id}`);

const PRODUCT_COLUMN: Record<Field, string> = {
  regular: 'price_iqd',
  prime: 'prime_price_iqd',
  pro: 'pro_price_iqd',
  cost: 'product_cost_iqd',
};

/**
 * Turns the cell changes a preview produced into the smallest set of column
 * writes that realises them, plus the history rows that record them.
 *
 * The minimal-update rule in one sentence: a cell that did not change
 * contributes no write, and a row with no changed cells is never named in an
 * UPDATE at all.
 */
function planWrites(changes: CellChange[]): { writes: Write[]; history: HistoryRow[] } {
  const writes: Write[] = [];
  const history: HistoryRow[] = [];
  for (const ch of changes) {
    const col = COLUMN_OF[ch.field];
    if (ch.level === 'product') {
      // The base row has no adjustment columns: there is nothing above it to
      // adjust, and the regular base price may never be cleared.
      writes.push({ level: 'product', id: '', column: PRODUCT_COLUMN[ch.field], value: ch.write_value });
    } else {
      writes.push({ level: ch.level, id: ch.id, column: col, value: ch.write_value });
      writes.push({ level: ch.level, id: ch.id, column: ADJUST_OF[col], value: ch.write_adjust });
    }
    history.push({
      variant_key: historyKeyOf(ch.level, ch.id),
      field: ch.field,
      old_iqd: ch.from_iqd,
      new_iqd: ch.to_iqd,
      old_mode: ch.from_mode,
      old_adjust_iqd: ch.from_adjust,
    });
  }
  return { writes, history };
}

const TABLE_OF: Record<Exclude<Level, 'product'>, string> = {
  option: 'product_option_values',
  color: 'product_colors',
};

/**
 * Applies the plan.
 *
 * RELATIONAL AND JSON ARE NOT BOTH WRITTEN. The store the resolver reads is
 * the store that changes; writing the other one as well would leave a shadow
 * copy that silently takes over the day someone adds a relational row — a
 * price change nobody made.
 */
function applyWrites(
  db: D1Database,
  loaded: LoadedProduct,
  productId: string,
  writes: Write[]
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  /** D1 cannot bind a boolean; SQLite's own spelling of it is 1 and 0. */
  const forSql = (v: Write['value']) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

  const productCols = writes.filter((w) => w.level === 'product');
  if (productCols.length) {
    const sets = productCols.map((w) => `${w.column} = ?`).join(', ');
    stmts.push(
      db
        .prepare(`UPDATE products SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .bind(...productCols.map((w) => forSql(w.value)), productId)
    );
  }

  const byRow = new Map<string, Write[]>();
  for (const w of writes) {
    if (w.level === 'product') continue;
    const k = `${w.level} ${w.id}`;
    const arr = byRow.get(k);
    if (arr) arr.push(w);
    else byRow.set(k, [w]);
  }

  if (loaded.relational) {
    for (const [k, group] of byRow) {
      const sep = k.indexOf(' ');
      const level = k.slice(0, sep) as Exclude<Level, 'product'>;
      const id = k.slice(sep + 1);
      const sets = group.map((w) => `${w.column} = ?`).join(', ');
      stmts.push(
        db
          .prepare(`UPDATE ${TABLE_OF[level]} SET ${sets} WHERE id = ? AND product_id = ?`)
          .bind(...group.map((w) => forSql(w.value)), id, productId)
      );
    }
  } else if (byRow.size) {
    // The JSON store is one column, so the arrays are edited in memory and
    // written back once — still only the touched keys on the touched rows.
    const patch = (arr: Array<Record<string, unknown>>, level: Exclude<Level, 'product'>) => {
      let touched = false;
      for (const item of arr) {
        const group = byRow.get(`${level} ${String(item.id ?? '')}`);
        if (!group) continue;
        for (const w of group) item[w.column] = w.value;
        touched = true;
      }
      return touched;
    };
    const optTouched = patch(loaded.jsonOptions, 'option');
    const colTouched = patch(loaded.jsonColors, 'color');
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (optTouched) {
      sets.push('options = ?');
      binds.push(JSON.stringify(loaded.jsonOptions));
    }
    if (colTouched) {
      sets.push('colors = ?');
      binds.push(JSON.stringify(loaded.jsonColors));
    }
    if (sets.length) {
      stmts.push(
        db
          .prepare(
            `UPDATE products SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          )
          .bind(...binds, productId)
      );
    }
  }

  return stmts;
}

function historyStatements(
  db: D1Database,
  productId: string,
  actorId: string,
  batchId: string,
  rows: HistoryRow[]
): D1PreparedStatement[] {
  return rows.map((h) =>
    db
      .prepare(
        `INSERT INTO price_history
           (product_id, variant_key, field, old_iqd, new_iqd, changed_by, batch_id, old_mode, old_adjust_iqd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(productId, h.variant_key, h.field, h.old_iqd, h.new_iqd, actorId, batchId, h.old_mode, h.old_adjust_iqd)
  );
}

// -------------------------------------------------------------- projections

/**
 * An assistant admin never sees a cost cell, a cost adjustment or a profit, in
 * the grid as anywhere else. The COST COLUMN IS REMOVED rather than blanked, so
 * the client renders three columns instead of four and no zero is ever mistaken
 * for a real cost.
 */
function projectGrid(env: Env, user: SessionUser | null | undefined, rows: GridRow[]) {
  if (canViewFinancials(env, user)) return rows;
  return rows.map((r) => {
    const cells = { ...r.cells } as Partial<GridRow['cells']>;
    delete cells.cost;
    return {
      ...r,
      cells,
      profit: { cost_iqd: null, price_iqd: r.profit.price_iqd, profit_iqd: null, margin_percent: null },
    };
  });
}

function assertMayWrite(env: Env, user: SessionUser | null | undefined, fields: Field[]) {
  if (fields.includes('cost') && !canViewFinancials(env, user)) {
    throw forbidden('Cost is restricted to financial admins');
  }
}

const readFields = (v: unknown): Field[] => {
  if (!Array.isArray(v) || v.length === 0) return [...FIELDS];
  const out: Field[] = [];
  for (const x of v) {
    if (typeof x === 'string' && (FIELDS as string[]).includes(x)) out.push(x as Field);
    else throw badRequest(`Unknown price field: ${String(x)}`, 'BAD_FIELD');
  }
  return out;
};

/** The guard set for one row after a change, given the fields that moved. */
function guardsAfter(
  row: GridRow,
  after: Partial<Record<Field, number | null>>,
  minMargin: number | null
): Guard[] {
  const out: Guard[] = [];
  const cost = after.cost !== undefined ? after.cost : row.cells.cost?.effective ?? null;
  for (const f of guardedFields(Object.keys(after) as Field[])) {
    const price = after[f] !== undefined ? after[f] : row.cells[f].effective;
    out.push(...guardsFor(row.label_ar || row.label_en || row.id, f, price ?? null, cost ?? null, minMargin));
  }
  return out;
}

// ----------------------------------------------------------------- endpoints

/**
 * Everything the quick-edit drawer needs, in one request: the grid, the profit
 * figures, the margin floor the guard uses, and the vocabulary the scope
 * pickers offer.
 */
adminPriceGridRoutes.get('/:id/price-grid', async (c) => {
  const admin = c.get('user');
  const productId = c.req.param('id');
  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const financial = canViewFinancials(c.env, admin);
  const minMargin = await getSetting(c.env.DB, 'minMarginPercent');

  const variants = new Map<string, string>();
  const availability = new Set<AvailabilityType>();
  for (const r of rows) {
    if (r.level === 'product') continue;
    if (r.variant_key) variants.set(r.variant_key, r.variant_label || r.variant_key);
    if (r.availability_type) availability.add(r.availability_type);
  }

  return c.json({
    success: true,
    product: {
      id: productId,
      name_ar: loaded.input.name_ar,
      name_en: loaded.input.name_en,
      selling_type: loaded.input.selling_type,
      sale_types: loaded.input.sale_types,
      store: loaded.relational ? 'relational' : 'json',
    },
    rows: projectGrid(c.env, admin, rows),
    variants: [...variants].map(([key, label]) => ({ key, label })),
    availability: [...availability],
    min_margin_percent: financial ? minMargin : null,
    can_view_cost: financial,
  });
});

interface CellPatch {
  level: Level;
  id: string;
  field: Field;
  mode: 'inherit' | 'adjust' | 'fixed';
  /** Raw as typed, so the amount shorthand is parsed on the server too — the
   *  client is not the only thing that may call this. */
  value?: unknown;
}

/**
 * The dirty-cell write. The body carries ONLY the cells the admin touched;
 * everything else about the product is left exactly as it is.
 *
 * The response is the freshly rebuilt grid, so an inline edit in the list needs
 * no second request to show its own result.
 */
adminPriceGridRoutes.patch('/:id/price-grid', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const confirm = body.confirm === true;

  const raw = Array.isArray(body.cells) ? body.cells : [];
  if (raw.length === 0) throw badRequest('No cells to change', 'NO_CELLS');
  if (raw.length > 500) throw badRequest('Too many cells in one request', 'TOO_MANY_CELLS');

  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const byKey = new Map(rows.map((r) => [`${r.level}:${r.id}`, r]));
  const financial = canViewFinancials(c.env, admin);
  const minMargin = await getSetting(c.env.DB, 'minMarginPercent');

  const patches: CellPatch[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const level = String(item.level ?? '') as Level;
    if (level !== 'product' && level !== 'option' && level !== 'color') {
      throw badRequest(`Unknown level: ${String(item.level)}`, 'BAD_LEVEL');
    }
    const field = String(item.field ?? '') as Field;
    if (!(FIELDS as string[]).includes(field)) {
      throw badRequest(`Unknown price field: ${String(item.field)}`, 'BAD_FIELD');
    }
    const mode = String(item.mode ?? 'fixed');
    if (mode !== 'inherit' && mode !== 'adjust' && mode !== 'fixed') {
      throw badRequest(`Unknown mode: ${mode}`, 'BAD_MODE');
    }
    patches.push({ level, id: String(item.id ?? ''), field, mode, value: item.value });
  }
  assertMayWrite(
    c.env,
    admin,
    patches.map((p) => p.field)
  );

  const changes: CellChange[] = [];
  const afterOf = new Map<string, Partial<Record<Field, number | null>>>();

  for (const p of patches) {
    const key = `${p.level}:${p.id}`;
    const row = byKey.get(key);
    if (!row) throw badRequest(`No such row in this product: ${key}`, 'ROW_NOT_FOUND');
    const cell = row.cells[p.field];

    let value: number | null = null;
    if (p.mode !== 'inherit') {
      const parsed = parseAmount(p.value);
      if (parsed.error) throw badRequest(`${row.label_ar || row.id} / ${p.field}: ${parsed.error}`, parsed.error);
      value = parsed.value;
      // An emptied cell means "stop overriding", which is inherit — the one
      // reading that never silently invents a zero price.
      if (value === null) p.mode = 'inherit';
    }

    if (p.mode === 'fixed' && (value as number) < 0) throw badRequest('A price cannot be negative', 'NEGATIVE_PRICE');
    if (p.level === 'product' && p.field === 'regular' && p.mode !== 'fixed') {
      throw badRequest('The base regular price is required and cannot inherit or adjust', 'BASE_PRICE_REQUIRED');
    }
    if (p.level === 'product' && p.mode === 'adjust') {
      throw badRequest('The base price has nothing above it to adjust', 'BASE_HAS_NOTHING_TO_ADJUST');
    }

    let after: number | null;
    let writeValue: number | null = null;
    let writeAdjust: number | null = null;
    if (p.mode === 'fixed') {
      after = value;
      writeValue = value;
    } else if (p.mode === 'adjust') {
      // cell.inherited carries the rung's regular surcharge for a member
      // cell (priceGrid cellOf); with nothing beneath, a member adjustment
      // anchors on the rung's own regular price, as the resolver does.
      const anchor =
        cell.inherited !== null
          ? cell.inherited
          : p.field === 'prime' || p.field === 'pro'
            ? row.cells.regular.effective
            : null;
      if (anchor === null) {
        throw badRequest(`${row.label_ar || row.id}: there is no inherited ${p.field} price to adjust`, 'NOTHING_TO_ADJUST');
      }
      writeAdjust = value;
      after = Math.max(0, anchor + (value ?? 0));
    } else {
      after = p.level === 'product' ? null : cell.inherited;
    }

    if (cell.mode === p.mode && cell.value === writeValue && cell.adjust === writeAdjust) continue;

    changes.push({
      level: p.level,
      id: p.id,
      label_ar: row.label_ar,
      label_en: row.label_en,
      field: p.field,
      from_mode: cell.mode,
      to_mode: p.mode,
      from_iqd: cell.effective,
      to_iqd: after,
      from_adjust: cell.adjust,
      write_value: writeValue,
      write_adjust: writeAdjust,
    });
    const bag = afterOf.get(key) ?? {};
    bag[p.field] = after;
    afterOf.set(key, bag);
  }

  if (changes.length === 0) {
    return c.json({ success: true, changed: 0, rows: projectGrid(c.env, admin, rows), guards: [], batch_id: '' });
  }

  // The guard is computed on the RESULT, pairing each row's new prices against
  // its new cost, and only a financial admin can be shown it at all.
  const guards: Guard[] = [];
  if (financial) {
    for (const [key, bag] of afterOf) guards.push(...guardsAfter(byKey.get(key)!, bag, minMargin));
  }
  if (guards.length && !confirm) {
    // Shaped as the API client's refusal envelope (error + code + details) so
    // the drawer can render the warning and offer "confirm" without a second
    // request; a 409 that only said "no" would make the guard a dead end.
    return c.json(
      {
        success: false,
        error: 'This change needs an explicit confirmation',
        code: 'PROFIT_GUARD',
        details: { guards, changes },
      },
      409
    );
  }

  const batchId = newId('pb');
  const { writes, history } = planWrites(changes);
  const stmts = applyWrites(c.env.DB, loaded, productId, writes);
  stmts.push(...historyStatements(c.env.DB, productId, admin.id, batchId, history));
  await c.env.DB.batch(stmts);

  await audit(c.env.DB, admin.id, 'product_v2.quick_price', productId, {
    batch_id: batchId,
    changed: changes.length,
    fields: [...new Set(changes.map((ch) => ch.field))],
    confirmed_guards: guards.length,
  });

  const after = await loadProduct(c.env.DB, productId);
  return c.json({
    success: true,
    changed: changes.length,
    batch_id: batchId,
    changes: projectForAdmin(c.env, admin, changes),
    guards,
    rows: projectGrid(c.env, admin, buildGrid(after.input)),
  });
});

const readScope = (v: unknown): BulkRequest['scope'] => {
  if (!v || typeof v !== 'object') return {};
  const s = v as Record<string, unknown>;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
  return {
    levels: list(s.levels).filter((l): l is Level => l === 'product' || l === 'option' || l === 'color'),
    availability: list(s.availability).map((a) => normalizeAvailability(a)),
    variant_keys: list(s.variant_keys),
    row_ids: list(s.row_ids),
    active_only: s.active_only === true,
  };
};

const BULK_OPS: BulkOp[] = ['add', 'subtract', 'add_percent', 'subtract_percent', 'set', 'inherit', 'adjust'];

/**
 * A bulk move over a scope, ALWAYS previewed first.
 *
 * `apply` is a field on the body rather than a separate endpoint so the preview
 * and the write are provably the same computation over the same input: the
 * apply path calls previewBulk and writes exactly what it returned.
 */
// ---------------------------------------------------------------- traits
//
// The three answers about a row that are NOT prices: what fulfilment route it
// is, how many there are, and whether it is on sale at all.

type TraitField = 'availability_type' | 'stock' | 'active';
const TRAIT_FIELDS: TraitField[] = ['availability_type', 'stock', 'active'];

interface TraitPatch {
  level: Exclude<Level, 'product'>;
  id: string;
  field: TraitField;
  value: unknown;
}

interface TraitChange {
  level: Exclude<Level, 'product'>;
  id: string;
  label: string;
  field: TraitField;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

/**
 * Change availability / stock / active from the SAME drawer as the prices.
 *
 * WHY IT IS NOT A CELL. The price grid's cells are money: they carry an
 * inherit/adjust/fixed mode, a guard against selling under cost, and a row in
 * `price_history`. None of that is true of "is this option a pre-order". Trying
 * to force availability through the cell path would have meant either a mode
 * that means nothing or a history table with a text column bolted on — so this
 * is a sibling list on the same request, sharing the same load, the same
 * authorisation and the same audit line.
 *
 * WHY IT REDERIVES sale_types. `products.sale_types` is read off the options
 * (worker/lib/availability.ts), and everything downstream — the storefront's
 * chooser, the cart's stage set, the pre-order transports — reads THAT. The
 * price grid writes option columns directly, so without this an admin could
 * flip an option to pre-order here and leave a product that still called
 * itself direct sale. The recomputation happens in the same batch as the
 * write, so the two can never be half-applied.
 *
 * WHY THE UNDO IS RETURNED, NOT STORED. `price_history` is a price log with
 * INTEGER columns; a fulfilment route is not a price and does not belong in
 * it. The response carries the exact inverse patch instead, which is what the
 * drawer needs to offer "undo" and is honest about its lifetime: it lasts as
 * long as the screen does, and the audit line is the durable record.
 */
adminPriceGridRoutes.patch('/:id/price-grid/traits', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const raw = Array.isArray(body.traits) ? body.traits : [];
  if (raw.length === 0) throw badRequest('No traits to change', 'NO_TRAITS');
  if (raw.length > 500) throw badRequest('Too many traits in one request', 'TOO_MANY_TRAITS');

  const patches: TraitPatch[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const level = String(item.level ?? '');
    if (level !== 'option' && level !== 'color') {
      // The product itself has no availability of its own to set here: it is
      // the CONCLUSION of its options, and `status` is a different question
      // answered by the product form.
      throw badRequest(`Traits are per option or colour, not ${String(item.level)}`, 'BAD_LEVEL');
    }
    const field = String(item.field ?? '') as TraitField;
    if (!TRAIT_FIELDS.includes(field)) throw badRequest(`Unknown trait: ${String(item.field)}`, 'BAD_TRAIT');
    if (field === 'availability_type' && level !== 'option') {
      throw badRequest('Only an option carries a fulfilment route', 'AVAILABILITY_IS_PER_OPTION');
    }
    patches.push({ level, id: String(item.id ?? ''), field, value: item.value });
  }

  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const byKey = new Map(rows.map((r) => [`${r.level}:${r.id}`, r]));

  const writes: Write[] = [];
  const changes: TraitChange[] = [];
  const undo: Array<{ level: string; id: string; field: TraitField; value: unknown }> = [];
  const nextAvailability = new Map<string, AvailabilityType>();

  for (const p of patches) {
    const row = byKey.get(`${p.level}:${p.id}`);
    if (!row) throw badRequest(`No such row in this product: ${p.level}:${p.id}`, 'ROW_NOT_FOUND');
    const label = row.label_ar || row.label_en || row.id;

    if (p.field === 'availability_type') {
      const before = row.availability_type;
      // '' is a real answer, not a missing one: it means "inherit whatever the
      // product says", which is what every option written before 0043 does.
      const after: AvailabilityType = p.value === '' || p.value === null || p.value === undefined
        ? ''
        : normalizeAvailability(p.value);
      if (after === '' && p.value !== '' && p.value !== null && p.value !== undefined) {
        throw badRequest(`${label}: unknown availability "${String(p.value)}"`, 'BAD_AVAILABILITY');
      }
      if (before === after) continue;
      writes.push({ level: p.level, id: p.id, column: 'availability_type', value: after });
      changes.push({ level: p.level, id: p.id, label, field: p.field, before, after });
      undo.push({ level: p.level, id: p.id, field: p.field, value: before });
      nextAvailability.set(p.id, after);
      continue;
    }

    if (p.field === 'stock') {
      const before = row.stock;
      let after: number | null;
      if (p.value === null || p.value === undefined || p.value === '') {
        // Empty means UNTRACKED, which is not the same as zero — zero is "sold
        // out", untracked is "we do not count these".
        after = null;
      } else {
        const parsed = Number(p.value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw badRequest(`${label}: stock must be a whole number of pieces, or empty`, 'BAD_STOCK');
        }
        after = parsed;
      }
      if (before === after) continue;
      writes.push({ level: p.level, id: p.id, column: 'stock', value: after });
      changes.push({ level: p.level, id: p.id, label, field: p.field, before, after });
      undo.push({ level: p.level, id: p.id, field: p.field, value: before });
      continue;
    }

    const before = row.active;
    const after = p.value === true || p.value === 1 || p.value === '1' || p.value === 'true';
    if (before === after) continue;
    writes.push({ level: p.level, id: p.id, column: 'active', value: after });
    changes.push({ level: p.level, id: p.id, label, field: p.field, before, after });
    undo.push({ level: p.level, id: p.id, field: p.field, value: before });
    // An option switched off stops voting on the product's sale types, exactly
    // as deriveSaleTypes says, so this counts as an availability change too.
    if (p.level === 'option') nextAvailability.set(p.id, after ? row.availability_type : '');
  }

  if (!changes.length) {
    return c.json({ success: true, changed: 0, changes: [], undo: [], sale_types: loaded.input.sale_types ?? [] });
  }

  const stmts = applyWrites(c.env.DB, loaded, productId, writes);

  /**
   * Re-derive the product's sale types from what the options will say AFTER
   * this batch, using the same function the product save uses so the two can
   * never disagree.
   */
  const declared = loaded.input.options.map((o) => {
    const flippedActive = changes.find((ch) => ch.id === o.id && ch.field === 'active');
    const active = flippedActive ? flippedActive.after === true : o.active !== false;
    const availability = nextAvailability.has(o.id)
      ? nextAvailability.get(o.id)!
      : normalizeAvailability(o.availability_type);
    return { availability_type: active ? availability : '', active };
  });
  const fallback = normalizeSaleTypes(
    loaded.input.sale_types,
    String(loaded.input.selling_type ?? 'direct_sale')
  );
  const derived = normalizeSaleTypes(deriveSaleTypes(declared, fallback), fallback[0] ?? 'direct_sale');
  const saleTypesChanged = derived.join(',') !== fallback.join(',');
  if (saleTypesChanged) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE products SET sale_types = ?, selling_type = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(JSON.stringify(derived), derived[0] ?? 'direct_sale', productId)
    );
  }

  await c.env.DB.batch(stmts);
  await audit(c.env.DB, admin.id, 'product.traits_quick_edit', productId, {
    changes: changes.map((ch) => ({ level: ch.level, id: ch.id, field: ch.field, before: ch.before, after: ch.after })),
    sale_types: derived,
  });

  const after = buildGrid((await loadProduct(c.env.DB, productId)).input);
  return c.json({
    success: true,
    changed: changes.length,
    changes,
    /** The exact inverse, for the drawer's undo button. */
    undo,
    sale_types: derived,
    sale_types_changed: saleTypesChanged,
    rows: projectGrid(c.env, admin, after),
  });
});

adminPriceGridRoutes.post('/:id/price-grid/bulk', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const op = String(body.op ?? '') as BulkOp;
  if (!BULK_OPS.includes(op)) throw badRequest(`op must be one of: ${BULK_OPS.join(', ')}`, 'BAD_OP');
  const fields = readFields(body.fields);
  assertMayWrite(c.env, admin, fields);

  let value: number | null = null;
  if (op !== 'inherit') {
    const parsed = parseAmount(body.value);
    if (parsed.error) throw badRequest(`value: ${parsed.error}`, parsed.error);
    value = parsed.value;
    if (value === null) throw badRequest('This operation needs an amount', 'VALUE_REQUIRED');
    if ((op === 'add_percent' || op === 'subtract_percent') && (value <= 0 || value > 1000)) {
      throw badRequest('A percentage must be between 1 and 1000', 'BAD_PERCENT');
    }
  }

  const req: BulkRequest = { op, fields, value, scope: readScope(body.scope) };
  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const financial = canViewFinancials(c.env, admin);
  const minMargin = await getSetting(c.env.DB, 'minMarginPercent');
  const preview = previewBulk(rows, req, financial ? minMargin : null);

  if (body.apply !== true) {
    return c.json({ success: true, preview: projectForAdmin(c.env, admin, preview) });
  }
  if (preview.changes.length === 0) {
    return c.json({ success: true, changed: 0, batch_id: '', preview: projectForAdmin(c.env, admin, preview) });
  }
  if (preview.guards.length && body.confirm !== true) {
    return c.json(
      {
        success: false,
        error: 'This change needs an explicit confirmation',
        code: 'PROFIT_GUARD',
        details: { preview: projectForAdmin(c.env, admin, preview) },
      },
      409
    );
  }

  const batchId = newId('pb');
  const { writes, history } = planWrites(preview.changes);
  const stmts = applyWrites(c.env.DB, loaded, productId, writes);
  stmts.push(...historyStatements(c.env.DB, productId, admin.id, batchId, history));
  await c.env.DB.batch(stmts);

  await audit(c.env.DB, admin.id, 'product_v2.bulk_price', productId, {
    batch_id: batchId,
    op,
    fields,
    value,
    scope: req.scope,
    changed: preview.changes.length,
  });

  const after = await loadProduct(c.env.DB, productId);
  return c.json({
    success: true,
    changed: preview.changes.length,
    batch_id: batchId,
    preview: projectForAdmin(c.env, admin, preview),
    rows: projectGrid(c.env, admin, buildGrid(after.input)),
  });
});

/** Copy one route's or one model's prices onto another's, previewed first. */
adminPriceGridRoutes.post('/:id/price-grid/copy', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const fields = readFields(body.fields);
  assertMayWrite(c.env, admin, fields);

  const side = (v: unknown, label: string): CopyRequest['from'] => {
    if (!v || typeof v !== 'object') throw badRequest(`${label} is required`, 'BAD_COPY_SIDE');
    const s = v as Record<string, unknown>;
    const out: CopyRequest['from'] = {};
    if (s.availability !== undefined) out.availability = normalizeAvailability(s.availability);
    if (s.variant_key !== undefined) out.variant_key = String(s.variant_key);
    if (out.availability === undefined && out.variant_key === undefined) {
      throw badRequest(`${label} must name an availability or a variant`, 'BAD_COPY_SIDE');
    }
    return out;
  };
  const req: CopyRequest = { from: side(body.from, 'from'), to: side(body.to, 'to'), fields };
  if (req.from.availability === req.to.availability && (req.from.variant_key ?? '') === (req.to.variant_key ?? '')) {
    throw badRequest('The source and the destination are the same', 'COPY_SAME_SIDE');
  }

  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const financial = canViewFinancials(c.env, admin);
  const minMargin = await getSetting(c.env.DB, 'minMarginPercent');
  const preview = previewCopy(rows, req, financial ? minMargin : null);

  if (body.apply !== true) {
    return c.json({ success: true, preview: projectForAdmin(c.env, admin, preview) });
  }
  if (preview.changes.length === 0) {
    return c.json({ success: true, changed: 0, batch_id: '', preview: projectForAdmin(c.env, admin, preview) });
  }
  if (preview.guards.length && body.confirm !== true) {
    return c.json(
      {
        success: false,
        error: 'This change needs an explicit confirmation',
        code: 'PROFIT_GUARD',
        details: { preview: projectForAdmin(c.env, admin, preview) },
      },
      409
    );
  }

  const batchId = newId('pb');
  const { writes, history } = planWrites(preview.changes);
  const stmts = applyWrites(c.env.DB, loaded, productId, writes);
  stmts.push(...historyStatements(c.env.DB, productId, admin.id, batchId, history));
  await c.env.DB.batch(stmts);

  await audit(c.env.DB, admin.id, 'product_v2.copy_price', productId, {
    batch_id: batchId,
    from: req.from,
    to: req.to,
    fields,
    changed: preview.changes.length,
  });

  const after = await loadProduct(c.env.DB, productId);
  return c.json({
    success: true,
    changed: preview.changes.length,
    batch_id: batchId,
    preview: projectForAdmin(c.env, admin, preview),
    rows: projectGrid(c.env, admin, buildGrid(after.input)),
  });
});

/**
 * Undo one batch, read backwards out of price_history.
 *
 * WHY THE HISTORY IS THE SOURCE and not a saved copy of the product: the
 * history rows say what each cell WAS, one cell at a time, which is exactly the
 * granularity the undo needs. Restoring a whole snapshot would also revert
 * anything else that changed in between — including someone else's edit — and
 * an undo that silently discards a colleague's work is worse than no undo.
 *
 * The undo is itself recorded as a new batch, so it can be undone in turn and
 * so the seven-day price protection still sees every move the price made.
 *
 * WHAT IT RESTORES is the STORED cell, reconstructed from the value the cell
 * had before the batch: back to inherit when the old value is exactly what the
 * cell would inherit today, and to that fixed number otherwise. The response
 * says which of the two happened per cell in `restored_as` rather than glossing
 * over the difference.
 */
adminPriceGridRoutes.post('/:id/price-grid/undo', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const batchId = str(body.batch_id, 'batch_id', { min: 3, max: 64 });

  const { results } = await c.env.DB.prepare(
    `SELECT variant_key, field, old_iqd, new_iqd, old_mode, old_adjust_iqd
       FROM price_history WHERE product_id = ? AND batch_id = ? ORDER BY id DESC`
  )
    .bind(productId, batchId)
    .all<{
      variant_key: string;
      field: Field;
      old_iqd: number | null;
      new_iqd: number | null;
      old_mode: string | null;
      old_adjust_iqd: number | null;
    }>();
  const back = results ?? [];
  if (back.length === 0) throw notFound('No such price change to undo');
  assertMayWrite(
    c.env,
    admin,
    back.map((r) => r.field)
  );

  const loaded = await loadProduct(c.env.DB, productId);
  const grid = buildGrid(loaded.input);
  const byKey = new Map(grid.map((r) => [`${r.level}:${r.id}`, r]));

  const changes: CellChange[] = [];
  const missing: string[] = [];
  const restoredAs: Array<{ where: string; field: Field; as: PriceMode }> = [];
  const seen = new Set<string>();

  for (const h of back) {
    const key = h.variant_key === '' ? 'product:' : h.variant_key;
    const cellKey = `${key} ${h.field}`;
    // Newest-first, so the first row seen for a cell is the LAST move it made
    // in this batch — the one whose old_iqd is where the cell stood before it.
    if (seen.has(cellKey)) continue;
    seen.add(cellKey);

    const row = byKey.get(key);
    if (!row) {
      missing.push(cellKey);
      continue;
    }
    const cell = row.cells[h.field];
    if (!cell) {
      missing.push(cellKey);
      continue;
    }
    const target = h.old_iqd;
    const canInherit = !(row.level === 'product' && h.field === 'regular');

    /**
     * RESTORE THE MODE, DO NOT RE-DERIVE IT.
     *
     * 0046 records what the cell was. When the row knows, undo puts it back
     * exactly — an adjustment returns as an adjustment and keeps following the
     * level above, instead of being pinned to the number it happened to show.
     * Rows written before 0046 carry old_mode = '' and honestly do not know,
     * so they keep the original inherit-or-fixed reasoning; that is the same
     * behaviour those batches have always had, not a regression introduced
     * here.
     */
    const recorded: PriceMode | '' =
      h.old_mode === 'inherit' || h.old_mode === 'adjust' || h.old_mode === 'fixed' ? h.old_mode : '';
    // The base regular price has nothing above it, so it can be neither
    // inherited nor adjusted however the row is labelled.
    const toMode: PriceMode = recorded
      ? recorded !== 'fixed' && !canInherit
        ? 'fixed'
        : recorded
      : canInherit && (target === null || (row.level !== 'product' && target === cell.inherited))
        ? 'inherit'
        : 'fixed';

    const writeValue = toMode === 'fixed' ? target : null;
    const writeAdjust = toMode === 'adjust' ? h.old_adjust_iqd : null;
    if (cell.mode === toMode && cell.value === writeValue && cell.adjust === writeAdjust) continue;

    restoredAs.push({ where: row.label_ar || row.label_en || row.id, field: h.field, as: toMode });
    changes.push({
      level: row.level,
      id: row.id,
      label_ar: row.label_ar,
      label_en: row.label_en,
      field: h.field,
      from_mode: cell.mode,
      to_mode: toMode,
      from_iqd: cell.effective,
      to_iqd: toMode === 'fixed' ? target : toMode === 'adjust' ? cell.inherited : cell.inherited,
      from_adjust: cell.adjust,
      write_value: writeValue,
      write_adjust: writeAdjust,
    });
  }

  if (changes.length === 0) {
    return c.json({ success: true, changed: 0, batch_id: '', missing, note: 'NOTHING_TO_UNDO' });
  }

  const undoBatch = newId('pb');
  const { writes, history } = planWrites(changes);
  const stmts = applyWrites(c.env.DB, loaded, productId, writes);
  stmts.push(...historyStatements(c.env.DB, productId, admin.id, undoBatch, history));
  await c.env.DB.batch(stmts);

  await audit(c.env.DB, admin.id, 'product_v2.undo_price', productId, {
    undone_batch: batchId,
    batch_id: undoBatch,
    changed: changes.length,
    missing,
  });

  const after = await loadProduct(c.env.DB, productId);
  return c.json({
    success: true,
    changed: changes.length,
    batch_id: undoBatch,
    undone_batch: batchId,
    restored_as: restoredAs,
    missing,
    rows: projectGrid(c.env, admin, buildGrid(after.input)),
  });
});

/**
 * The price timeline. Financial admins only: it carries cost moves, and a cost
 * is a cost whether it is current or historical. It is never served on any
 * public route, and no storefront code calls it.
 */
adminPriceGridRoutes.get('/:id/price-history', async (c) => {
  const admin = c.get('user')!;
  if (!canViewFinancials(c.env, admin)) throw forbidden('Price history is restricted to financial admins');
  const productId = c.req.param('id');
  const limit = int(c.req.query().limit, 'limit', { min: 1, max: 200, def: 60 });
  const offset = int(c.req.query().offset, 'offset', { min: 0, max: 100_000, def: 0 });

  const [list, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT h.id, h.variant_key, h.field, h.old_iqd, h.new_iqd, h.changed_at, h.batch_id,
              COALESCE(NULLIF(u.name, ''), u.email, h.changed_by) AS changed_by_name
         FROM price_history h
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.product_id = ?
        ORDER BY h.id DESC LIMIT ? OFFSET ?`
    )
      .bind(productId, limit, offset)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM price_history WHERE product_id = ?')
      .bind(productId)
      .first<{ n: number }>(),
  ]);

  const loaded = await loadProduct(c.env.DB, productId).catch(() => null);
  const labels = new Map<string, string>();
  if (loaded) {
    for (const o of loaded.input.options) labels.set(`option:${o.id}`, o.name_ar || o.name_en || o.id);
    for (const x of loaded.input.colors) labels.set(`color:${x.id}`, x.name_ar || x.name_en || x.id);
  }

  return c.json({
    success: true,
    total: count?.n ?? 0,
    limit,
    offset,
    entries: (list.results ?? []).map((r) => ({
      id: r.id,
      where: String(r.variant_key ?? '') === '' ? '' : labels.get(String(r.variant_key)) ?? String(r.variant_key),
      variant_key: r.variant_key,
      field: r.field,
      old_iqd: r.old_iqd,
      new_iqd: r.new_iqd,
      changed_at: r.changed_at,
      changed_by: r.changed_by_name,
      batch_id: r.batch_id ?? '',
    })),
  });
});

/**
 * A supplier cost change, shown as a percentage difference before it is
 * accepted, with the selling prices left alone unless the admin asks for a
 * suggestion. This endpoint WRITES NOTHING: the admin applies whichever part
 * they approve through the bulk endpoint above, which is why the suggestion
 * comes back as a ready-made bulk request rather than as prose.
 */
adminPriceGridRoutes.post('/:id/price-grid/cost-change', async (c) => {
  const admin = c.get('user')!;
  if (!canViewFinancials(c.env, admin)) throw forbidden('Cost is restricted to financial admins');
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseAmount(body.new_cost_iqd);
  if (parsed.error) throw badRequest(`new_cost_iqd: ${parsed.error}`, parsed.error);
  if (parsed.value === null || parsed.value < 0) throw badRequest('new_cost_iqd is required', 'VALUE_REQUIRED');
  const newCost = parsed.value;

  const loaded = await loadProduct(c.env.DB, productId);
  const rows = buildGrid(loaded.input);
  const base = rows.find((r) => r.level === 'product')!;
  const oldCost = base.cells.cost.effective;
  const diff = oldCost === null ? null : newCost - oldCost;
  const diffPercent = oldCost === null || oldCost === 0 ? null : Math.round(((newCost - oldCost) / oldCost) * 1000) / 10;

  const minMargin = await getSetting(c.env.DB, 'minMarginPercent');
  const costOnly: BulkRequest = { op: 'set', fields: ['cost'], value: newCost, scope: { levels: ['product'] } };

  // The suggestion keeps every selling price at the margin it has TODAY, which
  // is the only proposal that does not invent a pricing strategy. It is
  // returned, never applied — the admin approves.
  const suggest: BulkRequest | null =
    diffPercent === null || diffPercent === 0
      ? null
      : {
          op: diffPercent < 0 ? 'subtract_percent' : 'add_percent',
          fields: ['regular', 'prime', 'pro'],
          value: Math.abs(diffPercent),
          scope: {},
        };

  return c.json({
    success: true,
    old_cost_iqd: oldCost,
    new_cost_iqd: newCost,
    diff_iqd: diff,
    diff_percent: diffPercent,
    /** Apply this to change the cost and nothing else. */
    cost_only: costOnly,
    cost_only_preview: previewBulk(rows, costOnly, minMargin),
    /** Apply this as well to keep every margin where it stands today. */
    suggest_prices: suggest,
    suggest_prices_preview: suggest ? previewBulk(rows, suggest, minMargin) : null,
    profit_now: profitOf(base.cells.regular.effective, oldCost),
    profit_after_cost_only: profitOf(base.cells.regular.effective, newCost),
  });
});
