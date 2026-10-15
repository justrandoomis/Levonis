/**
 * ENRICH (Bambu import spec §A.1, §C.4–§C.7, §F, §J.2).
 *
 * Between EXTRACT and VALIDATE, on a COPY of the payload the builder made from
 * the store page:
 *
 *   1. CURATED. A curated-scope product's reviewed file
 *      `data/bambu-import/curated/<handle>.json` is read, checked against the
 *      bundled `curated/index.json` SHA-256, and merged: its specs win over a
 *      store-page value of the same key, scope and region only by source rank
 *      (official_variant > official_doc > official_page > component_maker >
 *      independent), a disagreement is recorded either way (`conflict` on the
 *      row, a `spec_sources_disagree` note); `not_published` keys become
 *      `not_published` rows; `searched` documents join the checked sources of
 *      the keys they covered; its documents are added. The payload carries the
 *      file's SHA-256 (`curated_sha256`), which the Worker matches against its
 *      bundled index (§A.3).
 *   2. TRACKERS. ≤ 5 tracker links, one HEAD each, never followed (tracker.ts).
 *   3. DOCUMENT CHECKS. ≤ 20 links on the store CDNs: HEAD, falling back to a
 *      ranged GET of bytes 0–1023, ≥ 1 s apart. Status, content type, size and
 *      the first-KB SHA-256 go to the Worker beside the payload
 *      (`document_checks`): a dead link is kept with `active = 0` and never
 *      shown to customers.
 *   4. WIKI. ≤ 3 wiki links the page itself gives, ≥ 5 s apart (wiki.ts).
 *
 * Optional data is never a blocker (R3): a failed check, an unresolved tracker
 * or an unread wiki page is recorded, and the product continues. Only a wait
 * that does not fit before the deadline stops ENRICH.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { H } from '@levonis/catalog/bambuImport/hash';
import { collapseWs, hostOf, keptLinkUrl } from '@levonis/catalog/bambuImport/normalize';
import { DOCUMENT_HOSTS, DOCUMENT_TITLES, documentKindOf } from '@levonis/catalog/bambuImport/registry/documents';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import type { ProductType } from '@levonis/catalog/bambuImport/registry/types';
import { scrubProse } from '@levonis/catalog/bambuImport/sentences';
import { specRowId } from '@levonis/catalog/bambuImport/specs';
import type { ImportPayload, PayloadDocument, PayloadSpec } from '@levonis/catalog/bambuImport/payload';
import type { DescribedLink } from '@levonis/catalog/bambuImport/describe';
import { WORST } from './deadline';
import { HostFetcher, ImportStop } from './fetch';
import type { DocumentCheck } from './opsClient';
import { MAX_TRACKERS_PER_PRODUCT, resolveTracker, type TrackerResult } from './tracker';
import { addCheckedSources, followWiki } from './wiki';

export const MAX_DOCUMENT_CHECKS = 20;
const CHECKED_HOSTS: ReadonlySet<string> = new Set(['store.bblcdn.com', 'cdn.shopify.com']);
const GENERIC_LINK_TEXT = /^(?:here|click here|this|link|this link|wiki|wiki link|wiki page|page|learn more|more|read more|video|download|details|view|see more)?$/i;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// ------------------------------------------------------------------ documents

/** A document row exactly as the builder writes one (same id rule, same title rule). */
export function documentRow(productId: string, rawUrl: string, text: string, sort: number): PayloadDocument | null {
  const url = keptLinkUrl(rawUrl.trim()).replace(/^http:\/\//i, 'https://');
  const host = hostOf(url);
  if (!url.startsWith('https://') || !DOCUMENT_HOSTS.has(host)) return null;
  const kind = host.endsWith('youtube.com') ? 'video' : documentKindOf(text, url);
  const reg = DOCUMENT_TITLES[kind];
  const linkText = collapseWs(scrubProse(text).kept).replace(/[\s,.;:!]+$/, '').slice(0, 200);
  const sourceTitle = GENERIC_LINK_TEXT.test(linkText) ? '' : linkText;
  const tail = sourceTitle && sourceTitle !== reg.en ? ` — ${sourceTitle}` : '';
  return {
    id: `pd_${H(`${productId}${url}product`)}`,
    kind,
    title_en: sourceTitle || reg.en,
    title_ar: `${reg.ar}${tail}`.slice(0, 300),
    title_ckb: `${reg.ckb}${tail}`.slice(0, 300),
    url,
    host,
    scope_kind: 'product',
    scope_id: '',
    language: 'en',
    sort,
  };
}

function addDocument(payload: ImportPayload, row: PayloadDocument | null): boolean {
  if (!row || payload.documents.some((d) => d.id === row.id) || payload.documents.length >= 200) return false;
  payload.documents.push(row);
  return true;
}

// ------------------------------------------------------------------ curated (§F)

export type CuratedGate = { kind: 'none' } | { kind: 'pending' } | { kind: 'mismatch' } | { kind: 'ok'; sha256: string; file: Rec };

/** The curated gate: not curated-scope, waiting for its file, a file whose digest is not the bundled one, or the file. */
export function curatedGate(dataDir: string, handle: string, curatedScope: boolean, index: Readonly<Record<string, string>>): CuratedGate {
  if (!curatedScope) return { kind: 'none' };
  const expected = index[handle];
  if (!expected) return { kind: 'pending' };
  const path = join(dataDir, 'curated', `${handle}.json`);
  if (!/^[\p{Ll}\p{Nd}][\p{Ll}\p{Nd}\p{M}._-]*$/u.test(handle) || !existsSync(path)) return { kind: 'pending' };
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) return { kind: 'mismatch' };
  try {
    const file = JSON.parse(new TextDecoder().decode(bytes));
    return isRec(file) ? { kind: 'ok', sha256, file } : { kind: 'mismatch' };
  } catch {
    return { kind: 'mismatch' };
  }
}

