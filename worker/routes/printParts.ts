/**
 * «من ليفونيس» — THE LEVONIS ITEMS A MERCHANT MAY BUILD INTO WHAT THEY PRINT
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 row «From
 * Levonis»).
 *
 *   GET /api/products/print-parts?kind&q&cursor
 *
 * Levonis products whose `printed_part` spec group (worker/lib/templateFamilies.ts)
 * says `printed_use = Yes`, visible by the predicate the public product list
 * uses (`status = 'active'`), 24 to a page with an exact `next_cursor` (the
 * statement reads 25). Each carries the GUEST price — through the same resolver
 * the product page and the checkout use — an `in_stock` boolean, never a
 * count, and the part in words in the three languages.
 *
 * Mounted on /api/products BEFORE `/:slug`, exactly like `/print-calculator`
 * (worker/routes/products.ts), so the literal path is never read as a product
 * slug. The same body answers every viewer — nothing here is priced for the
 * caller — so it is edge-cached for guests with its three declared params
 * (worker/lib/edgePolicy.ts) and needs no `Vary: Cookie`.
 *
 * `readLevonisPart` is the one read «من ليفونيس» (worker/routes/merchantParts.ts)
 * imports and refreshes through, so the sheet and the import can never
 * disagree about what an item is.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { badRequest } from '../lib/http';
import { anonymousCached } from '../lib/edgePolicy';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { canonicalProductMedia } from '../lib/productModel';
import {
  PART_KINDS,
  partSpecWords,
  readPartSpec,
  type PartDims,
  type PartKind,
  type PartLang,
  type PartSpec,
} from '@levonis/catalog/personalize/parts';

export const printPartsRoutes = new Hono<AppContext>();

/** The query parameters that may change the answer — the edge key is built from these and nothing else. */
export const PRINT_PARTS_PARAMS: readonly string[] = ['kind', 'q', 'cursor'];

export const PRINT_PARTS_PAGE = 24;

const LANGS: readonly PartLang[] = ['ar', 'en', 'ckb'];

export type PartWords = Record<PartLang, string>;

export interface LevonisPartOption {
  /** The option value's id — what `levonis:<id>#<key>` names. */
  key: string;
  name: string;
  name_ar: string;
  name_ckb: string;
  /** The guest price of this option, whole dinars. */
  price_iqd: number;
  in_stock: boolean;
  /** `/files/<key>` of the option's own picture, when it has one. */
  image: string | null;
  words: PartWords;
}

export interface LevonisPart {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb: string;
  description: string;
  description_ar: string;
  /** The cheapest way to buy it as a guest: its cheapest option, else its own price. */
  price_iqd: number;
  in_stock: boolean;
  image: string | null;
  /** The canonical gallery (R2 keys), primary first. */
  gallery: string[];
  net_weight_g: number | null;
  kind: PartKind;
  words: PartWords;
  /** The facts, with per-option lines keyed by the option's id. */
  spec: PartSpec;
  /** The English name of the option group `options` come from ('' when none). */
  option_group: string;
  options: LevonisPartOption[];
}

const words = (spec: PartSpec, variant?: string | null): PartWords =>
  Object.fromEntries(LANGS.map((l) => [l, partSpecWords(spec, l, variant)])) as PartWords;

/** SQL over `products p`: a live item the admin marked «يُستخدم داخل منتجات مطبوعة». */
const PRINTED_USE_SQL = `p.status = 'active'
  AND LOWER(TRIM(COALESCE(CASE WHEN json_valid(p.spec_fields) THEN json_extract(p.spec_fields, '$.printed_use') END, ''))) = 'yes'`;

/** The admin's kind word as `readPartSpec` reads it: lower-cased, spaces, dashes and underscores gone. */
const KIND_SQL = `LOWER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(CASE WHEN json_valid(p.spec_fields)
  THEN json_extract(p.spec_fields, '$.part_kind') END, '')), ' ', ''), '-', ''), '_', ''))`;

/**
 * Full `products` rows → the parts they describe, through the ONE pricing path
 * (`resolveVariantPricing` at a guest's context). A row whose spec does not
 * read as a part is dropped, never guessed at. Only the options of the item's
 * FIRST option group are offered — a part is sold by one axis (its size); a
 * second axis and colours are not part facts in C1.
 */
