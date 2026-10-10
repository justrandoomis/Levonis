import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Card, Input, money, T, today, useLabels, useOperation } from '../adminOperations/shared';
import LotCountForm from './LotCountForm';
import LotScanner from './LotScanner';
import BatchSnapshotCard from './BatchSnapshotCard';
import { daysSince } from './shared';

const INVESTMENT = '/api/admin/investment-finance';
type Lot = { id: string; incoming_id: string | null; product_id: string; scope: 'base' | 'option' | 'color' | 'variant'; scope_id: string; name?: string; name_ar?: string; product_name?: string; qty_received: number; qty_remaining: number; unit_cost_iqd: number | null; effective_unit_cost_iqd?: number | null; received_at: string; location_name?: string | null };
type Adjustment = { id?: string; adjustment_id: string; allocation_id?: string | null; adjustment_day: string; title?: string; unit_delta_iqd: number; old_unit_cost_iqd?: number; new_unit_cost_iqd?: number; amount_iqd?: number };
type Detail = { lot: Lot; contracts: { id: string; name: string; user_name?: string; profit_share_bps: number; state?: 'active' | 'void' }[]; allocations: { id: string; order_id?: string; qty: number; returned_qty?: number; cogs_iqd?: number | null }[]; adjustments: Adjustment[] };
type Filter = 'all' | 'aging' | 'unknown';
const currentCost = (l: Lot) => l.effective_unit_cost_iqd === undefined ? l.unit_cost_iqd : l.effective_unit_cost_iqd;
const label = (l: Lot) => l.name_ar || l.product_name || l.name || l.id.slice(-8);

