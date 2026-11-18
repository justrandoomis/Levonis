/**
 * THE MONTHLY LEVO CARE DRAW (owner, 2026-11-18/19; migration 0244; docs/DECISIONS.md row 359).
 *
 *   «monthly competitions of free filaments to random customer who have active levo care» ·
 *   «Random, I confirm each month» · «I set the prize each month»
 *
 * Pinned here: who is in the draw (one ticket per customer; expired, closed, transferred and staff
 * accounts), the pick is unbiased and repeatable from its seed, one row per Baghdad month whoever
 * runs it, an empty month is skipped, drawing another name passes the first over, a winner rests for
 * three draws, only the owner confirms, confirming grants exactly ONE gift through the gifts' own
 * writer however often it is pressed, a winner who lost his Care is refused, nothing about the
 * winner comes from the request, the customer's perks on /api/devices/mine, and a database without
 * 0244 answers as before. After the review of 2026-11-19: a prize bigger than the shelf is refused with
 * what is available, a confirmed prize not yet redeemed can be cancelled («إلغاء الجائزة») and a redeemed
 * one cannot, a proposal is live only inside its own month (the next month's draw closes it), a device
 * someone else bought shows no coupon date, and only the owner reads the proposed name, seed and hash.
 *
 * Run: node --import tsx --test tests/careDraw.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { giftWorld } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { deviceRoutes } from '../worker/routes/devices';
import { giftRoutes } from '../worker/routes/gifts';
import {
  CARE_DRAW_REFUSALS,
  PRIZE_QTY_MAX,
  baghdadMonth,
  candidateHash,
  careHolders,
  drawDueMs,
  pickIndex,
  confirmCareDraw,
  runCareDrawJob,
} from '../worker/lib/careDraw';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const MONTH = baghdadMonth(NOW);
/** An instant of this Baghdad month at which the draw is due (now, or the 1st 10:00 when today is the 1st before it). */
const DUE = iso(Math.max(NOW, drawDueMs(MONTH) + 60_000));

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const OTHER: StubUser = { id: 'other', role: 'customer', email: 'other@x.co' };

const TERMS = { eligible_parts: [{ key: 'nozzle', label: { ar: 'الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' } }], discount_pct: 50, max_claims: 2, max_benefit_iqd: 30_000, labor: 'discounted', shipping: 'full_price', exclusions: [] };
const services = (warranty: 0 | 12 | 24, care: 0 | 12) =>
  JSON.stringify({ lines: care ? [{ service: 'care', choice: 'c12', fee_iqd: 19_000, policy_version: 1 }] : [], warranty_months: warranty, care_months: care, care_total_months: care ? warranty + 12 : 0, revision: 1 });

