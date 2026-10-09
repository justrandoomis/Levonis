/**
 * «سجل أسعار الصرف» — THE RATE HISTORY, PAGED (FX programme plan §12).
 *
 * `fx_rate_log` is append-only and private; the owner reads it here, newest
 * first, one pair or all three, a page at a time (the cursor is the last
 * row's time AND id — one batch stamps all its rows with one time, FX-1
 * review C4). Each row says what happened in words (an unknown event is shown
 * by its code, never dropped), which pair by its name, who or what caused it,
 * why in words (an error code is never printed raw, UX review #11), and the
 * rate before and after — the server's text, in the panel's Latin digits.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { isAborted } from '../../lib/api';
import type { Language } from '../../translations';
import { FX_PAIR_IDS, fetchFxHistory, type FxHistoryItem, type FxPairId } from './api';
import { fxCodeText, fxEventLabel, pairShortName, type FxStrings } from './fxStrings';
import { FxFigure, fxDate, fxRefusalText, RATE_SHOWN_PLACES } from './fxParts';

const PAGE = 30;


export interface FxHistorySheetProps {
  open: boolean;
  onClose: () => void;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: FxStrings;
}

export default function FxHistorySheet({ open, onClose, lang, dir, s }: FxHistorySheetProps) {
  const titleId = useId();
  const [pair, setPair] = useState<'all' | FxPairId>('all');
  const [items, setItems] = useState<FxHistoryItem[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (before: { created_at: string; id: string } | null) => {
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;
      setLoading(true);
      setError(null);
      try {
        const r = await fetchFxHistory({ pair: pair === 'all' ? null : pair, before, limit: PAGE }, { signal: ac.signal });
        if (ac.signal.aborted) return;
        setItems((prev) => (before ? [...prev, ...r.items] : r.items));
        setMore(r.items.length === PAGE);
      } catch (e) {
        if (!isAborted(e) && !ac.signal.aborted) setError(fxRefusalText(e, lang, s));
      } finally {
        if (controller.current === ac) setLoading(false);
      }
    },
    [pair, lang, s]
  );

  useEffect(() => {
    if (!open) return;
    setItems([]);
    void load(null);
    return () => controller.current?.abort();
  }, [open, load]);

  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;
  // The filter names each pair by its source currency in words («الدولار», «یۆرۆ», "USD"): the
  // full name («الدولار ← الدينار») was cut off four to a row on a phone (UX review #11).
  const pairItems = [{ id: 'all', label: s.historyAll }, ...FX_PAIR_IDS.map((id) => ({ id, label: pairShortName(s.pairName[id]) }))];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="sm:max-w-[620px] sm:w-[92vw]"
      testId="fx-history-sheet"
      header={
        <div className="border-b border-border-subtle px-2 pb-2 pt-1" dir={dir}>
          <div className="flex items-center justify-between gap-2">
            <h2 id={titleId} className="min-w-0 px-2 text-[16px] font-extrabold text-text-primary">
              {s.historyTitle}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={s.close}
              className="grid size-11 shrink-0 place-items-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
          <div className="px-2 pt-1">
            <Segmented group="fx-history-pair" label={s.historyTitle} value={pair} onChange={(id) => setPair(id as 'all' | FxPairId)} size="sm" items={pairItems} />
          </div>
        </div>
      }
    >
      <div className="px-4 pb-4 pt-2" dir={dir} data-fx-history>
        {error && (
          <p role="alert" className="lv-alert lv-alert-danger mt-2 text-[13px] text-text-primary">
            {error}
          </p>
        )}
        {!error && !loading && items.length === 0 && <p className="py-6 text-center text-[13px] text-text-muted">{s.historyEmpty}</p>}
        <ol className="divide-y divide-border-subtle/60">
          {items.map((it) => (
            <li key={it.id} className="py-3" data-fx-history-item={it.event}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="min-w-0 text-[14px] font-semibold text-text-primary">
                  {fxEventLabel(s, it.event)}
                  {/* The margin on a wrapper in the reading direction, the name isolated inside it:
                      on the dir="ltr" span itself the margin landed on the far side (UX review #11). */}
                  <span className="ms-2 text-[12px] font-normal text-text-muted" data-fx-history-pair>
                    <bdi>{s.pairName[it.pair] ?? it.pair}</bdi>
                  </span>
                </p>
                <p className="text-[12px] text-text-muted">{fxDate(it.created_at, lang)}</p>
              </div>
              <p className="mt-0.5 text-[12.5px] text-text-secondary">
                {s.triggers[it.trigger_kind as keyof FxStrings['triggers']] ?? it.trigger_kind}
                {it.error_code && (
                  <span className="ms-2 text-[12px] text-text-muted" title={it.error_code} data-fx-history-code>
                    {fxCodeText(s, it.error_code)}
                  </span>
                )}
              </p>
              {(it.effective_before || it.effective_after) && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-text-primary">
                  {it.effective_before ? <FxFigure rate={it.effective_before} places={RATE_SHOWN_PLACES[it.pair]} /> : '—'}
                  <Arrow aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
                  {it.effective_after ? <FxFigure rate={it.effective_after} places={RATE_SHOWN_PLACES[it.pair]} className="font-semibold" /> : '—'}
                </p>
              )}
              {it.pending_rate && !it.effective_after && (
                <p className="mt-1 text-[12.5px] text-text-secondary">
                  {s.pendingNew}: <FxFigure rate={it.pending_rate} places={RATE_SHOWN_PLACES[it.pair]} />
                </p>
              )}
            </li>
          ))}
        </ol>
        {(more || loading) && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="secondary" loading={loading} loadingLabel={s.loading} onClick={() => {
                const last = items[items.length - 1];
                void load(last ? { created_at: last.created_at, id: last.id } : null);
              }}>
              {s.loadMore}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
