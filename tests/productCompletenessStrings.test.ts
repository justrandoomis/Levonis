/**
 * «ناقص» SPEAKS ARABIC, ENGLISH AND SORANI, AND THE RED FLAG IS REALLY THERE
 * (owner brief 2026-10-10; docs/DECISIONS.md row 183).
 *
 *   - every field label and hint of the central list, every sentence of the
 *     form's flags, the list's badge and the owner's switch, and every refusal
 *     of the switch has ar, en and its own Sorani (never the Arabic pasted
 *     across, with Sorani-only letters);
 *   - the refusals render by code in the reader's language;
 *   - a field the saved product misses renders outlined in red with the red
 *     line under it, `aria-invalid` and `aria-describedby` pointing at that
 *     line; a field it does not miss renders exactly as before; a model's cost
 *     is flagged on that model only; the box flags only its empty sides;
 *   - the section header carries the red count.
 *
 * Run: node --import tsx --test tests/productCompletenessStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMPLETENESS_ENTRIES, COMPLETENESS_REFUSALS } from '../packages/contracts/src/productCompleteness';
import { COMPLETENESS_UI, CompletenessProvider, MissingNote, type CompletenessItemDto } from '../src/components/adminProducts/completeness';
import { Field, SectionCard } from '../src/components/adminProducts/form/formUi';
import { DimensionsSection } from '../src/components/adminProducts/form/DimensionsSection';
import { emptyDimensions } from '../src/lib/productTypes';
import { REFUSAL_STRINGS, contractRefusal } from '../src/lib/refusalStrings';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;

/** `createElement` without the per-component prop inference (the props below are each component's own). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as unknown as (type: any, props?: Record<string, unknown> | null, ...children: unknown[]) => ReturnType<typeof createElement>;

test('every string has ar, en and its own Sorani', () => {
  const problems: string[] = [];
  const check = (where: string, t: { ar: string; en: string; ckb: string }) => {
    for (const lang of ['ar', 'en', 'ckb'] as const) if (!t[lang] || !t[lang].trim()) problems.push(`${where}.${lang} empty`);
    if (t.ckb === t.ar) problems.push(`${where}: ckb copies the Arabic`);
    if (!SORANI_ONLY.test(t.ckb)) problems.push(`${where}: no Sorani-only letter in «${t.ckb}»`);
    if (/[؀-ۿ]/.test(t.en)) problems.push(`${where}: Arabic script in the English`);
  };
  for (const [code, e] of Object.entries(COMPLETENESS_ENTRIES)) {
    check(`${code}.label`, e.label);
    check(`${code}.hint`, e.hint);
  }
  for (const [k, t] of Object.entries(COMPLETENESS_UI)) check(`UI.${k}`, t);
  for (const [k, t] of Object.entries(COMPLETENESS_REFUSALS)) check(`refusal.${k}`, t);
  assert.deepEqual(problems, []);
});

test('the switch refusals render by code in the reader\'s language', () => {
  for (const code of Object.keys(COMPLETENESS_REFUSALS)) {
    assert.ok(REFUSAL_STRINGS[code], `${code} is in the client table`);
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.equal(contractRefusal({ code, message: 'server sentence' }, lang), REFUSAL_STRINGS[code][lang]);
    }
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (items: CompletenessItemDto[], child: any, props: Record<string, unknown> = {}, lang = 'ar') =>
  renderToStaticMarkup(h(CompletenessProvider, { items, lang, optionName: (id: string) => `Model ${id}` }, h(child, props)));

const item = (code: CompletenessItemDto['code'], option_id = ''): CompletenessItemDto => ({
  code,
  option_id,
  section: COMPLETENESS_ENTRIES[code].section,
  private: COMPLETENESS_ENTRIES[code].private,
});

test('a missing field is outlined in red, with the red line, aria-invalid and aria-describedby; a present one is unchanged', () => {
  const field = (need: string) => () =>
    h(Field, { ar: 'السعر', en: 'Price', need: need as never }, h('input', { type: 'text' }));
  const missing = render([item('PRICE')], field('PRICE'));
  assert.match(missing, /data-missing-field="PRICE"/);
  assert.match(missing, /border-red-400\/60/);
  assert.match(missing, /aria-invalid="true"/);
  const described = /aria-describedby="([^"]+)"/.exec(missing)?.[1];
  assert.ok(described, 'the control names its red line');
  assert.match(missing, new RegExp(`<p id="${described}"[^>]*data-missing="PRICE"`));
  assert.ok(missing.includes(COMPLETENESS_UI.missingField.ar));
  const present = render([item('COST')], field('PRICE'));
  assert.doesNotMatch(present, /data-missing|aria-invalid|border-red-400/);
  // The Sorani sentence for a Sorani reader.
  assert.ok(render([item('PRICE')], field('PRICE'), {}, 'ckb').includes(COMPLETENESS_UI.missingField.ckb));
});

test('a model\'s cost is flagged on that model only; the private label never reaches a non-owner (OWNER_DATA)', () => {
  const note = (optionId: string) => () => h(MissingNote, { code: 'COST', optionId, withLabel: true });
  const items = [item('COST', 'o_b')];
  assert.equal(render(items, note('o_a')), '');
  const b = render(items, note('o_b'));
  assert.match(b, /data-missing="COST"/);
  assert.ok(b.includes('Model o_b'), 'names the model');
  // A non-owner's items never carry COST: only OWNER_DATA, rendered with its own label.
  const other = renderToStaticMarkup(
    h(CompletenessProvider, { items: [item('OWNER_DATA')], lang: 'en' }, h(MissingNote, { code: 'COST', optionId: 'o_b' }))
  );
  assert.equal(other, '');
});

test('the box flags only its empty sides; the packaged weight is flagged on the product\'s own measures alone', () => {
  const dims = { ...emptyDimensions(), package_width_mm: 300 };
  const html = render([item('PACKAGE_BOX'), item('PACKAGE_WEIGHT')], DimensionsSection, { dimensions: dims, onChange: () => {}, flags: true });
  const flagged = [...html.matchAll(/data-missing-field="([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(flagged.sort(), ['PACKAGE_BOX', 'PACKAGE_BOX', 'PACKAGE_WEIGHT'], 'depth and height, not the width already typed');
  const modelLevel = render([item('PACKAGE_BOX'), item('PACKAGE_WEIGHT')], DimensionsSection, { dimensions: dims, onChange: () => {}, collapsible: true });
  assert.doesNotMatch(modelLevel, /data-missing-field/, 'a model\'s override editor carries no product flag');
});

test('the section header carries the red count', () => {
  const html = renderToStaticMarkup(
    h(SectionCard, { n: 3, ar: 'الأسعار', en: 'Prices', open: false, onToggle: () => {}, missing: 2, missingLabel: '2 ناقص' }, h('div'))
  );
  assert.match(html, /data-section-missing="2"/);
  assert.ok(html.includes('2 ناقص'));
  assert.match(html, /border-red-500/);
  const none = renderToStaticMarkup(h(SectionCard, { n: 3, ar: 'الأسعار', en: 'Prices', open: false, onToggle: () => {} }, h('div')));
  assert.doesNotMatch(none, /data-section-missing/);
});
