/**
 * THE PRINTER FARM IS SHELVED — «قريبا — تحت التطوير».
 *
 * The owner asked for the farm to be marked coming-soon on the games page and
 * for its page not to be shown to customers. This suite pins what that had to
 * mean to be true rather than decorative:
 *
 *   * THE SERVER REFUSES, not just the app. worker/routes/farm.ts is the game
 *     engine — it pays coins, burns filament and moves jobs — so every player
 *     route, the public leaderboard included, answers 503 FARM_SHELVED to a
 *     customer while the game is closed, and a refused request creates nothing:
 *     no farm, no ledger row, no starter kit;
 *   * IT SHIPS CLOSED. With no `admin_settings.printerFarmShelved` row the
 *     game is shelved, so the deploy itself carries out the instruction. Only
 *     the literal `{"open": true}` opens it — a blank, a malformed value or
 *     `{"open": "true"}` all read as closed, because an unreadable value is
 *     not a decision anybody made;
 *   * THE ADMIN DOOR STAYS OPEN, on the existing `users.role` check and
 *     nothing new: an admin reads state, plays and tests while it is shut;
 *   * ONE SWITCH, NO DEPLOY. One settings write opens the game and another
 *     closes it, through an audited admin route; opening starts a coin economy
 *     so it needs financial scope, closing is a safety action any admin may
 *     take;
 *   * SHELVING IS NOT A WIPE. Everything a player earned before the game was
 *     closed is still there, byte for byte, when it reopens;
 *   * and the client half — the hub still LISTS the farm with the notice, the
 *     farm page is not rendered at all, and none of the copy is invented.
 *
 * The real routes run against the real migrations through the SQLite adapter;
 * only the session is stubbed. The client half is read as source, the way the
 * other farm client suites do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost } from '../worker/lib/hosts';
import { FARM_SHELVED_SETTING_KEY, farmOpenFromSetting, farmRoutes } from '../worker/routes/farm';
import { farmAdminRoutes } from '../worker/routes/farmAdmin';
import { FARM_STRINGS } from '../src/pages/farm/strings';
import { farmAccessOf } from '../src/pages/farm/shelved';

// ------------------------------------------------------------------ harness

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,admin_scope) VALUES
      ('u1','Sara','sara@x.co','h','customer','sara',NULL),
      ('boss','Owner','a@x.co','h','admin','boss',NULL),
      ('helper','Assistant','h@x.co','h','admin','helper','assistant');
  `);
  // No printerFarmShelved row on purpose: that IS the shipped state.
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const SCOPE: Record<string, string | null> = { u1: null, boss: null, helper: 'assistant' };

function appAs(db: D1Database, userId: string | null, role = 'customer', host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) {
      c.set('user', {
        id: userId, role, email: `${userId === 'boss' ? 'a' : userId}@x.co`, username: userId, admin_scope: SCOPE[userId] ?? null,
      } as never);
    }
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co' } as never;
    await next();
  });
  // Exactly how worker/index.ts wires the two routers.
  a.use('/api/admin/*', requireMainHost);
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
const post = (a: App, path: string, body: Record<string, unknown> = {}) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ idempotencyKey: `shelved-${++keyN}-abcdefgh`, ...body }),
  });
const put = (a: App, path: string, body: Record<string, unknown>) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Write the switch the way the admin route does, without going through it. */
const setSwitch = (raw: DatabaseSync, value: string) =>
  raw
    .prepare('INSERT INTO admin_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(FARM_SHELVED_SETTING_KEY, value);
const openGame = (raw: DatabaseSync) => setSwitch(raw, '{"open":true}');
const count = (raw: DatabaseSync, sql: string) => (raw.prepare(sql).get() as { n: number }).n;

/** Every player route a customer could reach, one of each shape. */
const PLAYER_READS = ['/api/farm/state', '/api/farm/config', '/api/farm/ledger', '/api/farm/events', '/api/farm/leaderboard'];
const PLAYER_WRITES: Array<[string, Record<string, unknown>]> = [
  ['/api/farm/profile', { farm_name: 'Mine' }],
  ['/api/farm/jobs/fjob_x/accept', {}],
  ['/api/farm/jobs/fjob_x/assign', { allocations: [] }],
  ['/api/farm/printers/fp_x/collect', {}],
  ['/api/farm/market/filament', { material: 'PLA', color: 'black', grams: 250 }],
  ['/api/farm/market/printers', { model_key: 'a1_mini' }],
  ['/api/farm/events/seen', { ids: ['fev_1'] }],
];

// ------------------------------------------------------- the server refuses

test('shipped closed: with no settings row every player route refuses a customer with 503 FARM_SHELVED, and a guest too', async () => {
  const { db, raw } = setup();
  const player = appAs(db, 'u1');
  const guest = appAs(db, null);

  for (const path of PLAYER_READS) {
    for (const [who, a] of [['a customer', player], ['a guest', guest]] as const) {
      const res = await a.request(path);
      assert.equal(res.status, 503, `${path} answered ${res.status} to ${who}`);
      const body = await json(res);
      assert.equal(body.success, false);
      assert.equal(body.code, 'FARM_SHELVED', `${path} → ${JSON.stringify(body)}`);
      assert.equal(body.details?.shelved, true, `${path} says which switch refused it`);
      // The refusal is honest about what it is: the sentence names the game and
      // its state, and does not pretend the route is missing.
      assert.match(body.error, /قريبا|under development/);
    }
  }
  for (const [path, body] of PLAYER_WRITES) {
    const res = await post(player, path, body);
    assert.equal(res.status, 503, `${path} answered ${res.status}`);
    assert.equal((await json(res)).code, 'FARM_SHELVED', path);
  }

  // NOTHING WAS CREATED. /state bootstraps a farm when it runs at all, so the
  // refusal has to come first: no profile, no starter coins, no printer.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_profiles'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM farm_jobs'), 0);
});

test('503, not 404: the route answers, and the client can tell a shelved game from a missing one', async () => {
  const { db } = setup();
  const res = await appAs(db, 'u1').request('/api/farm/state');
  assert.equal(res.status, 503);
  assert.notEqual(res.status, 404, 'a 404 would claim there was never a farm here');
  const body = await json(res);
  assert.equal(body.code, 'FARM_SHELVED');
  // The client has a sentence for that code in all three languages, so the
  // refusal never reaches a player as raw English.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(FARM_STRINGS[lang].errors.FARM_SHELVED, `${lang}.errors.FARM_SHELVED missing`);
  }
});

