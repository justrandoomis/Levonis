/**
 * D1 — A CONFIRMED STOCK PURCHASE BECOMES THE CURRENT COST AFTER THE OWNER
 * REVIEWS THE PRICE CHANGE (spec addendum A.10, A.12.4; DECISIONS rows 221
 * D1 and 222).
 *
 *   - confirming a purchase writes exactly one pending review per product
 *     (a second confirm supersedes it) and moves no price and no input;
 *   - the receive works with a review pending;
 *   - the review is owner-only (COST_ACCESS_DENIED for everyone else, the
 *     same body for a real and an invented id);
 *   - preview → apply is one V2 batch that writes the purchase's inputs and
 *     marks the review applied; a replay is `already`; dismiss is audited;
 *   - a product still in «يحتاج تسعيرًا»: the pending review is folded into
 *     the OWNER's prefill (never an editor's), and the owner's first complete
 *     write applies it in the same batch;
 *   - the purchase document names the products whose review waits (ids and
 *     states only, never a figure).
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2PurchaseReview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { AMS, OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { publishV2 } from './fixtures/v2Publish';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';

/** `row` for a row the test itself just wrote (never absent). */
const one = <T = Record<string, unknown>>(...a: Parameters<typeof row>): T => row<T>(...a)!;

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };

const reviews = (w: ReturnType<typeof pricingWorld>) =>
  w.raw.prepare('SELECT id, product_id, purchase_id, state, inputs_json FROM pricing_v2_purchase_reviews ORDER BY created_at, id').all() as Array<{
    id: string;
    product_id: string;
    purchase_id: string;
    state: string;
    inputs_json: string;
  }>;

test('confirming a purchase writes one pending review per product, moves nothing, and a second confirm supersedes it', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const pricesBefore = w.raw.prepare('SELECT * FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel').all(AMS);
  const inputsBefore = w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ?').get(AMS) as { n: number };
  const first = await w.save(w.draft());
  const list = reviews(w);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.product_id, AMS);
  assert.equal(list[0]!.purchase_id, first);
  assert.equal(list[0]!.state, 'pending');
  const inputs = JSON.parse(list[0]!.inputs_json) as Array<{ set: Record<string, unknown> }>;
  assert.ok(inputs.length > 0 && inputs.some((i) => i.set.supplier_cost_amount !== undefined), 'the supplier cost the purchase implies');
  assert.deepEqual(w.raw.prepare('SELECT * FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel').all(AMS), pricesBefore, 'no price moved');
  assert.equal((w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ?').get(AMS) as { n: number }).n, inputsBefore.n, 'no input moved');
  // The receive is independent of the review.
  const received = await w.receive(first, `op_${'r'.repeat(12)}`);
  assert.equal(received.status, 200, JSON.stringify(received.body).slice(0, 200));
  await w.save(w.draft());
  const after = reviews(w);
  assert.deepEqual(after.map((r) => r.state), ['superseded', 'pending']);
});

test('the review is the owner’s: everyone else gets COST_ACCESS_DENIED, the same body for a real and an invented id', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  await w.save(w.draft());
  const id = reviews(w)[0]!.id;
  const editor = stubApp(w.db, EDITOR, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const bodies: string[] = [];
  for (const [method, path] of [
    ['GET', `/api/admin/products-v2/${AMS}/purchase-review`],
    ['POST', `/api/admin/products-v2/${AMS}/purchase-review/${id}/preview`],
    ['POST', `/api/admin/products-v2/${AMS}/purchase-review/pvr_invented/preview`],
    ['POST', `/api/admin/products-v2/${AMS}/purchase-review/${id}/apply`],
    ['POST', `/api/admin/products-v2/${AMS}/purchase-review/${id}/dismiss`],
  ] as const) {
    const res = method === 'GET' ? await get(editor, path) : await post(editor, path, {});
    assert.equal(res.status, 403, path);
    const body = await json(res);
    assert.equal(body.code, 'COST_ACCESS_DENIED', path);
    bodies.push(JSON.stringify(body));
  }
  assert.equal(new Set(bodies).size, 1, 'one refusal for every review door and id');
  assert.equal(reviews(w)[0]!.state, 'pending');
});

test('preview → apply is one V2 batch: the purchase’s inputs are written and the review is applied; a replay is `already`', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  await w.save(w.draft());
  const id = reviews(w)[0]!.id;
  const owner = stubApp(w.db, { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const read = await json(await get(owner, `/api/admin/products-v2/${AMS}/purchase-review`));
  assert.equal(read.purchase_review.id, id);
  const preview = await json(await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${id}/preview`, {}));
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 300));
  const hash = preview.preview.review_hash as string;
  assert.match(hash, /^[0-9a-f]{64}$/);
  // Without the hash the server answers with its sheet.
  const refused = await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${id}/apply`, {});
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'PRICING_PREVIEW_REQUIRED');
  const body = { preview_hash: hash, ...(preview.preview.large_change || preview.preview.drop_flag ? { confirm_large_change: true } : {}) };
  const applied = await json(await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${id}/apply`, body));
  assert.equal(applied.success, true, JSON.stringify(applied).slice(0, 300));
  assert.equal(reviews(w)[0]!.state, 'applied');
  const written = one<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND source_ref LIKE 'purchase:%'", AMS);
  assert.ok(written.n >= 1, 'the purchase’s cost inputs, with their source');
  const again = await json(await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${id}/apply`, body));
  assert.equal(again.already, true);
});

