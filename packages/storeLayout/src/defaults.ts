/**
 * defaultLayoutFromStore — TODAY'S STOREFRONT, AS A LAYOUT.
 *
 * Every store that has never published a layout is rendered from this, on the
 * fly, from its current settings; and the builder starts a new draft from it.
 * It reproduces the one fixed page every store had before themes, top to
 * bottom (src/pages/Storefront.tsx before wave 2):
 *
 *   header  overlay       the way back and the ⋯ menu over the cover
 *   hero    profile       cover (the store banner), avatar, name, verified and
 *                         PRO marks, @address, rating, three honest stats,
 *                         bio, the three link pills, the three info cards (or
 *                         the honest fallback facts), the «not taking orders»
 *                         notice, contact + follow + share
 *   tabs    underline     Products (featured first, 6 then «show all», paging,
 *                         collection filter) · Collections · Deals · Services ·
 *                         Showcase · About (+ reviews) — each only when it has
 *                         something behind it
 *   footer  minimal       «install the app», on the store's own host only
 *
 * with the `classic` tokens and `accent: 'store'`, so the store's accent from
 * settings keeps applying. Nothing the store says is COPIED into the layout —
 * the hero, tabs and cards read the store's live data — so a merchant who keeps
 * editing settings keeps seeing those edits, published layout or not.
 */
import { makeBlock } from './normalize';
import type { StoreLayout } from './schema';
import { THEME_PRESETS } from './tokens';

/** What the generator may read from a store row. Everything is optional. */
export interface DefaultLayoutStore {
  accent?: unknown;
  sells_direct_products?: unknown;
  accepts_custom_requests?: unknown;
}

/**
 * The store row is accepted, and read for nothing today: the classic page is
 * the same skeleton for every store, and what differs — accent, words,
 * pictures, which tabs have content — is read live when the page renders.
 */
export function defaultLayoutFromStore(_store: DefaultLayoutStore | null = null): StoreLayout {
  return {
    schema_version: 1,
    theme: 'classic',
    tokens: { ...THEME_PRESETS.classic },
    header: { variant: 'overlay' },
    footer: { variant: 'minimal' },
    blocks: [makeBlock('hero', 'hero', { variant: 'profile' }), makeBlock('tabs', 'tabs')],
  };
}
