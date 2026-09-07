/**
 * LEVO Printer Farm — the adversarial-review findings, each pinned as the
 * behaviour the fix guarantees (migration 0054, docs/PRINTER_FARM.md §7/§9):
 *
 *   H1  randomness is the server's: a forged idempotency key cannot pick a
 *       print's outcome, offers cannot be forecast, and neither the offer salt
 *       nor an outcome seed ever leaves the server;
 *   H2  the revision fence: two requests sandwiched around a resolver batch
 *       apply exactly once (sell, cancel, maintain); a stale fence aborts the
 *       whole batch with 409 STATE_CHANGED and commits nothing; business
 *       ledger ids name the event;
 *   H3  a sold printer keeps its batch history: a half-delivered job remembers
 *       its collected parts and pays once; the slot comes free; the leaderboard
 *       ignores sold machines;
 *   M4  client keys and server ledger keys live in separate namespaces, and a
 *       resolver failure is loud, not a frozen clock;
 *   L1  every intent replays on the same key; the key is refused for a
 *       different route;
 *   L2  the daily cap never leaves a batch on the bed: collect frees the
 *       printer and the payout waits for the next Baghdad day;
 *   L3  an assistant admin cannot edit limits/rewards or grant coins;
 *   L4  maintenance is locked below its level; repair is not;
 *   L5  a late job whose last part finishes is ready (event + list);
 *   L6  every printer is born with a name; `resale_coins` and the `limits`
 *       block are server numbers.
 *
 * The real routes run against the real migrations through the SQLite adapter,
 * plus a GATED adapter that interleaves two requests at chosen statements so
 * a race is reproduced deterministically instead of hoped for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1, SqliteStatement } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost } from '../worker/lib/hosts';
import { sha256Hex } from '../worker/lib/crypto';
import { farmRoutes } from '../worker/routes/farm';
import { farmAdminRoutes } from '../worker/routes/farmAdmin';
import { adminRoutes } from '../worker/routes/admin';
import { FARM_CONFIG_DEFAULTS } from '../worker/lib/farm/config';
import { roll, seedFrom } from '../worker/lib/farm/rng';
import { generateOffers } from '../worker/lib/farm/jobs';
import { ownedCapacity } from '../worker/lib/farm/catalog';
import { baghdadDayOf } from '../worker/lib/farm/time';
import { PARKED_SLOT_BASE, type FarmPrinterRow } from '../worker/lib/farm/types';

// ------------------------------------------------------------------ harness

interface Hooks {
  beforeBatch?: (sqls: string[]) => Promise<void> | void;
  afterBatch?: (sqls: string[]) => void;
}

class GatedStatement {
  constructor(public readonly inner: SqliteStatement, public readonly sql: string) {}
  bind(...values: unknown[]): GatedStatement {
    return new GatedStatement(this.inner.bind(...values), this.sql);
  }
  run() { return this.inner.run(); }
  first<T = Record<string, unknown>>() { return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
}

class GatedD1 {
  public hooks: Hooks = {};
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string): GatedStatement {
    return new GatedStatement(this.inner.prepare(sql), sql);
  }
  async batch(statements: GatedStatement[]) {
    const sqls = statements.map((s) => s.sql);
    await this.hooks.beforeBatch?.(sqls);
    const out = await this.inner.batch(statements.map((s) => s.inner));
    this.hooks.afterBatch?.(sqls);
    return out;
  }
}

function setup(extraUsersSql = '') {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,avatar_key) VALUES
      ('u1','Sara','sara@x.co','h','customer','sara','av/sara.png'),
      ('u2','Omar','omar@x.co','h','customer','omar',NULL),
      ('boss','Admin','a@x.co','h','admin','boss',NULL);
    ${extraUsersSql}
  `);
  const gated = new GatedD1(new SqliteD1(raw));
  return { raw, gated, db: gated as unknown as D1Database };
}

const USERNAMES: Record<string, string> = { u1: 'sara', u2: 'omar', boss: 'boss', helper: 'helper', full: 'full' };

function appAs(db: D1Database, userId: string | null, role = 'customer', extra: Record<string, unknown> = {}, host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, email: `${userId}@x.co`, username: USERNAMES[userId] ?? userId, admin_scope: null, ...extra } as never);
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/admin', adminRoutes);
  a.route('/api/admin/farm', farmAdminRoutes);
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
const key = () => `hardkey-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;
const post = async (a: App, path: string, body: Record<string, unknown> = {}) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ idempotencyKey: key(), ...body }),
  });
const send = async (a: App, method: string, path: string, body: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async (a: App) => json(await a.request('/api/farm/state'));
const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sum = (raw: DatabaseSync, user = 'u1') =>
  (raw.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM farm_ledger WHERE user_id = ?').get(user) as { s: number }).s;
const count = (raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).get(...(params as never[])) as { n: number }).n;
const row = <T,>(raw: DatabaseSync, sql: string, ...params: unknown[]) => raw.prepare(sql).get(...(params as never[])) as T;
const cfg = FARM_CONFIG_DEFAULTS;
const RESALE = Math.round(cfg.printers.a1_mini.price * cfg.economy.resale_factor);
const yesterdayOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Accept the starter job and assign it (whole qty) to the starter printer on the starter spool. */
async function acceptAndAssign(a: App, s: Record<string, unknown>, jobId?: string, idem?: string) {
  const st = s as { jobs: { offered: Array<{ id: string }> }; printers: Array<{ id: string }>; spools: Array<{ id: string }> };
  const id = jobId ?? st.jobs.offered.find((j) => j.id.startsWith('fjob_first_'))!.id;
  const acc = await json(await post(a, `/api/farm/jobs/${id}/accept`));
  assert.equal(acc.success, true, JSON.stringify(acc));
  const job = acc.jobs.active.find((j: { id: string }) => j.id === id);
  const asg = await json(await post(a, `/api/farm/jobs/${id}/assign`, {
    ...(idem ? { idempotencyKey: idem } : {}),
    allocations: [{ printer_id: st.printers[0].id, qty: job.qty, spool_id: st.spools[0].id }],
  }));
  assert.equal(asg.success, true, JSON.stringify(asg));
  return { id, job, asg };
}

/** Coins straight into the ledger (a test grant), so a purchase can go through the real route. */
const grant = (raw: DatabaseSync, coins: number, user = 'u1') =>
  raw.prepare("INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key,created_at) VALUES (?,?,'admin_grant',?,?,?)")
    .run(`grant_${user}_${coins}_${Math.random().toString(36).slice(2)}`, user, coins, `adm:test-${Math.random()}`, new Date().toISOString());

const expireAnOffer = (raw: DatabaseSync, user: string) => {
  const j = row<{ id: string }>(raw, "SELECT id FROM farm_jobs WHERE user_id = ? AND state = 'offered' ORDER BY id LIMIT 1", user);
  raw.prepare('UPDATE farm_jobs SET offer_expires_at = ? WHERE id = ?').run(past(1), j.id);
};

/**
 * Two requests of the same player, interleaved the way a real pair can be:
 * A's resolver batch lands, A parks before its INTENT batch; B loads AFTER
 * A's resolver and BEFORE A's intent and parks before its own; A commits,
 * then B's intent batch runs. The window every mutation has between "resolve
 * to now" and "write the intent".
 */
async function sandwich(
  gated: GatedD1,
  isIntent: (sqls: string[]) => boolean,
  requestA: () => Promise<Response>,
  requestB: () => Promise<Response>
): Promise<[Response, Response]> {
  let intentBatches = 0;
  let firstIntentDone = false;
  let bReady = false;
  const waiters: Array<() => void> = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  const until = (pred: () => boolean) => new Promise<void>((resolve) => {
    const check = () => { if (pred()) resolve(); else waiters.push(check); };
    check();
  });
  gated.hooks = {
    beforeBatch: async (sqls) => {
      if (!isIntent(sqls)) return;
      intentBatches += 1;
      wake();
      if (intentBatches === 1) await until(() => bReady);
      else { bReady = true; wake(); await until(() => firstIntentDone); }
    },
    afterBatch: (sqls) => {
      if (isIntent(sqls)) { firstIntentDone = true; wake(); }
    },
  };
  const pa = requestA();
  await until(() => intentBatches >= 1);
  const pb = requestB();
  const out = await Promise.all([pa, pb]);
  gated.hooks = {};
  return out;
}

const isSell = (sqls: string[]) => sqls.some((q) => q.includes('SET sold_at'));
const isCancel = (sqls: string[]) => sqls.some((q) => q.includes("UPDATE farm_jobs SET state = 'cancelled'"));
const isMaintain = (sqls: string[]) => sqls.some((q) => q.includes("SET state = 'maintenance'"));

