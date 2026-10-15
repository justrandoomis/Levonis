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
import { agoText, hiddenBanner, NEEDS_PRICING } from '../src/components/adminProducts/needsPricingStrings';
import { COMPLETENESS_UI } from '../src/components/adminProducts/completeness';
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
  assert.match(t, /آخر طلب منذ 3 ساعة/);
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

test('the completeness card says which gaps hide and which only stop sale (rows 239-240)', () => {
  assert.match(COMPLETENESS_UI.switchScope.ar, /تمنع البيع فقط/);
  assert.match(COMPLETENESS_UI.switchScope.ar, /الصورة والقسم يمنعان الظهور/);
  for (const k of ['switchScope', 'blocksDisplay', 'blocksSale', 'bannerHeldSale', 'bannerWillHoldSale'] as const) {
    const t = COMPLETENESS_UI[k];
    assert.ok(t.ar && t.en && t.ckb, k);
    assert.notEqual(t.ckb as string, t.ar as string, `${k}: ckb copies the Arabic`);
  }
  const card = read('src/components/adminProducts/HideIncompleteCard.tsx');
  assert.match(card, /COMPLETENESS_UI\.switchScope/);
  const banner = read('src/components/adminProducts/completeness.tsx');
  assert.match(banner, /isCatalogBlockingCode\(i\.code\) \? COMPLETENESS_UI\.blocksDisplay : COMPLETENESS_UI\.blocksSale/);
});