/** The gift world (buyer, other, boss) with two more customers, two more admins, a printer and the published Care terms. */
function world(): DatabaseSync {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,admin_scope,phone_e164) VALUES
      ('lana','Lana Third','lana@x.co','h','customer','lana',NULL,'+9647701112233'),
      ('zed','Zed Fourth','zed@x.co','h','customer','zed',NULL,NULL),
      ('staff','Staff Full','staff@x.co','h','admin','staff','full',NULL),
      ('helper','Helper','helper@x.co','h','admin','helper','assistant',NULL);
    UPDATE users SET email_verified_at = '2026-01-01T00:00:00.000Z';
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog) VALUES ('cd_printers',NULL,'cd-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','cd-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',600000,'active',9,'[]','[]','direct_sale','["direct_sale"]','[]','[]','tracked');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','cd_printers',0);
    CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO d1_migrations (name, applied_at) VALUES ('0220_rewards_program.sql', '2025-01-01 00:00:00'), ('0225_weekly_reward_coupons.sql', '2025-01-01 00:00:00');
  `);
  raw.prepare('INSERT INTO printer_care_policies (policy_version, terms, published_at, published_by) VALUES (1, ?, ?, ?)').run(JSON.stringify(TERMS), iso(NOW - 400 * DAY), 'boss');
  return raw;
}

let seq = 0;
/** One delivered printer of `owner`: `care` months of Care (0 = none) after `warranty` months, delivered `daysAgo`. */
function device(raw: DatabaseSync, owner: string, opts: { daysAgo?: number; warranty?: 0 | 12 | 24; care?: 0 | 12; buyer?: string; closed?: boolean; snapshot?: boolean } = {}): string {
  const n = ++seq;
  const delivered = iso(NOW - (opts.daysAgo ?? 60) * DAY);
  const buyer = opts.buyer ?? owner;
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id,
          subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
       VALUES (?, ?, 'delivered', '{}', 'standard', '{}', 'cash', 600000, 0, 1400, 600000, 0, ?)`
    )
    .run(`CD-${n}`, buyer, delivered);
  raw.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES (?, ?, 'p_printer', 'A1 mini', 1, 600000, 600000)").run(`cdi${n}`, `CD-${n}`);
  if (opts.snapshot !== false) raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(services(opts.warranty ?? 12, opts.care ?? 12), `cdi${n}`);
  raw
    .prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at, warranty_closed_at, warranty_closed_reason)
       VALUES (?, ?, ?, 'p_printer', ?, 1, ?, ?, ?, ?, ?, ?)`
    )
    .run(`cdu${n}`, `CD-${n}`, `cdi${n}`, owner, delivered, opts.warranty ?? 12, delivered, iso(NOW + 300 * DAY), opts.closed ? iso(NOW - DAY) : null, opts.closed ? 'returned' : null);
  raw.prepare('INSERT INTO device_registrations (unit_id, user_id) VALUES (?, ?)').run(`cdu${n}`, owner);
  return `cdu${n}`;
}

const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;
const as = (raw: DatabaseSync, who: StubUser) =>
  stubApp(
    asD1(raw),
    who,
    (a) => {
      a.route('/api/admin/rewards', adminRewardsRoutes);
      a.route('/api/devices', deviceRoutes);
      a.route('/api/gifts', giftRoutes);
    },
    { publishV2: 'always' }
  );
const drawRow = (raw: DatabaseSync) => row<Record<string, unknown>>(raw, 'SELECT * FROM care_draws WHERE month = ?', MONTH);
const PRIZE = { productId: 'p_plain', optionValueIds: [], colorId: '', saleType: 'direct_sale', transportMethod: '', qty: 2 };
const read = async (raw: DatabaseSync, who: StubUser = OWNER) => json(await get(as(raw, who), '/api/admin/rewards/care-draws'));
const confirm = (raw: DatabaseSync, who: StubUser, id: string, body: Record<string, unknown> = { prize: PRIZE }) => post(as(raw, who), `/api/admin/rewards/care-draws/${id}/confirm`, body);
const gifts = (raw: DatabaseSync) => all<Record<string, unknown>>(raw, 'SELECT * FROM gift_entitlements ORDER BY created_at');
const audits = (raw: DatabaseSync, action: string) => count(raw, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', action);

// ------------------------------------------------------------------ the randomness

test('the pick is a pure function of the seed, always inside the range, and favours no index', async () => {
  assert.equal(await pickIndex('abc', 1), 0);
  assert.equal(await pickIndex('seed-1', 7), await pickIndex('seed-1', 7), 'the same seed and list give the same winner');
  const counts = [0, 0, 0];
  for (let i = 0; i < 3000; i++) {
    const k = await pickIndex(`s${i}`, 3);
    assert.ok(k >= 0 && k < 3);
    counts[k] += 1;
  }
  for (const c of counts) assert.ok(c > 880 && c < 1120, `3000 seeds over three names: ${counts.join(' / ')}`);
  await assert.rejects(() => pickIndex('x', 0));
  assert.equal(await candidateHash(['a', 'b']), await candidateHash(['a', 'b']));
  assert.notEqual(await candidateHash(['a', 'b']), await candidateHash(['a', 'c']));
  assert.match(await candidateHash(['a']), /^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------ who is in it

test('eligibility: one ticket per customer with a Care in force now — not expired, closed, without Care, or a staff account; a device given away is its holder’s', async () => {
  const raw = world();
  const a1 = device(raw, 'buyer', { daysAgo: 60, warranty: 12 });
  device(raw, 'buyer', { daysAgo: 30, warranty: 24 }); // a second device: still one ticket, and the later end wins
  device(raw, 'other', { daysAgo: 400, warranty: 0 }); // Care only, 12 months, delivered 13 months ago: expired
  device(raw, 'lana', { daysAgo: 500, warranty: 24 }); // 36 months of Care: month 17, in force though the coupon year is over
  device(raw, 'zed', { daysAgo: 20, closed: true }); // came back
  device(raw, 'zed', { daysAgo: 20, care: 0 }); // sold through the services without Care
  device(raw, 'zed', { daysAgo: 20, snapshot: false }); // sold before the services
  device(raw, 'staff', { daysAgo: 20 }); // a staff account is never in the draw
  const holders = await careHolders(asD1(raw), NOW);
  assert.deepEqual([...holders.keys()].sort(), ['buyer', 'lana']);
  assert.notEqual(holders.get('buyer')!.unit_id, a1, 'the ticket rides the device whose Care ends last');

  // The buyer gives one device to Omar: the Care goes with it, so Omar is in and the buyer still has his other one.
  raw.prepare('UPDATE order_item_units SET owner_user_id = ? WHERE id = ?').run('other', a1);
  assert.deepEqual([...(await careHolders(asD1(raw), NOW)).keys()].sort(), ['buyer', 'lana', 'other']);
  // An account turned into a staff account leaves the draw.
  raw.exec("UPDATE users SET role = 'admin' WHERE id = 'lana'");
  assert.deepEqual([...(await careHolders(asD1(raw), NOW)).keys()].sort(), ['buyer', 'other']);
  assert.deepEqual([...(await careHolders(asD1(raw), NOW, 'other')).keys()], ['other'], 'narrowed to one account');
});

// ------------------------------------------------------------------ the job

test('the job proposes once per Baghdad month, from the 1st 10:00: one row, the owner rung, nothing granted and the customer told nothing', async () => {
  const raw = world();
  device(raw, 'buyer');
  device(raw, 'other');
  const early = await runCareDrawJob(envOf(raw), iso(drawDueMs(MONTH) - 60_000));
  assert.equal(early.outcome, 'not_due');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM care_draws'), 0, 'before 10:00 on the 1st nothing is drawn');

  const first = await runCareDrawJob(envOf(raw), DUE);
  assert.deepEqual({ ...first }, { installed: true, month: MONTH, outcome: 'proposed', candidates: 2 });
  const again = await runCareDrawJob(envOf(raw), DUE);
  assert.equal(again.outcome, 'exists', 'the next tick finds the month’s row');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM care_draws'), 1);

  const d = drawRow(raw)!;
  assert.equal(d.state, 'proposed');
  assert.equal(d.candidates, 2);
  assert.match(String(d.seed), /^[0-9a-f]{64}$/);
  assert.equal(d.candidate_hash, await candidateHash(['buyer', 'other']), 'the hash is of the sorted candidate ids');
  assert.equal(d.winner_user_id, ['buyer', 'other'][await pickIndex(String(d.seed), 2)], 'the winner can be computed again from the seed and the list');
  assert.equal(d.gift_id, null);
  assert.equal(audits(raw, 'care_draw.proposed'), 1);
  assert.equal(gifts(raw).length, 0, 'nothing is granted by the job');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id IN ('buyer','other')"), 0, 'the customer is told nothing yet');
  const bell = all<{ user_id: string; link: string; meta: string }>(raw, "SELECT user_id, link, meta FROM user_notifications WHERE event_key LIKE 'care_draw:proposed:%'");
  assert.equal(bell.length, 1);
  assert.equal(bell[0].user_id, 'boss');
  assert.equal(bell[0].link, '/admin?tab=rewards');
  assert.ok(JSON.parse(bell[0].meta).body_ckb);
});

test('a month with no eligible holder is skipped with its reason; «اسحب الآن» reopens it when a holder appears, and refuses a month already drawn', async () => {
  const raw = world();
  const out = await runCareDrawJob(envOf(raw), DUE);
  assert.equal(out.outcome, 'skipped');
  const d = drawRow(raw)!;
  assert.equal(d.state, 'skipped');
  assert.equal(d.skip_reason, 'no_candidates');
  assert.equal(d.winner_user_id, null);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key LIKE 'care_draw:%'"), 0);

  let view = await read(raw);
  assert.equal(view.can_draw, true);
  device(raw, 'buyer');
  const drawn = await json(await post(as(raw, OWNER), '/api/admin/rewards/care-draws/draw', {}));
  assert.equal(drawn.success, true, JSON.stringify(drawn));
  assert.equal(drawn.current.state, 'proposed');
  assert.equal(drawn.current.winner.user_id, 'buyer');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM care_draws'), 1, 'the same row, reopened');

  const twice = await post(as(raw, OWNER), '/api/admin/rewards/care-draws/draw', {});
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).code, 'CARE_DRAW_EXISTS');
  view = await read(raw);
  assert.equal(view.can_draw, false);
});

test('the job and the owner’s press racing for one month leave one row', async () => {
  const raw = world();
  device(raw, 'buyer');
  const [a, b, c] = await Promise.all([runCareDrawJob(envOf(raw), DUE), runCareDrawJob(envOf(raw), DUE), post(as(raw, OWNER), '/api/admin/rewards/care-draws/draw', {})]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM care_draws'), 1);
  assert.equal([a.outcome, b.outcome].filter((o) => o === 'proposed').length + (c.status === 200 ? 1 : 0), 1, 'exactly one of them wrote it');
});

// ------------------------------------------------------------------ the admin's screen

test('the admin reads the proposed winner with his device and Care end; staff may read, only the owner may draw, redraw, skip or confirm', async () => {
  const raw = world();
  const unit = device(raw, 'lana', { daysAgo: 60, warranty: 24 });
  await runCareDrawJob(envOf(raw), DUE);
  const outline = await read(raw, FINANCE);
  assert.equal(outline.success, true);
  assert.equal(outline.viewer, 'staff');
  assert.deepEqual(
    [outline.current.state, outline.current.candidates, outline.current.winner, outline.current.seed, outline.current.candidate_hash, outline.can_draw],
    ['proposed', 1, null, '', '', false],
    'another admin reads the month, its state and its count: never the proposed name, the seed or the hash'
  );
  assert.doesNotMatch(JSON.stringify(outline), /Lana|2233|lana/, 'nothing of the proposed winner reaches a staff read');
  const view = await read(raw, OWNER);
  assert.equal(view.viewer, 'owner');
  assert.equal(view.success, true);
  assert.equal(view.installed, true);
  assert.equal(view.month, MONTH);
  assert.equal(view.holders_now, 1);
  const w = view.current.winner;
  assert.deepEqual([w.user_id, w.name, w.phone_tail, w.eligible], ['lana', 'Lana Third', '2233', true]);
  assert.equal(w.device.unit_id, unit);
  assert.equal(w.device.name.ar, 'طابعة A1 mini');
  assert.ok(Date.parse(w.device.care_end_at) > NOW + 900 * DAY, 'the Care runs 36 months from delivery');
  assert.deepEqual(view.rules, { prize_qty_max: PRIZE_QTY_MAX, rest_draws: 3, reason_min: 5 });

  const id = view.current.id as string;
  for (const who of [FINANCE, ASSISTANT]) {
    for (const [path, body] of [
      [`/api/admin/rewards/care-draws/${id}/confirm`, { prize: PRIZE }],
      [`/api/admin/rewards/care-draws/${id}/redraw`, { reason: 'another name please' }],
      [`/api/admin/rewards/care-draws/${id}/skip`, { reason: 'no prize this month' }],
      [`/api/admin/rewards/care-draws/${id}/void`, { reason: 'a mistake was made' }],
      ['/api/admin/rewards/care-draws/draw', {}],
    ] as const) {
      const res = await post(as(raw, who), path, body);
      assert.equal(res.status, 403, `${who.id} ${path}`);
    }
  }
  assert.equal(drawRow(raw)!.state, 'proposed');
  assert.equal(gifts(raw).length, 0, 'no refusal granted anything');
  assert.equal((await get(as(raw, BUYER), '/api/admin/rewards/care-draws')).status, 403, 'a customer reads nothing');
});

// ------------------------------------------------------------------ another name, or no name

test('«سحب اسم آخر» needs a reason, passes the first name over for the month, counts and audits; with nobody else it refuses', async () => {
  const raw = world();
  device(raw, 'buyer');
  device(raw, 'other');
  await runCareDrawJob(envOf(raw), DUE);
  const before = drawRow(raw)!;
  const id = String(before.id);
  const noReason = await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/redraw`, { reason: 'no' });
  assert.equal(noReason.status, 400);
  assert.equal((await json(noReason)).code, 'CARE_DRAW_REASON_REQUIRED');

  const out = await json(await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/redraw`, { reason: 'He asked not to take part' }));
  assert.equal(out.success, true, JSON.stringify(out));
  const after = drawRow(raw)!;
  assert.notEqual(after.winner_user_id, before.winner_user_id, 'the first name is never drawn again this month');
  assert.notEqual(after.seed, before.seed, 'a fresh seed');
  assert.equal(after.redraws, 1);
  assert.equal(after.candidates, 1);
  assert.deepEqual(JSON.parse(String(after.passed_user_ids)), [before.winner_user_id]);
  assert.equal(after.candidate_hash, await candidateHash([String(after.winner_user_id)]));
  assert.equal(audits(raw, 'care_draw.redraw'), 1);
  const detail = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'care_draw.redraw'")!.detail);
  assert.equal(detail.reason, 'He asked not to take part');
  assert.equal(detail.from.winner_user_id, before.winner_user_id);
  assert.equal(detail.from.seed, before.seed);

  const none = await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/redraw`, { reason: 'and another one' });
  assert.equal(none.status, 409);
  assert.equal((await json(none)).code, 'CARE_DRAW_NO_OTHER_CANDIDATE');
  assert.equal(drawRow(raw)!.redraws, 1, 'a refusal changes nothing');
});

