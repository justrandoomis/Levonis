/**
 * THE OWNER'S RATES AT A GLANCE, ON THE ADMIN OVERVIEW (FX programme plan
 * §12 `OwnerRatesCard`).
 *
 * The three effective rates with their status, and how many wait for the
 * owner's review, with the way into «التسعير والشحن» where they are run.
 *
 * WHO. src/components/AdminOverview.tsx mounts it — lazily, its own chunk —
 * only on `can_write_cost === true`, the same hint as the pricing tab; the
 * route behind it (`GET /api/admin/pricing/rates`) refuses everyone but the
 * verified owner on the server. A refusal or an older database (503
 * PRICING_NOT_INSTALLED) shows nothing: the card is a courtesy, never a
 * dead end on the first screen. Nothing is kept in browser storage.
 *
 * It reads the pricing tab's own words and formatter (fxStrings, format) —
 * never the tab's components — so the overview loads no pricing vocabulary.
 */
import React, { useEffect, useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Landmark } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { isAborted } from '../../lib/api';
import { StatusChip, type Tone } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import { fetchFxRates, type FxRatesAnswer, type FxStatus } from '../adminPricing/api';
import { fxStrings } from '../adminPricing/fxStrings';
import { fxCount, shownFigure } from '../adminPricing/format';

const TONE: Readonly<Record<FxStatus, Tone>> = {
  OK: 'success',
  REVIEW_REQUIRED: 'warning',
  FAILED: 'danger',
  STALE: 'warning',
  NOT_CONFIGURED: 'neutral',
};

const UNITS = { USD_IQD: ['USD', 'IQD'], EUR_USD: ['EUR', 'USD'], CNY_USD: ['CNY', 'USD'] } as const;
/** As the pricing tab shows them (fxParts RATE_SHOWN_PLACES — not imported, so the overview loads no tab code): CNY/USD to six decimals. */
const SHOWN_PLACES = { USD_IQD: null, EUR_USD: null, CNY_USD: 6 } as const;

export default function OwnerRatesCard({ onOpen }: { onOpen?: () => void }) {
  const { lang, dir } = useLanguage();
  const s = fxStrings(lang);
  const titleId = useId();
  const [data, setData] = useState<FxRatesAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetchFxRates({ signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!ac.signal.aborted && !isAborted(e)) setFailed(true);
      });
    return () => ac.abort();
  }, []);

  if (failed) return null;
  const waiting = data ? data.pairs.filter((p) => p.status === 'REVIEW_REQUIRED').length : 0;
  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;

  return (
    <section aria-labelledby={titleId} data-owner-rates-card className="lv-surface min-w-0 p-4" dir={dir}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="flex items-center gap-2 text-[15px] font-bold text-text-primary">
          <Landmark aria-hidden="true" className="h-4 w-4 text-text-muted" />
          {s.ownerCardTitle}
        </h2>
        {waiting > 0 && <StatusChip tone="warning">{s.ownerCardReview(fxCount(waiting))}</StatusChip>}
      </div>
      {!data ? (
        <div className="mt-3 space-y-2" aria-hidden="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border-subtle/60">
          {data.pairs.map((p) => {
            const [from, to] = UNITS[p.pair];
            const f = p.effective_rate ? shownFigure(p.effective_rate, SHOWN_PLACES[p.pair]) : null;
            return (
              <li key={p.pair} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-owner-rate={p.pair}>
                <span className="text-[13px] font-semibold text-text-secondary">{s.pairName[p.pair]}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-bold text-text-primary">
                    {f ? (
                      // Latin digits, like every figure of the rates panel (UX review #1).
                      <bdi dir="ltr" className="whitespace-nowrap tabular-nums" title={f.approx ? `1 ${from} = ${f.exact} ${to}` : undefined}>
                        1 {from} {f.approx ? '≈' : '='} {f.text} {to}
                      </bdi>
                    ) : (
                      <span className="text-[13px] font-medium text-text-muted">{s.ownerCardEmpty}</span>
                    )}
                  </span>
                  {/* A manual rate is «يدوي», not «يعمل» (UX review #6). */}
                  {p.mode === 'MANUAL' ? <StatusChip tone="neutral">{s.modeManual}</StatusChip> : <StatusChip tone={TONE[p.status]}>{s.st[p.status]}</StatusChip>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-md text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-owner-rates-open
        >
          {s.ownerCardOpen}
          <Arrow aria-hidden="true" className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}
