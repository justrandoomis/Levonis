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

/**
 * ─── THE ICON *IS* THE TILE, AND THE NAME SITS UNDER IT ───
 *
 * The owner: «يجب أن تملأ الأيقونة المربع الأسود كاملًا … والاسم يكون تحت
 * المربع الأسود وليس فيه». Before this, every card was a bordered box holding a
 * 44px chip and a caption, so the artwork they had commissioned — a gold mark
 * on its own rounded field, inside its own gold ring — was shown at about a
 * sixth of the area it was drawn for, boxed inside a second frame that repeated
 * what the file already had.
 *
 * So the card stops being a box. It is now a COLUMN: a square tile and a label
 * beneath it, with the tile drawn entirely by the uploaded file. That is why
 * `TILE_PLAIN`/`TILE_FEATURED` apply only when there is no image — a chip fill
 * and a border under an icon that brings its own would be the doubled frame
 * again, one pixel further out.
 *
 * `object-contain` AND NOT `object-cover`. The icons are 512×493 — a hair wider
 * than tall — so in a square tile `contain` letterboxes by about 1%, invisible,
 * while `cover` would crop 1% off each side and the first thing to go would be
 * the gold ring that defines the whole shape. A border cropped on two sides
 * reads as a mistake at any size.
 */
const ITEM_BASE = 'group flex w-[104px] shrink-0 snap-start flex-col items-center gap-2 min-w-0';
const TILE_BASE =
  'w-[104px] h-[104px] rounded-2xl flex items-center justify-center shrink-0 transition-colors';
const TILE_PLAIN = 'bg-zinc-900/50 border border-zinc-800 group-hover:border-zinc-600';
const TILE_FEATURED =
  'bg-gradient-to-br from-olive/20 to-zinc-900/60 border border-olive/40 group-hover:border-olive/70';

/**
 * `image` is the owner's uploaded icon for this card, or '' for none.
 *
 * NONE IS STILL A NORMAL CASE, not a missing state. The lucide icon is a
 * deliberate design, so a card without an upload keeps drawing it rather than
 * showing a gap — and a card whose image FAILS TO LOAD falls back to the same
 * drawn icon instead of a broken-image box. That second path is not
 * hypothetical: `Community.webp` was missing from the bucket while its ten
 * neighbours were there, and the community card kept its drawn icon instead of
 * becoming a hole on the first screen of the shop. All eleven objects are
 * uploaded now — that gap is closed — but the path stays, because the next
 * one is an upload away and a slot whose object is renamed or replaced mid-way
 * would otherwise 404 into a broken-image box on the shop's first screen.
 *
 * ─── THE UPLOADED ICON IS COMPOSITED NORMALLY, AND THAT IS NOW THE WHOLE
 * STORY ───
 *
 * The owner asked for «الأيقونة بدون الخلفية في الخدمات» — the icon with no
 * background behind it — and the files now deliver that themselves. All eleven
 * objects under `UiUx/MainPage/` were re-exported: 512×493 lossy WebP WITH A
 * REAL ALPHA CHANNEL, fully transparent outside the artwork, 35–44 KB each
 * against the 750–880 KB the first batch weighed. They are designed tiles — a
 * gold mark on a dark rounded field inside a gold ring — so the dark IS the
 * design, not a background waiting to be removed.
 *
 * THIS PARAGRAPH REPLACES ONE THAT WAS TRUE AND STOPPED BEING TRUE, which is
 * why it says so out loud. The first batch was opaque VP8 with no alpha at
 * all, 1254×1254 squares on pure #000000, so this tile carried
 * `mix-blend-screen`: screen(0, b) = b exactly, which made the baked black
 * composite to precisely the card's own surface. That was a real property of
 * those bytes — and the comment describing it outlived the upload that
 * falsified it. A comment asserting a fact about files that have since been
 * replaced is worse than no comment, because the next reader believes it.
 *
 * `screen` is REMOVED rather than left as a harmless leftover. Against these
 * files it lightens every dark pixel of the artwork toward the backdrop, and
 * the Studio card's backdrop is not neutral — it is the olive gradient of
 * TILE_FEATURED, which would tint the whole mark. On the ordinary near-black
 * cards the difference is a few percent and easy to wave through in review, so
 * the test is not «does it still look fine» but «what is this operation for»:
 * with genuine transparency there is nothing left for it to erase.
 *
 * The tile drops its own fill and border for an image and keeps both for the
 * drawn lucide icon, which needs the contrast. An uploaded icon arrives with
 * its own frame; a stroked glyph does not.
 *
 * WHAT A FUTURE UPLOAD MUST NOT DO, since that is the failure this paragraph
 * exists to prevent: an icon exported on an opaque background will now show
 * that background as a square, because nothing removes it any more. Export
 * with transparency. If a batch ever lands opaque, the answer is to re-export
 * it — not to reintroduce a blend mode that only works against one exact
 * colour and quietly lies about every other.
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
      <div className={`${TILE_BASE} ${showImage ? '' : featured ? TILE_FEATURED : TILE_PLAIN}`}>
        {showImage ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            /* The intrinsic box the browser reserves BEFORE the bytes arrive.
               It must match the rendered tile or the whole rail reflows as
               eleven lazy images land one by one — the layout shift a rail of
               placeholders is most prone to, and the cheapest to prevent. */
            width={104}
            height={104}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
            className="w-full h-full object-contain"
          />
        ) : (
          <Icon aria-hidden="true" className={`w-9 h-9 ${featured ? 'text-olive-light' : 'text-zinc-300'}`} />
        )}
      </div>
      {/* UNDER the tile, never inside it. `min-h` reserves the second line on
          every card so the tiles stay on one baseline whether a name wraps or
          not — «الضمان والصيانة» is one line and «مستعمل ومجدّد و Open Box» is
          two, and a rail whose squares sit at different heights reads as
          broken rather than as varied. */}
      <h3 className="w-full min-h-[2.25rem] text-[12px] font-bold leading-snug text-center text-zinc-200 line-clamp-2">
        {title}
      </h3>
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

      {/* One swipe rail at every width. Eleven 104px tiles are wider than a
          desktop row, so unlike the old 124px cards this one really does
          scroll everywhere — which is why it keeps `snap-x` and the momentum
          hook rather than degrading to a static row on a large screen.

          `items-start` so every column hangs from the same top edge: the tiles
          are what the eye lines up on, and stretching a short-titled column to
          match a two-line neighbour would push its square down. min-w-0 so a
          long Kurdish title wraps instead of widening its column. */}
      <div
        ref={rail.ref}
        className="flex items-start gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 sm:gap-3"
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
          className={ITEM_BASE}
        >
          <CardBody icon={Layers} title={t('studioCardTitle')} featured image={iconFor('studio')} />
        </a>

        {inApp.map((s) => (
          <Link key={s.id} to={s.to} data-service={s.id} className={ITEM_BASE}>
            <CardBody icon={s.icon} title={s.title} image={iconFor(s.id)} />
          </Link>
        ))}
      </div>
    </section>
  );
}