export async function readLevonisParts(db: D1Database, rows: Record<string, unknown>[]): Promise<LevonisPart[]> {
  if (!rows.length) return [];
  // Imported here, not at the top: products.ts mounts this router, and a
  // static import back into it would be a module cycle.
  const { pricingCtxForUser, resolveVariantPricing } = await import('./products');
  const ctx = await pricingCtxForUser(db, null);
  const priced = await resolveVariantPricing(db, rows, ctx);
  const out: LevonisPart[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const vp = priced.get(id);
    if (!vp) continue;
    const all = vp.options.filter((o) => !o.option.merged_into);
    const group = all[0]?.option.group_en ?? '';
    const options = all.filter((o) => (o.option.group_en ?? '') === group);
    const lineKeys = options.flatMap((o) => [o.option.id, o.option.variant_key ?? ''].filter(Boolean));
    const read = readPartSpec(safeParse<Record<string, unknown>>(String(row.spec_fields ?? '{}'), {}), lineKeys);
    if (!read) continue;
    // Lines keyed by an option's variant_key are re-keyed by its id, so a
    // source (`levonis:<id>#<option id>`) names them one way only.
    const byId: Record<string, PartDims> = {};
    for (const o of options) {
      const line = read.variants?.[o.option.id] ?? (o.option.variant_key ? read.variants?.[o.option.variant_key] : undefined);
      if (line) byId[o.option.id] = line;
    }
    const spec: PartSpec = { ...read };
    delete spec.variants;
    if (Object.keys(byId).length) spec.variants = byId;
    const gallery = canonicalProductMedia(vp.doc.media).map((m) => m.key).filter(Boolean);
    const optionRows: LevonisPartOption[] = options.map((o) => ({
      key: o.option.id,
      name: o.option.name_en,
      name_ar: o.option.name_ar,
      name_ckb: o.option.name_ckb,
      price_iqd: Math.max(0, Math.trunc(o.level.applied_iqd)),
      in_stock: o.available === null || o.available > 0,
      image: typeof o.option.image === 'string' && o.option.image.startsWith('/files/') ? o.option.image : null,
      words: words(spec, o.option.id),
    }));
    const stock = row.stock === null || row.stock === undefined ? null : Number(row.stock) - Number(row.stock_reserved ?? 0);
    const weight = Number(row.net_weight_g);
    out.push({
      id,
      slug: String(row.slug ?? ''),
      name: String(row.name ?? ''),
      name_ar: String(row.name_ar ?? ''),
      name_ckb: String(row.name_ku ?? ''),
      description: String(row.description ?? ''),
      description_ar: String(row.description_ar ?? ''),
      price_iqd: optionRows.length
        ? Math.min(...optionRows.map((o) => o.price_iqd))
        : Math.max(0, Math.trunc(vp.base.applied_iqd)),
      in_stock: optionRows.length ? optionRows.some((o) => o.in_stock) : stock === null || stock > 0,
      image: gallery[0] ? `/files/${gallery[0]}` : null,
      gallery,
      net_weight_g: Number.isFinite(weight) && weight > 0 ? Math.round(weight) : null,
      kind: spec.kind,
      words: words(spec),
      spec,
      option_group: group,
      options: optionRows,
    });
  }
  return out;
}

/** One Levonis item as a part, or null when it is not live or not marked «يُستخدم داخل منتجات مطبوعة». */
export async function readLevonisPart(db: D1Database, productId: string): Promise<LevonisPart | null> {
  const row = await db
    .prepare(`SELECT * FROM products p WHERE p.id = ? AND ${PRINTED_USE_SQL}`)
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return (await readLevonisParts(db, [row]))[0] ?? null;
}

// ------------------------------------------------------------------ cursor

function encodeCursor(name: string, id: string): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify([name, id])))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string): { name: string; id: string } | null {
  if (!raw) return null;
  try {
    const b = raw.slice(0, 400).replace(/-/g, '+').replace(/_/g, '/');
    const v = JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return { name: v[0], id: v[1] };
  } catch {
    /* not ours */
  }
  throw badRequest('That list position is not valid any more — reload the list', 'CURSOR_INVALID');
}

/** The card the sheet lists: no description, no gallery, no raw spec — the words say it. */
function card(p: LevonisPart) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    name_ar: p.name_ar,
    name_ckb: p.name_ckb,
    price_iqd: p.price_iqd,
    in_stock: p.in_stock,
    image: p.image,
    kind: p.kind,
    words: p.words,
    options: p.options.map((o) => ({
      key: o.key,
      name: o.name,
      name_ar: o.name_ar,
      name_ckb: o.name_ckb,
      price_iqd: o.price_iqd,
      in_stock: o.in_stock,
      words: o.words,
    })),
  };
}

printPartsRoutes.get('/', (c) =>
  anonymousCached(c, { params: PRINT_PARTS_PARAMS }, async () => {
    const db = c.env.DB;
    const kindRaw = String(c.req.query('kind') ?? '').trim().toLowerCase();
    const kind = (PART_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : '';
    const q = String(c.req.query('q') ?? '').trim().slice(0, 60);
    const cursor = decodeCursor(String(c.req.query('cursor') ?? ''));

    const where = [PRINTED_USE_SQL];
    const binds: unknown[] = [];
    if (kind) {
      where.push(`${KIND_SQL} = ?`);
      binds.push(kind);
    }
    if (q) {
      const like = likePattern(q);
      where.push(`(${sqlLikeClause(['p.name', 'p.name_ar', 'p.name_ku'])})`);
      binds.push(like, like, like);
    }
    if (cursor) {
      where.push('(p.name > ? OR (p.name = ? AND p.id > ?))');
      binds.push(cursor.name, cursor.name, cursor.id);
    }
    const { results } = await db
      .prepare(`SELECT * FROM products p WHERE ${where.join(' AND ')} ORDER BY p.name, p.id LIMIT ?`)
      .bind(...binds, PRINT_PARTS_PAGE + 1)
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    const page = rows.slice(0, PRINT_PARTS_PAGE);
    const last = page[page.length - 1];
    const parts = await readLevonisParts(db, page);
    return c.json({
      success: true,
      parts: parts.map(card),
      next_cursor: rows.length > PRINT_PARTS_PAGE && last ? encodeCursor(String(last.name ?? ''), String(last.id)) : null,
    });
  })
);