const RANK: Readonly<Record<string, number>> = { official_variant: 5, official_doc: 4, official_page: 3, component_maker: 2, independent: 1, derived: 0 };
const STATUSES = new Set(['verified', 'unverified', 'not_found', 'not_published', 'not_applicable', 'unknown']);
const SOURCE_KINDS = new Set(['store_page', 'store_messages', 'store_doc', 'tds', 'sds', 'manual', 'wiki', 'curated', 'derived']);
const REGIONS = new Set(['', 'us_110v', 'intl_220v']);

function scopeOf(payload: ImportPayload, scope: unknown): { kind: PayloadSpec['scope_kind']; id: string } | null {
  if (!isRec(scope) || scope.kind === undefined || scope.kind === 'product') return { kind: 'product', id: '' };
  if (scope.kind === 'option_value') {
    const sid = String(scope.source_value_id ?? scope.source_id ?? '');
    for (const g of payload.groups) for (const v of g.values) if (v.source_id === sid || v.id === scope.id) return { kind: 'option_value', id: v.id };
    return null;
  }
  if (scope.kind === 'variant') {
    const sid = String(scope.source_variant_id ?? scope.source_id ?? '');
    const v = payload.variants.find((x) => x.source_id === sid || x.id === scope.id);
    return v ? { kind: 'variant', id: v.id } : null;
  }
  return null;
}

function valueFields(value: unknown, unit: string): Pick<PayloadSpec, 'data_type' | 'value_text' | 'value_num' | 'value_num_max' | 'value_bool' | 'value_list'> | null {
  const empty = { value_text: '', value_num: null, value_num_max: null, value_bool: null, value_list: [] as Array<string | number> };
  if (typeof value === 'number' && Number.isFinite(value)) return { ...empty, data_type: 'number', value_num: value, value_text: `${value}${unit ? ` ${unit}` : ''}` };
  if (typeof value === 'boolean') return { ...empty, data_type: 'boolean', value_bool: value ? 1 : 0, value_text: value ? 'Yes' : 'No' };
  if (typeof value === 'string') return { ...empty, data_type: 'string', value_text: cut(value, 2000) };
  if (isRec(value) && typeof value.min === 'number' && typeof value.max === 'number') {
    return { ...empty, data_type: 'range', value_num: value.min, value_num_max: value.max, value_text: `${value.min}–${value.max}${unit ? ` ${unit}` : ''}` };
  }
  if (Array.isArray(value) && value.every((x) => typeof x === 'string' || typeof x === 'number')) {
    return { ...empty, data_type: 'list', value_list: value.slice(0, 200) as Array<string | number>, value_text: cut(value.join(', '), 2000) };
  }
  return null;
}

