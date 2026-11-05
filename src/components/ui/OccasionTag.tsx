import type { CSSProperties } from 'react';
import { occasionWords, type OccasionLang, type OccasionName, type OfferOccasionKey } from '../../../packages/contracts/src/offerOccasions';

/**
 * THE SALE'S OCCASION AS AN OBLIQUE CORNER RIBBON (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * The owner, of the first design (a pill stacked over the «−N٪» chip, the sale's clock across the photo):
 * «very bad design . the label on product should be only on top left corner sloping < oblique > . no need
 * for big button or date. the goal is modern and clean design < clay morphism style >».
 *
 * So an occasion is ONE SLIM BAND AT 45° across the photograph's top corner — top-left in Arabic and
 * Sorani, where the owner asked for it; top-right in English, where top-left holds the compare toggle —
 * cut by the photograph's own rounded edge (its tray clips it), carrying the occasion's name and nothing
 * else: no glyph, no date, no outline. Each occasion keeps its colours: a fill, an ink and, for most, a
 * hairline trim along both long edges — Black Friday onyx trimmed in gold, White Friday snow in antique
 * gold, Cyber Monday indigo in cyan, Ramadan night blue and both Eids green in gold (al-Fitr the brighter
 * green, al-Adha deep teal), Christmas deep green in red, the flash deal amber in onyx, back to school
 * yellow and winter ice in navy, summer orange in burnt orange, spring petal in leaf green; 11.11 crimson,
 * 12.12 flame, the hyper deal magenta and the owner's own name in silver are a solid fill. Wherever it
 * lands — a black studio photograph, a white one, either theme's gallery — a band stands off what is under
 * it by its fill, its trim or its clay edges.
 *
 * THE NAME SITS IN THE BAND, WHOLE. Arabic and Sorani reach far above and below their line — the hamza of
 * «الأضحى» 0.86 em up, the dots of «فرايدي» and the v under «ڕەمەزان» nearly half an em down — so each band is
 * as thick as that ink plus its two trims, and an Arabic or Sorani name's baseline sits 0.19 em under the
 * band's centre (`lift` raises it there from where Cairo's tall ascent would put it), which centres every
 * preset's ink between the trims. An English name keeps Cairo's own baseline, about 0.37 em under the centre,
 * which centres its capitals. Its line box is taller than the band, so no mark is ever cut off. Along the
 * band, every preset keeps at least 5 px of fill between its ink and the photograph's cut edge, at the ink's
 * top corner where the band is shortest (`room`; all measured: tests/fixtures/occasionTagWidths.json).
 *
 * CLAY, AND INFORMATION (DECISIONS rows 207 and 209). A label is information, and information is not raised:
 * the band rests ON the photograph. One edge treatment per band: a trimmed band's edges are its trims; a
 * solid band's are its own clay bevel — a lit rim along the edge that faces the light, a pressed base along
 * the other, the fill's own colour lifted and pressed (`BEVEL`, the house's `.lv-button-primary` recipe for a
 * solid fill in both themes). Under both, one small soft contact shadow in the PAGE's clay ink (warm on
 * cream, black in dark: `--clay-ambient`, read outside the dark island), offset straight down the screen
 * whichever way the band turns — no sideways cast flipping with the language (row 207). Solid; no blur
 * behind it, no gloss, no glyph, no radius of its own.
 *
 * ONE DESIGN IN BOTH THEMES. The band's fill is a dark island (`data-theme="dark"`, scripts/theme-tokens.mjs):
 * every palette shade inside it reads its designed value whatever the page's theme. The colours ride on it
 * as three custom properties (`--occ-fill`, `--occ-ink`, `--occ-edge`) read by three classes the
 * stylesheet already carries, and the geometry (where the band crosses the corner, its length and angle),
 * its type and its cast are the elements' own style: the public stylesheet has no byte to spare
 * (tests/bundleBudget.test.ts), and the ribbon adds no rule to it at all. Each token is written as its
 * custom property's name without the dashes (`color-violet-950`), so the theme generator counts the shade
 * and Tailwind copies none into `:root`.
 *
 * THE WORDS, AND A SCREEN READER. On a card the band on the photograph is decoration (`aria-hidden`): the
 * sentence a screen reader hears («تخفيض بلاك فرايدي») is inside the card's link, beside its price (`sr`,
 * src/components/home/ProductCard.tsx), so it is part of the product the link names. On the product page the
 * band carries its own sentence. A longer custom name ends in an ellipsis. A key this build does not know
 * renders nothing (and a card then wears an ordinary sale's chip and clock: ProductCard `drawnOccasion`).
 *
 * A LIST ROW'S 96 px PHOTOGRAPH IS TOO SMALL FOR A NAME: the longest names would need a band across most of
 * it. There the ribbon is a short FLAG — the same band in the same colours across the same corner, no words
 * (`list`) — and the row names the occasion in its price line, beside the «−N٪» (`name`).
 *
 * In a chip or a picker tile (`picker`) the ribbon is drawn in miniature — the same band across a small
 * tray's corner — beside the name in the chip's own type.
 */

