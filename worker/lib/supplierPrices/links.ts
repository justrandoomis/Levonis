/**
 * «روابط المورّد» — THE OWNER'S SUPPLIER LINKS (docs/SMART_PRICING.md §3.9;
 * the owner's request of 2026-10-31, DECISIONS row 278: "for tmall saved id of
 * every product and link for admin so here can easily found the product by tap
 * on link to order it or update the price").
 *
 * For every Levonis product with supplier matches (`confirmed` — by the owner
 * or automatically — or `suggested`) or with the owner's own price, per
 * sellable SKU (its combo key and its option and colour names in ar / en /
 * ckb): the source, the match state (auto / confirmed / suggested / manual),
 * the Tmall item id or store handle and the SKU id, the item's title (Chinese
 * and English on Tmall), the captured price with its currency, price label and
 * capture date, and the links that open the item and that exact option.
 *
 *   GET /links?q=&source=&cursor=   25 products a page, the most recently
 *                                   linked or priced first; `q` takes the
 *                                   lookup's forms (worker/lib/supplierPrices/
 *                                   lookup.ts) or words of the product name
 *   GET /links/:product_id          one product, in the same shape
 *
 * THE LINKS ARE BUILT, NEVER COPIED: only by packages/catalog/src/supplierPrices/
 * links.ts, only from validated ids (digits-only Tmall ids and store variant
 * ids, `[a-z0-9-]` handles), https only, EU links with `skr=yes`. A stored
 * `url` or `evidence_url`, a title, an option or the owner's search never
 * becomes a link and is never answered; an id that fails gets `null`.
 *
 * THE PRICE comes from the SKU row of the source's CURRENT complete snapshot
 * (ux_sps_current), the row an estimate reads (§3.7). A key missing from it
 * keeps its links and shows no price (`missing`), so the owner can open the
 * page and check.
 *
 * Owner-only (I6). Every supplier datum sits under `supplier_prices`, a
 * FINANCIAL_FIELDS name, so `stripFinancials` — the second net — drops the
 * whole list from any payload projected for a non-owner. Reads only: «تحديث
 * السعر» goes through the manual entry and the one-page store read, which call
 * assertCostWrite.
 *
 * DEPLOY-AHEAD: on a database without 0218 both routes answer an empty list.
 */
import { isMissingEstimateSchema } from '../priceEstimateLabel';
import { inputInvalid } from '../pricingEngine/whatIf';
import { supplierItemUrl, supplierSkuUrl } from '@levonis/catalog/supplierPrices/links';
import {
  EMPTY_TOKEN,
  SOURCE_CURRENCY,
  isSupplierCurrency,
  isSupplierSource,
  loadProductSkus,
  type ProductSkus,
  type SupplierCurrency,
  type SupplierSource,
} from './store';
import { likePatternsOf, parseSupplierQuery, searchWords, type SupplierQuery } from './lookup';
import { sqlLikeClause } from '../sqlLike';

/** Products per page of the Links tab. */
export const LINKS_PAGE = 25;

export type LinkState = 'auto' | 'confirmed' | 'suggested' | 'rejected' | 'manual';
export type LinkSource = SupplierSource | 'typed' | 'store_page';

/** One supplier fact of one SKU: a match (any source) or the owner's own price. */
export interface SupplierLink {
  source: LinkSource;
  state: LinkState;
  /** The Tmall item id or the store handle (null for the owner's own price). */
  item_key: string | null;
  /** The Tmall SKU id or the store variant id. */
  sku_key: string | null;
  /** The item's title as the source writes it, and in English (null when the key left the catalogue). */
  title: string | null;
  name_en: string | null;
  options: Record<string, string> | null;
  options_en: Record<string, string> | null;
  /** The codes the capture read on the item and the SKU (part and colour codes, the Bambu SKU code). */
  codes: string[];
  /** The captured price (or the owner's), decimal text, in `currency`; null when the key left the catalogue. */
  price: string | null;
  currency: SupplierCurrency | null;
  /** The words printed beside the price (Tmall: 优惠前), never a figure. */
  price_label: string | null;
  /** The capture date of the price's snapshot, or the day the owner entered his price. */
  captured_on: string | null;
  quantity: number | null;
  /** https only, built from validated ids; null when an id fails its grammar. */
  item_url: string | null;
  sku_url: string | null;
  /** A confirmed or suggested key absent from its source's current complete snapshot (EST_SOURCE_ITEM_MISSING). */
  missing: boolean;
  match_confidence: string | null;
  match_method: string | null;
  match_reasons: string[];
  units_per_offer: number;
  decided_at: string | null;
  /** The owner's note on his own price ('' otherwise). */
  note: string;
}

