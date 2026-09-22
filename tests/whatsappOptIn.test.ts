/**
 * «أما الواتساب فأقصد فهو مفعل من wasender ويعمل لكن لا يوجد زر لدى المستخدم
 *  يمكنه بالتفعيل الواتساب.»
 *
 * THE CHANNEL WORKED AND THE CUSTOMER HAD NO SAY IN IT. Order updates went out
 * on WhatsApp to the verified number on the account, and Settings could only
 * REPORT that — «جاهز» / «يحتاج رقمًا» — because there was nothing in the
 * database for a control to write to. Migration 0101 is that thing, and this
 * file proves the four places it has to hold:
 *
 *   1. The notification plan really drops the channel when the answer is no,
 *      and drops ONLY that channel. Proved against a real migrated database
 *      and the real fan-out, not by reading the source.
 *   2. An account that has never answered still gets WhatsApp — the default is
 *      1, so nobody's messages changed the day this landed.
 *   3. A database that has not run 0101 behaves like the old one rather than
 *      going silent, because a deploy can land before its migration.
 *   4. The switch exists, is drawn only where it can mean something, and the
 *      route it writes through refuses anything that is not a boolean.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asD1, freshDb } from './fixtures/app';
import { notifyCustomer, reachFor } from '../worker/lib/customerNotify';
import type { Env } from '../worker/lib/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PHONE = '+9647701234567';

const env = (raw: DatabaseSync): Env =>
  ({
    DB: asD1(raw),
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    WASENDER_API_KEY: 'wa_k',
    APP_ORIGIN: 'https://levonis-iq.com',
  }) as unknown as Env;

/** A customer with a verified mailbox AND a verified number, so email and
 *  WhatsApp are both genuinely available and only the switch separates them. */
