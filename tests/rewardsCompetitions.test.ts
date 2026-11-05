/**
 * COMPETITIONS (owner, 2026-11-03: «i added it later, enter free or by point
 * and etc.»; migration 0220; docs/DECISIONS.md row 286).
 *
 * The owner writes a competition, publishes it (every word in Arabic, English
 * and Sorani), customers enter free or with points, and the owner names the
 * winners after it closes — never a draw (DECISIONS row 25). An entry fee and
 * its entry are one batch; a prize and a refund can never be credited twice.
 *
 * Run: node --import tsx --test tests/rewardsCompetitions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, freshDb, get, post, row, send, stubApp, type Mount, type StubUser } from './fixtures/app';
import type { Env } from '../worker/lib/types';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { finishCompetition, phaseOf, publishProblem, parseCompetitionInput } from '../worker/lib/rewards/competitions';

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const OTHER: StubUser = { id: 'other', role: 'customer', email: 'other@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT: StubUser = { id: 'asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

const mount: Mount = (a) => {
  a.route('/api/rewards/program', rewardProgramRoutes);
  a.route('/api/admin/rewards', adminRewardsRoutes);
};
const appAs = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);
const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

function world(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara Buyer','buyer@x.co','h','customer','sara'),
      ('other','Omar Other','other@x.co','h','customer','omar'),
      ('boss','The Admin','boss@x.co','h','admin','boss');
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('asst','Assistant','asst@x.co','h','admin','assistant');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('pts_b','buyer','deposit','POINT',1000,'approved'),
      ('pts_o','other','deposit','POINT',100,'approved');
  `);
  return raw;
}

const points = (raw: DatabaseSync, user: string) =>
  row<{ n: number }>(raw, "SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM wallet_transactions WHERE user_id = ? AND currency='POINT' AND status='approved'", user)!.n;

const DRAFT = (over: Record<string, unknown> = {}) => ({
  title_ar: 'أجمل طبعة لهذا الشهر',
  title_en: 'Best print of the month',
  title_ckb: 'جوانترین چاپی ئەم مانگە',
  description_ar: 'ارفع صورة لشيء طبعته على طابعتك.',
  description_en: 'Upload a photo of something you printed on your printer.',
  description_ckb: 'وێنەی شتێک بنێرە کە بە چاپکەرەکەت چاپت کردووە.',
  entry_mode: 'free',
  submission: 'text',
  prize_points: [500, 200],
  starts_at: new Date(Date.now() - 3600_000).toISOString(),
  ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  ...over,
});

async function published(raw: DatabaseSync, over: Record<string, unknown> = {}): Promise<string> {
  const boss = appAs(raw, BOSS);
  const made = await json(await post(boss, '/api/admin/rewards/competitions', DRAFT(over)));
  assert.equal(made.success, true, JSON.stringify(made));
  const pub = await json(await post(boss, `/api/admin/rewards/competitions/${made.id}/publish`));
  assert.equal(pub.success, true, JSON.stringify(pub));
  return made.id as string;
}

test('a draft is anyone’s to write; publishing is the owner’s, and only with every word in three languages', async () => {
  const raw = world();
  const asst = appAs(raw, ASSISTANT);
  const made = await json(await post(asst, '/api/admin/rewards/competitions', DRAFT({ title_ckb: '' })));
  assert.equal(made.success, true, JSON.stringify(made));
  const refused = await post(asst, `/api/admin/rewards/competitions/${made.id}/publish`);
  assert.equal(refused.status, 403, 'an assistant cannot publish');
  const boss = appAs(raw, BOSS);
  const incomplete = await post(boss, `/api/admin/rewards/competitions/${made.id}/publish`);
  assert.equal(incomplete.status, 400);
  assert.match((await json(incomplete)).error, /title_ckb/);
  // The Sorani slot never carries the Arabic (DECISIONS row 183).
  assert.equal(publishProblem(parseCompetitionInput(DRAFT({ title_ckb: DRAFT().title_ar })), Date.now()), 'sorani_copy');
  assert.equal(publishProblem(parseCompetitionInput(DRAFT({ description_en: '' })), Date.now()), 'missing:description_en');
  assert.equal(publishProblem(parseCompetitionInput(DRAFT({ prize_points: [0] })), Date.now()), 'no_prize');
  assert.equal(publishProblem(parseCompetitionInput(DRAFT({ prize_ar: 'بكرة' })), Date.now()), 'prize_languages');

  const fixed = await send(boss, 'PUT', `/api/admin/rewards/competitions/${made.id}`, DRAFT());
  assert.equal(fixed.status, 200, JSON.stringify(await json(fixed.clone())));
  const ok = await json(await post(boss, `/api/admin/rewards/competitions/${made.id}/publish`));
  assert.equal(ok.success, true, JSON.stringify(ok));
  const lockedEdit = await send(boss, 'PUT', `/api/admin/rewards/competitions/${made.id}`, DRAFT({ prize_points: [99999] }));
  assert.equal(lockedEdit.status, 409, 'a published competition keeps the terms customers entered under');
});

test('a free competition: one entry per customer, with the answer it asks for, only while it is open', async () => {
  const raw = world();
  const id = await published(raw);
  const buyer = appAs(raw, BUYER);
  const empty = await post(buyer, `/api/rewards/program/competitions/${id}/enter`, {});
  assert.equal((await json(empty)).code, 'COMPETITION_ANSWER_REQUIRED');
  const entered = await json(await post(buyer, `/api/rewards/program/competitions/${id}/enter`, { answer: 'A dragon, 0.12 mm layers' }));
  assert.equal(entered.success, true, JSON.stringify(entered));
  assert.equal(entered.entry.state, 'entered');
  assert.equal(entered.entry.entry_points, 0);
  const twice = await post(buyer, `/api/rewards/program/competitions/${id}/enter`, { answer: 'again' });
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).code, 'COMPETITION_ALREADY_ENTERED');
  assert.equal(points(raw, 'buyer'), 1000, 'free means free');

  const hub = await json(await get(buyer, '/api/rewards/program'));
  const mine = hub.competitions.find((c: { id: string }) => c.id === id);
  assert.equal(mine.phase, 'open');
  assert.equal(mine.my_entry.answer, 'A dragon, 0.12 mm layers');
  assert.equal(mine.entries_count, 1);

  raw.prepare('UPDATE reward_competitions SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
  const late = await post(appAs(raw, OTHER), `/api/rewards/program/competitions/${id}/enter`, { answer: 'late' });
  assert.equal((await json(late)).code, 'COMPETITION_CLOSED');
});

test('a points competition: the fee and the entry are one batch — not enough points enters nothing and spends nothing', async () => {
  const raw = world();
  const id = await published(raw, { entry_mode: 'points', entry_points: 300, submission: 'none' });
  const poor = await post(appAs(raw, OTHER), `/api/rewards/program/competitions/${id}/enter`, {});
  assert.equal(poor.status, 409);
  assert.equal((await json(poor)).code, 'INSUFFICIENT_POINTS');
  assert.equal(points(raw, 'other'), 100);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_competition_entries'), 0);

  const ok = await json(await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${id}/enter`, {}));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(points(raw, 'buyer'), 700);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE ref = ? AND type = 'withdrawal'", `competition_entry:${id}`), 1);
});

test('a competition for printer owners refuses a customer who never received a printer', async () => {
  const raw = world();
  const id = await published(raw, { eligibility: 'printer_owners', submission: 'none' });
  const res = await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${id}/enter`, {});
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'COMPETITION_NOT_ELIGIBLE');
  const hub = await json(await get(appAs(raw, BUYER), '/api/rewards/program'));
  assert.equal(hub.competitions.find((c: { id: string }) => c.id === id).eligible, false);
});

test('the owner names the winners after it closes; each place is paid once, and the winners are told', async () => {
  const raw = world();
  const id = await published(raw, { entry_mode: 'points', entry_points: 50, submission: 'none' });
  const e1 = (await json(await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${id}/enter`, {}))).entry.id;
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_o2','other','deposit','POINT',100,'approved')");
  const e2 = (await json(await post(appAs(raw, OTHER), `/api/rewards/program/competitions/${id}/enter`, {}))).entry.id;

  const boss = appAs(raw, BOSS);
  const early = await post(boss, `/api/admin/rewards/competitions/${id}/finish`, { winners: [{ entry_id: e1, place: 1 }] });
  assert.equal((await json(early)).code, 'COMPETITION_STILL_OPEN');
  const asst = await post(appAs(raw, ASSISTANT), `/api/admin/rewards/competitions/${id}/finish`, { winners: [] });
  assert.equal(asst.status, 403, 'paying prizes is the financial scope');

  raw.prepare('UPDATE reward_competitions SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
  const dup = await post(boss, `/api/admin/rewards/competitions/${id}/finish`, { winners: [{ entry_id: e1, place: 1 }, { entry_id: e2, place: 1 }] });
  assert.equal((await json(dup)).code, 'COMPETITION_WINNERS_INVALID');
  const done = await json(await post(boss, `/api/admin/rewards/competitions/${id}/finish`, { winners: [{ entry_id: e1, place: 1 }, { entry_id: e2, place: 2 }] }));
  assert.equal(done.success, true, JSON.stringify(done));
  assert.deepEqual([done.winners, done.points], [2, 700]);
  assert.equal(points(raw, 'buyer'), 1000 - 50 + 500);
  assert.equal(points(raw, 'other'), 200 - 50 + 200);

  // A second announcement pays nothing.
  await assert.rejects(finishCompetition(envOf(raw), id, [{ entry_id: e1, place: 1 }]), /running competition/);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE ref = ?", `competition_prize:${id}`), 2);

  const notes = all<{ user_id: string; meta: string; link: string }>(raw, "SELECT user_id, meta, link FROM user_notifications WHERE event_key = ?", `reward:competition:${id}:won`);
  assert.deepEqual(notes.map((n) => n.user_id).sort(), ['buyer', 'other']);
  assert.ok(notes.every((n) => JSON.parse(n.meta).body_ckb));
  assert.ok(notes.every((n) => n.link === `/rewards/competitions/${id}`), 'a winner is sent to the competition’s own page (DECISIONS row 290)');
  const page = await json(await get(appAs(raw, BUYER), `/api/rewards/program/competitions/${id}`));
  assert.deepEqual([page.competition.phase, page.competition.my_entry.place, page.competition.winners.length], ['finished', 1, 2]);

  const hub = await json(await get(appAs(raw, OTHER), '/api/rewards/program'));
  const c = hub.competitions.find((x: { id: string }) => x.id === id);
  assert.equal(c.phase, 'finished');
  assert.deepEqual(c.winners.map((w: { place: number; name: string }) => [w.place, w.name]), [[1, 'Sara B.'], [2, 'Omar O.']], 'masked names, never the full identity');
});

test('cancelling gives every entry fee back, once', async () => {
  const raw = world();
  const id = await published(raw, { entry_mode: 'points', entry_points: 200, submission: 'none' });
  await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${id}/enter`, {});
  assert.equal(points(raw, 'buyer'), 800);
  const boss = appAs(raw, BOSS);
  const out = await json(await post(boss, `/api/admin/rewards/competitions/${id}/cancel`, { reason: 'printer shortage' }));
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.refunded, 1);
  assert.equal(points(raw, 'buyer'), 1000);
  const again = await json(await post(boss, `/api/admin/rewards/competitions/${id}/cancel`, { reason: 'printer shortage' }));
  assert.equal(again.refunded, 0);
  assert.equal(points(raw, 'buyer'), 1000, 'refunded once');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?", `reward:competition:${id}:refund`), 1);
});

test('the competitions page keeps the live ones and the results apart, and pages the results (DECISIONS row 290)', async () => {
  const raw = world();
  const open = await published(raw);
  const soon = await published(raw, {
    starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 9 * 86_400_000).toISOString(),
  });
  await json(await post(appAs(raw, BOSS), '/api/admin/rewards/competitions', DRAFT()));
  // A year of results: twenty-five finished ones, a minute apart — and one cancelled.
  const finished = raw.prepare(
    "INSERT INTO reward_competitions (id,title_ar,title_en,title_ckb,starts_at,ends_at,state,finished_at) VALUES (?,'منتهية','Finished','تەواوبوو','2026-09-01T00:00:00.000Z','2026-09-20T00:00:00.000Z','finished',?)"
  );
  for (let i = 0; i < 25; i++) finished.run(`fin_${String(i).padStart(2, '0')}`, new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString());
  raw.exec("INSERT INTO reward_competitions (id,title_ar,starts_at,ends_at,state,cancelled_at) VALUES ('gone','ملغاة','2026-09-01T00:00:00.000Z','2026-09-20T00:00:00.000Z','cancelled','2026-09-05T00:00:00.000Z')");

  const buyer = appAs(raw, BUYER);
  const current = await json(await get(buyer, '/api/rewards/program/competitions'));
  assert.equal(current.success, true, JSON.stringify(current));
  assert.equal(current.view, 'current');
  assert.deepEqual(
    current.competitions.map((c: { id: string; phase: string }) => [c.id, c.phase]),
    [[open, 'open'], [soon, 'upcoming']],
    'open first, then upcoming; a draft never'
  );
  assert.deepEqual(current.counts, { current: 2, results: 25 });
  assert.equal(current.next_cursor, null);

  const first = await json(await get(buyer, '/api/rewards/program/competitions?view=results'));
  assert.equal(first.competitions.length, 20);
  assert.equal(first.competitions[0].id, 'fin_24', 'newest first');
  assert.ok(first.next_cursor, 'more results wait behind a cursor');
  const second = await json(await get(buyer, `/api/rewards/program/competitions?view=results&cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.deepEqual(second.competitions.map((c: { id: string }) => c.id), ['fin_04', 'fin_03', 'fin_02', 'fin_01', 'fin_00']);
  assert.equal(second.next_cursor, null);
  const seen = [...first.competitions, ...second.competitions].map((c: { id: string }) => c.id);
  assert.equal(new Set(seen).size, 25, 'every result once');
  assert.ok(!seen.includes('gone'), 'a cancelled competition is not a result');
  assert.equal((await get(buyer, '/api/rewards/program/competitions?view=results&cursor=nonsense')).status, 400);
});

test('one competition’s own page: a draft or an unknown id is not found; a cancelled one only for its entrant', async () => {
  const raw = world();
  const id = await published(raw, { entry_mode: 'points', entry_points: 200, submission: 'none' });
  const buyer = appAs(raw, BUYER);
  const page = await json(await get(buyer, `/api/rewards/program/competitions/${id}`));
  assert.equal(page.success, true, JSON.stringify(page));
  assert.deepEqual([page.competition.phase, page.competition.my_entry, page.point_balance], ['open', null, 1000]);

  const draft = await json(await post(appAs(raw, BOSS), '/api/admin/rewards/competitions', DRAFT()));
  assert.equal((await get(buyer, `/api/rewards/program/competitions/${draft.id}`)).status, 404, 'a draft is nobody’s to read');
  assert.equal((await get(buyer, '/api/rewards/program/competitions/nope')).status, 404);
  assert.equal((await get(buyer, '/api/rewards/program/competitions/bad%20id')).status, 404);

  await post(buyer, `/api/rewards/program/competitions/${id}/enter`, {});
  await post(appAs(raw, BOSS), `/api/admin/rewards/competitions/${id}/cancel`, { reason: 'printer shortage' });
  const mine = await json(await get(buyer, `/api/rewards/program/competitions/${id}`));
  assert.equal(mine.competition.phase, 'cancelled');
  assert.ok(mine.competition.my_entry, 'the entrant sees why the points came back');
  assert.equal((await get(appAs(raw, OTHER), `/api/rewards/program/competitions/${id}`)).status, 404, 'nobody else’s');
  assert.equal(row<{ link: string }>(raw, 'SELECT link FROM user_notifications WHERE event_key = ?', `reward:competition:${id}:refund`)!.link, `/rewards/competitions/${id}`);
});

// ------------------------------------------------------------ the gate (DECISIONS row 290)

type Gate = { can_enter: boolean; blocked_by: string | null; points_short: number; spots_left: number | null };
const gate = (blocked_by: string | null, extra: Partial<Gate> = {}): Gate => ({ can_enter: blocked_by === null, blocked_by, points_short: 0, spots_left: null, ...extra });

/**
 * Each competition's gate as the hub, the competitions page and its own page
 * give it, asserted identical: the area reads whichever it has to hand.
 */
