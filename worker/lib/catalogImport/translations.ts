/**
 * THE TRANSLATION MEMORY'S LOADER — `POST /api/ops/catalog-import/run/translations`
 * (docs/bambu-import/I18N-DESIGN.md §A.3, §A.4, §E; DECISIONS rows 2, 183, 239).
 *
 * The Arabic and Sorani of the imported English are written by us, reviewed,
 * and committed as part files under data/bambu-import/translations/ (never
 * bundled: up to 1 MB each). Their INDEX — each part's SHA-256, row count and
 * size — IS bundled into the Worker, so it shipped through CI and workflow 7.
 * The runner (scripts/bambu-import/translations.ts, workflow 60 mode
 * `translations`) posts each part's exact text through the import door, under
 * the run's own token; integrity never rests on that transport:
 *
 *   1. the part is in the bundled index, else 409 TRANSLATIONS_PART_UNKNOWN
 *      (the deploy is lagging); its bytes hash to the index's SHA-256, else 409
 *      TRANSLATIONS_PART_MISMATCH; the ledger read proves 0196, else 409
 *      TRANSLATIONS_SCHEMA_MISSING;
 *   2. the ledger already holds that SHA-256: `skipped`, nothing written;
 *   3. EVERY row is re-validated (packages/catalog/src/bambuImport/i18n.ts
 *      `validateTranslationRow`: `h === sourceHash(en)`, `en` normalized, the
 *      scripts, the digits and codes, no bidi control, no money word, …); one
 *      bad row refuses the whole part — 400 TRANSLATIONS_ROW_INVALID naming the
 *      row's index and code, never its text;
 *   4. two reads (the rows and refs already there), then ONE atomic batch: the
 *      new or changed rows (upserts, ≤ 98 parameters a statement), the new
 *      refs (`INSERT OR IGNORE`, 50 a statement), the ledger row;
 *   5. the products whose shown text changed — the products of a changed row
 *      and of a new ref, at most 60 — are purged from the colo's cache (the
 *      page body, its knowledge, its public v1 record); every other colo ages
 *      out within the answers' s-maxage + stale-while-revalidate (≤ 15 min).
 *
 * The loader never deletes: a row is withdrawn by committing it again as
 * `needs_review` (stored, never shown). Nothing here is money: the 0195 guard
 * triggers do not name these tables, and no price, cost or stock is read or
 * written.
 */
import translationsIndexModule from '../../../data/bambu-import/translations/index.json';
import { sha256Hex } from '@levonis/catalog/bambuImport/hash';
import { validateTranslationRow, type TranslationRow } from '@levonis/catalog/bambuImport/i18n';
import { IDENTITY_TERMS } from '../translate/dictionary';
import { purgeAnonymousCache } from '../edgePolicy';
import { edgeCache } from '../publicApi/cache';
import { publicV1PurgeKeys } from '../../routes/publicApi';
import type { Env } from '../types';
import { OpsRefusal, type ImportRun } from './auth';
import { IMPORT_INVOCATION_LIMIT, packedInserts, type InvocationCounter } from './budget';
import { purgeOrigins } from './purge';

// ---------------------------------------------------------------- the bundled index

export interface TranslationsIndexEntry {
  sha256: string;
  rows: number;
  bytes: number;
}

export interface TranslationsIndex {
  version: 1;
  parts: Record<string, TranslationsIndexEntry>;
}

/** A part's name: `p` and at least three digits (the ledger's CHECK). */
export const PART_NAME = /^p[0-9]{3,}$/;
/** A part file is at most 1 MB (the door's body cap is 2 MB). */
export const PART_MAX_BYTES = 1024 * 1024;
/** At most this many products are purged per part; the rest age out (§A.4 step 6). */
export const PURGE_MAX = 60;
const REF_ROWS_PER_STATEMENT = 50;

/** The index as committed, validated; anything malformed knows no part (every load answers UNKNOWN). */
export function parseTranslationsIndex(raw: unknown): TranslationsIndex {
  const empty: TranslationsIndex = { version: 1, parts: {} };
  const v = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return empty;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !o.parts || typeof o.parts !== 'object' || Array.isArray(o.parts)) return empty;
  const parts: Record<string, TranslationsIndexEntry> = {};
  for (const [name, e] of Object.entries(o.parts as Record<string, unknown>)) {
    if (!PART_NAME.test(name) || name.length > 40 || !e || typeof e !== 'object') return empty;
    const x = e as Record<string, unknown>;
    if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) return empty;
    if (!Number.isInteger(x.rows) || (x.rows as number) < 0 || !Number.isInteger(x.bytes) || (x.bytes as number) < 0 || (x.bytes as number) > PART_MAX_BYTES) return empty;
    parts[name] = { sha256: x.sha256, rows: x.rows as number, bytes: x.bytes as number };
  }
  return { version: 1, parts };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

