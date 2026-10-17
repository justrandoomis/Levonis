/**
 * THE QUEUE AND THE REVIEWED BUNDLE (Bambu import spec §A.3, §D.2, §E.1, §I.3, §J.4).
 *
 *   - `loadReviewedBundle`: the committed reviewed files under
 *     data/bambu-import/ — the manifest, the taxonomy map, the existing-product
 *     matches, the compatibility targets, the identity map, the media
 *     overrides, the search synonyms and the curated index — read as bytes and
 *     hashed. `/hello` answers the Worker's SHA-256 of the same files, bundled
 *     into it; the runner refuses to continue when one differs
 *     (REVIEWED_BUNDLE_MISMATCH).
 *   - `manifestRequestRows`: the rows `/manifest` takes (≤ 100 per call), the
 *     manifest's identity fields plus discovery fields only.
 *   - `writeModeOf`: create, merge or hold, from the reviewed matches only.
 *   - `parseSitemap` / `sitemapDiff`: the end-of-run re-read of the three
 *     sitemaps (§I.3.1): new handles and handles no longer listed.
 *
 * Nothing here prints: callers log counts only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompatTargets } from '@levonis/catalog/bambuImport/relations';
import type { IdentityEntry, ManifestRowInput } from '@levonis/catalog/bambuImport/payload';
import type { MediaOverride } from '@levonis/catalog/bambuImport/media';
import type { ReviewedValueLabel } from '@levonis/catalog/bambuImport/options';

/** The reviewed files the Worker bundles (§A.3), relative to data/bambu-import/. */
export const REVIEWED_FILES = [
  'manifest.json',
  'taxonomy-map.json',
  'existing-matches.json',
  'compat-targets.json',
  'identity-map.json',
  'media-overrides.json',
  'search-synonyms.json',
  'curated/index.json',
] as const;

export const DEFAULT_DATA_DIR = 'data/bambu-import';

export interface ManifestRow extends ManifestRowInput {
  queue_position: number;
  source?: string;
  seo_code_raw?: string;
  canonical_url?: string;
  title?: string;
  type?: string;
  subtype?: string;
  currentAllIdRoute?: string;
  leaf?: string;
  also?: string[];
  curated?: boolean;
  hold_code?: '' | 'OWNER_HIDDEN' | 'ORDER_TYPE_WORD';
  sku_codes?: Record<string, string>;
  value_labels?: Record<string, ReviewedValueLabel>;
  audit_classes?: string[];
  source_collections?: string[];
}

export interface MatchEntry {
  source_product_id: string;
  source_handle?: string;
  levonis_product_id?: string;
  levonis_slug?: string;
  decision: 'merge' | 'merge_publish' | 'distinct' | 'not_bambu' | 'hold_owner_hidden';
  reason?: string;
  /** A merge's reviewed variant map (§E.2): what the Worker's writer maps through, and VERIFY expects by. */
  value_map?: Record<string, { option_value_ids?: string[]; color_id?: string }>;
  unmapped_variants?: string[];
}

