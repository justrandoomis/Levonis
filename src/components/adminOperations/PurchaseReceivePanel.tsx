import { useCallback, useEffect, useState } from 'react';
import { api, Card, Input, PROCUREMENT, T, useLabels, useOperation } from './shared';
import '../adminInventory/inventory-workspace.css';
import { useLanguage } from '../../LanguageContext';
import { purchaseNameStrings } from './purchaseName';

/**
 * RECEIVING A SHIPMENT WITHOUT SEEING ITS COST — owner decision 2, step S1.
 *
 * The purchase register and the purchase document carry purchase prices,
 * charges, payments and funding, so they are the owner's (ProcurementPanel,
 * behind `can_view_cost === true`). Receiving is an operations act every
 * admin holding `receive` keeps. This panel reads the cost-free receiving view
 * (`/api/admin/procurement/receiving`, an allowlist with no price column) and
 * posts the same receive the owner's panel posts. Nothing it reads or stores
 * names a cost, and it keeps nothing in browser storage.
 */
type Head = {
  id: string;
  invoice_no: string;
  status: string;
  purchase_day: string;
  expected_day: string | null;
  supplier_name: string | null;
  warehouse_name: string | null;
  /** The owner has fixed the final cost — the receive waits for it. */
  ready: boolean;
};
type Line = { line_id: string; label: string; rejected_qty: number; qty_ordered: number; qty_received: number };
type Detail = { purchase: Head; lines: Line[] };
type Draft = Record<string, { qty: number; rejected_qty: number }>;

const remaining = (l: Line) => Math.max(0, l.qty_ordered - l.qty_received);

