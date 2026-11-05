import {
  BadgePercent,
  Flower2,
  Gauge,
  Gift,
  LampCeiling,
  Moon,
  MoonStar,
  MousePointerClick,
  PencilLine,
  ShoppingBag,
  Snowflake,
  Sparkles,
  Sun,
  Tag,
  TreePine,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { occasionWords, type OccasionLang, type OccasionName, type OfferOccasionKey } from '../../../packages/contracts/src/offerOccasions';

/**
 * THE SALE'S OCCASION, IN ITS OWN DESIGN (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * The owner: «any of them have special design and clean ui ux for know this is dicount for this special
 * deal». One tag per occasion, each recognisable at a glance — a fill, an ink, an edge and a mark (a
 * lucide glyph, bare or on a medallion) of its own: Black Friday onyx with a gold edge, White Friday snow
 * with gold, Cyber Monday deep violet with cyan, 11.11 crimson and 12.12 flame, Ramadan night blue with a
 * gold lantern, Eid al-Fitr deep green with a gold crescent, Eid al-Adha deeper green with a crescent and
 * star on a gold medallion, Christmas deep green with a snow tree on a red medallion, back to school
 * yellow with a pencil, summer orange with a sun, winter ice with a snowflake, spring petal with a green
 * flower, the flash deal amber with a bolt, the hyper deal vivid violet, and the owner's own name a
 * neutral silver tag. Two tags that share an edge never share a fill's look (tests/offerOccasionCard.test.ts
 * holds their fills apart).
 *
 * ONE DESIGN IN BOTH THEMES. The tag is a dark island (`data-theme="dark"`, the generator's own
 * mechanism — scripts/theme-tokens.mjs): every palette shade and named tone inside it reads its
 * designed value whatever the page's theme, so a Ramadan tag is the same night blue on cream as on
 * black. Only fixed tokens and the palette shades the shop already uses; flat and opaque like the
 * «−17٪» chip under it (OfferBadge.tsx) — no blur, no shadow, no arbitrary radius, no zinc. The ink
 * reads at 4.5:1 or more on its fill and every glyph at 3:1 on what is under it, and each tag stands
 * off a dark photograph, a white one and every tray by its fill or its edge
 * (tests/offerOccasionCard.test.ts computes all of it).
 *
 * FIVE CLASSES FOR SIXTEEN DESIGNS. Each design is five design tokens handed to the tag as custom
 * properties (`--occ-fill`, `--occ-ink`, `--occ-edge`, `--occ-medal`, `--occ-glyph`, the Spinner's
 * `--lv-delay` pattern), read by the same five classes: one utility per colour per design would have
 * added some thirty rules to the stylesheet every visitor downloads (tests/bundleBudget.test.ts holds
 * it at 60 KB). Each token is written as its custom property's name without the dashes
 * (`color-violet-950` for `--color-violet-950`): the theme generator still counts the shade it reads
 * (scripts/theme-tokens.mjs), while Tailwind does not copy each one into the `:root` block — the island
 * declares them all, and the three fixed colours (snow, onyx, gold-fill) are every page's anyway.
 *
 * The words come from the shared contract (packages/contracts/src/offerOccasions.ts); the visible name
 * is hidden from a screen reader, which hears the sentence instead («تخفيض بلاك فرايدي»). A key this
 * build does not know renders nothing.
 */

export interface OccasionTheme {
  /** The tag's fill, its ink and its edge — each a colour token by its property's name (`color-onyx`). */
  fill: string;
  ink: string;
  edge: string;
  /** The mark: a medallion's fill (null: the bare glyph on the tag's fill) and the glyph's ink. */
  medal: string | null;
  glyph: string;
  icon: LucideIcon;
}

export const OCCASION_THEMES: Readonly<Record<OfferOccasionKey, OccasionTheme>> = {
  black_friday: { fill: 'color-onyx', ink: 'color-snow', edge: 'color-gold-fill', medal: 'color-gold-fill', glyph: 'color-onyx', icon: Tag },
  white_friday: { fill: 'color-snow', ink: 'color-yellow-900', edge: 'color-yellow-900', medal: 'color-gold-fill', glyph: 'color-onyx', icon: Sparkles },
  cyber_monday: { fill: 'color-violet-950', ink: 'color-cyan-300', edge: 'color-cyan-500', medal: 'color-cyan-300', glyph: 'color-violet-950', icon: MousePointerClick },
  singles_day: { fill: 'color-crimson', ink: 'color-snow', edge: 'color-flame', medal: 'color-snow', glyph: 'color-crimson', icon: ShoppingBag },
  double_twelve: { fill: 'color-flame', ink: 'color-onyx', edge: 'color-crimson', medal: 'color-onyx', glyph: 'color-flame', icon: Gift },
  flash_deal: { fill: 'color-amber-400', ink: 'color-onyx', edge: 'color-onyx', medal: 'color-onyx', glyph: 'color-amber-400', icon: Zap },
  hyper_deal: { fill: 'color-violet-700', ink: 'color-snow', edge: 'color-fuchsia-500', medal: 'color-fuchsia-500', glyph: 'color-onyx', icon: Gauge },
  ramadan: { fill: 'color-sky-900', ink: 'color-amber-100', edge: 'color-gold-fill', medal: null, glyph: 'color-gold-fill', icon: LampCeiling },
  eid_al_fitr: { fill: 'color-emerald-900', ink: 'color-amber-100', edge: 'color-gold-fill', medal: null, glyph: 'color-gold-fill', icon: Moon },
  eid_al_adha: { fill: 'color-teal-950', ink: 'color-amber-100', edge: 'color-gold-fill', medal: 'color-gold-fill', glyph: 'color-teal-950', icon: MoonStar },
  christmas: { fill: 'color-emerald-950', ink: 'color-snow', edge: 'color-red-500', medal: 'color-red-500', glyph: 'color-snow', icon: TreePine },
  back_to_school: { fill: 'color-yellow-300', ink: 'color-sky-900', edge: 'color-sky-900', medal: null, glyph: 'color-sky-900', icon: PencilLine },
  summer: { fill: 'color-orange-500', ink: 'color-onyx', edge: 'color-orange-900', medal: 'color-yellow-300', glyph: 'color-orange-900', icon: Sun },
  winter: { fill: 'color-sky-100', ink: 'color-sky-900', edge: 'color-sky-900', medal: 'color-sky-900', glyph: 'color-sky-100', icon: Snowflake },
  spring: { fill: 'color-petal', ink: 'color-emerald-900', edge: 'color-emerald-700', medal: null, glyph: 'color-emerald-700', icon: Flower2 },
  custom: { fill: 'color-slate-400', ink: 'color-onyx', edge: 'color-onyx', medal: null, glyph: 'color-onyx', icon: BadgePercent },
};

/** A design as the five custom properties its tag reads. */
const paint = (t: OccasionTheme): CSSProperties =>
  ({
    '--occ-fill': `var(--${t.fill})`,
    '--occ-ink': `var(--${t.ink})`,
    '--occ-edge': `var(--${t.edge})`,
    '--occ-medal': t.medal ? `var(--${t.medal})` : 'transparent',
    '--occ-glyph': `var(--${t.glyph})`,
  }) as CSSProperties;

/**
 * THE SIZES. `card`: on a card's photograph (and beside a list row's price), 20 px tall, stacked above the
 * «−N٪» chip — semibold on a 12 px medallion, so every preset's name fits the narrowest card (the home
 * rail's 148 px) with room to spare in all three languages (measured: tests/fixtures/occasionTagWidths.json).
 * `page`: the product page's gallery. `picker`: the owner's grid in the discount card.
 */
export const OCCASION_TAG_SIZES = {
  card: { tag: 'gap-0.5 ps-0.5 pe-0.75 py-px text-[10px] leading-4 font-semibold', mark: 'size-3', icon: 'size-2.5' },
  picker: { tag: 'gap-1 px-1.5 py-0.5 text-[11px] leading-4 font-bold', mark: 'size-4', icon: 'size-3' },
  page: { tag: 'gap-1.5 px-2 py-1 text-[13px] leading-5 font-bold', mark: 'size-5', icon: 'size-3.5' },
} as const;

export type OccasionTagSize = keyof typeof OCCASION_TAG_SIZES;

export interface OccasionTagProps {
  /** The offer block's key (`offer.badge`). */
  badge: string | null | undefined;
  /** The owner's own name, for `custom` (`offer.badge_text`). */
  name?: OccasionName | null;
  lang: OccasionLang;
  size?: OccasionTagSize;
  className?: string;
}

export default function OccasionTag({ badge, name, lang, size = 'card', className = '' }: OccasionTagProps) {
  const words = occasionWords(badge, name ?? null, lang);
  if (!words) return null;
  const theme = OCCASION_THEMES[words.key];
  const Icon = theme.icon;
  const sz = OCCASION_TAG_SIZES[size];
  const mark = (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-sm bg-[var(--occ-medal)] text-[var(--occ-glyph)] ${sz.mark}`}>
      <Icon className={sz.icon} strokeWidth={2.5} />
    </span>
  );
  return (
    <span
      data-occasion={words.key}
      data-occasion-size={size}
      data-theme="dark"
      style={paint(theme)}
      className={`inline-flex min-w-0 max-w-full items-center rounded-md border border-[var(--occ-edge)] bg-[var(--occ-fill)] ${sz.tag} ${className}`}
    >
      {mark}
      {/* The ink sits on the name, never on the island: an island's own `color` is its theme's text
          (src/index.css `[data-theme='dark']:not(html)`, outside every layer), which no utility on
          the island itself can override — the White Friday name read snow on snow. */}
      <span aria-hidden className="min-w-0 truncate text-[var(--occ-ink)]">
        {words.name}
      </span>
      <span className="sr-only">{words.sr}</span>
    </span>
  );
}

/**
 * «سعر بلاك فرايدي» — the product page's label beside a sale price its occasion set (§16.4). `fallback` (the
 * page's own «سعر العرض») when this build does not know the key.
 */
export function OccasionPriceLabel({
  badge,
  name,
  lang,
  fallback,
}: {
  badge: string | null | undefined;
  name?: OccasionName | null;
  lang: OccasionLang;
  fallback: string;
}) {
  const words = occasionWords(badge, name ?? null, lang);
  return <span data-occasion-price={words?.key ?? ''}>{words ? words.price : fallback}</span>;
}