function seedUser(raw: DatabaseSync, notifyWhatsapp: number | null): string {
  const id = `u_${notifyWhatsapp ?? 'null'}`;
  raw
    .prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164, email_verified_at, locale)
       VALUES (?, 'Customer', ?, ?, 'h', 'customer', ?, ?, 'ar')`
    )
    .run(id, `${id}@example.com`, id, PHONE, new Date().toISOString());
  if (notifyWhatsapp !== null) {
    raw.prepare('UPDATE users SET notify_whatsapp = ? WHERE id = ?').run(notifyWhatsapp, id);
  }
  return id;
}

/** Every channel the outbox was asked to send on. One user per database, so
 *  the whole table IS that customer's fan-out. */
function channels(raw: DatabaseSync): string[] {
  const rows = raw.prepare('SELECT kind FROM outbox ORDER BY kind').all() as Array<{ kind: string }>;
  return rows.map((r) => r.kind);
}

const MESSAGE = { subject: 'Order update', body: 'Your order moved.' };

// ------------------------------------------------- the plan, for real

test('the customer says no and WhatsApp stops — and nothing else does', async () => {
  const raw = freshDb();
  const off = seedUser(raw, 0);
  await notifyCustomer(env(raw), off, `order.status:${off}`, MESSAGE);
  const sent = channels(raw);
  assert.ok(!sent.includes('whatsapp'), `WhatsApp was still queued: ${sent.join(', ')}`);
  // The point of a per-CHANNEL switch is that the others are untouched. An
  // opt-out that quietly took email with it would be a worse bug than the one
  // this closes.
  assert.ok(sent.includes('email'), `email must still go out: ${sent.join(', ')}`);
});

test('an account that never answered still gets WhatsApp — the default is 1', async () => {
  const raw = freshDb();
  const untouched = seedUser(raw, null);
  await notifyCustomer(env(raw), untouched, `order.status:${untouched}`, MESSAGE);
  const sent = channels(raw);
  assert.ok(
    sent.includes('whatsapp'),
    `the migration must not change what an existing account receives: ${sent.join(', ')}`
  );
});

test('saying yes again turns it back on', async () => {
  const raw = freshDb();
  const id = seedUser(raw, 0);
  raw.prepare('UPDATE users SET notify_whatsapp = 1 WHERE id = ?').run(id);
  await notifyCustomer(env(raw), id, `order.status:${id}`, MESSAGE);
  assert.ok(channels(raw).includes('whatsapp'), 'the switch must work in both directions');
});

test('the reach reports the answer, and keeps it separate from the number', async () => {
  const raw = freshDb();
  const off = seedUser(raw, 0);
  const reach = await reachFor(env(raw), off);
  assert.equal(reach.wants_whatsapp, false);
  // THE NUMBER IS STILL THERE. `phone_e164` is the account's verified
  // identity and is read for sign-in codes too: somebody who turned off order
  // updates has not asked to be locked out of their own account.
  assert.equal(reach.phone, PHONE);
});

test('a database that has not run 0101 behaves like the old one', () => {
  // A deploy can land before its migration. `row.notify_whatsapp` is then
  // null, and null must read as "opted in" — the old behaviour — rather than
  // silencing a live channel for the whole shop until the migration runs.
  const src = read('worker/lib/customerNotify.ts');
  assert.match(src, /wants_whatsapp: row\.notify_whatsapp !== 0,/);
  assert.ok(
    !/row\.notify_whatsapp === 1/.test(src),
    'an equality test against 1 would read null as "off" — that is the outage'
  );
});

test('an opt-out makes the channel ABSENT, never a blocked outbox row', async () => {
  const raw = freshDb();
  const off = seedUser(raw, 0);
  await notifyCustomer(env(raw), off, `order.status:${off}`, MESSAGE);
  const rows = raw.prepare('SELECT kind, state FROM outbox').all() as Array<{ kind: string; state: string }>;
  assert.equal(
    rows.filter((r) => r.kind === 'whatsapp').length,
    0,
    'a customer choice is not a deployment fault to record on every send'
  );
});

// ------------------------------------------------------ the migration

test('the column defaults to 1, which is exactly today’s behaviour', () => {
  const sql = read('migrations/0101_whatsapp_opt_in.sql');
  assert.match(sql, /ALTER TABLE users ADD COLUMN notify_whatsapp INTEGER NOT NULL DEFAULT 1;/);
  // A default of 0 would have switched a live channel off for every customer
  // in the shop the moment it was applied.
  assert.ok(!/DEFAULT 0/.test(sql), 'the default must not silence existing accounts');
});

// ---------------------------------------------------------- the route

test('PATCH /api/profile takes a strict boolean and writes the column', () => {
  const src = read('worker/routes/profile.ts');
  assert.match(src, /if \(typeof body\.notify_whatsapp !== 'boolean'\)/,
    'a truthy string would let "false" turn the channel ON');
  assert.match(src, /notify_whatsapp = \?/, 'the UPDATE does not write the column');
  assert.match(src, /notifyWhatsapp, user\.id\)/, 'the value is not bound in the right place');
  // Omitting the key leaves the stored value alone, so the language row and
  // the avatar cannot flip a notification preference they never mentioned.
  assert.match(src, /let notifyWhatsapp = user\.notify_whatsapp !== 0 \? 1 : 0;/);
});

test('the user object carries the answer so the page can draw its state', () => {
  assert.match(read('worker/lib/types.ts'), /notify_whatsapp: u\.notify_whatsapp !== 0,/);
  assert.match(read('src/lib/api.ts'), /notify_whatsapp: boolean;/);
});

// --------------------------------------------------------- the button

test('the switch exists, and only where it can mean something', () => {
  const src = read('src/pages/Settings.tsx');
  assert.match(src, /role="switch"[\s\S]{0,200}aria-checked=\{waOn\}/, 'there is no switch');
  assert.match(src, /api\.patch\('\/api\/profile', \{ notify_whatsapp: next \}\)/);
  // Two gates: the DEPLOYMENT has a provider (whatsappConfigured, which wraps
  // this whole row) and THIS ACCOUNT has a number for it to reach. Offering it
  // to somebody with no verified number is a control with no effect — the
  // thing this page removed its Appearance row for.
  assert.match(src, /const whatsappConfigured = useCapabilities\(\)\?\.whatsappOtp \?\? false;/);
  const row = src.slice(src.indexOf('{user?.has_phone ? ('), src.indexOf('</SectionCard>', src.indexOf('role="switch"')));
  assert.ok(row.includes('role="switch"'), 'the switch escaped its has_phone gate');
});

test('the badge cannot say «مُفعّل» over a switch that is off', () => {
  const src = read('src/pages/Settings.tsx');
  // Reachability and consent are different facts; three states, not two.
  assert.match(src, /\{!user\?\.has_phone \? s\.waNeedsPhone : waOn \? s\.waReady : s\.waOff\}/);
  assert.match(src, /\{!user\?\.has_phone \? s\.waNeedsPhoneNote : waOn \? s\.waReadyNote : s\.waSwitchOffNote\}/);
});

test('the optimistic move is undone when the write is refused', () => {
  const src = read('src/pages/Settings.tsx');
  // The switch must never stay where the finger put it while the server still
  // holds the other answer.
  assert.match(src, /} catch \{\s*setWaDraft\(null\);\s*setWaError\(s\.waSwitchFailed\);/);
  assert.match(src, /await refreshUser\(\);\s*setWaDraft\(null\);/, 'the user object is the truth');
});

test('all three dictionaries carry every new string', () => {
  const src = read('src/pages/Settings.tsx');
  for (const key of ['waSwitch', 'waSwitchOffNote', 'waSwitchSaved', 'waSwitchFailed', 'waOff']) {
    assert.equal(
      (src.match(new RegExp(`^ *${key}: '`, 'gm')) ?? []).length,
      3,
      `${key} is missing from one of ar / en / ckb`
    );
  }
});