/** What a cheating client could compute for a chosen key under the Phase 1 derivation. */
async function forgedForecast(userId: string, k: string, i = 0) {
  const keyHash = (await sha256Hex(`${userId}:${k}`)).slice(0, 24);
  const id = `fasg_${keyHash}_${i}`;
  const seed = await seedFrom(id, 'outcome');
  return { id, seed, outcome: roll(seed, 'outcome') };
}
async function findForgedKey(userId: string, pred: (o: number) => boolean) {
  for (let n = 0; n < 5000; n++) {
    const k = `forged-${n}-abcdef`;
    const f = await forgedForecast(userId, k);
    if (pred(f.outcome)) return { key: k, ...f };
  }
  throw new Error('no forged key found');
}

// ------------------------------------------------------------------ H1

test('H1: the outcome seed is the server\'s — a key forged to "never fail" decides nothing; the stored seed does', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const never = await findForgedKey('u1', (o) => o >= cfg.failure.max);
  const { asg } = await acceptAndAssign(a, s, undefined, never.key);
  assert.equal(asg.assignments[0].assignment_id, never.id, 'the assignment id stays deterministic — it is the replay memory');
  const stored = row<{ outcome_seed: string }>(raw, 'SELECT outcome_seed FROM farm_assignments WHERE id = ?', never.id);
  assert.match(stored.outcome_seed, /^[0-9a-f]{64}$/, '32 random bytes');
  assert.notEqual(stored.outcome_seed, never.seed, 'not derivable from the key');
  // The server's probability is forced high; the STORED seed — not the forged
  // forecast, which said "done" — is what the resolver rolls against.
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0.99 WHERE id = ?').run(past(1), never.id);
  const st = await state(a);
  const expected = roll(stored.outcome_seed, 'outcome') < 0.99 ? 'failed' : 'done';
  assert.equal(st.printers[0].current.state, expected, 'the outcome follows the stored seed');
  assert.ok(never.outcome >= cfg.failure.max, 'the forged forecast promised success');
  // …and with the probability at 1 nothing the client chose can save the batch.
  const { db: db2, raw: raw2 } = setup();
  const a2 = appAs(db2, 'u1');
  const s2 = await state(a2);
  const never2 = await findForgedKey('u1', (o) => o >= cfg.failure.max);
  const { asg: asg2 } = await acceptAndAssign(a2, s2, undefined, never2.key);
  raw2.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 1 WHERE id = ?').run(past(1), asg2.assignments[0].assignment_id);
  const st2 = await state(a2);
  assert.equal(st2.printers[0].current.state, 'failed');
  assert.equal(st2.profile.stats.failures, 1);
});

test('H1: two players with the same key get different outcome seeds; offers come from a per-player secret, not from (user id, index)', async () => {
  const { db, raw } = setup();
  const a1 = appAs(db, 'u1');
  const a2 = appAs(db, 'u2');
  const s1 = await state(a1);
  const s2 = await state(a2);
  const k = 'shared-key-0001';
  const r1 = await acceptAndAssign(a1, s1, undefined, k);
  const r2 = await acceptAndAssign(a2, s2, undefined, k);
  const seed1 = row<{ outcome_seed: string }>(raw, 'SELECT outcome_seed FROM farm_assignments WHERE id = ?', r1.asg.assignments[0].assignment_id).outcome_seed;
  const seed2 = row<{ outcome_seed: string }>(raw, 'SELECT outcome_seed FROM farm_assignments WHERE id = ?', r2.asg.assignments[0].assignment_id).outcome_seed;
  assert.notEqual(seed1, seed2);
  // A second assignment by the same player with a new key: a fresh seed again.
  raw.exec(`INSERT INTO farm_jobs (id,user_id,state,customer_tier,product_key,qty,material,colors_json,grams,print_seconds,quality,reward_coins,
      offered_at,offer_expires_at,deadline_at,accepted_at,seed)
    VALUES ('j2','u1','accepted','individual','cable_clip',1,'PLA','["black"]',6,600,'standard',40,'${past(1)}','${future(60)}','${future(120)}','${past(1)}','s2')`);
  const q = await json(await post(a1, '/api/farm/jobs/j2/assign', { allocations: [{ printer_id: s1.printers[0].id, qty: 1, spool_id: s1.spools[0].id }] }));
  assert.equal(q.success, true, JSON.stringify(q));
  const seed3 = row<{ outcome_seed: string }>(raw, 'SELECT outcome_seed FROM farm_assignments WHERE id = ?', q.assignments[0].assignment_id).outcome_seed;
  assert.notEqual(seed3, seed1);

  // Offers: the board is NOT what the old (user id, refresh index) seed predicts,
  // and IS what the stored secret predicts — the salt is the seed.
  const salt = row<{ offer_salt: string }>(raw, "SELECT offer_salt FROM farm_profiles WHERE user_id = 'u1'").offer_salt;
  assert.match(salt, /^[0-9a-f]{64}$/);
  const starter: FarmPrinterRow = {
    id: 'p', user_id: 'u1', model_key: 'a1_mini', slot: 0, nickname: '', health: 100, state: 'printing', state_until: null,
    hours: 0, prints: 0, failures: 0, upgrades_json: '[]', created_at: '', updated_at: '', sold_at: null,
  };
  raw.prepare("UPDATE farm_jobs SET offer_expires_at = ? WHERE user_id = 'u1' AND state = 'offered'").run(past(1));
  raw.prepare("UPDATE farm_profiles SET last_offer_at = ? WHERE user_id = 'u1'").run(past(cfg.time.offer_refresh_minutes + 1));
  const st = await state(a1);
  assert.equal(st.jobs.offered.length, cfg.jobs.offers_visible);
  const input = { userId: 'u1', profile: { level: 1, reputation_bp: 0 }, capacity: ownedCapacity([starter], cfg), now: st.now, cfg, count: cfg.jobs.offers_visible };
  const fromSecret = generateOffers({ ...input, seed: await seedFrom(salt, 'offers', '1') }).map((j) => j.id).sort();
  const fromPublic = generateOffers({ ...input, seed: await seedFrom('u1', 'offers', '1') }).map((j) => j.id).sort();
  const actual = st.jobs.offered.map((j: { id: string }) => j.id).sort();
  assert.deepEqual(actual, fromSecret);
  assert.notDeepEqual(actual, fromPublic);
  // Different players, same refresh index → different boards, because different secrets.
  const salt2 = row<{ offer_salt: string }>(raw, "SELECT offer_salt FROM farm_profiles WHERE user_id = 'u2'").offer_salt;
  assert.notEqual(salt2, salt);
});

test('H1: a profile from before 0054 (empty offer_salt) is issued a secret once, on its first read', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  await state(a);
  raw.prepare("UPDATE farm_profiles SET offer_salt = '' WHERE user_id = 'u1'").run();
  await state(a);
  const salt = row<{ offer_salt: string }>(raw, "SELECT offer_salt FROM farm_profiles WHERE user_id = 'u1'").offer_salt;
  assert.match(salt, /^[0-9a-f]{64}$/);
  await state(a);
  assert.equal(row<{ offer_salt: string }>(raw, "SELECT offer_salt FROM farm_profiles WHERE user_id = 'u1'").offer_salt, salt, 'stable afterwards');
});

