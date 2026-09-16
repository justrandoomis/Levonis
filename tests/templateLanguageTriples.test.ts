/**
 * EVERY LINE OF HUMAN TEXT CARRIES ITS THREE LANGUAGES.
 *
 * The owner's request, verbatim: «اجعل في القالب هنالك لكل خانه او سطر له
 * إنجليزي وعربي كردي … مثل: how_to_use_ar= / how_to_use_en= / how_to_use_ckb=
 * ; usage_steps.1.title_ar= … ; options.1.preorder.lead_time_text_ar= …».
 *
 * Thirteen field families already had that triple. Three did not, and the
 * reason was the same each time: there was no per-language SLOT to read back
 * from, so the template had nothing to export.
 *
 * `how_to_use` was also a live data-loss bug rather than a missing feature.
 * `localizeProductDoc` translated it on every save and then discarded the
 * result — `put('how_to_use', doc.how_to_use, () => {})`, an empty setter —
 * behind a comment claiming the storefront read it from `product_translations`.
 * Nothing read it from there. The first test below is what that bug looked
 * like; it fails against the old code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductRow, upgradeUsageGuide, validateProductDoc } from '../worker/lib/productModel';
import type { ProductDoc } from '../worker/lib/productModel';
import { exportProduct, parseTemplate, toDocBody } from '../worker/lib/template';
import { localizeProductDoc } from '../worker/lib/translate/localizeProduct';
import { localizableSlots } from '../worker/lib/translationSlots';
import { relationsBodyFromDoc } from '../worker/lib/templateRelations';
import { bridgeLeadTimeTranslations } from '../worker/lib/productPersistence';
import { EMPTY_RELATIONS } from '../worker/lib/productOverlay';

/**
 * `upgradeOptions` rebuilds every option from a fixed field list and
 * `fulfillments` is not on it (worker/routes/template.ts `reattachCells` says
 * why): the order-type cells are hung off the options by the RELATIONS overlay
 * and by the template's own re-attach step. A test that builds a document has
 * to attach them the same way, or it is testing the JSON mirror instead of the
 * shape the exporter and the relations bridge actually see.
 */
function withCells(doc: ProductDoc, cells: Record<string, unknown[]>): ProductDoc {
  for (const o of doc.options) {
    const attached = cells[o.id];
    if (attached) (o as unknown as Record<string, unknown>).fulfillments = attached;
  }
  return doc;
}

const row = (extra: Record<string, unknown> = {}) =>
  parseProductRow({
    id: 'prd_t',
    slug: 't',
    status: 'active',
    name_ar: 'منتج',
    name_en: 'Product',
    price_iqd: 100_000,
    selling_type: 'direct_sale',
    sale_types: JSON.stringify(['direct_sale']),
    ...extra,
  });

test('the usage text the localiser translates is KEPT, not discarded', () => {
  const doc = row({ how_to_use: 'Nozzle diameter: 0.4 mm' });
  assert.equal(doc.how_to_use_ar, '', 'a stored row starts with no authored Arabic');
  const result = localizeProductDoc(doc);
  assert.equal(doc.how_to_use_ar, 'قطر الفوهة: 0.4 مم');
  assert.ok(doc.how_to_use_ckb.trim(), 'the Kurdish copy is written too');
  assert.ok(
    result.fields.some((f) => f.field === 'how_to_use'),
    'and the source is still recorded for product_translations'
  );
});

