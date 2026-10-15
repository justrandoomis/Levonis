/**
 * «الخدمات › الاستبدال» — THE TRADE-IN DESK v2 (Services S-P2, DECISIONS row 238; spec §10.3,
 * trade-in design B.5).
 *
 *   THE QUEUE (any admin)       one search, work chips with counts, keyset pages (TradeInQueue);
 *   THE REQUEST (any admin)     facts, declared vs inspected, photos by who took them, history, and
 *                               the next act: receive the device (IntakeSheet — an assistant too),
 *                               the value (ValuePanel — financial up to the server's ceiling, the
 *                               owner above it), the hand-back, the owner's completion
 *                               (TradeInDetail); the owner's valuation record in its own lazy panel;
 *   THE SETTINGS (the owner)    policy, P&L, component references, condition rules and the offer
 *                               parameters (TradeInSettings, its own chunk).
 *
 * Staff read the offer, the ceiling and the final value — never a cost, a margin or a parameter
 * (B.10): those are the owner's, behind cost_read doors the server refuses to anyone else. Every
 * string is in Arabic, English and Sorani (copy.ts). Built on the admin kit (.ap tokens).
 */
import React, { Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Repeat } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { useAuth } from '../../AuthContext';
import { useA } from './useA';
import TradeInQueue from './TradeInQueue';
import TradeInDetail from './TradeInDetail';

/** The owner's settings: their own chunk (the rules editor carries the engine and its calculator). */
const TradeInSettings = React.lazy(() => import('./TradeInSettings'));

function initialRequestId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('request') ?? '';
    return /^tin_[0-9a-f]{20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export default function AdminTradeIn() {
  const { a, dir } = useA();
  const { user } = useAuth();
  // The settings are cost reads: offered to the verified owner only (the server refuses everyone else).
  const owner = user?.can_view_cost === true && user?.is_owner === true;
  const [view, setView] = useState<'requests' | 'settings'>('requests');
  const [open, setOpen] = useState<string | null>(initialRequestId);
  const [version, setVersion] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('dash-topbar-slot')), []);

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="trade-in">
      {slot &&
        createPortal(
          <nav className={`${T.AP} hidden min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] sm:flex`} aria-label="breadcrumb" dir={dir}>
            <span>{a('breadcrumb')}</span>
            <span aria-hidden>/</span>
            <span>{a('group')}</span>
            <span aria-hidden>/</span>
            <span className="truncate font-semibold text-[var(--ap-text-1)]">{a('tab.tradeIn')}</span>
          </nav>,
          slot
        )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[20px] font-bold">
            <Repeat className="h-5 w-5 text-[var(--ap-accent-text)]" aria-hidden />
            {a('tab.tradeIn')}
          </h1>
          <p className={`text-[13px] ${T.text3}`}>{a('desk.sub')}</p>
        </div>
        {owner ? (
          <div role="group" aria-label={a('group')} className="lv-well inline-flex items-center gap-1 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-1">
            {(['requests', 'settings'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                data-trade-in-view={v}
                className={`min-h-[36px] rounded-sm border px-4 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  view === v ? 'border-border-subtle bg-surface-raised text-text-primary shadow-1' : 'border-transparent text-[var(--ap-text-3)] hover:text-[var(--ap-text-2)]'
                }`}
              >
                {v === 'requests' ? a('view.requests') : a('settings')}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {view === 'settings' && owner ? (
        <Suspense fallback={<p className={`py-12 text-center text-[13px] ${T.text3}`}>{a('loading')}</p>}>
          <TradeInSettings />
        </Suspense>
      ) : (
        <TradeInQueue onOpen={setOpen} version={version} />
      )}
      {open ? <TradeInDetail id={open} onClose={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} /> : null}
    </div>
  );
}