async function gatesOf(raw: DatabaseSync, user: StubUser, ids: string[]): Promise<Record<string, Gate>> {
  const app = appAs(raw, user);
  const hub = await json(await get(app, '/api/rewards/program'));
  const list = await json(await get(app, '/api/rewards/program/competitions'));
  const out: Record<string, Gate> = {};
  for (const id of ids) {
    const page = await json(await get(app, `/api/rewards/program/competitions/${id}`));
    assert.equal(page.success, true, JSON.stringify(page));
    const own = page.competition.gate as Gate;
    assert.deepEqual(hub.competitions.find((c: { id: string }) => c.id === id)?.gate, own, `${id}: the hub says what its page says`);
    assert.deepEqual(list.competitions.find((c: { id: string }) => c.id === id)?.gate, own, `${id}: the list says what its page says`);
    out[id] = own;
  }
  return out;
}

/** A printer delivered to this customer from a printer catalog: what a printer owners' competition asks for. */
function deliverPrinter(raw: DatabaseSync, userId: string): void {
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog) VALUES ('cmp_printers',NULL,'cmp-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p_cmp_printer','cmp-printer','Printer',500000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_cmp_printer','cmp_printers',0);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,shipping_type)
      VALUES ('ORD-CMP','${userId}','delivered','{}','standard','{}','cash',500000,0,1400,500000,0,'2026-10-01T00:00:00.000Z','direct');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_cmp','ORD-CMP','p_cmp_printer','Printer','',1,500000,500000);
  `);
}

test('every competition carries the server’s gate — the same on the hub, the list and its own page; the area decides nothing', async () => {
  const raw = world();
  const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const open = await published(raw);
  const soon = await published(raw, { starts_at: later(2), ends_at: later(9) });
  const shut = await published(raw);
  raw.prepare('UPDATE reward_competitions SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), shut);
  const owners = await published(raw, { eligibility: 'printer_owners', submission: 'none' });
  const capped = await published(raw, { max_entries: 3, submission: 'none' });
  const full = await published(raw, { max_entries: 1, submission: 'none' });
  const dear = await published(raw, { entry_mode: 'points', entry_points: 1500, submission: 'none' });
  const exact = await published(raw, { entry_mode: 'points', entry_points: 1000, submission: 'none' });
  const fullEntry = await json(await post(appAs(raw, OTHER), `/api/rewards/program/competitions/${full}/enter`, {}));
  assert.equal(fullEntry.success, true, JSON.stringify(fullEntry));
  const ids = [open, soon, shut, owners, capped, full, dear, exact];

  const before = await gatesOf(raw, BUYER, ids);
  assert.deepEqual(before[open], gate(null), 'open, free, uncapped: enter; no cap means no places to count');
  assert.deepEqual(before[soon], gate('upcoming'));
  assert.deepEqual(before[shut], gate('closed'));
  assert.deepEqual(before[owners], gate('not_eligible'), 'a printer owners’ competition, and no printer of theirs');
  assert.deepEqual(before[capped], gate(null, { spots_left: 3 }));
  assert.deepEqual(before[full], gate('full', { spots_left: 0 }));
  assert.deepEqual(before[dear], gate('insufficient_points', { points_short: 500 }), '1,500 to enter with 1,000: 500 short');
  assert.deepEqual(before[exact], gate(null), 'a balance that covers the fee exactly is enough');
  // Short is per customer: Omar holds 100.
  assert.deepEqual((await gatesOf(raw, OTHER, [dear, full]))[dear], gate('insufficient_points', { points_short: 1400 }));
  assert.deepEqual((await gatesOf(raw, OTHER, [full]))[full], gate('entered', { spots_left: 0 }), 'an entry already made comes before the cap');

  // Entered: whatever became of the entry since, it is the one entry this account has.
  const entered = await json(await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${open}/enter`, { answer: 'A vase' }));
  assert.equal(entered.success, true, JSON.stringify(entered));
  for (const state of ['entered', 'disqualified', 'refunded', 'winner', 'entered']) {
    raw.prepare('UPDATE reward_competition_entries SET state = ? WHERE id = ?').run(state, entered.entry.id);
    const page = await json(await get(appAs(raw, BUYER), `/api/rewards/program/competitions/${open}`));
    assert.equal(page.competition.my_entry.state, state);
    assert.deepEqual(page.competition.gate, gate('entered'), `an entry in state ${state}`);
  }

  // A printer delivered: the owners’ competition opens to them. The server says so; the page only reads it.
  deliverPrinter(raw, 'buyer');
  assert.deepEqual((await gatesOf(raw, BUYER, [owners]))[owners], gate(null));
});

