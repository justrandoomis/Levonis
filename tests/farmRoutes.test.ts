/**
 * LEVO Printer Farm — the player API, tested as the promises the game rests on.
 *
 *   * the server is the game: every coin, gram, printer state and job state
 *     moves in a route over real migrations, on the server clock — a request
 *     body's timestamps are ignored, and time only "passes" in these tests by
 *     rewriting rows into the past the way the real clock would;
 *   * the balance is SUM(farm_ledger) and the trigger refuses an overdraft;
 *   * every mutation is idempotent: a replayed key pays nothing extra;
 *   * inventory never goes negative, a printer prints one batch at a time,
 *     a job's parts cannot be double-booked;
 *   * the bootstrap runs once; the leaderboard exposes no ids or emails; a
 *     player cannot touch another player's farm.
 *
 * The real routes run against real migrations through the SQLite adapter;
 * only the session is stubbed.
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
import { FARM_SHELVED_SETTING_KEY, farmRoutes } from '../worker/routes/farm';
import { FARM_CONFIG_DEFAULTS } from '../worker/lib/farm/config';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,avatar_key) VALUES
      ('u1','Sara','sara@x.co','h','customer','sara','av/sara.png'),
      ('u2','Omar','omar@x.co','h','customer','omar',NULL),
      ('boss','Admin','a@x.co','h','admin','boss',NULL);
  `);
  // THE GAME IS OPEN FOR THIS SUITE. The Printer Farm ships SHELVED — with no
  // `printerFarmShelved` row every player route answers 503 FARM_SHELVED
  // (worker/routes/farm.ts) — and everything below is the game as it is
  // PLAYED, so the switch is turned on here, through the same row an admin
  // writes. tests/farmShelved.test.ts owns the closed half.
  raw.exec(`INSERT INTO admin_settings (key,value) VALUES ('${FARM_SHELVED_SETTING_KEY}','{"open":true}')`);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const USERNAMES: Record<string, string> = { u1: 'sara', u2: 'omar', boss: 'boss' };

function appAs(db: D1Database, userId: string | null, role = 'customer', host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, email: `${userId}@x.co`, username: USERNAMES[userId] ?? userId } as never);
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/farm', farmRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
    }
    throw err;
  });
  return a;
}
type App = ReturnType<typeof appAs>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
let keyN = 0;
const key = () => `farmkey-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;
const post = (a: App, path: string, body: Record<string, unknown> = {}) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ idempotencyKey: key(), ...body }),
  });
const state = async (a: App) => json(await a.request('/api/farm/state'));
const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sum = (raw: DatabaseSync, user = 'u1') =>
  (raw.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM farm_ledger WHERE user_id = ?').get(user) as { s: number }).s;
const count = (raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).get(...(params as never[])) as { n: number }).n;

/** Accept the starter job, assign it to the starter printer on the starter spool. */
async function acceptAndAssign(a: App, s: Record<string, unknown>, jobId?: string) {
  const st = s as { jobs: { offered: Array<{ id: string }> }; printers: Array<{ id: string }>; spools: Array<{ id: string }> };
  const id = jobId ?? st.jobs.offered.find((j) => j.id.startsWith('fjob_first_'))!.id;
  const acc = await json(await post(a, `/api/farm/jobs/${id}/accept`));
  assert.equal(acc.success, true, JSON.stringify(acc));
  const job = acc.jobs.active.find((j: { id: string }) => j.id === id);
  const asg = await json(await post(a, `/api/farm/jobs/${id}/assign`, {
    allocations: [{ printer_id: st.printers[0].id, qty: job.qty, spool_id: st.spools[0].id }],
  }));
  assert.equal(asg.success, true, JSON.stringify(asg));
  return { id, job, asg };
}

// ------------------------------------------------------------------ auth + bootstrap

test('signed-out: /state is 401, the leaderboard is public', async () => {
  const { db } = setup();
  const guest = appAs(db, null);
  assert.equal((await guest.request('/api/farm/state')).status, 401);
  const lb = await guest.request('/api/farm/leaderboard');
  assert.equal(lb.status, 200);
  assert.equal(lb.headers.get('cache-control'), 'public, max-age=60');
});

