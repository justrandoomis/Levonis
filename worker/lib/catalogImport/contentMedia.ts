/**
 * THE CONTENT PASS OF A DELTA RUN (Bambu import spec §O.6; ./delta.ts).
 *
 * The bulk run recorded `failed` for some pictures of a product's DESCRIPTION (an image block of
 * `products.content_blocks`) and of its BOX (the picture of an item of a `package.contents` row of
 * `product_spec_values`). The import left them out (§C.4: the block was not written and the later blocks took its
 * `order`; the item kept its text without `media_key`). At the owner's request (2026-10-19) a content item of a delta
 * run (`discovery_sources` = `content_media:<closed run>`) puts each where the original write meant it — ONLY where
 * that field is still byte for byte what the import (or an earlier content pass) wrote:
 *
 *   EXTRACTING       the runner reads the store page again (robots.txt, ≥ 11 s apart) and rebuilds the payload exactly
 *                    as the importer builds it (never enriched); a page that no longer reads as the product, or is gone
 *                    at the store, is MOOT (nothing fetched or written; a later pass takes it again);
 *   VALIDATING       POST /items/:sid/content-plan: the payload with its description blocks and `package.contents`
 *                    rows only (`contentPayloadOf`: the text travels to PROVE positions; none of it is ever written but
 *                    an inserted picture's authored alt, itself checked), proved to be this item's product; the plan
 *                    (`planContent`): which failed medium goes where, and whether its field is provably the import's
 *                    (`proveDescription`, `proveBox`). Only media whose field is provable are fetched;
 *   INGESTING_MEDIA  the ordinary /media, which for a content item takes only failed media of the two roles;
 *   WRITING          POST /items/:sid/content-attach: everything again from a FRESH read (the plan is never trusted),
 *                    then ONE batch under the import guard (`commitContent`); a field changed between the read and
 *                    the batch aborts it whole, and the Worker reads once more and decides on that evidence;
 *   PUBLISHING       the ordinary /publish-finish (recompute, purge);
 *   VERIFYING_LIVE   POST /items/:sid/content-complete: the runner's anonymous reads (`/api/products/<slug>`: the block
 *                    on `/files/<key>`; `/api/products/<slug>/knowledge`: `in_the_box[].image`) and the Worker's own
 *                    recompute (each inserted picture still held in D1, every object in R2). What the owner removed
 *                    since, or a product hidden since, is not expected.
 *
 * "AS THE IMPORT WROTE IT" is rebuilt, never stored: the writer's own functions (`contentBlocksOf`,
 * `upgradeContentBlocks`, `boxValueListOf`) over the rebuilt payload, a picture present exactly where the closed run
 * stored it (and the write could prove it: `presentKeys`) or where an earlier content pass put it; each language from
 * the import's OWN records (its `product_translations` rows, written in the same batch as the product, and the
 * authored alts), never recomputed; every block slot's `translation_meta` as the import left it; the count of blocks
 * the write recorded. A field that is not provable is counted, never written: `not_imported`, `owner_edited`,
 * `source_changed` (`ContentOutcome` in ./delta.ts). Counts and codes only in answers and events; medium ids and keys
 * stay in `stage_data.content_media` (the checkpoint, with per-language fingerprints and digests for an undo).
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { fence, isFenceMiss } from '../operations';
import { loadRelationsResponse } from '../productPersistence';
import { upgradeContentBlocks, type ContentBlockV2 } from '../productModel';
import { TRANSLATION_VERSION } from '../translate';
import { isSpecStatus } from '../knowledge/labels';
import { assertImportPayload, type ImportPayload, type PayloadBoxItem, type PayloadContentBlock, type PayloadSpec } from '@levonis/catalog/bambuImport/payload';
import { specRowId } from '@levonis/catalog/bambuImport/specs';
import { H, sha256Hex } from '@levonis/catalog/bambuImport/hash';
import { canonicalJson } from '@levonis/catalog/bambuImport/fingerprint';
import { stripQuery } from '@levonis/catalog/bambuImport/normalize';
import { altText } from '@levonis/catalog/bambuImport/registry/labels';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import { liveUrlOf } from './complete';
import {
  CONTENT_FINAL,
  CONTENT_OUTCOMES,
  CONTENT_PASSING,
  CONTENT_ROLES,
  CONTENT_RULE,
  contentQueue,
  contentSettledElsewhere,
  contentSettledIds,
  deltaDoorKindOf,
  deltaMarkOf,
  type ContentOutcome,
  type DeltaMark,
} from './delta';
import { stageDataOf, type ItemRow } from './items';
import { importObjectHead } from './media';
import { IMPORT_GUARD_ID } from './protectedTables';
import { payloadSha256, type ReviewedBundle } from './reviewed';
import { boxValueListOf, ckbNotCopy, contentBlocksOf, ImportWriteRefused, mapScopeOf, mergeMapping, readbackTargetOf, refusalOfBatch, type MergeMapping } from './writer';

export { CONTENT_FINAL, CONTENT_OUTCOMES, CONTENT_PASSING, CONTENT_ROLES, CONTENT_RULE, contentQueue, contentSettledElsewhere, contentSettledIds };
export type { ContentOutcome };

type ContentEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

export type ContentCounts = Record<ContentOutcome, number>;
export const emptyContentCounts = (): ContentCounts => Object.fromEntries(CONTENT_OUTCOMES.map((k) => [k, 0])) as ContentCounts;

/** Best first: the outcome of a medium shown at several places (a box picture of several rows). */
const PRIORITY: readonly ContentOutcome[] = ['attached', 'already_present', 'owner_removed', 'not_stored', 'owner_edited', 'source_changed', 'not_imported', 'not_on_page'];
export const bestOutcome = (list: readonly ContentOutcome[]): ContentOutcome => PRIORITY.find((o) => list.includes(o)) ?? list[0] ?? 'not_on_page';

/** The moots a runner may report: the page no longer reads as this product, or the store page is gone. */
export const CONTENT_MOOTS: ReadonlySet<string> = new Set(['identity_changed', 'source_gone']);
/** The digest a moot plan records in place of a payload's (never the media pass's: its own key). */
export const contentMootSha = (code: string): string => payloadSha256({ content_media_moot: code });

/** The keys of a stored description block, in the model's own order (productModel.ts upgradeContentBlocks). */
export const BLOCK_KEYS = ['id', 'kind', 'order', 'body_ar', 'body_en', 'body_ckb', 'caption_ar', 'caption_en', 'caption_ckb', 'alt_ar', 'alt_en', 'alt_ckb', 'url', 'media_key'] as const;
const BLOCK_SLOTS = ['body', 'caption', 'alt'] as const;

/** The import wrote its translation rows in the batch that recorded WRITTEN: their time, within this margin. */
export const TRANSLATION_MARGIN_MS = 10 * 60_000;
/** D1's row limit is 2,000,000 bytes, the whole products row: the new description keeps a margin under it. */
export const PRODUCT_ROW_LIMIT = 1_900_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const utf8 = (s: string): number => new TextEncoder().encode(s).byteLength;

// ---------------------------------------------------------------- what the proof reads

export interface ClosedMedium {
  status: string;
  r2_key: string;
}

export interface TranslationRow {
  source_en: string;
  text_ar: string;
  text_ckb: string;
  status: string;
  translation_version: number;
  updated_at: string;
}

export interface BoxRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  region: string;
  visibility: string;
  status: string;
  value_list: string;
  value_text: string;
}

/** What earlier content passes put in for this product (their checkpoints): block id → key, `row#index` → key. */
export interface EarlierInserted {
  blocks: Map<string, string>;
  box: Map<string, string>;
}

/** Everything the proof of "as the import wrote it" reads, as read (pure functions below decide on it). */
export interface ContentState {
  productId: string;
  merge: boolean;
  /** products.content_blocks, translation_meta and spec_fields, the raw stored text. */
  t0: string;
  m0: string;
  specFields: string;
  /** product_source_refs.fingerprint: the extraction the import wrote from. */
  fingerprint: string;
  /** The closed item's conflicts: the merge kept the owner's description; an aux medium was not stored (HEAD). */
  keptExisting: boolean;
  headConflict: boolean;
  /** stage_data.written.content_blocks of the closed item (null: not recorded). */
  writtenBlocks: number | null;
  /** The closed item's WRITTEN event time ('' when none). */
  writtenAt: string;
  /** The write's readback target's description, when it still survives (JSON text), else null. */
  readbackBlocks: string | null;
  closedMedia: ReadonlyMap<string, ClosedMedium>;
  /** product_translations rows of block slots (`block:<id>:<slot>`). */
  translations: ReadonlyMap<string, TranslationRow>;
  /** The closed run's own `package.contents` rows of the product (import_run_id = the closed run). */
  boxRows: readonly BoxRow[];
  earlier: EarlierInserted;
  /** A merge's reviewed value map applied to the product as it stands (null: a create, or not mapped). */
  mapping: MergeMapping | null;
  mergeOk: boolean;
}

const unchangedPage = (state: Pick<ContentState, 'fingerprint'>, payload: ImportPayload): boolean => !!state.fingerprint && payload.extraction_sha256 === state.fingerprint;

