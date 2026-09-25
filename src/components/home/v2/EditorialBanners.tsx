import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import type { EditorialCard } from '../../../lib/homeLayout';
import { ArrowGlyph } from './SectionHead';
import PromoPhoto from './PromoPhoto';

/**
 * THE TWO EDITORIAL BANNERS — side by side, on a phone too.
 *
 * What they say and show is the owner's: the admin's «البانرات التحريرية»
 * slot (AdminHomeSettings → `homeBanners.editorial_banners`) sets the
 * picture, the three lines of copy in each language and the link. Until the
 * owner writes one, the two banners of the spec are drawn with the spec's
 * copy over a real picture: the site-media banner image the owner uploaded,
 * else a real product photograph from the section the banner opens
 * (src/lib/homeLayout.ts `resolveEditorial`).
 *
 * Each banner is ONE link; the «اكتشف الآن» pill is its label, not a second
 * target inside it.
 */
function Banner({ card }: { card: EditorialCard }) {
  const { loc } = useLanguage();

  // OWNER: Sorani to be written by hand (both presets' three lines).
  const preset =
    card.preset === 'multicolor'
      ? {
          title: loc('اطبع بأكثر من لون.', 'Print in more than one colour.'),
          subtitle: loc('اكتشف إمكانيات الطباعة متعددة الألوان.', 'Discover what multi-colour printing can do.'),
          cta: loc('اكتشف الآن', 'Explore now'),
        }
      : card.preset === 'materials'
        ? {
            title: loc('من أول طبعة إلى مشروع كامل.', 'From the first print to a whole project.'),
            subtitle: loc('مواد عالية الجودة لكل احتياجاتك.', 'Quality materials for everything you make.'),
            cta: loc('تسوق مواد الطباعة', 'Shop materials'),
          }
        : { title: '', subtitle: '', cta: '' };
  const title = card.title ?? preset.title;
  const subtitle = card.subtitle ?? preset.subtitle;
  const cta = card.cta ?? preset.cta;

  const body = (
    <>
      <PromoPhoto
        src={card.image}
        crop={card.productPhoto}
        width={360}
        height={360}
        className={
          card.productPhoto
            ? 'lv-fade-corner bottom-0 end-0 h-[70%] w-[86%] lg:h-full lg:w-[58%]'
            : 'inset-0'
        }
      />
      {card.productPhoto ? null : (
        // An uploaded picture fills the banner; a scrim from the reading side
        // keeps the owner's copy legible over whatever they chose.
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-l from-transparent via-charcoal/40 to-charcoal/85 rtl:bg-gradient-to-r" />
      )}
      <div className="relative flex h-full flex-col items-start p-3 lg:max-w-[52%] lg:p-7">
        {title ? (
          <h3 className="text-[14px] font-bold leading-[1.35] text-ivory lg:text-[24px] lg:leading-tight">
            {title}
          </h3>
        ) : null}
        {subtitle ? (
          <p className="mt-1 max-w-[20ch] text-[11px] lg:max-w-none leading-4 text-text-secondary lg:mt-2 lg:text-[14px] lg:leading-6">
            {subtitle}
          </p>
        ) : null}
        {cta ? (
          <span className="mt-auto inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-white/20 bg-charcoal px-2.5 text-[11px] font-semibold text-ivory transition-colors group-hover:border-white/45 lg:h-10 lg:px-4 lg:text-[14px]">
            {cta}
            <ArrowGlyph className="h-3 w-3" />
          </span>
        ) : null}
      </div>
    </>
  );

  const cls =
    'group relative isolate block h-[168px] min-w-0 overflow-hidden rounded-2xl bg-charcoal ring-1 ring-inset ring-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted sm:h-[180px] lg:h-[260px] lg:rounded-[20px]';
  if (card.to.startsWith('/')) {
    return (
      <Link to={card.to} data-editorial={card.key} data-theme="dark" className={cls}>
        {body}
      </Link>
    );
  }
  if (/^https?:\/\//.test(card.to)) {
    return (
      <a href={card.to} target="_blank" rel="noopener noreferrer" data-editorial={card.key} data-theme="dark" className={cls}>
        {body}
      </a>
    );
  }
  return (
    <div data-editorial={card.key} data-theme="dark" className={cls}>
      {body}
    </div>
  );
}

export default function EditorialBanners({ cards }: { cards: EditorialCard[] }) {
  const { loc } = useLanguage();
  if (cards.length === 0) return null;
  return (
    <section
      data-home-section="editorial"
      aria-label={loc('مختارات تحريرية', 'Featured stories')}
      className={`grid gap-2.5 lg:gap-4 ${cards.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
    >
      {cards.map((c) => (
        <Banner key={c.key} card={c} />
      ))}
    </section>
  );
}
