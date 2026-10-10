import React from 'react';
import { ShieldCheck, ShieldOff, ShieldPlus, Clock, AlertTriangle, History, PackageCheck } from 'lucide-react';
import type { Language } from '../../translations';
import type { Device } from './types';
import { fmtDate, fmtInt } from './types';
import type { WarrantyStrings } from './strings';
import { monthsLabel } from '../orders/format';
import { warrantyTimeLeft } from '../../../packages/pricing/src/warrantyTime';

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
 *
 * A RESOLD DEVICE (owner decision 3, 2026-10-09) carries its original
 * warranty: the line starts at its FIRST delivery and says so; a used-sale
 * period is its own line, never folded into the original. What is left reads
 * in calendar months and days («11 شهرًا و5 أيام», «11 months»), not rounded
 * up, and always about the cover the server counted the days to.
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
  const used = warranty.used_sale ?? null;
  const nowIso = new Date().toISOString();
  // THE COVER THE SERVER COUNTED THE DAYS TO (`covered_via`, policy v4): the
  // used-sale period once it outlasts the original warranty — then the line,
  // its end date and the time left all describe that period, never the
  // original end beside used-sale days. An older server sends no `covered_via`:
  // the used-sale period is drawn only once the original warranty is over.
  const onUsedSale =
    state === 'active' &&
    !!used &&
    (warranty.covered_via ? warranty.covered_via === 'used_sale' : !!warranty.end_at && Date.parse(warranty.end_at) <= Date.now());
  const startIso = onUsedSale ? used!.start_at : warranty.start_at ?? deliveredAt;
  const endIso = onUsedSale ? warranty.cover_end_at ?? used!.end_at : warranty.end_at;
  const continuesFrom = warranty.carried && warranty.origin_start_at ? warranty.origin_start_at : null;

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
  const left = warrantyTimeLeft(endIso, nowIso);
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
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-bold min-w-0 ${active ? 'text-text-primary' : 'text-text-secondary'}`}>
          <Icon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-gold' : ''}`} />
          <span className="truncate">{label}</span>
        </span>
        {active && remaining !== null && (
          <span className="text-[12px] font-bold text-gold tabular-nums whitespace-nowrap shrink-0" data-warranty-left={`${left.months}m${left.days}d`}>
            {left.months > 0 ? s.left(left.months, left.days, (n) => fmtInt(n, lang)) : s.daysLeft(remaining, fmtInt(remaining, lang))}
          </span>
        )}
      </div>

      {/* The line itself is decoration: the dates and the status text above
          and below it carry the same facts for assistive technology. */}
      <div className="relative mt-4 h-3" aria-hidden="true">
        {notDelivered ? (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-border-subtle" />
        ) : (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-border-subtle" />
        )}
        {(active || expired) && (
          <div
            className={`absolute start-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${
              active ? 'bg-gold' : 'bg-text-muted'
            }`}
            style={{ width: pct }}
          />
        )}
        {/* end caps */}
        <span className={`absolute start-0 top-1/2 -translate-y-1/2 -ms-[3px] w-1.5 h-1.5 rounded-full ${notDelivered ? 'bg-border-subtle' : 'bg-text-muted'}`} />
        <span className={`absolute end-0 top-1/2 -translate-y-1/2 -me-[3px] w-1.5 h-1.5 rounded-full ${expired ? 'bg-text-muted' : needsConfig || notDelivered ? 'bg-surface-selected ring-1 ring-border-subtle' : 'bg-border-subtle'}`} />
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

      <div className="flex items-baseline justify-between gap-3 mt-1.5 text-[11px] text-text-muted tabular-nums min-w-0">
        <span className="truncate">
          {s.deliveredAt} <span className="text-text-secondary">{fmtDate(deliveredAt, lang)}</span>
        </span>
        <span className="truncate text-end">
          {s.warrantyEnd} <span className="text-text-secondary">{fmtDate(endIso, lang)}</span>
        </span>
      </div>

      {continuesFrom && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary tabular-nums min-w-0" data-coverage-continues={continuesFrom}>
          <History aria-hidden="true" className="w-3 h-3 shrink-0 text-gold" />
          {/* When the line draws the used-sale period, the original warranty's
              own end is said here, so it is never lost from the card. */}
          <span className="truncate">
            {onUsedSale
              ? s.originalWindow(fmtDate(continuesFrom, lang), fmtDate(warranty.end_at, lang))
              : s.continuesFrom(fmtDate(continuesFrom, lang))}
          </span>
        </p>
      )}

      {used && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary tabular-nums min-w-0" data-coverage-used-sale={used.months}>
          <PackageCheck aria-hidden="true" className="w-3 h-3 shrink-0 text-gold" />
          <span className="truncate">{s.usedSale(used.months, fmtDate(used.end_at, lang), (n) => fmtInt(n, lang))}</span>
        </p>
      )}

      {showSplit && (
        <p
          className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary tabular-nums min-w-0"
          data-coverage-split={`${baseMonths}+${extMonths}`}
        >
          <ShieldPlus aria-hidden="true" className="w-3 h-3 shrink-0 text-gold" />
          <span className="truncate">{s.coverageSplit(monthsLabel(baseMonths, lang), monthsLabel(extMonths, lang))}</span>
        </p>
      )}
    </div>
  );
}
