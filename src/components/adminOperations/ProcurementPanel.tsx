import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import SelectionPriceUpdate from './SelectionPriceUpdate';
import StockSelection from './StockSelection';
import PurchaseFundingFields, { newFunding, fundingValid, type FundingDraft, type PurchaseInvestor } from './PurchaseFundingFields';
import { estimateLineKey, purchaseEstimate } from './purchaseEstimate';
import { changeLineCostProfile, changePurchaseCostMode, cloneCostProfileSnapshot, packedMeasureInput, packedMeasureValid, restoreCostProfileSnapshot, selectionCostDraft, type ProcurementDraftLine as DraftLine } from './procurementCostDraft';
import { chargeDraft, chargeProblems, chargesAfterRouteChange, chargeWire, looksLikeFreight, newChargeDraft, type ChargeDraft } from './procurementCharges';
import PurchaseLineCosts, { type ExtraChargeView } from './PurchaseLineCosts';
import type { CostProfile, ProcurementChargeBasis } from '../../../packages/contracts/src/procurementCost';
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

/** A saved extra charge and the dinars it put on each line it covers;
 * `allocations` is null for an older document whose split was never saved. */
type SavedCharge = { id: string; title: string; amount_iqd: number; basis: ProcurementChargeBasis; scope: 'shipment' | 'unit'; unit_amount_iqd: number | null; applies_to: string[] | null; allocations: Array<{ line_id: string; amount_iqd: number }> | null };
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
    cost_profile_id?: string | null;
    cost_profile_version?: number | null;
    shipping_basis?: 'weight' | 'volume' | null;
    shipping_rate_iqd?: number | null;
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
      auto_shipping_iqd?: number;
    }
  >;
  charges: SavedCharge[];
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
  cost_profile_id: string | null;
  cost_profile_version: number | null;
  shipping_basis: 'weight' | 'volume' | null;
  shipping_rate_iqd: number | null;
  purchase_day: string;
  expected_day: string;
  tracking: string;
  note: string;
  attachment_url: string;
  invoice_total_iqd: string;
  cost_state: string;
};
const costMoney = (value: number) => Number.isFinite(value) ? money(value) : '—';
const newHeader = (): Header => ({
  supplier_id: '',
  warehouse_id: '',
  invoice_no: '',
  currency: 'IQD',
  exchange_rate: 1,
  cost_profile_id: null,
  cost_profile_version: null,
  shipping_basis: null,
  shipping_rate_iqd: null,
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
  const [config, setConfig] = useState<{ suppliers: Named[]; locations: Named[]; investors: PurchaseInvestor[]; cost_profiles: CostProfile[] }>({
      suppliers: [],
      locations: [],
      investors: [],
      cost_profiles: [],
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
    [charges, setCharges] = useState<ChargeDraft[]>([]),
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
    setConfig({ ...cfg, investors: cfg.investors ?? [], cost_profiles: cfg.cost_profiles ?? [] });
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
            ...newHeader(),
            ...(clone ? cloneCostProfileSnapshot(d.purchase, config.cost_profiles) : restoreCostProfileSnapshot(d.purchase, config.cost_profiles)),
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
            source_total_amount: l.purchase_cost_mode === 'total' ? l.source_total_amount ?? (l.purchase_total_iqd == null ? Number(l.source_unit_amount) * l.qty_ordered : l.purchase_total_iqd / (d.purchase.currency === 'IQD' ? 1 : d.purchase.exchange_rate)) : '',
            unit_cost_iqd: l.purchase_unit_iqd,
          }))
        : [],
    );
    // A copy starts with no extra costs: they belong to the old shipment and
    // must never reach a new one unseen. Editing keeps the document's own.
    setCharges(clone || !d ? [] : d.charges.map(chargeDraft));
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
      charges: charges.map(chargeWire),
      funding,
      operation_id: operationId,
      version: editVersion,
    };
    const r = editId
      ? await api.put<{ id: string }>(`${PROCUREMENT}/documents/${editId}`, body)
      : await api.post<{ id: string }>(`${PROCUREMENT}/documents`, body);
    localStorage.removeItem('levonis-purchase-draft-v2'); setDraftAvailable(false);
    // Cached picker rows belong to the completed draft. A future purchase must
    // fetch the just-saved supplier defaults, not reuse its pre-save snapshot.
    setRecent([]);
    const d = await api.get<Detail>(`${PROCUREMENT}/documents/${r.id}`);
    // The two steps are independently idempotent. A failed receipt leaves the
    // confirmed incoming document available to resume from the shipment list.
    if (quickReceive && status === 'ordered') {
      try { await api.post(`${PROCUREMENT}/documents/${r.id}/receive`, { operation_id: operationId, lines: d.lines.map((l) => ({ line_id: l.line_id, qty: l.qty_ordered, rejected_qty: 0 })) }); }
      catch (e) { await open(r.id); await load(); throw e; }
    }
    await load(); await open(r.id); onChanged();
  };
  const update = (key: keyof Header, value: string | number | null) => setHeader((h) => ({ ...h, [key]: value }));
  const costProfile = config.cost_profiles.find((p) => p.id === header.cost_profile_id);
  const shippingBasis = header.shipping_basis ?? costProfile?.shipping_basis;
  const chooseCostProfile = (id: string) => {
    const profile = config.cost_profiles.find((p) => p.id === id) ?? null;
    setCharges((old) => chargesAfterRouteChange(old, header.cost_profile_id, profile?.id ?? null));
    setHeader((h) => ({ ...h, cost_profile_id: profile?.id ?? null, cost_profile_version: profile?.version ?? null, currency: profile?.currency ?? 'IQD', exchange_rate: profile ? profile.exchange_rate ?? NaN : 1, shipping_rate_iqd: profile?.shipping_rate_iqd ?? null, shipping_basis: profile?.shipping_basis ?? null }));
    setLines((old) => old.map((l) => changeLineCostProfile(l, profile)));
  };
  const saveProfileDefaults = async () => {
    if (!costProfile) return;
    const { profile } = await api.put<{ profile: CostProfile }>(`${PROCUREMENT}/cost-profiles/${costProfile.id}`, { exchange_rate: header.exchange_rate, shipping_rate_iqd: header.shipping_rate_iqd, version: header.cost_profile_version });
    setConfig((old) => ({ ...old, cost_profiles: old.cost_profiles.map((p) => p.id === profile.id ? profile : p) }));
    setHeader((old) => old.cost_profile_id === profile.id ? { ...old, cost_profile_version: profile.version } : old);
  };
  const reloadProfileRates = async () => {
    const cfg = await api.get<typeof config>(`${PROCUREMENT}/config`);
    setConfig({ ...cfg, investors: cfg.investors ?? [], cost_profiles: cfg.cost_profiles ?? [] });
    const profile = cfg.cost_profiles?.find((p) => p.id === header.cost_profile_id);
    if (profile) setHeader((old) => old.cost_profile_id === profile.id ? { ...old, exchange_rate: profile.exchange_rate ?? NaN, shipping_rate_iqd: profile.shipping_rate_iqd, cost_profile_version: profile.version } : old);
  };
  const profileValid = !header.cost_profile_id || (!!shippingBasis && Number.isFinite(header.shipping_rate_iqd) && header.shipping_rate_iqd !== null && header.shipping_rate_iqd >= 0 && lines.every((l) => packedMeasureValid(l, shippingBasis)));
  const quantitiesValid = lines.length > 0 && lines.every((l) => Number.isSafeInteger(l.qty_ordered) && l.qty_ordered > 0 && Number.isSafeInteger(l.invoiced_qty) && l.invoiced_qty >= 0);
  const inputsValid = quantitiesValid && profileValid && Number.isFinite(header.exchange_rate) && header.exchange_rate > 0 && lines.every((l) => (l.purchase_cost_mode === 'total' ? l.source_total_amount !== '' && l.source_total_amount != null && Number.isFinite(Number(l.source_total_amount)) && Number(l.source_total_amount) >= 0 : l.source_unit_amount !== '' && l.source_unit_amount != null && Number.isFinite(Number(l.source_unit_amount)) && Number(l.source_unit_amount) >= 0)) && lines.every((l) => Number.isSafeInteger(l.selling_price_iqd) && l.selling_price_iqd >= 0);
  const estimates = purchaseEstimate(lines, charges, header.currency === 'IQD' ? 1 : header.exchange_rate, funding.mode === 'investor' ? funding.profit_share_bps : 0, funding.incoming_indexes, header.cost_profile_id && shippingBasis ? { basis: shippingBasis, rate: header.shipping_rate_iqd ?? NaN } : undefined);
  const lineKeys = lines.map(estimateLineKey);
  const lineChoices = lines.flatMap((l, i) => lineKeys.indexOf(lineKeys[i]) === i ? [{ key: lineKeys[i], label: l.label }] : []);
  const chargeIssues = charges.map((c, j) => chargeProblems(c, lineKeys, estimates.every((e) => Number.isFinite(e.charge_shares[j]))));
  const coverLabels = (keys: readonly string[] | null) => keys && lineChoices.filter((x) => keys.includes(x.key)).map((x) => x.label);
  const updateCharge = (j: number, change: Partial<ChargeDraft>) => setCharges((a) => a.map((x, k) => k === j ? { ...x, ...change } : x));
  const total = estimates.reduce((n, e) => n + e.total_iqd, 0);
  const costsValid = inputsValid && chargeIssues.every((p) => !p.length) && Number.isSafeInteger(total) && total <= 1e12 && estimates.every((e) => Number.isSafeInteger(e.total_iqd) && e.total_iqd >= 0);
  const fundedCost = estimates.reduce((n, e, i) => n + (!funding.incoming_indexes || funding.incoming_indexes.includes(i) ? e.total_iqd : 0), 0);
  const allocated = funding.mode === 'investor' ? Math.min(Number(funding.agreed_iqd), fundedCost) : 0;
  const saveLocal = () => { localStorage.setItem('levonis-purchase-draft-v2', JSON.stringify({ header, lines, charges, funding, editId, editVersion, operationId, quickReceive })); setDraftAvailable(true); };
  const restoreLocal = () => { try { const d = JSON.parse(localStorage.getItem('levonis-purchase-draft-v2') || '{}'); if (!Array.isArray(d.lines)) return; setHeader({ ...newHeader(), ...restoreCostProfileSnapshot(d.header ?? {}, config.cost_profiles) }); setLines(d.lines); setCharges(Array.isArray(d.charges) ? d.charges.map(chargeDraft) : []); setFunding(d.funding ?? newFunding()); setEditId(d.editId); setEditVersion(d.editVersion); setOperationId(d.operationId); setQuickReceive(d.quickReceive); setEditing(true); setStep(0); } catch { localStorage.removeItem('levonis-purchase-draft-v2'); } };
  const addChoice = () => { if (!choice) return; setLines((old) => [...old, selectionCostDraft(choice, header.cost_profile_id)]); setRecent((old) => [choice, ...old.filter((r) => `${r.product_id}:${r.scope}:${r.scope_id}` !== `${choice.product_id}:${choice.scope}:${choice.scope_id}`)].slice(0, 6)); setChoice(null); };
  return (
    <div className="inventory-workspace">
      {op.feedback}
      {priceLine && <SelectionPriceUpdate line={priceLine} onClose={()=>setPriceLine(null)}/>}
      {investmentFor && <Suspense fallback={<p role="status">{loc('جارٍ تحميل اتفاق التمويل…', 'Loading funding agreement…')}</p>}><InvestorContractForm initialIncomingId={investmentFor} onClose={() => setInvestmentFor('')} onSaved={() => { setInvestmentFor(''); onChanged(); }} /></Suspense>}
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => start(undefined, false, true)}>{loc('إضافة مخزون موجود', 'Add stock on hand')}</button>
        {draftAvailable && <><button type="button" className={T.btnSecondary} onClick={restoreLocal}>{loc('استكمال المسودة المحفوظة', 'Resume saved draft')}</button><button type="button" className={T.btnGhost} disabled={op.busy} onClick={() => { setEditing(false); localStorage.removeItem('levonis-purchase-draft-v2'); setDraftAvailable(false); }}>{loc('حذف المسودة المحلية', 'Discard local draft')}</button></>}
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
              <StockSelection value={choice} onChange={setChoice} showPurchaseReference={false} />
              <button type="button" className={`${T.btnSecondary} mt-3`} disabled={!choice} onClick={addChoice}>{loc('إضافة المنتج', 'Add item')}</button>
              {recent.length > 0 && <details><summary>{loc('منتجات استخدمتها الآن', 'Recent selections')}</summary><div className="flex flex-wrap gap-2">{recent.map((r) => <button key={`${r.product_id}:${r.scope}:${r.scope_id}`} type="button" className={T.btnGhost} onClick={() => setChoice(r)}>{r.label}</button>)}</div></details>}
            </div>
            {!lines.length && <p className={`py-3 text-sm ${T.text3}`}>{loc('ابحث عن المنتج ثم حدد الخيار واللون. نجلب سعر البيع والوزن المعبّأ، ثم آخر سعر خام محفوظ لمسار المورد الذي تختاره في التكاليف والشحن.', 'Choose the exact item. Its selling reference and packed measurements load here; saved raw supplier prices load when you choose the route in Costs & freight.')}</p>}
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
            <section className="inventory-line" aria-label={loc('إعدادات المورد والشحن', 'Supplier and freight settings')}>
              <h4 className={`mb-3 font-semibold ${T.text1}`}>{loc('المورد والشحن', 'Supplier and freight')}</h4>
              <div className="inventory-fields">
                <Select label={loc('مسار المورد والشحن', 'Supplier and shipping route')} value={header.cost_profile_id ?? ''} onChange={chooseCostProfile} empty={loc('إدخال يدوي / مستند سابق', 'Manual entry / legacy document')} options={config.cost_profiles.map((p) => ({ id: p.id, name: loc(p.name_ar, p.name_en) }))} />
                {header.cost_profile_id ? <div className="grid gap-1 text-sm"><span className={T.text2}>{loc('عملة شراء المورد', 'Supplier currency')}</span><strong className={T.text1}>{header.currency === 'EUR' ? loc('يورو (EUR)', 'Euro (EUR)') : loc('يوان صيني (CNY)', 'Chinese yuan (CNY)')}</strong></div> : <Select label={loc('عملة الشراء', 'Purchase currency')} value={header.currency} onChange={(v) => { if (v === header.currency) return; update('currency', v); update('exchange_rate', 1); setLines((a) => a.map((l) => ({ ...l, source_total_amount: '', source_unit_amount: '', cost_source: 'unknown' }))); }} options={['IQD', 'USD', 'CNY', 'EUR'].map((id) => ({ id, name: id }))} />}
                {header.currency !== 'IQD' && <Input label={header.currency === 'EUR' ? loc('سعر اليورو الواحد بالدينار العراقي', 'IQD per euro') : header.currency === 'CNY' ? loc('سعر اليوان الواحد بالدينار العراقي', 'IQD per Chinese yuan') : loc('دينار لكل وحدة عملة', 'IQD per currency unit')} type="number" min={0} decimals={6} value={header.exchange_rate} onChange={(v) => update('exchange_rate', v === '' ? NaN : Number(v))} />}
                {header.cost_profile_id && <Input label={shippingBasis === 'volume' ? loc('سعر المتر المكعب CBM بالدينار العراقي', 'Freight IQD per cubic metre (CBM)') : loc('سعر الكيلوغرام بالدينار العراقي', 'Freight IQD per kilogram')} type="number" min={0} decimals={6} value={header.shipping_rate_iqd ?? ''} onChange={(v) => update('shipping_rate_iqd', v === '' ? null : Number(v))} />}
              </div>
              <p className={`mt-3 text-sm ${T.text3}`}>{header.cost_profile_id ? loc('نحسب الشحن من وزن الكرتون مع التغليف أو حجمه. عند تأكيد الشراء تُحفظ الأسعار الخام والقياسات لهذا الخيار، ويُحفظ سعر الصرف والشحن لهذا المسار لاستخدامها في المشتريات القادمة.', 'Freight uses the packed carton weight or volume. Confirming saves this selection’s raw price and packed measurements, and this route’s exchange and freight rates for future purchases.') : loc('الإدخال اليدوي يحافظ على تكاليف المستندات السابقة. راجع إن كانت القيمة المحفوظة تشمل الشحن قبل إضافة تكلفة جديدة. اختر مسارًا أعلاه لحفظ أسعار المورد وحساب الشحن تلقائيًا.', 'Manual entry preserves historical document costs. Check whether a saved amount already includes shipping before adding charges. Choose a route above to remember supplier prices and calculate freight automatically.')}</p>
              {header.cost_profile_id && <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={T.btnSecondary} disabled={op.busy || !Number.isFinite(header.exchange_rate) || header.exchange_rate <= 0 || header.shipping_rate_iqd === null || !Number.isFinite(header.shipping_rate_iqd) || header.shipping_rate_iqd < 0} onClick={() => op.run(saveProfileDefaults, loc('حُفظ سعر الصرف والشحن للمشتريات القادمة', 'Exchange and freight defaults saved'))}>{loc('حفظ سعر الصرف والشحن الآن', 'Save exchange and freight defaults now')}</button><button type="button" className={T.btnGhost} disabled={op.busy} onClick={() => op.run(reloadProfileRates, loc('حُمّل سعر الصرف والشحن المحفوظان؛ بقيت أسعار المنتجات كما أدخلتها', 'Saved exchange and freight rates loaded; entered product prices preserved'))}>{loc('إعادة تحميل سعر الصرف والشحن', 'Reload saved exchange and freight rates')}</button></div>}
            </section>
            <div className="inventory-lines">{lines.map((l, i) => <article className="inventory-line" key={i}>
              <div className="inventory-line-head"><div><strong>{l.label}</strong><small>{loc('الكمية', 'Quantity')}: {l.qty_ordered} · {loc('سعر البيع المرجعي', 'Selling reference')}: {money(l.selling_price_iqd)}</small></div></div>
              {header.cost_profile_id && l.procurement_shared_colors && <p className={`mb-3 text-sm ${T.text3}`}>{loc('ألوان هذا الخيار تشترك في مخزون واحد، لذلك يشملها السعر الخام المحفوظ. لفصل تكاليف الألوان، اختر مخزونًا منفصلًا لكل خيار ولون في إعدادات المنتج.', 'This option shares one stock pool across colours, so its saved raw price applies to those colours. For separate colour costs, use stock tracked by option and colour in the product settings.')}</p>}
              <Select label={loc('طريقة إدخال الشراء الخام', 'Raw purchase input')} value={l.purchase_cost_mode || 'unit'} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? changePurchaseCostMode(x, v as 'unit' | 'total', header.currency === 'IQD' ? 0 : 6) : x))} options={[{ id: 'total', name: loc('إجمالي سعر شراء البند الخام', 'Total raw line purchase price') }, { id: 'unit', name: loc('سعر شراء القطعة الخام', 'Raw unit purchase price') }]} />
              <div className="inventory-fields mt-3"><Input label={`${l.purchase_cost_mode === 'total' ? loc('إجمالي سعر الشراء الخام من المورد', 'Raw supplier purchase total') : loc('سعر شراء القطعة الخام من المورد', 'Raw supplier unit price')} (${header.currency})`} type="number" min={0} decimals={header.currency === 'IQD' ? 0 : 6} value={l.purchase_cost_mode === 'total' ? l.source_total_amount ?? '' : l.source_unit_amount} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, unit_conversion_inexact: false, ...(x.purchase_cost_mode === 'total' ? { source_total_amount: v === '' ? '' : Number(v), source_unit_amount: v === '' ? '' : Number(v) / x.qty_ordered } : { source_unit_amount: v === '' ? '' : Number(v), source_total_amount: v === '' ? '' : Number((Number(v) * x.qty_ordered).toFixed(6)) }) } : x))} hint={l.cost_source === 'procurement_default' ? `${loc('آخر سعر خام محفوظ لهذا الخيار والمسار، دون شحن (متوسط القطعة عند إدخال إجمالي الفاتورة)', 'Saved raw supplier price, excluding freight (unit average when entered as an invoice total)')} ${l.cost_date?.slice(0, 10) || ''}` : l.cost_source === 'confirmed_purchase' || l.cost_source === 'catalogue' ? loc('قيمة المستند المحفوظة؛ راجع فصل الشحن عنها قبل التعديل', 'Saved document amount; verify whether freight is included before changing it') : loc('أدخل سعر المورد فقط، دون الشحن', 'Enter only the supplier price, excluding freight')} />
              <Input label={loc('سعر البيع المرجعي للقطعة بالدينار', 'Reference unit selling price IQD')} type="number" decimals={0} min={0} value={l.selling_price_iqd} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, selling_price_iqd: v === '' ? NaN : Number(v) } : x))} />
              {header.cost_profile_id && (shippingBasis === 'volume'
                ? <Input label={loc('حجم كرتون القطعة مع التغليف بالمتر المكعب (CBM)', 'Packed carton volume per unit (CBM)')} type="number" min={0} decimals={9} value={l.volume_mm3 > 0 ? l.volume_mm3 / 1_000_000_000 : ''} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, volume_mm3: packedMeasureInput(v, 'volume') } : x))} hint={loc('الحجم الخارجي مع التغليف؛ ليس حجم القطعة وحدها. يُحفظ لهذا الخيار عند التأكيد.', 'Outer packed volume, not the bare item. Saved for this selection on confirmation.')} />
                : <Input label={loc('وزن كرتون القطعة مع التغليف بالكيلوغرام', 'Packed carton weight per unit (kg)')} type="number" min={0} decimals={3} value={l.weight_g > 0 ? l.weight_g / 1_000 : ''} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, weight_g: packedMeasureInput(v, 'weight') } : x))} hint={loc('الوزن الإجمالي مع الكرتون والتغليف؛ يُحفظ لهذا الخيار عند التأكيد.', 'Gross weight including carton and packaging. Saved for this selection on confirmation.')} />)}
              </div>
              {l.unit_conversion_inexact && <p role="status" className={`mt-2 text-sm ${T.text2}`}>{loc('إجمالي الفاتورة لا يعطي سعر قطعة دقيقًا ضمن دقة هذه العملة. أدخل سعر القطعة، أو عد إلى إجمالي الشراء لاستعادة المبلغ الأصلي.', 'The invoice total has no exact unit price at this currency’s input precision. Enter a unit price, or return to total input to restore the original amount.')}</p>}
              <PurchaseLineCosts
                label={l.label}
                qty={l.qty_ordered}
                rawLabel={loc('شراء القطعة الخام بالدينار', 'Raw purchase per unit in IQD')}
                raw={estimates[i]?.purchase_iqd / l.qty_ordered}
                freight={header.cost_profile_id ? estimates[i]?.auto_shipping_iqd / l.qty_ordered : null}
                extrasLabel={header.cost_profile_id ? loc('تكاليف إضافية للقطعة', 'Extra costs per unit', 'تێچووی زیادەی هەر پارچەیەک') : loc('الشحن والتكاليف اليدوية للقطعة', 'Manual freight and charges per unit', 'گواستنەوە و تێچووی دەستیی هەر پارچەیەک')}
                extras={estimates[i]?.extras_iqd / l.qty_ordered}
                lineExtras={estimates[i]?.extras_iqd}
                final={estimates[i]?.unit_iqd}
                charges={charges.map((c, j): ExtraChargeView => ({ title: c.title.trim() || loc('تكلفة بلا اسم', 'Unnamed charge', 'تێچووی بێ ناو'), scope: c.scope, amount_iqd: c.amount_iqd, unit_amount_iqd: c.unit_amount_iqd, basis: c.basis, covers: coverLabels(c.applies_to), covered: !c.applies_to || c.applies_to.includes(lineKeys[i]), share_iqd: estimates[i]?.charge_shares[j] ?? NaN, status: c.review ? 'review' : chargeIssues[j].length ? 'incomplete' : 'counted' }))}
                emptyHint={header.cost_profile_id ? loc('إن دفعت مصروفًا فعليًا، أضفه من «مصاريف إضافية فعلية» أدناه.', 'If you actually paid an extra expense, add it under “Actual extra expenses” below.', 'ئەگەر خەرجییەکی زیادەت بە ڕاستی داوە، لە «خەرجیی زیادەی ڕاستەقینە» لە خوارەوە زیادی بکە.') : undefined}
              />
              <p className={`mt-2 text-xs ${T.text3}`}>{loc('إجمالي البند مع الشحن', 'Total line cost with freight')}: {costMoney(estimates[i]?.total_iqd)} · {loc('تُقرب المجاميع إلى أقرب دينار، ومتوسط القطعة للعرض.', 'Totals round to the nearest IQD; the unit average is for display.')}</p>
              {funding.mode === 'investor' && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={!funding.incoming_indexes || funding.incoming_indexes.includes(i)} onChange={(e) => setFunding((f) => { const indexes = f.incoming_indexes ?? lines.map((_, j) => j); return { ...f, incoming_indexes: e.target.checked ? [...indexes, i] : indexes.filter((j) => j !== i) }; })} />{loc('مشمول بتمويل المستثمر ونسبته', 'Include in investor funding and profit share')}</label>}
            </article>)}</div>
            <section aria-labelledby="purchase-extras-title">
              <h4 id="purchase-extras-title" className={`mb-1 font-semibold ${T.text1}`}>{header.cost_profile_id ? loc('مصاريف إضافية فعلية', 'Actual extra expenses', 'خەرجیی زیادەی ڕاستەقینە') : loc('الشحن والتكاليف اليدوية', 'Manual freight and charges', 'گواستنەوە و تێچووە دەستییەکان')}</h4>
              <p className={`mb-3 text-sm ${T.text3}`}>{header.cost_profile_id
                ? loc('الشحن محسوب أعلاه من وزن الكرتون أو حجمه. أضف هنا فقط ما دفعته فعلًا لهذه الشحنة، مثل التوصيل المحلي أو الجمارك أو رسوم التحويل أو التغليف. لا تُضاف أي تكلفة تلقائيًا، ولا تُنسخ من شحنة سابقة.', 'Freight is already calculated above from packed weight or volume. Add only what you actually paid for this shipment, such as local delivery, customs, transfer fees or packaging. Nothing is added automatically or copied from an earlier shipment.', 'کرێی گواستنەوە لە سەرەوە بەپێی کێش یان قەبارەی کارتۆن حیساب کراوە. لێرە تەنها ئەوەی بە ڕاستی بۆ ئەم بارە داوتە زیاد بکە، وەک گەیاندنی ناوخۆیی، گومرگ، کرێی حەواڵە یان پاکێجکردن. هیچ تێچوویەک خۆکارانە زیاد ناکرێت و لە بارێکی پێشوو کۆپی ناکرێت.')
                : loc('بدون مسار شحن، أدخل الشحن وأي تكلفة أخرى هنا. لكل تكلفة اسم ومبلغ فعلي.', 'Without a freight route, enter freight and any other cost here. Each cost needs a name and an actual amount.', 'بەبێ ڕێگای گواستنەوە، کرێی گواستنەوە و هەر تێچوویەکی تر لێرە بنووسە. هەر تێچوویەک ناو و بڕێکی ڕاستەقینەی دەوێت.')}</p>
              {!charges.length && <p className={`mb-3 text-sm ${T.text2}`}>{loc('لا توجد مصاريف إضافية؛ قيمتها 0 د.ع.', 'No extra expenses: 0 IQD.', 'هیچ خەرجییەکی زیادە نییە: 0 د.ع.')}</p>}
              {charges.map((c, i) => <div key={i} className="inventory-line mb-3">
                {c.review && <div role="alert" className="mb-3 rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-text-1)]">
                  <p>{loc('أُدخلت هذه التكلفة قبل اختيار مسار الشحن، وقد تكون الشحن نفسه المحسوب الآن من الوزن. لا تُحتسب حتى تختار.', 'This charge was entered before the freight route was chosen and may be the same freight now calculated from weight. It counts nothing until you decide.', 'ئەم تێچووە پێش هەڵبژاردنی ڕێگای گواستنەوە تۆمار کراوە و لەوانەیە هەمان کرێی گواستنەوە بێت کە ئێستا بەپێی کێش حیساب دەکرێت. تا بڕیار نەدەیت حیساب ناکرێت.')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={T.btnSecondary} onClick={() => updateCharge(i, { review: false })}>{loc('ليست شحنًا، احتسبها', 'Not freight, count it', 'کرێی گواستنەوە نییە، حیسابی بکە')}</button>
                    <button type="button" className={T.btnGhost} onClick={() => setCharges((a) => a.filter((_, j) => i !== j))}>{loc('حذفها', 'Remove it', 'بیسڕەوە')}</button>
                  </div>
                </div>}
                <div className="inventory-fields">
                  <Input label={loc('اسم التكلفة', 'Charge name', 'ناوی تێچوو')} value={c.title} hint={loc('مثل: توصيل محلي، جمارك، رسوم تحويل، تغليف', 'e.g. local delivery, customs, transfer fees, packaging', 'وەک: گەیاندنی ناوخۆیی، گومرگ، کرێی حەواڵە، پاکێجکردن')} onChange={(v) => updateCharge(i, { title: v })} />
                  <Select label={loc('تخص', 'Charged to', 'تایبەتە بە')} value={c.scope} onChange={(v) => updateCharge(i, { scope: v === 'unit' ? 'unit' : 'shipment' })} options={[{ id: 'shipment', name: loc('الشحنة كاملة', 'The whole shipment', 'هەموو بارەکە') }, { id: 'unit', name: loc('كل قطعة', 'Each piece', 'هەر پارچەیەک') }]} />
                  <Input label={c.scope === 'unit' ? loc('المبلغ لكل قطعة بالدينار', 'Amount per piece IQD', 'بڕ بۆ هەر پارچەیەک بە دینار') : loc('المبلغ الإجمالي بالدينار', 'Total amount IQD', 'کۆی بڕ بە دینار')} type="number" min={0} decimals={0} hint={c.scope === 'unit' ? loc('يُضرب في عدد قطع كل بند تشمله.', 'Multiplied by the pieces of each item it covers.', 'لە ژمارەی پارچەکانی هەر بەندێک کە دەیگرێتەوە دەدرێت.') : loc('مبلغ واحد يوزَّع على القطع بالطريقة التي تختارها.', 'One amount, split across pieces the way you choose.', 'یەک بڕ کە بەو شێوازەی هەڵیدەبژێریت بەسەر پارچەکاندا دابەش دەکرێت.')} value={c.scope === 'unit' ? c.unit_amount_iqd : c.amount_iqd} onChange={(v) => updateCharge(i, c.scope === 'unit' ? { unit_amount_iqd: v === '' ? NaN : Number(v) } : { amount_iqd: v === '' ? NaN : Number(v) })} />
                  {c.scope === 'shipment' && <Select label={loc('طريقة توزيعها على القطع', 'How it is split across pieces', 'شێوازی دابەشکردنی بەسەر پارچەکاندا')} value={c.basis} onChange={(v) => updateCharge(i, { basis: v as ProcurementChargeBasis })} options={[{ id: 'quantity', name: loc('حسب عدد القطع', 'By number of pieces', 'بەپێی ژمارەی پارچەکان') }, { id: 'value', name: loc('حسب قيمة الشراء الخام', 'By raw purchase value', 'بەپێی نرخی کڕینی خاو') }, { id: 'weight', name: loc('حسب وزن الكرتون', 'By packed weight', 'بەپێی کێشی کارتۆنەکە') }, { id: 'volume', name: loc('حسب حجم الكرتون', 'By packed volume', 'بەپێی قەبارەی کارتۆنەکە') }]} />}
                </div>
                {lineChoices.length > 1 && <fieldset className="mt-3"><legend className={`text-sm ${T.text2}`}>{loc('البنود التي تشملها', 'Items it covers', 'ئەو بەندانەی دەیگرێتەوە')}</legend><div className="flex flex-wrap gap-3">{lineChoices.map((x) => <label key={x.key} className="flex gap-2 text-sm"><input type="checkbox" checked={!c.applies_to || c.applies_to.includes(x.key)} onChange={(e) => {
                  const chosen = (c.applies_to ?? lineChoices.map((y) => y.key)).filter((k) => lineKeys.includes(k) && k !== x.key);
                  if (e.target.checked) chosen.push(x.key);
                  updateCharge(i, { applies_to: lineChoices.every((y) => chosen.includes(y.key)) ? null : chosen });
                }} />{x.label}</label>)}</div></fieldset>}
                {chargeIssues[i].filter((p) => p !== 'review').map((p) => <p key={p} role="status" className="mt-2 text-[13px] text-[var(--ap-danger)]">{p === 'title' ? loc('اكتب اسم التكلفة.', 'Name this charge.', 'ناوی ئەم تێچووە بنووسە.')
                  : p === 'amount' ? loc('أدخل مبلغًا فعليًا أكبر من صفر بالدينار، أو احذف التكلفة.', 'Enter an actual amount above zero in IQD, or remove the charge.', 'بڕێکی ڕاستەقینەی سەرووی سفر بە دینار بنووسە، یان تێچووەکە بسڕەوە.')
                    : p === 'lines' ? loc('اختر بندًا واحدًا على الأقل من بنود هذه الشحنة.', 'Choose at least one item of this shipment.', 'لانیکەم یەک بەند لە بەندەکانی ئەم بارە هەڵبژێرە.')
                      : c.basis === 'weight' ? loc('أدخل وزن كل بند تشمله، أو اختر توزيعًا آخر.', 'Enter the weight of every item it covers, or choose another split.', 'کێشی هەموو ئەو بەندانەی دەیگرێتەوە بنووسە، یان شێوازێکی تری دابەشکردن هەڵبژێرە.')
                        : c.basis === 'volume' ? loc('أدخل حجم التغليف لكل بند تشمله، أو اختر توزيعًا آخر.', 'Enter the packed volume of every item it covers, or choose another split.', 'قەبارەی پاکێجی هەموو ئەو بەندانەی دەیگرێتەوە بنووسە، یان شێوازێکی تری دابەشکردن هەڵبژێرە.')
                          : loc('أكمل سعر الشراء الخام والكمية للبنود التي تشملها.', 'Complete the raw purchase price and quantity of the items it covers.', 'نرخی کڕینی خاو و بڕی ئەو بەندانەی دەیگرێتەوە تەواو بکە.')}</p>)}
                {header.cost_profile_id && !c.review && looksLikeFreight(c.title) && <p className={`mt-2 text-sm ${T.text2}`}>{loc('الشحن الدولي محسوب أعلاه من الوزن. أبقِ هذه التكلفة فقط إن كانت مصروفًا آخر، مثل توصيل محلي، حتى لا يُحتسب الشحن مرتين.', 'International freight is calculated above from weight. Keep this charge only if it is a different expense, such as local delivery, so freight is not counted twice.', 'کرێی گواستنەوەی نێودەوڵەتی لە سەرەوە بەپێی کێش حیساب کراوە. ئەم تێچووە تەنها ئەگەر خەرجییەکی ترە بهێڵەوە، وەک گەیاندنی ناوخۆیی، بۆ ئەوەی کرێی گواستنەوە دووجار حیساب نەکرێت.')}</p>}
                <button type="button" className={`${T.btnGhost} mt-2`} onClick={() => setCharges((a) => a.filter((_, j) => i !== j))}>{loc('حذف التكلفة', 'Remove charge', 'سڕینەوەی تێچوو')}</button>
              </div>)}
              <button type="button" className={T.btnSecondary} disabled={charges.length >= 15} onClick={() => setCharges((a) => [...a, newChargeDraft()])}>{header.cost_profile_id ? loc('إضافة مصروف إضافي', 'Add an extra expense', 'زیادکردنی خەرجییەکی زیادە') : loc('إضافة شحن أو تكلفة', 'Add freight or charge', 'زیادکردنی کرێی گواستنەوە یان تێچوو')}</button>
            </section>
            <details className="mt-4"><summary>{loc('تكلفة تقديرية ووزن وحجم ومرفقات واستيراد', 'Estimated cost, weights, attachments and import')}</summary><div className="inventory-fields mt-3">
              <Select label={loc('حالة التكلفة', 'Cost status')} value={header.cost_state} onChange={(v) => update('cost_state', v)} options={[{ id: 'estimated', name: loc('تقديرية؛ الاستلام ينتظر تثبيتها', 'Estimated; receiving waits for confirmation') }, { id: 'final', name: loc('نهائية ومثبتة', 'Final and confirmed') }]} />
              <Input label={loc('رابط مرفق الفاتورة HTTPS', 'Invoice attachment HTTPS URL')} value={header.attachment_url} onChange={(v) => update('attachment_url', v)} />
              <Input label={loc('مجموع الفاتورة للمطابقة (اختياري)', 'Invoice total for matching (optional)')} type="number" value={header.invoice_total_iqd} onChange={(v) => update('invoice_total_iqd', v)} />
              <Input label={loc('ملاحظات (اختياري)', 'Notes (optional)')} value={header.note} onChange={(v) => update('note', v)} />
              {!header.cost_profile_id && lines.map((l, i) => <div className="grid gap-2" key={i}><span className={`text-sm ${T.text2}`}>{l.label}</span><Input label={loc('وزن الوحدة بالغرام', 'Unit weight (g)')} type="number" value={l.weight_g} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, weight_g: Number(v) } : x))} /><Input label={loc('حجم الوحدة بالملم المكعب', 'Unit volume (mm³)')} type="number" value={l.volume_mm3} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, volume_mm3: Number(v) } : x))} /></div>)}
              {header.cost_profile_id && lines.map((l, i) => <div className="grid gap-2" key={i}><span className={`text-sm ${T.text2}`}>{l.label}</span>{shippingBasis === 'weight' ? <Input label={loc('حجم التغليف CBM لتوزيع الرسوم الأخرى (اختياري)', 'Packed volume CBM for other charge allocation (optional)')} type="number" min={0} decimals={9} value={l.volume_mm3 > 0 ? l.volume_mm3 / 1_000_000_000 : ''} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, volume_mm3: v === '' ? 0 : packedMeasureInput(v, 'volume') } : x))} /> : <Input label={loc('وزن التغليف بالكيلو لتوزيع الرسوم الأخرى (اختياري)', 'Packed weight kg for other charge allocation (optional)')} type="number" min={0} decimals={3} value={l.weight_g > 0 ? l.weight_g / 1_000 : ''} onChange={(v) => setLines((a) => a.map((x, j) => j === i ? { ...x, weight_g: v === '' ? 0 : packedMeasureInput(v, 'weight') } : x))} />}</div>)}
            </div><p className={`my-3 text-xs ${T.text3}`}>CSV: sku,qty,unit_amount,weight_g,volume_mm3</p><input aria-label="CSV" type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setCsv); }} /><textarea aria-label={loc('محتوى CSV', 'CSV content')} className={`${T.input} my-2 h-24 w-full`} value={csv} onChange={(e) => setCsv(e.target.value)} /><button type="button" className={T.btnSecondary} disabled={op.busy || !csv} onClick={() => op.run(async () => { const r = await api.post<{ lines: DraftLine[] }>(`${PROCUREMENT}/import-preview`, { csv, cost_profile_id: header.cost_profile_id }); setLines(r.lines.map((l) => ({ ...l, invoiced_qty: l.qty_ordered }))); })}>{loc('فحص واستيراد البنود', 'Validate and import lines')}</button></details>
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
          <aside className="inventory-sticky-summary"><div className="inventory-total"><span>{loc('المجموع مع تكاليف الشحنة', 'Total landed cost')}</span><strong>{money(costsValid ? total : null)}</strong></div>{funding.mode === 'investor' && <dl className="inventory-review"><div><dt>{loc('تمويل مخصص / مستلم', 'Allocated / received')}</dt><dd>{costMoney(allocated)} / {costMoney(Number(funding.received_iqd))}</dd></div><div><dt>{loc('مساهمة المتجر', 'Store contribution')}</dt><dd>{costMoney(Math.max(0, total - allocated))}</dd></div><div><dt>{loc('نقد مستلم غير مخصص', 'Unallocated received cash')}</dt><dd>{costMoney(Math.max(0, Number(funding.received_iqd) - allocated))}</dd></div><div><dt>{loc('تمويل ينتظر الاستلام', 'Funding not yet received')}</dt><dd>{costMoney(Math.max(0, allocated - Number(funding.received_iqd)))}</dd></div></dl>}<p className={`mt-2 text-xs ${T.text3}`}>{loc(quickReceive ? 'ستُستلم القطع الموجودة الآن بعد تأكيد التكلفة. الربح تقديري حتى التسليم والتحصيل.' : 'الشراء القادم لا يزيد المخزون المتاح. الربح تقديري حتى تسليم الطلب والتحصيل.', quickReceive ? 'On-hand units are received after confirming cost. Profit remains an estimate until delivery and collection.' : 'Incoming purchases do not increase available stock. Profit remains an estimate until delivery and collection.')}</p></aside>
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
            <div className="inventory-line-head"><div><strong>{l.label}</strong><small>{loc('المطلوب / المستلم', 'Ordered / received')}: {l.qty_ordered} / {l.qty_received}</small></div></div>
            <PurchaseLineCosts
              label={l.label}
              qty={l.qty_ordered}
              rawLabel={loc('شراء القطعة دون التكاليف الإضافية', 'Purchase per unit before added charges')}
              raw={(l.purchase_total_iqd ?? l.purchase_unit_iqd * l.qty_ordered) / l.qty_ordered}
              freight={selected.purchase.cost_profile_id ? (l.auto_shipping_iqd ?? 0) / l.qty_ordered : null}
              extrasLabel={selected.purchase.cost_profile_id ? loc('تكاليف إضافية للقطعة', 'Extra costs per unit', 'تێچووی زیادەی هەر پارچەیەک') : loc('الشحن والتكاليف اليدوية للقطعة', 'Manual freight and charges per unit', 'گواستنەوە و تێچووی دەستیی هەر پارچەیەک')}
              extras={(l.charges_iqd - (l.auto_shipping_iqd ?? 0)) / l.qty_ordered}
              lineExtras={l.charges_iqd - (l.auto_shipping_iqd ?? 0)}
              final={((l.purchase_total_iqd ?? l.purchase_unit_iqd * l.qty_ordered) + l.charges_iqd) / l.qty_ordered}
              charges={selected.charges.map((c): ExtraChargeView => {
                const key = estimateLineKey(l, 0), covered = !c.applies_to || c.applies_to.includes(key);
                return { title: c.title, scope: c.scope, amount_iqd: c.amount_iqd, unit_amount_iqd: c.unit_amount_iqd, basis: c.basis, covers: c.applies_to && [...new Set(selected.lines.filter((x) => c.applies_to!.includes(estimateLineKey(x, 0))).map((x) => x.label))], covered, share_iqd: c.allocations ? c.allocations.find((a) => a.line_id === l.line_id)?.amount_iqd ?? 0 : null, status: 'counted' };
              })}
            />
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