test('a usage step and a lead time are translated into their own slots', () => {
  const doc = row({
    usage_guide: JSON.stringify({
      official_url: '',
      steps: [{ id: 'ustep_1', kind: 'setup', title: 'Layer height: 0.2 mm', body: 'Bed temperature: 60 C', order: 0 }],
    }),
    options: JSON.stringify([
      { id: 'opt_1', name_en: 'A1', availability_type: 'pre_order', lead_time_text: 'Lead time: 21 days' },
    ]),
  });
  withCells(doc, {
    opt_1: [
      {
        fulfillment_type: 'pre_order',
        lead_time_text: 'Lead time: 30 days',
        transports: [{ method: 'land', lead_time_text: 'Lead time: 45 days' }],
      },
    ],
  });
  localizeProductDoc(doc);
  const st = doc.usage_guide.steps[0];
  assert.ok(st.title_ar.trim() && st.title_ar !== st.title, `step title stayed English: ${st.title_ar}`);
  assert.ok(st.body_ar.trim() && st.body_ar !== st.body, `step body stayed English: ${st.body_ar}`);
  const o = doc.options[0];
  assert.equal(o.lead_time_text_ar, 'مدة التجهيز: 21 يوم');
  const cell = o.fulfillments![0];
  assert.equal(cell.lead_time_text_ar, 'مدة التجهيز: 30 يوم');
  const route = cell.transports![0];
  assert.equal(route.lead_time_text_ckb, 'ماوەی ئامادەکردن: 45 ڕۆژ');
});

test('every new slot is registered, so the manual-translation sheet can show it', () => {
  const doc = row({
    how_to_use: 'Plug it in.',
    usage_guide: JSON.stringify({ official_url: '', steps: [{ id: 'ustep_1', kind: 'usage', title: 'Start', body: 'Press go', order: 0 }] }),
    options: JSON.stringify([{ id: 'opt_1', name_en: 'A1', lead_time_text: 'two weeks' }]),
  });
  withCells(doc, {
    opt_1: [
      { fulfillment_type: 'pre_order', lead_time_text: 'three weeks', transports: [{ method: 'sea', lead_time_text: 'four weeks' }] },
    ],
  });
  const keys = new Set(localizableSlots(doc as unknown as Record<string, unknown>).map((s) => s.key));
  for (const k of [
    'how_to_use',
    'usage_step:ustep_1:title',
    'usage_step:ustep_1:body',
    'lead_time:opt_1',
    'lead_time:opt_1:pre_order',
    'lead_time:opt_1:pre_order:sea',
  ]) {
    assert.ok(keys.has(k), `${k} has no slot — the sheet would drop it`);
  }
  // A slot must READ what is stored, not just accept writes.
  const slot = localizableSlots(doc as unknown as Record<string, unknown>).find((s) => s.key === 'how_to_use')!;
  assert.equal(slot.en, 'Plug it in.');
  slot.set('ar', 'وصّلها بالكهرباء.');
  assert.equal(doc.how_to_use_ar, 'وصّلها بالكهرباء.');
});

test('the export writes all three languages, and the import reads them back', () => {
  const doc = row({
    how_to_use: 'Plug it in.',
    how_to_use_ar: 'وصّلها بالكهرباء.',
    how_to_use_ckb: 'بیخەرە کارەبا.',
    usage_guide: JSON.stringify({
      official_url: '',
      steps: [
        {
          id: 'ustep_1', kind: 'setup', order: 0,
          title: 'Unboxing', title_ar: 'فك التغليف', title_ckb: 'کردنەوەی سندوق',
          body: 'Remove the clips.', body_ar: 'أزل المشابك.', body_ckb: 'گیرەکان لابە.',
        },
      ],
    }),
  });
  const txt = exportProduct(doc);
  for (const line of [
    'how_to_use_ar=وصّلها بالكهرباء.',
    'how_to_use_en=Plug it in.',
    'how_to_use_ckb=بیخەرە کارەبا.',
    'usage_steps.1.title_ar=فك التغليف',
    'usage_steps.1.title_en=Unboxing',
    'usage_steps.1.title_ckb=کردنەوەی سندوق',
    'usage_steps.1.body_ar=أزل المشابك.',
    'usage_steps.1.body_en=Remove the clips.',
    'usage_steps.1.body_ckb=گیرەکان لابە.',
  ]) {
    assert.ok(txt.split('\n').includes(line), `the export is missing: ${line}`);
  }
  assert.ok(!txt.split('\n').some((l) => l === 'how_to_use=Plug it in.'), 'the legacy spelling is import-only');

  const back = validateProductDoc(toDocBody(parseTemplate(txt), doc, { needs_review: [] }).body);
  assert.equal(back.how_to_use, 'Plug it in.');
  assert.equal(back.how_to_use_ar, 'وصّلها بالكهرباء.');
  assert.equal(back.how_to_use_ckb, 'بیخەرە کارەبا.');
  assert.deepEqual(back.usage_guide.steps[0], doc.usage_guide.steps[0]);
});