export default function PurchaseReceivePanel({ onChanged }: { onChanged: () => void }) {
  const pn = purchaseNameStrings(useLanguage().lang);
  const { loc } = useLabels(),
    op = useOperation();
  const [purchases, setPurchases] = useState<Head[] | null>(null),
    [selected, setSelected] = useState<Detail | null>(null),
    [receiving, setReceiving] = useState<Draft>({}),
    [receiveId, setReceiveId] = useState(() => crypto.randomUUID());

  const load = useCallback(async () => {
    const r = await api.get<{ purchases: Head[] }>(`${PROCUREMENT}/receiving`);
    setPurchases(r.purchases ?? []);
    return r.purchases ?? [];
  }, []);
  const { run } = op;
  useEffect(() => {
    void run(load);
  }, [run, load]);

  const open = async (id: string) => {
    const d = await api.get<Detail>(`${PROCUREMENT}/receiving/${encodeURIComponent(id)}`);
    setSelected(d);
    setReceiving(Object.fromEntries(d.lines.map((l) => [l.line_id, { qty: remaining(l), rejected_qty: 0 }])));
    setReceiveId(crypto.randomUUID());
  };

  const statusLabel = (status: string) =>
    status === 'partial'
      ? loc('استلام جزئي', 'Partly received', 'بەشێکی وەرگیراوە')
      : loc('قادم', 'Incoming', 'لە ڕێگادایە');

  const valid =
    !!selected &&
    selected.purchase.ready &&
    selected.lines.some((l) => (receiving[l.line_id]?.qty ?? 0) > 0 || (receiving[l.line_id]?.rejected_qty ?? 0) > 0) &&
    selected.lines.every((l) => {
      const d = receiving[l.line_id] ?? { qty: 0, rejected_qty: 0 };
      return (
        Number.isInteger(d.qty) &&
        Number.isInteger(d.rejected_qty) &&
        d.qty >= 0 &&
        d.rejected_qty >= 0 &&
        d.qty + d.rejected_qty <= remaining(l)
      );
    });

  const receive = () =>
    op.run(async () => {
      if (!selected) return;
      const id = selected.purchase.id;
      await api.post(`${PROCUREMENT}/documents/${encodeURIComponent(id)}/receive`, {
        operation_id: receiveId,
        lines: selected.lines.map((l) => ({ line_id: l.line_id, ...receiving[l.line_id] })),
      });
      const still = await load();
      if (still.some((p) => p.id === id)) await open(id);
      else setSelected(null);
      onChanged();
    }, loc('تم الاستلام وتحديث المخزون', 'Received and stock updated', 'وەرگیرا و کۆگا نوێکرایەوە'));

  return (
    <div>
      {op.feedback}
      {selected && (
        <Card title={selected.purchase.invoice_no || pn.fallback}>
          <p className={`mb-3 text-sm ${T.text3}`}>
            {selected.purchase.supplier_name || loc('بدون مورد', 'No supplier', 'بێ دابینکەر')} · {statusLabel(selected.purchase.status)}
            {selected.purchase.warehouse_name ? ` · ${selected.purchase.warehouse_name}` : ''}
          </p>
          {!selected.purchase.ready && (
            <p role="status" className={`mb-3 text-sm ${T.text3}`}>
              {loc(
                'بانتظار تثبيت التكلفة النهائية من المالك قبل الاستلام.',
                'Waiting for the owner to fix the final cost before receiving.',
                'چاوەڕێی جێگیرکردنی تێچووی کۆتایی لەلایەن خاوەنەوەیە پێش وەرگرتن.'
              )}
            </p>
          )}
          <div className="inventory-lines">
            {selected.lines.map((l) => (
              <article className="inventory-line" key={l.line_id}>
                <div className="inventory-line-head">
                  <div>
                    <strong>{l.label}</strong>
                    <small>
                      {loc('المطلوب / المستلم', 'Ordered / received', 'داواکراو / وەرگیراو')}: {l.qty_ordered} / {l.qty_received}
                    </small>
                  </div>
                </div>
                <Input
                  label={loc('الكمية التي وصلت الآن', 'Quantity arriving now', 'ئەو بڕەی ئێستا گەیشت')}
                  type="number"
                  min={0}
                  decimals={0}
                  value={receiving[l.line_id]?.qty ?? 0}
                  onChange={(v) => setReceiving((r) => ({ ...r, [l.line_id]: { ...r[l.line_id], qty: Number(v) } }))}
                  hint={`${loc('المتبقي للاستلام', 'Remaining to receive', 'ماوە بۆ وەرگرتن')}: ${remaining(l)}`}
                />
                <Input
                  label={loc('المرفوض الآن', 'Rejected now', 'ئێستا ڕەتکراوە')}
                  type="number"
                  min={0}
                  decimals={0}
                  value={receiving[l.line_id]?.rejected_qty ?? 0}
                  onChange={(v) => setReceiving((r) => ({ ...r, [l.line_id]: { ...r[l.line_id], rejected_qty: Number(v) } }))}
                />
              </article>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={T.btnPrimary} disabled={op.busy || !valid} onClick={receive}>
              {loc('استلام الكميات المحددة', 'Receive selected quantities', 'وەرگرتنی بڕە دیاریکراوەکان')}
            </button>
            <button type="button" className={T.btnGhost} onClick={() => setSelected(null)}>
              {loc('إغلاق', 'Close', 'داخستن')}
            </button>
          </div>
        </Card>
      )}
      <Card title={loc('شحنات بانتظار الاستلام', 'Shipments awaiting receipt', 'بارەکانی چاوەڕێی وەرگرتن')}>
        <p className={`mb-3 text-sm ${T.text3}`}>
          {loc(
            'اختر الشحنة ثم أدخل الكميات التي وصلت. لا تظهر هنا أي تكلفة؛ أسعار الشراء والدفعات للمالك وحده.',
            'Choose a shipment, then enter the quantities that arrived. No cost is shown here; purchase prices and payments are the owner’s alone.',
            'بارێک هەڵبژێرە، پاشان ئەو بڕانە بنووسە کە گەیشتوون. هیچ تێچوویەک لێرە پیشان نادرێت؛ نرخی کڕین و پارەدانەکان تەنها هی خاوەنەکەن.'
          )}
        </p>
        {purchases === null ? (
          <p role="status" className={`py-3 text-sm ${T.text3}`}>{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>
        ) : purchases.length === 0 ? (
          <p className={`py-3 text-sm ${T.text3}`}>{loc('لا توجد شحنات بانتظار الاستلام.', 'No shipments are awaiting receipt.', 'هیچ بارێک چاوەڕێی وەرگرتن نییە.')}</p>
        ) : (
          <div className="inventory-lines">
            {purchases.map((p) => (
              <article className="inventory-line" key={p.id}>
                <div className="inventory-line-head">
                  <div>
                    <strong>{p.invoice_no || pn.fallback}</strong>
                    <small>
                      {p.supplier_name || loc('بدون مورد', 'No supplier', 'بێ دابینکەر')} · {statusLabel(p.status)}
                      {p.expected_day ? ` · ${p.expected_day}` : ''}
                    </small>
                  </div>
                  <button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => op.run(() => open(p.id))}>
                    {loc('استلام', 'Receive', 'وەرگرتن')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