test('H1: no route body carries offer_salt or an outcome_seed — player reads, every mutation, and the admin view', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  grant(raw, 20000);
  const bodies: Array<[string, unknown]> = [];
  const s = await state(a);
  bodies.push(['GET /state', s]);
  const secrets = () => {
    const salt = row<{ offer_salt: string }>(raw, "SELECT offer_salt FROM farm_profiles WHERE user_id = 'u1'").offer_salt;
    const seeds = (raw.prepare("SELECT outcome_seed FROM farm_assignments WHERE user_id = 'u1'").all() as Array<{ outcome_seed: string }>).map((r) => r.outcome_seed);
    return [salt, ...seeds].filter(Boolean);
  };
  const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
  const other = s.jobs.offered.find((j: { id: string }) => !j.id.startsWith('fjob_first_')).id;
  const p = s.printers[0].id, sp = s.spools[0].id;
  bodies.push(['profile', await json(await post(a, '/api/farm/profile', { farm_name: 'Sara Prints' }))]);
  bodies.push(['reject', await json(await post(a, `/api/farm/jobs/${other}/reject`))]);
  bodies.push(['accept', await json(await post(a, `/api/farm/jobs/${first}/accept`))]);
  const asg = await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }], allow_partial: true }));
  bodies.push(['assign', asg]);
  const asg2 = await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }] }));
  bodies.push(['assign-2', asg2]);
  bodies.push(['queue', await json(await post(a, `/api/farm/printers/${p}/queue`, { order: [asg2.assignments[0].assignment_id] }))]);
  bodies.push(['rename', await json(await post(a, `/api/farm/printers/${p}/rename`, { nickname: 'Bee' }))]);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  bodies.push(['GET /state after resolve', await state(a)]);
  bodies.push(['collect', await json(await post(a, `/api/farm/printers/${p}/collect`))]);
  bodies.push(['cancel', await json(await post(a, `/api/farm/jobs/${first}/cancel`))]);
  bodies.push(['filament', await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 250 }))]);
  const buy = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  bodies.push(['buy printer', buy]);
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  bodies.push(['maintain', await json(await post(a, `/api/farm/printers/${buy.printer_id}/maintain`))]);
  raw.prepare("UPDATE farm_printers SET state = 'broken', state_until = NULL WHERE id = ?").run(buy.printer_id);
  bodies.push(['repair', await json(await post(a, `/api/farm/printers/${buy.printer_id}/repair`))]);
  raw.prepare("UPDATE farm_printers SET state = 'idle', state_until = NULL WHERE id = ?").run(buy.printer_id);
  bodies.push(['sell', await json(await post(a, `/api/farm/market/printers/${buy.printer_id}/sell`))]);
  bodies.push(['GET /events', await json(await a.request('/api/farm/events?all=1'))]);
  bodies.push(['GET /ledger', await json(await a.request('/api/farm/ledger'))]);
  bodies.push(['GET /config', await json(await a.request('/api/farm/config'))]);
  bodies.push(['GET /leaderboard', await json(await appAs(db, null).request('/api/farm/leaderboard?board=farm_value'))]);
  bodies.push(['admin GET /players', await json(await appAs(db, 'boss', 'admin').request('/api/admin/farm/players/u1'))]);
  const secretValues = secrets();
  assert.ok(secretValues.length >= 3, 'the farm holds a salt and outcome seeds to look for');
  for (const [name, body] of bodies) {
    const text = JSON.stringify(body);
    assert.ok(!/"offer_salt"|"outcome_seed"/.test(text), `${name} exposes a secret field name`);
    for (const v of secretValues) assert.ok(!text.includes(v), `${name} contains a secret value`);
    assert.ok((body as { success: boolean }).success !== false || name === 'GET /leaderboard', `${name} failed: ${text.slice(0, 200)}`);
  }
});

// ------------------------------------------------------------------ H2

test('H2: SELL sandwiched around a resolver batch credits the resale exactly once', async () => {
  const { db, raw, gated } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  grant(raw, 5000); // the only machine: its sale must still leave a printer affordable (LAST_PRINTER guard)
  expireAnOffer(raw, 'u1'); // something for A's resolver to write
  const [ra, rb] = await sandwich(gated, isSell,
    () => post(a, `/api/farm/market/printers/${printer}/sell`),
    () => post(a, `/api/farm/market/printers/${printer}/sell`));
  const ba = await json(ra), bb = await json(rb);
  assert.equal(ba.success, true, JSON.stringify(ba));
  assert.equal(ba.credited, RESALE);
  assert.equal(bb.success, false, 'the loser is refused…');
  assert.equal(rb.status, 404, '…because after the re-read the machine is no longer theirs');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE user_id = 'u1' AND kind = 'printer_sale'"), 1, 'one credit');
  assert.equal(sum(raw), 1500 + 5000 + RESALE);
  assert.equal(row<{ id: string }>(raw, "SELECT id FROM farm_ledger WHERE kind = 'printer_sale'").id, `fl_sale_${printer}`, 'the id names the event');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_printers WHERE user_id = 'u1' AND sold_at IS NULL"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_printers WHERE user_id = 'u1'"), 1, 'the row is kept');
  assert.equal((await state(a)).profile.coins, 1500 + 5000 + RESALE);
});

test('H2: CANCEL sandwiched around a resolver batch refunds the queued grams exactly once', async () => {
  const { db, raw, gated } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
  const p = s.printers[0].id, sp = s.spools[0].id;
  await json(await post(a, `/api/farm/jobs/${first}/accept`));
  const a1 = await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }], allow_partial: true }));
  assert.equal(a1.success, true, JSON.stringify(a1));
  const a2 = await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }] }));
  assert.equal(a2.spools[0].grams_left, 500 - 24);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  expireAnOffer(raw, 'u1');
  const [ra, rb] = await sandwich(gated, isCancel,
    () => post(a, `/api/farm/jobs/${first}/cancel`),
    () => post(a, `/api/farm/jobs/${first}/cancel`));
  const ba = await json(ra), bb = await json(rb);
  assert.equal(ba.success, true, JSON.stringify(ba));
  assert.equal(ba.grams_refunded, 12);
  assert.equal(bb.success, false);
  assert.equal(row<{ grams_left: number }>(raw, 'SELECT grams_left FROM farm_spools WHERE id = ?', sp).grams_left, 500 - 24 + 12, 'the 12 g queued batch came back once; the printing 12 g are still on the bed');
  const prof = row<{ reputation_bp: number; stats_json: string }>(raw, "SELECT reputation_bp, stats_json FROM farm_profiles WHERE user_id = 'u1'");
  assert.equal(prof.reputation_bp, 1000 - cfg.customers.individual.cancel_penalty_bp);
  assert.equal(JSON.parse(prof.stats_json).cancelled, 1);
});

test('H2: MAINTAIN sandwiched around a resolver batch debits one service, with an id that names the order', async () => {
  const { db, raw, gated } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  expireAnOffer(raw, 'u1');
  const [ra, rb] = await sandwich(gated, isMaintain,
    () => post(a, `/api/farm/printers/${printer}/maintain`),
    () => post(a, `/api/farm/printers/${printer}/maintain`));
  const ba = await json(ra), bb = await json(rb);
  assert.equal(ba.success, true, JSON.stringify(ba));
  assert.equal(bb.code, 'PRINTER_BUSY');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE user_id = 'u1' AND kind = 'maintenance'"), 1);
  assert.equal(sum(raw), 1500 - cfg.economy.maintenance.cost, 'one service, one debit');
  const led = row<{ id: string; idempotency_key: string }>(raw, "SELECT id, idempotency_key FROM farm_ledger WHERE kind = 'maintenance'");
  assert.match(led.id, new RegExp(`^fl_maint_${printer}_\\d+$`));
  assert.equal(led.idempotency_key, `sys:${led.id}`);
});

test('H2: control — without a resolver write in between the fence still refuses the second sell', async () => {
  const { db, raw, gated } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  grant(raw, 5000); // see the LAST_PRINTER guard
  const [ra, rb] = await sandwich(gated, isSell,
    () => post(a, `/api/farm/market/printers/${printer}/sell`),
    () => post(a, `/api/farm/market/printers/${printer}/sell`));
  assert.equal((await json(ra)).success, true);
  assert.equal((await json(rb)).success, false);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE user_id = 'u1' AND kind = 'printer_sale'"), 1);
});

test('H2: a fence that is stale twice aborts with 409 STATE_CHANGED and commits nothing — not even the request memory', async () => {
  const { db, raw, gated } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const printer = s.printers[0].id;
  grant(raw, 5000); // see the LAST_PRINTER guard
  const before = row<{ revision: number }>(raw, "SELECT revision FROM farm_profiles WHERE user_id = 'u1'").revision;
  let bumps = 0;
  gated.hooks = {
    beforeBatch: (sqls) => {
      // Someone else moves the farm right before every intent batch.
      if (isSell(sqls)) { bumps += 1; raw.prepare("UPDATE farm_profiles SET revision = revision + 1 WHERE user_id = 'u1'").run(); }
    },
  };
  const k = key();
  const res = await a.request(`/api/farm/market/printers/${printer}/sell`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: k }),
  });
  gated.hooks = {};
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'STATE_CHANGED');
  assert.equal(bumps, 2, 'one retry, then the honest refusal');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'printer_sale'"), 0);
  assert.equal(row<{ sold_at: string | null }>(raw, 'SELECT sold_at FROM farm_printers WHERE id = ?', printer).sold_at, null);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_requests WHERE idempotency_key = ?', k), 0);
  assert.equal(row<{ revision: number }>(raw, "SELECT revision FROM farm_profiles WHERE user_id = 'u1'").revision, before + 2, 'only the outside bumps landed');
  // The same key, retried when the farm holds still, goes through.
  const ok = await json(await a.request(`/api/farm/market/printers/${printer}/sell`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: k }),
  }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.replayed, false);
});

