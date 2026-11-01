/**
 * THE CAPTURE TOOLS (docs/SMART_PRICING.md §3.1, §3.3, §10; WP4): the three scripts under
 * scripts/supplier-prices/ that turn the Tmall sweep, the EU browser snapshot and store pages
 * into `levonis.supplier-prices.v1` files for the owner's upload door.
 *
 *   - normalize-tmall.mjs: price_cny is the price, kept as exact decimal text; price_title
 *     becomes price_label and is never a price (a figure found there is dropped, and a SKU with
 *     no price_cny is refused even when its label holds one); hidden-price, failed and unpriced
 *     items, and SKUs the capture marks not for sale, are dropped and listed;
 *   - normalize-eu-snapshot.mjs: bambu_eu / EUR, the handle as item_key, the product URL with
 *     skr=yes, the manifest type as category, the variant id as sku_key, options by position,
 *     price_eur as exact text (1599 → "1599", 27.99 → "27.99", never rounded); a variant in
 *     another currency, from another host or without a price is refused, never relabelled;
 *   - capture-store-offers.ts: the JSON-LD reader on stored pages; under --store eu every
 *     request carries skr=yes, a redirected page is listed as redirected, a USD page is refused,
 *     robots.txt is obeyed and a challenge stops the run with what it has captured; on a sale
 *     page the regular (struck-through) price is written and the sale price only listed.
 *
 * Every written file passes the upload door's parser (packages/catalog/src/supplierPrices/
 * format.ts). No network: the store reader runs against a stubbed fetch and a fake clock, and
 * the two command lines run on copies in a temporary folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSupplierPriceFile, type SupplierPriceFile, type SupplierPriceItem } from '../packages/catalog/src/supplierPrices/format';
import { Deadline, type Clock } from '../scripts/bambu-import/deadline';
import type { ManifestRow } from '../scripts/bambu-import/discover';
import type { FetchLike } from '../scripts/bambu-import/fetch';
// @ts-expect-error - plain ESM capture tool, no types; typed below
import * as tmallTool from '../scripts/supplier-prices/normalize-tmall.mjs';
// @ts-expect-error - plain ESM capture tool, no types; typed below
import * as euTool from '../scripts/supplier-prices/normalize-eu-snapshot.mjs';
import { captureStoreOffers, handlesOfList, main, parseArgs, readStoreOffers, selectRows, storeFetch, type CaptureResult } from '../scripts/supplier-prices/capture-store-offers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'supplierPricePages');
const fixtureText = (name: string) => readFileSync(join(FIX, name), 'utf8');

// ---------------------------------------------------------------- the normalisers, typed

interface Refusal {
  reason: string;
  detail?: string;
}
interface TmallReport {
  items_read: number;
  items: number;
  skus: number;
  refused_skus: Array<Refusal & { item_key: string; sku_key: string }>;
  dropped_items: Array<Refusal & { item_key: string }>;
  notes: Array<{ item_key: string; sku_key?: string; note: string }>;
}
interface EuReport {
  products_read: number;
  items: number;
  skus: number;
  refused_variants: Array<Refusal & { handle: string; sku: string }>;
  dropped_products: Array<Refusal & { handle: string }>;
  on_sale: Array<{ handle: string; sku: string; price: string; sale_price: string }>;
  notes: Array<{ handle: string; note: string }>;
}
interface Normalized<R> {
  file: unknown;
  report: R;
}
const normalizeTmall: (snapshot: unknown) => Normalized<TmallReport> = tmallTool.normalizeTmallSnapshot;
const normalizeEu: (snapshot: unknown) => Normalized<EuReport> = euTool.normalizeEuSnapshot;
const optionValuesFromName: (variantName: string, productName: string) => string[] = euTool.optionValuesFromName;
const withSkipRegionRedirect: (url: string) => string = euTool.withSkipRegionRedirect;

interface TmallSku {
  sku_id?: string;
  price_cny?: unknown;
  price_title?: unknown;
  not_for_sale?: boolean;
  [key: string]: unknown;
}
interface TmallItem {
  item_id: string;
  hidden_price?: boolean | null;
  ok?: boolean | null;
  props?: unknown[];
  skus: TmallSku[];
  [key: string]: unknown;
}
interface EuVariant {
  sku?: string | null;
  name?: string;
  option_values?: string[];
  colour_code?: string | null;
  price_eur?: unknown;
  price_shown?: unknown;
  currency?: string;
  availability?: string | null;
  url?: string | null;
}
interface EuProduct {
  handle: string;
  name: string;
  url?: string | null;
  variants: EuVariant[];
}

const tmallSample = (): { captured_on: string; items: TmallItem[] } => JSON.parse(fixtureText('tmall-store-2026-10-31.sample.json'));
const euSample = (): { captured_on: string; products: EuProduct[] } => JSON.parse(fixtureText('eu-store-2026-10-31.sample.json'));
const clone = <T>(v: T): T => structuredClone(v);

/** The file as the upload door reads it: through JSON text and the strict parser. */
function v1Of(file: unknown): SupplierPriceFile {
  assert.ok(file, 'a file was produced');
  return parseSupplierPriceFile(JSON.stringify(file));
}
function itemOf(file: SupplierPriceFile, key: string): SupplierPriceItem {
  const it = file.items.find((i) => i.item_key === key);
  assert.ok(it, `item ${key} is in the file`);
  return it;
}

const DECIMAL = /^[0-9]+(?:\.[0-9]{1,2})?$/;

// ---------------------------------------------------------------- normalize-tmall.mjs

