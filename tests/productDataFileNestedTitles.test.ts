/**
 * «تحديث البيانات» — AN ITEM INSIDE AN ITEM HAS ITS OWN TITLE (docs/DECISIONS.md
 * row 207).
 *
 * Every row is titled «item · field» (dataFileStrings.ts `rowTitle`). A line in
 * an item INSIDE an item — a model's pre-order route
 * (`options.N.preorder.transports.M.*`, air vs sea) or a row of a spec group
 * (`spec_groups.N.rows.M.*`) — used to be titled by the outer item and the
 * field alone, so two different lines read the same title in every language
 * (found by the ux verifier on 317e878d). Now the inner item follows the outer
 * one: by the line's `nkey` as the sheet passes it (the route's method, the
 * spec row's label the comparison sends in `labels.inner`), else by its number
 * in the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post } from './fixtures/app';
import { setup, create, download, edit, PRODUCT } from './fixtures/dataFile';
import { bigWorld, coldApp, setLines } from './fixtures/dataFileLarge';
import { DATA_FILE_ROUTE_NAMES, pick, rowTitle, type DataFileLabels } from '../src/components/adminProducts/dataFileStrings';

interface Card {
  fields: Array<{ key: string; nkey?: string; status: string; item: { group: string; id: string } | null }>;
  labels?: DataFileLabels;
}

const LANGS = ['ar', 'en', 'ckb'] as const;
const changes = (p: Card) => p.fields.filter((f) => f.status === 'change');
/** Without the nkey (the key alone): the inner item by its number in the file. */
const bare = (p: Card, lang: string) => changes(p).map((f) => [f.key, rowTitle(f.key, f.item, p.labels, lang)] as const);
/** As the sheet calls it: with the line's nkey. */
const sheet = (p: Card, lang: string) => changes(p).map((f) => [f.key, rowTitle(f.key, f.item, p.labels, lang, f.nkey)] as const);

test('a model\'s two pre-order routes (air, sea): two changed lines, two different titles — each names its route', async () => {
  const s = setup();
  const id = await create(s.app, PRODUCT);
  let t = await download(s.app, id);
  assert.match(t, /^options\.1\.preorder\.transports\.1\.method=air$/m);
  assert.match(t, /^options\.1\.preorder\.transports\.2\.method=sea$/m);
  t = edit(t, 'options.1.preorder.transports.1.surcharge_iqd', '90000');
  t = edit(t, 'options.1.preorder.transports.2.surcharge_iqd', '35000');
  const res = await post(s.app, '/api/admin/template/data-preview', { text: t, product_id: id });
  const p = ((await res.json()) as { products: Card[] }).products[0];
  for (const lang of LANGS) {
    const titles = bare(p, lang);
    assert.equal(titles.length, 2);
    assert.notEqual(titles[0][1], titles[1][1], `[${lang}] ${titles[0][0]} and ${titles[1][0]} both read «${titles[0][1]}»`);
    const named = new Map(sheet(p, lang));
    assert.ok(named.get('options.1.preorder.transports.1.surcharge_iqd')!.includes(pick(DATA_FILE_ROUTE_NAMES.air, lang)), `[${lang}] ${JSON.stringify([...named])}`);
    assert.ok(named.get('options.1.preorder.transports.2.surcharge_iqd')!.includes(pick(DATA_FILE_ROUTE_NAMES.sea, lang)), `[${lang}] ${JSON.stringify([...named])}`);
  }
  assert.ok(sheet(p, 'en').every(([, title]) => /^[^·]+ · (Air|Sea) route · Route surcharge$/.test(title)), JSON.stringify(sheet(p, 'en')));
});

test('two rows of one spec group: two changed lines, two different titles — each names its row', async () => {
  const w = await bigWorld({ opts: 1 });
  const text = setLines(
    w.text,
    new Map([
      ['spec_groups.1.rows.1.value_en', '11 mm'],
      ['spec_groups.1.rows.2.value_en', '22 mm'],
    ])
  );
  const res = await post(coldApp(w.raw).app, '/api/admin/template/data-preview', { text, product_id: w.id });
  const p = ((await res.json()) as { products: Card[] }).products[0];
  for (const lang of LANGS) {
    const titles = bare(p, lang);
    assert.equal(titles.length, 2);
    assert.notEqual(titles[0][1], titles[1][1], `[${lang}] ${titles[0][0]} and ${titles[1][0]} both read «${titles[0][1]}»`);
    const named = sheet(p, lang);
    assert.notEqual(named[0][1], named[1][1], `[${lang}] ${JSON.stringify(named)}`);
  }
  // Each row by its own label (the comparison sends it in labels.inner).
  const labelEn = (n: number) => new RegExp(`^spec_groups\\.1\\.rows\\.${n}\\.label_en=(.+)$`, 'm').exec(w.text)?.[1] ?? null;
  assert.ok(Object.keys(p.labels?.inner ?? {}).length >= 1, JSON.stringify(p.labels));
  for (const n of [1, 2]) {
    const want = labelEn(n);
    if (!want) continue;
    assert.ok(
      sheet(p, 'en').some(([k, title]) => k === `spec_groups.1.rows.${n}.value_en` && title.includes(want)),
      `row ${n} reads its label «${want}»: ${JSON.stringify(sheet(p, 'en'))}`
    );
  }
});
