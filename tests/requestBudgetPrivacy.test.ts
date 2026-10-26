/**
 * Q2 — THE BUDGET IS PRIVATE BY DEFAULT (plan P1-06, acceptance 34; owner
 * answer Q2; docs/DECISIONS.md rows 262, 266 (٧), 268; build item B0;
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
 * it — the eligible workshop on its boards, its notification, the request
 * page and the revisions, the accepted merchant on the order — and still
 * never the public board, a guest, a member or a merchant the job is not for
 * (critique 2: the contract's `merchants`, not every merchant account).
 *
 * A DIRECT request (one store, from its chat): the budget typed into the
 * sheet is shown to that store (critique 3), not before the send (a draft is
 * its customer's alone), including a row written before the sheet stored the
 * switch (it stores it off; no row is rewritten). A chat card loses it at the
 * reader when the request stops showing it (critique 6) while the stored card
 * keeps it. A REPEAT of a direct request is a board draft with the switch
 * off: the budget typed for one store never reaches the board's workshops.
 *
 * THE CLIENT: the wizard hint is in three languages with a Sorani of its own
 * (plan R5, row 183), and no public card renders a budget.
 *
 * A database without the column (before 0208) reads it hidden.
 *
 * Run: node --import tsx --test tests/requestBudgetPrivacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asD1, get, json, post, row, stubApp, type Mount, type StubUser } from './fixtures/app';
import { fund, newDraft, offerOn, world, PLA } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { communityRoutes } from '../worker/routes/community';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { budgetFor, budgetReaderOf, stripSnapshotBudget, stripSpecBudget } from '../worker/lib/requestBudget';
import { cardPublic } from '../worker/lib/chatCards';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communitySearchRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/public/v1', publicApiRoutes);
};
/** The world's people: the customer, the FDM workshop (m1), the resin workshop (m2), a member, an admin. */
const user = (id: string, role: 'customer' | 'admin' = 'customer'): StubUser => ({ id, role, email: `${id}@x.co` });
const BUYER = user('buyer');
const ELIGIBLE = user('owner');
const INELIGIBLE = user('owner2');
const MEMBER = user('stranger');
const ADMIN = user('admin1', 'admin');
const GUEST = null;

const app = (raw: DatabaseSync, u: StubUser | null) => stubApp(asD1(raw), u, mount);
const read = async (raw: DatabaseSync, u: StubUser | null, path: string) => {
  const res = await get(app(raw, u), path);
  assert.equal(res.status, 200, `${path} (${u?.id ?? 'guest'}): ${res.status}`);
  return json(res);
};

/** A published PLA job with a budget of 25 000, the switch as given. */
async function job(raw: DatabaseSync, visible: boolean): Promise<string> {
  const id = await newDraft(raw, { budget_iqd: 25000 });
  const res = await post(app(raw, BUYER), `/api/marketplace/print/requests/${id}/publish`, { ...PLA, budget_iqd: 25000, budget_visible: visible });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return id;
}

/** `budget_iqd` of one row of a list; 'absent' when the row is not on it. */
const budgetOn = (rows: unknown, id: string) =>
  ((rows as Array<{ id: string; budget_iqd: unknown }>).find((r) => r.id === id) ?? { budget_iqd: 'absent' }).budget_iqd;
const pageBudget = async (raw: DatabaseSync, u: StubUser | null, id: string) =>
  ((await read(raw, u, `/api/marketplace/requests/${id}`)).request as Record<string, unknown>).budget_iqd;
const revisionBudgets = async (raw: DatabaseSync, u: StubUser | null, id: string) =>
  ((await read(raw, u, `/api/marketplace/print/requests/${id}/revisions`)).revisions as Array<{ spec: Record<string, unknown> }>).map((r) => r.spec.budget_iqd);
