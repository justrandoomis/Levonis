/**
 * The selected card, what it costs THIS account, and the one button.
 *
 * On a phone it floats above the navigation (the cart's `--nav-stack`
 * contract, so it never sits under the nav or its scrim) and the page pads
 * itself so the bar never covers content. From 1024px it is a sticky aside
 * beside the comparison. One element either way, so the confirmation window
 * always grows out of the button the customer actually pressed.
 *
 * EVERY FIGURE IS THE SERVER'S. The price is the plan's own; the credit, the
 * amount due, the wallet balance, the shortfall and the expiry come from
 * GET /api/memberships/quote, which runs the code the purchase will. They are
 * shown IN DINARS — the unit the price is quoted in and the unit /wallet
 * prints — so the balance here is the balance there (the owner's «يضاف كما هو
 * ولكن يحول الى الدولار وليس العكس»). A quote for another plan is never shown
 * under this one: it is treated as still loading.
 *
 * Every state is drawn: loading, a failed quote with a retry, a guest, a
 * price not announced, the current card (information, not an amber error), a
 * card already included in a higher one, a shortfall with the way to the
 * wallet, an upgrade credit, and ready.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { formatUsdCents } from '../../lib/api';
import { formatDate } from '../orders/format';
import Spinner from '../ui/Spinner';
import { CardArt } from './LevoCard';
import { TIER_META, durationLabel, durationSep, tierLabel } from './tierMeta';
import type { ApiPlan, PurchaseQuote } from './types';
import type { TierStanding } from './TierCards';
import { purchaseErrorText } from './purchaseErrors';

export interface CheckoutBarProps {
  plan: ApiPlan | null;
  standing: TierStanding;
  quote: PurchaseQuote | null;
  quoteLoading: boolean;
  quoteError: unknown;
  onRetryQuote: () => void;
  isGuest: boolean;
  busy: boolean;
  onSubscribe: () => void;
  ctaRef: React.RefObject<HTMLButtonElement | null>;
  currentExpiry: string | null;
}

/** The wallet figures in dinars; an older server's cents only as a fallback. */
export function hasShortfall(q: Extract<PurchaseQuote, { ok: true }>): boolean {
  return (q.shortfall_iqd ?? 0) > 0 || q.shortfall_usd_cents > 0;
}

function Row({ label, value, tone = 'plain' }: { label: React.ReactNode; value: React.ReactNode; tone?: 'plain' | 'muted' | 'credit' | 'warn' }) {
  const cls = tone === 'credit' ? 'text-success' : tone === 'warn' ? 'text-warning' : tone === 'muted' ? 'text-text-secondary' : 'text-text-primary';
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-text-muted text-[12.5px]">{label}</dt>
      <dd className={`text-[13px] font-semibold tabular-nums ${cls}`}>{value}</dd>
    </div>
  );
}

