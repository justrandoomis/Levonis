/**
 * «قبل التطبيق: ما الذي سيتغيّر» — THE PREVIEW BEFORE AN OWNER RATE ACT
 * (FX programme plan §7.8, §8, §12; owner decisions 8 and 11).
 *
 * Approving a held rate, a manual rate, the adjustment and a central shipping
 * rate each reprice the engine products that rate prices. Before the owner
 * applies one, the server answers what it would do — nothing written — and
 * this shows it:
 *   - the act: the rate from → to;
 *   - how many products and prices are repriced, or that none is;
 *   - every product, each model × channel: today's customer price → the new
 *     one, the change, and how far today's price lies below the new cost +
 *     minimum profit (the order the server writes in);
 *   - a price moving more than 15% (the act then needs the explicit tick) or
 *     dropping more than 30%;
 *   - the products the engine cannot reprice (they keep their prices), and
 *     how many follow on the quarter-hour sweep «خلال 15 دقيقة»;
 *   - the act needs a sign-in within the last ten minutes: the way through.
 * The act carries the preview's `preview_hash`; when something moved since
 * (409 PRICING_PREVIEW_STALE / _REQUIRED), the fresh preview replaces this one
 * and the owner reads it before applying again.
 *
 * Every figure is the server's (integers in dinars, rates and percentages as
 * text); nothing is computed here. No browser storage.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, LogIn, X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { ApiError } from '../../lib/api';
import type { Language } from '../../translations';
import { iqdUnit } from '../../lib/money';
import { previewOfRefusal, type FxRatePreview, type FxRatePreviewRow, type FxRatesAnswer } from './api';
import type { FxStrings } from './fxStrings';
import { FX_LARGE_CHANGE_PCT, FxMessage, fxRefusalText, useSignInAgain, type FxMessageState } from './fxParts';
import { signedPct } from './FxPairCard';
import { fxCount, fxFigure } from './format';
import { channelLabel, nameOf } from './strings';
import { Figure } from './parts';

/** The drop line (§7.8): a price falling more than this needs a second look. */
const DROP_PCT = fxCount(30);
/** The quarter-hour sweep takes the rest (§7.4). */
const SWEEP_MINUTES = fxCount(15);

/** One act to preview and apply: the server's preview, then the act with its hash. */
export interface RateActRequest {
  /** «الدولار ← الدينار» / «ألمانيا برًّا…» — what the act moves, already in the reader's words. */
  label: string;
  load: () => Promise<FxRatePreview>;
  /** The act itself, carrying the preview's hash (and the explicit tick when it was given). */
  commit: (previewHash: string, confirmLarge: boolean) => Promise<FxRatesAnswer>;
  /** Called after the act was applied (e.g. to close the editor that asked for it). */
  onDone?: () => void;
}

const money = (n: number | null | undefined, lang: Language) => (n === null || n === undefined ? '—' : `${fxCount(n)} ${iqdUnit(lang)}`);

/** The rows of one product, in the server's order (largest deficit first). */
function groupByProduct(rows: readonly FxRatePreviewRow[]): FxRatePreviewRow[][] {
  const out: FxRatePreviewRow[][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0]!.product_id === r.product_id) last.push(r);
    else out.push([r]);
  }
  return out;
}

/**
 * THE PREVIEW ITSELF — shared by the review sheet (approving a held rate)
 * and the act sheet below. `label` names what moves.
 */