test('Tmall: price_cny is the price, as exact decimal text; price_title is the label beside it and never a price', () => {
  const { file } = normalizeTmall(tmallSample());
  const v1 = v1Of(file);
  assert.deepEqual(
    [v1.format, v1.source, v1.currency, v1.price_basis, v1.capture, v1.captured_on, v1.captured_by],
    ['levonis.supplier-prices.v1', 'tmall_cn', 'CNY', 'list', 'browser_sweep', '2026-10-31', 'browser sweep']
  );

  // The ZH121 drill: one SKU labelled 优惠前 ("before discounts"), one with no label. The label
  // stays words beside the price; the price is price_cny.
  const drill = itemOf(v1, '1053109777521');
  assert.deepEqual(
    drill.skus.map((s) => [s.sku_key, s.price, s.price_label, s.quantity]),
    [
      ['6089953933955', '99', '', 0],
      ['6264995743059', '40', '优惠前', 59],
    ]
  );
  assert.deepEqual(
    [drill.url, drill.page_host, drill.category, drill.sourcing, drill.freight_route, drill.codes],
    ['https://detail.tmall.com/item.htm?id=1053109777521', 'detail.tmall.com', 'tool', 'CHINA_CNY', 'CHINA_SEA_OR_AIR', ['ZH121']]
  );
  assert.equal(drill.title, '拓竹 3D打印模型手捻钻高达手办文玩钻孔工具手工diy扩孔器 创客宝库-ZH121');
  assert.deepEqual(drill.props, tmallSample().items[0].props, 'the option groups are kept as captured');

  // Decimals exactly as captured: 19.7 and 22.6 stay "19.7" and "22.6", 2.1 stays "2.1".
  const lamp = itemOf(v1, '846915661262');
  assert.deepEqual(lamp.skus.slice(0, 4).map((s) => s.price), ['21', '19.7', '22.6', '19.7']);
  assert.deepEqual(lamp.skus.find((s) => s.sku_key === '5796898454865')?.codes, ['DY002'], "a SKU's own part code is kept");
  assert.equal(itemOf(v1, '785492874870').skus[0].price, '2.1');

  for (const it of v1.items) {
    for (const s of it.skus) {
      assert.match(s.price, DECIMAL, `${it.item_key}/${s.sku_key} price`);
      assert.ok(s.price_label === '' || s.price_label === '优惠前', `${it.item_key}/${s.sku_key} label is words: ${s.price_label}`);
      assert.equal(s.sku_code, '', 'Tmall shows no Bambu SKU code');
    }
  }
});

test('Tmall: SKUs the capture marks not for sale are dropped and listed, and an item left with none is dropped', () => {
  const { file, report } = normalizeTmall(tmallSample());
  const v1 = v1Of(file);
  assert.deepEqual(
    report.refused_skus.map((r) => [r.item_key, r.sku_key, r.reason, r.detail]),
    [
      ['846915661262', '5796898454872', 'not_for_sale', 'placeholder_option'],
      ['742608647813', '6197429735840', 'not_for_sale', 'placeholder_option'],
      ['1092658088711', '6315625903081', 'not_for_sale', 'placeholder_price'],
      ['1092658088711', '6315625903083', 'not_for_sale', 'placeholder_price'],
    ]
  );
  assert.deepEqual(report.dropped_items, [{ item_key: '1092658088711', reason: 'no_priced_sku' }]);
  assert.deepEqual(
    v1.items.map((i) => i.item_key),
    ['1053109777521', '846915661262', '742608647813', '785492874870']
  );
  assert.deepEqual([report.items_read, report.items, report.skus], [5, 4, 14]);
  const prices = v1.items.flatMap((i) => i.skus.map((s) => s.price));
  assert.ok(!prices.includes('9999') && !prices.includes('99999'), 'no placeholder price reaches the file');
  assert.deepEqual(itemOf(v1, '742608647813').skus.map((s) => [s.sku_key, s.price]), [['5293816695460', '115']]);
});

test('Tmall: a hidden price, a failed capture or no SKU price drops the item; a figure in price_title is dropped and never becomes the price', () => {
  const snap = tmallSample();
  const drill = snap.items[0];
  snap.items.push({ ...clone(drill), item_id: '900000000001', hidden_price: true });
  snap.items.push({ ...clone(drill), item_id: '900000000002', ok: false });
  snap.items.push({ ...clone(drill), item_id: '900000000003', skus: [] });
  // No price_cny, but a figure where the label goes: the SKU is refused, never priced from it.
  const figure = { ...clone(drill), item_id: '900000000004' };
  figure.skus = [
    { ...figure.skus[0], price_cny: null, price_title: '75' },
    { ...figure.skus[1], price_title: '¥40' },
  ];
  snap.items.push(figure);
  // A binary float, three decimals and a range are refused, never rounded or guessed.
  const floats = { ...clone(drill), item_id: '900000000005' };
  floats.skus = [
    { ...floats.skus[0], price_cny: 0.30000000000000004 },
    { ...floats.skus[1], price_cny: 12.345 },
    { ...floats.skus[1], sku_id: '6264995743060', price_cny: '99-199' },
  ];
  snap.items.push(floats);

  const { file, report } = normalizeTmall(snap);
  const v1 = v1Of(file);
  const dropped = Object.fromEntries(report.dropped_items.map((d) => [d.item_key, d.reason]));
  assert.equal(dropped['900000000001'], 'hidden_price');
  assert.equal(dropped['900000000002'], 'capture_failed');
  assert.equal(dropped['900000000003'], 'no_priced_sku');
  assert.equal(dropped['900000000005'], 'no_priced_sku');
  for (const key of ['900000000001', '900000000002', '900000000003', '900000000005']) assert.ok(!v1.items.some((i) => i.item_key === key), key);

  const refused = report.refused_skus.filter((r) => r.item_key.startsWith('9000000000')).map((r) => [r.item_key, r.sku_key, r.reason]);
  assert.deepEqual(refused, [
    ['900000000004', '6089953933955', 'price_missing'],
    ['900000000005', '6089953933955', 'price_not_two_decimals'],
    ['900000000005', '6264995743059', 'price_not_two_decimals'],
    ['900000000005', '6264995743060', 'price_invalid'],
  ]);
  const kept = itemOf(v1, '900000000004');
  assert.deepEqual(
    kept.skus.map((s) => [s.sku_key, s.price, s.price_label]),
    [['6264995743059', '40', '']],
    'the price is price_cny; the figure in the label is dropped'
  );
  assert.ok(report.notes.some((n) => n.item_key === '900000000004' && n.note === 'price_title_figure_dropped'));
});

