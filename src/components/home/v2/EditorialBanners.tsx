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
 *
 * THE PHOTOGRAPH FILLS THE BANNER (owner, 2026-09-26: «اجعل الصورة تملأ
 * البطاقة»): edge to edge, with the copy on it in the bottom corner on the
 * reading side over a dark scrim (`.lv-bleed-scrim`) — light words on a dark
 * scrim in both themes, since they sit on a photograph. The picture is the
 * admin's light/dark pair for the banner when there is one (targets
 * `editorial-multicolor` / `editorial-materials`), else a real product
 * photograph cropped to its middle band (src/lib/homeLayout.ts).
 *
 * ONE ROW, SIDE BY SIDE, AT EVERY WIDTH (owner, 2026-09-26, with the
 * reference shot: «يكون في شريط أفقي واحد بشكل مستطيل»). The two banners
 * share one horizontal row on a phone too, each a landscape rectangle by
 * aspect ratio (16:10 on a phone, 16:9 on a tablet, 12:5 from 1024 px). On a
 * phone the sub-line is dropped to keep the title and the pill clear.
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
      {card.image ? (
        <>
          <PromoPhoto
            src={card.image}
            lightSrc={card.lightImage}
            crop={card.productPhoto}
            bleed
            width={720}
            height={720}
            className="inset-0"
          />
          <div aria-hidden="true" className="lv-bleed-scrim-deep pointer-events-none absolute inset-0" />
        </>
      ) : null}
      <div className="relative flex h-full flex-col items-start justify-end p-2.5 sm:p-4 lg:max-w-[50%] lg:p-7 2xl:p-9">
        {title ? (
          <h3 className="text-[12.5px] font-bold leading-[1.4] text-snow [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] sm:text-[17px] lg:text-[24px] lg:leading-[1.35] 2xl:text-[28px]">
            {title}
          </h3>
        ) : null}
        {subtitle ? (
          <p className="mt-1 hidden max-w-[34ch] text-[12px] leading-[1.5] text-snow/80 sm:block lg:mt-1.5 lg:text-[14px] 2xl:text-[15px]">
            {subtitle}
          </p>
        ) : null}
        {cta ? (
          <span className="mt-2 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full bg-snow px-2.5 text-[10.5px] font-bold text-onyx transition-colors group-hover:bg-paper sm:mt-3 sm:h-9 sm:px-3.5 sm:text-[13px] lg:mt-4 lg:h-10 lg:px-4 lg:text-[14px]">
            {cta}
            <ArrowGlyph className="h-3 w-3" />
          </span>
        ) : null}
      </div>
    </>
  );

  const cls =
    'group relative isolate block aspect-[16/10] min-w-0 overflow-hidden rounded-2xl lv-bleed-ground ring-1 ring-inset ring-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:aspect-[16/9] lg:aspect-[12/5] lg:rounded-[20px]';
  if (card.to.startsWith('/')) {
    return (
      <Link to={card.to} data-editorial={card.key} data-feature="" className={cls}>
        {body}
      </Link>
    );
  }
  if (/^https?:\/\//.test(card.to)) {
    return (
      <a href={card.to} target="_blank" rel="noopener noreferrer" data-editorial={card.key} data-feature="" className={cls}>
        {body}
      </a>
    );
  }
  return (
    <div data-editorial={card.key} data-feature="" className={cls}>
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
      className={`grid gap-2 sm:gap-2.5 lg:gap-4 ${cards.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
    >
      {cards.map((c) => (
        <Banner key={c.key} card={c} />
      ))}
    </section>
  );
}
