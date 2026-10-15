/**
 * A RE-SEND WRITES THE SAME ROWS; A DUPLICATE CREATE IS IMPOSSIBLE (Bambu
 * import spec §A.7 "An ambiguous write failure", §B.8 deterministic ids).
 *
 *   - a write whose batch aborted (a lapsed lease) leaves nothing, and the
 *     retry under a fresh lease writes exactly the rows a write that never
 *     failed writes in another database: every id is deterministic (§B.8);
 *   - once a create has committed, sending it again — the same item, or the
 *     same source in a new run — is refused (IMPORT_DUPLICATE_CREATE) and changes
 *     nothing: the product_source_refs primary key (source, source_product_id)
 *     cannot hold the source twice;
 *   - a merge re-sent writes nothing new: the same rows, the same digests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1 } from './fixtures/app';
import { count, LEASE, newWorld, plan, RUN_ID, setWriting, stage, write, type World } from './fixtures/catalogImportWorld';
import { sample } from './fixtures/bambu/load';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { validateProductDoc } from '../worker/lib/productModel';
import { importWriteContext, ImportWriteRefused, planImportWrite, refusalOfBatch, runImportWrite } from '../worker/lib/catalogImport/writer';

/** Every row the import writes for one product, without timestamps or event ids (they are clocks, not content). */
function snapshot(w: World, productId: string): Record<string, unknown[]> {
  const drop = new Set(['created_at', 'updated_at', 'at', 'retrieved_at', 'fetched_at', 'resolved_at', 'id_event']);
  const clean = (rows: object[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k))));
  const q = (sql: string) => clean(w.raw.prepare(sql).all(productId) as object[]);
  return {
    product: q("SELECT id, slug, status, name, name_ar, name_ku, description, price_iqd, stock, category_id, sub_category_id, brand_id, inventory_mode, spec_fields, specifications, content_blocks, usage_guide, translation_meta FROM products WHERE id = ?"),
    groups: q('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id'),
    values: q('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id'),
    variants: q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id'),
    images: q('SELECT id, url, r2_key, sort_order, is_primary, option_value_id, variant_id, color_id, alt_en, alt_ar, alt_ckb FROM product_images WHERE product_id = ? ORDER BY id'),
    catalogs: q('SELECT catalog_id FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id'),
    source: q('SELECT source, source_product_id, source_handle, match_kind, stock_decision, fingerprint FROM product_source_refs WHERE product_id = ?'),
    optionRefs: q('SELECT * FROM product_option_source_refs WHERE product_id = ? ORDER BY kind, source_id, levonis_id'),
    specs: q('SELECT * FROM product_spec_values WHERE product_id = ? ORDER BY id'),
    documents: q('SELECT * FROM product_documents WHERE product_id = ? ORDER BY id'),
    externalIds: q('SELECT * FROM product_external_ids WHERE product_id = ? ORDER BY scope_kind, scope_id, id_type, value'),
    relations: q('SELECT * FROM product_relations WHERE product_id = ? ORDER BY id'),
    swatches: q('SELECT option_value_id, product_id, width, height FROM product_option_value_swatches WHERE product_id = ? ORDER BY option_value_id'),
    translations: q('SELECT product_id, field, source_en, source_hash, text_ar, text_ckb, status FROM product_translations WHERE product_id = ? ORDER BY field'),
    tokens: q('SELECT token, weight FROM search_tokens WHERE product_id = ? ORDER BY token'),
    conflicts: q('SELECT id, kind, field, detail FROM catalog_import_conflicts WHERE product_id = ? ORDER BY id'),
  };
}

/** The object keys differ between two worlds (each stores its own bytes); everything else is content. */
function withoutObjectKeys(s: Record<string, unknown[]>): Record<string, unknown[]> {
  const scrub = (v: unknown): unknown =>
    typeof v === 'string' ? v.replace(/products\/import\/gallery\/[0-9a-f]{64}\.webp/g, '<key>') : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
  return scrub(s) as Record<string, unknown[]>;
}

