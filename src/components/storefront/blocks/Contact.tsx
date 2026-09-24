/**
 * CONTACT — how to reach the store: its published phone (only if the merchant
 * published it — the server sends nothing otherwise), its hours, its city, and
 * the real conversation.
 */
import { Clock, MapPin, MessageCircle, Phone } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, governorateLabel, useText } from '../parts';
import type { BlockProps } from '../types';

export default function ContactBlock({ block, store }: BlockProps<'contact'>) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const text = useText();
  const rt = useStorefrontRuntime();
  const phone = s.show_phone && store.contact_phone ? store.contact_phone : '';
  const hours = s.show_hours ? (store.business_hours ?? []) : [];
  const place = s.show_location && store.governorate ? governorateLabel(store.governorate, lang) : '';
  if (!phone && !hours.length && !place && !s.show_chat) return null;
  return (
    <Column>
      <BlockHeading title={text(s.title) || loc('تواصل معنا', 'Get in touch')} />
      <div className="sf-card sf-card-pad space-y-3">
        {place && (
          <p className="flex items-center gap-2 text-zinc-300 text-[13px]">
            <MapPin className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
            {place}
          </p>
        )}
        {phone && (
          <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-2 text-gold text-[13px] font-semibold min-h-[32px]">
            <Phone className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span dir="ltr">{phone}</span>
          </a>
        )}
        {hours.length > 0 && (
          <div className="space-y-1.5">
            {hours.map((h, i) => (
              <div key={i} className="flex items-center justify-between text-[12px]">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                  {typeof h === 'string' ? h : h.day}
                </span>
                {typeof h !== 'string' && (
                  <span className="text-zinc-300" dir="ltr">
                    {h.open} – {h.close}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {s.show_chat && (
          <rt.ChatButton className="w-full min-h-[44px] rounded-xl border border-white/10 bg-white/[0.03] text-zinc-100 font-bold text-[13px] flex items-center justify-center gap-1.5">
            <MessageCircle className="w-4 h-4" aria-hidden="true" />
            {loc('مراسلة المتجر', 'Message the store', 'نامە بۆ فرۆشگا')}
          </rt.ChatButton>
        )}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