export interface ReviewedBundle {
  dir: string;
  /** file (relative to the data dir) → SHA-256 of its bytes. */
  sha256: Record<string, string>;
  rows: ManifestRow[];
  bySid: Map<string, ManifestRow>;
  taxonomy: Record<string, unknown>;
  matches: Map<string, MatchEntry>;
  targets: CompatTargets | null;
  identity: Record<string, IdentityEntry>;
  overrides: MediaOverride[];
  curatedIndex: Record<string, string>;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

export class BundleError extends Error {
  constructor(readonly code: 'REVIEWED_BUNDLE_MISSING' | 'REVIEWED_BUNDLE_INVALID', message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

function readJson(dir: string, file: string): { bytes: Buffer; json: unknown } {
  const path = join(dir, file);
  if (!existsSync(path)) throw new BundleError('REVIEWED_BUNDLE_MISSING', `${file} is not in the reviewed data directory`);
  const bytes = readFileSync(path);
  try {
    return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    throw new BundleError('REVIEWED_BUNDLE_INVALID', `${file} is not JSON`);
  }
}

/** curated/index.json: `{files: {handle: sha256}}`, `{entries: …}` or a plain `{handle: sha256}` map. */
export function curatedIndexOf(json: unknown): Record<string, string> {
  if (!isRec(json)) return {};
  const inner = isRec(json.files) ? json.files : isRec(json.entries) ? json.entries : json;
  const out: Record<string, string> = {};
  for (const [handle, v] of Object.entries(inner)) {
    const digest = typeof v === 'string' ? v : isRec(v) && typeof v.sha256 === 'string' ? v.sha256 : '';
    if (/^[0-9a-f]{64}$/.test(digest)) out[handle] = digest;
  }
  return out;
}

export function loadReviewedBundle(dir: string): ReviewedBundle {
  const sums: Record<string, string> = {};
  const parsed: Record<string, unknown> = {};
  for (const file of REVIEWED_FILES) {
    const { bytes, json } = readJson(dir, file);
    sums[file] = sha256(bytes);
    parsed[file] = json;
  }
  const manifest = parsed['manifest.json'];
  const rawRows = isRec(manifest) && Array.isArray(manifest.rows) ? manifest.rows : Array.isArray(manifest) ? manifest : null;
  if (!rawRows) throw new BundleError('REVIEWED_BUNDLE_INVALID', 'manifest.json has no rows');
  const rows: ManifestRow[] = [];
  for (const r of rawRows) {
    if (!isRec(r) || typeof r.source_product_id !== 'string' || typeof r.handle !== 'string' || typeof r.queue_position !== 'number') {
      throw new BundleError('REVIEWED_BUNDLE_INVALID', 'a manifest row lacks its id, handle or queue position');
    }
    rows.push(r as unknown as ManifestRow);
  }
  rows.sort((a, b) => a.queue_position - b.queue_position);
  const bySid = new Map(rows.map((r) => [r.source_product_id, r]));
  if (bySid.size !== rows.length) throw new BundleError('REVIEWED_BUNDLE_INVALID', 'a source id appears twice in the manifest');

  const m = parsed['existing-matches.json'];
  const entries = Array.isArray(m) ? m : isRec(m) && Array.isArray(m.entries) ? m.entries : isRec(m) && Array.isArray(m.matches) ? m.matches : [];
  const matches = new Map<string, MatchEntry>();
  for (const e of entries) if (isRec(e) && typeof e.source_product_id === 'string' && typeof e.decision === 'string') matches.set(e.source_product_id, e as unknown as MatchEntry);

  const targetsJson = parsed['compat-targets.json'];
  const identityJson = parsed['identity-map.json'];
  const overridesJson = parsed['media-overrides.json'];
  const identity: Record<string, IdentityEntry> = {};
  const idEntries = isRec(identityJson) && isRec(identityJson.entries) ? identityJson.entries : {};
  for (const [handle, v] of Object.entries(idEntries)) {
    if (!isRec(v)) continue;
    identity[handle] = {
      ...(typeof v.model === 'string' && v.model ? { model: v.model } : {}),
      ...(typeof v.series === 'string' && v.series ? { series: v.series } : {}),
      ...(typeof v.family === 'string' && v.family ? { family: v.family } : {}),
    };
  }
  const overrides: MediaOverride[] = [];
  const ovList = isRec(overridesJson) && Array.isArray(overridesJson.overrides) ? overridesJson.overrides : [];
  for (const o of ovList) {
    if (!isRec(o) || typeof o.resourceFileId !== 'string') continue;
    overrides.push({
      resourceFileId: o.resourceFileId,
      ...(Array.isArray(o.valueIds) ? { valueIds: o.valueIds.filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(o.variantIds) ? { variantIds: o.variantIds.filter((x): x is string => typeof x === 'string') } : {}),
    });
  }
  return {
    dir,
    sha256: sums,
    rows,
    bySid,
    taxonomy: isRec(parsed['taxonomy-map.json']) ? (parsed['taxonomy-map.json'] as Rec) : {},
    matches,
    targets: isRec(targetsJson) ? (targetsJson as unknown as CompatTargets) : null,
    identity,
    overrides,
    curatedIndex: curatedIndexOf(parsed['curated/index.json']),
  };
}

/** The name a reviewed file is listed under, whatever prefix the Worker uses (`manifest`, `manifest.json`, `data/bambu-import/manifest.json`). */
export function reviewedName(key: string): string {
  let k = key.replace(/^\.?\/*/, '').replace(/^data\/bambu-import\//, '');
  if (!/\.json$/.test(k)) k = `${k}.json`;
  return k;
}

/** The files whose SHA-256 the Worker and the runner disagree on, or that one side does not list. */
export function reviewedDifferences(local: Record<string, string>, worker: Record<string, string>): string[] {
  const theirs = new Map(Object.entries(worker).map(([k, v]) => [reviewedName(k), v.toLowerCase()]));
  const out = new Set<string>();
  for (const [file, digest] of Object.entries(local)) if (theirs.get(file) !== digest) out.add(file);
  for (const file of theirs.keys()) if (!(file in local)) out.add(file);
  return [...out].sort();
}

/** The combined digest stored on the run row (`reviewed_bundle_sha256`): SHA-256 over the sorted "file sha256" lines. */
export function bundleDigest(sums: Record<string, string>): string {
  return sha256(
    Object.keys(sums)
      .sort()
      .map((file) => `${file} ${sums[file]}\n`)
      .join('')
  );
}

/** One `/manifest` row: identity fields the Worker re-checks against its bundle, and discovery fields. */
export function manifestRequestRow(row: ManifestRow, discoveredAt: string): Rec {
  return {
    source_product_id: row.source_product_id,
    handle: row.handle,
    type: row.type ?? '',
    curated: row.curated === true,
    hold_code: row.hold_code ?? '',
    queue_position: row.queue_position,
    canonical_url: row.canonical_url ?? '',
    source_collections: Array.isArray(row.source_collections) ? row.source_collections : [],
    breadcrumbs: '',
    discovery_sources: ['sitemap'],
    discovered_at: discoveredAt,
  };
}

/** The manifest in calls of at most 100 rows (§A.3). */
export function manifestBatches(rows: readonly ManifestRow[], discoveredAt: string, size = 100): Rec[][] {
  const out: Rec[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size).map((r) => manifestRequestRow(r, discoveredAt)));
  return out;
}

export type WriteMode = { mode: 'create' } | { mode: 'merge'; productId: string; publish: boolean } | { mode: 'hold' };

/** create / merge / hold from the reviewed existing-matches.json only (§E.1); names never decide. */
export function writeModeOf(bundle: ReviewedBundle, sid: string): WriteMode {
  const entry = bundle.matches.get(sid);
  if (!entry) return { mode: 'create' };
  if ((entry.decision === 'merge' || entry.decision === 'merge_publish') && entry.levonis_product_id) {
    return { mode: 'merge', productId: entry.levonis_product_id, publish: entry.decision === 'merge_publish' };
  }
  if (entry.decision === 'hold_owner_hidden' || entry.decision === 'merge' || entry.decision === 'merge_publish') return { mode: 'hold' };
  return { mode: 'create' };
}

/** The raw path segment of a product page: the sitemap's own spelling when the manifest kept it. */
export function rawHandleOf(row: ManifestRow): string {
  const raw = typeof row.seo_code_raw === 'string' && row.seo_code_raw ? row.seo_code_raw : encodeURIComponent(row.handle);
  return /^[A-Za-z0-9%._~-]+$/.test(raw) ? raw : encodeURIComponent(row.handle);
}

// ------------------------------------------------------------------ sitemaps (§I.3.1)

/** Every <loc> of a sitemap or sitemap index, entity-decoded. */
export function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    out.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return out;
}

/** Handles of `/products/<handle>` URLs, decoded and NFC. */
export function productHandles(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const m = /\/products\/([^/?#]+)\/?(?:[?#].*)?$/.exec(u);
    if (!m) continue;
    try {
      out.add(decodeURIComponent(m[1]).normalize('NFC'));
    } catch {
      out.add(m[1]);
    }
  }
  return [...out];
}

export interface SitemapDiff {
  listed: number;
  added: string[];
  removed: string[];
  fingerprint: string;
}

/** New handles (need a reviewed manifest commit) and handles no longer listed (COMPLETE ones stay published). */
export function sitemapDiff(listedHandles: readonly string[], rows: readonly ManifestRow[]): SitemapDiff {
  const listed = new Set(listedHandles);
  const known = new Set(rows.map((r) => r.handle));
  return {
    listed: listed.size,
    added: [...listed].filter((h) => !known.has(h)).sort(),
    removed: [...known].filter((h) => !listed.has(h)).sort(),
    fingerprint: sha256([...listed].sort().join('\n')),
  };
}