/** The match notification the eligible workshop received: all three languages (ckb rides in `meta`). */
const told = (raw: DatabaseSync, id: string) => {
  const n = row<{ body_ar: string; body_en: string; meta: string }>(
    raw,
    `SELECT body_ar, body_en, meta FROM user_notifications WHERE user_id = 'owner' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`,
    id
  );
  return n ? `${n.body_ar}\n${n.body_en}\n${n.meta}` : null;
};
const NAMES_25000 = /25[,.٬]?000/;
const SAYS_BUDGET = /budget|الميزانية|بودجە/i;

// ------------------------------------------------------------------ the rule

test('the rule itself: owner and admin always, a merchant only with the switch, nobody else ever', () => {
  assert.equal(budgetFor(25000, 0, 'owner'), 25000);
  assert.equal(budgetFor(25000, 0, 'admin'), 25000);
  assert.equal(budgetFor(25000, 0, 'merchant'), null);
  assert.equal(budgetFor(25000, 1, 'merchant'), 25000);
  assert.equal(budgetFor(25000, 1, 'public'), null);
  assert.equal(budgetFor(25000, undefined, 'merchant'), null, 'a row without the column reads hidden');
  assert.equal(budgetFor(null, 1, 'owner'), null);
  assert.equal(budgetFor('', 1, 'owner'), null);
  const spec = { title: 't', budget_iqd: 25000 };
  assert.deepEqual(stripSpecBudget(spec, 0, 'merchant'), { title: 't', budget_iqd: null });
  assert.equal(stripSpecBudget(spec, 1, 'merchant'), spec, 'unchanged when it may be seen');
  assert.equal(spec.budget_iqd, 25000, 'the stored object is never rewritten');
  assert.deepEqual(stripSnapshotBudget({ spec: { budget_iqd: 9 }, files: [] }, 0, 'merchant'), { spec: { budget_iqd: null }, files: [] });
});

test('the reader: only the eligible and the engaged are merchants; a merchant account alone is public (critique 2)', () => {
  assert.equal(budgetReaderOf({ isOwner: true, isAdmin: false, reader: null }), 'owner');
  assert.equal(budgetReaderOf({ isOwner: false, isAdmin: true, reader: null }), 'admin');
  assert.equal(budgetReaderOf({ isOwner: false, isAdmin: false, reader: 'eligible' }), 'merchant');
  assert.equal(budgetReaderOf({ isOwner: false, isAdmin: false, reader: 'engaged' }), 'merchant');
  assert.equal(budgetReaderOf({ isOwner: false, isAdmin: false, reader: null }), 'public');
  assert.equal(budgetReaderOf({ isOwner: false, isAdmin: false, reader: undefined }), 'public');
});

// ------------------------------------------------------------- a board request

test('switch off (the default): the customer and an admin read the budget, and no other reader does', async () => {
  const raw = world();
  const id = await job(raw, false);
  for (const u of [GUEST, MEMBER, ELIGIBLE, INELIGIBLE]) {
    const who = u?.id ?? 'guest';
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), null, `board (${who})`);
    assert.equal(budgetOn((await read(raw, u, '/api/community/requests')).requests, id), null, `community list (${who})`);
    assert.equal(await pageBudget(raw, u, id), null, `request page (${who})`);
  }
  // The eligible workshop: its boards, its notification, the revisions.
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/merchant/workshop/board')).requests, id), null, 'workshop board');
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/community/requests?for=me')).requests, id), null, '«طلبات تناسبك»');
  const note = told(raw, id);
  assert.ok(note, 'the eligible workshop was told');
  assert.ok(!NAMES_25000.test(note!) && !SAYS_BUDGET.test(note!), 'the notification says no budget, in any language');
  assert.ok((await revisionBudgets(raw, ELIGIBLE, id)).every((b) => b === null), 'revisions');
  // The public API.
  const api = await read(raw, GUEST, `/api/public/v1/community/requests/${id}`);
  assert.equal(JSON.stringify(api).includes('25000'), false, 'public API');
  // Its owners.
  assert.equal(await pageBudget(raw, BUYER, id), 25000, 'the customer');
  assert.equal(await pageBudget(raw, ADMIN, id), 25000, 'an admin');
  assert.equal((await read(raw, BUYER, `/api/marketplace/print/requests/${id}/draft`)).draft.budget_iqd, 25000);
  assert.deepEqual(await revisionBudgets(raw, BUYER, id), [25000], 'the customer reads their own revisions');
  assert.ok((await read(raw, BUYER, '/api/marketplace/my-requests')).requests.some((r: Record<string, unknown>) => r.id === id && r.budget_iqd === 25000));
});

