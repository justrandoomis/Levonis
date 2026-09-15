/**
 * «من حيث التسجيل الدخول وربح النقاط وأثناء الشراء والتقييمات»
 *
 * The owner's multiplier rule names FOUR surfaces, and this file covers the
 * last one: A RATING. PREMIUM earns ×1.5 and PRO ×2 on a review exactly as
 * they do on a check-in, because the multiplier belongs to the member — not
 * to the kind of thing the member did.
 *
 * Two award doors exist in worker/routes/reviews.ts and BOTH are exercised
 * here against the real router, the real migrations and a real database:
 *
 *   1. the automatic fallback on POST /api/reviews and PUT /api/reviews/:id,
 *      which pays twice the configured base for a valid manual review that
 *      does not reach a printer-gift level;
 *   2. the admin approval on POST /api/reviews/admin/:id/reward, which pays
 *      the configured base for a reward row of kind 'points'.
 *
 * The three things worth pinning, none of which a unit test of the arithmetic
 * alone would catch:
 *
 *   * 1× IS BYTE-IDENTICAL to the behaviour before the multiplier existed, so
 *     a shop with no subscribers sees no change at all;
 *   * every surface that states the number — points_awards, the POINT wallet
 *     transaction, reviews.fallback_points_awarded, review_rewards
 *     .points_awarded and the JSON response — states the SAME number, so the
 *     customer's wallet and their receipt can never disagree;
 *   * the admin approval pays THE REVIEWER'S multiplier. The admin is the
 *     one holding the request; reading the tier off the wrong user is the
 *     obvious way to get this wrong and it would be invisible in production
 *     until a PRO complained.
 *
 * Run: npx tsx --test tests/reviewMultiplier.test.ts
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
import { reviewRoutes } from '../worker/routes/reviews';

type Tier = 'prime' | 'pro';
const PLAN: Record<Tier, string> = { prime: 'prime_12mo', pro: 'pro_12mo' };

const ORDER_COLS = `id, user_id, status, stage, shipping_type, address_snapshot, delivery_method_id,
  delivery_method_snapshot, payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd,
  due_on_delivery_iqd, delivered_at, created_at, updated_at`;

/**
 * Three customers who differ in EXACTLY ONE WAY — their subscription — plus
 * an admin with none, so an approval that read the admin's tier instead of
 * the reviewer's would pay 1× and fail loudly.
 */
function setup(basePoints: number | null = 25) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));

  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const started = new Date(Date.now() - 30 * 86_400_000).toISOString();

  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('free','Free Fatima','f@x.co','h','customer'),
      ('prime','Prime Noor','n@x.co','h','customer'),
      ('pro','Pro Kareem','k@x.co','h','customer'),
      ('lapsed','Lapsed Zain','z@x.co','h','customer'),
      ('boss','Admin','a@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES
      ('p1','pla-white','PLA White','PLA أبيض',25000,'[]');
  `);
  for (const [user, tier, expires] of [
    ['prime', 'prime', future],
    ['pro', 'pro', future],
    // Lapsed: a membership row that still says 'active' but is overdue. The
    // multiplier must follow the EXPIRY, not the stale state column.
    ['lapsed', 'pro', past],
  ] as const) {
    raw
      .prepare(
        `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
         VALUES (?,?,?,?, 'active',12,?,?)`
      )
      .run(`m_${user}`, user, PLAN[tier as Tier], tier, started, expires);
  }
  for (const u of ['free', 'prime', 'pro', 'lapsed']) {
    raw.exec(`
      INSERT INTO orders (${ORDER_COLS}) VALUES
        ('ORD-${u}','${u}','delivered','delivered','direct','{}','standard','{}','cash',
         25000,0,1400,25000,0,'2026-01-04T10:00:00.000Z',
         '2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z');
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
        VALUES ('oi_${u}','ORD-${u}','p1','PLA White','','White',1,25000,25000);
    `);
  }
  if (basePoints !== null) {
    raw
      .prepare("INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig',?)")
      .run(JSON.stringify({ enabled: true, points: basePoints }));
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string, role = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co` } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/reviews', reviewRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

/** POST once and return BOTH the status and the parsed body: an assertion
 *  message that calls res.text() would consume the body a later json() needs. */
async function post<T = Record<string, unknown>>(
  app: Hono<AppContext>,
  path: string,
  body: unknown
): Promise<{ status: number; json: T; text: string }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'levonis-iq.com' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = {} as T;
  }
  return { status: res.status, json: parsed, text };
}