test('GET /status always answers, and tells each caller the truth', async () => {
  const { db, raw } = setup();
  for (const [who, a, mayPlay, isAdmin] of [
    ['a guest', appAs(db, null), false, false],
    ['a customer', appAs(db, 'u1'), false, false],
    ['an admin', appAs(db, 'boss', 'admin'), true, true],
  ] as const) {
    const res = await a.request('/api/farm/status');
    assert.equal(res.status, 200, `${who} was refused the status`);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'the answer that hides a page is never cached');
    const body = await json(res);
    assert.deepEqual(
      { shelved: body.shelved, admin: body.admin, may_play: body.may_play },
      { shelved: true, admin: isAdmin, may_play: mayPlay },
      `${who}: ${JSON.stringify(body)}`
    );
  }
  // One settings write and the same question gets the opposite answer.
  openGame(raw);
  for (const [who, a] of [['a guest', appAs(db, null)], ['a customer', appAs(db, 'u1')]] as const) {
    const body = await json(await a.request('/api/farm/status'));
    assert.equal(body.shelved, false, who);
    assert.equal(body.may_play, true, who);
  }
});

test('the admin door: an admin reads, bootstraps and plays while the game is shelved', async () => {
  const { db, raw } = setup();
  const boss = appAs(db, 'boss', 'admin');
  const state = await json(await boss.request('/api/farm/state'));
  assert.equal(state.success, true, JSON.stringify(state));
  assert.equal(state.printers.length, 1, 'the starter kit was created for the admin');
  assert.ok(state.profile.coins > 0);
  // And a MUTATION, not just a read: the admin can actually play it.
  const offered = state.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_'));
  assert.ok(offered, 'the starter job is offered');
  const accepted = await json(await post(boss, `/api/farm/jobs/${offered.id}/accept`));
  assert.equal(accepted.success, true, JSON.stringify(accepted));
  // The admin's own farm is the only one that exists; no customer was bootstrapped.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_profiles WHERE user_id = 'boss'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM farm_profiles WHERE user_id = 'u1'"), 0);
  // The leaderboard is open to an admin too, and still refused to everyone else.
  assert.equal((await boss.request('/api/farm/leaderboard')).status, 200);
  assert.equal((await appAs(db, 'u1').request('/api/farm/leaderboard')).status, 503);
});

test('one settings write opens the game and another closes it — no deploy in between', async () => {
  const { db, raw } = setup();
  const player = appAs(db, 'u1');
  assert.equal((await player.request('/api/farm/state')).status, 503);

  openGame(raw);
  const opened = await json(await player.request('/api/farm/state'));
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal((await appAs(db, null).request('/api/farm/leaderboard')).status, 200, 'the public board is back');

  setSwitch(raw, '{"open":false}');
  assert.equal((await player.request('/api/farm/state')).status, 503);
  assert.equal((await appAs(db, null).request('/api/farm/leaderboard')).status, 503);
});