export interface LinkSku {
  combo_key: string;
  labels: { ar: string; en: string; ckb: string };
  /** FINANCIAL_FIELDS name: every supplier fact of this SKU. */
  supplier_prices: SupplierLink[];
}

export interface ProductLinks {
  product_id: string;
  name: string;
  names: { ar: string; en: string; ckb: string };
  /** The tokens a decision carries back (PUT /matches, PUT /manual): any change in between refuses PRICING_CHANGED. */
  versions: { matches: string; manual: string };
  skus: LinkSku[];
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const rowState = (state: unknown, decidedBy: unknown): LinkState =>
  state === 'suggested' ? 'suggested' : state === 'rejected' ? 'rejected' : decidedBy === 'auto' ? 'auto' : 'confirmed';

const STATE_ORDER: Record<LinkState, number> = { manual: 0, confirmed: 1, auto: 2, suggested: 3, rejected: 4 };
const SOURCE_ORDER: Record<LinkSource, number> = { typed: 0, store_page: 1, tmall_cn: 2, bambu_eu: 3, bambu_us: 4 };

export interface ViewOptions {
  /** The match states answered (the Links tab: confirmed and suggested; the review: every state). */
  states: ReadonlySet<'confirmed' | 'suggested' | 'rejected'>;
  /** Whether the owner's own prices are answered. */
  manual: boolean;
  /** Only this source's matches. */
  source?: SupplierSource | null;
  /** The products as the caller already loaded them (`loadProductSkus`), so they are not read twice. */
  loaded?: ReadonlyMap<string, ProductSkus>;
}

/**
 * The supplier view of each product named: its sellable SKUs, each with its
 * supplier facts. One batch of four reads after the products themselves,
 * whatever their number. An unknown product is absent; a database without
 * 0218 answers no product.
 */
export async function productLinkViews(db: D1Database, ids: readonly string[], opts: ViewOptions): Promise<Map<string, ProductLinks>> {
  const out = new Map<string, ProductLinks>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const list = JSON.stringify(unique);
  const states = JSON.stringify([...opts.states]);
  let answers: Array<{ results?: Array<Record<string, unknown>> }>;
  try {
    answers = (await db.batch([
      db
        .prepare(
          `SELECT m.product_id, m.combo_key, m.source, m.item_key, m.sku_key, m.state, m.confidence, m.method, m.reasons_json,
                  m.units_per_offer, m.decided_by, m.decided_at,
                  s.captured_on, i.title, i.name_en, i.codes_json AS item_codes, k.options_json, k.options_en_json,
                  k.codes_json AS sku_codes, k.sku_code, k.price, k.price_label, k.quantity,
                  (k.sku_key IS NOT NULL) AS present
             FROM supplier_price_matches m
             LEFT JOIN supplier_price_snapshots s ON s.source = m.source AND s.state = 'complete'
             LEFT JOIN supplier_price_items i ON i.snapshot_id = s.id AND i.item_key = m.item_key
             LEFT JOIN supplier_price_skus k ON k.snapshot_id = s.id AND k.item_key = m.item_key AND k.sku_key = m.sku_key
            WHERE m.product_id IN (SELECT value FROM json_each(?1)) AND m.state IN (SELECT value FROM json_each(?2))
              AND (?3 = '' OR m.source = ?3)`
        )
        .bind(list, states, opts.source ?? ''),
      db
        .prepare(
          `SELECT product_id, combo_key, amount, currency, origin, note, entered_at
             FROM supplier_price_manual WHERE ?2 = 1 AND product_id IN (SELECT value FROM json_each(?1))`
        )
        .bind(list, opts.manual ? 1 : 0),
      db
        .prepare(
          `SELECT product_id, COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(updated_at), '') AS token
             FROM supplier_price_matches WHERE product_id IN (SELECT value FROM json_each(?1)) GROUP BY product_id`
        )
        .bind(list),
      db
        .prepare(
          `SELECT product_id, COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(entered_at), '') AS token
             FROM supplier_price_manual WHERE product_id IN (SELECT value FROM json_each(?1)) GROUP BY product_id`
        )
        .bind(list),
    ])) as Array<{ results?: Array<Record<string, unknown>> }>;
  } catch (e) {
    if (isMissingEstimateSchema(e)) return out;
    throw e;
  }
  const [matchRes, manualRes, matchTokens, manualTokens] = answers;
  const products = opts.loaded && unique.every((id) => opts.loaded!.has(id)) ? opts.loaded : await loadProductSkus(db, unique);

  const linksBy = new Map<string, SupplierLink[]>();
  const add = (pid: string, combo: string, l: SupplierLink) => {
    const k = `${pid}\u0000${combo}`;
    if (!linksBy.has(k)) linksBy.set(k, []);
    linksBy.get(k)!.push(l);
  };
  for (const m of matchRes?.results ?? []) {
    if (!isSupplierSource(m.source)) continue;
    const source = m.source;
    const itemKey = String(m.item_key);
    const skuKey = String(m.sku_key);
    const present = Number(m.present) === 1;
    const reasons = parseJson<unknown[]>(m.reasons_json, []).filter((x): x is string => typeof x === 'string');
    const codes = [...parseJson<unknown[]>(m.item_codes, []), ...parseJson<unknown[]>(m.sku_codes, []), m.sku_code].filter(
      (x): x is string => typeof x === 'string' && x !== ''
    );
    add(String(m.product_id), String(m.combo_key), {
      source,
      state: rowState(m.state, m.decided_by),
      item_key: itemKey,
      sku_key: skuKey,
      title: m.title === null || m.title === undefined ? null : String(m.title),
      name_en: m.name_en === null || m.name_en === undefined ? null : String(m.name_en),
      options: present ? parseJson<Record<string, string>>(m.options_json, {}) : null,
      options_en: present ? parseJson<Record<string, string>>(m.options_en_json, {}) : null,
      codes: [...new Set(codes)],
      price: present && m.price !== null && m.price !== undefined ? String(m.price) : null,
      currency: SOURCE_CURRENCY[source],
      price_label: present ? String(m.price_label ?? '') : null,
      captured_on: present && m.captured_on ? String(m.captured_on) : null,
      quantity: present && m.quantity !== null && m.quantity !== undefined ? Number(m.quantity) : null,
      item_url: supplierItemUrl(source, itemKey),
      sku_url: supplierSkuUrl(source, itemKey, skuKey),
      missing: !present,
      match_confidence: String(m.confidence ?? ''),
      match_method: String(m.method ?? ''),
      match_reasons: reasons,
      units_per_offer: Number(m.units_per_offer ?? 1) || 1,
      decided_at: m.decided_at ? String(m.decided_at) : null,
      note: '',
    });
  }
  for (const r of manualRes?.results ?? []) {
    const origin: LinkSource = r.origin === 'store_page' ? 'store_page' : 'typed';
    add(String(r.product_id), String(r.combo_key), {
      source: origin,
      state: 'manual',
      item_key: null,
      sku_key: null,
      title: null,
      name_en: null,
      options: null,
      options_en: null,
      codes: [],
      price: String(r.amount),
      currency: isSupplierCurrency(r.currency) ? r.currency : null,
      price_label: null,
      captured_on: r.entered_at ? String(r.entered_at).slice(0, 10) : null,
      quantity: null,
      // The evidence address is never answered, nor turned into a link (§3.9).
      item_url: null,
      sku_url: null,
      missing: false,
      match_confidence: null,
      match_method: null,
      match_reasons: [],
      units_per_offer: 1,
      decided_at: r.entered_at ? String(r.entered_at) : null,
      note: String(r.note ?? ''),
    });
  }
  const tokenOf = (rows: Array<Record<string, unknown>> | undefined, pid: string) =>
    String(rows?.find((t) => String(t.product_id) === pid)?.token ?? EMPTY_TOKEN);

  for (const pid of unique) {
    const p = products.get(pid);
    if (!p) continue;
    const order = (a: SupplierLink, b: SupplierLink) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || String(a.item_key).localeCompare(String(b.item_key));
    const skus: LinkSku[] = (p.skus ?? []).map((s) => ({
      combo_key: s.combo_key,
      labels: s.labels,
      supplier_prices: (linksBy.get(`${pid}\u0000${s.combo_key}`) ?? []).sort(order),
    }));
    // A grid too large for the engine lists only the SKUs that carry a fact.
    if (p.skus === null) {
      for (const [k, links] of linksBy) {
        const [owner, combo] = k.split('\u0000') as [string, string];
        if (owner === pid) skus.push({ combo_key: combo, labels: { ar: '', en: '', ckb: '' }, supplier_prices: links.sort(order) });
      }
    }
    out.set(pid, {
      product_id: pid,
      name: p.name,
      names: p.names,
      versions: { matches: tokenOf(matchTokens?.results, pid), manual: tokenOf(manualTokens?.results, pid) },
      skus,
    });
  }
  return out;
}

const LINK_STATES = new Set<'confirmed' | 'suggested'>(['confirmed', 'suggested']);

/** Whether a view carries any supplier fact (a product with none answers an empty list). */
export const hasLinks = (v: ProductLinks): boolean => v.skus.some((s) => s.supplier_prices.length > 0);

/** GET /links/:product_id: the product, or no product when it has no match and no price of the owner's. */
export async function productLinks(db: D1Database, productId: string): Promise<ProductLinks[]> {
  const view = (await productLinkViews(db, [productId], { states: LINK_STATES, manual: true })).get(productId);
  return view && hasLinks(view) ? [view] : [];
}

// ---------------------------------------------------------------- the paged list

function base64url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The opaque cursor: the last row's stamp and product id. */
export const encodeLinksCursor = (t: string, id: string): string => base64url(JSON.stringify([t, id]));

export function decodeLinksCursor(raw: unknown): { t: string; id: string } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw inputInvalid('cursor');
  try {
    const v = JSON.parse(fromBase64url(raw)) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length <= 40 && v[1].length <= 120) return { t: v[0], id: v[1] };
  } catch {
    /* refused below */
  }
  throw inputInvalid('cursor');
}