test('«تخطّي هذا الشهر» needs a reason and ends the month without a prize; a skipped draw cannot be confirmed', async () => {
  const raw = world();
  device(raw, 'buyer');
  await runCareDrawJob(envOf(raw), DUE);
  const id = String(drawRow(raw)!.id);
  assert.equal((await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/skip`, {})).status, 400);
  const out = await json(await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/skip`, { reason: 'No stock for a prize' }));
  assert.equal(out.current.state, 'skipped');
  assert.equal(out.current.skip_reason, 'No stock for a prize');
  assert.equal(audits(raw, 'care_draw.skipped'), 1);
  const res = await confirm(raw, OWNER, id);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CARE_DRAW_NOT_PROPOSED');
  assert.equal(gifts(raw).length, 0);
});

// ------------------------------------------------------------------ confirming

test('confirming grants exactly one gift through the gifts’ writer, tells the winner, and a second or a concurrent press grants nothing more', async () => {
  const raw = world();
  device(raw, 'buyer');
  await runCareDrawJob(envOf(raw), DUE);
  const id = String(drawRow(raw)!.id);
  await read(raw); // the fixture publishes its products on the first request

  // TWO PRESSES AT ONCE. The second press has read the draw as «proposed» and built its own gift when the
  // first one commits: exactly what two tabs do. Its batch must write nothing and answer with the first gift.
  const real = asD1(raw);
  let rival: Awaited<ReturnType<typeof confirmCareDraw>> | null = null;
  const racing = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!rival) rival = await confirmCareDraw(envOf(raw), id, 'boss', { winnerSeen: undefined, prize: PRIZE, note: 'eSUN PLA+ black' });
      return real.batch(statements);
    },
  } as unknown as D1Database;
  const late = await confirmCareDraw({ ...envOf(raw), DB: racing } as Env, id, 'boss', { winnerSeen: undefined, prize: { ...PRIZE, qty: 3 }, note: '' });
  assert.equal(rival!.already, false, 'the first press confirmed it');
  assert.equal(late.already, true, 'the press that lost the race granted nothing');
  assert.equal(late.gift_id, rival!.gift_id, 'and answers with the gift already granted');

  const granted = gifts(raw);
  assert.equal(granted.length, 1, 'exactly one gift for the month');
  const g = granted[0];
  assert.deepEqual([g.user_id, g.grant_mode, g.reason, g.state, g.gift_product_id, g.granted_by], ['buyer', 'product', 'reward', 'ready_to_redeem', 'p_plain', 'boss']);
  const d = drawRow(raw)!;
  assert.deepEqual([d.state, d.gift_id, d.prize_product_id, d.confirmed_by], ['confirmed', g.id, 'p_plain', 'boss']);
  assert.equal(d.prize_qty, g.gift_qty, 'the row and the gift say the same quantity');
  assert.equal(audits(raw, 'care_draw.confirmed'), 1);
  assert.equal(audits(raw, 'gift.grant'), 1, 'the gifts’ own audit row');
  assert.equal(JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.grant'")!.detail).care_draw_id, id);

  const notes = all<{ kind: string; link: string; title_ar: string; meta: string }>(raw, "SELECT kind, link, title_ar, meta FROM user_notifications WHERE user_id = 'buyer'");
  assert.equal(notes.length, 1, 'one notice, not the gifts’ generic one beside it');
  assert.equal(notes[0].link, '/gifts');
  assert.match(notes[0].title_ar, /سحب ليفو كير/);
  assert.ok(JSON.parse(notes[0].meta).body_ckb);

  const staffView = await read(raw, FINANCE);
  assert.deepEqual(staffView.current.winner, { user_id: '', name: 'Sara Buyer', username: '', phone_tail: '', eligible: null, device: null }, 'a confirmed winner’s display name, nothing else');
  assert.equal(staffView.current.seed, '');
  assert.equal(staffView.current.gift_id, null);

  // Later presses: the same answer, still one gift.
  const later = await json(await confirm(raw, OWNER, id));
  assert.equal(later.already, true);
  assert.equal(later.gift_id, g.id);
  assert.equal(gifts(raw).length, 1);
  assert.equal(later.current.state, 'confirmed');
  assert.equal(later.current.prize.name.ar.length > 0, true);
  // The customer finds it among his gifts, to order for free.
  const mine = await json(await get(as(raw, BUYER), '/api/gifts'));
  assert.ok((mine.gifts as Array<{ id: string }>).some((x) => x.id === g.id));
  // And the month cannot be drawn again.
  assert.equal((await post(as(raw, OWNER), '/api/admin/rewards/care-draws/draw', {})).status, 409);
  assert.throws(() => raw.exec(`INSERT INTO care_draws (id, month, state, winner_user_id) VALUES ('x', '${MONTH}', 'proposed', 'other')`), /UNIQUE/, 'one row a month, by the schema itself');
  assert.throws(() => raw.exec(`INSERT INTO care_draws (id, month, state, winner_user_id, gift_id, prize_product_id, prize_qty) VALUES ('y', '1999-01', 'confirmed', 'other', '${g.id}', 'p_plain', 1)`), /UNIQUE/, 'one gift is the prize of one draw');
});

