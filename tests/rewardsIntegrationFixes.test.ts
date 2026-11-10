/**
 * WHAT THE INTEGRATION RUN OF THE MERGED REWARDS BUILD FOUND (lanes A/B, C and D together, on one real stack), each
 * held here so it cannot return. Pure helpers are read in three languages; the screens by their source, as
 * tests/couponPoolUi.test.ts does; the money and the routes through the real routers. The frame findings
 * (the six tabs at 390 px, the coupons page's document height) were measured in a real browser too, and the CSS is
 * held by tests/bundleBudget.test.ts, whose gate this run brought back under.
 *
 * Run: node --import tsx --test tests/rewardsIntegrationFixes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, stubApp } from './fixtures/app';
import { orderPillLabel, orderStatusLabel, STATUS_LABELS } from '../src/components/orders/format';
import { historyDate, ledgerLabel, secondsLeftText, secondsText, streakText } from '../src/components/points/words';
import { isolateLatin, pickName, pickTri } from '../src/components/rewards/model';
import { COPY, copyText } from '../src/components/rewards/copy';
import { reviewFactWord, REVIEW_FACT_WORDS } from '../src/components/adminReviews/reviewGiftStrings';
import { adminText } from '../src/components/adminGifts/strings';
import { GIFTS_ACCENT } from '../src/components/adminGifts/ui';
import { baghdadDay, entryStateWords } from '../src/components/adminRewards/AdminCompetitions';
import { currencyValue, splitMoney } from '../src/CurrencyContext';
import { calculateCodTaxIqd } from '../packages/shipping/src/codTax';
import { rewardText } from '../worker/lib/rewards/strings';
import { evaluateReviewQuality } from '../worker/lib/reviewQuality';
import { renderInvoiceHtmlDocument, type InvoiceEmailData } from '../worker/lib/emailTemplates';
import { createInvoiceForOrder } from '../worker/lib/invoices';
import { invoiceRoutes } from '../worker/routes/invoices';
import type { Env } from '../worker/lib/types';

const src = (file: string) => readFileSync(file, 'utf8');
const LANGS = ['ar', 'en', 'ckb'] as const;
const noop = () => {};
/** A Sorani sentence is its own: no copy of the Arabic or the English, no Arabic-only letter (DECISIONS row 183). */
const soraniOwn = (ar: string, en: string, ckb: string) => {
  assert.ok(ckb, `empty Sorani beside «${ar}»`);
  assert.notEqual(ckb, ar);
  assert.notEqual(ckb, en);
  assert.doesNotMatch(ckb, /[ةىيك]/, `an Arabic-only letter in «${ckb}»`);
};

// ------------------------------------------------------------------ the frames

