/**
 * PARTS AS STORE PRODUCTS — the Worker's half (Programme C, phase C1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.3, §0 row 7).
 *
 * A part is one of the store's own products whose `part_spec` (0164) is not
 * NULL. Nothing about it is a second catalogue: its price, stock, variants,
 * pictures and publish state are the product's. «Inside products only» is
 * `publish_state = 'hidden'`, which 0126's mirror trigger (as recreated by
 * 0152) turns into `status = 'hidden'` — so every storefront, search and
 * community reader, all of which ask `status = 'active'`, already refuses it.
 *
 * THIS FILE HOLDS THE THREE THINGS OTHER CODE MUST NOT RE-DERIVE:
 *
 *   PART_BUYABLE_SQL   the one predicate that lets a part through where a
 *                      blueprint, a quote or a checkout builds it in — its own
 *                      store, published or hidden, not hidden by Levonis, not
 *                      a private (0152) product;
 *   loadStoreParts     the store's parts with their live unit price and stock,
 *                      one row per sellable (product, variant), in ONE query;
 *   the write gate     `readPartSpecInput` / `settlePartSpec`: what a merchant
 *                      product write may store in `part_spec` — a map that
 *                      `readPartSpec` reads back exactly, or 400
 *                      PART_SPEC_INVALID naming the first fact that does not.
 *
 * The client never sets `source` (`levonis:<id>#<option>`): it is written by
 * «من ليفونيس» (worker/routes/merchantParts.ts) and kept across every edit.
 * No public DTO carries `part_spec`; the merchant list says only `is_part`.
 */
import type { VariantModel } from '@levonis/catalog/variants';
import {
  PART_KINDS,
  partSpecToMap,
  readPartSpec,
  type PartDims,
  type PartKind,
  type PartSpec,
} from '@levonis/catalog/personalize/parts';
import { safeParse } from '../types';
import { HttpError } from '../http';
import { variantLabelSql } from '../catalog/sql';

/** Every key the stored flat map may carry, in the Levonis spec group's order. */
export const PART_SPEC_KEYS = [
  'printed_use', 'part_kind', 'part_shape', 'diameter_mm', 'length_mm', 'width_mm', 'height_mm', 'voltage',
  'power_w', 'install_type', 'install_minutes', 'fits_family', 'uses', 'source', 'variant_specs',
] as const;

const KEYS = new Set<string>(PART_SPEC_KEYS);
const LIST_KEYS = new Set(['fits_family', 'uses']);

/** 400 PART_SPEC_INVALID {path} — the one refusal of the part facts. */
export const partSpecInvalid = (path: string) =>
  new HttpError(400, 'A part fact is not valid — check the highlighted field.', 'PART_SPEC_INVALID', { path });

// ------------------------------------------------------------ the predicate

/**
 * SQL: the product row aliased `alias` is a part the store bound at
 * `storeParam` (`?n`) may build into what it sells. Every column is 0126/0152's
 * and every input is an alias chosen in code or a bound parameter.
 */
export function PART_BUYABLE_SQL(alias: string, storeParam: string): string {
  const p = alias;
  return `(${p}.part_spec IS NOT NULL AND ${p}.store_id = ${storeParam} AND ${p}.publish_state IN ('published', 'hidden')`
    + ` AND ${p}.admin_hidden_at IS NULL AND ${p}.audience_user_id IS NULL)`;
}

// ------------------------------------------------------------- the reader

/** One sellable unit of a part: the product (simple) or one of its active variants. */
export interface StorePart {
  product_id: string;
  /** The variant this row prices; null for a product sold without variants. */
  variant_id: string | null;
  name: string;
  name_ar: string;
  /** «أحمر / كبير» — the variant's values, '' for a simple product. */
  label: string;
  /** `/files/<key>`: the variant's own picture, else the product's first. */
  image: string | null;
  /** Whole dinars: the variant's price when it has one, else the product's (resolveCatalogLine's rule). */
  unit_iqd: number;
  stock: number;
  tracked: boolean;
  in_stock: boolean;
  /** The part as THIS row names it: the product's facts with its values' lines over them. */
  spec: PartSpec;
}

const whole = (v: unknown): number => Math.max(0, Math.trunc(Number(v) || 0));

/**
 * The unit a part row costs — `resolveCatalogLine`'s rule (worker/lib/catalog/
 * lines.ts): the variant's own price when it has one, else the product's.
 * Accepts a `loadStoreParts` SQL row (`v_price`) or anything carrying
 * `price_iqd` and an optional `variant_price_iqd`.
 */