/** A plain, honest review: real text, no media, no Instagram evidence — so it
 *  is valid but reaches no printer-gift level, which is the fallback door. */
const plainReview = (orderId: string) => ({
  productId: 'p1',
  orderId,
  stars: 5,
  body: 'طبعت بها ثلاث قطع وكانت الطبقات نظيفة ولم تلتصق بالمنصة إطلاقاً، والالتصاق ممتاز عند 60 درجة.',
});

const awarded = (raw: DatabaseSync, user: string) =>
  raw.prepare('SELECT points FROM points_awards WHERE user_id = ?').get(user) as { points: number } | undefined;

const walletPoints = (raw: DatabaseSync, user: string) =>
  raw
    .prepare("SELECT amount, note FROM wallet_transactions WHERE user_id = ? AND currency = 'POINT'")
    .get(user) as { amount: number; note: string } | undefined;

// ===========================================================================
// 1. THE FALLBACK AWARD ON A NEW REVIEW
// ===========================================================================

test('a customer with no subscription is paid exactly what they were paid before', async () => {
  const { raw, db } = setup(25);
  const res = await post(appAs(db, 'free'), '/api/reviews', plainReview('ORD-free'));
  assert.equal(res.status, 200, res.text);
  // 25 configured × 2 (the long-standing fallback rule) × 1 (no membership).
  assert.equal(awarded(raw, 'free')?.points, 50);
});

test('PREMIUM is paid 1.5× and PRO 2× for the same review', async () => {
  const { raw, db } = setup(25);
  const p1 = await post(appAs(db, 'prime'), '/api/reviews', plainReview('ORD-prime'));
  const p2 = await post(appAs(db, 'pro'), '/api/reviews', plainReview('ORD-pro'));
  assert.equal(p1.status, 200, p1.text);
  assert.equal(p2.status, 200, p2.text);
  assert.equal(awarded(raw, 'prime')?.points, 75, '50 × 1.5');
  assert.equal(awarded(raw, 'pro')?.points, 100, '50 × 2');
  // The three customers differ ONLY in their subscription, so the ratio the
  // owner promised is visible directly in the ledger.
  assert.equal(awarded(raw, 'prime')!.points / 50, 1.5);
  assert.equal(awarded(raw, 'pro')!.points / 50, 2);
});

test('an overdue membership pays 1×, and the award does not wait for the sweeper', async () => {
  const { raw, db } = setup(25);
  // The row goes in as state='active' with a date in the past — the shape a
  // membership really has between lapsing and whatever marks it expired.
  assert.equal(
    (raw.prepare("SELECT state FROM memberships WHERE user_id='lapsed'").get() as { state: string }).state,
    'active'
  );
  const res = await post(appAs(db, 'lapsed'), '/api/reviews', plainReview('ORD-lapsed'));
  assert.equal(res.status, 200, res.text);
  assert.equal(awarded(raw, 'lapsed')?.points, 50, 'the benefit ended with the subscription, not with the bookkeeping');
  // getTierStatus settles the bookkeeping on the way past. Worth pinning:
  // the award was decided by the EXPIRY, and this write is the consequence,
  // not the cause — a PRO whose card lapsed yesterday is paid 1× on the very
  // first request, with no sweeper needing to have run first.
  assert.equal(
    (raw.prepare("SELECT state FROM memberships WHERE user_id='lapsed'").get() as { state: string }).state,
    'expired'
  );
});

test('every surface states the SAME number — ledger, wallet, review row and response', async () => {
  const { raw, db } = setup(25);
  const res = await post<{ fallback_points?: number; points_awarded?: number }>(
    appAs(db, 'pro'), '/api/reviews', plainReview('ORD-pro')
  );
  assert.equal(res.status, 200, res.text);
  const json = res.json;
  const row = raw.prepare("SELECT fallback_points_awarded FROM reviews WHERE user_id='pro'").get() as
    | { fallback_points_awarded: number }
    | undefined;
  assert.equal(awarded(raw, 'pro')?.points, 100);
  assert.equal(walletPoints(raw, 'pro')?.amount, 100, 'the wallet credits what the ledger recorded');
  assert.equal(row?.fallback_points_awarded, 100, 'the review row carries the real figure');
  const stated = json.fallback_points ?? json.points_awarded;
  if (stated !== undefined) assert.equal(stated, 100, 'and the response does not promise a smaller number');
});