const keyCovered = (pattern: string, key: string) => (pattern.endsWith('.*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key);

export interface CuratedMergeReport {
  specs_added: number;
  specs_replaced: number;
  conflicts: number;
  not_published: number;
  documents: number;
  skipped: number;
  /** Curated parts the payload has no field for yet (published hex, relations, in-the-box): recorded, not applied. */
  not_applied: number;
}

/** Merges a reviewed curated file into the payload (mutates it). */
export function mergeCurated(payload: ImportPayload, file: Rec, sha256: string): CuratedMergeReport {
  const report: CuratedMergeReport = { specs_added: 0, specs_replaced: 0, conflicts: 0, not_published: 0, documents: 0, skipped: 0, not_applied: 0 };
  payload.curated_sha256 = sha256;
  const byId = new Map(payload.specs.map((s, i) => [s.id, i]));
  let sort = payload.specs.reduce((m, s) => Math.max(m, s.sort), 0) + 1;
  const searched = (Array.isArray(file.searched) ? file.searched : []).filter(isRec);
  const searchedFor = (key: string) =>
    searched
      .filter((s) => Array.isArray(s.keys) && s.keys.some((k) => typeof k === 'string' && keyCovered(k, key)))
      .map((s) => ({ kind: String(s.kind ?? 'curated').slice(0, 40), url: String(s.url ?? '').slice(0, 1000), title: cut(String(s.title ?? s.kind ?? ''), 200) }))
      .slice(0, 20);

  for (const raw of Array.isArray(file.specs) ? file.specs : []) {
    if (!isRec(raw) || typeof raw.key !== 'string') {
      report.skipped++;
      continue;
    }
    const reg = specKey(raw.key);
    const scope = scopeOf(payload, raw.scope);
    const region = typeof raw.region === 'string' && REGIONS.has(raw.region) ? (raw.region as PayloadSpec['region']) : '';
    const unit = typeof raw.unit === 'string' ? raw.unit.slice(0, 20) : reg?.unit ?? '';
    const values = valueFields(raw.value, unit);
    const status = typeof raw.status === 'string' && STATUSES.has(raw.status) ? raw.status : 'unverified';
    const confidence = typeof raw.confidence === 'string' && raw.confidence in RANK ? raw.confidence : 'official_doc';
    const sourceKind = typeof raw.source_kind === 'string' && SOURCE_KINDS.has(raw.source_kind) ? raw.source_kind : 'curated';
    if (!scope || !values) {
      report.skipped++;
      continue;
    }
    const id = specRowId(payload.product_id, raw.key, scope.kind, scope.id, region);
    const row: PayloadSpec = {
      id,
      key: raw.key,
      group: reg?.group ?? raw.key.split('.')[0],
      scope_kind: scope.kind,
      scope_id: scope.id,
      region,
      ...values,
      data_type: reg?.type ?? values.data_type,
      original_label: cut(reg?.labels.en ?? raw.key, 300),
      original_value: cut(String(raw.quote ?? values.value_text), 1000),
      unit,
      status,
      confidence,
      source_kind: sourceKind,
      source_title: cut(String(raw.source_title ?? ''), 200),
      source_locator: cut(String(raw.locator ?? ''), 200),
      source_excerpt: cut(String(raw.quote ?? ''), 200),
      test_method: cut(String(raw.test_method ?? ''), 300),
      test_condition: cut(String(raw.test_condition ?? ''), 300),
      derived_from: '',
      missing_reason: '',
      checked_sources: [],
      visibility: reg?.ownerOnly ? 'owner' : 'public',
      conflict: '',
      sort: sort++,
    };
    const at = byId.get(id);
    if (at === undefined) {
      payload.specs.push(row);
      byId.set(id, payload.specs.length - 1);
      report.specs_added++;
      continue;
    }
    const page = payload.specs[at];
    if (page.status === 'not_found' || page.status === 'unknown') {
      payload.specs[at] = { ...row, sort: page.sort };
      report.specs_replaced++;
      continue;
    }
    const differs = page.value_num !== row.value_num || page.value_num_max !== row.value_num_max || (page.value_num === null && page.value_text !== row.value_text);
    if (differs) {
      report.conflicts++;
      payload.notes.push({ kind: 'spec_sources_disagree', field: raw.key.slice(0, 120) });
    }
    if ((RANK[row.confidence] ?? 0) > (RANK[page.confidence] ?? 0)) {
      payload.specs[at] = { ...row, sort: page.sort, conflict: differs ? 'curated value differs from the store page' : '' };
      report.specs_replaced++;
    } else if (differs) {
      page.conflict = 'curated value differs from the store page';
    }
  }

  for (const key of Array.isArray(file.not_published) ? file.not_published : []) {
    if (typeof key !== 'string') continue;
    const id = specRowId(payload.product_id, key, 'product', '', '');
    const at = byId.get(id);
    if (at !== undefined && payload.specs[at].status !== 'not_found' && payload.specs[at].status !== 'unknown') continue;
    const reg = specKey(key);
    const row: PayloadSpec = {
      id,
      key,
      group: reg?.group ?? key.split('.')[0],
      scope_kind: 'product',
      scope_id: '',
      region: '',
      data_type: reg?.type ?? 'string',
      original_label: cut(reg?.labels.en ?? key, 300),
      original_value: '',
      value_text: '',
      value_num: null,
      value_num_max: null,
      value_bool: null,
      value_list: [],
      unit: reg?.unit ?? '',
      status: 'not_published',
      confidence: 'official_doc',
      source_kind: 'curated',
      source_title: '',
      source_locator: '',
      source_excerpt: '',
      test_method: '',
      test_condition: '',
      derived_from: '',
      missing_reason: 'not_published_by_manufacturer',
      checked_sources: searchedFor(key),
      visibility: 'public',
      conflict: '',
      sort: at !== undefined ? payload.specs[at].sort : sort++,
    };
    if (at === undefined) {
      payload.specs.push(row);
      byId.set(id, payload.specs.length - 1);
    } else payload.specs[at] = row;
    report.not_published++;
  }

  for (const s of payload.specs) {
    if (s.status !== 'not_found') continue;
    for (const c of searchedFor(s.key)) if (s.checked_sources.length < 20 && !s.checked_sources.some((x) => x.url === c.url)) s.checked_sources.push(c);
  }

  for (const d of Array.isArray(file.documents) ? file.documents : []) {
    if (!isRec(d) || typeof d.url !== 'string') continue;
    if (addDocument(payload, documentRow(payload.product_id, d.url, String(d.title ?? d.text ?? ''), payload.documents.length))) report.documents++;
  }
  for (const part of ['hex', 'relations', 'in_the_box'] as const) if (Array.isArray(file[part])) report.not_applied += (file[part] as unknown[]).length;
  return report;
}

// ------------------------------------------------------------------ the stage

export interface EnrichInputs {
  payload: ImportPayload;
  productType: ProductType;
  trackerLinks: readonly DescribedLink[];
  retrievedAt: string;
  curated: CuratedGate;
  /**
   * What must still fit after each request's spacing wait: the rest of ENRICH's
   * worst case (§A.7 rule 1), measured from when the stage started. Default: all of it.
   */
  afterMs?: () => number;
}

export interface EnrichReport {
  documents_checked: number;
  documents_dead: number;
  tracker_links: number;
  trackers_resolved: number;
  trackers: TrackerResult[];
  wiki_pages: number;
  wiki_parsed: number;
  wiki_specs: number;
  curated: CuratedMergeReport | null;
}

export interface EnrichResult {
  payload: ImportPayload;
  documentChecks: DocumentCheck[];
  report: EnrichReport;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sizeOf(headers: Headers): number | null {
  const range = /\/(\d+)\s*$/.exec(headers.get('content-range') ?? '');
  if (range) return Number(range[1]);
  const len = headers.get('content-length');
  return len && /^\d+$/.test(len) ? Number(len) : null;
}

/** One document check (§C.7): HEAD, falling back to a ranged GET of bytes 0–1023. */
export async function checkDocument(fetcher: HostFetcher, doc: PayloadDocument, now: () => string, afterMs: number): Promise<DocumentCheck> {
  const base: DocumentCheck = { document_id: doc.id, check_status: 0, content_type: '', byte_size: null, content_sha256: '', checked_at: now(), tracker_source: '' };
  try {
    const head = await fetcher.request(doc.url, { method: 'HEAD', redirect: 'follow' }, afterMs);
    if (head.status >= 200 && head.status < 300) {
      return { ...base, check_status: head.status, content_type: (head.headers.get('content-type') ?? '').slice(0, 100), byte_size: sizeOf(head.headers), checked_at: now() };
    }
    const get = await fetcher.request(doc.url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-1023' }, wantBytes: true, maxBytes: 1024 }, afterMs);
    return {
      ...base,
      check_status: get.status,
      content_type: (get.headers.get('content-type') ?? '').slice(0, 100),
      byte_size: sizeOf(get.headers),
      content_sha256: get.bytes && get.status >= 200 && get.status < 300 ? sha256Hex(get.bytes) : '',
      checked_at: now(),
    };
  } catch (err) {
    if (err instanceof ImportStop && err.kind === 'deadline') throw err;
    return base;
  }
}

/** ENRICH on a copy of the payload. Throws only ImportStop('DEADLINE_EXIT'). */
export async function enrich(fetcher: HostFetcher, inp: EnrichInputs, now: () => string): Promise<EnrichResult> {
  const payload: ImportPayload = JSON.parse(JSON.stringify(inp.payload));
  const report: EnrichReport = {
    documents_checked: 0,
    documents_dead: 0,
    tracker_links: inp.trackerLinks.length,
    trackers_resolved: 0,
    trackers: [],
    wiki_pages: 0,
    wiki_parsed: 0,
    wiki_specs: 0,
    curated: null,
  };
  const afterOf = inp.afterMs ?? (() => WORST.ENRICH);

  // 1. curated
  if (inp.curated.kind === 'ok') report.curated = mergeCurated(payload, inp.curated.file, inp.curated.sha256);

  // 2. trackers
  const trackerSources = new Map<string, string>();
  for (const link of inp.trackerLinks.slice(0, MAX_TRACKERS_PER_PRODUCT)) {
    const r = await resolveTracker(fetcher, link, afterOf());
    report.trackers.push(r);
    if (r.outcome !== 'resolved') continue;
    const row = documentRow(payload.product_id, r.target, link.text, payload.documents.length);
    if (row && addDocument(payload, row)) {
      trackerSources.set(row.id, r.tracker);
      report.trackers_resolved++;
      // One tracker_unresolved note per resolved link leaves the payload (the builder wrote one per link).
      const at = payload.notes.findIndex((n) => n.kind === 'tracker_unresolved');
      if (at >= 0) payload.notes.splice(at, 1);
    }
  }

  // 3. document checks
  const checks: DocumentCheck[] = [];
  for (const doc of payload.documents) {
    if (checks.length >= MAX_DOCUMENT_CHECKS) break;
    if (!CHECKED_HOSTS.has(doc.host)) continue;
    const c = await checkDocument(fetcher, doc, now, afterOf());
    checks.push({ ...c, tracker_source: trackerSources.get(doc.id) ?? '' });
    report.documents_checked++;
    if (c.check_status === 0 || c.check_status >= 400) report.documents_dead++;
  }
  for (const [id, tracker] of trackerSources) if (!checks.some((c) => c.document_id === id)) checks.push({ document_id: id, check_status: 0, content_type: '', byte_size: null, content_sha256: '', checked_at: '', tracker_source: tracker });

  // 4. wiki
  const wikiUrls = payload.documents.filter((d) => d.host === 'wiki.bambulab.com').map((d) => d.url);
  if (wikiUrls.length) {
    const taken = new Set(payload.specs.filter((s) => s.scope_kind === 'product' && s.status !== 'not_found' && s.status !== 'unknown').map((s) => s.key));
    const sortFrom = payload.specs.reduce((m, s) => Math.max(m, s.sort), 0) + 1;
    const wiki = await followWiki(fetcher, wikiUrls, { productId: payload.product_id, productType: inp.productType, retrievedAt: inp.retrievedAt, taken, sortFrom }, afterOf());
    report.wiki_pages = wiki.pages;
    report.wiki_parsed = wiki.parsed;
    for (const row of wiki.rows) {
      const at = payload.specs.findIndex((s) => s.id === row.id);
      if (at >= 0) payload.specs[at] = { ...row, sort: payload.specs[at].sort };
      else payload.specs.push(row);
      report.wiki_specs++;
    }
    addCheckedSources(payload.specs, wiki.checked);
    for (const o of wiki.outcomes) {
      const doc = payload.documents.find((d) => d.url === o.url);
      if (doc && !checks.some((c) => c.document_id === doc.id)) {
        checks.push({ document_id: doc.id, check_status: o.status, content_type: o.ok ? 'text/html' : '', byte_size: null, content_sha256: '', checked_at: now(), tracker_source: trackerSources.get(doc.id) ?? '' });
      }
    }
  }
  return { payload, documentChecks: checks, report };
}
