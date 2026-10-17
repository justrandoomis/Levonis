/**
 * «طلبات السعر: 2» ON A PRODUCT ALREADY PRICED (the owner's report of
 * 2026-10-17: «فلمنت eSUN PLA+ — 1 كغم», active and sold at 26,000 د.ع, still
 * listed two price requests; DECISIONS row 240; worker/lib/priceRequestState.ts).
 *
 * The only door from `open` was the quarter-hour sweep; no pricing path moved a
 * request, and the chip counted every open row. Proves, on a colour product
 * like the owner's (three colours, catalog-only, two people asking):
 *   - the form's FIRST complete V2 write («اعتمد ونشر») moves the requests on
 *     in its own batch: `priced`, the stats recounted, the chip at 0 — and
 *     nobody is told by the write itself; the sweep then tells the one who
 *     asked to be told and closes the other;
 *   - the prices-only apply (PUT …/pricing) does the same;
 *   - a write that leaves the product unsellable (a draft, or held by the
 *     owner's switch) moves nothing and the chip keeps counting; the hold
 *     lifted, the chip drops at once (read from source) and the sweep tells;
 *   - a colour the write did not price keeps its request open and counted;
 *   - the rows left behind (requests of a product priced before this release)
 *     are repaired by the sweep's first statement, idempotently — a second
 *     pass changes nothing;
 *   - no notification ever names a product a customer could not buy.
 *
 * Run: node --import tsx --test tests/priceRequestsAnswered.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { Env } from '../worker/lib/types';
import { all, asD1, get, json, post, put, row, stubApp } from './fixtures/app';
import { discountWorld } from './fixtures/productDiscount';
import { countingD1 } from './fixtures/d1RoundTrips';

/** Production's statement limits on every read and write here (tests/fixtures/d1RoundTrips.ts). */
const limitD1 = (raw: DatabaseSync) => countingD1(raw).db;
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { statsRecompute, sweepPriceRequests, type PriceRequestBudget } from '../worker/lib/priceRequests';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co' };

const budget = (limit = 40): PriceRequestBudget => {
  let used = 0;
  return {
    canSpend: (n) => used + n <= limit,
    spend: (n) => (used + n > limit ? false : ((used += n), true)),
    remaining: () => limit - used,
  };
};

const envOf = (raw: DatabaseSync) => ({ DB: limitD1(raw), APP_ORIGIN: 'https://levonis-iq.com' }) as unknown as Env;

function admin(raw: DatabaseSync) {
  return stubApp(
    limitD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
    },
    { publishV2: false }
  );
}

/** Two people asking about `id`'s colours 0 and `second`: the first to be told, the second not. */
async function ask(raw: DatabaseSync, id: string, second = 'c1'): Promise<void> {
  raw.exec(`INSERT OR IGNORE INTO users (id, name, email, password_hash, role) VALUES
    ('u_ask1', 'Ask One', 'ask1@x.co', 'h', 'customer'), ('u_ask2', 'Ask Two', 'ask2@x.co', 'h', 'customer')`);
  raw.exec(`INSERT INTO product_price_requests (id, user_id, product_id, selection, notify) VALUES
    ('prq_${id}_1', 'u_ask1', '${id}', 'c:${id}_c0', 1),
    ('prq_${id}_2', 'u_ask2', '${id}', 'c:${id}_${second}', 0)`);
  const db = asD1(raw);
  await db.batch([statsRecompute(db, id, new Date().toISOString())]);
}

/** A catalog-only colour product (the owner's filament: three colours) with two people asking. */
async function filament(raw: DatabaseSync, id: string, second = 'c1'): Promise<void> {
  seedOptionless(raw, id, { colours: 3, routes: ['land'] });
  await ask(raw, id, second);
}

const states = (raw: DatabaseSync, id: string) =>
  Object.fromEntries(all<{ user_id: string; state: string }>(raw, 'SELECT user_id, state FROM product_price_requests WHERE product_id = ? ORDER BY user_id', id).map((r) => [r.user_id, r.state]));