test('«أبقِ التكلفة الحالية»: dismiss marks the review dismissed, audited, and moves nothing', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  await w.save(w.draft());
  const id = reviews(w)[0]!.id;
  const owner = stubApp(w.db, { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const res = await json(await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${id}/dismiss`, {}));
  assert.equal(res.dismissed, true);
  assert.equal(reviews(w)[0]!.state, 'dismissed');
  assert.equal(one<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pricing.v2.purchase_review_dismissed'").n, 1);
  // A decided review is immutable.
  assert.throws(() => w.raw.prepare("UPDATE pricing_v2_purchase_reviews SET state = 'pending', decided_at = NULL WHERE id = ?").run(id));
});

test('a needs-pricing product: the review is folded into the OWNER’s prefill (never an editor’s) and the first complete write applies it', async () => {
  const w = pricingWorld();
  // AMS is not published: it is «يحتاج تسعيرًا» (no method).
  const purchase = await w.save(w.draft());
  const review = reviews(w)[0]!;
  assert.equal(review.state, 'pending');
  const writes = JSON.parse(review.inputs_json) as Array<{ scope: string; scope_id: string; set: Record<string, unknown> }>;
  const routes = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => a.route('/api/admin/products-v2', adminProductsRoutes);
  const owner = stubApp(w.db, OWNER_USER, routes, { publishV2: false });
  // The review's own doors answer that the product is priced from its form.
  const direct = await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${review.id}/preview`, {});
  assert.equal(direct.status, 409);
  assert.equal((await json(direct)).code, 'PRICING_V2_NEEDS_PRICING');
  // The owner's prefill carries the review's cost inputs and names it.
  const read = await json(await get(owner, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(read.v2_cost_inputs.purchase_review_id, review.id);
  const shown = read.v2_cost_inputs.inputs as Array<Record<string, unknown>>;
  let compared = 0;
  for (const wr of writes) {
    const at = shown.find((r) => r.scope === wr.scope && (wr.scope === 'base' || r.scope_id === wr.scope_id));
    assert.ok(at, `the prefill has the review's ${wr.scope} row`);
    for (const [k, v] of Object.entries(wr.set)) {
      if (!(k in at!)) continue;
      assert.equal(String(at![k]), String(v), `${wr.scope}.${k} comes from the purchase`);
      compared += 1;
    }
  }
  assert.ok(compared > 0, 'at least one purchase field is compared');
  // An editor's answer never names the review nor carries a cost.
  const editor = stubApp(w.db, EDITOR, routes, { publishV2: false });
  const er = await get(editor, `/api/admin/products-v2/${AMS}/pricing`);
  const text = await er.text();
  assert.equal(er.status, 200, text.slice(0, 200));
  assert.equal(text.includes(review.id), false, 'the editor never reads the review');
  assert.equal(text.includes('v2_cost_inputs'), false);
  // The owner's first complete write applies it in the same batch.
  const pricing = { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }] };
  const pre = await json(await post(owner, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing }));
  assert.equal(pre.publishable, true, JSON.stringify(pre.codes));
  const res = await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: pre.seq, pricing, preview_hash: pre.review_hash });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  assert.equal(reviews(w)[0]!.state, 'applied');
  const written = one<{ n: number }>(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND source_ref = ?', AMS, `purchase:${purchase}`);
  assert.ok(written.n >= 1, 'the purchase’s inputs are the product’s current cost, with their source');
});

test('an editor’s first write of a needs-pricing product leaves the review pending (the owner decides it from the priced product)', async () => {
  const w = pricingWorld();
  await w.save(w.draft());
  const review = reviews(w)[0]!;
  const editor = stubApp(w.db, EDITOR, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const pricing = { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }] };
  const pre = await json(await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing }));
  const res = await put(editor, `/api/admin/products-v2/${AMS}/pricing`, { seq: pre.seq, pricing, preview_hash: pre.review_hash });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 400));
  assert.equal(reviews(w).find((r) => r.id === review.id)!.state, 'pending');
  assert.equal(one<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND source_ref LIKE 'purchase:%'", AMS).n, 0, 'no purchase cost written by an editor');
  // Now priced, the owner reviews it through the review's own doors.
  const owner = stubApp(w.db, OWNER_USER, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const preview = await json(await post(owner, `/api/admin/products-v2/${AMS}/purchase-review/${review.id}/preview`, {}));
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 300));
});

test('the purchase document names the products whose review waits — ids and states only', async () => {
  const w = pricingWorld();
  const purchase = await w.save(w.draft());
  const owner = stubApp(w.db, OWNER_USER, (a) => a.route('/api/admin/procurement', adminProcurementRoutes), { publishV2: false });
  const doc = await json(await get(owner, `/api/admin/procurement/documents/${purchase}`));
  assert.deepEqual(doc.price_reviews, [{ product_id: AMS, state: 'pending' }]);
});

test('a manual purchase (no supplier route) in a supplier currency writes a review too; an IQD purchase writes none', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const manual = { cost_profile_id: undefined, cost_profile_version: undefined, shipping_rate_iqd: undefined };
  await w.save(w.draft({ ...manual, currency: 'USD', exchange_rate: 1600 }));
  const list = reviews(w);
  assert.equal(list.length, 1, 'the procurement screen has no per-line tick any more: every supplier-currency line counts');
  const inputs = JSON.parse(list[0]!.inputs_json) as Array<{ set: Record<string, unknown> }>;
  assert.ok(inputs.some((i) => i.set.supplier_cost_amount === '450' && i.set.supplier_cost_currency === 'USD'), JSON.stringify(inputs));
  await w.save(w.draft({ ...manual, currency: 'IQD', exchange_rate: 1 }));
  assert.deepEqual(reviews(w).map((r) => r.state), ['pending'], 'a dinar purchase names no supplier currency: no review, the pending one stays');
});