export interface OccasionTheme {
  /** The band's fill and its ink — each a colour token by its property's name (`color-onyx`). */
  fill: string;
  ink: string;
  /** A hairline along both long edges of the band, or none (a solid fill, edged by its own clay bevel). */
  trim: string | null;
}

export const OCCASION_THEMES: Readonly<Record<OfferOccasionKey, OccasionTheme>> = {
  black_friday: { fill: 'color-onyx', ink: 'color-gold-fill', trim: 'color-gold-fill' },
  white_friday: { fill: 'color-snow', ink: 'color-yellow-900', trim: 'color-yellow-900' },
  cyber_monday: { fill: 'color-violet-950', ink: 'color-cyan-300', trim: 'color-cyan-500' },
  singles_day: { fill: 'color-crimson', ink: 'color-snow', trim: null },
  double_twelve: { fill: 'color-flame', ink: 'color-onyx', trim: null },
  flash_deal: { fill: 'color-amber-400', ink: 'color-onyx', trim: 'color-onyx' },
  hyper_deal: { fill: 'color-fuchsia-500', ink: 'color-onyx', trim: null },
  ramadan: { fill: 'color-sky-900', ink: 'color-amber-100', trim: 'color-gold-fill' },
  eid_al_fitr: { fill: 'color-emerald-700', ink: 'color-amber-100', trim: 'color-gold-fill' },
  eid_al_adha: { fill: 'color-teal-950', ink: 'color-amber-100', trim: 'color-gold-fill' },
  christmas: { fill: 'color-red-900', ink: 'color-snow', trim: 'color-emerald-500' },
  back_to_school: { fill: 'color-yellow-300', ink: 'color-blue-700', trim: 'color-blue-700' },
  summer: { fill: 'color-orange-400', ink: 'color-onyx', trim: 'color-orange-900' },
  winter: { fill: 'color-sky-200', ink: 'color-sky-900', trim: 'color-sky-900' },
  spring: { fill: 'color-petal', ink: 'color-emerald-900', trim: 'color-emerald-700' },
  custom: { fill: 'color-slate-400', ink: 'color-onyx', trim: null },
};

/** A design as the three custom properties its band reads (no trim: the edge is the fill, and `BEVEL` draws it). */
const paint = (t: OccasionTheme): CSSProperties =>
  ({
    '--occ-fill': `var(--${t.fill})`,
    '--occ-ink': `var(--${t.ink})`,
    '--occ-edge': `var(--${t.trim ?? t.fill})`,
  }) as CSSProperties;

/**
 * A SOLID BAND'S CLAY EDGES: its two long borders, translucent over its own fill (a background reaches under
 * its border) — the fill lifted toward white along the edge that faces the light, pressed toward black along
 * the other. Fixed, like `.lv-button-primary`'s rim and base: the band is the same in both themes.
 */
export const BEVEL = { rim: 'rgb(255 255 255 / 0.28)', base: 'rgb(0 0 0 / 0.3)' } as const;

/**
 * THE RIBBONS, in px. The band's centre line meets the photograph's top edge and its side edge `reach` from
 * the corner; the band is `band` thick (its two 1 px edges included) and long enough to run past both edges,
 * where the tray cuts it. `type` is the name's size and `lift` the space under an Arabic or Sorani name that
 * raises its baseline to 0.19 em under the band's centre (an English one needs none); `room` the longest name
 * the band shows whole (a longer one ends in an ellipsis). The card's band holds every preset whole in all
 * three languages on the narrowest photograph (a 320 px phone's two-across grid, 129 px), 5 px clear of both
 * cut edges; the gallery's is the card's at the gallery's scale; a list row's 96 px photograph wears the
 * FLAG — no words, so no `room`.
 */
export const OCCASION_RIBBONS = {
  card: { reach: 62, band: 16, type: 9.5, lift: 3.5, room: 64 },
  list: { reach: 32, band: 12, type: 0, lift: 0, room: 0 },
  page: { reach: 82, band: 21, type: 13, lift: 5, room: 88 },
} as const;

export type OccasionRibbonSize = keyof typeof OCCASION_RIBBONS;

/**
 * Where the band lies: centred on the corner's diagonal at `reach / 2` from both edges, turned 45° — up to
 * the right across the top-left corner (Arabic, Sorani), down to the right across the top-right one
 * (English). Its contact shadow is offset (∓1, 1) in the band's own turned frame: √2 px straight down the
 * screen, in both directions.
 */
