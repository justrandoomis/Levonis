import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, type PricingProduct, type OptionV2 } from '../packages/pricing/src/pricing';
import { fulfillmentDefaultsFor, canonicalModelSelection } from '../packages/pricing/src/fulfillmentPricing';
const model: OptionV2 = { id:'model', name_ar:'', name_en:'Combo', name_ckb:'', image:'', active:true, order:0,
  regular_price_iqd:null, prime_price_iqd:null, pro_price_iqd:null, cost_iqd:null, regular_adjust_iqd:200_000,
  fulfillment:{direct:{enabled:true},preorder:{enabled:true}} };
function product(): PricingProduct { return { id:'test-only', price_iqd:1_000_000, prime_price_iqd:null, pro_price_iqd:900_000, product_cost_iqd:700_000,
  selling_type:'direct_sale',sale_types:['direct_sale','pre_order'],direct_surcharge_iqd:50_000,
  options:[structuredClone(model)],colors:[],warranty_plans:[],
  preorder_transports:[{method:'sea',active:true,commission_iqd:0},{method:'land',active:true,commission_iqd:30_000},{method:'air',active:true,commission_iqd:80_000}]
}; }
function resolve(p=product(),patch:Partial<Parameters<typeof resolveUnitPrice>[0]>={}){return resolveUnitPrice({product:p,optionId:'model',transportMethod:'air',tier:'free',tierActive:false,...patch});}
function reconciles(r:ReturnType<typeof resolveUnitPrice>){assert.equal(r.unit_subtotal_iqd,r.applied_iqd+(r.direct&&!r.direct.waived?r.direct.surcharge_iqd:0)+(r.transport&&!r.transport.waived?r.transport.commission_iqd:0)+(r.warranty?.fee_iqd??0));}
test('existing central resolver accepts structured models and separates charged fees',()=>{
  const r=resolve();assert.deepEqual(r.errors,[]);assert.equal(r.unit_subtotal_iqd,1_280_000);assert.equal(r.transport?.commission_iqd,80_000);assert.equal(r.applied_iqd,1_200_000);reconciles(r);
});
test('PRO exemption keeps the model delta in the central resolver',()=>{
  const r=resolve(product(),{tier:'pro',tierActive:true});assert.equal(r.unit_subtotal_iqd,1_100_000);assert.equal(r.transport?.waived,true);reconciles(r);
});
test('per-model transport replacement and direct fixed totals use the existing entry point',()=>{
  const p=product();p.options[0].fulfillment={direct:{enabled:true,regular_price_iqd:1_350_000,pro_price_iqd:1_125_000},preorder:{transports:{air:{surcharge_iqd:20_000}}}};
  const air=resolve(p);assert.equal(air.unit_subtotal_iqd,1_220_000);reconciles(air);
  const direct=resolve(p,{transportMethod:null,fulfillmentType:'direct_sale'});assert.equal(direct.unit_subtotal_iqd,1_350_000);assert.equal(direct.direct,null);reconciles(direct);
});
test('structured COD preserves pre-order journey but follows configured direct price',()=>{
  const r=resolve(product(),{preorderPricing:'cod'});assert.equal(r.unit_subtotal_iqd,1_250_000);assert.equal(r.transport?.waived_by,'cod_direct_pricing');assert.equal(r.fulfillment_snapshot?.fulfillment_type,'pre_order');assert.equal(r.fulfillment_snapshot?.transport_method,'air');reconciles(r);
});
test('a pre-order-only product with no direct price keeps commission under COD',()=>{
  const p=product();p.direct_surcharge_iqd=null;p.sale_types=['pre_order'];p.options[0].fulfillment={direct:{enabled:false},preorder:{enabled:true}};
  const r=resolve(p,{preorderPricing:'cod'});assert.equal(r.unit_subtotal_iqd,1_280_000);assert.equal(r.pricing_basis,'preorder');reconciles(r);
});
test('an unconfigured enabled transport fails rather than inventing a zero fee',()=>{
  const p=product();p.preorder_transports=[];p.options[0].fulfillment={preorder:{enabled:true,transports:{air:{enabled:true}}}};
  assert.ok(resolve(p).errors.includes('TRANSPORT_COMMISSION_UNCONFIGURED'));
});
test('model transport can inherit an admin default without a fake product option',()=>{
  const p=product();p.preorder_transports=[];p.options[0].fulfillment={preorder:{enabled:true,transports:{air:{enabled:true}}}};
  const r=resolve(p,{transportDefaults:[{method:'air',commission_iqd:22_000}]});assert.equal(r.unit_subtotal_iqd,1_222_000);assert.equal(p.options.length,1);reconciles(r);
});
test('public fee contract reconciles every member and payment mode',()=>{
  for(const tier of ['free','prime','pro'] as const)for(const active of [false,true])for(const method of ['air','sea','land',null])for(const pay of ['prepaid','cod'] as const){const r=resolve(product(),{tier,tierActive:active,transportMethod:method,preorderPricing:pay});assert.deepEqual(r.errors,[]);reconciles(r);}
});
test('a legacy option ID resolves to its actual model and original fulfillment',()=>{
  const p=product();p.options[0].legacy_fulfillment_ids=[{id:'old-pre',fulfillment_type:'pre_order'}];
  assert.deepEqual(canonicalModelSelection(p.options,'old-pre'),{id:'model',legacyType:'pre_order'});
  const r=resolve(p,{optionId:'old-pre'});assert.deepEqual(r.errors,[]);assert.equal(r.fulfillment_snapshot?.model_id,'model');
  assert.ok(resolve(p,{optionId:'old-pre',fulfillmentType:'direct_sale',transportMethod:null}).errors.includes('LEGACY_FULFILLMENT_MISMATCH'));
});
test('legacy products without structured fulfillment keep their established price breakdown',()=>{
  const p=product();delete p.options[0].fulfillment;
  const r=resolve(p);assert.equal(r.unit_subtotal_iqd,1_280_000);assert.equal(r.fulfillment_snapshot,undefined);reconciles(r);
});
test('cost follows actual procurement fulfillment even when COD price uses direct',()=>{
  const p=product();p.options[0].fulfillment={direct:{cost_iqd:760_000},preorder:{cost_iqd:710_000,transports:{air:{cost_adjust_iqd:40_000}}}};
  const r=resolve(p,{preorderPricing:'cod'});assert.equal(r.cost_iqd,750_000);reconciles(r);
});
test('structured product defaults retain explicit false and zero',()=>{
  const p=product();p.fulfillment={direct:{enabled:false},preorder:{transports:{air:{surcharge_iqd:0}}}};
  const d=fulfillmentDefaultsFor(p);assert.equal(d.direct?.enabled,false);assert.equal(d.preorder?.transports?.air?.surcharge_iqd,0);
});