test('results_at is when the winners were announced: finished_at once finished, null before and on a cancelled one', async () => {
  const raw = world();
  const id = await published(raw, { submission: 'none' });
  const open = await published(raw, { submission: 'none' });
  const gone = await published(raw, { submission: 'none' });
  const buyer = appAs(raw, BUYER);
  const entry = (await json(await post(buyer, `/api/rewards/program/competitions/${id}/enter`, {}))).entry.id;
  await post(buyer, `/api/rewards/program/competitions/${gone}/enter`, {});
  assert.equal((await json(await get(buyer, `/api/rewards/program/competitions/${id}`))).competition.results_at, null, 'not announced yet');

  raw.prepare('UPDATE reward_competitions SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
  const done = await json(await post(appAs(raw, BOSS), `/api/admin/rewards/competitions/${id}/finish`, { winners: [{ entry_id: entry, place: 1 }] }));
  assert.equal(done.success, true, JSON.stringify(done));
  await post(appAs(raw, BOSS), `/api/admin/rewards/competitions/${gone}/cancel`, { reason: 'printer shortage' });
  const finishedAt = row<{ finished_at: string }>(raw, 'SELECT finished_at FROM reward_competitions WHERE id = ?', id)!.finished_at;
  assert.ok(finishedAt);

  const page = await json(await get(buyer, `/api/rewards/program/competitions/${id}`));
  assert.equal(page.competition.results_at, finishedAt);
  const hub = await json(await get(buyer, '/api/rewards/program'));
  assert.equal(hub.competitions.find((c: { id: string }) => c.id === id).results_at, finishedAt);
  assert.equal(hub.competitions.find((c: { id: string }) => c.id === open).results_at, null);
  const results = await json(await get(buyer, '/api/rewards/program/competitions?view=results'));
  assert.deepEqual(results.competitions.map((c: { id: string; results_at: string }) => [c.id, c.results_at]), [[id, finishedAt]]);
  assert.equal((await json(await get(buyer, `/api/rewards/program/competitions/${gone}`))).competition.results_at, null, 'a cancelled one announced nothing');
  // Over: a gate that only says closed (the entrant’s says entered).
  assert.deepEqual(page.competition.gate, gate('entered'));
  assert.deepEqual((await json(await get(appAs(raw, OTHER), `/api/rewards/program/competitions/${id}`))).competition.gate, gate('closed'));
});

test('«مشاركاتي فقط» (?view=results&mine=1): only the finished and cancelled competitions this customer entered, newest first, paged, never another’s', async () => {
  const raw = world();
  const at = (minutes: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + minutes * 60_000).toISOString();
  const competition = raw.prepare(
    "INSERT INTO reward_competitions (id,title_ar,title_en,title_ckb,starts_at,ends_at,state,finished_at,cancelled_at) VALUES (?,'مسابقة','Contest','پێشبڕکێ','2026-09-01T00:00:00.000Z','2026-09-20T00:00:00.000Z',?,?,?)"
  );
  const entry = raw.prepare('INSERT INTO reward_competition_entries (id,competition_id,user_id,state) VALUES (?,?,?,?)');
  const fm = (i: number) => `fm_${String(i).padStart(2, '0')}`;
  // Twenty-two finished ones Sara entered, a minute apart; fm_03 shares fm_04’s minute, so the id breaks the tie.
  for (let i = 0; i < 22; i++) {
    competition.run(fm(i), 'finished', at(i === 3 ? 4 : i), null);
    entry.run(`e_${fm(i)}`, fm(i), 'buyer', 'entered');
  }
  // Two cancelled ones she entered (her points came back): the newest of all, and one between fm_10 and fm_11.
  competition.run('cx_1', 'cancelled', null, at(30));
  entry.run('e_cx_1', 'cx_1', 'buyer', 'refunded');
  competition.run('cx_2', 'cancelled', null, at(10.5));
  entry.run('e_cx_2', 'cx_2', 'buyer', 'refunded');
  // Omar’s, nobody’s, and one still running that she entered: none of them hers to see here.
  competition.run('fo_1', 'finished', at(40), null);
  entry.run('e_fo_1', 'fo_1', 'other', 'winner');
  competition.run('fn_1', 'finished', at(41), null);
  competition.run('co_1', 'cancelled', null, at(42));
  entry.run('e_co_1', 'co_1', 'other', 'refunded');
  const running = await published(raw, { submission: 'none' });
  await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${running}/enter`, {});

  const expected = ['cx_1', ...Array.from({ length: 11 }, (_, k) => fm(21 - k)), 'cx_2', ...Array.from({ length: 11 }, (_, k) => fm(10 - k))];
  const buyer = appAs(raw, BUYER);
  const first = await json(await get(buyer, '/api/rewards/program/competitions?view=results&mine=1'));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual([first.view, first.mine], ['results', true], 'the filter is echoed');
  assert.deepEqual(first.competitions.map((c: { id: string }) => c.id), expected.slice(0, 20), 'newest first by the moment each ended');
  assert.equal(first.next_cursor, `${at(4)}|fm_04`);
  assert.ok(first.competitions.every((c: { my_entry: unknown }) => c.my_entry), 'each with her own entry');
  assert.equal(first.competitions[0].phase, 'cancelled');
  assert.equal(first.competitions[1].phase, 'finished');
  assert.deepEqual(first.counts, { current: 1, results: 24 }, 'the tabs’ counts stay global');
  const second = await json(await get(buyer, `/api/rewards/program/competitions?view=results&mine=1&cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.deepEqual(second.competitions.map((c: { id: string }) => c.id), expected.slice(20), 'the tie at the page edge is not lost');
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.competitions, ...second.competitions].map((c: { id: string }) => c.id)).size, 24, 'every one of hers, once');

  const omar = await json(await get(appAs(raw, OTHER), '/api/rewards/program/competitions?view=results&mine=1'));
  assert.deepEqual(omar.competitions.map((c: { id: string }) => c.id), ['co_1', 'fo_1'], 'his own, and never hers');

  // Without the filter: every result, entered or not; and `mine` means nothing on the current list.
  const all = await json(await get(buyer, '/api/rewards/program/competitions?view=results'));
  assert.equal(all.mine, false);
  assert.deepEqual(all.competitions.slice(0, 3).map((c: { id: string }) => c.id), ['fn_1', 'fo_1', fm(21)]);
  const current = await json(await get(buyer, '/api/rewards/program/competitions?mine=1'));
  assert.deepEqual([current.view, current.mine, current.competitions.map((c: { id: string }) => c.id)], ['current', false, [running]]);
  assert.equal((await get(buyer, '/api/rewards/program/competitions?view=results&mine=1&cursor=nonsense')).status, 400);
});

