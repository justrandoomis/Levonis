import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { HomeSectionItem, HomeTaxon, SiteMediaEntry } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';
import Marquee from './Marquee';
import { useRail } from '../../lib/useRail';

/**
 * The shared shelf scroller: a snap rail on phones that relaxes into a
 * wrapping row from `sm` up. One implementation so every home shelf swipes,
 * snaps and spaces identically. Wrapping — not a grid — because these
 * shelves hold however many taxa the store really has: three categories in
 * a six-column grid is one short row and five columns of dead black, while
 * a wrapped row is simply three cards.
 */
function Rail({ children }: { children: React.ReactNode }) {
  // `useRail` detaches itself above `sm`, where this becomes a wrapped grid —
  // a drag handler still listening on a layout it does not own would swallow
  // clicks on the category cards.
  const rail = useRail();
  return (
    <div
      ref={rail.ref}
      className="flex gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap sm:overflow-visible sm:gap-3"
    >
      {children}
    </div>
  );
}

/** An owner-authored card: picture, label, optional sub-line, optional link. */
function ItemCard({ item }: { item: HomeSectionItem }) {
  const body = (
    <>
      <div className="aspect-[4/3] bg-zinc-950 overflow-hidden">
        {item.image ? (
          <SafeImage src={item.image} alt={item.title} aspect="auto" className="w-full h-full" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-olive-dark to-olive" />
        )}
      </div>
      <div className="p-3 min-w-0">
        <h3 className="text-white font-bold text-[13px] leading-snug line-clamp-2">{item.title}</h3>
        {item.subtitle && <p className="text-xs text-zinc-400 line-clamp-2 mt-0.5">{item.subtitle}</p>}
      </div>
    </>
  );
  const className =
    'w-[180px] sm:w-[210px] shrink-0 snap-start rounded-2xl overflow-hidden bg-zinc-900/50 border border-zinc-800 hover:border-olive/50 transition-colors';

  if (item.link && item.link.startsWith('/')) {
    return (
      <Link to={item.link} data-strip-item={item.id} className={className}>
        {body}
      </Link>
    );
  }
  if (item.link) {
    return (
      <a href={item.link} target="_blank" rel="noopener noreferrer" data-strip-item={item.id} className={className}>
        {body}
      </a>
    );
  }
  return (
    <div data-strip-item={item.id} className={className}>
      {body}
    </div>
  );
}

/**
 * A horizontal strip of owner-authored cards — the `coupons_offers` section
 * and any owner-authored `categories`/`top_brands` cards.
 *
 * These were configurable in the admin panel and rendered NOWHERE: an owner
 * could fill in coupons and top brands and the storefront would silently
 * ignore every one of them. Renders nothing when empty, so an unconfigured
 * section costs no vertical space rather than showing an empty shelf.
 */
export function ItemStrip({
  id,
  title,
  accent,
  items,
}: {
  id: string;
  title: string;
  accent: string;
  items: HomeSectionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section data-home-section={id} className="mb-10 sm:mb-12">
      <SectionHeader title={title} accent={accent} />
      <Rail>
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </Rail>
    </section>
  );
}

/** The first letter the shopper reads — the seed of a taxon's monogram tile. */
function monogramOf(name: string): string {
  return (name.trim()[0] || '•').toUpperCase();
}

