import { resolveUnitPrice, type PricingProduct, type OptionV2, type ProPricingPolicy } from '../../../../worker/lib/pricing';
import type { FormValue } from './model';

export type FulfillmentDefaults = Pick<PricingProduct, 'sale_types' | 'preorder_transports' | 'direct_surcharge_iqd'> & { pricing_ready?: boolean; proPolicy?:ProPricingPolicy; transportDefaults?:Array<{method:string;commission_iqd:number}> };
export function ModelPricePreview({ value, base, defaults }: { value: FormValue; base: Record<'regular'|'prime'|'pro'|'cost', number|null>; defaults: FulfillmentDefaults }) {
  if (!defaults.pricing_ready) return <p className="text-xs text-zinc-400">معاينة السعر بانتظار إعدادات التسعير…</p>;
  const product: PricingProduct = { price_iqd:base.regular ?? 0, prime_price_iqd:base.prime, pro_price_iqd:base.pro, product_cost_iqd:base.cost, selling_type:'direct_sale', ...defaults, colors:[], warranty_plans:[], options:[{...value,name_ar:'',name_ckb:'',order:value.sort} as OptionV2] };
  const explicit = value.direct !== undefined || value.preorder !== undefined;
  const direct = explicit ? value.direct?.enabled : defaults.sale_types?.includes('direct_sale');
  const pre = explicit ? value.preorder?.enabled : defaults.sale_types?.includes('pre_order');
  const methods = value.preorder?.transports?.filter(t=>t.enabled).map(t=>t.method) ?? defaults.preorder_transports.filter(t=>t.active).map(t=>t.method);
  const routes: Array<{name:string; method:string|null;type:'direct_sale'|'pre_order'}> = [...(direct ? [{name:'بيع مباشر',method:null,type:'direct_sale' as const}] : []), ...(pre ? methods.map(method=>({name:method.toUpperCase(),method,type:'pre_order' as const})) : [])];
  return <div className="overflow-x-auto" data-model-price-preview={value.id}><table className="w-full text-xs tabular-nums"><caption className="text-start text-zinc-400 py-2">معاينة سعر الوحدة حسب العضوية، قبل التوصيل المحلي</caption><thead><tr><th>التنفيذ</th><th>Regular</th><th>PRIME</th><th>PRO</th></tr></thead><tbody>{routes.map(r=><tr key={r.name}><th className="p-2 text-start">{r.name}</th>{(['free','prime','pro'] as const).map(tier=>{const price=resolveUnitPrice({product,optionId:value.id,fulfillmentType:r.type,transportMethod:r.method,tier,tierActive:true,proPolicy:defaults.proPolicy,transportDefaults:defaults.transportDefaults});return <td key={tier} className="p-2 text-center">{price.errors.length ? '—' : price.unit_subtotal_iqd.toLocaleString('en-US')}</td>;})}</tr>)}</tbody></table></div>;
}