test('H2: the cancel penalty and the customer-cancel penalty share one deterministic id per job', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
  await json(await post(a, `/api/farm/jobs/${first}/accept`));
  raw.prepare('UPDATE farm_jobs SET cancel_penalty_coins = 100 WHERE id = ?').run(first);
  const c = await json(await post(a, `/api/farm/jobs/${first}/cancel`));
  assert.equal(c.success, true, JSON.stringify(c));
  assert.equal(c.coins_penalty, 100);
  const led = row<{ id: string; idempotency_key: string; amount: number }>(raw, "SELECT id, idempotency_key, amount FROM farm_ledger WHERE kind = 'penalty'");
  assert.equal(led.id, `fl_cancelpen_${first}`);
  assert.equal(led.idempotency_key, `sys:fl_cancelpen_${first}`);
  assert.equal(led.amount, -100);
});

// ------------------------------------------------------------------ H3

test('H3: selling a printer keeps its batch history — the split job remembers its collected part, pays once; the slot comes free; the leaderboard ignores the sold machine', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
  const p1 = s.printers[0].id, sp = s.spools[0].id;
  grant(raw, 20000);
  const buy = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(buy.success, true, JSON.stringify(buy));
  const p2 = buy.printer_id;
  assert.equal(buy.slot, 1);
  await json(await post(a, `/api/farm/jobs/${first}/accept`));
  const asg = await json(await post(a, `/api/farm/jobs/${first}/assign`, {
    allocations: [{ printer_id: p1, qty: 1, spool_id: sp }, { printer_id: p2, qty: 1, spool_id: sp }],
  }));
  assert.equal(asg.success, true, JSON.stringify(asg));
  const [b1, b2] = asg.assignments;
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), b1.assignment_id);
  const col = await json(await post(a, `/api/farm/printers/${p1}/collect`));
  assert.equal(col.collected.outcome, 'done');
  assert.equal(col.delivered, null);
  assert.equal(col.jobs.active.find((j: { id: string }) => j.id === first).assignments_summary.collected, 1);

  // Sell the now-idle printer 1 (slot 0).
  const coinsBefore = sum(raw);
  const sell = await json(await post(a, `/api/farm/market/printers/${p1}/sell`));
  assert.equal(sell.success, true, JSON.stringify(sell));
  assert.equal(sell.credited, RESALE);
  assert.equal(sell.slot_freed, 0);
  assert.equal(sum(raw), coinsBefore + RESALE);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_assignments WHERE id = ?', b1.assignment_id), 1, 'the collected batch survives the sale');
  const soldRow = row<{ sold_at: string | null; slot: number; state: string }>(raw, 'SELECT sold_at, slot, state FROM farm_printers WHERE id = ?', p1);
  assert.ok(soldRow.sold_at, 'sold, not deleted');
  assert.equal(soldRow.slot, PARKED_SLOT_BASE + 0, 'the slot is parked, the original recoverable as slot % 1000000');
  assert.deepEqual(sell.printers.map((p: { id: string }) => p.id), [p2], 'the sold machine left the farm');
  const job = sell.jobs.active.find((j: { id: string }) => j.id === first);
  assert.equal(job.assignments_summary.collected, 1, 'the part already made is remembered');
  assert.equal(job.assignments_summary.remaining, 0);
  assert.equal((await post(a, `/api/farm/market/printers/${p1}/sell`)).status, 404, 'a sold machine cannot be sold again');
  assert.equal((await post(a, `/api/farm/printers/${p1}/collect`)).status, 404);

  // The freed slot 0 accepts a new purchase.
  const buy2 = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(buy2.success, true, JSON.stringify(buy2));
  assert.equal(buy2.slot, 0, 'the lowest free slot is the one just sold');
  assert.equal(buy2.printers.length, 2);
  const noSlot = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(noSlot.code, 'NO_FREE_SLOT', 'the sold row does not count against max_printers, the live ones do');
  // Selling from slot 0 a second time parks at +2,000,000 (UNIQUE holds).
  const sell2 = await json(await post(a, `/api/farm/market/printers/${buy2.printer_id}/sell`));
  assert.equal(sell2.success, true, JSON.stringify(sell2));
  assert.equal(row<{ slot: number }>(raw, 'SELECT slot FROM farm_printers WHERE id = ?', buy2.printer_id).slot, 2 * PARKED_SLOT_BASE);

  // The other part delivers and pays exactly once; stats keep the whole history.
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), b2.assignment_id);
  const st = await state(a);
  assert.equal(st.jobs.active.find((j: { id: string }) => j.id === first).state, 'ready');
  const col2 = await json(await post(a, `/api/farm/printers/${p2}/collect`));
  assert.equal(col2.collected.outcome, 'done');
  assert.ok(col2.delivered, 'two parts made, two collected → delivered');
  assert.equal(col2.delivered.reward_coins, col2.jobs.active.length === 0 ? col2.delivered.reward_coins : -1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE user_id = 'u1' AND kind = 'job_payout'"), 1);
  assert.equal(col2.profile.stats.delivered, 1);
  assert.equal(col2.profile.stats.parts, 2);
  assert.equal(row<{ prints: number }>(raw, 'SELECT prints FROM farm_printers WHERE id = ?', p1).prints, 1, 'the sold machine\'s own history stays');

  // Leaderboard farm value: coins + LIVE printers only (one A1 mini left).
  const lb = await json(await appAs(db, null).request('/api/farm/leaderboard?board=farm_value'));
  assert.equal(lb.rows[0].username, 'sara');
  assert.equal(lb.rows[0].score, sum(raw) + RESALE);
  // The admin view shows live machines only too.
  const admin = await json(await appAs(db, 'boss', 'admin').request('/api/admin/farm/players/u1'));
  assert.equal(admin.farm.printers.length, 1);
});

// ------------------------------------------------------------------ M4

test('M4: a client key that looks like a server key is refused; a legacy burned key cannot stop a print from finishing', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const { asg } = await acceptAndAssign(a, s);
  const asgId = asg.assignments[0].assignment_id as string;
  for (const bad of [`fl_energy_${asgId}`, `sys:fl_energy_${asgId}`, 'sys_energy_1234', 'req:abcdefgh', 'has:a:colon']) {
    const r = await post(a, '/api/farm/market/filament', { idempotencyKey: bad, material: 'PLA', color: 'black', grams: 250 });
    assert.equal(r.status, 400, bad);
    assert.equal((await json(r)).code, 'IDEMPOTENCY_KEY_INVALID', bad);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'filament_purchase'"), 0);
  // A row that occupies the raw resolver key (as Phase 1 let a player write) is
  // in another namespace now: the resolver writes `sys:` and lands.
  raw.prepare("INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key,note) VALUES ('legacy_burn','u1','admin_grant',1,?, 'burned')").run(`fl_energy_${asgId}`);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asgId);
  const st = await state(a);
  assert.equal(st.printers[0].current.state, 'done', 'the print finished');
  const energy = row<{ idempotency_key: string; id: string }>(raw, "SELECT id, idempotency_key FROM farm_ledger WHERE kind = 'electricity'");
  assert.equal(energy.id, `fl_energy_${asgId}`);
  assert.equal(energy.idempotency_key, `sys:fl_energy_${asgId}`);
  // Client-keyed rows store `req:<key>`.
  const k = key();
  const buy = await json(await post(a, '/api/farm/market/filament', { idempotencyKey: k, material: 'PLA', color: 'black', grams: 250 }));
  assert.equal(buy.success, true, JSON.stringify(buy));
  assert.equal(row<{ idempotency_key: string }>(raw, "SELECT idempotency_key FROM farm_ledger WHERE kind = 'filament_purchase'").idempotency_key, `req:${k}`);
});

test('M4: an unexpected resolver failure is logged and surfaces — it does not silently freeze the farm\'s clock', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const { asg } = await acceptAndAssign(a, s);
  const asgId = asg.assignments[0].assignment_id as string;
  // Occupy the resolver's PRIMARY KEY (not just its idempotency key): the
  // electricity INSERT must fail with something the fence did not cause.
  raw.prepare("INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key,note) VALUES (?,'u1','admin_grant',1,'adm:pk-squat','squat')").run(`fl_energy_${asgId}`);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asgId);
  const logged: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assert.rejects(() => Promise.resolve(a.request('/api/farm/state')), /UNIQUE|PRIMARY KEY/);
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => String(l[0]).includes('farm resolve failed')), 'the failure is logged');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM farm_assignments WHERE id = ?', asgId).state, 'printing', 'nothing half-applied');
  // Once the obstacle is gone the clock catches up on the next read.
  raw.prepare("DELETE FROM farm_ledger WHERE idempotency_key = 'adm:pk-squat'").run();
  const st = await state(a);
  assert.equal(st.printers[0].current.state, 'done');
});

// ------------------------------------------------------------------ L1