test('nothing about the winner or the prize is trusted from the request', async () => {
  const raw = world();
  device(raw, 'buyer');
  await runCareDrawJob(envOf(raw), DUE);
  const id = String(drawRow(raw)!.id);
  const wrong = await confirm(raw, OWNER, id, { prize: PRIZE, winner_user_id: 'other' });
  assert.equal(wrong.status, 409);
  assert.equal((await json(wrong)).code, 'CARE_DRAW_CHANGED', 'a name the server did not draw is refused, never adopted');
  for (const prize of [undefined, { ...PRIZE, qty: PRIZE_QTY_MAX + 1 }, { ...PRIZE, qty: 0 }, { ...PRIZE, productId: 'p_draft' }, { ...PRIZE, productId: 'nope' }, { ...PRIZE, productId: 'p_bundle' }]) {
    const res = await confirm(raw, OWNER, id, { prize });
    assert.equal(res.status, 400, JSON.stringify(prize));
    assert.equal((await json(res)).code, 'CARE_DRAW_PRIZE_INVALID');
  }
  assert.equal(gifts(raw).length, 0);
  assert.equal(drawRow(raw)!.state, 'proposed');
  const ok = await json(await confirm(raw, OWNER, id, { prize: PRIZE, winner_user_id: 'buyer' }));
  assert.equal(ok.already, false);
  assert.equal(gifts(raw)[0].user_id, 'buyer');
});

