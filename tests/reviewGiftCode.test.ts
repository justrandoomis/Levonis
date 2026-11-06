/**
 * «قيّم طابعتك», THE WHOLE ROAD, through the real routes (owner, 2026-11-05;
 * docs/DECISIONS.md row 301; rewards policy version 7, chapter 8):
 *
 *   «from placing gift 1 2 3 4 5 to system reviwes from 1-100 to give admin to
 *    user code to redeem his gift … every 20 score the level appear and he can
 *    see the gift of level and select then confirm then add to cart as free gift
 *    and then place order and he will pay for delivery only».
 *
 * Gifts on the levels → a review of a delivered printer → the queue → approval at
 * 26 → the code → a wrong code refused → the right code → levels {1,2} only; an
 * item of level 3 refused → choose → redeem → cart → the quote charges delivery
 * only → order → delivered → fulfilled. Replays, races, four eyes, one gift per
 * review, the old tab and a database without the migration.
 *
 * Run: node --import tsx --test tests/reviewGiftCode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, row, stubApp, type Mount, type StubUser } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import {
  BOSS,
  BUYER,
  NOZZLE_04_RED,
  OTHER,
  PLAIN,
  PLATE_AIR,
  addGiftToCart,
  addLevelItem,
  choose,
  get,
  giftRow,
  giftWorld,
  json,
  mountGifts,
  patch,
  post,
  placeOrder,
  quoteBody,
  redeem,
  type J,
} from './fixtures/giftWorld';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import {
  GIFT_CODE_ALPHABET,
  GIFT_CODE_SHAPE,
  newGiftCode,
  normalizeGiftCode,
  reviewBreakdown,
} from '../worker/lib/gifts/reviewCode';
import { evaluateReviewQuality } from '../worker/lib/reviewQuality';

const DETAILED = [
  'I installed this printer in a small workshop and tested dimensional accuracy, first-layer consistency, noise,',
  'material changes, calibration, networking, and long jobs. The photos show the actual finish and setup from',
  'different angles. Bed adhesion remained consistent, the controls were clear, and maintenance access was practical.',
].join(' ');

class ReviewBucket {
  constructor(private readonly heads: Record<string, { size: number; hash: string; type: string }>) {}
  async head(key: string) {
    const value = this.heads[key];
    return value
      ? ({ key, size: value.size, customMetadata: { sha256: value.hash }, httpMetadata: { contentType: value.type } } as unknown as R2Object)
      : null;
  }
}

const HEADS: Record<string, { size: number; hash: string; type: string }> = {};
for (const user of ['buyer', 'other', 'boss']) {
  for (const [name, size, type] of [
    ['a.jpg', 180_000, 'image/jpeg'],
    ['b.jpg', 210_000, 'image/jpeg'],
    ['c.jpg', 240_000, 'image/jpeg'],
    ['demo.mp4', 900_000, 'video/mp4'],
  ] as const) HEADS[`reviews/${user}/${name}`] = { size, hash: `${user}-${name}`, type };
}
const BUCKET = new ReviewBucket(HEADS);
const ENV = { BUCKET, R2_PRIVATE: BUCKET };

const mount: Mount = (a) => {
  mountGifts(a);
  a.route('/api/rewards/program', rewardProgramRoutes);
};
const appOn = (db: unknown, user: StubUser) => stubApp(db, user, mount, { publishV2: 'always', env: ENV });

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };

/** The gift world, a printer in the printer catalogue, and that printer delivered to the buyer and to the other customer. */
function road(raw: DatabaseSync = giftWorld()) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('helper','Helper','helper@x.co','h','admin','assistant'),
      ('staff','Staff','staff@x.co','h','admin','full');
    INSERT INTO catalogs (id,slug,name_ar,is_printer_catalog) VALUES ('test-printers','test-printers','Printers',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_printer','bambu-p1s','Bambu Lab P1S','طابعة P1S','چاپکەری P1S',900000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','["/files/p1s.jpg"]');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','test-printers',91);
  `);
  const delivered = (order: string, user: string) => {
    raw.exec(`
      INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                          subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
        VALUES ('${order}','${user}','delivered','{}','standard','{}','cash',900000,0,1400,900000,0,'2026-09-01T00:00:00.000Z');
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
        VALUES ('oi_${order}','${order}','p_printer','Bambu Lab P1S','','','standard',1,900000,900000);
    `);
  };
  delivered('ord_b', 'buyer');
  delivered('ord_o', 'other');
  const db = asD1(raw);
  return { raw, db, buyer: appOn(db, BUYER), other: appOn(db, OTHER), admin: appOn(db, BOSS), helper: appOn(db, ASSISTANT), staff: appOn(db, FINANCE) };
}
type Road = ReturnType<typeof road>;

const RICH = {
  stars: 2,
  body: DETAILED,
  photoKeys: ['reviews/buyer/a.jpg', 'reviews/buyer/b.jpg', 'reviews/buyer/c.jpg'],
  videoKey: 'reviews/buyer/demo.mp4',
  instagram: { link: 'https://instagram.com/stories/sara/1' },
};

/** The buyer's review through the real route; answers its id. */
async function review(r: Road, body: Record<string, unknown> = RICH, app = r.buyer, orderId = 'ord_b'): Promise<string> {
  const res = await post(app, '/api/reviews', { productId: 'p_printer', orderId, ...body });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  return out.review.id;
}

const approve = (r: Road, id: string, body: Record<string, unknown> = {}, app = r.admin) =>
  post(app, `/api/reviews/admin/${id}/reward`, { action: 'approve', reason: 'Clear writing, real photos and a useful video.', ...body });

async function approved(r: Road, id: string, finalScore?: number): Promise<J> {
  const res = await approve(r, id, finalScore === undefined ? {} : { finalScore });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  return out;
}

const writeCode = (app: Road['buyer'], code: unknown) => post(app, '/api/rewards/program/gift-code', { code });

/** The whole hub answer, for what it says beside the printers. */
const hubOf = async (app: Road['buyer']): Promise<J> => json(await get(app, '/api/rewards/program'));

const printerOf = async (app: Road['buyer']): Promise<J> => {
  const hub = await json(await get(app, '/api/rewards/program'));
  return hub.printers.find((p: J) => p.product_id === 'p_printer');
};

/** Items on levels 1, 2 and 3: the nozzle kit, the cleaner and the plate. */
async function placeGifts(r: Road): Promise<{ l1: J; l2: J; l3: J }> {
  const l1 = await addLevelItem(r.admin, 1, NOZZLE_04_RED);
  const l2 = await addLevelItem(r.admin, 2, PLAIN);
  const l3 = await addLevelItem(r.admin, 3, PLATE_AIR);
  return { l1, l2, l3 };
}

// ---------------------------------------------------------------- the code itself

test('a code is ten characters, GFT first, read aloud without 0, O, 1 or I, and however it is typed it is the same code', () => {
  assert.equal(GIFT_CODE_ALPHABET.length, 32, 'five bits each');
  assert.doesNotMatch(GIFT_CODE_ALPHABET, /[01OI]/);
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = newGiftCode();
    assert.match(code, GIFT_CODE_SHAPE);
    assert.equal(code.length, 10);
    seen.add(code);
  }
  assert.ok(seen.size > 495, 'codes do not repeat');
  assert.equal(normalizeGiftCode('  gft-7kq 4mzx\n'), 'GFT7KQ4MZX');
  assert.equal(normalizeGiftCode('GFT ٧KQ٤MZX'), 'GFT7KQ4MZX', 'an Arabic keyboard writes its own digits');
  assert.equal(normalizeGiftCode('gft۷kq۴mzx'), 'GFT7KQ4MZX', 'and a Persian one its own');
  assert.equal(normalizeGiftCode(42), '');
  assert.equal(normalizeGiftCode(null), '');
});

test('the breakdown is the real parts: a review with no video and no story says so with zeros, and any gap to the final score is its own line', () => {
  const q = evaluateReviewQuality({ stars: 1, body: DETAILED, media: [], hasEvidence: false, isPrinter: true });
  const b = reviewBreakdown({ finalScore: q.score, quality: q, stars: 1, body: DETAILED, hasStory: false });
  assert.equal(b.text.max, 42);
  assert.equal(b.images.max, 27);
  assert.equal(b.video.max, 18);
  assert.equal(b.story.max, 8);
  assert.equal(b.stars.max, 5);
  assert.equal(b.text.score, q.textQuality);
  assert.ok(b.text.chars > 240 && b.text.words > 30, JSON.stringify(b.text));
  assert.deepEqual(b.images, { score: 0, max: 27, count: 0 });
  assert.deepEqual(b.video, { score: 0, max: 18, present: false });
  assert.deepEqual(b.story, { score: 0, max: 8, present: false });
  assert.deepEqual(b.stars, { score: 5, max: 5, stars: 1 }, 'one star earns the same five as five stars');
  assert.equal(b.adjustment, 0, 'the parts add up to the score');
  const lower = reviewBreakdown({ finalScore: q.score - 7, quality: q, stars: 1, body: DETAILED, hasStory: false });
  assert.equal(lower.adjustment, -7, 'the admin lowered it: said on its own line, never spread over the parts');
  // A reward whose snapshot predates the counts reads them again from the review's text: the same figures.
  const { textChars, wordCount, ...beforeCounts } = q;
  const older = reviewBreakdown({ finalScore: q.score, quality: beforeCounts, stars: 1, body: DETAILED, hasStory: false });
  assert.equal(older.text.chars, textChars);
  assert.equal(older.text.words, wordCount);
});

// -------------------------------------------------------------------- the road

test('the whole road: gifts on levels → review → queue → approved at 26 → code → levels {1,2} only → delivery only → fulfilled', async () => {
  const r = road();
  const { raw } = r;
  const { l1, l2, l3 } = await placeGifts(r);

  // ---- 1. The review enters the queue with the system's score and its parts. --
  const reviewId = await review(r);
  const queue = await json(await get(r.admin, '/api/reviews/admin/queue'));
  const entry = queue.queue.find((q: J) => q.review_id === reviewId);
  assert.equal(entry.reward_state, 'submitted');
  assert.equal(entry.quality_score, null, 'a level comes from the confirmed score, not before');
  assert.equal(entry.quality.score, 100, 'the system scored it');
  assert.equal(entry.final_score, null);
  assert.equal(entry.code, null);
  assert.ok(['ar', 'en', 'ckb'].includes(entry.customer.lang), 'the ready sentence is written in the customer’s language');
  assert.deepEqual(queue.gift_levels.map((l: J) => [l.level, l.sellable]), [[1, 1], [2, 1], [3, 1], [4, 0], [5, 0]]);
  assert.equal((await printerOf(r.buyer)).state, 'reward_pending');
  assert.deepEqual((await hubOf(r.buyer)).rating.gift_levels.map((l: J) => [l.level, l.threshold]), [[1, 1], [2, 20], [3, 40], [4, 60], [5, 80]], 'the server says what each level opens at');

  // ---- 2. Four eyes: an assistant moves nothing. Declining stays with everyone. --
  const byHelper = await approve(r, reviewId, { finalScore: 26 }, r.helper);
  assert.equal(byHelper.status, 403);
  assert.equal((await json(byHelper)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(row(raw, 'SELECT state FROM review_rewards WHERE review_id = ?', reviewId)?.state, 'submitted');

  // ---- 3. Approved at 26: a code, levels 1 and 2, and NO gift. ----------------
  const out = await approved(r, reviewId, 26);
  assert.equal(out.final_score, 26);
  assert.deepEqual(out.levels, [1, 2]);
  assert.match(out.code, GIFT_CODE_SHAPE);
  assert.equal(out.entitlement_id, null);
  assert.deepEqual(out.warnings, []);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0, 'no gift yet');
  const stored = row<J>(raw, 'SELECT * FROM review_rewards WHERE review_id = ?', reviewId)!;
  assert.equal(stored.state, 'approved');
  assert.equal(stored.final_score, 26);
  assert.equal(stored.redeem_code, out.code);
  assert.equal(stored.quality_score, null);
  assert.ok(stored.code_issued_at);
  assert.equal(stored.code_redeemed_at, null);
  assert.equal(stored.decided_by, BOSS.id);

  // ---- 4. The customer is told, once, in three languages, without the code. ---
  const notices = all<J>(raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward' AND entity_type = 'review'");
  assert.equal(notices.length, 1);
  const n = notices[0];
  assert.equal(n.link, '/rewards/rate');
  assert.equal(n.title_ar, 'اعتُمدت مراجعتك');
  assert.equal(n.body_ar, 'سيصلك كود هديتك من فريق Levonis، أدخله في «قيّم طابعتك».');
  const meta = JSON.parse(n.meta);
  assert.match(meta.title_ckb, /هەڵسەنگاندنەکەت پەسەندکرا/);
  assert.notEqual(meta.body_ckb, n.body_ar);
  assert.ok(!JSON.stringify(n).includes(out.code), 'the notice never carries the code');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 0);

  // The audit rows name only the code's tail.
  const approvals = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'review.reward' AND target = ?", reviewId);
  assert.equal(approvals.length, 1);
  assert.ok(!approvals[0].detail.includes(out.code), 'the log never holds a whole code');
  assert.equal(JSON.parse(approvals[0].detail).final_score, 26);

  // ---- 5. The rate screen knows a code is awaited, and shows no figure yet. ----
  const waiting = await printerOf(r.buyer);
  assert.equal(waiting.state, 'code_ready');
  assert.equal(waiting.final_score, null);
  assert.equal(waiting.gift, null);
  const queued = (await json(await get(r.admin, '/api/reviews/admin/queue?state=approved'))).queue[0];
  assert.equal(queued.code, out.code, 'the admin can read it back and hand it over');
  assert.equal(queued.final_score, 26);
  assert.deepEqual(queued.levels, [1, 2]);

  // ---- 6. A wrong code, someone else's code: one answer. ----------------------
  for (const [app, code] of [[r.buyer, 'GFT2222222'], [r.buyer, 'nonsense'], [r.buyer, ''], [r.buyer, 42], [r.other, out.code]] as const) {
    const refused = await writeCode(app, code);
    assert.equal(refused.status, 404, String(code));
    assert.equal((await json(refused)).code, 'GIFT_CODE_INVALID');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);

  // ---- 7. The right code, however it is typed. --------------------------------
  const typed = ` ${out.code.slice(0, 3).toLowerCase()}-${out.code.slice(3, 6).toLowerCase()} ${out.code.slice(6)} `;
  const reveal = await writeCode(r.buyer, typed);
  const answer = await json(reveal);
  assert.equal(reveal.status, 200, JSON.stringify(answer));
  assert.equal(answer.replay, false);
  assert.equal(answer.score, 26);
  assert.deepEqual(answer.levels, [1, 2]);
  assert.deepEqual(answer.track.map((t: J) => [t.level, t.threshold, t.opened]), [[1, 1, true], [2, 20, true], [3, 40, false], [4, 60, false], [5, 80, false]]);
  // The real parts.
  assert.deepEqual(answer.breakdown.images, { score: 27, max: 27, count: 3 });
  assert.deepEqual(answer.breakdown.video, { score: 18, max: 18, present: true });
  assert.deepEqual(answer.breakdown.story, { score: 8, max: 8, present: true });
  assert.deepEqual(answer.breakdown.stars, { score: 5, max: 5, stars: 2 });
  assert.equal(answer.breakdown.text.max, 42);
  assert.ok(answer.breakdown.text.chars > 240);
  assert.equal(answer.breakdown.adjustment, 26 - (answer.breakdown.text.score + 27 + 18 + 8 + 5), 'the admin lowered it, on a line of its own');
  assert.deepEqual(answer.review, { product_id: 'p_printer', slug: 'bambu-p1s', name: { ar: 'طابعة P1S', en: 'Bambu Lab P1S', ckb: 'چاپکەری P1S' }, image: '/files/p1s.jpg', stars: 2 });
  // The gift: every sellable item of the opened levels, by level; closed levels are not even sent.
  const gift = answer.gift;
  assert.equal(gift.status, 'GRANTED');
  assert.equal(gift.choice_scope, 'up_to');
  assert.equal(gift.level.n, 2);
  assert.deepEqual(gift.choices.map((c: J) => [c.item_id, c.level]), [[l1.id, 1], [l2.id, 2]]);
  assert.ok(!JSON.stringify(answer).includes(l3.id), 'a closed level’s gift never reaches the customer');
  // No internal note, no granting admin.
  assert.ok(!JSON.stringify(answer).includes('Clear writing'), 'the admin’s reason stays internal');
  assert.ok(!JSON.stringify(answer).includes('granted_by'));
  // The row is what the spec asks for.
  const g = giftRow(raw, gift.id);
  assert.equal(g.grant_mode, 'level');
  assert.equal(g.level, 2);
  assert.equal(g.max_level, 2);
  assert.equal(g.reason, 'review');
  assert.equal(g.choice_scope, 'up_to');
  assert.equal(g.reward_id, stored.id);
  assert.equal(g.granted_by, BOSS.id, 'the admin who approved it');
  assert.ok(row<J>(raw, 'SELECT code_redeemed_at FROM review_rewards WHERE id = ?', stored.id)!.code_redeemed_at);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 0, 'no «you received a gift»: they are looking at it');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.grant' AND target = ?", gift.id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'review.code.redeem' AND target = ?", reviewId), 1);

  // ---- 8. A replay by its owner answers the same, and writes nothing. ---------
  const before = count(raw, 'SELECT COUNT(*) AS n FROM audit_log');
  const again = await json(await writeCode(r.buyer, out.code));
  assert.equal(again.replay, true);
  assert.equal(again.score, 26);
  assert.equal(again.gift.id, gift.id);
  assert.deepEqual(again.breakdown, answer.breakdown);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_log'), before);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
  assert.equal((await writeCode(r.other, out.code)).status, 404, 'still nothing to anyone else');
  // The same answer without the code, for a later visit.
  const later = await json(await get(r.buyer, `/api/rewards/program/gift-reveal/${gift.id}`));
  assert.equal(later.score, 26);
  assert.deepEqual(later.levels, [1, 2]);
  assert.equal((await get(r.other, `/api/rewards/program/gift-reveal/${gift.id}`)).status, 404);
  // The rate screen: the gift waits there, and only now says the figure.
  const waitingGift = await printerOf(r.buyer);
  assert.equal(waitingGift.state, 'reward_approved');
  assert.equal(waitingGift.final_score, 26);
  assert.equal(waitingGift.reward_level, 2);
  assert.deepEqual(waitingGift.gift, { id: gift.id, status: 'GRANTED', scope: 'up_to' });

  // ---- 9. A level 3 item is refused at the door. ------------------------------
  const closed = await choose(r.buyer, gift.id, l3.id);
  assert.equal(closed.status, 409);
  const closedBody = await json(closed);
  assert.equal(closedBody.code, 'GIFT_ITEM_UNAVAILABLE');
  assert.equal(closedBody.details.reason, 'ITEM_NOT_IN_LEVEL');

  // ---- 10. Choose from level 1, change to level 2, redeem, cart. ---------------
  assert.equal((await json(await choose(r.buyer, gift.id, l1.id))).gift.chosen_level, 1);
  const chosen = (await json(await choose(r.buyer, gift.id, l2.id))).gift;
  assert.equal(chosen.status, 'READY_TO_REDEEM');
  assert.equal(chosen.chosen_level, 2);
  assert.equal(chosen.chosen.level, 2);
  assert.equal(chosen.chosen.product_id, 'p_plain');
  const redeemed = (await json(await redeem(r.buyer, gift.id))).gift;
  assert.equal(redeemed.status, 'REDEEMED');
  assert.equal(row(raw, 'SELECT level FROM gift_redemptions WHERE entitlement_id = ?', gift.id)?.level, 2, 'the level it came from');
  const cart = await json(await addGiftToCart(r.buyer, gift.id));
  const line = cart.items.find((i: J) => i.kind === 'gift');
  assert.equal(line.unit_price_iqd, 0);
  assert.equal((await printerOf(r.buyer)).gift.status, 'ADDED_TO_ORDER');

  // ---- 11. The quote charges delivery only; the order; delivered; fulfilled. ---
  const quote = (await json(await post(r.buyer, '/api/orders/quote', quoteBody()))).quote;
  assert.equal(quote.merchandise_iqd, 0, 'nothing but delivery');
  assert.equal(quote.lines.find((l: J) => l.is_gift).line_total_iqd, 0);
  assert.ok(quote.shipping.total_iqd > 0, 'delivery is charged as normal');
  assert.equal(quote.subtotal_iqd, 0);
  const order = await placeOrder(r.buyer);
  assert.equal(order.subtotal_iqd, 0);
  const placed = row<J>(raw, 'SELECT subtotal_iqd, shipping_iqd, total_iqd FROM orders WHERE id = ?', order.id)!;
  assert.ok(placed.shipping_iqd > 0);
  assert.equal(placed.total_iqd, placed.shipping_iqd, 'pays delivery only');
  assert.equal(order.order_kind, 'gift');
  const ordered = await printerOf(r.buyer);
  assert.equal(ordered.state, 'rated', 'nothing is left to do here');
  assert.equal(ordered.gift.status, 'ORDERED');
  const stillShown = await json(await writeCode(r.buyer, out.code));
  assert.equal(stillShown.gift.status, 'ORDERED', 'a reload while it travels still shows it');
  assert.equal((await patch(r.admin, `/api/admin/orders/${order.id}`, { status: 'delivered' })).status, 200);
  assert.equal(giftRow(raw, gift.id).state, 'fulfilled');
  const used = await writeCode(r.buyer, out.code);
  assert.equal(used.status, 409, 'once delivered the code is simply used');
  assert.equal((await json(used)).code, 'GIFT_CODE_USED');
  assert.equal((await writeCode(r.other, out.code)).status, 404, 'and only its owner hears that');

  // ---- 12. The admin's screens name the level taken. ---------------------------
  const adminGift = (await json(await get(r.admin, `/api/gifts/admin/grants/${gift.id}`))).grant;
  assert.equal(adminGift.choice_scope, 'up_to');
  assert.equal(adminGift.chosen_level, 2);
  assert.equal(adminGift.level.n, 2);
});

test('the owner’s examples: 5 opens level 1 alone, 20 opens two, 80 opens all five, and only those gifts are offered', async () => {
  for (const [score, levels] of [[5, [1]], [19, [1]], [20, [1, 2]], [40, [1, 2, 3]], [60, [1, 2, 3, 4]], [80, [1, 2, 3, 4, 5]], [100, [1, 2, 3, 4, 5]]] as const) {
    const r = road();
    const items: J[] = [];
    for (const n of [1, 2, 3, 4, 5]) items.push(await addLevelItem(r.admin, n, PLAIN));
    const id = await review(r);
    const { code } = await approved(r, id, score);
    const answer = await json(await writeCode(r.buyer, code));
    assert.deepEqual(answer.levels, levels, `score ${score}`);
    assert.deepEqual(answer.gift.choices.map((c: J) => c.level), levels, `score ${score}`);
    assert.deepEqual(answer.gift.choices.map((c: J) => c.item_id), levels.map((n) => items[n - 1].id));
  }
});

test('admission: a printer review with almost nothing still enters the queue as a 5; a severe signal stays out, with its fallback points', async () => {
  const r = road();
  await placeGifts(r);
  r.raw.exec(`INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{"enabled":true,"points":12}')`);

  // The owner's example: no photo, no video, hardly a word. It is a 5, and it is in the queue.
  const small = await post(r.buyer, '/api/reviews', { productId: 'p_printer', orderId: 'ord_b', stars: 3, body: 'Good' });
  const smallOut = await json(small);
  assert.equal(small.status, 200, JSON.stringify(smallOut));
  assert.equal(smallOut.review.fallback_points_awarded, 0, 'no fallback: it can still earn a gift');
  assert.equal(smallOut.review.reward.state, 'submitted');
  assert.equal(smallOut.quality.score, 5);
  assert.equal(smallOut.quality.tier, null, 'the old gate is still computed, and decides nothing');
  assert.equal(smallOut.quality.rewardEligible, true);
  // The admin's default is the system's own score.
  const out = await approved(r, smallOut.review.id);
  assert.equal(out.final_score, 5);
  assert.deepEqual(out.levels, [1]);
  const answer = await json(await writeCode(r.buyer, out.code));
  assert.equal(answer.score, 5);
  assert.deepEqual(answer.levels, [1]);
  assert.equal(answer.breakdown.adjustment, 0, 'the five is the stars, and nothing is invented');
  assert.deepEqual(answer.breakdown.images, { score: 0, max: 27, count: 0 });

  // The same words again from a second customer are fine; the same words from
  // the same customer on another printer are a severe signal: out of the queue.
  r.raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_printer2','bambu-a1','Bambu Lab A1','طابعة A1',600000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer2','test-printers',92);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_b2','buyer','delivered','{}','standard','{}','cash',600000,0,1400,600000,0,'2026-09-02T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_b2','ord_b2','p_printer2','Bambu Lab A1','','','standard',1,600000,600000);
    UPDATE reviews SET body = '${DETAILED.replace(/'/g, "''")}' WHERE id = '${smallOut.review.id}';
  `);
  const copy = await post(r.buyer, '/api/reviews', { productId: 'p_printer2', orderId: 'ord_b2', stars: 4, body: DETAILED });
  const copyOut = await json(copy);
  assert.equal(copy.status, 200, JSON.stringify(copyOut));
  assert.ok(copyOut.quality.suspiciousSignals.includes('duplicate_text'));
  assert.equal(copyOut.quality.rewardEligible, false);
  assert.equal(copyOut.review.reward, null, 'a severe signal never enters the queue');
  assert.equal(copyOut.review.fallback_points_awarded, 24, 'its path is what it was: the fallback points');
});

test('the cart, the quote, the order and their audit rows name the level the gift was chosen from, not the highest the score opened', async () => {
  const r = road();
  const { l1 } = await placeGifts(r);
  const id = await review(r);
  const { code } = await approved(r, id, 45);
  const { gift } = await json(await writeCode(r.buyer, code));
  assert.equal(gift.level.n, 3, 'the score opened three levels');

  // Level 1 of the three: every reader after this point says 1.
  assert.equal((await choose(r.buyer, gift.id, l1.id)).status, 200);
  assert.equal((await redeem(r.buyer, gift.id)).status, 200);
  const cart = await json(await addGiftToCart(r.buyer, gift.id));
  assert.equal(cart.items.find((i: J) => i.kind === 'gift').gift.level, 1, 'the cart’s «هدية · المستوى 1»');
  assert.equal((await json(await get(r.buyer, '/api/cart'))).items.find((i: J) => i.kind === 'gift').gift.level, 1);
  const quote = (await json(await post(r.buyer, '/api/orders/quote', quoteBody()))).quote;
  assert.equal(quote.lines.find((l: J) => l.is_gift).gift.level, 1);
  const order = await placeOrder(r.buyer);
  const item = row<J>(r.raw, 'SELECT pricing_snapshot FROM order_items WHERE order_id = ? AND gift_entitlement_id = ?', order.id, gift.id)!;
  assert.equal(JSON.parse(item.pricing_snapshot).gift.level, 1, 'the order’s own record');
  for (const action of ['gift.choose', 'gift.redeem', 'gift.cart_add', 'gift.order']) {
    const audit = row<{ detail: string }>(r.raw, 'SELECT detail FROM audit_log WHERE action = ? AND target = ?', action, gift.id)!;
    const detail = JSON.parse(audit.detail);
    assert.equal(detail.chosen_level ?? detail.level, 1, action);
  }
  // The gift itself still says how far the score reached.
  assert.equal(giftRow(r.raw, gift.id).level, 3);
  assert.equal(giftRow(r.raw, gift.id).chosen_level, 1);
});

test('a non-printer review keeps its fallback points, and a review proved by a gift line earns nothing', async () => {
  const r = road();
  r.raw.exec(`
    INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{"enabled":true,"points":12}');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_n','buyer','delivered','{}','standard','{}','cash',15000,0,1400,15000,0,'2026-09-02T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_n','ord_n','p_plain','Nozzle cleaner','','','standard',1,15000,15000);
  `);
  const res = await post(r.buyer, '/api/reviews', { productId: 'p_plain', orderId: 'ord_n', stars: 5, body: DETAILED });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.quality.rewardEligible, false);
  assert.equal(out.review.reward, null);
  assert.equal(out.review.fallback_points_awarded, 24);
});

// ------------------------------------------------------------------ the refusals

test('every opened level empty refuses the approval; a level switched off or empty beside a live one warns, and is reported', async () => {
  const r = road();
  const id = await review(r);
  // Nothing placed yet: a customer would land on nothing.
  const none = await approve(r, id, { finalScore: 26 });
  const noneBody = await json(none);
  assert.equal(none.status, 409, JSON.stringify(noneBody));
  assert.equal(noneBody.code, 'GIFT_LEVEL_EMPTY');
  assert.deepEqual(noneBody.details.levels, [1, 2]);
  assert.equal(row(r.raw, 'SELECT state FROM review_rewards WHERE review_id = ?', id)?.state, 'submitted', 'nothing was written');
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'reward'"), 0);

  // An item on level 3 does not help a 26.
  const l3 = await addLevelItem(r.admin, 3, PLAIN);
  assert.equal((await approve(r, id, { finalScore: 26 })).status, 409);

  // At 70: levels 1..4. Level 3 is live; 1 is switched off, 2 and 4 are empty, and a sold-out one is said too.
  const l1 = await addLevelItem(r.admin, 1, NOZZLE_04_RED);
  r.raw.exec("UPDATE gift_pools SET active = 0 WHERE id = 'gift_level_1'");
  const out = await approved(r, id, 70);
  assert.deepEqual(out.levels, [1, 2, 3, 4]);
  assert.deepEqual(out.warnings, [
    { level: 1, code: 'GIFT_LEVEL_OFF' },
    { level: 2, code: 'GIFT_LEVEL_NO_ITEMS' },
    { level: 4, code: 'GIFT_LEVEL_NO_ITEMS' },
  ]);

  // The customer is offered only what is live: the off level's gift is neither listed nor accepted.
  const answer = await json(await writeCode(r.buyer, out.code));
  assert.deepEqual(answer.levels, [1, 2, 3, 4], 'the score opened them');
  assert.deepEqual(answer.gift.choices.map((c: J) => c.item_id), [l3.id]);
  const off = await choose(r.buyer, answer.gift.id, l1.id);
  assert.equal(off.status, 409);
  assert.equal((await json(off)).details.reason, 'ITEM_NOT_IN_LEVEL');
  // A level switched off after the choice is refused at the redemption too.
  assert.equal((await choose(r.buyer, answer.gift.id, l3.id)).status, 200);
  r.raw.exec("UPDATE gift_pools SET active = 0 WHERE id = 'gift_level_3'");
  const late = await redeem(r.buyer, answer.gift.id);
  assert.equal(late.status, 409);
  assert.equal((await json(late)).details.reason, 'ITEM_WITHDRAWN');
});

test('a sold-out item is not offered by a code’s gift, and an item sold out on every opened level refuses the approval', async () => {
  const r = road();
  // 0.6 mm has no stock: configured, not sellable.
  await addLevelItem(r.admin, 1, { ...NOZZLE_04_RED, optionValueIds: ['v_06'] });
  const id = await review(r);
  const refused = await approve(r, id, { finalScore: 5 });
  assert.equal(refused.status, 409);
  assert.deepEqual((await json(refused)).details.warnings, [{ level: 1, code: 'GIFT_LEVEL_SOLD_OUT' }]);
  const ok = await addLevelItem(r.admin, 1, PLAIN);
  const out = await approved(r, id, 5);
  const answer = await json(await writeCode(r.buyer, out.code));
  assert.deepEqual(answer.gift.choices.map((c: J) => c.item_id), [ok.id], 'only what can be ordered now');
});

test('four eyes: an admin never approves their own review, and a financial admin approves another’s', async () => {
  const r = road();
  await placeGifts(r);
  r.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_s','staff','delivered','{}','standard','{}','cash',900000,0,1400,900000,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_s','ord_s','p_printer','Bambu Lab P1S','','','standard',1,900000,900000);
  `);
  const own = await review(r, { ...RICH, photoKeys: [], videoKey: '', stars: 4, body: `${DETAILED} From the staff side.` }, r.staff, 'ord_s');
  const self = await approve(r, own, { finalScore: 90 }, r.staff);
  assert.equal(self.status, 403);
  assert.equal((await json(self)).code, 'OWNER_REQUIRED');
  assert.equal(row(r.raw, 'SELECT redeem_code FROM review_rewards WHERE review_id = ?', own)?.redeem_code, null);

  const id = await review(r);
  const byStaff = await json(await approve(r, id, { finalScore: 90 }, r.staff));
  assert.equal(byStaff.final_score, 90);
  assert.equal(byStaff.reward_state, 'approved');
});