test('the wallet note does not still claim "2x base" when a membership doubled it again', async () => {
  const { raw, db } = setup(25);
  await post(appAs(db, 'pro'), '/api/reviews', plainReview('ORD-pro'));
  const note = walletPoints(raw, 'pro')!.note;
  // 25 → 50 → 100. A note that says only "2x base" describes 50, not 100, and
  // a customer reading their own wallet would be entitled to ask why.
  assert.match(note, /2x/, 'the fallback rule is still named');
  assert.ok(
    /membership|اشتراك|×|x2|2x membership/i.test(note) && note !== 'Valid manual review fallback (2x base)',
    `the membership share of the award must be named too — got ${JSON.stringify(note)}`
  );
});

test('no configured review point value still awards nothing at all, at any tier', async () => {
  const { raw, db } = setup(null);
  const r = await post(appAs(db, 'pro'), '/api/reviews', plainReview('ORD-pro'));
  assert.equal(r.status, 200, r.text);
  assert.equal(awarded(raw, 'pro'), undefined, 'a multiplier must not invent a value that was never configured');
  assert.equal(walletPoints(raw, 'pro'), undefined);
});

// ===========================================================================
// 2. THE ADMIN APPROVAL AWARD
// ===========================================================================

function rewardRow(raw: DatabaseSync, user: string, reviewId: string) {
  raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,order_item_id,order_id,stars,body,media,status,source,created_at)
      VALUES ('${reviewId}','${user}','p1','oi_${user}','ORD-${user}',5,'مراجعة مفصلة وصادقة عن المنتج','[]','published','user','2026-01-05T10:00:00.000Z');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,created_at)
      VALUES ('rr_${user}','${reviewId}','${user}','points','submitted','2026-01-05T10:00:00.000Z');
  `);
}

test('the admin approval pays the REVIEWER’s multiplier, never the admin’s', async () => {
  const { raw, db } = setup(25);
  rewardRow(raw, 'pro', 'rev_pro');
  // The approver ('boss') holds no subscription whatsoever. If the tier were
  // read off the request's user, this would pay 25.
  const res = await post<{ points_awarded: number }>(appAs(db, 'boss', 'admin'), '/api/reviews/admin/rev_pro/reward', {
    action: 'approve',
    reason: 'مراجعة جيدة ومفيدة',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.points_awarded, 50, '25 × 2 for PRO');
  assert.equal(awarded(raw, 'pro')?.points, 50);
  assert.equal(walletPoints(raw, 'pro')?.amount, 50);
  assert.equal(
    (raw.prepare("SELECT points_awarded FROM review_rewards WHERE id='rr_pro'").get() as { points_awarded: number })
      .points_awarded,
    50,
    'the reward row records what was actually paid'
  );
});

test('a half point on an approval rounds UP, in the member’s favour', async () => {
  const { raw, db } = setup(25);
  rewardRow(raw, 'prime', 'rev_prime');
  const res = await post<{ points_awarded: number }>(appAs(db, 'boss', 'admin'), '/api/reviews/admin/rev_prime/reward', {
    action: 'approve',
    reason: 'مراجعة جيدة ومفيدة',
  });
  assert.equal(res.status, 200, res.text);
  // 25 × 1.5 = 37.5. Rounding down would pay ×1.48 and quietly keep the half
  // for the shop on every odd award a PREMIUM member ever earns.
  assert.equal(res.json.points_awarded, 38);
  assert.equal(awarded(raw, 'prime')?.points, 38);
});

test('an approval for a customer with no subscription is unchanged', async () => {
  const { raw, db } = setup(25);
  rewardRow(raw, 'free', 'rev_free');
  const res = await post<{ points_awarded: number }>(appAs(db, 'boss', 'admin'), '/api/reviews/admin/rev_free/reward', {
    action: 'approve',
    reason: 'مراجعة جيدة ومفيدة',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.points_awarded, 25);
  assert.equal(awarded(raw, 'free')?.points, 25);
});

test('an unconfigured point value refuses the approval rather than inventing one', async () => {
  const { raw, db } = setup(null);
  rewardRow(raw, 'pro', 'rev_pro');
  const res = await post<{ code: string }>(appAs(db, 'boss', 'admin'), '/api/reviews/admin/rev_pro/reward', {
    action: 'approve',
    reason: 'مراجعة جيدة ومفيدة',
  });
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.code, 'REVIEW_POINTS_UNCONFIGURED');
  assert.equal(awarded(raw, 'pro'), undefined);
});
