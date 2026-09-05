/**
 * The purchase confirmation window.
 *
 * A Sheet on a phone, a centred window that grows out of the Subscribe button
 * from 640px up. It shows the tier, the duration, the IQD price, the USD
 * debit at today's rate, the spendable balance, the shortfall (with the way
 * to the wallet), the expiry or the launch-reserve note and the upgrade
 * credit — every one of them the server's quote, not a browser estimate.
 *
 * The RESULT stays in the window until the person closes it: a success with
 * its real state, or a refusal in their language. A retry after an error
 * reuses the same idempotency key (the page owns it), so a flaky network can
 * never charge twice.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Wallet } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd, formatUsdCents } from '../../lib/api';
import { formatDate } from '../orders/format';
import { Overlay, Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { TIER_META, membershipStateLabel, tierLabel } from './tierMeta';
import type { ApiPlan, LaunchInfo, PurchaseQuote, PurchaseResult } from './types';
import { needsTopUp, purchaseErrorText } from './purchaseErrors';

const PHONE_QUERY = '(max-width: 639px)';

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

export interface PurchaseConfirmProps {
  open: boolean;
  onClose: () => void;
  plan: ApiPlan | null;
  quote: PurchaseQuote | null;
  quoteLoading: boolean;
  quoteError: unknown;
  onRetryQuote: () => void;
  phase: 'review' | 'busy' | 'done';
  result: PurchaseResult | null;
  /** The server refused the confirmed figures (409 QUOTE_CHANGED) and `quote`
   *  now carries the fresh ones: say so in one line, charge nothing. */
  quoteChanged: boolean;
  onConfirm: () => void;
  onRetry: () => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
  launch: LaunchInfo | null;
}

function Fact({ label, value, tone = 'plain' }: { label: React.ReactNode; value: React.ReactNode; tone?: 'plain' | 'negative' | 'warn' | 'muted' }) {
  const cls = tone === 'negative' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'muted' ? 'text-zinc-400' : 'text-white';
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-zinc-400 text-[13px]">{label}</dt>
      <dd className={`text-[13.5px] font-semibold tabular-nums text-end ${cls}`} dir="ltr">
        {value}
      </dd>
    </div>
  );
}

