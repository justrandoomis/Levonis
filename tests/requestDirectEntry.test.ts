/**
 * «لهذا المتجر فقط» — A REQUEST FOR ONE STORE, FROM ITS PAGE (plan P1-06,
 * docs/DECISIONS.md row 268; worker/lib/directRequests.ts, migration 0151).
 *
 *   the entry makes a DIRECT draft addressed to the store, with no
 *   conversation: the store sees nothing — no thread in its inbox, not the
 *   request page, not its customer's name — until the draft is SENT;
 *   an idle entry is answered again rather than multiplied;
 *   the conversation's own rules: the customer's own store (OWN_STORE_REQUEST), a
 *   store not taking custom requests (STORE_NO_CUSTOM_REQUESTS), one not
 *   taking new work (MERCHANT_UNAVAILABLE), one the public may not see
 *   (STORE_UNAVAILABLE);
 *   the board's publish door refuses it (REQUEST_IS_DIRECT), and the send
 *   asks the publish door's questions (REQUEST_TITLE_REQUIRED) before any
 *   thread is opened;
 *   the send opens the thread and writes the card in one go; revision 1 is
 *   recorded with the model; a second send answers the same card; the budget
 *   follows Q2 on the request page and on the card; another store's offer is
 *   still refused by 0151;
 *   a draft the CHAT SHEET made, opened in the editor: the switch the editor
 *   shows is the one obeyed. Turned off there and sent through the editor's
 *   door, its store reads no budget on the page or on the card (B3 round 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, post, put, row, stubApp, type Mount } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { REFUSAL_STRINGS, apiRefusal } from '../src/lib/refusalStrings';
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
  assert.equal(own.body.code, 'OWN_STORE_REQUEST', 'a code of its own: OWN_REQUEST is the offer door');
  // The workshop reads that this is its own store, in each language, never the offer sentence.
  const said = {
    ar: 'هذا متجرك، لا يمكنك أن تطلب منه طباعة.',
    en: 'This is your own store, so you cannot send it a print request.',
    ckb: 'ئەمە فرۆشگاکەی خۆتە، ناتوانیت داوای چاپی بۆ بنێریت.',
  } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(apiRefusal(own.body, lang, 'x'), said[lang], lang);
    assert.notEqual(said[lang], REFUSAL_STRINGS.OWN_REQUEST[lang], `${lang}: not the offer sentence`);
  }
  // The product door asks the same question of the same store.
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock)
            VALUES ('cp1','m1','s1','cable-clip','Cable clip','active','active',5000,10,0)`);
  const ownProduct = await post(as(raw, 'owner'), '/api/marketplace/print/requests', { entry: { kind: 'product', product_id: 'cp1', store: 'ali3d' } });
  assert.equal(ownProduct.status, 400);
  assert.equal((await json(ownProduct)).code, 'OWN_STORE_REQUEST');
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

test('a chat-sheet draft switched OFF in the editor and sent there: the store reads no budget on the page or on the card', async () => {
  const raw = world();
  const open = await post(as(raw, 'buyer'), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(open.status, 200, JSON.stringify(await json(open.clone())));
  const chatId = String((await json(open)).chatId);
  const made = await post(as(raw, 'buyer'), `/api/chats/${chatId}/print-requests`, {
    title: 'A phone stand', description: 'A stand for my phone, matte black please', quantity: 1, budget_iqd: 25000,
  });
  const madeBody = await json(made);
  assert.equal(made.status, 201, JSON.stringify(madeBody));
  const id = String(madeBody.request.id);
  // The editor opens the sheet's draft: a budget typed for this store, shown to it.
  const opened = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`));
  assert.equal(opened.draft.budget_visible, true);

  // The customer turns the switch OFF in the editor: the editor reads it back off.
  const saved = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, { budget_visible: false });
  const savedBody = await json(saved);
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.draft.budget_visible, false, 'what the editor shows is what the store will read');
  const stored = row<{ budget_visible: number; notes: string }>(raw, 'SELECT budget_visible, notes FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual({ ...stored }, { budget_visible: 0, notes: `entry:chat:${chatId}` }, 'the switch, and the mark that ends the sheet rule');

  // Sent through the editor's door.
  const sent = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/send`);
  const sentBody = await json(sent);
  assert.equal(sent.status, 201, JSON.stringify(sentBody));
  assert.equal(sentBody.chat_id, chatId);
  type Card = { card: { type: string; original: Record<string, unknown> } | null };
  const cardFor = async (viewer: string) =>
    ((await json(await get(as(raw, viewer), `/api/chats/${chatId}/messages`))).messages as Card[]).find((m) => m.card?.type === 'print_request')!.card!.original.budget_iqd;
  // The store: not on the request page, not on the card.
  assert.equal((await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`))).request.budget_iqd, null, 'the store on the request page');
  assert.equal(await cardFor('owner'), null, 'the store on the card');
  // The customer still reads their own, on both.
  assert.equal((await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}`))).request.budget_iqd, 25000);
  assert.equal(await cardFor('buyer'), 25000);

  // A sheet draft whose switch the editor never wrote keeps the sheet rule:
  // saved in the editor without naming the switch, the store still reads it.
  const other = await json(await post(as(raw, 'buyer'), `/api/chats/${chatId}/print-requests`, {
    title: 'A cable clip', description: 'Two cable clips for a desk, white', quantity: 2, budget_iqd: 9000,
  }));
  const otherId = String(other.request.id);
  raw.prepare('UPDATE community_requests SET budget_visible = 0 WHERE id = ?').run(otherId);
  const kept = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${otherId}/draft`, { title: 'Two cable clips' });
  assert.equal(kept.status, 200);
  assert.equal((await json(kept)).draft.budget_visible, true);
  assert.equal(row<{ notes: string }>(raw, 'SELECT notes FROM community_requests WHERE id = ?', otherId)!.notes, '', 'no mark without a written switch');
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${otherId}/send`)).status, 201);
  assert.equal((await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${otherId}`))).request.budget_iqd, 9000);
});
