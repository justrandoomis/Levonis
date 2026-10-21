/**
 * «لهذا المتجر فقط» — A REQUEST FOR ONE STORE, FROM ITS PAGE (plan P1-06,
 * docs/DECISIONS.md row 268; worker/lib/directRequests.ts, migration 0151).
 *
 *   the entry makes a DIRECT draft addressed to the store, with no
 *   conversation: the store sees nothing — no thread in its inbox, not the
 *   request page, not its customer's name — until the draft is SENT;
 *   an idle entry is answered again rather than multiplied;
 *   the conversation's own rules: the customer's own store (OWN_REQUEST), a
 *   store not taking custom requests (STORE_NO_CUSTOM_REQUESTS), one not
 *   taking new work (MERCHANT_UNAVAILABLE), one the public may not see
 *   (STORE_UNAVAILABLE);
 *   the board's publish door refuses it (REQUEST_IS_DIRECT), and the send
 *   asks the publish door's questions (REQUEST_TITLE_REQUIRED) before any
 *   thread is opened;
 *   the send opens the thread and writes the card in one go; revision 1 is
 *   recorded with the model; a second send answers the same card; the budget
 *   follows Q2 on the request page and on the card; another store's offer is
 *   still refused by 0151.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, post, put, row, stubApp, type Mount } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { merchantInboxRoutes } from '../worker/routes/merchantInbox';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/merchant/inbox', merchantInboxRoutes);
};
const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);

async function enter(raw: DatabaseSync, merchant: string, user = 'buyer') {
  const res = await post(as(raw, user), '/api/marketplace/print/requests', { entry: { kind: 'store', merchant_id: merchant } });
  return { status: res.status, body: await json(res) };
}

test('the store entry makes a direct draft the store knows nothing of: no thread, no request page, no name', async () => {
  const raw = world();
  const born = await enter(raw, 'm1');
  assert.equal(born.status, 201, JSON.stringify(born.body));
  const id = born.body.request_id as string;
  const r = row<Record<string, unknown>>(raw, 'SELECT visibility, target_merchant_id, origin_chat_id, state, created_by FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual({ ...r }, { visibility: 'direct', target_merchant_id: 'm1', origin_chat_id: null, state: 'draft', created_by: 'customer' });
  assert.deepEqual(born.body.draft.direct, { merchant_id: 'm1', store_name: 'Ali 3D', store_slug: 'ali3d', chat_id: null });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 0, 'no conversation is opened by a visit');
  // The store: not its request page, not its inbox.
  const page = await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`);
  assert.equal(page.status, 404, 'a direct DRAFT is not its store’s to read');
  const inbox = await json(await get(as(raw, 'owner'), '/api/merchant/inbox'));
  assert.ok(!JSON.stringify(inbox).includes('Sara'), 'the customer’s name is nowhere in the store’s inbox');
  // Not on the board.
  const board = await json(await get(as(raw, 'stranger'), '/api/marketplace/requests'));
  assert.ok(!(board.requests as Array<{ id: string }>).some((x) => x.id === id));
  // An idle entry is answered again, not multiplied.
  const again = await enter(raw, 'm1');
  assert.equal(again.status, 200);
  assert.equal(again.body.request_id, id);
  assert.equal(again.body.replayed, true);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 1);
  // …but a draft the customer worked on is theirs: the next visit starts another.
  await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, { schema_version: 3, title: 'A bracket' });
  const third = await enter(raw, 'm1');
  assert.equal(third.status, 201);
  assert.notEqual(third.body.request_id, id);
});

test('the conversation’s rules: own store, no custom requests, no new work, a store the public may not see', async () => {
  const raw = world();
  const own = await enter(raw, 'm1', 'owner');
  assert.equal(own.status, 400);
  assert.equal(own.body.code, 'OWN_REQUEST');
  raw.prepare(`UPDATE merchant_stores SET accepts_custom_requests = 0 WHERE id = 's1'`).run();
  assert.equal((await enter(raw, 'm1')).body.code, 'STORE_NO_CUSTOM_REQUESTS');
  raw.prepare(`UPDATE merchant_stores SET accepts_custom_requests = 1, status = 'paused' WHERE id = 's1'`).run();
  assert.equal((await enter(raw, 'm1')).body.code, 'MERCHANT_UNAVAILABLE');
  raw.prepare(`UPDATE merchant_stores SET status = 'active' WHERE id = 's1'`).run();
  raw.prepare(`UPDATE community_merchants SET approved_at = NULL WHERE id = 'm1'`).run();
  const hidden = await enter(raw, 'm1');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, 'STORE_UNAVAILABLE');
  assert.equal((await enter(raw, 'nobody')).body.code, 'STORE_UNAVAILABLE');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id IN ('buyer','owner')`), 0);
});

test('a direct draft is sent, not published: the send asks the title first, then opens the thread with its card', async () => {
  const raw = world();
  const born = await enter(raw, 'm1');
  const id = born.body.request_id as string;
  const pub = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, { schema_version: 3, title: 'A bracket', description: 'A small bracket for a shelf' });
  assert.equal(pub.status, 409);
  assert.equal((await json(pub)).code, 'REQUEST_IS_DIRECT');
  // Born empty: the send refuses before any conversation exists.
  const early = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/send`);
  assert.equal(early.status, 400);
  assert.equal((await json(early)).code, 'REQUEST_TITLE_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 0);

  const saved = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    schema_version: 3,
    title: 'A shelf bracket',
    description: 'A small bracket for a wooden shelf, two of them',
    budget_iqd: 25000,
    budget_visible: false,
    parts: [{ process: 'fdm', quantity: 2, materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] }],
  });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())));
  const sent = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/send`);
  const body = await json(sent);
  assert.equal(sent.status, 201, JSON.stringify(body));
  const chatId = body.chat_id as string;
  const r = row<Record<string, unknown>>(raw, 'SELECT state, origin_chat_id FROM community_requests WHERE id = ?', id)!;
  assert.equal(r.state, 'open');
  assert.equal(r.origin_chat_id, chatId);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND card_type = 'print_request' AND card_ref = ?`, chatId, id), 1);
  const rev = row<{ spec: string }>(raw, 'SELECT spec FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!;
  assert.ok(rev.spec.includes('"model"'), 'revision 1 is recorded with the model');
  // A second send answers the same card.
  const twice = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/send`);
  assert.equal(twice.status, 200);
  assert.equal((await json(twice)).replayed, true);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM chat_messages WHERE card_ref = ?`, id), 1);

  // Q2: the store reads the request now, without the budget the customer kept private — on the page and on the card.
  const page = await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`));
  assert.equal(page.request.budget_iqd, null);
  assert.equal(page.request.customer_name, 'Sara', 'the store the request was sent to reads the customer’s name');
  const thread = await json(await get(as(raw, 'owner'), `/api/chats/${chatId}/messages`));
  const card = (thread.messages as Array<{ card: { type: string; original: Record<string, unknown> } | null }>).find((m) => m.card?.type === 'print_request')!;
  assert.equal(card.card!.original.budget_iqd, null, 'the stored card keeps it; the store reads it without');
  const mine = await json(await get(as(raw, 'buyer'), `/api/chats/${chatId}/messages`));
  const myCard = (mine.messages as Array<{ card: { type: string; original: Record<string, unknown> } | null }>).find((m) => m.card?.type === 'print_request')!;
  assert.equal(myCard.card!.original.budget_iqd, 25000, 'the customer reads their own');
  // The customer shows it: the store reads it, on both.
  raw.prepare('UPDATE community_requests SET budget_visible = 1 WHERE id = ?').run(id);
  assert.equal((await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`))).request.budget_iqd, 25000);
  const shown = await json(await get(as(raw, 'owner'), `/api/chats/${chatId}/messages`));
  assert.equal((shown.messages as Array<{ card: { type: string; original: Record<string, unknown> } | null }>).find((m) => m.card?.type === 'print_request')!.card!.original.budget_iqd, 25000);
  assert.ok(!JSON.stringify(shown).includes('__show_budget'), 'the private flag never reaches a client');

  // 0151: another store still cannot offer on it.
  const other = await post(as(raw, 'owner2'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 9000, delivery_method: 'pickup' });
  assert.notEqual(other.status, 201);
});