test('switch on: the merchants the request is meant for read it — never the board, a guest, a member or a workshop it is not for', async () => {
  const raw = world();
  const id = await job(raw, true);
  for (const u of [GUEST, MEMBER, ELIGIBLE, INELIGIBLE]) {
    const who = u?.id ?? 'guest';
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), null, `the public board (${who})`);
    assert.equal(budgetOn((await read(raw, u, '/api/community/requests')).requests, id), null, `the community list (${who})`);
    const found = await read(raw, u, '/api/community/search?q=phone&types=requests');
    assert.equal(JSON.stringify(found).includes('25000'), false, `search (${who})`);
  }
  assert.equal(JSON.stringify(await read(raw, GUEST, '/api/public/v1/community/requests')).includes('25000'), false, 'the public API list');
  assert.equal(JSON.stringify(await read(raw, GUEST, `/api/public/v1/community/requests/${id}`)).includes('25000'), false, 'the public API request');
  // The request page: only the eligible workshop among the non-parties.
  assert.equal(await pageBudget(raw, GUEST, id), null, 'request page (guest)');
  assert.equal(await pageBudget(raw, MEMBER, id), null, 'request page (a member)');
  assert.equal(await pageBudget(raw, INELIGIBLE, id), null, 'request page (a resin workshop the PLA job is not for)');
  assert.equal(await pageBudget(raw, ELIGIBLE, id), 25000, 'request page (the eligible workshop)');
  // The eligible workshop's own boards and its notification.
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/merchant/workshop/board')).requests, id), 25000, 'workshop board');
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/community/requests?for=me')).requests, id), 25000, '«طلبات تناسبك»');
  assert.equal(budgetOn((await read(raw, INELIGIBLE, '/api/merchant/workshop/board')).requests, id), 'absent', 'not on the resin board');
  assert.equal(budgetOn((await read(raw, INELIGIBLE, '/api/community/requests?for=me')).requests, id), 'absent', 'not for the resin workshop');
  const note = told(raw, id);
  assert.ok(note && NAMES_25000.test(note), 'the notification names it');
  assert.equal(
    row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner2' AND entity_id = ?`, id)!.n,
    0,
    'the workshop the job is not for is told nothing'
  );
  // The revisions: the eligible workshop that offered reads it; a member and a workshop it is not for do not.
  await offerOn(raw, id);
  assert.deepEqual(await revisionBudgets(raw, ELIGIBLE, id), [25000]);
  assert.ok((await revisionBudgets(raw, MEMBER, id)).every((b) => b === null), 'a member');
  assert.ok((await revisionBudgets(raw, INELIGIBLE, id)).every((b) => b === null), 'a workshop it is not for');
  assert.ok((await revisionBudgets(raw, GUEST, id)).every((b) => b === null), 'a guest');
});

