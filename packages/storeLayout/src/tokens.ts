/**
 * THEME TOKENS: every visual choice a merchant can make, as a closed enum.
 *
 * There is no colour picker, no font field and no CSS box, and that is the
 * rule, not a gap (docs/MERCHANT_PLATFORM.md §2 decision 12). A token value is
 * a NAME; the storefront maps names to CSS custom properties and class lists
 * it defines itself (src/components/storefront/theme.css, theme.ts). Nothing
 * a merchant types can reach a stylesheet, a `style` attribute or a class.
 *
 * The app is dark by decision (tests/darkOnlyTheme.test.ts), so every surface
 * is a dark ground; themes differ in tone, shape, rhythm and type weight.
 * Typography presets vary weight and scale of Cairo — the one family the app
 * already loads — and never letter-spacing, which breaks Arabic joining.
 */

/** `store` follows the accent chosen in store settings (merchant_stores.accent). */
export const ACCENT_TOKENS = ['store', 'default', 'olive', 'gold', 'slate', 'plum', 'teal', 'blue'] as const;
/** The seven accents store settings can hold — worker/routes/merchant.ts `ACCENTS`. */
export const STORE_ACCENTS = ['default', 'olive', 'gold', 'slate', 'plum', 'teal', 'blue'] as const;
export const SURFACES = ['glow', 'ink', 'graphite', 'carbon', 'midnight'] as const;
export const RADII = ['sharp', 'soft', 'round'] as const;
export const DENSITIES = ['compact', 'comfortable', 'airy'] as const;
export const TYPOGRAPHY = ['standard', 'bold', 'refined', 'compact'] as const;
export const CARD_STYLES = ['outline', 'flat', 'raised'] as const;
export const PRODUCT_CARDS = ['tile', 'bordered', 'overlay', 'minimal'] as const;
export const IMAGE_RATIOS = ['square', 'portrait', 'landscape'] as const;
export const SECTION_SPACING = ['tight', 'normal', 'loose'] as const;
/** Products per row on a phone; one more on a wider container. */
export const GRID_COLUMNS = [2, 3] as const;
export const WIDTHS = ['standard', 'wide'] as const;

export type AccentToken = (typeof ACCENT_TOKENS)[number];
export type StoreAccent = (typeof STORE_ACCENTS)[number];
export type Surface = (typeof SURFACES)[number];
export type Radius = (typeof RADII)[number];
export type Density = (typeof DENSITIES)[number];
export type Typography = (typeof TYPOGRAPHY)[number];
export type CardStyle = (typeof CARD_STYLES)[number];
export type ProductCardStyle = (typeof PRODUCT_CARDS)[number];
export type ImageRatio = (typeof IMAGE_RATIOS)[number];
export type SectionSpacing = (typeof SECTION_SPACING)[number];
export type GridColumns = (typeof GRID_COLUMNS)[number];
export type Width = (typeof WIDTHS)[number];

export interface ThemeTokens {
  accent: AccentToken;
  surface: Surface;
  radius: Radius;
  density: Density;
  typography: Typography;
  card: CardStyle;
  product_card: ProductCardStyle;
  image_ratio: ImageRatio;
  section_spacing: SectionSpacing;
  grid_columns: GridColumns;
  width: Width;
}

/** Each token and the values it may take — the normaliser's allow-list. */
export const TOKEN_VALUES: { readonly [K in keyof ThemeTokens]: readonly ThemeTokens[K][] } = {
  accent: ACCENT_TOKENS,
  surface: SURFACES,
  radius: RADII,
  density: DENSITIES,
  typography: TYPOGRAPHY,
  card: CARD_STYLES,
  product_card: PRODUCT_CARDS,
  image_ratio: IMAGE_RATIOS,
  section_spacing: SECTION_SPACING,
  grid_columns: GRID_COLUMNS,
  width: WIDTHS,
};

export const TOKEN_KEYS = Object.keys(TOKEN_VALUES) as Array<keyof ThemeTokens>;

/**
 * THE THEME PRESETS — full token sets a merchant starts from and then adjusts.
 *
 * `classic` is the storefront every store had before themes existed, value
 * for value: the reference profile on #0a0a0a with the accent glow, 10px
 * product tiles, outlined cards, three products per row. A store that never
 * publishes a layout renders exactly this (defaultLayoutFromStore), which is
 * what makes the switch-over lossless.
 *
 * Every preset keeps `accent: 'store'`: the accent is the merchant's BRAND
 * colour, chosen in store settings, and changing the page's style must not
 * silently repaint it. A merchant who wants a different accent on the page
 * sets the token explicitly.
 */
export const THEME_NAMES = ['classic', 'minimal', 'modern', 'premium_dark', 'workshop', 'portfolio', 'product_focused'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const THEME_PRESETS: { readonly [K in ThemeName]: Readonly<ThemeTokens> } = {
  classic: {
    accent: 'store', surface: 'glow', radius: 'soft', density: 'comfortable', typography: 'standard', card: 'outline',
    product_card: 'tile', image_ratio: 'square', section_spacing: 'normal', grid_columns: 3, width: 'standard',
  },
  minimal: {
    accent: 'store', surface: 'ink', radius: 'sharp', density: 'airy', typography: 'refined', card: 'flat',
    product_card: 'minimal', image_ratio: 'portrait', section_spacing: 'loose', grid_columns: 2, width: 'standard',
  },
  modern: {
    accent: 'store', surface: 'graphite', radius: 'round', density: 'comfortable', typography: 'bold', card: 'raised',
    product_card: 'bordered', image_ratio: 'square', section_spacing: 'normal', grid_columns: 2, width: 'wide',
  },
  premium_dark: {
    accent: 'store', surface: 'carbon', radius: 'soft', density: 'airy', typography: 'refined', card: 'outline',
    product_card: 'overlay', image_ratio: 'portrait', section_spacing: 'loose', grid_columns: 2, width: 'wide',
  },
  workshop: {
    accent: 'store', surface: 'graphite', radius: 'sharp', density: 'compact', typography: 'standard', card: 'outline',
    product_card: 'bordered', image_ratio: 'landscape', section_spacing: 'tight', grid_columns: 2, width: 'standard',
  },
  portfolio: {
    accent: 'store', surface: 'ink', radius: 'soft', density: 'airy', typography: 'refined', card: 'flat',
    product_card: 'overlay', image_ratio: 'portrait', section_spacing: 'loose', grid_columns: 2, width: 'wide',
  },
  product_focused: {
    accent: 'store', surface: 'midnight', radius: 'soft', density: 'compact', typography: 'bold', card: 'raised',
    product_card: 'tile', image_ratio: 'square', section_spacing: 'tight', grid_columns: 3, width: 'wide',
  },
};

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEME_NAMES as readonly string[]).includes(v);
}

/** The accent a page actually uses: the token, or the store's own when the token says `store`. */
export function effectiveAccent(token: AccentToken, storeAccent: unknown): StoreAccent {
  if (token !== 'store') return token;
  return typeof storeAccent === 'string' && (STORE_ACCENTS as readonly string[]).includes(storeAccent)
    ? (storeAccent as StoreAccent)
    : 'default';
}