test('a winner whose Care ended or whose device came back since the pick is refused; drawing another name then works', async () => {
  const raw = world();
  const unit = device(raw, 'buyer');
  device(raw, 'other');
  await runCareDrawJob(envOf(raw), DUE);
  raw.prepare("UPDATE care_draws SET winner_user_id = 'buyer' WHERE month = ?").run(MONTH);
  const id = String(drawRow(raw)!.id);
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned' WHERE id = ?").run(iso(NOW - 1000), unit);

  assert.equal((await read(raw)).current.winner.eligible, false, 'the screen says so before the press');
  const res = await confirm(raw, OWNER, id);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CARE_DRAW_WINNER_INELIGIBLE');
  assert.equal(gifts(raw).length, 0);

  const out = await json(await post(as(raw, OWNER), `/api/admin/rewards/care-draws/${id}/redraw`, { reason: 'His printer was returned' }));
  assert.equal(out.current.winner.user_id, 'other');
  assert.equal((await json(await confirm(raw, OWNER, id))).already, false);
  assert.equal(gifts(raw)[0].user_id, 'other');
});

test('a winner rests for the next three draws while anyone else is in the draw, and is drawn again when he is alone', async () => {
  const prior = (raw: DatabaseSync, monthsAgo: number, winner: string) => {
    const d = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5)) - 1 - monthsAgo, 1));
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    raw.prepare("INSERT INTO care_draws (id, month, state, winner_user_id, gift_id, prize_product_id, prize_qty) VALUES (?, ?, 'confirmed', ?, ?, 'p_plain', 1)").run(`old${monthsAgo}`, m, winner, `gift_old_${monthsAgo}`);
  };
  for (let i = 0; i < 12; i++) {
    const raw = world();
    device(raw, 'buyer');
    device(raw, 'other');
    prior(raw, 3, 'buyer');
    const out = await runCareDrawJob(envOf(raw), DUE);
    assert.equal(out.candidates, 1, 'the resting winner is not a candidate');
    assert.equal(drawRow(raw)!.winner_user_id, 'other');
  }
  const far = world();
  device(far, 'buyer');
  device(far, 'other');
  prior(far, 4, 'buyer');
  assert.equal((await runCareDrawJob(envOf(far), DUE)).candidates, 2, 'four months later he is in again');

  const alone = world();
  device(alone, 'buyer');
  prior(alone, 1, 'buyer');
  assert.equal((await runCareDrawJob(envOf(alone), DUE)).outcome, 'proposed');
  assert.equal(drawRow(alone)!.winner_user_id, 'buyer', 'with nobody else, the month still has a winner');
});