/** The key of a closed-run medium the write could have used (stored, with a key). */
const closedKey = (state: Pick<ContentState, 'closedMedia'>, sid: string): string => {
  const m = state.closedMedia.get(sid);
  return m && m.status === 'stored' && m.r2_key ? m.r2_key : '';
};

// ---------------------------------------------------------------- the description (pure)

export interface DescriptionProof {
  ok: boolean;
  /** When not ok: the code every description medium of the product gets. */
  label: ContentOutcome;
  reason: string;
  /** The key of each picture of the field as written, by source medium id (the closed run's, or an earlier pass's). */
  present: Map<string, string>;
  /** T0's blocks by id (when T0 parses). */
  stored: Map<string, Record<string, unknown>>;
  /** Pictures the closed run stored that its write could not prove (HEAD absent): not in the field, never failed. */
  storedNotWritten: number;
}

/** Per-language projections of a description (diagnosis only: the commit compares the exact stored text). */
export function languageFingerprints(blocks: ReadonlyArray<Record<string, unknown>>): { en: string; ar: string; ckb: string } {
  const pick = (keys: readonly string[]) => sha256Hex(canonicalJson(blocks.map((b) => keys.map((k) => b[k] ?? null))));
  return {
    en: pick(['id', 'kind', 'order', 'body_en', 'caption_en', 'alt_en', 'url', 'media_key']),
    ar: pick(['id', 'body_ar', 'caption_ar', 'alt_ar']),
    ckb: pick(['id', 'body_ckb', 'caption_ckb', 'alt_ckb']),
  };
}

/**
 * The description as the import (and every earlier content pass) wrote it: the writer's own `contentBlocksOf` over the
 * rebuilt payload with a picture wherever `keyBySid` names its key, through the model's reader, each text block's
 * Arabic and Sorani from the import's own translation row (never recomputed: the dictionary changed during the bulk
 * run), each picture's alt the payload's authored triple (as the writer stored it).
 */
export function expectedBlocks(payload: ImportPayload, keyBySid: ReadonlyMap<string, string>, translations: ReadonlyMap<string, TranslationRow>): ContentBlockV2[] {
  const blocks = upgradeContentBlocks(
    contentBlocksOf(payload, (sid) => {
      const k = keyBySid.get(sid);
      return k ? { r2_key: k } : null;
    })
  );
  for (const b of blocks) {
    if (b.kind !== 'text') continue;
    const row = translations.get(`block:${b.id}:body`);
    if (!row) continue;
    b.body_ar = row.text_ar;
    b.body_ckb = row.text_ckb;
  }
  return blocks;
}

/**
 * Pure: whether `products.content_blocks` is EXACTLY the description the import wrote (plus what earlier content
 * passes put in), and which pictures it holds. In this order:
 *
 *   1. what the closed item recorded: a merge that kept the owner's description (`field_kept_existing`), a count of
 *      blocks never recorded, a merge whose description held nothing the import filled → `not_imported`;
 *   2. the stored text itself: canonical JSON of blocks with exactly the model's keys, orders 0..n-1, unique ids;
 *   3. DURABLE evidence, whatever the page says: every stored block the import wrote against the import's own
 *      translation row (written in the WRITTEN batch: same English, Arabic and Sorani, `review_needed`, this
 *      translation version, the write's time) and its `translation_meta` as the import left it; a block an earlier
 *      pass put in carries neither → `owner_edited` (a row from before the write: `not_imported`, the merge's);
 *   4. the write's readback target, when it survives: byte for byte;
 *   5. the rebuild: the import's blocks count is the one the write recorded, and the stored text is byte for byte the
 *      expected one → else `owner_edited` when the store page is unchanged (its extraction fingerprint is the one the
 *      import wrote from), `source_changed` when it changed.
 *
 * Presence (`present`): a picture the closed run stored is expected in the field — unless the closed item recorded
 * that a stored medium could not be proved at the write (`image_review / media.not_stored`): then the field's own key
 * decides, and the count recorded catches a picture the owner deleted.
 */
export function proveDescription(state: ContentState, payload: ImportPayload): DescriptionProof {
  const present = new Map<string, string>();
  const stored = new Map<string, Record<string, unknown>>();
  let storedNotWritten = 0;
  const out = (ok: boolean, label: ContentOutcome, reason: string): DescriptionProof => ({ ok, label, reason, present, stored, storedNotWritten });
  const fail = (label: ContentOutcome, reason: string) => out(false, label, reason);
  const changed = (reason: string) => fail(unchangedPage(state, payload) ? 'owner_edited' : 'source_changed', reason);

  if (state.keptExisting) return fail('not_imported', 'kept_existing');
  if (state.writtenBlocks === null || !state.writtenAt || !Number.isFinite(Date.parse(state.writtenAt))) return fail('not_imported', 'unrecorded');
  if (state.merge && state.writtenBlocks <= 0) return fail('not_imported', 'merge_unfilled');

  let parsed: unknown;
  try {
    parsed = JSON.parse(state.t0);
  } catch {
    return fail('owner_edited', 'json');
  }
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== state.t0) return fail('owner_edited', 'json');
  const raw = parsed as unknown[];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (!isObj(b) || Object.keys(b).join() !== BLOCK_KEYS.join() || typeof b.id !== 'string' || stored.has(b.id)) return fail('owner_edited', 'json');
    if (b.order !== i) return fail('owner_edited', 'order');
    stored.set(b.id, b);
  }

  let meta: unknown;
  try {
    meta = JSON.parse(state.m0 || '{}');
  } catch {
    return fail('owner_edited', 'meta');
  }
  if (!isObj(meta)) return fail('owner_edited', 'meta');
  const writtenAt = Date.parse(state.writtenAt);
  for (const b of raw as Array<Record<string, unknown>>) {
    const id = String(b.id);
    const slotsOf = BLOCK_SLOTS.map((sl) => `block:${id}:${sl}`);
    if (state.earlier.blocks.has(id)) {
      // An earlier pass's picture: exactly as its batch left it — no translation row, no meta (an owner's save adds both).
      if (slotsOf.some((k) => k in meta || state.translations.has(k))) return fail('owner_edited', 'meta');
      continue;
    }
    const wanted = b.kind === 'text' ? 'body' : b.kind === 'image' ? 'alt' : '';
    for (const sl of BLOCK_SLOTS) {
      const k = `block:${id}:${sl}`;
      const row = state.translations.get(k);
      const en = typeof b[`${sl}_en`] === 'string' ? (b[`${sl}_en`] as string) : '';
      if (sl !== wanted || !en.trim()) {
        if (row || k in meta) return fail('owner_edited', 'meta');
        continue;
      }
      if (!row) return fail(state.merge ? 'not_imported' : 'owner_edited', 'translation');
      const at = Date.parse(row.updated_at);
      if (!Number.isFinite(at) || at > writtenAt + TRANSLATION_MARGIN_MS) return fail('owner_edited', 'translation');
      if (at < writtenAt - TRANSLATION_MARGIN_MS) return fail(state.merge ? 'not_imported' : 'owner_edited', 'translation');
      if (row.status !== 'review_needed' || Number(row.translation_version) !== TRANSLATION_VERSION) return fail('owner_edited', 'translation');
      if (row.source_en !== en || row.text_ar !== b[`${sl}_ar`] || row.text_ckb !== b[`${sl}_ckb`]) return fail('owner_edited', 'lang');
      const status = b.kind === 'image' ? 'approved' : 'imported';
      const m = (meta as Record<string, unknown>)[k];
      if (!isObj(m) || Object.keys(m).some((l) => l !== 'ar' && l !== 'ckb')) return fail('owner_edited', 'meta');
      for (const l of ['ar', 'ckb'] as const) {
        const e = m[l];
        if (!isObj(e) || e.status !== status) return fail('owner_edited', 'meta');
      }
    }
  }

  if (state.readbackBlocks !== null) {
    const importOnly = (raw as Array<Record<string, unknown>>).filter((b) => !state.earlier.blocks.has(String(b.id))).map((b, i) => ({ ...b, order: i }));
    if (JSON.stringify(importOnly) !== state.readbackBlocks) return fail('owner_edited', 'readback');
  }

  for (const b of payload.content_blocks) {
    if (b.kind !== 'image' || !b.source_media_id) continue;
    const earlier = state.earlier.blocks.get(b.id);
    if (earlier) {
      present.set(b.source_media_id, earlier);
      continue;
    }
    const k = closedKey(state, b.source_media_id);
    if (!k) continue;
    if (!state.headConflict) {
      present.set(b.source_media_id, k);
      continue;
    }
    const t = stored.get(b.id);
    if (t && t.kind === 'image' && t.media_key === k) present.set(b.source_media_id, k);
    else storedNotWritten++;
  }
  const expected = expectedBlocks(payload, present, state.translations);
  const importCount = expected.filter((b) => !state.earlier.blocks.has(b.id)).length;
  if (importCount !== state.writtenBlocks) return changed('count');
  const text = JSON.stringify(expected);
  if (text !== state.t0) {
    const a = languageFingerprints(expected as unknown as Array<Record<string, unknown>>);
    const s = languageFingerprints(raw as Array<Record<string, unknown>>);
    return changed(a.en !== s.en ? 'en' : a.ar !== s.ar ? 'ar' : a.ckb !== s.ckb ? 'ckb' : 'structure');
  }
  return out(true, 'owner_edited', '');
}

