/**
 * THE OWNER'S RULINGS OF 2026-11-09 (DECISIONS row 303), the ones the review road does not hold:
 *
 *   R2  points come back with a withdrawn coupon — once, in the withdrawal's own batch, with a notice
 *       in three languages, as a cancelled points-shop gift already does; policy 14.10;
 *   R3  100,000 and above — the delivery coupon's minimum counts, and every customer, admin and policy
 *       text says «من 100,000 د.ع فأكثر» / "of 100,000 IQD or more" (tests/cartRewardCoupons.test.ts
 *       holds the arithmetic at exactly the minimum, in the cart and at the checkout);
 *   R4  the policy's words for a refused printer review (tests/reviewGiftCode.test.ts holds the points);
 *
 * and the lead's call beside them: a gift's stated value is what a customer pays for it today, the sale
 * price under a live offer (tests/rewardsShopItems.test.ts holds it through the quote). R1 is
 * tests/rewardsReviewVoid.test.ts. Real migrations, real routers.
 *
 * THE OWNER'S WORDS OF 2026-11-10 (same row): the chip on the missions the browser counts reads
 * «يعتمد على متصفحك» / "Relies on your browser" in place of «غير مُتحقَّق منه»; policy 5.8 is unchanged.
 *
 * Run: node --import tsx --test tests/rewardsOwnerRulings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { all, asD1, count, row, stubApp } from './fixtures/app';
import { BOSS, get, json, post, type J } from './fixtures/giftWorld';
import { esunWorld, givePoints, mountShop, ownersPrices, points, ESUN_BEFORE_OFFER_IQD, ESUN_UNIT_IQD } from './fixtures/shopWorld';
import { printerOrder } from './fixtures/rewardsWorld';
import { rewardText } from '../worker/lib/rewards/strings';
import { SHOP_COUPON_BACK_NOTE } from '../worker/lib/rewards/coupons';
import { giftShelfUnitIqd } from '../worker/lib/gifts/cartLine';
import { ledgerLabel } from '../src/components/points/words';
import { pointsBackOnWithdraw } from '../src/components/adminRewards/RewardsCoupons';
import { COPY, copyText } from '../src/components/rewards/copy';
import type { ResolvedPrice } from '../worker/lib/pricing';
import type { OfferView } from '../worker/lib/offers';

const src = (file: string) => readFileSync(file, 'utf8');
const own = (ar: string, en: string, ckb: string, why: string) => {
  assert.ok(ar && en && ckb, why);
  assert.notEqual(ckb, ar, why);
  assert.notEqual(ckb, en, why);
  assert.doesNotMatch(ckb, /[ةىيك]/, `${why}: an Arabic-only letter in the Sorani`);
};

// ------------------------------------------------------------------ R2

function shop() {
  const raw = esunWorld();
  ownersPrices(raw);
  const db = asD1(raw);
  return { raw, buyer: stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, mountShop, { publishV2: 'always' }), boss: stubApp(db, BOSS, mountShop, { publishV2: 'always' }) };
}

test('R2: the team withdraws a coupon bought with 3,000 points, and the 3,000 come back once, in that batch, with a notice in three languages', async () => {
  const w = shop();
  givePoints(w.raw, 5_000);
  const bought = await json(await post(w.buyer, '/api/rewards/program/shop/free_shipping'));
  assert.equal(bought.success, true, JSON.stringify(bought));
  const grantId = bought.coupon.id as string;
  assert.equal(points(w.raw), 2_000);

  const res = await post(w.boss, `/api/admin/rewards/grants/${grantId}/revoke`, { reason: 'Issued by mistake' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.points_returned, 3_000);
  assert.equal(points(w.raw), 5_000, 'the price is back');
  const back = row<{ amount: number; note: string; ref: string; type: string }>(w.raw, 'SELECT amount, note, ref, type FROM wallet_transactions WHERE id = ?', `wtx_rwshop_back_${grantId}`)!;
  assert.deepEqual(back, { amount: 3_000, note: SHOP_COUPON_BACK_NOTE, ref: `reward_shop_back:${grantId}`, type: 'deposit' });
  const notice = row<{ title_ar: string; body_en: string; meta: string; link: string }>(w.raw, 'SELECT title_ar, body_en, meta, link FROM user_notifications WHERE event_key = ?', `reward:shop_coupon_refund:${grantId}`)!;
  assert.ok(notice, 'one notice');
  assert.equal(notice.link, '/rewards/coupons');
  assert.match(notice.body_en, /The 3,000 points you paid for the free-delivery coupon are back in your balance\./);
  assert.match(JSON.parse(notice.meta).body_ckb, /3,000 خاڵەی بۆ کۆپۆنی گەیاندنی بەخۆڕایی دابووت گەڕێنرایەوە/);
  const audit = all<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'rewards.revoke' AND target = ?", grantId);
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].detail).points_returned, 3_000);

  // Pressed again, from an old tab: nothing more.
  const again = await json(await post(w.boss, `/api/admin/rewards/grants/${grantId}/revoke`, { reason: 'Issued by mistake' }));
  assert.equal(again.already, true);
  assert.equal(points(w.raw), 5_000);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM wallet_transactions WHERE ref = ?', `reward_shop_back:${grantId}`), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `reward:shop_coupon_refund:${grantId}`), 1);

  // The page names the movement in the reader's language.
  assert.equal(ledgerLabel(SHOP_COUPON_BACK_NOTE, 'ar'), 'نقاط كوبون سُحب من متجر النقاط');
  assert.equal(ledgerLabel(SHOP_COUPON_BACK_NOTE, 'en'), 'Points of a withdrawn points-shop coupon');
  assert.equal(ledgerLabel(SHOP_COUPON_BACK_NOTE, 'ckb'), 'خاڵی کۆپۆنێکی کشێنراوەی فرۆشگای خاڵ');
  assert.equal(ledgerLabel('Points shop refund: gift cancelled', 'en'), 'Points of a cancelled points-shop product', 'the gift keeps its own words');
});

test('R2: an expired shop coupon, a printer’s and a team’s coupon give nothing back when withdrawn (policy 14.10)', async () => {
  const w = shop();
  givePoints(w.raw, 5_000);
  const bought = await json(await post(w.buyer, '/api/rewards/program/shop/free_shipping'));
  const grantId = bought.coupon.id as string;
  w.raw.prepare('UPDATE coupons SET ends_at = ? WHERE reward_grant_id = ?').run(new Date(Date.now() - 60_000).toISOString(), grantId);
  const expired = await json(await post(w.boss, `/api/admin/rewards/grants/${grantId}/revoke`, { reason: 'Clearing an old one' }));
  assert.equal(expired.success, true, JSON.stringify(expired));
  assert.equal(expired.points_returned, 0, 'an expired coupon keeps its points spent');
  assert.equal(points(w.raw), 2_000);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `reward:shop_coupon_refund:${grantId}`), 0, 'and says nothing');

  const { orderId } = await printerOrder(w.raw, 1, new Date(Date.now() - 3_600_000).toISOString(), true);
  const printer = row<{ id: string }>(w.raw, "SELECT id FROM reward_grants WHERE order_id = ? AND kind = 'free_shipping'", orderId)!;
  const out = await json(await post(w.boss, `/api/admin/rewards/grants/${printer.id}/revoke`, { reason: 'Test withdrawal' }));
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.points_returned, 0);
  assert.equal(points(w.raw), 2_000);
});

test('R2: the withdraw dialog says the points go back before the press, and the words exist in three languages', () => {
  assert.equal(pointsBackOnWithdraw({ source: 'points_shop', state: 'active', points_spent: 3_000 }), 3_000);
  assert.equal(pointsBackOnWithdraw({ source: 'points_shop', state: 'expired', points_spent: 3_000 }), 0);
  assert.equal(pointsBackOnWithdraw({ source: 'printer', state: 'active', points_spent: 0 }), 0);
  assert.equal(pointsBackOnWithdraw({ source: 'admin', state: 'active', points_spent: 0 }), 0);
  const dialog = src('src/components/adminRewards/RewardsCoupons.tsx');
  assert.match(dialog, /const back = pointsBackOnWithdraw\(g\);/);
  assert.match(dialog, /تعود إلى الزبون \$\{formatFigure\(back, 'ar'\)\} نقطة دفعها مقابل هذا الكوبون، ويصله إشعار بذلك\./);
  assert.match(dialog, /The \$\{formatFigure\(back, 'en'\)\} points the customer paid for this coupon go back to them, with a notice\./);
  assert.match(dialog, /ئەو \$\{formatFigure\(back, 'ckb'\)\} خاڵەی کڕیار بۆ ئەم کۆپۆنە دای بۆی دەگەڕێتەوە/);
  for (const coupon of ['free_shipping', 'filament_discount'] as const) {
    const t = rewardText({ kind: 'shop_coupon_refund', coupon, points: 3_000 });
    own(t.title.ar, t.title.en, t.title.ckb, `${coupon} title`);
    own(t.body.ar, t.body.en, t.body.ckb, `${coupon} body`);
    assert.match(t.body.ar, /أعدنا إلى رصيدك 3,000 نقطة/);
  }
});

// ------------------------------------------------------------------ R3

test('R3: the minimum counts, and every text of the rule says so — «من … فأكثر», "of … or more", never above or over', async () => {
  const usual = rewardText({ kind: 'weekly_coupons', until: '2026-12-01', percent: 15, amount: 5_000, min: 100_000, pieces: 1, kinds: ['free_shipping', 'filament_discount'] }).body;
  assert.match(usual.ar, /للطلبات من 100,000 د\.ع فأكثر/);
  assert.match(usual.en, /on orders of 100,000 IQD or more/);
  assert.match(usual.ckb, /بۆ داواکارییەکانی 100,000 دینار و زیاتر/);
  const plain = (x: string) => x.replace(/\u00A0/g, ' ');
  assert.equal(plain(copyText('coupon.shipMin', 'ar', { money: '100,000 د.ع' })), 'للطلبات من 100,000 د.ع فأكثر');
  assert.equal(plain(copyText('coupon.shipMin', 'en', { money: '100,000 IQD' })), 'On orders of 100,000 IQD or more');
  assert.equal(plain(copyText('coupon.shipMin', 'ckb', { money: '100,000 د.ع' })), 'بۆ داواکارییەکانی 100,000 د.ع و زیاتر');
  assert.match(copyText('coupon.shipMin', 'ar', { money: 'X' }), /X\u00A0فأكثر/, 'the amount and «فأكثر» never part at a line end');
  for (const key of ['coupons.what.bothTerms', 'coupons.what.shipTerms'] as const) {
    const [ar, en, ckb] = COPY[key];
    assert.match(ar, /للطلبات من \{min\} فأكثر/, key);
    assert.match(en, /on orders of \{min\} or more/, key);
    assert.match(ckb, /بۆ داواکارییەکانی \{min\} و زیاتر/, key);
  }
  // Nowhere a customer or the team reads the rule does «فوق», over, above or «سەروو» stand for it.
  const files = [
    'src/components/rewards/copy.ts',
    'worker/lib/rewards/strings.ts',
    'src/components/adminRewards/AdminRewards.tsx',
    'src/components/adminRewards/RewardsCoupons.tsx',
    'src/components/rewards/CartCoupons.tsx',
  ];
  for (const file of files) {
    const code = src(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /للطلبات فوق|orders over|orders above|On orders over|سەرووی \{|داواکارییەکانی سەرووی/, file);
  }
  const admin = src('src/components/adminRewards/AdminRewards.tsx');
  assert.match(admin, /للطلبات من هذا المبلغ فأكثر \(د\.ع، بعد كل الخصومات\)/);
  assert.match(admin, /a \$\{amount\} delivery coupon on orders of \$\{min\} or more/);
  assert.match(src('src/components/adminRewards/RewardsCoupons.tsx'), /On orders of \$\{money\(g\.min_total_iqd\)\} or more/);
  // The policy, in its three languages.
  const { rewards } = await import('../worker/lib/policies/rewards');
  assert.match(rewards.body.ar, /5,000 د\.ع للطلبات من 100,000 د\.ع فأكثر\./);
  assert.match(rewards.body.en, /5,000 IQD on orders of 100,000 IQD or more\./);
  assert.match(rewards.body.ckb, /5,000 دینار بۆ داواکارییەکانی 100,000 دینار و زیاتر\./);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.doesNotMatch(rewards.body[lang], /فوق 100,000|over 100,000|سەرووی 100,000/, lang);
  // And the arithmetic is the inclusive one the words promise.
  assert.match(src('packages/pricing/src/coupons.ts'), /const min = dinars\(c\.min_total_iqd\);\s*if \(goodsAfter < min\)/, 'blocked only below it');
});

// ------------------------------------------------------------------ R2, R4: the policy

test('policy v8: 14.10 returns a withdrawn coupon’s points and 7.8 pays a refused printer review, in three languages', async () => {
  const { rewards } = await import('../worker/lib/policies/rewards');
  assert.equal(rewards.version, 8, 'the unpublished version 8, not a ninth');
  assert.match(rewards.body.ar, /### 14\.10 متى تعود النقاط المستبدلة\n.*وإذا سحب المتجر كوبوناً استُبدل بالنقاط قبل أن يُستعمل وقبل انتهاء صلاحيته عادت نقاطه إلى صاحبه مرة واحدة/);
  assert.match(rewards.body.en, /### 14\.10 When exchanged points return\n.*If the Store withdraws a coupon exchanged for points before it is used and before it expires, its points return to its holder once/);
  assert.match(rewards.body.ckb, /### 14\.10 کەی خاڵی گۆڕدراو دەگەڕێتەوە\n.*خاڵەکانی یەک جار بۆ خاوەنەکەی دەگەڕێنەوە/);
  // L6 (the lead, 2026-11-10): 7.8 cites article 7.5 alone. Citing 7.6 too, which is withheld until the owner sets
  // {{REVIEW_BASE_POINTS}}, took the whole of 7.8 off the published page; tests/rewardsPolicyPublished.test.ts reads that page.
  assert.match(rewards.body.ar, /فإن رفض المتجر هديتها مُنحت عند الرفض نقاط المراجعة التي تُمنح لأي مراجعة يدوية صحيحة وفق المادة 7\.5، مرة واحدة لا تتكرر\./);
  assert.match(rewards.body.en, /If the Store refuses its gift, it is granted, at the refusal, the review points any valid manual review is granted under article 7\.5, once only\./);
  assert.match(rewards.body.ckb, /ئەگەر فرۆشگا دیارییەکەی ڕەت بکاتەوە، لە کاتی ڕەتکردنەوەکەدا[^\n]*بەپێی ماددەی 7\.5، تەنها یەک جار\./);
  // L2 (the lead, 2026-11-09): approved after a refusal, the review keeps those points and gets its code — the same article.
  assert.match(rewards.body.ar, /### 7\.8 [^\n]*\n[^\n]*مرة واحدة لا تتكرر\. وإن وافق المتجر على هديتها بعد رفضها بقيت لها تلك النقاط وأخذت كودها أيضاً، فلا يُسترد منها شيء ولا تُدفع النقاط مرة ثانية\.\n/);
  assert.match(rewards.body.en, /### 7\.8 [^\n]*\n[^\n]*once only\. If the Store approves its gift after refusing it, the review keeps those points and also receives its code: nothing is taken back, and the points are not paid a second time\.\n/);
  assert.match(rewards.body.ckb, /### 7\.8 [^\n]*\n[^\n]*تەنها یەک جار\. ئەگەر فرۆشگا دوای ڕەتکردنەوەکە دیارییەکەی پەسەند بکات، ئەو خاڵانە بۆ پێداچوونەوەکە دەمێننەوە و کۆدەکەشی وەردەگرێت: هیچیان لێ وەرناگیرێتەوە و دوو جار نادرێن\.\n/);
  // R4 on the team's screen: the refusal dialog says the review then earns its usual points.
  const queue = src('src/components/AdminReviews.tsx');
  assert.match(queue, /const description = action === 'reject' && row\.kind === 'printer_gift' \? S\.rejectRewardPoints : undefined;/);
  for (const words of [/rejectRewardPoints: 'يُعرض السبب للزبون\./, /rejectRewardPoints: 'The customer sees the reason\./, /rejectRewardPoints: 'کڕیار هۆکارەکە دەبینێت\./]) assert.match(queue, words);
});

// ------------------------------------------------------------------ the gift's value

const RESOLVED = { regular_iqd: ESUN_BEFORE_OFFER_IQD, applied_iqd: ESUN_BEFORE_OFFER_IQD, unit_subtotal_iqd: ESUN_BEFORE_OFFER_IQD, errors: [] } as unknown as ResolvedPrice;
const offer = (over: Record<string, unknown> = {}): OfferView =>
  ({ window: { id: 'ofw', active: true, starts_at: null, ends_at: null, required_tiers: [], locked_preview: false, offer_price_mode: 'fixed', offer_price_iqd: ESUN_UNIT_IQD, ...over }, limits: null }) as unknown as OfferView;

test('a gift is worth what a customer pays for it today: the sale price under a live public offer, else the regular price', () => {
  assert.equal(giftShelfUnitIqd(RESOLVED, null, null), ESUN_BEFORE_OFFER_IQD, 'no offer: the regular price');
  assert.equal(giftShelfUnitIqd(RESOLVED, offer(), null), ESUN_UNIT_IQD, 'eSUN PLA+: 24,000, not the struck 27,250');
  assert.equal(giftShelfUnitIqd(RESOLVED, offer({ ends_at: '2020-01-01T00:00:00.000Z' }), null), ESUN_BEFORE_OFFER_IQD, 'an ended offer is no price');
  assert.equal(giftShelfUnitIqd(RESOLVED, offer({ required_tiers: ['pro'] }), null), ESUN_BEFORE_OFFER_IQD, 'a members’ offer is not the shelf price');
  assert.equal(giftShelfUnitIqd(RESOLVED, offer({ active: false }), null), ESUN_BEFORE_OFFER_IQD);
  // The three doors read it: the grant's snapshot, the cart's line and the checkout's line.
  assert.match(src('worker/lib/gifts/selection.ts'), /giftShelfUnitIqd\(resolved, p\.offer, doc\)/);
  assert.match(src('worker/routes/cart.ts'), /giftUnitValueOf\(doc\.sku_strict === true, giftShelfUnitIqd\(facts\.resolved, input\.offer, doc\)/);
  assert.match(src('worker/routes/orders.ts'), /giftUnitValueOf\(v2Gift, giftShelfUnitIqd\(facts\.resolved, giftOffers\.get\(offerKey\(subjectOf\(String\(row\.id\)\)\)\) \?\? null, facts\.doc\)/);
});

test('the eSUN gift a customer swaps points for reads 24,000 on «هداياي», in the cart and in the quote, and costs nothing', async () => {
  const w = shop();
  givePoints(w.raw, 30_000);
  const swapped = await json(await post(w.buyer, '/api/rewards/program/shop/items/esun_black'));
  assert.equal(swapped.success, true, JSON.stringify(swapped));
  const gifts = await json(await get(w.buyer, '/api/gifts'));
  const g = (gifts.gifts as J[]).find((x) => x.id === swapped.gift.id)!;
  assert.equal(g.chosen.value_iqd, ESUN_UNIT_IQD, '«هداياي»: the snapshot of the swap');
  assert.equal((await post(w.buyer, '/api/cart/gift-items', { giftId: g.id })).status, 200);
  const cart = await json(await get(w.buyer, '/api/cart'));
  const line = (cart.items as J[]).find((i) => i.kind === 'gift')!;
  assert.equal(line.gift.value_iqd, ESUN_UNIT_IQD, 'the cart line');
  assert.equal(line.unit_price_iqd, 0, 'never charged');
});

test('10 Nov: the missions the browser counts carry the owner’s chip, «يعتمد على متصفحك», in three languages', () => {
  const page = src('src/pages/Rewards.tsx');
  const ar = 'يعتمد على متصفحك', en = 'Relies on your browser', ckb = 'پشت بە وێبگەڕەکەت دەبەستێت';
  own(ar, en, ckb, 'the chip on a mission the browser counts');
  assert.ok(page.includes(`{loc('${ar}', '${en}', '${ckb}')}`), 'the chip reads the owner’s words');
  assert.ok(!page.includes("loc('غير مُتحقَّق منه'") && !page.includes("'Not verifiable',"), 'the old chip words are gone from the screen');
  // The notifications, ad and browsing missions all still carry it (policy 5.8: the customer is told on the page).
  assert.equal((page.match(/<UnverifiedTag /g) ?? []).length, 3, 'three missions carry the chip');
});