test('the accepted order: the stored snapshot keeps the budget; the merchant reads it only with the switch', async () => {
  for (const visible of [false, true]) {
    const raw = world();
    const id = await job(raw, visible);
    const offer = await offerOn(raw, id, 20000);
    fund(raw, 'buyer', 60000);
    const accepted = await post(app(raw, BUYER), `/api/marketplace/offers/${offer.id}/accept`, { expected_total_iqd: 20000, offer_revision: offer.revision });
    const body = await json(accepted);
    assert.equal(accepted.status, 201, JSON.stringify(body));
    const orderId = String(body.order?.id ?? '');
    assert.ok(orderId);
    const stored = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders WHERE id = ?', orderId)!.request_snapshot);
    assert.equal(stored.spec.budget_iqd, 25000, 'the stored snapshot keeps it: never rewritten');
    const mine = await read(raw, BUYER, `/api/marketplace/orders/${orderId}`);
    const theirs = await read(raw, ELIGIBLE, `/api/marketplace/orders/${orderId}`);
    assert.equal(mine.order.request_snapshot.spec.budget_iqd, 25000, 'the customer');
    assert.equal(theirs.order.request_snapshot.spec.budget_iqd, visible ? 25000 : null, `the accepted merchant, switch ${visible ? 'on' : 'off'}`);
    // The engaged merchant on the request page: a party, the switch decides.
    assert.equal(await pageBudget(raw, ELIGIBLE, id), visible ? 25000 : null, `request page (the accepted merchant, switch ${visible ? 'on' : 'off'})`);
  }
});

test('a database before 0208 has no switch: the budget reads hidden to every merchant reader', async () => {
  const raw = world('0207');
  const id = await newDraft(raw, { budget_iqd: 25000 });
  const res = await post(app(raw, BUYER), `/api/marketplace/print/requests/${id}/publish`, { ...PLA, budget_iqd: 25000 });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/merchant/workshop/board')).requests, id), null);
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/community/requests?for=me')).requests, id), null);
  assert.equal(await pageBudget(raw, ELIGIBLE, id), null);
  assert.ok(!NAMES_25000.test(told(raw, id) ?? ''), 'the notification');
  assert.equal(await pageBudget(raw, BUYER, id), 25000);
});

// ----------------------------------------------------------- a direct request

/** The customer opens the store's conversation and drafts a request to it with a budget of 30 000. */
async function directDraft(raw: DatabaseSync): Promise<{ chatId: string; id: string }> {
  const open = await post(app(raw, BUYER), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(open.status, 200, JSON.stringify(await json(open.clone())));
  const chatId = String((await json(open)).chatId);
  const res = await post(app(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'A phone stand', description: 'A stand for my phone, matte black please', quantity: 1, budget_iqd: 30000,
  });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.request.budget_iqd, 30000, 'the customer reads back the budget they typed');
  return { chatId, id: String(body.request.id) };
}
type Msg = { card?: { type: string; original: Record<string, unknown>; current: Record<string, unknown> } | null };
const cardBudget = async (raw: DatabaseSync, viewer: StubUser, chatId: string) => {
  const messages = (await read(raw, viewer, `/api/chats/${chatId}/messages?limit=50`)).messages as Msg[];
  const card = messages.filter((m) => m.card?.type === 'print_request').pop();
  assert.ok(card, 'the request card is in the thread');
  assert.equal('__show_budget' in card!.card!.current, false, 'the private flag never reaches a client');
  return card!.card!.original.budget_iqd;
};

test('a direct request: the store reads the budget typed for it once sent — never the draft, never the public (critique 3)', async () => {
  const raw = world();
  const { chatId, id } = await directDraft(raw);
  // A draft is its customer's alone: the store cannot open it at all yet.
  assert.equal((await get(app(raw, ELIGIBLE), `/api/marketplace/requests/${id}`)).status, 404, 'the store does not see the draft');
  assert.equal((await get(app(raw, ELIGIBLE), `/api/marketplace/print/requests/${id}/revisions`)).status, 404, 'nor its revisions');
  const sent = await post(app(raw, BUYER), `/api/chats/${chatId}/print-requests/${id}/send`, {});
  const sentBody = await json(sent);
  assert.equal(sent.status, 201, JSON.stringify(sentBody));
  assert.equal(sentBody.request.budget_iqd, 30000, 'the customer reads it back on the send');
  // The addressed store: the request page, the card and the revisions.
  assert.equal(await pageBudget(raw, ELIGIBLE, id), 30000, 'the store on the request page');
  assert.equal(await cardBudget(raw, ELIGIBLE, chatId), 30000, 'the store on the card');
  assert.deepEqual(await revisionBudgets(raw, ELIGIBLE, id), [30000], 'the store on the revisions');
  // Anyone else: never.
  for (const u of [GUEST, MEMBER, INELIGIBLE]) {
    assert.equal((await get(app(raw, u), `/api/marketplace/requests/${id}`)).status, 404, `a direct request is nobody else's (${u?.id ?? 'guest'})`);
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), 'absent', 'never on the board');
  }
});

