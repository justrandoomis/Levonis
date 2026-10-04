import { useCallback, useEffect, useState } from 'react';
import StockSelection from './StockSelection';
import LotCountForm from '../adminInventory/LotCountForm';
import LotScanner from '../adminInventory/LotScanner';
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
  incoming: number;
  recommended_purchase: number;
  cover_days: number | null;
  oldest: string;
  sold_30d: number;
  reorder_point: number;
  lead_time_days: number;
};
export default function StockOperationsPanel({ onChanged, initialTab }: { onChanged: () => void; initialTab?: 'counts' | 'locations' }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [tab, setTab] = useState(initialTab ?? 'health'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [returnCase, setReturnCase] = useState(''),
    [returnCases, setReturnCases] = useState<
      Array<{ id: string; order_id: string; order_item_id: string; name_snapshot: string; qty: number }>
    >([]),
    [returnAllocations, setReturnAllocations] = useState<Array<{ id: string; order_item_id: string; lot_id: string; qty: number; claimed: number; label?: string }>>([]),
    [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({}),
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
      const r = await api.get<{ rows: Health[] }>(
        `${STOCK}/health?q=${encodeURIComponent(search)}&offset=${offset}`,
      );
      setHealth(r.rows);
    } else if (tab === 'counts') {
      const [countRows, locationRows] = await Promise.all([api.get<{ counts: Count[] }>(`${STOCK}/counts`), api.get<{ lots: Lot[] }>(`${STOCK}/locations?q=${encodeURIComponent(search)}&offset=${offset}`)]);
      setCounts(countRows.counts);
      setLots(locationRows.lots);
    } else if (tab === 'serials') {
      const r = await api.get<{ returns: typeof returnCases; return_allocations?: typeof returnAllocations; links: typeof trace; lots: Lot[] }>(
        `${STOCK}/trace?q=${encodeURIComponent(search)}&offset=${offset}`,
      );
      setLots(r.lots);
      setReturnCases(r.returns);
      setReturnAllocations(r.return_allocations ?? []);
      setTrace(r.links);
    } else {
      const r = await api.get<{ locations: Named[]; lots: Lot[] }>(
        `${STOCK}/locations?q=${encodeURIComponent(search)}&offset=${offset}`,
      );
      setLocations(r.locations);
      setLots(r.lots);
    }
  }, [tab, search, offset]);
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
  const returnEvidence = returnOrigins.map((a) => ({ allocation_id: a.id, qty: returnOrigins.length === 1 ? selectedReturn?.qty ?? 0 : returnQuantities[a.id] ?? 0 })).filter((a) => a.qty > 0);
  const returnValid = returnOrigins.length === 0 || (returnEvidence.reduce((n, a) => n + a.qty, 0) === selectedReturn?.qty && returnOrigins.every((a) => { const n = returnOrigins.length === 1 ? selectedReturn?.qty ?? 0 : returnQuantities[a.id] ?? 0; return Number.isSafeInteger(n) && n >= 0 && n <= Math.max(0, a.qty - a.claimed); }));
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
          { id: 'health', name: loc('المطابقة وإعادة الطلب', 'Reconciliation and reorder') },
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
          <Card title={loc('دقة المخزون وخطة الشراء', 'Stock accuracy and replenishment')}>
            <p className={`mb-3 text-xs ${T.text3}`}>
              {loc(
                'المقترح يعتمد مبيعات آخر 30 يومًا، مهلة التوريد، 7 أيام احتياط، حد الطلب، والمخزون القادم. يمكن البحث والتنقل بين صفحات من 200 بند.',
                'Suggestions use 30-day sales, lead time, seven-day safety stock, reorder point and incoming units. Search or page through 200 selections at a time.',
              )}
            </p>
            <DataTable
              headers={[
                loc('المنتج', 'Product'),
                loc('فعلي / دفعات', 'Physical / lots'),
                loc('المحجوز / المتاح', 'Reserved / available'),
                loc('الفرق', 'Difference'),
                loc('القادم', 'Incoming'),
                loc('تغطية بالأيام', 'Coverage days'),
                loc('شراء مقترح', 'Suggested purchase'),
                '',
              ]}
            >
              {health.map((r) => (
                <tr key={`${r.product_id}:${r.scope}:${r.scope_id}`}>
                  <Cell>
                    {r.name_ar || r.name}
                    <small className="block">{r.scope_id}</small>
                  </Cell>
                  <Cell>
                    {r.stock} / {r.lot_units}
                  </Cell>
                  <Cell>
                    {r.reserved} / {r.available}
                  </Cell>
                  <Cell>
                    <span className={r.discrepancy ? 'font-bold text-red-600' : ''}>{r.discrepancy}</span>
                  </Cell>
                  <Cell>{r.incoming}</Cell>
                  <Cell>{r.cover_days ?? '—'}</Cell>
                  <Cell>{r.recommended_purchase}</Cell>
                  <Cell>
                    <button
                      type="button"
                      className={T.btnGhost}
                      onClick={() => {
                        setReorder(r);
                        setPoint(r.reorder_point);
                        setLead(r.lead_time_days);
                      }}
                    >
                      {loc('ضبط التوريد', 'Set replenishment')}
                    </button>
                  </Cell>
                </tr>
              ))}
            </DataTable>
          </Card>
          {reorder && (
            <Card title={reorder.name_ar || reorder.name}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label={loc('حد إعادة الطلب', 'Reorder point')}
                  type="number"
                  value={point}
                  onChange={(v) => setPoint(Number(v))}
                />
                <Input
                  label={loc('مهلة التوريد بالأيام', 'Lead time days')}
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
                      loc('تم حفظ خطة التوريد', 'Replenishment saved'),
                    )
                  }
                >
                  {loc('حفظ', 'Save')}
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
            <button
              type="button"
              className={T.btnPrimary}
              disabled={op.busy || !source || !target || !Number.isSafeInteger(qty) || qty < 1 || qty > (lots.find((l) => l.id === source)?.qty_remaining ?? 0)}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${STOCK}/transfers`, {
                      operation_id: transferId,
                      lot_id: source,
                      location_id: target,
                      qty,
                      note,
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
                        const r = await api.post<{ unknown_cost_lines: number }>(
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
                onChange={(v) => { setReturnCase(v); setReturnQuantities({}); setReturnId(crypto.randomUUID()); }}
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
            {returnOrigins.length > 0 && <div className="inventory-line mt-4">
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
                    });
                    setReturnId(crypto.randomUUID());
                    setReturnCase('');
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
