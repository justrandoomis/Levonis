/**
 * The four defects the owner reported on the admin product form, each pinned
 * by the smallest test that would have caught it.
 *
 *   1. «فشل رفع وحفظ الصورة» — the upload refused files it was about to
 *      shrink, and then threw the reason away.
 *   2. «ترجمة المنتجات من العربية إلى الإنجليزية والكردية يفشل» — the engine
 *      runs English → ar/ckb and never invents prose (§3), so an Arabic source
 *      can only be translated by a human. There was no way for a human to do
 *      it, and the banner's explanation was wrong.
 *   3. «فشل في حفظ المنتج لسبب غير معروف» — the fulfilment panel inside the
 *      form moved `products.updated_at` and never said so, so the form's own
 *      concurrency token went stale and the next save was refused as
 *      "modified by someone else".
 *   4. «نفس الحقل مكرر بأكثر من قسم» — mirrored controls with nothing on
 *      screen admitting they are the same value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MAX_SOURCE_BYTES,
  PRODUCT_VIDEO_MAX_BYTES,
  prepareProductImage,
} from '../src/lib/imagePreprocess';
import { isArabicScript, reviewReason } from '../worker/lib/translate/index';
import { localizeProductDoc } from '../worker/lib/translate/localizeProduct';
import { localizeRespectingAuthored, readTranslationOverrides } from '../worker/lib/productPersistence';
import { validateProductDoc } from '../worker/lib/productModel';
import type { ProductDoc } from '../worker/lib/productModel';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const pngBytes = (bytes: number) => {
  const buf = new Uint8Array(bytes);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buf;
};
const gifBytes = (bytes: number) => {
  const buf = new Uint8Array(bytes);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  return buf;
};
const mp4Bytes = (bytes: number) => {
  const buf = new Uint8Array(bytes);
  // ....ftypisom
  buf.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return buf;
};

// ---------------------------------------------------------------- 1. images

test('the 8 MB ceiling is measured on the WebP that is uploaded, not the camera original', async () => {
  // Exactly the shape of the owner's screenshot: a large Apple PNG export.
  const big = new File([pngBytes(12 * 1024 * 1024)], 'AE61C6DA-FFC8-4524-8E7C-77DCD8A8DF0B.png', {
    type: 'image/png',
  });
  assert.ok(big.size > PRODUCT_IMAGE_MAX_BYTES, 'the fixture must exceed the upload ceiling');

  const result = await prepareProductImage(big, async () => ({
    // What a 12 MB PNG really becomes at 3000px / q0.87.
    blob: new Blob([new Uint8Array(420 * 1024)], { type: 'image/webp' }),
    width: 3000,
    height: 2000,
  }));
  assert.equal(result.converted, true);
  assert.ok(result.file.size < PRODUCT_IMAGE_MAX_BYTES);
  assert.equal(result.file.type, 'image/webp');
});

test('a format that travels untouched still keeps the real ceiling, and says the numbers', async () => {
  // A GIF is deliberately never re-encoded (it would destroy the animation),
  // so for it the upload ceiling really is the ceiling.
  const gif = new File([gifBytes(9 * 1024 * 1024)], 'loop.gif', { type: 'image/gif' });
  await assert.rejects(
    () => prepareProductImage(gif),
    (e: Error) => /9\.0 MB/.test(e.message) && /8\.0 MB/.test(e.message)
  );

  const small = new File([gifBytes(1024)], 'tiny.gif', { type: 'image/gif' });
  const kept = await prepareProductImage(small);
  assert.equal(kept.converted, false);
  assert.equal(kept.file, small);
});

test('video keeps its own, larger ceiling and a source too big to decode is named as such', async () => {
  assert.ok(PRODUCT_VIDEO_MAX_BYTES > PRODUCT_IMAGE_MAX_BYTES);
  const clip = new File([mp4Bytes(20 * 1024 * 1024)], 'demo.mp4', { type: 'video/mp4' });
  const kept = await prepareProductImage(clip);
  assert.equal(kept.converted, false);

  const absurd = new File([pngBytes(PRODUCT_IMAGE_MAX_SOURCE_BYTES + 1024)], 'huge.png', { type: 'image/png' });
  await assert.rejects(
    () => prepareProductImage(absurd, async () => { throw new Error('the encoder must never be reached'); }),
    /source file too large/
  );
});

test('the upload UI shows the reason it was given instead of one generic sentence', () => {
  const images = src('src/components/adminProducts/form/ImagesSection.tsx');
  // The defect: `e instanceof ApiError ? e.message : '<generic>'`. Everything
  // thrown BEFORE the request is a plain Error, so that branch discarded
  // exactly the messages the admin needed.
  assert.doesNotMatch(images, /instanceof ApiError \? e\.message/);
  assert.match(images, /failureText\(e, 'فشل الرفع/);
  // AVIF was promised under the button and refused by the file dialog.
  assert.match(images, /image\/avif/);

  const api = src('src/lib/api.ts');
  assert.match(api, /export function failureText/);
  // A multipart body must not inherit a 20-second JSON deadline.
  assert.match(api, /timeoutMs: uploadTimeoutMs\(prepared\.size\)/);

  // A slot that could only turn red now says why.
  const formUi = src('src/components/adminProducts/form/formUi.tsx');
  assert.match(formUi, /setErr\(failureText\(e,/);
  assert.doesNotMatch(formUi, /\} catch \{\n\s+setErr\(true\);/);
});

// ------------------------------------------------------------ 2. translation

test('an English box filled in Arabic is reported as that, not as "stayed in English"', () => {
  assert.equal(isArabicScript('طابعة ثلاثية الأبعاد عالية السرعة'), true);
  assert.equal(isArabicScript('High-speed 3D printer'), false);
  // A model code inside Arabic does not make the text English.
  assert.equal(isArabicScript('طابعة Bambu Lab A1'), true);
  // ...and an English line carrying one Arabic word is still English.
  assert.equal(isArabicScript('Bambu Lab A1 mini printer, ships from العراق'), false);

  assert.equal(reviewReason('طابعة ثلاثية الأبعاد'), 'not_english');
  assert.equal(
    reviewReason('This printer uses a fully enclosed chamber so it can run engineering filaments all day long'),
    'prose'
  );
  assert.equal(reviewReason('Chassis: die-cast aluminium'), 'terms');
});

test('every flagged field carries its reason, and the old list is still produced', () => {
  const doc = validateProductDoc({
    name_en: 'A1 mini',
    price_iqd: 100000,
    description_en: 'طابعة ثلاثية الأبعاد مناسبة للمبتدئين وتعمل بصمت',
  });
  const result = localizeProductDoc(doc);
  assert.ok(result.review_needed.includes('description'));
  assert.deepEqual(
    result.review_details.find((d) => d.field === 'description'),
    { field: 'description', reason: 'not_english' }
  );
});

test('a translation the admin typed is stored, marked approved, and survives the next save', () => {
  const body = {
    name_en: 'A1 mini',
    price_iqd: 100000,
    description_en: 'A compact printer that is quiet enough to leave running overnight in a bedroom',
  };
  const first = validateProductDoc(body) as ProductDoc;
  const localized = localizeRespectingAuthored(first, null, {
    description: { ar: 'طابعة صغيرة هادئة', ckb: 'پرینتەرێکی بچووکی بێدەنگ' },
  });

  assert.equal(first.description_ar, 'طابعة صغيرة هادئة');
  assert.equal(first.description_ckb, 'پرینتەرێکی بچووکی بێدەنگ');
  assert.equal(first.translation_meta.description?.ar?.status, 'approved');
  assert.equal(first.translation_meta.description?.ckb?.status, 'approved');
  // A field a human has just written is no longer waiting for a human.
  assert.ok(!localized.review_needed.includes('description'));
  assert.ok(!localized.review_details.some((d) => d.field === 'description'));

  // SAVE TWO, with no overrides at all: the machine must not write over it.
  const second = validateProductDoc(body) as ProductDoc;
  localizeRespectingAuthored(second, first);
  assert.equal(second.description_ar, 'طابعة صغيرة هادئة');
  assert.equal(second.description_ckb, 'پرینتەرێکی بچووکی بێدەنگ');

  // ...but once the ENGLISH moves, the human copy is honestly marked stale
  // rather than left describing text that no longer exists.
  const third = validateProductDoc({ ...body, description_en: 'A different printer entirely' }) as ProductDoc;
  localizeRespectingAuthored(third, first);
  assert.equal(third.translation_meta.description?.ar?.status, 'stale');
  assert.notEqual(third.description_ar, 'طابعة صغيرة هادئة');
});

test('the override channel is bounded and refuses anything it does not recognise', () => {
  assert.equal(readTranslationOverrides(undefined), undefined);
  assert.equal(readTranslationOverrides('description'), undefined);
  assert.equal(readTranslationOverrides({ description: 'not an object' }), undefined);
  assert.equal(readTranslationOverrides({ 'spec:a b': { ar: 'x' } }), undefined, 'a space is not a slot key');
  assert.equal(readTranslationOverrides({ description: { ar: 7 } }), undefined, 'a number is not text');

  const polluted = JSON.parse('{"__proto__":{"ar":"x"},"description":{"ar":"نص"}}');
  const parsed = readTranslationOverrides(polluted);
  assert.deepEqual(parsed, { description: { ar: 'نص' } });
  assert.equal(({} as Record<string, unknown>).ar, undefined);

  const long = readTranslationOverrides({ description: { ar: 'ن'.repeat(60_000) } });
  assert.equal(long!.description.ar!.length, 50_000);

  const many: Record<string, { ar: string }> = {};
  for (let i = 0; i < 500; i++) many[`label:l${i}`] = { ar: 'x' };
  assert.equal(Object.keys(readTranslationOverrides(many)!).length, 400);
});

test('the form offers the hand-translation door the review flag used to point at', () => {
  const form = src('src/components/adminProducts/ProductForm.tsx');
  // The sentence that was not true for a form filled in Arabic. Comment lines
  // are dropped first: the fix's own note quotes the old wording to explain
  // why it went, and a test that forbade naming it would forbid the
  // explanation too.
  const rendered = form
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(rendered, /بقيت بالإنجليزية/);
  assert.match(rendered, /تحتاج ترجمة بشرية/);
  assert.match(form, /translation_overrides/);
  assert.match(form, /TranslationsSheet/);

  const route = src('worker/routes/adminProducts.ts');
  assert.match(route, /readTranslationOverrides\(body\.translation_overrides\)/);
  assert.match(route, /translation_review: localized\.review_details/);

  // No network call may enter the translator (§3: no AI, no generative API).
  const engine = src('worker/lib/translate/index.ts');
  assert.doesNotMatch(engine, /\bfetch\(/);
});

// ---------------------------------------------------------- 3. save conflict

test('the second write door inside the form hands back the concurrency token', () => {
  const route = src('worker/routes/adminProductRelations.ts');
  // The door that moves `products.updated_at`...
  assert.match(route, /UPDATE products SET sale_types = \?, updated_at = strftime/);
  // ...must return the value it moved it to.
  assert.match(route, /SELECT updated_at FROM products WHERE id = \?/);
  assert.match(route, /updated_at: token\?\.updated_at/);

  const panel = src('src/components/adminProducts/FulfillmentPanel.tsx');
  assert.match(panel, /if \(res\.updated_at\) onProductTouched\?\.\(res\.updated_at\)/);

  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /onProductTouched=\{setLoadedUpdatedAt\}/);
});

test('a refused save offers a way out instead of a sentence with nothing below it', () => {
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /e\.code === 'STALE_EDIT'/);
  assert.match(form, /data-form="stale-edit"/);
  // Both answers exist: keep mine, or take the stored one.
  assert.match(form, /save\(staleSave, \{ overwrite: true \}\)/);
  assert.match(form, /expected_updated_at: overwrite \? undefined :/);
});

// ------------------------------------------------------- 4. mirrored fields

test('every control that shows a value owned elsewhere says so, in one shared marker', () => {
  const formUi = src('src/components/adminProducts/form/formUi.tsx');
  assert.match(formUi, /export function MirrorNote/);
  // Three relationships, because they behave differently for the admin.
  for (const kind of ['same', 'replaces', 'derived']) {
    assert.match(formUi, new RegExp(`'${kind}'`));
  }

  // The direct-sale stock the owner named: one column, two screens.
  const options = src('src/components/adminProducts/form/OptionsSection.tsx');
  const panel = src('src/components/adminProducts/FulfillmentPanel.tsx');
  assert.match(options, /MirrorNote kind="same" where="١٢ نوع الطلب لكل موديل"/);
  assert.match(panel, /MirrorNote kind="same" where="٥ الخيارات والألوان"/);

  // The prices and the direct premium they also named.
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /kind="replaces"\s*\n?\s*where="٥ الخيارات والألوان"/);
  assert.match(form, /where="خصم العضوية أسفل هذا القسم"/);
  assert.match(form, /where="١٢ نوع الطلب لكل موديل"/);
  assert.match(form, /kind="derived"/);
});