test('a direct request written before the sheet stored the switch (stored off): its store still reads the budget typed for it, nobody else does', async () => {
  const raw = world();
  const { chatId, id } = await directDraft(raw);
  assert.equal((await post(app(raw, BUYER), `/api/chats/${chatId}/print-requests/${id}/send`, {})).status, 201);
  // Every live chat-born direct request written before B0 holds the switch off (the sheet never set it).
  raw.exec(`UPDATE community_requests SET budget_visible = 0 WHERE id = '${id}'`);
  // The store it was typed for: the request page, the card and the revisions.
  assert.equal(await pageBudget(raw, ELIGIBLE, id), 30000, 'the store on the request page');
  assert.equal(await cardBudget(raw, ELIGIBLE, chatId), 30000, 'the store on the card');
  assert.deepEqual(await revisionBudgets(raw, ELIGIBLE, id), [30000], 'the store on the revisions');
  // The customer, and the wizard hint they read: the store sees it.
  assert.equal(await cardBudget(raw, BUYER, chatId), 30000, 'the customer on the card');
  assert.equal((await read(raw, BUYER, `/api/marketplace/print/requests/${id}/draft`)).draft.budget_visible, true, 'the wizard hint says merchants see it');
  // Nobody else, ever.
  for (const u of [GUEST, MEMBER, INELIGIBLE]) {
    assert.equal((await get(app(raw, u), `/api/marketplace/requests/${id}`)).status, 404, `a direct request is nobody else's (${u?.id ?? 'guest'})`);
    assert.equal(budgetOn((await read(raw, u, '/api/marketplace/requests')).requests, id), 'absent', 'never on the board');
  }
  // The accepted order: the store quotes in its conversation, the customer
  // accepts, and the store reads the budget on its copy of the job too.
  const quoted = await post(app(raw, ELIGIBLE), `/api/chats/${chatId}/quotes`, {
    request_id: id, price_iqd: 20000, completion_days: 3, delivery_method: 'pickup', valid_days: 7,
  });
  const quote = await json(quoted);
  assert.equal(quoted.status, 201, JSON.stringify(quote));
  fund(raw, 'buyer', 60000);
  const accepted = await post(app(raw, BUYER), `/api/marketplace/offers/${quote.message.card.ref}/accept`, {
    expected_price_iqd: quote.message.card.original.price_iqd,
    offer_revision: quote.message.card.original.revision,
  });
  const body = await json(accepted);
  assert.equal(accepted.status, 201, JSON.stringify(body));
  const orderId = String(body.order?.id ?? '');
  const theirs = await read(raw, ELIGIBLE, `/api/marketplace/orders/${orderId}`);
  assert.equal(theirs.order.request_snapshot.spec.budget_iqd, 30000, 'the store on the accepted order');
  assert.equal(await pageBudget(raw, ELIGIBLE, id), 30000, 'the store on the request page, once engaged');
});

