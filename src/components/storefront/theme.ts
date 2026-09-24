/**
 * THEME LOOKUPS — the only way a token becomes a class or a data attribute.
 *
 * A token is an enum value the server normalised (packages/storeLayout); the
 * renderer still maps every one through a closed table defined HERE, so even a
 * layout that skipped normalisation could not put a string of its own into the
 * DOM. Unknown values fall back to the classic preset.
 */
import {
  effectiveAccent,
  THEME_PRESETS,
  TOKEN_VALUES,
  type StoreAccent,
  type ThemeTokens,
} from '../../../packages/storeLayout/src/tokens';

export interface AccentClasses {
  ring: string;
  chip: string;
  glow: string;
  text: string;
  btn: string;
  line: string;
  indicator: string;
}

/**
 * The accent presets. A NAME maps to classes chosen here — a merchant never
 * supplies a colour, so nothing they type can reach the stylesheet. `btn` is
 * the contact button's fill; the rest tint rings, chips and the active tab.
 * `indicator` is the FILL of the travelling tab underline.
 */
export const ACCENTS: Record<string, AccentClasses> = {
  default: { ring: 'border-gold/30', chip: 'bg-olive/30 text-gold', glow: 'bg-olive/15', text: 'text-gold', btn: 'bg-zinc-100 text-zinc-900', line: 'border-gold', indicator: 'bg-gold' },
  olive: { ring: 'border-olive-light/40', chip: 'bg-olive/40 text-gold', glow: 'bg-olive/20', text: 'text-gold', btn: 'bg-olive text-white', line: 'border-gold', indicator: 'bg-gold' },
  gold: { ring: 'border-gold/40', chip: 'bg-gold/15 text-gold', glow: 'bg-gold/10', text: 'text-gold', btn: 'bg-gold text-zinc-900', line: 'border-gold', indicator: 'bg-gold' },
  slate: { ring: 'border-slate-500/40', chip: 'bg-slate-500/15 text-slate-200', glow: 'bg-slate-500/10', text: 'text-slate-200', btn: 'bg-slate-200 text-slate-900', line: 'border-slate-300', indicator: 'bg-slate-300' },
  plum: { ring: 'border-purple-500/40', chip: 'bg-purple-500/15 text-purple-200', glow: 'bg-purple-500/10', text: 'text-purple-200', btn: 'bg-purple-300 text-purple-950', line: 'border-purple-300', indicator: 'bg-purple-300' },
  teal: { ring: 'border-teal-500/40', chip: 'bg-teal-500/15 text-teal-200', glow: 'bg-teal-500/10', text: 'text-teal-200', btn: 'bg-teal-300 text-teal-950', line: 'border-teal-300', indicator: 'bg-teal-300' },
  blue: { ring: 'border-sky-500/40', chip: 'bg-sky-500/15 text-sky-300', glow: 'bg-sky-500/10', text: 'text-sky-400', btn: 'bg-zinc-100 text-zinc-900', line: 'border-sky-400', indicator: 'bg-sky-400' },
};

/** The accent a page paints with: the token, or the store's own when it says `store`. */
export function accentFor(tokens: ThemeTokens, storeAccent: unknown): { name: StoreAccent; classes: AccentClasses } {
  const name = effectiveAccent(tokens.accent, storeAccent);
  return { name, classes: ACCENTS[name ?? 'default'] ?? ACCENTS.default };
}

/** Tokens, each re-checked against its closed list. */
export function safeTokens(tokens: Partial<ThemeTokens> | null | undefined): ThemeTokens {
  const base = { ...THEME_PRESETS.classic };
  if (!tokens || typeof tokens !== 'object') return base;
  for (const key of Object.keys(TOKEN_VALUES) as Array<keyof ThemeTokens>) {
    const v = tokens[key];
    if ((TOKEN_VALUES[key] as readonly unknown[]).includes(v)) (base as unknown as Record<string, unknown>)[key] = v;
  }
  return base;
}

/**
 * The data attributes the theme stylesheet (theme.css) keys on. Values come
 * from `safeTokens`, i.e. from the closed lists, never from the input.
 */
export function themeAttributes(tokens: ThemeTokens): Record<string, string> {
  return {
    'data-store-theme': '',
    'data-sf-surface': tokens.surface,
    'data-sf-radius': tokens.radius,
    'data-sf-density': tokens.density,
    'data-sf-type': tokens.typography,
    'data-sf-card': tokens.card,
    'data-sf-pcard': tokens.product_card,
    'data-sf-ratio': tokens.image_ratio,
    'data-sf-spacing': tokens.section_spacing,
    'data-sf-width': tokens.width,
  };
}

/**
 * Products per row: the token is the count on a phone; a container of 40rem
 * and wider shows one more, and a wide page at 64rem one more again. Container
 * queries, so the builder's preview frame lays out exactly like a real width.
 */
export function gridClasses(tokens: ThemeTokens): string {
  if (tokens.grid_columns === 2) {
    return tokens.width === 'wide' ? 'grid-cols-2 @min-[40rem]:grid-cols-3 @min-[64rem]:grid-cols-4' : 'grid-cols-2 @min-[40rem]:grid-cols-3';
  }
  return tokens.width === 'wide' ? 'grid-cols-3 @min-[40rem]:grid-cols-4 @min-[64rem]:grid-cols-5' : 'grid-cols-3 @min-[40rem]:grid-cols-4';
}
