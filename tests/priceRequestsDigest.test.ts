/**
 * «طلب السعر» — THE ADMIN'S DIGEST (DECISIONS row 240; spec §4.7, §7.5;
 * worker/lib/priceRequests.ts `digestPriceRequests`).
 *
 * One Arabic message to the existing «البلاغات» topic (`report`, default D8),
 * never one per request: a product is announced when its distinct requesters
 * cross 1, 3, 10, 25, 50, 100 (then every further 100) since its last
 * announcement, at most once an hour. CLAIM, THEN SEND: two digests started at
 * once send once. The text carries names and counts, never a person.
 *
 * Telegram is stubbed at `api.telegram.org`; the real routing reads the
 * configured group and topic.
 *
 * Run: node --import tsx --test tests/priceRequestsDigest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../worker/lib/types';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { DIGEST_INTERVAL_MS, digestPriceRequests, type PriceRequestBudget } from '../worker/lib/priceRequests';
import { crossedDigestThreshold, digestThreshold, requestersText } from '@levonis/contracts/priceRequests';

const GROUP = '-1001234567890';
const REPORT_THREAD = 77;

const budget = (limit = 40): PriceRequestBudget => {
  let used = 0;
  return { canSpend: (n) => used + n <= limit, spend: (n) => (used + n > limit ? false : ((used += n), true)), remaining: () => limit - used };
};

function world(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('boss', 'Boss', 'boss@x.co', 'h', 'admin');
    INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg) VALUES ('singleton', '${GROUP}', 'Levonis', 'boss', 1);
    INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg) VALUES ('report', ${REPORT_THREAD}, 1, 'boss', 1);
    INSERT INTO products (id, slug, name, name_ar, status, price_iqd) VALUES
      ('p_one', 'one', 'Printer One', 'الطابعة الأولى', 'active', 0),
      ('p_two', 'two', 'Printer Two', 'الطابعة الثانية', 'active', 0),
      ('p_three', 'three', 'Printer Three', '', 'active', 0);
  `);
  return raw;
}

/** `n` distinct people asking about `productId` (the stats as the route's recompute leaves them). */
function asked(raw: DatabaseSync, productId: string, n: number, at = '2026-10-15T09:30:00.000Z'): void {
  for (let i = 0; i < n; i++) {
    const user = `u_${productId}_${i}`;
    raw.prepare("INSERT OR IGNORE INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, 'h', 'customer')").run(user, `Secret Person ${i}`, `${user}@x.co`);
    raw
      .prepare(
        `INSERT OR IGNORE INTO product_price_requests (id, user_id, product_id, selection, requested_at, last_clicked_at, first_requested_at)
         VALUES (?, ?, ?, '', ?, ?, ?)`
      )
      .run(`prq_${productId}_${i}`, user, productId, at, at, at);
  }
  raw
    .prepare(
      `INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at, updated_at)
       SELECT ?, COUNT(DISTINCT user_id), COUNT(DISTINCT selection), SUM(click_count), MAX(requested_at), ?
         FROM product_price_requests WHERE product_id = ? AND state = 'open'
       ON CONFLICT(product_id) DO UPDATE SET requesters = excluded.requesters, selections = excluded.selections,
         clicks = excluded.clicks, last_request_at = excluded.last_request_at`
    )
    .run(productId, at, productId);
}

function stubTelegram(): { sent: Array<{ chat_id: string; message_thread_id?: number; text: string }>; restore: () => void } {
  const sent: Array<{ chat_id: string; message_thread_id?: number; text: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: Number(GROUP) } } }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = real) };
}

