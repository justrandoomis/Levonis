/**
 * The selected-plan summary and the call to action — the right-hand column on
 * a desktop, the block under the cards on a phone.
 *
 * Every figure here is the SERVER's: the price is the plan's own, and the
 * upgrade credit, the wallet debit, the balance, the shortfall and the expiry
 * preview come from GET /api/memberships/quote, which runs the same code the
 * purchase will. While that quote is loading the rows say so; when it fails
 * they offer a retry — no number is ever estimated in the browser.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Clock, Wallet } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { formatUsdCents } from '../../lib/api';
import { formatDate } from '../orders/format';
import Spinner from '../ui/Spinner';
import { TIER_META, tierLabel } from './tierMeta';
import type { ApiPlan, LaunchInfo, PurchaseQuote } from './types';
import { purchaseErrorText } from './purchaseErrors';
import { useMoney } from '../../CurrencyContext';

export interface PlanSummaryProps {
  plan: ApiPlan | null;
  quote: PurchaseQuote | null;
  quoteLoading: boolean;
  quoteError: unknown;
  onRetryQuote: () => void;
  isGuest: boolean;
  launch: LaunchInfo | null;
  onSubscribe: () => void;
  ctaRef: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
}

function Row({ label, value, tone = 'plain' }: { label: React.ReactNode; value: React.ReactNode; tone?: 'plain' | 'muted' | 'negative' | 'warn' }) {
  const valueCls =
    tone === 'negative' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'muted' ? 'text-zinc-400' : 'text-white';
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-zinc-400 text-[12.5px]">{label}</dt>
      <dd className={`text-[13px] font-semibold tabular-nums ${valueCls}`} dir="ltr">
        {value}
      </dd>
    </div>
  );
}

export function PlanSummary({
  plan,
  quote,
  quoteLoading,
  quoteError,
  onRetryQuote,
  isGuest,
  launch,
  onSubscribe,
  ctaRef,
  busy,
}: PlanSummaryProps) {
  const { money } = useMoney();
  const { t, loc, lang } = useLanguage();
  const m = useMotion();

  if (!plan) return null;
  const meta = TIER_META[plan.tier];
  const priced = plan.price_iqd !== null;
  const ok = quote && quote.ok === true ? quote : null;
  const refused = quote && quote.ok === false ? quote : null;
  const preLaunch = launch ? !launch.activated : false;

  const ctaDisabled =
    busy || !priced || (!isGuest && (quoteLoading || !!quoteError || !!refused || (!!ok && ok.shortfall_usd_cents > 0)));

  const ctaText = !priced
    ? `${t('subscribeDisabled')} — ${t('priceTBA')}`
    : isGuest
      ? t('signInToSubscribe')
      : t('subscribeNow');

  return (
    <aside data-plan-summary className="rounded-[24px] border border-white/10 bg-zinc-900/50 p-5 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-white font-bold text-[15px]">{t('yourSelection')}</h4>
        <span className={`inline-flex items-center gap-1 text-[11px] font-black px-2 py-0.5 rounded-md border ${meta.chip}`}>
          <meta.Icon className="w-3.5 h-3.5" aria-hidden />
          {meta.label}
        </span>
      </div>

      {/* The price cross-fades on a change of plan: the row keeps its place,
          the number arrives. */}
      <div className="mt-3 min-h-[3.75rem] relative">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={plan.id}
            initial={{ opacity: 0, y: m.travel(6) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.travel(-6) }}
            transition={m.spring('quick')}
            className="flex items-end justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="text-zinc-300 text-[13px]">
                {plan.duration_months} {plan.duration_months === 1 ? t('month') : t('months')}
              </p>
              {priced && plan.duration_months > 1 && plan.per_month_iqd !== null && (
                <p className="text-zinc-500 text-[11.5px] tabular-nums" dir="ltr">
                  {money(plan.per_month_iqd)} / {t('month')}
                </p>
              )}
            </div>
            <p
              className={`font-black text-[26px] leading-none tabular-nums whitespace-nowrap ${priced ? 'text-white' : 'text-amber-400 text-[16px]'}`}
              dir="ltr"
              data-summary-price
            >
              {priced ? money(plan.price_iqd as number) : t('priceTBA')}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* The server's answer for this account. */}
      {!isGuest && priced && (
        <div className="mt-3 border-t border-white/5">
          {quoteLoading && !quote ? (
            <p className="py-3 text-[12.5px] text-zinc-400 flex items-center gap-2">
              <Spinner size="xs" delayMs={0} decorative /> {t('checkingQuote')}
            </p>
          ) : quoteError && !quote ? (
            <p className="py-3 text-[12.5px] text-amber-300 flex items-center justify-between gap-2">
              <span>{t('quoteFailed')}</span>
              <button type="button" onClick={onRetryQuote} className="underline font-bold min-h-[32px] px-1">
                {t('retry')}
              </button>
            </p>
          ) : refused ? (
            <p className="py-3 text-[12.5px] text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>{purchaseErrorText(refused.code, refused.message, lang)}</span>
            </p>
          ) : ok ? (
            <>
              {/* A <dl> holds dt/dd groups only; the notes and the way to the
                  wallet follow it below. */}
              <dl className="divide-y divide-white/5" data-summary-quote>
                {ok.credit_iqd > 0 && (
                  <Row
                    label={`${t('upgradeCredit')} (${tierLabel(ok.upgrade_from_tier)})`}
                    value={`− ${money(ok.credit_iqd)}`}
                    tone="negative"
                  />
                )}
                {ok.credit_iqd > 0 && <Row label={t('amountDue')} value={money(ok.charge_iqd)} />}
                <Row
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
                <Row label={t('walletBalance')} value={formatUsdCents(ok.balance_usd_cents)} tone="muted" />
                {ok.shortfall_usd_cents > 0 && (
                  <Row label={t('shortfall')} value={formatUsdCents(ok.shortfall_usd_cents)} tone="warn" />
                )}
                <Row
                  label={ok.activate_now ? t('activeUntil') : t('status')}
                  value={ok.activate_now && ok.expires_at ? formatDate(ok.expires_at, lang) : t('pendingLaunch')}
                  tone={ok.activate_now ? 'plain' : 'warn'}
                />
              </dl>
              {ok.shortfall_usd_cents > 0 && (
                <Link
                  to="/wallet"
                  className="mt-2 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[12.5px] font-bold hover:bg-amber-500/15 transition-colors"
                >
                  <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
                </Link>
              )}
              {ok.upgrade_from_tier && (
                <p className="py-2 text-[11.5px] text-zinc-500 leading-relaxed">{t('upgradeCreditNote')}</p>
              )}
            </>
          ) : null}
        </div>
      )}

      <button
        ref={ctaRef}
        type="button"
        data-subscribe-cta
        onClick={onSubscribe}
        disabled={ctaDisabled}
        aria-haspopup="dialog"
        className={`mt-4 w-full min-h-14 rounded-2xl font-black text-[16px] transition-colors ${
          !priced
            ? 'bg-zinc-800 text-zinc-500 border border-zinc-700 cursor-not-allowed'
            : 'bg-white text-black hover:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed'
        }`}
        style={priced ? { boxShadow: `0 0 28px ${meta.hex}33` } : undefined}
      >
        {busy ? t('working') : ctaText}
      </button>

      {/* Honest pre-launch note: paid cards are reserved, not started. */}
      {preLaunch && (
        <p className="mt-3 text-center text-[12px] text-sky-300/80 flex items-center justify-center gap-1.5">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden />
          {t('launchNote')}
          {launch?.launch_at ? ` — ${formatDate(launch.launch_at, lang)}` : ''}
        </p>
      )}
      {isGuest && priced && (
        <p className="mt-3 text-center text-[12px] text-zinc-500">
          {loc('يمكنك قراءة كل شيء هنا؛ الاشتراك يحتاج إلى حساب.', 'You can read everything here; subscribing needs an account.', 'دەتوانیت هەموو شتێک لێرە بخوێنیتەوە؛ بەشداریکردن هەژمارێک دەوێت.')}
        </p>
      )}
    </aside>
  );
}

export default PlanSummary;