const requesters = (raw: DatabaseSync, id: string) => Number(row<{ n: number }>(raw, 'SELECT requesters AS n FROM product_price_request_stats WHERE product_id = ?', id)?.n ?? -1);
const told = (raw: DatabaseSync, id: string) =>
  all<{ user_id: string }>(raw, "SELECT user_id FROM user_notifications WHERE kind = 'price_available' AND entity_id = ? ORDER BY user_id", id).map((r) => r.user_id);

/** The admin list's «طلبات السعر» for `id` (the chip). */
async function chip(app: ReturnType<typeof admin>, id: string): Promise<number | null> {
  const body = await json(await get(app, '/api/admin/products-v2?sort=requests&limit=50'));
  assert.ok(Array.isArray(body.products), JSON.stringify(body).slice(0, 300));
  const item = (body.products as Array<{ id: string; price_requests: number | null }>).find((p) => p.id === id);
  assert.ok(item, `${id} is listed`);
  return item.price_requests;
}

const pricing = (usd: string) => ({ method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd }] });

/** The form's save with its prices: bare (409 + the sheet), then «اعتمد ونشر» with the sheet's hash. */
async function publishThroughForm(app: ReturnType<typeof admin>, id: string, block: Record<string, unknown>, status = 'active') {
  const doc = (await json(await get(app, `/api/admin/products-v2/${id}`))).product;
  const body = { ...doc, status, pricing_v2: block };
  const bare = await json(await post(app, '/api/admin/products-v2', body));
  assert.equal(bare.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(bare).slice(0, 300));
  const doc2 = (await json(await get(app, `/api/admin/products-v2/${id}`))).product;
  const res = await post(app, '/api/admin/products-v2', { ...doc2, status, pricing_v2: { ...block, preview_hash: bare.details.preview.review_hash, confirm_large_change: true } });
  const saved = await json(res);
  assert.equal(res.status, 200, JSON.stringify(saved).slice(0, 400));
  return saved;
}

test('the form’s first complete V2 write («اعتمد ونشر») moves the requests on in its batch; the chip drops; the sweep tells', async () => {
  const w = await discountWorld({ costFirst: false });
  const ID = 'p_esun';
  await filament(w.raw, ID);
  const app = admin(w.raw);
  assert.equal(await chip(app, ID), 2, 'two people wait on the owner');

  await publishThroughForm(app, ID, { pricing: pricing('17') });

  assert.deepEqual(states(w.raw, ID), { u_ask1: 'priced', u_ask2: 'priced' }, 'answered in the same batch as the prices');
  assert.equal(requesters(w.raw, ID), 0, 'the stats recounted with them');
  assert.equal(await chip(app, ID), 0, 'nothing waits on the owner any more');
  assert.deepEqual(told(w.raw, ID), [], 'the write tells nobody: the sweep does');

  const report = await sweepPriceRequests(envOf(w.raw), budget());
  assert.equal(report.notified, 1);
  assert.equal(report.closed, 1);
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'notified', u_ask2: 'closed' });
  assert.deepEqual(told(w.raw, ID), ['u_ask1'], 'the one who asked to be told');
});

test('the prices-only apply (PUT …/pricing) moves them on too', async () => {
  const w = await discountWorld({ costFirst: false });
  const ID = 'p_apply';
  await filament(w.raw, ID);
  const app = admin(w.raw);
  const bare = await json(await put(app, `/api/admin/products-v2/${ID}/pricing`, { seq: { inputs_seq: 0, write_seq: 0 }, pricing: pricing('20') }));
  assert.equal(bare.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(bare).slice(0, 300));
  const res = await put(app, `/api/admin/products-v2/${ID}/pricing`, {
    seq: { inputs_seq: 0, write_seq: 0 },
    pricing: pricing('20'),
    preview_hash: bare.details.preview.review_hash,
    confirm_large_change: true,
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 300));
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'priced', u_ask2: 'priced' });
  assert.equal(requesters(w.raw, ID), 0);
  assert.equal(await chip(app, ID), 0);
});

