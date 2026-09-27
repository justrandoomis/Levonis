/**
 * The top of /subscription: who you are here, before anything is offered.
 *
 * A member sees their own card, small, with the tier and «فعّالة حتى {date}»
 * and the way down to «عضويتك». Everyone else — a guest, a signed-in account
 * with no membership — sees the title and one line of what a card is, and no
 * empty card: a blank card with a placeholder number looks like an account
 * they do not have.
 */
import React from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatDate } from '../orders/format';
import { LevoCard } from './LevoCard';
import { PRO_PAUSE_WORDS, daysKeptLabel, isPaidTier, tierLabel, type AnyTier, type PaidTier } from './tierMeta';
import type { PausedMembership } from './types';

export interface MemberHeaderProps {
  user: { id: string; name?: string | null; username?: string | null } | null;
  tier: AnyTier;
  expiresAt: string | null;
  /** A reservation still waiting for a human (legacy data only). */
  pending: { tier: PaidTier; duration_months: number } | null;
  /**
   * The member's PRO card, frozen while PRO is paused (0145). The header then
   * shows the PRO card they own — not the PREMIUM it acts as meanwhile — and
   * the owner's own words about it.
   */
  paused?: PausedMembership | null;
  onManage: () => void;
}

export function MemberHeader({ user, tier, expiresAt, pending, paused = null, onManage }: MemberHeaderProps) {
  const { t, loc, lang } = useLanguage();
  const member = !!user && (isPaidTier(tier) || !!paused);
  const shownTier: PaidTier | null = paused ? 'pro' : isPaidTier(tier) ? tier : null;

  return (
    <header className="pt-6 sm:pt-10">
      {member && (
        <div className="mb-7 sm:mb-9 flex items-center gap-4 sm:gap-6">
          <LevoCard user={user!} tier={shownTier as PaidTier} />
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-text-muted">{t('yourMembership')}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[1.05rem] sm:text-[1.25rem] font-extrabold text-text-primary">
              <span dir="ltr">{tierLabel(shownTier)}</span>
              {paused && (
                <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-bold text-warning">
                  <Wrench className="h-3 w-3" aria-hidden />
                  {loc('صيانة', 'Maintenance', 'چاککردنەوە')}
                </span>
              )}
            </p>
            {paused && (
              <div role="status" data-pro-paused className="mt-1 max-w-md space-y-0.5">
                <p className="text-[12.5px] sm:text-[13.5px] leading-relaxed text-text-primary">
                  {loc(PRO_PAUSE_WORDS.maintenance.ar, PRO_PAUSE_WORDS.maintenance.en, PRO_PAUSE_WORDS.maintenance.ckb)}
                </p>
                <p className="text-[12px] text-text-secondary">
                  {paused.remaining_days !== null && (
                    <span className="font-semibold text-text-primary tabular-nums">{daysKeptLabel(paused.remaining_days, lang)}</span>
                  )}
                  {paused.remaining_days !== null && ' · '}
                  {loc(PRO_PAUSE_WORDS.meanwhile.ar, PRO_PAUSE_WORDS.meanwhile.en, PRO_PAUSE_WORDS.meanwhile.ckb)}
                </p>
              </div>
            )}
            {expiresAt && !paused && (
              <p className="text-[12.5px] sm:text-[13.5px] text-text-secondary">
                {t('activeUntil')} {formatDate(expiresAt, lang)}
              </p>
            )}
            <button
              type="button"
              onClick={onManage}
              className="mt-0.5 -ms-2 inline-flex items-center gap-1 min-h-11 px-2 rounded-lg text-[12.5px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {loc('التفاصيل', 'Details', 'وردەکاری')} <ChevronDown className="w-4 h-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
      <h1 id="choose-card-title" className="text-[1.6rem] sm:text-[2.1rem] font-extrabold leading-[1.2] text-text-primary">
        {t('chooseCard')}
      </h1>
      {!member && (
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-text-secondary">
          {loc(
            'بطاقة واحدة تُدفع من محفظتك، ومزاياها تبدأ لحظة الاشتراك وتُطبَّق على كل طلب.',
            'One card, paid from your wallet. Its benefits start the moment you subscribe and apply to every order.'
          )}
        </p>
      )}
      {pending && (
        <p data-pending-activation className="mt-2 text-[12.5px] text-warning">
          {tierLabel(pending.tier)} — {t('pendingActivation')}
        </p>
      )}
    </header>
  );
}

export default MemberHeader;