test('the chat card: the stored card keeps the budget; the store loses it at the reader when the request stops showing it (critique 6)', async () => {
  const raw = world();
  const { chatId, id } = await directDraft(raw);
  assert.equal((await post(app(raw, BUYER), `/api/chats/${chatId}/print-requests/${id}/send`, {})).status, 201);
  // A direct request the chat-sheet rule does not cover (here the same row
  // with no conversation of origin) follows the switch alone. Turned off
  // later: the stored card is not rewritten…
  raw.exec(`UPDATE community_requests SET budget_visible = 0, origin_chat_id = NULL WHERE id = '${id}'`);
  const stored = row<{ card_snapshot: string }>(raw, `SELECT card_snapshot FROM chat_messages WHERE chat_id = ? AND card_type = 'print_request'`, chatId)!;
  assert.equal(JSON.parse(stored.card_snapshot).budget_iqd, 30000, 'the stored card keeps what it was sent with');
  // …but the store reads it without the budget, and the customer still with it.
  assert.equal(await cardBudget(raw, ELIGIBLE, chatId), null, 'the store, switch off');
  assert.equal(await cardBudget(raw, BUYER, chatId), 30000, 'the customer');
  assert.equal(await pageBudget(raw, ELIGIBLE, id), null, 'the store on the request page, switch off');
  assert.equal(await pageBudget(raw, BUYER, id), 30000, 'the customer on the request page');
  // On again: the store reads it again.
  raw.exec(`UPDATE community_requests SET budget_visible = 1 WHERE id = '${id}'`);
  assert.equal(await cardBudget(raw, ELIGIBLE, chatId), 30000, 'the store, switch on');
});

// ------------------------------------------------------------------ a repeat

/** «إعادة الطلب»: the repeat of a request, as a draft; its id. */
async function repeatOf(raw: DatabaseSync, id: string): Promise<string> {
  const res = await post(app(raw, BUYER), `/api/marketplace/print/requests/${id}/repeat`, {});
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  return String(body.request_id);
}
const switchOf = (raw: DatabaseSync, id: string) =>
  ({ ...row<{ visibility: string; budget_visible: number; budget_iqd: number | null }>(raw, 'SELECT visibility, budget_visible, budget_iqd FROM community_requests WHERE id = ?', id)! });

test('a repeat of a direct request is a board draft with the switch OFF: the budget typed for one store reaches no workshop of the board', async () => {
  const raw = world();
  const { chatId, id } = await directDraft(raw);
  assert.equal(switchOf(raw, id).budget_visible, 1, 'the sheet shows it to its one store');
  assert.equal((await post(app(raw, BUYER), `/api/chats/${chatId}/print-requests/${id}/send`, {})).status, 201);
  const copy = await repeatOf(raw, id);
  assert.deepEqual(switchOf(raw, copy), { visibility: 'public', budget_visible: 0, budget_iqd: 30000 }, 'a board draft: the figure is kept for its customer, hidden from merchants');
  assert.equal((await read(raw, BUYER, `/api/marketplace/print/requests/${copy}/draft`)).draft.budget_visible, false, 'the wizard hint says hidden');
  // The live wizard publishes it: its body names no switch.
  const pub = await post(app(raw, BUYER), `/api/marketplace/print/requests/${copy}/publish`, { ...PLA, budget_iqd: 30000 });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  // The eligible workshop: its page, both boards and its notification carry no budget.
  assert.equal(await pageBudget(raw, ELIGIBLE, copy), null, 'request page (the eligible workshop)');
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/merchant/workshop/board')).requests, copy), null, 'workshop board');
  assert.equal(budgetOn((await read(raw, ELIGIBLE, '/api/community/requests?for=me')).requests, copy), null, '«طلبات تناسبك»');
  const note = told(raw, copy);
  assert.ok(note, 'the eligible workshop was told');
  assert.ok(!/30[,.٬]?000/.test(note!) && !SAYS_BUDGET.test(note!), 'the notification says no budget, in any language');
  // The customer keeps their own figure; the source still shows it to its store.
  assert.equal(await pageBudget(raw, BUYER, copy), 30000, 'the customer');
  assert.equal(await pageBudget(raw, ELIGIBLE, id), 30000, 'the direct source, to its store');
});

test('a repeat of a board request keeps its switch, off or on', async () => {
  for (const visible of [false, true]) {
    const raw = world();
    const copy = await repeatOf(raw, await job(raw, visible));
    assert.deepEqual(switchOf(raw, copy), { visibility: 'public', budget_visible: visible ? 1 : 0, budget_iqd: 25000 }, `switch ${visible ? 'on' : 'off'}`);
  }
});