test('only an explicit {"open": true} opens the game; everything unreadable stays shut', async () => {
  for (const [stored, opens] of [
    ['{"open":true}', true],
    ['{"open": true, "updated_at": "2026-09-15T00:00:00.000Z", "by": "boss"}', true],
    ['{"open":false}', false],
    ['{"open":"true"}', false],
    ['{"open":1}', false],
    ['{}', false],
    ['[]', false],
    ['[{"open":true}]', false],
    ['null', false],
    ['true', false],
    ['', false],
    ['   ', false],
    ['not json at all', false],
  ] as const) {
    assert.equal(farmOpenFromSetting(stored), opens, `stored ${JSON.stringify(stored)}`);
  }
  assert.equal(farmOpenFromSetting(null), false, 'a missing row is shelved');
  assert.equal(farmOpenFromSetting(undefined), false);

  // And through the real route, so the parser and the guard agree.
  const { db, raw } = setup();
  const player = appAs(db, 'u1');
  for (const stored of ['{"open":"true"}', 'not json at all', '{}']) {
    setSwitch(raw, stored);
    assert.equal((await player.request('/api/farm/state')).status, 503, `stored ${stored}`);
  }
  openGame(raw);
  assert.equal((await player.request('/api/farm/state')).status, 200);
});

// ------------------------------------------------------- nothing is destroyed

test('shelving is not a wipe: every coin, printer and job survives the close and is there on reopening', async () => {
  const { db, raw } = setup();
  openGame(raw);
  const player = appAs(db, 'u1');
  const before = await json(await player.request('/api/farm/state'));
  assert.equal(before.success, true);
  const offered = before.jobs.offered.find((j: { id: string }) => j.id.startsWith('fjob_first_'));
  assert.equal((await json(await post(player, `/api/farm/jobs/${offered.id}/accept`))).success, true);
  await post(player, '/api/farm/profile', { farm_name: 'مزرعة سارة' });

  const snapshot = () => ({
    profiles: count(raw, 'SELECT COUNT(*) AS n FROM farm_profiles'),
    ledger: count(raw, 'SELECT COUNT(*) AS n FROM farm_ledger'),
    coins: count(raw, "SELECT COALESCE(SUM(amount),0) AS n FROM farm_ledger WHERE user_id = 'u1'"),
    printers: count(raw, 'SELECT COUNT(*) AS n FROM farm_printers'),
    spools: count(raw, 'SELECT COUNT(*) AS n FROM farm_spools'),
    jobs: count(raw, 'SELECT COUNT(*) AS n FROM farm_jobs'),
    events: count(raw, 'SELECT COUNT(*) AS n FROM farm_events'),
  });
  const kept = snapshot();
  assert.ok(kept.coins > 0 && kept.printers > 0 && kept.jobs > 0, `nothing to lose: ${JSON.stringify(kept)}`);

  setSwitch(raw, '{"open":false}');
  assert.equal((await player.request('/api/farm/state')).status, 503, 'the door is shut');
  // Shutting the door touched not one row.
  assert.deepEqual(snapshot(), kept, 'shelving deleted or changed something');
  // Nor does traffic against the shut door.
  for (const path of PLAYER_READS) await player.request(path);
  for (const [path, body] of PLAYER_WRITES) await post(player, path, body);
  assert.deepEqual(snapshot(), kept, 'a refused request still moved state');

  openGame(raw);
  const after = await json(await player.request('/api/farm/state'));
  assert.equal(after.success, true);
  assert.equal(after.profile.farm_name, 'مزرعة سارة', 'the farm came back with its name');
  assert.equal(after.profile.coins, before.profile.coins, 'no coin was clawed back');
  assert.equal(after.printers.length, before.printers.length);
  assert.equal(after.spools.length, before.spools.length);
  assert.ok(after.jobs.active.some((j: { id: string }) => j.id === offered.id), 'the accepted job is still accepted');
});

// ------------------------------------------------------------ the admin route

