/**
 * ONE EXCHANGE RATE, AS THE OWNER RUNS IT (FX programme plan §12, brief
 * §3–§5, §27–§30).
 *
 * USD → IQD: the Iraqi parallel market (IQWealth, attributed), the market
 * sell / buy and the CBI rate for context, the owner's adjustment, and the
 * EFFECTIVE rate — the shop's rate customers read dollars at. EUR → USD and
 * CNY → USD: the ECB's daily reference, and the computed rate in dinars.
 *
 * What the owner can do here, each through its own route and each answered
 * beside the control that sent it (`useFxAct`):
 *   - the tracking: Off (the rate becomes manual, kept where it is) / every 6
 *     or 12 hours (USD) / every 24 hours (ECB) — a choice, then «حفظ»;
 *   - a manual rate; back to automatic; «استخدم {rate} سعرًا يدويًا» after a
 *     refresh while manual (critique L14);
 *   - the adjustment (USD only, signed dinars per dollar, Q1);
 *   - «تأكيد السعر الحالي», which moves the drift anchor (critique F1);
 *   - the safety settings, collapsed, behind a fresh sign-in (critique F3);
 *   - a held value is decided in the review sheet (FxReviewSheet).
 *
 * Every figure is the server's decimal text; nothing is computed here.
 */
