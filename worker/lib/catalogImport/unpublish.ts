/**
 * CONTROLLED UNPUBLISH ON BLOCK, AND THE REPUBLISH ON RESUME (Bambu import
 * spec §A.10; §A.3 `event BLOCKED`, `/publish-finish`).
 *
 * A product the RUN CREATED that reaches BLOCKED after its write is taken off
 * the storefront in the same call that records the block, so a half-verified
 * product is never left showing:
 *
 *   0  INSERT the guard row ops_guards('catalog-import-batch')  — arms 0195's guards
 *   1  catalog_import_items.unpublished_on_block = 1, only when step 2 will take effect
 *   2  UPDATE products SET status = 'hidden' — only an ACTIVE product whose
 *      product_source_refs row says this run CREATED it (a merged product is
 *      never unpublished, §A.10 row 2)
 *   …  the caller's own statements (the BLOCKED transition of the item)
 *   n  the UNPUBLISHED event, fenced by trg_cie_lease_fence: a stale executor's
 *      batch aborts whole
 *   n+1 DELETE the guard row
 *
 * The route purges the product's pages afterwards (step 6b). On resume,
 * `/publish-finish` runs the mirror image (`republishAfterBlock`): the
 * product goes back to `active` only while the item records that the import
 * hid it, with a REPUBLISHED event under the same fence.
 */
import { newId } from '../crypto';
import { IMPORT_GUARD_ID } from './protectedTables';
import { refusalOfBatch } from './writer';

export interface UnpublishInput {
  runId: string;
  itemId: string;
  leaseToken: string;
  productId: string;
  /** Statements the caller's call writes in the same batch (the BLOCKED transition), before the fenced event. */
  extra?: D1PreparedStatement[];
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** The product was created by this run (product_source_refs, §B.2): the one product the import may hide. */
const CREATED_BY_RUN = `id IN (SELECT product_id FROM product_source_refs WHERE match_kind = 'created' AND import_run_id = ? AND product_id = ?)`;

function eventStatement(db: D1Database, input: UnpublishInput, stage: 'UNPUBLISHED' | 'REPUBLISHED'): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), ?, ?, '', '', '{}', ?)`
    )
    .bind(newId('cie'), input.runId, input.itemId, input.runId, stage, stage === 'UNPUBLISHED' ? 'unpublished' : 'republished', input.leaseToken);
}

/** The unpublish batch (§A.10 row 1). `changedAt` is the index of the products UPDATE in it. */
export function unpublishOnBlockStatements(db: D1Database, input: UnpublishInput): { statements: D1PreparedStatement[]; changedAt: number } {
  const statements: D1PreparedStatement[] = [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(IMPORT_GUARD_ID)];
  // The flag first, on the same condition the hide reads: a product the owner had already hidden is not the
  // import's to hide, so it is never flagged — and never re-activated by the republish.
  statements.push(
    db
      .prepare(
        `UPDATE catalog_import_items SET unpublished_on_block = 1, updated_at = ${NOW_SQL}
          WHERE id = ? AND run_id = ? AND levonis_product_id = ?
            AND EXISTS (SELECT 1 FROM products WHERE id = ? AND status = 'active' AND ${CREATED_BY_RUN})`
      )
      .bind(input.itemId, input.runId, input.productId, input.productId, input.runId, input.productId)
  );
  const changedAt = statements.length;
  statements.push(
    db
      .prepare(`UPDATE products SET status = 'hidden', updated_at = ${NOW_SQL} WHERE id = ? AND status = 'active' AND ${CREATED_BY_RUN}`)
      .bind(input.productId, input.runId, input.productId)
  );
  statements.push(...(input.extra ?? []));
  statements.push(eventStatement(db, input, 'UNPUBLISHED'));
  statements.push(db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID));
  return { statements, changedAt };
}

/** Runs the unpublish batch. `unpublished` is true when the product was active and is now hidden. */
export async function unpublishOnBlock(db: D1Database, input: UnpublishInput): Promise<{ unpublished: boolean }> {
  const { statements, changedAt } = unpublishOnBlockStatements(db, input);
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = (await db.batch(statements)) as Array<{ meta?: { changes?: number } }>;
  } catch (e) {
    throw refusalOfBatch(e);
  }
  return { unpublished: Number(results[changedAt]?.meta?.changes ?? 0) > 0 };
}

/** The republish batch of `/publish-finish` on resume (§A.10): active again only while the import's own flag stands. */
export function republishStatements(db: D1Database, input: UnpublishInput): { statements: D1PreparedStatement[]; changedAt: number } {
  const statements: D1PreparedStatement[] = [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(IMPORT_GUARD_ID)];
  const changedAt = statements.length;
  statements.push(
    db
      .prepare(
        `UPDATE products SET status = 'active', updated_at = ${NOW_SQL}
          WHERE id = ? AND status = 'hidden' AND ${CREATED_BY_RUN}
            AND EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND run_id = ? AND levonis_product_id = ? AND unpublished_on_block = 1)`
      )
      .bind(input.productId, input.runId, input.productId, input.itemId, input.runId, input.productId)
  );
  statements.push(
    db
      .prepare(`UPDATE catalog_import_items SET unpublished_on_block = 0, updated_at = ${NOW_SQL} WHERE id = ? AND run_id = ? AND levonis_product_id = ? AND unpublished_on_block = 1`)
      .bind(input.itemId, input.runId, input.productId)
  );
  statements.push(...(input.extra ?? []));
  statements.push(eventStatement(db, input, 'REPUBLISHED'));
  statements.push(db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID));
  return { statements, changedAt };
}

/** Runs the republish batch. `republished` is true when the product went back to active. */
export async function republishAfterBlock(db: D1Database, input: UnpublishInput): Promise<{ republished: boolean }> {
  const { statements, changedAt } = republishStatements(db, input);
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = (await db.batch(statements)) as Array<{ meta?: { changes?: number } }>;
  } catch (e) {
    throw refusalOfBatch(e);
  }
  return { republished: Number(results[changedAt]?.meta?.changes ?? 0) > 0 };
}
