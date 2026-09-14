import type { FulfillmentPricing, ModelPreorder, ModelTransport } from '@levonis/pricing/fulfillment';
import type { FormValue } from './model';
import { Field, Grid, Money, Qty, TextInput } from './formUi';

export function ModelAvailabilityEditor({ value, onChange, error }: { value: FormValue; onChange: (patch: Partial<FormValue>) => void; error?: string }) {
  const edit = (key: 'direct' | 'preorder', patch: Partial<ModelPreorder>) => onChange({
    availability_type: '',
    [key]: { enabled: true, ...value[key], ...patch },
  });
  const prices = (row: FulfillmentPricing, update: (patch: Partial<FulfillmentPricing>) => void) => (
    <Grid cols={3}>
      {(['regular', 'prime', 'pro'] as const).map((tier) => <Field key={tier} ar={tier === 'regular' ? 'اعتيادي' : tier.toUpperCase()} en={tier.toUpperCase()} hint="فارغ = وراثة السعر">
        <Money value={row[`${tier}_price_iqd`] ?? null} onChange={(n) => update({ [`${tier}_price_iqd`]: n, [`${tier}_adjust_iqd`]: null })} />
        <label className="mt-1 block text-[11px] text-zinc-400">فرق السعر
          <input type="number" step="1" value={row[`${tier}_adjust_iqd`] ?? ''} disabled={row[`${tier}_price_iqd`] != null} onChange={(e) => update({ [`${tier}_adjust_iqd`]: e.target.value === '' ? null : Number(e.target.value) })} className="mt-1 w-full min-w-0 rounded-md bg-zinc-900 px-2 py-2 text-sm" />
        </label>
      </Field>)}
    </Grid>
  );
  const lead = (row: FulfillmentPricing, update: (patch: Partial<FulfillmentPricing>) => void) => <Grid cols={3}>
    <Field ar="مدة الانتظار" en="Lead time"><TextInput value={row.lead_time_text ?? ''} onChange={(e) => update({ lead_time_text: e.target.value })} /></Field>
    <Field ar="أقل عدد أيام" en="Min days"><Qty value={row.lead_time_min_days ?? null} onChange={(n) => update({ lead_time_min_days: n })} /></Field>
    <Field ar="أكثر عدد أيام" en="Max days"><Qty value={row.lead_time_max_days ?? null} onChange={(n) => update({ lead_time_max_days: n })} /></Field>
  </Grid>;
  return <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3" data-model-availability={value.id}>
    <p className="text-xs text-zinc-400">التوفر العام يُستخدم حتى تخصص هذا الموديل. عند التخصيص، فعّل كل نوع طلب تريد إتاحته.</p>
    {(['direct', 'preorder'] as const).map((key) => {
      const row = value[key];
      return <section key={key} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm">{key === 'direct' ? 'بيع مباشر / Direct sale' : 'طلب مسبق / Pre-order'}</strong>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row?.enabled ?? false} onChange={(e) => edit(key, { enabled: e.target.checked })} />{value.direct === undefined && value.preorder === undefined ? 'حسب المنتج — تخصيص' : 'مفعّل'}</label>
        </div>
        {row?.enabled && <>
          {prices(row, (p) => edit(key, p))}
          {key === 'direct' && <Field ar="المخزون" en="Stock"><Qty value={row.stock ?? null} onChange={(n) => edit(key, { stock: n })} /></Field>}
          {key === 'preorder' && <>
            {lead(row, (p) => edit(key, p))}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={(row as ModelPreorder).transports !== undefined} onChange={(e) => edit(key, { transports: e.target.checked ? [] : undefined })} />تخصيص طرق النقل لهذا الموديل</label>
            {(row as ModelPreorder).transports !== undefined && (['sea', 'land', 'air'] as const).map((method) => {
              const methods = (row as ModelPreorder).transports ?? [];
              const transport = methods.find((t) => t.method === method) ?? { method, enabled: false };
              const update = (p: Partial<ModelTransport>) => edit(key, { transports: [...methods.filter((t) => t.method !== method), { ...transport, ...p }] });
              return <div key={method} className="space-y-2 border-s border-zinc-700 ps-3 py-2">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={transport.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{method.toUpperCase()}</label>
                {transport.enabled && <><Field ar="زيادة النقل" en="Surcharge"><Money value={transport.surcharge_iqd ?? null} onChange={(n) => update({ surcharge_iqd: n })} /></Field>{prices(transport, update)}{lead(transport, update)}</>}
              </div>;
            })}
          </>}
        </>}
      </section>;
    })}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </div>;
}