// ---------------------------------------------------------------- normalize-eu-snapshot.mjs

test('EU snapshot: bambu_eu in EUR, the handle, the product URL with skr=yes, the variant id, exact prices', () => {
  const { file, report } = normalizeEu(euSample());
  const v1 = v1Of(file);
  assert.deepEqual(
    [v1.source, v1.currency, v1.price_basis, v1.capture, v1.captured_on, v1.captured_by],
    ['bambu_eu', 'EUR', 'list', 'browser_sweep', '2026-10-31', 'browser sweep (?skr=yes)']
  );

  const h2d = itemOf(v1, 'h2d');
  assert.deepEqual(
    [h2d.url, h2d.page_host, h2d.title, h2d.name_en, h2d.category, h2d.sourcing, h2d.freight_route],
    ['https://eu.store.bambulab.com/products/h2d?skr=yes', 'eu.store.bambulab.com', 'Bambu Lab H2D', 'Bambu Lab H2D', 'printer', 'EU_STORE_EUR', 'GERMANY_LAND']
  );
  assert.deepEqual(h2d.skus[0], {
    sku_key: '596571526982115329',
    options: { option1: 'H2D AMS Combo', option2: 'Standard' },
    options_en: { option1: 'H2D AMS Combo', option2: 'Standard' },
    price: '1599',
    price_label: '',
    quantity: null,
    sku_code: '',
    codes: [],
  });
  assert.deepEqual(
    h2d.skus.map((s) => s.price),
    ['1599', '1949', '2299', '1399', '1699', '1849']
  );
  assert.deepEqual(itemOf(v1, 'filament-buffer').skus.map((s) => [s.sku_key, s.price]), [['43719762903259', '27.99']]);
  assert.deepEqual(itemOf(v1, 'filament-buffer').category, 'spare_part');
  // OutOfStock is a stock of 0; InStock says nothing about how many.
  assert.deepEqual(
    itemOf(v1, 'h2c').skus.map((s) => [s.sku_key, s.quantity]),
    [
      ['666136020008767488', null],
      ['666136020008767498', 0],
      ['666136020008767503', 0],
      ['761060179809759232', null],
    ]
  );
  // A product name that itself holds " - ": the options are what follows the whole name.
  assert.deepEqual(itemOf(v1, 'vision-encoder-r1').skus[0].options, { option1: 'R1' });
  assert.deepEqual(itemOf(v1, 'toolhead-enhanced-cooling-fan').skus[1].options, { option1: 'H2C and H2C Laser', option2: 'Replacement', option3: 'Spare' });
  // A handle captured percent-encoded is the decoded handle (as the import and the manifest hold it).
  const iron = itemOf(v1, 'usb\u2011c-soldering-iron-kit-for-heat-set-inserts');
  assert.equal(iron.url, 'https://eu.store.bambulab.com/products/usb%E2%80%91c-soldering-iron-kit-for-heat-set-inserts?skr=yes');

  // The H2D Pro's one variant has no price: refused, and the product, left with none, dropped.
  assert.deepEqual(report.refused_variants, [{ handle: 'h2d-pro', sku: '631286032295866372', reason: 'price_missing', detail: 'null' }]);
  assert.deepEqual(report.dropped_products, [{ handle: 'h2d-pro', reason: 'no_priced_variant' }]);
  assert.deepEqual([report.products_read, report.items, report.skus], [8, 7, 18]);

  for (const it of v1.items) {
    assert.equal(new URL(it.url).searchParams.get('skr'), 'yes', `${it.item_key} url carries skr=yes`);
    for (const s of it.skus) assert.match(s.price, DECIMAL);
  }
  // Every price is the snapshot's own number written as text, character for character.
  const source = new Map(euSample().products.flatMap((p) => p.variants.map((v) => [v.sku, v.price_eur] as const)));
  for (const s of v1.items.flatMap((i) => i.skus)) assert.equal(s.price, JSON.stringify(source.get(s.sku_key)));
});

