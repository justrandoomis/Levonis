/**
 * THE DETERMINISTIC SUPPLIER MATCHER (docs/SMART_PRICING.md §3.5).
 *
 * Fixtures: real Tmall product pages, the EU store snapshot and real manifest
 * rows (tests/fixtures/supplierPrices/), against the Bambu import's own option
 * model of real products (tests/fixtures/bambu).
 *
 *   - keys: colour codes only in a colour option or a title; part codes with
 *     B- removed and the revision kept apart; SKU codes, kits as compounds;
 *     model and material tokens; pack and weight; the index rows;
 *   - matching by colour code, part code (with B-), SKU code, variant id and
 *     handle; the spool / refill, nozzle and plate dictionaries; a plate's
 *     own type and generation read from its name;
 *   - a pack against a single spool is refused (PACK_MISMATCH), never divided;
 *   - ambiguity leaves both sides unmapped and lists what each could be;
 *   - the confidence levels, and which are confirmed automatically;
 *   - refurbished units, other printers, placeholders and promotion listings
 *     never match automatically; the owner's type refuses a contradicting item;
 *   - ids carried across captures: a confirmed match follows its Tmall / store
 *     ids to the next capture's price; a vanished id is reported missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_TYPES,
  catalogueKeysOf,
  colourCodesIn,
  isAddonSku,
  isColourGroupName,
  isPlaceholderSku,
  listingFlagsOf,
  materialTokensIn,
  modelTokensIn,
  nameTokensOf,
  normalizePartCode,
  nozzleOf,
  packOf,
  partCodesIn,
  plateOf,
  skuCodeParts,
  spoolOf,
} from '../packages/catalog/src/supplierPrices/keys';
import {
  AUTO_CONFIRMED,
  MATCH_REASONS,
  carryConfirmed,
  isAutoConfirmed,
  matchProduct,
  productKeysOf,
  type CatalogueItem,
  type ItemMatch,
  type MatchIdentity,
  type ProductMatch,
} from '../packages/catalog/src/supplierPrices/match';
import type { SupplierSource } from '../packages/catalog/src/supplierPrices/format';
import { MODELS } from '../packages/catalog/src/bambuImport/registry/models';
import { catalogueItems, euFile, handIdentity, importedIdentity, manifestRow, tmallFile } from './fixtures/supplierPrices/load';

const tmall = tmallFile();
const eu = euFile();
const T = (...keys: string[]) => catalogueItems(tmall, keys);
const EU = (...keys: string[]) => catalogueItems(eu, keys);
const sorted = (a: readonly string[]) => [...a].sort();

function itemOf(r: ProductMatch, source: SupplierSource, itemKey: string): ItemMatch {
  const m = r.sources.find((s) => s.source === source)?.items.find((i) => i.item_key === itemKey);
  assert.ok(m, `${source} ${itemKey} scored`);
  return m!;
}
const bestOf = (r: ProductMatch, source: SupplierSource) => r.sources.find((s) => s.source === source)?.best ?? null;
const namesOf = (id: MatchIdentity, comboKey: string) =>
  id.skus
    .find((s) => s.combo_key === comboKey)!
    .value_ids.map((v) => id.values.find((x) => x.id === v)!.name_en)
    .join(' / ');
const tmallSku = (itemKey: string, skuKey: string) => tmall.items.find((i) => i.item_key === itemKey)!.skus.find((s) => s.sku_key === skuKey)!;

// ---------------------------------------------------------------- keys

test('keys: a colour code counts only in a colour option or a title', () => {
  assert.deepEqual(colourCodesIn('银色10102【含料盘】'), ['10102']);
  assert.deepEqual(colourCodesIn('PLA Basic 无料盘 蓝*10 | 蓝色10601'), ['10601']);
  assert.deepEqual(colourCodesIn('Jade White (10100)'), ['10100']);
  for (const none of ['14500 7.4V 800mAh Li-ion Battery (1PCS)', '1.75mm', '12345.6', '10000mAh', '10000 mAh', '20000 rpm', 'A00-W1-1.75-1000-SPLFREE', '1234', '123456']) {
    assert.deepEqual(colourCodesIn(none), [], none);
  }
  assert.equal(isColourGroupName('颜色'), true);
  assert.equal(isColourGroupName('颜色分类'), true);
  assert.equal(isColourGroupName('Colour'), true);
  assert.equal(isColourGroupName('有无料盘（FDM线材）'), false);
  assert.equal(isColourGroupName('配件类型'), false);
  // In an index: the TPU's codes come from 颜色, its spool group carries none; a 5-digit
  // figure in a parts option is no colour.
  const tpu = catalogueKeysOf('tmall_cn', tmall.items.find((i) => i.item_key === '749375355825')!);
  assert.deepEqual(sorted(tpu.filter((k) => k.key_type === 'color_code').map((k) => k.key_value)), ['51100', '51101', '51102', '51200', '51400', '51600']);
  const part = catalogueKeysOf('tmall_cn', { item_key: '1', title: '拓竹 配件', name_en: '', skus: [{ sku_key: '2', options: { 配件类型: '型号 12345' } }] });
  assert.equal(part.filter((k) => k.key_type === 'color_code').length, 0);
});

test('keys: part codes with B- removed and the revision apart; SKU codes; kits are compounds', () => {
  assert.deepEqual(partCodesIn('【新品】拓竹3D打印 创意模型组件热气球旋转LED灯 家庭节日家居装饰可DIY配色B-ZH144'), [{ code: 'ZH144', revision: '' }]);
  assert.deepEqual(partCodesIn('拓竹3D打印模型专用标准零件 单轴减速齿轮包（1个) LA022&LA016 创客宝库'), [
    { code: 'LA022', revision: '' },
    { code: 'LA016', revision: '' },
  ]);
  assert.deepEqual(partCodesIn('FAP023-V1'), [{ code: 'FAP023', revision: 'V1' }]);
  assert.deepEqual(partCodesIn('SA002-N'), [{ code: 'SA002', revision: '' }]);
  for (const none of ['X2D', 'H2D', 'A1 mini', 'TPU 95A', 'PA6-CF', 'M2.5x6', 'BT2.6x8', 'WDT K013', 'A00-W1-1.75-1000-SPLFREE', 'AMS 2 Pro', 'qa018']) {
    assert.deepEqual(partCodesIn(none), [], none);
  }
  assert.deepEqual(normalizePartCode('b-qa018'), { code: 'QA018', revision: '' });
  assert.equal(normalizePartCode('A00-W1-1.75-1000-SPL'), null);
  const kit = skuCodeParts(Object.values(manifestRow('print-finishing-kit').sku_codes).find((c) => c.includes('+'))!);
  assert.equal(kit.compound, true);
  assert.deepEqual(
    kit.parts.map((p) => p.code),
    ['SA001', 'QA013', 'QA018', 'QA016', 'QA017']
  );
  assert.deepEqual(skuCodeParts('B-KC008'), { parts: [{ code: 'KC008', revision: '' }], compound: false });
  assert.deepEqual(skuCodeParts('A00-W1-1.75-1000-SPLFREE'), { parts: [], compound: false });
  // The real pumpkin lamp listing indexes KC008, the code the US store sells it under (B-KC008).
  assert.ok(Object.values(manifestRow('led-flame-tea-light-candle-set-warm-yellow').sku_codes).includes('B-KC008'));
  const lamp = catalogueKeysOf('tmall_cn', tmall.items.find((i) => i.item_key === '846915661262')!);
  assert.ok(lamp.some((k) => k.key_type === 'part_code' && k.key_value === 'KC008' && k.sku_key === ''));
});

test('keys: model and material tokens (and the import’s every printer and AMS token)', () => {
  assert.deepEqual(sorted(modelTokensIn('拓竹 硬化钢不锈钢热端喷嘴【适配A2L/A1/A1 mini】')), ['A1', 'A1 mini', 'A2L']);
  assert.deepEqual(sorted(modelTokensIn('拓竹 螺丝包套装 【X1/P1系列（包括AMS）适用】')), ['AMS', 'P1 series', 'X1 series']);
  assert.deepEqual(modelTokensIn('拓竹 AMS 2 Pro上下料组件'), ['AMS 2 Pro']);
  assert.deepEqual(modelTokensIn('AMS lite Mainboard'), ['AMS lite']);
  assert.deepEqual(modelTokensIn('Filament Buffer'), []);
  for (const m of MODELS.filter((x) => x.kind === 'printer' || x.kind === 'ams')) assert.deepEqual(modelTokensIn(m.token), [m.token], `import token ${m.token}`);

  assert.deepEqual(materialTokensIn('拓竹PLA Basic基础 3D打印耗材 高韧性易打印'), ['PLA Basic']);
  assert.deepEqual(materialTokensIn('拓竹PLA Basic双色渐变 3D打印耗材'), ['PLA Basic Gradient']);
  assert.deepEqual(materialTokensIn('拓竹PLA Silk+光泽丝绸 3D打印耗材'), ['PLA Silk+']);
  assert.deepEqual(sorted(materialTokensIn('【新色上市】拓竹TPU 85A&90A 3D打印耗材')), ['TPU 85A', 'TPU 90A']);
  assert.deepEqual(materialTokensIn('拓竹PLA-CF碳纤增强 3D打印耗材'), ['PLA-CF']);
  assert.deepEqual(materialTokensIn('拓竹PC 3D打印耗材'), ['PC']);
  assert.deepEqual(materialTokensIn('Single-shaft reduction gear pack (1 pc)'), [], 'one piece is not polycarbonate');
  assert.deepEqual(nameTokensOf('Hotend Cooling Fan - X2D'), ['hotend', 'cooling', 'fan']);
});

test('keys: pack and weight (packOf)', () => {
  const p = (...texts: string[]) => packOf(texts);
  assert.deepEqual(p('PLA Basic 无料盘 黑*2+白*2+彩6色*1', '拓竹PLA Basic实惠10件装 多色组合 3D打印耗材 净重10kg'), { pack_units: 10, net_weight_g: 10000, units_stated: true });
  assert.deepEqual(p('PLA Basic-白色（6卷） 含料盘', '拓竹PLA Basic囤货套装六件套 3D打印耗材 净重6kg'), { pack_units: 6, net_weight_g: 6000, units_stated: true });
  assert.deepEqual(p('M2.5x6 半圆头机牙螺丝 (20PCS)- AA013'), { pack_units: 20, net_weight_g: null, units_stated: true });
  assert.equal(p('PLA Matte 无料盘 黑*10').pack_units, 10);
  assert.equal(p('PLA Matte 无料盘 黑*5+白*5').pack_units, 10);
  // Rolls by colour add up; the parts of one set do not (the real 3D Effect listing 800769896817).
  assert.deepEqual(p('【适配X1/P1/A1】碳纤纹套装（膜*2+弹簧钢板*1）', '拓竹 转印膜打印板 替换膜【适配A1/P1系列/A1mini/X1C】 3D打印机配件 镭射纹 花纹转印'), { pack_units: 1, net_weight_g: null, units_stated: false });
  assert.equal(p('【适配A1/X/P】星空纹（膜*2）').pack_units, 2, 'one part ×2 is two');
  assert.equal(p('黑*5+白*5', '拓竹PLA Matte 3D打印耗材').pack_units, 10, 'the title names the filament');
  assert.equal(p('拓竹 A2L 热端硅胶套*3【适配A2L】').pack_units, 3);
  assert.equal(p('拓竹PLA Basic囤货套装六件套').pack_units, 6);
  assert.equal(p('Bambu Scraper (3 pcs)').pack_units, 3);
  assert.equal(p('Glue Stick, pack of 2').pack_units, 2);
  // Never a count: a length times a quantity, a size, a model.
  for (const t of ['370mm*1+550mm*2【X1系列/P1S】', '2x18 mm 不锈钢直销轴', 'X1 Series and P1 Series', 'X2D 热端风扇', 'M2.5x6']) {
    assert.deepEqual(p(t), { pack_units: 1, net_weight_g: null, units_stated: false }, t);
  }
  assert.deepEqual(p('黑色 45101【含料盘】 【含料盘】1kg'), { pack_units: 1, net_weight_g: 1000, units_stated: false });
  assert.equal(p('500g').net_weight_g, 500);
  assert.equal(p('0.5kg').net_weight_g, 500);
  assert.equal(p('【万圣节套装】拓竹耗材组合包 多色组合 净重3kg/4kg').net_weight_g, null, 'two weights state none');
  assert.equal(p('拓竹 10 W 激光模组气管接头').net_weight_g, null);
  // Every real SKU's pack fits 0218's columns.
  for (const it of tmall.items) {
    for (const s of it.skus) {
      const f = packOf([...Object.values(s.options), it.title]);
      assert.ok(f.pack_units >= 1 && f.pack_units <= 1000, `${s.sku_key} ${f.pack_units}`);
      assert.ok(f.net_weight_g === null || (f.net_weight_g >= 1 && f.net_weight_g <= 100_000_000));
    }
  }
});

test('keys: the spool, nozzle and plate dictionaries', () => {
  assert.equal(spoolOf('银色10102【含料盘】'), 'spool');
  assert.equal(spoolOf('浅灰10104【无料盘】'), 'refill');
  assert.equal(spoolOf('有料盘（可复用）'), 'spool');
  assert.equal(spoolOf('ABS-GF-绿色41500 有盘'), 'spool');
  assert.equal(spoolOf('PLA Matte 无料盘 黑*10'), 'refill');
  assert.equal(spoolOf('补充装'), 'refill');
  assert.equal(spoolOf('Refill'), 'refill');
  assert.equal(spoolOf('Filament with spool'), 'spool');
  assert.equal(spoolOf('Spool + Refill'), null);
  assert.equal(spoolOf('低温料盘*4'), null, 'spools sold on their own are no spool state');
  assert.equal(spoolOf('有无料盘（FDM线材）'), 'refill', 'why a group NAME is never read: only values are');

  assert.deepEqual(nozzleOf('0.4mm 硬化钢热端【日常打印】'), { diameter: '0.4', material: 'hardened_steel', flow: 'standard' });
  assert.deepEqual(nozzleOf('0.6 mm 碳化钨热端【快速打印】'), { diameter: '0.6', material: 'tungsten_carbide', flow: 'standard' });
  assert.deepEqual(nozzleOf('0.4mm 高流量硬化钢热端【日常打印】'), { diameter: '0.4', material: 'hardened_steel', flow: 'high' });
  assert.deepEqual(nozzleOf('0.2mm Stainless Steel'), { diameter: '0.2', material: 'stainless_steel', flow: 'standard' });
  assert.equal(nozzleOf('拓竹 高流量硬化钢热端喷嘴【适配X2D】0.4/0.6/0.8mm大流量喷头').diameter, null, 'a list names no one diameter');
  assert.equal(nozzleOf('拓竹 硬化钢不锈钢热端喷嘴').material, null);
  assert.equal(nozzleOf('PLA Basic 1.75mm').diameter, null);

  assert.deepEqual(plateOf('二代纹理 PEI 打印板-适配X2D/P2S/A1/P1/X1'), { type: 'textured_pei', generation: 2 });
  assert.deepEqual(plateOf('纹理+光面 PEI 打印板-适配A1/X1/P1'), { type: 'dual_pei', generation: null });
  assert.equal(plateOf('增稳低温打印板Pro-适配X2D/P2S/P1/A1/X1').type, 'cool_supertack');
  assert.equal(plateOf('Bambu Engineering Plate').type, 'engineering');
  assert.equal(plateOf('Bambu Textured PEI Plate').type, 'textured_pei');
  // The English SuperTack names its plate class too: still the SuperTack, never "two types".
  assert.equal(plateOf('Bambu Cool Plate SuperTack Series').type, 'cool_supertack');
  assert.equal(plateOf('Cool Plate SuperTack Pro — A2L/X2D/P2S/H2 series/P1/X1/A1').type, 'cool_supertack');
  assert.equal(plateOf('Bambu Cool Plate').type, 'cool');
});

test('keys: listing flags, placeholder SKUs and add-on SKUs of real listings', () => {
  const flags = (k: string) => listingFlagsOf(tmall.items.find((i) => i.item_key === k)!.title);
  assert.deepEqual(flags('1001355372982'), ['promo_link', 'flash_sale']);
  assert.deepEqual(flags('985511290426'), ['promo_link', 'members_only']);
  assert.deepEqual(flags('1076932251478'), ['refurbished']);
  assert.deepEqual(flags('693972799714'), []);
  assert.deepEqual(listingFlagsOf('【非国补 对公用户专用 慎拍】拓竹AMS lite 3D打印机供料系统'), ['business_listing']);
  assert.deepEqual(listingFlagsOf('[Refurbished] Bambu Lab H2D 3D Printer'), ['refurbished']);
  assert.equal(isPlaceholderSku(tmallSku('742608647813', '6197429735840').options), true);
  assert.equal(isPlaceholderSku(tmallSku('1052136734939', '6304656691258').options), true);
  assert.equal(isPlaceholderSku(tmallSku('742608647813', '5293816695460').options), false);
  assert.equal(isAddonSku(tmallSku('728613928927', '6198834143492').options), true);
  assert.equal(isAddonSku(tmallSku('902156974306', '6035709421220').options), true);
  assert.equal(isAddonSku(tmallSku('728613928927', '6207134270420').options), false);
});

test('keys: the index rows of every real item fit supplier_price_keys; a product finds its candidates', () => {
  for (const [source, file] of [
    ['tmall_cn', tmall],
    ['bambu_eu', eu],
  ] as const) {
    for (const it of file.items) {
      const rows = catalogueKeysOf(source, it);
      const skuKeys = new Set(it.skus.map((s) => s.sku_key));
      const seen = new Set<string>();
      for (const r of rows) {
        assert.ok((KEY_TYPES as readonly string[]).includes(r.key_type), r.key_type);
        assert.ok(r.key_value.length >= 1 && r.key_value.length <= 120);
        assert.ok(r.sku_key === '' || skuKeys.has(r.sku_key), `${it.item_key} ${r.sku_key}`);
        const k = `${r.key_type}|${r.key_value}|${r.sku_key}`;
        assert.ok(!seen.has(k), `no duplicate row ${k}`);
        seen.add(k);
      }
    }
  }
  const h2d = catalogueKeysOf('bambu_eu', eu.items.find((i) => i.item_key === 'h2d')!);
  assert.ok(h2d.some((k) => k.key_type === 'handle' && k.key_value === 'h2d' && k.sku_key === ''));
  assert.ok(h2d.some((k) => k.key_type === 'variant_id' && k.key_value === '596571526982115329' && k.sku_key === '596571526982115329'));
  const pla = tmall.items.find((i) => i.item_key === '693972799714')!;
  const plaRows = catalogueKeysOf('tmall_cn', pla);
  assert.equal(plaRows.filter((k) => k.key_type === 'color_code').length, 54);
  assert.ok(plaRows.some((k) => k.key_type === 'name_token' && k.key_value === 'pla basic'));

  const id = importedIdentity('pla-basic-filament');
  const keys = productKeysOf(id);
  assert.equal(keys.filter((k) => k.key_type === 'variant_id').length, id.skus.length);
  assert.ok(keys.some((k) => k.key_type === 'sku_code' && k.key_value === 'A00-W1-1.75-1000-SPLFREE'));
  assert.ok(keys.some((k) => k.key_type === 'handle' && k.key_value === 'pla-basic-filament'));
  assert.ok(keys.some((k) => k.key_type === 'name_token' && k.key_value === 'pla basic'));
  // The lookup (ix_spk_lookup) meets the listing's own rows.
  const lookup = new Set(keys.map((k) => `${k.key_type}|${k.key_value}`));
  const hits = plaRows.filter((r) => lookup.has(`${r.key_type}|${r.key_value}`));
  assert.ok(hits.filter((r) => r.key_type === 'color_code').length >= 30);
});

// ---------------------------------------------------------------- matching

test('colour code + spool / refill: the real PLA Basic import against the real Tmall listing — every SKU, high', () => {
  const id = importedIdentity('pla-basic-filament');
  assert.equal(id.skus.length, 43);
  const r = matchProduct(id, T('693972799714'));
  const m = itemOf(r, 'tmall_cn', '693972799714');
  assert.equal(m.confidence, 'high');
  assert.equal(m.method, 'color_code');
  assert.equal(m.mapped, 43);
  for (const reason of ['COLOUR_COVERAGE', 'MATERIAL_EQUAL', 'SPOOL_DICT'] as const) assert.ok(m.reasons.includes(reason), reason);
  assert.ok(isAutoConfirmed(m) && AUTO_CONFIRMED.has('high'));
  const used = new Set<string>();
  for (const s of m.skus) {
    assert.ok(s.sku_key, s.combo_key);
    assert.ok(!used.has(s.sku_key!), 'one to one');
    used.add(s.sku_key!);
    assert.equal(s.method, 'color_code');
    const names = namesOf(id, s.combo_key);
    const code = /\((\d{5})\)/.exec(names)![1]!;
    const c = tmallSku('693972799714', s.sku_key!);
    const text = Object.values(c.options).join(' ');
    assert.ok(text.includes(code), `${names} → ${text}`);
    if (names.includes('Refill')) {
      assert.match(text, /无料盘/, names);
      assert.equal(c.price, '65');
    } else {
      assert.match(text, /含料盘/, names);
      assert.equal(c.price, '75');
    }
  }
});

test('a pack is refused against a single spool, even with the same colour codes, and never divided', () => {
  const id = importedIdentity('pla-basic-filament');
  const pack = tmall.items.find((i) => i.item_key === '1001036512689')!;
  const packCodes = catalogueKeysOf('tmall_cn', pack).filter((k) => k.key_type === 'color_code').map((k) => k.key_value);
  assert.deepEqual(sorted(packCodes), ['10103', '10200', '10601']);
  assert.ok(packCodes.every((c) => id.values.some((v) => v.color_code === c)), 'the 10-pack carries the product’s own colour codes');
  const r = matchProduct(id, T('693972799714', '1001036512689'));
  const m = itemOf(r, 'tmall_cn', '1001036512689');
  assert.equal(m.refused, 'PACK_MISMATCH');
  assert.equal(m.mapped, 0);
  assert.ok(m.skus.every((s) => s.sku_key === null && s.reasons.includes('PACK_MISMATCH')));
  assert.equal(bestOf(r, 'tmall_cn')!.item_key, '693972799714');
  // A pack product meets the pack: 10 against 10.
  const tenPack = handIdentity({ name: 'PLA Basic Value Pack (10 rolls)', groups: [{ kind: 'color', values: [{ name: 'Blue (10601)', code: '10601' }] }, { kind: 'spool', values: ['Refill'] }] });
  const ten = itemOf(matchProduct(tenPack, T('1001036512689')), 'tmall_cn', '1001036512689');
  assert.equal(ten.refused, null);
  assert.equal(ten.mapped, 1);
  assert.ok(ten.reasons.includes('PACK_EQUAL'));
});

test('a separate spool group (TPU 95A HF) and a weight in the option (ASA 1kg)', () => {
  const tpu = handIdentity({
    name: 'TPU 95A HF',
    groups: [
      { kind: 'color', values: ['51200', '51100', '51400', '51600', '51101', '51102'].map((code) => ({ name: `Colour (${code})`, code })) },
      { kind: 'spool', values: ['Filament with spool'] },
    ],
  });
  const t = itemOf(matchProduct(tpu, T('749375355825')), 'tmall_cn', '749375355825');
  assert.equal(t.confidence, 'high');
  assert.equal(t.mapped, 6);
  assert.ok(t.reasons.includes('SPOOL_DICT'));
  const asa = handIdentity({ name: 'ASA', groups: [{ kind: 'color', values: ['45101', '45100', '45102'].map((code) => ({ name: `Colour (${code})`, code })) }, { kind: 'pack', values: ['1kg'] }] });
  const a = itemOf(matchProduct(asa, T('718106932700')), 'tmall_cn', '718106932700');
  assert.equal(a.confidence, 'high');
  assert.ok(a.reasons.includes('PACK_EQUAL'));
  // A refill product never takes a with-spool SKU.
  const refill = handIdentity({ name: 'TPU 95A HF', groups: [{ kind: 'color', values: [{ name: 'Red (51200)', code: '51200' }] }, { kind: 'spool', values: ['Refill'] }] });
  assert.equal(itemOf(matchProduct(refill, T('749375355825')), 'tmall_cn', '749375355825').mapped, 0);
});

test('part code with B-: exact one-to-one; a stripped revision is high; a kit is not its part; another code refuses', () => {
  const screws = itemOf(matchProduct(handIdentity({ name: 'M2.5x6 Pan Head Machine Screws (20PCS)', skuCodes: { '': 'B-AA013' } }), T('785492874870')), 'tmall_cn', '785492874870');
  assert.equal(screws.confidence, 'exact');
  assert.equal(screws.method, 'part_code');
  assert.deepEqual(sorted(screws.reasons.filter((r) => ['CODE_EQUAL', 'PACK_EQUAL'].includes(r))), ['CODE_EQUAL', 'PACK_EQUAL']);
  assert.equal(screws.skus[0]!.sku_key, '5365752729795');

  const cutters = itemOf(matchProduct(handIdentity({ name: 'Flush Cutters', skuCodes: { '': 'B-QA018' } }), T('1036834158903')), 'tmall_cn', '1036834158903');
  assert.equal(cutters.confidence, 'exact');

  // The code only in the product's name is evidence, never exact.
  const named = itemOf(matchProduct(handIdentity({ name: 'M2.5x6 Pan Head Machine Screws (20PCS) - AA013' }), T('785492874870')), 'tmall_cn', '785492874870');
  assert.equal(named.confidence, 'high');
  assert.ok(named.reasons.includes('CODE_EQUAL'));

  const plate: CatalogueItem = {
    source: 'tmall_cn',
    item_key: '900000000001',
    title: '拓竹 增稳低温打印板 FAP023',
    name_en: 'Cool Plate SuperTack',
    sourcing_hint: 'CHINA_CNY',
    skus: [{ sku_key: '900000000002', options: { 配件类型: '增稳低温打印板' }, price: '99' }],
  };
  const v1 = Object.values(manifestRow('bambu-cool-plate-supertack').sku_codes)[0]!;
  assert.equal(v1, 'FAP023-V1');
  const rev = itemOf(matchProduct(handIdentity({ name: 'Bambu Cool Plate SuperTack Series', skuCodes: { '': v1 } }), [plate]), 'tmall_cn', '900000000001');
  assert.equal(rev.confidence, 'high');
  assert.ok(rev.reasons.includes('REVISION_STRIPPED'));

  const kitCode = Object.values(manifestRow('print-finishing-kit').sku_codes).find((c) => c.includes('+'))!;
  const kit = itemOf(matchProduct(handIdentity({ name: 'Print Finishing Kit', skuCodes: { '': kitCode } }), T('1036834158903')), 'tmall_cn', '1036834158903');
  assert.equal(kit.mapped, 0, 'a kit holding QA018 is not QA018');
  assert.ok(!kit.reasons.includes('CODE_EQUAL'));

  const other = itemOf(matchProduct(handIdentity({ name: 'Flush Cutters', skuCodes: { '': 'B-QA018' } }), T('1053109777521')), 'tmall_cn', '1053109777521');
  assert.equal(other.mapped, 0, 'the ZH121 drill is another part');
});

test('SKU code and variant id decide a store variant: exact', () => {
  const h2d = importedIdentity('h2d');
  const us: CatalogueItem = {
    source: 'bambu_us',
    item_key: 'h2d',
    title: 'Bambu Lab H2D',
    name_en: 'Bambu Lab H2D',
    skus: h2d.skus.map((s, i) => ({ sku_key: s.variant_ids![0]!, options: { option1: `variant ${i}` }, price: '1999' })),
  };
  const byId = itemOf(matchProduct(h2d, [us]), 'bambu_us', 'h2d');
  assert.equal(byId.confidence, 'exact');
  assert.equal(byId.method, 'variant_id');
  assert.equal(byId.mapped, 6);
  assert.ok(byId.skus.every((s, i) => s.sku_key === h2d.skus[i]!.variant_ids![0] && s.method === 'variant_id'));

  const glue: CatalogueItem = {
    source: 'bambu_us',
    item_key: 'glue-stick-for-build-plate',
    title: 'Glue Stick',
    name_en: 'Glue Stick',
    skus: [{ sku_key: '1', options: { option1: 'Default Title' }, sku_code: 'SGL001', price: '5.99' }],
  };
  const byCode = itemOf(matchProduct(handIdentity({ name: 'Glue Stick for Build Plate', skuCodes: { '': 'SGL001' } }), [glue]), 'bambu_us', 'glue-stick-for-build-plate');
  assert.equal(byCode.confidence, 'exact');
  assert.equal(byCode.method, 'sku_code');
});

test('handle: the EU store by handle and English option labels (its variant ids are not the import’s)', () => {
  const buffer = importedIdentity('filament-buffer');
  const b = itemOf(matchProduct(buffer, EU('filament-buffer', 'h2d')), 'bambu_eu', 'filament-buffer');
  assert.equal(b.confidence, 'high');
  assert.equal(b.method, 'handle');
  assert.deepEqual(
    b.skus.map((s) => s.sku_key),
    ['43719762903259']
  );
  assert.ok(!buffer.skus[0]!.variant_ids!.includes('43719762903259'), 'the EU variant id differs from the US one');

  const h2d = importedIdentity('h2d');
  const r = matchProduct(h2d, EU('h2d', 'h2c', 'x2d', 'filament-buffer'));
  const m = itemOf(r, 'bambu_eu', 'h2d');
  assert.equal(bestOf(r, 'bambu_eu')!.item_key, 'h2d');
  assert.equal(m.mapped, 5);
  assert.equal(m.confidence, 'low', 'one SKU has no EU variant: not every SKU is mapped');
  const map = Object.fromEntries(m.skus.map((s) => [namesOf(h2d, s.combo_key), s.sku_key]));
  assert.equal(map['H2D AMS Combo / Standard'], '596571526982115329');
  assert.equal(map['H2D / standard'], '596571526990503947', 'labels compare case-blind');
  assert.equal(map['H2D Laser Full Combo / 40W'], '596571526990503942');
  assert.equal(map['H2D AMS Combo / Dual AMS 2 Pro Bundle'], null);
  assert.equal(itemOf(r, 'bambu_eu', 'h2c').refused, 'MODEL_MISMATCH');
});

test('handle: an EU filament page — colour by code, spool and weight by label — every SKU it sells', () => {
  // The EU store names its variants as the US one does ("Jade White (10100) / Refill / 1kg"), with its own ids.
  const id = importedIdentity('pla-basic-filament');
  const pick = id.skus.slice(0, 6);
  const euPla: CatalogueItem = {
    source: 'bambu_eu',
    item_key: 'pla-basic-filament',
    title: 'PLA Basic',
    name_en: 'PLA Basic',
    skus: pick.map((s, i) => ({
      sku_key: `59657152698211${String(5400 + i)}`,
      options: Object.fromEntries(s.value_ids.map((v, j) => [`option${j + 1}`, id.values.find((x) => x.id === v)!.name_en])),
      price: '24.99',
    })),
  };
  const m = itemOf(matchProduct({ ...id, skus: pick }, [euPla]), 'bambu_eu', 'pla-basic-filament');
  assert.equal(m.confidence, 'high');
  assert.equal(m.method, 'handle');
  assert.deepEqual(
    m.skus.map((s) => s.sku_key),
    euPla.skus.map((s) => s.sku_key)
  );
  // A value the EU variant does not state is no match on a store: every value it states must be the product's.
  const extra: CatalogueItem = { ...euPla, skus: euPla.skus.map((s) => ({ ...s, options: { ...s.options, option4: 'Bundle' } })) };
  assert.equal(itemOf(matchProduct({ ...id, skus: pick }, [extra]), 'bambu_eu', 'pla-basic-filament').mapped, 0);
});

test('nozzle dictionary: diameter, material and flow; add-on SKUs are never the product', () => {
  const hotend = handIdentity({ name: 'Bambu Hotend - X2D/P2S/H2 Series', groups: [{ kind: 'nozzle', values: ['0.2mm Stainless Steel', '0.4mm Hardened Steel', '0.6mm Hardened Steel', '0.8mm Hardened Steel'] }] });
  const r = matchProduct(hotend, T('902156974306', '903027880049', '743686111205'));
  const std = itemOf(r, 'tmall_cn', '902156974306');
  assert.equal(std.mapped, 4);
  assert.ok(std.reasons.includes('NOZZLE_DICT'));
  assert.deepEqual(
    std.skus.map((s) => s.sku_key),
    ['5761073729112', '5761073729113', '5761073729114', '5761073729115']
  );
  assert.ok(!std.skus.some((s) => ['6035709421220', '6035709421221'].includes(s.sku_key ?? '')), 'the silicone socks beside the nozzles');
  assert.equal(itemOf(r, 'tmall_cn', '903027880049').mapped, 0, 'a high-flow hotend is another product');
  assert.equal(itemOf(r, 'tmall_cn', '743686111205').refused, 'MODEL_MISMATCH', 'the A1 hotend fits other printers');
  assert.equal(bestOf(r, 'tmall_cn')!.item_key, '902156974306');

  const highFlow = handIdentity({ name: 'High Flow Hotend - X2D/P2S/H2 Series', groups: [{ kind: 'nozzle', values: ['0.4mm Hardened Steel', '0.6mm Hardened Steel', '0.8mm Hardened Steel'] }] });
  const hf = matchProduct(highFlow, T('902156974306', '903027880049'));
  assert.equal(itemOf(hf, 'tmall_cn', '903027880049').mapped, 3);
  assert.equal(itemOf(hf, 'tmall_cn', '902156974306').mapped, 0);
});

test('plate type and generation from the product’s name: another plate’s listing is refused, another plate’s SKU never pairs', () => {
  // The real import: one Printer Model group and no plate group, so the plate type is in the name only.
  const textured = importedIdentity('bambu-textured-pei-plate');
  assert.deepEqual(
    textured.groups.map((g) => g.kind),
    ['printer']
  );
  // The real SuperTack Pro listing: ids, titles and options as captured; the prices are not the capture's.
  const superTack: CatalogueItem = {
    source: 'tmall_cn',
    item_key: '1000231253475',
    title: '拓竹 增稳低温打印板Pro【A2L/X2D/P2S/H2系列/P1/X1/A1】 冷打板 低温打印板 3D打印板 3D打印板配件',
    name_en: 'Cool Plate SuperTack Pro — A2L/X2D/P2S/H2 series/P1/X1/A1',
    category: 'build_plate',
    sourcing_hint: 'CHINA_CNY',
    skus: [
      { sku_key: '6150763586257', options: { 配件类型: '适配H2D' }, options_en: { 'Part type': 'For H2D' }, price: '1' },
      { sku_key: '6155440810349', options: { 配件类型: '适配H2C' }, options_en: { 'Part type': 'For H2C' }, price: '2' },
      { sku_key: '6155440810350', options: { 配件类型: '增稳低温打印板Pro-适配X2D/P2S/P1/A1/X1' }, options_en: { 'Part type': 'Cool Plate SuperTack Pro, for X2D/P2S/P1/A1/X1' }, price: '3' },
    ],
  };
  const r = matchProduct(textured, [superTack, ...T('728613928927')]);
  const st = itemOf(r, 'tmall_cn', '1000231253475');
  assert.equal(st.refused, 'LISTING_MISMATCH', 'a SuperTack listing is no Textured PEI plate');
  assert.equal(st.mapped, 0);
  assert.equal(bestOf(r, 'tmall_cn')!.item_key, '728613928927');
  assert.ok(r.sources.every((s) => s.items.every((m) => m.skus.every((x) => !superTack.skus.some((k) => k.sku_key === x.sku_key)))), 'no SKU takes a SuperTack price');
  // The same listing still serves the SuperTack, which refuses the textured listing in turn.
  const cool = handIdentity({ name: 'Bambu Cool Plate SuperTack Series', groups: [{ kind: 'printer', values: ['H2D', 'H2C'] }] });
  const rc = matchProduct(cool, [superTack, ...T('728613928927')]);
  assert.deepEqual(
    itemOf(rc, 'tmall_cn', '1000231253475').skus.map((s) => s.sku_key),
    ['6150763586257', '6155440810349']
  );
  assert.equal(itemOf(rc, 'tmall_cn', '728613928927').refused, 'LISTING_MISMATCH');

  // A listing of two plates whose title names neither: each SKU is judged by its own words.
  const both: CatalogueItem = {
    source: 'tmall_cn',
    item_key: '900000000020',
    title: '拓竹 PEI 打印板【适配A1 mini】',
    name_en: 'PEI plate — A1 mini',
    skus: [
      { sku_key: '900000000021', options: { 配件类型: '纹理 PEI 打印板-适配A1 mini' }, price: '1' },
      { sku_key: '900000000022', options: { 配件类型: '光面 PEI 打印板-适配A1 mini' }, price: '2' },
    ],
  };
  const mini = (name: string) => handIdentity({ name, groups: [{ kind: 'printer', values: ['A1 mini'] }] });
  assert.deepEqual(
    itemOf(matchProduct(mini('Bambu Textured PEI Plate'), [both]), 'tmall_cn', '900000000020').skus.map((s) => s.sku_key),
    ['900000000021']
  );
  assert.deepEqual(
    itemOf(matchProduct(mini('Bambu Smooth PEI Plate'), [both]), 'tmall_cn', '900000000020').skus.map((s) => s.sku_key),
    ['900000000022']
  );

  // A generation the name states: the other generation's SKU never pairs, a listing of the other generation is refused.
  const gens: CatalogueItem = {
    source: 'tmall_cn',
    item_key: '900000000030',
    title: '拓竹 纹理 PEI 打印板【适配A1/P1/X1】',
    name_en: 'Textured PEI plate — A1/P1/X1',
    skus: [
      { sku_key: '900000000031', options: { 配件类型: '一代纹理 PEI 打印板-适配A1/P1/X1' }, price: '1' },
      { sku_key: '900000000032', options: { 配件类型: '二代纹理 PEI 打印板-适配A1/P1/X1' }, price: '2' },
    ],
  };
  const a1 = (name: string) => handIdentity({ name, groups: [{ kind: 'printer', values: ['A1'] }] });
  assert.deepEqual(
    itemOf(matchProduct(a1('Bambu Textured PEI Plate (2nd Gen)'), [gens]), 'tmall_cn', '900000000030').skus.map((s) => s.sku_key),
    ['900000000032']
  );
  assert.deepEqual(itemOf(matchProduct(a1('Bambu Textured PEI Plate'), [gens]), 'tmall_cn', '900000000030').skus[0]!.reasons, ['AMBIGUOUS'], 'no generation stated: either');
  const firstGen: CatalogueItem = { ...gens, item_key: '900000000040', title: '拓竹 一代纹理 PEI 打印板【适配A1/P1/X1】', skus: [{ sku_key: '900000000041', options: { 配件类型: '适配A1' }, price: '1' }] };
  assert.equal(itemOf(matchProduct(a1('Bambu Textured PEI Plate (2nd Gen)'), [firstGen]), 'tmall_cn', '900000000040').refused, 'LISTING_MISMATCH');

  // A name that is no plate's states no plate: a "smooth" plunger is not refused by a textured listing.
  assert.equal(itemOf(matchProduct(handIdentity({ name: 'Smooth Ball Spring Plunger' }), T('728613928927')), 'tmall_cn', '728613928927').refused, null);
});

test('ambiguity leaves both sides unmapped and lists what each SKU could be', () => {
  // One Tmall SKU per nozzle serves all three printers: three Levonis SKUs land on one catalogue SKU.
  const id = importedIdentity('bambu-hotend-a1-a2');
  assert.equal(id.skus.length, 15);
  const m = itemOf(matchProduct(id, T('743686111205')), 'tmall_cn', '743686111205');
  assert.equal(m.mapped, 0);
  assert.equal(m.confidence, 'low');
  assert.ok(m.reasons.includes('AMBIGUOUS'));
  for (const s of m.skus) {
    assert.equal(s.sku_key, null);
    assert.deepEqual(s.reasons, ['AMBIGUOUS']);
    assert.equal(s.could_be.length, 1);
    const names = namesOf(id, s.combo_key);
    const c = tmallSku('743686111205', s.could_be[0]!);
    const text = Object.values(c.options).join(' ');
    assert.ok(text.startsWith(/^\S+/.exec(names.split(' / ').find((x) => /mm/.test(x))!)![0]!), `${names} → ${text}`);
  }
  // One Levonis SKU on two catalogue SKUs: the drill's two sets.
  const drill = itemOf(matchProduct(handIdentity({ name: 'Hand Drill', skuCodes: { '': 'B-ZH121' } }), T('1053109777521')), 'tmall_cn', '1053109777521');
  assert.equal(drill.mapped, 0);
  assert.deepEqual(drill.skus[0]!.reasons, ['AMBIGUOUS']);
  assert.deepEqual(sorted(drill.skus[0]!.could_be), ['6089953933955', '6264995743059']);
});

test('a Tmall listing without options (one SKU keyed by its item id): one product pairs with it, a product with options never maps more than one SKU', () => {
  // Real listings of the 2026-10-31 capture as normalize-tmall.mjs writes them; the prices are not the capture's.
  const single = (item_key: string, title: string, name_en: string, category: string, sourcing_hint: string): CatalogueItem => ({
    source: 'tmall_cn',
    item_key,
    title,
    name_en,
    category,
    sourcing_hint,
    skus: [{ sku_key: item_key, options: {}, options_en: {}, price: '1' }],
  });
  const cover = single('966154880524', '拓竹 显示屏后盖（含转轴）【X1系列适用】 3D打印机配件', 'Display rear cover (with hinge) — X1 series', 'spare_part', 'CHINA_CNY');
  const heatbed = single('960718061606', '拓竹 热床 【X1C适用】 3D打印机配件', 'Heatbed — X1C', 'electronic_part', 'EU_STORE_EUR');
  const platform = single('972722214224', '拓竹 激光垫板 激光工作底板【H2D/H2S适用】 3D打印机配件', 'Laser work platform — H2D/H2S', 'accessory', 'CHINA_CNY');

  // The manifest's product, one SKU: paired with the item's own id, by name and model — a suggestion, never automatic.
  const one = itemOf(matchProduct(handIdentity({ name: 'Display Rear Housing with Hinge - X1 Series' }), [cover]), 'tmall_cn', '966154880524');
  assert.deepEqual([one.refused, one.confidence, one.method, one.mapped], [null, 'medium', 'name', 1]);
  assert.deepEqual(one.skus.map((s) => s.sku_key), ['966154880524']);
  assert.deepEqual(sorted(one.reasons), ['MODEL_EQUAL', 'NAME_SIMILAR']);
  assert.equal(isAutoConfirmed(one), false);
  assert.equal(itemOf(matchProduct(handIdentity({ name: 'Laser Work Platform - H2D/H2S' }), [platform]), 'tmall_cn', '972722214224').skus[0]!.sku_key, '972722214224');

  // Options the title tells apart: only the printer it names maps, so not every SKU is mapped — low.
  const byPrinter = itemOf(matchProduct(handIdentity({ name: 'Heatbed', groups: [{ kind: 'printer', values: ['X1C', 'P1S'] }] }), [heatbed]), 'tmall_cn', '960718061606');
  assert.deepEqual(byPrinter.skus.map((s) => [s.sku_key, s.reasons, s.could_be]), [
    ['960718061606', [], []],
    [null, [], []],
  ]);
  assert.deepEqual([byPrinter.mapped, byPrinter.confidence], [1, 'low']);
  // Options the one offer cannot tell apart: two SKUs on one catalogue SKU stay unmapped (AMBIGUOUS), never both paired.
  for (const [id, item] of [
    [handIdentity({ name: 'Laser Work Platform', groups: [{ kind: 'printer', values: ['H2D', 'H2S'] }] }), platform],
    [handIdentity({ name: 'Display Rear Housing with Hinge - X1 Series', groups: [{ kind: 'color', values: ['Black', 'White'] }] }), cover],
  ] as const) {
    const m = itemOf(matchProduct(id, [item]), 'tmall_cn', item.item_key);
    assert.equal(m.mapped, 0, item.item_key);
    assert.deepEqual(m.skus.map((s) => [s.sku_key, s.reasons, s.could_be]), [
      [null, ['AMBIGUOUS'], [item.item_key]],
      [null, ['AMBIGUOUS'], [item.item_key]],
    ]);
  }

  // Carried by its ids: the next capture's price; once the listing gains options its item-id SKU is gone (missing).
  const ref = { combo_key: '', source: 'tmall_cn' as const, item_key: '966154880524', sku_key: '966154880524' };
  assert.equal(carryConfirmed([ref], [{ ...cover, skus: [{ ...cover.skus[0]!, price: '2' }] }])[0]!.sku!.price, '2');
  assert.equal(carryConfirmed([ref], [{ ...cover, skus: [{ sku_key: '6300000000001', options: { 颜色: '黑色' }, price: '2' }] }])[0]!.sku, null);
});

test('the confidence levels, and which are confirmed automatically', () => {
  assert.deepEqual([...AUTO_CONFIRMED].sort(), ['exact', 'high']);
  const exact = itemOf(matchProduct(handIdentity({ name: 'Flush Cutters', skuCodes: { '': 'B-QA018' } }), T('1036834158903')), 'tmall_cn', '1036834158903');
  const high = itemOf(matchProduct(importedIdentity('filament-buffer'), EU('filament-buffer')), 'bambu_eu', 'filament-buffer');
  const medium = itemOf(matchProduct(handIdentity({ name: 'Hotend Cooling Fan - X2D' }), T('1036813526277')), 'tmall_cn', '1036813526277');
  const low = itemOf(matchProduct(importedIdentity('ams-2-pro-feeder-unit'), T('900979520783')), 'tmall_cn', '900979520783');
  assert.deepEqual(
    [exact, high, medium, low].map((m) => m.confidence),
    ['exact', 'high', 'medium', 'low']
  );
  assert.deepEqual(
    [exact, high, medium, low].map((m) => isAutoConfirmed(m)),
    [true, true, false, false]
  );
  assert.ok(medium.reasons.includes('NAME_SIMILAR') && medium.reasons.includes('MODEL_EQUAL'));
  assert.equal(medium.mapped, 1);
  assert.equal(low.mapped, 1, 'mapped, but the names agree too little');
  assert.ok(low.name_similarity < 0.6);
  // A pack the offer does not count is never automatic.
  const nuts = handIdentity({ name: 'M2.5x6 Pan Head Machine Screws (20PCS)', skuCodes: { '': 'B-AA013' } });
  const silent: CatalogueItem = { source: 'tmall_cn', item_key: '900000000003', title: '拓竹 半圆头机牙螺丝 AA013', name_en: 'Pan-head machine screws', skus: [{ sku_key: '900000000004', options: {}, price: '9' }] };
  const s = itemOf(matchProduct(nuts, [silent]), 'tmall_cn', '900000000003');
  assert.equal(s.mapped, 1);
  assert.equal(s.confidence, 'medium');
});

test('refused or held back: refurbished units, other printers, placeholders, promotions, the owner’s type', () => {
  const refurb = importedIdentity('refurbished-bambu-lab-h2d-3d-printer');
  const r1 = matchProduct(refurb, T('1076932251478', '1040900100796'));
  assert.equal(itemOf(r1, 'tmall_cn', '1040900100796').refused, 'LISTING_MISMATCH', 'a new X2D is no refurbished unit');
  assert.equal(itemOf(r1, 'tmall_cn', '1076932251478').refused, 'MODEL_MISMATCH', 'a refurbished X2D is no H2D');
  assert.equal(bestOf(r1, 'tmall_cn'), null);
  const newX2d = handIdentity({ name: 'Bambu Lab X2D' });
  assert.equal(itemOf(matchProduct(newX2d, T('1076932251478')), 'tmall_cn', '1076932251478').refused, 'LISTING_MISMATCH');

  // A "do not buy" placeholder SKU is never the product.
  const heater = itemOf(matchProduct(handIdentity({ name: 'Hotend Heating Assembly - A1 Series' }), T('742608647813')), 'tmall_cn', '742608647813');
  assert.deepEqual(
    heater.skus.map((s) => s.sku_key),
    ['5293816695460']
  );
  assert.equal(heater.confidence, 'medium');
  const purifier = itemOf(matchProduct(handIdentity({ name: 'E1 Pro Air Purifier for R1' }), T('1052136734939')), 'tmall_cn', '1052136734939');
  assert.equal(purifier.skus[0]!.sku_key, '6089957685845');
  const placeholder: CatalogueItem = { source: 'tmall_cn', item_key: '1', title: '拓竹 占坑 勿上架', name_en: '', skus: [{ sku_key: '2', options: {}, price: '1' }] };
  assert.equal(itemOf(matchProduct(newX2d, [placeholder]), 'tmall_cn', '1').refused, 'PLACEHOLDER_LISTING');

  // A flash-sale price is never the regular cost: mapped, but held at low.
  const absgf = handIdentity({ name: 'ABS-GF', groups: [{ kind: 'color', values: [{ name: 'Green (41500)', code: '41500' }, { name: 'Yellow (41400)', code: '41400' }] }, { kind: 'spool', values: ['Filament with spool'] }] });
  const flash = itemOf(matchProduct(absgf, T('1001355372982')), 'tmall_cn', '1001355372982');
  assert.equal(flash.mapped, 2);
  assert.equal(flash.confidence, 'low');
  assert.ok(flash.reasons.includes('PROMO_LISTING') && flash.reasons.includes('COLOUR_COVERAGE'));
  assert.equal(isAutoConfirmed(flash), false);

  // The owner chose an EU type: a China-sourced candidate is refused; an import type refuses nothing.
  const fan = handIdentity({ name: 'Hotend Cooling Fan - X2D', owner_sourcing: 'CHINA_CNY' });
  assert.equal(itemOf(matchProduct(fan, T('1036813526277')), 'tmall_cn', '1036813526277').refused, 'TYPE_MISMATCH');
  const fanEu = handIdentity({ name: 'Hotend Cooling Fan - X2D', owner_sourcing: 'EU_STORE_EUR' });
  assert.equal(itemOf(matchProduct(fanEu, T('1036813526277')), 'tmall_cn', '1036813526277').refused, null);
  const cutters = handIdentity({ name: 'Flush Cutters', skuCodes: { '': 'B-QA018' }, owner_sourcing: 'EU_STORE_EUR' });
  assert.equal(itemOf(matchProduct(cutters, T('1036834158903')), 'tmall_cn', '1036834158903').refused, 'TYPE_MISMATCH');
  assert.equal(itemOf(matchProduct({ ...cutters, owner_sourcing: null }, T('1036834158903')), 'tmall_cn', '1036834158903').refused, null);
});

test('two listings equally good go to the owner unless every mapped price agrees', () => {
  const base = tmall.items.find((i) => i.item_key === '1036834158903')!;
  const twin = (key: string, price: string): CatalogueItem => ({
    source: 'tmall_cn',
    item_key: key,
    title: base.title,
    name_en: base.name_en,
    codes: base.codes,
    skus: base.skus.map((s) => ({ ...s, sku_key: `${key}9`, price })),
  });
  const id = handIdentity({ name: 'Flush Cutters', skuCodes: { '': 'B-QA018' } });
  const differ = matchProduct(id, [twin('222', '49'), twin('111', '45')]);
  for (const m of differ.sources[0]!.items) {
    assert.equal(m.confidence, 'low');
    assert.ok(m.reasons.includes('AMBIGUOUS'));
    assert.equal(isAutoConfirmed(m), false);
  }
  const same = matchProduct(id, [twin('222', '45.00'), twin('111', '45')]);
  assert.equal(bestOf(same, 'tmall_cn')!.item_key, '111');
  assert.equal(bestOf(same, 'tmall_cn')!.confidence, 'exact');
});

test('ids carried across captures: a confirmed match follows its ids to the next capture’s price', () => {
  const id = importedIdentity('pla-basic-filament');
  const first = itemOf(matchProduct(id, T('693972799714')), 'tmall_cn', '693972799714');
  const refs = first.skus.map((s) => ({ combo_key: s.combo_key, source: 'tmall_cn' as const, item_key: first.item_key, sku_key: s.sku_key! }));

  // The next capture: new prices, SKUs in another order, one colour gone, a new title word.
  const [item] = T('693972799714');
  const gone = refs[0]!.sku_key;
  const next: CatalogueItem = {
    ...item!,
    title: `${item!.title} 新品`,
    skus: [...item!.skus]
      .reverse()
      .filter((s) => s.sku_key !== gone)
      .map((s) => ({ ...s, price: String(Number(s.price) + 5) })),
  };
  const second = itemOf(matchProduct(id, [next]), 'tmall_cn', '693972799714');
  for (const s of second.skus) {
    const before = first.skus.find((x) => x.combo_key === s.combo_key)!;
    if (before.sku_key === gone) assert.equal(s.sku_key, null);
    else assert.equal(s.sku_key, before.sku_key, 'the same Tmall sku id');
  }
  const carried = carryConfirmed(refs, [next]);
  assert.equal(carried.length, refs.length);
  for (const c of carried) {
    if (c.ref.sku_key === gone) {
      assert.equal(c.sku, null, 'EST_SOURCE_ITEM_MISSING');
      continue;
    }
    const old = tmallSku('693972799714', c.ref.sku_key);
    assert.equal(c.sku!.price, String(Number(old.price) + 5), 'the new capture’s price');
  }
  // A whole item gone, or another source with the same ids: missing.
  assert.ok(carryConfirmed(refs, []).every((c) => c.sku === null));
  assert.ok(carryConfirmed(refs, [{ ...next, source: 'bambu_eu' }]).every((c) => c.sku === null));
});

test('deterministic and closed: the same answer in any order; reasons are codes from the list', () => {
  const id = importedIdentity('pla-basic-filament');
  const items = T('693972799714', '1001036512689', '998916499888', '1001355372982', '749375355825');
  const a = matchProduct(id, items);
  const b = matchProduct(id, [...items].reverse());
  assert.deepEqual(a, b);
  const all: ProductMatch[] = [
    a,
    matchProduct(importedIdentity('h2d'), EU('h2d', 'h2c', 'x2d', 'filament-buffer')),
    matchProduct(importedIdentity('bambu-hotend-a1-a2'), T('743686111205', '902156974306', '903027880049')),
    matchProduct(importedIdentity('refurbished-bambu-lab-h2d-3d-printer'), T('1076932251478', '1040900100796')),
  ];
  for (const r of all) {
    for (const s of r.sources) {
      for (const m of s.items) {
        for (const reason of [...m.reasons, ...m.skus.flatMap((x) => x.reasons)]) assert.ok((MATCH_REASONS as readonly string[]).includes(reason), reason);
        assert.ok(JSON.stringify(m.reasons).length <= 2000, 'reasons_json fits its column');
        assert.ok(m.skus.every((x) => x.could_be.length <= 10));
      }
    }
  }
});
