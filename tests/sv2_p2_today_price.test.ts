/**
 * «سعر اليوم» AND THE COMBO'S PARTS (Services S-P2 spec §4.2, §4.3, §13.1).
 *
 *   today     the lowest PUBLIC new price of the same SKU through the strict V2 resolver: direct
 *             sale, or a cheaper pre-order route; an unlisted, hidden or never-published product
 *             answers null; `products.price_iqd` and the option rows' rollback prices are sentinels
 *             the code must never read
 *   B.4       rule 1 (Combo − plain), rule 2 (a linked standalone AMS caps the gap), rule 3 (the
 *             plain model gone: the standalone AMS), rule 4 (the owner's USD reference, at most
 *             half the Combo), rule 5 (none: the Combo is one machine)
 *
 * Run: node --import tsx --test tests/sv2_p2_today_price.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, all, withoutTriggers } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { TodayReader } from '../worker/lib/tradeInToday';
import { componentNows, usdToIqdCeil } from '../worker/lib/tradeInOffer';
import { restoreFetch, seed } from './sv2_tradein_fixture';
import type { Env } from '../worker/lib/types';

test.after(restoreFetch);

const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw) }) as unknown as Env;
const SENTINEL = 987_654_000;

/** A1 (plain 750,000 / Combo 1,000,000), a standalone AMS at 320,000 and a pre-order-cheaper X1, all V2-published. */
async function world(): Promise<DatabaseSync> {
  const raw = seed({ a1Now: 750_000, comboNow: 1_000_000 });
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_ams','ams-lite','Bambu AMS Lite','AMS لايت',320000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_hidden','hidden','Hidden printer','مخفية',400000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_x1','x1','Bambu X1','X1',470000,'active',3,'[]','[]','direct_sale','["direct_sale","pre_order"]','[]','cat_printers','cat_printers_fdm');
    UPDATE products SET direct_surcharge_iqd = 30000, preorder_transports = '[{"method":"air","commission_iqd":0,"active":true}]' WHERE id = 'p_x1';
  `);
  await publishSeededV2(raw);
  raw.exec(`UPDATE products SET status = 'hidden' WHERE id = 'p_hidden'`);
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
              ('p_new','new','Never priced','بلا تسعير',600000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm')`);
  // The legacy dinar columns become sentinels: today's price never reads them.
  const triggers = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('products', 'product_option_values')").map((t) => t.name);
  withoutTriggers(raw, triggers, `UPDATE products SET price_iqd = ${SENTINEL}; UPDATE product_option_values SET regular_price_iqd = ${SENTINEL}, regular_adjust_iqd = ${SENTINEL};`);
  return raw;
}

test('today: the direct price of a published SKU; a cheaper pre-order route wins; unlisted / hidden / never priced → null; no sentinel read', async () => {
  const raw = await world();
  const r = new TodayReader(envOf(raw));
  assert.deepEqual(await r.price({ productId: 'p_a1', optionValueIds: ['v_a1'], colorId: null }), { iqd: 750_000, channel: 'direct_sale' });
  assert.deepEqual(await r.price({ productId: 'p_a1', optionValueIds: ['v_a1c'], colorId: null }), { iqd: 1_000_000, channel: 'direct_sale' });
  const x1 = await r.price({ productId: 'p_x1', optionValueIds: [], colorId: null });
  assert.ok(x1, 'the X1 is priced');
  assert.equal(x1!.iqd, 470_000, JSON.stringify(x1));
  assert.match(x1!.channel, /^pre_order_/);
  assert.equal(await r.price({ productId: 'p_hidden', optionValueIds: [], colorId: null }), null);
  assert.equal(await r.price({ productId: 'p_new', optionValueIds: [], colorId: null }), null, '«يحتاج تسعيرًا»: never listed, never priced');
  assert.equal(await r.price({ productId: 'p_a1', optionValueIds: ['v_nope'], colorId: null }), null, 'a model the product does not carry');
  assert.deepEqual(await r.lowest('p_ams'), { iqd: 320_000, channel: 'direct_sale' });
  for (const p of [await r.lowest('p_a1'), await r.price({ productId: 'p_a1', optionValueIds: ['v_a1'], colorId: null })]) assert.notEqual(p?.iqd, SENTINEL);
});

const comboUnit = (plain: string | null) => ({
  product_id: 'p_a1',
  is_combo: true,
  selection: { option_value_ids: ['v_a1c'], color_id: null, combo_value_id: 'v_a1c', plain_value_id: plain },
});

test('B.4 rule 1: the AMS is the gap between the Combo and its plain sibling, the printer the plain model', async () => {
  const raw = await world();
  const env = envOf(raw);
  const n = await componentNows(env, new TodayReader(env), comboUnit('v_a1'), { amsReferenceIqd: 0, refs: [] });
  assert.deepEqual([n.combo_now, n.ams?.now_iqd, n.device?.now_iqd, n.ams?.source, n.split_unavailable], [1_000_000, 250_000, 750_000, 'combo_gap', false]);
});

