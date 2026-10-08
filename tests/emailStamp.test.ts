/**
 * ONE MEANING OF "VERIFIED" FOR EVERY READER OF users.email_verified_at
 * (review finding C3 of the S1 amendment; worker/lib/emailStamp.ts).
 *
 * The cost rule (`hasVerifiedAddress`, worker/lib/adminScope.ts) and the auth
 * routes count only a non-blank stamp: NULL, '' and '   ' are none. The other
 * readers of the column — the customer notifier, the wallet notices, channel
 * readiness, the invoice mailer and the invoice resend route — used to test it
 * for truthiness, which reads '   ' as verified. A blank left by a manual or
 * imported edit was then "verified" to the mailers and "unverified" to the
 * cost rule. Every reader now calls the one `isStamped`, and this file proves
 * each of them on a blank stamp, then walks worker/ and scripts/ for a truthiness read
 * that would bring the second answer back.
 *
 * Run: node --import tsx --test tests/emailStamp.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { asD1, freshDb, json, post, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import type { Env } from '../worker/lib/types';
import { isStamped, STAMP_ONCE } from '../worker/lib/emailStamp';
import { reachFor } from '../worker/lib/customerNotify';
import { channelReadiness } from '../worker/lib/channelReadiness';
import { enqueueUserDepositStatusNotification } from '../worker/lib/walletNotify';
import { createInvoiceForOrder } from '../worker/lib/invoices';
import { invoiceRoutes } from '../worker/routes/invoices';

const ADDRESS = 'customer@example.com';
const STAMP = '2026-01-01T00:00:00.000Z';
/** Every value that is NOT a stamp, beside the NULL the column starts as. */
const BLANKS = ['', '   ', '\t \n'] as const;

const env = (raw: DatabaseSync, over: Record<string, unknown> = {}): Env =>
  ({
    DB: asD1(raw),
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    ...over,
  }) as unknown as Env;