test('ADMIN → المكافآت: six tabs wrap in rows at a phone’s width, none cut, each 44 px, and the stylesheet pays nothing for it', () => {
  const screen = src('src/components/adminRewards/AdminRewards.tsx');
  assert.doesNotMatch(screen, /min-w-\[25rem\]|overflow-x-auto py-1|\[&_\[role=radio\]\]:px-0\.5/, 'the strip 400 px wide in a 366 px box');
  assert.match(screen, /gridTemplateColumns: 'repeat\(auto-fit, minmax\(6\.5rem, 1fr\)\)'/);
  const strip = screen.slice(screen.indexOf('<Segmented'), screen.indexOf('<RewardsOverview'));
  assert.doesNotMatch(strip, /size="sm"/, 'the default size is the one with 44 px options');
  const seg = src('src/components/ui/Segmented.tsx');
  assert.match(seg, /minmax\(0, 1fr\)\)`, \.\.\.style \}\}/, 'the equal columns stay the default, an option overrides them');
  assert.match(seg, /'min-h-11 text-\[13px\]'/);
});

test('/rewards/coupons: nothing absolutely placed reaches past the page’s scroller, so the document stays one screen tall', () => {
  // A `sr-only` span is position:absolute: without a positioned ancestor it hung off the document at its own offset, 3133 px down.
  assert.match(src('src/pages/RewardsArea.tsx'), /data-rewards-scroll className="relative flex-1 min-h-0 overflow-y-auto/);
  const coupons = src('src/components/rewards/CouponsScreen.tsx');
  assert.match(coupons, /<div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">\s*<code dir="ltr"/);
});

test('/rewards/rate and the printers block print the whole name, and the chip has its own line', () => {
  const rate = src('src/components/rewards/RateScreen.tsx');
  assert.doesNotMatch(rate, /line-clamp/, 'a printer’s name beside its chip lost its end');
  assert.match(rate, /<div className="flex flex-col items-start gap-1\.5">\s*<h2 id="rate-next-title"/, 'the focal card: the chip under the name');
  assert.doesNotMatch(src('src/components/rewards/PrintersBlock.tsx'), /line-clamp/);
});

test('/points keeps its header, and the mascot on it, above the page: it never sits over a mission', () => {
  const page = src('src/pages/Rewards.tsx');
  assert.match(page, /sticky top-0 z-20 bg-canvas border-b border-border-subtle/);
  assert.doesNotMatch(page, /sticky top-0 z-10 relative/, '`relative` beat `sticky`, so the header left and its mascot stayed');
});

// ------------------------------------------------------------------ a cancelled order

test('a cancelled order’s pill is the status, in three languages, whatever stage its path stopped at', () => {
  const stopped = [{ label: 'تم استلام الطلب', current: true }, { label: 'تم تأكيد الطلب', current: false }];
  for (const lang of LANGS) {
    assert.equal(orderPillLabel(lang, { status: 'cancelled' }, stopped), STATUS_LABELS[lang].cancelled);
    assert.equal(orderPillLabel(lang, { status: 'pending', total_iqd: 100, due_on_delivery_iqd: 100 }, stopped), 'تم استلام الطلب', 'a live order keeps the server’s stage');
    assert.equal(orderPillLabel(lang, { status: 'shipped' }, null), orderStatusLabel(lang, { status: 'shipped' }), 'no path yet: the legacy label');
  }
  assert.equal(orderPillLabel('ar', null, null), '');
  const page = src('src/pages/OrderDetail.tsx');
  assert.match(page, /const pillLabel = orderPillLabel\(lang, order, tracking\?\.steps\);/);
  assert.match(page, /order\.status === 'cancelled' \? \(\s*<p data-order-cancelled[\s\S]{0,160}s\.cancelledNotice[\s\S]{0,120}<OrderTracker/, 'the cancellation instead of a path');
  const card = src('src/components/orders/OrderCard.tsx');
  assert.match(card, /trackingOpen && order\.status !== 'cancelled' && <OrderTracker/);
  assert.match(card, /order\.status !== 'cancelled' && \(\s*<button\s+type="button"\s+data-track-order/);
});

const invoice = (over: Partial<InvoiceEmailData> = {}): InvoiceEmailData => ({
  invoice_no: 'INV-2026-X',
  order_id: 'ORD-X',
  revision: 1,
  issued_at: '2026-11-06T10:00:00.000Z',
  customer_name: 'Sara',
  lines: [],
  subtotal_iqd: 24_000,
  delivery_fee_iqd: 5_000,
  cod_tax_iqd: 0,
  cod_tax_before_exemption_iqd: 0,
  cod_tax_exemption_iqd: 0,
  membership_discount_iqd: 0,
  membership_tier: 'none',
  delivery_waived: false,
  coupon_discount_iqd: 0,
  points_applied_iqd: 0,
  price_adjustment_iqd: 0,
  wallet_applied_iqd: 29_000,
  total_iqd: 29_000,
  amount_paid_iqd: 29_000,
  amount_due_iqd: 0,
  payment_status: 'paid',
  ...over,
} as InvoiceEmailData);

test('the printable invoice of a cancelled order says so in three languages, what came back, and that nothing is due', () => {
  const words = {
    ar: ['أُلغي هذا الطلب، ولا يُطلب بهذه الفاتورة أي مبلغ.', 'ملغية', 'أُعيد إلى محفظتك', 'نقاط أُعيدت إليك', 'مدفوعة بالكامل'],
    en: ['This order was cancelled. Nothing is due on this invoice.', 'Cancelled', 'Returned to your wallet', 'Points returned to you', 'Paid in full'],
    ckb: ['ئەم داواکارییە هەڵوەشێنرایەوە، و هیچ بڕێک بەم پسوولەیە داوا ناکرێت.', 'هەڵوەشێنراوەتەوە', 'گەڕێنرایەوە بۆ جزدانەکەت', 'خاڵی گەڕێنراوە بۆت', ''],
  } as const;
  for (const lang of LANGS) {
    const [banner, status, wallet, points, paidInFull] = words[lang];
    const live = renderInvoiceHtmlDocument(lang, invoice());
    assert.ok(!live.includes(banner), 'an order that stands is unchanged');
    assert.ok(!live.includes('data-invoice-cancelled'));
    const doc = renderInvoiceHtmlDocument(lang, invoice({ amount_due_iqd: 7_000, payment_status: 'partial' }), { refunded_wallet_iqd: 29_000, refunded_points: 1_250 });
    assert.ok(doc.includes(banner), lang);
    assert.ok(doc.includes(`: ${status}</p>`), `${lang}: the status line`);
    assert.ok(doc.includes(wallet), lang);
    assert.ok(doc.includes(points), lang);
    assert.ok(doc.includes('1,250'), lang);
    // The stylesheet names both classes; the row that says what is due is the one that must be clear.
    assert.doesNotMatch(doc, /<tr class="due-open">/, 'nothing is due on a cancelled order, even one that was to be paid at the door');
    assert.match(doc, /<tr class="due-clear">/);
    if (paidInFull) assert.ok(!renderInvoiceHtmlDocument(lang, invoice(), { refunded_wallet_iqd: 0, refunded_points: 0 }).includes(paidInFull), `${lang}: the sentence that was no longer true`);
  }
  soraniOwn(words.ar[0], words.en[0], words.ckb[0]);
});

function cancellableOrder(raw: DatabaseSync): string {
  raw.exec('PRAGMA foreign_keys = OFF;');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,locale) VALUES ('u_1','Sara','s@x.co','h','customer','ar');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,wallet_applied_iqd,due_on_delivery_iqd)
      VALUES ('ORD-INV','u_1','pending','{}','dm','{}','wallet',29000,1400,29000,29000,0);
  `);
  return 'ORD-INV';
}