test('a file written before 0079 still imports, and the new spelling wins over it', () => {
  const doc = row({ how_to_use: 'old', how_to_use_ar: 'قديم' });
  const legacy = toDocBody(parseTemplate('template_version=2\nhow_to_use=written the old way\n'), doc, { needs_review: [] });
  const applied = validateProductDoc(legacy.body);
  assert.equal(applied.how_to_use, 'written the old way');
  assert.equal(applied.how_to_use_ar, 'قديم', 'an omitted key preserves, it never erases');
  assert.ok(!legacy.preserved_fields.includes('how_to_use'), 'the synonym is a spelling, not a second value');

  const both = validateProductDoc(
    toDocBody(parseTemplate('template_version=2\nhow_to_use=old spelling\nhow_to_use_en=new spelling\n'), doc, {
      needs_review: [],
    }).body
  );
  assert.equal(both.how_to_use, 'new spelling');
});

test('the option lead time survives the export → import → relations-body path', () => {
  const doc = row({
    options: JSON.stringify([
      {
        id: 'opt_1',
        name_en: 'A1',
        availability_type: 'pre_order',
        lead_time_text: 'ships in 3 weeks',
        lead_time_text_ar: 'يُشحن خلال ٣ أسابيع',
        lead_time_text_ckb: 'لە ٣ هەفتەدا دەنێردرێت',
      },
    ]),
  });
  const cells = [
    {
      fulfillment_type: 'pre_order',
      enabled: true,
      lead_time_text: 'cell english',
      lead_time_text_ar: 'عربية الخلية',
      lead_time_text_ckb: 'کوردی خانە',
      transports: [
        {
          method: 'land',
          enabled: true,
          lead_time_text: 'route english',
          lead_time_text_ar: 'عربية الطريق',
          lead_time_text_ckb: 'کوردی ڕێگا',
        },
      ],
    },
  ];
  withCells(doc, { opt_1: cells });
  const txt = exportProduct(doc);
  for (const line of [
    'options.1.lead_time_text_ar=يُشحن خلال ٣ أسابيع',
    'options.1.lead_time_text_en=ships in 3 weeks',
    'options.1.lead_time_text_ckb=لە ٣ هەفتەدا دەنێردرێت',
    'options.1.preorder.lead_time_text_ar=عربية الخلية',
    'options.1.preorder.lead_time_text_en=cell english',
    'options.1.preorder.lead_time_text_ckb=کوردی خانە',
    'options.1.preorder.transports.1.lead_time_text_ar=عربية الطريق',
    'options.1.preorder.transports.1.lead_time_text_en=route english',
    'options.1.preorder.transports.1.lead_time_text_ckb=کوردی ڕێگا',
  ]) {
    assert.ok(txt.split('\n').includes(line), `the export is missing: ${line}`);
  }

  const merged = toDocBody(parseTemplate(txt), doc, { needs_review: [] });
  const back = validateProductDoc(merged.body);
  // `upgradeOptions` drops the cells; the template route re-attaches them from
  // the merge body by option id, and this mirrors that one step.
  withCells(back, {
    opt_1: ((merged.body.options as Array<Record<string, unknown>>)[0].fulfillments ?? []) as unknown[],
  });
  const o = back.options[0];
  assert.equal(o.lead_time_text, 'ships in 3 weeks');
  assert.equal(o.lead_time_text_ar, 'يُشحن خلال ٣ أسابيع');
  assert.equal(o.lead_time_text_ckb, 'لە ٣ هەفتەدا دەنێردرێت');

  // …and reaches the wire body `planRelationsWrite` actually writes from.
  const relations = relationsBodyFromDoc(back, EMPTY_RELATIONS);
  const groups = relations.groups as Array<{ values: Array<Record<string, unknown>> }>;
  const value = groups[0].values[0];
  assert.equal(value.lead_time_text_ar, 'يُشحن خلال ٣ أسابيع');
  assert.equal(value.lead_time_text_ckb, 'لە ٣ هەفتەدا دەنێردرێت');
  const cell = (value.fulfillments as Array<Record<string, unknown>>)[0];
  assert.equal(cell.lead_time_text_ar, 'عربية الخلية');
  assert.equal((cell.transports as Array<Record<string, unknown>>)[0].lead_time_text_ckb, 'کوردی ڕێگا');
});

