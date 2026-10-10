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
 *
 * FX-5 (§7.8, §8): once a product is engine-priced, approving reprices it, so
 * the sheet reads the approval's preview (…/review/preview, nothing written)
 * and shows it under the figures — every product's price today → after, the
 * blocked ones, how many follow within 15 minutes — and the approval carries
 * that preview's hash. When something moved since (409 PRICING_PREVIEW_STALE),
 * the fresh preview the refusal carries replaces it.
 */
import React, { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import type { Language } from '../../translations';
import { ApiError } from '../../lib/api';
import { previewFxReview, previewOfRefusal, reviewFxRate, type FxPairDto, type FxRatePreview, type FxRatesAnswer } from './api';
import { RatePreviewBody } from './RatePreview';
import type { FxStrings } from './fxStrings';
import { Fact, FX_DAY_HOURS, FxFigure, FxMessage, fxDate, pctText, RATE_SHOWN_PLACES, RateLine, useFxAct } from './fxParts';
import { signedPct } from './FxPairCard';
import { fxFigure, shownFigure } from './format';
import { Figure } from './parts';

export interface FxReviewSheetProps {
  pair: FxPairDto | null;
  /** How many products the engine prices: above 0, approving is previewed first (FX-5). */
  engineProducts?: number;
  onClose: () => void;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: FxStrings;
  onAnswer: (answer: FxRatesAnswer) => void;
  onStale: () => void;
}

export default function FxReviewSheet({ pair: p, engineProducts = 0, onClose, lang, dir, s, onAnswer, onStale }: FxReviewSheetProps) {
  const titleId = useId();
  const bodyId = useId();
  const keepHintId = useId();
  const { busy, message, run, clear } = useFxAct({ lang, s, onAnswer, onStale });
  const pending = p?.pending ?? null;
  const open = !!p && !!pending;
  // FX-5: what approving reprices (null until read; never read when no product is engine-priced).
  const [preview, setPreview] = useState<FxRatePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewKey = open && engineProducts > 0 ? `${p!.pair}:${p!.owner_version}:${pending!.effective_rate}` : null;
  useEffect(() => {
    setPreview(null);
    setPreviewFailed(false);
    if (!previewKey || !p) return;
    let live = true;
    previewFxReview(p.pair).then(
      (answer) => {
        if (live) setPreview(answer);
      },
      () => {
        if (live) setPreviewFailed(true);
      }
    );
    return () => {
      live = false;
    };
    // The preview follows the pair's owner version and the held value (previewKey), not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const decide = (decision: 'approve' | 'reject' | 'keep_manual') =>
    p &&
    run(decision, (confirm_large_change) =>
      reviewFxRate(p.pair, {
        owner_version: p.owner_version,
        decision,
        ...(decision === 'approve' && preview ? { preview_hash: preview.preview_hash } : {}),
        ...(confirm_large_change ? { confirm_large_change: true } : {}),
      }).catch((e: unknown) => {
        // Something moved since the preview: the refusal carries the fresh one — shown before approving again.
        const fresh = e instanceof ApiError ? previewOfRefusal(e.details) : null;
        if (fresh) setPreview(fresh);
        throw e;
      })
    ).then((ok) => {
      if (ok) onClose();
    });
  // While the preview is being read, approving waits for it (the server would ask for it anyway).
  const approveWaits = engineProducts > 0 && !preview && !previewFailed;

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
            <Button
              variant="primary"
              loading={busy === 'approve'}
              disabled={(!!busy && busy !== 'approve') || approveWaits}
              onClick={() => decide('approve')}
              data-fx-decision="approve"
            >
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
                <FxFigure rate={p.market_adjustment_iqd ?? '0'} />
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
          {/* FX-5 (§7.8): what approving reprices, before it is approved. */}
          {engineProducts > 0 && (
            <section className="mt-4 border-t border-border-subtle/60 pt-4" aria-label={s.previewTitle} data-fx-review-preview>
              <h3 className="mb-2 text-[13px] font-bold text-text-muted">{s.previewTitle}</h3>
              {preview ? (
                <RatePreviewBody preview={preview} label={s.pairName[p.pair]} lang={lang} s={s} />
              ) : previewFailed ? (
                <p className="text-[13px] text-text-muted">{s.loadFailed}</p>
              ) : (
                <p className="text-[13px] text-text-muted" role="status">
                  {s.previewLoading}
                </p>
              )}
              {preview?.fresh_sign_in && <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted" data-fx-review-fresh>{s.reauth}</p>}
            </section>
          )}
          <FxMessage message={message} s={s} />
        </div>
      )}
    </Sheet>
  );
}