test('the first /state creates the starter kit once; a second /state creates nothing more', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s1 = await state(a);
  assert.equal(s1.success, true);
  assert.equal(s1.profile.coins, FARM_CONFIG_DEFAULTS.economy.starter_coins);
  assert.equal(s1.profile.coins, sum(raw));
  assert.equal(s1.profile.level, 1);
  assert.equal(s1.profile.location.key, 'tiny_room');
  assert.equal(s1.printers.length, 1);
  assert.equal(s1.printers[0].model_key, 'a1_mini');
  assert.equal(s1.printers[0].slot, 0);
  assert.equal(s1.printers[0].state, 'idle');
  assert.equal(s1.spools.length, 1);
  assert.equal(s1.spools[0].material, 'PLA');
  assert.equal(s1.spools[0].grams_left, 500);
  assert.equal(s1.jobs.offered.length, FARM_CONFIG_DEFAULTS.jobs.offers_visible);
  assert.ok(s1.jobs.offered.some((j: { id: string }) => j.id === 'fjob_first_u1'));
  const first = s1.jobs.offered.find((j: { id: string }) => j.id === 'fjob_first_u1');
  assert.equal(first.product_key, 'keychain');
  assert.equal(first.qty, 2);
  assert.equal(first.title.en, 'Keychain');
  assert.ok(first.reward_coins > 0);
  assert.equal(s1.unlocks.market, true);
  assert.equal(s1.unlocks.maintenance, false, 'maintenance unlocks at level 2');
  assert.equal(s1.unlocks.store, false, 'store is not built in phase 1 — locked, not lied about');
  assert.ok(s1.config && s1.config.printers && !('limits' in s1.config) && !('rewards' in s1.config));
  assert.equal(s1.config_version, 0);

  const before = {
    ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'),
    printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'),
    spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'),
    jobs: count(raw, 'SELECT COUNT(*) AS n FROM farm_jobs'),
  };
  const s2 = await state(a);
  assert.equal(s2.profile.coins, s1.profile.coins);
  assert.deepEqual(
    {
      ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'),
      printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'),
      spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'),
      jobs: count(raw, 'SELECT COUNT(*) AS n FROM farm_jobs'),
    },
    before
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'starter'"), 1);
  // ?config=0 keeps the poll light
  const slim = await json(await a.request('/api/farm/state?config=0'));
  assert.equal('config' in slim, false);
});

test('GET /config carries an ETag and answers 304 to a matching If-None-Match', async () => {
  const { db } = setup();
  const a = appAs(db, 'u1');
  const r = await a.request('/api/farm/config');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), '"farm-v0"');
  const body = await json(r);
  assert.equal(body.version, 0);
  assert.equal('limits' in body.config, false);
  const r2 = await a.request('/api/farm/config', { headers: { 'If-None-Match': '"farm-v0"' } });
  assert.equal(r2.status, 304);
});

// ------------------------------------------------------------------ jobs

