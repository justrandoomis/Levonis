import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { loadProductPricing, type RuleWrite } from '../worker/lib/pricingEngine/store';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { directPurchaseStore } from '../worker/lib/pricingEngine/directPurchase';
import { evaluateCompleteness, evaluateDraft, recomputeCompleteness, recomputeCost } from '../worker/lib/productCompleteness';
import { completenessInstalled, listedProductBySlug } from '../worker/lib/listing';
import { countingD1 } from '../worker/lib/d1Count';
import { mergedRules } from '../worker/lib/pricingEngine/fromPurchase';
import { saleAvailability } from '../worker/routes/products';

function readyWorld(directOnly = true) {
  const w = pricingWorld();
  w.raw.exec(`
    INSERT INTO catalogs (id,slug,name_ar,name_en,name_ckb,sort,active) VALUES ('proof_cat','proof-cat','قسم','Section','بەش',0,1);
    UPDATE products SET product_cost_iqd=NULL,
      category_id='proof_cat', package_weight_g=2500, package_width_mm=300, package_depth_mm=200, package_height_mm=100
      WHERE id='${AMS}';
    UPDATE product_option_values SET cost_iqd=NULL,cost_adjust_iqd=NULL WHERE product_id='${AMS}';
    UPDATE product_option_fulfillment SET cost_iqd=NULL,cost_adjust_iqd=NULL WHERE product_id='${AMS}';
    INSERT INTO product_images (id,product_id,url,r2_key,content_type,bytes,width,height,sort_order,is_primary)
      VALUES ('proof_img','${AMS}','/files/products/proof.webp','products/proof.webp','image/webp',1000,800,600,0,1);
    INSERT INTO admin_settings(key,value) VALUES ('catalogHideIncomplete','{"enabled":true}')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  if (directOnly) w.raw.exec(`
    UPDATE products SET sale_types='["direct_sale"]', selling_type='direct_sale' WHERE id='${AMS}';
    DELETE FROM product_option_transports WHERE product_id='${AMS}';
    DELETE FROM product_option_fulfillment WHERE product_id='${AMS}' AND fulfillment_type='pre_order';
  `);
  return w;
}

async function adoptStock(w: ReturnType<typeof readyWorld>) {
  const id = await w.save(w.draft());
  const preview = await w.preview({ purchase_id: id, pricing: {
    minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }],
    direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 50000 }],
  }});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const product = preview.body.products[0];
  assert.equal(product.adoption.complete, true, JSON.stringify(product.adoption));
  assert.deepEqual(product.adoption.rows.map((r: { channel: string }) => r.channel), ['direct_sale']);
  const apply = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true,
    minimum_profits: [{ scope:'product', amount_usd:'120' }], direct_sale_extras:[{scope:'product',amount_iqd:50000}]
  });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  assert.equal(apply.body.priced, true);
}

test('complete direct-only stock adoption satisfies completeness and stays listed without shared pricing inputs', async () => {
  const w = readyWorld();
  await adoptStock(w);
  const s = await loadProductPricing(w.db, AMS);
  assert.equal(s.state?.mode, 'engine');
  assert.equal(s.direct_purchase?.direct_only, true);
  assert.equal(s.inputs.length, 0);
  assert.equal(s.rules.length, 0);
  const loaded = (await loadProducts(w.db,[AMS])).get(AMS)!;
  const effective = directPurchaseStore(s);
  assert.deepEqual(evaluateCompleteness({id:AMS,doc:loaded.doc,view:loaded.view,mode:'engine',inputs:effective.inputs,rules:effective.rules,category_ok:true,blocked:''}), []);
  const result = await recomputeCompleteness(w.db,[AMS]);
  assert.deepEqual(result.verdicts[0]!.items, []);
  assert.deepEqual(await evaluateDraft(w.db, { id: AMS, doc: loaded.doc, view: loaded.view, mode: 'engine' }), []);
  const held = w.raw.prepare('SELECT complete,held,missing_json FROM product_completeness WHERE product_id=?').get(AMS);
  assert.equal(held?.held, 0);
  assert.ok(await listedProductBySlug(w.db, loaded.doc.slug));
  const counted = countingD1(w.db);
  await completenessInstalled(counted.db);
  const before = counted.executed;
  const report = await recomputeCompleteness(counted.db, [AMS]);
  const actual = counted.executed - before;
  assert.equal(actual, report.statements, 'reported statements include the durable overlay read');
  assert.equal(actual, recomputeCost(1), 'the sweep budget reserves the actual recompute cost');
});

test('a direct stock basis satisfies a mixed model but never completes a separate preorder-only model', async () => {
  const w = readyWorld(false);
  await adoptStock(w);
  assert.deepEqual((await recomputeCompleteness(w.db, [AMS])).verdicts[0]!.items, []);
  // Synthetic catalogue maintenance uses the same engine price token as its writer.
  w.raw.prepare('INSERT INTO ops_guards (id,ok) VALUES (?,1)').run(`engine-price:${AMS}`);
  const group = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id=?').get(AMS_MODEL)!.group_id;
  w.raw.prepare(`INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock)
    VALUES ('proof_pre',?,?,'Preorder model','طلب مسبق',1,1,0)`).run(AMS, group);
  w.raw.prepare(`INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled)
    VALUES ('proof_pre_cell',?,'proof_pre','pre_order',1)`).run(AMS);
  w.raw.prepare(`INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled)
    VALUES ('proof_pre_land',?,'proof_pre_cell','land',1)`).run(AMS);
  w.raw.prepare('DELETE FROM ops_guards WHERE id=?').run(`engine-price:${AMS}`);
  const expected = [{ code: 'COST', option_id: 'proof_pre' }, { code: 'ENGINE_INPUTS', option_id: 'proof_pre' }];
  assert.deepEqual((await recomputeCompleteness(w.db, [AMS])).verdicts[0]!.items, expected);
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  assert.deepEqual(await evaluateDraft(w.db, { id: AMS, doc: loaded.doc, view: loaded.view, mode: 'engine' }), expected);
  assert.equal(w.raw.prepare('SELECT held FROM product_completeness WHERE product_id=?').get(AMS)!.held, 1);
});

test('draft owner supplier clearing supersedes stock supplier while an unrelated weight edit preserves it', async () => {
  const w = readyWorld();
  const authored = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, inputs: [{
    scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '100', supplier_cost_currency: 'EUR',
    shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500,
  }] });
  assert.equal(authored.status, 200, JSON.stringify(authored.body));
  await adoptStock(w);
  const s = await loadProductPricing(w.db, AMS);
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  const draft = { id: AMS, doc: loaded.doc, view: loaded.view, mode: 'engine' as const, rules: s.rules };
  assert.deepEqual(await evaluateDraft(w.db, { ...draft, inputs: s.inputs.map((r) => ({ ...r, shipping_weight_g: 3000 })) }), []);
  assert.deepEqual(await evaluateDraft(w.db, { ...draft, inputs: s.inputs.map((r) => ({ ...r, supplier_cost_amount: null, supplier_cost_currency: null })) }), [{ code: 'COST', option_id: AMS_MODEL }]);
  const clearTarget: RuleWrite = {
    kind: 'target_profit', scope: 'product', scope_id: '', existing: null,
    next: { state: 'INHERIT', amount_usd: null, amount_iqd: null, source: 'OWNER', legacy_result_id: null },
  };
  assert.deepEqual(await evaluateDraft(w.db, {
    ...draft, stored: s, inputs: s.inputs, rules: mergedRules(s, [clearTarget]), ruleWrites: [clearTarget],
  }), [{ code: 'ENGINE_INPUTS', option_id: AMS_MODEL }]);
  // Draft checks never persist the proposed clear or alter the stock basis.
  assert.equal(directPurchaseStore(await loadProductPricing(w.db, AMS)).inputs.find((r) => r.scope_id === AMS_MODEL)!.supplier_cost_amount, '450');
});

test('a secondary preorder-only selection cannot inherit completeness from its direct model stock basis', async () => {
  const w = readyWorld(false);
  await adoptStock(w);
  w.raw.prepare('INSERT INTO ops_guards (id,ok) VALUES (?,1)').run(`engine-price:${AMS}`);
  w.raw.prepare(`INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('proof_size_group',?,'Size',1,1)`).run(AMS);
  w.raw.prepare(`INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active,stock,availability_type)
    VALUES ('proof_neutral_size',?,'proof_size_group','Standard',0,1,5,''),
      ('proof_pre_size',?,'proof_size_group','Preorder size',1,1,5,'pre_order')`).run(AMS, AMS);
  w.raw.prepare('DELETE FROM ops_guards WHERE id=?').run(`engine-price:${AMS}`);
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  assert.ok(saleAvailability(loaded.doc, { optionValueIds: [AMS_MODEL, 'proof_neutral_size'] }).modes.some((m) => m.type === 'direct_sale'));
  assert.equal(saleAvailability(loaded.doc, { optionValueIds: [AMS_MODEL, 'proof_pre_size'] }).modes.some((m) => m.type === 'direct_sale'), false);
  const expected = [{ code: 'COST', option_id: AMS_MODEL }, { code: 'ENGINE_INPUTS', option_id: AMS_MODEL }];
  assert.deepEqual((await recomputeCompleteness(w.db, [AMS])).verdicts[0]!.items, expected);
  assert.deepEqual(await evaluateDraft(w.db, { id: AMS, doc: loaded.doc, view: loaded.view, mode: 'engine' }), expected);
});
