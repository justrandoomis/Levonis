/**
 * The purchase confirmation window.
 *
 * A Sheet on a phone, a window that grows out of the Subscribe button from
 * 640px up. It states the server's quote IN DINARS — the price, any upgrade
 * credit and the amount due, the wallet balance and, when it falls short, the
 * shortfall with the way to the wallet — and the expiry the membership will
 * run to. The dollar debit the wallet records is one quiet line under it: the
 * ledger keeps cents, the customer thinks in dinars (migration 0108).
 *
 * The site is live, so there is no reservation branch: confirming pays, and
 * the membership runs from that moment.
 *
 * The RESULT stays in the window until the person closes it: the new card
 * with «فعّالة حتى {date}», or a refusal in their language. A retry after an
 * error reuses the same idempotency key (the page owns it), so a flaky network
 * can never charge twice.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { AlertTriangle, Wallet } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { formatUsdCents } from '../../lib/api';
import { formatDate } from '../orders/format';
import { Overlay, Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { CardArt } from './LevoCard';
import { TIER_META, durationLabel, durationSep, membershipStateLabel, tierLabel } from './tierMeta';
import type { ApiPlan, PurchaseQuote, PurchaseResult } from './types';
import { needsTopUp, purchaseErrorText } from './purchaseErrors';
import { hasShortfall } from './CheckoutBar';
import { useMoney } from '../../CurrencyContext';

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
}

function Fact({ label, value, tone = 'plain' }: { label: React.ReactNode; value: React.ReactNode; tone?: 'plain' | 'credit' | 'warn' | 'muted' | 'strong' }) {
  const cls =
    tone === 'credit'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warning'
        : tone === 'muted'
          ? 'text-text-secondary'
          : tone === 'strong'
            ? 'text-text-primary text-[15px] font-bold'
            : 'text-text-primary';
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <dt className="text-text-muted text-[13px]">{label}</dt>
      <dd className={`text-[13.5px] font-semibold tabular-nums text-end ${cls}`}>{value}</dd>
    </div>
  );
}

export function PurchaseConfirm(props: PurchaseConfirmProps) {
  const { money } = useMoney();
  const { open, onClose, plan, quote, quoteLoading, quoteError, onRetryQuote, phase, result, quoteChanged, onConfirm, onRetry, anchor } = props;
  const { t, lang, dir } = useLanguage();
  const m = useMotion();
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
  // A quote for another plan is the previous selection's: it is never shown here.
  const q = quote && quote.plan?.id === plan.id ? quote : null;
  const ok = q && q.ok === true ? q : null;
  const refused = q && q.ok === false ? q : null;
  const short = !!ok && hasShortfall(ok);
  const canConfirm = !!ok && !short && !busy;

  const body = (
    <div dir={dir} data-purchase-confirm className="p-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3">
        <CardArt tier={plan.tier} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-text-primary font-bold text-base sm:text-lg outline-none">
            {phase === 'done' && result ? (result.kind === 'ok' ? t('purchaseDone') : t('purchaseFailed')) : t('confirmPurchase')}
          </h2>
          <p className="text-text-secondary text-[13px] mt-0.5">
            <span className={`font-extrabold ${meta.text}`} dir="ltr">
              {meta.label}
            </span>
            {durationSep(lang)}
            {durationLabel(plan.duration_months, lang)}
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------------- review */}
      {phase !== 'done' && (
        <>
          {quoteChanged && ok && (
            <p role="status" data-quote-changed className="mt-4 lv-alert lv-alert-warning text-[12.5px] text-text-primary flex items-start gap-2 leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden />
              <span>{t('quoteChangedNotice')}</span>
            </p>
          )}
          {quoteLoading && !q ? (
            <p role="status" className="mt-4 text-[13px] text-text-secondary flex items-center gap-2">
              <Spinner size="sm" delayMs={0} decorative /> {t('checkingQuote')}
            </p>
          ) : quoteError && !q ? (
            <div className="mt-4 lv-alert lv-alert-warning text-[13px] text-text-primary flex items-center justify-between gap-3">
              <span>{t('quoteFailed')}</span>
              <button type="button" onClick={onRetryQuote} className="underline font-bold min-h-11 px-1">
                {t('retry')}
              </button>
            </div>
          ) : refused ? (
            <div className="mt-4 lv-alert lv-alert-warning text-[13px] text-text-primary flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden />
              <span>{purchaseErrorText(refused.code, refused.message, lang)}</span>
            </div>
          ) : ok ? (
            <>
              <dl className="mt-4 lv-surface divide-y divide-border-subtle/70" data-confirm-facts>
                <Fact label={t('price')} value={money(ok.price_iqd)} tone={ok.credit_iqd > 0 ? 'plain' : 'strong'} />
                {ok.credit_iqd > 0 && (
                  <Fact label={`${t('upgradeCredit')} (${tierLabel(ok.upgrade_from_tier)})`} value={`− ${money(ok.credit_iqd)}`} tone="credit" />
                )}
                {ok.credit_iqd > 0 && <Fact label={t('amountDue')} value={money(ok.charge_iqd)} tone="strong" />}
                <Fact
                  label={t('walletBalance')}
                  value={ok.balance_iqd !== undefined ? money(ok.balance_iqd) : formatUsdCents(ok.balance_usd_cents)}
                  tone="muted"
                />
                {short && (
                  <Fact
                    label={t('shortfall')}
                    value={ok.shortfall_iqd !== undefined ? money(ok.shortfall_iqd) : formatUsdCents(ok.shortfall_usd_cents)}
                    tone="warn"
                  />
                )}
                {ok.expires_at && <Fact label={t('activeUntil')} value={formatDate(ok.expires_at, lang)} />}
              </dl>
              {/* The ledger's own unit, stated once and quietly. */}
              {ok.charge_usd_cents > 0 && (
                <p data-usd-line className="mt-2 px-1 text-[11.5px] text-text-muted tabular-nums">
                  {t('walletDebit')}: <span dir="ltr">{formatUsdCents(ok.charge_usd_cents)}</span> · {t('exchangeRateLabel')}{' '}
                  <span dir="ltr">1 USD = {ok.exchange_rate.toLocaleString('en-US')} IQD</span>
                </p>
              )}
              {short && (
                <Link to="/wallet" className="mt-3 lv-button lv-button-secondary lv-button-sm">
                  <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
                </Link>
              )}
              {ok.upgrade_from_tier && <p className="mt-3 text-[12px] text-text-muted leading-relaxed">{t('upgradeCreditNote')}</p>}
            </>
          ) : null}

          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button type="button" data-confirm-cancel onClick={onClose} disabled={busy} className="lv-button lv-button-secondary flex-1 min-h-12">
              {t('cancel')}
            </button>
            <button type="button" data-confirm-accept onClick={onConfirm} disabled={!canConfirm} className="lv-button lv-button-primary flex-1 min-h-12">
              {busy ? (
                <>
                  <Spinner size="sm" delayMs={0} decorative /> {t('working')}
                </>
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
            <div role="status" data-confirm-result="ok" className="mt-5 flex flex-col items-center text-center">
              <motion.div
                initial={{ opacity: 0, y: m.travel(14), scale: m.reduced ? 1 : 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={m.spring('ui')}
              >
                <CardArt tier={plan.tier} size="lg" />
              </motion.div>
              <p className="mt-4 text-[15px] font-bold text-text-primary">
                {result.res.replay
                  ? t('alreadyRecorded')
                  : result.res.membership.state === 'active'
                    ? `${t('activeUntil')} ${formatDate(result.res.membership.expires_at, lang)}`
                    : `${t('status')}: ${membershipStateLabel(result.res.membership.state, lang)}`}
              </p>
              {result.res.credit_iqd > 0 && (
                <p className="mt-1 text-[12.5px] text-text-secondary tabular-nums">
                  {t('upgradeCredit')}: − {money(result.res.credit_iqd)}
                </p>
              )}
              {result.res.charged_iqd > 0 && (
                <p className="mt-1 text-[12.5px] text-text-secondary tabular-nums">
                  {t('walletDebit')}: {money(result.res.charged_iqd)}
                </p>
              )}
            </div>
          ) : (
            <div role="alert" data-confirm-result="err" className="mt-4 lv-alert lv-alert-danger text-[13px] text-text-primary">
              <p className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-danger" aria-hidden />
                <span>{purchaseErrorText(result.code, result.message, lang)}</span>
              </p>
              {needsTopUp(result.code) && (
                <Link to="/wallet" className="mt-3 lv-button lv-button-secondary lv-button-sm">
                  <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
                </Link>
              )}
            </div>
          )}
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button type="button" data-confirm-close onClick={onClose} className="lv-button lv-button-primary flex-1 min-h-12">
              {t('close')}
            </button>
            {result.kind === 'err' && !refused && (
              <button type="button" data-confirm-retry onClick={onRetry} className="lv-button lv-button-secondary flex-1 min-h-12">
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
