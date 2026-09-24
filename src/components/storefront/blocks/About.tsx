/**
 * ABOUT — the store's own story, from its settings: description, specialities,
 * coverage, delivery, hours, contact, policies, links and its date on Levonis.
 * The classic About tab, and a stacked block.
 */
import { useMemo } from 'react';
import { Clock, MapPin } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { BlockHeading, Column, deliveryNote, Section, sinceLine, useText } from '../parts';
import type { BlockProps, StorefrontStore } from '../types';

export function AboutView({ store, showPolicies = true, showHours = true }: { store: StorefrontStore; showPolicies?: boolean; showHours?: boolean }) {
  const { loc, lang } = useLanguage();
  const policies = useMemo(() => Object.entries(store.policies ?? {}), [store.policies]);
  // The server reduced these to http(s) URLs on the way in; the scheme is
  // checked again here so no other kind of address can reach an href.
  const socials = useMemo(
    () => Object.entries(store.social_links ?? {}).filter(([, v]) => typeof v === 'string' && /^https?:\/\//i.test(v)),
    [store.social_links]
  );
  const note = deliveryNote(store);
  const hours = store.business_hours ?? [];

  return (
    <div className="space-y-3">
      {store.description && (
        <Section title={loc('عن المتجر', 'About the store', 'دەربارەی فرۆشگا')}>
          <p className="text-zinc-300 text-[12.5px] leading-relaxed whitespace-pre-wrap">{store.description}</p>
        </Section>
      )}

      {(store.categories?.length ?? 0) > 0 && (
        <Section title={loc('التخصصات', 'Specialities', 'پسپۆڕییەکان')}>
          <div className="flex flex-wrap gap-1.5">
            {store.categories.map((cat) => (
              <span key={cat} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300">
                {cat}
              </span>
            ))}
          </div>
        </Section>
      )}

      {(store.service_areas?.length ?? 0) > 0 && (
        <Section title={loc('مناطق التغطية', 'Service areas', 'ناوچەکانی گەیاندن')}>
          <div className="flex flex-wrap gap-1.5">
            {store.service_areas.map((a) => (
              <span key={a} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-zinc-500" aria-hidden="true" />
                {a}
              </span>
            ))}
          </div>
        </Section>
      )}

      {note && (
        <Section title={loc('التوصيل', 'Delivery', 'گەیاندن')}>
          <p className="text-zinc-300 text-[12.5px] leading-relaxed">{note}</p>
        </Section>
      )}

      {showHours && hours.length > 0 && (
        <Section title={loc('ساعات العمل', 'Business hours', 'کاتژمێری کارکردن')}>
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
        </Section>
      )}

      {store.contact_phone && (
        <Section title={loc('التواصل', 'Contact', 'پەیوەندی')}>
          <a href={`tel:${store.contact_phone.replace(/[^\d+]/g, '')}`} className="text-gold text-[13px] font-semibold" dir="ltr">
            {store.contact_phone}
          </a>
        </Section>
      )}

      {showPolicies && policies.length > 0 && (
        <Section title={loc('سياسات المتجر', 'Store policies', 'سیاسەتەکانی فرۆشگا')}>
          <div className="space-y-2.5">
            {policies.map(([k, v]) => (
              <div key={k}>
                <p className="text-zinc-400 text-[11.5px] font-semibold mb-0.5">{k}</p>
                <p className="text-zinc-300 text-[12px] leading-relaxed whitespace-pre-wrap">{v}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {socials.length > 0 && (
        <Section title={loc('روابط', 'Links', 'بەستەرەکان')}>
          <div className="flex flex-wrap gap-2">
            {socials.map(([k, v]) => (
              <a
                key={k}
                href={v}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-[11.5px] px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300"
              >
                {k}
              </a>
            ))}
          </div>
        </Section>
      )}

      {store.created_at && <p className="text-zinc-600 text-[11px] text-center pt-1">{sinceLine(store.created_at, loc, lang)}</p>}
    </div>
  );
}

export default function AboutBlock({ block, store }: BlockProps<'about'>) {
  const text = useText();
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      <AboutView store={store} showPolicies={block.settings.show_policies} showHours={block.settings.show_hours} />
    </Column>
  );
}