test('a write that leaves the product unsellable moves nothing; the hold lifted, the chip drops at once and the sweep tells', async () => {
  const w = await discountWorld({ costFirst: false });
  const ID = 'p_held';
  await filament(w.raw, ID);
  const app = admin(w.raw);
  // Held by the owner's switch for a gap (the completeness row the hook keeps), then priced.
  w.raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
              VALUES ('${ID}', 0, 1, '[{"c":"WEIGHT"}]', 1, '2026-10-17T00:00:00.000Z')`);
  await writeV2(w.db, ID, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '17' }] });
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'open', u_ask2: 'open' }, 'priced but not sellable: still waiting');
  assert.equal(await chip(app, ID), 2, 'and still counted');
  const held = await sweepPriceRequests(envOf(w.raw), budget());
  assert.equal(held.notified + held.closed + held.priced, 0);
  assert.deepEqual(told(w.raw, ID), [], 'never a price the customer cannot buy');

  w.raw.exec(`UPDATE product_completeness SET held = 0, complete = 1, missing_json = '[]', missing_count = 0 WHERE product_id = '${ID}'`);
  assert.equal(await chip(app, ID), 0, 'read from source: the chip is right before any sweep');
  const lifted = await sweepPriceRequests(envOf(w.raw), budget());
  assert.equal(lifted.notified, 1);
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'notified', u_ask2: 'closed' });
});

test('a draft priced through the form tells nobody and keeps its requests; a colour left unpriced keeps its own', async () => {
  const w = await discountWorld({ costFirst: false });
  const DRAFT = 'p_draft';
  await filament(w.raw, DRAFT);
  const app = admin(w.raw);
  await publishThroughForm(app, DRAFT, { pricing: pricing('17') }, 'draft');
  assert.deepEqual(states(w.raw, DRAFT), { u_ask1: 'open', u_ask2: 'open' }, 'a draft is not sellable');
  await sweepPriceRequests(envOf(w.raw), budget());
  assert.deepEqual(told(w.raw, DRAFT), []);

  // A selection the write does not price (here a colour no SKU carries any more) keeps its request waiting.
  const ID = 'p_part';
  await filament(w.raw, ID, 'gone');
  await publishThroughForm(app, ID, { pricing: pricing('17') });
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'priced', u_ask2: 'open' });
  assert.equal(requesters(w.raw, ID), 1);
  assert.equal(await chip(app, ID), 1, 'only the one still waiting');
});

test('the rows left behind: the sweep’s first statement repairs them, once', async () => {
  const w = await discountWorld({ costFirst: false });
  const ID = 'p_old';
  // Priced BEFORE the fix: the prices written, the requests (and their stats) left open.
  seedOptionless(w.raw, ID, { colours: 3, routes: ['land'] });
  await writeV2(w.db, ID, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '17' }] });
  await ask(w.raw, ID, 'c2');
  // …as the release before this one left them: open, and counted.
  w.raw.exec(`UPDATE product_price_requests SET state = 'open', priced_at = '' WHERE product_id = '${ID}'`);
  await w.db.batch([statsRecompute(w.db, ID, '2026-10-16T00:00:00.000Z')]);
  assert.equal(requesters(w.raw, ID), 2, 'the owner’s screen: «طلبات السعر: 2»');
  const app = admin(w.raw);
  assert.equal(await chip(app, ID), 0, 'the chip counts only what still needs the owner');

  // A pass with room for the repair only: the rows move on and the stats are recounted.
  const small = await sweepPriceRequests(envOf(w.raw), budget(5));
  assert.equal(small.statements, 5);
  assert.deepEqual(states(w.raw, ID), { u_ask1: 'priced', u_ask2: 'priced' });
  assert.equal(requesters(w.raw, ID), 0);

  const full = await sweepPriceRequests(envOf(w.raw), budget());
  assert.deepEqual([full.notified, full.closed], [1, 1]);
  const snapshot = () => JSON.stringify([all(w.raw, 'SELECT id, state FROM product_price_requests ORDER BY id'), all(w.raw, 'SELECT id FROM user_notifications ORDER BY id')]);
  const before = snapshot();
  const again = await sweepPriceRequests(envOf(w.raw), budget());
  assert.equal(again.notified + again.closed + again.priced + again.reopened, 0);
  assert.equal(snapshot(), before, 'idempotent');
});
