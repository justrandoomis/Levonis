/**
 * Q2 — THE BUDGET IS PRIVATE BY DEFAULT (plan P1-06, acceptance 34; owner
 * answer Q2; docs/DECISIONS.md rows 262, 266 (٧), 268;
 * worker/lib/requestBudget.ts).
 *
 * With the switch OFF (the default, and every request that existed before
 * it): nobody but the customer and an admin reads the budget — not the board,
 * the community list, the request page of a guest, a member or an eligible
 * workshop, not the workshop's board or «طلبات تناسبك», not the match
 * notification, not the revisions, not the merchant's copy of an accepted
 * order (whose stored snapshot keeps it).
 *
 * With «اعرض ميزانيتي للتجار» ON: the merchants the request is meant for read
 * it — the eligible workshop on its boards, its notification and the request
 * page, a merchant who offered on the revisions, the accepted merchant on the
 * order — and still never the public board, a guest or a stranger.
 *
 * A database without the column (before 0208) reads it hidden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, type Mount, type StubUser } from './fixtures/app';
import { fund, newDraft, offerOn, world, PLA } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { communityRoutes } from '../worker/routes/community';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { budgetFor, stripSpecBudget } from '../worker/lib/requestBudget';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
};
const user = (id: string, role: 'customer' | 'admin' = 'customer'): StubUser => ({ id, role, email: `${id}@x.co` });
const app = (raw: DatabaseSync, u: StubUser | null) => stubApp(asD1(raw), u, mount);
const read = async (raw: DatabaseSync, u: StubUser | null, path: string) => {
  const res = await get(app(raw, u), path);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return json(res);
};

/** A published PLA job with a budget of 25 000, the switch as given. */
async function job(raw: DatabaseSync, visible: boolean): Promise<string> {
  const id = await newDraft(raw, { budget_iqd: 25000 });
  const res = await post(app(raw, user('buyer')), `/api/marketplace/print/requests/${id}/publish`, { ...PLA, budget_iqd: 25000, budget_visible: visible });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return id;
}

const budgetOn = (rows: unknown, id: string) => ((rows as Array<{ id: string; budget_iqd: unknown }>).find((r) => r.id === id) ?? { budget_iqd: 'absent' }).budget_iqd;
const told = (raw: DatabaseSync, id: string) =>
  row<{ body_ar: string; body_en: string }>(raw, `SELECT body_ar, body_en FROM user_notifications WHERE user_id = 'owner' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`, id);

test('the rule itself: owner and admin always, a merchant only with the switch, nobody else ever', () => {
  assert.equal(budgetFor(25000, 0, 'owner'), 25000);
  assert.equal(budgetFor(25000, 0, 'admin'), 25000);
  assert.equal(budgetFor(25000, 0, 'merchant'), null);
  assert.equal(budgetFor(25000, 1, 'merchant'), 25000);
  assert.equal(budgetFor(25000, 1, 'public'), null);
  assert.equal(budgetFor(25000, undefined, 'merchant'), null, 'a row without the column reads hidden');
  assert.equal(budgetFor(null, 1, 'owner'), null);
  const spec = { title: 't', budget_iqd: 25000 };
  assert.deepEqual(stripSpecBudget(spec, 0, 'merchant'), { title: 't', budget_iqd: null });
  assert.equal(stripSpecBudget(spec, 1, 'merchant'), spec, 'unchanged when it may be seen');
  assert.equal(spec.budget_iqd, 25000, 'the stored object is never rewritten');
});

test('switch off (the default): the customer and an admin read the budget, and no other reader does', async () => {
  const raw = world();
  const id = await job(raw, false);
  // The public board and list, to anyone.
  for (const u of [null, user('stranger'), user('owner')]) {
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), null, 'board');
    assert.equal(budgetOn((await read(raw, u, '/api/community/requests')).requests, id), null, 'community list');
    assert.equal((await read(raw, u, `/api/marketplace/requests/${id}`)).request.budget_iqd, null, `request page (${u?.id ?? 'guest'})`);
  }
  // The eligible workshop: its boards, its notification, the revisions.
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/merchant/workshop/board')).requests, id), null, 'workshop board');
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/community/requests?for=me')).requests, id), null, '«طلبات تناسبك»');
  const note = told(raw, id);
  assert.ok(note, 'the eligible workshop was told');
  assert.ok(!/25[,.٬]?000|budget|الميزانية/.test(`${note!.body_ar} ${note!.body_en}`), 'the notification says no budget');
  const revs = await read(raw, user('owner'), `/api/marketplace/print/requests/${id}/revisions`);
  assert.ok((revs.revisions as Array<{ spec: Record<string, unknown> }>).every((r) => r.spec.budget_iqd === null), 'revisions');
  // Its owners.
  assert.equal((await read(raw, user('buyer'), `/api/marketplace/requests/${id}`)).request.budget_iqd, 25000);
  assert.equal((await read(raw, user('admin1', 'admin'), `/api/marketplace/requests/${id}`)).request.budget_iqd, 25000);
  assert.equal((await read(raw, user('buyer'), `/api/marketplace/print/requests/${id}/draft`)).draft.budget_iqd, 25000);
  const ownRevs = await read(raw, user('buyer'), `/api/marketplace/print/requests/${id}/revisions`);
  assert.equal((ownRevs.revisions as Array<{ spec: Record<string, unknown> }>)[0].spec.budget_iqd, 25000);
});