function seedCustomer(raw: DatabaseSync, stamp: string | null, id = 'u_1'): string {
  raw
    .prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, email_verified_at, locale)
       VALUES (?, 'Customer', ?, ?, 'h', 'customer', ?, 'en')`
    )
    .run(id, ADDRESS, id, stamp);
  return id;
}

// ---------------------------------------------------------------------------
// The predicate itself.

test('isStamped: only a non-blank string is a stamp — NULL, undefined, "" and whitespace are none', () => {
  assert.equal(isStamped(STAMP), true);
  assert.equal(isStamped(' 2026-01-01T00:00:00.000Z '), true, 'surrounding spaces do not unmake a real stamp');
  for (const v of [null, undefined, '', '   ', '\t \n', 0, 1, true, {}]) assert.equal(isStamped(v), false, JSON.stringify(v));
});

test('STAMP_ONCE keeps a real stamp and replaces a blank one like a NULL', () => {
  const raw = freshDb();
  for (const [id, before] of [['a', STAMP], ['b', null], ['c', ''], ['d', '   ']] as const) {
    raw.prepare("INSERT INTO users (id, name, email, password_hash, role, email_verified_at) VALUES (?, 'x', ?, 'h', 'customer', ?)").run(id, `${id}@x.co`, before);
  }
  raw.prepare(`UPDATE users SET email_verified_at = ${STAMP_ONCE}`).run('2026-10-08T00:00:00.000Z');
  const got = (id: string) => row<{ v: string }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', id)?.v;
  assert.equal(got('a'), STAMP, 'the first real stamp wins');
  for (const id of ['b', 'c', 'd']) assert.equal(got(id), '2026-10-08T00:00:00.000Z', id);
});

// ---------------------------------------------------------------------------
// Every reader, on a blank stamp: the address is not a verified one.

test('customer reach (customerNotify.ts): a blank stamp is not a mailbox; a real one is', async () => {
  for (const blank of BLANKS) {
    const raw = freshDb();
    seedCustomer(raw, blank);
    assert.equal((await reachFor(env(raw), 'u_1')).email, null, JSON.stringify(blank));
  }
  const raw = freshDb();
  seedCustomer(raw, STAMP);
  assert.equal((await reachFor(env(raw), 'u_1')).email, ADDRESS);
});

test('channel readiness (channelReadiness.ts): a blank stamp reads ACCOUNT_NOT_VERIFIED and offers the verify action', async () => {
  const emailState = async (stamp: string | null) => {
    const raw = freshDb();
    seedCustomer(raw, stamp);
    const r = await channelReadiness(env(raw), 'u_1');
    return r.channels.find((c) => c.channel === 'email')!;
  };
  for (const blank of BLANKS) {
    const s = await emailState(blank);
    assert.equal(s.ready, false, JSON.stringify(blank));
    assert.equal(s.blocker, 'ACCOUNT_NOT_VERIFIED', JSON.stringify(blank));
    assert.equal(s.action?.kind, 'verify_email');
  }
  const ok = await emailState(STAMP);
  assert.equal(ok.ready, true);
  assert.equal(ok.blocker, null);
});

test('wallet deposit notice (walletNotify.ts): a blank stamp gets no email; a real one does', async () => {
  const sent = async (stamp: string | null) => {
    const raw = freshDb();
    seedCustomer(raw, stamp);
    raw
      .prepare(
        "INSERT INTO wallet_transactions (id, user_id, type, amount, status, currency) VALUES ('dep1', 'u_1', 'deposit', 5000, 'approved', 'USD')"
      )
      .run();
    const r = await enqueueUserDepositStatusNotification(env(raw), 'dep1');
    const mail = raw.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'email'").get() as { n: number };
    return { flag: r.email, rows: mail.n };
  };
  for (const blank of BLANKS) assert.deepEqual(await sent(blank), { flag: false, rows: 0 }, JSON.stringify(blank));
  assert.deepEqual(await sent(STAMP), { flag: true, rows: 1 });
});

/** One delivered order owned by u_1, with no catalogue behind it — the invoice reads the order alone. */
function seedOrder(raw: DatabaseSync, stamp: string | null): string {
  raw.exec('PRAGMA foreign_keys = OFF;');
  seedCustomer(raw, stamp);
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
                           payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
       VALUES ('ORD-STAMP', 'u_1', 'delivered', '{}', 'dm', '{}', 'pm', 10000, 1400, 10000, 0)`
    )
    .run();
  return 'ORD-STAMP';
}

test('invoice email (lib/invoices.ts): a blank stamp is recorded as skipped, never queued for sending', async () => {
  const state = async (stamp: string | null) => {
    const raw = freshDb();
    const orderId = seedOrder(raw, stamp);
    assert.ok(await createInvoiceForOrder({ DB: asD1(raw) } as unknown as Env, orderId));
    return row<{ state: string }>(raw, 'SELECT state FROM outbox WHERE event_key = ?', `invoice:${orderId}:1`)?.state;
  };
  for (const blank of BLANKS) assert.equal(await state(blank), 'skipped', JSON.stringify(blank));
  assert.notEqual(await state(STAMP), 'skipped', 'a real stamp is queued for delivery');
});

test('invoice resend (routes/invoices.ts): a blank stamp is RECIPIENT_UNVERIFIED', async () => {
  const resend = async (stamp: string | null) => {
    const raw = freshDb();
    const orderId = seedOrder(raw, stamp);
    const made = await createInvoiceForOrder({ DB: asD1(raw) } as unknown as Env, orderId);
    assert.ok(made);
    const a = stubApp(asD1(raw), { id: 'usr_admin', role: 'admin', email: 'admin@x.co' }, (app) => app.route('/api/invoices', invoiceRoutes));
    const res = await post(a, `/api/invoices/${made.invoiceId}/resend`);
    return { status: res.status, body: await json(res) };
  };
  for (const blank of BLANKS) {
    const r = await resend(blank);
    assert.equal(r.status, 400, JSON.stringify(blank));
    assert.equal(r.body.code, 'RECIPIENT_UNVERIFIED');
  }
  const ok = await resend(STAMP);
  assert.notEqual(ok.body.code, 'RECIPIENT_UNVERIFIED', JSON.stringify(ok.body));
});

