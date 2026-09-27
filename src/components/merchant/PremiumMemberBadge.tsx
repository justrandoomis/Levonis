import { Crown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * «شارة مميزة في مجتمع ليفو» — PREMIUM's own mark (owner, 2026-09-27;
 * migration 0145). It follows the membership entitlement the server returns
 * (`premium_badge`) and disappears on expiry exactly as the PRO badge does. A
 * PRO member never carries both: the server sends the highest one alone.
 *
 * The PRO badge's shape and size, in PREMIUM's gold (tierMeta.ts), so the two
 * read as one family and the tier is told by colour and word, never by a
 * second kind of object.
 */
export default function PremiumMemberBadge({ compact = false }: { compact?: boolean }) {
  const { loc } = useLanguage();
  const label = loc('عضو PREMIUM', 'PREMIUM member', 'ئەندامی PREMIUM');
  return (
    <span
      data-premium-member-badge
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center rounded-full border border-gold-muted/55 bg-gradient-to-r from-[#5b4d22] via-[#7A6836] to-[#9c8a55] text-cream ${
        compact ? 'gap-1 px-1.5 py-0.5 text-[9px]' : 'gap-1.5 px-2.5 py-1 text-[10px]'
      } font-black tracking-[0.13em]`}
    >
      <Crown className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.5} aria-hidden="true" />
      PREMIUM
    </span>
  );
}
