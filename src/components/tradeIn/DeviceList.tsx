/**
 * SCREEN 1 — «أجهزتك» (trade-in design B.2). Only the customer's OWN delivered LEVONIS devices,
 * from the server (GET /api/trade-in/eligible); a device that cannot be traded stays in the list,
 * dimmed, with its reason; one that has an open request shows where it stands and opens it.
 * «طلباتي للاستبدال» is the second tab. The search is client-side: name, model, order number,
 * the year it arrived.
 */
import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight, PackageSearch, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { TabStrip } from '../ui/Tabs';
import { Badge, StatusChip } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { timeLeftWords, warrantyTimeLeft } from '../../../packages/pricing/src/warrantyTime';
import { STAGE_LABELS } from '../../../packages/pricing/src/tradeIn';
import { useT } from './useT';
import { ErrorLine } from './parts';
import { dateText, stageTone, triText, type EligibleUnit, type RequestSummary } from './model';
import type { CopyKey } from './copy';

export type DeviceTab = 'devices' | 'requests';

/** Why a device cannot be traded now, in the customer's words (the server's codes). */
export function reasonKey(u: Pick<EligibleUnit, 'reason' | 'open_request_id' | 'in_shop'>): CopyKey {
  if (u.in_shop) return 'reason.inShop';
  switch (u.reason) {
    case 'TRADE_IN_ALREADY_CLAIMED':
      return u.open_request_id ? 'reason.claimedOpen' : 'reason.claimed';
    case 'TRADE_IN_RETURN_OPEN':
      return 'reason.return';
    case 'TRADE_IN_BELOW_MINIMUM':
      return 'reason.below';
    case 'TRADE_IN_NOT_DELIVERED':
      return 'reason.notDelivered';
    case 'TRADE_IN_GIFT':
      return 'reason.gift';
    case 'TRADE_IN_LINKED_ELSEWHERE':
      return 'reason.linked';
    case 'TRADE_IN_SERVICE_OPEN':
      return 'reason.service';
    case 'TRADE_IN_PROTECTION_OPEN':
      return 'reason.protection';
    case 'TRADE_IN_DEVICE_IN_SHOP':
      return 'reason.inShop';
    default:
      return 'reason.other';
  }
}

const norm = (s: string) => s.toLocaleLowerCase().replace(/[ً-ٟ]/g, '').trim();