test('a mutation without an idempotency key is refused; accepting twice is a 409', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const id = s.jobs.offered[0].id;
  const bare = await a.request(`/api/farm/jobs/${id}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bare.status, 400);
  const first = await post(a, `/api/farm/jobs/${id}/accept`);
  assert.equal(first.status, 200);
  const again = await post(a, `/api/farm/jobs/${id}/accept`);
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'JOB_NOT_OFFERED');
  // An expired offer says so — even though the resolver closed it before the
  // handler looked, and a stranger's job is simply not found.
  const other = s.jobs.offered[1].id;
  raw.prepare('UPDATE farm_jobs SET offer_expires_at = ? WHERE id = ?').run(past(1), other);
  const exp = await post(a, `/api/farm/jobs/${other}/accept`);
  assert.equal(exp.status, 409);
  assert.equal((await json(exp)).code, 'OFFER_EXPIRED');
});

test('the active-job cap holds; rejecting an offer closes it', async () => {
  const { db } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const [j1, j2, j3] = s.jobs.offered.map((j: { id: string }) => j.id);
  assert.equal((await post(a, `/api/farm/jobs/${j1}/accept`)).status, 200);
  assert.equal((await post(a, `/api/farm/jobs/${j2}/accept`)).status, 200);
  const third = await post(a, `/api/farm/jobs/${j3}/accept`);
  assert.equal(third.status, 409);
  assert.equal((await json(third)).code, 'TOO_MANY_ACTIVE_JOBS');
  const rej = await json(await post(a, `/api/farm/jobs/${j3}/reject`));
  assert.equal(rej.success, true);
  assert.equal(rej.jobs.offered.length, 0);
});

test('assign validates compatibility, grams and quantity, reserves grams, and starts an idle printer', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const id = 'fjob_first_u1';
  await post(a, `/api/farm/jobs/${id}/accept`);
  const printer = s.printers[0].id;
  const spool = s.spools[0].id;
  raw.exec(`INSERT INTO farm_spools (id,user_id,material,color,grams_left,grams_total,quality) VALUES
    ('sp_petg','u1','PETG','black',500,500,0.9), ('sp_tiny','u1','PLA','black',5,500,0.9), ('sp_red','u1','PLA','red',500,500,0.9)`);

  const mismatch = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: 'sp_petg' }] }));
  assert.equal(mismatch.code, 'SPOOL_MISMATCH');
  const wrongColor = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: 'sp_red' }] }));
  assert.equal(wrongColor.code, 'SPOOL_MISMATCH');
  const tiny = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: 'sp_tiny' }] }));
  assert.equal(tiny.code, 'SPOOL_INSUFFICIENT');
  const qty = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 1, spool_id: spool }] }));
  assert.equal(qty.code, 'QTY_MISMATCH');
  const over = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 3, spool_id: spool }] }));
  assert.equal(over.code, 'QTY_MISMATCH');
  const ghost = await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: 'nope', qty: 2, spool_id: spool }] });
  assert.equal(ghost.status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_assignments'), 0, 'nothing was written by refused assigns');
  assert.equal((raw.prepare('SELECT grams_left FROM farm_spools WHERE id = ?').get(spool) as { grams_left: number }).grams_left, 500);

  const ok = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: spool }] }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.assignments.length, 1);
  assert.equal(ok.assignments[0].started, true);
  assert.equal(ok.assignments[0].seconds, 3000, 'keychain 1500 s × 2 on the reference machine at standard');
  const p = ok.printers[0];
  assert.equal(p.state, 'printing');
  assert.equal(p.current.assignment_id, ok.assignments[0].assignment_id);
  const realMs = Date.parse(p.current.ends_at) - Date.parse(p.current.started_at);
  assert.equal(realMs, 150_000, '3000 game seconds at time_scale 20 = 150 real seconds');
  assert.equal(ok.spools.find((x: { id: string }) => x.id === spool).grams_left, 476, '12 g × 2 reserved');
  const job = ok.jobs.active.find((j: { id: string }) => j.id === id);
  assert.equal(job.state, 'printing');
  assert.deepEqual(job.assignments_summary, { assigned: 2, queued: 0, printing: 2, done: 0, collected: 0, failed: 0, remaining: 0 });
  // Server-side reservation: grams_left can never go below zero.
  assert.throws(() => raw.exec(`UPDATE farm_spools SET grams_left = grams_left - 1000 WHERE id = '${spool}'`), /grams_left/);
});

test('a printer takes one printing batch at a time — the second assignment queues; the queue can be reordered', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  const spool = s.spools[0].id;
  await acceptAndAssign(a, s);
  // A second PLA job for the same printer — carve it so it fits the starter spool.
  raw.exec(`INSERT INTO farm_jobs (id,user_id,state,customer_tier,product_key,qty,material,colors_json,grams,print_seconds,quality,reward_coins,
      offered_at,offer_expires_at,deadline_at,accepted_at,seed)
    VALUES ('j2','u1','accepted','individual','cable_clip',2,'PLA','["black"]',12,1200,'standard',80,
      '${past(1)}','${new Date(Date.now() + 3600_000).toISOString()}','${new Date(Date.now() + 7200_000).toISOString()}','${past(1)}','s2'),
    ('j3','u1','accepted','individual','cable_clip',1,'PLA','["black"]',6,600,'standard',40,
      '${past(1)}','${new Date(Date.now() + 3600_000).toISOString()}','${new Date(Date.now() + 7200_000).toISOString()}','${past(1)}','s3')`);
  const q1 = await json(await post(a, '/api/farm/jobs/j2/assign', { allocations: [{ printer_id: printer, qty: 2, spool_id: spool }] }));
  assert.equal(q1.success, true, JSON.stringify(q1));
  assert.equal(q1.assignments[0].started, false);
  const q2 = await json(await post(a, '/api/farm/jobs/j3/assign', { allocations: [{ printer_id: printer, qty: 1, spool_id: spool }] }));
  assert.equal(q2.success, true);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_assignments WHERE state = 'printing'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_assignments WHERE state = 'queued'"), 2);
  const p = q2.printers[0];
  assert.deepEqual(p.queue.map((x: { job_id: string }) => x.job_id), ['j2', 'j3']);
  // The database itself refuses a second printing batch on the printer.
  assert.throws(
    () => raw.exec(`UPDATE farm_assignments SET state='printing', started_at='x', ends_at='y' WHERE id = '${p.queue[0].assignment_id}'`),
    /UNIQUE/
  );
  const wrong = await json(await post(a, `/api/farm/printers/${printer}/queue`, { order: [p.queue[0].assignment_id] }));
  assert.equal(wrong.code, 'QUEUE_MISMATCH');
  const re = await json(await post(a, `/api/farm/printers/${printer}/queue`, { order: [p.queue[1].assignment_id, p.queue[0].assignment_id] }));
  assert.equal(re.success, true);
  assert.deepEqual(re.printers[0].queue.map((x: { job_id: string }) => x.job_id), ['j3', 'j2']);
});

test('collect: refused before ends_at; after it the batch delivers, pays once, and a replayed key pays nothing extra', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  const { id, job, asg } = await acceptAndAssign(a, s);
  const early = await post(a, `/api/farm/printers/${printer}/collect`);
  assert.equal(early.status, 409);
  const earlyBody = await json(early);
  assert.equal(earlyBody.code, 'PRINT_NOT_FINISHED');
  assert.ok(earlyBody.details.ends_at);

  // Time passes on the server: the batch's end moved into the past. The
  // outcome roll must succeed for this test, so the stored probability is 0.
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const resolved = await state(a);
  const p = resolved.printers[0];
  assert.equal(p.state, 'done');
  assert.equal(p.current.state, 'done');
  assert.equal(p.current.progress, 1);
  assert.equal(p.prints, 2);
  assert.ok(p.hours > 0.8 && p.hours < 0.9, `hours ${p.hours}`);
  assert.ok(p.health < 100 && p.health > 98, `wear applied: ${p.health}`);
  assert.equal(resolved.jobs.active.find((j: { id: string }) => j.id === id).state, 'ready');
  assert.ok(resolved.events_unseen.some((e: { kind: string }) => e.kind === 'print_done'));
  assert.ok(resolved.events_unseen.some((e: { kind: string }) => e.kind === 'job_ready'));
  const energy = raw.prepare("SELECT amount FROM farm_ledger WHERE kind = 'electricity'").all() as Array<{ amount: number }>;
  assert.equal(energy.length, 1, 'electricity was billed once for the batch');
  assert.ok(energy[0].amount < 0);
  const coinsBefore = resolved.profile.coins;
  assert.equal(coinsBefore, sum(raw));

  const k = key();
  const col = await json(await a.request(`/api/farm/printers/${printer}/collect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: k }),
  }));
  assert.equal(col.success, true, JSON.stringify(col));
  assert.equal(col.replayed, false);
  assert.equal(col.delivered.job_id, id);
  assert.equal(col.delivered.late, false);
  assert.equal(col.delivered.reward_coins, job.reward_coins);
  assert.equal(col.profile.coins, coinsBefore + job.reward_coins);
  assert.equal(col.profile.coins, sum(raw), 'the reported balance is the ledger sum');
  assert.equal(col.profile.reputation_bp, job.reputation_gain_bp);
  assert.equal(col.profile.xp, FARM_CONFIG_DEFAULTS.progression.xp_per_job + 2 * FARM_CONFIG_DEFAULTS.progression.xp_per_part);
  assert.equal(col.profile.stats.delivered, 1);
  assert.equal(col.printers[0].state, 'idle');
  assert.equal(col.printers[0].current, null);
  assert.equal(col.jobs.active.length, 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 1);
  assert.equal((raw.prepare("SELECT day, coins_earned, jobs_delivered FROM farm_daily WHERE user_id = 'u1'").get() as { jobs_delivered: number }).jobs_delivered, 1);

  const replay = await json(await a.request(`/api/farm/printers/${printer}/collect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: k }),
  }));
  assert.equal(replay.success, true);
  assert.equal(replay.replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 1, 'no second payout');
  assert.equal(replay.profile.coins, col.profile.coins);
  // A fresh key on an empty printer has nothing to collect.
  const nothing = await post(a, `/api/farm/printers/${printer}/collect`);
  assert.equal(nothing.status, 409);
  assert.equal((await json(nothing)).code, 'NOTHING_TO_COLLECT');
  // The ledger view: newest first, running balance, the payout on top.
  const led = await json(await a.request('/api/farm/ledger'));
  assert.equal(led.entries[0].kind, 'job_payout');
  assert.equal(led.entries[0].balance_after, col.profile.coins);
  assert.equal(led.entries[led.entries.length - 1].kind, 'starter');
  assert.equal(led.next_before, null);
});

test('after the deadline a delivery is late and costs reputation instead of earning it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  const { id, job, asg } = await acceptAndAssign(a, s);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(2), asg.assignments[0].assignment_id);
  raw.prepare('UPDATE farm_jobs SET deadline_at = ? WHERE id = ?').run(past(1), id);
  const st = await state(a);
  assert.equal(st.jobs.active.find((j: { id: string }) => j.id === id).state, 'late');
  assert.ok(st.events_unseen.some((e: { kind: string }) => e.kind === 'job_late'));
  const col = await json(await post(a, `/api/farm/printers/${printer}/collect`));
  assert.equal(col.delivered.late, true);
  assert.equal(col.delivered.reward_coins, job.reward_coins, 'late still pays the coins');
  assert.equal(col.profile.reputation_bp, 1000 - job.late_penalty_bp);
  assert.equal(col.profile.stats.late, 1);
  assert.equal(col.profile.stats.delivered, 1);
});

test('after the deadline plus grace the customer cancels: penalty, event, and reserved grams released', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const spool = s.spools[0].id;
  const { id } = await acceptAndAssign(a, s);
  // Put a QUEUED batch of the same job on the books to see its grams come back.
  raw.exec(`INSERT INTO farm_jobs (id,user_id,state,customer_tier,product_key,qty,material,colors_json,grams,print_seconds,quality,reward_coins,
      cancel_penalty_bp,offered_at,offer_expires_at,deadline_at,accepted_at,seed)
    VALUES ('j2','u1','accepted','individual','cable_clip',3,'PLA','["black"]',18,1800,'standard',100,150,
      '${past(5)}','${new Date(Date.now() + 3600_000).toISOString()}','${new Date(Date.now() + 7200_000).toISOString()}','${past(5)}','s2')`);
  const q = await json(await post(a, '/api/farm/jobs/j2/assign', { allocations: [{ printer_id: s.printers[0].id, qty: 3, spool_id: spool }] }));
  assert.equal(q.assignments[0].started, false);
  const gramsAfterReserve = q.spools[0].grams_left;
  assert.equal(gramsAfterReserve, 500 - 24 - 18);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  raw.prepare('UPDATE farm_jobs SET deadline_at = ? WHERE id = ?').run(past(FARM_CONFIG_DEFAULTS.jobs.late_grace_minutes + 1), 'j2');
  const st = await state(a);
  assert.equal(st.jobs.active.some((j: { id: string }) => j.id === 'j2'), false, 'the cancelled job left the active list');
  assert.equal((raw.prepare("SELECT state FROM farm_jobs WHERE id = 'j2'").get() as { state: string }).state, 'cancelled');
  assert.equal((raw.prepare("SELECT state FROM farm_assignments WHERE job_id = 'j2'").get() as { state: string }).state, 'cancelled');
  assert.equal(st.spools[0].grams_left, gramsAfterReserve + 18, 'the queued batch gave its grams back');
  assert.equal(st.profile.reputation_bp, 1000 - 150);
  assert.equal(st.profile.stats.cancelled, 1);
  assert.ok(st.events_unseen.some((e: { kind: string; payload: { job_id: string } }) => e.kind === 'job_cancelled_by_customer' && e.payload.job_id === 'j2'));
  // The printing job is untouched.
  assert.equal(st.jobs.active.find((j: { id: string }) => j.id === id).state, 'printing');
});

test('the player can cancel an accepted job: queued grams refunded, reputation penalty applied', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  await state(a);
  const id = 'fjob_first_u1';
  await post(a, `/api/farm/jobs/${id}/accept`);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 500 WHERE user_id = 'u1'").run();
  const c = await json(await post(a, `/api/farm/jobs/${id}/cancel`));
  assert.equal(c.success, true);
  assert.equal(c.profile.reputation_bp, 500 - FARM_CONFIG_DEFAULTS.customers.individual.cancel_penalty_bp);
  assert.equal(c.jobs.active.length, 0);
  assert.equal((await post(a, `/api/farm/jobs/${id}/cancel`)).status, 404, 'a closed job is gone from the live set');
});

test('a forced failure loses grams, hits health, records an event; a mechanical failure breaks the printer, repair fixes it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  const { id, asg } = await acceptAndAssign(a, s);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  // Only the mechanical kind can happen, and the roll cannot beat p = 1.
  const cfg = JSON.parse(JSON.stringify(FARM_CONFIG_DEFAULTS));
  for (const k of Object.keys(cfg.failure.kinds)) cfg.failure.kinds[k].weight = k === 'mechanical' ? 1 : 0;
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('printerFarmConfig', ?)").run(JSON.stringify(cfg));
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 1 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const gramsBefore = 500 - 24;
  const st = await state(a);
  const p = st.printers[0];
  assert.equal(p.state, 'broken');
  assert.equal(p.current.state, 'failed');
  assert.equal(p.current.failure_kind, 'mechanical');
  assert.equal(p.failures, 1);
  assert.ok(p.health <= 100 - FARM_CONFIG_DEFAULTS.failure.kinds.mechanical.health_hit, `health hit: ${p.health}`);
  assert.equal(st.spools[0].grams_left, gramsBefore + 12, 'half of the 24 g came back (grams_loss_factor 0.5)');
  assert.equal(st.profile.stats.failures, 1);
  assert.equal(st.profile.reputation_bp, 1000 - FARM_CONFIG_DEFAULTS.progression.failure_reputation_bp);
  assert.ok(st.events_unseen.some((e: { kind: string }) => e.kind === 'print_failed'));
  assert.ok(st.events_unseen.some((e: { kind: string }) => e.kind === 'printer_broken'));
  const job = st.jobs.active.find((j: { id: string }) => j.id === id);
  assert.equal(job.assignments_summary.failed, 2);
  assert.equal(job.assignments_summary.remaining, 2, 'the failed parts are free to re-assign');

  // A broken printer cannot be maintained and cannot take work (maintenance
  // unlocks at level 2 — the lock is checked after the printer's own state).
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  const m = await json(await post(a, `/api/farm/printers/${printer}/maintain`));
  assert.equal(m.code, 'PRINTER_BROKEN');
  const asg2 = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: s.spools[0].id }] }));
  assert.equal(asg2.code, 'PRINTER_UNAVAILABLE');
  // Collect clears the failed batch; the printer stays broken.
  const col = await json(await post(a, `/api/farm/printers/${printer}/collect`));
  assert.equal(col.collected.outcome, 'failed');
  assert.equal(col.delivered, null);
  assert.equal(col.printers[0].state, 'broken');
  assert.equal(col.printers[0].current, null);
  // Repair: costs coins, takes time, restores health on completion.
  const coins = col.profile.coins;
  const rep = await json(await post(a, `/api/farm/printers/${printer}/repair`));
  assert.equal(rep.success, true, JSON.stringify(rep));
  assert.equal(rep.cost, FARM_CONFIG_DEFAULTS.economy.repair.cost);
  assert.equal(rep.profile.coins, coins - FARM_CONFIG_DEFAULTS.economy.repair.cost);
  assert.equal(rep.printers[0].state, 'maintenance');
  const untilMs = Date.parse(rep.state_until) - Date.now();
  assert.ok(untilMs > 300_000 && untilMs <= 360_000, `120 game minutes = 6 real minutes (${untilMs})`);
  raw.prepare('UPDATE farm_printers SET state_until = ? WHERE id = ?').run(past(1), printer);
  const after = await state(a);
  assert.equal(after.printers[0].state, 'idle');
  assert.equal(after.printers[0].health, FARM_CONFIG_DEFAULTS.economy.repair.health);
  assert.ok(after.events_unseen.some((e: { kind: string }) => e.kind === 'maintenance_done'));
  // Re-assigning the failed parts works now.
  const asg3 = await json(await post(a, `/api/farm/jobs/${id}/assign`, { allocations: [{ printer_id: printer, qty: 2, spool_id: s.spools[0].id }] }));
  assert.equal(asg3.success, true, JSON.stringify(asg3));
});

test('maintenance costs coins and takes time; it is refused while printing — and locked below level 2', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  raw.prepare('UPDATE farm_printers SET health = 60 WHERE id = ?').run(printer);
  // Progressive disclosure is enforced server-side: at level 1 the order is refused and nothing is charged.
  const locked = await post(a, `/api/farm/printers/${printer}/maintain`);
  assert.equal(locked.status, 409);
  const lockedBody = await json(locked);
  assert.equal(lockedBody.code, 'FEATURE_LOCKED');
  assert.equal(lockedBody.details.min_level, FARM_CONFIG_DEFAULTS.progression.unlocks.maintenance);
  assert.equal(sum(raw), FARM_CONFIG_DEFAULTS.economy.starter_coins);
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  const m = await json(await post(a, `/api/farm/printers/${printer}/maintain`));
  assert.equal(m.success, true, JSON.stringify(m));
  assert.equal(m.profile.coins, FARM_CONFIG_DEFAULTS.economy.starter_coins - FARM_CONFIG_DEFAULTS.economy.maintenance.cost);
  assert.equal(m.profile.coins, sum(raw));
  assert.equal(m.printers[0].state, 'maintenance');
  assert.equal(m.printers[0].health, 100);
  const busy = await json(await post(a, `/api/farm/printers/${printer}/maintain`));
  assert.equal(busy.code, 'PRINTER_BUSY');
  const notBroken = await json(await post(a, `/api/farm/printers/${printer}/repair`));
  assert.equal(notBroken.code, 'PRINTER_NOT_BROKEN');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'maintenance'"), 1);
  const renamed = await json(await post(a, `/api/farm/printers/${printer}/rename`, { nickname: 'Old Faithful' }));
  assert.equal(renamed.printers[0].nickname, 'Old Faithful');
  const farm = await json(await post(a, '/api/farm/profile', { farm_name: 'Sara Prints' }));
  assert.equal(farm.profile.farm_name, 'Sara Prints');
});

// ------------------------------------------------------------------ market

test('buying filament and printers debits the ledger, respects level and slots, and refuses when poor', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  await state(a);
  const badSize = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 123 }));
  assert.equal(badSize.code, 'SPOOL_SIZE_UNKNOWN');
  const badColor = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'pink', grams: 250 }));
  assert.equal(badColor.code, 'COLOR_UNKNOWN');
  const locked = await json(await post(a, '/api/farm/market/filament', { material: 'TPU', color: 'black', grams: 250 }));
  assert.equal(locked.code, 'LEVEL_TOO_LOW');
  const buy = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 250 }));
  assert.equal(buy.success, true, JSON.stringify(buy));
  assert.equal(buy.cost, 250 * FARM_CONFIG_DEFAULTS.materials.PLA.price_per_gram);
  assert.equal(buy.profile.coins, 1500 - buy.cost);
  assert.equal(buy.profile.coins, sum(raw));
  assert.equal(buy.spools.length, 2);

  // Too poor for a 1 kg spool (2,000) or a printer (6,000) → the TRIGGER
  // refuses and nothing is written: no spool, no printer, no ledger row.
  const coinsBefore = sum(raw);
  const printersBefore = count(raw, 'SELECT COUNT(*) AS n FROM farm_printers');
  const spoolsBefore = count(raw, 'SELECT COUNT(*) AS n FROM farm_spools');
  const poorSpool = await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 1000 });
  assert.equal(poorSpool.status, 400);
  assert.equal((await json(poorSpool)).code, 'INSUFFICIENT_COINS');
  const poor = await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' });
  assert.equal(poor.status, 400);
  assert.equal((await json(poor)).code, 'INSUFFICIENT_COINS');
  assert.equal(sum(raw), coinsBefore);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'), printersBefore);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'), spoolsBefore);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'), 2, 'starter + the one 250 g purchase');
  const gated = await json(await post(a, '/api/farm/market/printers', { model_key: 'x1c' }));
  assert.equal(gated.code, 'LEVEL_TOO_LOW');
  const unknown = await json(await post(a, '/api/farm/market/printers', { model_key: 'ender3' }));
  assert.equal(unknown.code, 'MODEL_UNKNOWN');

  raw.exec("INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key,note) VALUES ('fl_test_grant','u1','admin_grant',20000,'test-grant','test')");
  // Storage: the tiny room holds 3000 g — 500 + 250 + 1000 + 1000 fits, one more does not.
  const full = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 1000 }));
  assert.equal(full.success, true, JSON.stringify(full));
  const tooMuch = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 1000 }));
  assert.equal(tooMuch.success, true, JSON.stringify(tooMuch));
  const over = await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 1000 }));
  assert.equal(over.code, 'STORAGE_FULL');

  const bought = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(bought.success, true, JSON.stringify(bought));
  assert.equal(bought.slot, 1);
  assert.equal(bought.profile.coins, sum(raw));
  assert.equal(bought.printers.length, 2);
  const noSlot = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(noSlot.code, 'NO_FREE_SLOT');

  // Sell the new one back at resale value.
  const before = sum(raw);
  const sold = await json(await post(a, `/api/farm/market/printers/${bought.printer_id}/sell`));
  assert.equal(sold.success, true, JSON.stringify(sold));
  assert.equal(sold.credited, Math.round(6000 * FARM_CONFIG_DEFAULTS.economy.resale_factor));
  assert.equal(sum(raw), before + sold.credited);
  assert.equal(sold.printers.length, 1);
  // A busy printer cannot be sold.
  const s2 = await state(a);
  await acceptAndAssign(a, s2);
  const busy = await json(await post(a, `/api/farm/market/printers/${s2.printers[0].id}/sell`));
  assert.equal(busy.code, 'PRINTER_BUSY');
});

test('the same idempotency key reused for a different intent is refused; the same intent replays', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  await state(a);
  const k = key();
  const buy = await json(await a.request('/api/farm/market/filament', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: k, material: 'PLA', color: 'red', grams: 250 }),
  }));
  assert.equal(buy.success, true);
  const again = await json(await a.request('/api/farm/market/filament', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: k, material: 'PLA', color: 'red', grams: 250 }),
  }));
  assert.equal(again.replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'filament_purchase'"), 1);
  const other = await a.request('/api/farm/market/printers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: k, model_key: 'a1_mini' }),
  });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, 'IDEMPOTENCY_KEY_REUSED');
});

// ------------------------------------------------------------------ ledger, events, leaderboard

test('the ledger pages newest-first, 30 at a time, with a running balance', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  await state(a);
  const ins = raw.prepare('INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key,note,created_at) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 40; i++) {
    ins.run(`fl_t_${String(i).padStart(3, '0')}`, 'u1', 'admin_grant', 10, `k${i}`, `t${i}`, new Date(Date.now() - (100 - i) * 1000).toISOString());
  }
  const p1 = await json(await a.request('/api/farm/ledger'));
  assert.equal(p1.entries.length, 30);
  assert.ok(p1.next_before);
  assert.equal(p1.entries[0].kind, 'starter', 'the starter row is the newest');
  assert.equal(p1.entries[0].balance_after, 1500 + 400);
  const p2 = await json(await a.request(`/api/farm/ledger?before=${encodeURIComponent(p1.next_before)}`));
  assert.equal(p2.entries.length, 11);
  assert.equal(p2.next_before, null);
  const ids = new Set([...p1.entries, ...p2.entries].map((e: { id: string }) => e.id));
  assert.equal(ids.size, 41, 'no row repeated or skipped across pages');
  assert.equal(p2.entries[p2.entries.length - 1].balance_after, 10);
});

test('events: unseen until marked; /events?all=1 lists everything', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const { asg } = await acceptAndAssign(a, s);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const st = await state(a);
  assert.ok(st.events_unseen.length >= 1);
  const ids = st.events_unseen.map((e: { id: string }) => e.id);
  const seen = await json(await post(a, '/api/farm/events/seen', { ids }));
  assert.equal(seen.marked, ids.length);
  assert.equal((await state(a)).events_unseen.length, 0);
  const all = await json(await a.request('/api/farm/events?all=1'));
  assert.equal(all.events.length, ids.length);
  assert.ok(all.events.every((e: { seen_at: string | null }) => e.seen_at));
  // The away summary appears only after a long absence.
  raw.prepare("UPDATE farm_profiles SET last_seen_at = ? WHERE user_id = 'u1'").run(past(60));
  const back = await state(a);
  assert.ok(back.away && back.away.minutes >= 60);
});

test('the leaderboard exposes username, avatar, farm name and score — never ids or emails', async () => {
  const { db, raw } = setup();
  await state(appAs(db, 'u1'));
  await state(appAs(db, 'u2'));
  raw.exec("UPDATE farm_profiles SET reputation_bp = 3000, stats_json = '{\"delivered\":7}' WHERE user_id = 'u2'");
  raw.exec("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'");
  const guest = appAs(db, null);
  const rep = await json(await guest.request('/api/farm/leaderboard?board=reputation&limit=10'));
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.rows[0].username, 'omar');
  assert.equal(rep.rows[0].score, 3000);
  assert.deepEqual(Object.keys(rep.rows[0]).sort(), ['avatar_key', 'farm_name', 'rank', 'score', 'username']);
  const text = JSON.stringify(rep);
  assert.equal(/@x\.co|"u1"|"u2"|user_id/.test(text), false, 'no email or id leaks');
  const jobs = await json(await guest.request('/api/farm/leaderboard?board=jobs_delivered'));
  assert.equal(jobs.rows[0].username, 'omar');
  assert.equal(jobs.rows[0].score, 7);
  const value = await json(await guest.request('/api/farm/leaderboard?board=farm_value'));
  // coins 1500 + one A1 mini at resale 3300 each
  assert.equal(value.rows[0].score, 1500 + Math.round(6000 * FARM_CONFIG_DEFAULTS.economy.resale_factor));
  const bad = await guest.request('/api/farm/leaderboard?board=coins');
  assert.equal(bad.status, 400);
});

// ------------------------------------------------------------------ isolation, clock

test('a player cannot read or touch another player\'s farm', async () => {
  const { db, raw } = setup();
  const a1 = appAs(db, 'u1');
  const a2 = appAs(db, 'u2');
  const s1 = await state(a1);
  const s2 = await state(a2);
  assert.notEqual(s1.printers[0].id, s2.printers[0].id);
  assert.equal(s2.jobs.offered.some((j: { id: string }) => j.id === 'fjob_first_u1'), false);
  assert.equal((await post(a2, '/api/farm/jobs/fjob_first_u1/accept')).status, 404);
  assert.equal((await post(a2, `/api/farm/printers/${s1.printers[0].id}/collect`)).status, 404);
  assert.equal((await post(a2, `/api/farm/printers/${s1.printers[0].id}/maintain`)).status, 404);
  await post(a1, '/api/farm/jobs/fjob_first_u1/accept');
  const steal = await post(a2, '/api/farm/jobs/fjob_first_u1/assign', {
    allocations: [{ printer_id: s2.printers[0].id, qty: 2, spool_id: s1.spools[0].id }],
  });
  assert.equal(steal.status, 404);
  assert.equal((raw.prepare("SELECT state FROM farm_jobs WHERE id = 'fjob_first_u1'").get() as { state: string }).state, 'accepted');
});

test('offline progression runs on the server clock only — timestamps in the body change nothing', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  const { asg } = await acceptAndAssign(a, s);
  const lie = await post(a, `/api/farm/printers/${printer}/collect`, {
    now: '2099-01-01T00:00:00.000Z', ends_at: '2000-01-01T00:00:00.000Z', timestamp: 4102444800000, coins: 999999,
  });
  assert.equal(lie.status, 409);
  assert.equal((await json(lie)).code, 'PRINT_NOT_FINISHED');
  assert.equal(sum(raw), 1500);
  // Only the row's own end time — written by the server — moves the print on.
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const st = await state(a);
  assert.equal(st.printers[0].state, 'done');
});
