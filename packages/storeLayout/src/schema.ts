/**
 * THE STORE LAYOUT, version 1: what a store page is, as data.
 *
 *   { schema_version: 1, theme, tokens, header, footer, background, blocks[] }
 *
 * `theme` names the preset the tokens started from; `tokens` are the enums the
 * merchant then adjusted (tokens.ts); `header`/`footer` pick a variant — and,
 * since storefront L6/L7, carry the notice line and the footer links;
 * `background` is the page's own picture or video behind the cards (L4); each
 * block is `{id, type, variant, settings, visibility, hidden, schedule?}` from
 * the registry (blocks.ts). Order is array order. A layout holds PRESENTATION
 * only: products, reviews, collections, services, orders and the store's own
 * words live in their tables and are referenced, never copied — which is why
 * changing a theme, or deleting a block, can never delete any of them.
 */
import type { BlockType, SettingsOf, VariantOf } from './blocks';
import { NO_LINK, type LinkTarget } from './refs';
import { EMPTY_TEXT, type LocalizedText } from './text';
import type { ThemeName, ThemeTokens } from './tokens';

export const SCHEMA_VERSION = 1 as const;

/**
 * `overlay`: the way back and the ⋯ menu float over the top of the page (the
 * classic profile, over its cover). `bar`: an in-flow top bar with the store's
 * logo and name. `none`: neither.
 */
export const HEADER_VARIANTS = ['overlay', 'bar', 'none'] as const;
/**
 * `minimal`: the «install the app» card on the store's own host (the classic
 * page). `standard`: that card plus the store's name and its date on Levonis.
 * `none`: nothing below the blocks.
 */
export const FOOTER_VARIANTS = ['minimal', 'standard', 'none'] as const;
export type HeaderVariant = (typeof HEADER_VARIANTS)[number];
export type FooterVariant = (typeof FOOTER_VARIANTS)[number];

export interface Visibility {
  /** Shown when the page (or the builder's preview frame) is narrower than 48rem. */
  mobile: boolean;
  /** Shown at 48rem and wider. */
  desktop: boolean;
}

/**
 * A scheduled block (storefront L8): shown to visitors only inside
 * [`from`, `until`) — ISO instants, either may be '' for «no bound». The
 * builder's preview shows it always (with a «مجدول» mark); the live page
 * filters it through `renderableBlocks(layout, now, 'live')`. Present on a
 * block only when one bound is set.
 */
export interface BlockSchedule {
  from: string;
  until: string;
}

export interface BlockOf<T extends BlockType> {
  id: string;
  type: T;
  variant: VariantOf<T>;
  settings: SettingsOf<T>;
  visibility: Visibility;
  /** The merchant's own hide: kept in the layout, not rendered. */
  hidden: boolean;
  schedule?: BlockSchedule;
}

/** Any block, discriminated by `type`. */
export type StoreBlock = { [T in BlockType]: BlockOf<T> }[BlockType];

/**
 * The header box (storefront L6): its variant, and the NOTICE LINE — one short
 * announcement («توصيل مجاني هذا الأسبوع») with an optional destination, shown
 * by the core StoreHeader whatever the variant. `notice_from` / `notice_until`
 * (ISO instants) bound when it shows; absent = always. Blank notice = none.
 */
export interface StoreHeader {
  variant: HeaderVariant;
  notice: LocalizedText;
  notice_link: LinkTarget;
  notice_from?: string;
  notice_until?: string;
}

/** One footer link (storefront L7): the merchant's label and where it goes. */
export interface FooterLink {
  label: LocalizedText;
  link: LinkTarget;
}

export interface StoreFooter {
  variant: FooterVariant;
  /** At most MAX_FOOTER_LINKS (blocks.ts). */
  links: FooterLink[];
}

/**
 * THE PAGE BACKGROUND (storefront L4; DECISIONS «media caps — phones see the
 * still»). `media` is the owner's own image (a GIF included) or video key by
 * `kind`; `poster` the still a video shows before it plays — and INSTEAD of
 * playing on phones and under reduced motion. `dim` is how much the renderer
 * darkens it so the cards stay legible (the three dims are inline styles the
 * client keys on `data-sf-bg`); `phones` says whether phones paint it at all
 * (the still, never the video). `kind: 'none'` is «no background»; an empty
 * `media` under another kind draws nothing either.
 */
export const BACKGROUND_KINDS = ['none', 'image', 'video'] as const;
export const BACKGROUND_DIMS = ['light', 'medium', 'heavy'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];
export type BackgroundDim = (typeof BACKGROUND_DIMS)[number];

export interface StoreBackground {
  kind: BackgroundKind;
  media: string;
  poster: string;
  dim: BackgroundDim;
  phones: boolean;
}

export interface StoreLayout {
  schema_version: typeof SCHEMA_VERSION;
  theme: ThemeName;
  tokens: ThemeTokens;
  header: StoreHeader;
  footer: StoreFooter;
  background: StoreBackground;
  blocks: StoreBlock[];
}

/** A header with a variant and nothing else set — what every layout carried before L6. */
export function defaultHeader(variant: HeaderVariant = 'overlay'): StoreHeader {
  return { variant, notice: { ...EMPTY_TEXT }, notice_link: { ...NO_LINK } };
}

/** A footer with a variant and no links. */
export function defaultFooter(variant: FooterVariant = 'minimal'): StoreFooter {
  return { variant, links: [] };
}

/** No background: the theme's own surface, as every page had before L4. */
export function defaultBackground(): StoreBackground {
  return { kind: 'none', media: '', poster: '', dim: 'medium', phones: false };
}

/** Blocks per layout. */
export const MAX_BLOCKS = 40;
/**
 * The normalised layout, serialised, in UTF-8 bytes. It is stored once as the
 * draft and once per revision, and served inside the store's first answer, so
 * it is capped as a whole besides every field being capped on its own.
 */
export const MAX_LAYOUT_BYTES = 64 * 1024;
/** A request body carrying a layout is refused before parsing above this. */
export const MAX_REQUEST_BYTES = 256 * 1024;