export function PurchaseConfirm(props: PurchaseConfirmProps) {
  const { open, onClose, plan, quote, quoteLoading, quoteError, onRetryQuote, phase, result, quoteChanged, onConfirm, onRetry, anchor, launch } = props;
  const { t, lang, dir } = useLanguage();
  const phone = usePhone();
  const titleId = 'purchase-confirm-title';
  const busy = phase === 'busy';
  // When the review block unmounts for the result, focus would fall to the
  // body; it lands on the heading instead, which now reads the outcome.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (phase === 'done' && open) headingRef.current?.focus();
  }, [phase, open]);

  if (!plan) return null;
  const meta = TIER_META[plan.tier];
  const ok = quote && quote.ok === true ? quote : null;
  const refused = quote && quote.ok === false ? quote : null;
  const canConfirm = !!ok && ok.shortfall_usd_cents === 0 && !busy;

  const body = (
    <div dir={dir} data-purchase-confirm className="p-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      <div className="flex items-start gap-3">
        <span className={`shrink-0 w-11 h-11 rounded-2xl border flex items-center justify-center ${meta.chip}`}>
          <meta.Icon className="w-5 h-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-white font-bold text-base sm:text-lg outline-none">
            {phase === 'done' && result ? (result.kind === 'ok' ? t('purchaseDone') : t('purchaseFailed')) : t('confirmPurchase')}
          </h2>
          <p className="text-zinc-300 text-sm mt-1">
            <span className={`font-black ${meta.text}`}>{meta.label}</span> · {plan.duration_months}{' '}
            {plan.duration_months === 1 ? t('month') : t('months')}
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------------- review */}
      {phase !== 'done' && (
        <>
          {quoteChanged && ok && (
            <p role="status" data-quote-changed className="mt-4 text-[12.5px] text-amber-200 flex items-start gap-2 leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>{t('quoteChangedNotice')}</span>
            </p>
          )}
          {quoteLoading && !quote ? (
            <p role="status" className="mt-4 text-[13px] text-zinc-400 flex items-center gap-2">
              <Spinner size="sm" delayMs={0} decorative /> {t('checkingQuote')}
            </p>
          ) : quoteError && !quote ? (
            <div className="mt-4 rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-[13px] text-amber-200 flex items-center justify-between gap-3">
              <span>{t('quoteFailed')}</span>
              <button type="button" onClick={onRetryQuote} className="underline font-bold min-h-[36px] px-1">
                {t('retry')}
              </button>
            </div>
          ) : refused ? (
            <div className="mt-4 rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-[13px] text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>{purchaseErrorText(refused.code, refused.message, lang)}</span>
            </div>
          ) : ok ? (
            <>
              <dl className="mt-4 rounded-2xl bg-zinc-900/70 border border-zinc-800 divide-y divide-zinc-800" data-confirm-facts>
                <Fact label={t('price')} value={formatIqd(ok.price_iqd)} />
                {ok.credit_iqd > 0 && (
                  <Fact label={`${t('upgradeCredit')} (${tierLabel(ok.upgrade_from_tier)})`} value={`− ${formatIqd(ok.credit_iqd)}`} tone="negative" />
                )}
                {ok.credit_iqd > 0 && <Fact label={t('amountDue')} value={formatIqd(ok.charge_iqd)} />}
                <Fact
                  label={t('walletDebit')}
                  value={
                    <span>
                      {formatUsdCents(ok.charge_usd_cents)}
                      <span className="block text-[10.5px] text-zinc-500 font-normal">
                        {t('exchangeRateLabel')}: 1 USD = {ok.exchange_rate.toLocaleString('en-US')} IQD
                      </span>
                    </span>
                  }
                />
                <Fact label={t('walletBalance')} value={formatUsdCents(ok.balance_usd_cents)} tone="muted" />
                {ok.shortfall_usd_cents > 0 && (
                  <Fact label={t('shortfall')} value={formatUsdCents(ok.shortfall_usd_cents)} tone="warn" />
                )}
                <Fact
                  label={ok.activate_now ? t('activeUntil') : t('status')}
                  value={ok.activate_now && ok.expires_at ? formatDate(ok.expires_at, lang) : t('pendingLaunch')}
                  tone={ok.activate_now ? 'plain' : 'warn'}
                />
              </dl>
              {ok.shortfall_usd_cents > 0 && (
                <Link
                  to="/wallet"
                  className="mt-3 inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[13px] font-bold hover:bg-amber-500/15 transition-colors"
                >
                  <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
                </Link>
              )}
              {ok.upgrade_from_tier && <p className="mt-3 text-[12px] text-zinc-500 leading-relaxed">{t('upgradeCreditNote')}</p>}
              {!ok.activate_now && (
                <p className="mt-3 text-[12px] text-sky-300/90 leading-relaxed flex items-start gap-1.5">
                  <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                  <span>
                    {t('launchNote')}
                    {ok.launch_at || launch?.launch_at ? ` — ${formatDate(ok.launch_at ?? launch?.launch_at, lang)}` : ''}
                  </span>
                </p>
              )}
            </>
          ) : null}

          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button
              type="button"
              data-confirm-cancel
              onClick={onClose}
              disabled={busy}
              className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 disabled:opacity-50 transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              data-confirm-accept
              onClick={onConfirm}
              disabled={!canConfirm}
              className="flex-1 min-h-[48px] rounded-2xl bg-white text-black font-bold hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <Spinner size="sm" delayMs={0} decorative /> {t('working')}
                </>
              ) : ok && !ok.activate_now ? (
                t('confirmAndReserve')
              ) : (
                t('confirmAndPay')
              )}
            </button>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- result */}
      {phase === 'done' && result && (
        <>
          {result.kind === 'ok' ? (
            <div role="status" className="mt-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 px-4 py-3 text-[13px] text-emerald-200" data-confirm-result="ok">
              <p className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                <span>
                  {result.res.replay
                    ? t('alreadyRecorded')
                    : result.res.membership.state === 'active'
                      ? `${t('activeUntil')} ${formatDate(result.res.membership.expires_at, lang)}`
                      : result.res.membership.state === 'prepaid_pending_launch'
                        ? t('launchNote')
                        : `${t('status')}: ${membershipStateLabel(result.res.membership.state, lang)}`}
                </span>
              </p>
              {result.res.credit_iqd > 0 && (
                <p className="mt-1.5 ps-6 tabular-nums" dir="ltr">
                  {t('upgradeCredit')}: − {formatIqd(result.res.credit_iqd)}
                </p>
              )}
              {result.res.charged_iqd > 0 && (
                <p className="mt-1 ps-6 tabular-nums" dir="ltr">
                  {t('walletDebit')}: {formatIqd(result.res.charged_iqd)}
                  {result.res.charged_usd_cents > 0 ? ` (${formatUsdCents(result.res.charged_usd_cents)})` : ''}
                </p>
              )}
            </div>
          ) : (
            <div role="alert" className="mt-4 rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-[13px] text-red-200" data-confirm-result="err">
              <p className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                <span>{purchaseErrorText(result.code, result.message, lang)}</span>
              </p>
              {needsTopUp(result.code) && (
                <Link
                  to="/wallet"
                  className="mt-3 inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[13px] font-bold hover:bg-amber-500/15 transition-colors"
                >
                  <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
                </Link>
              )}
            </div>
          )}
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button
              type="button"
              data-confirm-close
              onClick={onClose}
              className="flex-1 min-h-[48px] rounded-2xl bg-white text-black font-bold hover:bg-zinc-200 transition-colors"
            >
              {t('close')}
            </button>
            {result.kind === 'err' && !refused && (
              <button
                type="button"
                data-confirm-retry
                onClick={onRetry}
                className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 transition-colors"
              >
                {t('retry')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  // A window that must be answered while the charge is in flight: no scrim or
  // Escape dismissal until the server has spoken.
  return phone ? (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      label={t('confirmPurchase')}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId="purchase-confirm"
      panelClassName="w-full sm:max-w-md max-h-[90dvh] overflow-y-auto"
    >
      {body}
    </Sheet>
  ) : (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      label={t('confirmPurchase')}
      anchor={anchor}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId="purchase-confirm"
      panelClassName="w-full max-w-md max-h-[90dvh] overflow-y-auto"
    >
      {body}
    </Overlay>
  );
}

export default PurchaseConfirm;
