/**
 * «تغيّر كبير في السعر» — A HELD VALUE, DECIDED BY THE OWNER (FX programme
 * plan §12, brief §30; critique M4).
 *
 * The scheduler held a value instead of applying it: the first value from a
 * source, a jump above the step limit, a move above it within 24 hours, a
 * drift from the last rate the owner confirmed, or a return to automatic
 * with a difference. The sheet says which, with the server's own figures —
 * the new rate beside the one in force, the change, how long it has waited —
 * and offers the three decisions:
 *   - «اعتماد السعر الجديد» (approve: the new rate becomes effective, at the
 *     CURRENT adjustment, critique M4.3);
 *   - «رفض والإبقاء على الحالي» (reject: remembered 24 h, never re-offered in
 *     that time, M4.2);
 *   - «أبقِ سعري الحالي يدويًا» (keep_manual: the rate in force becomes manual).
 * A decision above 15% asks for the explicit confirmation and a fresh sign-in
 * (§7.8) — said here, beside the buttons.
 */
import React, { useId } from 'react';
import { X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import type { Language } from '../../translations';
import { reviewFxRate, type FxPairDto, type FxRatesAnswer } from './api';
import type { FxStrings } from './fxStrings';
import { Fact, FX_DAY_HOURS, FxFigure, FxMessage, fxDate, pctText, RATE_SHOWN_PLACES, RateLine, useFxAct } from './fxParts';
import { signedPct } from './FxPairCard';
import { fxFigure, shownFigure } from './format';
import { Figure } from './parts';

export interface FxReviewSheetProps {
  pair: FxPairDto | null;
  onClose: () => void;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: FxStrings;
  onAnswer: (answer: FxRatesAnswer) => void;
  onStale: () => void;
}

export default function FxReviewSheet({ pair: p, onClose, lang, dir, s, onAnswer, onStale }: FxReviewSheetProps) {
  const titleId = useId();
  const bodyId = useId();
  const keepHintId = useId();
  const { busy, message, run, clear } = useFxAct({ lang, s, onAnswer, onStale });
  const pending = p?.pending ?? null;
  const open = !!p && !!pending;

  const decide = (decision: 'approve' | 'reject' | 'keep_manual') =>
    p &&
    run(decision, (confirm_large_change) =>
      reviewFxRate(p.pair, { owner_version: p.owner_version, decision, ...(confirm_large_change ? { confirm_large_change: true } : {}) })
    ).then((ok) => {
      if (ok) onClose();
    });

  const close = () => {
    clear();
    onClose();
  };

  const limit = pending?.reason === 'DRIFT' ? p?.drift_threshold_pct : p?.anomaly_threshold_pct;
  const first = pending?.reason === 'FIRST_VALUE' || !p?.effective_rate;

  return (
    <Sheet
      open={open}
      onClose={close}
      labelledBy={titleId}
      describedBy={bodyId}
      detents={['large']}
      panelClassName="sm:max-w-[560px] sm:w-[92vw]"
      testId="fx-review-sheet"
      header={
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 pb-2 pt-1" dir={dir}>
          <h2 id={titleId} className="min-w-0 px-2 text-[16px] font-extrabold text-text-primary">
            {first ? s.reviewFirst : s.reviewTitle}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={s.close}
            className="grid size-11 shrink-0 place-items-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
      }
      footer={
        p && pending ? (
          <div className="flex flex-col gap-2 px-4 pb-3 pt-2 sm:flex-row-reverse sm:flex-wrap" dir={dir}>
            <Button variant="primary" loading={busy === 'approve'} disabled={!!busy && busy !== 'approve'} onClick={() => decide('approve')} data-fx-decision="approve">
              {s.approve}
            </Button>
            {p.effective_rate && (
              <Button variant="secondary" loading={busy === 'reject'} disabled={!!busy && busy !== 'reject'} onClick={() => decide('reject')} data-fx-decision="reject">
                {s.reject}
              </Button>
            )}
            {p.effective_rate && (
              <Button
                variant="ghost"
                loading={busy === 'keep_manual'}
                disabled={!!busy && busy !== 'keep_manual'}
                onClick={() => decide('keep_manual')}
                aria-describedby={keepHintId}
                data-fx-decision="keep_manual"
              >
                {s.keepManual}
              </Button>
            )}
            {/* Said before the act: it turns tracking off, so it asks for a fresh sign-in (UX review #2). */}
            {p.effective_rate && (
              <p id={keepHintId} className="text-[12px] leading-relaxed text-text-muted sm:basis-full" data-fx-keep-manual-hint>
                {s.keepManualHint}
              </p>
            )}
          </div>
        ) : null
      }
    >
      {p && pending && (
        <div className="px-4 pb-4 pt-3" dir={dir} data-fx-review={p.pair}>
          <p className="text-[13px] font-semibold text-text-muted">{s.pairName[p.pair]}</p>
          <p id={bodyId} className="mt-2 text-[14px] leading-relaxed text-text-secondary">
            {/* The first value: what approving it does — the title already says what it is (UX review #15). */}
            {first || !p.effective_rate || !pending.change_pct
              ? s.reviewFirstBody
              : s.reviewBody(
                  shownFigure(pending.effective_rate, RATE_SHOWN_PLACES[p.pair]).text,
                  shownFigure(p.effective_rate, RATE_SHOWN_PLACES[p.pair]).text,
                  fxFigure(pctText(pending.change_pct).replace(/^-/, '')),
                  fxFigure(limit ?? '')
                )}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border-subtle/70 p-3">
            <Fact label={s.pendingNew} wide>
              <span className="text-[18px] font-black">
                <RateLine pair={p.pair} rate={pending.effective_rate} />
              </span>
            </Fact>
            <Fact label={s.pendingCurrent}>
              {p.effective_rate ? <RateLine pair={p.pair} rate={p.effective_rate} /> : <span className="font-normal text-text-muted">{s.noRateYet}</span>}
            </Fact>
            <Fact label={s.change}>
              <Figure>{signedPct(pending.change_pct, lang)}</Figure>
            </Fact>
            {p.pair === 'USD_IQD' && pending.market_rate && (
              <Fact label={s.pendingMarket}>
                <FxFigure rate={pending.market_rate} />
              </Fact>
            )}
            {p.pair === 'USD_IQD' && (
              <Fact label={s.adjustment}>
                <FxFigure rate={p.adjustment_iqd_per_usd ?? '0'} />
              </Fact>
            )}
            {pending.reason && (
              <Fact label={s.reason} wide>
                <span className="font-medium">{s.reasons[pending.reason](fxFigure(limit ?? ''), FX_DAY_HOURS)}</span>
              </Fact>
            )}
            {pending.published_at && <Fact label={s.published}>{fxDate(pending.published_at, lang)}</Fact>}
            {pending.observed_at && <Fact label={s.lastCheck}>{fxDate(pending.observed_at, lang)}</Fact>}
          </dl>
          {pending.observed_at && <p className="mt-3 text-[12.5px] text-text-muted">{s.waitingSince(fxDate(pending.observed_at, lang))}</p>}
          <FxMessage message={message} s={s} />
        </div>
      )}
    </Sheet>
  );
}