export function partUnitIqd(row: { price_iqd?: unknown; v_price?: unknown; variant_price_iqd?: unknown }): number {
  const own = row.v_price ?? row.variant_price_iqd;
  return own === null || own === undefined ? whole(row.price_iqd) : whole(own);
}

/** The product's facts with each of the row's option values' lines laid over them, in value order. */
export function partSpecForValues(spec: PartSpec, valueIds: readonly string[]): PartSpec {
  const { variants, ...base } = spec;
  let out: PartSpec = base;
  for (const id of valueIds) {
    const line: PartDims | undefined = variants?.[id];
    if (line) out = { ...out, ...line };
  }
  return out;
}

/**
 * The store's parts, one row per sellable unit, in ONE statement: the product
 * joined to its active variants, gated by PART_BUYABLE_SQL. A variant product
 * with no active variant sells nothing and yields no row; a product still on
 * the pre-0126 JSON options (`legacy`) is not offered as a part.
 */
export async function loadStoreParts(
  db: D1Database,
  storeId: string,
  opts: { ids?: readonly string[]; kinds?: readonly PartKind[] } = {}
): Promise<StorePart[]> {
  const where = [PART_BUYABLE_SQL('p', '?1'), "p.variant_mode <> 'legacy'"];
  const binds: unknown[] = [storeId];
  if (opts.ids) {
    binds.push(JSON.stringify([...new Set(opts.ids)]));
    where.push(`p.id IN (SELECT value FROM json_each(?${binds.length}))`);
  }
  if (opts.kinds) {
    binds.push(JSON.stringify(opts.kinds.filter((k) => (PART_KINDS as readonly string[]).includes(k))));
    where.push(`json_extract(p.part_spec, '$.part_kind') IN (SELECT value FROM json_each(?${binds.length}))`);
  }
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.name_ar, p.images, p.price_iqd, p.stock, p.track_stock, p.variant_mode, p.part_spec,
              (SELECT json_group_array(x.id) FROM community_product_option_values x WHERE x.product_id = p.id) AS value_ids,
              v.id AS v_id, v.price_iqd AS v_price, v.stock AS v_stock, v.image_key AS v_image,
              v.value1_id, v.value2_id, v.value3_id, ${variantLabelSql('v')} AS v_label
         FROM community_products p
         LEFT JOIN community_product_variants v
           ON v.product_id = p.id AND v.active = 1 AND p.variant_mode = 'variants'
        WHERE ${where.join(' AND ')}
        ORDER BY p.name, p.id, v.position, v.id`
    )
    .bind(...binds)
    .all<Record<string, unknown>>();

  const out: StorePart[] = [];
  for (const r of results ?? []) {
    const variants = r.variant_mode === 'variants';
    if (variants && !r.v_id) continue;
    const spec = readPartSpec(r.part_spec, safeParse<string[]>(r.value_ids, []));
    if (!spec) continue;
    const tracked = !!Number(r.track_stock);
    const stock = Number(variants ? r.v_stock : r.stock) || 0;
    const images = safeParse<unknown[]>(r.images, []).filter((x): x is string => typeof x === 'string');
    out.push({
      product_id: String(r.id),
      variant_id: variants ? String(r.v_id) : null,
      name: String(r.name ?? ''),
      name_ar: String(r.name_ar ?? ''),
      label: variants ? String(r.v_label ?? '') : '',
      image: variants && r.v_image ? `/files/${String(r.v_image)}` : (images[0] ?? null),
      unit_iqd: partUnitIqd(variants ? r : { price_iqd: r.price_iqd }),
      stock,
      tracked,
      in_stock: !tracked || stock > 0,
      spec: variants
        ? partSpecForValues(spec, [r.value1_id, r.value2_id, r.value3_id].filter((x): x is string => typeof x === 'string' && !!x))
        : partSpecForValues(spec, []),
    });
  }
  return out;
}

// ------------------------------------------------------------ the write gate

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * WHAT A MERCHANT WRITE MAY STORE, OR WHERE IT IS WRONG.
 *
 * Strict where `readPartSpec` is lenient: a fact the body states and the
 * reader cannot read back is refused with its path, never dropped in silence.
 * `null` clears the part (the product is no longer a part). The body's
 * `source` is ignored — the server owns it (`settlePartSpec` keeps the stored
 * one). With `optionValueIds`, a `variant_specs` line must name one of them.
 */
export function readPartSpecInput(
  raw: unknown,
  optionValueIds?: readonly string[]
): { ok: true; map: Record<string, string> | null } | { ok: false; path: string } {
  if (raw === null) return { ok: true, map: null };
  if (!isPlainObject(raw)) return { ok: false, path: 'part_spec' };
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KEYS.has(k)) return { ok: false, path: `part_spec.${k}` };
    if (k === 'source') continue;
    if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null || (LIST_KEYS.has(k) && Array.isArray(v)))) {
      return { ok: false, path: `part_spec.${k}` };
    }
    input[k] = v;
  }
  const spec = readPartSpec(input, optionValueIds);
  if (!spec) return { ok: false, path: blank(input.printed_use) || /^yes$/i.test(String(input.printed_use).trim()) ? 'part_spec.part_kind' : 'part_spec.printed_use' };
  const map = partSpecToMap(spec);
  for (const [k, v] of Object.entries(input)) {
    if (k === 'variant_specs' || k === 'printed_use' || blank(v)) continue;
    if (LIST_KEYS.has(k)) {
      const items = Array.isArray(v) ? v : String(v).split(/[,،;؛\n]/);
      if (items.length > 12 || items.some((x) => typeof x !== 'string' || x.trim().length > 40)) return { ok: false, path: `part_spec.${k}` };
      continue;
    }
    if (k === 'install_type' && String(v).trim().length > 60) return { ok: false, path: `part_spec.${k}` };
    if (map[k] === undefined) return { ok: false, path: `part_spec.${k}` };
  }
  // Every non-blank line names a value of THIS product and every fact on it reads.
  if (!blank(input.variant_specs)) {
    if (typeof input.variant_specs !== 'string' || input.variant_specs.length > 4000) return { ok: false, path: 'part_spec.variant_specs' };
    for (const line of input.variant_specs.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^\s*([^:=\s][^:=]{0,79}?)\s*:\s*(.+)$/.exec(line);
      if (!m) return { ok: false, path: 'part_spec.variant_specs' };
      for (const pair of m[2].split(/[,;،؛]/)) {
        if (!pair.trim()) continue;
        const one = readPartSpec({ part_kind: 'other', variant_specs: `${m[1]}: ${pair}` }, optionValueIds);
        const facts = one?.variants ? Object.values(one.variants)[0] : undefined;
        if (!facts || Object.keys(facts).length !== 1) return { ok: false, path: 'part_spec.variant_specs' };
      }
    }
  }
  return { ok: true, map };
}

/** The option value ids a product will have after this write: the model's kept ones, or the stored ones. */
async function valueIdsAfterWrite(db: D1Database, productId: string | null, model: VariantModel | undefined): Promise<string[]> {
  if (!productId) return [];
  const { results } = await db
    .prepare('SELECT id FROM community_product_option_values WHERE product_id = ?')
    .bind(productId)
    .all<{ id: string }>();
  const stored = (results ?? []).map((r) => r.id);
  if (!model) return stored;
  // `variantModelStatements` keeps a value's id only when the model names it
  // by that id; a new value's id is minted in the batch and cannot be named yet.
  const refs = new Set(model.groups.flatMap((g) => g.values.map((v) => v.ref)));
  return stored.filter((id) => refs.has(id));
}

/**
 * THE COLUMN VALUE A PRODUCT WRITE STORES — called by POST and PATCH
 * /api/merchant/products after `readProductInput` put the body's map in
 * `fields.part_spec`. Re-reads it against the product's own option values
 * (400 PART_SPEC_INVALID on a line naming anything else) and keeps the
 * server-owned `source`. No-op when the body did not send `part_spec`.
 */
export async function settlePartSpec(
  db: D1Database,
  merchantId: string,
  productId: string | null,
  input: { fields: Record<string, unknown>; variantModel?: VariantModel }
): Promise<void> {
  const sent = input.fields.part_spec;
  if (sent === undefined) return;
  if (sent === null) return;
  const draft = safeParse<Record<string, unknown> | null>(sent, null);
  const ids = await valueIdsAfterWrite(db, productId, input.variantModel);
  const read = readPartSpecInput(draft, ids);
  if (!read.ok) throw partSpecInvalid(read.path);
  if (!read.map) {
    input.fields.part_spec = null;
    return;
  }
  if (productId) {
    const stored = await db
      .prepare('SELECT part_spec FROM community_products WHERE id = ? AND merchant_id = ?')
      .bind(productId, merchantId)
      .first<{ part_spec: string | null }>();
    const source = readPartSpec(stored?.part_spec ?? null)?.source;
    if (source) read.map.source = source;
  }
  input.fields.part_spec = JSON.stringify(read.map);
}

/** The merchant's own read of the column: the stored map, or null. Never on a public DTO. */
export function partSpecOut(raw: unknown): Record<string, string> | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const map = safeParse<Record<string, unknown> | null>(raw, null);
  if (!isPlainObject(map)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (KEYS.has(k) && typeof v === 'string') out[k] = v;
  return out;
}