test('L1: every intent replays cleanly on its own key and refuses that key for another route', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  grant(raw, 30000);
  const s = await state(a);
  const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
  const [o1, o2] = s.jobs.offered.filter((j: { id: string }) => !j.id.startsWith('fjob_first_')).map((j: { id: string }) => j.id);
  const p = s.printers[0].id, sp = s.spools[0].id;
  const snapshot = () => ({
    ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'),
    assignments: count(raw, 'SELECT COUNT(*) AS n FROM farm_assignments'),
    printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'),
    spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'),
    jobs: raw.prepare('SELECT id, state FROM farm_jobs ORDER BY id').all(),
    requests: count(raw, 'SELECT COUNT(*) AS n FROM farm_requests'),
  });
  /** Send twice with one key: the second must be a replay carrying the first's result and changing nothing. */
  const twice = async (path: string, body: Record<string, unknown>, expectFields: string[]) => {
    const k = key();
    const r1 = await json(await post(a, path, { ...body, idempotencyKey: k }));
    assert.equal(r1.success, true, `${path}: ${JSON.stringify(r1)}`);
    assert.equal(r1.replayed, false);
    const snap = snapshot();
    const r2 = await json(await post(a, path, { ...body, idempotencyKey: k }));
    assert.equal(r2.success, true, `${path} replay: ${JSON.stringify(r2)}`);
    assert.equal(r2.replayed, true, `${path} must replay`);
    for (const f of expectFields) assert.deepEqual(r2[f], r1[f], `${path} replay carries ${f}`);
    assert.deepEqual(snapshot(), snap, `${path} replay wrote nothing`);
    return { k, r1 };
  };
  const acc = await twice(`/api/farm/jobs/${first}/accept`, {}, ['job_id']);
  await twice(`/api/farm/jobs/${o1}/reject`, {}, ['job_id']);
  await twice('/api/farm/profile', { farm_name: 'Replay Farm' }, ['farm_name']);
  const asg = await twice(`/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }], allow_partial: true }, ['job_id', 'assignments']);
  const asg2 = await twice(`/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }] }, ['job_id', 'assignments']);
  await twice(`/api/farm/printers/${p}/queue`, { order: [asg2.r1.assignments[0].assignment_id] }, ['order']);
  await twice(`/api/farm/printers/${p}/rename`, { nickname: 'Twin' }, ['nickname']);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.r1.assignments[0].assignment_id);
  await state(a);
  await twice(`/api/farm/printers/${p}/collect`, {}, ['collected', 'delivered']);
  await twice(`/api/farm/jobs/${first}/cancel`, {}, ['job_id', 'grams_refunded']);
  await twice('/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 250 }, ['spool_id', 'cost']);
  const buy = await twice('/api/farm/market/printers', { model_key: 'a1_mini' }, ['printer_id', 'slot', 'cost']);
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  await twice(`/api/farm/printers/${buy.r1.printer_id}/maintain`, {}, ['printer_id', 'cost', 'state_until']);
  raw.prepare("UPDATE farm_printers SET state = 'broken', state_until = NULL WHERE id = ?").run(buy.r1.printer_id);
  await twice(`/api/farm/printers/${buy.r1.printer_id}/repair`, {}, ['printer_id', 'cost']);
  raw.prepare("UPDATE farm_printers SET state = 'idle', state_until = NULL WHERE id = ?").run(buy.r1.printer_id);
  await twice(`/api/farm/market/printers/${buy.r1.printer_id}/sell`, {}, ['printer_id', 'credited']);

  // A spent key on ANOTHER route — or the same route for another job — is a reuse.
  for (const [path, body] of [
    [`/api/farm/jobs/${o2}/accept`, {}],
    ['/api/farm/market/filament', { material: 'PLA', color: 'red', grams: 250 }],
    [`/api/farm/printers/${p}/rename`, { nickname: 'X' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await post(a, path, { ...body, idempotencyKey: acc.k });
    assert.equal(r.status, 409, path);
    assert.equal((await json(r)).code, 'IDEMPOTENCY_KEY_REUSED', path);
  }
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM farm_jobs WHERE id = ?', o2).state, 'offered', 'nothing happened on the refused reuse');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_requests WHERE user_id = 'u1'"), 14, 'one memory row per accepted intent');
});

// ------------------------------------------------------------------ L2

test('L2: at the daily jobs cap collect still clears the bed; the payout waits and is paid on the next Baghdad day, judged late by hand-over time', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  const { id, job, asg } = await acceptAndAssign(a, s);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const today = baghdadDayOf(new Date().toISOString());
  raw.prepare('INSERT INTO farm_daily (user_id, day, coins_earned, jobs_delivered) VALUES (?, ?, 0, ?)').run('u1', today, cfg.limits.daily_jobs_cap);
  const before = await state(a);
  assert.deepEqual(before.limits, {
    max_active_jobs: cfg.jobs.max_active_jobs[0], storage_grams: cfg.locations.tiny_room.storage_grams,
    daily_jobs_cap: cfg.limits.daily_jobs_cap, daily_coins_cap: cfg.limits.daily_coins_cap,
    jobs_today: cfg.limits.daily_jobs_cap, coins_today: 0,
  }, 'the client can see why a payout would wait');

  const col = await post(a, `/api/farm/printers/${p}/collect`);
  assert.equal(col.status, 200, 'never a 429 on the bed');
  const c = await json(col);
  assert.equal(c.collected.outcome, 'done');
  assert.equal(c.delivered, null);
  assert.deepEqual(c.payout_deferred, { job_id: id, reward_coins: job.reward_coins, day: today, late: false, reason: 'daily_jobs_cap' });
  assert.equal(c.printers[0].state, 'idle', 'the printer is free');
  assert.equal(c.printers[0].current, null, 'the bed is clear');
  const held = c.jobs.active.find((j: { id: string }) => j.id === id);
  assert.equal(held.state, 'ready', 'the job stays visible…');
  assert.equal(held.payout_deferred_day, today, '…flagged as waiting');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 0);
  assert.equal(c.profile.stats.delivered, 0);
  const handedOver = row<{ delivered_at: string }>(raw, 'SELECT delivered_at FROM farm_jobs WHERE id = ?', id).delivered_at;
  assert.ok(Date.parse(handedOver) <= Date.now() && Date.parse(handedOver) > Date.now() - 60_000, 'delivered_at records the collect moment');
  // Reading again does not pay it today, the player cannot cancel done work,
  // and the slot it held is free for a new job.
  await state(a);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 0);
  assert.equal((await json(await post(a, `/api/farm/jobs/${id}/cancel`))).code, 'JOB_NOT_ACTIVE');
  const [o1, o2] = s.jobs.offered.filter((j: { id: string }) => j.id !== id).map((j: { id: string }) => j.id);
  assert.equal((await post(a, `/api/farm/jobs/${o1}/accept`)).status, 200);
  assert.equal((await post(a, `/api/farm/jobs/${o2}/accept`)).status, 200, 'the held job does not occupy an active slot');
  // The deadline passes (plus grace) while it waits: the customer has the parts,
  // no cancellation — and the hand-over (moved back here to before the deadline)
  // is what lateness will be judged on, not the day the coins arrive.
  raw.prepare('UPDATE farm_jobs SET deadline_at = ?, delivered_at = ? WHERE id = ?')
    .run(past(cfg.jobs.late_grace_minutes + 5), past(cfg.jobs.late_grace_minutes + 120), id);
  const waiting = await state(a);
  assert.equal(waiting.jobs.active.find((j: { id: string }) => j.id === id).state, 'ready');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM farm_jobs WHERE id = ?', id).state, 'ready');

  // A day passes: the hold day and the counters move to yesterday.
  const yday = yesterdayOf(today);
  raw.prepare('UPDATE farm_jobs SET payout_deferred_day = ? WHERE id = ?').run(yday, id);
  raw.prepare('UPDATE farm_daily SET day = ? WHERE user_id = ?').run(yday, 'u1');
  const paid = await state(a);
  assert.equal(paid.jobs.active.some((j: { id: string }) => j.id === id), false, 'delivered');
  const jobRow = row<{ state: string; delivered_at: string; deadline_at: string; payout_deferred_day: string | null }>(
    raw, 'SELECT state, delivered_at, deadline_at, payout_deferred_day FROM farm_jobs WHERE id = ?', id
  );
  assert.equal(jobRow.state, 'delivered');
  assert.equal(jobRow.payout_deferred_day, null);
  assert.ok(Date.parse(jobRow.delivered_at) < Date.parse(jobRow.deadline_at), 'delivered_at is the hand-over, untouched by the payout — and it was before the deadline');
  const payout = row<{ id: string; idempotency_key: string; amount: number }>(raw, "SELECT id, idempotency_key, amount FROM farm_ledger WHERE kind = 'job_payout'");
  assert.equal(payout.id, `fl_payout_${id}`);
  assert.equal(payout.idempotency_key, `sys:fl_payout_${id}`);
  assert.equal(payout.amount, job.reward_coins);
  assert.equal(paid.profile.coins, sum(raw));
  assert.equal(paid.profile.stats.delivered, 1);
  assert.equal(paid.profile.stats.late, 0, 'handed over before the deadline — late is judged on delivered_at, not payout time');
  assert.equal(paid.profile.reputation_bp, job.reputation_gain_bp);
  assert.equal(paid.profile.xp, cfg.progression.xp_per_job + 2 * cfg.progression.xp_per_part);
  assert.equal(paid.limits.jobs_today, 1);
  assert.equal(paid.limits.coins_today, job.reward_coins);
  await state(a);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 1, 'paid once');
});

