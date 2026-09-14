import type { ShippingQuote } from './shipping';

interface SnapshotLine { product_id:string; qty:number; unit:number; name:string; name_ar:string; variant:string; option_id:string; color_id:string; image:string; selection_snapshot?:string; pricing_snapshot:string; warranty_snapshot:string|null; transport_snapshot:string|null }
/** Shipping is quoted once for the order. Allocate that exact integer fee,
 * first by its product-owned components, then the shared remainder; never run
 * the delivery formula a second time or round a per-unit fee independently. */
export function freezeOrderSelections<T extends SnapshotLine>(lines:T[], shipping:ShippingQuote, deliveryMethod:string): void {
  const fees=lines.map(()=>0);
  const allocate=(amount:number,indices:number[])=>{
    const total=indices.reduce((n,i)=>n+lines[i].qty,0); if (!total) return;
    let left=amount;
    indices.forEach((i,p)=>{const fee=p===indices.length-1 ? left : Math.floor(amount*lines[i].qty/total);fees[i]+=fee;left-=fee;});
  };
  let assigned=0;
  for (const component of shipping.components) {
    if (!component.product_id || component.waived) continue;
    const indices=lines.flatMap((line,i)=>line.product_id===component.product_id ? [i] : []);
    if (!indices.length) continue;
    allocate(component.fee_iqd,indices);assigned+=component.fee_iqd;
  }
  allocate(Math.max(0,shipping.total_iqd-assigned),lines.map((_,i)=>i));
  lines.forEach((line,i)=>{
    const pricing=JSON.parse(line.pricing_snapshot || '{}');
    const snapshot=JSON.parse(line.selection_snapshot || '{}');
    const transport=line.transport_snapshot ? JSON.parse(line.transport_snapshot) : null;
    const base=Object.keys(snapshot).length ? snapshot : pricing.selection_snapshot ?? {resolved_product_base:line.unit,resolved_option_delta:0,resolved_fulfillment_delta:0,resolved_transport_delta:0,resolved_membership_adjustment:0,lead_time:{text:'',min_days:null,max_days:null}};
    line.selection_snapshot=JSON.stringify({...base,product_id:line.product_id,option_id:line.option_id || null,variant_key:base.variant_key ?? '',product_name:line.name_ar || line.name,option_name:line.variant,color_id:line.color_id || null,image:line.image,warranty:line.warranty_snapshot ? JSON.parse(line.warranty_snapshot) : null,fulfillment_type:base.fulfillment_type ?? (transport?.method ? 'pre_order' : 'direct_sale'),transport_method:base.transport_method ?? transport?.method ?? null,membership_tier:base.membership_tier ?? pricing.applied_tier ?? 'regular',local_delivery_method:deliveryMethod,quantity:line.qty,resolved_unit_price:line.unit,resolved_delivery_fee:fees[i],resolved_final_price:line.unit*line.qty+fees[i],delivery_snapshot:shipping.components.filter(c=>!c.product_id || c.product_id===line.product_id),delivery_waiver_source:shipping.waiver_source});
  });
}