test('the hub counts the competitions by window, and the open ones this customer can still enter', async () => {
  const raw = world();
  const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const open = await published(raw);
  // The fee is not part of «can still enter»: the page says what they lack.
  await published(raw, { entry_mode: 'points', entry_points: 5000, submission: 'none' });
  const full = await published(raw, { max_entries: 1, submission: 'none' });
  await published(raw, { eligibility: 'printer_owners', submission: 'none' });
  await published(raw, { starts_at: later(2), ends_at: later(9) });
  const shut = await published(raw);
  raw.prepare('UPDATE reward_competitions SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), shut);
  await json(await post(appAs(raw, BOSS), '/api/admin/rewards/competitions', DRAFT()));
  raw.exec(`
    INSERT INTO reward_competitions (id,title_ar,starts_at,ends_at,state,finished_at) VALUES ('was','منتهية','2026-09-01T00:00:00.000Z','2026-09-20T00:00:00.000Z','finished','2026-09-25T00:00:00.000Z');
    INSERT INTO reward_competitions (id,title_ar,starts_at,ends_at,state,cancelled_at) VALUES ('nix','ملغاة','2026-09-01T00:00:00.000Z','2026-09-20T00:00:00.000Z','cancelled','2026-09-05T00:00:00.000Z');
  `);
  await post(appAs(raw, OTHER), `/api/rewards/program/competitions/${full}/enter`, {});
  const counts = async (user: StubUser) => (await json(await get(appAs(raw, user), '/api/rewards/program'))).competition_counts;

  assert.deepEqual(await counts(BUYER), { open: 4, upcoming: 1, closed: 1, open_to_enter: 2 }, 'not the full one, not the printer owners’ one; drafts, results and cancelled ones not at all');
  assert.deepEqual(await counts(OTHER), { open: 4, upcoming: 1, closed: 1, open_to_enter: 2 }, 'Omar is in the full one already');
  await post(appAs(raw, BUYER), `/api/rewards/program/competitions/${open}/enter`, { answer: 'A vase' });
  assert.deepEqual(await counts(BUYER), { open: 4, upcoming: 1, closed: 1, open_to_enter: 1 }, 'entering drops it');
  deliverPrinter(raw, 'buyer');
  assert.deepEqual(await counts(BUYER), { open: 4, upcoming: 1, closed: 1, open_to_enter: 2 }, 'a printer delivered: the owners’ one counts');
});

test('the phase is the window against the server clock', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  const c = { state: 'published' as const, starts_at: '2026-11-11T00:00:00.000Z', ends_at: '2026-11-20T00:00:00.000Z' };
  assert.equal(phaseOf(c, now), 'upcoming');
  assert.equal(phaseOf({ ...c, starts_at: '2026-11-01T00:00:00.000Z' }, now), 'open');
  assert.equal(phaseOf({ ...c, starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-05T00:00:00.000Z' }, now), 'closed');
  assert.equal(phaseOf({ ...c, state: 'draft' as const }, now), 'draft');
});

test('a database before 0220 answers the hub with empty lists, not an error', async () => {
  const { dbThrough } = await import('./fixtures/app');
  const raw = dbThrough('0219');
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','buyer@x.co','h','customer')");
  const hub = await json(await get(appAs(raw, BUYER), '/api/rewards/program'));
  assert.equal(hub.success, true, JSON.stringify(hub));
  assert.equal(hub.installed, false);
  assert.deepEqual([hub.coupons, hub.competitions], [[], []]);
  // The competitions page reads the same way: an empty list, and one competition is simply not found.
  const list = await json(await get(appAs(raw, BUYER), '/api/rewards/program/competitions?view=results'));
  assert.deepEqual([list.success, list.installed, list.competitions, list.counts], [true, false, [], { current: 0, results: 0 }]);
  assert.equal((await get(appAs(raw, BUYER), '/api/rewards/program/competitions/p_a1')).status, 404);
  // The additions read the same way: zero counts, no holdings, an empty «mine», and the statuses a migrated database gives.
  assert.deepEqual(hub.competition_counts, { open: 0, upcoming: 0, closed: 0, open_to_enter: 0 });
  assert.deepEqual(hub.coupon_counts, { active: 0, past: 0 });
  assert.equal(list.mine, false);
  const mine = await get(appAs(raw, BUYER), '/api/rewards/program/competitions?view=results&mine=1');
  assert.equal(mine.status, 200);
  const mineBody = await json(mine);
  assert.deepEqual([mineBody.installed, mineBody.mine, mineBody.competitions, mineBody.next_cursor], [false, true, [], null]);
  const current = await json(await get(appAs(raw, BUYER), '/api/rewards/program/competitions'));
  assert.deepEqual([current.installed, current.mine, current.competitions, current.counts], [false, false, [], { current: 0, results: 0 }]);
});
