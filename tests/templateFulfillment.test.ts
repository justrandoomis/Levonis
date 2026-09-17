/**
 * THE MODEL'S ORDER TYPES SURVIVE A ROUND TRIP THROUGH THE FILE.
 *
 * The owner's grammar, verbatim:
 *
 *   options.N.direct.*
 *   options.N.preorder.*
 *   options.N.preorder.transports.N.{method,enabled,surcharge_iqd,lead_time_*}
 *
 * The TXT format had exactly two levels of indexing before this. A third
 * exists ONLY here, and only because the thing being described genuinely has
 * three: a model, its order types, and the routes of one of them. Flattening
 * it into a fourth top-level group would mean repeating the model id on every
 * line and letting a route drift away from the order type it belongs to.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBlankTemplate, parseTemplate, toDocBody } from '../worker/lib/template';

const HEAD = 'template_version=2\nname_en=A1 mini\nprice_iqd=499000\n';

const parse = (body: string) => parseTemplate(HEAD + body);

test('the nested keys parse into cells, and nothing lands in unknown_keys', () => {
  const p = parse(
    [
      'options.1.id=opt_mini',
      'options.1.name_en=A1 mini',
      'options.1.direct.enabled=true',
      'options.1.direct.price_iqd=+50000',
      'options.1.preorder.enabled=true',
      'options.1.preorder.lead_time_text=٢١ إلى ٣٠ يوم',
      'options.1.preorder.lead_time_min_days=21',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.surcharge_iqd=80000',
      'options.1.preorder.transports.2.method=sea',
      'options.1.preorder.transports.2.enabled=false',
    ].join('\n')
  );
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.unknown_keys, []);

  const item = p.groups.options![0]!;
  assert.ok(item.cells, 'the item carries its cells');
  assert.equal(item.cells!.direct!.fields.enabled!.value, true);
  assert.equal(item.cells!.direct!.fields.price_iqd!.value, 50_000);
  assert.equal(item.cells!.direct!.fields.price_iqd!.adjust, true, '+N is an adjustment, not a price');
  assert.equal(item.cells!.preorder!.fields.lead_time_text!.value, '٢١ إلى ٣٠ يوم');
  assert.equal(item.cells!.preorder!.list!.length, 2);
  assert.equal(item.cells!.preorder!.list![0]!.fields.method!.value, 'air');
  assert.equal(item.cells!.preorder!.list![1]!.fields.enabled!.value, false);
});

test('a route that is not air, sea or land is an error rather than a stored value', () => {
  const p = parse(
    ['options.1.id=o', 'options.1.name_en=M', 'options.1.preorder.transports.1.method=rocket'].join('\n')
  );
  assert.ok(p.errors.some((e) => /method/.test(e.key)), 'the bad method is named');
});

test('a key that merely contains a dot is still unknown, not silently a cell', () => {
  const p = parse(['options.1.id=o', 'options.1.name_en=M', 'options.1.nonsense.field=1'].join('\n'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.unknown_keys, ['options.1.nonsense.field']);
});

test('the document carries the cells, with the file’s price_iqd under the ladder’s name', () => {
  const p = parse(
    [
      'options.1.id=opt_mini',
      'options.1.name_en=A1 mini',
      'options.1.direct.enabled=true',
      'options.1.direct.price_iqd=549000',
      'options.1.preorder.enabled=true',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.surcharge_iqd=80000',
    ].join('\n')
  );
  const out = toDocBody(p, null, {});
  const options = out.body.options as Array<Record<string, unknown>>;
  const cells = options[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.equal(cells.length, 2);

  const direct = cells.find((c) => c.fulfillment_type === 'direct_sale')!;
  assert.equal(direct.regular_price_iqd, 549_000, 'the file says price_iqd; the ladder says regular_price_iqd');
  assert.equal('price_iqd' in direct, false, 'and the file’s spelling does not leak into the document');
  assert.equal(direct.enabled, true);

  const pre = cells.find((c) => c.fulfillment_type === 'pre_order')!;
  const routes = pre.transports as Array<Record<string, unknown>>;
  assert.deepEqual(routes.map((r) => [r.method, r.surcharge_iqd, r.enabled]), [['air', 80_000, true]]);
});

test('a cell the file does not mention is PRESERVED, and __CLEAR__ is how one is removed', () => {
  const existing = {
    options: [
      {
        id: 'opt_mini',
        name_en: 'A1 mini',
        fulfillments: [
          { fulfillment_type: 'direct_sale', enabled: true, regular_price_iqd: 549_000 },
          { fulfillment_type: 'pre_order', enabled: true, lead_time_text: 'kept' },
        ],
      },
    ],
  } as unknown as Parameters<typeof toDocBody>[1];

  // Mentions only the direct cell: the pre-order survives untouched.
  const kept = toDocBody(
    parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.direct.price_iqd=560000'].join('\n')),
    existing,
    {}
  );
  const keptCells = (kept.body.options as Array<Record<string, unknown>>)[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.equal(keptCells.length, 2);
  assert.equal(keptCells.find((c) => c.fulfillment_type === 'direct_sale')!.regular_price_iqd, 560_000);
  assert.equal(keptCells.find((c) => c.fulfillment_type === 'pre_order')!.lead_time_text, 'kept');

  // "The file did not mention it" and "the owner deleted it" have to be
  // different statements, or nothing could ever be taken away.
  const cleared = toDocBody(
    parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder=__CLEAR__'].join('\n')),
    existing,
    {}
  );
  const clearedCells = (cleared.body.options as Array<Record<string, unknown>>)[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.deepEqual(clearedCells.map((c) => c.fulfillment_type), ['direct_sale']);
});

test('a file that says nothing about order types leaves them entirely alone', () => {
  const existing = {
    options: [
      { id: 'opt_mini', name_en: 'A1 mini', fulfillments: [{ fulfillment_type: 'pre_order', enabled: true }] },
    ],
  } as unknown as Parameters<typeof toDocBody>[1];
  const out = toDocBody(parse('options.1.id=opt_mini\noptions.1.name_en=A1 mini\n'), existing, {});
  const cells = (out.body.options as Array<Record<string, unknown>>)[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.deepEqual(cells.map((c) => c.fulfillment_type), ['pre_order']);
});

test('the blank template documents the grammar and declares nothing by printing it', () => {
  const blank = generateBlankTemplate();
  for (const key of [
    'options.1.direct.enabled',
    'options.1.direct.price_iqd',
    'options.1.preorder.lead_time_text_en',
    'options.1.preorder.transports.1.method',
    'options.1.preorder.transports.1.surcharge_iqd',
  ]) {
    assert.ok(blank.includes(key), `${key} should appear in the blank template`);
    // COMMENTED OUT: a block that is present means "this model sells that
    // way", so a live line would declare every new product as selling both
    // ways before anyone said so.
    assert.ok(
      new RegExp(`^#\\s*${key.replace(/[.]/g, '\\.')}=`, 'm').test(blank),
      `${key} must be commented out in the blank template`
    );
  }
  // And the blank still parses, with the cells inert.
  const p = parseTemplate(blank);
  assert.deepEqual(p.unknown_keys, []);
  assert.equal(p.groups.options?.[0]?.cells, undefined, 'a commented block declares nothing');

  // The distinction the owner insisted on, said in the file itself.
  assert.ok(blank.includes('وليس التوصيل داخل العراق'), 'air/sea/land is named as NOT local delivery');
});