test('switch on: the merchants the request is meant for read it — never the board, a guest or a stranger', async () => {
  const raw = world();
  const id = await job(raw, true);
  for (const u of [null, user('stranger')]) {
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), null);
    assert.equal(budgetOn((await read(raw, u, '/api/community/requests')).requests, id), null);
    assert.equal((await read(raw, u, `/api/marketplace/requests/${id}`)).request.budget_iqd, null, `request page (${u?.id ?? 'guest'})`);
  }
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/marketplace/requests')).requests, id), null, 'the public board, even to an eligible workshop');
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/merchant/workshop/board')).requests, id), 25000, 'workshop board');
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/community/requests?for=me')).requests, id), 25000, '«طلبات تناسبك»');
  assert.equal((await read(raw, user('owner'), `/api/marketplace/requests/${id}`)).request.budget_iqd, 25000, 'the request page of an eligible workshop');
  assert.equal((await read(raw, user('owner2'), `/api/marketplace/requests/${id}`)).request.budget_iqd, null, 'a resin workshop the job is not for');
  const note = told(raw, id);
  assert.ok(note && /25[,.٬]000/.test(`${note.body_ar} ${note.body_en}`), 'the notification names it');
  // A merchant who offered reads it on the revisions; a stranger does not.
  await offerOn(raw, id);
  const revs = await read(raw, user('owner'), `/api/marketplace/print/requests/${id}/revisions`);
  assert.equal((revs.revisions as Array<{ spec: Record<string, unknown> }>)[0].spec.budget_iqd, 25000);
  const theirs = await read(raw, user('stranger'), `/api/marketplace/print/requests/${id}/revisions`);
  assert.ok((theirs.revisions as Array<{ spec: Record<string, unknown> }>).every((r) => r.spec.budget_iqd === null));
});

test('the accepted order: the stored snapshot keeps the budget; the merchant reads it only with the switch', async () => {
  for (const visible of [false, true]) {
    const raw = world();
    const id = await job(raw, visible);
    const offer = await offerOn(raw, id, 20000);
    fund(raw, 'buyer', 60000);
    const accepted = await post(app(raw, user('buyer')), `/api/marketplace/offers/${offer.id}/accept`, { expected_total_iqd: 20000, offer_revision: offer.revision });
    const body = await json(accepted);
    assert.equal(accepted.status, 201, JSON.stringify(body));
    const orderId = String(body.order?.id ?? '');
    assert.ok(orderId);
    const stored = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders WHERE id = ?', orderId)!.request_snapshot);
    assert.equal(stored.spec.budget_iqd, 25000, 'the stored snapshot keeps it: never rewritten');
    const mine = await read(raw, user('buyer'), `/api/marketplace/orders/${orderId}`);
    const theirs = await read(raw, user('owner'), `/api/marketplace/orders/${orderId}`);
    assert.equal(mine.order.request_snapshot.spec.budget_iqd, 25000, 'the customer');
    assert.equal(theirs.order.request_snapshot.spec.budget_iqd, visible ? 25000 : null, `the merchant, switch ${visible ? 'on' : 'off'}`);
  }
});

test('a database before 0208 has no switch: the budget reads hidden to every merchant reader', async () => {
  const raw = world('0207');
  const id = await newDraft(raw, { budget_iqd: 25000 });
  const res = await post(app(raw, user('buyer')), `/api/marketplace/print/requests/${id}/publish`, { ...PLA, budget_iqd: 25000 });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal(budgetOn((await read(raw, user('owner'), '/api/merchant/workshop/board')).requests, id), null);
  assert.equal((await read(raw, user('owner'), `/api/marketplace/requests/${id}`)).request.budget_iqd, null);
  assert.equal((await read(raw, user('buyer'), `/api/marketplace/requests/${id}`)).request.budget_iqd, 25000);
});
