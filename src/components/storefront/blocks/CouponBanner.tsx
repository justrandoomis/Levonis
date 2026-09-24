/**
 * COUPON — a code the merchant advertises. It renders only while the coupon is
 * usable (active, started, not expired, uses left — the server reads it so),
 * so a page never advertises a code checkout would refuse.
 */
import { useState } from 'react';
import { Check, Copy, TicketPercent } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { iqd } from '../../../lib/merchant';
import { useStorefrontRuntime } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { Column, useText } from '../parts';
import type { BlockProps } from '../types';

export default function CouponBannerBlock({ block, data }: BlockProps<'coupon_banner'>) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const text = useText();
  const rt = useStorefrontRuntime();
  const { accent } = useStoreTheme();
  const [copied, setCopied] = useState(false);
  const coupon = data.coupons.find((c) => c.id === s.coupon_id);
  if (!coupon) return null;
  const off = coupon.kind === 'percent' ? `${coupon.value}%` : iqd(coupon.value);
  const ends = coupon.ends_at ? new Date(coupon.ends_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', { day: 'numeric', month: 'long' }) : '';

  async function copy() {
    if (rt.mode !== 'live') return;
    try {
      await navigator.clipboard.writeText(coupon!.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the code is on screen to type */
    }
  }

  return (
    <Column>
      <div className="sf-card sf-card-pad flex items-center gap-3">
        <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${accent.chip}`}>
          <TicketPercent className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-white text-[14px] font-bold" dir="auto">
            {text(s.title) || loc(`خصم ${off}`, `${off} off`)}
          </p>
          <p className="text-zinc-400 text-[11.5px] leading-snug" dir="auto">
            {text(s.note) ||
              [
                coupon.min_total_iqd > 0 ? loc(`للطلبات من ${iqd(coupon.min_total_iqd)}`, `On orders from ${iqd(coupon.min_total_iqd)}`) : '',
                ends ? loc(`حتى ${ends}`, `Until ${ends}`) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 min-h-[44px] px-3 rounded-xl border border-dashed border-white/25 text-white text-[13px] font-bold tracking-wide inline-flex items-center gap-1.5"
          aria-label={loc(`نسخ الكود ${coupon.code}`, `Copy the code ${coupon.code}`)}
        >
          <span dir="ltr" translate="no">
            {coupon.code}
          </span>
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />}
        </button>
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