/**
 * The brands strip: a self-scrolling ticker of brand marks, at the owner's
 * request — logos only, no cards or counts, drifting sideways until a finger
 * or pointer rests on it and resuming when it leaves.
 *
 * NO WHITE PLATE, AND NO CAPTION. «لا تجعل هنالك خلفية بيضاء, بل تكون فقط صورة
 * العلامة بدون خلفية بيضاء أو اسم للعلامة». Each logo used to sit in a
 * `bg-zinc-100` puck with its name printed underneath — the last pure-white
 * surface on a near-black page, and the same pattern src/pages/Cart.tsx:1344
 * records having already removed once for the same reason.
 *
 * WHAT THE PLATE WAS ACTUALLY HIDING, measured rather than guessed. All seven
 * seeded logos are genuinely transparent — every one is a VP8X WebP with the
 * alpha flag set, and 164 of 164 sampled border pixels are fully transparent,
 * so nothing here renders as a white rectangle. But they are DARK. Against
 * `--color-canvas` (#0b0c0f) their median contrast is: Antinsky 2.2:1, eSUN
 * 2.5:1, QIDI 2.5:1, BIGTREETECH 2.7:1, BIQU 2.8:1 — below the 3:1 floor a
 * graphic needs to be seen at all. Removing the plate and doing nothing else
 * would have made five of seven brands nearly invisible.
 *
 * SO THE MARK IS BRIGHTENED, NOT BACKED. `brightness(2) saturate(1.25)` lifts
 * every one of them over the floor — the worst, QIDI, reaches 3.9:1 and the
 * rest 4.9:1 to 15:1 — while keeping the hue that makes a logo recognisable.
 * The three things it is NOT, because the next reader will be tempted:
 *   - `mix-blend-multiply` multiplies against the backdrop, and this backdrop
 *     is near-black, so it would crush every logo to black. It erases white
 *     only against a WHITE page, which this is not.
 *   - `mix-blend-screen` erases BLACK, not white; a white matte would survive
 *     it untouched while dark lettering washed away.
 *   - `invert(1)` turns Bambu Lab's green magenta.
 * A logo that is already light simply clamps toward white under this filter,
 * which is the correct degradation: it can make a mark plainer, never dimmer.
 *
 * THE ALT TEXT IS NOW LOAD-BEARING. With the caption gone it is the link's
 * only accessible name, so the wrapper span's `aria-hidden` had to go with it
 * — hiding a subtree and then writing an alt into it cancels both, and the
 * screen reader falls back to reading the href aloud.
 *
 * TWO SOURCES, one look. Owner-authored `top_brands` cards win and their
 * pictures ARE the logos. With none authored it falls back to the real
 * `brands` table ordered by how many active products carry each brand — that
 * table has no image column, so a gold monogram tile stands in rather than a
 * fake logo. A monogram keeps its caption: «B» on its own is not a brand, so
 * the belt is captioned whenever any entry lacks a picture, and bare only
 * when every entry has one. That is decided once for the whole belt rather
 * than per mark, because a row that is half logos and half lettered pucks
 * reads as a rendering fault.
 *
 * The loop renders the set several times so the belt never shows a seam;
 * only the FIRST copy carries data attributes and keyboard focus, so tests
 * count real brands (not copies) and a keyboard user meets each brand once.
 * prefers-reduced-motion parks the belt and leaves a plain swipeable rail.
 */
interface MarqueeEntry {
  key: string;
  name: string;
  image: string;
  link: string;
  /** data attribute name for the first copy: strip item vs brand chip. */
  data: 'strip' | 'brand';
  id: string;
}

/**
 * What the brightening does, in one place so both the CSS and the reason
 * travel together. See the section note above for the measurements.
 */
const LOGO_FILTER = 'brightness(2) saturate(1.25)';

function MarqueeMark({
  entry,
  first,
  logoOnly,
}: {
  entry: MarqueeEntry;
  first: boolean;
  /** True when EVERY entry in the belt has a picture — see the note above. */
  logoOnly: boolean;
}) {
  /**
   * The puck behind a logo in CAPTIONED mode. A logo needs a surface here only
   * because the belt is mixed and the marks have to line up with the monogram
   * tiles beside them — and it gets the app's own dark surface, never a white
   * one. A white plate on a near-black page is the thing the owner asked to be
   * rid of, and src/pages/Cart.tsx records this repo removing the last one for
   * the same reason.
   */
  const plate = entry.image
    ? 'bg-zinc-900 border-zinc-800'
    : 'bg-gold/10 border-gold/30 text-gold font-black text-base';

  const body = logoOnly ? (
    <img
      src={entry.image}
      /* THE LINK'S ONLY NAME. There is no caption any more and no wrapper to
         hide this from assistive tech, so `alt=""` would leave a screen
         reader announcing the href — "products search Bambu%20Lab". */
      alt={entry.name}
      /* A FIXED BOX. Marquee measures ONE set and then walks exactly that
         stride; these logos range from a square roundel to a wordmark and
         they load lazily, so an auto-width mark would widen the set after the
         stride was measured and the whole belt would visibly re-lay-out. */
      width={112}
      height={56}
      loading="lazy"
      decoding="async"
      className="w-full h-full object-contain"
      style={{ filter: LOGO_FILTER }}
    />
  ) : (
    <>
      <span
        aria-hidden={!!entry.image || undefined}
        className={`w-14 h-14 rounded-full shrink-0 flex items-center justify-center overflow-hidden border ${plate}`}
      >
        {entry.image ? (
          <img
            src={entry.image}
            alt=""
            width={56}
            height={56}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-contain p-2"
            style={{ filter: LOGO_FILTER }}
          />
        ) : (
          monogramOf(entry.name)
        )}
      </span>
      <span className="block w-full text-center text-[10px] font-semibold text-zinc-400 truncate group-hover:text-white transition-colors">
        {entry.name}
      </span>
    </>
  );
  const cls = logoOnly
    ? // 112×56 so a wordmark has room to be read; `h-14` matches the puck the
      // captioned mode draws, so switching modes does not change the belt's
      // height. The opacity shift is the hover affordance the caption used to
      // provide, and the focus ring is its own because a bare <Link> gets none
      // from the button system.
      'group w-[112px] h-14 shrink-0 flex items-center justify-center min-w-0 rounded-lg opacity-90 transition-opacity motion-reduce:transition-none hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
    : 'group w-[84px] shrink-0 flex flex-col items-center gap-1.5 min-w-0';
  const dataProps: Record<string, unknown> = first
    ? { [entry.data === 'brand' ? 'data-brand-chip' : 'data-strip-item']: entry.id }
    : { 'aria-hidden': true, tabIndex: -1 };
  if (entry.link.startsWith('/')) {
    return (
      <Link to={entry.link} className={cls} {...dataProps}>
        {body}
      </Link>
    );
  }
  if (entry.link) {
    return (
      <a href={entry.link} target="_blank" rel="noopener noreferrer" className={cls} {...dataProps}>
        {body}
      </a>
    );
  }
  return (
    <span className={cls} {...dataProps}>
      {body}
    </span>
  );
}

