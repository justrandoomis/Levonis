import React from 'react';
import { Link } from 'react-router-dom';
import {
  Layers, ShieldCheck, Wrench, Package, Users, Gift, Scale,
  Shuffle, Repeat, PackageOpen, LifeBuoy,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';
import SectionHeader from './SectionHeader';
import { useRail } from '../../lib/useRail';
import type { SiteMediaEntry } from '../../lib/api';

/**
 * What LEVONIS does besides sell boxes — eleven compact cards on one
 * horizontally swiped rail (the owner asked for small modern cards, not a
 * stacked list eating a phone screen).
 *
 * EVERY CARD POINTS AT A PAGE THAT EXISTS. This is a storefront promise, so
 * nothing here is aspirational: each route below is registered in App.tsx and
 * already works. If a service is ever removed, its card goes with it rather
 * than becoming a dead link. The promise is now MACHINE-CHECKED —
 * worker/lib/siteMedia.ts carries the same destinations as data and
 * tests/serviceSlots.test.ts resolves every one of them against App.tsx's
 * route table — because a list of links nobody verifies is exactly how a rail
 * like this drifts into promising pages the router does not serve.
 *
 * THE ORDER IS THE OWNER'S, not this file's. They listed the eleven services
 * in the sequence they want them read, and the slot table repeats that order
 * so the admin's icon list and the customer's rail cannot disagree about which
 * service is which. Comparison still comes first among the in-app cards, which
 * is also where the owner put it: deciding between two printers is a question
 * a buyer has BEFORE choosing, while warranty and points are questions you
 * only have after you have bought.
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
 * NONE IS STILL A NORMAL CASE, not a missing state. The lucide icon is a
 * deliberate design, so a card without an upload keeps drawing it rather than
 * showing a gap — and a card whose image FAILS TO LOAD falls back to the same
 * drawn icon instead of a broken-image box. That second path is not
 * hypothetical: the owner's list names `Community.webp`, and that one object
 * is not in the bucket yet while its ten neighbours are. Without `onError`
 * the community card would be a hole on the first screen of the shop; with it,
 * the card looks exactly as it did before the upload and starts working the
 * moment the file lands, with no deploy.
 *
 * ─── WHY THE UPLOADED MARK IS BLENDED RATHER THAN BOXED ───
 *
 * The owner asked for «الأيقونة بدون الخلفية في الخدمات» — the icon with no
 * background behind it. The uploaded WebPs cannot give that on their own:
 * every one of the ten is a simple lossy VP8 with NO alpha channel at all,
 * exported as a 1254×1254 square whose margin is pure #000000. CSS cannot
 * delete pixels that are opaque, so there is nothing here to "make
 * transparent" and no honest way to pretend otherwise.
 *
 * What CSS can do is choose a compositing operation under which that exact
 * colour disappears. `screen` returns the backdrop unchanged wherever the
 * source is black — screen(0, b) = b, exactly, for every channel — so the
 * baked square composites to precisely the card's own surface and the mark is
 * left sitting on it. That is a real property of the blend and of these
 * files, not a trick: it was verified against the bytes actually served from
 * R2, whose margins measured 99.97% pure #000 with a maximum channel value of
 * 1. The tile therefore drops its own chip fill, border and padding for an
 * image, and keeps all three for the drawn icon, which needs the contrast.
 *
 * THE CONSTRAINT THIS PUTS ON FUTURE UPLOADS, because it is the failure this
 * comment exists to prevent: an icon exported on a WHITE or coloured
 * background will not quietly look slightly wrong under `screen` — white
 * screens to white, so the tile would turn into a solid white square. Service
 * icons must be exported on pure black (or with real transparency, which
 * behaves correctly here too). If that ever stops being true, the fix is to
 * put the chip background back for images, not to leave a white tile on the
 * first screen of the shop.
 *
 * No `isolate` on the wrapper: the blend is SUPPOSED to see the card
 * underneath it. Isolating would give it an empty backdrop to composite
 * against and hand back the black square this is removing.
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
  // Latched per card. An image that 404s once will 404 again, and re-rendering
  // the <img> to watch it fail a second time only reintroduces the flicker.
  const [imageFailed, setImageFailed] = React.useState(false);
  const showImage = Boolean(image) && !imageFailed;

  return (
    <>
      <div
        className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 overflow-hidden ${
          showImage
            ? ''
            : `border ${featured ? 'bg-olive/25 border-olive/50' : 'bg-zinc-800/70 border-zinc-700/60'}`
        }`}
      >
        {showImage ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            width={44}
            height={44}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
            className="w-full h-full object-contain mix-blend-screen"
          />
        ) : (
          <Icon aria-hidden="true" className={`w-5 h-5 ${featured ? 'text-olive-light' : 'text-zinc-300'}`} />
        )}
      </div>
      <h3 className="w-full text-[12px] font-bold leading-snug text-white line-clamp-2">{title}</h3>
    </>
  );
}

export default function ServicesGrid({ siteMedia = [] }: { siteMedia?: SiteMediaEntry[] }) {
  const { t, loc } = useLanguage();
  // Keyed by the same id the card already carries in `data-service`, so there
  // is no second naming scheme to keep in step with the server's slot list.
  const iconFor = (id: string): string =>
    siteMedia.find((m) => m.group === 'service' && m.slot === `service-${id}`)?.url || '';
  // Short cards: a snappier decay suits a rail this narrow.
  const rail = useRail({ decelerationRate: 0.99 });

  /**
   * The four cards added with the owner's list have no key in
   * src/translations.ts and use `loc(ar, en, ckb)` instead. That is the house
   * idiom for inline trilingual text and it is NOT `dir === 'rtl' ? ar : en`:
   * Sorani is right-to-left too, so that ternary serves Arabic to every
   * Kurdish reader. The six older cards keep their translation keys — the
   * owner's Arabic names for them are word-for-word what those keys already
   * hold, so there is nothing to move.
   */
  const inApp: Array<{ id: string; to: string; title: string; icon: React.ElementType }> = [
    { id: 'compare', to: '/compare', title: t('svcCompareTitle'), icon: Scale },
    { id: 'tools', to: '/tools', title: t('svcToolsTitle'), icon: Wrench },
    { id: 'bundles', to: '/bundles', title: t('svcBundlesTitle'), icon: Package },
    // The mystery filament is a FILTER on the bundles page, not a page of its
    // own — Bundles.tsx reads `kind` out of the query string and pre-selects
    // the «عروض غامضة» chip. A second surface for the same rows would be a
    // second answer about what is in stock.
    {
      id: 'mystery',
      to: '/bundles?kind=mystery',
      title: loc('الفلامنت العشوائي', 'Mystery filament', 'فیلامێنتی هەڕەمەکی'),
      icon: Shuffle,
    },
    {
      id: 'tradein',
      to: '/trade-in',
      title: loc('استبدل القديمة بجديدة', 'Trade in your old printer', 'کۆنەکەت بگۆڕەوە بە نوێ'),
      icon: Repeat,
    },
    {
      id: 'used',
      to: '/used-printers',
      // NOT «طابعات مستعملة». The page behind this card selects on the
      // presence of a CONDITION DOCUMENT, which grades a product and carries
      // no product kind — so a graded filament spool appears on it, and so
      // does an Open Box unit, which is a NEW machine in an opened carton
      // rather than a used one. A card promising used printers that opens on a
      // spool of PLA has told the customer the wrong thing, and the route
      // name is the one thing they read before tapping.
      title: loc('مستعمل ومجدّد و Open Box', 'Used, refurbished & Open Box', 'بەکارهاتوو، نۆژەنکراوە و Open Box'),
      icon: PackageOpen,
    },
    { id: 'rewards', to: '/points', title: t('svcRewardsTitle'), icon: Gift },
    { id: 'warranty', to: '/warranty', title: t('svcWarrantyTitle'), icon: ShieldCheck },
    { id: 'community', to: '/community', title: t('svcCommunityTitle'), icon: Users },
    { id: 'support', to: '/support', title: loc('الدعم', 'Support', 'پشتگیری'), icon: LifeBuoy },
  ];

  return (
    <section data-home-section="services" className="mb-10 sm:mb-12">
      <SectionHeader title={t('services')} accent="bg-olive" />

      {/* One swipe rail at every width; the small cards fit a desktop row
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
