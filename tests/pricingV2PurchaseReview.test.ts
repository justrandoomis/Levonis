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
 *     marks the review applied; a replay is `already`; dismiss is audited.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2PurchaseReview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { publishV2 } from './fixtures/v2Publish';
import { adminProductsRoutes } from '../worker/routes/adminProducts';

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
