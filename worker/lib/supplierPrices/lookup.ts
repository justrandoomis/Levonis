/**
 * «ابحث عن المنتج عند المورّد» — THE OWNER'S CATALOGUE LOOKUP
 * (docs/SMART_PRICING.md §3.6 `GET /lookup?q=`; migration 0218).
 *
 * The owner types or pastes what he has in hand, in any of these forms:
 *   - a Tmall URL (with or without `skuId`) or a Tmall item id;
 *   - a store URL (a product or variant page, with or without `?id=` and
 *     `skr=yes`) or a store handle;
 *   - a store variant id (any long run of digits is tried as a Tmall item id,
 *     a Tmall SKU id and a store variant id);
 *   - a 5-digit Bambu colour code;
 *   - a part code (ZH122, B-ZH171, FAP023-V1) or a Bambu SKU code
 *     (A00-W1-1.75-1000-SPLFREE);
 *   - words of a title or an English name.
 * The complete snapshots are searched (never a loading or discarded one) and
 * at most 50 items come back with their SKUs, prices, links and the Levonis
 * products already matched to them. The same parser serves the Links tab's
 * search (worker/lib/supplierPrices/links.ts).
 *
 * The text is only ever a search key: it is bound, never spliced into SQL,
 * and never becomes a link — a link is built only from a stored, validated id
 * (packages/catalog/src/supplierPrices/links.ts).
 */
import { inputInvalid } from '../pricingEngine/whatIf';
import { likePattern, sqlLikeClause } from '../sqlLike';
import { isSupplierItemKey } from '@levonis/catalog/supplierPrices/format';
import { normalizePartCode } from '@levonis/catalog/supplierPrices/keys';
import { isTmallId, supplierItemUrl, supplierSkuUrl } from '@levonis/catalog/supplierPrices/links';
import { SOURCE_CURRENCY, isSupplierSource, type SupplierCurrency, type SupplierSource } from './store';

/** The most items one lookup answers (§3.6). */
export const LOOKUP_MAX_ITEMS = 50;
/** The longest text the owner may search with. */
export const QUERY_MAX = 300;

export type SupplierQuery =
  | { kind: 'empty' }
  | { kind: 'tmall_url'; item_key: string; sku_key: string | null }
  | { kind: 'store_url'; source: 'bambu_eu' | 'bambu_us' | null; item_key: string; sku_key: string | null }
  | { kind: 'digits'; value: string }
  | { kind: 'code'; part_code: string | null; sku_code: string | null }
  | { kind: 'handle'; item_key: string; words: string[] }
  | { kind: 'words'; words: string[] };

const DIGITS = /^[0-9]{1,40}$/;
const SKU_CODE = /^[A-Za-z0-9][A-Za-z0-9._+-]{2,119}$/;
const HANDLE_LIKE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const STORE_HOSTS: Record<string, 'bambu_eu' | 'bambu_us' | null> = {
  'eu.store.bambulab.com': 'bambu_eu',
  'us.store.bambulab.com': 'bambu_us',
  'store.bambulab.com': null,
};

/** The words of a search: NFKC, lower case, split on spaces and punctuation, at most five, each 1–60 characters. */
export function searchWords(text: string): string[] {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s,;|/\\()[\]{}"'«»،]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= 60);
  return [...new Set(words)].slice(0, 5);
}

/** Whether a URL host is one of Tmall's or Taobao's. */
const isTmallHost = (host: string) => /^(?:[a-z0-9-]+\.)*(?:tmall|taobao)\.com$/.test(host);