export function RatePreviewBody({ preview: p, label, lang, s }: { preview: FxRatePreview; label: string; lang: Language; s: FxStrings }) {
  const groups = groupByProduct(p.rows);
  const unit = p.act.kind === 'shipping' ? iqdUnit(lang) : p.act.pair === 'USD_IQD' ? iqdUnit(lang) : 'USD';
  // The server's decimal text, grouped for reading (never re-computed).
  const rate = (v: string | null) => (v ? `${fxFigure(v)} ${unit}` : s.unknown);
  return (
    <div data-fx-rate-preview={p.act.kind}>
      <p className="text-[14px] font-semibold leading-relaxed text-text-primary" data-fx-preview-act>
        {s.previewAct(label, rate(p.act.effective_before), rate(p.act.effective_after))}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-text-secondary" data-fx-preview-summary>
        {p.affected.products > 0 ? s.previewSummary(fxCount(p.affected.products), fxCount(p.affected.models)) : s.previewNone}
      </p>
      {p.follows > 0 && (
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary" data-fx-preview-follows={p.follows}>
          {s.previewFollows(fxCount(p.follows), SWEEP_MINUTES)}
        </p>
      )}
      {(p.large_change || p.drop_flag) && (
        <div className="lv-alert lv-alert-warning mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-text-primary" role="note" data-fx-preview-flags>
          <AlertTriangle aria-hidden="true" className="mt-[2px] h-4 w-4 shrink-0 text-warning" />
          <div>
            {p.large_change && <p data-fx-preview-large>{s.previewLarge(FX_LARGE_CHANGE_PCT)}</p>}
            {p.drop_flag && <p data-fx-preview-drop>{s.previewDrop(DROP_PCT)}</p>}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle/60 rounded-xl border border-border-subtle/70" data-fx-preview-rows>
          {groups.map((rows) => {
            const head = rows[0]!;
            return (
              <li key={head.product_id} className="px-3 py-2.5" data-fx-preview-product={head.product_id}>
                <p className="text-[13.5px] font-bold leading-snug text-text-primary">{nameOf(head, lang, head.product_id)}</p>
                <ul className="mt-1.5 space-y-2">
                  {rows.map((r) => {
                    const model = nameOf({ name_ar: r.model_ar, name_en: r.model_en, name_ckb: r.model_ckb }, lang, '');
                    // Priced per SKU (FX-7) several rows share a model: the unit's key keeps each row its own.
                    return (
                      <li key={`${r.combo_key ?? r.option_id}@${r.channel}`} className="text-[12.5px] leading-relaxed" data-fx-preview-row={`${r.combo_key ?? r.option_id}@${r.channel}`}>
                        <p className="text-text-muted">
                          {model ? `${model} — ` : ''}
                          {channelLabel(r.channel, lang)}
                        </p>
                        <p className="flex flex-wrap items-baseline gap-x-2 text-text-primary">
                          <span>
                            {s.previewToday}: <Figure>{money(r.today_prepaid_iqd, lang)}</Figure>
                          </span>
                          <span aria-hidden="true" className="text-text-muted rtl:-scale-x-100">→</span>
                          <span className="font-semibold">
                            {s.previewNew}: <Figure>{money(r.computed_price_iqd, lang)}</Figure>
                          </span>
                          {r.change_pct !== null && (
                            <span className={r.large || r.drop_flag ? 'font-semibold text-warning' : 'text-text-secondary'} data-fx-preview-change>
                              <Figure>{signedPct(r.change_pct, lang)}</Figure>
                            </span>
                          )}
                        </p>
                        {r.deficit_iqd > 0 && (
                          <p className="text-text-muted" data-fx-preview-deficit>
                            {s.previewBelowFloor(money(r.deficit_iqd, lang))}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {p.blocked.length > 0 && (
        <div className="mt-3" data-fx-preview-blocked>
          <p className="text-[13px] font-bold text-warning">{s.previewBlockedTitle}</p>
          <ul className="mt-1 space-y-0.5 text-[12.5px] text-text-secondary">
            {p.blocked.map((b) => (
              <li key={b.product_id} data-fx-preview-blocked-code={b.code}>
                {nameOf(b, lang, b.product_id)} — <span className="font-mono text-[12px]">{b.code}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * THE ACT SHEET: loads the preview, shows it, applies the act with its hash.
 * One request at a time; a refusal is said beside the button that sent it.
 */
export default function RatePreviewSheet({
  request,
  onClose,
  onAnswer,
  onStale,
  lang,
  dir,
  s,
}: {
  request: RateActRequest | null;
  onClose: () => void;
  onAnswer: (answer: FxRatesAnswer) => void;
  onStale: () => void;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: FxStrings;
}) {
  const titleId = useId();
  const confirmId = useId();
  const signInAgain = useSignInAgain();
  const [preview, setPreview] = useState<FxRatePreview | null>(null);
  const [message, setMessage] = useState<FxMessageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLarge, setConfirmLarge] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    setPreview(null);
    setMessage(null);
    setConfirmLarge(false);
    if (!request) return;
    let live = true;
    request.load().then(
      (p) => {
        if (live) setPreview(p);
      },
      (e) => {
        if (live) setMessage({ tone: 'danger', text: fxRefusalText(e, lang, s), reauth: e instanceof ApiError && e.code === 'REAUTH_REQUIRED' });
      }
    );
    return () => {
      live = false;
    };
  }, [request, lang, s]);

  const apply = useCallback(
    async (rateConfirm = false) => {
      if (!request || !preview || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const answer = await request.commit(preview.preview_hash, confirmLarge || rateConfirm);
        onAnswer(answer);
        request.onDone?.();
        onClose();
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        const fresh = e instanceof ApiError ? previewOfRefusal(e.details) : null;
        if ((code === 'PRICING_PREVIEW_STALE' || code === 'PRICING_PREVIEW_REQUIRED') && fresh) {
          // Something moved since: the fresh preview replaces this one, read before applying again.
          setPreview(fresh);
          setConfirmLarge(false);
          setMessage({ tone: 'warning', text: s.previewStale });
        } else if (code === 'PRICING_LARGE_CHANGE_CONFIRM' && !(confirmLarge || rateConfirm)) {
          // The RATE moves more than 15% (or the owner's acts of the last 24 hours do): the explicit tick, then again.
          if (fresh) setPreview(fresh);
          setMessage({ tone: 'warning', text: s.largeChange(FX_LARGE_CHANGE_PCT), confirmLarge: () => void apply(true) });
        } else {
          if (code === 'PRICING_CHANGED') onStale();
          setMessage({ tone: 'danger', text: fxRefusalText(e, lang, s), reauth: code === 'REAUTH_REQUIRED' });
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [request, preview, confirmLarge, onAnswer, onClose, onStale, lang, s]
  );

  const open = !!request;
  const needsTick = !!preview?.large_change;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="sm:max-w-[620px] sm:w-[94vw]"
      testId="fx-rate-preview-sheet"
      header={
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 pb-2 pt-1" dir={dir}>
          <h2 id={titleId} className="min-w-0 px-2 text-[16px] font-extrabold text-text-primary">
            {s.previewTitle}
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
      }
      footer={
        request && preview ? (
          <div className="flex flex-col gap-2 px-4 pb-3 pt-2" dir={dir}>
            {needsTick && (
              <label htmlFor={confirmId} className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[13px] font-semibold text-text-primary">
                <input id={confirmId} type="checkbox" className="size-4" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} data-fx-preview-confirm />
                {s.previewLargeConfirm}
              </label>
            )}
            {preview.fresh_sign_in ? (
              // The act asks for a sign-in within the last ten minutes: said before it, with the way through (§7.8).
              <div className="flex flex-col gap-2 sm:flex-row-reverse sm:items-center">
                <Button variant="primary" icon={<LogIn aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />} onClick={() => void signInAgain()} data-fx-preview-sign-in>
                  {s.signInAgain}
                </Button>
                <p className="text-[12.5px] leading-relaxed text-text-muted">{s.reauth}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button variant="primary" loading={busy} disabled={needsTick && !confirmLarge} onClick={() => void apply()} data-fx-preview-apply>
                  {s.previewApply}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onClose}>
                  {s.cancel}
                </Button>
              </div>
            )}
          </div>
        ) : null
      }
    >
      <div className="px-4 pb-4 pt-3" dir={dir}>
        {request && preview ? (
          <RatePreviewBody preview={preview} label={request.label} lang={lang} s={s} />
        ) : request && !message ? (
          <div>
            <p className="text-[13px] text-text-muted" role="status" data-fx-preview-loading>
              {s.previewLoading}
            </p>
            <div className="mt-3 space-y-2" aria-hidden="true">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        ) : null}
        <FxMessage message={message} s={s} />
      </div>
    </Sheet>
  );
}