export default function DeviceList({
  units,
  requests,
  loadError,
  onRetry,
  tab,
  onTab,
  query,
  onQuery,
  onPick,
  onOpenRequest,
}: {
  units: EligibleUnit[] | null;
  requests: RequestSummary[] | null;
  loadError: string;
  onRetry: () => void;
  tab: DeviceTab;
  onTab: (t: DeviceTab) => void;
  query: string;
  onQuery: (q: string) => void;
  onPick: (u: EligibleUnit) => void;
  onOpenRequest: (id: string) => void;
}) {
  const { t, tx } = useT();
  const { loc, lang, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const openCount = (requests ?? []).filter(
    (r) => !['completed', 'cancelled', 'customer_rejected'].includes(r.status) || r.stage === 'device_to_collect' || r.stage === 'credit_reissued'
  ).length;

  const shown = useMemo(() => {
    const q = norm(query);
    if (!units || !q) return units;
    return units.filter((u) => {
      const year = u.delivered_at ? new Date(u.delivered_at).getUTCFullYear().toString() : '';
      return [u.name, u.variant, u.order_id, year].some((f) => norm(f || '').includes(q));
    });
  }, [units, query]);

  const warranty = (u: EligibleUnit) => {
    const left = warrantyTimeLeft(u.warranty_end_at, new Date().toISOString());
    if (left.months <= 0 && left.days <= 0) return t('warrantyOver');
    return t('warrantyLeft', {
      n: timeLeftWords(left, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'),
    });
  };

  return (
    <section className="lv-surface overflow-hidden" data-trade-in-devices>
      <TabStrip
        items={[
          { id: 'devices', label: t('tab.devices') },
          {
            id: 'requests',
            label: t('tab.requests'),
            badge: openCount > 0 ? <Badge tone="accent">{openCount}</Badge> : undefined,
          },
        ]}
        value={tab}
        onChange={(id) => onTab(id as DeviceTab)}
        group="trade-in-home"
        label={t('title')}
        indicatorClassName="bg-gold"
        className="border-b border-border-subtle"
      />

      {loadError ? (
        <div className="space-y-3 p-4">
          <ErrorLine>{loadError}</ErrorLine>
          <Button variant="secondary" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      ) : tab === 'devices' ? (
        <div className="p-3 sm:p-4" role="tabpanel" aria-label={t('tab.devices')}>
          <div className="relative">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted" aria-hidden />
            <input
              type="text"
              inputMode="search"
              className="lv-input ps-9 pe-11 text-[14px]"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
              enterKeyHint="search"
              data-trade-in-search
            />
            {query ? (
              <button
                type="button"
                onClick={() => onQuery('')}
                aria-label={t('clearSearch')}
                className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-md text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>

          {shown === null ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : units && units.length === 0 ? (
            <div className="px-2 py-8 text-center" data-trade-in-empty>
              <span className="lv-well mx-auto flex h-12 w-12 items-center justify-center rounded-full text-text-muted">
                <PackageSearch className="h-5 w-5" aria-hidden />
              </span>
              <p className="mt-3 text-[15px] font-bold text-text-primary">{t('empty')}</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] leading-6 text-text-secondary">{t('emptyHint')}</p>
            </div>
          ) : shown.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13.5px] text-text-secondary" role="status">
              {t('noResults', { q: query.trim() })}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {shown.map((u) => {
                const opens = !!u.open_request_id;
                const actionable = u.available || opens;
                return (
                  <li key={u.key}>
                    <button
                      type="button"
                      onClick={() => (opens ? onOpenRequest(u.open_request_id!) : onPick(u))}
                      disabled={!actionable}
                      data-unit={u.key}
                      className={`lv-choice flex w-full items-center gap-3 p-3 text-start ${actionable ? '' : 'opacity-60'}`}
                    >
                      <SafeImage sizes="56px" src={u.image} alt="" aspect="square" className="h-14 w-14 shrink-0 rounded-md" bgClassName="bg-surface" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-bold leading-5 text-text-primary line-clamp-2">{u.name}</span>
                        {u.variant ? <span className="block truncate text-[12px] text-text-muted">{u.variant}</span> : null}
                        <span className="flex flex-wrap gap-x-1.5 text-[12px] text-text-secondary tabular-nums">
                          {/* The label reads in the reader's direction; only the order number is isolated
                              left-to-right (review F-18). The «·» belongs to the date, so it never ends a line. */}
                          <span className="whitespace-nowrap" data-order-no>
                            {tx('orderNo', { id: <bdi dir="ltr">{u.order_id}</bdi> })}
                          </span>
                          <span className="whitespace-nowrap">
                            <span aria-hidden className="pe-1.5">
                              ·
                            </span>
                            {t('delivered', { date: dateText(u.delivered_at, lang) })}
                          </span>
                        </span>
                        <span className="block text-[12px] text-text-secondary">{warranty(u)}</span>
                        {opens && u.stage ? (
                          <StatusChip tone={stageTone(u.stage)} className="mt-1.5">
                            {triText(STAGE_LABELS[u.stage], loc)}
                          </StatusChip>
                        ) : !u.available ? (
                          <StatusChip tone="neutral" className="mt-1.5">
                            {t(reasonKey(u))}
                          </StatusChip>
                        ) : null}
                      </span>
                      {actionable ? <Chevron className="h-5 w-5 shrink-0 text-text-muted" aria-hidden /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="p-3 sm:p-4" role="tabpanel" aria-label={t('tab.requests')}>
          {requests === null ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : requests.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13.5px] text-text-secondary">{t('requestsEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {requests.map((r) => {
                // A fixed value is the device's value; an offer is only ever «حتى X» (review F-25).
                const fixed = r.final_value_iqd ?? null;
                const upTo = fixed === null ? (r.offer_iqd ?? null) : null;
                const label = r.stage ? triText(STAGE_LABELS[r.stage], loc) : triText(r.status_label, loc);
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => onOpenRequest(r.id)} data-request={r.id} className="lv-choice flex w-full items-center gap-3 p-3 text-start">
                      <SafeImage sizes="48px" src={r.image} alt="" aspect="square" className="h-12 w-12 shrink-0 rounded-md" bgClassName="bg-surface" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-bold leading-5 text-text-primary">{r.name}</span>
                        <StatusChip tone={stageTone(r.stage)} className="mt-1">
                          {label}
                        </StatusChip>
                        <span className="mt-1 block text-[11.5px] text-text-muted tabular-nums">{dateText(r.created_at, lang)}</span>
                      </span>
                      {fixed !== null ? (
                        <span className="shrink-0 text-[13px] font-bold text-text-primary" data-request-figure="final">
                          <Money iqd={fixed} />
                        </span>
                      ) : upTo !== null ? (
                        <span className="shrink-0 text-[13px] font-bold text-text-primary" data-request-figure="up-to">
                          {tx('offer.upTo', { x: <Money iqd={upTo} /> })}
                        </span>
                      ) : null}
                      <Chevron className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
