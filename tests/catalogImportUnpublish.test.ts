/**
 * CONTROLLED UNPUBLISH ON BLOCK AND THE REPUBLISH ON RESUME (Bambu import spec
 * §A.10; worker/lib/catalogImport/unpublish.ts).
 *
 *   - a product the run CREATED that blocks after its write is hidden in one
 *     guarded batch, with the item flagged and an UNPUBLISHED event under the
 *     lease fence; the caller's own statements (the BLOCKED transition) ride in it;
 *   - a stale executor's batch aborts whole (the lease fence): nothing hidden;
 *   - a merged product is never unpublished, and a product the owner had
 *     already hidden is never flagged — so the republish never re-activates it;
 *   - the republish puts the product back to active only while the import's own
 *     flag stands, with a REPUBLISHED event; the guard row never survives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1 } from './fixtures/app';
import { count, LEASE, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { sample } from './fixtures/bambu/load';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { validateProductDoc } from '../worker/lib/productModel';
import { republishAfterBlock, unpublishOnBlock } from '../worker/lib/catalogImport/unpublish';
import { ImportWriteRefused } from '../worker/lib/catalogImport/writer';
import { IMPORT_GUARD_ID } from '../worker/lib/catalogImport/protectedTables';

const status = (w: World, id: string) => (w.raw.prepare('SELECT status FROM products WHERE id = ?').get(id) as { status: string }).status;
const flag = (w: World, item: string) => (w.raw.prepare('SELECT unpublished_on_block AS f FROM catalog_import_items WHERE id = ?').get(item) as { f: number }).f;
const events = (w: World, item: string) => (w.raw.prepare('SELECT stage, outcome FROM catalog_import_events WHERE item_id = ? ORDER BY seq').all(item) as Array<{ stage: string; outcome: string }>).map((e) => `${e.stage}:${e.outcome}`);

async function created(): Promise<{ w: World; pid: string; item: string }> {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  await write(w, s);
  return { w, pid: s.payload.product_id, item: s.itemId };
}

const blocked = (w: World, item: string) =>
  w.db
    .prepare("UPDATE catalog_import_items SET processing_state = 'BLOCKED', blocker_code = 'VERIFY_FAILED_PERSISTENT', resume_instruction = 'dispatch workflow 60 mode=run resume=true' WHERE id = ?")
    .bind(item);

test('a created product that blocks after its write is hidden in the same batch as the block, under the lease fence', async () => {
  const { w, pid, item } = await created();
  assert.equal(status(w, pid), 'active');
  const r = await unpublishOnBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: LEASE, productId: pid, extra: [blocked(w, item)] });
  assert.equal(r.unpublished, true);
  assert.equal(status(w, pid), 'hidden');
  assert.equal(flag(w, item), 1);
  assert.equal((w.raw.prepare('SELECT processing_state AS s FROM catalog_import_items WHERE id = ?').get(item) as { s: string }).s, 'BLOCKED');
  assert.deepEqual(events(w, item), ['WRITTEN:ok', 'UNPUBLISHED:unpublished']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0);
  // On resume: back to active, the flag cleared, a REPUBLISHED event.
  const back = await republishAfterBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: LEASE, productId: pid });
  assert.equal(back.republished, true);
  assert.equal(status(w, pid), 'active');
  assert.equal(flag(w, item), 0);
  assert.deepEqual(events(w, item), ['WRITTEN:ok', 'UNPUBLISHED:unpublished', 'REPUBLISHED:republished']);
  // A second republish finds no flag: nothing moves.
  assert.equal((await republishAfterBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: LEASE, productId: pid })).republished, false);
});

test("a stale executor's unpublish aborts whole: the product stays, no flag, no event", async () => {
  const { w, pid, item } = await created();
  await assert.rejects(
    () => unpublishOnBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: 'lease_stale', productId: pid, extra: [blocked(w, item)] }),
    (e: unknown) => e instanceof ImportWriteRefused && e.code === 'IMPORT_LEASE_LOST'
  );
  assert.equal(status(w, pid), 'active');
  assert.equal(flag(w, item), 0);
  assert.deepEqual(events(w, item), ['WRITTEN:ok']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0);
});

test('a product the owner already hid is not the import’s: never flagged, never re-activated', async () => {
  const { w, pid, item } = await created();
  w.raw.prepare("UPDATE products SET status = 'hidden' WHERE id = ?").run(pid);
  const r = await unpublishOnBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: LEASE, productId: pid });
  assert.equal(r.unpublished, false);
  assert.equal(flag(w, item), 0);
  assert.equal((await republishAfterBlock(w.db, { runId: RUN_ID, itemId: item, leaseToken: LEASE, productId: pid })).republished, false);
  assert.equal(status(w, pid), 'hidden', 'the owner’s choice stands');
});

test('a merged product is never unpublished (§A.10 row 2)', async () => {
  const w = newWorld();
  const db = asD1(w.raw);
  const doc = validateProductDoc({ id: 'p_a1old', slug: 'bambu-lab-a1', name_en: 'Bambu Lab A1', price_iqd: 0, status: 'active', category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm' });
  await saveProductAtomic(
    db,
    await planProductSave(db, {
      mode: 'create',
      doc,
      prev: null,
      relations: { inventory_mode: 'VARIANT_COMBINATION', groups: [{ id: 'g', name_en: 'Model', sort: 0, values: [{ id: 'v', name_en: 'A1', sort: 0 }] }], colors: [], variants: [{ id: 'x', option_value_ids: ['v'] }], images: [] },
      catalogIds: ['cat_printers'],
      actor: { adminId: 'usr_owner', money: false },
    })
  );
  const x = sample('a1');
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_a1old', decision: 'merge', value_map: { '579550514255634444': { option_value_ids: ['v'] } }, reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  await write(w, s);
  const r = await unpublishOnBlock(w.db, { runId: RUN_ID, itemId: s.itemId, leaseToken: LEASE, productId: 'p_a1old', extra: [blocked(w, s.itemId)] });
  assert.equal(r.unpublished, false);
  assert.equal(status(w, 'p_a1old'), 'active');
  assert.equal(flag(w, s.itemId), 0);
  assert.equal((w.raw.prepare('SELECT processing_state AS s FROM catalog_import_items WHERE id = ?').get(s.itemId) as { s: string }).s, 'BLOCKED', 'the block itself is still recorded');
});
