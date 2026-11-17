import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useOptionalAuth } from '../../AuthContext';
import StockSelection from './StockSelection';
import LotCountForm from '../adminInventory/LotCountForm';
import LotScanner from '../adminInventory/LotScanner';
import LotUnitPicker, { type PieceSelection } from '../adminInventory/LotUnitPicker';
import '../adminInventory/inventory-workspace.css';
import {
  api,
  Card,
  Cell,
  DataTable,
  Input,
  money,
  nameOf,
  Select,
  STOCK,
  T,
  Tabs,
  useLabels,
  useOperation,
  type Named,
  type Selection,
} from './shared';
type Lot = {
  id: string;
  product_id: string;
  qty_remaining: number;
  unit_cost_iqd?: number | null;
  name: string;
  name_ar: string;
  location_id: string | null;
  location_name: string | null;
};
type Count = { id: string; name: string; status: string; lines: number };
type CountLine = Selection & { counted_qty: number; note: string };
type ReturnUnitOrigin = {
  origin_id: string | null; allocation_id: string; order_item_id: string; unit_index: number;
  unit_id: string | null; lot_id: string; purchase_name: string; purchase_id: string;
  supplier_order_no: string; tracking_no: string; serial_norm: string | null; claimed: number;
};
const returnUnitKey = (unit: ReturnUnitOrigin) => unit.origin_id ?? unit.unit_id ?? '';
type Health = {
  product_id: string;
  scope: string;
  scope_id: string;
  name: string;
  name_ar: string;
  stock: number;
  reserved: number;
  available: number;
  lot_units: number;
  discrepancy: number;
  /** A −n row whose write-off would reach an investor-funded lot: fixed by «جرد الدفعة» only. */
  needs_lot_count?: boolean;
  incoming: number;
  recommended_purchase: number;
  cover_days: number | null;
  oldest: string;
  sold_30d: number;
  reorder_point: number;
  lead_time_days: number;
};
type HealthSummary = { rows_total: number; rows_differ: number; units_without_lots: number; lot_units_not_on_shelf: number };
export default function StockOperationsPanel({ onChanged, initialTab }: { onChanged: () => void; initialTab?: 'counts' | 'locations' }) {
  const { loc } = useLabels(),
    op = useOperation(),
    // Fixing a difference books cost: the owner's alone (fail closed).
    canFix = useOptionalAuth()?.user?.can_view_cost === true;
  const [tab, setTab] = useState(initialTab ?? 'health'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [returnCase, setReturnCase] = useState(''),
    [returnCases, setReturnCases] = useState<
      Array<{ id: string; order_id: string; order_item_id: string; name_snapshot: string; qty: number; unit_id?: string | null }>
    >([]),
    [returnAllocations, setReturnAllocations] = useState<Array<{ id: string; order_item_id: string; lot_id: string; qty: number; claimed: number; label?: string }>>([]),
    [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({}),
    [returnUnitOrigins, setReturnUnitOrigins] = useState<ReturnUnitOrigin[]>([]),
    [selectedReturnUnits, setSelectedReturnUnits] = useState<string[]>([]),
    [trace, setTrace] = useState<
      Array<{
        serial_norm: string;
        lot_id: string;
        model_name: string;
        purchase_id: string;
        invoice_no: string;
        order_id: string;
        warranty_end_at: string;
        location_name: string;
      }>
    >([]),
    [health, setHealth] = useState<Health[]>([]),
    [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null),
    [onlyDiff, setOnlyDiff] = useState(false),
    [locations, setLocations] = useState<Named[]>([]),
    [lots, setLots] = useState<Lot[]>([]),
    [counts, setCounts] = useState<Count[]>([]),
    [countDetails, setCountDetails] = useState<{
      count: Count;
      lines: Array<{ id: string; name: string; expected_qty: number; counted_qty: number; note: string }>;
    } | null>(null),
    [name, setName] = useState(''),
    [parent, setParent] = useState(''),
    [kind, setKind] = useState('warehouse'),
    [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [qty, setQty] = useState(1),
    [transferId, setTransferId] = useState(() => crypto.randomUUID()),
    [transferPieces, setTransferPieces] = useState<PieceSelection>({ required: false, valid: true, ids: [] }),
    [countId, setCountId] = useState(() => crypto.randomUUID()),
    [countName, setCountName] = useState(''),
    [countLines, setCountLines] = useState<CountLine[]>([]),
    [choice, setChoice] = useState<Selection | null>(null),
    [serial, setSerial] = useState(''),
    [item, setItem] = useState(''),
    [disposition, setDisposition] = useState('quarantine'),
    [returnId, setReturnId] = useState(() => crypto.randomUUID()),
    [note, setNote] = useState(''),
    [reorder, setReorder] = useState<Health | null>(null),
    [point, setPoint] = useState(0),
    [lead, setLead] = useState(7);
  const load = useCallback(async () => {
    if (tab === 'health') {
      const r = await api.get<{ rows: Health[]; summary?: HealthSummary }>(
        `${STOCK}/health?q=${encodeURIComponent(search)}&offset=${offset}${onlyDiff ? '&only_diff=1' : ''}`,
      );
      setHealth(r.rows);
      setHealthSummary(r.summary ?? null);
    } else if (tab === 'counts') {
      const [countRows, locationRows] = await Promise.all([api.get<{ counts: Count[] }>(`${STOCK}/counts`), api.get<{ lots: Lot[] }>(`${STOCK}/locations?q=${encodeURIComponent(search)}&offset=${offset}`)]);
      setCounts(countRows.counts);
      setLots(locationRows.lots);
    } else if (tab === 'serials') {
      const r = await api.get<{ returns: typeof returnCases; return_allocations?: typeof returnAllocations; return_unit_origins?: ReturnUnitOrigin[]; links: typeof trace; lots: Lot[] }>(
        `${STOCK}/trace?q=${encodeURIComponent(search)}&offset=${offset}`,
      );
      setLots(r.lots);
      setReturnCases(r.returns);
      setReturnAllocations(r.return_allocations ?? []);
      setReturnUnitOrigins(r.return_unit_origins ?? []);
      setTrace(r.links);
    } else {
      const r = await api.get<{ locations: Named[]; lots: Lot[] }>(
        `${STOCK}/locations?q=${encodeURIComponent(search)}&offset=${offset}`,
      );
      setLocations(r.locations);
      setLots(r.lots);
    }
  }, [tab, search, offset, onlyDiff]);
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  const refresh = async () => {
    await load();
    onChanged();
  };
  const selectedReturn = returnCases.find((r) => r.id === returnCase);
  const returnOrigins = returnAllocations.filter((a) => a.order_item_id === selectedReturn?.order_item_id);
  const returnUnits = returnUnitOrigins.filter((u) => u.order_item_id === selectedReturn?.order_item_id && (!selectedReturn.unit_id || u.unit_id === selectedReturn.unit_id));
  const chosenReturnUnits = returnUnits.filter((u) => selectedReturnUnits.includes(returnUnitKey(u)));
  const returnEvidence = returnOrigins.map((a) => ({ allocation_id: a.id, qty: returnUnits.length ? chosenReturnUnits.filter((u) => u.allocation_id === a.id).length : returnOrigins.length === 1 ? selectedReturn?.qty ?? 0 : returnQuantities[a.id] ?? 0 })).filter((a) => a.qty > 0);
  const returnValid = returnUnits.length > 0
    ? chosenReturnUnits.length === selectedReturn?.qty && chosenReturnUnits.every((u) => !u.claimed) && (chosenReturnUnits.every((u) => u.unit_id) || chosenReturnUnits.every((u) => u.origin_id))
    : returnOrigins.length === 0 || (returnEvidence.reduce((n, a) => n + a.qty, 0) === selectedReturn?.qty && returnOrigins.every((a) => { const n = returnOrigins.length === 1 ? selectedReturn?.qty ?? 0 : returnQuantities[a.id] ?? 0; return Number.isSafeInteger(n) && n >= 0 && n <= Math.max(0, a.qty - a.claimed); }));
  return (
    <div className="inventory-workspace">
      {op.feedback}
      <Tabs
        value={tab}
        onChange={(v) => {
          setTab(v);
          setOffset(0);
        }}
        items={[
          { id: 'health', name: loc('المطابقة وإعادة الطلب', 'Reconciliation and reorder', 'بەراوردکردن و داواکردنەوە') },
          { id: 'locations', name: loc('المستودعات والنقل', 'Warehouses and transfers') },
          { id: 'counts', name: loc('جلسات الجرد', 'Count sessions') },
          { id: 'serials', name: loc('الأجهزة والمرتجعات', 'Serials and returns') },
        ]}
      />
      {['health', 'locations', 'serials', 'counts'].includes(tab) && (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <Input
            label={loc('بحث بالاسم أو SKU أو الدفعة', 'Search name, SKU or lot')}
            value={search}
            onChange={(v) => {
              setSearch(v);
              setOffset(0);
            }}
          />
          <button
            type="button"
            className={T.btnGhost}
            disabled={op.busy || !offset}
            onClick={() => setOffset((o) => Math.max(0, o - 200))}
          >
            {loc('السابق', 'Previous')}
          </button>
          <button
            type="button"
            className={T.btnGhost}
            disabled={op.busy || (tab === 'health' ? health : lots).length < 200}
            onClick={() => setOffset((o) => o + 200)}
          >
            {loc('التالي', 'Next')}
          </button>
        </div>
      )}
      <button
        type="button"
        className={`${T.btnSecondary} mb-4`}
        disabled={op.busy}
        onClick={() => op.run(load)}
      >
        {loc('تحديث', 'Refresh')}
      </button>
      {tab === 'health' && (
        <>
          <StockAccuracyCard
            canFix={canFix}
            rows={health}
            summary={healthSummary}
            onlyDiff={onlyDiff}
            onOnlyDiff={(v) => {
              setOnlyDiff(v);
              setOffset(0);
            }}
            search={search}
            busy={op.busy}
            run={op.run}
            reload={load}
            onReorder={(r) => {
              setReorder(r);
              setPoint(r.reorder_point);
              setLead(r.lead_time_days);
            }}
          />
          {reorder && (
            <Card title={reorder.name_ar || reorder.name}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label={loc('حد إعادة الطلب', 'Reorder point', 'سنووری داواکردنەوە')}
                  type="number"
                  value={point}
                  onChange={(v) => setPoint(Number(v))}
                />
                <Input
                  label={loc('مهلة التوريد بالأيام', 'Lead time days', 'ماوەی گەیاندن بە ڕۆژ')}
                  type="number"
                  value={lead}
                  onChange={(v) => setLead(Number(v))}
                />
                <button
                  type="button"
                  className={`${T.btnPrimary} self-end`}
                  disabled={op.busy}
                  onClick={() =>
                    op.run(
                      async () => {
                        await api.post(`${STOCK}/reorder`, {
                          ...reorder,
                          reorder_point: point,
                          lead_time_days: lead,
                        });
                        setReorder(null);
                        await load();
                      },
                      loc('تم حفظ خطة التوريد', 'Replenishment saved', 'پلانی دابینکردن پاشەکەوت کرا'),
                    )
                  }
                >
                  {loc('حفظ', 'Save', 'پاشەکەوتکردن')}
                </button>
              </div>
            </Card>
          )}
        </>
      )}
      {tab === 'locations' && (
        <>
          <details className="mb-4"><summary>{loc('إدارة المستودعات والرفوف', 'Manage warehouses and shelves')}</summary><Card title={loc('إضافة مستودع أو رف أو حجر', 'Add warehouse, shelf or quarantine location')}>
            <div className="grid gap-3 sm:grid-cols-4">
              <Input label={loc('الاسم', 'Name')} value={name} onChange={setName} />
              <Select
                label={loc('النوع', 'Type')}
                value={kind}
                onChange={setKind}
                options={[
                  { id: 'warehouse', name: loc('مستودع', 'Warehouse') },
                  { id: 'shelf', name: loc('رف', 'Shelf') },
                  { id: 'quarantine', name: loc('حجر وفحص', 'Quarantine') },
                ]}
              />
              <Select
                label={loc('يتبع موقعًا', 'Parent location')}
                value={parent}
                onChange={setParent}
                empty={loc('موقع مستقل', 'Standalone')}
                options={locations.map((x) => ({ id: x.id, name: nameOf(x) }))}
              />
              <button
                type="button"
                className={`${T.btnPrimary} self-end`}
                disabled={op.busy || !name}
                onClick={() =>
                  op.run(
                    async () => {
                      await api.post(`${STOCK}/locations?q=${encodeURIComponent(search)}&offset=${offset}`, {
                        name,
                        kind,
                        parent_id: parent,
                      });
                      setName('');
                      await refresh();
                    },
                    loc('تمت إضافة الموقع', 'Location added'),
                  )
                }
              >
                {loc('إضافة', 'Add')}
              </button>
            </div>
          </Card></details>
          <Card title={loc('نقل دفعة أو جزء منها', 'Transfer a lot or part of a lot')}>
            <LotScanner onScanned={(result) => { if (result.lot) { const l = result.lot; if (!lots.some((v) => v.id === l.id)) setLots((old) => [...old, { id: l.id, product_id: l.product_id ?? '', name: l.name ?? '', name_ar: l.name_ar ?? '', qty_remaining: l.qty_remaining ?? 0, location_id: null, location_name: null }]); setSource(l.id); } }} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Select
                label={loc('الدفعة', 'Lot')}
                value={source}
                onChange={setSource}
                empty={loc('اختر الدفعة', 'Choose lot')}
                options={lots.map((l) => ({
                  id: l.id,
                  name: `${l.name_ar || l.name} · ${l.qty_remaining} · ${l.location_name || loc('غير محدد', 'Unassigned')} · ${l.id.slice(-6)}`,
                }))}
              />
              <Select
                label={loc('الموقع الجديد', 'New location')}
                value={target}
                onChange={setTarget}
                empty={loc('اختر الموقع', 'Choose location')}
                options={locations.map((x) => ({ id: x.id, name: nameOf(x) }))}
              />
              <Input
                label={loc('الكمية', 'Quantity')}
                type="number"
                value={qty}
                onChange={(v) => setQty(Number(v))}
              />
            </div>
            <p className={`my-3 text-xs ${T.text3}`}>
              {loc(
                'النقل يحافظ على التكلفة وتاريخ FIFO. الدفعات المرتبطة بأرقام أجهزة تُنقل كاملة.',
                'Transfers preserve cost and FIFO age. Lots linked to device serials move as a whole.',
              )}
            </p>
            <LotUnitPicker lotId={source} qty={qty} mode="move" onChange={setTransferPieces} />
            <button
              type="button"
              className={T.btnPrimary}
              disabled={op.busy || !source || !target || !Number.isSafeInteger(qty) || qty < 1 || qty > (lots.find((l) => l.id === source)?.qty_remaining ?? 0) || !transferPieces.valid}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${STOCK}/transfers`, {
                      operation_id: transferId,
                      lot_id: source,
                      location_id: target,
                      qty,
                      note,
                      ...(transferPieces.required ? { unit_origin_ids: transferPieces.ids } : {}),
                    });
                    setTransferId(crypto.randomUUID());
                    setSource('');
                    await refresh();
                  },
                  loc('تم النقل', 'Transferred'),
                )
              }
            >
              {loc('تنفيذ النقل', 'Transfer')}
            </button>
          </Card>
          <Card title={loc('الدفعات ومواقعها', 'Lots and locations')}>
            <DataTable
              headers={[
                loc('المنتج / الدفعة', 'Product / lot'),
                loc('الموقع', 'Location'),
                loc('المتبقي', 'Remaining'),
                loc('تكلفة الوحدة', 'Unit cost'),
              ]}
            >
              {lots.map((l) => (
                <tr key={l.id}>
                  <Cell>
                    {l.name_ar || l.name}
                    <small className="block">{l.id}</small>
                  </Cell>
                  <Cell>{l.location_name || loc('غير محدد', 'Unassigned')}</Cell>
                  <Cell>{l.qty_remaining}</Cell>
                  <Cell>{money(l.unit_cost_iqd)}</Cell>
                </tr>
              ))}
            </DataTable>
          </Card>
        </>
      )}
      {tab === 'counts' && (
        <>
          <Card title={loc('جرد دفعة محددة', 'Count a specific lot')}><LotCountForm lots={lots} onChanged={refresh} /></Card>
          <details className="mb-4"><summary>{loc('جرد شامل لعدة منتجات', 'Consolidated count for multiple items')}</summary><Card title={loc('إنشاء جرد شامل للمخزون', 'Create consolidated stock count')}>
            <p className={`mb-3 text-xs ${T.text3}`}>
              {loc(
                'أدخل إجمالي الكمية الفعلية للنسخة في جميع المستودعات والرفوف. نقل الدفعات بين المواقع لا يغيّر هذا الإجمالي.',
                'Enter the physical total across all warehouses and shelves. Moving lots between locations does not change this total.',
              )}
            </p>
            <Input label={loc('اسم الجرد', 'Count name')} value={countName} onChange={setCountName} />
            <div className="my-4 max-w-2xl">
              <StockSelection value={choice} onChange={setChoice} />
              <button
                type="button"
                className={`${T.btnSecondary} mt-3`}
                disabled={!choice || choice.stock === null}
                onClick={() => {
                  if (
                    countLines.some(
                      (l) => l.product_id === choice.product_id && l.scope_id === choice.scope_id,
                    )
                  )
                    return;
                  setCountLines((a) => [...a, { ...choice, counted_qty: choice.stock, note: '' }]);
                  setChoice(null);
                }}
              >
                {loc('إضافة للجرد', 'Add to count')}
              </button>
            </div>
            <DataTable
              headers={[
                loc('المنتج', 'Product'),
                loc('المتوقع', 'Expected'),
                loc('المعدود فعليًا', 'Counted'),
                loc('سبب الفرق', 'Discrepancy note'),
                '',
              ]}
            >
              {countLines.map((l, i) => (
                <tr key={i}>
                  <Cell>{l.label}</Cell>
                  <Cell>{l.stock}</Cell>
                  <Cell>
                    <input
                      aria-label={loc('المعدود', 'Counted')}
                      type="number"
                      min="0"
                      className={T.input}
                      value={l.counted_qty}
                      onChange={(e) =>
                        setCountLines((a) =>
                          a.map((x, j) => (j === i ? { ...x, counted_qty: Number(e.target.value) } : x)),
                        )
                      }
                    />
                  </Cell>
                  <Cell>
                    <input
                      aria-label={loc('السبب', 'Reason')}
                      className={T.input}
                      value={l.note}
                      onChange={(e) =>
                        setCountLines((a) => a.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))
                      }
                    />
                  </Cell>
                  <Cell>
                    <button
                      type="button"
                      className={T.btnGhost}
                      onClick={() => setCountLines((a) => a.filter((_, j) => i !== j))}
                    >
                      {loc('حذف', 'Remove')}
                    </button>
                  </Cell>
                </tr>
              ))}
            </DataTable>
            <button
              type="button"
              className={`${T.btnPrimary} mt-3`}
              disabled={op.busy || !countName || !countLines.length}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${STOCK}/counts`, {
                      operation_id: countId,
                      name: countName,
                      lines: countLines,
                    });
                    setCountId(crypto.randomUUID());
                    setCountLines([]);
                    setCountName('');
                    await refresh();
                  },
                  loc('تم حفظ مسودة الجرد', 'Count draft saved'),
                )
              }
            >
              {loc('حفظ الجرد للمراجعة', 'Save count for review')}
            </button>
          </Card></details>
          <Card title={loc('الجرد المحفوظ', 'Saved counts')}>
            <DataTable headers={[loc('الاسم', 'Name'), loc('الحالة', 'Status'), loc('البنود', 'Lines'), '']}>
              {counts.map((c) => (
                <tr key={c.id}>
                  <Cell>{c.name}</Cell>
                  <Cell>
                    {c.status === 'posted'
                      ? loc('مثبت', 'Posted')
                      : c.status === 'cancelled'
                        ? loc('ملغى', 'Cancelled')
                        : loc('مسودة', 'Draft')}
                  </Cell>
                  <Cell>{c.lines}</Cell>
                  <Cell>
                    <button
                      type="button"
                      className={T.btnSecondary}
                      onClick={() =>
                        op.run(async () => setCountDetails(await api.get(`${STOCK}/counts/${c.id}`)))
                      }
                    >
                      {loc('مراجعة', 'Review')}
                    </button>
                    {c.status === 'draft' && (
                      <button
                        type="button"
                        className={T.btnGhost}
                        disabled={op.busy}
                        onClick={() =>
                          op.run(async () => {
                            await api.post(`${STOCK}/counts/${c.id}/cancel`, {});
                            setCountDetails(null);
                            await load();
                          })
                        }
                      >
                        {loc('إلغاء المسودة', 'Cancel draft')}
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
            </DataTable>
          </Card>
          {countDetails && (
            <Card title={countDetails.count.name}>
              <DataTable
                headers={[
                  loc('المنتج', 'Product'),
                  loc('المتوقع', 'Expected'),
                  loc('المعدود', 'Counted'),
                  loc('الفرق', 'Difference'),
                ]}
              >
                {countDetails.lines.map((l) => (
                  <tr key={l.id}>
                    <Cell>{l.name}</Cell>
                    <Cell>{l.expected_qty}</Cell>
                    <Cell>{l.counted_qty}</Cell>
                    <Cell>{l.counted_qty - l.expected_qty}</Cell>
                  </tr>
                ))}
              </DataTable>
              {countDetails.count.status === 'draft' && (
                <button
                  type="button"
                  className={`${T.btnPrimary} mt-3`}
                  disabled={op.busy}
                  onClick={() =>
                    op.run(
                      async () => {
                        const r = await api.post<{ unknown_cost_lines?: number }>(
                          `${STOCK}/counts/${countDetails.count.id}/post`,
                          {},
                        );
                        setCountDetails(null);
                        await refresh();
                        if (r.unknown_cost_lines)
                          op.setError(
                            loc(
                              'تم تثبيت الكميات، مع بنود غير مسعرة تحتاج مراجعة مالية',
                              'Quantities posted; some unpriced lines need financial review',
                            ),
                          );
                      },
                      loc('تم تثبيت الجرد', 'Count posted'),
                    )
                  }
                >
                  {loc('تثبيت فروقات الجرد', 'Post count differences')}
                </button>
              )}
            </Card>
          )}
        </>
      )}
      {tab === 'serials' && (
        <>
          <Card
            title={loc('ربط رقم الجهاز بدفعة الشراء والطلب', 'Link device serial to purchase lot and order')}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label={loc('الرقم التسلسلي المسجل', 'Registered serial number')}
                value={serial}
                onChange={setSerial}
              />
              <Select
                label={loc('دفعة الشراء', 'Purchase lot')}
                value={source}
                onChange={setSource}
                empty={loc('اختر دفعة', 'Choose lot')}
                options={lots.map((l) => ({ id: l.id, name: `${l.name_ar || l.name} · ${l.id.slice(-8)}` }))}
              />
              <Input
                label={loc('بند الطلب (اختياري)', 'Order item (optional)')}
                value={item}
                onChange={setItem}
              />
            </div>
            <button
              type="button"
              className={`${T.btnPrimary} mt-3`}
              disabled={op.busy || !serial || !source}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${STOCK}/serial-link`, {
                      serial_norm: serial,
                      lot_id: source,
                      order_item_id: item,
                    });
                    setSerial('');
                  },
                  loc('تم الربط', 'Linked'),
                )
              }
            >
              {loc('ربط الجهاز', 'Link device')}
            </button>
          </Card>
          <Card title={loc('تتبع الجهاز والضمان', 'Device and warranty trace')}>
            <DataTable
              headers={[
                loc('الجهاز', 'Device'),
                loc('الفاتورة / الدفعة', 'Invoice / lot'),
                loc('الطلب', 'Order'),
                loc('الموقع', 'Location'),
                loc('نهاية الضمان', 'Warranty end'),
              ]}
            >
              {trace.map((t) => (
                <tr key={t.serial_norm}>
                  <Cell>
                    {t.model_name}
                    <small className="block">{t.serial_norm}</small>
                  </Cell>
                  <Cell>
                    {t.invoice_no || t.purchase_id || '—'}
                    <small className="block">{t.lot_id}</small>
                  </Cell>
                  <Cell>{t.order_id || '—'}</Cell>
                  <Cell>{t.location_name || '—'}</Cell>
                  <Cell>{t.warranty_end_at?.slice(0, 10) || '—'}</Cell>
                </tr>
              ))}
            </DataTable>
          </Card>
          <Card title={loc('فحص المرتجع', 'Return inspection')}>
            <p className={`mb-3 text-xs ${T.text3}`}>
              {loc(
                'سجّل نتيجة الفحص قبل معالجة المرتجع من شاشة المرتجعات. هذه الخطوة لا تكرر رد المال أو زيادة المخزون.',
                'Record inspection before processing the return in Returns. This step does not repeat the refund or inventory restoration.',
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select
                label={loc('حالة المرتجع المفتوحة', 'Open return case')}
                value={returnCase}
                onChange={(v) => { setReturnCase(v); setReturnQuantities({}); setSelectedReturnUnits([]); setReturnId(crypto.randomUUID()); }}
                empty={loc('اختر المرتجع', 'Choose return')}
                options={returnCases.map((r) => ({
                  id: r.id,
                  name: `${r.order_id} · ${r.name_snapshot} · ${r.qty}`,
                }))}
              />
              <Select
                label={loc('نتيجة الفحص', 'Disposition')}
                value={disposition}
                onChange={setDisposition}
                options={[
                  { id: 'restock', name: loc('صالح للإرجاع للمخزون', 'Restock') },
                  { id: 'quarantine', name: loc('حجر وفحص إضافي', 'Quarantine') },
                  { id: 'damage', name: loc('تالف', 'Damaged') },
                ]}
              />
              <Input label={loc('الملاحظات', 'Notes')} value={note} onChange={setNote} />
            </div>
            {returnUnits.length > 0 ? <div className="inventory-line mt-4">
              <h4 className={`mb-2 font-semibold ${T.text1}`}>{loc('القطع المرتجعة بالتحديد', 'Exact returned pieces', 'پارچە گەڕاوەکان بە وردی')}</h4>
              <p className={`mb-3 text-sm ${T.text3}`}>{loc('طابق الرقم الداخلي أو التسلسلي ومعلومات المورد مع القطعة المستلمة. بيانات المورد داخلية للأدمن فقط.', 'Match the internal ID or serial and supplier details with the received piece. Supplier details are private to admins.', 'ژمارەی ناوخۆیی یان زنجیرەیی و زانیاریی دابینکەر لەگەڵ ئەو پارچەیەی وەرگیراوە بگونجێنە. زانیاریی دابینکەر تەنها بۆ بەڕێوەبەرانە.')}</p>
              <div className="grid gap-2">
                {returnUnits.map((u) => {
                  const key = returnUnitKey(u), checked = selectedReturnUnits.includes(key);
                  return <label key={key} className={`flex items-start gap-3 rounded-xl border border-current/10 p-3 ${u.claimed ? 'opacity-50' : ''}`}>
                    <input type="checkbox" className="mt-1" checked={checked} disabled={!!u.claimed || (!checked && chosenReturnUnits.length >= (selectedReturn?.qty ?? 0))}
                      onChange={(event) => setSelectedReturnUnits((old) => event.target.checked ? [...old, key] : old.filter((id) => id !== key))}
                      aria-label={`${loc('قطعة', 'Piece', 'پارچە')} ${u.unit_index} · ${key}`} />
                    <span className="min-w-0 flex-1 space-y-1 text-sm">
                      <strong className={`block ${T.text1}`}>{loc('قطعة', 'Piece', 'پارچە')} {u.unit_index}{u.serial_norm ? ` · ${u.serial_norm}` : ''}{u.claimed ? ` · ${loc('محددة في مرتجع آخر', 'Claimed by another return', 'لە گەڕاندنەوەیەکی تردا دیاریکراوە')}` : ''}</strong>
                      <span className={`block break-all ${T.text2}`}>{loc('الرقم الداخلي', 'Internal ID', 'ژمارەی ناوخۆیی')}: {key}</span>
                      <span className={`block break-all ${T.text2}`}>{loc('الدفعة', 'Lot', 'وەجبە')}: {u.lot_id} · {u.purchase_name || u.purchase_id || loc('شراء قديم', 'Historical purchase', 'کڕینی کۆن')}</span>
                      <span className={`block break-all ${T.text3}`}>{loc('طلب المورد', 'Supplier order', 'داواکاریی دابینکەر')}: {u.supplier_order_no || loc('غير موثق', 'Not recorded', 'تۆمار نەکراوە')} · {loc('التتبع', 'Tracking', 'بەدواداچوون')}: {u.tracking_no || loc('غير موثق', 'Not recorded', 'تۆمار نەکراوە')}</span>
                    </span>
                  </label>;
                })}
              </div>
              <p className={`mt-3 text-sm ${T.text2}`}>{loc('المحدد / المطلوب', 'Selected / required', 'هەڵبژێردراو / پێویست')}: {chosenReturnUnits.length} / {selectedReturn?.qty}</p>
            </div> : returnOrigins.length > 0 && <div className="inventory-line mt-4">
              <h4 className={`mb-3 font-semibold ${T.text1}`}>{loc('مصدر القطع المرتجعة', 'Origin of returned units')}</h4>
              {returnOrigins.length > 1 ? <>
                <p className={`mb-3 text-sm ${T.text3}`}>{loc(`حدد دفعات القطع ${selectedReturn?.qty ?? 0} المرتجعة حتى تُسوّى تكلفة ومستثمر كل قطعة بدقة.`, `Select the origin of all ${selectedReturn?.qty ?? 0} returned units so each unit’s cost and investor are settled accurately.`)}</p>
                <LotScanner orderItemId={selectedReturn?.order_item_id} onScanned={(r) => { const a = returnOrigins.find((v) => v.lot_id === r.lot?.id); if (!a) throw new Error(loc('الدفعة ليست من أصل هذا المرتجع', 'This lot is not an origin of this return')); setReturnQuantities((old) => ({ ...old, [a.id]: Math.min(Math.max(0, a.qty - a.claimed), (old[a.id] ?? 0) + 1) })); }} />
                <div className="inventory-fields">{returnOrigins.map((a) => <Input key={a.id} label={a.label || `${loc('دفعة', 'Lot')} · ${a.lot_id.slice(-8)}`} type="number" min={0} value={returnQuantities[a.id] ?? 0} onChange={(v) => setReturnQuantities((old) => ({ ...old, [a.id]: Number(v) }))} hint={`${loc('المتاح للإرجاع', 'Available to return')}: ${Math.max(0, a.qty - a.claimed)}`} />)}</div>
                <p className={`mt-3 text-sm ${T.text2}`}>{loc('المحدد / المطلوب', 'Selected / required')}: {returnEvidence.reduce((n, a) => n + a.qty, 0)} / {selectedReturn?.qty}</p>
              </> : <p className={`text-sm ${T.text2}`}>{returnOrigins[0].label || `${loc('دفعة', 'Lot')} · ${returnOrigins[0].lot_id.slice(-8)}`} · {loc('الكمية', 'Quantity')}: {selectedReturn?.qty}</p>}
            </div>}
            <button
              type="button"
              className={`${T.btnPrimary} mt-3`}
              disabled={op.busy || !returnCase || !returnValid}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${STOCK}/return-inspections`, {
                      operation_id: returnId,
                      return_case_id: returnCase,
                      disposition,
                      note,
                      ...(returnOrigins.length > 0 ? { allocations: returnEvidence } : {}),
                      ...(returnUnits.length > 0 ? {
                        inventory_origin_ids: chosenReturnUnits.flatMap((u) => u.origin_id ? [u.origin_id] : []),
                        ...(chosenReturnUnits.every((u) => u.unit_id) ? { unit_ids: chosenReturnUnits.map((u) => u.unit_id!) } : {}),
                      } : {}),
                    });
                    setReturnId(crypto.randomUUID());
                    setReturnCase('');
                    setSelectedReturnUnits([]);
                    await load();
                  },
                  loc('تم حفظ الفحص', 'Inspection saved'),
                )
              }
            >
              {loc('حفظ نتيجة الفحص', 'Save inspection')}
            </button>
          </Card>
        </>
      )}
    </div>
  );
}