test('EU snapshot: another currency, another host, a missing price or a float is refused, never relabelled or rounded', () => {
  const snap = euSample();
  const h2d = snap.products.find((p) => p.handle === 'h2d')!;
  // Another region's store answered: the assembler keeps its figure as price_shown, price_eur null.
  Object.assign(h2d.variants[0], { currency: 'USD', price_eur: null, price_shown: 1599 });
  h2d.variants[1].url = 'https://us.store.bambulab.com/products/h2d?id=596571526990503937';
  h2d.variants[2].price_eur = 0.30000000000000004;
  h2d.variants[3].price_eur = 12.345;
  delete h2d.variants[4].price_eur;
  snap.products.find((p) => p.handle === 'h2c')!.url = 'https://us.store.bambulab.com/products/h2c';

  const { file, report } = normalizeEu(snap);
  const v1 = v1Of(file);
  assert.deepEqual(
    report.refused_variants.filter((r) => r.handle === 'h2d').map((r) => [r.sku, r.reason, r.detail]),
    [
      ['596571526982115329', 'currency_not_eur', 'USD'],
      ['596571526990503937', 'not_eu_store_url', 'https://us.store.bambulab.com/products/h2d?id=596571526990503937'],
      ['596571526990503942', 'price_not_two_decimals', '0.30000000000000004'],
      ['596571526990503947', 'price_not_two_decimals', '12.345'],
      ['622679523065323523', 'price_missing', undefined],
    ]
  );
  assert.deepEqual(itemOf(v1, 'h2d').skus.map((s) => [s.sku_key, s.price]), [['789701095558488064', '1849']]);
  assert.ok(report.dropped_products.some((d) => d.handle === 'h2c' && d.reason === 'not_eu_store_url'));
  assert.ok(!v1.items.some((i) => i.item_key === 'h2c'));
  const prices = v1.items.flatMap((i) => i.skus.map((s) => s.price));
  for (const never of ['12.35', '0.3', '0.30000000000000004', '12.345']) assert.ok(!prices.includes(never), never);
});

test('EU snapshot: a product without its address gets the store page built from its handle; a malformed handle or variant id is refused', () => {
  const snap = euSample();
  const buffer = snap.products.find((p) => p.handle === 'filament-buffer')!;
  buffer.url = null;
  buffer.variants[0].url = null;
  snap.products.push({ ...clone(buffer), handle: 'Not A/Handle' });
  const laser = snap.products.find((p) => p.handle === 'laser-module')!;
  laser.variants[0].sku = 'not an id';
  laser.variants[1].sku = null; // its url still carries the variant id (?id=…)
  const { file, report } = normalizeEu(snap);
  const v1 = v1Of(file);
  assert.equal(itemOf(v1, 'filament-buffer').url, 'https://eu.store.bambulab.com/products/filament-buffer?skr=yes');
  assert.ok(report.dropped_products.some((d) => d.handle === 'not a/handle' && d.reason === 'bad_handle'));
  assert.deepEqual(
    itemOf(v1, 'laser-module').skus.map((s) => s.sku_key),
    ['686086595042648067', '686086595042648072']
  );
  assert.ok(report.refused_variants.some((r) => r.handle === 'laser-module' && r.sku === 'not an id' && r.reason === 'bad_sku'));
});

test('EU snapshot: options come from option_values, else from the variant name, alike; a colour code goes to the SKU codes', () => {
  const withValues = v1Of(normalizeEu(euSample()).file);
  const snap = euSample();
  for (const p of snap.products) for (const v of p.variants) delete v.option_values;
  const fromNames = v1Of(normalizeEu(snap).file);
  assert.deepEqual(fromNames.items, withValues.items, 'the snapshot rule and the name rule agree');

  assert.deepEqual(optionValuesFromName('Bambu Lab H2D - H2D AMS Combo / Standard', 'Bambu Lab H2D'), ['H2D AMS Combo', 'Standard']);
  assert.deepEqual(optionValuesFromName('Vision Encoder - R1 - R1', 'Vision Encoder - R1'), ['R1']);
  assert.deepEqual(optionValuesFromName('Filament Buffer', 'Filament Buffer'), []);
  assert.deepEqual(optionValuesFromName('PLA Basic \u2013 Jade White (10100) / Refill / 1kg', 'PLA Basic'), ['Jade White (10100)', 'Refill', '1kg'], 'any dash is a plain one');

  const coloured = euSample();
  Object.assign(coloured.products.find((p) => p.handle === 'filament-buffer')!.variants[0], { option_values: ['Jade White (10100)'], colour_code: '10100' });
  const sku = itemOf(v1Of(normalizeEu(coloured).file), 'filament-buffer').skus[0];
  assert.deepEqual([sku.options, sku.codes], [{ option1: 'Jade White (10100)' }, ['10100']]);
});

// ---------------------------------------------------------------- the two command lines

