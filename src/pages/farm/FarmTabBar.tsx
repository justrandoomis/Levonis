/**
 * The farm's bottom pill bar: FARM · JOBS · MARKET · STOCK, plus STORE and
 * UPGRADE drawn LOCKED (never hidden) so the layout is the same on day one as
 * on day thirty. One indicator travels between tabs on the house `move`
 * spring; under reduced motion it jumps. The bar is a flex child of the page,
 * not a fixed element, so the scroll area above it needs no clearance spacer.
 *
 * A locked tab is `aria-disabled`, not `disabled`: it stays tappable so a
 * phone can be TOLD why it is locked ("Unlocks at level 3") — a `title` alone
 * is unreachable without a mouse. Tapping it reports the reason through
 * `onLocked` and never switches the tab.
 */
import React from 'react';
import { motion } from 'motion/react';
import { Boxes, ClipboardList, Lock, Printer, Store, Wrench, type LucideIcon } from 'lucide-react';
import { useMotion } from '../../lib/motion';
import type { FarmStrings } from './strings';

export type FarmTab = 'farm' | 'jobs' | 'market' | 'inventory' | 'store' | 'upgrades';
export const FARM_TABS: FarmTab[] = ['farm', 'jobs', 'market', 'inventory', 'store', 'upgrades'];

export interface TabLock {
  /** Why the tab cannot be opened; null when it can. */
  reason: string | null;
}

const ICONS: Record<FarmTab, LucideIcon> = {
  farm: Printer,
  jobs: ClipboardList,
  market: Store,
  inventory: Boxes,
  store: Store,
  upgrades: Wrench,
};

export function tabLabel(tab: FarmTab, s: FarmStrings): string {
  switch (tab) {
    case 'farm':
      return s.tabFarm;
    case 'jobs':
      return s.tabJobs;
    case 'market':
      return s.tabMarket;
    case 'inventory':
      return s.tabInventory;
    case 'store':
      return s.tabStore;
    case 'upgrades':
      return s.tabUpgrades;
  }
}

export default function FarmTabBar({
  value,
  onChange,
  onLocked,
  locks,
  badges,
  s,
}: {
  value: FarmTab;
  onChange: (tab: FarmTab) => void;
  /** A locked tab was tapped: show the reason (the tab does not switch). */
  onLocked?: (tab: FarmTab, reason: string) => void;
  locks: Record<FarmTab, TabLock>;
  /** A small count after a label, e.g. offers waiting. */
  badges?: Partial<Record<FarmTab, number>>;
  s: FarmStrings;
}) {
  const m = useMotion();
  return (
    <div className="shrink-0 px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] bg-[#0a0a0a]" data-farm-tabbar>
      <nav
        role="tablist"
        aria-label={s.tabsLabel}
        className="flex items-stretch bg-zinc-950/95 border border-white/10 rounded-[28px] p-1 max-w-2xl mx-auto"
      >
        {FARM_TABS.map((tab) => {
          const Icon = ICONS[tab];
          const active = tab === value;
          const lock = locks[tab]?.reason ?? null;
          const badge = badges?.[tab];
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={lock ? true : undefined}
              data-farm-tab={tab}
              data-farm-tab-locked={lock ? true : undefined}
              title={lock ?? undefined}
              onClick={() => {
                if (lock) onLocked?.(tab, lock);
                else onChange(tab);
              }}
              className={`relative flex-1 min-w-0 min-h-[52px] px-0.5 py-1 rounded-full flex flex-col items-center justify-center gap-0.5 press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]/70 ${
                lock ? 'text-zinc-600 cursor-help' : active ? 'text-[#BAA369]' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="farm-tab-indicator"
                  data-farm-tab-indicator
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-[#BAA369]/10 border border-[#BAA369]/25"
                  transition={m.reduced ? { duration: 0 } : m.spring('move')}
                />
              )}
              <span className="relative z-10 flex items-center justify-center">
                {lock ? <Lock aria-hidden="true" className="w-[18px] h-[18px]" /> : <Icon aria-hidden="true" className="w-5 h-5" />}
                {badge !== undefined && badge > 0 && !lock && (
                  <span
                    className="absolute -top-1.5 -end-2.5 min-w-[16px] h-4 px-1 rounded-full bg-[#BAA369] text-black text-[9.5px] font-black leading-4 text-center tabular-nums"
                    dir="ltr"
                  >
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </span>
              {/* Short words per language (strings.ts) so nothing truncates at
                  360px; `break-words` + `leading-tight` allow a second line
                  rather than an ellipsis should a font run wide. */}
              <span className="relative z-10 block max-w-full text-[10px] font-bold leading-tight text-center break-words">{tabLabel(tab, s)}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