/** What the owner's text asks for. Throws 400 PRICING_INPUT_INVALID {field: 'q'} for a text longer than QUERY_MAX. */
export function parseSupplierQuery(raw: unknown): SupplierQuery {
  if (raw === undefined || raw === null) return { kind: 'empty' };
  if (typeof raw !== 'string' || raw.length > QUERY_MAX) throw inputInvalid('q');
  const s = raw.normalize('NFKC').trim();
  if (!s) return { kind: 'empty' };

  // A pasted address: Tmall or a Bambu Lab store.
  if (/^https?:\/\//i.test(s) || /^(?:[a-z0-9-]+\.)*(?:tmall\.com|taobao\.com|bambulab\.com)\//i.test(s)) {
    let url: URL | null = null;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      url = null;
    }
    if (url) {
      const host = url.hostname.toLowerCase();
      if (isTmallHost(host)) {
        const id = url.searchParams.get('id');
        const sku = url.searchParams.get('skuId');
        if (id && isTmallId(id)) return { kind: 'tmall_url', item_key: id, sku_key: sku && isTmallId(sku) ? sku : null };
      } else if (Object.prototype.hasOwnProperty.call(STORE_HOSTS, host)) {
        const m = /\/products\/([^/?#]+)/.exec(url.pathname);
        let handle = '';
        try {
          handle = m ? decodeURIComponent(m[1]!).normalize('NFC').toLowerCase() : '';
        } catch {
          handle = '';
        }
        const source = STORE_HOSTS[host] ?? null;
        if (handle && isSupplierItemKey(source ?? 'bambu_us', handle)) {
          const id = url.searchParams.get('id');
          return { kind: 'store_url', source, item_key: handle, sku_key: id && DIGITS.test(id) ? id : null };
        }
      }
    }
    return { kind: 'words', words: searchWords(s) };
  }
  if (DIGITS.test(s)) return { kind: 'digits', value: s };
  const part = normalizePartCode(s);
  if (part) return { kind: 'code', part_code: part.code, sku_code: null };
  if (HANDLE_LIKE.test(s)) return { kind: 'handle', item_key: s, words: searchWords(s.replace(/-/g, ' ')) };
  if (SKU_CODE.test(s) && /[0-9]/.test(s) && /-/.test(s) && !/\s/.test(s)) return { kind: 'code', part_code: null, sku_code: s.toUpperCase() };
  return { kind: 'words', words: searchWords(s) };
}

/**
 * The bound LIKE patterns of a search's words (worker/lib/sqlLike.ts `likePattern`: `%`, `_` and `\`
 * literal under ESCAPE '\', at most D1's 50 bytes, never cut inside a character); a word that leaves
 * no pattern is dropped.
 */
export function likePatternsOf(words: readonly string[]): string[] {
  return words.map((w) => likePattern(w)).filter((p) => p !== '');
}

// ---------------------------------------------------------------- the search

interface Ref {
  snapshot_id: string;
  item_key: string;
  sku_key: string;
}

const COMPLETE = "s.state = 'complete'";

/** The statements that find the items a query names, each answering (snapshot_id, item_key, sku_key). */
function refStatements(db: D1Database, q: SupplierQuery): D1PreparedStatement[] {
  const byItemKey = (sources: readonly SupplierSource[], key: string) =>
    db
      .prepare(
        `SELECT s.id AS snapshot_id, i.item_key, '' AS sku_key
           FROM supplier_price_snapshots s JOIN supplier_price_items i ON i.snapshot_id = s.id AND i.item_key = ?1
          WHERE ${COMPLETE} AND s.source IN (SELECT value FROM json_each(?2))`
      )
      .bind(key, JSON.stringify(sources));
  const byKey = (type: string, value: string) =>
    db
      .prepare(
        `SELECT k.snapshot_id, k.item_key, k.sku_key
           FROM supplier_price_keys k JOIN supplier_price_snapshots s ON s.id = k.snapshot_id AND ${COMPLETE}
          WHERE k.key_type = ?1 AND k.key_value = ?2
          ORDER BY s.source, k.item_key, k.sku_key LIMIT 200`
      )
      .bind(type, value);
  const bySkuKey = (sources: readonly SupplierSource[], value: string) =>
    db
      .prepare(
        `SELECT k.snapshot_id, k.item_key, k.sku_key
           FROM supplier_price_snapshots s JOIN supplier_price_skus k ON k.snapshot_id = s.id
          WHERE ${COMPLETE} AND s.source IN (SELECT value FROM json_each(?2)) AND k.sku_key = ?1
          ORDER BY k.item_key LIMIT 50`
      )
      .bind(value, JSON.stringify(sources));
  const byWords = (patterns: readonly string[]) =>
    db
      .prepare(
        `SELECT s.id AS snapshot_id, i.item_key, '' AS sku_key
           FROM supplier_price_snapshots s JOIN supplier_price_items i ON i.snapshot_id = s.id
          WHERE ${COMPLETE} ${patterns.map((_, n) => `AND ${sqlLikeClause(["(i.title || ' ' || i.name_en)"], `?${n + 1}`)}`).join(' ')}
          ORDER BY s.source, i.item_key LIMIT ${LOOKUP_MAX_ITEMS}`
      )
      .bind(...patterns);
  const words = q.kind === 'handle' || q.kind === 'words' ? likePatternsOf(q.words) : [];

  switch (q.kind) {
    case 'empty':
      return [];
    case 'tmall_url':
      return [byItemKey(['tmall_cn'], q.item_key)];
    case 'store_url':
      return [byItemKey(q.source ? [q.source] : ['bambu_eu', 'bambu_us'], q.item_key)];
    case 'digits': {
      const out = [byItemKey(['tmall_cn'], q.value), byKey('variant_id', q.value), bySkuKey(['tmall_cn'], q.value)];
      if (q.value.length === 5) out.push(byKey('color_code', q.value));
      return out;
    }
    case 'code':
      return [...(q.part_code ? [byKey('part_code', q.part_code)] : []), ...(q.sku_code ? [byKey('sku_code', q.sku_code)] : [])];
    case 'handle':
      return [byItemKey(['bambu_eu', 'bambu_us'], q.item_key), ...(words.length ? [byWords(words)] : [])];
    case 'words':
      return words.length ? [byWords(words)] : [];
  }
}

export interface LookupProduct {
  product_id: string;
  name: string;
  combo_key: string;
  /** 'auto' (confirmed automatically), 'confirmed' (by the owner) or 'suggested'. */
  state: 'auto' | 'confirmed' | 'suggested';
}

export interface LookupSku {
  sku_key: string;
  options: Record<string, string>;
  options_en: Record<string, string>;
  price: string;
  price_label: string;
  quantity: number | null;
  sku_code: string;
  sku_url: string | null;
  /** The SKU the query named (a URL's skuId or ?id=, a colour, a code). */
  highlight: boolean;
  products: LookupProduct[];
}

export interface LookupItem {
  source: SupplierSource;
  snapshot_id: string;
  captured_on: string;
  currency: SupplierCurrency;
  item_key: string;
  title: string;
  name_en: string;
  category: string;
  item_url: string | null;
  skus: LookupSku[];
}

const parseObject = (raw: unknown): Record<string, string> => {
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/** GET /lookup?q=: at most 50 items of the complete snapshots, with their SKUs, prices, links and matched products. */
export async function lookupCatalogue(db: D1Database, q: SupplierQuery): Promise<LookupItem[]> {
  const statements = refStatements(db, q);
  if (!statements.length) return [];
  const answers = (await db.batch(statements)) as Array<{ results?: Ref[] }>;
  const wantSku = q.kind === 'tmall_url' || q.kind === 'store_url' ? q.sku_key : null;
  const refs = new Map<string, { snapshot_id: string; item_key: string; skus: Set<string> }>();
  for (const a of answers) {
    for (const r of a.results ?? []) {
      const k = `${r.snapshot_id}\u0000${r.item_key}`;
      if (!refs.has(k)) {
        if (refs.size >= LOOKUP_MAX_ITEMS) continue;
        refs.set(k, { snapshot_id: String(r.snapshot_id), item_key: String(r.item_key), skus: new Set() });
      }
      if (r.sku_key) refs.get(k)!.skus.add(String(r.sku_key));
    }
  }
  if (!refs.size) return [];
  const list = JSON.stringify([...refs.values()].map((r) => [r.snapshot_id, r.item_key]));
  const [itemRes, skuRes, matchRes] = (await db.batch([
    db
      .prepare(
        `SELECT i.snapshot_id, i.item_key, i.title, i.name_en, i.category, s.source, s.captured_on
           FROM json_each(?1) j
           JOIN supplier_price_items i ON i.snapshot_id = json_extract(j.value, '$[0]') AND i.item_key = json_extract(j.value, '$[1]')
           JOIN supplier_price_snapshots s ON s.id = i.snapshot_id`
      )
      .bind(list),
    db
      .prepare(
        `SELECT k.snapshot_id, k.item_key, k.sku_key, k.options_json, k.options_en_json, k.price, k.price_label, k.quantity, k.sku_code
           FROM json_each(?1) j
           JOIN supplier_price_skus k ON k.snapshot_id = json_extract(j.value, '$[0]') AND k.item_key = json_extract(j.value, '$[1]')
          ORDER BY k.item_key, k.sku_key`
      )
      .bind(list),
    db
      .prepare(
        `SELECT m.source, m.item_key, m.sku_key, m.product_id, m.combo_key, m.state, m.decided_by, p.name
           FROM json_each(?1) j
           JOIN supplier_price_snapshots s ON s.id = json_extract(j.value, '$[0]')
           JOIN supplier_price_matches m ON m.source = s.source AND m.item_key = json_extract(j.value, '$[1]')
           LEFT JOIN products p ON p.id = m.product_id
          WHERE m.state IN ('confirmed', 'suggested')
          ORDER BY m.product_id, m.combo_key`
      )
      .bind(list),
  ])) as Array<{ results?: Array<Record<string, unknown>> }>;

  const matchesBy = new Map<string, LookupProduct[]>();
  for (const m of matchRes?.results ?? []) {
    const k = `${m.source}\u0000${m.item_key}\u0000${m.sku_key}`;
    if (!matchesBy.has(k)) matchesBy.set(k, []);
    matchesBy.get(k)!.push({
      product_id: String(m.product_id),
      name: String(m.name ?? ''),
      combo_key: String(m.combo_key),
      state: m.state === 'suggested' ? 'suggested' : m.decided_by === 'auto' ? 'auto' : 'confirmed',
    });
  }
  const skusBy = new Map<string, Array<Record<string, unknown>>>();
  for (const s of skuRes?.results ?? []) {
    const k = `${s.snapshot_id}\u0000${s.item_key}`;
    if (!skusBy.has(k)) skusBy.set(k, []);
    skusBy.get(k)!.push(s);
  }
  const items: LookupItem[] = [];
  for (const i of itemRes?.results ?? []) {
    if (!isSupplierSource(i.source)) continue;
    const source = i.source;
    const itemKey = String(i.item_key);
    const ref = refs.get(`${i.snapshot_id}\u0000${itemKey}`);
    items.push({
      source,
      snapshot_id: String(i.snapshot_id),
      captured_on: String(i.captured_on ?? ''),
      currency: SOURCE_CURRENCY[source],
      item_key: itemKey,
      title: String(i.title ?? ''),
      name_en: String(i.name_en ?? ''),
      category: String(i.category ?? ''),
      item_url: supplierItemUrl(source, itemKey),
      skus: (skusBy.get(`${i.snapshot_id}\u0000${itemKey}`) ?? []).map((s) => {
        const skuKey = String(s.sku_key);
        return {
          sku_key: skuKey,
          options: parseObject(s.options_json),
          options_en: parseObject(s.options_en_json),
          price: String(s.price),
          price_label: String(s.price_label ?? ''),
          quantity: s.quantity === null || s.quantity === undefined ? null : Number(s.quantity),
          sku_code: String(s.sku_code ?? ''),
          sku_url: supplierSkuUrl(source, itemKey, skuKey),
          highlight: skuKey === wantSku || !!ref?.skus.has(skuKey),
          products: matchesBy.get(`${source}\u0000${itemKey}\u0000${skuKey}`) ?? [],
        };
      }),
    });
  }
  const rank: Record<SupplierSource, number> = { tmall_cn: 0, bambu_eu: 1, bambu_us: 2 };
  return items.sort((a, b) => rank[a.source] - rank[b.source] || (a.item_key < b.item_key ? -1 : a.item_key > b.item_key ? 1 : 0));
}