test('cardPublic strips a print request budget unless the reader was cleared for it, and never sends the flag', () => {
  const m = { card_type: 'print_request', card_ref: 'r1', card_snapshot: JSON.stringify({ title: 't', budget_iqd: 30000 }) };
  assert.equal(cardPublic(m, undefined)!.original.budget_iqd, null, 'no state read: hidden');
  assert.equal(cardPublic(m, { status: 'open', actions: [] })!.original.budget_iqd, null, 'not cleared: hidden');
  const shown = cardPublic(m, { status: 'open', actions: [], __show_budget: true })!;
  assert.equal(shown.original.budget_iqd, 30000, 'cleared: shown');
  assert.equal('__show_budget' in shown.current, false, 'the flag stays on the server');
  // Another card type is untouched.
  const quote = { card_type: 'quote', card_ref: 'o1', card_snapshot: JSON.stringify({ price_iqd: 5, budget_iqd: 7 }) };
  assert.equal(cardPublic(quote, { status: 'pending', actions: [] })!.original.budget_iqd, 7);
});

// ---------------------------------------------------------------- the client

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Every three-string `loc('ar', 'en', 'ckb')` call, with its arguments (as in tests/clayPolishSorani.test.ts). */
const THREE_ARG_LOC = /\bloc\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*,\s*(['"`])((?:(?!\3)[^\\]|\\.)*)\3\s*,\s*(['"`])((?:(?!\5)[^\\]|\\.)*)\5\s*\)/g;
/** A letter Sorani writes and Arabic does not. */
const SORANI_LETTER = /[ەڵۆێڕڤگچپژ]/;

test('the wizard budget hint is in three languages, and its Sorani is its own (plan R5, row 183)', () => {
  const wizard = source('src/components/community/requests/RequestWizard.tsx');
  const calls = [...wizard.matchAll(THREE_ARG_LOC)];
  for (const [ar, en] of [
    ['لا يراها التجار ولا العموم.', 'Hidden from merchants and the public.'],
    ['يراها التجار الذين يمكنهم صنع طلبك، ولا تظهر للعموم.', 'Merchants who can make your request see it; it is never public.'],
  ]) {
    const call = calls.find((m) => m[2] === ar && m[4] === en);
    assert.ok(call, `RequestWizard.tsx says «${en}» in all three languages`);
    const ckb = call![6];
    assert.ok(ckb.trim().length > 0, `the Sorani of «${en}» is written`);
    assert.notEqual(ckb, ar, `the Sorani of «${en}» is not the Arabic copied`);
    assert.match(ckb, SORANI_LETTER, `the Sorani of «${en}» is Sorani`);
  }
  // The promise the old hint made is gone in every language.
  assert.doesNotMatch(wizard, /يراها التجار\. اتركها|Merchants see it\. Leave it|بازرگانەکان دەیبینن\./, 'the old «merchants see it» hint is back');
});

test('no public request card renders a budget: the hub card and the board card of /requests', () => {
  const card = source('src/components/community/hub/RequestCard.tsx');
  assert.doesNotMatch(card, /budget_iqd/, 'hub/RequestCard.tsx reads budget_iqd again');
  assert.doesNotMatch(card, /loc\('الميزانية'/, 'hub/RequestCard.tsx labels a budget again');
  const page = source('src/pages/Requests.tsx');
  const start = page.indexOf('function AllRequests(');
  assert.ok(start > 0, 'the board card of /requests is AllRequests');
  const next = page.indexOf('\nfunction ', start + 1);
  const board = page.slice(start, next > 0 ? next : undefined);
  assert.doesNotMatch(board, /budget_iqd/, 'the AllRequests card reads budget_iqd again');
  assert.doesNotMatch(board, /loc\('الميزانية'/, 'the AllRequests card labels a budget again');
});