/** The description with `inserted` block ids taken out and `order` renumbered: what an undo writes back. */
export function undoBlocks(text: string, inserted: ReadonlySet<string>): string {
  const blocks = JSON.parse(text) as Array<Record<string, unknown>>;
  return JSON.stringify(blocks.filter((b) => !inserted.has(String(b.id))).map((b, i) => ({ ...b, order: i })));
}

// ---------------------------------------------------------------- the box (pure)

export interface BoxProof {
  spec: PayloadSpec;
  /** The row the write gave this spec ('' when the merge's map does not merge its scope). */
  rowId: string;
  row: BoxRow | null;
  list: unknown[] | null;
  ok: boolean;
  label: ContentOutcome;
  reason: string;
  /** The key of each item of the row as written, by item index. */
  keyAt: Map<number, string>;
  v0: string;
}

/** The first box row the writer mirrors into spec_fields.in_the_box (writer.ts specFieldMirror). */
const mirroredBox = (payload: ImportPayload): PayloadSpec | undefined =>
  payload.specs.find((s) => s.key === 'package.contents' && s.scope_kind === 'product' && s.visibility === 'public' && s.value_text.trim() !== '');

/**
 * Pure: each `package.contents` row of the payload with box items, matched ONE TO ONE to the row the closed run wrote
 * for it (its id: the payload's for a create, the reviewed map's for a merge, as the writer computes it; its scope and
 * region; `import_run_id` the closed run), and whether that row is byte for byte the writer's mapping of the rebuilt
 * spec (`boxValueListOf`, a key where the closed run stored the picture or an earlier pass put it) with the same text.
 * A curated list (plain strings), a scope the merge does not map, a row the closed run did not write: `not_imported`;
 * the in-the-box mirror (spec_fields.in_the_box) no longer the row's text: `owner_edited` (a merge: `not_imported`,
 * it filled the mirror only when it was empty); a row not as rebuilt: `owner_edited` / `source_changed` by the page.
 */
export function proveBox(state: ContentState, payload: ImportPayload): BoxProof[] {
  const out: BoxProof[] = [];
  const mirrored = mirroredBox(payload);
  let mirror: string | null = null;
  let mirrorBad = false;
  try {
    const sf = JSON.parse(state.specFields || '{}') as unknown;
    if (isObj(sf) && sf.in_the_box !== undefined) mirror = typeof sf.in_the_box === 'string' ? sf.in_the_box : null;
    if (isObj(sf) && sf.in_the_box !== undefined && typeof sf.in_the_box !== 'string') mirrorBad = true;
  } catch {
    mirrorBad = true;
  }
  const changed = unchangedPage(state, payload) ? 'owner_edited' : 'source_changed';
  for (const s of payload.specs) {
    if (s.key !== 'package.contents' || !s.value_list.some(isObj)) continue;
    const base: BoxProof = { spec: s, rowId: '', row: null, list: null, ok: false, label: 'not_imported', reason: '', keyAt: new Map(), v0: '' };
    const scope = state.merge ? (state.mergeOk ? mapScopeOf(state.mapping, s.scope_kind, s.scope_id) : null) : { kind: s.scope_kind, id: s.scope_id };
    if (!scope) {
      out.push({ ...base, reason: 'scope' });
      continue;
    }
    const rowId = scope.kind === s.scope_kind && scope.id === s.scope_id ? s.id : specRowId(state.productId, s.key, scope.kind, scope.id, s.region);
    const row = state.boxRows.find((r) => r.id === rowId) ?? null;
    // One to one: a row a payload spec before this one already claims (two scopes a merge maps onto one) was written
    // for that one (the writer keeps the first), never for this.
    if (out.some((p) => p.rowId === rowId)) {
      out.push({ ...base, reason: 'row' });
      continue;
    }
    if (!row || row.scope_kind !== scope.kind || row.scope_id !== scope.id || row.region !== s.region) {
      out.push({ ...base, rowId, row, reason: 'row' });
      continue;
    }
    let list: unknown;
    try {
      list = JSON.parse(row.value_list);
    } catch {
      list = null;
    }
    if (!Array.isArray(list) || JSON.stringify(list) !== row.value_list) {
      out.push({ ...base, rowId, row, label: 'owner_edited', reason: 'json' });
      continue;
    }
    if (!list.some(isObj)) {
      out.push({ ...base, rowId, row, list, reason: 'curated' });
      continue;
    }
    const keyAt = new Map<number, string>();
    s.value_list.forEach((item, i) => {
      if (!isObj(item)) return;
      const sid = (item as unknown as PayloadBoxItem).source_media_id;
      if (!sid) return;
      const earlier = state.earlier.box.get(`${rowId}#${i}`);
      if (earlier) {
        keyAt.set(i, earlier);
        return;
      }
      const k = closedKey(state, sid);
      if (!k) return;
      const r = list[i];
      if (!state.headConflict || (isObj(r) && r.media_key === k)) keyAt.set(i, k);
    });
    const v0 = JSON.stringify(boxValueListOf(s.value_list, (_item, i) => keyAt.get(i) ?? ''));
    const p = { ...base, rowId, row, list, keyAt, v0 };
    if (v0 !== row.value_list || row.value_text !== s.value_text) {
      out.push({ ...p, label: changed, reason: 'row_text' });
      continue;
    }
    if (s === mirrored && (mirrorBad || (mirror !== null && mirror !== s.value_text.trim().slice(0, 2000)))) {
      out.push({ ...p, label: state.merge ? 'not_imported' : 'owner_edited', reason: 'mirror' });
      continue;
    }
    out.push({ ...p, ok: true, label: 'owner_edited', reason: '' });
  }
  return out;
}

// ---------------------------------------------------------------- the plan (pure)

export interface ContentRequest {
  source_media_id: string;
  role: 'description' | 'in_the_box';
  source_url: string;
}

export interface FailedContentMedium {
  source_media_id: string;
  role: 'description' | 'in_the_box';
}

export interface ContentPlan {
  /** Every failed medium: its outcome, or `planned` (fetched, then attached or not_stored at the attach). */
  outcomes: Map<string, ContentOutcome | 'planned'>;
  reasons: Map<string, string>;
  requests: ContentRequest[];
  description: DescriptionProof | null;
  box: BoxProof[];
  /** The planned occurrences of each planned in-the-box medium. */
  occurrences: Map<string, Array<{ proof: BoxProof; index: number }>>;
  storedNotWritten: number;
}

/**
 * Pure: the plan of a content item over its state and the rebuilt payload. A product that is not public (hidden, or
 * gone) gets nothing (`product_not_public`); every other failed medium is placed by the payload — a description
 * picture at its image block, an in-the-box picture at every item showing it — and planned only where its field is
 * provable; what the field already holds is `already_present`, what an earlier pass put there and the field no longer
 * holds is `owner_removed` (never put back).
 */
export function planContent(state: ContentState | null, payload: ImportPayload, failed: readonly FailedContentMedium[], active: boolean): ContentPlan {
  const outcomes = new Map<string, ContentOutcome | 'planned'>();
  const reasons = new Map<string, string>();
  const requests: ContentRequest[] = [];
  const occurrences = new Map<string, Array<{ proof: BoxProof; index: number }>>();
  const plan: ContentPlan = { outcomes, reasons, requests, description: null, box: [], occurrences, storedNotWritten: 0 };
  if (!state || !active) {
    for (const f of failed) outcomes.set(f.source_media_id, 'product_not_public');
    return plan;
  }
  const description = failed.some((f) => f.role === 'description') ? proveDescription(state, payload) : null;
  const box = failed.some((f) => f.role === 'in_the_box') ? proveBox(state, payload) : [];
  plan.description = description;
  plan.box = box;
  plan.storedNotWritten = description?.storedNotWritten ?? 0;
  for (const f of failed) {
    const id = f.source_media_id;
    if (f.role === 'description') {
      const b = payload.content_blocks.find((x) => x.kind === 'image' && x.source_media_id === id);
      if (!b) {
        outcomes.set(id, 'not_on_page');
        continue;
      }
      const t = description!.stored.get(b.id);
      if (t && t.kind === 'image' && typeof t.media_key === 'string' && t.media_key) outcomes.set(id, 'already_present');
      else if (state.earlier.blocks.has(b.id)) outcomes.set(id, 'owner_removed');
      else if (!description!.ok) {
        outcomes.set(id, description!.label);
        reasons.set(id, description!.reason);
      } else {
        outcomes.set(id, 'planned');
        requests.push({ source_media_id: id, role: 'description', source_url: b.source_url });
      }
      continue;
    }
    const found: Array<{ proof: BoxProof; index: number }> = [];
    for (const proof of box) proof.spec.value_list.forEach((item, index) => isObj(item) && (item as unknown as PayloadBoxItem).source_media_id === id && found.push({ proof, index }));
    if (!found.length) {
      outcomes.set(id, 'not_on_page');
      continue;
    }
    const each: ContentOutcome[] = [];
    const planned: Array<{ proof: BoxProof; index: number }> = [];
    let reason = '';
    for (const o of found) {
      const r = o.proof.list?.[o.index];
      const item = o.proof.spec.value_list[o.index] as unknown as PayloadBoxItem;
      if (isObj(r) && typeof r.media_key === 'string' && r.media_key && r.text === item.text) each.push('already_present');
      else if (o.proof.rowId && state.earlier.box.has(`${o.proof.rowId}#${o.index}`)) each.push('owner_removed');
      else if (!o.proof.ok) {
        each.push(o.proof.label);
        reason ||= o.proof.reason;
      } else planned.push(o);
    }
    const best = bestOutcome(each);
    // A planned occurrence is fetched unless one already shows it (or an earlier pass's was removed by the owner).
    if (planned.length && !(each.includes('already_present') || each.includes('owner_removed'))) {
      outcomes.set(id, 'planned');
      occurrences.set(id, planned);
      requests.push({ source_media_id: id, role: 'in_the_box', source_url: (found[0].proof.spec.value_list[found[0].index] as unknown as PayloadBoxItem).source_url });
    } else {
      outcomes.set(id, each.length ? best : 'not_on_page');
      if (reason && !CONTENT_FINAL.has(best)) reasons.set(id, reason);
    }
  }
  return plan;
}

