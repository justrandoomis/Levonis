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
 * FOUR TABS, AND NO FIFTH.
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
 * AN ASSISTANT ADMIN IS WELCOME HERE AND SEES NO MONEY.
 *
 * Unlike the profit screen — which refuses them at the door, because there is
 * no useful non-financial part of a profit report — this one is theirs to use:
 * §52 has them counting units and receiving shipments all day. The server
 * strips every cost from the payload, and the tables respond by dropping the
 * COLUMNS rather than printing a wall of dashes that advertises what is behind
 * them. The summary strip does the same.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Boxes, CalendarClock, Layers, PackagePlus, RefreshCw, Truck } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { fetchInventoryOverview, type InventoryOverview } from '../../lib/api';
import { Money, Notice, Stat, errMsg, useCount, useLoc, type NoticeState } from './shared';
import { inventoryStrings } from './strings';
import { StockTab } from './StockTab';
import { IncomingTab } from './IncomingTab';
import { MovementsTab } from './MovementsTab';
import { SuppliersTab } from './SuppliersTab';

type Tab = 'stock' | 'incoming' | 'movements' | 'suppliers';

export default function AdminInventory() {
  const { dir, loc, latin } = useLoc();
  const count = useCount();
  const s = inventoryStrings(loc);
  const [tab, setTab] = useState<Tab>('stock');
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await fetchInventoryOverview());
    } catch (e) {
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // The server removed the money for an assistant admin; the strip drops the
  // cards rather than printing them empty.
  const showsCosts = overview !== null && 'inventory_value_iqd' in overview;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'stock', label: s.tabs.stock },
    { id: 'incoming', label: s.tabs.incoming },
    { id: 'movements', label: s.tabs.movements },
    { id: 'suppliers', label: s.tabs.suppliers },
  ];

  return (
    <div className={T.AP} dir={dir}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className={`text-[19px] font-bold ${T.text1}`}>{s.title}</h1>
        <button type="button" className={T.btnSecondary} onClick={loadOverview}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      <Notice state={notice} onClose={() => setNotice(null)} />

      {/* ------------------------------------------- 1. THE SUMMARY STRIP */}
      {overview && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
      {tab === 'incoming' && <IncomingTab s={s} onChanged={loadOverview} />}
      {tab === 'movements' && <MovementsTab s={s} />}
      {tab === 'suppliers' && <SuppliersTab s={s} />}
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