test('PUT /api/admin/farm/shelved is the one write path: audited, scoped, and refused to everyone else', async () => {
  const { db, raw } = setup();
  const owner = appAs(db, 'boss', 'admin');
  const assistant = appAs(db, 'helper', 'admin');
  const player = appAs(db, 'u1');

  assert.equal((await json(await owner.request('/api/admin/farm/shelved'))).shelved, true, 'it reads as shipped: closed');

  // A customer cannot reach the switch at all.
  assert.equal((await put(player, '/api/admin/farm/shelved', { open: true })).status, 403);
  assert.equal((await put(appAs(db, null), '/api/admin/farm/shelved', { open: true })).status, 401);

  // An assistant admin may CLOSE but not OPEN: opening starts a coin economy.
  const refused = await put(assistant, '/api/admin/farm/shelved', { open: true });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal((await appAs(db, 'u1').request('/api/farm/state')).status, 503, 'and it did not open');

  const badBody = await put(owner, '/api/admin/farm/shelved', { open: 'yes' });
  assert.equal(badBody.status, 400);
  assert.equal((await json(badBody)).code, 'FARM_OPEN_REQUIRED');

  const opened = await json(await put(owner, '/api/admin/farm/shelved', { open: true }));
  assert.deepEqual({ shelved: opened.shelved, changed: opened.changed }, { shelved: false, changed: true });
  assert.equal((await player.request('/api/farm/state')).status, 200, 'the owner opened it for real');

  // Closing it again is allowed to the assistant, and is idempotent in meaning.
  const closed = await json(await put(assistant, '/api/admin/farm/shelved', { open: false }));
  assert.equal(closed.shelved, true);
  assert.equal((await player.request('/api/farm/state')).status, 503);

  // Every flip is traceable to a person and a direction.
  const trail = raw
    .prepare("SELECT actor_id, target, detail FROM audit_log WHERE action = 'farm.shelved_update' ORDER BY id")
    .all() as Array<{ actor_id: string; target: string; detail: string }>;
  assert.equal(trail.length, 2, `expected one audit row per flip: ${JSON.stringify(trail)}`);
  assert.deepEqual(trail.map((r) => r.actor_id), ['boss', 'helper']);
  assert.equal(trail[0].target, FARM_SHELVED_SETTING_KEY);
  assert.deepEqual(JSON.parse(trail[0].detail), { before_shelved: true, after_shelved: false });
  assert.deepEqual(JSON.parse(trail[1].detail), { before_shelved: false, after_shelved: true });

  // The whole admin surface is still apex-only: a storefront host sees nothing.
  const onStore = appAs(db, 'boss', 'admin', 'shop.levonis-iq.com');
  assert.equal((await onStore.request('/api/admin/farm/shelved')).status, 404);
});

// ------------------------------------------------------------- the client half

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the games hub still LISTS the farm, wearing the notice, and asks nothing of a shelved game', () => {
  const hub = read('src/pages/Games.tsx');
  // The card is still there — the owner asked for coming-soon, not for deletion.
  assert.match(hub, /data-hub-farm\b/, 'the farm card still has its place on the hub');
  assert.match(hub, /s\.shelved\.badge/, 'and wears the «قريبا» chip');
  assert.match(hub, /s\.shelved\.title/);
  assert.match(hub, /s\.shelved\.body/);
  // The notice comes from the server's switch, not from a constant in the page.
  assert.match(hub, /useFarmAccess\(\)/, 'the hub asks the server whether the game is open');
  assert.equal(/const\s+SHELVED\s*=/.test(hub), false, 'no hardcoded shelving flag in the page');
  // A shelved viewer is never sent to /api/farm/state: an error box is not «قريبا».
  assert.match(hub, /if \(isAuthenticated && access\.may_play\) void load\(\);/, 'state is fetched only when this viewer may play');
  // The three rows stay listed and stop being links.
  assert.match(hub, /mayPlay \? \(/, 'the rows are links only while the game is open');
  assert.match(hub, /s\.shelved\.linkNote/);
  // An unanswered question is never dressed up as a decision.
  assert.match(hub, /accessError !== null/);
  assert.match(hub, /<ErrorState compact error=\{accessError\}/);
});

