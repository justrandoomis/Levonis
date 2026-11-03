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

  const notes = all<{ user_id: string; meta: string }>(raw, "SELECT user_id, meta FROM user_notifications WHERE event_key = ?", `reward:competition:${id}:won`);
  assert.deepEqual(notes.map((n) => n.user_id).sort(), ['buyer', 'other']);
  assert.ok(notes.every((n) => JSON.parse(n.meta).body_ckb));

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
});
