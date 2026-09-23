/**
 * D1 REFUSES MORE THAN 100 BOUND PARAMETERS, AND THE SUITE CANNOT SEE IT.
 *
 * These tests run on node:sqlite, whose variable limit is 999. Every `IN (…)`
 * built from a list therefore PASSES here at any length and fails in
 * production at 101 — which is exactly how three of them shipped. So this file
 * does two things that are different in kind:
 *
 *   1. it READS THE SOURCE and asserts the chunking is there, the way
 *      tests/busyOverlay.test.ts pins constants it cannot execute; and
 *   2. it RUNS the routes over lists longer than the ceiling and asserts the
 *      answers are still complete — because a chunked query that forgets to
 *      merge its pages is a different bug with the same symptom, and only the
 *      behavioural half can catch that one.
 *
 * The house rule is written down in worker/lib/customerNotify.ts: the ceiling
 * is 100 and the chunk is 90, leaving a caller room for a bound value of its
 * own.
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
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** More than the ceiling, and more than one chunk of 90. */
const OVER_CEILING = 150;

function adminApp(db: D1Database) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'boss', role: 'admin' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  app.route('/api/admin/community', adminCommunityRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  });
  return app;
}

function setup(memberCount: number) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec("INSERT INTO users (id,name,email,password_hash) VALUES ('boss','Admin','ad@x.co','h');");
  const ids: string[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    const id = `beta_${String(i).padStart(3, '0')}`;
    ids.push(id);
    raw
      .prepare('INSERT INTO users (id,name,email,password_hash) VALUES (?,?,?,?)')
      .run(id, `Beta ${i}`, `b${i}@x.co`, 'h');
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database, ids };
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

/**
 * THE ALLOW-LIST IS CAPPED AT 200 — TWICE THE CEILING.
 *
 * `PUT /gate` explicitly permits 200 entries and then checked them all with
 * one placeholder each. An owner allow-listing 101 beta members pressed save,
 * D1 refused the statement, the gate was never written, and the members stayed
 * locked out of a community the owner believed he had just let them into.
 */
test('the gate allow-list survives a list longer than D1 would bind', async () => {
  const { db, ids } = setup(OVER_CEILING);
  const app = adminApp(db);

  const res = await app.request('/api/admin/community/gate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open: false, allowed_user_ids: ids }),
  });
  assert.equal(res.status, 200, 'saving 150 allow-listed members must not fail');
  const saved = await json(res);
  assert.equal((saved.allowed_user_ids as string[]).length, OVER_CEILING);

  // And the READ path, which renders that list back to the admin who has to
  // shorten it. It had the identical bug.
  const got = await json(await app.request('/api/admin/community/gate'));
  const members = got.members as Array<Record<string, unknown>>;
  assert.equal(members.length, OVER_CEILING, 'every member comes back');
  assert.equal(
    members.filter((m) => m.email !== null).length,
    OVER_CEILING,
    'a chunk whose results were dropped would show as members with null names'
  );
  // Order is the stored order, not the order the chunks happened to return in.
  assert.equal(members[0].id, ids[0]);
  assert.equal(members[OVER_CEILING - 1].id, ids[OVER_CEILING - 1]);
});

/** One unknown id anywhere in a long list is still named, not lost between
 *  chunks — the check exists so a typo is never saved silently. */
test('an unknown id in the second chunk is still refused by name', async () => {
  const { db, ids } = setup(OVER_CEILING);
  const app = adminApp(db);
  const withTypo = [...ids];
  withTypo[120] = 'usr_does_not_exist';

  const res = await app.request('/api/admin/community/gate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open: false, allowed_user_ids: withTypo }),
  });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'COMMUNITY_ALLOW_UNKNOWN_USER');
  assert.match(String(body.error), /usr_does_not_exist/);
});

/**
 * THE SOURCE-LEVEL HALF. node:sqlite will never refuse these statements, so
 * the only way to keep the chunking is to assert it is written.
 */
test('every list-driven IN (…) on these paths is chunked, and at the house size', () => {
  for (const [file, constant] of [
    ['worker/routes/adminCommunity.ts', 'GATE_ID_CHUNK'],
    ['worker/routes/devices.ts', 'ACCOUNT_IN_CHUNK'],
  ] as const) {
    const src = read(file);
    assert.match(
      src,
      new RegExp(`const ${constant} = 90;`),
      `${file}: the chunk is 90 — 100 is D1's refusal point and 90 leaves room for a bound value of its own`
    );
    assert.match(src, new RegExp(`chunk\\([^)]*, ${constant}\\)`), `${file}: the constant has to be USED`);
    assert.match(src, /import \{ chunk \} from '\.\.\/lib\/inventory';/, `${file}: one chunk helper, not a fourth`);
  }
});

/**
 * `/admin/units` resolves TWO accounts per unit — buyer and holder — over a
 * page of up to 200 units, so a reseller whose printers sit in 100+ different
 * holders' accounts crossed the ceiling on the one search that exists to show
 * who holds them. The branch this replaced resolved no accounts at all, so
 * nothing here could fail on parameter count before.
 */
test('the admin unit list names every account across more ids than D1 would bind', () => {
  const src = read('worker/routes/devices.ts');
  const helper = /async function adminUnitsWithAccounts\([\s\S]*?\n\}/.exec(src);
  assert.ok(helper, 'adminUnitsWithAccounts should be findable');
  assert.match(helper[0], /for \(const part of chunk\(ids, ACCOUNT_IN_CHUNK\)\)/);
  assert.ok(
    !/\.bind\(\.\.\.ids\)/.test(helper[0]),
    'binding the whole id list in one statement is the defect this replaced'
  );
  // The results of every chunk are kept, not just the last one's.
  assert.match(helper[0], /people\.push\(\.\.\.results\)/);
});
