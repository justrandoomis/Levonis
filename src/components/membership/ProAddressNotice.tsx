/**
 * «الخصم لا يعمل بالرغم من الاشتراك بالبرو».
 *
 * PRO purchase benefits — the PRO price and the free delivery — apply only at
 * the member's APPROVED default address (entitlements.ts `pricingTierContext`,
 * the owner's rule, kept on 2026-09-24). The server already prices a PRO
 * member without one at the regular price, and says so in
 * `pro_benefits_context: false`; nothing on screen said why, so a paid PRO
 * member saw the ordinary price and read it as a broken discount.
 *
 * One quiet line, in PRO's colour, where the price is read, with the way to
 * fix it: the subscription page, where the address is sent for approval.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export default function ProAddressNotice({ className = '' }: { className?: string }) {
  const { loc } = useLanguage();
  return (
    <p
      data-pro-address-notice
      className={`flex items-start gap-2 rounded-xl border border-[#B03142]/30 bg-[#B03142]/10 px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary ${className}`}
    >
      <Sparkles aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[#e06070]" />
      <span>
        {loc(
          'سعر PRO والتوصيل المجاني يُطبَّقان على عنوانك المعتمد فقط.',
          'PRO prices and free delivery apply at your approved address only.'
        )}{' '}
        <Link to="/addresses" className="font-bold text-[#e06070] underline underline-offset-2">
          {loc('اعتمد عنوانك', 'Get your address approved')}
        </Link>
      </span>
    </p>
  );
}