// ------------------------------------------------------------------ the customer's perks

test('GET /api/devices/mine: care_perks says until when the weekly coupons run and whether he is this month’s CONFIRMED winner', async () => {
  const raw = world();
  const unit = device(raw, 'buyer', { daysAgo: 60, warranty: 24 });
  device(raw, 'other', { care: 0 });
  const mine = async (who: StubUser) => json(await get(as(raw, who), '/api/devices/mine'));

  let me = await mine(BUYER);
  assert.equal(me.success, true, JSON.stringify(me));
  const twelve = new Date(NOW - 60 * DAY);
  twelve.setUTCFullYear(twelve.getUTCFullYear() + 1);
  assert.equal(String(me.care_perks.weekly_coupons_until).slice(0, 10), twelve.toISOString().slice(0, 10), 'delivery + 12 months, though the Care runs 36');
  assert.equal(me.care_perks.weekly_coupons_by_unit[unit], me.care_perks.weekly_coupons_until);
  assert.deepEqual(me.care_perks.draw, { month: MONTH, won: false, prize: null, gift_id: null });
  assert.equal((await mine(OTHER)).care_perks, null, 'no Care, no perks');

  await runCareDrawJob(envOf(raw), DUE);
  me = await mine(BUYER);
  assert.equal(me.care_perks.draw.won, false, 'a proposed name is the owner’s business: the customer is told nothing');
  const id = String(drawRow(raw)!.id);
  const out = await json(await confirm(raw, OWNER, id));
  me = await mine(BUYER);
  assert.deepEqual(me.care_perks.draw, { month: MONTH, won: true, prize: { name: 'Nozzle cleaner', name_ar: me.care_perks.draw.prize.name_ar, name_ku: me.care_perks.draw.prize.name_ku, qty: 2 }, gift_id: out.gift_id });

  // A device someone else bought and gave him: its Care is his (the draw), its coupons are its buyer's (no date).
  const given = device(raw, 'buyer', { daysAgo: 30, warranty: 12, buyer: 'other' });
  me = await mine(BUYER);
  assert.equal(me.care_perks.weekly_coupons_by_unit[given], undefined, 'no coupon date for a device whose coupons he does not earn');
  assert.ok(me.care_perks.weekly_coupons_by_unit[unit], 'his own purchase keeps its date');
  assert.equal(me.care_perks.weekly_coupons_until, me.care_perks.weekly_coupons_by_unit[unit]);
  raw.prepare('DELETE FROM device_registrations WHERE unit_id = ?').run(unit);
  raw.prepare("UPDATE order_item_units SET owner_user_id = 'lana' WHERE id = ?").run(unit);
  me = await mine(BUYER);
  assert.equal(me.care_perks.weekly_coupons_until, null, 'only a given device left: Care and the draw, no coupon date');
  assert.deepEqual(me.care_perks.weekly_coupons_by_unit, {});
  assert.equal(me.care_perks.draw.won, true);
  raw.prepare("UPDATE order_item_units SET owner_user_id = 'buyer' WHERE id = ?").run(unit);
  raw.prepare("INSERT INTO device_registrations (unit_id, user_id) VALUES (?, 'buyer')").run(unit);

  // The weekly programme switched off: no date is promised.
  raw.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('rewardProgramConfig', ?)").run(JSON.stringify({ enabled: false }));
  me = await mine(BUYER);
  assert.equal(me.care_perks.weekly_coupons_until, null);
  assert.equal(me.care_perks.draw.won, true);
});