// ---------------------------------------------------------------------------
// No second answer creeps back in.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

/** Code with comments blanked (line numbers kept), so a sentence that mentions the column does not count as a read. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// `!x.email_verified_at`, `!!x.email_verified_at`, `x.email_verified_at ? a : b`,
// `x.email_verified_at &&`, `&& x.email_verified_at` (not compared), `if (x.email_verified_at)`.
// A member read (`.trim()`), a comparison and a type annotation (`?:`) are not truthiness.
const NOT_TRUTHY = String.raw`(?!\s*(?:[=!<>]=?|\??\.|\?:))`;
const TRUTHY = [
  new RegExp(String.raw`!\s*!?\s*[\w$?.]*\bemail_verified_at\b` + NOT_TRUTHY),
  /[\w$?.]*\bemail_verified_at\b\s*\?(?![?.:])/,
  /[\w$?.]*\bemail_verified_at\b\s*(&&|\|\|)/,
  new RegExp(String.raw`(&&|\|\|)\s*[\w$?.]*\bemail_verified_at\b` + NOT_TRUTHY),
  /\bif\s*\(\s*[\w$?.]*\bemail_verified_at\b\s*\)/,
];
const truthyRead = (line: string) => TRUTHY.some((re) => re.test(line));

test('the truthiness scan catches the spellings the review found — and passes the ones that are not reads', () => {
  for (const old of [
    'const mail = row.email && row.email_verified_at && !isPlaceholderEmail(row.email) ? row.email : null;',
    'const verified = real && !!row?.email_verified_at;',
    'if (!owner.email_verified_at) {',
    'if (owner.email_verified_at) {',
    'return user.email_verified_at ? email : null;',
    'const ok = flag || u.email_verified_at;',
  ]) {
    assert.equal(truthyRead(old), true, old);
  }
  for (const fine of [
    'const mail = row.email && isStamped(row.email_verified_at) ? row.email : null;',
    "return typeof user.email_verified_at === 'string' && user.email_verified_at.trim() !== '';",
    'email_verified_at?: string | null;',
    'email_verified_at: row.email_verified_at ?? null,',
    'verified: isStamped(row?.email_verified_at),',
  ]) {
    assert.equal(truthyRead(fine), false, fine);
  }
});

test('nothing under worker/ or scripts/ reads email_verified_at by truthiness — every reader goes through isStamped or its non-blank test', () => {
  const offenders: string[] = [];
  // scripts/ too (review of the amendment): restore-finance-owner.ts guarded the
  // owner binding with `!target.email_verified_at`, so '   ' passed a guard the
  // cost rule would then refuse.
  for (const file of [...walk(join(ROOT, 'worker')), ...walk(join(ROOT, 'scripts'))]) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      // SQL text is not a JavaScript read.
      if (/\b(SELECT|UPDATE|INSERT|WHERE|COALESCE)\b/.test(line)) return;
      if (truthyRead(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'read the stamp with isStamped (worker/lib/emailStamp.ts)');
});

test('the readers named by the review import the one isStamped', () => {
  for (const file of [
    'worker/routes/auth.ts',
    'worker/lib/customerNotify.ts',
    'worker/lib/walletNotify.ts',
    'worker/lib/channelReadiness.ts',
    'worker/lib/invoices.ts',
    'worker/routes/invoices.ts',
  ]) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.match(src, /import \{[^}]*\bisStamped\b[^}]*\} from '\.\.?\/(lib\/)?emailStamp'/, file);
    assert.doesNotMatch(codeOnly(src), /function isStamped\(/, `${file} keeps no private copy`);
  }
});