test('an aborted write leaves nothing; the retry writes exactly the rows of a write that never failed', async () => {
  // Reference: written in one go.
  const ref = newWorld();
  const refStaged = stage(ref, 'pla-basic-filament');
  await write(ref, refStaged);
  const expected = withoutObjectKeys(snapshot(ref, refStaged.payload.product_id));

  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  const first = await plan(w, s);
  w.raw.prepare("UPDATE catalog_import_items SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(s.itemId);
  await assert.rejects(() => runImportWrite(first.ctx, first.plan), (e: unknown) => e instanceof ImportWriteRefused && e.code === 'IMPORT_ITEM_CHANGED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM products'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_spec_values'), 0);
  // The retry: a fresh lease, the same staged payload.
  setWriting(w, s.itemId, s.payload);
  await write(w, s);
  const got = withoutObjectKeys(snapshot(w, s.payload.product_id));
  assert.deepEqual(got, expected, 'the same ids, the same rows');
  assert.ok((got.optionRefs as unknown[]).length > 100 && (got.specs as unknown[]).length > 0);
});

test('a create cannot happen twice: the same item re-sent, or the same source in a new run, is refused and changes nothing', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  await write(w, s);
  const pid = s.payload.product_id;
  const before = snapshot(w, pid);
  // The same item: it left WRITING with its checkpoint, so the writer refuses before planning.
  await assert.rejects(() => plan(w, s), (e: unknown) => e instanceof ImportWriteRefused && e.code === 'IMPORT_ILLEGAL_TRANSITION');
  // The same source in a new run (the first run closed): planned, then refused by the database.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_ID);
  const run2 = 'cir_fedcba9876543210fedcba98';
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'running')").run(run2);
  w.raw.prepare("UPDATE catalog_import_media SET run_id = ? WHERE run_id = ?").run(run2, RUN_ID);
  w.raw
    .prepare(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at)
       VALUES ('cii_second', ?, 'bambu_us', ?, ?, 'https://us.store.bambulab.com/products/x', 1, 't')`
    )
    .run(run2, s.payload.source_product_id, s.payload.handle);
  setWriting(w, 'cii_second', s.payload);
  const ctx = importWriteContext(w.db, w.media as never);
  const p = await planImportWrite(ctx, { mode: 'write', payload: s.payload, bundle: w.bundle, runId: run2, itemId: 'cii_second', leaseToken: LEASE });
  await assert.rejects(() => runImportWrite(ctx, p), (e: unknown) => e instanceof ImportWriteRefused && e.code === 'IMPORT_DUPLICATE_CREATE');
  assert.deepEqual(snapshot(w, pid), before, 'nothing changed');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM products'), 1);
  // The key itself: the source cannot be recorded for a second product.
  const raw = w.raw;
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
           VALUES ('bambu_us', ?, ?, 'another-handle', 'https://x', 'created', 'not_configured', 'f', 't', ?)`
        )
        .run(s.payload.source_product_id, pid, run2),
    (e: Error) => {
      const mapped = refusalOfBatch(e);
      return mapped instanceof ImportWriteRefused && mapped.code === 'IMPORT_DUPLICATE_CREATE';
    }
  );
});

test('a merge re-sent writes nothing new: the same rows, an equal fingerprint', async () => {
  const w = newWorld();
  const db = asD1(w.raw);
  const doc = validateProductDoc({ id: 'p_a1old', slug: 'bambu-lab-a1', name_en: 'Bambu Lab A1', price_iqd: 0, status: 'active', category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm' });
  await saveProductAtomic(
    db,
    await planProductSave(db, {
      mode: 'create',
      doc,
      prev: null,
      relations: { inventory_mode: 'VARIANT_COMBINATION', groups: [{ id: 'g_model', name_en: 'Model', sort: 0, values: [{ id: 'v_std', name_en: 'A1', sort: 0 }] }], colors: [], variants: [{ id: 'x_std', option_value_ids: ['v_std'] }], images: [] },
      catalogIds: ['cat_printers'],
      actor: { adminId: 'usr_owner', money: false },
    })
  );
  const x = sample('a1');
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_a1old', decision: 'merge', value_map: { '579550514255634444': { option_value_ids: ['v_std'] } }, reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  const first = await write(w, s);
  assert.equal(first.result.before_fp_equal, true);
  const after1 = snapshot(w, 'p_a1old');
  // The runner never re-sends a committed write (/lease reports the product); if a second write of the same
  // merge does run — the item rolled back and processed again — it changes nothing.
  // Back to WRITING the only way the graph allows: COMPLETE, then the rollback to the end of the queue (§A.10).
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'VERIFYING_LIVE', last_completed_stage = 'PUBLISHING' WHERE id = ?").run(s.itemId);
  w.raw
    .prepare("UPDATE catalog_import_items SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = 'u', verified_at = 'v', d1_checks = '{\"ok\":1}', edge_evidence = '{\"ok\":1}' WHERE id = ?")
    .run(s.itemId);
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'DISCOVERED', last_completed_stage = '', levonis_product_id = '', queue_position = 99 WHERE id = ?").run(s.itemId);
  setWriting(w, s.itemId, s.payload);
  const second = await write(w, s);
  assert.equal(second.result.before_fp_equal, true);
  assert.deepEqual(snapshot(w, 'p_a1old'), after1, 'the same rows, byte for byte');
});
