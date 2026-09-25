import React from 'react';
import { ShieldCheck, ShieldOff, ShieldPlus, Clock, AlertTriangle } from 'lucide-react';
import type { Language } from '../../translations';
import type { Device } from './types';
import { fmtDate, fmtInt } from './types';
import type { WarrantyStrings } from './strings';
import { monthsLabel } from '../orders/format';

/**
 * THE WARRANTY TIMELINE. A hairline from the delivery date to the end date,
 * with a gold fill for the time already used and a tick where today is. The
 * one number a person actually wants — days left — sits at the end of the
 * status line in tabular figures so a list of cards lines up.
 *
 * It says only what the server said: the fill is derived from the same two
 * dates that are printed under it, and every non-active state (expired, not
 * delivered, awaiting configuration) is drawn as its own honest shape rather
 * than a bar pretending to be partly full.
 */
export function CoverageBar({
  warranty,
  deliveredAt,
  lang,
  s,
  className = '',
}: {
  warranty: Device['warranty'];
  deliveredAt: string | null;
  lang: Language;
  s: WarrantyStrings;
  className?: string;
}) {
  const state = warranty.state;
  const startIso = warranty.start_at ?? deliveredAt;
  const endIso = warranty.end_at;

  let fraction = 0;
  if (startIso && endIso) {
    const a = new Date(startIso).getTime();
    const b = new Date(endIso).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      fraction = Math.min(1, Math.max(0, (Date.now() - a) / (b - a)));
    }
  }
  if (state === 'expired') fraction = 1;

  const active = state === 'active';
  const expired = state === 'expired';
  const notDelivered = state === 'not_delivered';
  const needsConfig = state === 'needs_config';

  const Icon = active ? ShieldCheck : expired ? ShieldOff : needsConfig ? AlertTriangle : Clock;
  const label = active ? s.stActive : expired ? s.stExpired : needsConfig ? s.stNeedsConfig : s.stNotDelivered;
  const remaining = warranty.remaining_days;
  const showTodayLabel = active && fraction > 0.14 && fraction < 0.86;
  const pct = `${Math.round(fraction * 1000) / 10}%`;
  // A PURCHASED extension (the +12 / +24 bought with the printer): the
  // device record carries the base and the extension separately, and the
  // end date under the line already holds their sum — so the split is shown
  // as two server facts, not re-added here.
  const extMonths = Number(warranty.ext_months) || 0;
  const baseMonths = typeof warranty.base_months === 'number' && warranty.base_months > 0 ? warranty.base_months : null;
  const showSplit = extMonths > 0 && baseMonths !== null;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-bold min-w-0 ${active ? 'text-zinc-200' : 'text-zinc-400'}`}>
          <Icon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-gold' : ''}`} />
          <span className="truncate">{label}</span>
        </span>
        {active && remaining !== null && (
          <span className="text-[12px] font-bold text-gold tabular-nums whitespace-nowrap shrink-0">
            {s.daysLeft(remaining, fmtInt(remaining, lang))}
          </span>
        )}
      </div>

      {/* The line itself is decoration: the dates and the status text above
          and below it carry the same facts for assistive technology. */}
      <div className="relative mt-4 h-3" aria-hidden="true">
        {notDelivered ? (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-zinc-700" />
        ) : (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-zinc-800" />
        )}
        {(active || expired) && (
          <div
            className={`absolute start-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${
              active ? 'bg-gold' : 'bg-zinc-600'
            }`}
            style={{ width: pct }}
          />
        )}
        {/* end caps */}
        <span className={`absolute start-0 top-1/2 -translate-y-1/2 -ms-[3px] w-1.5 h-1.5 rounded-full ${notDelivered ? 'bg-zinc-700' : 'bg-zinc-500'}`} />
        <span className={`absolute end-0 top-1/2 -translate-y-1/2 -me-[3px] w-1.5 h-1.5 rounded-full ${expired ? 'bg-zinc-500' : needsConfig || notDelivered ? 'bg-zinc-800 ring-1 ring-zinc-700' : 'bg-zinc-700'}`} />
        {/* today */}
        {active && (
          <>
            <span
              className="absolute top-0 h-3 w-px bg-gold transition-[inset-inline-start] duration-700 ease-out motion-reduce:transition-none"
              style={{ insetInlineStart: pct }}
            />
            {showTodayLabel && (
              <span
                className="absolute -top-3.5 text-[9px] uppercase tracking-wide text-gold/80 -translate-x-1/2 rtl:translate-x-1/2 whitespace-nowrap"
                style={{ insetInlineStart: pct }}
              >
                {s.today}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-3 mt-1.5 text-[11px] text-zinc-500 tabular-nums min-w-0">
        <span className="truncate">
          {s.deliveredAt} <span className="text-zinc-400">{fmtDate(deliveredAt, lang)}</span>
        </span>
        <span className="truncate text-end">
          {s.warrantyEnd} <span className="text-zinc-400">{fmtDate(endIso, lang)}</span>
        </span>
      </div>

      {showSplit && (
        <p
          className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400 tabular-nums min-w-0"
          data-coverage-split={`${baseMonths}+${extMonths}`}
        >
          <ShieldPlus aria-hidden="true" className="w-3 h-3 shrink-0 text-gold" />
          <span className="truncate">{s.coverageSplit(monthsLabel(baseMonths, lang), monthsLabel(extMonths, lang))}</span>
        </p>
      )}
    </div>
  );
}