// ---------------------------------------------------------------- the item, its closed item and the product

export interface ContentContext {
  mark: DeltaMark;
  closedItemId: string;
  productId: string;
  /** The product's slug as it stands now (the owner may have renamed it), else the closed item's. */
  slug: string;
  merge: boolean;
  active: boolean;
  /** The product the closed run wrote is gone, or no longer carries the source. */
  gone: boolean;
  /** The closed run's failed media of the two roles that no earlier content item settled. */
  failed: FailedContentMedium[];
  state: ContentState | null;
  /** The whole products row in bytes (D1's row limit). */
  rowBytes: number;
  /** COUNT || ':' || MAX(updated_at) of the product's block translation rows, as the guard computes it. */
  translationsDigest: string;
}

/** The checkpoint an item's attach wrote (`stage_data.content_media`). */
export interface ContentCheckpoint {
  rule: number;
  counts: ContentCounts;
  media: Record<string, ContentOutcome>;
  reasons: Record<string, string>;
  inserted: { blocks: Array<{ id: string; r2_key: string }>; box: Array<{ row_id: string; index: number; r2_key: string }> };
  fp: { before: { en: string; ar: string; ckb: string } | null; after: { en: string; ar: string; ckb: string } | null };
  sha: { t0: string; t1: string; box: Array<{ row_id: string; v0: string; v1: string }> };
  stored_not_written: number;
}

/** The inserted pictures a checkpoint recorded; empty for anything else. */
export function insertedOf(stageData: unknown): ContentCheckpoint['inserted'] {
  let data: unknown;
  try {
    data = typeof stageData === 'string' ? JSON.parse(stageData || '{}') : stageData;
  } catch {
    data = {};
  }
  const c = isObj(data) && isObj(data.content_media) ? data.content_media : {};
  const ins = isObj(c.inserted) ? c.inserted : {};
  const blocks = (Array.isArray(ins.blocks) ? ins.blocks : []).flatMap((b) => (isObj(b) && typeof b.id === 'string' && typeof b.r2_key === 'string' ? [{ id: b.id, r2_key: b.r2_key }] : []));
  const box = (Array.isArray(ins.box) ? ins.box : []).flatMap((b) =>
    isObj(b) && typeof b.row_id === 'string' && Number.isInteger(b.index) && typeof b.r2_key === 'string' ? [{ row_id: b.row_id, index: Number(b.index), r2_key: b.r2_key }] : []
  );
  return { blocks, box };
}

/** The item as a content item of this run, or refused (IMPORT_DELTA_REFUSED): its mark. */
async function contentMark(db: D1Database, item: Pick<ItemRow, 'id'>): Promise<DeltaMark> {
  const row = await db.prepare('SELECT discovery_sources FROM catalog_import_items WHERE id = ?').bind(item.id).first<{ discovery_sources: string }>();
  const mark = deltaMarkOf(row?.discovery_sources ?? '');
  if (!mark || mark.kind !== 'content' || deltaDoorKindOf(row?.discovery_sources ?? '') !== 'content') throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  return mark;
}

/**
 * A content item of this run, with everything its proof reads: the closed run's COMPLETE item that wrote the product
 * (an ordinary item, or a delta's new product), the product the import wrote for this source (product_source_refs),
 * the failed media of the two roles no earlier content item settled, and — unless the product is gone — the stored
 * fields, the closed item's record (its conflicts, the count of blocks it wrote, its WRITTEN time, a surviving
 * readback target), the closed run's media rows, the import's translation rows of block slots, the closed run's own
 * box rows, and what earlier content passes put in.
 */
export async function contentContext(db: D1Database, item: ItemRow): Promise<ContentContext> {
  const mark = await contentMark(db, item);
  const closed = await db
    .prepare(
      `SELECT id, levonis_product_id, slug, match_kind, stage_data, discovery_sources FROM catalog_import_items
        WHERE run_id = ? AND source = 'bambu_us' AND source_product_id = ? AND processing_state = 'COMPLETE'`
    )
    .bind(mark.fromRun, item.source_product_id)
    .first<{ id: string; levonis_product_id: string; slug: string; match_kind: string; stage_data: string; discovery_sources: string }>();
  const closedKind = closed ? deltaDoorKindOf(closed.discovery_sources) : 'unknown';
  if (!closed?.levonis_product_id || (closedKind !== 'none' && closedKind !== 'new')) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  const { results: failedRows } = await db
    .prepare(
      `SELECT source_media_id, role FROM catalog_import_media
        WHERE run_id = ? AND source_product_id = ? AND status = 'failed' AND role IN ('description','in_the_box') ORDER BY source_media_id`
    )
    .bind(mark.fromRun, item.source_product_id)
    .all<FailedContentMedium>();
  const settled = (await contentSettledElsewhere(db, item.run_id, mark.fromRun, [item.source_product_id])).get(item.source_product_id) ?? new Set<string>();
  const failed = (failedRows ?? []).filter((f) => CONTENT_ROLES.has(f.role) && !settled.has(f.source_media_id));
  const ref = await db
    .prepare("SELECT product_id, match_kind, fingerprint FROM product_source_refs WHERE source = 'bambu_us' AND source_product_id = ?")
    .bind(item.source_product_id)
    .first<{ product_id: string; match_kind: string; fingerprint: string }>();
  const product = ref ? await db.prepare('SELECT * FROM products WHERE id = ?').bind(ref.product_id).first<Record<string, unknown>>() : null;
  const merge = closed.match_kind === 'merged';
  const base = { mark, closedItemId: closed.id, failed, rowBytes: 0, translationsDigest: '' };
  if (!ref || !product || ref.product_id !== closed.levonis_product_id || (ref.match_kind !== 'created' && ref.match_kind !== 'merged')) {
    return { ...base, productId: closed.levonis_product_id, slug: String(closed.slug ?? ''), merge, active: false, gone: true, state: null };
  }
  const productId = ref.product_id;
  const rowBytes = Object.values(product).reduce<number>((n, v) => n + (typeof v === 'string' ? utf8(v) : v === null ? 0 : 8), 0);
  const { results: conflicts } = await db.prepare('SELECT kind, field FROM catalog_import_conflicts WHERE item_id = ?').bind(closed.id).all<{ kind: string; field: string }>();
  const written = await db
    .prepare("SELECT MAX(at) AS at FROM catalog_import_events WHERE item_id = ? AND stage = 'WRITTEN' AND outcome = 'ok'")
    .bind(closed.id)
    .first<{ at: string | null }>();
  const { results: media } = await db
    .prepare('SELECT source_media_id, status, r2_key FROM catalog_import_media WHERE run_id = ? AND source_product_id = ?')
    .bind(mark.fromRun, item.source_product_id)
    .all<{ source_media_id: string; status: string; r2_key: string }>();
  const { results: translations } = await db
    .prepare("SELECT field, source_en, text_ar, text_ckb, status, translation_version, updated_at FROM product_translations WHERE product_id = ? AND field LIKE 'block:%'")
    .bind(productId)
    .all<TranslationRow & { field: string }>();
  const digest = await db
    .prepare("SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') AS d FROM product_translations WHERE product_id = ? AND field LIKE 'block:%'")
    .bind(productId)
    .first<{ d: string }>();
  const { results: boxRows } = await db
    .prepare(
      `SELECT id, scope_kind, scope_id, region, visibility, status, value_list, value_text FROM product_spec_values
        WHERE product_id = ? AND canonical_key = 'package.contents' AND import_run_id = ?`
    )
    .bind(productId, mark.fromRun)
    .all<BoxRow>();
  // What every earlier content pass put in for this product (any closed run's pass: the fields are the product's).
  const { results: earlierItems } = await db
    .prepare(`SELECT stage_data, levonis_product_id FROM catalog_import_items WHERE run_id <> ? AND source = 'bambu_us' AND source_product_id = ? AND discovery_sources LIKE '%"content_media:%'`)
    .bind(item.run_id, item.source_product_id)
    .all<{ stage_data: string; levonis_product_id: string }>();
  const earlier: EarlierInserted = { blocks: new Map(), box: new Map() };
  for (const e of earlierItems ?? []) {
    if (e.levonis_product_id && e.levonis_product_id !== productId) continue;
    const ins = insertedOf(e.stage_data);
    for (const b of ins.blocks) earlier.blocks.set(b.id, b.r2_key);
    for (const b of ins.box) earlier.box.set(`${b.row_id}#${b.index}`, b.r2_key);
  }
  let writtenBlocks: number | null = null;
  try {
    const w = (JSON.parse(closed.stage_data || '{}') as { written?: { content_blocks?: unknown } }).written?.content_blocks;
    writtenBlocks = typeof w === 'number' && Number.isInteger(w) && w >= 0 ? w : null;
  } catch {
    writtenBlocks = null;
  }
  const target = readbackTargetOf(closed.stage_data);
  const targetBlocks = target && isObj(target.doc) && Array.isArray((target.doc as unknown as Record<string, unknown>).content_blocks) ? JSON.stringify((target.doc as unknown as Record<string, unknown>).content_blocks) : null;
  const state: ContentState = {
    productId,
    merge,
    t0: typeof product.content_blocks === 'string' ? product.content_blocks : '',
    m0: typeof product.translation_meta === 'string' ? product.translation_meta : '',
    specFields: typeof product.spec_fields === 'string' ? product.spec_fields : '',
    fingerprint: String(ref.fingerprint ?? ''),
    keptExisting: (conflicts ?? []).some((c) => c.kind === 'field_kept_existing' && c.field === 'content_blocks'),
    headConflict: (conflicts ?? []).some((c) => c.kind === 'image_review' && c.field === 'media.not_stored'),
    writtenBlocks,
    writtenAt: String(written?.at ?? ''),
    readbackBlocks: targetBlocks,
    closedMedia: new Map((media ?? []).map((m) => [String(m.source_media_id), { status: m.status, r2_key: String(m.r2_key ?? '') }])),
    translations: new Map((translations ?? []).map((t) => [t.field, t])),
    boxRows: boxRows ?? [],
    earlier,
    mapping: null,
    mergeOk: !merge,
  };
  return {
    ...base,
    productId,
    slug: String(product.slug ?? closed.slug ?? ''),
    merge,
    active: product.status === 'active',
    gone: false,
    state,
    rowBytes,
    translationsDigest: String(digest?.d ?? ''),
  };
}

