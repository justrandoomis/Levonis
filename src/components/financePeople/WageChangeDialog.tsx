import { ApiError } from '../../lib/api';
import { useEffect, useRef, useState } from 'react';
import { Check, CalendarDays, ArrowRightLeft } from 'lucide-react';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { NumberInput } from '../ui/NumberInput';
import { Select } from '../ui/Field';
import { api, Button, dateLabel, Dialog, Feedback, Field, Input, Money, PEOPLE, useLanguage, useMutation } from './shared';

type Scope={catalog_ids:string[];product_ids:string[];excluded_product_ids:string[]};
type Rule={id:string;version:number;amount:number;basis:string;active:number;cap_iqd?:number|null;scope?:Scope;target_type?:string;target_id?:string;requires_assignment:number};
type Named={id:string;name?:string;name_ar?:string;name_en?:string};
export type WageImpact={preview_token:string;preview_job_id?:string;complete?:boolean;processed_orders?:number;from:string;until:string|null;orders_count:number;units_count:number;previous_iqd:number;corrected_iqd:number|null;delta_iqd:number;paid_iqd:number;held_iqd:number;pending_costs:number;manual_overrides:number;investor_delta_iqd:number|null;owner_delta_iqd:number|null;withdrawals:{id:string;amount_iqd:number;paid_iqd:number}[];after_balance:{ledgers:{staff:{net_iqd:number;debt_iqd:number;available_iqd:number}}}};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export default function WageChangeDialog({rule,staff,catalogs,products:knownProducts,onClose,onSaved}:{rule:Rule;staff:{name:string;start_work_date?:string|null};catalogs:Named[];products:Named[];onClose:()=>void;onSaved:(result:Record<string,never>)=>void}){
  const {loc,lang}=useLanguage(),op=useMutation();
  const [step,setStep]=useState(0),[basis,setBasis]=useState(rule.basis),[amount,setAmount]=useState<number|null>(rule.basis.endsWith('percent')?rule.amount/100:rule.amount);
  const [from,setFrom]=useState(today),[until,setUntil]=useState(''),[reason,setReason]=useState('');
  const [scope,setScope]=useState<Scope>(rule.scope??{catalog_ids:rule.target_type==='catalog'&&rule.target_id?[rule.target_id]:[],product_ids:rule.target_type==='product'&&rule.target_id?[rule.target_id]:[],excluded_product_ids:[]});
  const [products,setProducts]=useState(knownProducts),[active,setActive]=useState(!!rule.active),[release,setRelease]=useState(false);
  const [preview,setPreview]=useState<WageImpact|null>(null);const operation=useRef(crypto.randomUUID());
  const percent=basis.endsWith('percent');
  const payload=()=>({version:rule.version,basis,amount:percent?Math.round((amount??0)*100):amount,effective_from:from,effective_to:until||null,reason:reason.trim(),scope,active});
  const mounted=useRef(true),previewJob=useRef<string|undefined>(undefined);
  const [processed,setProcessed]=useState<number|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const inspect=()=>op.run(async()=>{
    let result:WageImpact;
    const key=`wage-preview:${rule.id}`,request=JSON.stringify(payload());
    try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');previewJob.current=saved?.request===request?saved.id:undefined;}catch{previewJob.current=undefined;}
    setProcessed(0);
    try{
      do {result=await api.post<WageImpact>(`${PEOPLE}/rules/${encodeURIComponent(rule.id)}/preview`,{...payload(),preview_job_id:previewJob.current},{mascot:'silent'});previewJob.current=result.preview_job_id;sessionStorage.setItem(key,JSON.stringify({request,id:result.preview_job_id}));if(mounted.current)setProcessed(result.processed_orders??result.orders_count);}while(mounted.current&&result.complete===false);
      if(mounted.current){setPreview(result);setRelease(false);setStep(2);}
    }catch(e){if(e instanceof ApiError && e.status>=400 && e.status<500){sessionStorage.removeItem(key);previewJob.current=undefined;}throw e;}
    finally{if(mounted.current)setProcessed(null);}
  });
  const save=()=>op.run(async()=>{if(!preview)return;const result=await api.post<Record<string,never>>(`${PEOPLE}/rules/${encodeURIComponent(rule.id)}/apply`,{...payload(),preview_token:preview.preview_token,preview_job_id:preview.preview_job_id,operation_id:operation.current,release_withdrawals:release});onSaved(result);});
  const toggle=(key:keyof Scope,id:string)=>setScope(s=>({...s,[key]:s[key].includes(id)?s[key].filter(v=>v!==id):[...s[key],id]}));
  const name=(id:string)=>{const n=[...catalogs,...products].find(v=>v.id===id);return n?.name_ar||n?.name||n?.name_en||id;};
  return <Dialog open dirty busy={op.busy} title={loc('تغيير الأجر','Change pay')} onClose={onClose}>
    <p className="fp-muted">{staff.name}</p>
    <ol className="fp-steps">{[loc('الأجر والنطاق','Pay and scope'),loc('تاريخ السريان','Effective date'),loc('معاينة الأثر','Review impact')].map((label,i)=><li key={i} aria-current={step===i?'step':undefined} data-done={step>i}>{i+1}. {label}</li>)}</ol>
    <Feedback error={op.error}/>{processed!==null&&<p role="status" className="fp-note">{loc(`جارٍ فحص الأثر · ${processed} طلب تمت مراجعته`,`Reviewing impact · ${processed} orders checked`)}</p>}
    {step===0&&<div className="fp-stack">
      <Field label={loc('طريقة الحساب','Calculation')}><Select value={basis} onChange={e=>{setBasis(e.target.value);setAmount(null);}}><option value="unit">{loc('أجر لكل قطعة','Pay per unit')}</option><option value="order">{loc('أجر لكل طلب','Pay per order')}</option><option value="revenue_percent">{loc('نسبة من صافي المبيعات','Share of net sales')}</option><option value="profit_percent">{loc('نسبة من ربح البضاعة','Share of goods profit')}</option></Select></Field>
      <Field label={percent?loc('النسبة الجديدة','New percentage'):loc('الأجر الجديد','New pay')}><NumberInput kind={percent?'number':'money'} value={amount} min={0} max={percent?100:undefined} unit={percent?'%':undefined} onValueChange={(v,valid)=>setAmount(valid?v:null)}/></Field>
      {basis==='profit_percent'&&<p className="fp-note">{loc('أساس النسبة: قيمة البضاعة بعد الخصومات والمرتجعات، مطروحًا منها تكلفة القطع المثبتة. تُحسب الأجور قبل توزيع ربح المستثمر.','Profit basis: goods revenue after discounts and returns, less verified product cost. Wages are calculated before investor distribution.')}</p>}
      <details className="fp-detail"><summary>{loc('الأقسام والمنتجات المشمولة','Included categories and products')}</summary><p className="fp-muted">{loc('ترك الخيارات فارغة يشمل جميع المنتجات. الاستثناءات لها الأولوية.','Leave selections empty to include all products. Exclusions take priority.')}</p><div className="fp-chips">{catalogs.map(c=><button type="button" key={c.id} className="fp-chip" aria-pressed={scope.catalog_ids.includes(c.id)} onClick={()=>toggle('catalog_ids',c.id)}>{scope.catalog_ids.includes(c.id)&&<Check size={13}/>} {name(c.id)}</button>)}</div>
      {(['product_ids','excluded_product_ids'] as const).map(key=><div className="fp-stack" key={key}><strong>{key==='product_ids'?loc('منتجات مشمولة','Included products'):loc('منتجات مستثناة','Excluded products')}</strong><div className="fp-chips">{scope[key].map(id=><button type="button" className="fp-chip" onClick={()=>toggle(key,id)} key={id}>{name(id)} ×</button>)}</div><ProductPicker value="" keepOpen excludeComposition={false} onChange={(id,p)=>{if(!id||!p)return;setProducts(old=>[...old.filter(v=>v.id!==id),p]);if(!scope[key].includes(id))toggle(key,id);}}/></div>)}</details>
      <label className="fp-check"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>{loc('القاعدة فعالة من تاريخ السريان','Rule enabled from its effective date')}</label>
    </div>}
    {step===1&&<div className="fp-stack"><Field label={loc('أول يوم تسليم بالقيمة الجديدة','First delivery day at the new rate')} required><Input type="date" value={from} onChange={e=>setFrom(e.target.value)} dir="ltr"/></Field><p className="fp-note"><CalendarDays size={16}/>{loc('هذا اليوم مشمول بالقيمة الجديدة بتوقيت بغداد. تاريخ تسجيل التعديل لا يغيّر تاريخ الاستحقاق.','This day uses the new rate in Baghdad time. Recording time does not determine eligibility.')}</p><Field label={loc('سبب التغيير','Reason for change')} required><Input value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} placeholder={loc('مثال: اتفاق جديد على أجور التجهيز','e.g. New preparation pay agreement')}/></Field><details className="fp-detail"><summary>{loc('تاريخ انتهاء اختياري','Optional end date')}</summary><Input type="date" min={from} value={until} onChange={e=>setUntil(e.target.value)} dir="ltr"/><p className="fp-muted">{loc('عند تركه فارغًا تستمر القيمة حتى نسخة لاحقة. أي تغيير لاحق مسجّل يبقى في موعده.','Leave empty to continue until the next version. An existing later change keeps its date.')}</p></details></div>}
    {step===2&&preview&&<div className="fp-stack">
      <div className="fp-review-heading"><ArrowRightLeft size={20}/><div><strong>{preview.orders_count} {loc('طلب','orders')} · {preview.units_count} {loc('قطعة','units')}</strong><p className="fp-muted">{dateLabel(preview.from,lang)} {preview.until&&<>← {loc('قبل ','before ')}{dateLabel(preview.until,lang)}</>}</p></div></div>
      <div className="fp-stats"><div className="fp-stat"><span>{loc('المستحق السابق','Previous earnings')}</span><Money value={preview.previous_iqd}/></div><div className="fp-stat"><span>{loc('المستحق المصحح','Corrected earnings')}</span><Money value={preview.corrected_iqd}/></div><div className="fp-stat"><span>{loc('فرق التسوية','Adjustment')}</span><Money value={preview.delta_iqd} className={preview.delta_iqd<0?'fp-negative':'fp-positive'}/></div><div className="fp-stat"><span>{loc('المسدّد سابقًا','Already paid')}</span><Money value={preview.paid_iqd}/></div></div>
      <div className="fp-detail fp-rows"><div className="fp-row"><span>{loc('رصيد الأجور المتوقع','Expected wage balance')}</span><Money value={preview.after_balance.ledgers.staff.net_iqd}/></div><div className="fp-row"><span>{loc('الدين المتبقي','Remaining debt')}</span><Money value={preview.after_balance.ledgers.staff.debt_iqd}/></div><div className="fp-row"><span>{loc('المحجوز حاليًا','Currently reserved')}</span><Money value={preview.held_iqd}/></div><div className="fp-row"><span>{loc('التغيير في حصة المستثمرين','Investor share change')}</span><Money value={preview.investor_delta_iqd}/></div><div className="fp-row"><span>{loc('التغيير في صافي المالك','Owner net change')}</span><Money value={preview.owner_delta_iqd}/></div></div>
      {preview.manual_overrides>0&&<p className="fp-note">{loc(`${preview.manual_overrides} تعديل يدوي خاص بالطلبات محفوظ كما هو.`,`${preview.manual_overrides} per-order manual overrides remain in effect.`)}</p>}
      {preview.pending_costs>0&&<p className="fp-note">{loc(`${preview.pending_costs} استحقاق يحتاج تثبيت تكلفة البضاعة. لا تتحول التكلفة المجهولة إلى صفر.`,`${preview.pending_costs} earnings require verified goods costs. Unknown costs remain unknown.`)}</p>}
      {preview.withdrawals.length>0&&<div className="fp-warning-box"><strong>{loc('سحوبات تحتاج إعادة اعتماد','Withdrawals need renewed approval')}</strong>{preview.withdrawals.map(w=><div className="fp-row" key={w.id}><span>{loc('الجزء غير المسدّد','Unpaid portion')}</span><Money value={w.amount_iqd-w.paid_iqd}/></div>)}<label className="fp-check"><input type="checkbox" checked={release} onChange={e=>setRelease(e.target.checked)}/>{loc('تحرير الأجزاء غير المسددة لإعادة طلبها واعتمادها وفق الرصيد المصحح. تبقى المدفوعات السابقة محفوظة.','Release unpaid reservations for a new request and approval using the corrected balance. Previous payments remain recorded.')}</label></div>}
      <p className="fp-muted">{loc('ستُسجّل الفروق فقط في الفترة المفتوحة، مع الاحتفاظ بتاريخ استحقاق كل طلب.','Only differences are posted to the open period, retaining each order’s earning date.')}</p>
    </div>}
    <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={()=>step?setStep(step-1):onClose()}>{step?loc('السابق','Back'):loc('إلغاء','Cancel')}</Button>{step===0?<Button variant="primary" disabled={amount===null||amount<0||percent&&amount>100} onClick={()=>setStep(1)}>{loc('تاريخ السريان','Effective date')}</Button>:step===1?<Button variant="primary" loading={op.busy} disabled={!from||reason.trim().length<3||!!until&&until<from} onClick={inspect}>{loc('معاينة الأثر','Preview impact')}</Button>:<><Button disabled={op.busy} onClick={inspect}>{loc('تحديث المعاينة','Refresh preview')}</Button><Button variant="primary" loading={op.busy} disabled={!preview||preview.withdrawals.length>0&&!release} onClick={save}>{loc('تطبيق التسوية','Apply adjustment')}</Button></>}</footer>
  </Dialog>;
}
