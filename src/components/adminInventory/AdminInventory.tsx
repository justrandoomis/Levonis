/**
 * «إدارة المخزون» — the owner's warehouse, as one screen.
 *
 * ###########################################################################
 * #  ONE PRODUCT'S STOCK MAY CARRY SEVERAL COSTS, AND EVERY SALE CONSUMES   #
 * #  THE OLDEST ONE FIRST.                                                  #
 * ###########################################################################
 *
 * That sentence is the whole feature, and it is printed at the top of the
 * stock tab rather than buried in a help page, because every number on this
 * screen only makes sense once the reader has it. A shop that bought ten units
 * at 450,000 and ten at 560,000 does not hold twenty units worth 11.2 million;
 * it holds twenty units worth 10.1 million, and the next twelve it sells cost
 * exactly 5,620,000.
 *
 * ---------------------------------------------------------------------------
 * Connected stock, procurement, supplier and warehouse operations.
 *
 *   المخزون الحالي   what is on the shelf, and what each layer of it cost
 *   المشتريات القادمة what has been bought and not yet arrived
 *   الحركات          every change, read-only
 *   الموردون         a name to attach to a purchase
 *
 * §32 is explicit that this must not grow a stock TAXONOMY — «جديد»,
 * «مستعمل», «تالف» as though they were kinds of stock. Damage is a REASON for
 * an adjustment, recorded on the movement, and it stays there.
 *
 * ---------------------------------------------------------------------------
 * EVERY ADMIN BUT THE OWNER IS WELCOME HERE AND SEES NO COST.
 *
 * Owner decision 2 (2026-10-07): cost reaches the main admin only — full-scope
 * admins included in the "no". The procurement and lot-report tabs (purchase
 * costs, valuation) show only for `can_view_cost === true` AND a payload that
 * actually carries the valuation; either missing hides them.
 *
 * Unlike the profit screen — which refuses them at the door, because there is
 * no useful non-financial part of a profit report — this one is theirs to use:
 * §52 has them counting units and receiving shipments all day. The server
 * strips every cost from the payload, and the tables respond by dropping the
 * COLUMNS rather than printing a wall of dashes that advertises what is behind
 * them. The summary strip does the same.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { ArrowLeftRight, Boxes, CalendarClock, ClipboardCheck, Layers, PackagePlus, RefreshCw, Truck } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { fetchInventoryOverview, type InventoryOverview } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { Money, Notice, Stat, errMsg, useCount, useLoc, type NoticeState } from './shared';
import { inventoryStrings } from './strings';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { StockTab } from './StockTab';
import { IncomingTab } from './IncomingTab';
import { MovementsTab } from './MovementsTab';
import { SuppliersTab } from './SuppliersTab';
import './inventory-workspace.css';
const ProcurementPanel=lazy(()=>import('../adminOperations/ProcurementPanel'));
const PurchaseReceivePanel=lazy(()=>import('../adminOperations/PurchaseReceivePanel'));
const StockOperationsPanel=lazy(()=>import('../adminOperations/StockOperationsPanel'));
const InventoryLotPanel=lazy(()=>import('./InventoryLotPanel'));

type Tab = 'stock' | 'incoming' | 'movements' | 'suppliers' | 'procurement' | 'receiving' | 'operations' | 'reports';
const TABS: readonly Tab[] = ['stock', 'procurement', 'receiving', 'operations', 'movements', 'reports', 'suppliers', 'incoming'];

/** The tab the address names (`?itab=`), so a reload or a shared link reopens it (owner request 2026-11-03). */
function initialTab(): Tab {
  try {
    const t = new URLSearchParams(window.location.search).get('itab') ?? '';
    return (TABS as readonly string[]).includes(t) ? (t as Tab) : 'stock';
  } catch {
    return 'stock';
  }
}