/** A merge's reviewed map applied to the product as it stands (the box rows of a value or variant scope). */
async function withMapping(db: D1Database, ctx: ContentContext, payload: ImportPayload, bundle: Pick<ReviewedBundle, 'matches'>, sid: string): Promise<void> {
  if (!ctx.state || !ctx.merge) return;
  const match = bundle.matches.bySourceId.get(sid) ?? null;
  const ok = !!match && (match.decision === 'merge' || match.decision === 'merge_publish') && match.levonis_product_id === ctx.productId;
  const rel = ok ? await loadRelationsResponse(db, ctx.productId) : null;
  ctx.state.mergeOk = ok && !!rel;
  ctx.state.mapping = ok && rel ? mergeMapping(payload, match!, rel) : null;
}

// ---------------------------------------------------------------- the payload

/**
 * The payload, allow-listed, and proved to be this item's product as the import wrote it. The content door takes the
 * payload with its description blocks and `package.contents` rows ONLY (the runner's contentOnlyPayload): no other
 * spec, document, relation, external id, note, short description or usage guide. Its blocks are the builder's own
 * (orders 0..n-1, each id the builder's hash of the product, its section and its order); each picture's medium id the
 * builder's of its address; each picture's alt the registry's authored triple of the product's title.
 */
export function contentPayloadOf(raw: unknown, item: Pick<ItemRow, 'id' | 'source_product_id' | 'handle'>, ctx: Pick<ContentContext, 'productId' | 'merge' | 'gone'>): ImportPayload {
  const payload = assertImportPayload(raw);
  const prose =
    payload.documents.length + payload.relations.length + payload.external_ids.length + payload.notes.length + payload.product.usage_steps.length +
    (payload.product.short_description_en ? 1 : 0) + (payload.product.usage_official_url ? 1 : 0);
  if (prose > 0 || payload.specs.some((s) => s.key !== 'package.contents')) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  if (
    payload.source_product_id !== item.source_product_id ||
    payload.handle !== item.handle ||
    payload.product_id !== ctx.productId ||
    (!ctx.gone && payload.write_mode !== (ctx.merge ? 'merge' : 'create'))
  ) {
    throw new OpsRefusal(409, 'IMPORT_IDENTITY_AMBIGUOUS', [item.id]);
  }
  const alt = altText(payload.product.title_en);
  const ids = new Set<string>();
  for (let i = 0; i < payload.content_blocks.length; i++) {
    const b: PayloadContentBlock = payload.content_blocks[i];
    if (b.order !== i || b.id !== `cb_${H(`${payload.product_id}:${b.section_path}:${b.order}`)}` || ids.has(b.id)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
    ids.add(b.id);
    if (b.kind === 'image' && b.source_media_id) {
      if (b.source_media_id !== `content:${H(stripQuery(b.source_url))}` || b.alt_en !== alt.en || b.alt_ar !== alt.ar || b.alt_ckb !== alt.ckb) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
    }
  }
  for (const s of payload.specs) {
    for (const v of s.value_list) {
      if (!isObj(v)) continue;
      const it = v as unknown as PayloadBoxItem;
      if (it.source_media_id && it.source_media_id !== `box:${H(stripQuery(it.source_url))}`) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
    }
  }
  return payload;
}

/** /media for a content item: only the closed run's failed media of the two roles, each in its own role. */
export function assertContentRequests(ctx: Pick<ContentContext, 'failed'>, item: Pick<ItemRow, 'id'>, requests: ReadonlyArray<{ source_media_id: string; role: string }>): void {
  const failed = new Map(ctx.failed.map((f) => [f.source_media_id, f.role]));
  for (const r of requests) {
    if (!CONTENT_ROLES.has(r.role) || failed.get(r.source_media_id) !== r.role) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  }
}

const tally = (outcomes: ReadonlyMap<string, ContentOutcome | 'planned'>): ContentCounts => {
  const counts = emptyContentCounts();
  for (const o of outcomes.values()) if (o !== 'planned') counts[o]++;
  return counts;
};

// ---------------------------------------------------------------- /content-plan

export const CONTENT_PLAN_STATES = new Set(['VALIDATING', 'INGESTING_MEDIA', 'WRITING']);

/**
 * POST /items/:sid/content-plan (after holdLease): records the payload's digest and answers what to fetch. With
 * `moot` (`identity_changed`: the page no longer reads as this product; `source_gone`: the store page is gone) and no
 * payload: the moot plan (every failed medium counted with it, nothing fetched or written).
 */
export async function planContentMedia(
  db: D1Database,
  item: ItemRow,
  bundle: Pick<ReviewedBundle, 'matches'>,
  raw: unknown,
  moot?: unknown
): Promise<{ payload_sha256: string; media: ContentRequest[]; skipped: ContentCounts; failed: number; stored_not_written: number }> {
  if (!CONTENT_PLAN_STATES.has(item.processing_state)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  if (moot !== undefined && (typeof moot !== 'string' || !CONTENT_MOOTS.has(moot) || (raw !== undefined && raw !== null))) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  const ctx = await contentContext(db, item);
  let sha: string;
  let plan: ContentPlan;
  if (moot !== undefined) {
    sha = contentMootSha(moot as string);
    plan = { outcomes: new Map(ctx.failed.map((f) => [f.source_media_id, moot as ContentOutcome])), reasons: new Map(), requests: [], description: null, box: [], occurrences: new Map(), storedNotWritten: 0 };
  } else {
    const payload = contentPayloadOf(raw, item, ctx);
    await withMapping(db, ctx, payload, bundle, item.source_product_id);
    sha = payloadSha256(payload);
    plan = planContent(ctx.state, payload, ctx.failed, ctx.active && !ctx.gone);
  }
  const skipped = tally(plan.outcomes);
  const r = await db
    .prepare(
      `UPDATE catalog_import_items
          SET payload_sha256 = ?,
              stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.content_media_plan', json(?)),
              updated_at = ${NOW_SQL}
        WHERE id = ? AND lease_token = ? AND processing_state IN ('VALIDATING','INGESTING_MEDIA','WRITING')`
    )
    .bind(
      sha,
      JSON.stringify({ failed: ctx.failed.length, requests: plan.requests.length, skipped, stored_not_written: plan.storedNotWritten, ...(moot !== undefined ? { moot } : {}) }),
      item.id,
      item.lease_token
    )
    .run();
  if (Number(r.meta?.changes ?? 0) !== 1) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  return { payload_sha256: sha, media: plan.requests, skipped, failed: ctx.failed.length, stored_not_written: plan.storedNotWritten };
}

// ---------------------------------------------------------------- /content-attach

export interface ContentAttachAnswer {
  product_id: string;
  slug: string;
  counts: ContentCounts & { blocks: number; box: number; stored_not_written: number };
  inserted: ContentCheckpoint['inserted'];
}

export interface ContentWrite {
  counts: ContentCounts;
  media: Record<string, ContentOutcome>;
  reasons: Record<string, string>;
  inserted: ContentCheckpoint['inserted'];
  t0: string;
  t1: string | null;
  boxWrites: Array<{ rowId: string; v0: string; v1: string }>;
  checkpoint: ContentCheckpoint;
}

/** The new keys of the planned media: this run's own stored rows whose object R2 holds as WebP. */
async function newKeysOf(env: ContentEnv, runId: string, item: ItemRow, plan: ContentPlan): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!plan.requests.length) return out;
  const { results } = await env.DB
    .prepare("SELECT source_media_id, r2_key FROM catalog_import_media WHERE run_id = ? AND source_product_id = ? AND status = 'stored' AND r2_key <> '' AND source_media_id IN (SELECT value FROM json_each(?))")
    .bind(runId, item.source_product_id, JSON.stringify(plan.requests.map((r) => r.source_media_id)))
    .all<{ source_media_id: string; r2_key: string }>();
  for (const r of results ?? []) {
    const head = await importObjectHead(env, r.r2_key);
    // A storage that does not answer says nothing: refused whole (transient), never read as "not stored".
    if (head.presence === 'unknown') throw new OpsRefusal(503, 'IMAGE_STORAGE_FAILED', [item.id]);
    if (head.presence === 'present' && (!head.contentType || head.contentType === 'image/webp')) out.set(String(r.source_media_id), r.r2_key);
  }
  return out;
}

