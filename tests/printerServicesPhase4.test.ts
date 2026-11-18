/**
 * PRINTER SERVICES PHASE 4 — the config contract (DECISIONS row 355; plan-phase4 §B).
 *
 * Kit / add-on discounts (supersede phase 2's «kits: no discount»; packages still carry none), kit
 * colour modes, add-ons, store bundles per printer: validation, the back-compat read of a phase 3
 * list, the canonical round-trip, the publish checks, unitDiscount's arithmetic (percent, fixed
 * split, 90% cap, integers) and the phase 4 refusal codes.
 *
 * Run: node --import tsx --test tests/printerServicesPhase4.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  ADDON_CHANGED, ADDON_NOT_OFFERED, ADDON_UNAVAILABLE, ADDON_WITHOUT_PRINTER, DEFAULT_PRINTER_SERVICES, KIT_COLOR_UNAVAILABLE,
  MAX_ADDONS, MAX_STORE_BUNDLES, PHASE2_CODES, PHASE4_CODES, SERVICES_CODES,
  addonsForPrinter, canonicalConfig, configIssues, kitsForPrinter, publishIssues, servicesOffer, servicesOfferFor, storeBundleIdsFor,
  unitDiscount, withPhase2Defaults, withPhase4Defaults,
  type FilamentKit, type PrinterAddon, type PrinterServicesConfig,
} from '../packages/pricing/src/printerServices';
import { keepPhase4Fields, printerExtrasCatalogIssues, withAttachedLink } from '../worker/lib/printerServices';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const KIT: FilamentKit = {
  id: 'a1-starter', active: true, sort: 1,
  title: { ar: 'باقة البداية', en: 'Starter kit', ckb: 'پاکێجی دەستپێک' },
  items: [
    { product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 2, color_mode: 'customer' },
    { product_id: 'p_petg', option_value_ids: ['ov_1kg'], color_id: 'c_black', qty: 1, color_mode: 'fixed' },
  ],
  printers: [{ product_id: 'p_a1', option_value_id: null }],
  discount: { mode: 'percent', value: 10 },
};
const ADDON: PrinterAddon = {
  id: 'nozzle-04', active: true, sort: 2, title: null,
  product_id: 'p_nozzle', option_value_ids: [], color_id: null, color_mode: 'fixed', qty: 1,
  discount: { mode: 'fixed_iqd', value: 5_000 }, printers: null,
};

function config(over: Partial<PrinterServicesConfig> = {}): PrinterServicesConfig {
  return {
    ...DEFAULT_PRINTER_SERVICES, revision: 1,
    products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: ['b_starter', 'b_tools'] } },
    kits: [KIT], addons: [ADDON], ...over,
  };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const has = (issues: string[], needle: string) => assert.ok(issues.some((i) => i.includes(needle)), `${needle}: ${issues.join(' | ')}`);

test('a phase 4 config is valid; the seeded draft has no add-ons', () => {
  assert.deepEqual(configIssues(config()), []);
  assert.deepEqual(DEFAULT_PRINTER_SERVICES.addons, []);
  assert.deepEqual(configIssues(DEFAULT_PRINTER_SERVICES), []);
});

test('validation: the kit takes exactly one discount field; every other *discount* key is still refused (kits, items, add-ons, packages)', () => {
  const k = (over: Record<string, unknown>) => configIssues(config({ kits: [{ ...KIT, ...over } as unknown as FilamentKit] }));
  has(k({ discount_iqd: 5000 }), "kits[0].discount_iqd: a kit's only discount field is discount");
  has(k({ Discount_Pct: 5 }), 'kits[0].Discount_Pct');
  has(k({ discount: { mode: 'percent', value: 91 } }), 'kits[0].discount.value: whole percent 1..90');
  has(k({ discount: { mode: 'percent', value: 0 } }), 'kits[0].discount.value');
  has(k({ discount: { mode: 'percent', value: 12.5 } }), 'kits[0].discount.value');
  has(k({ discount: { mode: 'fixed_iqd', value: 10_000_001 } }), 'kits[0].discount.value: whole IQD 1..10000000');
  has(k({ discount: { mode: 'half', value: 5 } }), 'kits[0].discount: {mode');
  has(k({ discount: { mode: 'percent', value: 5, max_iqd: 1 } }), 'kits[0].discount: only mode and value');
  assert.deepEqual(k({ discount: null }), []);
  assert.deepEqual(k({ discount: { mode: 'fixed_iqd', value: 10_000_000 } }), []);
  const item = configIssues(config({ kits: [{ ...KIT, items: [{ ...KIT.items[0], discount: { mode: 'percent', value: 5 } }] } as unknown as FilamentKit] }));
  has(item, 'kits[0].items[0].discount: a discount belongs to the kit');
  const addon = configIssues(config({ addons: [{ ...ADDON, discount_pct: 5 } as unknown as PrinterAddon] }));
  has(addon, "addons[0].discount_pct: an add-on's only discount field is discount");
  // Packages: still no discount at all (owner ruling 2026-11-17 stands).
  const pk = clone(config());
  (pk.packages.smart as unknown as Record<string, unknown>).discount = { mode: 'percent', value: 5 };
  has(configIssues(pk), 'packages.smart.discount: packages carry no discount');
});

test('validation: colour modes, add-ons and store bundles', () => {
  const kitWith = (items: unknown[]) => configIssues(config({ kits: [{ ...KIT, items } as unknown as FilamentKit] }));
  has(kitWith([{ ...KIT.items[0], color_mode: 'rainbow' }]), 'kits[0].items[0].color_mode: fixed or customer');
  has(kitWith([{ ...KIT.items[0], color_id: 'c_red' }]), 'kits[0].items[0].color_id: null when the customer picks the colour');
  // A customer-colour product appears once in the kit (not again with a fixed colour, not twice as customer).
  has(kitWith([KIT.items[0], { ...KIT.items[0], color_mode: 'fixed', color_id: 'c_red' }]), 'kits[0].items[1]: a product whose colour the customer picks appears once');
  has(kitWith([{ ...KIT.items[0], color_mode: 'fixed', color_id: 'c_red' }, KIT.items[0]]), 'kits[0].items[1]: a product whose colour the customer picks appears once');
  // Two fixed colours of one product stay allowed (phase 2 behaviour).
  assert.deepEqual(kitWith([{ ...KIT.items[0], color_mode: 'fixed', color_id: 'c_red' }, { ...KIT.items[0], color_mode: 'fixed', color_id: 'c_blue' }]), []);

  const add = (list: unknown) => configIssues(config({ addons: list as PrinterAddon[] }));
  has(add('x'), 'addons: array');
  has(add(Array.from({ length: MAX_ADDONS + 1 }, (_, i) => ({ ...ADDON, id: `a${i}` }))), `addons: at most ${MAX_ADDONS}`);
  const bad = add([
    { ...ADDON, id: 'Bad Id', qty: 0 },
    { ...ADDON, qty: 21, title: { ar: 'x' } },
    { ...ADDON },
    { ...ADDON, id: 'colour', color_mode: 'customer', color_id: 'c_red', printers: [{ product_id: 'p_a1' }] },
  ]);
  for (const needle of ['addons[0].id', 'addons[0].qty: 1..20 per printer', 'addons[1].qty', 'addons[1].title', 'addons[2].id: used twice',
    'addons[3].color_id: null when the customer picks', 'addons[3].printers[0]']) has(bad, needle);

  const bundles = (ids: unknown) => configIssues(config({ products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: ids as string[] } } }));
  has(bundles(Array.from({ length: MAX_STORE_BUNDLES + 1 }, (_, i) => `b${i}`)), `store_bundle_ids: at most ${MAX_STORE_BUNDLES}`);
  has(bundles(['b1', 'b1']), 'store_bundle_ids: each bundle once');
  has(bundles(['']), 'store_bundle_ids');
  assert.deepEqual(bundles([]), []);
});

test('back-compat: a phase 3 list stays valid and reads as fixed colours, no discounts, no add-ons, no bundles', () => {
  const old = clone(config()) as unknown as Record<string, any>;
  delete old.addons;
  delete old.products.p_a1.store_bundle_ids;
  old.kits = [{ ...clone(KIT) }];
  delete old.kits[0].discount;
  for (const it of old.kits[0].items) delete it.color_mode;
  old.kits[0].items[0].color_id = 'c_red';
  assert.deepEqual(configIssues(old), [], 'a phase 3 list stays valid');
  const read = withPhase2Defaults(old as PrinterServicesConfig);
  assert.deepEqual(read.addons, []);
  assert.deepEqual(read.products.p_a1.store_bundle_ids, []);
  assert.equal(read.kits![0].discount, null);
  assert.deepEqual(read.kits![0].items.map((i) => i.color_mode), ['fixed', 'fixed']);
  assert.deepEqual(addonsForPrinter(read, 'p_a1', []), []);
  assert.deepEqual(storeBundleIdsFor(read, 'p_a1'), []);
  // withPhase4Defaults alone is idempotent and leaves what is set.
  assert.deepEqual(withPhase4Defaults(withPhase4Defaults(config())), withPhase4Defaults(config()));
  assert.deepEqual(withPhase4Defaults(config()).kits![0].discount, { mode: 'percent', value: 10 });
  // The offer: add-ons and store bundles only for this selection.
  const offer = servicesOfferFor(config(), { warranty_family: 'a1', delivery_class: 'd1' }, 'p_a1', []);
  assert.deepEqual(offer.addons, [{ id: 'nozzle-04', title: null }]);
  assert.deepEqual(offer.store_bundles, ['b_starter', 'b_tools']);
  assert.deepEqual(servicesOffer(config(), { warranty_family: 'a1', delivery_class: 'd1' }).addons, []);
  assert.deepEqual(servicesOfferFor(config(), { warranty_family: 'a1', delivery_class: 'd1' }, 'p_other', []).store_bundles, []);
});

test('canonicalConfig carries the phase 4 fields, drops unknown keys and round-trips', () => {
  const messy = clone(config()) as unknown as Record<string, any>;
  messy.kits[0].junk = 1;
  messy.kits[0].discount.extra = undefined;
  messy.kits[0].items[1].option_value_ids = ['ov_b', 'ov_a'];
  messy.addons[0].title = { ar: ' فوهة ', en: ' Nozzle ', ckb: ' نۆزڵ ' };
  messy.addons[0].junk = true;
  delete messy.addons[0].color_mode;
  const canon = canonicalConfig(messy as PrinterServicesConfig);
  assert.deepEqual(canon.kits![0].discount, { mode: 'percent', value: 10 });
  assert.equal((canon.kits![0] as unknown as Record<string, unknown>).junk, undefined);
  assert.deepEqual(canon.kits![0].items.map((i) => [i.color_mode, i.option_value_ids]), [['customer', []], ['fixed', ['ov_a', 'ov_b']]]);
  assert.deepEqual(canon.addons, [{
    id: 'nozzle-04', active: true, sort: 2, title: { ar: 'فوهة', en: 'Nozzle', ckb: 'نۆزڵ' },
    product_id: 'p_nozzle', option_value_ids: [], color_id: null, color_mode: 'fixed', qty: 1,
    discount: { mode: 'fixed_iqd', value: 5_000 }, printers: null,
  }]);
  assert.deepEqual(canon.products.p_a1.store_bundle_ids, ['b_starter', 'b_tools']);
  assert.deepEqual(configIssues(canon), []);
  assert.deepEqual(canonicalConfig(canon), canon, 'canonical is a fixed point');
  assert.deepEqual(JSON.parse(JSON.stringify(canon)), canon, 'survives the setting text');
  // A pre-phase-4 kit canonicalises to the explicit defaults.
  const old = clone(config()) as unknown as Record<string, any>;
  delete old.kits[0].discount; delete old.addons; delete old.products.p_a1.store_bundle_ids;
  const c2 = canonicalConfig(old as PrinterServicesConfig);
  assert.equal(c2.kits![0].discount, null);
  assert.deepEqual([c2.addons, c2.products.p_a1.store_bundle_ids], [[], []]);
});

test('publishIssues: add-ons and store bundles', () => {
  assert.deepEqual(publishIssues(config()).filter((i) => i.startsWith('addons') || i.includes('store bundle') || i.startsWith('kits')), []);
  const bad = config({
    products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: ['p_a1'] } },
    addons: [
      { ...ADDON, id: 'a', title: { ar: 'فوهة', en: '', ckb: 'نۆزڵ' } },
      { ...ADDON, id: 'b', product_id: 'p_a1' },
      { ...ADDON, id: 'c', printers: [{ product_id: 'p_zz', option_value_id: null }] },
      { ...ADDON, id: 'off', active: false, product_id: 'p_a1' },
    ],
  });
  const p = publishIssues(bad);
  for (const needle of ['addons.a: a title needs Arabic, English and Kurdish', 'addons.b: a printer cannot be an add-on', 'addons.c: printer p_zz is not mapped',
    'products.p_a1: store bundle p_a1 is a printer']) has(p, needle);
  assert.ok(!p.some((i) => i.startsWith('addons.off')), 'an inactive add-on blocks nothing');
});

test('addonsForPrinter: active, this printer or every printer, a named version must be chosen, owner order', () => {
  const c = config({
    addons: [
      { ...ADDON, id: 'z-all', sort: 1 },
      { ...ADDON, id: 'a-all', sort: 1 },
      { ...ADDON, id: 'first', sort: 0, printers: [{ product_id: 'p_a1', option_value_id: null }] },
      { ...ADDON, id: 'combo', sort: 0, printers: [{ product_id: 'p_a1', option_value_id: 'ov_combo' }] },
      { ...ADDON, id: 'other', sort: 0, printers: [{ product_id: 'p_x', option_value_id: null }] },
      { ...ADDON, id: 'off', sort: 0, active: false },
    ],
  });
  assert.deepEqual(addonsForPrinter(c, 'p_a1', []).map((a) => a.id), ['first', 'a-all', 'z-all']);
  assert.deepEqual(addonsForPrinter(c, 'p_a1', ['ov_combo']).map((a) => a.id), ['combo', 'first', 'a-all', 'z-all']);
  assert.deepEqual(addonsForPrinter(c, 'p_x', []).map((a) => a.id), ['other', 'a-all', 'z-all']);
  assert.deepEqual(kitsForPrinter(c, 'p_a1', []).map((k) => k.id), ['a1-starter']);
});

test('unitDiscount: percent floored, fixed split per printer unit floored, capped at 90% of the unit, integers, 0 when none', () => {
  assert.equal(unitDiscount(null, 25_000, 2), 0);
  assert.equal(unitDiscount(undefined, 25_000, 2), 0);
  assert.equal(unitDiscount({ mode: 'percent', value: 10 }, 25_000, 2), 2_500);
  assert.equal(unitDiscount({ mode: 'percent', value: 15 }, 33_333, 1), Math.floor((33_333 * 15) / 100));
  assert.equal(unitDiscount({ mode: 'percent', value: 90 }, 1_001, 1), 900);
  // fixed: 10,000 per printer over 3 units → 3,333 per unit (the sheet shows the effective 9,999).
  assert.equal(unitDiscount({ mode: 'fixed_iqd', value: 10_000 }, 25_000, 3), 3_333);
  assert.equal(unitDiscount({ mode: 'fixed_iqd', value: 10_000 }, 25_000, 0), 10_000, 'units < 1 count as one');
  // The 90% cap: a fixed amount larger than the unit, or a hostile percent past 90.
  assert.equal(unitDiscount({ mode: 'fixed_iqd', value: 100_000 }, 25_000, 1), 22_500);
  assert.equal(unitDiscount({ mode: 'fixed_iqd', value: 100_000 }, 25_001, 1), 22_500);
  assert.equal(unitDiscount({ mode: 'percent', value: 100 } as never, 25_000, 1), 22_500);
  // Free or garbage prices give nothing, never NaN or a negative.
  for (const applied of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(unitDiscount({ mode: 'percent', value: 50 }, applied, 1), 0);
  assert.equal(unitDiscount({ mode: 'fixed_iqd', value: Number.NaN }, 25_000, 1), 0);
  assert.equal(unitDiscount({ mode: 'other', value: 5 } as never, 25_000, 1), 0);
  for (const d of [{ mode: 'percent', value: 33 }, { mode: 'fixed_iqd', value: 7_777 }] as const) {
    for (const applied of [1, 999, 12_345, 1_000_000_000]) {
      const v = unitDiscount(d, applied, 3);
      assert.ok(Number.isInteger(v) && v >= 0 && v <= Math.floor(applied * 0.9), `${d.mode} ${applied}: ${v}`);
    }
  }
});

test('PHASE4_CODES: the five new refusals, apart from the phase 2 and services codes', () => {
  assert.deepEqual([...PHASE4_CODES].sort(), [ADDON_CHANGED, ADDON_NOT_OFFERED, ADDON_UNAVAILABLE, ADDON_WITHOUT_PRINTER, KIT_COLOR_UNAVAILABLE].sort());
  assert.deepEqual([...PHASE4_CODES].sort(), ['ADDON_CHANGED', 'ADDON_NOT_OFFERED', 'ADDON_UNAVAILABLE', 'ADDON_WITHOUT_PRINTER', 'KIT_COLOR_UNAVAILABLE']);
  for (const code of PHASE4_CODES) assert.ok(!PHASE2_CODES.has(code) && !SERVICES_CODES.has(code), code);
  // WP-B: every phase 4 code is spoken in the three languages (real Sorani, not the Arabic copied).
  for (const code of PHASE4_CODES) {
    const w = REFUSAL_STRINGS[code];
    assert.ok(w && w.ar && w.en && w.ckb && w.ckb !== w.ar, `${code} in REFUSAL_STRINGS (ar/en/ckb)`);
  }
});

test('a page that does not know the phase 4 fields keeps them (keepPhase4Fields); one that sends them is obeyed', () => {
  const stored = withPhase2Defaults(config());
  const posted = clone(stored) as unknown as Record<string, any>;
  delete posted.addons;
  delete posted.products.p_a1.store_bundle_ids;
  delete posted.kits[0].discount;
  for (const it of posted.kits[0].items) delete it.color_mode;
  keepPhase4Fields(posted, stored);
  assert.deepEqual(canonicalConfig(posted as PrinterServicesConfig), canonicalConfig(stored));
  const cleared = clone(stored) as unknown as Record<string, any>;
  cleared.addons = []; cleared.products.p_a1.store_bundle_ids = []; cleared.kits[0].discount = null;
  keepPhase4Fields(cleared, stored);
  assert.deepEqual([cleared.addons, cleared.products.p_a1.store_bundle_ids, cleared.kits[0].discount], [[], [], null]);
});

test('withAttachedLink: kit or add-on columns only on an attached line; colour mode and discount only when given', () => {
  assert.equal(withAttachedLink(undefined, null, { kitId: 'k' }), undefined);
  assert.deepEqual(withAttachedLink({ a: 1 }, null, { addonId: 'x' }), { a: 1 });
  assert.deepEqual(withAttachedLink(undefined, 'oi_printer', { kitId: 'k', colorMode: 'random', discountIqd: 5_000 }),
    { kit_parent_item_id: 'oi_printer', kit_id: 'k', kit_color_mode: 'random', printer_discount_iqd: 5_000 });
  assert.deepEqual(withAttachedLink(undefined, 'oi_printer', { addonId: 'nozzle-04', discountIqd: 0 }),
    { kit_parent_item_id: 'oi_printer', addon_id: 'nozzle-04' });
  assert.deepEqual(withAttachedLink(undefined, 'oi_printer', { kitId: 'k' }), { kit_parent_item_id: 'oi_printer', kit_id: 'k' });
});

test('printerExtrasCatalogIssues: add-ons are plain store products, customer colours exist, linked store bundles are bundles', async () => {
  const raw = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  const row = (id: string, composition = '') =>
    `('${id}','${id}','${id}','${id}',10000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]','${composition}')`;
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images,composition) VALUES
      ${[row('p_a1'), row('p_pla'), row('p_petg'), row('p_nozzle'), row('p_plain'), row('b_starter', 'bundle'), row('b_mystery', 'mystery')].join(',')};
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_p','test-ps4-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0);
    INSERT INTO product_colors (id, product_id, name_en, hex, active) VALUES ('c_red','p_pla','Red','#ff0000',1), ('c_off','p_plain','Grey','#888888',0);
  `);
  const db = new SqliteD1(raw) as unknown as D1Database;
  const good = config({ products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: ['b_starter'] } } });
  assert.deepEqual(await printerExtrasCatalogIssues(db, good), []);
  const bad = config({
    products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: ['b_mystery', 'p_plain', 'b_gone'] } },
    kits: [{ ...KIT, items: [{ ...KIT.items[0], product_id: 'p_plain' }] }],
    addons: [
      { ...ADDON, id: 'printer', product_id: 'p_a1' },
      { ...ADDON, id: 'bundle', product_id: 'b_starter' },
      { ...ADDON, id: 'gone', product_id: 'p_gone' },
      { ...ADDON, id: 'grey', product_id: 'p_plain', color_mode: 'customer' },
      { ...ADDON, id: 'off', active: false, product_id: 'p_gone' },
    ],
  });
  const issues = await printerExtrasCatalogIssues(db, bad);
  for (const needle of ['kits.a1-starter: p_plain has no active colour', 'addons.printer: p_a1 is a printer', 'addons.bundle: b_starter is a bundle or a mystery offer',
    'addons.gone: product p_gone does not exist', 'addons.grey: p_plain has no active colour', 'products.p_a1: b_mystery is not a store bundle',
    'products.p_a1: p_plain is not a store bundle', 'products.p_a1: store bundle b_gone does not exist']) has(issues, needle);
  assert.ok(!issues.some((i) => i.startsWith('addons.off')), 'an inactive add-on is not checked');
});