export function CheckoutBar({
  plan,
  standing,
  quote,
  quoteLoading,
  quoteError,
  onRetryQuote,
  isGuest,
  busy,
  onSubscribe,
  ctaRef,
  currentExpiry,
}: CheckoutBarProps) {
  const { t, loc, lang } = useLanguage();
  const { money } = useMoney();
  if (!plan) return null;

  const meta = TIER_META[plan.tier];
  const priced = plan.price_iqd !== null; // null = unpriced; 0 is a real price
  // A quote for a different plan is the previous selection's: never show it here.
  const q = quote && quote.plan?.id === plan.id ? quote : null;
  const ok = q && q.ok === true ? q : null;
  const refused = q && q.ok === false ? q : null;
  const short = !!ok && hasShortfall(ok);
  const loading = !isGuest && priced && !q && !quoteError;
  const current = refused?.code === 'ALREADY_SUBSCRIBED' || (!q && standing === 'current');
  const included = refused?.code === 'DOWNGRADE_BLOCKED' || (!q && standing === 'included');

  const ctaDisabled = busy || !priced || (!isGuest && (quoteLoading || !!quoteError || !ok || short));
  const ctaText = busy
    ? t('working')
    : !priced
      ? t('priceTBA')
      : isGuest
        ? t('signInToSubscribe')
        : current
          ? t('yourCurrentPlan')
          : included
            ? t('includedInYours')
            : t('subscribeNow');

  const balance = ok ? (ok.balance_iqd !== undefined ? money(ok.balance_iqd) : formatUsdCents(ok.balance_usd_cents)) : null;
  const shortfall = ok ? (ok.shortfall_iqd !== undefined ? money(ok.shortfall_iqd) : formatUsdCents(ok.shortfall_usd_cents)) : null;

  // One line that says where this account stands. On a desktop the ready
  // states are the list below instead, so the line is for the rest.
  let status: React.ReactNode = null;
  let statusTone = 'text-text-secondary';
  let statusDesktop = true;
  if (!priced) {
    status = t('subscribeDisabled');
  } else if (isGuest) {
    status = loc('يمكنك قراءة كل شيء هنا؛ الاشتراك يحتاج إلى حساب.', 'You can read everything here; subscribing needs an account.', 'دەتوانیت هەموو شتێک لێرە بخوێنیتەوە؛ بەشداریکردن هەژمارێک دەوێت.');
  } else if (quoteError && !q) {
    statusTone = 'text-warning';
    status = (
      <>
        {t('quoteFailed')}{' '}
        <button type="button" onClick={onRetryQuote} className="underline font-bold min-h-11 px-1">
          {t('retry')}
        </button>
      </>
    );
  } else if (loading || (quoteLoading && !q)) {
    status = (
      <span className="inline-flex items-center gap-1.5">
        <Spinner size="xs" delayMs={0} decorative /> {t('checkingQuote')}
      </span>
    );
  } else if (current) {
    statusTone = 'text-success';
    status = currentExpiry ? `${t('activeUntil')} ${formatDate(currentExpiry, lang)}` : t('yourCurrentPlan');
  } else if (refused) {
    status = purchaseErrorText(refused.code, refused.message, lang);
  } else if (ok && short) {
    statusTone = 'text-warning';
    status = `${t('shortfall')}: ${shortfall}`;
    statusDesktop = false;
  } else if (ok && ok.credit_iqd > 0) {
    status = `${t('amountDue')}: ${money(ok.charge_iqd)}`;
    statusDesktop = false;
  } else if (ok) {
    status = `${t('walletBalance')}: ${balance}`;
    statusDesktop = false;
  }

  return (
    <aside
      data-checkout-bar
      data-plan-summary
      aria-label={t('yourSelection')}
      className="fixed inset-x-3 sm:inset-x-0 sm:mx-auto sm:w-[min(36rem,calc(100%-1.5rem))] bottom-[calc(var(--nav-stack)+0.25rem)] z-[130] material rounded-2xl border border-border-subtle p-3 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.9)] lg:sticky lg:mx-0 lg:w-auto lg:bottom-auto lg:top-6 lg:z-auto lg:p-5 lg:rounded-[20px]"
    >
      <p className="hidden lg:block mb-3 text-[12px] font-semibold text-text-muted">{t('yourSelection')}</p>
      <div className="flex items-center gap-3">
        <CardArt tier={plan.tier} size="xs" className="lg:w-14 lg:h-[35px] lg:rounded-[7px]" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-text-primary truncate">
            <span className={meta.text} dir="ltr">
              {meta.label}
            </span>
            <span className="text-text-muted font-medium">
              {durationSep(lang)}
              {durationLabel(plan.duration_months, lang)}
            </span>
          </p>
          {status && (
            <p role="status" className={`text-[12px] leading-snug line-clamp-2 lg:line-clamp-none lg:mt-0.5 ${statusTone} ${statusDesktop ? '' : 'lg:hidden'}`}>
              {status}
            </p>
          )}
        </div>
        <p data-summary-price className="shrink-0 text-[16px] font-extrabold tabular-nums text-text-primary lg:hidden">
          {priced ? money(plan.price_iqd as number) : '—'}
        </p>
      </div>
      {/* From 1024px the price has the width to be the headline. */}
      <p className="hidden lg:block mt-3 text-[1.75rem] leading-tight font-extrabold tabular-nums text-text-primary">
        {priced ? money(plan.price_iqd as number) : t('priceTBA')}
      </p>

      {/* The server's answer for this account, in full — from 1024px. A <dl>
          holds dt/dd groups only; the notes and the way to the wallet follow. */}
      {ok && (
        <div className="hidden lg:block mt-3 border-t border-border-subtle/70">
          <dl className="divide-y divide-border-subtle/60" data-summary-quote>
            <Row label={t('price')} value={money(ok.price_iqd)} />
            {ok.credit_iqd > 0 && (
              <Row label={`${t('upgradeCredit')} (${tierLabel(ok.upgrade_from_tier)})`} value={`− ${money(ok.credit_iqd)}`} tone="credit" />
            )}
            {ok.credit_iqd > 0 && <Row label={t('amountDue')} value={money(ok.charge_iqd)} />}
            <Row label={t('walletBalance')} value={balance} tone="muted" />
            {short && <Row label={t('shortfall')} value={shortfall} tone="warn" />}
            {ok.activate_now && ok.expires_at && <Row label={t('activeUntil')} value={formatDate(ok.expires_at, lang)} />}
          </dl>
          {ok.upgrade_from_tier && <p className="pt-2 text-[11.5px] leading-relaxed text-text-muted">{t('upgradeCreditNote')}</p>}
        </div>
      )}

      <div className="mt-2.5 lg:mt-4 flex gap-2 lg:flex-col-reverse">
        {short && (
          <Link
            to="/wallet"
            data-top-up
            className="lv-button lv-button-secondary lv-button-sm shrink-0"
          >
            <Wallet className="w-4 h-4" aria-hidden /> {t('topUpWallet')}
          </Link>
        )}
        <button
          ref={ctaRef}
          type="button"
          data-subscribe-cta
          onClick={onSubscribe}
          disabled={ctaDisabled}
          aria-haspopup={isGuest ? undefined : 'dialog'}
          className="lv-button lv-button-primary flex-1 min-h-12 text-[15px]"
        >
          {ctaText}
        </button>
      </div>
    </aside>
  );
}

export default CheckoutBar;
