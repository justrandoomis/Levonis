/**
 * «أسعار الصرف» — THE OWNER'S EXCHANGE-RATE PANEL, THE FIRST SECTION OF
 * «التسعير والشحن» (FX programme plan §12, push FX-1).
 *
 * Three pairs (FxPairCard) — USD → IQD from the Iraqi parallel market,
 * EUR → USD and CNY → USD from the ECB — the three central shipping rates
 * (ShippingRatesCard), the history (FxHistorySheet) and the decision on a
 * held value (FxReviewSheet).
 *
 * WHO. It lives inside the pricing tab, which src/pages/Admin.tsx mounts only
 * on `can_write_cost === true`; every route behind it refuses everyone but
 * the verified owner on the server (`requireCostRead`), and every answer is
 * `private, no-store`. Nothing is kept in browser storage.
 *
 * THE BROWSER NEVER CALLS A RATE PROVIDER. «تحديث الآن» asks the SERVER to
 * check (`POST /rates/fx/refresh`, two rate-limit buckets); the server alone
 * reaches IQWealth or the ECB.
 *
 * EVERY FIGURE IS THE SERVER'S. Each act answers with the whole rates body,
 * which replaces this copy; the client never computes a rate.
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { isAborted } from '../../lib/api';
import type { Language } from '../../translations';
import { fetchFxRates, refreshFxRates, type FxPairDto, type FxRatesAnswer } from './api';
import { fxStrings } from './fxStrings';
import { FxMessage, refreshMessage, useFxAct } from './fxParts';
import FxPairCard from './FxPairCard';
import FxReviewSheet from './FxReviewSheet';
import FxHistorySheet from './FxHistorySheet';
import ShippingRatesCard from './ShippingRatesCard';
import { PricingFailure } from './parts';
import { fxCount } from './format';

export default function RatesPanel({ lang, dir }: { lang: Language; dir: 'rtl' | 'ltr' }) {
  const s = fxStrings(lang);
  const titleId = useId();
  const [data, setData] = useState<FxRatesAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [reviewPair, setReviewPair] = useState<FxPairDto['pair'] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchFxRates({ signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!ac.signal.aborted && !isAborted(e)) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  const onAnswer = useCallback((answer: FxRatesAnswer) => setData(answer), []);
  const onStale = useCallback(() => setReload((n) => n + 1), []);
  const refresh = useFxAct({ lang, s, onAnswer, onStale });

  const reviewing = reviewPair && data ? data.pairs.find((p) => p.pair === reviewPair) ?? null : null;

  return (
    <section aria-labelledby={titleId} data-fx-rates-panel className="lv-surface min-w-0 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-[68ch]">
          <h3 id={titleId} className="text-[17px] font-bold leading-snug text-text-primary">
            {s.title}
          </h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{s.intro}</p>
        </div>
        {data && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<History aria-hidden="true" className="h-4 w-4" />}
              onClick={() => setHistoryOpen(true)}
              data-fx-history-open
            >
              {s.history}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />}
              loading={refresh.busy === 'refresh'}
              loadingLabel={s.refreshing}
              onClick={() => refresh.run('refresh', () => refreshFxRates(), (answer) => refreshMessage(answer.report, s))}
              data-fx-refresh
            >
              {s.refresh}
            </Button>
          </div>
        )}
      </div>
      {data && (
        <p className="mt-1 text-[12px] text-text-muted" data-fx-refresh-budget>
          {s.refreshBudget(fxCount(data.refresh_budget.used_today), fxCount(data.refresh_budget.limit))}
        </p>
      )}
      <FxMessage message={refresh.message} s={s} />

      {error ? (
        <div className="mt-4">
          <PricingFailure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} fallback={s.loadFailed} />
        </div>
      ) : !data ? (
        // The status is announced; the skeleton beside it is decoration (UX review #8:
        // inside the aria-hidden wrapper the status was never read out).
        <div className="mt-4">
          <p className="sr-only" role="status" data-fx-loading>
            {s.loading}
          </p>
          <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
            <Skeleton className="h-64 w-full md:col-span-2" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {data.pairs.map((p) => (
            <div key={p.pair} className={p.pair === 'USD_IQD' ? 'md:col-span-2' : ''}>
              <FxPairCard pair={p} rates={data} lang={lang} s={s} onAnswer={onAnswer} onStale={onStale} onReview={(pair) => setReviewPair(pair.pair)} />
            </div>
          ))}
          <div className="md:col-span-2">
            <ShippingRatesCard shipping={data.shipping} lang={lang} s={s} onAnswer={onAnswer} onStale={onStale} />
          </div>
        </div>
      )}

      <FxReviewSheet pair={reviewing && reviewing.pending ? reviewing : null} onClose={() => setReviewPair(null)} lang={lang} dir={dir} s={s} onAnswer={onAnswer} onStale={onStale} />
      <FxHistorySheet open={historyOpen} onClose={() => setHistoryOpen(false)} lang={lang} dir={dir} s={s} />
    </section>
  );
}
