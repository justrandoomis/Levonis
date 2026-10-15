/**
 * «طلب السعر» — THE CUSTOMER'S DOORS (DECISIONS rows 239 (4) and 240; spec
 * §4.3, §7.5; worker/routes/priceRequests.ts, migration 0193).
 *
 * On the catalog-only world (tests/fixtures/catalogOnly.ts): the H2D (two
 * models × two colours; White is sold with the Combo only, Red is retired,
 * an old model is merged away) and the Snapmaker U1 (no option at all) are
 * shown and unpriced; the A1 is priced. Proves:
 *   - signed out: 401 on every door, `private, no-store` on every answer;
 *   - ask, ask again (`repeat: true`, the click counter 2, still ONE person),
 *     my requests (no counter, no one else), notify me or not, withdraw, ask
 *     again (cycle 2, a new request time);
 *   - the selection is checked on the server: a required group or colour
 *     missing is SELECTION_REQUIRED; another product's value, a retired
 *     colour, a colour not sold with that model, a merged value, a made-up id
 *     are SELECTION_INVALID; a product with no option is the key '';
 *   - a priced product answers 409 ALREADY_PRICED; a hidden one, a draft and an
 *     invented id answer the same 404;
 *   - 50 open requests a person and 20 a product (PRICE_REQUEST_LIMIT), a
 *     repeat tap never refused for being one too many; the create bucket
 *     fires at 21 in 600 s;
 *   - the row count of every money and stock table is the same after.
 *
 * Run: node --import tsx --test tests/priceRequestsRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, json, patch, post, row, send, get, type App } from './fixtures/app';
import { P } from './fixtures/liveCatalog';
import { CAT, CAT_SEL, CUSTOMER_ROLES, catalogLeaks, catalogOnlyWorld, moneyCounts, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { rateLimitKey } from '../worker/lib/ratelimit';
import { PRICE_REQUEST_LIMITS } from '@levonis/contracts/priceRequests';

const CUSTOMER = CUSTOMER_ROLES.customer!;
const PRIME = CUSTOMER_ROLES.prime!;
const U1 = P.U1;

let shared: Promise<CatalogOnlyWorld> | null = null;
async function build(): Promise<CatalogOnlyWorld> {
  const w = await catalogOnlyWorld({ alsoUnpriced: [U1] });
  w.raw.exec(`
    -- White is sold with the Combo only; Red is retired; an old model is merged into the standard one.
    INSERT INTO product_color_option_links (color_id, option_value_id, group_id) VALUES ('${CAT_SEL.white}', '${CAT_SEL.combo}', 'g_cat_model');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES ('c_cat_red', '${CAT.id}', 'Red', 'أحمر', 'سوور', '#ff0000', 2, 0);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, merged_into)
      VALUES ('v_cat_old', '${CAT.id}', 'g_cat_model', 'H2D 2024', 'H2D 2024', 'H2D 2024', 2, 1, '${CAT_SEL.std}');
    -- Another product's value (a draft, so it is nobody's shelf).
    INSERT INTO products (id, slug, name, status, price_iqd) VALUES ('p_other', 'other-draft', 'Other', 'draft', 0);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_other', 'p_other', 'Size', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v_other', 'p_other', 'g_other', 'Big', 0, 1);
  `);
  return w;
}
const world = () => (shared ??= build());

const ask = (app: App, body: Record<string, unknown>) => post(app, '/api/price-requests', body);
const sel = (value: string, color: string) => ({ option_value_ids: [value], color_id: color });
const stats = (w: CatalogOnlyWorld, productId: string) =>
  row<{ requesters: number; selections: number; clicks: number; last_request_at: string }>(
    w.raw,
    'SELECT requesters, selections, clicks, last_request_at FROM product_price_request_stats WHERE product_id = ?',
    productId
  );
const mine = (w: CatalogOnlyWorld, user: string, productId: string, selection: string) =>
  row<Record<string, unknown>>(w.raw, 'SELECT * FROM product_price_requests WHERE user_id = ? AND product_id = ? AND selection = ?', user, productId, selection);

test('signed out: 401 on every door, never cacheable', async () => {
  const w = await world();
  const app = w.as(null);
  for (const res of [
    await ask(app, { product_id: CAT.id }),
    await get(app, '/api/price-requests/mine'),
    await patch(app, '/api/price-requests/prq_x', { notify: true }),
    await send(app, 'DELETE', '/api/price-requests/prq_x'),
  ]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(all(w.raw, 'SELECT id FROM product_price_requests').length, 0);
});

test('ask, ask again, read mine, notify, withdraw, ask again: one row per person and selection, the counts exact, no money table touched', async () => {
  const w = await world();
  const before = moneyCounts(w.raw);
  const app = w.as(CUSTOMER);
  const key = CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey);

  const first = await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.std, CAT_SEL.grey), notify: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  const a = await json(first);
  assert.equal(a.repeat, false);
  assert.deepEqual(Object.keys(a.request).sort(), ['id', 'notify', 'product_id', 'requested_at', 'selection', 'state']);
  assert.equal(a.request.selection, key);
  assert.equal(a.request.state, 'open');
  assert.equal(a.request.notify, true);
  assert.deepEqual(stats(w, CAT.id), { requesters: 1, selections: 1, clicks: 1, last_request_at: a.request.requested_at });

  // The repeat tap: the same row, the counter + 1, still one person; the request time does not move.
  const again = await json(await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.std, CAT_SEL.grey), notify: true }));
  assert.equal(again.repeat, true);
  assert.equal(again.request.id, a.request.id);
  assert.equal(again.request.requested_at, a.request.requested_at);
  const r1 = mine(w, CUSTOMER.id, CAT.id, key)!;
  assert.equal(r1.click_count, 2);
  assert.equal(r1.cycle, 1);
  assert.deepEqual(stats(w, CAT.id), { requesters: 1, selections: 1, clicks: 2, last_request_at: a.request.requested_at });

  // A second selection by the same person: still ONE requester for the product.
  const combo = await json(await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.combo, CAT_SEL.white) }));
  assert.equal(combo.request.notify, false, 'absent consent is "do not notify" (D10)');
  assert.equal(stats(w, CAT.id)!.requesters, 1);
  assert.equal(stats(w, CAT.id)!.selections, 2);

  // Another person on the same selection: two requesters.
  assert.equal((await ask(w.as(PRIME), { product_id: CAT.id, ...sel(CAT_SEL.std, CAT_SEL.grey), notify: true })).status, 200);
  assert.equal(stats(w, CAT.id)!.requesters, 2);

  // Mine: my rows only, no counter, no user id, no count.
  const list = await get(app, `/api/price-requests/mine?product_id=${CAT.id}`);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  const listBody = await json(list);
  assert.deepEqual(catalogLeaks(listBody), []);
  assert.equal(listBody.requests.length, 2);
  for (const r of listBody.requests as Array<Record<string, unknown>>) {
    assert.equal(r.product_slug, CAT.slug);
    for (const k of ['user_id', 'click_count', 'cycle', 'requesters', 'clicks']) assert.ok(!(k in r), k);
  }
  assert.ok(!JSON.stringify(listBody).includes(PRIME.id), 'never anyone else');
  assert.equal((await json(await get(w.as(PRIME), '/api/price-requests/mine'))).requests.length, 1);

  // Notify me — or not. Someone else's id answers like an unknown one.
  assert.equal((await patch(app, `/api/price-requests/${a.request.id}`, { notify: false })).status, 200);
  assert.equal(mine(w, CUSTOMER.id, CAT.id, key)!.notify, 0);
  assert.equal((await patch(w.as(PRIME), `/api/price-requests/${a.request.id}`, { notify: true })).status, 404);
  assert.equal((await patch(app, `/api/price-requests/${a.request.id}`, { notify: 'yes' })).status, 400);
  assert.equal(mine(w, CUSTOMER.id, CAT.id, key)!.notify, 0);

  // Withdraw: closed, the count drops; withdrawing again (or someone else's) is a 404.
  assert.equal((await send(w.as(PRIME), 'DELETE', `/api/price-requests/${a.request.id}`)).status, 404);
  const gone = await send(app, 'DELETE', `/api/price-requests/${a.request.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual((await json(gone)).request, { id: a.request.id, state: 'closed', close_reason: 'withdrawn' });
  const closed = mine(w, CUSTOMER.id, CAT.id, key)!;
  assert.equal(closed.state, 'closed');
  assert.equal(closed.close_reason, 'withdrawn');
  assert.ok(String(closed.closed_at) > '');
  assert.equal((await send(app, 'DELETE', `/api/price-requests/${a.request.id}`)).status, 404);
  assert.equal(stats(w, CAT.id)!.requesters, 2, 'the customer still holds the Combo request');
  assert.equal(stats(w, CAT.id)!.selections, 2, 'grey-standard is still open for the PRIME member');

  // Ask again: the same row reopens — cycle 2, a new request time, the close cleared.
  await new Promise((r) => setTimeout(r, 5));
  const reopened = await json(await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.std, CAT_SEL.grey), notify: true }));
  assert.equal(reopened.repeat, false);
  assert.equal(reopened.request.id, a.request.id);
  assert.ok(reopened.request.requested_at > a.request.requested_at);
  const r2 = mine(w, CUSTOMER.id, CAT.id, key)!;
  assert.equal(r2.state, 'open');
  assert.equal(r2.cycle, 2);
  assert.equal(r2.close_reason, '');
  assert.equal(r2.closed_at, '');
  assert.equal(r2.first_requested_at, a.request.requested_at, 'the first request time is kept');

  assert.deepEqual(moneyCounts(w.raw), before, 'no money or stock table changed');
});

test('the selection is checked on the server', async () => {
  const w = await world();
  const app = w.as(CUSTOMER_ROLES.pro);
  const code = async (body: Record<string, unknown>) => {
    const res = await ask(app, { product_id: CAT.id, ...body });
    const b = await json(res);
    return `${res.status} ${String(b.code ?? 'ok')}`;
  };
  assert.equal(await code({}), '400 PRICE_REQUEST_SELECTION_REQUIRED', 'nothing chosen');
  assert.equal(await code({ option_value_ids: [CAT_SEL.std] }), '400 PRICE_REQUEST_SELECTION_REQUIRED', 'the colour is missing');
  assert.equal(await code({ color_id: CAT_SEL.grey }), '400 PRICE_REQUEST_SELECTION_REQUIRED', 'the model is missing');
  assert.equal(await code(sel('v_other', CAT_SEL.grey)), '400 PRICE_REQUEST_SELECTION_INVALID', 'another product’s value');
  assert.equal(await code(sel('v_nope', CAT_SEL.grey)), '400 PRICE_REQUEST_SELECTION_INVALID', 'an invented value');
  assert.equal(await code(sel(CAT_SEL.std, 'c_cat_red')), '400 PRICE_REQUEST_SELECTION_INVALID', 'a retired colour');
  assert.equal(await code(sel(CAT_SEL.std, CAT_SEL.white)), '400 PRICE_REQUEST_SELECTION_INVALID', 'White is not sold with the standard model');
  assert.equal(await code(sel('v_cat_old', CAT_SEL.grey)), '400 PRICE_REQUEST_SELECTION_INVALID', 'a merged value');
  assert.equal(await code({ option_value_ids: [CAT_SEL.std, 7], color_id: CAT_SEL.grey }), '400 PRICE_REQUEST_SELECTION_INVALID', 'a non-text id');
  assert.equal(await code(sel(CAT_SEL.combo, CAT_SEL.white)), '200 ok');
  assert.equal(all(w.raw, "SELECT id FROM product_price_requests WHERE user_id = 'u_pro'").length, 1, 'refusals wrote nothing');

  // A product with no option at all: the product itself, key ''.
  const u1 = await json(await ask(app, { product_id: U1 }));
  assert.equal(u1.request.selection, '');
  // …and a selection sent for it is refused, never stored as something else.
  const stray = await ask(app, { product_id: U1, color_id: CAT_SEL.grey });
  assert.equal((await json(stray)).code, 'PRICE_REQUEST_SELECTION_INVALID');
});

test('priced, hidden, draft and invented products', async () => {
  const w = await world();
  const app = w.as(CUSTOMER_ROLES.pro);
  const priced = await ask(app, { product_id: P.A1 });
  assert.equal(priced.status, 409);
  const pb = await json(priced);
  assert.equal(pb.code, 'PRICE_REQUEST_ALREADY_PRICED');
  assert.match(pb.error, /صار له سعر/);
  // Held by the owner's switch for a catalogue gap (no picture): hidden, the same 404 as an invented id.
  w.raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
              VALUES ('${P.A2L}', 0, 1, '[{"c":"IMAGE","o":""}]', 1, '2026-10-15T00:00:00.000Z')`);
  for (const id of [P.A2L, 'p_other', 'prd_does_not_exist']) {
    const res = await ask(app, { product_id: id });
    assert.equal(res.status, 404, id);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(all(w.raw, `SELECT id FROM product_price_requests WHERE product_id IN ('${P.A1}', '${P.A2L}', 'p_other')`).length, 0);
});

test('caps: 50 open a person, 20 open selections a person on one product; a repeat tap is never one too many', async () => {
  const w = await world();
  const app = w.as(PRIME);
  const now = new Date().toISOString();
  const insert = w.raw.prepare(
    `INSERT INTO product_price_requests (id, user_id, product_id, selection, requested_at, last_clicked_at, first_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // The PRIME member already holds grey-standard (above); 19 more open selections on the H2D make 20.
  const open = () => Number(row<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM product_price_requests WHERE user_id = ? AND product_id = ? AND state = 'open'", PRIME.id, CAT.id)!.n);
  for (let i = open(); i < PRICE_REQUEST_LIMITS.openPerProduct; i++) insert.run(`prq_cap_p${i}`, PRIME.id, CAT.id, `c:filler${i}`, now, now, now);
  assert.equal(open(), 20);
  const over = await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.combo, CAT_SEL.white) });
  assert.equal(over.status, 409);
  const ob = await json(over);
  assert.equal(ob.code, 'PRICE_REQUEST_LIMIT');
  assert.equal(ob.details.max_per_product, 20);
  assert.equal(open(), 20, 'nothing was written');
  // The one already open is a repeat tap, never refused.
  const repeat = await ask(app, { product_id: CAT.id, ...sel(CAT_SEL.std, CAT_SEL.grey) });
  assert.equal(repeat.status, 200);
  assert.equal((await json(repeat)).repeat, true);

  // 50 a person across the shop.
  const total = () => Number(row<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM product_price_requests WHERE user_id = ? AND state = 'open'", PRIME.id)!.n);
  const others = (all<{ id: string }>(w.raw, `SELECT id FROM products WHERE id NOT IN ('${CAT.id}', '${U1}') ORDER BY id`)).map((r) => r.id);
  let i = 0;
  while (total() < PRICE_REQUEST_LIMITS.openPerUser) {
    const pid = others[i % others.length]!;
    insert.run(`prq_cap_u${i}`, PRIME.id, pid, `c:filler${i}`, now, now, now);
    i++;
  }
  const full = await ask(app, { product_id: U1 });
  assert.equal(full.status, 409);
  assert.equal((await json(full)).details.max_open, 50);
  // Withdrawing one frees a place.
  const any = row<{ id: string }>(w.raw, "SELECT id FROM product_price_requests WHERE user_id = ? AND id LIKE 'prq_cap_u%' LIMIT 1", PRIME.id)!;
  assert.equal((await send(app, 'DELETE', `/api/price-requests/${any.id}`)).status, 200);
  assert.equal((await ask(app, { product_id: U1 })).status, 200);
});

test('the create bucket fires at 21 requests in 600 seconds', async () => {
  const w = await world();
  const app = w.as(CUSTOMER);
  const now = Math.floor(Date.now() / 1000);
  // 19 already spent in this window (the bucket's own key), then two more: the 20th passes, the 21st is refused.
  w.raw
    .prepare('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 19)')
    .run(rateLimitKey('price-request', CUSTOMER.id, '1.2.3.4'), now - (now % 600));
  assert.equal((await ask(app, { product_id: U1 })).status, 200);
  const refused = await ask(app, { product_id: U1 });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('cache-control'), 'private, no-store');
});