export function BrandMarquee({ items, brands, siteMedia = [] }: {
  items: HomeSectionItem[];
  brands: HomeTaxon[];
  siteMedia?: SiteMediaEntry[];
}) {
  const { t, loc } = useLanguage();

  /**
   * THREE SOURCES, IN DESCENDING ORDER OF HOW DELIBERATE THEY ARE.
   *
   * 1. Cards the owner authored for this section — an explicit editorial
   *    choice, so nothing overrides them.
   * 2. The main-page brand slots. These carry REAL LOGOS: the seven marks the
   *    owner uploaded to `UiUx/MainPage/`, resolved into URLs by the server.
   * 3. The `brands` taxonomy table. It has no logo column at all, so every
   *    entry it produces renders as a gold monogram letter — correct as a last
   *    resort, and not what a brand belt is for.
   *
   * The middle source is the one that was missing. Before it, a shop with
   * seven logos sitting in R2 and no authored cards fell straight through to
   * (3) and drew seven letters.
   */
  const brandSlots = siteMedia.filter((m) => m.group === 'brand' && m.url);

  const entries: MarqueeEntry[] =
    items.length > 0
      ? items.map((it) => ({
          key: it.id,
          name: it.title,
          image: it.image,
          link: it.link,
          data: 'strip' as const,
          id: it.id,
        }))
      : brandSlots.length > 0
      ? brandSlots.map((m) => ({
          key: m.slot,
          name: m.label,
          image: m.url,
          link: m.link,
          data: 'brand' as const,
          id: m.slot,
        }))
      : brands.map((b) => ({
          key: b.id,
          name: loc(b.name_ar, b.name_en || b.name_ar, b.name_ckb),
          image: '',
          link: `/products?search=${encodeURIComponent(b.name_en || b.name_ar)}`,
          data: 'brand' as const,
          id: b.id,
        }));
  if (entries.length === 0) return null;

  /**
   * The whole belt is bare, or the whole belt is captioned — never a mix.
   * «B» on its own is not a brand, so a monogram keeps its name; and a row of
   * logos beside lettered pucks reads as something half-rendered. Deciding it
   * once for the belt also means an owner who authors one picture-less card
   * gets a captioned belt rather than a silently dropped card — quietly
   * discarding what the owner typed is the failure this codebase keeps
   * refusing to commit.
   */
  const logoOnly = entries.every((e) => !!e.image);

  return (
    <section data-home-section="top_brands" className="mb-10 sm:mb-12">
      <SectionHeader title={t('topBrands')} accent="bg-gold" />
      {/* Marquee measures the screen and repeats the set until the belt is
          wider than any viewport, so ONE brand still fills an iPad edge to
          edge and the loop has no visible seam. The set carries its own
          trailing space (pe-3 = the internal gap) so every copy's stride is
          identical — that exactness is what makes the wrap invisible.

          `bleed-x` is what makes "edge to edge" true on a LARGE screen. The
          negative margins that were here before (-mx-4 … lg:-mx-8) only
          cancelled the column's own padding, so above 80rem the belt stopped
          at the column's edge and left a gutter on each side — the owner's
          «يظهر اليمين واليسار فارغا ومقصوصا». See index.css. */}
      <Marquee
        speed={34}
        className="bleed-x"
        renderSet={(first) => (
          <div className="flex items-center gap-3 pe-3">
            {entries.map((e) => (
              <MarqueeMark key={e.key} entry={e} first={first} logoOnly={logoOnly} />
            ))}
          </div>
        )}
      />
    </section>
  );
}
