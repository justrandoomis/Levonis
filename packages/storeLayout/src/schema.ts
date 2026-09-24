/**
 * THE STORE LAYOUT, version 1: what a store page is, as data.
 *
 *   { schema_version: 1, theme, tokens, header, footer, blocks[] }
 *
 * `theme` names the preset the tokens started from; `tokens` are the enums the
 * merchant then adjusted (tokens.ts); `header`/`footer` pick a variant; each
 * block is `{id, type, variant, settings, visibility, hidden}` from the
 * registry (blocks.ts). Order is array order. A layout holds PRESENTATION
 * only: products, reviews, collections, services, orders and the store's own
 * words live in their tables and are referenced, never copied — which is why
 * changing a theme, or deleting a block, can never delete any of them.
 */
import type { BlockType, SettingsOf, VariantOf } from './blocks';
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

export interface BlockOf<T extends BlockType> {
  id: string;
  type: T;
  variant: VariantOf<T>;
  settings: SettingsOf<T>;
  visibility: Visibility;
  /** The merchant's own hide: kept in the layout, not rendered. */
  hidden: boolean;
}

/** Any block, discriminated by `type`. */
export type StoreBlock = { [T in BlockType]: BlockOf<T> }[BlockType];

export interface StoreLayout {
  schema_version: typeof SCHEMA_VERSION;
  theme: ThemeName;
  tokens: ThemeTokens;
  header: { variant: HeaderVariant };
  footer: { variant: FooterVariant };
  blocks: StoreBlock[];
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
