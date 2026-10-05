import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import SelectionPriceUpdate from './SelectionPriceUpdate';
import StockSelection from './StockSelection';
import PurchaseFundingFields, { newFunding, fundingValid, type FundingDraft, type PurchaseInvestor } from './PurchaseFundingFields';
import { purchaseEstimate } from './purchaseEstimate';
import '../adminInventory/inventory-workspace.css';
const InvestorContractForm = lazy(() => import('../financePeople/InvestorPanel').then((m) => ({ default: m.InvestorContractForm })));
import {
  api,
  Card,
  Input,
  money,
  nameOf,
  PROCUREMENT,
  Select,
  T,
  today,
  useLabels,
  useOperation,
  type Named,
  type Selection,
} from './shared';

type DraftLine = Selection & {
  qty_ordered: number;
  source_unit_amount: number | string;
  invoiced_qty: number;
  purchase_cost_mode?: 'unit' | 'total';
  source_total_amount?: number | string;
};
type Charge = { title: string; amount_iqd: number; basis: string };
type Purchase = {
  id: string;
  invoice_no: string;
  supplier_name: string;
  status: string;
  cost_state: string;
  total_cost_iqd: number;
  paid_iqd: number;
  version: number;
};
type FundingSummary = { investor_name: string; user_id: string; agreed_iqd: number; allocated_iqd: number; received_iqd: number; unallocated_iqd: number; store_contribution_iqd: number; funding_shortfall_iqd: number; profit_share_bps: number };
type Detail = {
  funding?: FundingSummary | null;
  purchase: Purchase & {
    request_json: string;
    supplier_id: string;
    warehouse_id: string;
    currency: string;
    exchange_rate: number;
    purchase_day: string;
    expected_day: string;
    tracking: string;
    note: string;
    attachment_url: string;
    invoice_total_iqd: number | null;
  };
  lines: Array<
    DraftLine & {
      line_id: string;
      id: string;
      qty_received: number;
      rejected_qty: number;
      purchase_unit_iqd: number;
      purchase_total_iqd?: number;
      charges_iqd: number;
    }
  >;
  charges: Charge[];
  ordered_total_iqd: number;
  paid_iqd: number;
  balance_iqd: number;
  matching: {
    ordered_qty: number;
    received_qty: number;
    invoiced_qty: number;
    rejected_qty: number;
    invoice_difference_iqd: number | null;
  };
  payments: Array<{ id: string; amount_iqd: number; payment_day: string; reference: string }>;
};
type Header = {
  supplier_id: string;
  warehouse_id: string;
  invoice_no: string;
  currency: string;
  exchange_rate: number;
  purchase_day: string;
  expected_day: string;
  tracking: string;
  note: string;
  attachment_url: string;
  invoice_total_iqd: string;
  cost_state: string;
};
const newHeader = (): Header => ({
  supplier_id: '',
  warehouse_id: '',
  invoice_no: '',
  currency: 'IQD',
  exchange_rate: 1,
  purchase_day: today(),
  expected_day: '',
  tracking: '',
  note: '',
  attachment_url: '',
  invoice_total_iqd: '',
  cost_state: 'final',
});
export default function ProcurementPanel({ onChanged, initialAction }: { onChanged: () => void; initialAction?: 'purchase' | 'receive' }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [investmentFor, setInvestmentFor] = useState('');
  const [priceLine,setPriceLine]=useState<Detail['lines'][number]|null>(null);
  const [config, setConfig] = useState<{ suppliers: Named[]; locations: Named[]; investors: PurchaseInvestor[] }>({
      suppliers: [],
      locations: [],
      investors: [],
    }),
    [purchases, setPurchases] = useState<Purchase[]>([]),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Detail | null>(null),
    [editing, setEditing] = useState(initialAction === 'purchase'),
    [step, setStep] = useState(0),
    [funding, setFunding] = useState<FundingDraft>(newFunding),
    [quickReceive, setQuickReceive] = useState(false),
    [recent, setRecent] = useState<Selection[]>([]),
    [draftAvailable, setDraftAvailable] = useState(() => !!localStorage.getItem('levonis-purchase-draft-v2')),
    [fundReceipt, setFundReceipt] = useState(''),
    [fundReference, setFundReference] = useState(''),
    [fundReceiptId, setFundReceiptId] = useState(() => crypto.randomUUID()),
    [receiveOnly, setReceiveOnly] = useState(initialAction === 'receive'),
    [editId, setEditId] = useState(''),
    [editVersion, setEditVersion] = useState<number | undefined>(),
    [header, setHeader] = useState(newHeader),
    [lines, setLines] = useState<DraftLine[]>([]),
    [charges, setCharges] = useState<Charge[]>([]),
    [choice, setChoice] = useState<Selection | null>(null),
    [csv, setCsv] = useState(''),
    [operationId, setOperationId] = useState(() => crypto.randomUUID()),
    [receiveId, setReceiveId] = useState(() => crypto.randomUUID()),
    [payId, setPayId] = useState(() => crypto.randomUUID()),
    [receiving, setReceiving] = useState<Record<string, { qty: number; rejected_qty: number }>>({}),
    [payment, setPayment] = useState(''),
    [reference, setReference] = useState(''),
    [closeReason, setCloseReason] = useState('');
  const load = useCallback(async () => {
    const [cfg, r] = await Promise.all([
      api.get<typeof config>(`${PROCUREMENT}/config`),
      api.get<{ purchases: Purchase[] }>(`${PROCUREMENT}/documents?offset=${offset}&awaiting=${receiveOnly ? '1' : '0'}`),
    ]);
    setConfig(cfg);
    setPurchases(r.purchases);
  }, [offset, receiveOnly]);
  const { run } = op;
  useEffect(() => { if (!editing || (!lines.length && funding.mode === 'store')) return; const timer = setTimeout(() => { localStorage.setItem('levonis-purchase-draft-v2', JSON.stringify({ header, lines, charges, funding, editId, editVersion, operationId, quickReceive })); setDraftAvailable(true); }, 600); return () => clearTimeout(timer); }, [editing, header, lines, charges, funding, editId, editVersion, operationId, quickReceive]);
  useEffect(() => {
    run(load);
  }, [load, run]);
  const open = async (id: string) => {
    const d = await api.get<Detail>(`${PROCUREMENT}/documents/${id}`);
    setSelected(d);
    setEditing(false);
    setReceiving(
      Object.fromEntries(
        d.lines.map((l) => [
          l.line_id,
          { qty: Math.max(0, l.qty_ordered - l.qty_received), rejected_qty: 0 },
        ]),
      ),
    );
    setReceiveId(crypto.randomUUID());
    setPayId(crypto.randomUUID());
  };
  const start = (d?: Detail, clone = false, quick = false) => {
    setQuickReceive(quick);
    let savedFunding = newFunding();
    if (d?.purchase.request_json) { try { savedFunding = { ...savedFunding, ...JSON.parse(d.purchase.request_json).funding }; } catch { /* historical purchase */ } }
    setFunding(clone ? { ...savedFunding, received_iqd: '', reference: '', received_day: today(), save_default: false } : savedFunding);
    setStep(0);
    setReceiveOnly(false);
    setHeader(
      d
        ? {
            ...d.purchase,
            invoice_total_iqd:
              d.purchase.invoice_total_iqd == null ? '' : String(d.purchase.invoice_total_iqd),
            invoice_no: clone ? '' : d.purchase.invoice_no,
            purchase_day: clone ? today() : d.purchase.purchase_day,
          }
        : newHeader(),
    );
    setLines(
      d
        ? d.lines.map((l) => ({
            ...l,
            sku: l.sku ?? '',
            stock: null,
            reserved: 0,
            cost_source: 'confirmed_purchase',
            source_total_amount: l.purchase_total_iqd == null ? Number(l.source_unit_amount) * l.qty_ordered : l.purchase_total_iqd / (d.purchase.currency === 'IQD' ? 1 : d.purchase.exchange_rate),
            unit_cost_iqd: l.purchase_unit_iqd,
          }))
        : [],
    );
    setCharges(d?.charges ?? []);
    setEditId(d && !clone ? d.purchase.id : '');
    setEditVersion(d && !clone ? d.purchase.version : undefined);
    setOperationId(crypto.randomUUID());
    setChoice(null);
    setEditing(true);
  };
  const save = async (status: string) => {
    const body = {
      ...header,
      invoice_total_iqd: header.invoice_total_iqd === '' ? null : Number(header.invoice_total_iqd),
      status,
      lines,
      charges,
      funding,
      operation_id: operationId,
      version: editVersion,
    };
    const r = editId
      ? await api.put<{ id: string }>(`${PROCUREMENT}/documents/${editId}`, body)
      : await api.post<{ id: string }>(`${PROCUREMENT}/documents`, body);
    localStorage.removeItem('levonis-purchase-draft-v2'); setDraftAvailable(false);
    const d = await api.get<Detail>(`${PROCUREMENT}/documents/${r.id}`);
    // The two steps are independently idempotent. A failed receipt leaves the
    // confirmed incoming document available to resume from the shipment list.
    if (quickReceive && status === 'ordered') {
      try { await api.post(`${PROCUREMENT}/documents/${r.id}/receive`, { operation_id: operationId, lines: d.lines.map((l) => ({ line_id: l.line_id, qty: l.qty_ordered, rejected_qty: 0 })) }); }
      catch (e) { await open(r.id); await load(); throw e; }
    }
    await load(); await open(r.id); onChanged();
  };
  const update = (key: keyof Header, value: string | number) => setHeader((h) => ({ ...h, [key]: value }));
  const quantitiesValid = lines.length > 0 && lines.every((l) => Number.isSafeInteger(l.qty_ordered) && l.qty_ordered > 0 && Number.isSafeInteger(l.invoiced_qty) && l.invoiced_qty >= 0);
  const costsValid = quantitiesValid && Number.isFinite(header.exchange_rate) && header.exchange_rate > 0 && lines.every((l) => (l.purchase_cost_mode === 'total' ? l.source_total_amount !== '' && l.source_total_amount != null && Number.isFinite(Number(l.source_total_amount)) && Number(l.source_total_amount) >= 0 : l.source_unit_amount !== '' && l.source_unit_amount != null && Number.isFinite(Number(l.source_unit_amount)) && Number(l.source_unit_amount) >= 0)) && lines.every((l) => Number.isSafeInteger(l.selling_price_iqd) && l.selling_price_iqd >= 0) && charges.every((c) => c.title.trim() && Number.isSafeInteger(c.amount_iqd) && c.amount_iqd >= 0);
  const estimates = purchaseEstimate(lines, charges, header.currency === 'IQD' ? 1 : header.exchange_rate, funding.mode === 'investor' ? funding.profit_share_bps : 0, funding.incoming_indexes);
  const total = estimates.reduce((n, e) => n + e.total_iqd, 0);
  const fundedCost = estimates.reduce((n, e, i) => n + (!funding.incoming_indexes || funding.incoming_indexes.includes(i) ? e.total_iqd : 0), 0);
  const allocated = funding.mode === 'investor' ? Math.min(Number(funding.agreed_iqd), fundedCost) : 0;
  const saveLocal = () => { localStorage.setItem('levonis-purchase-draft-v2', JSON.stringify({ header, lines, charges, funding, editId, editVersion, operationId, quickReceive })); setDraftAvailable(true); };
  const restoreLocal = () => { try { const d = JSON.parse(localStorage.getItem('levonis-purchase-draft-v2') || '{}'); if (!Array.isArray(d.lines)) return; setHeader(d.header); setLines(d.lines); setCharges(d.charges); setFunding(d.funding); setEditId(d.editId); setEditVersion(d.editVersion); setOperationId(d.operationId); setQuickReceive(d.quickReceive); setEditing(true); setStep(0); } catch { localStorage.removeItem('levonis-purchase-draft-v2'); } };
  const addChoice = () => { if (!choice) return; setLines((old) => [...old, { ...choice, qty_ordered: 1, invoiced_qty: 1, purchase_cost_mode: 'unit', source_unit_amount: choice.purchase_unit_iqd == null ? '' : choice.purchase_unit_iqd / (header.currency === 'IQD' ? 1 : header.exchange_rate) }]); setRecent((old) => [choice, ...old.filter((r) => `${r.product_id}:${r.scope}:${r.scope_id}` !== `${choice.product_id}:${choice.scope}:${choice.scope_id}`)].slice(0, 6)); setChoice(null); };
  return (
    <div className="inventory-workspace">
      {op.feedback}
      {priceLine && <SelectionPriceUpdate line={priceLine} onClose={()=>setPriceLine(null)}/>}
      {investmentFor && <Suspense fallback={<p role="status">{loc('جارٍ تحميل اتفاق التمويل…', 'Loading funding agreement…')}</p>}><InvestorContractForm initialIncomingId={investmentFor} onClose={() => setInvestmentFor('')} onSaved={() => { setInvestmentFor(''); onChanged(); }} /></Suspense>}
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => start(undefined, false, true)}>{loc('إضافة مخزون موجود', 'Add stock on hand')}</button>
        {draftAvailable && <button type="button" className={T.btnSecondary} onClick={restoreLocal}>{loc('استكمال المسودة المحفوظة', 'Resume saved draft')}</button>}
        <button type="button" className={T.btnPrimary} onClick={() => start()}>
          {loc('شراء قادم', 'Incoming purchase')}
        </button>
        <button type="button" className={T.btnSecondary} aria-pressed={receiveOnly} onClick={() => { setEditing(false); setSelected(null); setOffset(0); setReceiveOnly((v) => !v); }}>
          {loc('الشحنات بانتظار الاستلام', 'Awaiting receipt')}
        </button>
        <button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => op.run(load)}>
          {loc('تحديث', 'Refresh')}
        </button>
      </div>
      {editing && (
        <Card title={loc(editId ? 'تعديل أمر الشراء' : 'شراء جديد', editId ? 'Edit purchase' : 'New purchase')}>
          <ol className="inventory-stepper" aria-label={loc('خطوات الشراء', 'Purchase steps')}>
            {[loc('التمويل', 'Funding'), loc('المنتجات', 'Products'), loc('التكاليف والشحن', 'Costs & freight'), loc('المراجعة', 'Review')].map((label, i) => (
              <li key={label}><button type="button" aria-current={step === i ? 'step' : undefined} disabled={(i > 0 && !fundingValid(funding)) || (i > 1 && !quantitiesValid) || (i === 3 && !costsValid)} onClick={() => setStep(i)}><span>{i + 1}</span>{label}</button></li>
            ))}
          </ol>
          {step === 0 && <PurchaseFundingFields value={funding} onChange={setFunding} investors={config.investors} />}
          {step === 1 && <>
            <div className="inventory-fields">
              <Select label={loc('المورد', 'Supplier')} value={header.supplier_id} onChange={(v) => update('supplier_id', v)} empty={loc('بدون مورد', 'No supplier')} options={config.suppliers.map((x) => ({ id: x.id, name: nameOf(x) }))} />
              <Input label={loc('تاريخ الشراء', 'Purchase date')} type="date" value={header.purchase_day} onChange={(v) => update('purchase_day', v)} />
            </div>
            <div className="my-5 max-w-2xl">
              <StockSelection value={choice} onChange={setChoice} />
              <button type="button" className={`${T.btnSecondary} mt-3`} disabled={!choice} onClick={addChoice}>{loc('إضافة المنتج', 'Add item')}</button>
              {recent.length > 0 && <details><summary>{loc('منتجات استخدمتها الآن', 'Recent selections')}</summary><div className="flex flex-wrap gap-2">{recent.map((r) => <button key={`${r.product_id}:${r.scope}:${r.scope_id}`} type="button" className={T.btnGhost} onClick={() => setChoice(r)}>{r.label}</button>)}</div></details>}
            </div>
            {!lines.length && <p className={`py-3 text-sm ${T.text3}`}>{loc('ابحث عن المنتج ثم حدد الخيار واللون. سنملأ آخر تكلفة وسعر البيع تلقائيًا.', 'Find the item and choose its option and colour. The latest cost and selling price fill automatically.')}</p>}
            <div className="inventory-lines">{lines.map((l, i) => <article key={i} className="inventory-line">
              <div className="inventory-line-head">{l.image_url && <img src={l.image_url} alt="" className="inventory-thumb" loading="lazy" />}<div><strong>{l.label}</strong><small>{l.sku}</small></div><button type="button" className={T.btnGhost} onClick={() => setLines((a) => [...a, { ...l }])}>{loc('تكرار', 'Duplicate')}</button><button type="button" className={T.btnGhost} onClick={() => { setLines((a) => a.filter((_, j) => i !== j)); setFunding((f) => ({...f,incoming_indexes:f.incoming_indexes?.filter(j=>j!==i).map(j=>j>i?j-1:j)})); }}>{loc('حذف', 'Remove')}</button></div>
              <Input label={loc('الكمية المطلوبة', 'Quantity ordered')} type="number" min={1} value={l.qty_ordered} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, qty_ordered: v === '' ? NaN : Number(v), invoiced_qty: x.invoiced_qty === x.qty_ordered ? Number(v) : x.invoiced_qty } : x))} />
              <details className="mt-2"><summary>{loc('كمية الفاتورة مختلفة؟', 'Different invoiced quantity?')}</summary><Input label={loc('كمية الفاتورة', 'Invoice quantity')} type="number" min={0} value={l.invoiced_qty} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, invoiced_qty: Number(v) } : x))} /></details>
            </article>)}</div>
            <details><summary>{loc('فاتورة وموقع ووصول متوقع', 'Invoice, location and arrival')}</summary><div className="inventory-fields mt-3">
              <Input label={loc('رقم الفاتورة', 'Invoice number')} value={header.invoice_no} onChange={(v) => update('invoice_no', v)} />
              <Select label={loc('المستودع / الموقع', 'Warehouse / location')} value={header.warehouse_id} onChange={(v) => update('warehouse_id', v)} empty={loc('غير محدد', 'Unassigned')} options={config.locations.map((x) => ({ id: x.id, name: nameOf(x) }))} />
              <Input label={loc('الوصول المتوقع', 'Expected arrival')} type="date" value={header.expected_day} onChange={(v) => update('expected_day', v)} />
              <Input label={loc('رقم التتبع', 'Tracking number')} value={header.tracking} onChange={(v) => update('tracking', v)} />
            </div></details>
          </>}
          {step === 2 && <>
            <div className="inventory-fields">
              <Select label={loc('عملة الشراء', 'Purchase currency')} value={header.currency} onChange={(v) => { if (v === header.currency) return; update('currency', v); update('exchange_rate', 1); setLines((a) => a.map((l) => ({ ...l, purchase_cost_mode: 'unit', source_total_amount: '', source_unit_amount: v === 'IQD' ? l.purchase_unit_iqd ?? '' : '' }))); }} options={['IQD', 'USD', 'CNY', 'EUR'].map((id) => ({ id, name: id }))} />
              {header.currency !== 'IQD' && <Input label={loc('دينار لكل وحدة عملة', 'IQD per currency unit')} type="number" min={0} value={header.exchange_rate} onChange={(v) => update('exchange_rate', Number(v))} />}
            </div>
            <div className="inventory-lines">{lines.map((l, i) => <article className="inventory-line" key={i}>
              <div className="inventory-line-head"><div><strong>{l.label}</strong><small>{loc('الكمية', 'Quantity')}: {l.qty_ordered} · {loc('سعر البيع المرجعي', 'Selling reference')}: {money(l.selling_price_iqd)}</small></div></div>
              <Select label={loc('طريقة إدخال الشراء', 'Purchase input')} value={l.purchase_cost_mode || 'unit'} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, purchase_cost_mode: v as 'unit' | 'total', source_total_amount: v === 'total' ? (x.source_unit_amount === '' ? '' : Number(x.source_unit_amount) * x.qty_ordered) : x.source_total_amount, source_unit_amount: v === 'unit' && x.source_total_amount != null ? Number(x.source_total_amount) / x.qty_ordered : x.source_unit_amount } : x))} options={[{ id: 'total', name: loc('إجمالي تكلفة شراء البند', 'Total line purchase cost') }, { id: 'unit', name: loc('تكلفة شراء القطعة', 'Unit purchase cost') }]} />
              <div className="inventory-fields mt-3"><Input label={`${l.purchase_cost_mode === 'total' ? loc('إجمالي الشراء', 'Purchase total') : loc('تكلفة القطعة', 'Unit purchase cost')} (${header.currency})`} type="number" min={0} decimals={header.currency === 'IQD' ? 0 : 6} value={l.purchase_cost_mode === 'total' ? l.source_total_amount ?? '' : l.source_unit_amount} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, ...(x.purchase_cost_mode === 'total' ? { source_total_amount: v === '' ? '' : Number(v), source_unit_amount: v === '' ? '' : Number(v) / x.qty_ordered } : { source_unit_amount: v === '' ? '' : Number(v), source_total_amount: v === '' ? '' : Number(v) * x.qty_ordered }) } : x))} hint={l.cost_source === 'confirmed_purchase' ? `${loc('آخر شراء مؤكد لنفس الخيار واللون', 'Last confirmed purchase of this selection')} ${l.cost_date?.slice(0, 10) || ''}` : l.cost_source === 'catalogue' ? loc('التكلفة المقترحة من بطاقة المنتج', 'Suggested catalogue cost') : loc('التكلفة تحتاج إدخالًا', 'Cost needs input')} />
              <Input label={loc('سعر البيع المرجعي للقطعة بالدينار', 'Reference unit selling price IQD')} type="number" decimals={0} min={0} value={l.selling_price_iqd} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, selling_price_iqd: v === '' ? NaN : Number(v) } : x))} /></div>
              <p className={`mt-2 text-sm ${T.text3}`}>{loc('إجمالي الشراء / متوسط القطعة', 'Purchase total / average unit')}: {money(estimates[i]?.purchase_iqd)} / {money(estimates[i]?.purchase_iqd / l.qty_ordered)}</p>
              {funding.mode === 'investor' && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={!funding.incoming_indexes || funding.incoming_indexes.includes(i)} onChange={(e) => setFunding((f) => { const indexes = f.incoming_indexes ?? lines.map((_, j) => j); return { ...f, incoming_indexes: e.target.checked ? [...indexes, i] : indexes.filter((j) => j !== i) }; })} />{loc('مشمول بتمويل المستثمر ونسبته', 'Include in investor funding and profit share')}</label>}
            </article>)}</div>
            <h4 className={`mb-3 font-semibold ${T.text1}`}>{loc('تكاليف الشحنة', 'Shipment charges')}</h4>
            {charges.map((c, i) => <div key={i} className="inventory-line mb-3"><div className="inventory-fields">
              <Input label={loc('اسم التكلفة', 'Charge name')} value={c.title} onChange={(v) => setCharges((a) => a.map((x, j) => j === i ? { ...x, title: v } : x))} />
              <Input label={loc('إجمالي بالدينار', 'Total IQD')} type="number" min={0} value={c.amount_iqd} onChange={(v) => setCharges((a) => a.map((x, j) => j === i ? { ...x, amount_iqd: v === '' ? NaN : Number(v) } : x))} />
            </div><details className="mt-2"><summary>{loc('توزيع التكلفة', 'Charge allocation')}</summary><Select label={loc('طريقة التوزيع', 'Allocation method')} value={c.basis} onChange={(v) => setCharges((a) => a.map((x, j) => j === i ? { ...x, basis: v } : x))} options={['quantity', 'value', 'weight', 'volume'].map((id, j) => ({ id, name: [loc('الكمية', 'Quantity'), loc('القيمة', 'Value'), loc('الوزن', 'Weight'), loc('الحجم', 'Volume')][j] }))} /></details><button type="button" className={T.btnGhost} onClick={() => setCharges((a) => a.filter((_, j) => i !== j))}>{loc('حذف التكلفة', 'Remove charge')}</button></div>)}
            <button type="button" className={T.btnSecondary} onClick={() => setCharges((a) => [...a, { title: loc('شحن', 'Shipping'), amount_iqd: 0, basis: 'quantity' }])}>{loc('إضافة شحن أو تكلفة', 'Add freight or charge')}</button>
            <details className="mt-4"><summary>{loc('تكلفة تقديرية ووزن وحجم ومرفقات واستيراد', 'Estimated cost, weights, attachments and import')}</summary><div className="inventory-fields mt-3">
              <Select label={loc('حالة التكلفة', 'Cost status')} value={header.cost_state} onChange={(v) => update('cost_state', v)} options={[{ id: 'estimated', name: loc('تقديرية؛ الاستلام ينتظر تثبيتها', 'Estimated; receiving waits for confirmation') }, { id: 'final', name: loc('نهائية ومثبتة', 'Final and confirmed') }]} />
              <Input label={loc('رابط مرفق الفاتورة HTTPS', 'Invoice attachment HTTPS URL')} value={header.attachment_url} onChange={(v) => update('attachment_url', v)} />
              <Input label={loc('مجموع الفاتورة للمطابقة (اختياري)', 'Invoice total for matching (optional)')} type="number" value={header.invoice_total_iqd} onChange={(v) => update('invoice_total_iqd', v)} />
              <Input label={loc('ملاحظات (اختياري)', 'Notes (optional)')} value={header.note} onChange={(v) => update('note', v)} />
              {lines.map((l, i) => <div className="grid gap-2" key={i}><span className={`text-sm ${T.text2}`}>{l.label}</span><Input label={loc('وزن الوحدة بالغرام', 'Unit weight (g)')} type="number" value={l.weight_g} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, weight_g: Number(v) } : x))} /><Input label={loc('حجم الوحدة بالملم المكعب', 'Unit volume (mm³)')} type="number" value={l.volume_mm3} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, volume_mm3: Number(v) } : x))} /></div>)}
            </div><p className={`my-3 text-xs ${T.text3}`}>CSV: sku,qty,unit_amount,weight_g,volume_mm3</p><input aria-label="CSV" type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setCsv); }} /><textarea aria-label={loc('محتوى CSV', 'CSV content')} className={`${T.input} my-2 h-24 w-full`} value={csv} onChange={(e) => setCsv(e.target.value)} /><button type="button" className={T.btnSecondary} disabled={op.busy || !csv} onClick={() => op.run(async () => { const r = await api.post<{ lines: DraftLine[] }>(`${PROCUREMENT}/import-preview`, { csv }); setLines(r.lines.map((l) => ({ ...l, invoiced_qty: l.qty_ordered }))); })}>{loc('فحص واستيراد البنود', 'Validate and import lines')}</button></details>
          </>}
          {step === 3 && <>
            <dl className="inventory-review">
              <div><dt>{loc('المورد', 'Supplier')}</dt><dd>{nameOf(config.suppliers.find((x) => x.id === header.supplier_id) ?? { id: loc('بدون مورد', 'No supplier') })}</dd></div>
              <div><dt>{loc('تاريخ الشراء', 'Purchase date')}</dt><dd>{header.purchase_day}</dd></div>
              <div><dt>{loc('الفاتورة', 'Invoice')}</dt><dd>{header.invoice_no || '—'}</dd></div>
              <div><dt>{loc('التكلفة', 'Cost status')}</dt><dd>{header.cost_state === 'final' ? loc('نهائية', 'Final') : loc('تقديرية؛ لا تستلم بعد', 'Estimated; receipt is blocked')}</dd></div>
            </dl>
            <div className="inventory-lines">{lines.map((l, i) => <article className="inventory-line" key={i}><strong>{l.label}</strong><div className={`mt-2 flex flex-wrap gap-3 text-sm ${T.text2}`}><span>{loc('الكمية', 'Quantity')}: {l.qty_ordered}</span><span>{loc('تكلفة البند', 'Line cost')}: {money(estimates[i]?.total_iqd)}</span><span>{loc('تكلفة القطعة النهائية', 'Landed unit cost')}: {money(estimates[i]?.unit_iqd)}</span><span>{loc('ربح المستثمر التقديري', 'Estimated investor profit')}: {money(estimates[i]?.investor_iqd)}</span><span>{loc('ربح المتجر التقديري', 'Estimated store profit')}: {money(estimates[i]?.owner_iqd)}</span></div></article>)}</div>
            <p className={`text-sm ${T.text3}`}>{loc('احفظ مسودة إن كنت تنتظر تكلفة نهائية. تأكيد الشراء يضيف شحنة قادمة؛ اختر استلام شحنة عند وصولها.', 'Save a draft while waiting for final costs. Confirming creates an incoming shipment; receive it when it arrives.')}</p>
          </>}
          <aside className="inventory-sticky-summary"><div className="inventory-total"><span>{loc('المجموع مع تكاليف الشحنة', 'Total landed cost')}</span><strong>{money(costsValid ? total : null)}</strong></div>{funding.mode === 'investor' && <dl className="inventory-review"><div><dt>{loc('تمويل مخصص / مستلم', 'Allocated / received')}</dt><dd>{money(allocated)} / {money(Number(funding.received_iqd))}</dd></div><div><dt>{loc('مساهمة المتجر', 'Store contribution')}</dt><dd>{money(Math.max(0, total - allocated))}</dd></div><div><dt>{loc('نقد مستلم غير مخصص', 'Unallocated received cash')}</dt><dd>{money(Math.max(0, Number(funding.received_iqd) - allocated))}</dd></div><div><dt>{loc('تمويل ينتظر الاستلام', 'Funding not yet received')}</dt><dd>{money(Math.max(0, allocated - Number(funding.received_iqd)))}</dd></div></dl>}<p className={`mt-2 text-xs ${T.text3}`}>{loc(quickReceive ? 'ستُستلم القطع الموجودة الآن بعد تأكيد التكلفة. الربح تقديري حتى التسليم والتحصيل.' : 'الشراء القادم لا يزيد المخزون المتاح. الربح تقديري حتى تسليم الطلب والتحصيل.', quickReceive ? 'On-hand units are received after confirming cost. Profit remains an estimate until delivery and collection.' : 'Incoming purchases do not increase available stock. Profit remains an estimate until delivery and collection.')}</p></aside>
          <div className="inventory-footer">
            {step > 0 && <button type="button" className={T.btnSecondary} onClick={() => setStep((v) => v - 1)}>{loc('رجوع', 'Back')}</button>}
            {step < 3 ? <button type="button" className={T.btnPrimary} disabled={op.busy || !fundingValid(funding) || (step > 0 && !quantitiesValid) || (step === 2 && !costsValid)} onClick={() => setStep((v) => v + 1)}>{loc('التالي', 'Continue')}</button> : <button type="button" className={T.btnPrimary} disabled={op.busy || !costsValid || !fundingValid(funding) || (quickReceive && header.cost_state !== 'final')} onClick={() => op.run(() => save('ordered'), loc('تم تأكيد أمر الشراء', 'Purchase confirmed'))}>{loc(quickReceive ? 'تأكيد وإضافة المخزون' : 'تأكيد الشراء القادم', quickReceive ? 'Confirm and receive stock' : 'Confirm incoming purchase')}</button>}
            <button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => { saveLocal(); if (costsValid) op.run(() => save('draft'), loc('تم حفظ المسودة', 'Draft saved')); }}>{loc('حفظ مسودة', 'Save draft')}</button>
            <button type="button" className={T.btnGhost} disabled={op.busy} onClick={() => setEditing(false)}>{loc('إلغاء', 'Cancel')}</button>
          </div>
        </Card>
      )}
      {!editing && selected && (
        <Card
          title={`${loc('تفاصيل الشحنة', 'Shipment details')} · ${selected.purchase.invoice_no || selected.purchase.id}`}
        >
          {!selected.funding && <details className="mb-4"><summary>{loc('ربط هذا الشراء بمستثمر', 'Associate this purchase with an investor')}</summary><p className={`mb-3 text-sm ${T.text3}`}>{loc('اختر بند المنتج لربط اتفاق رأس المال والربح. تسجيل التمويل الفعلي يتم في حساب المستثمر.', 'Choose the item to associate a capital and profit agreement. Record actual funding in the investor account.')}</p><div className="inventory-lines">{selected.lines.map((l) => <button type="button" className={T.btnSecondary} key={l.line_id} onClick={() => setInvestmentFor(l.id)}>{l.label}</button>)}</div></details>}
          {selected.funding && <section className="inventory-line"><h4>{selected.funding.investor_name} · {selected.funding.profit_share_bps / 100}%</h4><dl className="inventory-review">{[[loc('المتفق عليه', 'Agreed'), selected.funding.agreed_iqd], [loc('المستلم', 'Received'), selected.funding.received_iqd], [loc('المخصص', 'Allocated'), selected.funding.allocated_iqd], [loc('غير مخصص', 'Unallocated'), selected.funding.unallocated_iqd], [loc('مساهمة المتجر', 'Store contribution'), selected.funding.store_contribution_iqd], [loc('تمويل ينتظر الاستلام', 'Funding shortfall'), selected.funding.funding_shortfall_iqd]].map(([k, n]) => <div key={String(k)}><dt>{k}</dt><dd>{money(Number(n))}</dd></div>)}</dl><details><summary>{loc('تسجيل تمويل مستلم', 'Record received funding')}</summary><div className="inventory-fields"><Input label={loc('المبلغ المستلم بالدينار', 'Amount received IQD')} value={fundReceipt} type="number" min={1} decimals={0} onChange={setFundReceipt} /><Input label={loc('مرجع الاستلام', 'Receipt reference')} value={fundReference} onChange={setFundReference} /></div><button type="button" className={`${T.btnSecondary} mt-3`} disabled={op.busy || !Number(fundReceipt) || !fundReference.trim()} onClick={() => op.run(async () => { await api.post(`${PROCUREMENT}/documents/${selected.purchase.id}/investor-receipts`, { operation_id: fundReceiptId, amount_iqd: Number(fundReceipt), reference: fundReference, payment_day: today() }); setFundReceipt(''); setFundReference(''); setFundReceiptId(crypto.randomUUID()); await open(selected.purchase.id); onChanged(); })}>{loc('تسجيل الاستلام', 'Record receipt')}</button></details></section>}
          <div className="mb-4 flex flex-wrap gap-4 text-sm">
            <span>
              {loc('المطلوب / المستلم / المفوتر / المرفوض', 'Ordered / received / invoiced / rejected')}:{' '}
              {selected.matching.ordered_qty} / {selected.matching.received_qty} /{' '}
              {selected.matching.invoiced_qty} / {selected.matching.rejected_qty}
            </span>
            <span>
              {loc('فرق الفاتورة', 'Invoice difference')}: {money(selected.matching.invoice_difference_iqd)}
            </span>
            <span>
              {loc('رصيد المورد', 'Supplier balance')}: {money(selected.balance_iqd)}
            </span>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <button type="button" className={T.btnSecondary} onClick={() => start(selected, true)}>
              {loc('نسخ لشراء جديد', 'Clone purchase')}
            </button>
            {['draft', 'ordered'].includes(selected.purchase.status) && !selected.matching.received_qty && !selected.funding && (
              <button type="button" className={T.btnSecondary} onClick={() => start(selected)}>
                {loc('تعديل / إكمال المسودة', 'Edit / resume draft')}
              </button>
            )}
            <button type="button" className={T.btnGhost} onClick={() => setSelected(null)}>
              {loc('إغلاق', 'Close')}
            </button>
          </div>
          <div className="inventory-lines">{selected.lines.map((l) => <article className="inventory-line" key={l.line_id}>
            <div className="inventory-line-head"><div><strong>{l.label}</strong><small>{loc('المطلوب / المستلم', 'Ordered / received')}: {l.qty_ordered} / {l.qty_received} · {loc('تكلفة الوحدة', 'Unit cost')}: {money(l.purchase_unit_iqd)}</small></div></div>
            <button type="button" className={T.btnGhost} onClick={()=>setPriceLine(l)}>{loc('تحديث سعر هذا الخيار في المتجر','Update this selection’s store price')}</button>
            <Input label={loc('الكمية التي وصلت الآن', 'Quantity arriving now')} type="number" min={0} value={receiving[l.line_id]?.qty ?? 0} onChange={(v) => setReceiving((r) => ({ ...r, [l.line_id]: { ...r[l.line_id], qty: Number(v) } }))} hint={`${loc('المتبقي للاستلام', 'Remaining to receive')}: ${l.qty_ordered - l.qty_received}`} />
            <details className="mt-2"><summary>{loc('كمية مرفوضة وتكلفة الشحنة', 'Rejected quantity and charges')}</summary><Input label={loc('المرفوض الآن', 'Rejected now')} type="number" min={0} value={receiving[l.line_id]?.rejected_qty ?? 0} onChange={(v) => setReceiving((r) => ({ ...r, [l.line_id]: { ...r[l.line_id], rejected_qty: Number(v) } }))} /><p className={`mt-2 text-xs ${T.text3}`}>{loc('نصيب البند من الشحنة', 'Line share of shipment charges')}: {money(l.charges_iqd)}</p></details>
          </article>)}</div>
          {['ordered', 'partial'].includes(selected.purchase.status) && (
            <button
              type="button"
              className={`${T.btnPrimary} my-3`}
              disabled={op.busy || selected.purchase.cost_state !== 'final' || !selected.lines.some((l) => receiving[l.line_id]?.qty > 0) || selected.lines.some((l) => !Number.isInteger(receiving[l.line_id]?.qty) || receiving[l.line_id]?.qty < 0 || receiving[l.line_id]?.qty > l.qty_ordered - l.qty_received)}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${PROCUREMENT}/documents/${selected.purchase.id}/receive`, {
                      operation_id: receiveId,
                      lines: selected.lines.map((l) => ({ line_id: l.line_id, ...receiving[l.line_id] })),
                    });
                    await open(selected.purchase.id);
                    await load();
                    onChanged();
                  },
                  loc('تم الاستلام وتحديث المخزون', 'Received and stock updated'),
                )
              }
            >
              {loc('استلام الكميات المحددة', 'Receive selected quantities')}
            </button>
          )}
          <details className="mt-4"><summary>{loc('دفعات المورد', 'Supplier payments')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Input
              label={loc('دفعة المورد بالدينار', 'Supplier payment IQD')}
              type="number"
              value={payment}
              onChange={setPayment}
            />
            <Input label={loc('مرجع الدفع', 'Payment reference')} value={reference} onChange={setReference} />
            <button
              type="button"
              className={`${T.btnSecondary} self-end`}
              disabled={op.busy || !payment}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${PROCUREMENT}/documents/${selected.purchase.id}/payments`, {
                      operation_id: payId,
                      amount_iqd: Number(payment),
                      reference,
                    });
                    setPayment('');
                    await open(selected.purchase.id);
                    await load();
                  },
                  loc('تم تسجيل الدفعة', 'Payment recorded'),
                )
              }
            >
              {loc('تسجيل الدفعة', 'Record payment')}
            </button>
          </div></details>
          {['draft', 'ordered', 'partial'].includes(selected.purchase.status) && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm">
                {loc('إلغاء / إغلاق الكميات المتبقية', 'Cancel / close remaining quantities')}
              </summary>
              <div className="mt-3 flex flex-wrap gap-3">
                <Input
                  label={loc('سبب الإغلاق أو النقص', 'Closure / shortage reason')}
                  value={closeReason}
                  onChange={setCloseReason}
                />
                <button
                  type="button"
                  className={`${T.btnSecondary} self-end`}
                  disabled={op.busy || closeReason.length < 3}
                  onClick={() =>
                    op.run(async () => {
                      await api.post(`${PROCUREMENT}/documents/${selected.purchase.id}/close`, {
                        reason: closeReason,
                      });
                      await open(selected.purchase.id);
                      await load();
                      onChanged();
                    })
                  }
                >
                  {loc('إغلاق المتبقي', 'Close remainder')}
                </button>
              </div>
            </details>
          )}
        </Card>
      )}
      <Card title={receiveOnly ? loc('شحنات بانتظار الاستلام', 'Shipments awaiting receipt') : loc('سجل أوامر الشراء', 'Purchase orders')}>
        {receiveOnly && <p className={`mb-3 text-sm ${T.text3}`}>{loc('اختر الشحنة ثم أدخل الكميات التي وصلت. تظهر الشحنات القادمة والمستلمة جزئيًا من جميع النتائج.', 'Choose a shipment and enter the quantities received. Shows ordered and partially received shipments across all matching results.')}</p>}
        <div className="inventory-lines">{purchases.filter((p) => !receiveOnly || ['ordered', 'partial'].includes(p.status)).map((p) => <article className="inventory-line" key={p.id}>
          <div className="inventory-line-head"><div><strong>{p.invoice_no || loc('شراء بلا رقم فاتورة', 'Purchase without invoice number')}</strong><small>{p.supplier_name || loc('بدون مورد', 'No supplier')} · {loc(({ draft: 'مسودة', ordered: 'قادم', partial: 'استلام جزئي', received: 'مكتمل', cancelled: 'ملغى' } as Record<string, string>)[p.status] || p.status, p.status)}</small></div><button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => op.run(() => open(p.id))}>{receiveOnly ? loc('استلام', 'Receive') : loc('فتح', 'Open')}</button></div>
          <div className={`flex flex-wrap gap-3 text-sm ${T.text2}`}><span>{loc('الإجمالي', 'Total')}: {money(p.total_cost_iqd)}</span><span>{loc('المدفوع', 'Paid')}: {money(p.paid_iqd)}</span></div>
        </article>)}</div>
        {!purchases.filter((p) => !receiveOnly || ['ordered', 'partial'].includes(p.status)).length && <p className={`py-3 text-sm ${T.text3}`}>{loc('لا توجد أوامر في هذه الصفحة', 'No orders on this page')}</p>}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className={T.btnGhost}
            disabled={offset === 0 || op.busy}
            onClick={() => setOffset((o) => Math.max(0, o - 50))}
          >
            {loc('السابق', 'Previous')}
          </button>
          <button
            type="button"
            className={T.btnGhost}
            disabled={purchases.length < 50 || op.busy}
            onClick={() => setOffset((o) => o + 50)}
          >
            {loc('التالي', 'Next')}
          </button>
        </div>
      </Card>
    </div>
  );
}
