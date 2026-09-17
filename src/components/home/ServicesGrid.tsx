import React from 'react';
import { Link } from 'react-router-dom';
import { Layers, ShieldCheck, Wrench, Package, Users, Gift } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';
import SectionHeader from './SectionHeader';
import { useRail } from '../../lib/useRail';
import type { SiteMediaEntry } from '../../lib/api';

/**
 * What LEVONIS does besides sell boxes — six compact cards on one
 * horizontally swiped rail (the owner asked for small modern cards, not a
 * stacked list eating a phone screen).
 *
 * EVERY CARD POINTS AT A PAGE THAT EXISTS. This is a storefront promise, so
 * nothing here is aspirational: each route below is registered in App.tsx and
 * already works. If a service is ever removed, its card goes with it rather
 * than becoming a dead link.
 *
 * The Studio card is written out as a LITERAL `<a href={STUDIO_URL}>` rather
 * than looped with the rest. That is deliberate: tests/store-isolation.test.ts
 * greps for exactly that anchor, and a link hidden behind an array entry would
 * pass review while silently becoming a router <Link>.
 *
 * It opens in a NEW TAB, at the owner's request: the Studio is a separate
 * application on a separate subdomain, and taking over the store's tab costs
 * the visitor their cart and their place on the page. An earlier version of
 * this comment argued the opposite — that the target should be the user's
 * choice — and the owner has since said plainly that it should open on its
 * own page. Still no iframe, no prefetch and no Studio code in this bundle
 * (docs/STUDIO_PLAN.md decision 6): a new tab is a navigation, not an
 * embedding.
 */

const CARD_BASE =
  'group flex w-[124px] min-h-[112px] shrink-0 snap-start flex-col items-center justify-center gap-2.5 rounded-xl border px-3 py-3.5 text-center transition-colors min-w-0';
const CARD_PLAIN = 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-600';
const CARD_FEATURED =
  'bg-gradient-to-br from-olive/20 to-zinc-900/60 border-olive/40 hover:border-olive/70';

/**
 * `image` is the owner's uploaded icon for this card, or '' for none.
 *
 * NONE IS THE NORMAL CASE, not a missing state. The lucide icon is a deliberate
 * design, so a card without an upload keeps drawing it rather than showing a
 * gap — the upload REPLACES a working icon, it does not fill a hole. That is
 * also why the tile keeps its size, border and background either way: swapping
 * the mark inside the tile leaves the rail's rhythm untouched.
 */
function CardBody({
  icon: Icon,
  title,
  featured,
  image,
}: {
  icon: React.ElementType;
  title: string;
  featured?: boolean;
  image?: string;
}) {
  return (
    <>
      <div
        className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 overflow-hidden border ${
          featured ? 'bg-olive/25 border-olive/50' : 'bg-zinc-800/70 border-zinc-700/60'
        }`}
      >
        {image ? (
          <img src={image} alt="" aria-hidden="true" loading="lazy" decoding="async" className="w-full h-full object-contain p-1.5" />
        ) : (
          <Icon aria-hidden="true" className={`w-5 h-5 ${featured ? 'text-olive-light' : 'text-zinc-300'}`} />
        )}
      </div>
      <h3 className="w-full text-[12px] font-bold leading-snug text-white line-clamp-2">{title}</h3>
    </>
  );
}

export default function ServicesGrid({ siteMedia = [] }: { siteMedia?: SiteMediaEntry[] }) {
  const { t } = useLanguage();
  // Keyed by the same id the card already carries in `data-service`, so there
  // is no second naming scheme to keep in step with the server's slot list.
  const iconFor = (id: string): string =>
    siteMedia.find((m) => m.group === 'service' && m.slot === `service-${id}`)?.url || '';
  // Six short cards: a snappier decay suits a rail this narrow.
  const rail = useRail({ decelerationRate: 0.99 });

  const inApp: Array<{ id: string; to: string; title: string; icon: React.ElementType }> = [
    { id: 'warranty', to: '/warranty', title: t('svcWarrantyTitle'), icon: ShieldCheck },
    { id: 'tools', to: '/tools', title: t('svcToolsTitle'), icon: Wrench },
    { id: 'bundles', to: '/bundles', title: t('svcBundlesTitle'), icon: Package },
    { id: 'community', to: '/community', title: t('svcCommunityTitle'), icon: Users },
    { id: 'rewards', to: '/points', title: t('svcRewardsTitle'), icon: Gift },
  ];

  return (
    <section data-home-section="services" className="mb-10 sm:mb-12">
      <SectionHeader title={t('services')} accent="bg-olive" />

      {/* One swipe rail at every width; six small cards fit a desktop row
          outright, so the rail only actually scrolls where it should — on a
          phone. min-w-0 so a long Kurdish title wraps inside its card. */}
      <div
        ref={rail.ref}
        className="flex gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 sm:gap-3"
      >
        {/* Opens in its OWN tab. The Studio is a separate application on a
            separate subdomain, and replacing the store with it costs the
            customer their cart, their scroll position and their place in
            whatever they were doing. rel="noopener" because a new tab gets
            window.opener otherwise, which is a handle onto this page. */}
        <a
          href={STUDIO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-service="studio"
          className={`${CARD_BASE} ${CARD_FEATURED}`}
        >
          <CardBody icon={Layers} title={t('studioCardTitle')} featured image={iconFor('studio')} />
        </a>

        {inApp.map((s) => (
          <Link key={s.id} to={s.to} data-service={s.id} className={`${CARD_BASE} ${CARD_PLAIN}`}>
            <CardBody icon={s.icon} title={s.title} image={iconFor(s.id)} />
          </Link>
        ))}
      </div>
    </section>
  );
}