/**
 * Pure: the write of a plan with the new keys — the outcome of every failed medium, the new description (the field
 * with the pictures at their payload positions and every other block byte for byte, its `order` renumbered by the
 * writer's rule: the field the import would have written) and each box row with its new keys. Every invariant is
 * checked here; a broken one refuses the whole call (500), nothing written.
 */
export function contentWriteOf(state: ContentState | null, payload: ImportPayload | null, plan: ContentPlan, keys: ReadonlyMap<string, string>, rowBytes: number): ContentWrite {
  const outcomes = new Map(plan.outcomes);
  const reasons = new Map(plan.reasons);
  const inserted: ContentCheckpoint['inserted'] = { blocks: [], box: [] };
  let t1: string | null = null;
  const boxWrites: ContentWrite['boxWrites'] = [];
  const t0 = state?.t0 ?? '';
  let fpAfter: ContentCheckpoint['fp']['after'] = null;
  const bad = () => new OpsRefusal(500, 'IMPORT_INTERNAL');
  if (state && payload) {
    // ---- the description
    const descKeys = new Map(plan.description?.present ?? []);
    const added = new Map<string, string>();
    for (const r of plan.requests) {
      if (r.role !== 'description') continue;
      const k = keys.get(r.source_media_id);
      if (!k) {
        outcomes.set(r.source_media_id, 'not_stored');
        continue;
      }
      descKeys.set(r.source_media_id, k);
      added.set(r.source_media_id, k);
    }
    if (added.size) {
      const blocks = expectedBlocks(payload, descKeys, state.translations);
      const text = JSON.stringify(blocks);
      const insertedIds = new Set(payload.content_blocks.filter((b) => b.kind === 'image' && added.has(b.source_media_id)).map((b) => b.id));
      // Invariants: unique ids; the model reads it back byte for byte; taking the new blocks out gives T0 back; each new
      // block a picture on its key with the authored alt.
      const alt = altText(payload.product.title_en);
      const keyOfBlock = new Map(payload.content_blocks.filter((b) => b.kind === 'image' && added.has(b.source_media_id)).map((b) => [b.id, added.get(b.source_media_id)!]));
      if (new Set(blocks.map((b) => b.id)).size !== blocks.length) throw bad();
      if (JSON.stringify(upgradeContentBlocks(JSON.parse(text))) !== text) throw bad();
      if (undoBlocks(text, insertedIds) !== t0) throw bad();
      for (const b of blocks) {
        if (!insertedIds.has(b.id)) continue;
        const k = keyOfBlock.get(b.id) ?? '';
        if (b.kind !== 'image' || !k || b.url !== `/files/${k}` || b.media_key !== k || b.alt_en !== alt.en || b.alt_ar !== alt.ar || b.alt_ckb !== ckbNotCopy(alt.ar, alt.ckb)) throw bad();
      }
      if (blocks.filter((b) => insertedIds.has(b.id)).length !== added.size) throw bad();
      if (rowBytes - utf8(t0) + utf8(text) > PRODUCT_ROW_LIMIT) {
        for (const sid of added.keys()) {
          outcomes.set(sid, 'not_stored');
          reasons.set(sid, 'row_size');
        }
      } else {
        t1 = text;
        for (const [sid, k] of added) {
          outcomes.set(sid, 'attached');
          const b = payload.content_blocks.find((x) => x.kind === 'image' && x.source_media_id === sid)!;
          inserted.blocks.push({ id: b.id, r2_key: k });
        }
        fpAfter = languageFingerprints(blocks as unknown as Array<Record<string, unknown>>);
      }
    }
    // ---- the box rows
    const byRow = new Map<string, { proof: BoxProof; keyAt: Map<number, string> }>();
    for (const r of plan.requests) {
      if (r.role !== 'in_the_box') continue;
      const k = keys.get(r.source_media_id);
      if (!k) {
        outcomes.set(r.source_media_id, 'not_stored');
        continue;
      }
      for (const o of plan.occurrences.get(r.source_media_id) ?? []) {
        const slot = byRow.get(o.proof.rowId) ?? { proof: o.proof, keyAt: new Map(o.proof.keyAt) };
        slot.keyAt.set(o.index, k);
        byRow.set(o.proof.rowId, slot);
        inserted.box.push({ row_id: o.proof.rowId, index: o.index, r2_key: k });
      }
      outcomes.set(r.source_media_id, 'attached');
    }
    for (const [rowId, { proof, keyAt }] of byRow) {
      const v1 = JSON.stringify(boxValueListOf(proof.spec.value_list, (_item, i) => keyAt.get(i) ?? ''));
      const a = JSON.parse(proof.v0) as unknown[];
      const b = JSON.parse(v1) as unknown[];
      if (a.length !== b.length || proof.v0 !== proof.row?.value_list) throw bad();
      // Invariant: the same items, each equal but for a media_key added where it had none.
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (!isObj(x) || !isObj(y) || x.media_key !== undefined) {
          if (JSON.stringify(x) !== JSON.stringify(y)) throw bad();
          continue;
        }
        const { media_key: mk, ...rest } = y;
        if (canonicalJson(rest) !== canonicalJson(x) || (mk !== undefined && (typeof mk !== 'string' || !mk))) throw bad();
      }
      boxWrites.push({ rowId, v0: proof.v0, v1 });
    }
  }
  const media: Record<string, ContentOutcome> = {};
  for (const [id, o] of outcomes) media[id] = o === 'planned' ? 'not_stored' : o;
  const counts = emptyContentCounts();
  for (const o of Object.values(media)) counts[o]++;
  let fpBefore: ContentCheckpoint['fp']['before'] = null;
  try {
    const parsed = JSON.parse(t0) as unknown;
    if (Array.isArray(parsed)) fpBefore = languageFingerprints(parsed.filter(isObj));
  } catch {
    fpBefore = null;
  }
  const checkpoint: ContentCheckpoint = {
    rule: CONTENT_RULE,
    counts,
    media,
    reasons: Object.fromEntries(reasons),
    inserted,
    fp: { before: fpBefore, after: fpAfter },
    sha: { t0: sha256Hex(t0), t1: t1 === null ? '' : sha256Hex(t1), box: boxWrites.map((w) => ({ row_id: w.rowId, v0: sha256Hex(w.v0), v1: sha256Hex(w.v1) })) },
    stored_not_written: plan.storedNotWritten,
  };
  return { counts, media, reasons: Object.fromEntries(reasons), inserted, t0, t1, boxWrites, checkpoint };
}

/**
 * POST /items/:sid/content-attach (after holdLease): the planned media now stored, put in by ONE guarded batch
 * (`commitContent`), everything recomputed from a fresh read. A moot item (`moot`, after a moot /content-plan) writes
 * nothing and moves on the same way. A batch the guard aborts (a field changed between the read and the batch) is
 * decided once more on a fresh read while the item still holds this lease at WRITING; a second abort is transient.
 */
