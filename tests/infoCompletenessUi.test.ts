/**
 * «اكتمال المعلومات» ON SCREEN (the Bambu import spec §H.2;
 * src/components/adminProducts/InfoCompleteness.tsx).
 *
 *   - the words exactly as the spec gives them, in three languages;
 *   - the list cell: the percentage, then missing / unknown / unverified apart,
 *     «—» for a product with no knowledge row;
 *   - the form card: the counts and the keys not stated, by name, grouped
 *     missing → unknown → unverified;
 *   - the list has the column, the form the card — separate from «ناقص».
 *
 * Run: node --import tsx --test tests/infoCompletenessUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { INFO_WORDS, InfoCompletenessCell, InfoCompletenessView, type InfoCompletenessCardData } from '../src/components/adminProducts/InfoCompleteness';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the spec’s words, in three languages; the Sorani never the Arabic', () => {
  assert.deepEqual(INFO_WORDS.column, { ar: 'اكتمال المعلومات', en: 'Information completeness', ckb: 'تەواوی زانیاری' });
  assert.deepEqual(INFO_WORDS.missing, { ar: 'ناقص', en: 'Missing', ckb: 'کەم' });
  assert.deepEqual(INFO_WORDS.unknown, { ar: 'غير معروف', en: 'Unknown', ckb: 'نەزانراو' });
  assert.deepEqual(INFO_WORDS.unverified, { ar: 'غير مؤكَّد', en: 'Unverified', ckb: 'پشتڕاست نەکراوەتەوە' });
  for (const w of Object.values(INFO_WORDS)) assert.notEqual(w.ckb, w.ar);
});

test('the list cell: the ratio, then the three counts apart; «—» without knowledge rows', () => {
  const html = renderToStaticMarkup(
    createElement(InfoCompletenessCell, { value: { ratio: 0.625, applicable: 16, verified: 8, unverified: 2, missing: 3, unknown: 3 }, lang: 'ar' })
  );
  assert.equal(text(html), '63% ناقص 3 · غير معروف 3 · غير مؤكَّد 2');
  assert.equal(text(renderToStaticMarkup(createElement(InfoCompletenessCell, { value: null, lang: 'en' }))), '—');
});

test('the form card: the keys not stated, by name, missing → unknown → unverified', () => {
  const data: InfoCompletenessCardData = {
    ratio: 0.5,
    applicable: 4,
    verified: 1,
    unverified: 1,
    missing: 1,
    unknown: 1,
    type: 'printer',
    not_found: 1,
    not_published: 0,
    gaps: [
      { key: 'motion.max_speed', label: { ar: 'أقصى سرعة', en: 'Max speed', ckb: 'زۆرترین خێرایی' }, status: 'not_found' },
      { key: 'electrical.voltage', label: { ar: 'الجهد', en: 'Voltage', ckb: 'ڤۆڵتیە' }, status: 'unknown' },
      { key: 'printing.camera', label: { ar: 'الكاميرا', en: 'Camera', ckb: 'کامێرا' }, status: 'unverified' },
    ],
  };
  const html = renderToStaticMarkup(createElement(InfoCompletenessView, { data, lang: 'ckb' }));
  const t = text(html);
  assert.ok(t.startsWith('تەواوی زانیاری 50%'), t);
  assert.ok(t.indexOf('زۆرترین خێرایی') < t.indexOf('ڤۆڵتیە') && t.indexOf('ڤۆڵتیە') < t.indexOf('کامێرا'), t);
  assert.match(html, /data-info-gap="not_found\+not_published"/);
});

test('where it lives: the list’s column and the form’s card, beside — never inside — the commercial «ناقص»', () => {
  const list = readFileSync(join(ROOT, 'src/components/AdminProducts.tsx'), 'utf8');
  assert.match(list, /data-col="info-completeness"/);
  assert.match(list, /<InfoCompletenessCell value=\{p\.info_completeness\}/);
  const form = readFileSync(join(ROOT, 'src/components/adminProducts/ProductForm.tsx'), 'utf8');
  assert.match(form, /<InfoCompletenessCard productId=/);
  const card = readFileSync(join(ROOT, 'src/components/adminProducts/InfoCompleteness.tsx'), 'utf8');
  assert.match(card, /\/api\/admin\/products-v2\/\$\{encodeURIComponent\(productId\)\}\/info-completeness/);
});
