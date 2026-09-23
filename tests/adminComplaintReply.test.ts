/**
 * «الشكاوى» — AN ADMIN MUST BE ABLE TO ANSWER THE PERSON.
 *
 * The complaint thread has been selected by `GET /complaints/:id` since
 * migration 0031 created `community_complaint_messages`, and the admin panel
 * could set a complaint's STATUS. But `INSERT INTO
 * community_complaint_messages` appeared NOWHERE in the repository, in any
 * route — so an admin could read a complaint, move it to «بانتظار العميل»,
 * and the customer would be waiting on a reply the product had no way to
 * send. A status is not an answer.
 *
 * These tests run the real route against real migrations, so the foreign keys,
 * the CHECK on `status` and the `internal` default all execute.
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

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('buyer','Sara','s@x.co','h'), ('boss','Admin','ad@x.co','h');
    INSERT INTO community_complaints (id, reporter_id, category, description, status)
      VALUES ('ct1','buyer','quality','الطباعة وصلت مكسورة','under_review');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

const post = (app: Hono<AppContext>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('an admin reply is written to the thread and comes back on the complaint', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);

  const res = await post(app, '/api/admin/community/complaints/ct1/messages', {
    body: 'اعتذر عن هذا. سنرسل بديلًا اليوم.',
    internal: false,
  });
  assert.equal(res.status, 200);

  // The row exists, as an ADMIN message, and is not internal.
  const row = raw
    .prepare('SELECT sender_id, sender_role, body, internal FROM community_complaint_messages WHERE complaint_id = ?')
    .get('ct1') as Record<string, unknown>;
  assert.equal(row.sender_id, 'boss');
  assert.equal(row.sender_role, 'admin');
  assert.equal(row.internal, 0);
  assert.match(String(row.body), /سنرسل بديلًا/);

  // And the screen that shows the complaint now shows it.
  const detail = await json(await app.request('/api/admin/community/complaints/ct1'));
  const messages = detail.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender_name, 'Admin');
});

/**
 * `internal` HAS TO BE EXPLICIT. The column exists so a dispute desk can write
 * a note to ITSELF; the failure worth designing against is a note that becomes
 * a reply by omission, so an absent or non-boolean value means PUBLIC — the
 * thing the admin meant to type — and a note must say so.
 */
test('an internal note is stored as internal, and anything but true is a public reply', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);

  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'تأخر الشحن من المورّد', internal: true });
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'رد للزبون', internal: 'true' });
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'رد ثانٍ للزبون' });

  const rows = raw
    .prepare('SELECT body, internal FROM community_complaint_messages WHERE complaint_id = ? ORDER BY rowid')
    .all('ct1') as Array<Record<string, unknown>>;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].internal, 1);
  assert.equal(rows[1].internal, 0, "the string 'true' is not the boolean true");
  assert.equal(rows[2].internal, 0, 'an omitted flag is a public reply');
});

/** Replying is not deciding. `/status` writes `resolved_at` and the
 *  resolution; a typed sentence must not move the case on its own. */
test('a reply does not change the status', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'نراجع الطلب الآن', internal: false });
  const row = raw
    .prepare('SELECT status, resolved_at FROM community_complaints WHERE id = ?')
    .get('ct1') as Record<string, unknown>;
  assert.equal(row.status, 'under_review');
  assert.equal(row.resolved_at, null);
});

test('an empty reply is refused, and so is one on a complaint that does not exist', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);

  assert.equal((await post(app, '/api/admin/community/complaints/ct1/messages', { body: '   ' })).status, 400);
  assert.equal((await post(app, '/api/admin/community/complaints/nope/messages', { body: 'مرحبا' })).status, 404);

  const n = raw
    .prepare('SELECT COUNT(*) AS n FROM community_complaint_messages')
    .get() as { n: number };
  assert.equal(n.n, 0, 'neither refusal may leave a row behind');
});

/** The decision is on the record: who typed it, on which complaint, and
 *  whether it was a note or a reply. */
test('every reply is audited', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'ملاحظة للفريق', internal: true });
  const row = raw
    .prepare("SELECT actor_id, target, detail FROM audit_log WHERE action = 'admin.complaint_message'")
    .get() as Record<string, unknown>;
  assert.ok(row, 'the reply should be audited');
  assert.equal(row.actor_id, 'boss');
  assert.equal(row.target, 'ct1');
  assert.match(String(row.detail), /"internal":true/);
});

/**
 * THE HALF THE LAST TWO ROUNDS KEPT MISSING: does the answer REACH anybody?
 *
 * The reporter now has a thread of their own (GET/POST
 * /api/marketplace/complaints/:id, drawn in «تذاكري» on the Support page), and
 * the notification is its door: it carries the answer as a preview AND links
 * to the thread where it is read in full. Before that screen existed the link
 * was '' and the bell clamped the body to two lines, so a longer answer could
 * be read by nobody. These tests fail if a future change quietly removes the
 * delivery and leaves the write, or points the door back at nothing.
 */
test('a public reply reaches the reporter, carrying the text', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/complaints/ct1/messages', {
    body: 'اعتذر — سنرسل بديلًا اليوم، والمبلغ محجوز لحين وصوله.',
    internal: false,
  });
  // The route dispatches the notification without an ExecutionContext in this
  // harness, so it runs as a floating promise; let the microtasks settle.
  await new Promise((r) => setTimeout(r, 50));

  const row = raw
    .prepare("SELECT user_id, kind, body_ar, link, entity_type, entity_id, event_key FROM user_notifications WHERE kind = 'complaint_reply'")
    .get() as Record<string, unknown> | undefined;
  assert.ok(row, 'the reporter must be told at all');
  assert.equal(row.user_id, 'buyer', 'the person who complained, not the admin');
  assert.match(String(row.body_ar), /سنرسل بديلًا اليوم/, 'and the answer itself, as the preview the bell shows');
  assert.equal(row.entity_type, 'complaint');
  assert.equal(row.entity_id, 'ct1');
  assert.equal(
    row.link,
    '/support?tab=tickets&complaint=ct1',
    'the row opens the reporter\'s own thread — the page reads exactly these parameters'
  );
});

/** An internal note is the desk writing to ITSELF. Mailing it to the person it
 *  is about is the worst thing this feature could do. */
test('an internal note reaches nobody', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/complaints/ct1/messages', {
    body: 'المورّد يماطل — نصعّد داخليًا قبل الرد عليه',
    internal: true,
  });
  await new Promise((r) => setTimeout(r, 50));
  const n = raw.prepare('SELECT COUNT(*) AS n FROM user_notifications').get() as { n: number };
  assert.equal(n.n, 0, 'an internal note must never be delivered to the reporter');
});

/** A dispute is a conversation: the third answer is as much news as the first.
 *  Keying the delivery on the complaint would swallow every reply after one. */
test('each reply is its own news, not just the first', async () => {
  const { raw, db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'نراجع الطلب الآن', internal: false });
  await new Promise((r) => setTimeout(r, 50));
  await post(app, '/api/admin/community/complaints/ct1/messages', { body: 'أُرسل البديل اليوم', internal: false });
  await new Promise((r) => setTimeout(r, 50));

  const rows = raw
    .prepare("SELECT event_key, body_ar FROM user_notifications WHERE kind = 'complaint_reply' ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, 'both answers are delivered');
  assert.notEqual(rows[0].event_key, rows[1].event_key, 'the key carries the MESSAGE id, not the complaint id');
  assert.match(String(rows[1].body_ar), /أُرسل البديل/);
});