export async function attachContentMedia(env: ContentEnv, run: ImportRun, item: ItemRow, bundle: Pick<ReviewedBundle, 'matches'>, body: Record<string, unknown>): Promise<ContentAttachAnswer> {
  const db = env.DB;
  if (item.processing_state !== 'WRITING') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  if (typeof body.payload_sha256 !== 'string' || body.payload_sha256 !== item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
  const moot = body.moot;
  if (moot !== undefined ? typeof moot !== 'string' || !CONTENT_MOOTS.has(moot) || item.payload_sha256 !== contentMootSha(moot) : [...CONTENT_MOOTS].some((m) => contentMootSha(m) === item.payload_sha256)) {
    throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
  }
  for (let attempt = 0; ; attempt++) {
    const ctx = await contentContext(db, item);
    let write: ContentWrite;
    if (moot !== undefined) {
      const plan: ContentPlan = { outcomes: new Map(ctx.failed.map((f) => [f.source_media_id, moot as ContentOutcome])), reasons: new Map(), requests: [], description: null, box: [], occurrences: new Map(), storedNotWritten: 0 };
      write = contentWriteOf(null, null, plan, new Map(), 0);
    } else {
      const payload = contentPayloadOf(body.payload, item, ctx);
      if (payloadSha256(payload) !== item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
      await withMapping(db, ctx, payload, bundle, item.source_product_id);
      const plan = planContent(ctx.state, payload, ctx.failed, ctx.active && !ctx.gone);
      const keys = await newKeysOf(env, run.id, item, plan);
      write = contentWriteOf(ctx.state, payload, plan, keys, ctx.rowBytes);
    }
    try {
      await commitContent(db, run, item, ctx, write);
      return {
        product_id: ctx.productId,
        slug: ctx.slug,
        counts: { ...write.counts, blocks: write.inserted.blocks.length, box: write.inserted.box.length, stored_not_written: write.checkpoint.stored_not_written },
        inserted: write.inserted,
      };
    } catch (e) {
      const changed = e instanceof ImportWriteRefused && e.code === 'IMPORT_ITEM_CHANGED';
      const clash = /UNIQUE constraint failed:\s*ops_guards\.id/i.test(String((e as Error)?.message ?? e));
      if (!changed && !clash) throw e;
      if (clash) throw new OpsRefusal(503, 'IMPORT_ITEM_CHANGED', [item.id]);
      const still = await db
        .prepare(`SELECT 1 AS x FROM catalog_import_items WHERE id = ? AND processing_state = 'WRITING' AND lease_token = ? AND lease_until > ${NOW_SQL} AND payload_sha256 = ?`)
        .bind(item.id, item.lease_token, item.payload_sha256)
        .first();
      if (!still) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      if (attempt >= 1) throw new OpsRefusal(503, 'IMPORT_ITEM_CHANGED', [item.id]);
    }
  }
}

/**
 * ONE batch, under the import guard (so every money, stock and package trigger of §B.4 refuses anything):
 *
 *   1. the guard row, fenced on the item (WRITING, its lease, its staged digest, the run open) and — when anything
 *      is written — on the product as read: active, `content_blocks`, `translation_meta` and `spec_fields` the texts
 *      read, its block translation rows unchanged (count and latest time);
 *   2. per touched box row, the guard fenced on that row's text (one statement each, so no statement nears D1's 100
 *      parameters however many rows);
 *   3. the description: `content_blocks` compare-and-set, `updated_at` bumped (an editor opened before reloads);
 *   4. per touched box row: its `value_list` compare-and-set, nothing else of it;
 *   5. the lease-fenced WRITTEN event; the checkpoint; the guard row removed.
 *
 * No other column, row or table of the product is written; nothing is deleted but the guard row.
 */
export function contentBatch(
  db: D1Database,
  run: Pick<ImportRun, 'id' | 'github_run_id'>,
  item: Pick<ItemRow, 'id' | 'lease_token' | 'payload_sha256'>,
  ctx: Pick<ContentContext, 'productId' | 'slug' | 'mark' | 'state' | 'translationsDigest'>,
  w: Pick<ContentWrite, 't0' | 't1' | 'boxWrites' | 'inserted' | 'counts' | 'checkpoint'>
): D1PreparedStatement[] {
  const writes = w.t1 !== null || w.boxWrites.length > 0;
  const state = ctx.state;
  const itemFence = `EXISTS (
           SELECT 1 FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
            WHERE i.id = ?2 AND i.run_id = ?3 AND i.processing_state = 'WRITING' AND i.lease_token = ?4 AND i.lease_token <> ''
              AND i.lease_until > ${NOW_SQL} AND i.payload_sha256 = ?5 AND r.state IN ('open','running'))`;
  const statements: D1PreparedStatement[] = [];
  if (writes && state) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ops_guards (id, ok) SELECT ?1, CASE WHEN ${itemFence}
             AND EXISTS (SELECT 1 FROM products p WHERE p.id = ?6 AND p.status = 'active' AND p.content_blocks IS ?7 AND p.translation_meta IS ?8 AND p.spec_fields IS ?9)
             AND (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM product_translations WHERE product_id = ?6 AND field LIKE 'block:%') = ?10
           THEN 1 ELSE 0 END`
        )
        .bind(IMPORT_GUARD_ID, item.id, run.id, item.lease_token, item.payload_sha256, ctx.productId, state.t0, state.m0, state.specFields, ctx.translationsDigest)
    );
    for (const b of w.boxWrites) {
      statements.push(
        db
          .prepare(
            `UPDATE ops_guards SET ok = CASE WHEN EXISTS (SELECT 1 FROM product_spec_values WHERE id = ?1 AND product_id = ?2 AND canonical_key = 'package.contents'
               AND import_run_id = ?3 AND value_list IS ?4) THEN 1 ELSE 0 END WHERE id = ?5`
          )
          .bind(b.rowId, ctx.productId, ctx.mark.fromRun, b.v0, IMPORT_GUARD_ID)
      );
    }
    if (w.t1 !== null) {
      statements.push(
        db.prepare(`UPDATE products SET content_blocks = ?1, updated_at = ${NOW_SQL} WHERE id = ?2 AND content_blocks IS ?3`).bind(w.t1, ctx.productId, w.t0)
      );
    }
    for (const b of w.boxWrites) {
      statements.push(
        db
          .prepare(`UPDATE product_spec_values SET value_list = ?1 WHERE id = ?2 AND product_id = ?3 AND canonical_key = 'package.contents' AND import_run_id = ?4 AND value_list IS ?5`)
          .bind(b.v1, b.rowId, ctx.productId, ctx.mark.fromRun, b.v0)
      );
    }
  } else {
    statements.push(db.prepare(`INSERT INTO ops_guards (id, ok) SELECT ?1, CASE WHEN ${itemFence} THEN 1 ELSE 0 END`).bind(IMPORT_GUARD_ID, item.id, run.id, item.lease_token, item.payload_sha256));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'WRITTEN', 'ok', '', '', ?, ?, ?)`
      )
      .bind(
        newId('cie'),
        run.id,
        item.id,
        run.id,
        JSON.stringify({ content_only: true, blocks: w.inserted.blocks.length, box: w.inserted.box.length, ...w.counts }),
        item.lease_token,
        run.github_run_id
      ),
    db
      .prepare(
        `UPDATE catalog_import_items
            SET processing_state = 'PUBLISHING', last_completed_stage = 'WRITING', levonis_product_id = ?, slug = ?, stage_attempts = 0, retry_at = '',
                stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.content_media', json(?)),
                updated_at = ${NOW_SQL}
          WHERE id = ? AND run_id = ? AND lease_token = ?`
      )
      .bind(ctx.productId, ctx.slug, JSON.stringify(w.checkpoint), item.id, run.id, item.lease_token),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID)
  );
  return statements;
}

async function commitContent(db: D1Database, run: ImportRun, item: ItemRow, ctx: ContentContext, w: ContentWrite): Promise<void> {
  try {
    await db.batch(contentBatch(db, run, item, ctx, w));
  } catch (e) {
    throw refusalOfBatch(e);
  }
}

// ---------------------------------------------------------------- /content-complete

export interface ContentEvidence {
  version: 1;
  live_url: string;
  round: number;
  status: number;
  knowledge_status: number;
  blocks_seen: number;
  box_seen: number;
}

const int = (v: unknown, max = 100_000): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/** A row's scope the knowledge answer shows (productKnowledge.ts scopeLive): the product, an active value of an active group, an active variant. */
const SCOPE_LIVE = `CASE s.scope_kind
      WHEN 'option_value' THEN EXISTS (SELECT 1 FROM product_option_values lv JOIN product_option_groups lg ON lg.id = lv.group_id
                                        WHERE lv.id = s.scope_id AND lv.product_id = s.product_id AND lv.active = 1 AND lg.active = 1)
      WHEN 'variant' THEN EXISTS (SELECT 1 FROM product_variants lx WHERE lx.id = s.scope_id AND lx.product_id = s.product_id AND lx.active = 1)
      ELSE 1 END`;

