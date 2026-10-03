import { useCallback, useEffect, useState } from 'react';
import StockSelection from './StockSelection';
import {
  api,
  Card,
  Cell,
  DataTable,
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
type Detail = {
  purchase: Purchase & {
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
      qty_received: number;
      rejected_qty: number;
      purchase_unit_iqd: number;
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
export default function ProcurementPanel({ onChanged }: { onChanged: () => void }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [config, setConfig] = useState<{ suppliers: Named[]; locations: Named[] }>({
      suppliers: [],
      locations: [],
    }),
    [purchases, setPurchases] = useState<Purchase[]>([]),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Detail | null>(null),
    [editing, setEditing] = useState(false),
    [editId, setEditId] = useState(''),
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
      api.get<{ purchases: Purchase[] }>(`${PROCUREMENT}/documents?offset=${offset}`),
    ]);
    setConfig(cfg);
    setPurchases(r.purchases);
  }, [offset]);
  const { run } = op;
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
  const start = (d?: Detail, clone = false) => {
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
            cost_source: 'latest_purchase',
            unit_cost_iqd: l.purchase_unit_iqd,
          }))
        : [],
    );
    setCharges(d?.charges ?? []);
    setEditId(d && !clone ? d.purchase.id : '');
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
      operation_id: operationId,
      version: selected?.purchase.version,
    };
    const r = editId
      ? await api.put<{ id: string }>(`${PROCUREMENT}/documents/${editId}`, body)
      : await api.post<{ id: string }>(`${PROCUREMENT}/documents`, body);
    await load();
    await open(r.id);
    onChanged();
  };
  const update = (key: keyof Header, value: string | number) => setHeader((h) => ({ ...h, [key]: value }));
  const total =
    lines.reduce(
      (s, l) =>
        s +
        l.qty_ordered *
          Math.round(Number(l.source_unit_amount) * (header.currency === 'IQD' ? 1 : header.exchange_rate)),
      0,
    ) + charges.reduce((s, c) => s + c.amount_iqd, 0);
  return (
    <div>
      {op.feedback}
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => start()}>
          {loc('شراء / شحنة جديدة', 'New purchase / shipment')}
        </button>
        <button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => op.run(load)}>
          {loc('تحديث', 'Refresh')}
        </button>
      </div>
      {editing && (
        <Card
          title={loc(
            editId ? 'تعديل أمر الشراء' : 'تسجيل شراء متعدد المنتجات',
            editId ? 'Edit purchase' : 'Record a multi-product purchase',
          )}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Select
              label={loc('المورد', 'Supplier')}
              value={header.supplier_id}
              onChange={(v) => update('supplier_id', v)}
              empty={loc('بدون مورد', 'No supplier')}
              options={config.suppliers.map((x) => ({ id: x.id, name: nameOf(x) }))}
            />
            <Input
              label={loc('رقم الفاتورة', 'Invoice number')}
              value={header.invoice_no}
              onChange={(v) => update('invoice_no', v)}
            />
            <Select
              label={loc('المستودع / الموقع', 'Warehouse / location')}
              value={header.warehouse_id}
              onChange={(v) => update('warehouse_id', v)}
              empty={loc('غير محدد', 'Unassigned')}
              options={config.locations.map((x) => ({ id: x.id, name: nameOf(x) }))}
            />
            <Input
              label={loc('تاريخ الشراء', 'Purchase date')}
              type="date"
              value={header.purchase_day}
              onChange={(v) => update('purchase_day', v)}
            />
            <Select
              label={loc('عملة الشراء', 'Purchase currency')}
              value={header.currency}
              onChange={(v) => {
                update('currency', v);
                update('exchange_rate', v === 'IQD' ? 1 : header.exchange_rate);
              }}
              options={['IQD', 'USD', 'CNY', 'EUR'].map((id) => ({ id, name: id }))}
            />
            {header.currency !== 'IQD' && (
              <Input
                label={loc('دينار لكل وحدة عملة', 'IQD per currency unit')}
                type="number"
                value={header.exchange_rate}
                onChange={(v) => update('exchange_rate', Number(v))}
              />
            )}
            <Input
              label={loc('الوصول المتوقع', 'Expected arrival')}
              type="date"
              value={header.expected_day}
              onChange={(v) => update('expected_day', v)}
            />
            <Select
              label={loc('حالة التكلفة', 'Cost status')}
              value={header.cost_state}
              onChange={(v) => update('cost_state', v)}
              options={[
                { id: 'estimated', name: loc('تقديرية؛ لا يمكن الاستلام', 'Estimated; receiving blocked') },
                { id: 'final', name: loc('نهائية ومثبتة', 'Final and confirmed') },
              ]}
            />
          </div>
          <div className="my-5 max-w-2xl">
            <StockSelection value={choice} onChange={setChoice} />
            <button
              type="button"
              className={`${T.btnSecondary} mt-3`}
              disabled={!choice}
              onClick={() => {
                setLines((old) => [
                  ...old,
                  {
                    ...choice,
                    qty_ordered: 1,
                    invoiced_qty: 1,
                    source_unit_amount:
                      choice.purchase_unit_iqd == null
                        ? ''
                        : choice.purchase_unit_iqd / (header.currency === 'IQD' ? 1 : header.exchange_rate),
                  },
                ]);
                setChoice(null);
              }}
            >
              {loc('إضافة بند', 'Add line')}
            </button>
          </div>
          <DataTable
            headers={[
              loc('المنتج والخيار واللون', 'Product / selection'),
              loc('الكمية', 'Quantity'),
              loc('سعر الوحدة بعملة الشراء', 'Unit price in purchase currency'),
              loc('كمية الفاتورة', 'Invoice quantity'),
              loc('سعر البيع المرجعي', 'Selling reference'),
              '',
            ]}
          >
            {lines.map((l, i) => (
              <tr key={i}>
                <Cell>
                  {l.label}
                  <small className="block">{l.sku}</small>
                </Cell>
                <Cell>
                  <input
                    aria-label={loc('الكمية', 'Quantity')}
                    className={T.input}
                    type="number"
                    min="1"
                    value={l.qty_ordered}
                    onChange={(e) =>
                      setLines((a) =>
                        a.map((v, j) => (j === i ? { ...v, qty_ordered: Number(e.target.value) } : v)),
                      )
                    }
                  />
                </Cell>
                <Cell>
                  <input
                    aria-label={loc('التكلفة', 'Cost')}
                    className={T.input}
                    type="number"
                    min="0"
                    step="any"
                    value={l.source_unit_amount}
                    onChange={(e) =>
                      setLines((a) =>
                        a.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                source_unit_amount: e.target.value === '' ? '' : Number(e.target.value),
                              }
                            : v,
                        ),
                      )
                    }
                  />
                </Cell>
                <Cell>
                  <input
                    aria-label={loc('كمية الفاتورة', 'Invoice quantity')}
                    className={T.input}
                    type="number"
                    min="0"
                    value={l.invoiced_qty}
                    onChange={(e) =>
                      setLines((a) =>
                        a.map((v, j) => (j === i ? { ...v, invoiced_qty: Number(e.target.value) } : v)),
                      )
                    }
                  />
                </Cell>
                <Cell>{money(l.selling_price_iqd)}</Cell>
                <Cell>
                  <button
                    type="button"
                    className={T.btnGhost}
                    onClick={() => setLines((a) => a.filter((_, j) => i !== j))}
                  >
                    {loc('حذف', 'Remove')}
                  </button>
                </Cell>
              </tr>
            ))}
          </DataTable>
          <details className="my-4">
            <summary className={`cursor-pointer text-sm ${T.text2}`}>
              {loc('تفاصيل الوزن والحجم والاستيراد والمرفقات', 'Weights, volumes, CSV and attachments')}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {lines.map((l, i) => (
                <div key={i} className="grid gap-2">
                  <span className="text-xs">{l.label}</span>
                  <Input
                    label={loc('وزن الوحدة بالغرام', 'Unit weight (g)')}
                    type="number"
                    value={l.weight_g}
                    onChange={(v) =>
                      setLines((a) => a.map((x, j) => (j === i ? { ...x, weight_g: Number(v) } : x)))
                    }
                  />
                  <Input
                    label={loc('حجم الوحدة بالملم المكعب', 'Unit volume (mm³)')}
                    type="number"
                    value={l.volume_mm3}
                    onChange={(v) =>
                      setLines((a) => a.map((x, j) => (j === i ? { ...x, volume_mm3: Number(v) } : x)))
                    }
                  />
                </div>
              ))}
              <Input
                label={loc('رابط مرفق الفاتورة HTTPS', 'Invoice attachment HTTPS URL')}
                value={header.attachment_url}
                onChange={(v) => update('attachment_url', v)}
              />
              <Input
                label={loc('مجموع الفاتورة للمطابقة (اختياري)', 'Invoice total for matching (optional)')}
                type="number"
                value={header.invoice_total_iqd}
                onChange={(v) => update('invoice_total_iqd', v)}
              />
              <Input
                label={loc('رقم التتبع', 'Tracking number')}
                value={header.tracking}
                onChange={(v) => update('tracking', v)}
              />
              <Input
                label={loc('الملاحظات', 'Notes')}
                value={header.note}
                onChange={(v) => update('note', v)}
              />
              <div className="sm:col-span-2">
                <p className="mb-2 text-xs">CSV: sku,qty,unit_amount,weight_g,volume_mm3</p>
                <input
                  aria-label="CSV"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) f.text().then(setCsv);
                  }}
                />
                <textarea
                  aria-label={loc('محتوى CSV', 'CSV content')}
                  className={`${T.input} mt-2 h-24 w-full`}
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                />
                <button
                  type="button"
                  className={T.btnSecondary}
                  disabled={op.busy || !csv}
                  onClick={() =>
                    op.run(async () => {
                      const r = await api.post<{ lines: DraftLine[] }>(`${PROCUREMENT}/import-preview`, {
                        csv,
                      });
                      setLines(r.lines.map((l) => ({ ...l, invoiced_qty: l.qty_ordered })));
                    })
                  }
                >
                  {loc('فحص واستيراد البنود', 'Validate and import lines')}
                </button>
              </div>
            </div>
          </details>
          <h4 className={`my-3 font-semibold ${T.text1}`}>
            {loc('تكاليف الشحن والجمارك والتوصيل وغيرها', 'Freight, customs, delivery and other charges')}
          </h4>
          {charges.map((c, i) => (
            <div key={i} className="mb-3 grid items-end gap-2 sm:grid-cols-4">
              <Input
                label={loc('اسم التكلفة', 'Charge name')}
                value={c.title}
                onChange={(v) => setCharges((a) => a.map((x, j) => (j === i ? { ...x, title: v } : x)))}
              />
              <Input
                label={loc('إجمالي بالدينار', 'Total IQD')}
                type="number"
                value={c.amount_iqd}
                onChange={(v) =>
                  setCharges((a) => a.map((x, j) => (j === i ? { ...x, amount_iqd: Number(v) } : x)))
                }
              />
              <Select
                label={loc('طريقة التوزيع', 'Allocation method')}
                value={c.basis}
                onChange={(v) => setCharges((a) => a.map((x, j) => (j === i ? { ...x, basis: v } : x)))}
                options={['quantity', 'value', 'weight', 'volume'].map((id, j) => ({
                  id,
                  name: [
                    loc('الكمية', 'Quantity'),
                    loc('القيمة', 'Value'),
                    loc('الوزن', 'Weight'),
                    loc('الحجم', 'Volume'),
                  ][j],
                }))}
              />
              <button
                type="button"
                className={T.btnGhost}
                onClick={() => setCharges((a) => a.filter((_, j) => i !== j))}
              >
                {loc('حذف التكلفة', 'Remove charge')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className={T.btnSecondary}
            onClick={() =>
              setCharges((a) => [...a, { title: loc('شحن', 'Shipping'), amount_iqd: 0, basis: 'quantity' }])
            }
          >
            {loc('إضافة تكلفة', 'Add charge')}
          </button>
          <p className={`my-4 font-bold ${T.text1}`}>
            {loc('المجموع مع تكاليف الشحنة', 'Total landed cost')}: {money(total)}
          </p>
          <p className={`mb-3 text-xs ${T.text3}`}>
            {loc(
              'السعر المرجعي للمعاينة؛ يمكن تحديث سعر البيع من محرر المنتجات. تثبيت التكلفة يمنع تغييرها بعد الاستلام.',
              'Selling references are previews; update selling prices in the product editor. Received costs are frozen.',
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={T.btnSecondary}
              disabled={op.busy || !lines.length}
              onClick={() => op.run(() => save('draft'), loc('تم حفظ المسودة', 'Draft saved'))}
            >
              {loc('حفظ مسودة', 'Save draft')}
            </button>
            <button
              type="button"
              className={T.btnPrimary}
              disabled={op.busy || !lines.length}
              onClick={() => op.run(() => save('ordered'), loc('تم تأكيد أمر الشراء', 'Purchase confirmed'))}
            >
              {loc('حفظ وتأكيد الشراء', 'Save and confirm')}
            </button>
            <button type="button" className={T.btnGhost} onClick={() => setEditing(false)}>
              {loc('إلغاء', 'Cancel')}
            </button>
          </div>
        </Card>
      )}
      {!editing && selected && (
        <Card
          title={`${loc('تفاصيل الشحنة', 'Shipment details')} · ${selected.purchase.invoice_no || selected.purchase.id}`}
        >
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
          <div className="mb-3 flex gap-2">
            <button type="button" className={T.btnSecondary} onClick={() => start(selected, true)}>
              {loc('نسخ لشراء جديد', 'Clone purchase')}
            </button>
            {['draft', 'ordered'].includes(selected.purchase.status) && !selected.matching.received_qty && (
              <button type="button" className={T.btnSecondary} onClick={() => start(selected)}>
                {loc('تعديل / إكمال المسودة', 'Edit / resume draft')}
              </button>
            )}
            <button type="button" className={T.btnGhost} onClick={() => setSelected(null)}>
              {loc('إغلاق', 'Close')}
            </button>
          </div>
          <DataTable
            headers={[
              loc('المنتج', 'Product'),
              loc('المطلوب / المستلم', 'Ordered / received'),
              loc('تكلفة الوحدة / نصيب الشحنة', 'Unit cost / charge share'),
              loc('استلام الآن', 'Receive now'),
              loc('مرفوض الآن', 'Rejected now'),
            ]}
          >
            {selected.lines.map((l) => (
              <tr key={l.line_id}>
                <Cell>{l.label}</Cell>
                <Cell>
                  {l.qty_ordered} / {l.qty_received}
                </Cell>
                <Cell>
                  {money(l.purchase_unit_iqd)} / {money(l.charges_iqd)}
                </Cell>
                <Cell>
                  <input
                    aria-label={loc('المستلم', 'Received')}
                    className={T.input}
                    type="number"
                    min="0"
                    max={l.qty_ordered - l.qty_received}
                    value={receiving[l.line_id]?.qty ?? 0}
                    onChange={(e) =>
                      setReceiving((r) => ({
                        ...r,
                        [l.line_id]: { ...r[l.line_id], qty: Number(e.target.value) },
                      }))
                    }
                  />
                </Cell>
                <Cell>
                  <input
                    aria-label={loc('المرفوض', 'Rejected')}
                    className={T.input}
                    type="number"
                    min="0"
                    value={receiving[l.line_id]?.rejected_qty ?? 0}
                    onChange={(e) =>
                      setReceiving((r) => ({
                        ...r,
                        [l.line_id]: { ...r[l.line_id], rejected_qty: Number(e.target.value) },
                      }))
                    }
                  />
                </Cell>
              </tr>
            ))}
          </DataTable>
          {['ordered', 'partial'].includes(selected.purchase.status) && (
            <button
              type="button"
              className={`${T.btnPrimary} my-3`}
              disabled={op.busy}
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
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
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
          </div>
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
      <Card title={loc('سجل أوامر الشراء', 'Purchase orders')}>
        <DataTable
          headers={[
            loc('الفاتورة / المورد', 'Invoice / supplier'),
            loc('الحالة', 'Status'),
            loc('المجموع', 'Total'),
            loc('المدفوع', 'Paid'),
            '',
          ]}
        >
          {purchases.map((p) => (
            <tr key={p.id}>
              <Cell>
                {p.invoice_no || p.id}
                <small className="block">{p.supplier_name}</small>
              </Cell>
              <Cell>
                {loc(
                  {
                    draft: 'مسودة',
                    ordered: 'قادم',
                    partial: 'استلام جزئي',
                    received: 'مكتمل',
                    cancelled: 'ملغى',
                  }[p.status] || p.status,
                  p.status,
                )}
              </Cell>
              <Cell>{money(p.total_cost_iqd)}</Cell>
              <Cell>{money(p.paid_iqd)}</Cell>
              <Cell>
                <button
                  type="button"
                  className={T.btnSecondary}
                  disabled={op.busy}
                  onClick={() => op.run(() => open(p.id))}
                >
                  {loc('فتح', 'Open')}
                </button>
              </Cell>
            </tr>
          ))}
        </DataTable>
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
