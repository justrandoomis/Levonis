import React from 'react';
import { ShieldCheck, ShieldOff, Clock, AlertTriangle, History, PackageCheck, ShieldPlus } from 'lucide-react';
import type { Language } from '../../translations';
import type { Device } from './types';
import { fmtDate, fmtInt } from './types';
import type { CareStrings, WarrantyStrings } from './strings';
import { monthsLabel } from '../orders/format';
import { warrantyTimeLeft } from '../../../packages/pricing/src/warrantyTime';
import { StatusChip } from '../ui/Badge';

/**
 * WHAT COVERS THIS PRINTER, AND UNTIL WHEN — in words first, then as one line.
 *
 * The headline is a sentence («مغطّاة بالضمان حتى …», «انتهى الضمان — ليفو كير
 * ساري حتى …») with the time left beside it. Under it one bar runs from the
 * delivery to the end of the last cover: the warranty in gold, then Levo Care
 * after it (Care = 12 months AFTER the warranty: 12 / 24 / 36 months in total,
 * DECISIONS row 358). The time already used is dimmed, a tick marks today, and
 * each cover has its own row of words under the bar, so the picture is never
 * the only carrier of a date.
 *
 * It says only what the server said: every date is the server's, the widths are
 * the same dates drawn, and a field an older server leaves out (`care_only_from`,
 * `warranty_months`, `total_months`) falls back to the warranty's own end.
 *
 * A RESOLD DEVICE (owner decision 3, 2026-10-09) carries its original warranty:
 * the line starts at its FIRST delivery and says so; a used-sale period is its
 * own line, never folded into the original.
 */

const GOLD = 'var(--color-gold)';
const CARE = 'var(--color-info)';

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

interface Segment {
  key: 'warranty' | 'care';
  from: number;
  to: number;
  colour: string;
}

