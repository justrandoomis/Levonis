import { Sparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * Active-PRO merchant status. This is intentionally not a verification/KYC
 * mark: the blue/gold BadgeCheck remains the store moderation identity, while
 * this premium red-gold pill follows the membership entitlement returned by
 * the server and disappears immediately on expiry/cancellation.
 */
export default function ProMerchantBadge({ compact = false }: { compact?: boolean }) {
  const { loc } = useLanguage();
  const label = loc('تاجر PRO', 'PRO merchant', 'بازرگانی PRO');
  return (
    <span
      data-pro-merchant-badge
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center rounded-full border border-[#f0c86a]/55 bg-gradient-to-r from-[#7f1d2d] via-[#b03142] to-[#7a5a19] text-[#fff4cf] shadow-[0_0_18px_rgba(176,49,66,0.24)] ${
        compact ? 'gap-1 px-1.5 py-0.5 text-[9px]' : 'gap-1.5 px-2.5 py-1 text-[10px]'
      } font-black tracking-[0.13em]`}
    >
      <Sparkles className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.5} aria-hidden="true" />
      PRO
    </span>
  );
}