const envOf = (db: D1Database) =>
  ({ DB: db, TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN', APP_ORIGIN: 'https://levonis-iq.com' }) as unknown as Env;

test('the thresholds: 1, 3, 10, 25, 50, 100, then every further 100', () => {
  assert.deepEqual([0, 1, 2, 3, 9, 10, 24, 25, 49, 50, 99, 100, 199, 200, 250].map(digestThreshold), [0, 1, 1, 3, 3, 10, 10, 25, 25, 50, 50, 100, 100, 200, 200]);
  assert.equal(crossedDigestThreshold(1, 0), true);
  assert.equal(crossedDigestThreshold(2, 1), false, 'the second person is not news');
  assert.equal(crossedDigestThreshold(3, 1), true);
  assert.equal(crossedDigestThreshold(9, 3), false);
  assert.equal(crossedDigestThreshold(10, 9), true);
  assert.equal(crossedDigestThreshold(150, 100), false);
  assert.equal(crossedDigestThreshold(200, 199), true);
  // The admin's words: Arabic dual and plural forms; real Sorani.
  assert.equal(requestersText(2, 'ar'), 'شخصان طلبا السعر');
  assert.equal(requestersText(5, 'ar'), '5 أشخاص طلبوا السعر');
  assert.equal(requestersText(11, 'ar'), '11 شخصاً طلبوا السعر');
  assert.equal(requestersText(1, 'en'), '1 person requested the price');
  assert.notEqual(requestersText(2, 'ckb'), requestersText(2, 'ar'));
});

test('one message to «البلاغات», names and counts only; then at most one an hour, and only at a threshold', async () => {
  const raw = world();
  asked(raw, 'p_one', 3);
  asked(raw, 'p_two', 1, '2026-10-15T08:00:00.000Z');
  const tg = stubTelegram();
  try {
    const t0 = Date.parse('2026-10-15T10:00:00.000Z');
    const first = await digestPriceRequests(envOf(asD1(raw)), budget(), t0);
    assert.equal(first.sent, true);
    assert.equal(first.products, 2);
    assert.equal(tg.sent.length, 1, 'one message for both products');
    const msg = tg.sent[0]!;
    assert.equal(msg.chat_id, GROUP);
    assert.equal(msg.message_thread_id, REPORT_THREAD, 'the existing report topic');
    assert.match(msg.text, /^🔔 طلبات السعر/);
    assert.match(msg.text, /الطابعة الأولى: 3 أشخاص طلبوا السعر — آخر طلب 2026-10-15 09:30 UTC/);
    assert.match(msg.text, /الطابعة الثانية: شخص واحد طلب السعر/);
    assert.ok(msg.text.indexOf('الأولى') < msg.text.indexOf('الثانية'), 'most requested first');
    assert.match(msg.text, /https:\/\/levonis-iq\.com\/admin\?tab=products&pricing=needs&focus=p_one/);
    assert.doesNotMatch(msg.text, /Secret Person|u_p_one|@x\.co/, 'no person in the text');
    assert.deepEqual(
      all(raw, 'SELECT product_id, digest_requesters FROM product_price_request_stats ORDER BY product_id'),
      [
        { product_id: 'p_one', digest_requesters: 3 },
        { product_id: 'p_two', digest_requesters: 1 },
      ]
    );

    // Within the hour: nothing, even with a new threshold crossed.
    asked(raw, 'p_three', 1);
    const soon = await digestPriceRequests(envOf(asD1(raw)), budget(), t0 + DIGEST_INTERVAL_MS - 60_000);
    assert.equal(soon.sent, false);
    assert.equal(tg.sent.length, 1);

    // An hour later: only the product that crossed a threshold (p_one at 4 has not reached 10).
    asked(raw, 'p_one', 4);
    const later = await digestPriceRequests(envOf(asD1(raw)), budget(), t0 + DIGEST_INTERVAL_MS + 1000);
    assert.equal(later.sent, true);
    assert.equal(tg.sent.length, 2);
    assert.match(tg.sent[1]!.text, /Printer Three: شخص واحد طلب السعر/, 'the English name when there is no Arabic one');
    assert.doesNotMatch(tg.sent[1]!.text, /الطابعة الأولى/, '4 people is not a threshold after 3');

    // Nothing new crossed: no message at all.
    const quiet = await digestPriceRequests(envOf(asD1(raw)), budget(), t0 + 3 * DIGEST_INTERVAL_MS);
    assert.equal(quiet.sent, false);
    assert.equal(tg.sent.length, 2);
  } finally {
    tg.restore();
  }
});

test('claim, then send: two digests at once send once', async () => {
  const raw = world();
  asked(raw, 'p_one', 10);
  const db = serialD1(raw);
  const tg = stubTelegram();
  try {
    const now = Date.parse('2026-10-15T10:00:00.000Z');
    const [a, b] = await Promise.all([digestPriceRequests(envOf(db), budget(), now), digestPriceRequests(envOf(db), budget(), now)]);
    assert.equal(Number(a.sent) + Number(b.sent), 1, 'exactly one of them claimed');
    assert.equal(tg.sent.length, 1);
    assert.equal(row<{ digest_requesters: number }>(raw, "SELECT digest_requesters FROM product_price_request_stats WHERE product_id = 'p_one'")!.digest_requesters, 10);
  } finally {
    tg.restore();
  }
});

test('a budget too small, or a database without 0193: no message, no throw', async () => {
  const raw = world();
  asked(raw, 'p_one', 3);
  const tg = stubTelegram();
  try {
    for (const limit of [0, 1, 2, 3]) {
      const r = await digestPriceRequests(envOf(asD1(raw)), budget(limit));
      assert.equal(r.sent, false, `budget ${limit}`);
      assert.ok(r.statements <= limit);
    }
    const bare = freshDb();
    bare.exec('DROP TABLE product_price_request_stats; DROP TABLE product_price_requests;');
    assert.equal((await digestPriceRequests(envOf(asD1(bare)), budget())).sent, false);
    assert.equal(tg.sent.length, 0);
  } finally {
    tg.restore();
  }
});