// ------------------------------------------------------------------ deploy-ahead, words

test('a database without 0244: the job writes nothing, the screens read as before and a write answers 503', async () => {
  const raw = world();
  device(raw, 'buyer');
  raw.exec('DROP TABLE care_draws');
  const out = await runCareDrawJob(envOf(raw), DUE);
  assert.equal(out.installed, false);
  const view = await read(raw);
  assert.equal(view.success, true);
  assert.equal(view.installed, false);
  assert.equal(view.current, null);
  const me = await json(await get(as(raw, BUYER), '/api/devices/mine'));
  assert.equal(me.success, true);
  assert.equal(me.care_perks.draw, null);
  assert.ok(me.care_perks.weekly_coupons_until);
  for (const path of ['/api/admin/rewards/care-draws/draw', '/api/admin/rewards/care-draws/x/confirm', '/api/admin/rewards/care-draws/x/redraw', '/api/admin/rewards/care-draws/x/skip']) {
    const res = await post(as(raw, OWNER), path, { prize: PRIZE, reason: 'a good reason' });
    assert.equal(res.status, 503, path);
    assert.equal((await json(res)).code, 'CARE_DRAW_NOT_INSTALLED');
  }
});

test('every refusal of the draw has its sentence in ar / en / ckb, on the server and on the screens, and the Sorani is its own', () => {
  for (const [code, t] of Object.entries(CARE_DRAW_REFUSALS)) {
    assert.ok(t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, `${code}: the Sorani is not the Arabic`);
    const screen = (REFUSAL_STRINGS as Record<string, { ar: string; en: string; ckb: string }>)[code];
    assert.ok(screen, `${code} is missing from src/lib/refusalStrings.ts`);
    assert.deepEqual(screen, t, `${code}: the screen says what the server says`);
  }
});

// ------------------------------------------------------------------ after the review of 2026-11-19

test('a prize bigger than the shelf is refused with what is available, and the picker’s read says the same before the press', async () => {
  const raw = world();
  device(raw, 'buyer');
  await runCareDrawJob(envOf(raw), DUE);
  const id = String(drawRow(raw)!.id);
  const check = async (qty: number) => json(await get(as(raw, OWNER), `/api/admin/rewards/care-draws/prize-check?productId=p_plain&saleType=direct_sale&qty=${qty}`));
  assert.deepEqual(await check(4), { success: true, valid: true, ok: false, available: 3, code: 'CARE_DRAW_PRIZE_OUT_OF_STOCK' });
  assert.deepEqual(await check(3), { success: true, valid: true, ok: true, available: 3, code: null });
  assert.equal((await json(await get(as(raw, OWNER), '/api/admin/rewards/care-draws/prize-check?productId=p_draft&qty=1'))).valid, false);

  const res = await confirm(raw, OWNER, id, { prize: { ...PRIZE, qty: 4 } });
  const out = await json(res);
  assert.equal(res.status, 409, JSON.stringify(out));
  assert.equal(out.code, 'CARE_DRAW_PRIZE_OUT_OF_STOCK');
  assert.equal(out.details.available, 3);
  assert.equal(out.details.requested, 4);
  assert.equal(gifts(raw).length, 0, 'nothing was granted');
  assert.equal(drawRow(raw)!.state, 'proposed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer'"), 0, 'and the winner was told nothing');

  // The shelf emptied since: even one unit is refused; refilled, the whole shelf may be the prize.
  raw.exec("UPDATE products SET stock = 0 WHERE id = 'p_plain'");
  assert.equal((await confirm(raw, OWNER, id, { prize: { ...PRIZE, qty: 1 } })).status, 409);
  raw.exec("UPDATE products SET stock = 3 WHERE id = 'p_plain'");
  assert.equal((await json(await confirm(raw, OWNER, id, { prize: { ...PRIZE, qty: 3 } }))).already, false);
  assert.equal(gifts(raw)[0].gift_qty, 3);
});

test('«إلغاء الجائزة»: a confirmed prize not yet redeemed is undone by the owner with a reason — the gift cancelled, the draw void, the winner told; a redeemed one is not', async () => {
  const raw = world();
  device(raw, 'buyer');
  await runCareDrawJob(envOf(raw), DUE);
  const id = String(drawRow(raw)!.id);
  const done = await json(await confirm(raw, OWNER, id));
  assert.equal((await read(raw)).current.can_void, true);
  const voidIt = (who: StubUser, body: Record<string, unknown>) => post(as(raw, who), `/api/admin/rewards/care-draws/${id}/void`, body);

  const noReason = await voidIt(OWNER, {});
  assert.equal(noReason.status, 400);
  assert.equal((await json(noReason)).code, 'CARE_DRAW_REASON_REQUIRED');
  assert.equal((await voidIt(FINANCE, { reason: 'wrong prize chosen' })).status, 403);
  assert.equal(drawRow(raw)!.state, 'confirmed');

  const out = await json(await voidIt(OWNER, { reason: 'wrong prize chosen' }));
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.current.state, 'void');
  assert.equal(out.current.can_void, false);
  const d = drawRow(raw)!;
  assert.deepEqual([d.state, d.skip_reason, d.gift_id], ['void', 'wrong prize chosen', done.gift_id]);
  const g = gifts(raw)[0];
  assert.deepEqual([g.state, g.cancelled_by], ['cancelled', 'boss'], 'the gift went through the gifts’ own cancel');
  assert.equal(audits(raw, 'care_draw.voided'), 1);
  assert.equal(audits(raw, 'gift.cancel'), 1);
  const note = row<{ title_ar: string; meta: string }>(raw, "SELECT title_ar, meta FROM user_notifications WHERE event_key LIKE 'care_draw:voided:%'")!;
  assert.match(note.title_ar, /أُلغيت جائزة/);
  assert.ok(JSON.parse(note.meta).body_ckb);
  const me = await json(await get(as(raw, BUYER), '/api/devices/mine'));
  assert.equal(me.care_perks.draw.won, false, 'the customer no longer reads a win');
  assert.ok(!(await json(await get(as(raw, BUYER), '/api/gifts'))).gifts.some((x: { id: string; status: string }) => x.id === g.id && x.status !== 'CANCELLED'));

  const again = await voidIt(OWNER, { reason: 'once more please' });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'CARE_DRAW_NOT_CONFIRMED');
  // The month keeps its row: no second prize, no second draw.
  assert.equal((await post(as(raw, OWNER), '/api/admin/rewards/care-draws/draw', {})).status, 409);
  assert.equal((await confirm(raw, OWNER, id)).status, 409);
  assert.equal(gifts(raw).length, 1);

  // A prize the winner already redeemed is his: not taken back from here.
  const other = world();
  device(other, 'buyer');
  await runCareDrawJob(envOf(other), DUE);
  const id2 = String(row<{ id: string }>(other, 'SELECT id FROM care_draws')!.id);
  const gift2 = (await json(await confirm(other, OWNER, id2))).gift_id;
  other.prepare("UPDATE gift_entitlements SET state = 'redeemed', redeemed_at = ? WHERE id = ?").run(iso(NOW), gift2);
  assert.equal((await read(other)).current.can_void, false);
  const refused = await post(as(other, OWNER), `/api/admin/rewards/care-draws/${id2}/void`, { reason: 'too late for this' });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'CARE_DRAW_PRIZE_REDEEMED');
  assert.equal(row<{ state: string }>(other, 'SELECT state FROM care_draws')!.state, 'confirmed');
  assert.equal(row<{ state: string }>(other, 'SELECT state FROM gift_entitlements WHERE id = ?', gift2)!.state, 'redeemed');
});

