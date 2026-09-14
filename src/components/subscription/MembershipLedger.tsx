/**
 * The member's own ledger — every membership row with its real state — and
 * the benefits an account review has paused, if any. Both come straight from
 * GET /api/memberships/mine.
 */
import React from 'react';
import { PauseCircle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatDate } from '../orders/format';
import { membershipStateLabel, tierLabel, tierMetaFor } from './tierMeta';
import type { ApiMembership } from './types';

export interface MembershipLedgerProps {
  memberships: ApiMembership[];
  gatedBenefits: string[];
}

/** Human names for the benefit flags a restriction case can pause. */
const BENEFIT_NAMES: Record<string, { ar: string; en: string; ckb: string }> = {
  proPricing: { ar: 'أسعار PRO', en: 'PRO prices', ckb: 'نرخەکانی PRO' },
  freeDelivery: { ar: 'التوصيل المجاني', en: 'Free delivery', ckb: 'گەیاندنی بێبەرامبەر' },
  noPreorderCommission: { ar: 'إعفاء رسوم الشحن', en: 'Shipping surcharge waiver', ckb: 'لێبوردنی زیادکراوی گەیاندن' },
  priorityService: { ar: 'أولوية الخدمة والدعم', en: 'Priority service and support', ckb: 'پێشینەی خزمەتگوزاری و پشتیوانی' },
  proExclusive: { ar: 'عروض PRO', en: 'PRO offers', ckb: 'ئۆفەرەکانی PRO' },
  merchantProfile: { ar: 'ملف التاجر', en: 'Merchant profile', ckb: 'پرۆفایلی بازرگان' },
  merchantStore: { ar: 'المتجر', en: 'Storefront', ckb: 'فرۆشگا' },
  merchantProducts: { ar: 'نشر المنتجات', en: 'Publishing products', ckb: 'بڵاوکردنەوەی بەرهەم' },
  merchantOrders: { ar: 'طلبات المتجر', en: 'Store orders', ckb: 'داواکارییەکانی فرۆشگا' },
  communityOffers: { ar: 'عروض المجتمع', en: 'Community offers', ckb: 'ئۆفەرەکانی کۆمەڵگە' },
  merchantAnalytics: { ar: 'تحليلات المتجر', en: 'Store analytics', ckb: 'شیکاری فرۆشگا' },
  merchantSubdomain: { ar: 'رابط المتجر الفرعي', en: 'Store subdomain', ckb: 'ژێردۆمەینی فرۆشگا' },
  exclusiveCoupons: { ar: 'كوبونات الأعضاء', en: 'Member coupons', ckb: 'کۆپۆنی ئەندامان' },
  exclusiveSections: { ar: 'الأقسام الحصرية', en: 'Exclusive sections', ckb: 'بەشە تایبەتەکان' },
  verifiedMerchant: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  proMerchantBadge: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  primeDeliveryEligible: { ar: 'توصيل PREMIUM المجاني', en: 'PREMIUM free delivery', ckb: 'گەیاندنی بێبەرامبەری PREMIUM' },
  premiumDelivery: { ar: 'توصيل PREMIUM المجاني', en: 'PREMIUM free delivery', ckb: 'گەیاندنی بێبەرامبەری PREMIUM' },
};

export function MembershipLedger({ memberships, gatedBenefits }: MembershipLedgerProps) {
  const { t, loc, lang } = useLanguage();

  // The words come from the shared table (tierMeta.ts) so the confirmation
  // window and this ledger can never name a state differently.
  const STATE_CLS: Record<string, string> = {
    active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    prepaid_pending_launch: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    pending_payment: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    expired: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40',
    cancelled: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  const stateChip = (state: string): { label: string; cls: string } => ({
    label: membershipStateLabel(state, lang),
    cls: STATE_CLS[state] ?? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40',
  });

  const nameOf = (flag: string) => {
    const n = BENEFIT_NAMES[flag];
    return n ? loc(n.ar, n.en, n.ckb) : flag;
  };

  if (memberships.length === 0 && gatedBenefits.length === 0) return null;

  return (
    <div className="space-y-4">
      {gatedBenefits.length > 0 && (
        <div data-gated-benefits className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 p-5">
          <h4 className="text-amber-200 font-bold text-[15px] flex items-center gap-2">
            <PauseCircle className="w-5 h-5" aria-hidden /> {t('pausedBenefits')}
          </h4>
          <p className="text-amber-200/80 text-[12.5px] mt-1.5 leading-relaxed">{t('pausedBenefitsNote')}</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {gatedBenefits.map((f) => (
              <li key={f} className="text-[12px] font-bold px-2.5 py-1 rounded-full bg-black/30 border border-amber-500/30 text-amber-100">
                {nameOf(f)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {memberships.length > 0 && (
        <div data-membership-ledger className="bg-zinc-900/40 border border-white/10 rounded-[24px] p-5">
          <h4 className="text-white font-bold text-[15px] mb-4">{t('membership')}</h4>
          <ul className="space-y-3">
            {memberships.map((m) => {
              const chip = stateChip(m.state);
              const meta = tierMetaFor(m.tier);
              return (
                <li key={m.id} className="flex items-center justify-between gap-3 text-[13px]">
                  <div className="min-w-0 flex items-center gap-2.5">
                    {meta && (
                      <span className={`shrink-0 w-8 h-8 rounded-xl border flex items-center justify-center ${meta.chip}`}>
                        <meta.Icon className="w-4 h-4" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0">
                      <span className="text-white font-bold">
                        <span className={meta ? meta.text : ''}>{tierLabel(m.tier)}</span> · {m.duration_months}{' '}
                        {m.duration_months === 1 ? t('month') : t('months')}
                      </span>
                      <p className="text-zinc-500 text-[11px] truncate">
                        {m.state === 'active' && m.expires_at
                          ? `${t('activeUntil')} ${formatDate(m.expires_at, lang)}`
                          : m.state === 'prepaid_pending_launch'
                            ? t('pendingLaunch')
                            : formatDate(m.purchased_at, lang)}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[11px] font-bold px-2 py-1 rounded-full border whitespace-nowrap shrink-0 ${chip.cls}`}>
                    {chip.label}
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