export function ribbonGeometry(size: OccasionRibbonSize, rtl: boolean): CSSProperties {
  const { reach, band } = OCCASION_RIBBONS[size];
  const length = Math.ceil(reach * Math.SQRT2 + band + 4);
  return {
    top: reach / 2 - band / 2,
    [rtl ? 'left' : 'right']: reach / 2 - length / 2,
    width: length,
    height: band,
    transform: `rotate(${rtl ? -45 : 45}deg)`,
    boxShadow: `${rtl ? -1 : 1}px 1px 2px var(--clay-ambient)`,
  };
}

/** The miniature: the same band across a 20 × 16 tray's corner, in flat stops (the trim, the fill, the trim). */
const swatch = (rtl: boolean) =>
  `linear-gradient(${rtl ? 135 : 225}deg, transparent 0 14%, var(--occ-edge) 14% 19%, var(--occ-fill) 19% 50%, var(--occ-edge) 50% 55%, transparent 55%)`;

/**
 * `card` / `list` / `page`: the ribbon on a photograph (its tray is `relative` and clips it); `picker`: the
 * miniature beside the name; `name`: the name beside a list row's price, with its sentence; `sr`: the
 * sentence alone, inside a grid card's link.
 */
export type OccasionTagSize = OccasionRibbonSize | 'picker' | 'name' | 'sr';

export interface OccasionTagProps {
  /** The offer block's key (`offer.badge`). */
  badge: string | null | undefined;
  /** The owner's own name, for `custom` (`offer.badge_text`). */
  name?: OccasionName | null;
  lang: OccasionLang;
  size?: OccasionTagSize;
  className?: string;
}

export default function OccasionTag({ badge, name, lang, size = 'card', className }: OccasionTagProps) {
  const words = occasionWords(badge, name ?? null, lang);
  if (!words) return null;
  const theme = OCCASION_THEMES[words.key];
  const rtl = lang !== 'en';
  const extra = className ? ` ${className}` : '';
  if (size === 'sr') {
    return (
      <span data-occasion={words.key} data-occasion-size={size} className={`sr-only${extra}`}>
        {words.sr}
      </span>
    );
  }
  if (size === 'name') {
    return (
      <span data-occasion={words.key} data-occasion-size={size} className={`min-w-0 truncate font-bold${extra}`}>
        <span aria-hidden>· {words.name}</span>
        <span className="sr-only">{words.sr}</span>
      </span>
    );
  }
  if (size === 'picker') {
    return (
      <span data-occasion={words.key} data-occasion-size={size} className={`inline-flex min-w-0 items-center gap-1.5${extra}`}>
        <span aria-hidden className="relative h-4 w-5 shrink-0 overflow-hidden rounded bg-border-subtle">
          <span data-theme="dark" className="absolute inset-0" style={{ ...paint(theme), backgroundImage: swatch(rtl) }} />
        </span>
        <span className="min-w-0 truncate">{words.name}</span>
      </span>
    );
  }
  const r = OCCASION_RIBBONS[size];
  const page = size === 'page';
  return (
    <span
      aria-hidden={page ? undefined : true}
      data-occasion={words.key}
      data-occasion-size={size}
      className={`pointer-events-none absolute z-[1]${extra}`}
      style={ribbonGeometry(size, rtl)}
    >
      {/* The ink sits on the name, never on the island: an island's own `color` is its theme's text
          (src/index.css `[data-theme='dark']:not(html)`, outside every layer), which no utility on the
          island itself can override — the White Friday name read snow on snow. */}
      <span
        data-theme="dark"
        dir={rtl ? 'rtl' : 'ltr'}
        className="flex h-full items-center justify-center border-y border-[var(--occ-edge)] bg-[var(--occ-fill)] font-bold"
        style={{
          ...paint(theme),
          ...(theme.trim ? null : { borderTopColor: BEVEL.rim, borderBottomColor: BEVEL.base }),
          ...(r.room ? { fontSize: r.type, lineHeight: 2, ...(rtl ? { paddingBottom: r.lift } : null) } : null),
        }}
      >
        {r.room ? (
          <span aria-hidden className="truncate text-[var(--occ-ink)]" style={{ maxWidth: r.room }}>
            {words.name}
          </span>
        ) : null}
      </span>
      {page ? <span className="sr-only">{words.sr}</span> : null}
    </span>
  );
}

/**
 * «سعر بلاك فرايدي» — the product page's label beside a sale price its occasion set (§16.4), in the page's
 * quiet label type. `fallback` (the page's own «سعر العرض») when this build does not know the key.
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
