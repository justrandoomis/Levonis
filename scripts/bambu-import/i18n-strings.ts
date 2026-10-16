/**
 * THE STRINGS TO TRANSLATE (docs/bambu-import/I18N-DESIGN.md §D).
 *
 *   npx tsx scripts/bambu-import/i18n-strings.ts \
 *     --corpus <scratchpad>/corpus/p0/raw --data data/bambu-import \
 *     --out <scratchpad>/i18n [--batch-size 250] [--existing data/bambu-import/translations]
 *
 * BUILT EXACTLY AS THE RUNNER BUILDS (scripts/bambu-import/run.ts `extract`):
 * the reviewed bundle (discover.ts `loadReviewedBundle`), then for each
 * manifest row in queue order its crawled page — `<corpus>/<handle with every
 * code point outside [A-Za-z0-9._-] as "_">.html.gz`, the crawler's own rule; a
 * `.status` file is a page withdrawn at the source — through `extractPage`,
 * the identity checks, `buildImportPayload` with the runner's inputs, and the
 * reviewed curated file when the gate gives one. NOTHING IS FETCHED: wiki and
 * tracker rows ENRICH adds are not in the corpus (open question Q3).
 *
 * COLLECTED as the writer stores them and the display reads them, in the
 * segments the overlay looks up (packages/catalog/src/bambuImport/i18n.ts
 * `slotSegments`: lines, a bullet kept aside, a table row's cells):
 *
 *   page  short_description · usage_title · usage_body · spec_value_text ·
 *         spec_list_item · spec_label (x.* keys) · box_item · test_method ·
 *         doc_title (not the registry's default) · relation_label (not a name)
 *   api   block_title · block_line · block_cell · faq_q · faq_a (the content
 *         blocks the storefront does not draw today; public API v1 carries them)
 *
 * EXCLUDED, each with its counter: owner-only rows; registry-authored strings
 * (their translations exist: a content block's BLOCK_TITLES heading is listed
 * under `authored` with the registry's own ar/ckb for the assembler);
 * names (a manifest title, a compat-targets label, compound or requirement
 * target, a registry model, «Bambu Lab» — or only names and connectors);
 * neutral strings (numbers, ranges, symbol units, codes, upper-case identity
 * terms, URLs and punctuation only); strings already in Arabic script; with
 * `--existing`, strings already committed; and English over 4,000 characters.
 *
 * OUTPUT: `strings.json` (every unique string by its key, with its kinds,
 * products, handles, a context and the local dictionary's seed), the batches
 * `batches/batch-NNN.json` (~250 strings; every page string before every api
 * string; a product's strings together; a string in the batch of its first
 * product), `glossary.json` (the app's existing vocabulary in three
 * languages), `names.json` (the names a translation keeps verbatim) and
 * `RULES.md` (the translators' rules). Byte-identical for the same inputs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extractPage, identityCrossCheck } from '@levonis/catalog/bambuImport/extract';
import { extractionFingerprint } from '@levonis/catalog/bambuImport/fingerprint';
import { buildImportPayload, type ImportPayload, type PayloadSpec } from '@levonis/catalog/bambuImport/payload';
import { EN_MAX, lineParts, nameForms, namesOnlyIn, normalizeSource, sourceHash, type TmKind } from '@levonis/catalog/bambuImport/i18n';
import { labelKey } from '@levonis/catalog/bambuImport/normalize';
import { BLOCK_TITLES, VALUE_STATE_LABELS, REGION_LABELS } from '@levonis/catalog/bambuImport/registry/labels';
import { DOCUMENT_TITLES, type DocumentKind } from '@levonis/catalog/bambuImport/registry/documents';
import { SPEC_KEYS, specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import { MODELS } from '@levonis/catalog/bambuImport/registry/models';
import { BASE_COLOURS } from '@levonis/catalog/bambuImport/registry/colours';
import { IDENTITY_TERMS, PHRASES, UNITS } from '../../worker/lib/translate/dictionary';
import { translateText } from '../../worker/lib/translate/index';
import { GROUP_LABELS } from '../../worker/lib/knowledge/labels';
import { isOwnerOnlyKey, publicDocumentUrl } from '../../worker/lib/knowledge/answer';
import { bundleDigest, loadReviewedBundle, writeModeOf, type ManifestRow, type ReviewedBundle } from './discover';
import { curatedGate, mergeCurated } from './enrich';
import { translationNames } from './i18nData';

// ------------------------------------------------------------------ the shapes

export const PAGE_KINDS: ReadonlySet<TmKind> = new Set<TmKind>([
  'short_description',
  'usage_title',
  'usage_body',
  'spec_value_text',
  'spec_list_item',
  'spec_label',
  'box_item',
  'test_method',
  'doc_title',
  'relation_label',
]);

export type Surface = 'page' | 'api';
export const surfaceOf = (kind: TmKind): Surface => (PAGE_KINDS.has(kind) ? 'page' : 'api');

/** One place a string was found in one product. */
export interface Occurrence {
  en: string;
  kind: TmKind;
  /** Where in the product (`specs[electrical.current]`, `usage[0].body`, `blocks[3].line[2]` …). */
  field: string;
  /** The neighbouring line, block title or spec label (≤ 160 characters). */
  near: string;
}