export default function AdminInventory() {
  const { dir, loc, latin } = useLoc();
  const count = useCount();
  const s = useMemo(() => inventoryStrings(loc), [loc]);
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab);
  // The address follows the tab (replace, never push: the admin’s own back button stays the admin’s).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('itab') === tab) return;
      url.searchParams.set('itab', tab);
      window.history.replaceState(window.history.state, '', url);
    } catch { /* an address that cannot be rewritten keeps the tab in memory only */ }
  }, [tab]);
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // The overview’s last answer failed: an owner cost tab named in the address stops waiting for it (closing
  // the error notice must not bring back «جارٍ التحميل…» for ever).
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [action, setAction] = useState<{ kind: 'purchase' | 'receive' | 'count' | 'transfer'; key: number } | null>(null);
  const begin = (kind: 'purchase' | 'receive' | 'count' | 'transfer') => {
    setAction((old) => ({ kind, key: (old?.key ?? 0) + 1 }));
    // Every admin but the owner receives through the cost-free receiving view
    // (PurchaseReceivePanel); the purchase register is the owner's.
    setTab(kind === 'purchase' || kind === 'receive' ? (showsCosts ? 'procurement' : 'receiving') : 'operations');
  };

  const loadOverview = useCallback(async () => {
    setOverviewFailed(false);
    try {
      setOverview(await fetchInventoryOverview());
    } catch (e) {
      setOverviewFailed(true);
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // The server removed the cost for every admin but the owner; the strip drops
  // the cards rather than printing them empty. The hint is compared with
  // `=== true` too, so a session without it never opens the cost tabs.
  const showsCosts = user?.can_view_cost === true && overview !== null && 'inventory_value_iqd' in overview;

  // The daily work first (stock, purchases, counts), the records after, the legacy list last.
  const incoming = overview?.incoming_purchases ?? 0;
  const tabs: { id: Tab; label: string; count?: number; legacy?: boolean }[] = [
    { id: 'stock', label: s.tabs.stock },
    ...(showsCosts ? [{ id: 'procurement' as const, label: loc('أوامر الشراء والشحنات', 'Purchase orders and shipments', 'داواکاریی کڕین و بارەکان'), count: incoming }] : []),
    ...(!showsCosts ? [{ id: 'receiving' as const, label: loc('استلام الشحنات', 'Receive shipments', 'وەرگرتنی بارەکان'), count: incoming }] : []),
    { id: 'operations', label: loc('الجرد والمستودعات', 'Counts and warehouses', 'ژماردن و کۆگاکان') },
    { id: 'movements', label: s.tabs.movements },
    ...(showsCosts ? [{ id: 'reports' as const, label: loc('تقارير ودفعات المخزون', 'Inventory reports and lots', 'ڕاپۆرت و کۆمەڵەکانی کۆگا') }] : []),
    { id: 'suppliers', label: s.tabs.suppliers },
    { id: 'incoming', label: loc('المشتريات المنفردة السابقة', 'Legacy individual purchases', 'کڕینە تاکە کۆنەکان'), legacy: true },
  ];
  // A tab the address names but this admin cannot open falls back to the stock; the owner’s cost tabs wait
  // for the overview that proves they may open (never a cost panel before `showsCosts`).
  const available = tabs.some((x) => x.id === tab);
  const waiting = !available && overview === null && !overviewFailed && user?.can_view_cost === true && (tab === 'procurement' || tab === 'reports');
  const current: Tab = available || waiting ? tab : 'stock';
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** Arrow keys move along the row (mirrored in Arabic and Kurdish), Home and End jump to its ends. */
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    // Alt/⌘/Ctrl with an arrow is the browser’s (history, text): only the bare keys move along the row.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const j = e.key === forward ? (i + 1) % tabs.length : e.key === back ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    const next = tabs[j]!.id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const pendingLabel = (n: number) => loc(`المشتريات القادمة: ${count(n)}`, `Incoming purchases: ${count(n)}`, `کڕینە چاوەڕوانکراوەکان: ${count(n)}`);

  return (
    <div className={`${T.AP} inventory-workspace`} dir={dir}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className={`text-[19px] font-bold ${T.text1}`}>{s.title}</h1>
        <button type="button" className={T.btnSecondary} onClick={loadOverview}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      <Notice state={notice} onClose={() => setNotice(null)} />

      {/* The owner before the address is verified: purchases, values and lot
          costs stay shut, and this says how to open them (DECISIONS row 185
          amendment). Counting and receiving below work as for any admin. */}
      {user?.owner_email_unverified === true && <OwnerCostVerifyCard compact />}

      <div className="inventory-start" aria-label={loc('ابدأ عملية مخزون', 'Start an inventory operation', 'کردارێکی کۆگا دەست پێ بکە')}>
        {showsCosts && <button type="button" onClick={() => begin('purchase')} className="inventory-action">
          <PackagePlus size={20} aria-hidden /><span><strong>{loc('شراء جديد', 'New purchase', 'کڕینی نوێ')}</strong><small>{loc('مورد ومنتجات وتكلفة', 'Supplier, items and cost', 'دابینکەر و بەرهەم و تێچوو')}</small></span>
        </button>}
        <button type="button" onClick={() => begin('receive')} className="inventory-action">
          <Truck size={20} aria-hidden /><span><strong>{loc('استلام شحنة', 'Receive shipment', 'وەرگرتنی بار')}</strong><small>{loc('اختر الشراء القادم', 'Choose an incoming purchase', 'کڕینی چاوەڕوانکراو هەڵبژێرە')}</small></span>
        </button>
        <button type="button" onClick={() => begin('count')} className="inventory-action">
          <ClipboardCheck size={20} aria-hidden /><span><strong>{loc('جرد المخزون', 'Count stock', 'ژماردنی کۆگا')}</strong><small>{loc('قارن الفعلي والمسجل', 'Compare actual and recorded', 'ڕاستەقینە و تۆمارکراو بەراورد بکە')}</small></span>
        </button>
        <button type="button" onClick={() => begin('transfer')} className="inventory-action">
          <ArrowLeftRight size={20} aria-hidden /><span><strong>{loc('نقل بين المواقع', 'Transfer stock', 'گواستنەوە لە نێوان شوێنەکان')}</strong><small>{loc('دفعة أو جزء منها', 'Move a lot or part of it', 'کۆمەڵەیەک یان بەشێکی')}</small></span>
        </button>
      </div>

      {/* ------------------------------------------- 1. THE SUMMARY STRIP */}
      {overview && (
        <div className="inventory-summary mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat
            label={s.stats.onHand}
            value={count(overview.on_hand_units)}
            sub={`${s.stats.lots}: ${count(overview.active_lots)}`}
            icon={<Boxes size={15} />}
          />
          {showsCosts && (
            <Stat
              label={s.stats.value}
              value={<Money value={overview.inventory_value_iqd} unknownLabel={s.stock.unknown} />}
              sub={
                overview.unpriced_units > 0
                  ? s.stats.unpriced(count(overview.unpriced_units))
                  : s.stats.valueHint
              }
                icon={<Layers size={15} />}
            />
          )}
          <Stat
            label={s.stats.incoming}
            value={count(overview.incoming_units)}
            sub={`${s.tabs.incoming}: ${count(overview.incoming_purchases)}`}
            icon={<Truck size={15} />}
          />
          <Stat
            label={s.stats.aging}
            value={
              <span className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[14px]">
                {/* The day ranges in the digits of their counts: one card, one digit system.
                    Two by two, so a band never breaks across lines between its
                    count and its range. */}
                <Age n={count(overview.aging_units.d0_30)} tag={`${count(0)}–${count(30)}`} ok />
                <Age n={count(overview.aging_units.d31_90)} tag={`${count(31)}–${count(90)}`} ok />
                <Age n={count(overview.aging_units.d91_180)} tag={`${count(91)}–${count(180)}`} />
                <Age n={count(overview.aging_units.d180_plus)} tag={`${count(180)}+`} warn />
              </span>
            }
            sub={s.stats.agingHint}
            icon={<CalendarClock size={15} />}
          />
        </div>
      )}

      {/* ------------------------------------------------- 2. THE TABS
          ONE ROW THAT SCROLLS, not rows that wrap: at 390px the tabs wrapped
          into three rows and pushed the content a screen down. Real tabs now
          (owner request 2026-11-03, «حسّن نظام التبويبات»): one selected tab
          with an underline, a roving focus the arrow keys move, a count where
          a number waits for the owner, the address keeping the open tab, and
          the legacy list last. */}
      <div className="inventory-tabs hide-scrollbar" role="tablist" aria-label={loc('أقسام المخزون', 'Inventory sections', 'بەشەکانی کۆگا')}>
        {tabs.map((x, i) => (
          <button
            key={x.id}
            ref={(el) => { tabRefs.current[x.id] = el; }}
            type="button"
            role="tab"
            id={`inventory-tab-${x.id}`}
            aria-selected={current === x.id}
            aria-controls="inventory-tab-panel"
            aria-describedby={x.count ? `inventory-tab-${x.id}-count` : undefined}
            tabIndex={current === x.id ? 0 : -1}
            className="inventory-tab"
            data-legacy={x.legacy || undefined}
            onClick={() => setTab(x.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {x.label}
            {x.count ? <span className="inventory-tab-count" aria-hidden>{count(x.count)}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((x) => x.count ? <span key={x.id} id={`inventory-tab-${x.id}-count`} className="sr-only">{pendingLabel(x.count)}</span> : null)}

      {/* ------------------------------------------------ 3. THE PANEL */}
      <div id="inventory-tab-panel" role="tabpanel" aria-labelledby={`inventory-tab-${current}`} tabIndex={0} className="inventory-tab-panel">
        {waiting && <p role="status" className={T.text3}>{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>}
        {current === 'stock' && <StockTab s={s} onChanged={loadOverview} />}
        {current === 'incoming' && <IncomingTab s={s} onChanged={loadOverview} onNewPurchase={showsCosts ? () => begin('purchase') : undefined} />}
        {current === 'movements' && <MovementsTab s={s} />}
        {current === 'suppliers' && <SuppliersTab s={s} />}
        {current === 'procurement' && showsCosts && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…','بارکردن…')}</p>}><ProcurementPanel key={action?.key} initialAction={action?.kind === 'purchase' ? 'purchase' : action?.kind === 'receive' ? 'receive' : undefined} onChanged={loadOverview} /></Suspense>}
        {current === 'receiving' && !showsCosts && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…','بارکردن…')}</p>}><PurchaseReceivePanel key={action?.key} onChanged={loadOverview} /></Suspense>}
        {current === 'operations' && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…','بارکردن…')}</p>}><StockOperationsPanel key={action?.key} initialTab={action?.kind === 'count' ? 'counts' : action?.kind === 'transfer' ? 'locations' : undefined} onChanged={loadOverview} /></Suspense>}
        {current === 'reports' && showsCosts && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…','بارکردن…')}</p>}><InventoryLotPanel onChanged={loadOverview} onOperations={() => { setAction(null); setTab('operations'); }} /></Suspense>}
      </div>
    </div>
  );
}

/**
 * ONE AGE BAND. The oldest band is tinted because that is the one that costs
 * money — stock sitting for six months is capital the shop cannot spend, and
 * a row of four identical grey numbers says nothing about which of them the
 * owner should act on.
 */
function Age({ n, tag, ok, warn }: { n: string; tag: string; ok?: boolean; warn?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1 min-w-0">
      <span className={`font-bold tabular-nums ${warn ? 'text-[var(--ap-warning)]' : ok ? T.text1 : T.text2}`}>{n}</span>
      {/* A range is a number run («٣١–٩٠»): isolated, so the bidi algorithm
          cannot reorder it against the Arabic around it. */}
      <bdi className={`text-[11px] whitespace-nowrap ${T.text3}`}>{tag}</bdi>
    </span>
  );
}