/**
 * The products a search names, from every reading of the owner's text: the
 * matched items and SKUs it names (ids, handles, colour, part and SKU codes,
 * title words), the import's own ids and handle, and the product's names.
 * null: no search.
 */
async function idsForQuery(db: D1Database, q: SupplierQuery, raw: string): Promise<string[] | null> {
  if (q.kind === 'empty') return null;
  const LIVE = "m.state IN ('confirmed', 'suggested')";
  const byMatchKey = (column: 'item_key' | 'sku_key', value: string, source: SupplierSource | null) =>
    db
      .prepare(`SELECT DISTINCT m.product_id FROM supplier_price_matches m WHERE ${LIVE} AND m.${column} = ?1 AND (?2 = '' OR m.source = ?2) LIMIT 500`)
      .bind(value, source ?? '');
  const byCatalogueKey = (type: string, value: string) =>
    db
      .prepare(
        `SELECT DISTINCT m.product_id
           FROM supplier_price_keys k
           JOIN supplier_price_snapshots s ON s.id = k.snapshot_id AND s.state = 'complete'
           JOIN supplier_price_matches m ON m.source = s.source AND m.item_key = k.item_key AND (k.sku_key = '' OR m.sku_key = k.sku_key)
          WHERE k.key_type = ?1 AND k.key_value = ?2 AND ${LIVE} LIMIT 500`
      )
      .bind(type, value);
  const byExternalId = (types: readonly string[], value: string) =>
    db
      .prepare('SELECT DISTINCT product_id FROM product_external_ids WHERE id_type IN (SELECT value FROM json_each(?1)) AND value = ?2 LIMIT 500')
      .bind(JSON.stringify(types), value);
  const byHandle = (handle: string) => db.prepare('SELECT DISTINCT product_id FROM product_source_refs WHERE source_handle = ?1 LIMIT 500').bind(handle);
  /** Every word's bound pattern (`likePattern`) must be in the product's names, or in the matched item's titles. */
  const byWords = (words: readonly string[]): D1PreparedStatement[] => {
    const patterns = likePatternsOf(words);
    if (!patterns.length) return [];
    const each = (column: string) => patterns.map((_, n) => sqlLikeClause([column], `?${n + 1}`)).join(' AND ');
    return [
      db.prepare(`SELECT p.id AS product_id FROM products p WHERE ${each("(p.name || ' ' || p.name_ar || ' ' || p.name_ku)")} LIMIT 500`).bind(...patterns),
      db
        .prepare(
          `SELECT DISTINCT m.product_id
             FROM supplier_price_matches m
             JOIN supplier_price_snapshots s ON s.source = m.source AND s.state = 'complete'
             JOIN supplier_price_items i ON i.snapshot_id = s.id AND i.item_key = m.item_key
            WHERE ${LIVE} AND ${each("(i.title || ' ' || i.name_en)")} LIMIT 500`
        )
        .bind(...patterns),
    ];
  };

  const statements: D1PreparedStatement[] = [];
  switch (q.kind) {
    case 'tmall_url':
      statements.push(byMatchKey('item_key', q.item_key, 'tmall_cn'));
      break;
    case 'store_url':
      statements.push(byMatchKey('item_key', q.item_key, q.source), byHandle(q.item_key));
      break;
    case 'digits':
      statements.push(byMatchKey('item_key', q.value, null), byMatchKey('sku_key', q.value, null), byExternalId(['bambu_variant_id', 'color_code', 'part_code'], q.value));
      if (q.value.length === 5) statements.push(byCatalogueKey('color_code', q.value));
      break;
    case 'code':
      if (q.part_code) statements.push(byCatalogueKey('part_code', q.part_code), byExternalId(['part_code', 'bambu_sku_code'], q.part_code));
      if (q.sku_code) statements.push(byCatalogueKey('sku_code', q.sku_code), byExternalId(['bambu_sku_code'], q.sku_code));
      break;
    case 'handle':
      statements.push(byMatchKey('item_key', q.item_key, null), byHandle(q.item_key), ...byWords(q.words));
      break;
    case 'words':
      statements.push(...byWords(q.words));
      break;
  }
  // An id or a code is also tried as words of the product's names (a part code or a model in its name).
  if (q.kind === 'digits' || q.kind === 'code') statements.push(...byWords(searchWords(raw)).slice(0, 1));
  if (!statements.length) return [];
  const answers = (await db.batch(statements)) as Array<{ results?: Array<{ product_id: string }> }>;
  const ids = new Set<string>();
  for (const a of answers) for (const r of a.results ?? []) ids.add(String(r.product_id));
  return [...ids];
}