test('one gift per review: a second approval, a second review of that printer, and a race on the code all write nothing more', async () => {
  const r = road();
  await placeGifts(r);
  const id = await review(r);
  const out = await approved(r, id, 45);
  const code = out.code as string;

  // A second approval, by a press or by an old tab.
  const second = await approve(r, id, { finalScore: 99 });
  assert.equal(second.status, 409);
  assert.equal((await approve(r, id, { qualityScore: 5 })).status, 409);
  assert.equal(row(r.raw, 'SELECT redeem_code FROM review_rewards WHERE review_id = ?', id)?.redeem_code, code, 'the code did not move');

  // A second review of the same printer: one review per product, whatever was bought.
  r.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_b3','buyer','delivered','{}','standard','{}','cash',900000,0,1400,900000,0,'2026-10-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_b3','ord_b3','p_printer','Bambu Lab P1S','','','standard',1,900000,900000);
  `);
  assert.equal((await post(r.buyer, '/api/reviews', { productId: 'p_printer', orderId: 'ord_b3', stars: 5, body: 'A second opinion on the same printer.' })).status, 409);

  // Two presses at once, on a database that runs them one statement at a time.
  const db = serialD1(r.raw);
  const buyer = appOn(db, BUYER);
  const [a, b] = await Promise.all([writeCode(buyer, code), writeCode(buyer, code)]);
  assert.deepEqual([a.status, b.status], [200, 200], 'both presses see the gift');
  const [ja, jb] = [await json(a), await json(b)];
  assert.equal(ja.gift.id, jb.gift.id);
  assert.deepEqual([ja.replay, jb.replay].sort(), [false, true], 'one of them made it');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.grant'"), 1);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'review.code.redeem'"), 1);
});

test('regenerating: while unredeemed the old code dies and the new one works; after it, refused; an assistant never', async () => {
  const r = road();
  await placeGifts(r);
  const id = await review(r);
  const out = await approved(r, id, 26);
  const path = `/api/reviews/admin/${id}/code/regenerate`;

  const byHelper = await post(r.helper, path, {});
  assert.equal(byHelper.status, 403);
  assert.equal((await json(byHelper)).code, 'FINANCIAL_SCOPE_REQUIRED');

  const fresh = await json(await post(r.admin, path, {}));
  assert.match(fresh.code, GIFT_CODE_SHAPE);
  assert.notEqual(fresh.code, out.code);
  const audit = row<{ detail: string }>(r.raw, "SELECT detail FROM audit_log WHERE action = 'review.code.regenerate' AND target = ?", id)!;
  assert.ok(!audit.detail.includes(fresh.code) && !audit.detail.includes(out.code), 'tails only');
  assert.equal(JSON.parse(audit.detail).old_code_tail, out.code.slice(-3));

  const dead = await writeCode(r.buyer, out.code);
  assert.equal(dead.status, 404, 'to the customer a dead code is an unknown one');
  assert.equal((await json(dead)).code, 'GIFT_CODE_INVALID');

  const answer = await json(await writeCode(r.buyer, fresh.code));
  assert.equal(answer.score, 26);
  const late = await post(r.admin, path, {});
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'GIFT_CODE_USED');
  assert.equal(row(r.raw, 'SELECT redeem_code FROM review_rewards WHERE review_id = ?', id)?.redeem_code, fresh.code);

  // A reward with no code has nothing to regenerate.
  const other = await review(r, { ...RICH, photoKeys: [], videoKey: '', body: `${DETAILED} And from me too.` }, r.other, 'ord_o');
  const none = await post(r.admin, `/api/reviews/admin/${other}/code/regenerate`, {});
  assert.equal(none.status, 409);
  assert.equal((await json(none)).code, 'GIFT_CODE_NONE');
  assert.equal((await post(r.admin, '/api/reviews/admin/nope/code/regenerate', {})).status, 404);
});

test('ten tries an hour on its own limiter: the eleventh is refused, wherever it comes from', async () => {
  const r = road();
  for (let i = 0; i < 10; i++) assert.equal((await writeCode(r.buyer, `GFT22222${i + 2}`)).status, 404, `try ${i + 1}`);
  const over = await writeCode(r.buyer, 'GFT2222222');
  assert.equal(over.status, 429);
  assert.equal((await writeCode(r.other, 'GFT2222222')).status, 404, 'each customer has their own ten');
});

// ---------------------------------------------------------- the old and the older

test('an old tab’s qualityScore is read as the score that opens that level, and grants nothing', async () => {
  const r = road();
  await placeGifts(r);
  const id = await review(r);
  const out = await json(await approve(r, id, { qualityScore: 2 }));
  assert.equal(out.reward_state, 'approved');
  assert.equal(out.final_score, 39, 'the system’s 100 is above level 2: the nearest score that opens exactly it');
  assert.deepEqual(out.levels, [1, 2]);
  assert.match(out.code, GIFT_CODE_SHAPE);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  // Out of range stays refused.
  const r2 = road();
  await placeGifts(r2);
  const id2 = await review(r2);
  assert.equal((await approve(r2, id2, { qualityScore: 9 })).status, 400);
  assert.equal((await approve(r2, id2, { finalScore: 0 })).status, 400);
  assert.equal((await approve(r2, id2, { finalScore: 101 })).status, 400);
  assert.equal((await approve(r2, id2, { finalScore: 'many' })).status, 400);
});

test('a reward approved before this keeps its entitlement and its old path: its own level’s items, no code', async () => {
  const r = road();
  const { l1, l2 } = await placeGifts(r);
  const other = await addLevelItem(r.admin, 2, NOZZLE_04_RED);
  r.raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,stars,body,status,source)
      VALUES ('rv_old','buyer','p_printer',5,'An older review of this printer.','published','user');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score,quality_snapshot,decided_by,decided_at)
      VALUES ('rr_old','rv_old','buyer','printer_gift','approved',2,'{"score":60,"tier":2,"rewardEligible":true}','boss','2026-10-01T00:00:00.000Z');
    INSERT INTO gift_entitlements (id,reward_id,user_id,max_level,chosen_level,state,grant_mode,reason,level,admin_note,granted_by,granted_at,updated_at,created_at)
      VALUES ('gift_old','rr_old','buyer',2,2,'granted','level','review',2,'','boss','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
  `);
  const printer = await printerOf(r.buyer);
  assert.equal(printer.state, 'reward_approved', 'it waits under /gifts as it did');
  assert.equal(printer.reward_level, 2);
  assert.equal(printer.final_score, null);
  assert.deepEqual(printer.gift, { id: 'gift_old', status: 'GRANTED', scope: 'level' });
  const card = (await json(await get(r.buyer, '/api/gifts'))).gifts[0];
  assert.equal(card.choice_scope, 'level');
  assert.deepEqual(card.choices.map((c: J) => c.item_id).sort(), [l2.id, other.id].sort(), 'its own level, and nothing below');
  assert.equal((await choose(r.buyer, 'gift_old', l1.id)).status, 409, 'level 1 is not its level');
  assert.equal((await choose(r.buyer, 'gift_old', l2.id)).status, 200);
  assert.equal((await get(r.buyer, '/api/rewards/program/gift-reveal/gift_old')).status, 404, 'it never came from a code');
  // A second approval still leaves it alone.
  assert.equal((await approve(r, 'rv_old', { finalScore: 90 })).status, 409);
  const after = row<J>(r.raw, "SELECT quality_score, final_score, redeem_code FROM review_rewards WHERE id = 'rr_old'")!;
  assert.deepEqual([after.quality_score, after.final_score, after.redeem_code], [2, null, null]);
});