export interface StringEntry {
  h: string;
  en: string;
  kind: TmKind;
  kinds: Record<string, number>;
  surface: Surface;
  freq: number;
  products: string[];
  handles: string[];
  context: { handle: string; title: string; field: string; near: string };
  dict: { ar: string; ckb: string } | null;
}

export interface AuthoredEntry {
  h: string;
  en: string;
  ar: string;
  ckb: string;
  kind: TmKind;
  products: string[];
}

export interface ExcludedCounts {
  owner_only: number;
  registry: number;
  name: number;
  neutral: number;
  arabic: number;
  existing: number;
  too_long: number;
}

export interface KindCounts {
  unique: number;
  occurrences: number;
  chars: number;
}

export interface StringsFile {
  version: 1;
  generated_at: string;
  inputs: { corpus: string; code_commit: string; reviewed_bundle_sha256: string };
  counts: {
    products_built: number;
    products_failed: Array<{ handle: string; reason: string }>;
    products_withdrawn: string[];
    unique: number;
    occurrences: number;
    chars: number;
    by_kind: Record<string, KindCounts>;
    by_surface: Record<Surface, KindCounts>;
    excluded: ExcludedCounts;
    batches: { page: number; api: number };
  };
  strings: StringEntry[];
  authored: AuthoredEntry[];
}

export interface BatchFile {
  batch: number;
  surface: Surface;
  handles: string[];
  strings: Array<Pick<StringEntry, 'h' | 'en' | 'kind' | 'freq' | 'context' | 'dict'>>;
}

// ------------------------------------------------------------------ the classifiers

const IDENTITY = new Set(IDENTITY_TERMS);
/** The dictionary's units that are symbols, not English words («hours», «pack», «spool» are translated). */
const WORD_UNITS = new Set(['in', 'inch', 'inches', 'micron', 'microns', 'watt', 'watts', 'volt', 'volts', 'amp', 'amps', 'ampere', 'amperes', 'pcs', 'pc', 'pack', 'roll', 'rolls', 'spool', 'spools', 'set', 'sets', 'hour', 'hours', 'month', 'months', 'year', 'years', 'day', 'days', 'week', 'weeks']);
const SYMBOL_UNITS = new Set(Object.keys(UNITS).filter((u) => !WORD_UNITS.has(u) && !/\s/.test(u)));
const MODEL_CODE_RE = /^[A-Za-z]{0,3}\d+[A-Za-z0-9-]*$|^[A-Z]{1,6}\d[A-Za-z0-9-]*$/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** A token that reads the same in every language: a number, a range, a symbol unit, a code, an upper-case identity term. */
function neutralToken(tok: string): boolean {
  if (!tok) return true;
  if (/^[±~≤≥<>+-]?[\d.,]+(?:[-–~/][\d.,]+)*%?$/.test(tok)) return true;
  if (/^[x×*·°]$/i.test(tok)) return true;
  const lower = tok.toLowerCase();
  if (SYMBOL_UNITS.has(lower)) return true;
  if (MODEL_CODE_RE.test(tok) || /^[A-Z]{2,}\d/.test(tok)) return true;
  // An identity term as it is written in a spec sheet (PLA, PETG-CF, USB-C, 3MF), never a lower-case English word («step»).
  if (IDENTITY.has(lower) && (tok === tok.toUpperCase() || /[\d+-]/.test(tok))) return true;
  if (/^\d/.test(tok) && SYMBOL_UNITS.has(lower.replace(/^[\d.,]+/, ''))) return true;
  return false;
}

