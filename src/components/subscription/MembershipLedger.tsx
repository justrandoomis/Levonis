/**
 * The member's own ledger — every membership row with its real state — and
 * the benefits an account review has paused, if any. Both come straight from
 * GET /api/memberships/mine.
 */
import React from 'react';
import { PauseCircle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatDate } from '../orders/format';
import { ENTITLEMENT_LABELS, durationLabel, durationSep, membershipStateLabel, tierLabel, tierMetaFor } from './tierMeta';
import type { ApiMembership } from './types';

export interface MembershipLedgerProps {
  memberships: ApiMembership[];
  gatedBenefits: string[];
}

// The words come from the shared table (tierMeta.ts) so the confirmation
// window and this ledger can never name a state differently. Colour is the
// semantic set: success for running, warning for waiting, neutral for over.
const STATE_CLS: Record<string, string> = {
  active: 'text-success',
  prepaid_pending_launch: 'text-warning',
  pending_payment: 'text-warning',
  expired: 'text-text-muted',
  cancelled: 'text-text-muted',
};

export function MembershipLedger({ memberships, gatedBenefits }: MembershipLedgerProps) {
  const { t, loc, lang } = useLanguage();

  const nameOf = (flag: string) => {
    const n = ENTITLEMENT_LABELS[flag];
    return n ? loc(n.ar, n.en, n.ckb) : flag;
  };

  if (memberships.length === 0 && gatedBenefits.length === 0) return null;

  return (
    <div className="space-y-4">
      {gatedBenefits.length > 0 && (
        <div data-gated-benefits className="lv-alert lv-alert-warning">
          <h4 className="text-text-primary font-bold text-[14px] flex items-center gap-2">
            <PauseCircle className="w-4 h-4 text-warning" aria-hidden /> {t('pausedBenefits')}
          </h4>
          <p className="text-text-secondary text-[12.5px] mt-1 leading-relaxed">{t('pausedBenefitsNote')}</p>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {gatedBenefits.map((f) => (
              <li key={f} className="text-[12px] font-semibold px-2.5 py-1 rounded-full bg-surface-raised border border-border-subtle text-text-primary">
                {nameOf(f)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {memberships.length > 0 && (
        <div data-membership-ledger className="lv-surface">
          <h4 className="px-4 pt-3.5 pb-2 text-text-secondary font-semibold text-[13px]">{t('membership')}</h4>
          <ul className="divide-y divide-border-subtle/70">
            {memberships.map((m) => {
              const meta = tierMetaFor(m.tier);
              return (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
                  <div className="min-w-0 flex items-center gap-2.5">
                    {meta && <meta.Icon className={`w-4 h-4 shrink-0 ${meta.text}`} aria-hidden />}
                    <div className="min-w-0">
                      <p className="text-text-primary font-semibold">
                        {tierLabel(m.tier)}
                        <span className="text-text-muted font-normal">
                          {durationSep(lang)}
                          {durationLabel(m.duration_months, lang)}
                        </span>
                      </p>
                      <p className="text-text-muted text-[11.5px] truncate">
                        {m.state === 'active' && m.expires_at
                          ? `${t('activeUntil')} ${formatDate(m.expires_at, lang)}`
                          : m.state === 'prepaid_pending_launch'
                            ? t('pendingActivation')
                            : formatDate(m.purchased_at, lang)}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[12px] font-semibold whitespace-nowrap shrink-0 ${STATE_CLS[m.state] ?? 'text-text-muted'}`}>
                    {membershipStateLabel(m.state, lang)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default MembershipLedger;
