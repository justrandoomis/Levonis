import React from 'react';
import { Link } from 'react-router-dom';
import {
  Layers, ShieldCheck, Wrench, Package, Users, Gift, Scale,
  Shuffle, Repeat, PackageOpen, LifeBuoy,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';
import SectionHead from './v2/SectionHead';
import { useCommunityAccess } from '../../pages/community/access';

/**
 * What LEVONIS does besides sell boxes — eleven compact tiles, the last
 * section of the home page.
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
 * THE ORDER IS THE OWNER'S, not this file's — and it is the order of the
 * homepage-v2 brief: «الضمان · Trade-in · مقارنة الطابعات · الأدوات · استوديو
 * ليفو · المكافآت», then the rest of the shop's real services.
 *
 * HOMEPAGE V2: A QUIET GRID OF LIGHT TILES AT THE END OF THE PAGE. The owner
 * moved services below the community and asked for «very clean compact grid
 * of light tiles (minimal line icon, short title)», visually secondary to the
 * products. So the uploaded gold-on-dark artwork (site-media `service-*`
 * slots) is no longer drawn here: those tiles were designed for the dark rail
 * this grid replaces, and on the ivory ground they read as eleven dark
 * stickers. Each tile is now a hairline paper square with one line icon in
 * ink. The slot table (worker/lib/siteMedia.ts) still lists every service and
 * its destination, and tests/serviceSlots.test.ts still holds the two lists
 * together.
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

/* A phone gets a four-up grid of small squares (icon over a two-line name);
   from 1024px each tile turns into a row — icon beside the name — six to a
   line, which is how a long name like «مستعمل ومجدّد و Open Box» stays on
   one or two lines instead of being clipped. */
const TILE =
  'group flex min-h-[80px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[14px] border border-hairline bg-paper px-1 py-2.5 text-center transition-colors hover:border-[#cfc8bb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted lg:min-h-[64px] lg:flex-row lg:justify-start lg:gap-3 lg:rounded-2xl lg:px-4 lg:text-start';
const ICON = 'h-5 w-5 shrink-0 text-ink lg:h-[22px] lg:w-[22px]';
const TITLE = 'line-clamp-3 text-[11px] font-semibold leading-[1.3] text-ink lg:text-[13.5px] lg:leading-5';

export default function ServicesGrid() {
  const { t, loc } = useLanguage();
  /**
   * The community tile is dropped while the server says Levo Community is
   * shut (worker/lib/communityGate.ts). Presentation only — the gate itself is
   * on the server and a tapped stale tile lands on the maintenance card — but
   * a grid of services should not advertise one that is closed. An answer
   * that has not arrived, or one that failed, keeps the tile: an unknown state
   * is not a refusal, and the grid must not reshuffle under a thumb.
   */
  const { access: communityAccess } = useCommunityAccess();
  const communityShut = communityAccess?.may_enter === false;

  /**
   * `loc(ar, en, ckb)` for the cards without a translation key — the house
   * idiom for inline trilingual text, NOT `dir === 'rtl' ? ar : en` (Sorani
   * is right-to-left too, so that ternary serves Arabic to every Kurdish
   * reader). The older cards keep their translation keys.
   */
  const inApp: Array<{ id: string; to: string; title: string; icon: React.ElementType }> = [
    { id: 'warranty', to: '/warranty', title: t('svcWarrantyTitle'), icon: ShieldCheck },
    // «Trade-in» is the owner's own name for this tile in the homepage-v2
    // brief, in both languages; the page behind it keeps the long title.
    { id: 'tradein', to: '/trade-in', title: 'Trade-in', icon: Repeat },
    { id: 'compare', to: '/compare', title: t('svcCompareTitle'), icon: Scale },
    { id: 'tools', to: '/tools', title: t('svcToolsTitle'), icon: Wrench },
    // The Studio card is drawn just before this one — see `studio` below.
    { id: 'rewards', to: '/points', title: t('svcRewardsTitle'), icon: Gift },
    { id: 'bundles', to: '/bundles', title: t('svcBundlesTitle'), icon: Package },
    // The mystery filament is a FILTER on the bundles page, not a page of its
    // own — Bundles.tsx reads `kind` out of the query string and pre-selects
    // the «عروض غامضة» chip.
    {
      id: 'mystery',
      to: '/bundles?kind=mystery',
      title: loc('الفلامنت العشوائي', 'Mystery filament', 'فیلامێنتی هەڕەمەکی'),
      icon: Shuffle,
    },
    {
      id: 'used',
      to: '/used-printers',
      // NOT «طابعات مستعملة». The page behind this card selects on the
      // presence of a CONDITION DOCUMENT, which grades a product and carries
      // no product kind — a graded spool appears on it, and so does an Open
      // Box unit, which is a NEW machine in an opened carton.
      title: loc('مستعمل ومجدّد و Open Box', 'Used, refurbished & Open Box', 'بەکارهاتوو، نۆژەنکراوە و Open Box'),
      icon: PackageOpen,
    },
    { id: 'community', to: '/community', title: t('svcCommunityTitle'), icon: Users },
    { id: 'support', to: '/support', title: loc('الدعم', 'Support', 'پشتگیری'), icon: LifeBuoy },
  ].filter((card) => !(card.id === 'community' && communityShut));

  /**
   * THE STUDIO opens in its OWN tab, at the owner's request: it is a separate
   * application on a separate subdomain, and replacing the store with it costs
   * the customer their cart and their place on the page. rel="noopener"
   * because a new tab otherwise receives window.opener, a handle onto this
   * page. Written as a literal anchor on purpose (tests/store-isolation).
   */
  const studio = (
    <a href={STUDIO_URL} target="_blank" rel="noopener noreferrer" data-service="studio" className={TILE}>
      <Layers aria-hidden="true" strokeWidth={1.5} className={ICON} />
      {/* OWNER: Sorani to be written by hand. */}
      <span className={TITLE}>{loc('استوديو ليفو', 'LEVO Studio')}</span>
    </a>
  );

  return (
    <section data-home-section="services" aria-labelledby="home-services-title">
      {/* No «عرض جميع الخدمات»: the shop has no services index page, and a
          link has to go somewhere real. Every service is already on the grid.
          OWNER: Sorani to be written by hand (the title). */}
      <SectionHead id="home-services-title" title={loc('خدمات ومزايا إضافية', 'More services & benefits')} />
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-6 lg:gap-3">
        {inApp.map((s) => (
          <React.Fragment key={s.id}>
            {s.id === 'rewards' ? studio : null}
            <Link to={s.to} data-service={s.id} className={TILE}>
              <s.icon aria-hidden="true" strokeWidth={1.5} className={ICON} />
              <span className={TITLE}>{s.title}</span>
            </Link>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}