test('L2: the coins cap defers too, and a deferred payout waits again when the next day is also full', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  const { id, job, asg } = await acceptAndAssign(a, s);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const today = baghdadDayOf(new Date().toISOString());
  raw.prepare('INSERT INTO farm_daily (user_id, day, coins_earned, jobs_delivered) VALUES (?, ?, ?, 1)').run('u1', today, cfg.limits.daily_coins_cap - job.reward_coins + 1);
  const c = await json(await post(a, `/api/farm/printers/${p}/collect`));
  assert.equal(c.payout_deferred.reason, 'daily_coins_cap');
  assert.equal(c.printers[0].current, null);
  // Yesterday's hold, but today is at the jobs cap: it waits, no error, no double.
  raw.prepare('UPDATE farm_jobs SET payout_deferred_day = ? WHERE id = ?').run(yesterdayOf(today), id);
  raw.prepare('UPDATE farm_daily SET coins_earned = 0, jobs_delivered = ? WHERE user_id = ?').run(cfg.limits.daily_jobs_cap, 'u1');
  const st = await state(a);
  assert.equal(st.jobs.active.find((j: { id: string }) => j.id === id).payout_deferred_day, yesterdayOf(today));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 0);
  raw.prepare('UPDATE farm_daily SET jobs_delivered = 0 WHERE user_id = ?').run('u1');
  const paid = await state(a);
  assert.equal(paid.jobs.active.length, 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 1);
});

// ------------------------------------------------------------------ L3

test('L3: an assistant admin reads the console and edits balancing, but limits, rewards and grants are 403', async () => {
  const { db, raw } = setup("INSERT INTO users (id,name,email,password_hash,role,username,admin_scope) VALUES ('helper','Assistant','helper@x.co','h','admin','helper','assistant'), ('full','Full','full@x.co','h','admin','full',NULL);");
  await state(appAs(db, 'u1'));
  const helper = appAs(db, 'helper', 'admin', { admin_scope: 'assistant' });
  const cfgRes = await json(await helper.request('/api/admin/farm/config'));
  assert.equal(cfgRes.success, true, 'the console is readable');
  const economy = await json(await send(helper, 'PUT', '/api/admin/farm/config/economy', { expected_version: 0, value: { ...cfg.economy, starter_coins: 1600 } }));
  assert.equal(economy.success, true, 'balancing sections stay editable');
  for (const [method, path, body] of [
    ['PUT', '/api/admin/farm/config/limits', { expected_version: 1, value: { ...cfg.limits, daily_coins_cap: 1_000_000_000 } }],
    ['PUT', '/api/admin/farm/config/rewards', { expected_version: 1, value: cfg.rewards }],
    ['POST', '/api/admin/farm/config/limits/reset', { confirm: 'RESET' }],
    ['POST', '/api/admin/farm/config/rewards/reset', { confirm: 'RESET' }],
    ['POST', '/api/admin/farm/players/u1/grant', { amount: 10_000_000, reason: 'because', idempotencyKey: 'assist-grant-1' }],
  ] as Array<[string, string, unknown]>) {
    const r = await send(helper, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal((await json(r)).code, 'FINANCIAL_SCOPE_REQUIRED', `${method} ${path}`);
  }
  const stored = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'printerFarmConfig'").value);
  assert.equal(stored.version, 1, 'no financial save landed');
  assert.deepEqual(stored.limits, cfg.limits);
  assert.equal(sum(raw), cfg.economy.starter_coins, 'no grant landed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('farm.admin_grant','farm.config_reset')"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'farm.config_update' AND target = 'limits'"), 0);
  // The owner and a full-scope admin may.
  const owner = appAs(db, 'boss', 'admin', { admin_scope: 'assistant' }); // even flagged, the owner is never restricted
  assert.equal((await send(owner, 'PUT', '/api/admin/farm/config/limits', { expected_version: 1, value: { ...cfg.limits, daily_jobs_cap: 150 } })).status, 200);
  const full = appAs(db, 'full', 'admin', { admin_scope: null });
  const g = await json(await send(full, 'POST', '/api/admin/farm/players/u1/grant', { amount: 100, reason: 'welcome', idempotencyKey: 'full-grant-1' }));
  assert.equal(g.success, true, JSON.stringify(g));
  assert.equal(row<{ idempotency_key: string }>(raw, "SELECT idempotency_key FROM farm_ledger WHERE kind = 'admin_grant'").idempotency_key, 'adm:full-grant-1', 'admin keys have their own namespace');
  // …and the player may spend the very same key for their own purchase.
  const player = appAs(db, 'u1');
  const buy = await json(await post(player, '/api/farm/market/filament', { idempotencyKey: 'full-grant-1', material: 'PLA', color: 'red', grams: 250 }));
  assert.equal(buy.success, true, JSON.stringify(buy));
});

// ------------------------------------------------------------------ L4

test('L4: repair stays open at level 1 while maintenance is locked — a broken starter printer is always recoverable', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  assert.equal(s.unlocks.maintenance, false);
  const m = await json(await post(a, `/api/farm/printers/${p}/maintain`));
  assert.equal(m.code, 'FEATURE_LOCKED');
  assert.deepEqual(m.details, { feature: 'maintenance', min_level: cfg.progression.unlocks.maintenance });
  raw.prepare("UPDATE farm_printers SET state = 'broken', health = 5 WHERE id = ?").run(p);
  const r = await json(await post(a, `/api/farm/printers/${p}/repair`));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.printers[0].state, 'maintenance');
  assert.equal(sum(raw), cfg.economy.starter_coins - cfg.economy.repair.cost);
  assert.equal((await post(a, '/api/farm/printers/nope/maintain')).status, 404, 'a stranger\'s or missing printer is still a 404, not a lock hint');
});

// ------------------------------------------------------------------ L5

test('L5: a late job whose last part finishes says ready — job_ready event, deliverable, state keeps the late overlay', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  const { id, asg } = await acceptAndAssign(a, s);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  raw.prepare('UPDATE farm_jobs SET deadline_at = ? WHERE id = ?').run(past(1), id);
  const late = await state(a);
  assert.equal(late.jobs.active.find((j: { id: string }) => j.id === id).state, 'late');
  assert.equal(late.events_unseen.some((e: { kind: string }) => e.kind === 'job_ready'), false);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const st = await state(a);
  const job = st.jobs.active.find((j: { id: string }) => j.id === id);
  assert.equal(st.printers[0].current.state, 'done');
  assert.equal(job.assignments_summary.done, 2);
  assert.equal(job.state, 'late', 'late stays the visible overlay');
  const ready = st.events_unseen.find((e: { kind: string }) => e.kind === 'job_ready');
  assert.ok(ready, 'job_ready was recorded');
  assert.equal(ready.payload.job_id, id);
  assert.equal(ready.payload.late, true);
  const col = await json(await post(a, `/api/farm/printers/${p}/collect`));
  assert.equal(col.delivered.late, true);
  assert.equal(col.profile.reputation_bp, 1000 - late.jobs.active[0].late_penalty_bp);
});

// ------------------------------------------------------------------ L6 + contract fields

test('L6: every printer is born with a name; a blank nickname falls back to model + slot; resale_coins is the sell credit', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  grant(raw, 20000);
  const s = await state(a);
  assert.notEqual(s.printers[0].nickname, '');
  assert.equal(s.printers[0].nickname, 'A1 mini 1');
  assert.equal(row<{ nickname: string }>(raw, 'SELECT nickname FROM farm_printers WHERE id = ?', s.printers[0].id).nickname, 'A1 mini 1', 'stored, not only projected');
  assert.equal(s.printers[0].resale_coins, RESALE);
  const buy = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(buy.success, true, JSON.stringify(buy));
  const bought = buy.printers.find((p: { id: string }) => p.id === buy.printer_id);
  assert.equal(bought.nickname, 'A1 mini 2');
  assert.equal(bought.slot, 1);
  // A legacy row with '' (or a player who cleared the name) still shows a name.
  raw.prepare("UPDATE farm_printers SET nickname = '' WHERE id = ?").run(s.printers[0].id);
  assert.equal((await state(a)).printers[0].nickname, 'A1 mini 1');
  const renamed = await json(await post(a, `/api/farm/printers/${s.printers[0].id}/rename`, { nickname: 'Old Faithful' }));
  assert.equal(renamed.printers[0].nickname, 'Old Faithful');
  const cleared = await json(await post(a, `/api/farm/printers/${s.printers[0].id}/rename`, { nickname: '' }));
  assert.equal(cleared.printers[0].nickname, 'A1 mini 1');
  // resale_coins is exactly what sell pays.
  const sold = await json(await post(a, `/api/farm/market/printers/${buy.printer_id}/sell`));
  assert.equal(sold.credited, bought.resale_coins);
  // The limits block travels with every state and mutation body.
  for (const body of [s, buy, renamed, sold]) {
    assert.deepEqual(Object.keys(body.limits).sort(), ['coins_today', 'daily_coins_cap', 'daily_jobs_cap', 'jobs_today', 'max_active_jobs', 'storage_grams']);
  }
  // Job projection carries the deferral flag (null when not deferred).
  assert.equal(s.jobs.offered[0].payout_deferred_day, null);
});