/** A normaliser run as the owner runs it: bare node, the input path as its one argument. */
function cli(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'supplier-prices', script), ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('the normalisers write <name>.v1.json beside their input, only a file the parser accepts, and nothing when nothing is priced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lv-supplier-capture-'));
  try {
    const tmall = join(dir, 'tmall-store-2026-10-31.json');
    copyFileSync(join(FIX, 'tmall-store-2026-10-31.sample.json'), tmall);
    const t = cli('normalize-tmall.mjs', tmall);
    assert.equal(t.status, 0, t.stderr);
    const tOut = join(dir, 'tmall-store-2026-10-31.v1.json');
    assert.deepEqual(JSON.parse(t.stdout).output, tOut);
    assert.equal(parseSupplierPriceFile(readFileSync(tOut, 'utf8')).items.length, 4);

    const eu = join(dir, 'eu-store-2026-10-31.json');
    copyFileSync(join(FIX, 'eu-store-2026-10-31.sample.json'), eu);
    const e = cli('normalize-eu-snapshot.mjs', eu, '--captured-by', 'owner, browser with ?skr=yes');
    assert.equal(e.status, 0, e.stderr);
    const eOut = join(dir, 'eu-store-2026-10-31.v1.json');
    const written = parseSupplierPriceFile(readFileSync(eOut, 'utf8'));
    assert.deepEqual([written.source, written.currency, written.captured_by, written.items.length], ['bambu_eu', 'EUR', 'owner, browser with ?skr=yes', 7]);
    assert.deepEqual(written, v1Of({ ...(normalizeEu(euSample()).file as object), captured_by: 'owner, browser with ?skr=yes' }));

    // Nothing priced: exit 2 and no file.
    const empty = join(dir, 'tmall-store-2026-11-01.json');
    writeFileSync(empty, JSON.stringify({ captured_on: '2026-11-01', items: [tmallSample().items[4]] }));
    const none = cli('normalize-tmall.mjs', empty);
    assert.equal(none.status, 2, none.stderr);
    assert.equal(JSON.parse(none.stdout).written, false);
    assert.ok(!existsSync(join(dir, 'tmall-store-2026-11-01.v1.json')));

    // A v1 file is not a snapshot, and a snapshot without a date is refused: exit 1, nothing written.
    assert.equal(cli('normalize-eu-snapshot.mjs', eOut).status, 1);
    const undated = join(dir, 'eu-store-undated.json');
    writeFileSync(undated, JSON.stringify({ products: euSample().products }));
    assert.equal(cli('normalize-eu-snapshot.mjs', undated).status, 1);
    assert.ok(!existsSync(join(dir, 'eu-store-undated.v1.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- capture-store-offers.ts

test('the JSON-LD reader on stored pages: every variant with its id, price, currency, availability and address', () => {
  const h2d = readStoreOffers(fixtureText('eu-h2d.page.html'));
  assert.ok(h2d);
  assert.deepEqual([h2d.name, h2d.url, h2d.productGroupId, h2d.variants.length], ['Bambu Lab H2D', 'https://eu.store.bambulab.com/products/h2d', '14937650200924', 6]);
  assert.deepEqual(h2d.variants[0], {
    sku: '596571526982115329',
    mpn: '',
    name: 'Bambu Lab H2D - H2D AMS Combo / Standard',
    price: 1599,
    currency: 'EUR',
    availability: 'https://schema.org/InStock',
    url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329',
  });
  const pla = readStoreOffers(fixtureText('us-pla-basic-filament.page.html'));
  assert.deepEqual(
    pla?.variants.map((v) => [v.sku, v.price, v.currency]),
    [
      ['40475106640008', 15.99, 'USD'],
      ['41078274687112', 18.99, 'USD'],
      ['41078274654344', 18.99, 'USD'],
    ]
  );
  assert.equal(readStoreOffers(fixtureText('challenge.page.html')), null, 'a challenge page has no offers');

  // A lone Product, an AggregateOffer, an @graph, and a broken block beside a good one.
  const ld = (o: unknown) => `<script type="application/ld+json">${typeof o === 'string' ? o : JSON.stringify(o)}</script>`;
  const lone = readStoreOffers(ld({ '@type': 'Product', name: 'X', sku: '1', offers: { '@type': 'AggregateOffer', offers: [{ '@type': 'Offer', price: '9.50', priceCurrency: 'eur' }] } }));
  assert.deepEqual(lone?.variants.map((v) => [v.sku, v.price, v.currency]), [['1', '9.50', 'EUR']]);
  const graph = readStoreOffers(`${ld('{not json')}${ld({ '@graph': [{ '@type': 'Organization' }, { '@type': 'ProductGroup', name: 'G', hasVariant: { '@type': 'Product', sku: '2', offers: [{ price: 3, priceCurrency: 'USD' }] } }] })}`);
  assert.deepEqual(graph?.variants.map((v) => [v.sku, v.price]), [['2', 3]]);
  // A variant id written as a JSON number past 2^53 has already lost digits: it is no id.
  const unsafe = readStoreOffers(ld({ '@type': 'ProductGroup', hasVariant: [{ '@type': 'Product', sku: 2 ** 60, offers: { price: 1 } }] }));
  assert.equal(unsafe?.variants[0].sku, '');
});

test('withSkipRegionRedirect sets skr=yes and keeps the rest; only the EU fetch adds it', async () => {
  assert.equal(withSkipRegionRedirect('https://eu.store.bambulab.com/products/h2d'), 'https://eu.store.bambulab.com/products/h2d?skr=yes');
  assert.equal(withSkipRegionRedirect('https://eu.store.bambulab.com/products/h2d?id=596571526982115329'), 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes');
  assert.equal(withSkipRegionRedirect('https://eu.store.bambulab.com/products/h2d?skr=no'), 'https://eu.store.bambulab.com/products/h2d?skr=yes');
  const seen: string[] = [];
  const inner: FetchLike = async (url) => {
    seen.push(url);
    return new Response('');
  };
  await storeFetch('eu', inner)('https://eu.store.bambulab.com/robots.txt', {});
  await storeFetch('us', inner)('https://us.store.bambulab.com/products/h2d', {});
  assert.deepEqual(seen, ['https://eu.store.bambulab.com/robots.txt?skr=yes', 'https://us.store.bambulab.com/products/h2d']);
});

// The store, stubbed: a route per path; every address sent is recorded.
type Route = () => Response;
const page = (name: string, status = 200) => () => new Response(fixtureText(name), { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const gone = () => new Response('not found', { status: 404 });

function stubStore(host: string, routes: Record<string, Route>) {
  const sent: string[] = [];
  const unexpected: string[] = [];
  const fetch: FetchLike = async (url) => {
    sent.push(url);
    const u = new URL(url);
    const route = u.hostname === host ? routes[u.pathname] : undefined;
    if (!route) {
      unexpected.push(url);
      return new Response('', { status: 500 });
    }
    return route();
  };
  return { fetch, sent, unexpected };
}

function fakeClock(start = Date.parse('2026-10-31T08:00:00Z')) {
  let now = start;
  const slept: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
  return { clock, slept };
}

const row = (handle: string, type: string): ManifestRow => ({
  queue_position: 1,
  source_product_id: '1',
  handle,
  seo_code_raw: handle,
  canonical_url: `https://us.store.bambulab.com/products/${handle}`,
  title: handle,
  type,
});

async function capture(store: 'us' | 'eu', rows: ManifestRow[], routes: Record<string, Route>) {
  const stub = stubStore(store === 'eu' ? 'eu.store.bambulab.com' : 'us.store.bambulab.com', routes);
  const { clock, slept } = fakeClock();
  const result: CaptureResult = await captureStoreOffers({ store, rows, fetch: stub.fetch, clock, deadline: new Deadline(clock.now() + 24 * 3600_000, clock) });
  assert.deepEqual(stub.unexpected, [], 'no request outside the stubbed store');
  return { ...result, sent: stub.sent, slept };
}

test('--store eu: skr=yes on every request; a redirected page is listed as redirected; a USD page is refused; robots.txt is obeyed', async () => {
  const run = await capture('eu', [row('h2d', 'printer'), row('h2c', 'printer'), row('x2d', 'printer'), row('pla-basic-filament', 'filament'), row('a1-mini', 'printer')], {
    '/robots.txt': text(fixtureText('robots.txt')),
    '/products/h2d': page('eu-h2d.page.html'),
    '/products/h2c': page('eu-h2c.page.html'),
    // The store sends this page to another region's store: never followed, never captured.
    '/products/x2d': redirect('https://us.store.bambulab.com/products/x2d'),
    // Another region's store answered on the EU address: its USD is never labelled EUR.
    '/products/pla-basic-filament': page('us-pla-basic-filament.page.html'),
  });

  assert.deepEqual(
    run.sent,
    [
      'https://eu.store.bambulab.com/robots.txt?skr=yes',
      'https://eu.store.bambulab.com/products/h2d?skr=yes',
      'https://eu.store.bambulab.com/products/h2c?skr=yes',
      'https://eu.store.bambulab.com/products/x2d?skr=yes',
      'https://eu.store.bambulab.com/products/pla-basic-filament?skr=yes',
    ],
    'every request carries skr=yes; the disallowed page is never requested'
  );
  assert.ok(run.slept.length >= 4 && run.slept.every((ms) => ms >= 11_000), 'the import’s 11 s spacing holds between requests');
  const r = run.report;
  assert.deepEqual(r.redirected, [{ handle: 'x2d', status: 302 }]);
  assert.deepEqual(r.refused, [{ handle: 'pla-basic-filament', reason: 'currency_mismatch', detail: 'USD' }]);
  assert.deepEqual(r.robots_disallowed, ['a1-mini']);
  assert.deepEqual([r.captured, r.stopped, r.requests, r.items, r.skus], [['h2d', 'h2c'], null, 5, 2, 10]);

  const v1 = v1Of(run.file);
  assert.deepEqual([v1.source, v1.currency, v1.price_basis, v1.capture, v1.captured_on, v1.captured_by], ['bambu_eu', 'EUR', 'list', 'store_script', '2026-10-31', 'capture-store-offers.ts --store eu']);
  const h2d = itemOf(v1, 'h2d');
  assert.deepEqual([h2d.url, h2d.page_host, h2d.title, h2d.category], ['https://eu.store.bambulab.com/products/h2d?skr=yes', 'eu.store.bambulab.com', 'Bambu Lab H2D', 'printer']);
  assert.deepEqual(
    itemOf(v1, 'h2c').skus.map((s) => [s.sku_key, s.price, s.quantity]),
    [
      ['666136020008767488', '1799', null],
      ['666136020008767498', '2149', 0],
      ['666136020008767503', '2499', 0],
      ['761060179809759232', '2019', null],
    ]
  );
  // The store page and the browser snapshot of the same product give the same SKUs.
  const fromSnapshot = itemOf(v1Of(normalizeEu(euSample()).file), 'h2d');
  assert.deepEqual(h2d.skus, fromSnapshot.skus);
});

test('--store eu on a sale day: the regular (struck-through) price is written; the sale price is listed in on_sale and never written', async () => {
  const run = await capture('eu', [row('a1', 'printer'), row('h2c', 'printer')], {
    '/robots.txt': gone,
    // A1: a list holding the sale price and the StrikethroughPrice (the schema.org URL).
    '/products/a1': page('eu-a1-sale.page.html'),
    // H2C: one StrikethroughPrice object (the bare name).
    '/products/h2c': page('eu-h2c-sale.page.html'),
  });
  const v1 = v1Of(run.file);
  assert.deepEqual([v1.price_basis, run.report.captured], ['list', ['a1', 'h2c']]);
  assert.deepEqual(
    itemOf(v1, 'a1').skus.map((s) => [s.sku_key, s.price, s.price_label]),
    [
      ['599117150694776840', '259', ''],
      ['599117150694776844', '369', ''],
    ]
  );
  assert.deepEqual(
    itemOf(v1, 'h2c').skus.map((s) => [s.sku_key, s.price, s.quantity]),
    [
      ['666136020008767488', '2149', null],
      ['666136020008767498', '2549', 0],
      ['666136020008767503', '2949', 0],
      ['761060179809759232', '2449', null],
    ]
  );
  assert.deepEqual(run.report.on_sale, [
    { handle: 'a1', sku: '599117150694776840', price: '259', sale_price: '239' },
    { handle: 'a1', sku: '599117150694776844', price: '369', sale_price: '339' },
    { handle: 'h2c', sku: '666136020008767488', price: '2149', sale_price: '1799' },
    { handle: 'h2c', sku: '666136020008767498', price: '2549', sale_price: '2149' },
    { handle: 'h2c', sku: '666136020008767503', price: '2949', sale_price: '2499' },
    { handle: 'h2c', sku: '761060179809759232', price: '2449', sale_price: '2019' },
  ]);
  const written = new Set(v1.items.flatMap((i) => i.skus.map((s) => `${i.item_key}|${s.sku_key}|${s.price}`)));
  for (const s of run.report.on_sale) assert.ok(!written.has(`${s.handle}|${s.sku}|${s.sale_price}`), `${s.handle}/${s.sku}: the sale price is never written`);
  assert.deepEqual([run.report.refused, run.report.refused_variants], [[], []]);

  // The browser snapshot of the same day (assemble-snapshot.mjs: price_eur is the regular price,
  // sale_price_eur beside it) gives the same SKUs and lists the same sales.
  const variant = (handle: string, sku: string, name: string, regular: number, sale: number, availability: string) => ({
    sku,
    name,
    colour_code: null,
    price_eur: regular,
    sale_price_eur: sale,
    on_sale: true,
    currency: 'EUR',
    availability,
    url: `https://eu.store.bambulab.com/products/${handle}?id=${sku}`,
  });
  const snapshot = {
    captured_on: '2026-10-31',
    products: [
      {
        handle: 'a1',
        name: 'Bambu Lab A1 3D Printer',
        type: 'printer',
        url: 'https://eu.store.bambulab.com/products/a1',
        variants: [
          variant('a1', '599117150694776840', 'Bambu Lab A1 3D Printer - A1', 259, 239, 'InStock'),
          variant('a1', '599117150694776844', 'Bambu Lab A1 3D Printer - A1 Combo', 369, 339, 'InStock'),
        ],
      },
      {
        handle: 'h2c',
        name: 'Bambu Lab H2C',
        type: 'printer',
        url: 'https://eu.store.bambulab.com/products/h2c',
        variants: [
          variant('h2c', '666136020008767488', 'Bambu Lab H2C - H2C AMS Combo / Standard', 2149, 1799, 'InStock'),
          variant('h2c', '666136020008767498', 'Bambu Lab H2C - H2C Laser Full Combo / 10W Laser', 2549, 2149, 'OutOfStock'),
          variant('h2c', '666136020008767503', 'Bambu Lab H2C - H2C Laser Full Combo / 40W Laser', 2949, 2499, 'OutOfStock'),
          variant('h2c', '761060179809759232', 'Bambu Lab H2C - H2C Vortek Ultimate Bundle / Standard', 2449, 2019, 'InStock'),
        ],
      },
    ],
  };
  const fromSnapshot = normalizeEu(snapshot);
  const snap = v1Of(fromSnapshot.file);
  assert.deepEqual(itemOf(snap, 'a1').skus, itemOf(v1, 'a1').skus);
  assert.deepEqual(itemOf(snap, 'h2c').skus, itemOf(v1, 'h2c').skus);
  assert.deepEqual(fromSnapshot.report.on_sale, run.report.on_sale);
  // A snapshot with no sale lists none.
  assert.deepEqual(normalizeEu(euSample()).report.on_sale, []);
});

test('--store eu: a same-product redirect is followed once, still with skr=yes; another product, an error and foreign offer addresses are listed and the run goes on', async () => {
  const foreignOffers = fixtureText('eu-filament-buffer.page.html').replaceAll('https://eu.store.bambulab.com/products/filament-buffer?id=', 'https://us.store.bambulab.com/products/filament-buffer?id=');
  const run = await capture('eu', [row('h2c', 'printer'), row('x2d', 'printer'), row('a1', 'printer'), row('filament-buffer', 'spare_part'), row('h2d', 'printer')], {
    '/robots.txt': gone,
    '/products/h2c': redirect('/products/h2c/', 301),
    '/products/h2c/': page('eu-h2c.page.html'),
    '/products/x2d': redirect('https://eu.store.bambulab.com/products/x2d-combo', 301),
    '/products/a1': text('busy', 500),
    '/products/filament-buffer': () => new Response(foreignOffers, { status: 200 }),
    '/products/h2d': page('eu-h2d.page.html'),
  });
  assert.ok(run.sent.includes('https://eu.store.bambulab.com/products/h2c/?skr=yes'), 'the followed redirect carries skr=yes too');
  assert.ok(run.sent.every((u) => new URL(u).searchParams.get('skr') === 'yes'), run.sent.join(' '));
  const r = run.report;
  assert.deepEqual(r.redirected, [{ handle: 'x2d', status: 301, to_other_product: true }]);
  assert.deepEqual(r.failed, [{ handle: 'a1', code: 'STORE_UNAVAILABLE', during: 'page', status: 500 }]);
  assert.deepEqual(r.refused, [{ handle: 'filament-buffer', reason: 'offer_host_mismatch', detail: 'us.store.bambulab.com' }]);
  assert.deepEqual([r.captured, r.stopped], [['h2c', 'h2d'], null]);
  assert.equal(itemOf(v1Of(run.file), 'h2c').url, 'https://eu.store.bambulab.com/products/h2c?skr=yes');
});

test('a challenge stops the run with what it has captured; nothing works around it', async () => {
  const run = await capture('eu', [row('h2d', 'printer'), row('filament-buffer', 'spare_part'), row('h2c', 'printer')], {
    '/robots.txt': gone,
    '/products/h2d': page('eu-h2d.page.html'),
    // A 200 whose body is Cloudflare's "Just a moment...".
    '/products/filament-buffer': page('challenge.page.html'),
    '/products/h2c': page('eu-h2c.page.html'),
  });
  assert.deepEqual(run.report.stopped, { code: 'ACCESS_CHALLENGE', handle: 'filament-buffer', during: 'page', status: 200 });
  assert.equal(run.report.not_reached, 1);
  assert.deepEqual(run.sent, ['https://eu.store.bambulab.com/robots.txt?skr=yes', 'https://eu.store.bambulab.com/products/h2d?skr=yes', 'https://eu.store.bambulab.com/products/filament-buffer?skr=yes']);
  assert.deepEqual(v1Of(run.file).items.map((i) => i.item_key), ['h2d']);

  // A 403 with Cloudflare's header, on robots.txt itself: no page is read at all.
  const blocked = await capture('eu', [row('h2d', 'printer')], {
    '/robots.txt': () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
  });
  assert.deepEqual(blocked.report.stopped, { code: 'ACCESS_CHALLENGE', handle: 'h2d', during: 'robots', status: 403 });
  assert.deepEqual([blocked.file, blocked.sent.length], [null, 1]);
});

test('--store us: no request carries skr=yes; USD is kept with its colour codes, and a EUR page is refused', async () => {
  const run = await capture('us', [row('pla-basic-filament', 'filament'), row('h2d', 'printer'), row('p1s', 'printer')], {
    '/robots.txt': gone,
    '/products/pla-basic-filament': page('us-pla-basic-filament.page.html'),
    '/products/h2d': page('eu-h2d.page.html'),
    '/products/p1s': gone,
  });
  assert.ok(run.sent.every((u) => !u.includes('skr') && u.startsWith('https://us.store.bambulab.com/')), run.sent.join(' '));
  assert.deepEqual(run.report.refused, [{ handle: 'h2d', reason: 'currency_mismatch', detail: 'EUR' }]);
  assert.deepEqual(run.report.withdrawn, [{ handle: 'p1s', status: 404 }]);
  const v1 = v1Of(run.file);
  assert.deepEqual([v1.source, v1.currency], ['bambu_us', 'USD']);
  const pla = itemOf(v1, 'pla-basic-filament');
  assert.deepEqual([pla.url, pla.page_host, pla.category], ['https://us.store.bambulab.com/products/pla-basic-filament', 'us.store.bambulab.com', 'filament']);
  assert.deepEqual(pla.skus[0], {
    sku_key: '40475106640008',
    options: { option1: 'Jade White (10100)', option2: 'Refill', option3: '1kg' },
    options_en: { option1: 'Jade White (10100)', option2: 'Refill', option3: '1kg' },
    price: '15.99',
    price_label: '',
    quantity: null,
    sku_code: '',
    codes: ['10100'],
  });
  assert.deepEqual(pla.skus.map((s) => s.price), ['15.99', '18.99', '18.99']);
});

test('the capture command line: arguments, the manifest selection, and a run that writes the checked file', async () => {
  assert.throws(() => parseArgs([]), /--store is required/);
  assert.throws(() => parseArgs(['--store', 'cn']), /us or eu/);
  assert.throws(() => parseArgs(['--store', 'eu', '--store', 'us']), /repeated/);
  assert.throws(() => parseArgs(['--store', 'eu', '--limit', '0']), /positive whole number/);
  assert.throws(() => parseArgs(['--store', 'eu', '--spacing', '1']), /unknown argument/);
  const args = parseArgs(['--store', 'eu', '--handles', 'h2d, a1', '--types', 'printer', '--limit', '5', '--date', '2026-10-31']);
  assert.deepEqual([args.store, args.handles, args.types, args.limit, args.date], ['eu', ['h2d', 'a1'], ['printer'], 5, '2026-10-31']);

  const rows = [row('h2d', 'printer'), row('a1', 'printer'), row('filament-buffer', 'spare_part'), row('h2c', 'printer')];
  assert.deepEqual(selectRows(rows, { handles: ['H2D', 'filament-buffer'] }).map((r) => r.handle), ['h2d', 'filament-buffer']);
  assert.deepEqual(selectRows(rows, { types: ['printer'], limit: 2 }).map((r) => r.handle), ['h2d', 'a1']);
  assert.deepEqual(handlesOfList({ captured_on: '2026-10-31', rows: [{ handle: 'h2d', type: 'printer' }, { title: 'no handle' }] }), ['h2d']);
  assert.deepEqual(handlesOfList({ handles: ['refurbished-p1s'] }), ['refurbished-p1s']);

  const dir = mkdtempSync(join(tmpdir(), 'lv-store-offers-'));
  try {
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ rows }));
    const out = join(dir, 'eu-offers.v1.json');
    const stub = stubStore('eu.store.bambulab.com', { '/robots.txt': gone, '/products/h2d': page('eu-h2d.page.html'), '/products/h2c': page('eu-h2c.page.html') });
    const logs: string[] = [];
    const { clock } = fakeClock();
    const code = await main(['--store', 'eu', '--manifest', manifest, '--handles', 'h2d,h2c', '--out', out], {
      fetch: stub.fetch,
      clock,
      log: { log: (s: string) => logs.push(s), error: (s: string) => logs.push(`ERR ${s}`) },
    });
    assert.equal(code, 0, logs.join('\n'));
    assert.ok(stub.sent.every((u) => u.includes('skr=yes')));
    const written = parseSupplierPriceFile(readFileSync(out, 'utf8'));
    assert.deepEqual([written.source, written.capture, written.items.map((i) => i.item_key)], ['bambu_eu', 'store_script', ['h2d', 'h2c']]);
    assert.equal(JSON.parse(logs[0]).output, out);

    const none = await main(['--store', 'eu', '--manifest', manifest, '--handles', 'not-a-product'], { fetch: stub.fetch, clock, log: { log: () => {}, error: () => {} } });
    assert.equal(none, 1, 'a selection that matches no manifest row is refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