/** How many fixes one request carries (the route's RECONCILE_BATCH_MAX). */
const RECONCILE_CHUNK = 25;
const identityOf = (r: Pick<Health, 'product_id' | 'scope' | 'scope_id'>) => `${r.product_id}:${r.scope}:${r.scope_id}`;
/** A signed difference with a real minus sign: «+3», «−2», «0». */
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const diffTone = (n: number) =>
  n > 0
    ? 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]'
    : n < 0
      ? 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]'
      : 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]';

/**
 * «دقة المخزون وخطة الشراء». The Difference is the shelf counter minus the
 * units in FIFO cost batches. «تصحيح» brings the batches to the shelf — never
 * the shelf to the batches — so what the shop sells does not move
 * (worker/lib/stockReconcile.ts). Every fix is confirmed inline first, with
 * the list of what will change.
 */
function StockAccuracyCard({
  canFix,
  rows,
  summary,
  onlyDiff,
  onOnlyDiff,
  search,
  busy,
  run,
  reload,
  onReorder,
}: {
  canFix: boolean;
  rows: Health[];
  summary: HealthSummary | null;
  onlyDiff: boolean;
  onOnlyDiff: (v: boolean) => void;
  search: string;
  busy: boolean;
  run: (work: () => Promise<unknown>, success?: string) => Promise<boolean>;
  reload: () => Promise<void>;
  onReorder: (r: Health) => void;
}) {
  const { loc } = useLabels();
  const [pending, setPending] = useState<{ rows: Health[]; operation: string } | null>(null);
  const differing = rows.filter((r) => Number(r.discrepancy) !== 0);
  const plus = summary?.units_without_lots ?? 0,
    minus = summary?.lot_units_not_on_shelf ?? 0,
    differ = summary?.rows_differ ?? differing.length;
  const nameOfRow = (r: Health) => r.name_ar || r.name || r.product_id;
  const scopeLabel = (r: Health) =>
    r.scope === 'base'
      ? ''
      : r.scope === 'option'
        ? loc('خيار', 'Option', 'هەڵبژاردە')
        : r.scope === 'color'
          ? loc('لون', 'Colour', 'ڕەنگ')
          : loc('تركيبة', 'Combination', 'تێکەڵە');
  const effect = (r: Health) =>
    r.discrepancy > 0
      ? loc(
          `فتح دفعة من ${r.discrepancy} وحدة بتكلفة غير معروفة`,
          `open a batch of ${r.discrepancy} units at unknown cost`,
          `کردنەوەی وەجبەیەکی ${r.discrepancy} یەکە بە تێچووی نەزانراو`,
        )
      : loc(
          `إخراج ${Math.abs(r.discrepancy)} وحدة من أقدم الدفعات`,
          `remove ${Math.abs(r.discrepancy)} units from the oldest batches`,
          `دەرکردنی ${Math.abs(r.discrepancy)} یەکە لە کۆنترین وەجبەکان`,
        );

  /** Every differing row for the current search, across all pages — «fix all» means all. */
  const allDiffering = async () => {
    const out: Health[] = [];
    for (let offset = 0; offset < 100000; offset += 200) {
      const r = await api.get<{ rows: Health[] }>(`${STOCK}/health?q=${encodeURIComponent(search)}&offset=${offset}&only_diff=1`);
      out.push(...r.rows.filter((x) => Number(x.discrepancy) !== 0));
      if (r.rows.length < 200) break;
    }
    return out;
  };
  const ask = (list: Health[]) => {
    if (list.length) setPending({ rows: list, operation: crypto.randomUUID() });
  };
  const lotCountLabel = loc('يحتاج جرد الدفعة', 'Needs a lot count', 'پێویستی بە ژماردنی وەجبەیە');
  const apply = () => {
    if (!pending) return;
    const { operation } = pending;
    // Rows that reach an investor-funded lot are never sent: «جرد الدفعة» posts the investor's loss.
    const list = pending.rows.filter((r) => !r.needs_lot_count);
    const skipped = pending.rows.length - list.length;
    const skippedNote = skipped
      ? loc(
          ` — تُرك ${skipped} بند يحتاج «جرد الدفعة»`,
          ` — ${skipped} left for a lot count`,
          ` — ${skipped} ڕیز بۆ «ژماردنی وەجبە» جێهێڵدرا`,
        )
      : '';
    if (!list.length) return;
    void run(async () => {
      let done = 0;
      try {
        for (let i = 0; i < list.length; i += RECONCILE_CHUNK) {
          const chunk = list.slice(i, i + RECONCILE_CHUNK);
          await api.post(`${STOCK}/reconcile`, {
            // One id per chunk, stable across a retry of the same confirmation: a replay writes nothing twice.
            operation_id: `${operation}-${i / RECONCILE_CHUNK}`,
            rows: chunk.map((r) => ({ product_id: r.product_id, scope: r.scope, scope_id: r.scope_id, stock: r.stock, lot_units: r.lot_units })),
          });
          done += chunk.length;
        }
      } catch (e) {
        await reload().catch(() => undefined);
        if (done > 0) setPending(null);
        if (e instanceof ApiError && e.code === 'STOCK_CHANGED')
          throw new Error(
            loc(
              `تغيّر المخزون أثناء التصحيح؛ صُحّح ${done} من ${list.length}. حُدّثت القائمة — راجعها وأعد المحاولة.`,
              `Stock changed while fixing; ${done} of ${list.length} fixed. The list is refreshed — check it and try again.`,
              `کۆگا لە کاتی چاککردندا گۆڕا؛ ${done} لە ${list.length} چاک کران. لیستەکە نوێ کرایەوە — بیپشکنە و دووبارە هەوڵ بدەرەوە.`,
            ),
          );
        if (e instanceof ApiError && e.code === 'RECONCILE_INVESTOR_LOT')
          throw new Error(
            loc(
              `صُحّح ${done} من ${list.length}. بند يُخرج وحدات من دفعة ممولة من مستثمر: صحّحه بـ«جرد الدفعة» على تلك الدفعة ليُسجَّل أثره على رأس مال المستثمر.`,
              `${done} of ${list.length} fixed. A row would write off units of an investor-funded batch: correct it with a lot count on that batch so the investor’s capital loss is recorded.`,
              `${done} لە ${list.length} چاک کران. ڕیزێک یەکە لە وەجبەیەک دەردەکات کە وەبەرهێنەر پارەی داوە: بە «ژماردنی وەجبە» لەسەر ئەو وەجبەیە چاکی بکە تا کاریگەرییەکەی لەسەر سەرمایەی وەبەرهێنەر تۆمار بکرێت.`,
            ),
          );
        if (e instanceof ApiError && e.code === 'UNIT_ORIGIN_LOT_COUNT_REQUIRED')
          throw new Error(
            loc(
              `صُحّح ${done} من ${list.length}. دفعة فيها قطع معرّفة بأرقامها: صحّح فرقها من «جرد دفعة محددة» في جلسات الجرد.`,
              `${done} of ${list.length} fixed. A batch holds individually numbered pieces: fix it with «Lot count» under Count sessions.`,
              `${done} لە ${list.length} چاک کران. وەجبەیەک پارچەی ژمارەداری تێدایە: لە «ژماردنی وەجبەیەکی دیاریکراو» لە دانیشتنەکانی ژماردن چاکی بکە.`,
            ),
          );
        throw e;
      }
      setPending(null);
      await reload();
    }, loc(`صُحّحت الفروقات (${list.length})`, `Differences fixed (${list.length})`, `جیاوازییەکان چاک کران (${list.length})`) + skippedNote);
  };

  return (
    <Card title={loc('دقة المخزون وخطة الشراء', 'Stock accuracy and replenishment', 'وردی کۆگا و پلانی کڕین')}>
      {summary && (
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3" aria-live="polite">
          <div className={`${T.surface} p-3`}>
            <div className={`text-xs ${T.text3}`}>{loc('بنود فيها فرق', 'Rows with a difference', 'ڕیزی جیاواز')}</div>
            <div className={`text-lg font-bold ${differ ? 'text-[var(--ap-danger)]' : 'text-[var(--ap-success)]'}`}>
              {differ} <span className={`text-xs font-normal ${T.text3}`}>/ {summary.rows_total}</span>
            </div>
          </div>
          <div className={`${T.surface} p-3`}>
            <div className={`text-xs ${T.text3}`}>{loc('على الرف بلا دفعة تكلفة', 'On the shelf, no cost batch', 'لەسەر ڕەف، بێ وەجبەی تێچوو')}</div>
            <div className="text-lg font-bold text-[var(--ap-warning)]">{signed(plus)}</div>
          </div>
          <div className={`${T.surface} p-3`}>
            <div className={`text-xs ${T.text3}`}>{loc('في الدفعات وليست على الرف', 'In batches, not on the shelf', 'لە وەجبەکاندا، لەسەر ڕەف نییە')}</div>
            <div className="text-lg font-bold text-[var(--ap-danger)]">{signed(-minus)}</div>
          </div>
        </div>
      )}
      <details className={`mb-3 text-xs ${T.text2}`} open={differ > 0}>
        <summary className="cursor-pointer font-semibold">{loc('ما معنى «الفرق»؟', 'What does «Difference» mean?', '«جیاوازی» واتای چییە؟')}</summary>
        <ul className="mt-2 list-disc space-y-1 ps-5">
          <li>
            {loc(
              'الفرق = الكمية على الرف − الوحدات المسجّلة في دفعات التكلفة. الطبيعي أن يكون صفرًا.',
              'Difference = quantity on the shelf − units recorded in cost batches. Normally it is zero.',
              'جیاوازی = بڕی سەر ڕەف − ئەو یەکانەی لە وەجبەکانی تێچوودا تۆمار کراون. بە ئاسایی سفرە.',
            )}
          </li>
          <li>
            <span className="font-bold text-[var(--ap-warning)]">+</span>{' '}
            {loc(
              'موجب: وحدات على الرف بلا دفعة تكلفة (غالبًا أُضيفت من محرر المنتج دون تسجيل شراء)، فتكلفتها غير معروفة.',
              'Positive: shelf units with no cost batch (usually added in the product editor without recording a purchase), so their cost is unknown.',
              'پۆزەتیڤ: یەکەی سەر ڕەف کە وەجبەی تێچوویان نییە (زۆرجار لە دەستکاریکەری بەرهەم زیاد کراون بێ تۆمارکردنی کڕین)، بۆیە تێچوویان نەزانراوە.',
            )}
          </li>
          <li>
            <span className="font-bold text-[var(--ap-danger)]">−</span>{' '}
            {loc(
              'سالب: دفعات ما زالت تحمل وحدات لم تعد على الرف (أُنقصت الكمية دون جرد).',
              'Negative: batches still hold units that are no longer on the shelf (the quantity was lowered without a count).',
              'نێگەتیڤ: وەجبەکان هێشتا ئەو یەکانەیان تێدایە کە ئیتر لەسەر ڕەف نین (بڕەکە بێ ژماردن کەم کراوەتەوە).',
            )}
          </li>
          <li>
            {loc(
              '«تصحيح» يجعل الدفعات تطابق الرف ويسجّل حركة في «الحركات». الكمية المعروضة للبيع لا تتغير. إن كان الرف نفسه خاطئًا فابدأ بجلسة جرد.',
              '«Fix» makes the batches match the shelf and records a movement under «Movements». The quantity on sale does not change. If the shelf itself is wrong, run a count session first.',
              '«چاککردن» وەجبەکان لەگەڵ ڕەف ڕێک دەخات و جووڵەیەک لە «جووڵەکان» تۆمار دەکات. ئەو بڕەی بۆ فرۆشتنە ناگۆڕێت. ئەگەر ڕەفەکە خۆی هەڵەیە، سەرەتا دانیشتنێکی ژماردن بکە.',
            )}
          </li>
        </ul>
      </details>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={T.chip} aria-pressed={onlyDiff} onClick={() => onOnlyDiff(!onlyDiff)}>
          {loc('فقط الفروقات', 'Only differences', 'تەنها جیاوازییەکان')}
        </button>
        {canFix ? (
          <button
            type="button"
            className={T.btnSecondary}
            disabled={busy || differ === 0 || !!pending}
            onClick={() => void run(async () => ask(await allDiffering()))}
          >
            {loc('تصحيح كل الفروقات', 'Fix all differences', 'چاککردنی هەموو جیاوازییەکان')}
          </button>
        ) : (
          <span className={`text-xs ${T.text3}`}>
            {loc('تصحيح الفروقات يقوم به المالك.', 'The owner fixes differences.', 'خاوەنەکە جیاوازییەکان چاک دەکات.')}
          </span>
        )}
      </div>
      {canFix && pending && (
        <div role="region" aria-label={loc('تأكيد التصحيح', 'Confirm the fix', 'پشتڕاستکردنەوەی چاککردن')} className={`${T.surface} mb-3 p-3`}>
          <p className={`mb-2 text-sm font-semibold ${T.text1}`}>
            {loc(
              `سيتغير ${pending.rows.length} بند — الدفعات فقط، والكمية على الرف تبقى كما هي:`,
              `${pending.rows.length} rows will change — batches only; the shelf quantity stays as it is:`,
              `${pending.rows.length} ڕیز دەگۆڕێت — تەنها وەجبەکان؛ بڕی سەر ڕەف وەک خۆی دەمێنێتەوە:`,
            )}
          </p>
          <ul className={`mb-3 max-h-60 space-y-1 overflow-y-auto text-xs ${T.text2}`}>
            {pending.rows.map((r) => (
              <li key={identityOf(r)} className="flex flex-wrap items-center gap-2">
                <span className={`${T.badgeBase} ${diffTone(r.discrepancy)}`}>{signed(r.discrepancy)}</span>
                <span className={`font-medium ${T.text1}`}>{nameOfRow(r)}</span>
                {scopeLabel(r) && <span>({scopeLabel(r)})</span>}
                {r.needs_lot_count ? (
                  <span className={`${T.badgeBase} ${diffTone(-1)}`}>{lotCountLabel}</span>
                ) : (
                  <span>— {effect(r)}</span>
                )}
              </li>
            ))}
          </ul>
          {pending.rows.some((r) => r.needs_lot_count) && (
            <p className={`mb-2 text-xs ${T.text2}`}>
              {loc(
                `${pending.rows.filter((r) => r.needs_lot_count).length} بند يُخرج وحدات من دفعة ممولة من مستثمر فيُترك: صحّحه بـ«جرد الدفعة» على تلك الدفعة (في جلسات الجرد) ليُسجَّل أثره على رأس مال المستثمر.`,
                `${pending.rows.filter((r) => r.needs_lot_count).length} row(s) would write off units of an investor-funded batch and are skipped: correct them with a lot count (under Count sessions) so the investor’s capital loss is recorded.`,
                `${pending.rows.filter((r) => r.needs_lot_count).length} ڕیز یەکە لە وەجبەیەک دەردەکەن کە وەبەرهێنەر پارەی داوە، بۆیە جێدەهێڵدرێن: بە «ژماردنی وەجبە» (لە دانیشتنەکانی ژماردن) چاکیان بکە تا کاریگەرییەکەی لەسەر سەرمایەی وەبەرهێنەر تۆمار بکرێت.`,
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={T.btnPrimary} disabled={busy || pending.rows.every((r) => r.needs_lot_count)} onClick={apply}>
              {loc('تأكيد التصحيح', 'Confirm fix', 'پشتڕاستکردنەوەی چاککردن')}
            </button>
            <button type="button" className={T.btnGhost} disabled={busy} onClick={() => setPending(null)}>
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          </div>
        </div>
      )}
      <p className={`mb-3 text-xs ${T.text3}`}>
        {loc(
          'الشراء المقترح يعتمد مبيعات آخر 30 يومًا، مهلة التوريد، 7 أيام احتياط، حد الطلب، والمخزون القادم. يمكن البحث والتنقل بين صفحات من 200 بند.',
          'Suggestions use 30-day sales, lead time, seven-day safety stock, reorder point and incoming units. Search or page through 200 selections at a time.',
          'کڕینی پێشنیارکراو پشت بە فرۆشی 30 ڕۆژی ڕابردوو، ماوەی گەیاندن، 7 ڕۆژی یەدەگ، سنووری داواکردنەوە و کۆگای داهاتوو دەبەستێت. دەتوانیت بگەڕێیت و لە پەڕەکانی 200 بڕگەیی بگوازیتەوە.',
        )}
      </p>
      {rows.length === 0 ? (
        <p className={`text-sm ${T.text3}`}>
          {onlyDiff
            ? loc('لا فروقات — الدفعات تطابق الرف.', 'No differences — the batches match the shelf.', 'هیچ جیاوازییەک نییە — وەجبەکان لەگەڵ ڕەف یەکدەگرنەوە.')
            : loc('لا توجد بنود مخزون متتبعة.', 'No tracked stock rows.', 'هیچ ڕیزێکی کۆگای بەدواداچوو نییە.')}
        </p>
      ) : (
        <>
          {/* Phones: one card per row, nothing to scroll sideways. */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={identityOf(r)} className={`${T.surface} p-3`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className={`truncate font-medium ${T.text1}`}>{nameOfRow(r)}</div>
                    {scopeLabel(r) && (
                      <div className={`truncate text-xs ${T.text3}`}>
                        {scopeLabel(r)} · {r.scope_id}
                      </div>
                    )}
                  </div>
                  <span className={`${T.badgeBase} ${diffTone(r.discrepancy)}`} title={loc('الفرق', 'Difference', 'جیاوازی')}>
                    {signed(r.discrepancy)}
                  </span>
                </div>
                <dl className={`mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs ${T.text2}`}>
                  <dt>{loc('الرف / الدفعات', 'Shelf / batches', 'ڕەف / وەجبەکان')}</dt>
                  <dd className={T.text1}>
                    {r.stock} / {r.lot_units}
                  </dd>
                  <dt>{loc('المحجوز / المتاح', 'Reserved / available', 'گیراو / بەردەست')}</dt>
                  <dd className={T.text1}>
                    {r.reserved} / {r.available}
                  </dd>
                  <dt>{loc('القادم', 'Incoming', 'داهاتوو')}</dt>
                  <dd className={T.text1}>{r.incoming}</dd>
                  <dt>{loc('تغطية بالأيام', 'Coverage days', 'ڕۆژانی داپۆشین')}</dt>
                  <dd className={T.text1}>{r.cover_days ?? '—'}</dd>
                  <dt>{loc('شراء مقترح', 'Suggested purchase', 'کڕینی پێشنیارکراو')}</dt>
                  <dd className={T.text1}>{r.recommended_purchase}</dd>
                </dl>
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.needs_lot_count ? (
                    <span className={`${T.badgeBase} ${diffTone(-1)}`}>{lotCountLabel}</span>
                  ) : canFix && r.discrepancy !== 0 && (
                    <button type="button" className={T.btnSecondary} disabled={busy || !!pending} onClick={() => ask([r])}>
                      {loc('تصحيح', 'Fix', 'چاککردن')}
                    </button>
                  )}
                  <button type="button" className={T.btnGhost} onClick={() => onReorder(r)}>
                    {loc('ضبط التوريد', 'Set replenishment', 'ڕێکخستنی دابینکردن')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <DataTable
              headers={[
                loc('المنتج', 'Product', 'بەرهەم'),
                loc('الرف / الدفعات', 'Shelf / batches', 'ڕەف / وەجبەکان'),
                loc('المحجوز / المتاح', 'Reserved / available', 'گیراو / بەردەست'),
                loc('الفرق', 'Difference', 'جیاوازی'),
                loc('القادم', 'Incoming', 'داهاتوو'),
                loc('تغطية بالأيام', 'Coverage days', 'ڕۆژانی داپۆشین'),
                loc('شراء مقترح', 'Suggested purchase', 'کڕینی پێشنیارکراو'),
                '',
              ]}
            >
              {rows.map((r) => (
                <tr key={identityOf(r)}>
                  <Cell>
                    {nameOfRow(r)}
                    {scopeLabel(r) && (
                      <small className={`block ${T.text3}`}>
                        {scopeLabel(r)} · {r.scope_id}
                      </small>
                    )}
                  </Cell>
                  <Cell>
                    {r.stock} / {r.lot_units}
                  </Cell>
                  <Cell>
                    {r.reserved} / {r.available}
                  </Cell>
                  <Cell>
                    <span className={`${T.badgeBase} ${diffTone(r.discrepancy)}`}>{signed(r.discrepancy)}</span>
                  </Cell>
                  <Cell>{r.incoming}</Cell>
                  <Cell>{r.cover_days ?? '—'}</Cell>
                  <Cell>{r.recommended_purchase}</Cell>
                  <Cell>
                    <div className="flex flex-wrap gap-1">
                      {r.needs_lot_count ? (
                    <span className={`${T.badgeBase} ${diffTone(-1)}`}>{lotCountLabel}</span>
                  ) : canFix && r.discrepancy !== 0 && (
                        <button type="button" className={T.btnGhost} disabled={busy || !!pending} onClick={() => ask([r])}>
                          {loc('تصحيح', 'Fix', 'چاککردن')}
                        </button>
                      )}
                      <button type="button" className={T.btnGhost} onClick={() => onReorder(r)}>
                        {loc('ضبط التوريد', 'Set replenishment', 'ڕێکخستنی دابینکردن')}
                      </button>
                    </div>
                  </Cell>
                </tr>
              ))}
            </DataTable>
          </div>
        </>
      )}
    </Card>
  );
}
