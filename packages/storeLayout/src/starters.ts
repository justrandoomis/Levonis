/**
 * STARTER LAYOUTS — the seven theme presets as whole pages a merchant can
 * start from («ابدأ من قالب», the store builder's first run).
 *
 * A preset in tokens.ts is a LOOK (colour ground, corners, rhythm, type). A
 * starter is that look plus an arrangement of blocks that suits it: the
 * workshop leads with services and machines, the portfolio with finished
 * work, the product-focused page with collections and a wide grid.
 *
 * Every block here renders from the store's OWN data — products, collections,
 * services, showcase, reviews, printers, the store's profile — so a starter
 * never puts a word or a picture into a merchant's page that the merchant did
 * not write or upload. Nothing here is placeholder copy, and nothing needs
 * filling in before the page is honest.
 *
 * Built with `makeBlock`, so each block is exactly what the normaliser would
 * produce (tests/storeDesignEditor.test.ts pins that every starter normalises
 * to itself with no issue, fits the caps, and reproduces its preset's tokens).
 * Choosing one writes only the DRAFT (worker/routes/storeLayout.ts PUT /draft).
 */
import { makeBlock } from './normalize';
import { defaultLayoutFromStore } from './defaults';
import type { FooterVariant, HeaderVariant, StoreBlock, StoreLayout } from './schema';
import { THEME_NAMES, THEME_PRESETS, type ThemeName } from './tokens';

type Spec = [type: Parameters<typeof makeBlock>[0], id: string, opts?: Parameters<typeof makeBlock>[2]];

interface Starter {
  header: HeaderVariant;
  footer: FooterVariant;
  blocks: readonly Spec[];
}

const STARTERS: { readonly [K in Exclude<ThemeName, 'classic'>]: Starter } = {
  /** Quiet: a name, one grid, the story. */
  minimal: {
    header: 'bar',
    footer: 'standard',
    blocks: [
      ['hero', 'hero', { variant: 'minimal', settings: { align: 'start' } }],
      ['products_grid', 'products', { settings: { source: 'latest', limit: 8 } }],
      ['about', 'about'],
    ],
  },
  /** Collections up front, a carousel of what is new, the deals, what customers say. */
  modern: {
    header: 'bar',
    footer: 'standard',
    blocks: [
      ['hero', 'hero', { variant: 'cover' }],
      ['collections', 'collections', { variant: 'cards' }],
      ['products_carousel', 'new', { settings: { source: 'latest', limit: 10 } }],
      ['deals', 'deals', { variant: 'carousel' }],
      ['reviews', 'reviews', { variant: 'cards', settings: { limit: 6 } }],
      ['contact', 'contact'],
    ],
  },
  /** Featured pieces large, names over pictures, few words. */
  premium_dark: {
    header: 'overlay',
    footer: 'minimal',
    blocks: [
      ['hero', 'hero', { variant: 'cover' }],
      ['products_grid', 'featured', { settings: { source: 'featured', limit: 6 } }],
      ['collections', 'collections', { variant: 'cards' }],
      ['reviews', 'reviews', { variant: 'cards', settings: { limit: 4 } }],
      ['about', 'about'],
    ],
  },
  /** What the workshop can make, on which machines, and how to ask for it. */
  workshop: {
    header: 'bar',
    footer: 'standard',
    blocks: [
      ['hero', 'hero', { variant: 'split' }],
      ['stats', 'stats', { variant: 'row', settings: { metrics: ['completed_orders', 'rating', 'years'] } }],
      ['services', 'services', { variant: 'grid' }],
      ['printers', 'printers', { variant: 'cards' }],
      ['showcase', 'showcase', { variant: 'grouped' }],
      ['custom_request_cta', 'custom-request'],
      ['contact', 'contact'],
    ],
  },
  /** The finished work first, then the proof. */
  portfolio: {
    header: 'overlay',
    footer: 'minimal',
    blocks: [
      ['hero', 'hero', { variant: 'cover' }],
      ['showcase', 'work', { variant: 'grid', settings: { kinds: ['work'] } }],
      ['stats', 'stats', { variant: 'cards', settings: { metrics: ['completed_orders', 'positive', 'followers'] } }],
      ['reviews', 'reviews', { variant: 'list', settings: { limit: 6 } }],
      ['contact', 'contact'],
    ],
  },
  /** A shop: find a collection, see a wide grid, catch the deals. */
  product_focused: {
    header: 'bar',
    footer: 'standard',
    blocks: [
      ['hero', 'hero', { variant: 'minimal' }],
      ['collections', 'collections', { variant: 'chips' }],
      ['products_grid', 'products', { settings: { source: 'latest', limit: 12 } }],
      ['deals', 'deals', { variant: 'grid', settings: { limit: 6 } }],
      ['delivery_info', 'delivery'],
      ['reviews', 'reviews', { variant: 'list', settings: { limit: 4 } }],
    ],
  },
};

/** The starter page for a preset: its tokens, its header and footer, its blocks. */
export function starterLayout(theme: ThemeName): StoreLayout {
  if (theme === 'classic') return defaultLayoutFromStore(null);
  const s = STARTERS[theme];
  return {
    schema_version: 1,
    theme,
    tokens: { ...THEME_PRESETS[theme] },
    header: { variant: s.header },
    footer: { variant: s.footer },
    blocks: s.blocks.map(([type, id, opts]): StoreBlock => makeBlock(type, id, opts)),
  };
}

/** Every starter, in the presets' order. */
export const STARTER_THEMES: readonly ThemeName[] = THEME_NAMES;