let indexForTests: TranslationsIndex | null = null;

/** TEST-ONLY: the index the loader trusts (null: back to the bundled one). */
export function useTranslationsIndexForTests(index: TranslationsIndex | null): void {
  indexForTests = index;
}

/**
 * The bundled index. Wrangler may bundle the file as text or as a JSON module, and Node (the tests) parses it:
 * either form is read.
 */
export function bundledTranslationsIndex(): TranslationsIndex {
  return indexForTests ?? parseTranslationsIndex(translationsIndexModule);
}

// ---------------------------------------------------------------- the load

export interface TranslationLoadResult {
  part: string;
  skipped: boolean;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  refs_added: number;
  purge_ids: string[];
  purge_truncated: boolean;
}

const IDENTITY: ReadonlySet<string> = new Set(IDENTITY_TERMS);

const isMissing0196 = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e)) && /catalog_translation/i.test(e instanceof Error ? e.message : String(e));

/**
 * Loads one committed part (§A.4 steps 1–5). Throws an `OpsRefusal` with a fixed code for every refusal; the
 * caller purges `purge_ids`. `counter` is the invocation's statement count: a part whose batch would pass the
 * import's budget is refused before anything is written (PLAN_TOO_LARGE).
 */
export async function loadTranslationPart(
  db: D1Database,
  run: Pick<ImportRun, 'id'>,
  part: string,
  text: string,
  counter?: InvocationCounter
): Promise<TranslationLoadResult> {
  const index = bundledTranslationsIndex();
  const entry = PART_NAME.test(part) ? index.parts[part] : undefined;
  if (!entry) throw new OpsRefusal(409, 'TRANSLATIONS_PART_UNKNOWN', PART_NAME.test(part) ? [part] : []);
  if (sha256Hex(text) !== entry.sha256) throw new OpsRefusal(409, 'TRANSLATIONS_PART_MISMATCH', [part]);

  // The first read names 0196: its absence is the deploy-ahead answer, never a 500.
  let ledger: { sha256: string } | null;
  try {
    ledger = await db.prepare('SELECT sha256 FROM catalog_translation_parts WHERE part = ?').bind(part).first<{ sha256: string }>();
  } catch (e) {
    if (isMissing0196(e)) throw new OpsRefusal(409, 'TRANSLATIONS_SCHEMA_MISSING');
    throw e;
  }
  const none = { part, rows: entry.rows, inserted: 0, updated: 0, unchanged: 0, refs_added: 0, purge_ids: [], purge_truncated: false };
  if (ledger && ledger.sha256 === entry.sha256) return { ...none, skipped: true };

  // Every row, re-proved before anything is written. One bad row refuses the part.
  const parsed = safeJson(text);
  if (!Array.isArray(parsed)) throw new OpsRefusal(400, 'TRANSLATIONS_ROW_INVALID', ['row:-1', 'SHAPE']);
  if (parsed.length !== entry.rows) throw new OpsRefusal(409, 'TRANSLATIONS_PART_MISMATCH', [part]);
  const rows: TranslationRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const v = validateTranslationRow(parsed[i], { identity: IDENTITY });
    if (!v.ok) throw new OpsRefusal(400, 'TRANSLATIONS_ROW_INVALID', [`row:${i}`, v.code]);
    if (seen.has(v.row.h)) throw new OpsRefusal(400, 'TRANSLATIONS_ROW_INVALID', [`row:${i}`, 'DUPLICATE']);
    seen.add(v.row.h);
    rows.push(v.row);
  }

  // What is there already: two reads, one parameter each.
  const hashes = JSON.stringify(rows.map((r) => r.h));
  const [have, haveRefs] = await Promise.all([
    db
      .prepare('SELECT h, ar, ckb, kind, status FROM catalog_translations WHERE h IN (SELECT value FROM json_each(?1))')
      .bind(hashes)
      .all<{ h: string; ar: string; ckb: string; kind: string; status: string }>(),
    db.prepare('SELECT product_id, h FROM catalog_translation_refs WHERE h IN (SELECT value FROM json_each(?1))').bind(hashes).all<{ product_id: string; h: string }>(),
  ]);
  const existing = new Map((have.results ?? []).map((r) => [r.h, r]));
  const refSet = new Set((haveRefs.results ?? []).map((r) => `${r.product_id}\u0000${r.h}`));

  const upserts: unknown[][] = [];
  const newRefs: unknown[][] = [];
  const affected = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const r of rows) {
    const before = existing.get(r.h);
    const changed = !before || before.ar !== r.ar || before.ckb !== r.ckb || before.status !== r.status || before.kind !== r.kind;
    if (!before) inserted += 1;
    else if (changed) updated += 1;
    else unchanged += 1;
    if (changed) {
      upserts.push([r.h, r.en, r.ar, r.ckb, r.kind, r.status, part]);
      for (const p of r.products) affected.add(p);
    }
    for (const p of r.products) {
      if (refSet.has(`${p}\u0000${r.h}`)) continue;
      refSet.add(`${p}\u0000${r.h}`);
      newRefs.push([p, r.h]);
      affected.add(p);
    }
  }

  const statements = [
    ...packedInserts(
      db,
      'INSERT INTO catalog_translations (h, en, ar, ckb, kind, status, part)',
      '(?, ?, ?, ?, ?, ?, ?)',
      upserts,
      `ON CONFLICT(h) DO UPDATE SET ar = excluded.ar, ckb = excluded.ckb, kind = excluded.kind, status = excluded.status, part = excluded.part,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ),
    ...packedInserts(db, 'INSERT OR IGNORE INTO catalog_translation_refs (product_id, h)', '(?, ?)', newRefs, '', 2 * REF_ROWS_PER_STATEMENT),
    db
      .prepare(
        `INSERT INTO catalog_translation_parts (part, sha256, rows, run_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(part) DO UPDATE SET sha256 = excluded.sha256, rows = excluded.rows, run_id = excluded.run_id,
           loaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .bind(part, entry.sha256, rows.length, run.id),
  ];
  // The whole invocation counts (§A.5): the door, the rate limit, the reads, this batch, the purge read after it.
  if (counter && counter.count + statements.length + 1 > IMPORT_INVOCATION_LIMIT) throw new OpsRefusal(409, 'PLAN_TOO_LARGE', [part]);
  await db.batch(statements);

  const ids = [...affected].sort();
  return {
    part,
    skipped: false,
    rows: rows.length,
    inserted,
    updated,
    unchanged,
    refs_added: newRefs.length,
    purge_ids: ids.slice(0, PURGE_MAX),
    purge_truncated: ids.length > PURGE_MAX,
  };
}

/**
 * Drops the colo's cached answers of the products a load changed: the page body, its knowledge answer and its
 * public v1 record, on the request's origin and the root domain. No listing, home or section path: a card
 * carries no memory text (I18N-DESIGN D9). Best effort, never throws; answers what it purged.
 */
export async function purgeTranslatedProducts(
  env: Pick<Env, 'DB' | 'STORE_ROOT_DOMAIN' | 'APP_ORIGIN'>,
  requestUrl: string,
  productIds: readonly string[]
): Promise<{ products: number; paths: number; keys: number }> {
  if (!productIds.length) return { products: 0, paths: 0, keys: 0 };
  let slugs: string[] = [];
  try {
    const { results } = await env.DB.prepare('SELECT id, slug FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...productIds]))
      .all<{ id: string; slug: string }>();
    slugs = [...new Set((results ?? []).map((r) => String(r.slug ?? '')).filter(Boolean))].sort();
  } catch (e) {
    console.error('catalog_translations_purge_failed', JSON.stringify({ code: 'IMPORT_PURGE_FAILED', name: e instanceof Error ? e.name : typeof e }));
    return { products: 0, paths: 0, keys: 0 };
  }
  const paths = slugs.flatMap((s) => [`/api/products/${s}`, `/api/products/${s}/knowledge`, `/api/public/v1/products/${encodeURIComponent(s)}`]);
  let keys = 0;
  for (const origin of purgeOrigins(env, requestUrl)) {
    try {
      await purgeAnonymousCache(origin, paths);
      const v1 = publicV1PurgeKeys(origin, { products: slugs });
      keys += v1.length;
      const cache = edgeCache();
      if (cache) await Promise.all(v1.map((k) => cache.delete(k).catch(() => false)));
    } catch (e) {
      console.error('catalog_translations_purge_failed', JSON.stringify({ code: 'IMPORT_PURGE_FAILED', name: e instanceof Error ? e.name : typeof e }));
    }
  }
  return { products: slugs.length, paths: paths.length, keys };
}
