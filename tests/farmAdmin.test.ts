/**
 * LEVO Printer Farm — the balancing console (/api/admin/farm) and the one
 * rule around it: `printerFarmConfig` has exactly one write path.
 *
 *   * a merchant subdomain answers 404 to the whole surface, even to an admin;
 *   * a stale expected_version is a 409, so two admins cannot silently revert
 *     each other; a document the engine could not run on is a 400 with the
 *     list of problems; a good save bumps the version and audits before/after;
 *   * reset needs the typed word; the generic settings PUT refuses the key;
 *   * a coin grant is idempotent, audited, and lands on the player's ledger.
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
import { farmAdminRoutes } from '../worker/routes/farmAdmin';
import { adminRoutes } from '../worker/routes/admin';
import { farmRoutes } from '../worker/routes/farm';
import { FARM_CONFIG_DEFAULTS } from '../worker/lib/farm/config';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('u1','Sara','sara@x.co','h','customer','sara'),
      ('boss','Admin','a@x.co','h','admin','boss'),
      ('helper','Assistant','h@x.co','h','admin','helper');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string | null, role = 'admin', host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId } as never);
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co' } as never;
    await next();
  });
  // Exactly how worker/index.ts wires it: the apex-only guard on /api/admin/*.
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
const send = (a: App, method: string, path: string, body: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the farm admin surface exists only on the main host — a merchant subdomain answers 404 even to an admin', async () => {
  const { db, raw } = setup();
  const onShop = appAs(db, 'boss', 'admin', 'shop.levonis-iq.com');
  assert.equal((await onShop.request('/api/admin/farm/config')).status, 404);
  assert.equal((await send(onShop, 'PUT', '/api/admin/farm/config/economy', { value: { starter_coins: 1 }, expected_version: 0 })).status, 404);
  assert.equal((await send(onShop, 'POST', '/api/admin/farm/config/economy/reset', { confirm: 'RESET' })).status, 404);
  assert.equal((await onShop.request('/api/admin/farm/players/u1')).status, 404);
  assert.equal((await send(onShop, 'POST', '/api/admin/farm/players/u1/grant', { amount: 100, reason: 'shop page', idempotencyKey: 'shopgrant-1' })).status, 404);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'printerFarmConfig'").get() as { n: number }).n, 0);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM farm_ledger').get() as { n: number }).n, 0);
  // A customer on the main host is forbidden; a guest is unauthorised.
  assert.equal((await appAs(db, 'u1', 'customer').request('/api/admin/farm/config')).status, 403);
  assert.equal((await appAs(db, null).request('/api/admin/farm/config')).status, 401);
});

test('GET /config returns the normalised document, the defaults, the public view and the problems', async () => {
  const { db } = setup();
  const a = appAs(db, 'boss');
  const r = await json(await a.request('/api/admin/farm/config'));
  assert.equal(r.success, true);
  assert.equal(r.version, 0);
  assert.deepEqual(r.config, FARM_CONFIG_DEFAULTS);
  assert.deepEqual(r.defaults, FARM_CONFIG_DEFAULTS);
  assert.equal('limits' in r.public, false);
  assert.deepEqual(r.problems, []);
  assert.ok(r.sections.includes('economy') && r.sections.includes('rewards'));
});

test('PUT /config/:section: stale version → 409, invalid → 400 with problems, good → stored, versioned, audited before/after', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'boss');
  const stale = await send(a, 'PUT', '/api/admin/farm/config/economy', { value: { ...FARM_CONFIG_DEFAULTS.economy, starter_coins: 2000 }, expected_version: 3 });
  assert.equal(stale.status, 409);
  const staleBody = await json(stale);
  assert.equal(staleBody.code, 'CONFIG_VERSION_MISMATCH');
  assert.equal(staleBody.details.current_version, 0);

  const invalid = await send(a, 'PUT', '/api/admin/farm/config/starter', {
    value: { ...FARM_CONFIG_DEFAULTS.starter, printer_model: 'ender3', spool: { material: 'WOOD', color: 'black', grams: 500, quality: 1 } },
    expected_version: 0,
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await json(invalid);
  assert.equal(invalidBody.code, 'FARM_CONFIG_INVALID');
  assert.ok(Array.isArray(invalidBody.details.problems) && invalidBody.details.problems.length >= 2);
  assert.ok(invalidBody.details.problems.some((p: string) => p.includes('starter.printer_model')));
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'printerFarmConfig'").get() as { n: number }).n, 0, 'nothing stored');

  // The Points switch cannot be turned on in this phase.
  const points = await send(a, 'PUT', '/api/admin/farm/config/rewards', {
    value: { levonis_points: { ...FARM_CONFIG_DEFAULTS.rewards.levonis_points, enabled: true } }, expected_version: 0,
  });
  assert.equal(points.status, 400);
  assert.ok((await json(points)).details.problems.some((p: string) => p.includes('levonis_points.enabled')));

  const unknown = await send(a, 'PUT', '/api/admin/farm/config/secrets', { value: {}, expected_version: 0 });
  assert.equal(unknown.status, 400);

  const good = await send(a, 'PUT', '/api/admin/farm/config/economy', {
    value: { ...FARM_CONFIG_DEFAULTS.economy, starter_coins: 2000, resale_factor: 9 }, expected_version: 0,
  });
  assert.equal(good.status, 200);
  const goodBody = await json(good);
  assert.equal(goodBody.version, 1);
  assert.equal(goodBody.config.economy.starter_coins, 2000);
  assert.equal(goodBody.config.economy.resale_factor, 1, 'normalised on the way in');
  assert.equal(goodBody.config.printers.a1_mini.price, 6000, 'other sections untouched');
  const stored = JSON.parse((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printerFarmConfig'").get() as { value: string }).value);
  assert.equal(stored.version, 1);
  assert.equal(stored.economy.starter_coins, 2000);
  const audit = raw.prepare("SELECT actor_id, target, detail FROM audit_log WHERE action = 'farm.config_update'").all() as Array<{ actor_id: string; target: string; detail: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, 'boss');
  assert.equal(audit[0].target, 'economy');
  const detail = JSON.parse(audit[0].detail);
  assert.equal(detail.version, 1);
  assert.equal(detail.before.starter_coins, 1500);
  assert.equal(detail.after.starter_coins, 2000);

  // The player side reads the new version immediately; a second save needs it.
  const cfgRes = await appAs(db, 'u1', 'customer').request('/api/farm/config');
  assert.equal(cfgRes.headers.get('etag'), '"farm-v1"');
  const state = await json(await appAs(db, 'u1', 'customer').request('/api/farm/state'));
  assert.equal(state.profile.coins, 2000, 'a new player starts with the new starter coins');
  assert.equal((await send(a, 'PUT', '/api/admin/farm/config/economy', { value: FARM_CONFIG_DEFAULTS.economy, expected_version: 0 })).status, 409);
  assert.equal((await send(a, 'PUT', '/api/admin/farm/config/time', { value: { ...FARM_CONFIG_DEFAULTS.time, time_scale: 40 }, expected_version: 1 })).status, 200);
});

test('POST /config/:section/reset requires the typed word and restores the code defaults for that section only', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'boss');
  await send(a, 'PUT', '/api/admin/farm/config/economy', { value: { ...FARM_CONFIG_DEFAULTS.economy, starter_coins: 2000 }, expected_version: 0 });
  await send(a, 'PUT', '/api/admin/farm/config/time', { value: { ...FARM_CONFIG_DEFAULTS.time, time_scale: 40 }, expected_version: 1 });
  const noConfirm = await send(a, 'POST', '/api/admin/farm/config/economy/reset', { confirm: 'yes' });
  assert.equal(noConfirm.status, 400);
  assert.equal((await json(noConfirm)).code, 'CONFIRM_REQUIRED');
  const reset = await json(await send(a, 'POST', '/api/admin/farm/config/economy/reset', { confirm: 'RESET' }));
  assert.equal(reset.success, true);
  assert.equal(reset.version, 3);
  assert.equal(reset.config.economy.starter_coins, 1500);
  assert.equal(reset.config.time.time_scale, 40, 'the other edited section survives');
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'farm.config_reset'").get() as { n: number }).n, 1);
});

test('the generic PUT /api/admin/settings/:key refuses printerFarmConfig and points at the farm route', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'boss');
  const r = await send(a, 'PUT', '/api/admin/settings/printerFarmConfig', { value: { economy: { starter_coins: 999999 } } });
  assert.equal(r.status, 400);
  const body = await json(r);
  assert.equal(body.code, 'FARM_CONFIG_ROUTE');
  assert.match(body.error, /\/api\/admin\/farm\/config/);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'printerFarmConfig'").get() as { n: number }).n, 0);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'").get() as { n: number }).n, 0);
  // Other keys still work through it.
  assert.equal((await send(a, 'PUT', '/api/admin/settings/exchangeRate', { value: 1450 })).status, 200);
});

test('GET /players/:userId shows a farm without moving it; grants are idempotent, audited and guarded by the trigger', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'boss');
  assert.equal((await a.request('/api/admin/farm/players/ghost')).status, 404);
  const none = await json(await a.request('/api/admin/farm/players/u1'));
  assert.equal(none.farm, null, 'a player who never opened the game has no farm yet');

  const grant = await json(await send(a, 'POST', '/api/admin/farm/players/u1/grant', { amount: 500, reason: 'welcome bonus', idempotencyKey: 'grant-u1-0001' }));
  assert.equal(grant.success, true, JSON.stringify(grant));
  assert.equal(grant.replayed, false);
  assert.equal(grant.balance, FARM_CONFIG_DEFAULTS.economy.starter_coins + 500, 'the farm was created first, then credited');
  const again = await json(await send(a, 'POST', '/api/admin/farm/players/u1/grant', { amount: 500, reason: 'welcome bonus', idempotencyKey: 'grant-u1-0001' }));
  assert.equal(again.replayed, true);
  assert.equal(again.balance, grant.balance);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM farm_ledger WHERE kind = 'admin_grant'").get() as { n: number }).n, 1);
  const audits = raw.prepare("SELECT target, detail FROM audit_log WHERE action = 'farm.admin_grant'").all() as Array<{ target: string; detail: string }>;
  assert.equal(audits.length, 1, 'the replay is not audited twice');
  assert.equal(audits[0].target, 'u1');
  assert.equal(JSON.parse(audits[0].detail).amount, 500);

  // A deduction the balance cannot cover is refused by the trigger.
  const tooMuch = await send(a, 'POST', '/api/admin/farm/players/u1/grant', { amount: -100000, reason: 'claw back', idempotencyKey: 'grant-u1-0002' });
  assert.equal(tooMuch.status, 409);
  assert.equal((await json(tooMuch)).code, 'INSUFFICIENT_COINS');
  const adjust = await json(await send(a, 'POST', '/api/admin/farm/players/u1/grant', { amount: -200, reason: 'correction', idempotencyKey: 'grant-u1-0003' }));
  assert.equal(adjust.balance, grant.balance - 200);
  assert.equal((raw.prepare("SELECT kind FROM farm_ledger WHERE id = ?").get(adjust.ledger_id) as { kind: string }).kind, 'admin_adjust');
  const bad = await send(a, 'POST', '/api/admin/farm/players/u1/grant', { amount: 0, reason: 'nothing', idempotencyKey: 'grant-u1-0004' });
  assert.equal(bad.status, 400);

  const view = await json(await a.request('/api/admin/farm/players/u1'));
  assert.equal(view.user.username, 'sara');
  assert.equal(view.farm.profile.coins, grant.balance - 200);
  assert.equal(view.farm.ledger_tail.length, 3);
  assert.equal(view.farm.printers.length, 1);
  assert.ok(Array.isArray(view.farm.jobs_recent));
  // The player sees the grant on the next visit.
  const player = await json(await appAs(db, 'u1', 'customer').request('/api/farm/state'));
  assert.equal(player.profile.coins, grant.balance - 200);
});