test('B.4 rule 2: a linked standalone AMS caps the gap', async () => {
  const raw = await world();
  const env = envOf(raw);
  const refs = [{ product_id: 'p_a1', option_value_id: 'v_a1c', role: 'ams' as const, ref_product_id: 'p_ams', ref_price_usd: null }];
  // Gap 250,000 < standalone 320,000: rule 1 stands.
  assert.equal((await componentNows(env, new TodayReader(env), comboUnit('v_a1'), { amsReferenceIqd: 0, refs })).ams?.now_iqd, 250_000);
  // The Combo dearer (gap 450,000 > 320,000): the standalone caps it, the printer is the rest.
  const reader = new TodayReader(env);
  const realPrice = reader.price.bind(reader);
  reader.price = async (sel) => (sel.optionValueIds.includes('v_a1c') ? { iqd: 1_200_000, channel: 'direct_sale' } : realPrice(sel));
  const n = await componentNows(env, reader, comboUnit('v_a1'), { amsReferenceIqd: 0, refs });
  assert.deepEqual([n.ams?.now_iqd, n.device?.now_iqd, n.ams?.source], [320_000, 880_000, 'standalone_cap']);
});

test('B.4 rule 3: the plain model no longer sold — the standalone AMS, the printer the rest', async () => {
  const raw = await world();
  const env = envOf(raw);
  const refs = [{ product_id: 'p_a1', option_value_id: 'v_a1c', role: 'ams' as const, ref_product_id: 'p_ams', ref_price_usd: null }];
  const n = await componentNows(env, new TodayReader(env), comboUnit(null), { amsReferenceIqd: 0, refs });
  assert.deepEqual([n.ams?.now_iqd, n.device?.now_iqd, n.ams?.source], [320_000, 680_000, 'standalone']);
});

test('B.4 rule 4: the owner\'s USD reference (ceil to 1,000 at the approved rate), at most half the Combo; else the AMS rule set\'s dinar reference', async () => {
  const raw = await world();
  const env = envOf(raw);
  const refs = [{ product_id: 'p_a1', option_value_id: '', role: 'ams' as const, ref_product_id: null, ref_price_usd: '199.99' }];
  const n = await componentNows(env, new TodayReader(env), comboUnit(null), { amsReferenceIqd: 0, refs });
  assert.equal(n.ams?.now_iqd, usdToIqdCeil('199.99', '1500'));
  assert.equal(n.ams?.now_iqd, 300_000);
  assert.equal(n.ams?.source, 'owner_usd');
  const big = await componentNows(env, new TodayReader(env), comboUnit(null), { amsReferenceIqd: 0, refs: [{ ...refs[0], ref_price_usd: '999' }] });
  assert.equal(big.ams?.now_iqd, 500_000, 'at most half the Combo');
  const dinar = await componentNows(env, new TodayReader(env), comboUnit(null), { amsReferenceIqd: 210_000, refs: [] });
  assert.deepEqual([dinar.ams?.now_iqd, dinar.ams?.source], [210_000, 'ams_reference']);
  assert.equal(usdToIqdCeil('0.01', '1312.5'), 1000);
  assert.equal(usdToIqdCeil('200', '1500'), 300_000);
  assert.equal(usdToIqdCeil('x', '1500'), null);
});

test('B.4 rule 5: nothing to split by — the Combo is one machine; a device with no price today (and no reference) has no offer', async () => {
  const raw = await world();
  const env = envOf(raw);
  const n = await componentNows(env, new TodayReader(env), comboUnit(null), { amsReferenceIqd: 0, refs: [] });
  assert.deepEqual([n.split_unavailable, n.device?.now_iqd, n.ams?.now_iqd], [true, 1_000_000, 0]);
  const gone = await componentNows(env, new TodayReader(env), { product_id: 'p_hidden', is_combo: false, selection: { option_value_ids: [], color_id: null, combo_value_id: null, plain_value_id: null } }, { amsReferenceIqd: 0, refs: [] });
  assert.equal(gone.missing, true);
  // The owner named a successor for a device no longer sold.
  const successor = await componentNows(
    env,
    new TodayReader(env),
    { product_id: 'p_hidden', is_combo: false, selection: { option_value_ids: [], color_id: null, combo_value_id: null, plain_value_id: null } },
    { amsReferenceIqd: 0, refs: [{ product_id: 'p_hidden', option_value_id: '', role: 'device', ref_product_id: 'p_p1s', ref_price_usd: null }] }
  );
  assert.deepEqual([successor.missing, successor.device?.now_iqd, successor.device?.source], [false, 1_500_000, 'successor']);
});
