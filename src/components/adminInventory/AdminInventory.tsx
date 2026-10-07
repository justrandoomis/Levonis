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
import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { ArrowLeftRight, Boxes, CalendarClock, ClipboardCheck, Layers, PackagePlus, RefreshCw, Truck } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { fetchInventoryOverview, type InventoryOverview } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { Money, Notice, Stat, errMsg, useCount, useLoc, type NoticeState } from './shared';
import { inventoryStrings } from './strings';
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

export default function AdminInventory() {
  const { dir, loc, latin } = useLoc();
  const count = useCount();
  const s = useMemo(() => inventoryStrings(loc), [loc]);
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('stock');
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [action, setAction] = useState<{ kind: 'purchase' | 'receive' | 'count' | 'transfer'; key: number } | null>(null);
  const begin = (kind: 'purchase' | 'receive' | 'count' | 'transfer') => {
    setAction((old) => ({ kind, key: (old?.key ?? 0) + 1 }));
    // Every admin but the owner receives through the cost-free receiving view
    // (PurchaseReceivePanel); the purchase register is the owner's.
    setTab(kind === 'purchase' || kind === 'receive' ? (showsCosts ? 'procurement' : 'receiving') : 'operations');
  };

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await fetchInventoryOverview());
    } catch (e) {
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // The server removed the cost for every admin but the owner; the strip drops
  // the cards rather than printing them empty. The hint is compared with
  // `=== true` too, so a session without it never opens the cost tabs.
  const showsCosts = user?.can_view_cost === true && overview !== null && 'inventory_value_iqd' in overview;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'stock', label: s.tabs.stock },
    ...(showsCosts ? [{ id: 'procurement' as const, label: loc('أوامر الشراء والشحنات', 'Purchase orders and shipments', 'داواکاریی کڕین و بارەکان') }] : []),
    ...(showsCosts ? [{ id: 'reports' as const, label: loc('تقارير ودفعات المخزون', 'Inventory reports and lots') }] : []),
    ...(!showsCosts ? [{ id: 'receiving' as const, label: loc('استلام الشحنات', 'Receive shipments', 'وەرگرتنی بارەکان') }] : []),
    { id: 'operations', label: loc('الجرد والمستودعات', 'Counts and warehouses', 'ژماردن و کۆگاکان') },
    { id: 'incoming', label: loc('المشتريات المنفردة السابقة', 'Legacy individual purchases', 'کڕینە تاکە کۆنەکان') },
    { id: 'movements', label: s.tabs.movements },
    { id: 'suppliers', label: s.tabs.suppliers },
  ];

  return (
    <div className={`${T.AP} inventory-workspace`} dir={dir}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className={`text-[19px] font-bold ${T.text1}`}>{s.title}</h1>
        <button type="button" className={T.btnSecondary} onClick={loadOverview}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      <Notice state={notice} onClose={() => setNotice(null)} />

      <div className="inventory-start" aria-label={loc('ابدأ عملية مخزون', 'Start an inventory operation')}>
        {showsCosts && <button type="button" onClick={() => begin('purchase')} className="inventory-action">
          <PackagePlus size={20} aria-hidden /><span><strong>{loc('شراء جديد', 'New purchase')}</strong><small>{loc('مورد ومنتجات وتكلفة', 'Supplier, items and cost')}</small></span>
        </button>}
        <button type="button" onClick={() => begin('receive')} className="inventory-action">
          <Truck size={20} aria-hidden /><span><strong>{loc('استلام شحنة', 'Receive shipment')}</strong><small>{loc('اختر الشراء القادم', 'Choose an incoming purchase')}</small></span>
        </button>
        <button type="button" onClick={() => begin('count')} className="inventory-action">
          <ClipboardCheck size={20} aria-hidden /><span><strong>{loc('جرد المخزون', 'Count stock')}</strong><small>{loc('قارن الفعلي والمسجل', 'Compare actual and recorded')}</small></span>
        </button>
        <button type="button" onClick={() => begin('transfer')} className="inventory-action">
          <ArrowLeftRight size={20} aria-hidden /><span><strong>{loc('نقل بين المواقع', 'Transfer stock')}</strong><small>{loc('دفعة أو جزء منها', 'Move a lot or part of it')}</small></span>
        </button>
      </div>

      {/* ------------------------------------------- 1. THE SUMMARY STRIP */}
      {overview && (
        <div className="inventory-summary mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat
            label={s.stats.onHand}
            value={count(overview.on_hand_units)}
            sub={`${s.stats.lots}: ${count(overview.active_lots)}`}
            tint="blue"
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
              tint="green"
              icon={<Layers size={15} />}
            />
          )}
          <Stat
            label={s.stats.incoming}
            value={count(overview.incoming_units)}
            sub={`${s.tabs.incoming}: ${count(overview.incoming_purchases)}`}
            tint="amber"
            icon={<Truck size={15} />}
          />
          <Stat
            label={s.stats.aging}
            value={
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[14px]">
                <Age n={count(overview.aging_units.d0_30)} tag="0–30" ok />
                <Age n={count(overview.aging_units.d31_90)} tag="31–90" ok />
                <Age n={count(overview.aging_units.d91_180)} tag="91–180" />
                <Age n={count(overview.aging_units.d180_plus)} tag="180+" warn />
              </span>
            }
            sub={s.stats.agingHint}
            tint="purple"
            icon={<CalendarClock size={15} />}
          />
        </div>
      )}

      {/* ------------------------------------------------- 2. THE TABS */}
      <div className="mb-5 flex flex-wrap gap-1.5" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            aria-current={tab === x.id ? 'page' : undefined}
            className={T.chip}
            aria-pressed={tab === x.id}
            onClick={() => setTab(x.id)}
          >
            {x.id === 'incoming' && <PackagePlus size={13} />}
            {x.label}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------ 3. THE PANEL */}
      {tab === 'stock' && <StockTab s={s} onChanged={loadOverview} />}
      {tab === 'incoming' && <IncomingTab s={s} onChanged={loadOverview} onNewPurchase={showsCosts ? () => begin('purchase') : undefined} />}
      {tab === 'movements' && <MovementsTab s={s} />}
      {tab === 'suppliers' && <SuppliersTab s={s} />}
      {tab === 'procurement' && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…')}</p>}><ProcurementPanel key={action?.key} initialAction={action?.kind === 'purchase' ? 'purchase' : action?.kind === 'receive' ? 'receive' : undefined} onChanged={loadOverview} /></Suspense>}
      {tab === 'receiving' && !showsCosts && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…','بارکردن…')}</p>}><PurchaseReceivePanel key={action?.key} onChanged={loadOverview} /></Suspense>}
      {tab === 'operations' && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…')}</p>}><StockOperationsPanel key={action?.key} initialTab={action?.kind === 'count' ? 'counts' : action?.kind === 'transfer' ? 'locations' : undefined} onChanged={loadOverview} /></Suspense>}
      {tab === 'reports' && showsCosts && <Suspense fallback={<p role="status">{loc('جارٍ التحميل…','Loading…')}</p>}><InventoryLotPanel onChanged={loadOverview} onOperations={() => { setAction(null); setTab('operations'); }} /></Suspense>}
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
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-bold tabular-nums ${warn ? 'text-[var(--ap-warning)]' : ok ? T.text1 : T.text2}`}>{n}</span>
      <span className={`text-[10.5px] ${T.text3}`}>{tag}</span>
    </span>
  );
}