export function CoverTimeline({
  device,
  lang,
  s,
  c,
  className = '',
}: {
  device: Device;
  lang: Language;
  s: WarrantyStrings;
  c: CareStrings;
  className?: string;
}) {
  const warranty = device.warranty;
  const care = device.care ?? null;
  const state = warranty.state;
  const used = warranty.used_sale ?? null;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const num = (n: number) => fmtInt(n, lang);
  const date = (iso: string | null | undefined) => fmtDate(iso, lang);

  // THE COVER THE SERVER COUNTED THE DAYS TO (`covered_via`, policy v4): the
  // used-sale period once it outlasts the original warranty. An older server
  // sends no `covered_via`: the used-sale period is drawn only once the
  // original warranty is over.
  const onUsedSale =
    state === 'active' &&
    !!used &&
    (warranty.covered_via ? warranty.covered_via === 'used_sale' : !!warranty.end_at && Date.parse(warranty.end_at) <= now);
  const startIso = onUsedSale ? used!.start_at : warranty.start_at ?? device.delivered_at;
  const warrantyEndIso = onUsedSale ? warranty.cover_end_at ?? used!.end_at : warranty.end_at;
  const continuesFrom = warranty.carried && warranty.origin_start_at ? warranty.origin_start_at : null;

  const notDelivered = state === 'not_delivered';
  const needsConfig = state === 'needs_config';
  const warrantyActive = state === 'active';

  // Levo Care is drawn while it has a window: in force, or over.
  const careDrawn = !!care && (care.state === 'active' || care.state === 'expired') && !!care.end_at;
  const careActive = care?.state === 'active';
  const noWarranty = !!care && care.warranty_months === 0;

  const a = ms(startIso);
  const wEnd = noWarranty ? a : ms(warrantyEndIso);
  const cEnd = careDrawn ? ms(care!.end_at) : null;
  // The day Care becomes the only cover: the server's, else the warranty's end.
  const cFrom = careDrawn ? ms(care!.care_only_from) ?? wEnd ?? a : null;

  const segments: Segment[] = [];
  if (a !== null && wEnd !== null && wEnd > a) segments.push({ key: 'warranty', from: a, to: wEnd, colour: GOLD });
  if (cFrom !== null && cEnd !== null && cEnd > cFrom) segments.push({ key: 'care', from: cFrom, to: cEnd, colour: CARE });
  const lineFrom = segments.length ? segments[0].from : null;
  const lineTo = segments.length ? segments[segments.length - 1].to : null;
  const span = lineFrom !== null && lineTo !== null ? lineTo - lineFrom : 0;
  const todayAt = span > 0 ? Math.min(1, Math.max(0, (now - lineFrom!) / span)) : 0;
  const todayPct = `${Math.round(todayAt * 1000) / 10}%`;
  const showToday = !notDelivered && span > 0 && now > lineFrom! && now < lineTo!;

  // ---- the headline, in words
  const lastEndIso = cEnd !== null && (wEnd === null || cEnd >= wEnd) ? care!.end_at : warrantyEndIso;
  let Icon: React.ElementType = ShieldOff;
  let headline = s.stExpired;
  let leftUntil: string | null = null;
  if (notDelivered) {
    Icon = Clock;
    headline = s.coverStarts;
  } else if (needsConfig) {
    Icon = AlertTriangle;
    headline = s.stNeedsConfig;
  } else if (warrantyActive && !noWarranty) {
    Icon = ShieldCheck;
    headline = warrantyEndIso ? s.coveredUntil(date(warrantyEndIso)) : s.stActive;
    leftUntil = warrantyEndIso ?? null;
  } else if (careActive && care?.end_at) {
    Icon = ShieldCheck;
    headline = noWarranty ? `${c.title} — ${c.activeUntil(date(care.end_at))}` : s.careOnlyUntil(date(care.end_at));
    leftUntil = care.end_at;
  } else if (lastEndIso) {
    headline = s.coverEnded(date(lastEndIso));
  }
  const covered = leftUntil !== null;
  const left = warrantyTimeLeft(leftUntil, nowIso);
  const daysLeft = leftUntil ? Math.max(0, Math.ceil((Date.parse(leftUntil) - now) / 86_400_000)) : 0;

  // ---- the rows under the line
  const extMonths = Number(warranty.ext_months) || 0;
  const baseMonths = typeof warranty.base_months === 'number' && warranty.base_months > 0 ? warranty.base_months : null;
  const showSplit = extMonths > 0 && baseMonths !== null;
  const warrantyMonths = baseMonths !== null ? baseMonths + extMonths : typeof care?.warranty_months === 'number' && care.warranty_months > 0 ? care.warranty_months : null;
  const careMonths =
    typeof care?.total_months === 'number' && typeof care?.warranty_months === 'number' && care.total_months > care.warranty_months
      ? care.total_months - care.warranty_months
      : null;
  const warrantyOver = !warrantyActive && !notDelivered && !needsConfig;

  const row = (key: string, colour: string, label: string, detail: string, chip: React.ReactNode) => (
    <li key={key} className="flex items-center gap-2.5 min-w-0" data-cover-row={key}>
      <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colour }} />
      <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-secondary">
        <span className="font-bold text-text-primary">{label}</span>
        {detail ? <span className="tabular-nums"> · {detail}</span> : null}
      </span>
      {chip}
    </li>
  );

  return (
    <div className={className} data-cover={covered ? 'covered' : notDelivered ? 'not_delivered' : needsConfig ? 'needs_config' : 'ended'}>
      <div className="flex items-start gap-2.5">
        <span className={`lv-well inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${covered ? 'text-gold' : 'text-text-muted'}`}>
          <Icon aria-hidden="true" className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold leading-snug text-text-primary" data-cover-headline>
            {headline}
          </p>
          {covered && (
            <p className="mt-0.5 text-[12.5px] font-bold text-gold tabular-nums" data-warranty-left={`${left.months}m${left.days}d`}>
              {left.months > 0 ? s.left(left.months, left.days, num) : s.daysLeft(daysLeft, num(daysLeft))}
            </p>
          )}
        </div>
      </div>

      {/* The line is decoration: the headline above and the rows below carry
          the same dates for assistive technology. */}
      {segments.length > 0 && (
        <div className="mt-4" aria-hidden="true">
          <div className="relative">
            <div className={`flex gap-0.5 ${notDelivered ? 'opacity-50' : ''}`}>
              {segments.map((seg) => {
                const width = span > 0 ? ((seg.to - seg.from) / span) * 100 : 100;
                const usedPart = notDelivered ? 0 : Math.min(1, Math.max(0, (now - seg.from) / (seg.to - seg.from)));
                return (
                  <div key={seg.key} className="relative h-2 overflow-hidden rounded-full" style={{ width: `${width}%`, background: seg.colour }} data-cover-segment={seg.key}>
                    {/* The time already used, dimmed: what is still bright is what is left. */}
                    <div
                      className="absolute inset-y-0 start-0"
                      style={{ width: `${usedPart * 100}%`, background: 'color-mix(in srgb, var(--color-surface) 72%, transparent)' }}
                    />
                  </div>
                );
              })}
            </div>
            {showToday && (
              <span className="absolute -top-1 h-4 w-0.5 rounded-full bg-text-primary" style={{ insetInlineStart: todayPct }} data-cover-today />
            )}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px] text-text-muted tabular-nums">
            <span className="truncate">
              {s.deliveredAt} <span className="text-text-secondary">{date(startIso)}</span>
            </span>
            <span className="truncate text-end text-text-secondary">{date(lineTo !== null ? new Date(lineTo).toISOString() : null)}</span>
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {noWarranty
          ? row('warranty', 'var(--color-border-subtle)', s.rowWarranty, s.noWarranty, null)
          : !notDelivered && !needsConfig && warrantyEndIso
            ? row(
                'warranty',
                GOLD,
                s.rowWarranty,
                [warrantyMonths !== null ? s.rowMonths(warrantyMonths, num) : '', warrantyOver ? s.endedOn(date(warrantyEndIso)) : s.untilDate(date(warrantyEndIso))].filter(Boolean).join(' · '),
                <StatusChip tone={warrantyOver ? 'neutral' : 'accent'} className="shrink-0 whitespace-nowrap">{warrantyOver ? s.rowEnded : s.rowActive}</StatusChip>
              )
            : null}
        {care &&
          row(
            'care',
            CARE,
            s.rowCare,
            careDrawn
              ? [careMonths !== null ? s.rowCareMonths(careMonths, num) : '', care.state === 'expired' ? s.endedOn(date(care.end_at)) : s.untilDate(date(care.end_at))].filter(Boolean).join(' · ')
              : care.state in c.state
                ? c.state[care.state as keyof CareStrings['state']]
                : '',
            careDrawn ? (
              <StatusChip tone={careActive ? 'info' : 'neutral'} className="shrink-0 whitespace-nowrap">{careActive ? s.rowActive : s.rowEnded}</StatusChip>
            ) : null
          )}
      </ul>

      {care && typeof care.total_months === 'number' && care.total_months > 0 && !noWarranty && (
        <p className="mt-2 text-[11.5px] text-text-muted tabular-nums" data-cover-total={care.total_months}>
          {s.totalCover(care.total_months, num)}
        </p>
      )}

      {continuesFrom && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-text-secondary tabular-nums" data-coverage-continues={continuesFrom}>
          <History aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gold" />
          {/* When the line draws the used-sale period, the original warranty's
              own end is said here, so it is never lost from the card. */}
          <span>{onUsedSale ? s.originalWindow(date(continuesFrom), date(warranty.end_at)) : s.continuesFrom(date(continuesFrom))}</span>
        </p>
      )}
      {used && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-text-secondary tabular-nums" data-coverage-used-sale={used.months}>
          <PackageCheck aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gold" />
          <span>{s.usedSale(used.months, date(used.end_at), num)}</span>
        </p>
      )}
      {showSplit && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-text-secondary tabular-nums" data-coverage-split={`${baseMonths}+${extMonths}`}>
          <ShieldPlus aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gold" />
          <span>{s.coverageSplit(monthsLabel(baseMonths!, lang), monthsLabel(extMonths, lang))}</span>
        </p>
      )}
    </div>
  );
}