/**
 * POST /items/:sid/content-complete (after holdLease): COMPLETE only when R2 holds every object the product still
 * shows and the runner saw, on each anonymous answer it needed, every inserted picture the product still holds and
 * shows: each kept block on `/api/products/<slug>` (the same id on `/files/<key>`), each kept box item the knowledge
 * answer shows (`in_the_box[].image`: a public row of a live scope with a known status, among its first 100 items,
 * with text). What the owner removed or replaced since the attach, or a product hidden since, is not expected on
 * either side (a refusal could never clear). Otherwise nothing moves: the runner purges, waits and asks once more,
 * then blocks VERIFY_FAILED_PERSISTENT.
 */
export async function completeContentMedia(
  env: ContentEnv,
  requestUrl: string,
  run: ImportRun,
  item: ItemRow,
  body: Record<string, unknown>
): Promise<{ state: 'COMPLETE' | 'VERIFYING_LIVE'; seq: number | null; d1_checks: Record<string, unknown> }> {
  if (item.processing_state !== 'VERIFYING_LIVE') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  await contentMark(env.DB, item);
  const liveUrl = liveUrlOf(body.live_url, requestUrl, item.slug);
  if (!liveUrl) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  const e = isObj(body.edge_evidence) ? body.edge_evidence : null;
  const round = int(e?.round, 10);
  const status = int(e?.status, 999);
  const knowledgeStatus = int(e?.knowledge_status, 999);
  const blocksSeen = int(e?.blocks_seen);
  const boxSeen = int(e?.box_seen);
  if (!e || e.version !== 1 || e.live_url !== liveUrl || round === null || status === null || knowledgeStatus === null || blocksSeen === null || boxSeen === null) {
    throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  }
  const evidence: ContentEvidence = { version: 1, live_url: liveUrl, round, status, knowledge_status: knowledgeStatus, blocks_seen: blocksSeen, box_seen: boxSeen };
  const db = env.DB;
  const inserted = insertedOf(stageDataOf(item));
  const product = await db.prepare('SELECT status, content_blocks FROM products WHERE id = ?').bind(item.levonis_product_id).first<{ status: string; content_blocks: string }>();
  let blocks: unknown[] = [];
  try {
    const p = JSON.parse(product?.content_blocks || '[]') as unknown;
    blocks = Array.isArray(p) ? p : [];
  } catch {
    blocks = [];
  }
  const keptBlocks = inserted.blocks.filter((b) => blocks.some((x) => isObj(x) && x.id === b.id && x.media_key === b.r2_key));
  const rowIds = [...new Set(inserted.box.map((b) => b.row_id))];
  const { results: rows } = rowIds.length
    ? await db
        .prepare(`SELECT s.id, s.value_list, s.status, s.visibility, ${SCOPE_LIVE} AS live FROM product_spec_values s WHERE s.product_id = ? AND s.id IN (SELECT value FROM json_each(?))`)
        .bind(item.levonis_product_id, JSON.stringify(rowIds))
        .all<{ id: string; value_list: string; status: string; visibility: string; live: number }>()
    : { results: [] as Array<{ id: string; value_list: string; status: string; visibility: string; live: number }> };
  const rowOf = new Map((rows ?? []).map((r) => [String(r.id), r]));
  const listOf = new Map<string, unknown[]>();
  for (const r of rows ?? []) {
    try {
      const l = JSON.parse(r.value_list) as unknown;
      listOf.set(String(r.id), Array.isArray(l) ? l : []);
    } catch {
      listOf.set(String(r.id), []);
    }
  }
  const keptBox = inserted.box.filter((b) => {
    const x = listOf.get(b.row_id)?.[b.index];
    return isObj(x) && x.media_key === b.r2_key;
  });
  const shownBox = keptBox.filter((b) => {
    const r = rowOf.get(b.row_id)!;
    const x = listOf.get(b.row_id)![b.index] as Record<string, unknown>;
    return r.visibility === 'public' && Number(r.live) === 1 && isSpecStatus(r.status) && b.index < 100 && typeof x.text === 'string' && x.text.trim() !== '';
  });
  const shown = product?.status === 'active';
  let objects = 0;
  const keys = [...new Set([...keptBlocks.map((b) => b.r2_key), ...keptBox.map((b) => b.r2_key)])];
  for (const key of keys) {
    const p = (await importObjectHead(env, key)).presence;
    if (p === 'unknown') throw new OpsRefusal(503, 'IMPORT_STORAGE_UNAVAILABLE', [item.id]);
    if (p === 'present') objects++;
  }
  const d1Ok = objects === keys.length;
  const blocksNeeded = shown && keptBlocks.length > 0;
  const boxNeeded = shown && shownBox.length > 0;
  const edgeOk = (!blocksNeeded || (status === 200 && blocksSeen === keptBlocks.length)) && (!boxNeeded || (knowledgeStatus === 200 && boxSeen >= shownBox.length));
  const d1Checks = {
    ok: d1Ok && edgeOk,
    content_media: {
      blocks: inserted.blocks.length,
      blocks_present: keptBlocks.length,
      box: inserted.box.length,
      box_present: keptBox.length,
      box_shown: shownBox.length,
      objects: keys.length,
      objects_present: objects,
      product_shown: shown,
    },
    agreement: { edge_ok: edgeOk, counts_agree: d1Ok },
  };
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = 'VERIFYING_LIVE' AND lease_token = ?)`, [item.id, item.lease_token]);
  const event = (stage: string, outcome: string, code: string, detail: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), ?, ?, ?, '', ?, ?, ?)`
      )
      .bind(newId('cie'), run.id, item.id, run.id, stage, outcome, code, JSON.stringify(detail), item.lease_token, run.github_run_id);
  const batch = async (statements: D1PreparedStatement[]) => {
    try {
      await db.batch(statements);
    } catch (err) {
      if (isFenceMiss(err)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      throw refusalOfBatch(err);
    }
  };
  if (!d1Checks.ok) {
    await batch([
      fenceIn,
      db
        .prepare(`UPDATE catalog_import_items SET d1_checks = ?, edge_evidence = ?, updated_at = ${NOW_SQL} WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`)
        .bind(JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
      event('VERIFYING_LIVE', 'info', 'IMPORT_VERIFY_DISAGREES', { round, blocks: inserted.blocks.length, blocks_seen: blocksSeen, box: inserted.box.length, box_seen: boxSeen }),
      fenceOut,
    ]);
    return { state: 'VERIFYING_LIVE', seq: null, d1_checks: d1Checks };
  }
  await batch([
    fenceIn,
    db
      .prepare(
        `UPDATE catalog_import_items
            SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = ?, verified_at = ${NOW_SQL},
                completed_at = ${NOW_SQL}, d1_checks = ?, edge_evidence = ?, stage_attempts = 0, retry_at = '', updated_at = ${NOW_SQL}
          WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`
      )
      .bind(liveUrl, JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
    event('COMPLETED', 'ok', '', { round, content_only: true, blocks: inserted.blocks.length, box: inserted.box.length }),
    fenceOut,
  ]);
  const seq = await db
    .prepare("SELECT seq FROM catalog_import_events WHERE run_id = ? AND item_id = ? AND stage = 'COMPLETED' ORDER BY seq DESC LIMIT 1")
    .bind(run.id, item.id)
    .first<{ seq: number }>();
  return { state: 'COMPLETE', seq: seq?.seq ?? null, d1_checks: d1Checks };
}

// ---------------------------------------------------------------- undo (reversible, never run by the import)

/**
 * Pure: what undoing an item's content pass would write, from its checkpoint and the fields as they stand: the
 * description without the inserted blocks (orders renumbered) — only when that gives back exactly the text the pass
 * replaced (its sha256) — and each box row without the keys it added, under the same proof. null for a field that
 * moved since (an undo is then the owner's decision, never automatic).
 */
export function contentUndoOf(
  checkpoint: Pick<ContentCheckpoint, 'inserted' | 'sha'>,
  fields: { content_blocks: string; rows: ReadonlyMap<string, string> }
): { content_blocks: string | null; rows: Array<{ row_id: string; from: string; to: string }> } {
  let content: string | null = null;
  if (checkpoint.inserted.blocks.length && checkpoint.sha.t1 && sha256Hex(fields.content_blocks) === checkpoint.sha.t1) {
    const back = undoBlocks(fields.content_blocks, new Set(checkpoint.inserted.blocks.map((b) => b.id)));
    if (sha256Hex(back) === checkpoint.sha.t0) content = back;
  }
  const rows: Array<{ row_id: string; from: string; to: string }> = [];
  for (const w of checkpoint.sha.box) {
    const now = fields.rows.get(w.row_id);
    if (now === undefined || sha256Hex(now) !== w.v1) continue;
    const drop = new Set(checkpoint.inserted.box.filter((b) => b.row_id === w.row_id).map((b) => b.index));
    const list = (JSON.parse(now) as unknown[]).map((x, i) => {
      if (!drop.has(i) || !isObj(x)) return x;
      const { media_key: _k, ...rest } = x;
      void _k;
      return rest;
    });
    const back = JSON.stringify(list);
    if (sha256Hex(back) === w.v0) rows.push({ row_id: w.row_id, from: now, to: back });
  }
  return { content_blocks: content, rows };
}