export default function InventoryLotPanel({ onChanged, onOperations }: { onChanged: () => void; onOperations: () => void }) {
  const { loc } = useLabels();
  const op = useOperation();
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<Filter>('all'), [lots, setLots] = useState<Lot[]>([]), [detail, setDetail] = useState<Detail | null>(null);
  const [offset, setOffset] = useState(0);
  const [newCost, setNewCost] = useState(''), [showCost, setShowCost] = useState(false), [showCount, setShowCount] = useState(false), [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const generation = useRef(0);
  const load = useCallback(async () => { const mine = ++generation.current; try { const r = await api.get<{ lots: Lot[] }>(`${INVESTMENT}/lots?q=${encodeURIComponent(search)}&offset=${offset}`); if (mine === generation.current) setLots(r.lots); } catch (e) { if (mine === generation.current) throw e; } }, [search, offset]);
  const { run } = op;
  useEffect(() => { const t = setTimeout(() => { run(load); }, search ? 280 : 0); return () => { clearTimeout(t); generation.current += 1; }; }, [load, run, search]);
  const open = async (id: string) => { const r = await api.get<Detail>(`${INVESTMENT}/lots/${encodeURIComponent(id)}`); setDetail({ ...r, lot: { ...lots.find((l) => l.id === id), ...r.lot } }); setShowCost(false); setShowCount(false); setNewCost(''); setOperationId(crypto.randomUUID()); };
  const knownCapital = lots.reduce((n, l) => n + (currentCost(l) == null ? 0 : l.qty_remaining * currentCost(l)), 0);
  const unknownUnits = lots.reduce((n, l) => n + (currentCost(l) == null ? l.qty_remaining : 0), 0);
  const agingUnits = lots.reduce((n, l) => n + ((daysSince(l.received_at) ?? 0) >= 180 ? l.qty_remaining : 0), 0);
  const rows = lots.filter((l) => filter === 'all' || (filter === 'aging' ? (daysSince(l.received_at) ?? 0) >= 180 && l.qty_remaining > 0 : currentCost(l) == null && l.qty_remaining > 0));
  const history = [...new Map((detail?.adjustments ?? []).map((a) => [a.adjustment_id ?? a.id, a])).values()];
  return <div className="inventory-workspace">
    {op.feedback}
    <Card title={loc('رأس المال وعمر المخزون', 'Inventory capital and age')}>
      <p className={`mb-3 text-sm ${T.text3}`}>{loc('الأرقام التالية تخص نتائج البحث الحالية، حسب تكلفة كل دفعة. افتح الدفعة لمعرفة مصدرها ومبيعاتها وتمويلها.', 'These figures cover the current search results at each lot’s own cost. Open a lot to see its origin, sales and funding.')}</p>
      <dl className="inventory-review mb-4">
        <div><dt>{loc('رأس المال المعروف المتبقي', 'Known remaining capital')}</dt><dd>{money(knownCapital)}</dd></div>
        <div><dt>{loc('قطع بعمر 180 يومًا أو أكثر', 'Units aged 180+ days')}</dt><dd>{agingUnits}</dd></div>
        <div><dt>{loc('قطع تحتاج تثبيت تكلفة', 'Units with unknown cost')}</dt><dd>{unknownUnits}</dd></div>
        <div><dt>{loc('دفعات في النتائج', 'Lots in results')}</dt><dd>{lots.length}</dd></div>
      </dl>
      <div className="inventory-report-links">
        {(['all', 'aging', 'unknown'] as const).map((id, i) => <button type="button" className={T.chip} aria-pressed={filter === id} key={id} onClick={() => setFilter(id)}>{[loc('كل الدفعات', 'All lots'), loc('مخزون راكد', 'Aging stock'), loc('تكلفة غير معروفة', 'Unknown cost')][i]}</button>)}
        <button type="button" className={T.btnSecondary} onClick={onOperations}>{loc('فروقات المخزون وخطة الشراء', 'Stock discrepancies and replenishment')}</button>
      </div>
      <Input label={loc('ابحث عن منتج أو دفعة', 'Find product or lot')} value={search} onChange={(v) => { setSearch(v); setOffset(0); }} />
      <div className="inventory-lines">{rows.map((l) => <article className="inventory-line" key={l.id}>
        <div className="inventory-line-head"><div><strong>{label(l)}</strong><small>{l.location_name || loc('موقع غير محدد', 'Unassigned location')} · {(l.received_at || '').slice(0, 10)} · {l.id.slice(-8)}</small></div><button type="button" className={T.btnSecondary} disabled={op.busy} onClick={() => op.run(() => open(l.id))}>{loc('تفاصيل', 'Details')}</button></div>
        <div className={`flex flex-wrap gap-3 text-sm ${T.text2}`}><span>{loc('المتبقي', 'Remaining')}: {l.qty_remaining}</span><span>{loc('تكلفة الوحدة الحالية', 'Current unit cost')}: {money(currentCost(l))}</span><span>{loc('رأس المال', 'Capital')}: {money(currentCost(l) == null ? null : l.qty_remaining * currentCost(l))}</span></div>
      </article>)}</div>
      {!rows.length && !op.busy && <p className={`py-3 text-sm ${T.text3}`}>{loc('لا توجد دفعات مطابقة', 'No matching lots')}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={T.btnSecondary} disabled={op.busy || offset === 0} onClick={() => setOffset((v) => Math.max(0, v - 200))}>{loc('السابق', 'Previous')}</button><button type="button" className={T.btnSecondary} disabled={op.busy || lots.length < 200} onClick={() => setOffset((v) => v + 200)}>{loc('التالي', 'Next')}</button></div>
    </Card>
    {detail && <Card title={`${loc('تفاصيل الدفعة', 'Lot details')} · ${label(detail.lot)}`}>
      <div className="mb-4 flex flex-wrap gap-2"><button type="button" className={T.btnSecondary} onClick={() => setShowCount((v) => !v)}>{loc('جرد هذه الدفعة', 'Count this lot')}</button><button type="button" className={T.btnSecondary} disabled={!detail.lot.incoming_id} onClick={() => setShowCost((v) => !v)}>{loc('تعديل تكلفة الوحدة', 'Adjust unit cost')}</button><button type="button" className={T.btnGhost} onClick={() => setDetail(null)}>{loc('إغلاق', 'Close')}</button></div>
      <LotScanner selection={{ product_id: detail.lot.product_id, scope: detail.lot.scope, scope_id: detail.lot.scope_id }} onScanned={(r) => { if (r.lot?.id !== detail.lot.id) throw new Error(loc('الرمز يخص دفعة أخرى من هذا المنتج', 'The label belongs to another lot of this item')); }} />
      <dl className="inventory-review mb-4"><div><dt>{loc('المستلم / المتبقي', 'Received / remaining')}</dt><dd>{detail.lot.qty_received} / {detail.lot.qty_remaining}</dd></div><div><dt>{loc('تكلفة الوحدة الحالية', 'Current unit cost')}</dt><dd>{money(currentCost(detail.lot))}</dd></div><div><dt>{loc('مصدر الشراء', 'Purchase origin')}</dt><dd>{detail.lot.incoming_id || loc('رصيد افتتاحي', 'Opening balance')}</dd></div><div><dt>{loc('الموقع', 'Location')}</dt><dd>{detail.lot.location_name || '—'}</dd></div></dl>
      <BatchSnapshotCard key={`snapshot:${detail.lot.id}`} filter={{ lot_id: detail.lot.id }} />
      {showCount && <div className="inventory-line mb-4"><LotCountForm key={detail.lot.id} initialLot={detail.lot.id} lots={[detail.lot]} onChanged={async () => { await load(); await open(detail.lot.id); onChanged(); }} /></div>}
      {showCost && <div className="inventory-line mb-4">
        <p className={`mb-3 text-sm ${T.text2}`}>{loc('التكلفة السابقة', 'Previous cost')}: {money(currentCost(detail.lot))}</p>
        <Input label={loc('التكلفة الجديدة للوحدة بالدينار', 'New unit cost IQD')} type="number" min={0} value={newCost} onChange={(v) => { setNewCost(v); setOperationId(crypto.randomUUID()); }} />
        <p className={`my-3 text-xs ${T.text3}`}>{loc('أكمل استلام بند الشراء وسوِّ فروقات الجرد أولًا. يحدّث هذا الرقم جميع دفعات البند، بما فيها المنقولة؛ ويحسب النظام فرق الباقي والمباع ويحفظ السجل تلقائيًا.', 'Complete receipt of the purchase line and settle count discrepancies first. This updates all its lots, including transfers; the system calculates remaining and sold cost differences and saves the history automatically.')}</p>
        <button type="button" className={T.btnPrimary} disabled={op.busy || newCost === '' || !Number.isInteger(Number(newCost)) || Number(newCost) < 0 || Number(newCost) === currentCost(detail.lot)} onClick={() => op.run(async () => { await api.post(`${INVESTMENT}/lot-cost-adjustments`, { operation_id: operationId, incoming_id: detail.lot.incoming_id, new_unit_cost_iqd: Number(newCost), adjustment_day: today() }); await load(); await open(detail.lot.id); onChanged(); }, loc('تم تسجيل التكلفة الجديدة', 'New cost recorded'))}>{loc('حفظ التكلفة الجديدة', 'Save new cost')}</button>
      </div>}
      <details><summary>{loc('المستثمرون المرتبطون', 'Associated investors')} ({detail.contracts.length})</summary>{detail.contracts.map((c) => <p className={`my-2 text-sm ${T.text2}`} key={c.id}>{c.user_name || c.name} · {c.state === 'void' ? loc('اتفاق مبطل', 'Voided agreement') : `${loc('حصة الربح', 'Profit share')}: ${c.profit_share_bps / 100}%`}</p>)}</details>
      <details><summary>{loc('مبيعات الدفعة', 'Lot sales')} ({detail.allocations.length})</summary>{detail.allocations.map((a) => <p className={`my-2 text-sm ${T.text2}`} key={a.id}>{a.order_id || '—'} · {loc('الكمية', 'Quantity')}: {a.qty} · {loc('المرتجع', 'Returned')}: {a.returned_qty ?? 0}</p>)}</details>
      <details><summary>{loc('سجل تعديل التكلفة', 'Cost adjustment history')} ({history.length})</summary>{history.map((a) => <div className="inventory-line my-2" key={a.adjustment_id ?? a.id}><strong>{a.adjustment_day}</strong><dl className="inventory-review mt-2"><div><dt>{loc('السابقة', 'Previous')}</dt><dd>{money(a.old_unit_cost_iqd ?? (a.new_unit_cost_iqd === undefined ? null : a.new_unit_cost_iqd - a.unit_delta_iqd))}</dd></div><div><dt>{loc('الجديدة', 'New')}</dt><dd>{money(a.new_unit_cost_iqd)}</dd></div></dl></div>)}{!history.length && <p className={`my-2 text-sm ${T.text3}`}>{loc('لا توجد تعديلات تكلفة', 'No cost adjustments')}</p>}</details>
    </Card>}
  </div>;
}