import React, { useEffect, useId, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { Field, Input } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import type { Language } from '../../translations';
import { confirmFxRate, saveFxSettings, setFxManual, type FxPairDto, type FxRatesAnswer, type FxSettingsBody } from './api';
import type { FxStrings } from './fxStrings';
import { adjustmentInput, fxRateInput, pctInput } from './fxInput';
import { Fact, FxMessage, FX_STATUS_TONE, fxDate, pctText, RateLine, useFxAct } from './fxParts';
import { readDecimal } from './format';
import { Figure } from './parts';
import { iqdUnit } from '../../lib/money';

type Tracking = 'off' | '6' | '12' | '24';

const trackingOf = (p: FxPairDto): Tracking => (p.mode === 'MANUAL' ? 'off' : p.pair === 'USD_IQD' ? (p.interval_hours === 12 ? '12' : '6') : '24');

/** Signed for reading: «+3.6» / «−2.9» (the server's text, the sign made explicit). */
export function signedPct(text: string | null, lang: Language): string {
  if (!text) return '—';
  const cut = pctText(text);
  const neg = cut.startsWith('-');
  const abs = neg ? cut.slice(1) : cut;
  const sign = neg ? '−' : /^0+(\.0+)?$/.test(abs) ? '' : '+';
  return `${sign}${readDecimal(abs, lang)}${lang === 'en' ? '%' : '٪'}`;
}

export interface FxPairCardProps {
  pair: FxPairDto;
  rates: FxRatesAnswer;
  lang: Language;
  s: FxStrings;
  onAnswer: (answer: FxRatesAnswer) => void;
  onStale: () => void;
  onReview: (pair: FxPairDto) => void;
}

export default function FxPairCard({ pair: p, rates, lang, s, onAnswer, onStale, onReview }: FxPairCardProps) {
  const usd = p.pair === 'USD_IQD';
  const titleId = useId();
  const { busy, message, run } = useFxAct({ lang, s, onAnswer, onStale });

  const [tracking, setTracking] = useState<Tracking>(trackingOf(p));
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState(p.adjustment_iqd_per_usd ?? '0');
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [guards, setGuards] = useState(() => guardDraft(p));
  const [guardErrors, setGuardErrors] = useState<Partial<Record<keyof GuardDraft, string>>>({});

  // A new answer from the server is the truth: the drafts follow it.
  useEffect(() => {
    setTracking(trackingOf(p));
    setAdjustment(p.adjustment_iqd_per_usd ?? '0');
    setGuards(guardDraft(p));
  }, [p]);

  const base = { owner_version: p.owner_version };

  const saveTracking = () =>
    run('tracking', (confirm_large_change) => {
      const body: FxSettingsBody = { ...base };
      if (tracking === 'off') body.mode = 'MANUAL';
      else {
        if (p.mode === 'MANUAL') body.mode = 'AUTO';
        if (usd) body.interval_hours = tracking === '12' ? 12 : 6;
      }
      if (confirm_large_change) body.confirm_large_change = true;
      return saveFxSettings(p.pair, body);
    });

  const saveManual = async (raw: string) => {
    const rate = fxRateInput(raw, p.pair);
    if (!rate) {
      setManualError(s.invalidRate);
      return;
    }
    setManualError(null);
    const ok = await run('manual', (confirm_large_change) =>
      setFxManual(p.pair, { ...base, rate, ...(confirm_large_change ? { confirm_large_change: true } : {}) })
    );
    if (ok) {
      setManualOpen(false);
      setManual('');
    }
  };

  const saveAdjustment = () => {
    const adj = adjustmentInput(adjustment);
    if (adj === null) {
      setAdjustmentError(s.invalidAdjustment);
      return;
    }
    setAdjustmentError(null);
    void run('adjustment', (confirm_large_change) =>
      saveFxSettings(p.pair, { ...base, adjustment_iqd_per_usd: adj, ...(confirm_large_change ? { confirm_large_change: true } : {}) })
    );
  };

  const saveGuards = () => {
    const errors: Partial<Record<keyof GuardDraft, string>> = {};
    const anomaly = pctInput(guards.anomaly, false);
    const drift = pctInput(guards.drift, false);
    const dead = pctInput(guards.dead, true);
    const min = fxRateInput(guards.min, p.pair);
    const max = fxRateInput(guards.max, p.pair);
    if (!anomaly) errors.anomaly = s.invalidPct;
    if (!drift) errors.drift = s.invalidPct;
    if (!dead) errors.dead = s.invalidPct;
    if (!min) errors.min = s.invalidRate;
    if (!max) errors.max = s.invalidRate;
    setGuardErrors(errors);
    if (Object.keys(errors).length) return;
    // Only what changed travels; the server compares exact text.
    const body: FxSettingsBody = { ...base };
    if (anomaly !== p.anomaly_threshold_pct) body.anomaly_threshold_pct = anomaly!;
    if (drift !== p.drift_threshold_pct) body.drift_threshold_pct = drift!;
    if (dead !== p.min_change_pct) body.min_change_pct = dead!;
    if (min !== p.bound_min) body.bound_min = min!;
    if (max !== p.bound_max) body.bound_max = max!;
    if (Object.keys(body).length === 1) return;
    void run('guards', () => saveFxSettings(p.pair, body));
  };

  const derived = p.pair === 'EUR_USD' ? rates.effective_rates_iqd.EUR : p.pair === 'CNY_USD' ? rates.effective_rates_iqd.CNY : null;
  const unknown = <span className="font-normal text-text-muted">{s.unknown}</span>;
  const fig = (v: string | null) => (v ? <Figure>{readDecimal(v, lang)}</Figure> : unknown);
  const when = (v: string | null) => (v ? <span className="font-medium">{fxDate(v, lang)}</span> : unknown);
  const trackingItems = (usd ? (['off', '6', '12'] as const) : (['off', '24'] as const)).map((id) => ({
    id,
    // Short in the control («٦ کاتژمێر»): «هەر ٦ کاتژمێر جارێک» does not fit a third of a phone.
    label: id === 'off' ? s.intOff : id === '6' ? s.int6Short : id === '12' ? s.int12Short : s.int24Short,
  }));
  const anchorDiffers = p.effective_rate !== null && p.drift_anchor_rate !== p.effective_rate;
  const pending = p.pending;
  const limit = pending?.reason === 'DRIFT' ? p.drift_threshold_pct : p.anomaly_threshold_pct;
  const keyMissing = usd && !rates.key_configured;

  return (
    <article aria-labelledby={titleId} data-fx-pair={p.pair} className="lv-surface-raised min-w-0 p-4">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h4 id={titleId} className="text-[15px] font-bold leading-snug text-text-primary">
            {s.pairName[p.pair]}
          </h4>
          <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{usd ? s.srcParallel : s.srcEcb}</p>
        </div>
        <StatusChip tone={FX_STATUS_TONE[p.status]} className="shrink-0">
          {s.st[p.status]}
        </StatusChip>
      </header>

      {/* The rate in force — the one figure the card exists for. */}
      <div className="mt-4" data-fx-effective>
        <p className="text-[12px] text-text-muted">{s.effective}</p>
        {p.effective_rate ? (
          <p className="mt-0.5 text-[22px] font-black leading-tight text-text-primary">
            <RateLine pair={p.pair} rate={p.effective_rate} lang={lang} />
          </p>
        ) : (
          <p className="mt-0.5 text-[15px] font-semibold text-text-secondary">{s.noRateYet}</p>
        )}
        {derived && (
          <p className="mt-1 text-[13px] text-text-secondary" data-fx-derived>
            {s.effectiveIqd[p.pair === 'EUR_USD' ? 'EUR' : 'CNY']}:{' '}
            {derived.rate_iqd ? (
              <span className="font-semibold text-text-primary">
                <Figure>{readDecimal(derived.rate_iqd, lang)}</Figure> {iqdUnit(lang)}
              </span>
            ) : (
              unknown
            )}
          </p>
        )}
      </div>

      {keyMissing && (
        <p role="note" className="lv-alert lv-alert-warning mt-3 text-[13px] leading-relaxed text-text-secondary" data-fx-key-missing>
          {s.keyMissing}
        </p>
      )}

      {pending && (
        <div className="lv-alert lv-alert-warning mt-3" data-fx-pending>
          <p className="text-[14px] font-bold leading-snug text-text-primary">{pending.reason === 'FIRST_VALUE' ? s.reviewFirst : s.reviewTitle}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
            {s.pendingNew}: <span className="font-semibold text-text-primary"><RateLine pair={p.pair} rate={pending.effective_rate} lang={lang} /></span>
          </p>
          {pending.reason && pending.reason !== 'FIRST_VALUE' && (
            <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{s.reasons[pending.reason](readDecimal(limit, lang))}</p>
          )}
          {pending.observed_at && <p className="mt-0.5 text-[12px] text-text-muted">{s.waitingSince(fxDate(pending.observed_at, lang))}</p>}
          <Button size="sm" variant="primary" className="mt-3" onClick={() => onReview(p)} data-fx-review-open>
            {s.reviewOpen}
          </Button>
        </div>
      )}

      {p.rejected && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-muted" data-fx-rejected>
          {s.rejectedRecently(readDecimal(p.rejected.rejected_rate, lang), fxDate(p.rejected.rejected_at, lang))}
        </p>
      )}

      {p.mode === 'MANUAL' && (
        <div className="mt-3 space-y-2" data-fx-manual-mode>
          <p className="text-[13px] leading-relaxed text-text-secondary">{s.manualNote}</p>
          {p.last_observed && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'observed'}
                onClick={() =>
                  run('observed', (confirm_large_change) =>
                    setFxManual(p.pair, { ...base, rate: p.last_observed!.candidate, ...(confirm_large_change ? { confirm_large_change: true } : {}) })
                  )
                }
                data-fx-use-observed
              >
                {s.useObserved(readDecimal(p.last_observed.candidate, lang))}
              </Button>
              <span className="text-[12px] text-text-muted">{s.observedAt(fxDate(p.last_observed.observed_at, lang))}</span>
            </div>
          )}
        </div>
      )}

      {/* The tracking: a choice, then «حفظ» — never a request per arrow key. */}
      <div className="mt-4">
        <p className="mb-2 text-[12px] font-bold text-text-muted">{usd ? s.tracking : s.trackingEcb}</p>
        <Segmented
          group={`fx-tracking-${p.pair}`}
          label={usd ? s.tracking : s.trackingEcb}
          value={tracking}
          onChange={(id) => setTracking(id as Tracking)}
          dataAttr="data-fx-tracking"
          size="sm"
          items={trackingItems}
        />
        {tracking !== trackingOf(p) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" loading={busy === 'tracking'} onClick={saveTracking} data-fx-save-tracking>
              {s.save}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTracking(trackingOf(p))}>
              {s.cancel}
            </Button>
            <span className="text-[12px] text-text-muted">{s.guardsHint}</span>
          </div>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-subtle/60 pt-4" data-fx-facts>
        <Fact label={usd ? s.marketSell : s.marketEcb}>{fig(p.market_rate)}</Fact>
        {usd && <Fact label={s.marketBuy}>{fig(p.market_buy)}</Fact>}
        {usd && <Fact label={s.official}>{fig(p.official_rate)}</Fact>}
        {usd && <Fact label={s.adjustment}>{fig(p.adjustment_iqd_per_usd)}</Fact>}
        <Fact label={s.lkg}>{fig(p.last_known_good_rate)}</Fact>
        <Fact label={s.anchor}>{fig(p.drift_anchor_rate)}</Fact>
        <Fact label={s.lastUpdate}>{when(p.effective_applied_at)}</Fact>
        <Fact label={s.lastCheck}>
          {p.last_checked_at ? (
            <>
              <span className="font-medium">{fxDate(p.last_checked_at, lang)}</span>
              {p.last_check_result && <span className="block text-[12px] font-normal text-text-muted">{s.checkResult[p.last_check_result] ?? p.last_check_result}</span>}
            </>
          ) : (
            unknown
          )}
        </Fact>
        <Fact label={s.published}>{when(p.published_at)}</Fact>
        {p.mode === 'AUTO' && <Fact label={s.nextCheck}>{when(p.next_check_at)}</Fact>}
      </dl>

      {usd && (
        <div className="mt-4 border-t border-border-subtle/60 pt-4" data-fx-adjustment>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={s.adjustment} hint={s.adjustmentHint} error={adjustmentError} className="min-w-[12rem] max-w-sm flex-1">
              <Input ltr inputMode="decimal" autoComplete="off" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} />
            </Field>
            {adjustmentInput(adjustment) !== (p.adjustment_iqd_per_usd ?? '0') && (
              <Button variant="secondary" loading={busy === 'adjustment'} onClick={saveAdjustment} className="mb-[22px]" data-fx-save-adjustment>
                {s.save}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* The owner's own rate, and the way back. */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle/60 pt-4">
        {!manualOpen && (
          <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)} data-fx-manual-open>
            {s.manual}
          </Button>
        )}
        {p.mode === 'MANUAL' && !manualOpen && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'auto'}
            onClick={() => run('auto', () => saveFxSettings(p.pair, { ...base, mode: 'AUTO' }))}
            data-fx-back-auto
          >
            {s.backAuto}
          </Button>
        )}
        {anchorDiffers && !manualOpen && (
          <Button
            size="sm"
            variant="ghost"
            icon={<ShieldCheck aria-hidden="true" className="h-4 w-4" />}
            loading={busy === 'confirm'}
            onClick={() => run('confirm', () => confirmFxRate(p.pair, base))}
            title={s.confirmCurrentHint}
            data-fx-confirm-current
          >
            {s.confirmCurrent}
          </Button>
        )}
      </div>
      {manualOpen && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveManual(manual);
          }}
          data-fx-manual-form
        >
          <Field label={s.manualLabel} error={manualError} className="min-w-[12rem] max-w-sm flex-1">
            <Input ltr inputMode="decimal" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} placeholder={p.effective_rate ?? ''} />
          </Field>
          <div className={`flex gap-2 ${manualError ? 'mb-[22px]' : ''}`}>
            <Button type="submit" variant="primary" loading={busy === 'manual'}>
              {s.manualSave}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setManualOpen(false);
                setManualError(null);
              }}
            >
              {s.cancel}
            </Button>
          </div>
        </form>
      )}

      <FxMessage message={message} s={s} />

      {/* «إعدادات الحماية» — collapsed: they are set once and rarely touched. */}
      <details className="group mt-4 border-t border-border-subtle/60 pt-2" data-fx-guards>
        <summary className="inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 rounded-md text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 text-text-muted" />
          {s.guards}
        </summary>
        <p className="mb-3 text-[12px] leading-relaxed text-text-muted">{s.guardsHint}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={s.threshold} error={guardErrors.anomaly}>
            <Input ltr inputMode="decimal" autoComplete="off" value={guards.anomaly} onChange={(e) => setGuards({ ...guards, anomaly: e.target.value })} />
          </Field>
          <Field label={s.drift} error={guardErrors.drift}>
            <Input ltr inputMode="decimal" autoComplete="off" value={guards.drift} onChange={(e) => setGuards({ ...guards, drift: e.target.value })} />
          </Field>
          <Field label={s.minChange} error={guardErrors.dead}>
            <Input ltr inputMode="decimal" autoComplete="off" value={guards.dead} onChange={(e) => setGuards({ ...guards, dead: e.target.value })} />
          </Field>
          <Field label={s.boundMin} error={guardErrors.min}>
            <Input ltr inputMode="decimal" autoComplete="off" value={guards.min} onChange={(e) => setGuards({ ...guards, min: e.target.value })} />
          </Field>
          <Field label={s.boundMax} error={guardErrors.max}>
            <Input ltr inputMode="decimal" autoComplete="off" value={guards.max} onChange={(e) => setGuards({ ...guards, max: e.target.value })} />
          </Field>
        </div>
        <Button size="sm" variant="secondary" className="mt-3" loading={busy === 'guards'} onClick={saveGuards} data-fx-save-guards>
          {s.guardsSave}
        </Button>
      </details>

      <p className="mt-3 text-[12px] text-text-muted" data-fx-attribution>
        <a
          href={p.attribution.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-sm underline decoration-border-subtle underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {usd ? s.attribution : s.ecbAttribution}
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </p>
    </article>
  );
}

interface GuardDraft {
  anomaly: string;
  drift: string;
  dead: string;
  min: string;
  max: string;
}

function guardDraft(p: FxPairDto): GuardDraft {
  return { anomaly: p.anomaly_threshold_pct, drift: p.drift_threshold_pct, dead: p.min_change_pct, min: p.bound_min, max: p.bound_max };
}
