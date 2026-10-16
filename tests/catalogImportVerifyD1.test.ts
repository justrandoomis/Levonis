/**
 * THE WORKER'S OWN D1 RECOMPUTE BEFORE COMPLETE (Bambu import spec §I.1.10;
 * worker/lib/catalogImport/verifyD1.ts).
 *
 * After a real write, every check holds: VISIBLE and not SELLABLE through
 * catalog-only's predicates, the map's taxonomy, the search stamp, the title
 * and alias tokens, the R2 objects, the counts the write recorded, the stock
 * decision, no guard row, and the price-request door answering eligible for the
 * default selection — through the POST's own validator, with no request row
 * created. Each check fails on its own when D1 disagrees (a created product
 * made SELLABLE, a membership too many or the root one lost, a title token
 * lost, the source row's kind, and a merged item's own branches); the answer
 * names the failed checks and never a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { recomputeD1Checks } from '../worker/lib/catalogImport/verifyD1';
import { INDEX_STAMP } from '../worker/lib/search/store';
import { sample } from './fixtures/bambu/load';
import { isV2Published, publishV2 } from './fixtures/v2Publish';

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

/** One mutation of D1, checked, then rolled back (the checks only read). */
async function failedUnder(w: World, item: string, mutate: () => void): Promise<string[]> {
  w.raw.exec('SAVEPOINT verify');
  try {
    mutate();
    return (await check(w, item)).failed;
  } finally {
    w.raw.exec('ROLLBACK TO verify');
    w.raw.exec('RELEASE verify');
  }
}

test('the checks no other test breaks: an extra membership, the root membership, a lost title token, the source row, SELLABLE', async () => {
  const { w, s, pid } = await written('ams-2-pro-feeder-unit');
  assert.deepEqual((await check(w, s.itemId)).failed, []);
  const product = w.raw.prepare('SELECT name, category_id FROM products WHERE id = ?').get(pid) as { name: string; category_id: string };
  // A membership the map does not give (a created product is in exactly its sections).
  const other = (w.raw.prepare('SELECT id FROM catalogs WHERE id NOT IN (SELECT catalog_id FROM product_catalogs WHERE product_id = ?) LIMIT 1').get(pid) as { id: string }).id;
  assert.deepEqual(await failedUnder(w, s.itemId, () => w.raw.prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, 99)').run(pid, other)), ['memberships']);
  // The root section's own membership.
  const root = await failedUnder(w, s.itemId, () => w.raw.prepare('DELETE FROM product_catalogs WHERE product_id = ? AND catalog_id = ?').run(pid, product.category_id));
  assert.ok(root.includes('taxonomy') && root.includes('memberships'), JSON.stringify(root));
  // One token of the title (the stamp kept).
  const token = (w.raw.prepare('SELECT token FROM search_tokens WHERE product_id = ? AND token <> ? ORDER BY token LIMIT 1').get(pid, INDEX_STAMP) as { token: string }).token;
  assert.deepEqual(await failedUnder(w, s.itemId, () => w.raw.prepare('DELETE FROM search_tokens WHERE product_id = ? AND token <> ?').run(pid, INDEX_STAMP)), ['search_tokens']);
  assert.ok(token);
  // The source row says merged (0194 then requires the not_required decision).
  const source = await failedUnder(w, s.itemId, () => w.raw.prepare("UPDATE product_source_refs SET match_kind = 'merged', stock_decision = 'not_required' WHERE product_id = ?").run(pid));
  assert.ok(source.includes('source_ref'), JSON.stringify(source));
  // SELLABLE: a stock decision taken, then a V2 price published — a created product must stay catalog-only.
  w.raw.prepare("UPDATE product_source_refs SET stock_decision = 'untracked', stock_decided_by = 'usr', stock_decided_at = 't' WHERE product_id = ?").run(pid);
  await publishV2(w.raw, pid);
  assert.ok(isV2Published(w.raw, pid));
  const sellable = await check(w, s.itemId);
  assert.ok(sellable.failed.includes('not_sellable') && sellable.checks.visible === true, JSON.stringify(sellable.failed));
});

test('a merged item: the merge branches — the kept stock decision, an already-priced product eligible, only the imported images counted', async () => {
  const w = newWorld();
  const x = sample('a1');
  w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images)
    VALUES ('p_a1m', 'bambu-a1-m', 'Bambu Lab A1', 'بامبو A1', 'بامبو A1', 'active', 0, 'cat_printers', '[]', '[]', '[]')`);
  w.raw.exec("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1m', 'cat_printers', 1)");
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_a1m', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' });
  await write(w, s);
  w.raw.prepare("UPDATE product_source_refs SET stock_decision = 'not_required' WHERE product_id = 'p_a1m'").run();
  await publishV2(w.raw, 'p_a1m');
  const r = await check(w, s.itemId);
  assert.deepEqual(r.failed, [], 'a merged, priced product passes');
  assert.equal(r.checks.not_sellable, null, 'a merge keeps its own V2 state');
  assert.equal(r.checks.stock_decision, true);
  assert.equal(r.checks.price_request, true, 'PRICE_REQUEST_ALREADY_PRICED is the right answer for a priced merge');
  // The owner's own picture is not one the write recorded.
  assert.deepEqual(
    await failedUnder(w, s.itemId, () =>
      w.raw.exec("INSERT INTO product_images (id, product_id, url, r2_key, content_type, width, height, bytes, sort_order, is_primary) VALUES ('img_owner2', 'p_a1m', '/files/products/o.webp', 'products/o.webp', 'image/webp', 1, 1, 1, 99, 0)")
    ),
    [],
    'counted and HEADed only through the import\'s own image refs (the owner\'s picture is neither)'
  );
  // The source row of a merge that says created.
  assert.deepEqual(await failedUnder(w, s.itemId, () => w.raw.prepare("UPDATE product_source_refs SET match_kind = 'created' WHERE product_id = 'p_a1m'").run()), ['source_ref']);
  // No source row at all: no 'not_required' decision on record either.
  const gone = await failedUnder(w, s.itemId, () => w.raw.prepare("DELETE FROM product_source_refs WHERE product_id = 'p_a1m'").run());
  assert.ok(gone.includes('stock_decision') && gone.includes('source_ref'), JSON.stringify(gone));
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

test('review 6b: the placement is the manifest row\'s reviewed one (not the stored source_route); a swatch of another product\'s value fails', async () => {
  const { w, s, pid } = await written('pla-basic-filament');
  assert.deepEqual((await check(w, s.itemId)).failed, []);
  // The stored source_route says another section: the recompute still resolves the manifest row's own route.
  assert.deepEqual(await failedUnder(w, s.itemId, () => w.raw.prepare("UPDATE product_source_refs SET source_route = '552709755391528960>552709755467026432>552709755534135296' WHERE product_id = ?").run(pid)), []);
  // The product moved to a section the manifest row was not reviewed for: the recompute sees it.
  const moved = await failedUnder(w, s.itemId, () => w.raw.prepare("UPDATE products SET sub_category_id = 'cat_printers_fdm' WHERE id = ?").run(pid));
  assert.ok(moved.includes('taxonomy'), JSON.stringify(moved));
  // A swatch row credited to this product for a value it does not own (§I.1.6).
  const foreign = await failedUnder(w, s.itemId, () =>
    w.raw.prepare("INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key) VALUES ('ov_of_another_product', ?, '/files/x.webp', 'x.webp')").run(pid)
  );
  assert.ok(foreign.includes('swatches_own'), JSON.stringify(foreign));
});
