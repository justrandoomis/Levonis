/**
 * THE WIKI FOLLOW (Bambu import spec §C.7, §J.2, §1 row 7).
 *
 * At most 3 wiki.bambulab.com links per product, and only links the store page
 * itself gives, read ≥ 5 s apart. Their key/value tables go through the same
 * deterministic parser as the store's (`pairsOfGrid`, the registry's
 * synonyms, `typeValue`). A wiki value is `source_kind 'wiki'`,
 * `status 'unverified'` (prose and wiki tables never verify a number on their
 * own), and it never overrides a value the store page or a curated file gave:
 * it fills a key that is absent or `not_found`. Each page that parsed joins
 * the `checked_sources` of every key still `not_found`.
 */
import { findAll, isEl, parseHtml, tableGrid, textOf, type ElementNode } from '@levonis/catalog/bambuImport/html';
import { pairsOfGrid, specRowId, typeValue } from '@levonis/catalog/bambuImport/specs';
import { keyForLabel } from '@levonis/catalog/bambuImport/registry/specKeys';
import type { ProductType } from '@levonis/catalog/bambuImport/registry/types';
import { classifySentence } from '@levonis/catalog/bambuImport/sentences';
import { collapseWs } from '@levonis/catalog/bambuImport/normalize';
import type { PayloadSpec } from '@levonis/catalog/bambuImport/payload';
import { HostFetcher, ImportStop } from './fetch';

export const MAX_WIKI_PAGES = 3;
const MAX_CHECKED_SOURCES = 20;

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export interface WikiParse {
  title: string;
  tables: number;
  rows: PayloadSpec[];
}

const REFUSED = new Set(['money', 'promotion', 'shipping_policy', 'warranty']);
const clean = (s: string) => (REFUSED.has(classifySentence(s)) ? '' : collapseWs(s));

/** The spec rows a wiki page's tables give for keys the payload does not hold yet. */
export function wikiSpecRows(
  html: string,
  ctx: { productId: string; productType: ProductType; url: string; retrievedAt: string; taken: ReadonlySet<string>; sortFrom: number }
): WikiParse {
  const nodes = parseHtml(html);
  const titleNode = findAll(nodes, isEl('title'))[0] ?? findAll(nodes, isEl('h1'))[0];
  const title = cut(clean(titleNode ? textOf(titleNode) : '') || 'Bambu Lab Wiki', 200);
  const tables = findAll(nodes, isEl('table')) as ElementNode[];
  const rows: PayloadSpec[] = [];
  const seen = new Set<string>(ctx.taken);
  let sort = ctx.sortFrom;
  tables.forEach((table, t) => {
    const parsed = pairsOfGrid(tableGrid(table), `wiki table ${t + 1}`);
    if (!parsed) return;
    parsed.pairs.forEach((pair, r) => {
      const key = keyForLabel(pair.label, ctx.productType);
      if (!key || key.ownerOnly) return;
      if (seen.has(key.key)) return;
      const value = clean(pair.value);
      const label = clean(pair.label);
      if (!value || !label) return;
      const typed = typeValue(value, key.type, key.unit);
      if (key.type !== 'string' && key.type !== 'list' && typed.ambiguous) return;
      seen.add(key.key);
      rows.push({
        id: specRowId(ctx.productId, key.key, 'product', '', ''),
        key: key.key,
        group: key.group,
        scope_kind: 'product',
        scope_id: '',
        region: '',
        data_type: key.type,
        original_label: cut(label, 300),
        original_value: cut(value, 1000),
        value_text: cut(typed.valueText, 2000),
        value_num: typed.valueNum,
        value_num_max: typed.valueNumMax,
        value_bool: typed.valueBool,
        value_list: (typed.valueList as Array<string | number>).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => (typeof x === 'string' ? cut(x, 500) : x)),
        unit: typed.unit,
        status: 'unverified',
        confidence: 'official_page',
        source_kind: 'wiki',
        source_title: title,
        source_locator: cut(`${pair.locator || `wiki table ${t + 1}`} › row ${r + 1}`, 200),
        source_excerpt: cut(value, 200),
        test_method: '',
        test_condition: '',
        derived_from: '',
        missing_reason: '',
        checked_sources: [],
        visibility: 'public',
        conflict: '',
        sort: sort++,
      });
    });
  });
  return { title, tables: tables.length, rows };
}

export interface WikiFollow {
  pages: number;
  parsed: number;
  rows: PayloadSpec[];
  /** Pages that parsed: they join `checked_sources` of the keys still not found. */
  checked: Array<{ kind: string; url: string; title: string }>;
  outcomes: Array<{ url: string; status: number; ok: boolean }>;
}

/** Reads ≤ 3 wiki pages (≥ 5 s apart through the fetcher) and parses their tables. */
export async function followWiki(
  fetcher: HostFetcher,
  urls: readonly string[],
  ctx: { productId: string; productType: ProductType; retrievedAt: string; taken: ReadonlySet<string>; sortFrom: number },
  afterMs: number
): Promise<WikiFollow> {
  const out: WikiFollow = { pages: 0, parsed: 0, rows: [], checked: [], outcomes: [] };
  const taken = new Set(ctx.taken);
  let sortFrom = ctx.sortFrom;
  for (const url of urls.slice(0, MAX_WIKI_PAGES)) {
    out.pages++;
    let status = 0;
    try {
      const res = await fetcher.request(url, { method: 'GET', redirect: 'manual', maxBytes: 3 * 1024 * 1024 }, afterMs);
      status = res.status;
      if (res.status !== 200 || !res.body) {
        out.outcomes.push({ url, status, ok: false });
        continue;
      }
      const parsed = wikiSpecRows(res.body, { ...ctx, url, taken, sortFrom });
      for (const r of parsed.rows) taken.add(r.key);
      sortFrom += parsed.rows.length;
      out.rows.push(...parsed.rows);
      out.parsed++;
      out.checked.push({ kind: 'wiki', url, title: parsed.title });
      out.outcomes.push({ url, status, ok: true });
    } catch (err) {
      if (err instanceof ImportStop && err.kind === 'deadline') throw err;
      out.outcomes.push({ url, status, ok: false });
    }
  }
  return out;
}

/** Adds the parsed wiki pages to the checked sources of every `not_found` row (≤ 20 per row). */
export function addCheckedSources(specs: PayloadSpec[], checked: ReadonlyArray<{ kind: string; url: string; title: string }>): void {
  if (!checked.length) return;
  for (const s of specs) {
    if (s.status !== 'not_found') continue;
    for (const c of checked) {
      if (s.checked_sources.length >= MAX_CHECKED_SOURCES) break;
      if (!s.checked_sources.some((x) => x.url === c.url)) s.checked_sources.push({ kind: c.kind, url: c.url, title: c.title });
    }
  }
}
