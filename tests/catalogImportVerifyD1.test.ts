/**
 * THE WORKER'S OWN D1 RECOMPUTE BEFORE COMPLETE (Bambu import spec §I.1.10;
 * worker/lib/catalogImport/verifyD1.ts).
 *
 * After a real write, every check holds: VISIBLE and not SELLABLE through
 * catalog-only's predicates, the map's taxonomy, the search stamp, the title
 * and alias tokens, the R2 objects, the counts the write recorded, the stock
 * decision, no guard row, and the price-request door answering eligible for the
 * default selection — through the POST's own validator, with no request row
 * created. Each check fails on its own when D1 disagrees; the answer names the
 * failed checks and never a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { recomputeD1Checks } from '../worker/lib/catalogImport/verifyD1';
import { INDEX_STAMP } from '../worker/lib/search/store';

async function written(handle: 'pla-basic-filament' | 'ams-2-pro-feeder-unit' | 'h2d' = 'pla-basic-filament') {
  const w = newWorld();
  const s = stage(w, handle);
  await write(w, s);
  return { w, s, pid: s.payload.product_id };
}

const check = (w: World, item: string, extra: Partial<Parameters<typeof recomputeD1Checks>[1]> = {}) =>
  recomputeD1Checks(w.db, { bundle: w.bundle, runId: RUN_ID, itemId: item, media: w.media as never, ...extra });

test('after a real write every D1 check holds, and the answer carries booleans and counts only', async () => {
  const { w, s } = await written();
  const r = await check(w, s.itemId);
  assert.deepEqual(r.failed, []);
  assert.equal(r.ok, true);
  for (const k of ['written', 'visible', 'not_sellable', 'taxonomy', 'memberships', 'search_stamp', 'search_tokens', 'counts', 'media', 'stock_decision', 'guard_clear', 'price_request', 'no_request_created']) {
    assert.equal(r.checks[k], true, k);
  }
  assert.ok(Number(r.counts.images) > 0 && Number(r.counts.media_objects) > Number(r.counts.images), 'images, swatches and box pictures HEADed');
  const text = JSON.stringify(r);
  assert.ok(!/https?:|\/files\/|PLA Basic/.test(text), 'no URL, key or name in the answer');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_price_requests'), 0, 'the eligibility check created no request');
});

test('each check fails on its own when D1 disagrees', async () => {
  const { w, s, pid } = await written('ams-2-pro-feeder-unit');
  assert.equal((await check(w, s.itemId)).ok, true);
  // A lost image binding row.
  const img = (w.raw.prepare('SELECT id, r2_key FROM product_images WHERE product_id = ? AND is_primary = 0 LIMIT 1').get(pid) as { id: string; r2_key: string });
  w.raw.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  assert.deepEqual((await check(w, s.itemId)).failed, ['counts']);
  // A missing object in R2.
  const primary = (w.raw.prepare('SELECT r2_key FROM product_images WHERE product_id = ? AND is_primary = 1').get(pid) as { r2_key: string }).r2_key;
  w.bucket.objects.delete(primary);
  assert.ok((await check(w, s.itemId)).failed.includes('media'));
  assert.equal((await check(w, s.itemId, { media: undefined })).checks.media, null, 'without the bindings the HEADs are not run');
  // The search stamp.
  w.raw.prepare('DELETE FROM search_tokens WHERE product_id = ? AND token = ?').run(pid, INDEX_STAMP);
  assert.ok((await check(w, s.itemId)).failed.includes('search_stamp'));
  // Hidden: not visible.
  w.raw.prepare("UPDATE products SET status = 'hidden' WHERE id = ?").run(pid);
  const hidden = await check(w, s.itemId);
  assert.ok(hidden.failed.includes('visible') && hidden.failed.includes('not_sellable') && hidden.failed.includes('price_request'));
  // A stock decision taken.
  w.raw.prepare("UPDATE product_source_refs SET stock_decision = 'untracked', stock_decided_by = 'usr', stock_decided_at = 't' WHERE product_id = ?").run(pid);
  assert.ok((await check(w, s.itemId)).failed.includes('stock_decision'));
  // A guard row that survived.
  w.raw.exec("INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
  assert.ok((await check(w, s.itemId)).failed.includes('guard_clear'));
  // Moved out of its section.
  w.raw.prepare('UPDATE products SET sub_category_id = NULL WHERE id = ?').run(pid);
  assert.ok((await check(w, s.itemId)).failed.includes('taxonomy'));
});

test('price-request eligibility: complete selections eligible, an incomplete one SELECTION_REQUIRED, through the POST validator', async () => {
  const { w, s, pid } = await written('h2d');
  const values = w.raw.prepare('SELECT v.id, v.group_id FROM product_option_values v WHERE v.product_id = ? ORDER BY v.group_id, v.sort').all(pid) as Array<{ id: string; group_id: string }>;
  const variant = (w.raw.prepare('SELECT combo_key FROM product_variants WHERE product_id = ? LIMIT 1').get(pid) as { combo_key: string }).combo_key;
  const complete = variant.split('|').map((p) => p.slice(2));
  const incomplete = [values[0].id];
  const ok = await check(w, s.itemId, { selections: [{ option_value_ids: complete }, { option_value_ids: incomplete }] });
  assert.equal(ok.checks.price_request, true);
  assert.equal(ok.counts.selections_checked, 3, 'the default selection and the two the runner checked');
  // A selection that names no real SKU is neither: the check fails.
  const bad = await check(w, s.itemId, { selections: [{ option_value_ids: ['ov_not_a_value', values[1].id] }] });
  assert.equal(bad.checks.price_request, false);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_price_requests'), 0);
});

test('an item that was never written fails the first check and says nothing else', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const r = await check(w, s.itemId);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ['written']);
});
