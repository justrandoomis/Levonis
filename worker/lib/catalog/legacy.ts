/**
 * THE PRE-0126 OPTIONS / COLOURS, MOVED ONTO THE VARIANT MODEL — one product
 * at a time, only when nothing has to be invented (packages/catalog legacy.ts
 * says exactly when that is).
 *
 * Migration 0127 marked every product whose `options`/`colors` JSON offered a
 * choice as `variant_mode = 'legacy'`: sold exactly as before. This converts
 * them, bounded per run, from the scheduled jobs (`runCatalogSweeps`):
 *
 *   · mappable → option groups, values (each remembering the old entry id it
 *     came from, `legacy_ref`) and variants; the product's mode flips to
 *     `variants`; the cart lines that named an old (option, colour) pair are
 *     re-pointed at the variant it became — ONE batch, fenced on the product
 *     still being the legacy product that was read (a merchant edit in between
 *     aborts it, and the next run reads the new state);
 *   · not mappable → it stays `legacy` with a note of why
 *     (`legacy_variant_note`), which the editor shows beside «convert».
 *
 * Idempotent: a converted product is no longer `legacy`, a noted one is not
 * picked again.
 */
import type { Env } from '../types';
import { convertLegacyOptions } from '@levonis/catalog/legacy';
import { readExistingModel, variantModelStatements } from './product';

export const LEGACY_BATCH = 50;

export interface LegacySweepReport {
  converted: number;
  kept_legacy: number;
  errors: number;
}

export async function convertLegacyProducts(env: Env, limit = LEGACY_BATCH): Promise<LegacySweepReport> {
  const db = env.DB;
  const report: LegacySweepReport = { converted: 0, kept_legacy: 0, errors: 0 };
  const { results } = await db
    .prepare(
      `SELECT id, store_id, options, colors, track_stock, stock FROM community_products
        WHERE variant_mode = 'legacy' AND legacy_variant_note IS NULL AND store_id IS NOT NULL
        ORDER BY created_at, id LIMIT ?1`
    )
    .bind(limit)
    .all<{ id: string; store_id: string; options: string; colors: string; track_stock: number; stock: number }>();

  for (const p of results) {
    try {
      const conv = convertLegacyOptions(p.options, p.colors, { track_stock: !!Number(p.track_stock), stock: Number(p.stock) || 0 });
      if (!conv.ok) {
        await db
          .prepare(
            `UPDATE community_products
                SET legacy_variant_note = CASE WHEN ?2 = 'empty' THEN NULL ELSE ?2 END,
                    variant_mode = CASE WHEN ?2 = 'empty' THEN 'simple' ELSE variant_mode END
              WHERE id = ?1 AND variant_mode = 'legacy' AND options = ?3 AND colors = ?4`
          )
          .bind(p.id, conv.reason, p.options, p.colors)
          .run();
        report.kept_legacy += 1;
        continue;
      }
      // Each value remembers the old entry id that named it.
      const legacyRefs = new Map<string, string>();
      conv.model.variants.forEach((v, i) => {
        v.values.forEach((ref) => {
          legacyRefs.set(ref, ref.startsWith('lo_') ? conv.legacyKeys[i].option_id : conv.legacyKeys[i].color_id);
        });
      });
      const existing = await readExistingModel(db, p.id);
      const written = variantModelStatements(db, p.id, p.store_id, conv.model, existing, legacyRefs);
      const stmts: D1PreparedStatement[] = [
        // THE FENCE: still the legacy product this run read — else NULL into the
        // NOT NULL `name` aborts the whole batch.
        db
          .prepare(
            `UPDATE community_products
                SET name = CASE WHEN variant_mode = 'legacy' AND options = ?2 AND colors = ?3 THEN name ELSE NULL END
              WHERE id = ?1`
          )
          .bind(p.id, p.options, p.colors),
        ...written.statements,
      ];
      // A cart line that named an old (option, colour) pair now names its variant.
      conv.legacyKeys.forEach((k, i) => {
        const vid = written.variantIds[i];
        stmts.push(
          db
            .prepare(
              `UPDATE cart_items SET variant_id = ?1, option_id = ?1, color_id = ''
                WHERE community_product_id = ?2 AND option_id = ?3 AND color_id = ?4`
            )
            .bind(vid, p.id, k.option_id, k.color_id)
        );
      });
      // One combination: a line that chose nothing (the only line the old page
      // could add) is that combination — unless the customer already holds it.
      if (written.variantIds.length === 1) {
        stmts.push(
          db
            .prepare(
              `UPDATE cart_items SET variant_id = ?1, option_id = ?1, color_id = ''
                WHERE community_product_id = ?2 AND option_id = '' AND color_id = ''
                  AND NOT EXISTS (SELECT 1 FROM cart_items o WHERE o.user_id = cart_items.user_id
                                   AND o.community_product_id = ?2 AND o.option_id = ?1)`
            )
            .bind(written.variantIds[0], p.id)
        );
      }
      await db.batch(stmts);
      report.converted += 1;
    } catch (e) {
      report.errors += 1;
      console.error('catalog: legacy options not converted', p.id, e instanceof Error ? e.message : String(e));
    }
  }
  return report;
}