test('the rate screen stops saying «your gift is waiting» once a gift has gone: ordered, delivered, cancelled, or never a gift at all', async () => {
  const r = road();
  r.raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,stars,body,status,source)
      VALUES ('rv_old','buyer','p_printer',5,'An older review of this printer.','published','user');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,points_awarded,decided_by,decided_at)
      VALUES ('rr_old','rv_old','buyer','points','approved',50,'boss','2026-10-01T00:00:00.000Z');
  `);
  const points = await printerOf(r.buyer);
  assert.equal(points.state, 'rated', 'a points reward never had a gift to wait for');
  assert.equal(points.gift, null);
  r.raw.exec(`
    UPDATE review_rewards SET kind = 'printer_gift', quality_score = 2 WHERE id = 'rr_old';
    INSERT INTO gift_entitlements (id,reward_id,user_id,max_level,chosen_level,state,grant_mode,reason,level,admin_note,granted_by,granted_at,updated_at,created_at,cancelled_at)
      VALUES ('gift_old','rr_old','buyer',2,2,'cancelled','level','review',2,'','boss','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-02T00:00:00.000Z');
  `);
  const cancelled = await printerOf(r.buyer);
  assert.equal(cancelled.state, 'rated');
  assert.equal(cancelled.gift.status, 'CANCELLED');
});

test('a gift cancelled by the shop: its code answers «used» to its owner, and the reveal still reads', async () => {
  const r = road();
  await placeGifts(r);
  const id = await review(r);
  const { code } = await approved(r, id, 26);
  const answer = await json(await writeCode(r.buyer, code));
  assert.equal((await post(r.admin, `/api/gifts/admin/grants/${answer.gift.id}/cancel`, { reason: 'Customer asked to cancel it.' })).status, 200);
  const used = await writeCode(r.buyer, code);
  assert.equal(used.status, 409);
  assert.equal((await json(used)).code, 'GIFT_CODE_USED');
  assert.equal((await printerOf(r.buyer)).state, 'rated');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1, 'a code never makes a second gift');
});

test('a database before 0228: the queue, the hub and /gifts answer as they did, an approval grants the old gift, and every code is unknown', async () => {
  const r = road(giftWorld(dbThrough('0225')));
  const { raw } = r;
  const { l2 } = await placeGifts(r);
  const id = await review(r);
  // Every read answers.
  const queue = await json(await get(r.admin, '/api/reviews/admin/queue'));
  assert.equal(queue.queue[0].final_score, null);
  assert.equal(queue.queue[0].code, null);
  assert.equal((await printerOf(r.buyer)).state, 'reward_pending');
  // The approval does what it did the day before.
  const out = await approved(r, id, 26);
  assert.equal(out.reward_state, 'approved');
  assert.ok(out.entitlement_id, 'the old level gift');
  assert.equal(out.quality_score, 2);
  const g = row<J>(raw, 'SELECT * FROM gift_entitlements WHERE id = ?', out.entitlement_id)!;
  assert.equal(g.level, 2);
  assert.equal(g.choice_scope, undefined);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 1, 'with its notice');
  // A customer's screens keep working, at the old path.
  const printer = await printerOf(r.buyer);
  assert.equal(printer.state, 'reward_approved');
  assert.deepEqual(printer.gift, { id: out.entitlement_id, status: 'GRANTED', scope: 'level' });
  const card = (await json(await get(r.buyer, '/api/gifts'))).gifts[0];
  assert.equal(card.choice_scope, 'level');
  assert.deepEqual(card.choices.map((c: J) => c.item_id), [l2.id]);
  assert.equal((await choose(r.buyer, out.entitlement_id, l2.id)).status, 200);
  // The code's door: no such code can exist.
  const refused = await writeCode(r.buyer, 'GFT2222222');
  assert.equal(refused.status, 404);
  assert.equal((await json(refused)).code, 'GIFT_CODE_INVALID');
  assert.equal((await get(r.buyer, `/api/rewards/program/gift-reveal/${out.entitlement_id}`)).status, 404);
  const none = await post(r.admin, `/api/reviews/admin/${id}/code/regenerate`, {});
  assert.equal(none.status, 409);
  assert.equal((await json(none)).code, 'GIFT_CODE_NONE');
});