export interface LinksPage {
  products: ProductLinks[];
  next_cursor: string | null;
}

/** GET /links?q=&source=&cursor=. */
export async function linksPage(db: D1Database, input: { q?: unknown; source?: unknown; cursor?: unknown }): Promise<LinksPage> {
  const q = parseSupplierQuery(input.q);
  const sourceRaw = input.source === undefined || input.source === null ? '' : input.source;
  if (sourceRaw !== '' && !isSupplierSource(sourceRaw)) throw inputInvalid('source');
  const source = sourceRaw === '' ? null : (sourceRaw as SupplierSource);
  const cursor = decodeLinksCursor(input.cursor);
  try {
    const filter = await idsForQuery(db, q, typeof input.q === 'string' ? input.q : '');
    if (filter !== null && !filter.length) return { products: [], next_cursor: null };
    const { results } = await db
      .prepare(
        `SELECT a.product_id, a.t FROM (
           SELECT product_id, MAX(t) AS t FROM (
             SELECT product_id, updated_at AS t FROM supplier_price_matches WHERE state IN ('confirmed', 'suggested') AND (?1 = '' OR source = ?1)
             UNION ALL
             SELECT product_id, entered_at AS t FROM supplier_price_manual WHERE ?1 = ''
           ) GROUP BY product_id
         ) a
         WHERE (?2 = '' OR a.t < ?2 OR (a.t = ?2 AND a.product_id < ?3))
           AND (?4 = 0 OR a.product_id IN (SELECT value FROM json_each(?5)))
           AND EXISTS (SELECT 1 FROM products p WHERE p.id = a.product_id)
         ORDER BY a.t DESC, a.product_id DESC
         LIMIT ?6`
      )
      .bind(source ?? '', cursor?.t ?? '', cursor?.id ?? '', filter === null ? 0 : 1, JSON.stringify(filter ?? []), LINKS_PAGE + 1)
      .all<{ product_id: string; t: string }>();
    const rows = results ?? [];
    const page = rows.slice(0, LINKS_PAGE);
    const views = await productLinkViews(
      db,
      page.map((r) => String(r.product_id)),
      { states: LINK_STATES, manual: source === null, source }
    );
    const last = page[page.length - 1];
    return {
      products: page.map((r) => views.get(String(r.product_id))).filter((v): v is ProductLinks => !!v),
      next_cursor: rows.length > LINKS_PAGE && last ? encodeLinksCursor(String(last.t), String(last.product_id)) : null,
    };
  } catch (e) {
    if (isMissingEstimateSchema(e)) return { products: [], next_cursor: null };
    throw e;
  }
}
