/**
 * «طلب السعر» IN THE ADMIN (DECISIONS row 240, spec §5.3).
 *
 * The needs-pricing queue states how many distinct signed-in customers asked
 * each product's price, when the latest asked, and — folded — the count per
 * option or colour; its action is «تحديد السعر» (the existing V2 section) and
 * it gains the «الأكثر طلباً» filter. The products list gains the requests
 * sort, a «طلبات السعر» filter and a count chip. Counts only: no requester's
 * name or id is ever on these screens. The wording follows the catalog-only
 * state: an unpriced product is SHOWN without a price, never «مخفي».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { RequestsLine } from '../src/components/adminProducts/NeedsPricingQueue';
import { activeTileSub, agoText, hiddenBanner, NEEDS_PRICING, queueEmptyText, statusBadgeKind } from '../src/components/adminProducts/needsPricingStrings';
import { COMPLETENESS_UI } from '../src/components/adminProducts/completeness';
import { V2_STRINGS } from '../src/components/adminProducts/form/v2/v2Strings';
import { PRICE_REQUEST_ADMIN_TEXT, requestersText } from '../packages/contracts/src/priceRequests';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('a queue row says how many people asked, when the latest asked, and folds the per-choice counts', () => {
  const now = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const html = renderToStaticMarkup(
    createElement(RequestsLine, {
      lang: 'ar',
      r: {
        people: 12,
        last_at: now,
        selections: [
          { selection: 'o:m1|c:red', label: { ar: 'X1 · أحمر', en: 'X1 · Red', ckb: 'X1 · سوور' }, people: 9, last_at: now },
          { selection: '', label: { ar: '', en: '', ckb: '' }, people: 3, last_at: now },
        ],
      },
    })
  );
  const t = text(html);
  assert.match(t, new RegExp(requestersText(12, 'ar')));
  assert.match(t, /آخر طلب منذ 3 ساعات/);
  assert.match(html, /<details[^>]*data-queue-selections/);
  assert.match(t, /X1 · أحمر/);
  assert.match(t, new RegExp(PRICE_REQUEST_ADMIN_TEXT.whole_product.ar));
  assert.match(html, /min-h-11/, 'the disclosure is a 44 px target');
  assert.doesNotMatch(html, /user_id|usr_|@/, 'counts only — never a requester');
});

test('the queue: «الأكثر طلباً» filter, «تحديد السعر» action, and the catalog-only wording', () => {
  const q = read('src/components/adminProducts/NeedsPricingQueue.tsx');
  assert.match(q, /const FILTERS: readonly Filter\[\] = \['all', 'most_requested'/);
  assert.match(q, /most_requested: 'most_requested'/, 'the chip shows counts.most_requested');
  assert.match(q, /\{p\.requests && p\.requests\.people > 0 \? <RequestsLine/);
  assert.equal(NEEDS_PRICING.priceNow, PRICE_REQUEST_ADMIN_TEXT.set_price);
  assert.equal(NEEDS_PRICING.filters.most_requested, PRICE_REQUEST_ADMIN_TEXT.most_requested);
  assert.equal(NEEDS_PRICING.hiddenChip.ar, 'ظاهر بلا سعر — يحتاج تسعيرًا');
  for (const l of ['ar', 'en', 'ckb'] as const) {
    assert.doesNotMatch(NEEDS_PRICING.intro[l], /مخفي|hidden|شاردراو/, `${l}: an unpriced product is shown, not hidden`);
    assert.doesNotMatch(hiddenBanner(4, l), /مخفي|hidden|شاردراو/, l);
  }
  assert.equal(agoText(null, 'en'), '—');
  // Arabic counting: 1 alone, 2 as the dual, 3–10 plural, 11+ singular.
  const ago = (ms: number) => agoText(new Date(Date.now() - ms).toISOString(), 'ar');
  const MIN = 60_000;
  assert.deepEqual(
    [ago(1 * MIN + 5000), ago(2 * MIN + 5000), ago(5 * MIN + 5000), ago(15 * MIN + 5000)],
    ['منذ دقيقة', 'منذ دقيقتين', 'منذ 5 دقائق', 'منذ 15 دقيقة']
  );
  assert.deepEqual([ago(60 * MIN + 5000), ago(120 * MIN + 5000), ago(180 * MIN + 5000), ago(11 * 60 * MIN + 5000)], ['منذ ساعة', 'منذ ساعتين', 'منذ 3 ساعات', 'منذ 11 ساعة']);
  assert.deepEqual([ago(24 * 60 * MIN + 5000), ago(5 * 24 * 60 * MIN + 5000), ago(12 * 24 * 60 * MIN + 5000)], ['منذ يوم', 'منذ 5 أيام', 'منذ 12 يومًا']);
  // One digit style on a ckb screen.
  assert.equal(requestersText(2, 'ckb'), '2 کەس داوای نرخیان کردووە');
  assert.match(requestersText(3, 'ckb'), /^3 /);
  // The queue's empty state names its own filter: «everything is priced» only when nothing at all is left.
  assert.equal(queueEmptyText('all', 'ar'), NEEDS_PRICING.empty.ar);
  for (const l of ['ar', 'en', 'ckb'] as const) {
    assert.equal(queueEmptyText('most_requested', l), NEEDS_PRICING.emptyRequests[l]);
    assert.notEqual(queueEmptyText('ready', l), NEEDS_PRICING.empty[l]);
  }
  assert.notEqual(NEEDS_PRICING.emptyRequests.ckb, NEEDS_PRICING.emptyRequests.ar);
  assert.equal(agoText(new Date(Date.now() - 90_000).toISOString(), 'ckb'), '1 خولەک لەمەوبەر');
});

test('the products list: the requests sort, the «طلبات السعر» filter and the count chip', () => {
  const src = read('src/components/AdminProducts.tsx');
  assert.match(src, /<option value="requests">/);
  assert.match(src, /if \(requestedOnly\) params\.set\('requested', '1'\);/);
  assert.match(src, /data-filter-requested/);
  assert.match(src, /data-price-requests=\{n\}/);
  assert.match(src, /if \(typeof n !== 'number' \|\| n <= 0\) return null;/, 'nothing without a request or without 0193');
});

test('«ظاهر بلا سعر» only for what customers can see: never a composition or a product hidden for a missing picture', () => {
  assert.equal(statusBadgeKind('active', { needs_pricing: true }), 'unpriced');
  assert.equal(statusBadgeKind('active', { needs_pricing: true, composition: 'bundle' }), 'hidden');
  assert.equal(statusBadgeKind('active', { needs_pricing: true, catalog_held: true }), 'hidden');
  assert.equal(statusBadgeKind('draft', { needs_pricing: true }), 'draft');
  assert.equal(statusBadgeKind('hidden', { needs_pricing: true }), 'hidden');
  assert.equal(statusBadgeKind('active', { needs_pricing: false }), 'active');
  // The tile and the banner count what customers see, never the wider «needs pricing» total.
  assert.match(activeTileSub({ active_needs_pricing: 9, shown_unpriced: 4 }, 50, 'en'), /· 4 shown without a price/);
  const src = read('src/components/AdminProducts.tsx');
  assert.match(src, /setHiddenCount\(typeof d\.totals\?\.shown_unpriced === 'number' \? d\.totals\.shown_unpriced : null\)/);
  assert.doesNotMatch(src, /needs_pricing=1&limit=1/, 'the banner no longer counts drafts, hidden products and compositions');
  assert.equal((src.match(/<Badge status=\{p\.status\} product=\{p\} \/>/g) ?? []).length, 4);
});

test('the completeness card says which gaps hide and which only stop sale (rows 239-240)', () => {
  // Section ٣ of the product form: a product with no V2 price is shown (while active) and not sold — never «مخفي».
  for (const l of ['ar', 'en', 'ckb'] as const) {
    assert.doesNotMatch(V2_STRINGS[l].hiddenNote, /مخفي|hidden|شاراوە/, `hiddenNote.${l}`);
    assert.doesNotMatch(V2_STRINGS[l].hiddenNoteReady, /إظهار|show the product|پیشاندانی بەرهەمەکە/, `hiddenNoteReady.${l}`);
  }
  assert.match(COMPLETENESS_UI.switchScope.ar, /تمنع البيع فقط/);
  assert.match(COMPLETENESS_UI.switchScope.ar, /الصورة والقسم يمنعان الظهور/);
  for (const k of ['switchScope', 'blocksDisplay', 'blocksSale', 'bannerHeldSale', 'bannerWillHoldSale'] as const) {
    const t = COMPLETENESS_UI[k];
    assert.ok(t.ar && t.en && t.ckb, k);
    assert.notEqual(t.ckb as string, t.ar as string, `${k}: ckb copies the Arabic`);
  }
  const card = read('src/components/adminProducts/HideIncompleteCard.tsx');
  assert.match(card, /COMPLETENESS_UI\.switchScope/);
  // The counts split what the switch holds: hidden (a missing image or section) vs shown without a price.
  for (const l of ['ar', 'en', 'ckb'] as const) {
    for (const k of ['hiddenNow', 'willHide'] as const) assert.match(COMPLETENESS_UI[k][l], /\{h\}/, `${k}.${l} names how many are hidden`);
    assert.doesNotMatch(COMPLETENESS_UI.confirmOn[l], /إخفاء|\bhide\b|بشارەوە/, `confirmOn.${l}: the switch stops sale; only some are hidden`);
  }
  for (const k of ['hiddenNow', 'willHide', 'confirmOn'] as const) assert.notEqual(COMPLETENESS_UI[k].ckb, COMPLETENESS_UI[k].ar);
  assert.match(COMPLETENESS_UI.hiddenNow.ar, /بلا سعر/);
  assert.match(COMPLETENESS_UI.willHide.en, /shown without a price/);
  assert.match(card, /h: summary\.held_from_catalog \?\? summary\.held/);
  assert.match(card, /h: summary\.would_hide_from_catalog \?\? summary\.would_hide/);
  const banner = read('src/components/adminProducts/completeness.tsx');
  assert.match(banner, /isCatalogBlockingCode\(i\.code\) \? COMPLETENESS_UI\.blocksDisplay : COMPLETENESS_UI\.blocksSale/);
});