test('a proposal lives only inside its own month: an old one cannot be confirmed or redrawn, and the next month’s draw closes it with its reason', async () => {
  const raw = world();
  device(raw, 'buyer');
  device(raw, 'other');
  const d = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5)) - 2, 1));
  const last = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  raw.prepare("INSERT INTO care_draws (id, month, state, candidates, candidate_hash, seed, winner_user_id, proposed_at) VALUES ('old', ?, 'proposed', 2, 'h', 'oldseed', 'buyer', ?)").run(last, iso(NOW - 20 * DAY));

  // The owner's screen shows the current month only; the API agrees.
  const view = await read(raw);
  assert.equal(view.current, null);
  assert.equal(view.history[0].state, 'proposed');
  const late = await confirm(raw, OWNER, 'old');
  assert.equal(late.status, 409);
  const body = await json(late);
  assert.equal(body.code, 'CARE_DRAW_MONTH_PASSED');
  assert.deepEqual(body.details, { month: last, current_month: MONTH });
  const redraw = await post(as(raw, OWNER), '/api/admin/rewards/care-draws/old/redraw', { reason: 'another name please' });
  assert.equal((await json(redraw)).code, 'CARE_DRAW_MONTH_PASSED');
  assert.equal(gifts(raw).length, 0);

  // This month's draw closes it, in its own batch, audited.
  const out = await runCareDrawJob(envOf(raw), DUE);
  assert.equal(out.outcome, 'proposed');
  const old = row<Record<string, unknown>>(raw, "SELECT * FROM care_draws WHERE id = 'old'")!;
  assert.deepEqual([old.state, old.skip_reason], ['skipped', 'not_confirmed_in_time']);
  const closed = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'care_draw.skipped' AND target = 'old'")!.detail);
  assert.deepEqual([closed.reason, closed.closed_by_month, closed.by], ['not_confirmed_in_time', MONTH, 'job']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM care_draws WHERE state = 'proposed'"), 1, 'one live proposal at a time');
  const now = await read(raw);
  assert.equal(now.history[0].skip_reason, 'not_confirmed_in_time', 'the history says why in a word the screen translates');
  const stale = await confirm(raw, OWNER, 'old');
  assert.equal((await json(stale)).code, 'CARE_DRAW_NOT_PROPOSED');

  // Only this month is ever confirmed: one customer cannot hold two months' prizes from one stale screen.
  assert.equal((await json(await confirm(raw, OWNER, String(drawRow(raw)!.id)))).already, false);
  assert.equal(gifts(raw).length, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM care_draws WHERE state = 'confirmed'"), 1);
});
