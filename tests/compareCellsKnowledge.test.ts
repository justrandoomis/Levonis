/**
 * THE COMPARISON'S CELLS SAY WHY (the Bambu import spec §G.5 «Compare»;
 * src/components/compare/SpecTable.tsx over the real route's answer).
 *
 * A cell the knowledge model answered carries its state: an absent value
 * shows the state's words («لم تنشره الشركة المصنّعة» …) instead of «غير
 * مذكور», never a 0; a value the manufacturer measured shows its test method;
 * an unverified value says so. A comparison with no knowledge row is drawn
 * exactly as before.
 *
 * Run: node --import tsx --test tests/compareCellsKnowledge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { insertSpecValue, notPublished } from './fixtures/knowledgeModel';
import { compareRoutes } from '../worker/routes/compare';
import { LanguageProvider } from '../src/LanguageContext';
import SpecTable from '../src/components/compare/SpecTable';
import { compareStrings } from '../src/components/compare/strings';
import type { CompareProductCard, CompareResult } from '../src/lib/compare';
import { VALUE_STATE_LABELS } from '../packages/catalog/src/bambuImport/registry/labels';

async function comparison(withKnowledge: boolean): Promise<{ products: CompareProductCard[]; result: CompareResult }> {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (withKnowledge) {
    raw.exec(`UPDATE products SET spec_fields = json_remove(spec_fields, '$.nozzle_temp_max') WHERE id = '${P.X2D}'`);
    insertSpecValue(raw, P.H2D, 'thermal.max_nozzle_temp', {
      value_text: '350 °C', value_num: 350, source_kind: 'manual', source_ref: 'https://store.bblcdn.com/s1/h2d-manual.pdf', source_excerpt: 'Max 350 °C', test_method: 'Bench measurement',
    });
    insertSpecValue(raw, P.H2D, 'thermal.max_bed_temp', { value_text: '120 °C', value_num: 120, status: 'unverified' });
    insertSpecValue(raw, P.X2D, 'thermal.max_nozzle_temp', notPublished());
  }
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/compare', compareRoutes), { publishV2: false });
  const random = Math.random;
  Math.random = () => 0.5;
  try {
    const body = await json(await get(app, `/api/compare?ids=${P.H2D},${P.X2D}`));
    return { products: body.products, result: body.comparison };
  } finally {
    Math.random = random;
  }
}

const render = (products: CompareProductCard[], result: CompareResult) =>
  renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(SpecTable, { products, result, diffOnly: false, onDiffOnly: () => {} })),
    })
  );

test('an absent value says why, a measured one names its method, an unverified one says so', async () => {
  const { products, result } = await comparison(true);
  const html = render(products, result);
  const nozzle = /data-field="nozzle_temp_max"[\s\S]*?(?=data-field=")/.exec(html)?.[0] ?? '';
  assert.ok(nozzle, 'the nozzle row is drawn');
  assert.ok(nozzle.includes(VALUE_STATE_LABELS.not_published.ar), 'the X2D cell says «لم تنشره الشركة المصنّعة»');
  assert.match(nozzle, new RegExp(`data-state="not_published"[^>]*>${VALUE_STATE_LABELS.not_published.ar}<`), 'the cell itself carries the state');
  // (The row's own hint says «قيمة غير مذكورة» about scoring; the CELL never reads «غير مذكور» where the state is known.)
  assert.ok(!nozzle.includes(`>${compareStrings('ar').missing}<`), 'never «غير مذكور» where the state is known');
  assert.match(nozzle, /data-test-method/);
  assert.ok(nozzle.includes('Bench measurement') && nozzle.includes(compareStrings('ar').testMethod));
  const bed = /data-field="bed_temp_max"[\s\S]*?(?=data-field=")/.exec(html)?.[0] ?? '';
  assert.ok(bed.includes(VALUE_STATE_LABELS.unverified.ar), 'an unverified value says so');
});

test('the words: «طريقة الاختبار» in three languages, the Sorani its own', () => {
  assert.equal(compareStrings('ar').testMethod, 'طريقة الاختبار');
  assert.equal(compareStrings('en').testMethod, 'Test method');
  assert.equal(compareStrings('ckb').testMethod, 'ڕێگای تاقیکردنەوە');
});

test('without knowledge rows the table is drawn as before: no state, no method', async () => {
  const { products, result } = await comparison(false);
  const html = render(products, result);
  assert.doesNotMatch(html, /data-test-method|data-state="/);
});
