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
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatDate } from '../orders/format';
import { LevoCard } from './LevoCard';
import { isPaidTier, tierLabel, type AnyTier, type PaidTier } from './tierMeta';

export interface MemberHeaderProps {
  user: { id: string; name?: string | null; username?: string | null } | null;
  tier: AnyTier;
  expiresAt: string | null;
  /** A reservation still waiting for a human (legacy data only). */
  pending: { tier: PaidTier; duration_months: number } | null;
  onManage: () => void;
}

export function MemberHeader({ user, tier, expiresAt, pending, onManage }: MemberHeaderProps) {
  const { t, loc, lang } = useLanguage();
  const member = !!user && isPaidTier(tier);

  return (
    <header className="pt-6 sm:pt-10">
      {member && (
        <div className="mb-7 sm:mb-9 flex items-center gap-4 sm:gap-6">
          <LevoCard user={user!} tier={tier as PaidTier} />
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-text-muted">{t('yourMembership')}</p>
            <p className="mt-0.5 text-[1.05rem] sm:text-[1.25rem] font-extrabold text-text-primary">
              <span dir="ltr">{tierLabel(tier)}</span>
            </p>
            {expiresAt && (
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
