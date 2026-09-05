/**
 * The PRO "verified merchant" badge is real.
 *
 * benefits.verifiedMerchant existed and nothing read it, so a benefit the
 * PRO card advertised was never granted. Every community payload that shows
 * a store's `verified` flag now resolves it as: the admin's manual mark OR an
 * ACTIVE PRO owner whose benefit is not paused. PLUS never gets it, a lapsed
 * PRO loses it, and a restriction case pauses it.
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
import { communityRoutes } from '../worker/routes/community';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('pro','Pro Owner','p@x.co','h'),
      ('plus','Plus Owner','pl@x.co','h'),
      ('manual','Admin-marked','m@x.co','h'),
      ('lapsed','Lapsed Pro','l@x.co','h'),
      ('gated','Gated Pro','g@x.co','h'),
      ('viewer','Viewer','v@x.co','h');
    INSERT INTO community_merchants (id, user_id, name, verified) VALUES
      ('cm_pro','pro','Pro Store',0),
      ('cm_plus','plus','Plus Store',0),
      ('cm_manual','manual','Manual Store',1),
      ('cm_lapsed','lapsed','Lapsed Store',0),
      ('cm_gated','gated','Gated Store',0);
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source) VALUES
      ('m_pro','pro','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','${FUTURE}','purchase'),
      ('m_plus','plus','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}','purchase'),
      ('m_lapsed','lapsed','pro_12mo','pro','active',12,499000,'2019-01-01T00:00:00.000Z','${PAST}','purchase'),
      ('m_gated','gated','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','${FUTURE}','purchase');
    INSERT INTO restriction_cases (id, user_id, kind, state, reason, benefit_flags) VALUES
      ('rc1','gated','other','active','complaint','["verifiedMerchant"]');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function app(db: D1Database, userId: string | null = null) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role: 'customer' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/community', communityRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

test('the merchant directory verifies active PRO owners and the admin-marked store, nobody else', async () => {
  const { db } = setup();
  const body = await json(await app(db).request('/api/community/merchants'));
  const byId = new Map((body.merchants as Array<Record<string, unknown>>).map((m) => [m.id, m.verified]));
  assert.equal(byId.get('cm_pro'), true, 'an active PRO owner is verified by entitlement');
  assert.equal(byId.get('cm_manual'), true, "the admin's mark still verifies on its own");
  assert.equal(byId.get('cm_plus'), false, 'PLUS is not PRO');
  assert.equal(byId.get('cm_lapsed'), false, 'an expired PRO is not verified');
  assert.equal(byId.get('cm_gated'), false, 'a paused verifiedMerchant benefit is not verified');
  // No membership data leaks into the public card.
  for (const m of body.merchants as Array<Record<string, unknown>>) {
    assert.ok(!('tier' in m) && !('expires_at' in m));
  }
});

test('the store page and the owner\'s own view agree with the directory', async () => {
  const { db } = setup();
  const pro = await json(await app(db).request('/api/community/store/cm_pro'));
  assert.equal((pro.merchant as Record<string, unknown>).verified, true);
  const plus = await json(await app(db).request('/api/community/store/cm_plus'));
  assert.equal((plus.merchant as Record<string, unknown>).verified, false);

  const mine = await json(await app(db, 'pro').request('/api/community/my-store'));
  assert.equal((mine.merchant as Record<string, unknown>).verified, true);
  const minePlus = await json(await app(db, 'plus').request('/api/community/my-store'));
  assert.equal((minePlus.merchant as Record<string, unknown>).verified, false);
});

test('the badge follows the membership: cancel the PRO and it is gone', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE memberships SET state = 'cancelled' WHERE id = 'm_pro'");
  const pro = await json(await app(db).request('/api/community/store/cm_pro'));
  assert.equal((pro.merchant as Record<string, unknown>).verified, false);
});

test('followed stores carry the same flag', async () => {
  const { db, raw } = setup();
  raw.exec("INSERT INTO follows (user_id, merchant_id) VALUES ('viewer','cm_pro'), ('viewer','cm_plus')");
  const body = await json(await app(db, 'viewer').request('/api/community/followed'));
  const byId = new Map((body.merchants as Array<Record<string, unknown>>).map((m) => [m.id, m.verified]));
  assert.equal(byId.get('cm_pro'), true);
  assert.equal(byId.get('cm_plus'), false);
});