test('a usage step stored before 0079 reads as "nothing authored", never as a fabrication', () => {
  const guide = upgradeUsageGuide({ official_url: '', steps: [{ id: 'u1', kind: 'usage', title: 'T', body: 'B', order: 0 }] });
  assert.deepEqual(
    { ar: guide.steps[0].title_ar, ckb: guide.steps[0].body_ckb },
    { ar: '', ckb: '' },
    'an old row must not claim a translation it does not have'
  );
});

/**
 * THE SEAM BETWEEN THE DOCUMENT AND THE RELATION TABLES.
 *
 * The localiser writes the DOCUMENT. «مدة التجهيز» lives in `product_option_*`,
 * which is written from the relations WIRE BODY — and on the form path that
 * body is typed by an admin who, by §3, never sees an ar/ckb box. Without the
 * bridge the generated text would be computed and dropped on every form save,
 * which is the exact failure `how_to_use` shipped with.
 */
test('the generated lead time reaches the relations body the writer uses', () => {
  const doc = row({
    options: JSON.stringify([{ id: 'opt_1', name_en: 'A1', lead_time_text: 'Lead time: 21 days' }]),
  });
  withCells(doc, {
    opt_1: [
      { fulfillment_type: 'pre_order', lead_time_text: 'Lead time: 30 days', transports: [{ method: 'air', lead_time_text: 'Lead time: 45 days' }] },
    ],
  });
  localizeProductDoc(doc);

  // What the FORM PUTs: English only, no ar/ckb anywhere.
  const relations: Record<string, unknown> = {
    groups: [
      {
        id: 'g1',
        values: [
          {
            id: 'opt_1',
            name_en: 'A1',
            lead_time_text: 'Lead time: 21 days',
            fulfillments: [
              { fulfillment_type: 'pre_order', lead_time_text: 'Lead time: 30 days', transports: [{ method: 'air', lead_time_text: 'Lead time: 45 days' }] },
            ],
          },
        ],
      },
    ],
  };
  bridgeLeadTimeTranslations(doc, relations);
  const value = (relations.groups as Array<{ values: Array<Record<string, unknown>> }>)[0].values[0];
  assert.equal(value.lead_time_text_ar, 'مدة التجهيز: 21 يوم');
  const cell = (value.fulfillments as Array<Record<string, unknown>>)[0];
  assert.equal(cell.lead_time_text_ar, 'مدة التجهيز: 30 يوم');
  assert.equal((cell.transports as Array<Record<string, unknown>>)[0].lead_time_text_ar, 'مدة التجهيز: 45 يوم');
});

test('a translation the BODY states outranks the machine, and the bridge leaves it alone', () => {
  const doc = row({ options: JSON.stringify([{ id: 'opt_1', name_en: 'A1', lead_time_text: 'Lead time: 21 days' }]) });
  localizeProductDoc(doc);
  const relations: Record<string, unknown> = {
    groups: [{ id: 'g1', values: [{ id: 'opt_1', name_en: 'A1', lead_time_text_ar: 'بعد العيد' }] }],
  };
  bridgeLeadTimeTranslations(doc, relations);
  const value = (relations.groups as Array<{ values: Array<Record<string, unknown>> }>)[0].values[0];
  assert.equal(value.lead_time_text_ar, 'بعد العيد', 'a human statement is not overwritten by the engine');
  // …and the language the body said nothing about still gets the machine's.
  assert.equal(value.lead_time_text_ckb, 'ماوەی ئامادەکردن: 21 ڕۆژ');
});