test('GET /api/invoices/:id/html reads the order’s state and the ledger’s refund rows, and never rewrites what was issued', async () => {
  const raw = freshDb();
  const orderId = cancellableOrder(raw);
  const made = await createInvoiceForOrder({ DB: asD1(raw) } as unknown as Env, orderId);
  assert.ok(made);
  const issued = raw.prepare('SELECT snapshot FROM invoices WHERE id = ?').get(made.invoiceId) as { snapshot: string };
  const app = stubApp(asD1(raw), { id: 'u_1', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/invoices', invoiceRoutes));
  const html = async (lang: string) => (await get(app, `/api/invoices/${made.invoiceId}/html?lang=${lang}`)).text();

  assert.ok(!(await html('en')).includes('data-invoice-cancelled'), 'while the order stands');
  raw.exec(`
    UPDATE orders SET status = 'cancelled' WHERE id = '${orderId}';
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,amount_iqd) VALUES ('wtx_refund_${orderId}_usd','u_1','deposit','USD',2071,'approved','Refund for cancelled order','${orderId}',29000);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref) VALUES ('wtx_refund_${orderId}_pts','u_1','deposit','POINT',1250,'approved','Points refund for cancelled order','${orderId}');
  `);
  const en = await html('en');
  assert.ok(en.includes('This order was cancelled.'));
  assert.match(en, /Returned to your wallet<\/th><td[^>]*>29,000/);
  assert.match(en, /Points returned to you<\/th><td[^>]*>1,250/);
  assert.ok(!en.includes('Paid in full'));
  assert.ok((await html('ar')).includes('أُلغي هذا الطلب'));
  assert.ok((await html('ckb')).includes('ئەم داواکارییە هەڵوەشێنرایەوە'));
  assert.equal((raw.prepare('SELECT snapshot FROM invoices WHERE id = ?').get(made.invoiceId) as { snapshot: string }).snapshot, issued.snapshot);

  // A cancel that moved no money still says it was cancelled, and names no refund.
  raw.exec(`DELETE FROM wallet_transactions WHERE ref = '${orderId}'`);
  const none = await html('en');
  assert.ok(none.includes('This order was cancelled.'));
  assert.ok(!none.includes('Returned to your wallet'));
});

// ------------------------------------------------------------------ /points

test('every movement of the points history reads in the reader’s language, those the checkout and the cancel write among them', () => {
  const table: ReadonlyArray<readonly [string, string, string, string]> = [
    ['Points used on order ORD-1', 'نقاط استُخدمت في طلب', 'Points used on an order', 'خاڵ لە داواکارییەکدا بەکارهات'],
    ['Points refund for cancelled order ORD-1', 'نقاط عادت من طلب أُلغي', 'Points back from a cancelled order', 'خاڵ لە داواکارییەکی هەڵوەشاوە گەڕایەوە'],
    ['Purchase points released for order ORD-1', 'نقاط الشراء', 'Purchase points', 'خاڵی کڕین'],
    ['Points reversal for order ORD-1: returned', 'نقاط طلب أُلغي أو أُرجع', 'Points of a cancelled or returned order', 'خاڵی داواکارییەکی هەڵوەشاوە یان گەڕێنراوە'],
    ['Points shop product: eSUN', 'منتج من متجر النقاط', 'A product from the points shop', 'بەرهەمێک لە فرۆشگای خاڵ'],
    ['Points shop refund: gift cancelled', 'نقاط منتج أُلغي من متجر النقاط', 'Points of a cancelled points-shop product', 'خاڵی بەرهەمێکی هەڵوەشاوەی فرۆشگای خاڵ'],
    ['Points shop: delivery coupon', 'كوبون من متجر النقاط', 'A coupon from the points shop', 'کۆپۆنێک لە فرۆشگای خاڵ'],
  ];
  for (const [note, ar, en, ckb] of table) {
    assert.equal(ledgerLabel(note, 'ar'), ar);
    assert.equal(ledgerLabel(note, 'en'), en);
    assert.equal(ledgerLabel(note, 'ckb'), ckb);
    soraniOwn(ar, en, ckb);
  }
  assert.equal(ledgerLabel('Something new the server wrote', 'ar'), 'Something new the server wrote', 'a record nobody named keeps its words');
  // The notes the two writers really write.
  assert.match(src('worker/routes/orders.ts'), /`Points used on order \$\{orderId\}`/);
  assert.match(src('worker/lib/orderCancelOps.ts'), /`Points refund for cancelled order \$\{id\}`/);
});

test('a history line’s date has one form per language: never a raw 2026-11-06, an Arabic-Indic year or an Arabic month on a Sorani page', () => {
  const dated = { day: '2026-11-06', awarded_at: '2026-11-06T21:30:00.000Z' };
  const instant = { day: 'once', awarded_at: '2027-01-12T09:00:00.000Z' };
  assert.equal(historyDate(dated, 'ckb'), '6ی تشرینی دووەم 2026');
  assert.equal(historyDate(instant, 'ckb'), '12ی کانوونی دووەم 2027');
  assert.doesNotMatch(historyDate(dated, 'ar'), /[٠-٩]/, 'Latin digits, as every other figure of the page');
  assert.match(historyDate(dated, 'ar'), /^6 .* 2026$/);
  assert.match(historyDate(dated, 'en'), /^6 Nov 2026$/);
  assert.equal(historyDate({ day: 'once', awarded_at: null }, 'en'), '', 'the word «once» is never printed');
  const page = src('src/pages/Rewards.tsx');
  assert.match(page, /\{historyDate\(h, lang\)\}/);
  assert.match(page, /\{formatFigure\(h\.points, lang\)\} \{loc\('نقطة', 'pts', 'خاڵ'\)\}/, '23,000, not 23000');
  assert.doesNotMatch(page, /'ckb-IQ'/, 'Chromium has no Sorani locale data');
});

test('Arabic counts agree with their nouns', () => {
  assert.deepEqual([1, 2, 3, 4, 10, 11, 45, 100].map((n) => secondsText(n, 'ar')), ['ثانية واحدة', 'ثانيتان', '3 ثوانٍ', '4 ثوانٍ', '10 ثوانٍ', '11 ثانية', '45 ثانية', '100 ثانية']);
  assert.equal(secondsLeftText(4), 'تبقّت 4 ثوانٍ');
  assert.doesNotMatch(src('src/components/points/AdWatchModal.tsx'), /متبقٍ \$\{secondsLeft\} ثانية/);
  assert.deepEqual([0, 1, 2, 3, 10, 11, 100].map((n) => streakText(n, 'ar')), [
    'لا أيام متتالية بعد',
    'سجّلت دخولك يومًا واحدًا',
    'سجّلت دخولك يومين متتاليين',
    'سجّلت دخولك 3 أيام متتالية',
    'سجّلت دخولك 10 أيام متتالية',
    'سجّلت دخولك 11 يومًا متتاليًا',
    'سجّلت دخولك 100 يوم متتالٍ',
  ]);
  assert.equal(streakText(1, 'en'), "You've checked in for 1 day");
  assert.equal(streakText(4, 'en'), "You've checked in for 4 days");
  assert.equal(streakText(0, 'en'), 'No check-in streak yet');
  assert.equal(streakText(4, 'ckb'), '4 ڕۆژی یەک لە دوای یەک ئامادە بوویت');
  soraniOwn(streakText(0, 'ar'), streakText(0, 'en'), streakText(0, 'ckb'));
  // One level is not «the levels up to 1».
  const [ar, en, ckb] = COPY['now.giftUpTo.one'];
  assert.doesNotMatch(ar, /حتى/);
  soraniOwn(ar, en, ckb);
  assert.match(src('src/components/rewards/HubScreen.tsx'), /p\.reward_level === 1 \? 'now\.giftUpTo\.one' : 'now\.giftUpTo\.body'/);
  assert.match(src('src/components/rewards/RateScreen.tsx'), /scope === 'up_to' && level > 1 \? 'rate\.upTo' : 'rate\.approved'/);
  // The owner's list: agreement, or a label with no noun to agree.
  const admin = src('src/components/adminRewards/AdminCompetitions.tsx');
  assert.doesNotMatch(admin, /نقطة اشتراك|\$\{c\.entries_count\} مشارك/);
  assert.match(admin, /countText\('entrants', c\.entries_count/);
});

// ------------------------------------------------------------------ one product, one name

test('one product has one name, option and colour on every screen: English, as the product page and the cart print them (mandate §3, §7)', () => {
  const esun = { ar: 'فلمنت eSUN PLA+ — 1 كغم', en: 'eSUN PLA+ Filament — 1 kg', ckb: 'فیلامێنتی eSUN PLA+ — 1 کگ' };
  assert.equal(pickName(esun), 'eSUN PLA+ Filament — 1 kg');
  assert.equal(pickName({ ar: 'بيج', en: '', ckb: 'بێژ' }), 'بيج', 'a row saved before the rule keeps what it has');
  assert.equal(pickName(null), '');
  assert.equal(pickTri(esun, 'ar'), esun.ar, 'what the owner writes in three languages stays his');
  for (const file of ['CouponsScreen', 'HubScreen', 'PrintersBlock', 'RateScreen', 'ShopProducts', 'couponUse', 'GiftReveal']) {
    const code = src(`src/components/rewards/${file}.tsx`);
    assert.doesNotMatch(code, /tri\((p|c\.printer|item\.product|data\.review|pickedItem)\.(name|color|option)\)|tri\(item\.product\.(color|option)\)/, `${file} still chooses a name by language`);
  }
  const card = src('src/components/reviews/gifts/GiftCard.tsx');
  assert.match(card, /const variant = productWord\(item\.variant\);/);
  assert.match(card, /const color = productWord\(item\.color\);/);
  const adminRow = src('src/components/adminGifts/ui.tsx');
  assert.doesNotMatch(adminRow, /triOf\(lang, item\.(variant|color)\)/);
  assert.match(src('src/components/AdminReviews.tsx'), /p\.name \|\| p\.name_ar \|\| '—'/);
  assert.doesNotMatch(src('src/components/adminProducts/form/ProductPicker.tsx'), /p\.name_ar \|\| p\.name_en : p\.name_en/);
});

test('the owner’s titles keep «PLA+» together in an Arabic line', () => {
  const LRI = '⁦';
  const PDI = '⁩';
  assert.equal(isolateLatin('مسابقة بكرة فلمنت eSUN PLA+'), `مسابقة بكرة فلمنت ${LRI}eSUN PLA+${PDI}`, 'the plus stays with its name');
  assert.equal(isolateLatin('فلمنت eSUN PLA+ — 1 كغم'), `فلمنت ${LRI}eSUN PLA+${PDI} — ${LRI}1${PDI} كغم`, 'the weight beside its unit, not beside «فلمنت»');
  assert.equal(isolateLatin('500 نقطة للأول'), `${LRI}500${PDI} نقطة للأول`);
  assert.equal(isolateLatin('Win a spool of eSUN PLA+'), 'Win a spool of eSUN PLA+', 'an English line needs nothing');
  assert.equal(isolateLatin('أجمل طبعة هذا الشهر'), 'أجمل طبعة هذا الشهر');
  for (const [file, drawn] of [
    ['rewards/HubScreen', /isolateLatin\(title\)/],
    ['rewards/CompetitionsScreen', /isolateLatin\(tri\(c\.title\)/],
    ['rewards/CompetitionScreen', /isolateLatin\(tri\(c\.title\)/],
    ['rewards/CompetitionScreen', /isolateLatin\(words\)/],
    ['rewards/CompetitionScreen', /isolateLatin\(prizeWords\)/],
    ['rewards/EntrySheet', /isolateLatin\(tri\(c\.title\)\)/],
    ['adminRewards/AdminCompetitions', /isolateLatin\(c\.title\[l\]/],
  ] as const) assert.match(src(`src/components/${file}.tsx`), drawn, file);
  // Not BidiText here: a new importer splits the chunk it rides in, and tests/motionLazy.test.ts counts the pieces.
  for (const file of ['rewards/HubScreen', 'rewards/CompetitionScreen', 'adminRewards/AdminCompetitions']) {
    assert.doesNotMatch(src(`src/components/${file}.tsx`), /ui\/BidiText|lib\/bidi/, file);
  }
});

test('a delivery card’s money never parts from its unit at a line end', () => {
  assert.match(src('src/components/rewards/couponUse.tsx'), /const whole = \(iqd: number\) => money\(iqd\)\.replace\(\/ \/g, '\\u00A0'\);/);
});

// ------------------------------------------------------------------ money on screen

test('the cart says what cash at the door adds, at the owner’s rate: the 50-piece order is 6,000 under its checkout total no more', () => {
  const rate = { blockIqd: 500_000, perBlockIqd: 3_000 };
  assert.equal(calculateCodTaxIqd(1_190_600, rate), 6_000);
  assert.equal(1_190_600 + calculateCodTaxIqd(1_190_600, rate), 1_196_600, 'the walk’s own checkout total');
  assert.equal(calculateCodTaxIqd(499_999, rate), 0, 'nothing to say under one block');
  const cart = src('src/pages/Cart.tsx');
  assert.match(cart, /activeMembership\?\.cod_tax_exempt \? 0 : calculateCodTaxIqd\(total, \{ blockIqd: settings\?\.codTaxBlockIqd, perBlockIqd: settings\?\.codTaxPerBlockIqd \}\)/);
  assert.match(cart, /data-cart-cod-tax/);
  assert.match(cart, /عند الدفع نقدًا عند الاستلام تُضاف ضريبة شركة التوصيل/);
  assert.match(cart, /Paying cash on delivery adds the delivery company tax/);
  assert.match(cart, /ئەگەر لە کاتی گەیاندن بە کاش پارە بدەیت، باجی پارەدان لە کاتی گەیاندن زیاد دەکرێت/);
});

test('English reads IQD, Arabic and Sorani د.ع, through the one door every customer figure takes', () => {
  const en = currencyValue('IQD', noop, null, true, 'en');
  assert.equal(en.money(5_000), '5,000 IQD');
  assert.equal(en.moneyBoth(1_750_000), '1,750,000 IQD');
  assert.equal(en.walletMoney(12_000), '12,000 IQD');
  assert.equal(en.walletCharge(12_000), '12,000 IQD');
  assert.deepEqual(splitMoney(en.money(5_000)), ['5,000', 'IQD']);
  for (const lang of ['ar', 'ckb']) assert.match(currencyValue('IQD', noop, null, true, lang).money(5_000), /^5,000 د\.ع$|^٥٬٠٠٠ د\.ع$/);
  assert.match(currencyValue('IQD', noop, null).money(5_000), /د\.ع$/, 'unasked, as before');
  const ctx = src('src/CurrencyContext.tsx');
  assert.match(ctx, /currencyValue\(currency, setCurrency, rate, settingsLoaded, lang\)/);
  assert.match(ctx, /const lang = useOptionalLanguage\(\);/, 'a shared provider, never a throw above the language');
  assert.doesNotMatch(src('src/pages/Checkout.tsx'), /It is \$\{formatIqd\(/);
});

// ------------------------------------------------------------------ the admin's screens

test('an admin’s competition window reads in Baghdad days, whatever the device', () => {
  assert.equal(baghdadDay('2026-12-11T21:00:00.000Z'), '2026-12-12', 'midnight in Baghdad is the 12th, though it is still the 11th in UTC');
  assert.equal(baghdadDay('2026-12-14T20:59:59.000Z'), '2026-12-14');
  assert.equal(baghdadDay('not a date'), '');
  assert.doesNotMatch(src('src/components/adminRewards/AdminCompetitions.tsx'), /starts_at\.slice\(0, 10\)/);
});

test('entry states and review reasons are words, in three languages; the keys stay the server’s', () => {
  const loc = (lang: 0 | 1 | 2) => (ar: string, en: string, ckb: string) => [ar, en, ckb][lang];
  for (const state of ['entered', 'winner', 'refunded', 'disqualified']) {
    const [ar, en, ckb] = [entryStateWords(state, loc(0)), entryStateWords(state, loc(1)), entryStateWords(state, loc(2))];
    assert.notEqual(ar, state);
    assert.notEqual(en, state);
    soraniOwn(ar, en, ckb);
  }
  assert.equal(entryStateWords('newer', loc(0)), 'newer');
  // Every key the scorer can write is worded: run it on what makes it write them, and read the rest from its source.
  const scorer = src('worker/lib/reviewQuality.ts');
  const keys = [...scorer.matchAll(/(?:reasons|suspiciousSignals)\.push\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15, `found ${keys.length}`);
  for (const key of keys) {
    const row = REVIEW_FACT_WORDS[key];
    assert.ok(row, `no words for ${key}`);
    assert.equal(reviewFactWord('ar', key), row[0]);
    assert.equal(reviewFactWord('en', key), row[1]);
    assert.equal(reviewFactWord('ckb', key), row[2]);
    soraniOwn(row[0], row[1], row[2]);
  }
  assert.equal(reviewFactWord('ar', 'a_new_key'), 'a_new_key');
  assert.ok(evaluateReviewQuality, 'the scorer these keys come from');
  const queue = src('src/components/AdminReviews.tsx');
  assert.match(queue, /row\.quality\.reasons\.map\(\(r\) => reviewFactWord\(lang, r\)\)/);
  assert.match(queue, /row\.quality\.suspiciousSignals\.map\(\(r\) => reviewFactWord\(lang, r\)\)/);
  assert.match(queue, /formatDate\(row\.created_at, lang\)/);
});

test('no owner action opens the browser’s own prompt: the reason has a label, a required check and the error beside it', () => {
  for (const file of ['src/components/adminRewards/AdminCompetitions.tsx', 'src/components/AdminReviews.tsx']) {
    const code = src(file);
    assert.doesNotMatch(code, /window\.prompt/, file);
    assert.match(code, /usePrompt\(\)/, file);
    assert.match(code, /\{promptDialog\}/, file);
    assert.match(code, /required: true/, file);
  }
  assert.equal(src('src/components/adminRewards/AdminCompetitions.tsx').match(/\{promptDialog\}/g)?.length, 2, 'the list and the judging panel each draw their own');
});

test('ADMIN → الهدايا words a duplicate in the reader’s language, and speaks the shop’s colours', () => {
  const words = LANGS.map((l) => adminText(l, 'itemDuplicate'));
  assert.ok(words.every(Boolean));
  soraniOwn(words[0], words[1], words[2]);
  soraniOwn(adminText('ar', 'itemLegacy'), adminText('en', 'itemLegacy'), adminText('ckb', 'itemLegacy'));
  const panel = src('src/components/adminGifts/LevelsPanel.tsx');
  assert.match(panel, /code === 'GIFT_ITEM_DUPLICATE' \? t\('itemDuplicate'\)/);
  // One door for the section's accent: the primary button, the switch and the chosen chips read these names.
  const accent = GIFTS_ACCENT as Record<string, string>;
  assert.equal(accent['--color-iris'], 'var(--color-primary-fill)');
  assert.equal(accent['--color-snow'], 'var(--color-canvas)', 'the ink lv-button-primary prints on that fill, in both themes');
  for (const file of ['AdminGifts', 'GrantDetail', 'GrantSheet', 'LevelsPanel']) {
    assert.match(src(`src/components/adminGifts/${file}.tsx`), /style=\{GIFTS_ACCENT\}/, `${file}: a sheet is portalled out of the panel, so each root says it`);
  }
  assert.match(src('src/components/adminProducts/form/formUi.tsx'), /enabled:bg-iris enabled:hover:bg-iris-deep enabled:text-snow/, 'the names this re-points');
});

test('the overview names its ceiling for what it is, in three languages', () => {
  const screen = src('src/components/adminRewards/RewardsOverview.tsx');
  assert.match(screen, /سقف الإعدادات/);
  assert.match(screen, /the ceiling of the settings/);
  assert.match(screen, /سنووری ڕێکخستنەکان/);
  assert.doesNotMatch(screen, /أقصى ما تخصمه كوبونات أسبوع/);
});

// ------------------------------------------------------------------ what the customer is told

test('a winner’s notice names the prize in the owner’s words, and how a prize in kind arrives', () => {
  const title = { ar: 'مسابقة', en: 'Contest', ckb: 'پێشبڕکێ' };
  const prize = { ar: 'بكرة فلمنت', en: 'One spool', ckb: 'قرقرەیەک فیلامێنت' };
  const won = rewardText({ kind: 'competition_won', title, place: 1, points: 0, prize });
  assert.match(won.body.ar, /حللت في المركز 1\. جائزة المسابقة: بكرة فلمنت\. تُسلَّم الجوائز العينية كما يعلن المتجر\. شكرًا لمشاركتك!/);
  assert.match(won.body.en, /You placed 1\. The prize: One spool\. Prizes in kind are handed over as the shop announces\. Thank you for taking part!/);
  assert.match(won.body.ckb, /خەڵاتی پێشبڕکێکە: قرقرەیەک فیلامێنت\. خەڵاتە کاڵاییەکان/);
  for (const words of [undefined, { ar: '', en: '', ckb: '' }]) {
    const plain = rewardText({ kind: 'competition_won', title, place: 2, points: 500, prize: words });
    assert.equal(plain.body.ar, 'حللت في المركز 2 وأُضيفت 500 نقطة إلى رصيدك. شكرًا لمشاركتك!', 'points only: as before');
    assert.equal(plain.body.en, 'You placed 2, and 500 points were added to your balance. Thank you for taking part!');
  }
  assert.match(src('worker/lib/rewards/competitions.ts'), /kind: 'competition_won', title: competitionTitle\(row\), place: p\.place, points, prize: \{ ar: row\.prize_ar, en: row\.prize_en, ckb: row\.prize_ckb \}/);
});

test('the rate page’s new sentences exist in three languages, the Sorani its own', () => {
  for (const key of ['rate.rewardRejected', 'rate.revision', 'rate.revision.edit', 'rate.reason'] as const) {
    const [ar, en, ckb] = COPY[key];
    soraniOwn(ar, en, ckb);
  }
  assert.equal(copyText('rate.reason', 'ar', { reason: 'صور غير واضحة' }), 'السبب: صور غير واضحة');
});

test('the home page a Sorani customer lands on from the browse mission speaks Sorani', () => {
  const twoArgs = /\bloc\('[^']*',\s*'[^']*'\)/;
  for (const file of ['CategoryBento', 'EditorialBanners', 'LatestProducts']) {
    assert.doesNotMatch(src(`src/components/home/v2/${file}.tsx`), twoArgs, `${file} falls back to Arabic on a Sorani page`);
  }
  assert.match(src('src/components/home/v2/LatestProducts.tsx'), /loc\('أحدث المنتجات', 'Latest products', 'نوێترین بەرهەمەکان'\)/);
  for (const [ar, en, ckb] of [
    ['تسوق حسب الفئة', 'Shop by category', 'بەپێی پۆل بکڕە'],
    ['اكتشف الآن', 'Explore now', 'ئێستا بیدۆزەرەوە'],
  ]) soraniOwn(ar, en, ckb);
});

// ------------------------------------------------------------------ the small things

test('a toast rises above the browse clock while the clock is up, and leaves nothing behind when it goes', () => {
  assert.match(src('src/components/ui/Toast.tsx'), /var\(--nav-stack\)\) \+ 0\.75rem \+ var\(--toast-lift, 0px\)\)/);
  const clock = src('src/components/BrowseMissionTimer.tsx');
  assert.match(clock, /root\.style\.setProperty\('--toast-lift', '3\.25rem'\);/);
  assert.match(clock, /root\.style\.removeProperty\('--toast-lift'\);/);
});

test('small controls keep their drawing and take a 44 px tap', () => {
  const pins: ReadonlyArray<readonly [string, RegExp]> = [
    ['src/components/rewards/CartCoupons.tsx', /<Link to=\{link\} className="relative lv-hit /],
    ['src/pages/Cart.tsx', /className="relative lv-hit rounded text-gold[^"]*"\s*>\s*\{loc\('اشترك الآن'/],
    ['src/pages/Cart.tsx', /navigate\('\/profile'\)\}\s*className="relative lv-hit /],
    ['src/pages/Cart.tsx', /navigate\(-1\)\} className="relative lv-hit /],
    ['src/components/cart/VariantChoices.tsx', /className="lv-choice lv-hit /],
    ['src/pages/Checkout.tsx', /data-checkout-promo-toggle\s*className="relative lv-hit /],
    ['src/components/ui/SummaryInfo.tsx', /className=\{`relative lv-hit -my-1 ms-1 inline-flex h-6 w-6/],
    ['src/components/adminRewards/RewardsPrinters.tsx', /className="relative lv-hit font-mono/],
    ['src/components/adminGifts/LevelsPanel.tsx', /\$\{T\.btnIcon\} relative lv-hit/],
    ['src/components/adminGifts/LevelsPanel.tsx', /\$\{T\.btnIconDanger\} relative lv-hit/],
    ['src/components/DashboardLayout.tsx', /className="relative lv-hit hover:text-text-primary transition-colors min-h-11/],
    ['src/components/DashboardLayout.tsx', /className="relative lv-hit w-9 h-9 rounded-full/],
  ];
  for (const [file, pin] of pins) assert.match(src(file), pin, file);
  assert.match(src('src/index.css'), /\.lv-hit::after \{/, 'the helper they lean on');
});

test('the reviews queue’s state filter is the house’s 44 px lv-choice, pressed when chosen, and the clay census counts no hand-drawn button in it', async () => {
  const queue = src('src/components/AdminReviews.tsx');
  assert.match(
    queue,
    /<div role="group" aria-label=\{S\.tabs\.queue\} className="flex flex-wrap items-center gap-1\.5">[\s\S]{0,260}aria-pressed=\{stateFilter === f\}[\s\S]{0,120}className="lv-choice press-scale min-h-\[44px\] px-3 text-\[12px\] leading-\[1\.5\] font-bold whitespace-nowrap"/
  );
  // A wrapping row, not a clipping scroller: the 44 px is the option's own, not a ::after a scroller would cut.
  assert.doesNotMatch(queue, /overflow-x-auto">\s*\{\(\['submitted'/);
  const { scanSource } = await import('../scripts/clay-census.mjs');
  assert.deepEqual(scanSource(queue).btn, [], 'tests/claySystem.test.ts’s ratchet counts no ad-hoc button here');
  assert.match(src('src/index.css'), /\.lv-choice \{\s*position: relative;\s*min-block-size: 44px;/, 'the option is 44 px by the house class');
});

test('L3: a queue row’s printer name takes its own direction, so a long English name in an Arabic or Sorani row is cut at its end, not its start', () => {
  const queue = src('src/components/AdminReviews.tsx');
  // dir="auto" (the house's way: adminCommunity/AdminCommunity.tsx), aligned with the row by two utilities the sheet already holds.
  assert.match(queue, /<div dir="auto" className=\{`text-sm font-bold truncate \$\{dir === 'rtl' \? 'text-right' : 'text-left'\}`\}>\{productName\(row\.product\)\}<\/div>/);
  // And the line under it: the email, the order and the written date each isolated, so the day stays with its month.
  assert.match(queue, /<bdi>\{row\.customer\.email\}<\/bdi> · <bdi>\{row\.order_id \?\? '—'\}<\/bdi> · <bdi>\{formatDate\(row\.created_at, lang\)\}<\/bdi>/);
});

test('the checkout gives a line’s name two lines, and nothing shows through the product page’s bar', () => {
  const checkout = src('src/pages/Checkout.tsx');
  assert.doesNotMatch(checkout, /text-text-primary line-clamp-1( mb-0\.5)?">\{(line\.name|entry\.items\[0\]\.name)\}/);
  assert.match(src('src/pages/Product.tsx'), /data-testid="product-buybar" data-bottom-bar className="[^"]*\bbg-surface-raised px-3/);
});

test('the build pays for itself: no utility a single fixture or a one-off asked for', () => {
  // `h-screen` alone: `min-h-screen` is another utility, and one the sheet already holds.
  assert.doesNotMatch(src('tests/browser/points-ads-fixture.tsx'), /(?<![\w-])h-screen(?![\w-])/, 'a fixture’s class ships in every visitor’s first paint (@source "../tests/browser")');
  const modal = src('src/components/points/AdWatchModal.tsx');
  assert.doesNotMatch(modal, /(?<![\w-])(ease-linear|m-2)(?![\w-])/);
  assert.doesNotMatch(src('src/components/adminRewards/RewardsShopProducts.tsx'), /outline-danger/);
});

test('row 302 names the switch the code reads', () => {
  const row = src('docs/DECISIONS.md').split('\n').find((l) => l.startsWith('| 302 |')) ?? '';
  assert.ok(row.includes('`filament.on_offer`'));
  assert.ok(!row.includes('`filament.on_sale`'));
});