test('the farm page is not rendered at all: App.tsx gates every game route but the hub', () => {
  const app = read('src/App.tsx');
  assert.match(app, /import \{ FarmGate \} from '\.\/pages\/farm\/shelved';/, 'the gate is imported eagerly');
  for (const path of ['/games/printer-farm', '/games/profile', '/games/redeem', '/leaderboards']) {
    const at = app.indexOf(`path="${path}"`);
    assert.ok(at > 0, `App.tsx lacks ${path}`);
    assert.match(app.slice(at, at + 400), /<FarmGate/, `${path} is not behind the gate`);
  }
  // /games itself must NOT be gated — it is where the gate sends people, and
  // it is the page that carries the notice.
  const hubAt = app.indexOf('path="/games"');
  assert.ok(hubAt > 0);
  assert.equal(/<FarmGate/.test(app.slice(hubAt, hubAt + 260)), false, 'the hub must stay reachable');
  // The farm page keeps its sign-in guard and its skeleton.
  assert.match(app, /path="\/games\/printer-farm"[\s\S]{0,200}<ProtectedRoute>[\s\S]{0,120}<Suspense fallback=\{<FarmSkeleton \/>\}>/);

  const gate = read('src/pages/farm/shelved.tsx');
  assert.match(gate, /<Navigate to="\/games" replace \/>/, 'a shelved page redirects to the hub');
  assert.equal((gate.match(/<Navigate to="\/games" replace \/>/g) || []).length, 2, 'both the refusal and the unanswerable question redirect');
  assert.match(gate, /if \(!access\.may_play\) return <Navigate/, 'the server decides, not the page');
  // `replace` is what keeps the back button out of the shelved page.
  assert.equal(/<Navigate to="[^"]*"(?![^>]*replace)/.test(gate), false, 'every redirect replaces the history entry');
  // Eager import: it must not drag the game's 65 KB string table into the
  // first bundle, so it carries no text at all.
  assert.equal(gate.includes("from './strings'"), false, 'the gate must stay text-free');
});

test('farmAccessOf refuses to read permission into a body that does not carry it', () => {
  assert.deepEqual(farmAccessOf({ success: true, shelved: false, admin: false, may_play: true }), {
    shelved: false, admin: false, may_play: true,
  });
  assert.deepEqual(farmAccessOf({ shelved: true, admin: true, may_play: true }), { shelved: true, admin: true, may_play: true });
  assert.equal(farmAccessOf({ shelved: true }), null, 'may_play is not assumed');
  assert.equal(farmAccessOf({ may_play: true }), null, 'shelved is not assumed');
  assert.equal(farmAccessOf({ shelved: 'false', may_play: 'true' }), null, 'strings are not booleans');
  assert.equal(farmAccessOf({}), null);
  assert.equal(farmAccessOf(null), null);
  assert.equal(farmAccessOf('open'), null);
  // `admin` absent is simply not an admin — it decides nothing on its own.
  assert.deepEqual(farmAccessOf({ shelved: true, may_play: true }), { shelved: true, admin: false, may_play: true });
});

test('the notice exists in all three languages and says the same thing, with the Sorani left for the owner', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const sh = FARM_STRINGS[lang].shelved;
    for (const [k, v] of Object.entries(sh)) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.shelved.${k} is empty`);
    }
  }
  // The owner's own word, exactly as they wrote it.
  assert.equal(FARM_STRINGS.ar.shelved.badge, 'قريبا');
  assert.match(FARM_STRINGS.ar.shelved.title, /تحت التطوير/);
  // Sorani is NOT machine-written: the ckb notice is the Arabic sentence,
  // deliberately, until the owner writes it by hand.
  assert.equal(FARM_STRINGS.ckb.shelved.badge, FARM_STRINGS.ar.shelved.badge);
  assert.equal(FARM_STRINGS.ckb.shelved.body, FARM_STRINGS.ar.shelved.body);
  assert.match(read('src/pages/farm/strings.ts'), /owner's to write by hand/, 'and the file says so');
  // No promise the shelving cannot keep: the notice names no date.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(/\d{4}|\d+\s*(day|days|يوم|أيام)/.test(FARM_STRINGS[lang].shelved.body), false, `${lang} invents a date`);
  }
});

test('the admin console can lift the shelving without a deploy, through the audited route alone', () => {
  const panel = read('src/components/adminFarm/ShelvedPanel.tsx');
  const api = read('src/components/adminFarm/shelvedApi.ts');
  assert.match(api, /api\.put<FarmShelvedWrite>\('\/api\/admin\/farm\/shelved', \{ open \}\)/, 'one body, one route');
  assert.match(api, /api\.get<FarmShelvedRead>\('\/api\/admin\/farm\/shelved'\)/);
  assert.equal(/\/api\/farm\b/.test(api.replace(/\/api\/admin\/farm/g, '')), false, 'the console never writes the player API');
  assert.match(panel, /farmShelvedApi\.set\(draft\)/);
  assert.match(panel, /s\.shelvedState\(!res\.shelved\)/, 'the panel reports the state the SERVER returned');
  assert.equal(/setShelved\((?:true|false)\)/.test(panel), false, 'never an assumed state');
  assert.match(read('src/components/adminFarm/AdminFarmConfig.tsx'), /<ShelvedPanel s=\{s\} \/>/, 'the switch is on the console');
});
