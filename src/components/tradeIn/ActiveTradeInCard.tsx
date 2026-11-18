/**
 * «استبدالك قيد التنفيذ» — the home page's first card when a trade-in is still open, so the
 * customer who comes back (from a notification, or the profile) lands on what waits, not on a
 * device list. One request: the one waiting on the customer first, else the latest moved
 * (model.ts `activeRequests`). More than one request in all: a link to «طلباتي للاستبدال», counting
 * every request that tab lists.
 *
 * THE SERVER'S FIGURES ONLY: a fixed value is the device's value; an offer is only ever «حتى X»
 * (the same rule as the requests tab, review F-25).
 */
import React from 'react';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { StatusChip } from '../ui/Badge';
import { Money } from '../ui/Money';
import SafeImage from '../ui/SafeImage';
import { STAGE_LABELS } from '../../../packages/pricing/src/tradeIn';
import { useT } from './useT';
import { YOUR_TURN_STAGES, nameOf, stageTone, triText, type RequestSummary } from './model';

export default function ActiveTradeInCard({ active, total, onOpen, onAll }: { active: RequestSummary[]; total: number; onOpen: (id: string) => void; onAll: () => void }) {
  const { t, tx } = useT();
  const { loc, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const r = active[0];
  if (!r) return null;
  const fixed = r.final_value_iqd ?? null;
  const upTo = fixed === null ? (r.offer_iqd ?? null) : null;
  const label = r.stage ? triText(STAGE_LABELS[r.stage], loc) : triText(r.status_label, loc);
  const yourTurn = !!r.stage && YOUR_TURN_STAGES.includes(r.stage);
  const target = r.target_name || r.target_name_ar ? nameOf({ name: r.target_name ?? '', name_ar: r.target_name_ar ?? '', name_ckb: r.target_name_ckb }, loc) : '';

  return (
    <section className="lv-surface overflow-hidden" aria-label={t('active.title')} data-trade-in-active>
      <div className="flex items-center gap-2 px-4 pt-3 text-[12px] font-bold text-text-muted">
        <Repeat className="h-3.5 w-3.5 text-gold" aria-hidden />
        <h2 className="flex-1 text-[12px] font-bold">{t('active.title')}</h2>
        {yourTurn ? (
          <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold" data-trade-in-your-turn>
            {t('active.yourTurn')}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onOpen(r.id)}
        data-request={r.id}
        className="flex w-full items-center gap-3 px-4 pb-3 pt-2 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        <SafeImage sizes="56px" src={r.image} alt="" aspect="square" className="h-14 w-14 shrink-0 rounded-md" bgClassName="bg-surface" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold leading-5 text-text-primary">{r.name}</span>
          {target ? <span className="block truncate text-[12px] text-text-muted">{t('active.towards', { name: target })}</span> : null}
          <StatusChip tone={stageTone(r.stage)} className="mt-1.5">
            {label}
          </StatusChip>
        </span>
        {fixed !== null ? (
          <span className="shrink-0 text-[14px] font-bold text-text-primary" data-request-figure="final">
            <Money iqd={fixed} />
          </span>
        ) : upTo !== null ? (
          <span className="shrink-0 text-[13px] font-bold text-text-primary" data-request-figure="up-to">
            {tx('offer.upTo', { x: <Money iqd={upTo} /> })}
          </span>
        ) : null}
        <Chevron className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      </button>
      {total > 1 ? (
        <button
          type="button"
          onClick={onAll}
          className="block min-h-[44px] w-full border-t border-border-subtle px-4 text-start text-[13px] font-semibold text-gold hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
          data-trade-in-all
        >
          {t('active.all', { n: total })}
        </button>
      ) : null}
    </section>
  );
}
