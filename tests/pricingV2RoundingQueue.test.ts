/**
 * EXISTING PRICES MOVE TO THE NEW ROUNDING ONCE, AND THE OWNER SEES THEM FIRST (DECISIONS row 245).
 *
 * A price published under the old 1,000 step (1,600,112 → 1,601,000) is not rewritten by the
 * deploy, by migration 0199 or by the quarter-hour repricing: customers keep paying it until the
 * owner re-publishes the product through the review sheet («راجع الأسعار التي ستتغيّر»), which
 * shows it old → new (1,601,000 → 1,600,250) before anything is written. The owner finds those
 * products in the queue's «بانتظار التقريب الجديد» filter; once re-published, a product leaves it.
 * Idempotent by construction: the filter writes nothing, and a product already on the rule is
 * never listed.
 *
 * Run: node --import tsx --test tests/pricingV2RoundingQueue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json, put, withoutTriggers, type StubUser } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { cartGrid, v2App, writeV2 } from './fixtures/pricingV2';
import { loadStoredV2Results, staleReasonsV2 } from '../worker/lib/pricingEngine/v2/stale';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { NEEDS_PRICING } from '../src/components/adminProducts/needsPricingStrings';

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
const MODEL = `${AMS}_o0`;
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const point = (usd: string) => ({ scope: 'product', id: '', kind: 'fixed', usd });
const answer = async (res: Response) => ({ status: res.status, body: await json(res) });

/** A price as the 1,000 step published it, staged under the engine's own guards (lifted for this SQL only). */
function publishedUnderTheOldStep(raw: DatabaseSync, pid: string, oldIqd: number): void {
  const guards = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('pricing_v2_sku_results', 'product_sku_prices')").all() as Array<{ name: string }>
  ).map((t) => t.name);
  withoutTriggers(
    raw,
    guards,
    `UPDATE pricing_v2_sku_results SET final_price_iqd = ${oldIqd}, direct_price_iqd = ${oldIqd} WHERE product_id = '${pid}';
     UPDATE product_sku_prices SET regular_price_iqd = ${oldIqd} WHERE product_id = '${pid}';`
  );
}

async function world() {
  const w = pricingWorld();
  // $1,000.07 × 1,600 = 1,600,112: the 1,000 step published 1,601,000, the rule gives 1,600,250.
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000.07')] });
  publishedUnderTheOldStep(w.raw, AMS, 1_601_000);
  return w;
}

test('a price of the old step keeps selling, is listed for the owner only, and no automatic repricing touches it', async () => {
  const w = await world();
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_601_000, 'customers still pay the published price');

  const owner = v2App(w.raw);
  const listed = await json(await get(owner, '/api/admin/products-v2/needs-pricing?filter=rounding&page=1'));
  assert.equal(listed.filter, 'rounding');
  const products = listed.products as Array<{ id: string; rounding_pending?: boolean; state: string }>;
  assert.deepEqual(products.map((p) => p.id), [AMS]);
  assert.equal(products[0]!.rounding_pending, true);
  assert.equal(products[0]!.state, 'published');
  assert.deepEqual(listed.counts, { rounding: 1 }, 'the other lists were not read here: no count is said for them');
  // The needs-pricing list itself is unchanged: a published product is not in it.
  const all = await json(await get(owner, '/api/admin/products-v2/needs-pricing?filter=all&page=1'));
  assert.ok(!(all.products as Array<{ id: string }>).some((p) => p.id === AMS));
  assert.equal((all.counts as Record<string, number>).rounding, 1, 'the chip says how many wait, from every list');

  // A price editor: the filter is the owner's (it falls back to «all»), and no count of it.
  const editor = await json(await get(v2App(w.raw, EDITOR), '/api/admin/products-v2/needs-pricing?filter=rounding&page=1'));
  assert.equal(editor.filter, 'all');
  assert.equal('rounding' in (editor.counts as Record<string, number>), false);

  // The quarter-hour repricing reads only rate moves: nothing here is stale, so nothing is rewritten silently.
  const rows = await loadStoredV2Results(w.db, [AMS]);
  const rates = await loadPricingRates(w.db);
  assert.deepEqual(staleReasonsV2(rows, rates!), []);
});

test('re-publishing goes through the review sheet: old → new first, then the new price, and the product leaves the list', async () => {
  const w = await world();
  const owner = v2App(w.raw);
  const read = await answer(await get(owner, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(read.status, 200);
  const pricing = { points: [point('1000.07')] };

  // Saved as it stands, without the sheet's hash: the sheet first, never a silent write.
  const bare = await answer(await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: read.body.seq, pricing }));
  assert.equal(bare.status, 409, JSON.stringify(bare.body).slice(0, 300));
  assert.equal(bare.body.code, 'PRICING_PREVIEW_REQUIRED');
  const preview = bare.body.details.preview as { review_hash: string; changes: Array<{ channel: string; old_iqd: number; new_iqd: number }> };
  const direct = preview.changes.find((c) => c.channel === 'direct_sale');
  assert.deepEqual({ old: direct?.old_iqd, now: direct?.new_iqd }, { old: 1_601_000, now: 1_600_250 }, 'the sheet shows old → new');
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_601_000, 'nothing written yet');

  // The owner confirms the sheet.
  const ok = await answer(await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: read.body.seq, pricing, preview_hash: preview.review_hash }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_600_250, 'the rule’s price, after the owner saw it');

  const after = await json(await get(owner, '/api/admin/products-v2/needs-pricing?filter=rounding&page=1'));
  assert.deepEqual(after.products, []);
  assert.equal((after.counts as Record<string, number>).rounding, 0);
  // From any other list, the owner still sees how many wait (one COUNT, row 245).
  const fromAll = await json(await get(owner, '/api/admin/products-v2/needs-pricing?filter=all&page=1'));
  assert.equal((fromAll.counts as Record<string, number>).rounding, 0);

  // Once on the rule, a save that moves nothing writes nothing.
  const again = await answer(await get(owner, `/api/admin/products-v2/${AMS}/pricing`));
  const noop = await answer(await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: again.body.seq, pricing }));
  assert.equal(noop.status, 200);
  assert.equal(noop.body.unchanged, true);
});

test('the filter\'s words: ar, en and real Sorani', () => {
  for (const t of [NEEDS_PRICING.filters.rounding, NEEDS_PRICING.roundingNote]) {
    assert.ok(t.ar && t.en && t.ckb);
    assert.notEqual(t.ckb, t.ar, 'the Sorani is never the Arabic');
    assert.match(t.ckb, /[ڕۆێڵەچ]/, 'Sorani letters');
  }
  assert.match(NEEDS_PRICING.roundingNote.ar, /250/);
  assert.match(NEEDS_PRICING.roundingNote.en, /250/);
});