/** Nothing but numbers, ranges, symbol units, codes, identity terms, URLs and punctuation: no Latin word of 2+ letters. */
export function isNeutral(en: string): boolean {
  const text = en.replace(/https?:\/\/\S+/gi, ' ');
  for (const raw of text.split(/[\s,;:()[\]{}"“”‘’!?|&]+/)) {
    const tok = raw.replace(/^[^\p{L}\p{N}±~≤≥<>+-]+|[^\p{L}\p{N}%°]+$/gu, '');
    if (!tok || neutralToken(tok)) continue;
    // A hyphenated or slashed token is neutral when each of its parts is (PLA-CF, 220-240V, A1/A1 mini …).
    const parts = tok.split(/[-/–]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => neutralToken(p) || !/[A-Za-z]{2,}/.test(p))) continue;
    if (/[A-Za-z]{2,}/.test(tok)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ one product's occurrences

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The official spec group's value of a row (worker/lib/catalogImport/writer.ts `valueOf`, `mirrorable`). */
function officialValueOf(s: PayloadSpec): string | null {
  const mirrorable =
    s.visibility === 'public' &&
    s.scope_kind === 'product' &&
    (s.status === 'verified' || s.status === 'unverified') &&
    (s.region === '' || s.region === 'intl_220v') &&
    s.key !== 'package.contents' &&
    s.key !== 'compat.statement' &&
    !s.key.startsWith('manufacturer_terms.') &&
    s.key !== 'identity.family';
  if (!mirrorable) return null;
  const t = s.value_text.trim();
  if (t) return t.slice(0, 1000);
  if (s.value_num !== null) return null; // a number and its unit: neutral
  if (s.value_bool !== null) return s.value_bool ? 'Yes' : 'No';
  return null;
}

/** The content blocks as the writer stores them (writer.ts `contentBlocksOf`): a section's title once, as its first line. */
function storedBlocks(p: ImportPayload): Array<{ body: string; sectionKind: string; title: string }> {
  const out: Array<{ body: string; sectionKind: string; title: string }> = [];
  let shown = '';
  for (const b of p.content_blocks) {
    if (b.kind !== 'text') continue;
    const heading = b.title_en ? JSON.stringify([b.section_path, b.title_en]) : '';
    const body = b.title_en && heading !== shown && !b.body_en.startsWith(b.title_en) ? `${b.title_en}\n${b.body_en}` : b.body_en;
    if (!body.trim()) continue;
    if (heading) shown = heading;
    out.push({ body: body.slice(0, 20000), sectionKind: b.section_kind, title: b.title_en });
  }
  return out;
}

export interface CollectCounts {
  owner_only: number;
}

/** Every occurrence of imported English in one payload, in field order (§D "Collect"). */
export function occurrencesOf(p: ImportPayload, counts: CollectCounts = { owner_only: 0 }): Occurrence[] {
  const out: Occurrence[] = [];
  const add = (raw: string, kind: TmKind, field: string, near = '') => {
    const en = normalizeSource(raw);
    if (en) out.push({ en, kind, field, near: cut(normalizeSource(near), 160) });
  };
  /** A multi-line slot, segment by segment, as `translateLines` looks it up. */
  const lines = (body: string, field: string, kindOf: (lineIndex: number, line: string) => TmKind, cellKind: TmKind | null = null) => {
    const ls = body.split('\n');
    ls.forEach((line, i) => {
      const parts = lineParts(line);
      const near = ls[i - 1] ?? ls[i + 1] ?? '';
      const kind = kindOf(i, line);
      parts.segments.forEach((seg, j) => add(seg, parts.cells && cellKind ? cellKind : kind, parts.cells ? `${field}.line[${i}].cell[${j}]` : `${field}.line[${i}]`, near));
    });
  };

  // The description (writer: description_en = short_description_en).
  lines(p.product.short_description_en, 'description', () => 'short_description');
  // The usage guide: steps with a body only; the title ≤ 200 and the body ≤ 2,000 characters (writer step 9).
  p.product.usage_steps
    .filter((s) => s.body_en.trim() !== '')
    .forEach((s, i) => {
      lines(s.title_en.slice(0, 200), `usage[${i}].title`, () => 'usage_title');
      lines(s.body_en.slice(0, 2000), `usage[${i}].body`, () => 'usage_body');
    });
  // Specifications: what the knowledge answer reads (public, not owner-only) and the official group's values.
  for (const s of p.specs) {
    if (s.visibility !== 'public' || isOwnerOnlyKey(s.key, s.group)) {
      counts.owner_only += 1;
      continue;
    }
    // A code for filters, never drawn (knowledge NOT_DISPLAYED_KEYS, writer NOT_IN_SPEC_TABLE).
    if (s.key === 'identity.family') continue;
    const label = specKey(s.key)?.labels.en ?? s.original_label;
    if (s.key === 'package.contents') {
      s.value_list.forEach((item, i) => {
        const t = typeof item === 'string' ? text(item, 200) : item && typeof item === 'object' ? text(item.text, 200) : '';
        if (t) add(t, 'box_item', `box[${i}]`, label);
      });
      continue;
    }
    if (s.key.startsWith('x.')) add(text(s.original_label, 200) || s.key.replace(/^x\./, '').replace(/[-_]/g, ' '), 'spec_label', `specs[${s.key}].label`, s.value_text);
    if (s.data_type === 'list') {
      s.value_list.forEach((item, i) => {
        if (typeof item === 'string' && item.trim()) add(item.trim().slice(0, 200), 'spec_list_item', `specs[${s.key}].items[${i}]`, label);
      });
    } else if (s.value_text.trim()) {
      add(s.value_text.trim().slice(0, 1000), 'spec_value_text', `specs[${s.key}]`, label);
    }
    const official = officialValueOf(s);
    if (official && (s.data_type === 'list' || !s.value_text.trim())) add(official, 'spec_value_text', `spec_groups.sg_bambu_official[${s.key}]`, label);
    if (s.test_method.trim()) add(text(s.test_method, 200), 'test_method', `specs[${s.key}].test_method`, label);
  }
  // Documents a customer may follow, titled by the source (not the registry's default for the kind).
  for (const [i, d] of p.documents.entries()) {
    const title = text(d.title_en, 300);
    if (!title || !publicDocumentUrl(d.url)) continue;
    if (title === DOCUMENT_TITLES[d.kind as DocumentKind]?.en) continue;
    add(title, 'doc_title', `documents[${i}]`, d.kind);
  }
  // Relation labels (names are excluded later: the label is the target's name almost always).
  for (const [i, r] of p.relations.entries()) add(text(r.target_label, 300), 'relation_label', `relations[${i}]`, r.relation);
  // The content blocks (api surface): a section's title line, its lines and table cells; a FAQ's questions and answers.
  storedBlocks(p).forEach((b, bi) => {
    const faq = b.sectionKind === 'faq';
    let afterBlank = true;
    lines(
      b.body,
      `blocks[${bi}]`,
      (i, line) => {
        if (i === 0 && b.title && line.trim() === b.title.trim()) return 'block_title';
        if (!faq) return 'block_line';
        const q = afterBlank;
        afterBlank = line.trim() === '';
        return q ? 'faq_q' : 'faq_a';
      },
      'block_cell'
    );
  });
  return out;
}

// ------------------------------------------------------------------ the corpus

/** The crawler's file name of a handle (crawl.py: every code point outside [A-Za-z0-9._-] → "_"). */
export const corpusName = (handle: string): string => handle.replace(/[^A-Za-z0-9._-]/gu, '_');

export interface BuiltProduct {
  row: ManifestRow;
  payload: ImportPayload;
}

export interface BuildOutcome {
  built: BuiltProduct[];
  failed: Array<{ handle: string; reason: string }>;
  withdrawn: string[];
}

/** Every manifest row's payload, built exactly as the runner builds it, from the corpus alone. */
export function buildFromCorpus(corpus: string, dataDir: string, bundle: ReviewedBundle = loadReviewedBundle(dataDir)): BuildOutcome {
  const out: BuildOutcome = { built: [], failed: [], withdrawn: [] };
  for (const row of bundle.rows) {
    const base = join(corpus, corpusName(row.handle));
    if (existsSync(`${base}.status`)) {
      out.withdrawn.push(row.handle);
      continue;
    }
    if (!existsSync(`${base}.html.gz`)) {
      out.failed.push({ handle: row.handle, reason: 'missing' });
      continue;
    }
    try {
      const html = new TextDecoder().decode(gunzipSync(readFileSync(`${base}.html.gz`)));
      const x = extractPage(html).extraction;
      if (x.sourceProductId !== row.source_product_id || x.handle !== row.handle) {
        out.failed.push({ handle: row.handle, reason: 'identity' });
        continue;
      }
      if (!identityCrossCheck(x).ok) {
        out.failed.push({ handle: row.handle, reason: 'identity_cross_check' });
        continue;
      }
      const mode = writeModeOf(bundle, row.source_product_id);
      const build = buildImportPayload({
        extraction: x,
        writeMode: mode.mode === 'merge' ? 'merge' : 'create',
        mergeProductId: mode.mode === 'merge' ? mode.productId : undefined,
        extractionSha256: extractionFingerprint(x),
        manifestRow: row,
        identity: bundle.identity[row.handle] ?? null,
        targets: bundle.targets,
        overrides: bundle.overrides,
        retrievedAt: '2026-10-16T00:00:00.000Z',
      });
      if (build.report.errors.length) {
        out.failed.push({ handle: row.handle, reason: `build:${build.report.errors[0]}` });
        continue;
      }
      const payload = build.payload;
      const gate = curatedGate(dataDir, row.handle, row.curated === true, bundle.curatedIndex);
      if (gate.kind === 'ok') mergeCurated(payload, gate.file, gate.sha256);
      out.built.push({ row, payload });
    } catch (e) {
      out.failed.push({ handle: row.handle, reason: `extract:${e instanceof Error ? e.name : 'error'}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the strings

export interface CollectContext {
  /** Exact names (labelKey) and the forms for «only names» (nameForms). */
  nameKeys: ReadonlySet<string>;
  nameForms: readonly string[];
  /** Normalized English already committed (`--existing`). */
  existing: ReadonlySet<string>;
}

export function collectContext(bundle: ReviewedBundle, existing: ReadonlySet<string> = new Set()): CollectContext {
  const names = new Set<string>(translationNames(bundle));
  for (const r of bundle.rows) if (r.title) names.add(String(r.title));
  for (const m of MODELS) for (const f of m.forms) names.add(f);
  return { nameKeys: new Set([...names].map((n) => labelKey(n)).filter(Boolean)), nameForms: nameForms(names), existing };
}

/** Registry-authored English and its own Arabic and Sorani (block and document titles, spec, group, state and region labels). */
const REGISTRY_TRI: ReadonlyMap<string, { ar: string; ckb: string }> = new Map(
  [
    ...Object.values(BLOCK_TITLES),
    ...Object.values(DOCUMENT_TITLES),
    ...SPEC_KEYS.map((k) => k.labels),
    ...Object.values(GROUP_LABELS),
    ...Object.values(VALUE_STATE_LABELS),
    ...Object.values(REGION_LABELS),
  ]
    .filter((t) => t.en && t.ar && t.ckb)
    .map((t) => [normalizeSource(t.en), { ar: normalizeSource(t.ar), ckb: normalizeSource(t.ckb) }] as const)
);
const REGISTRY_EN: ReadonlySet<string> = new Set(REGISTRY_TRI.keys());

/** Why a string is not offered for translation, or null when it is. */
export function exclusionOf(en: string, kind: TmKind, ctx: CollectContext): keyof ExcludedCounts | null {
  if (en.length > EN_MAX) return 'too_long';
  if (ARABIC.test(en)) return 'arabic';
  if (isNeutral(en)) return 'neutral';
  // A name before the registry: «AMS» is a model, never a label to translate.
  if (ctx.nameKeys.has(labelKey(en)) || (en.length <= 300 && namesOnlyIn(en, ctx.nameForms))) return 'name';
  if (REGISTRY_EN.has(en) && kind !== 'spec_value_text' && kind !== 'spec_list_item' && kind !== 'box_item') return 'registry';
  if (ctx.existing.has(en)) return 'existing';
  return null;
}

/** The local dictionary's seed: both languages fully covered, the Sorani its own (row 183). */
export function dictSeed(en: string): { ar: string; ckb: string } | null {
  const ar = translateText(en, 'ar');
  const ckb = translateText(en, 'ckb');
  if (ar.status !== 'machine' || ckb.status !== 'machine') return null;
  const a = normalizeSource(ar.text);
  const k = normalizeSource(ckb.text);
  if (!a || !k || a === k || a === en || k === en) return null;
  return { ar: a, ckb: k };
}

export interface ExtractOptions {
  corpus: string;
  dataDir: string;
  batchSize?: number;
  existingDir?: string;
  generatedAt?: string;
  codeCommit?: string;
}

export interface ExtractResult {
  strings: StringsFile;
  batches: BatchFile[];
}

/** Normalized English of every row already committed under `dir`. */
export function existingEnglish(dir: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /^p[0-9]{3,}\.json$/.test(x)).sort()) {
    for (const r of JSON.parse(readFileSync(join(dir, f), 'utf8')) as Array<{ en: string }>) if (typeof r.en === 'string') out.add(r.en);
  }
  return out;
}

/** strings.json and the batches from built products (pure: tests hand it payloads directly). */
export function collectStrings(
  products: readonly BuiltProduct[],
  ctx: CollectContext,
  meta: { generatedAt: string; corpus: string; codeCommit: string; bundleSha256: string; failed?: BuildOutcome['failed']; withdrawn?: string[]; batchSize?: number }
): ExtractResult {
  const excluded: ExcludedCounts = { owner_only: 0, registry: 0, name: 0, neutral: 0, arabic: 0, existing: 0, too_long: 0 };
  const byEn = new Map<string, StringEntry & { order: [number, number] }>();
  const authored = new Map<string, AuthoredEntry>();
  const firstOf = new Map<string, number>();
  products.forEach(({ row, payload }, pi) => {
    const counts = { owner_only: 0 };
    const occ = occurrencesOf(payload, counts);
    excluded.owner_only += counts.owner_only;
    occ.forEach((o, fi) => {
      const why = exclusionOf(o.en, o.kind, ctx);
      if (why) {
        excluded[why] += 1;
        // A registry-authored string the overlay still looks up (a section's heading inside a content block): its own words.
        const tri = why === 'registry' ? REGISTRY_TRI.get(o.en) : undefined;
        if (tri) {
          const a = authored.get(o.en) ?? { h: sourceHash(o.en), en: o.en, ar: tri.ar, ckb: tri.ckb, kind: o.kind, products: [] };
          if (!a.products.includes(payload.product_id)) a.products.push(payload.product_id);
          authored.set(o.en, a);
        }
        return;
      }
      let e = byEn.get(o.en);
      if (!e) {
        e = {
          h: sourceHash(o.en),
          en: o.en,
          kind: o.kind,
          kinds: {},
          surface: surfaceOf(o.kind),
          freq: 0,
          products: [],
          handles: [],
          context: { handle: row.handle, title: String(row.title ?? ''), field: o.field, near: o.near },
          dict: null,
          order: [pi, fi],
        };
        byEn.set(o.en, e);
        firstOf.set(o.en, pi);
      }
      e.kinds[o.kind] = (e.kinds[o.kind] ?? 0) + 1;
      if (surfaceOf(o.kind) === 'page') e.surface = 'page';
      e.freq += 1;
      if (!e.products.includes(payload.product_id)) e.products.push(payload.product_id);
      if (!e.handles.includes(row.handle)) e.handles.push(row.handle);
    });
  });
  const entries = [...byEn.values()].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  for (const e of entries) {
    e.products.sort();
    e.dict = dictSeed(e.en);
  }
  const strings: StringEntry[] = entries.map(({ order: _order, ...rest }) => rest);

  // Counts.
  const zero = (): KindCounts => ({ unique: 0, occurrences: 0, chars: 0 });
  const byKind: Record<string, KindCounts> = {};
  const bySurface: Record<Surface, KindCounts> = { page: zero(), api: zero() };
  for (const e of strings) {
    const k = (byKind[e.kind] ??= zero());
    k.unique += 1;
    k.occurrences += e.freq;
    k.chars += e.en.length;
    const s = bySurface[e.surface];
    s.unique += 1;
    s.occurrences += e.freq;
    s.chars += e.en.length;
  }

  // Batches: every page string first, then api; a product's strings together; a string in its first product's batch.
  const size = Math.max(1, meta.batchSize ?? 250);
  const batches: BatchFile[] = [];
  for (const surface of ['page', 'api'] as const) {
    const byProduct = new Map<number, StringEntry[]>();
    for (const e of strings) {
      if (e.surface !== surface) continue;
      const pi = firstOf.get(e.en)!;
      const list = byProduct.get(pi);
      if (list) list.push(e);
      else byProduct.set(pi, [e]);
    }
    let cur: StringEntry[] = [];
    let handles: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      batches.push({
        batch: batches.length + 1,
        surface,
        handles,
        strings: cur.map((e) => ({ h: e.h, en: e.en, kind: e.kind, freq: e.freq, context: e.context, dict: e.dict })),
      });
      cur = [];
      handles = [];
    };
    for (const pi of [...byProduct.keys()].sort((a, b) => a - b)) {
      const list = byProduct.get(pi)!;
      if (cur.length && cur.length + list.length > size && cur.length >= Math.ceil(size / 2)) flush();
      const handle = products[pi].row.handle;
      for (const e of list) {
        if (cur.length >= size) flush();
        if (!handles.includes(handle)) handles.push(handle);
        cur.push(e);
      }
    }
    flush();
  }

  const all = strings.reduce((n, e) => n + e.freq, 0);
  return {
    strings: {
      version: 1,
      generated_at: meta.generatedAt,
      inputs: { corpus: meta.corpus, code_commit: meta.codeCommit, reviewed_bundle_sha256: meta.bundleSha256 },
      counts: {
        products_built: products.length,
        products_failed: meta.failed ?? [],
        products_withdrawn: meta.withdrawn ?? [],
        unique: strings.length,
        occurrences: all,
        chars: strings.reduce((n, e) => n + e.en.length, 0),
        by_kind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        by_surface: bySurface,
        excluded,
        batches: { page: batches.filter((b) => b.surface === 'page').length, api: batches.filter((b) => b.surface === 'api').length },
      },
      strings,
      authored: [...authored.values()].map((a) => ({ ...a, products: [...a.products].sort() })).sort((a, b) => (a.en < b.en ? -1 : a.en > b.en ? 1 : 0)),
    },
    batches,
  };
}

// ------------------------------------------------------------------ the glossary and the rules

export interface GlossaryEntry {
  en: string;
  ar: string;
  ckb: string;
  source: string;
}

/** The app's existing vocabulary in three languages, for the translators (never a translation of its own). */
export function glossary(bundle: ReviewedBundle, dataDir: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const add = (en: string, ar: string | undefined, ckb: string | undefined, source: string) => {
    if (en && ar && ckb && ckb !== ar) out.push({ en, ar, ckb, source });
  };
  for (const [en, t] of Object.entries(PHRASES)) add(en, t.ar, t.ckb, 'dictionary');
  for (const k of SPEC_KEYS) add(k.labels.en, k.labels.ar, k.labels.ckb, `spec:${k.key}`);
  for (const [g, t] of Object.entries(GROUP_LABELS)) add(t.en, t.ar, t.ckb, `group:${g}`);
  for (const [k, t] of Object.entries(BLOCK_TITLES)) add(t.en, t.ar, t.ckb, `block:${k}`);
  for (const [k, t] of Object.entries(DOCUMENT_TITLES)) add(t.en, t.ar, t.ckb, `document:${k}`);
  for (const [k, t] of Object.entries(VALUE_STATE_LABELS)) add(t.en, t.ar, t.ckb, `state:${k}`);
  for (const [k, t] of Object.entries(BASE_COLOURS)) add(t.en, t.ar, t.ckb, `colour:${k}`);
  const tax = bundle.taxonomy as { create?: Array<Record<string, unknown>> };
  for (const n of tax.create ?? []) add(String(n.name_en ?? ''), String(n.name_ar ?? ''), String(n.name_ckb ?? ''), `section:${String(n.slug ?? '')}`);
  const syn = JSON.parse(readFileSync(join(dataDir, 'search-synonyms.json'), 'utf8')) as { rows?: Array<Record<string, unknown>> };
  const byCanonical = new Map<string, { ar?: string; ckb?: string }>();
  for (const r of syn.rows ?? []) {
    const c = String(r.canonical ?? '');
    const lang = String(r.lang ?? '');
    if (!c || (lang !== 'ar' && lang !== 'ckb')) continue;
    const e = byCanonical.get(c) ?? {};
    if (!e[lang]) e[lang] = String(r.term ?? '');
    byCanonical.set(c, e);
  }
  for (const [c, e] of [...byCanonical].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) add(c, e.ar, e.ckb, 'search_synonym');
  return out;
}

export const RULES = `# Translating the imported Bambu Lab text (Arabic and Sorani)

docs/bambu-import/I18N-DESIGN.md; DECISIONS rows 2 and 183. These rules bind every translator and reviewer.

## What you write
For each batch \`batches/batch-NNN.json\`, write \`batches/batch-NNN.out.json\`:

    [ { "h": "<the string's h>", "ar": "<Arabic>", "ckb": "<Sorani>", "status": "reviewed" | "needs_review" } ]

One object per string you translate, \`h\` copied exactly. Leave a string out rather than guess: it stays English.
\`needs_review\` is stored and never shown. A reviewer signs off before \`reviewed\` is committed.

## The house rules
1. Product NAMES are never translated: product, option and colour names stay English (see names.json). A name inside a sentence is copied verbatim.
2. Model numbers, part codes, units and brand names stay in Latin script, exactly as written: X1C, A1 mini, SA011, M3*21.5, 4-Pin, 24V, 10mA, 0.4 mm, °C, PLA, PETG-CF, Bambu Lab.
3. Numbers stay Western digits (0-9), never Arabic-Indic digits; every number of the English appears in both translations.
4. Sorani (ckb) is real Central Kurdish in Arabic script, with its own letters (ە ێ ۆ ڵ ڕ) — never a copy of the Arabic.
5. Never add a price, a cost, stock, availability, delivery or shipping time — the English carries none, so a translation never does.
6. Write Arabic punctuation between Arabic words, and around Latin names inside Arabic sentences: ، ؛ ؟
7. Never put a bidi control character (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) in the text: the site isolates Latin runs itself.
8. Keep one line one line: no line break inside a translation; a bullet or a table separator is not part of the string.
9. Use the app's own words where they exist (glossary.json): the same spec label, section and colour names the site already shows.
10. The length stays reasonable: at most three times the English (or the English plus 200 characters).

## What is checked (packages/catalog/src/bambuImport/i18n.ts validateTranslationRow)
The key matches the English; the text is normalized (one space, no line break, NFC); Arabic has Arabic letters and no Sorani-only letter; Sorani has its letters once it has two words; the digits are the same; codes, upper-case terms (PLA, AMS, USB) and units after a number survive verbatim; names survive verbatim; no bidi control; no price, stock or shipping word. One failing row refuses its whole part at load time.
`;

// ------------------------------------------------------------------ the files

const json = (v: unknown) => `${JSON.stringify(v, null, 1)}\n`;
const pad3 = (n: number) => String(n).padStart(3, '0');

export function writeOutputs(out: string, result: ExtractResult, extra: { glossary: GlossaryEntry[]; names: string[] }): string[] {
  mkdirSync(out, { recursive: true });
  const dir = join(out, 'batches');
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^batch-\d{3,}\.json$/.test(f)) rmSync(join(dir, f));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(out, 'strings.json'), json(result.strings));
  const paths: string[] = [];
  for (const b of result.batches) {
    const p = join(dir, `batch-${pad3(b.batch)}.json`);
    writeFileSync(p, json(b));
    paths.push(p);
  }
  writeFileSync(join(out, 'glossary.json'), json({ version: 1, entries: extra.glossary }));
  writeFileSync(join(out, 'names.json'), json({ version: 1, names: extra.names }));
  writeFileSync(join(out, 'RULES.md'), RULES);
  return paths;
}

function newestMtime(dir: string): string {
  let t = 0;
  for (const f of readdirSync(dir)) t = Math.max(t, statSync(join(dir, f)).mtimeMs);
  return new Date(Math.floor(t / 1000) * 1000).toISOString();
}

function gitHead(root: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : '';
  } catch {
    return '';
  }
}

/** The whole extraction (§D): build, collect, batch. Reads the corpus and the reviewed files; fetches nothing. */
export function extractStrings(opts: ExtractOptions & { root?: string }): ExtractResult & { glossary: GlossaryEntry[]; names: string[] } {
  const bundle = loadReviewedBundle(opts.dataDir);
  const built = buildFromCorpus(opts.corpus, opts.dataDir, bundle);
  const ctx = collectContext(bundle, existingEnglish(opts.existingDir));
  const result = collectStrings(built.built, ctx, {
    generatedAt: opts.generatedAt ?? newestMtime(opts.corpus),
    corpus: opts.corpus,
    codeCommit: opts.codeCommit ?? gitHead(opts.root ?? process.cwd()),
    bundleSha256: bundleDigest(bundle.sha256),
    failed: built.failed,
    withdrawn: built.withdrawn,
    batchSize: opts.batchSize,
  });
  return { ...result, glossary: glossary(bundle, opts.dataDir), names: [...translationNames(bundle)].sort() };
}

export function main(argv = process.argv.slice(2)): number {
  const given: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) given[argv[i]] = argv[i + 1] ?? '';
  const root = resolve(new URL('../../', import.meta.url).pathname);
  if (!given['--corpus'] || !given['--out']) {
    process.stderr.write('usage: i18n-strings.ts --corpus <dir> --data <data/bambu-import> --out <dir> [--batch-size 250] [--existing <dir>]\n');
    return 2;
  }
  const r = extractStrings({
    corpus: resolve(given['--corpus']),
    dataDir: resolve(root, given['--data'] || 'data/bambu-import'),
    batchSize: given['--batch-size'] ? Number(given['--batch-size']) : 250,
    existingDir: given['--existing'] ? resolve(root, given['--existing']) : undefined,
    generatedAt: given['--generated-at'] || undefined,
    root,
  });
  const paths = writeOutputs(resolve(given['--out']), r, { glossary: r.glossary, names: r.names });
  const c = r.strings.counts;
  process.stdout.write(
    `[i18n-strings] products built ${c.products_built}, failed ${c.products_failed.length}, withdrawn ${c.products_withdrawn.length}; ` +
      `unique ${c.unique} (page ${c.by_surface.page.unique}, api ${c.by_surface.api.unique}), occurrences ${c.occurrences}, chars ${c.chars}; ` +
      `batches ${paths.length} (page ${c.batches.page}, api ${c.batches.api}); authored ${r.strings.authored.length}\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
