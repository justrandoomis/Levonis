/**
 * Persistence for the local translator (mandate §3: "خزّن المصدر الإنجليزي
 * ومخرجات ar وckb مع حالة translation_version").
 *
 * Writes rows into `product_translations` (migration 0018). Two properties
 * matter and are enforced here rather than left to callers:
 *
 *  1. NO NETWORK. The engine is pure; this module only touches D1. A save or
 *     an import therefore never waits on, or depends on, an external service.
 *  2. A translation NEVER blocks a save. Every write is a plain upsert, and a
 *     segment the engine refused to translate is stored as its English source
 *     with status='review_needed'. Nothing here throws on low coverage.
 *
 * `source_hash` lets a re-save skip fields whose English text has not changed,
 * and an `approved` row (a human edited it on the future review page) is never
 * overwritten by the machine as long as its source is unchanged.
 */

import { translateField, type FieldTranslation } from './index';

export interface TranslationInput {
  field: string;
  source_en: string;
}

export interface TranslationWriteSummary {
  written: number;
  skipped_unchanged: number;
  kept_approved: number;
  review_needed: string[];
}

interface ExistingRow {
  field: string;
  source_hash: string;
  status: string;
}

/**
 * Regenerates and stores translations for the given fields of one product.
 * Returns a summary the caller can surface in the admin UI — the fields still
 * needing a human are named explicitly, never hidden behind a success message.
 */
export async function syncProductTranslations(
  db: D1Database,
  productId: string,
  inputs: TranslationInput[]
): Promise<TranslationWriteSummary> {
  const summary: TranslationWriteSummary = {
    written: 0,
    skipped_unchanged: 0,
    kept_approved: 0,
    review_needed: [],
  };
  if (inputs.length === 0) return summary;

  const { results } = await db
    .prepare('SELECT field, source_hash, status FROM product_translations WHERE product_id = ?')
    .bind(productId)
    .all<ExistingRow>();
  const existing = new Map(results.map((r) => [r.field, r]));

  const statements: D1PreparedStatement[] = [];
  const nowIso = new Date().toISOString();

  for (const input of inputs) {
    const t: FieldTranslation = translateField(input.field, input.source_en);
    const prev = existing.get(input.field);

    if (prev && prev.source_hash === t.source_hash) {
      // Source unchanged. A human-approved row stays exactly as the human left
      // it; a machine row has nothing new to say either.
      if (prev.status === 'approved') summary.kept_approved += 1;
      else summary.skipped_unchanged += 1;
      if (prev.status === 'review_needed') summary.review_needed.push(input.field);
      continue;
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO product_translations
             (product_id, field, source_en, source_hash, text_ar, text_ckb, status, translation_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (product_id, field) DO UPDATE SET
             source_en = excluded.source_en,
             source_hash = excluded.source_hash,
             text_ar = excluded.text_ar,
             text_ckb = excluded.text_ckb,
             status = excluded.status,
             translation_version = excluded.translation_version,
             updated_at = excluded.updated_at`
        )
        .bind(
          productId,
          t.field,
          t.source_en,
          t.source_hash,
          t.text_ar,
          t.text_ckb,
          t.status,
          t.translation_version,
          nowIso
        )
    );
    summary.written += 1;
    if (t.status === 'review_needed') summary.review_needed.push(t.field);
  }

  // Fields the product no longer has (a description that was emptied) lose
  // their stale translations rather than lingering as ghost text.
  const keep = new Set(inputs.map((i) => i.field));
  for (const field of existing.keys()) {
    if (!keep.has(field)) {
      statements.push(
        db
          .prepare('DELETE FROM product_translations WHERE product_id = ? AND field = ?')
          .bind(productId, field)
      );
    }
  }

  if (statements.length) await db.batch(statements);
  return summary;
}

export interface StoredTranslation {
  field: string;
  text_ar: string;
  text_ckb: string;
  status: string;
}

/** Reads the stored translations for one product, keyed by field. */
export async function loadProductTranslations(
  db: D1Database,
  productId: string
): Promise<Record<string, StoredTranslation>> {
  const { results } = await db
    .prepare('SELECT field, text_ar, text_ckb, status FROM product_translations WHERE product_id = ?')
    .bind(productId)
    .all<StoredTranslation>();
  const out: Record<string, StoredTranslation> = {};
  for (const r of results) out[r.field] = r;
  return out;
}