// ------------------------------------------------------------------ re-verification (second adversarial pass)
//
// What the second pass found and pinned: the market intents ignored
// `unlocks.market`; selling the only printer could strand a farm; `job_ready`
// said `late: false` when the print ended and the deadline passed in one
// resolution; and §7 measures that had no executable proof (rate limits, the
// Points wall, the database's own invariants, N-way races).

/** A D1 whose batch is ATOMIC (no await inside the transaction), so `Promise.all` over N requests interleaves only between statements — D1's own shape. */
class AtomicD1 {
  constructor(private readonly raw: DatabaseSync, private readonly inner: SqliteD1) {}
  prepare(sql: string) { return this.inner.prepare(sql); }
  async batch(statements: SqliteStatement[]) {
    await new Promise<void>((r) => setImmediate(r));
    this.raw.exec('BEGIN');
    try {
      const out = statements.map((s) => {
        const { sql, params } = s as unknown as { sql: string; params: unknown[] };
        const res = this.raw.prepare(sql).run(...(params as never[]));
        return { success: true, results: [], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid), duration: 0 } };
      });
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}
function setupAtomic() {
  const { raw } = setup();
  const db = new AtomicD1(raw, new SqliteD1(raw)) as unknown as D1Database;
  return { raw, db };
}
const bodies = async (rs: Response[]) => Promise.all(rs.map(async (r) => ({ status: r.status, body: await json(r) })));

test('R1: the three market intents are FEATURE_LOCKED below progression.unlocks.market — the tab the client hides is closed on the server', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  grant(raw, 50000);
  // Default: market opens at level 1 — every intent works.
  assert.equal((await json(await post(a, '/api/farm/market/filament', { material: 'PLA', color: 'black', grams: 250 }))).success, true);
  // The admin raises the unlock through the real route.
  const boss = appAs(db, 'boss', 'admin');
  const cur = await json(await boss.request('/api/admin/farm/config'));
  const put = await json(await send(boss, 'PUT', '/api/admin/farm/config/progression', {
    expected_version: cur.version, value: { ...cur.config.progression, unlocks: { ...cur.config.progression.unlocks, market: 2 } },
  }));
  assert.equal(put.success, true, JSON.stringify(put));
  const st = await state(a);
  assert.equal(st.unlocks.market, false);
  const before = { ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'), spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'), printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers') };
  for (const [path, body] of [
    ['/api/farm/market/filament', { material: 'PLA', color: 'black', grams: 250 }],
    ['/api/farm/market/printers', { model_key: 'a1_mini' }],
    [`/api/farm/market/printers/${p}/sell`, {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await post(a, path, body);
    assert.equal(r.status, 409, path);
    const b = await json(r);
    assert.equal(b.code, 'FEATURE_LOCKED', path);
    assert.deepEqual(b.details, { feature: 'market', min_level: 2 });
  }
  assert.deepEqual({ ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'), spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'), printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers') }, before, 'nothing moved');
  // Level 2 reopens it.
  raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
  assert.equal((await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }))).success, true);
});

test('R2: LAST_PRINTER — the only machine cannot be sold into a dead farm; with enough coins it can; a busy machine is still PRINTER_BUSY first', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  const cheapest = Math.min(...Object.values(cfg.printers).filter((m) => m.min_level <= 1).map((m) => m.price));
  assert.ok(cfg.economy.starter_coins + RESALE < cheapest, 'the defaults would strand a new player who sells the starter');
  const refused = await post(a, `/api/farm/market/printers/${p}/sell`);
  assert.equal(refused.status, 409);
  const rb = await json(refused);
  assert.equal(rb.code, 'LAST_PRINTER');
  assert.deepEqual(rb.details, { coins_after_sale: cfg.economy.starter_coins + RESALE, cheapest_printer_coins: cheapest });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'printer_sale'"), 0);
  assert.equal(row<{ sold_at: string | null }>(raw, 'SELECT sold_at FROM farm_printers WHERE id = ?', p).sold_at, null);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_requests WHERE user_id = 'u1'"), 0, 'a refusal writes no memory');
  // Busy takes precedence: the reason the player sees is the real one.
  await acceptAndAssign(a, s);
  assert.equal((await json(await post(a, `/api/farm/market/printers/${p}/sell`))).code, 'PRINTER_BUSY');
  // With the proceeds covering another machine the sale is a normal sale.
  const { db: db2, raw: raw2 } = setup();
  const a2 = appAs(db2, 'u1');
  const s2 = await state(a2);
  grant(raw2, cheapest - cfg.economy.starter_coins - RESALE);
  const ok = await json(await post(a2, `/api/farm/market/printers/${s2.printers[0].id}/sell`));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(sum(raw2), cheapest, 'exactly enough to buy the cheapest model again');
  const rebuy = await json(await post(a2, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal(rebuy.success, true, JSON.stringify(rebuy));
  // Two machines: the first sale is never the last.
  const { db: db3, raw: raw3 } = setup();
  const a3 = appAs(db3, 'u1');
  const s3 = await state(a3);
  grant(raw3, 20000);
  const buy = await json(await post(a3, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  assert.equal((await json(await post(a3, `/api/farm/market/printers/${s3.printers[0].id}/sell`))).success, true);
  assert.equal((await json(await post(a3, `/api/farm/market/printers/${buy.printer_id}/sell`))).success, true, 'coins cover a rebuy');
});

test('R3: job_ready.late is judged on the deadline — a print that ends in the same resolution in which the deadline passes is announced late, and paid late', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const { id, asg } = await acceptAndAssign(a, s);
  raw.prepare("UPDATE farm_profiles SET reputation_bp = 1000 WHERE user_id = 'u1'").run();
  raw.prepare('UPDATE farm_jobs SET deadline_at = ? WHERE id = ?').run(past(1), id);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  const st = await state(a); // ONE resolution: step 1 finishes the print, step 5 marks the job late
  const job = st.jobs.active.find((j: { id: string }) => j.id === id);
  assert.equal(job.state, 'late');
  const ready = st.events_unseen.find((e: { kind: string }) => e.kind === 'job_ready');
  assert.ok(ready);
  assert.equal(ready.payload.late, true, 'the sheet says late, as the payout will');
  assert.ok(st.events_unseen.some((e: { kind: string }) => e.kind === 'job_late'));
  const col = await json(await post(a, `/api/farm/printers/${s.printers[0].id}/collect`));
  assert.equal(col.delivered.late, true);
  assert.equal(col.profile.reputation_bp, 1000 - job.late_penalty_bp);
  assert.equal(row<{ note: string }>(raw, "SELECT note FROM farm_ledger WHERE kind = 'job_payout'").note, 'job delivered late');
  // Control: a job whose deadline is still ahead says late: false.
  const { db: db2, raw: raw2 } = setup();
  const a2 = appAs(db2, 'u1');
  const s2 = await state(a2);
  const r2 = await acceptAndAssign(a2, s2);
  raw2.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), r2.asg.assignments[0].assignment_id);
  const st2 = await state(a2);
  assert.equal(st2.events_unseen.find((e: { kind: string }) => e.kind === 'job_ready').payload.late, false);
});

