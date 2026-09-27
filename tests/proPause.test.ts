/**
 * PRO, PAUSED — migration 0145 and worker/lib/tierPause.ts.
 *
 * «أوقف اشتراك PRO فقط … يظهر (قريبًا… يتم العمل على تطوير النظام) … وأي شخص
 * مشترك سابقًا … (صيانة في اشتراك البرو، لا تقلق لم يتم استقطاع أيامك من
 * الاشتراك) … وتعليق لمن لديه الاشتراك إلى إشعار آخر وإخفاء سعر البرو»
 * (owner, 2026-09-27).
 *
 * What is proven here:
 *   - the migration pauses the sale and freezes every RUNNING PRO membership,
 *     and never an expired one, a PLUS one, or anyone once the owner resumed;
 *   - while paused no PRO price leaves the server (/plans, /quote) and no PRO
 *     card is quoted, bought or granted (`PRO_PAUSED`), with nothing written;
 *   - a frozen member acts as PREMIUM (never PRO, never nothing), never
 *     expires while frozen, and keeps every remaining day;
 *   - resuming pushes each expiry forward by exactly the time it was frozen,
 *     in bulk (the admin's switch) or lazily (a row the bulk missed) — once.
 *
 * Real schema (every migration, in order).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { classifyHost } from '../worker/lib/hosts';
import { membershipsRoutes } from '../worker/routes/memberships';
import { getTierStatus, hasEntitlement, membershipBadges, usersWithEntitlement } from '../worker/lib/entitlements';
import { multiplierSql, rewardMultiplierX100, tierNameSql } from '../worker/lib/pointsMultiplier';
import { frozenRemainingDays, parseProPause, PRO_PAUSE_DEFAULT } from '../worker/lib/tierPause';

const DAY = 86_400_000;
const MIGRATIONS = join(ROOT, 'migrations');
const MIGRATION = '0145_membership_restructure.sql';
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const iso = (ms: number) => new Date(ms).toISOString();

function migrate(raw: DatabaseSync, filter: (f: string) => boolean) {
  for (const f of files().filter(filter)) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  migrate(raw, () => true);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('u1','Sara','s@x.co','h'), ('u2','Omar','o@x.co','h'), ('boss','Admin','ad@x.co','h');
  `);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','{"activated":true}')`);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function addMembership(
  raw: DatabaseSync,
  id: string,
  user: string,
  tier: 'plus' | 'prime' | 'pro',
  expiresAt: string,
  extra: { state?: string; paused_at?: string | null } = {}
) {
  const plan = tier === 'pro' ? 'pro_12mo' : tier === 'prime' ? 'prime_12mo' : 'plus_12mo';
  raw
    .prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source)
       VALUES (?, ?, ?, ?, ?, 12, 0, ?, ?, 'admin')`
    )
    .run(id, user, plan, tier, extra.state ?? 'active', iso(Date.now() - 200 * DAY), expiresAt);
  if (extra.paused_at !== undefined) raw.prepare('UPDATE memberships SET paused_at = ? WHERE id = ?').run(extra.paused_at, id);
}

const membership = (raw: DatabaseSync, id: string) =>
  raw.prepare('SELECT * FROM memberships WHERE id = ?').get(id) as Record<string, string | number | null>;
const pauseSetting = (raw: DatabaseSync) =>
  parseProPause((raw.prepare(`SELECT value FROM admin_settings WHERE key = 'proPause'`).get() as { value: string } | undefined)?.value);

function app(db: D1Database, userId: string | null, role = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, created_at: new Date().toISOString() } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}
type App = ReturnType<typeof app>;
const post = (a: App, path: string, body: Record<string, unknown>) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

// ------------------------------------------------------------ the migration

test('0145 pauses the sale and freezes every RUNNING PRO membership — nobody else', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  migrate(raw, (f) => f < MIGRATION);
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES
    ('a','A','a@x.co','h'), ('b','B','b@x.co','h'), ('c','C','c@x.co','h'), ('d','D','d@x.co','h')`);
  const soon = iso(Date.now() + 100 * DAY);
  raw
    .prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, starts_at, expires_at) VALUES
        ('running', 'a', 'pro_12mo', 'pro', 'active', 12, ?1, ?2),
        ('ran_out', 'b', 'pro_12mo', 'pro', 'expired', 12, ?1, ?3),
        ('overdue', 'c', 'pro_12mo', 'pro', 'active', 12, ?1, ?3),
        ('plus', 'd', 'plus_12mo', 'plus', 'active', 12, ?1, ?2)`
    )
    .run(iso(Date.now() - 200 * DAY), soon, iso(Date.now() - DAY));
  migrate(raw, (f) => f === MIGRATION);

  const pause = pauseSetting(raw);
  assert.equal(pause.paused, true, 'the migration pauses PRO');
  assert.ok(pause.since && Number.isFinite(Date.parse(pause.since)), 'and says since when');

  const running = membership(raw, 'running');
  assert.ok(running.paused_at, 'a running PRO membership is frozen');
  assert.equal(running.expires_at, soon, 'its end date is kept as it was — the resume moves it, not the freeze');
  assert.equal(running.state, 'active');
  assert.equal(membership(raw, 'ran_out').paused_at, null, 'an expired one is not revived');
  assert.equal(membership(raw, 'overdue').paused_at, null, 'one already past its end is not revived either');
  assert.equal(membership(raw, 'plus').paused_at, null, 'PLUS is not touched');
});

test('a replay of 0145 after the owner resumed PRO pauses and freezes nobody', () => {
  const { raw } = setup();
  raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);
  addMembership(raw, 'm1', 'u1', 'pro', iso(Date.now() + 30 * DAY));

  // The two statements of the migration that decide the pause, as written.
  const sql = readFileSync(join(MIGRATIONS, MIGRATION), 'utf8');
  const insert = sql.match(/INSERT INTO admin_settings \(key, value\)\s+SELECT 'proPause'[\s\S]*?;/)?.[0];
  const freeze = sql.match(/UPDATE memberships\s+SET paused_at[\s\S]*?;/)?.[0];
  assert.ok(insert && freeze, 'the migration still carries both statements');
  raw.exec(insert);
  raw.exec(freeze);

  assert.equal(pauseSetting(raw).paused, false, 'the owner’s resume stands');
  assert.equal(membership(raw, 'm1').paused_at, null, 'and no member is frozen again');
});

// ------------------------------------------------------------- the sale stops

test('/plans shows PRO as «coming soon»: no price, no per-month, no benefits — the others unchanged', async () => {
  const { db } = setup();
  const res = await app(db, null).request('/api/memberships/plans');
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  const plans = body.plans as Array<Record<string, unknown>>;

  const pro = plans.find((p) => p.tier === 'pro')!;
  assert.equal(pro.paused, true);
  assert.equal(pro.price_iqd, null, 'no PRO price leaves the server');
  assert.equal(pro.per_month_iqd, null);
  assert.equal(pro.purchasable, false);
  assert.doesNotMatch(text, /499000/, 'not anywhere in the payload');
  assert.deepEqual((body.pro_pause as Record<string, unknown>).paused, true);
  assert.equal((body.benefits as Record<string, unknown>).pro, null, '«إخفاء المميزات وكتابة فقط قريبًا»');

  for (const p of plans.filter((x) => x.tier !== 'pro')) {
    assert.equal(p.paused, false, `${p.id} is on sale`);
    assert.equal(p.purchasable, true, `${p.id} is on sale`);
  }
});

test('a PRO card is not quoted, bought or granted while PRO is paused — and nothing is written', async () => {
  const { db, raw } = setup();
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES ('seed', 'u1', 'deposit', 'USD', 1000000, 'approved', 'seed', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run();
  const customer = app(db, 'u1');

  const quote = (await json(await customer.request('/api/memberships/quote?planId=pro_12mo'))).quote as Record<string, unknown>;
  assert.equal(quote.ok, false);
  assert.equal(quote.code, 'PRO_PAUSED');
  assert.equal((quote.plan as Record<string, unknown>).price_iqd, null, 'not even inside the refusal');

  const bought = await post(customer, '/api/memberships/subscribe', { planId: 'pro_12mo', idempotencyKey: 'buy-pro-1' });
  assert.equal(bought.status, 400);
  assert.equal((await json(bought)).code, 'PRO_PAUSED');

  const granted = await post(app(db, 'boss', 'admin'), '/api/memberships/admin/grant', {
    userId: 'u2',
    planId: 'pro_12mo',
    reason: 'a comped PRO card',
    idempotencyKey: 'grant-pro-1',
  });
  assert.equal(granted.status, 400);
  assert.equal((await json(granted)).code, 'PRO_PAUSED');

  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }).n, 0, 'no membership written');
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type = 'withdrawal'").get() as { n: number }).n,
    0,
    'no wallet charged'
  );

  // PLUS and PREMIUM are still sold.
  const plus = (await json(await customer.request('/api/memberships/quote?planId=prime_1mo'))).quote as Record<string, unknown>;
  assert.equal(plus.ok, true);
});

// ------------------------------------------------------ the frozen member

test('a frozen PRO member acts as PREMIUM: its delivery and badge, never a PRO benefit', async () => {
  const { db, raw } = setup();
  addMembership(raw, 'm1', 'u1', 'pro', iso(Date.now() + 165 * DAY));

  // The row became PRO before anyone froze it: the first read freezes it.
  const status = await getTierStatus(db, 'u1');
  assert.ok(membership(raw, 'm1').paused_at, 'frozen on read while PRO is paused');
  assert.equal(status.tier, 'prime');
  assert.equal(status.active, true);
  assert.equal(status.expires_at, null, 'a frozen clock has no end date');
  assert.equal(status.paused?.tier, 'pro');
  assert.equal(status.paused?.remaining_days, 165);

  for (const kept of ['exclusiveSections', 'premiumDelivery', 'premiumBadge'] as const) {
    assert.equal(hasEntitlement(status, kept), true, `${kept} is kept while frozen`);
  }
  for (const gone of ['proPricing', 'freeDelivery', 'priorityService', 'proMerchantBadge', 'premiumPricing', 'premiumRewards', 'codTaxExemption'] as const) {
    assert.equal(hasEntitlement(status, gone), false, `${gone} waits for the resume`);
  }

  // ×1 — and the SQL the check-in awards with says the same.
  assert.equal(rewardMultiplierX100(status), 100);
  const now = iso(Date.now());
  const sql = raw.prepare(`SELECT ${multiplierSql("'u1'", '?')} AS m, ${tierNameSql("'u1'", '?')} AS t`).get(now, now) as { m: number; t: string };
  assert.equal(sql.m, 100);
  assert.equal(sql.t, 'prime');

  // The community shows PREMIUM's mark, not PRO's.
  const badges = await membershipBadges(db, ['u1']);
  assert.equal(badges.pro.has('u1'), false);
  assert.equal(badges.premium.has('u1'), true);
});

test('a frozen membership never expires while it waits, and keeps every day it had', async () => {
  const { db, raw } = setup();
  // Frozen 30 days ago with 10 days left: its old end date is 20 days behind us.
  addMembership(raw, 'm1', 'u1', 'pro', iso(Date.now() - 20 * DAY), { paused_at: iso(Date.now() - 30 * DAY) });

  const status = await getTierStatus(db, 'u1');
  assert.equal(membership(raw, 'm1').state, 'active', 'the lazy expiry skips a frozen row');
  assert.equal(status.active, true);
  assert.equal(status.paused?.remaining_days, 10);

  // The bulk reader's sweep skips it too.
  assert.equal((await usersWithEntitlement(db, ['u1'], 'premiumBadge')).has('u1'), true);
  assert.equal(membership(raw, 'm1').state, 'active');

  // GET /mine tells the member, in the status their page reads.
  const mine = await json(await app(db, 'u1').request('/api/memberships/mine'));
  const paused = (mine.status as Record<string, unknown>).paused as Record<string, unknown>;
  assert.equal(paused.tier, 'pro');
  assert.equal(paused.remaining_days, 10);
  const rows = mine.memberships as Array<Record<string, unknown>>;
  assert.ok(rows[0].paused_at, 'the ledger row says it is frozen');
});

// ------------------------------------------------------------- the resume

test('the admin’s resume thaws each frozen card forward by exactly the time it was frozen', async () => {
  const { db, raw } = setup();
  const frozenAt = Date.now() - 30 * DAY;
  addMembership(raw, 'm1', 'u1', 'pro', iso(frozenAt + 10 * DAY), { paused_at: iso(frozenAt) });
  const admin = app(db, 'boss', 'admin');

  const unconfirmed = await post(admin, '/api/memberships/admin/pro-pause', { paused: false });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await json(unconfirmed)).code, 'CONFIRMATION_REQUIRED');
  assert.equal(pauseSetting(raw).paused, true, 'nothing changed without the typed confirmation');

  const before = Date.now();
  const res = await post(admin, '/api/memberships/admin/pro-pause', { paused: false, confirm: 'RESUME' });
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.equal((await json(res)).memberships, 1);
  assert.equal(pauseSetting(raw).paused, false);

  const row = membership(raw, 'm1');
  assert.equal(row.paused_at, null);
  // Ten days were left at the freeze; ten days are left now.
  const end = Date.parse(row.expires_at as string);
  assert.ok(end >= before + 10 * DAY - 5 && end <= after + 10 * DAY + 5, `expiry ${row.expires_at} is ten days from the resume`);

  const status = await getTierStatus(db, 'u1');
  assert.equal(status.tier, 'pro', 'PRO again, with every PRO benefit');
  assert.equal(status.paused, null);
  assert.equal(status.expires_at, row.expires_at);
  assert.equal(hasEntitlement(status, 'proPricing'), true);
  assert.equal(rewardMultiplierX100(status), 200);

  const audit = raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'membership.pro_%'").all() as Array<{ action: string }>;
  assert.deepEqual(audit.map((a) => a.action), ['membership.pro_resume']);

  // And the sale is open again.
  const plans = (await json(await app(db, null).request('/api/memberships/plans'))).plans as Array<Record<string, unknown>>;
  const pro = plans.find((p) => p.tier === 'pro')!;
  assert.equal(pro.paused, false);
  assert.equal(pro.price_iqd, 499000);
});

test('pausing again freezes what runs, keeps its first moment, and is idempotent', async () => {
  const { db, raw } = setup();
  raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);
  addMembership(raw, 'm1', 'u1', 'pro', iso(Date.now() + 40 * DAY));
  const admin = app(db, 'boss', 'admin');

  const first = await json(await post(admin, '/api/memberships/admin/pro-pause', { paused: true, confirm: 'PAUSE' }));
  assert.equal(first.memberships, 1);
  const since = pauseSetting(raw).since;
  const pausedAt = membership(raw, 'm1').paused_at;
  assert.ok(since && pausedAt);

  const second = await json(await post(admin, '/api/memberships/admin/pro-pause', { paused: true, confirm: 'PAUSE' }));
  assert.equal(second.memberships, 0, 'nothing new to freeze');
  assert.equal(pauseSetting(raw).since, since, 'the pause keeps the moment it began');
  assert.equal(membership(raw, 'm1').paused_at, pausedAt, 'a frozen row keeps its own moment');

  const listing = await json(await admin.request('/api/memberships/admin/plans'));
  assert.deepEqual((listing.pro_pause as Record<string, unknown>).frozen_count, 1);
  const pro = (listing.plans as Array<Record<string, unknown>>).find((p) => p.tier === 'pro')!;
  assert.equal(pro.paused, true);
  assert.equal(pro.price_iqd, 499000, 'the admin still sees the stored price');
});

test('a row the bulk resume missed is thawed on its next read — exactly once', async () => {
  const { db, raw } = setup();
  const frozenAt = Date.now() - 12 * DAY;
  const oldEnd = frozenAt + 5 * DAY;
  addMembership(raw, 'm1', 'u1', 'pro', iso(oldEnd), { paused_at: iso(frozenAt) });
  // The switch is lifted by hand, without the bulk statement.
  raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);

  const first = await getTierStatus(db, 'u1');
  const thawed = membership(raw, 'm1');
  assert.equal(thawed.paused_at, null);
  assert.equal(first.tier, 'pro');
  const moved = Date.parse(thawed.expires_at as string) - oldEnd;
  assert.ok(moved >= 12 * DAY - 1000 && moved <= 12 * DAY + 60_000, `moved forward by the twelve frozen days (${moved} ms)`);

  await getTierStatus(db, 'u1');
  assert.equal(membership(raw, 'm1').expires_at, thawed.expires_at, 'a second read moves nothing');
});

// ------------------------------------------------------------- the helpers

test('the stored switch is read tolerantly, and the days left are whole and never negative', () => {
  assert.deepEqual(parseProPause(null), PRO_PAUSE_DEFAULT);
  assert.deepEqual(parseProPause('not json'), PRO_PAUSE_DEFAULT);
  assert.deepEqual(parseProPause('{"paused":"yes"}'), PRO_PAUSE_DEFAULT, 'only a real true pauses');
  assert.deepEqual(parseProPause('{"paused":true,"since":"2026-09-27T00:00:00.000Z"}'), {
    paused: true,
    since: '2026-09-27T00:00:00.000Z',
  });
  assert.deepEqual(parseProPause({ paused: false, since: '2026-09-27T00:00:00.000Z' }), { paused: false, since: null });

  assert.equal(frozenRemainingDays(null, '2026-10-01T00:00:00.000Z'), null);
  assert.equal(frozenRemainingDays('2026-09-27T00:00:00.000Z', '2026-10-07T00:00:00.000Z'), 10);
  assert.equal(frozenRemainingDays('2026-09-27T00:00:00.000Z', '2026-10-07T00:00:01.000Z'), 11, 'a started day counts');
  assert.equal(frozenRemainingDays('2026-09-27T00:00:00.000Z', '2026-09-20T00:00:00.000Z'), 0);
});

test('a Worker ahead of its database: the admin panel still loads, and the switch refuses whole — nothing half-paused', async () => {
  // Every migration BEFORE 0145: the code of this change on the database it replaces.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  migrate(raw, (f) => f < MIGRATION);
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h'), ('boss','Admin','ad@x.co','h')`);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('launchConfig','{"activated":true}')`);
  const db = new SqliteD1(raw) as unknown as D1Database;
  const admin = app(db, 'boss', 'admin');

  const listing = await admin.request('/api/memberships/admin/plans');
  assert.equal(listing.status, 200, 'the plans panel does not fail on the missing column');
  assert.equal(((await json(listing)).pro_pause as Record<string, unknown>).frozen_count, 0);

  const refused = await post(admin, '/api/memberships/admin/pro-pause', { paused: true, confirm: 'PAUSE' });
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'SCHEMA_PENDING');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'proPause'`).get()?.n, 0, 'no «paused» stored over running members');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership.pro_%'`).get()?.n, 0);
});
