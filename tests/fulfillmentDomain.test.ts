import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelFulfillment, validateFulfillment, parseFulfillment, publicFulfillment, fulfillmentModes, fulfillmentTransports, type ModelFulfillment, type FulfillmentTier } from '../packages/pricing/src/fulfillment';
import { planLegacyModelNormalization } from '../packages/pricing/src/fulfillmentMigration';

const defaults: ModelFulfillment = {
  direct: { enabled: true, surcharge_iqd: 50_000, stock: 10 },
  preorder: { enabled: true, transports: {
    sea: { enabled: true, surcharge_iqd: 0, lead_time_min_days: 21, lead_time_max_days: 28 },
    land: { enabled: true, surcharge_iqd: 30_000, lead_time_min_days: 14, lead_time_max_days: 21 },
    air: { enabled: true, surcharge_iqd: 80_000, lead_time_min_days: 7, lead_time_max_days: 12 },
  } },
};
function resolve(patch: Partial<Parameters<typeof resolveModelFulfillment>[0]> = {}) {
  return resolveModelFulfillment({ productId: 'fixture-not-production', modelId: 'model', productRegularIqd: 1_000_000,
    modelPrices: { regular: 1_000_000, prime: 950_000, pro: 900_000 }, defaults,
    fulfillmentType: 'pre_order', transportMethod: 'sea', tier: 'regular', tierActive: false, ...patch });
}
for (const [method, surcharge] of [['sea',0],['land',30_000],['air',80_000]] as const) {
  test(`transport fixture ${method}: configured amount added once`, () => {
    const r = resolve({ transportMethod: method });
    assert.equal(r.ok, true); assert.equal(r.snapshot?.resolved_final_price, 1_000_000 + surcharge);
    assert.equal(r.snapshot?.resolved_transport_delta, surcharge);
  });
  test(`PRO transport fixture ${method}: model increase survives waiver`, () => {
    const r = resolve({ transportMethod: method, tier: 'pro', tierActive: true,
      modelPrices: { regular: 1_200_000, prime: 1_150_000, pro: 1_100_000 } });
    assert.equal(r.snapshot?.resolved_final_price, 1_100_000);
    assert.equal(r.snapshot?.resolved_option_delta, 200_000);
    assert.equal(r.pro_transport_waived_iqd, surcharge);
  });
}
test('model transport override replaces fallback, never sums with it', () => {
  const r = resolve({ defaults: { preorder: { enabled: true, transports: { air: { enabled: true, surcharge_iqd: 50_000 } } } },
    override: { preorder: { transports: { air: { surcharge_iqd: 80_000 } } } }, transportMethod: 'air' });
  assert.equal(r.snapshot?.resolved_final_price,1_080_000);
});
test('explicit zero transport override suppresses the parent fee', () => {
  assert.equal(resolve({ transportMethod: 'air', override: { preorder: { transports: { air: { surcharge_iqd: 0 } } } } }).snapshot?.resolved_final_price,1_000_000);
});
test('model direct adjustment replaces product direct fee', () => {
  const r = resolve({ fulfillmentType: 'direct_sale', transportMethod: null, override: { direct: { regular_adjust_iqd: 20_000 } } });
  assert.equal(r.snapshot?.resolved_final_price,1_020_000); assert.equal(r.snapshot?.resolved_fulfillment_delta,20_000);
});
test('fixed direct price does not get the product fee again', () => {
  const r = resolve({ fulfillmentType: 'direct_sale', transportMethod: null, override: { direct: { regular_price_iqd: 549_000, pro_price_iqd: 449_000 } } });
  assert.equal(r.snapshot?.resolved_final_price,549_000); assert.equal(r.prices?.pro,449_000);
});
for (const [name, pre, pro, direct] of [['A1 mini',499000,449000,549000],['A1 mini Combo',679000,639000,699000]] as const) {
  for (const tier of ['regular','prime','pro'] as FulfillmentTier[]) {
    test(`${name} ${tier}: same model supports direct and preorder`, () => {
      const override: ModelFulfillment = { direct: { enabled: true, regular_price_iqd: direct, pro_price_iqd: pro }, preorder: { enabled: true, regular_price_iqd: pre, pro_price_iqd: pro } };
      const p = resolve({ override, tier, tierActive: true });
      const d = resolve({ override, tier, tierActive: true, fulfillmentType: 'direct_sale', transportMethod: null });
      assert.equal(p.prices?.regular,pre); assert.equal(d.prices?.regular,direct);
      assert.equal(p.prices?.pro,pro); assert.equal(d.prices?.pro,pro);
      assert.equal(p.snapshot?.model_id,d.snapshot?.model_id);
    });
  }
}
test('exact transport fixed total outranks inherited fees and does not waive a model total', () => {
  const r = resolve({ transportMethod:'air', tier:'pro', tierActive:true, override: { preorder: { transports: { air: { regular_price_iqd:1_100_000,pro_price_iqd:975_000 } } } } });
  assert.equal(r.snapshot?.resolved_final_price,975_000);assert.equal(r.pro_transport_waived_iqd,0);
});
test('transport tier adjustment is independent and pro exemption is configurable', () => {
  const r = resolve({ transportMethod:'air', tier:'pro', tierActive:true, override: { preorder: { pro_exempt_transport:false, transports: { air: { prime_adjust_iqd:20_000,pro_adjust_iqd:10_000 } } } } });
  assert.equal(r.prices?.regular,1_080_000);assert.equal(r.prices?.prime,970_000);assert.equal(r.snapshot?.resolved_final_price,910_000);
});
test('expired PRO membership gets regular price and no exemption', () => {
  const r=resolve({transportMethod:'air',tier:'pro',tierActive:false});
  assert.equal(r.snapshot?.membership_tier,'regular');assert.equal(r.snapshot?.resolved_final_price,1_080_000);
});
test('direct stock is never consumed or required for preorder selection', () => {
  const override:ModelFulfillment={direct:{stock:0}};
  assert.equal(resolve({override}).ok,true);
  const direct=resolve({override,fulfillmentType:'direct_sale',transportMethod:null});
  assert.equal(direct.ok,false);assert.ok(direct.errors.includes('DIRECT_OUT_OF_STOCK'));assert.equal(direct.snapshot,null);
});
test('disabled model/type/transport is rejected with no chargeable snapshot', () => {
  for(const patch of [ {modelActive:false}, {override:{preorder:{enabled:false}}}, {override:{preorder:{transports:{sea:{enabled:false}}}}} ]){
    const r=resolve(patch);assert.equal(r.ok,false);assert.equal(r.snapshot,null);assert.equal(r.prices,null);
  }
});
test('transport is required for preorder and forbidden for direct', () => {
  assert.ok(resolve({transportMethod:null}).errors.includes('TRANSPORT_REQUIRED'));
  assert.ok(resolve({fulfillmentType:'direct_sale',transportMethod:'air'}).errors.includes('DIRECT_HAS_NO_TRANSPORT'));
  assert.ok(resolve({transportMethod:'space'}).errors.includes('TRANSPORT_UNAVAILABLE'));
});
test('partial lead-time overrides are merged and validated', () => {
  const r=resolve({override:{preorder:{transports:{sea:{lead_time_text:'Owner-authored estimate',lead_time_min_days:24}}}}});
  assert.deepEqual(r.snapshot?.lead_time,{text:'Owner-authored estimate',min_days:24,max_days:28});
  assert.ok(resolve({override:{preorder:{transports:{sea:{lead_time_min_days:40}}}}}).errors.includes('LEAD_TIME_INVALID'));
});
test('snapshot components reconcile for every tier, mode and transport', () => {
  for(const tier of ['regular','prime','pro'] as const)for(const method of ['air','sea','land',null] as const){
    const r=resolve({tier,tierActive:true,fulfillmentType:method?'pre_order':'direct_sale',transportMethod:method});
    const s=r.snapshot!;assert.ok(s);
    assert.equal(s.resolved_base_price+s.resolved_option_delta+s.resolved_fulfillment_delta+s.resolved_transport_delta+s.resolved_membership_adjustment,s.resolved_final_price);
  }
});
test('snapshots are detached from subsequent product edits', () => {
  const cfg=parseFulfillment(defaults)!;const r=resolve({defaults:cfg});
  cfg.preorder!.transports!.sea!.lead_time_min_days=99;
  assert.equal(r.snapshot?.lead_time.min_days,21);
});
test('negative adjustments are allowed but invalid or overflowing totals are not prices', () => {
  assert.equal(resolve({override:{preorder:{regular_adjust_iqd:-20000}}}).snapshot?.resolved_final_price,980000);
  for(const value of [NaN,Infinity,1.5,2_000_000_001])assert.equal(resolve({override:{preorder:{regular_price_iqd:value}}}).ok,false);
  assert.equal(resolve({override:{preorder:{regular_adjust_iqd:-2_000_000}}}).ok,false);
});
test('strict validation rejects typo keys, mixed price modes and misplaced stock', () => {
  for(const raw of [[],{air:{}},{direct:{enabled:'false'}},{preorder:{stock:3}},{direct:{regular_price_iqd:1,regular_adjust_iqd:2}},{preorder:{transports:{space:{enabled:true}}}}])assert.ok(validateFulfillment(raw).length);
  assert.deepEqual(validateFulfillment(defaults),[]);
});
test('JSON round trip preserves false, explicit zero and inherited null', () => {
  const input:ModelFulfillment={direct:{enabled:false,regular_price_iqd:null},preorder:{enabled:true,transports:{sea:{enabled:true,surcharge_iqd:0}}}};
  const restored=parseFulfillment(JSON.stringify(input));assert.deepEqual(restored,input);
  assert.deepEqual(fulfillmentModes({},restored),['pre_order']);assert.deepEqual(fulfillmentTransports({},restored),['sea']);
});
test('public nested fulfillment never exposes cost or cost adjustments', () => {
  const input:ModelFulfillment={direct:{cost_iqd:1,cost_adjust_iqd:null},preorder:{cost_iqd:2,transports:{air:{cost_iqd:3,cost_adjust_iqd:4}}}};
  assert.doesNotMatch(JSON.stringify(publicFulfillment(input)),/cost/);
  assert.equal(input.preorder?.transports?.air?.cost_iqd,3);
});
test('legacy A1 rows normalize to two actual models, with all original IDs and metadata retained', () => {
  const rows=[['a1','A1 mini',499000,449000,549000],['combo','A1 mini Combo',679000,639000,699000]] as const;
  const input=rows.flatMap(([key,label,pre,pro,direct])=>[
    {id:key+'-pre',name_en:label+' — Pre-order',variant_key:key,variant_label:label,availability_type:'pre_order',regular_price_iqd:pre,pro_price_iqd:pro,cost_iqd:123,image:'/assets/pre.webp',sku_part:key+'-P',lead_time_text:'estimate'},
    {id:key+'-direct',name_en:label+' — Direct',variant_key:key,variant_label:label,availability_type:'direct_sale',regular_price_iqd:direct,pro_price_iqd:pro,stock:4,cost_iqd:234,image:'/assets/direct.webp',sku_part:key+'-D'},
  ]);
  const plan=planLegacyModelNormalization(input);assert.deepEqual(plan.conflicts,[]);assert.equal(plan.models.length,2);assert.equal(plan.aliases.length,4);
  for(const model of plan.models){assert.equal(model.availability_type,'');assert.equal(model.fulfillment?.direct?.stock,4);assert.equal(model.fulfillment?.preorder?.cost_iqd,123);assert.equal(model.fulfillment?.direct?.cost_iqd,234);}
  assert.deepEqual(plan.aliases.map(a=>a.original),input);
  const again=planLegacyModelNormalization(plan.models);assert.equal(again.changed,false);assert.deepEqual(again.models,plan.models);
});
test('ambiguous duplicate type rows abort the whole model plan without guessing', () => {
  const input=[1,2].map(n=>({id:String(n),name_en:'A1',variant_key:'a1',availability_type:'direct_sale',regular_price_iqd:n}));
  const result=planLegacyModelNormalization(input);assert.equal(result.changed,false);assert.equal(result.aliases.length,0);assert.deepEqual(result.models,input);assert.equal(result.conflicts[0]?.reason,'DUPLICATE_FULFILLMENT_ROWS');
});
test('variant keys never merge unrelated option groups', () => {
  const result=planLegacyModelNormalization(['one','two'].map(group_id=>({id:group_id,name_en:'A1',variant_key:'a1',group_id,availability_type:'direct_sale'})));
  assert.equal(result.models.length,2);assert.deepEqual(result.conflicts,[]);
});
test('a pre-order row with held inventory cannot be collapsed behind a different ID', () => {
  const result=planLegacyModelNormalization([{id:'p',name_en:'A1',variant_key:'a1',availability_type:'pre_order',reserved:1},{id:'d',name_en:'A1',variant_key:'a1',availability_type:'direct_sale'}]);
  assert.equal(result.changed,false);assert.equal(result.conflicts[0]?.reason,'LEGACY_ROW_HAS_RESERVATIONS');
});