test('R4: per-user rate limits — farm-mutate refuses request limits.mutations_per_hour + 1; farm-buy refuses the 31st purchase; another user is untouched', async () => {
  const { db } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const p = s.printers[0].id;
  let refusedAt = -1;
  for (let i = 0; i < cfg.limits.mutations_per_hour + 1; i++) {
    const r = await post(a, `/api/farm/printers/${p}/rename`, { nickname: `n${i}` });
    if (r.status === 429) { refusedAt = i; break; }
    assert.equal(r.status, 200, `attempt ${i}`);
  }
  assert.equal(refusedAt, cfg.limits.mutations_per_hour, 'the limit is the configured value, checked before anything else');
  const b = appAs(db, 'u2');
  const sb = await state(b);
  assert.equal((await post(b, `/api/farm/printers/${sb.printers[0].id}/rename`, { nickname: 'free' })).status, 200, 'another user is not throttled');
  // farm-buy: 30 per hour on the two purchases, whatever their outcome.
  let buyRefusedAt = -1;
  for (let i = 0; i < 31; i++) {
    const r = await post(b, '/api/farm/market/printers', { model_key: 'a1_mini' }); // refused as INSUFFICIENT_COINS, still counted
    if (r.status === 429) { buyRefusedAt = i; break; }
  }
  assert.equal(buyRefusedAt, 30);
});

test('R5: the Points wall — no wallet, points or ticket row moves through a whole farm loop, and the farm modules import none of that code', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%wallet%' OR name LIKE '%point%' OR name LIKE '%ticket%' OR name LIKE 'game_%')").all() as Array<{ name: string }>).map((t) => t.name);
  assert.ok(tables.includes('wallet_transactions') && tables.includes('ticket_ledger') && tables.includes('game_sessions'));
  const snapshot = () => Object.fromEntries(tables.map((t) => [t, count(raw, `SELECT COUNT(*) AS n FROM ${t}`)]));
  const before = snapshot();
  const s = await state(a);
  grant(raw, 20000);
  const { asg } = await acceptAndAssign(a, s);
  raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
  await state(a);
  assert.ok((await json(await post(a, `/api/farm/printers/${s.printers[0].id}/collect`))).delivered);
  const buy = await json(await post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }));
  await json(await post(a, `/api/farm/market/printers/${buy.printer_id}/sell`));
  await json(await send(appAs(db, 'boss', 'admin'), 'POST', '/api/admin/farm/players/u1/grant', { amount: 5, reason: 'welcome gift', idempotencyKey: 'r5-grant-0001' }));
  assert.deepEqual(snapshot(), before, 'Farm Coins moved; Levonis Points, wallets and tickets did not');
  // Static: the farm server code does not reach for the wallet/points modules.
  const files = [...readdirSync(join(ROOT, 'worker/lib/farm')).map((f) => join(ROOT, 'worker/lib/farm', f)), join(ROOT, 'worker/routes/farm.ts'), join(ROOT, 'worker/routes/farmAdmin.ts')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const forbidden of ['/wallet', '/walletOps', '/walletNotify', '/pointsOps', '/membershipOps', 'wallet_transactions', 'ticket_ledger']) {
      assert.ok(!src.includes(forbidden), `${f} references ${forbidden}`);
    }
  }
});

test('R6: the database holds its own invariants — over-booking, a second printing batch, a negative spool and an overdraft are refused by SQLite itself', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'u1');
  const s = await state(a);
  const { id, asg } = await acceptAndAssign(a, s);
  const p = s.printers[0].id, sp = s.spools[0].id;
  const ins = (rowId: string, jobId: string, printerId: string, stateV: string, qty: number) =>
    raw.prepare(`INSERT INTO farm_assignments (id,user_id,job_id,printer_id,spool_id,qty,grams,seconds,quality,position,state,started_at,ends_at,outcome_seed)
                 VALUES (?,'u1',?,?,?,?,1,1,'standard',9,?,?,?,'x')`).run(rowId, jobId, printerId, sp, qty, stateV, past(1), past(1));
  assert.throws(() => ins('evil1', id, p, 'queued', 1), /FARM_QTY_EXCEEDED/, 'the job is fully booked');
  raw.exec(`INSERT INTO farm_jobs (id,user_id,state,customer_tier,product_key,qty,material,colors_json,grams,print_seconds,quality,reward_coins,offered_at,offer_expires_at,deadline_at,accepted_at,seed)
            VALUES ('j9','u1','accepted','individual','cable_clip',1,'PLA','["black"]',6,600,'standard',40,'${past(1)}','${future(60)}','${future(120)}','${past(1)}','s')`);
  assert.throws(() => ins('evil2', 'j9', p, 'printing', 1), /UNIQUE|idx_farm_assignments_one_printing/, 'one printing batch per printer');
  assert.throws(() => raw.prepare('UPDATE farm_spools SET grams_left = grams_left - 100000 WHERE id = ?').run(sp), /CHECK|grams_left/);
  assert.throws(() => raw.prepare("INSERT INTO farm_ledger (id,user_id,kind,amount,idempotency_key) VALUES ('od','u1','maintenance',-1000000,'sys:od')").run(), /FARM_INSUFFICIENT_COINS/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_assignments'), 1);
  void asg;
});

test('R7: five concurrent distinct-key intents of every money-moving kind apply exactly once (atomic batches, real interleaving)', async () => {
  const N = 5;
  // Sell.
  {
    const { db, raw } = setupAtomic();
    const a = appAs(db, 'u1');
    const s = await state(a);
    grant(raw, 5000);
    expireAnOffer(raw, 'u1');
    const rs = await bodies(await Promise.all(Array.from({ length: N }, () => post(a, `/api/farm/market/printers/${s.printers[0].id}/sell`))));
    assert.equal(rs.filter((r) => r.body.success).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
    assert.ok(rs.every((r) => r.status !== 500));
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'printer_sale'"), 1);
    assert.equal(sum(raw), 1500 + 5000 + RESALE);
  }
  // Cancel with a queued batch and a coin penalty.
  {
    const { db, raw } = setupAtomic();
    const a = appAs(db, 'u1');
    const s = await state(a);
    const first = s.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_')).id;
    const p = s.printers[0].id, sp = s.spools[0].id;
    await json(await post(a, `/api/farm/jobs/${first}/accept`));
    await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }], allow_partial: true }));
    await json(await post(a, `/api/farm/jobs/${first}/assign`, { allocations: [{ printer_id: p, qty: 1, spool_id: sp }] }));
    raw.prepare('UPDATE farm_jobs SET cancel_penalty_coins = 100 WHERE id = ?').run(first);
    const rs = await bodies(await Promise.all(Array.from({ length: N }, () => post(a, `/api/farm/jobs/${first}/cancel`))));
    assert.equal(rs.filter((r) => r.body.success).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
    assert.equal(row<{ grams_left: number }>(raw, 'SELECT grams_left FROM farm_spools WHERE id = ?', sp).grams_left, 500 - 24 + 12, 'refunded once');
    assert.equal(sum(raw), 1500 - 100, 'penalised once');
    assert.equal(JSON.parse(row<{ stats_json: string }>(raw, "SELECT stats_json FROM farm_profiles WHERE user_id = 'u1'").stats_json).cancelled, 1);
  }
  // Collect of a finished job — the first request's resolver flips the print, the others race it.
  {
    const { db, raw } = setupAtomic();
    const a = appAs(db, 'u1');
    const s = await state(a);
    const { job, asg } = await acceptAndAssign(a, s);
    raw.prepare('UPDATE farm_assignments SET ends_at = ?, failure_p = 0 WHERE id = ?').run(past(1), asg.assignments[0].assignment_id);
    const rs = await bodies(await Promise.all(Array.from({ length: N }, () => post(a, `/api/farm/printers/${s.printers[0].id}/collect`))));
    assert.equal(rs.filter((r) => r.body.success).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'job_payout'"), 1);
    assert.equal(row<{ amount: number }>(raw, "SELECT amount FROM farm_ledger WHERE kind = 'job_payout'").amount, job.reward_coins);
    assert.equal(JSON.parse(row<{ stats_json: string }>(raw, "SELECT stats_json FROM farm_profiles WHERE user_id = 'u1'").stats_json).delivered, 1);
  }
  // Maintain.
  {
    const { db, raw } = setupAtomic();
    const a = appAs(db, 'u1');
    const s = await state(a);
    raw.prepare("UPDATE farm_profiles SET level = 2 WHERE user_id = 'u1'").run();
    const rs = await bodies(await Promise.all(Array.from({ length: N }, () => post(a, `/api/farm/printers/${s.printers[0].id}/maintain`))));
    assert.equal(rs.filter((r) => r.body.success).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
    assert.equal(sum(raw), 1500 - cfg.economy.maintenance.cost);
  }
  // Printer purchase with coins for exactly one.
  {
    const { db, raw } = setupAtomic();
    const a = appAs(db, 'u1');
    await state(a);
    grant(raw, cfg.printers.a1_mini.price - 1500);
    const rs = await bodies(await Promise.all(Array.from({ length: N }, () => post(a, '/api/farm/market/printers', { model_key: 'a1_mini' }))));
    assert.equal(rs.filter((r) => r.body.success).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
    assert.equal(sum(raw), 0);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_printers WHERE user_id = 'u1' AND sold_at IS NULL"), 2);
  }
});
