/**
 * THE BLOCK REGISTRY — every block a store page can hold, and every setting
 * each block has, declared as data.
 *
 * One declaration serves three readers:
 *   - the normaliser (normalize.ts), which accepts a setting only if it is
 *     declared here, in the declared type and within the declared bounds;
 *   - the storefront renderer, whose block components receive settings typed
 *     from these declarations (`SettingsOf<'hero'>`);
 *   - the store builder (wave 4), which draws each block's inspector from the
 *     same field list, so an editor can never offer a setting the server would
 *     strip or a value it would refuse.
 *
 * Adding a block is adding an entry here and a component in
 * src/components/storefront/blocks/ — nothing else needs to learn about it.
 * Removing a setting is safe: stored layouts that still carry it have it
 * stripped on read, with an issue, never an error.
 */
import type { LocalizedText } from './text';
import type { LinkTarget, MediaKind, SocialItem } from './refs';

export type RefKind = 'product' | 'collection' | 'coupon';

type ScalarSpec =
  | { readonly t: 'bool'; readonly d: boolean }
  | { readonly t: 'enum'; readonly values: readonly string[]; readonly d: string }
  | { readonly t: 'int'; readonly min: number; readonly max: number; readonly d: number }
  /** LocalizedText; `max` is per language. */
  | { readonly t: 'text'; readonly max: number; readonly multiline?: boolean }
  /** A storage key the store's owner uploaded; '' = none. */
  | { readonly t: 'media'; readonly kind: MediaKind }
  | { readonly t: 'link' }
  /** An ISO instant between 2020 and 2100; '' = none. */
  | { readonly t: 'date' }
  /** One id of this store's own rows; '' = none. */
  | { readonly t: 'ref'; readonly ref: RefKind }
  | { readonly t: 'refs'; readonly ref: RefKind; readonly max: number }
  /** An ordered subset of `values`, no repeats, `min`..`max` long. */
  | { readonly t: 'set'; readonly values: readonly string[]; readonly min: number; readonly max: number; readonly d: readonly string[] }
  | { readonly t: 'socials'; readonly max: number };

export type FieldSpec =
  | ScalarSpec
  /** A list of small records. An item missing any `requires` field is dropped. */
  | { readonly t: 'list'; readonly max: number; readonly item: { readonly [k: string]: ScalarSpec }; readonly requires: readonly string[] };

/** The value a setting holds after normalisation, from its declaration. */
export type SpecValue<S> = S extends { t: 'bool' }
  ? boolean
  : S extends { t: 'enum'; values: readonly (infer V)[] }
    ? V
    : S extends { t: 'int' }
      ? number
      : S extends { t: 'text' }
        ? LocalizedText
        : S extends { t: 'media' | 'date' | 'ref' }
          ? string
          : S extends { t: 'link' }
            ? LinkTarget
            : S extends { t: 'refs' }
              ? string[]
              : S extends { t: 'set'; values: readonly (infer V)[] }
                ? V[]
                : S extends { t: 'socials' }
                  ? SocialItem[]
                  : S extends { t: 'list'; item: infer I }
                    ? Array<{ -readonly [K in keyof I]: SpecValue<I[K]> }>
                    : never;

export interface BlockDef {
  /** The first variant is the default. */
  readonly variants: readonly string[];
  readonly settings: { readonly [k: string]: FieldSpec };
  /** At most this many blocks of this type in one layout (default 10). */
  readonly max?: number;
  /**
   * A capability the platform must have before a builder offers this block.
   * `merchant_video_upload`: merchant uploads (`purpose=community`) refuse
   * video today, so no store can own a video key yet and a video block
   * normalises to an empty one — the builder must not offer it until uploads
   * accept merchant video.
   */
  readonly requires?: 'merchant_video_upload';
}

/** The icon names a profile widget may carry — worker/routes/merchant.ts WIDGET_ICONS. */
export const WIDGET_ICON_NAMES = [
  'link', 'globe', 'instagram', 'facebook', 'youtube', 'tiktok', 'telegram', 'whatsapp',
  'phone', 'map-pin', 'clock', 'package', 'truck', 'shield', 'star', 'printer',
  'layers', 'hammer', 'zap', 'award',
] as const;

const title = (max = 60) => ({ t: 'text', max }) as const;
const PRODUCT_SOURCES = ['latest', 'featured', 'deals', 'collection'] as const;
export const TAB_KINDS = ['products', 'collections', 'deals', 'services', 'showcase', 'about'] as const;
export const SHOWCASE_KINDS = ['work', 'printer', 'material'] as const;
export const STAT_METRICS = ['rating', 'positive', 'products', 'followers', 'completed_orders', 'years'] as const;

export const BLOCKS = {
  /**
   * The store's identity at the top of the page. `profile` is the reference
   * profile every store had before blocks (cover, avatar, three honest stats,
   * bio, three links, three info cards, contact/follow/share). Empty text and
   * an empty image mean «use the store's own»: the name, tagline and banner
   * stay the store's data, edited in settings, never copied into the layout.
   */
  hero: {
    variants: ['profile', 'cover', 'split', 'minimal'],
    max: 1,
    settings: {
      image: { t: 'media', kind: 'image' },
      headline: title(80),
      subheadline: { t: 'text', max: 200 },
      show_cover: { t: 'bool', d: true },
      show_stats: { t: 'bool', d: true },
      show_bio: { t: 'bool', d: true },
      show_links: { t: 'bool', d: true },
      show_info_cards: { t: 'bool', d: true },
      show_actions: { t: 'bool', d: true },
      cta_label: title(30),
      cta_link: { t: 'link' },
      align: { t: 'enum', values: ['center', 'start'], d: 'center' },
    },
  },
  banner: {
    variants: ['wide', 'inset'],
    settings: {
      image: { t: 'media', kind: 'image' },
      title: title(80),
      subtitle: { t: 'text', max: 160 },
      cta_label: title(30),
      link: { t: 'link' },
      overlay: { t: 'enum', values: ['dim', 'none'], d: 'dim' },
      height: { t: 'enum', values: ['medium', 'short', 'tall'], d: 'medium' },
    },
  },
  image_text: {
    variants: ['image_start', 'image_end'],
    settings: {
      image: { t: 'media', kind: 'image' },
      title: title(80),
      body: { t: 'text', max: 1200, multiline: true },
      cta_label: title(30),
      link: { t: 'link' },
    },
  },
  products_grid: {
    variants: ['grid'],
    settings: {
      title: title(),
      source: { t: 'enum', values: PRODUCT_SOURCES, d: 'latest' },
      collection_id: { t: 'ref', ref: 'collection' },
      limit: { t: 'int', min: 2, max: 24, d: 6 },
      show_more: { t: 'bool', d: true },
    },
  },
  products_carousel: {
    variants: ['carousel'],
    settings: {
      title: title(),
      source: { t: 'enum', values: PRODUCT_SOURCES, d: 'latest' },
      collection_id: { t: 'ref', ref: 'collection' },
      limit: { t: 'int', min: 2, max: 24, d: 10 },
    },
  },
  featured_products: {
    variants: ['grid', 'carousel'],
    settings: {
      title: title(),
      product_ids: { t: 'refs', ref: 'product', max: 12 },
    },
  },
  collections: {
    variants: ['chips', 'list', 'cards'],
    settings: {
      title: title(),
      /** Empty = every active collection that holds a published product. */
      collection_ids: { t: 'refs', ref: 'collection', max: 30 },
    },
  },
  deals: {
    variants: ['grid', 'carousel'],
    settings: {
      title: title(),
      limit: { t: 'int', min: 2, max: 24, d: 6 },
    },
  },
  /** A live coupon of this store. It renders nothing once the coupon is not usable. */
  coupon_banner: {
    variants: ['ticket'],
    max: 4,
    settings: {
      coupon_id: { t: 'ref', ref: 'coupon' },
      title: title(),
      note: { t: 'text', max: 160 },
    },
  },
  /** A merchant-set deadline. It hides itself when the moment passes — no looping urgency. */
  countdown: {
    variants: ['bar', 'card'],
    max: 3,
    settings: {
      title: title(80),
      ends_at: { t: 'date' },
      cta_label: title(30),
      link: { t: 'link' },
    },
  },
  services: {
    variants: ['list', 'grid'],
    settings: {
      title: title(),
      limit: { t: 'int', min: 1, max: 40, d: 40 },
      /** The quote/chat doors under the list. */
      show_doors: { t: 'bool', d: true },
    },
  },
  showcase: {
    variants: ['grouped', 'grid'],
    settings: {
      title: title(),
      kinds: { t: 'set', values: SHOWCASE_KINDS, min: 1, max: 3, d: SHOWCASE_KINDS },
      limit: { t: 'int', min: 1, max: 60, d: 60 },
    },
  },
  reviews: {
    variants: ['list', 'cards'],
    max: 2,
    settings: {
      title: title(),
      limit: { t: 'int', min: 1, max: 20, d: 6 },
      show_summary: { t: 'bool', d: true },
    },
  },
  faq: {
    variants: ['accordion'],
    settings: {
      title: title(),
      items: {
        t: 'list',
        max: 12,
        requires: ['q', 'a'],
        item: { q: { t: 'text', max: 160 }, a: { t: 'text', max: 600, multiline: true } },
      },
    },
  },
  text: {
    variants: ['plain', 'callout'],
    settings: {
      title: title(80),
      body: { t: 'text', max: 2000, multiline: true },
      align: { t: 'enum', values: ['start', 'center'], d: 'start' },
    },
  },
  gallery: {
    variants: ['grid', 'carousel'],
    settings: {
      title: title(),
      images: {
        t: 'list',
        max: 24,
        requires: ['image'],
        item: { image: { t: 'media', kind: 'image' }, caption: { t: 'text', max: 120 } },
      },
    },
  },
  /** The merchant's OWN uploaded video — never an embed (the CSP allows no third-party frame). */
  video: {
    variants: ['inline'],
    max: 4,
    requires: 'merchant_video_upload',
    settings: {
      title: title(80),
      video: { t: 'media', kind: 'video' },
      poster: { t: 'media', kind: 'image' },
      caption: { t: 'text', max: 200 },
      autoplay: { t: 'bool', d: false },
    },
  },
  social_links: {
    variants: ['pills', 'icons'],
    settings: {
      title: title(),
      /** `store` shows the links saved in store settings; `custom` the items below. */
      source: { t: 'enum', values: ['store', 'custom'], d: 'store' },
      items: { t: 'socials', max: 8 },
    },
  },
  cta: {
    variants: ['accent', 'subtle'],
    settings: {
      title: title(80),
      body: { t: 'text', max: 300, multiline: true },
      label: title(30),
      link: { t: 'link' },
      align: { t: 'enum', values: ['center', 'start'], d: 'center' },
    },
  },
  contact: {
    variants: ['card'],
    max: 2,
    settings: {
      title: title(),
      show_phone: { t: 'bool', d: true },
      show_hours: { t: 'bool', d: true },
      show_location: { t: 'bool', d: true },
      show_chat: { t: 'bool', d: true },
    },
  },
  delivery_info: {
    variants: ['card'],
    max: 2,
    settings: {
      title: title(),
      show_areas: { t: 'bool', d: true },
      show_note: { t: 'bool', d: true },
    },
  },
  /** The workshop's machines, from the printers the merchant registered — capability, never cost. */
  printers: {
    variants: ['cards', 'list'],
    max: 2,
    settings: {
      title: title(),
      limit: { t: 'int', min: 1, max: 20, d: 12 },
      show_materials: { t: 'bool', d: true },
    },
  },
  /** Shown only while the store takes custom requests and the board is open to the visitor. */
  custom_request_cta: {
    variants: ['card'],
    max: 2,
    settings: {
      title: title(80),
      body: { t: 'text', max: 300, multiline: true },
      label: title(30),
    },
  },
  /** Real figures only; a metric with no data (no reviews yet) is left out, never faked. */
  stats: {
    variants: ['row', 'cards'],
    max: 2,
    settings: {
      title: title(),
      metrics: { t: 'set', values: STAT_METRICS, min: 1, max: 4, d: ['positive', 'products', 'followers'] },
    },
  },
  info_cards: {
    variants: ['row', 'grid'],
    settings: {
      source: { t: 'enum', values: ['store', 'custom'], d: 'store' },
      items: {
        t: 'list',
        max: 6,
        requires: ['title'],
        item: {
          icon: { t: 'enum', values: WIDGET_ICON_NAMES, d: 'link' },
          title: { t: 'text', max: 40 },
          subtitle: { t: 'text', max: 60 },
        },
      },
    },
  },
  /**
   * The storefront's tab strip: each tab is one of the stacked blocks above,
   * rendered in place (products with «show all» and paging, collections that
   * filter them, deals, services, showcase, about with reviews). A tab with
   * nothing behind it is not shown.
   */
  tabs: {
    variants: ['underline'],
    max: 1,
    settings: {
      items: { t: 'set', values: TAB_KINDS, min: 1, max: 6, d: TAB_KINDS },
      about_reviews: { t: 'bool', d: true },
      products_preview: { t: 'int', min: 2, max: 24, d: 6 },
    },
  },
  /** The store's own story from settings: description, specialities, areas, hours, contact, policies, links. */
  about: {
    variants: ['cards'],
    max: 1,
    settings: {
      title: title(),
      show_policies: { t: 'bool', d: true },
      show_hours: { t: 'bool', d: true },
    },
  },
} as const satisfies Record<string, BlockDef>;

export type BlockType = keyof typeof BLOCKS;
export const BLOCK_TYPES = Object.keys(BLOCKS) as BlockType[];
export type VariantOf<T extends BlockType> = (typeof BLOCKS)[T]['variants'][number];
export type SettingsOf<T extends BlockType> = {
  -readonly [K in keyof (typeof BLOCKS)[T]['settings']]: SpecValue<(typeof BLOCKS)[T]['settings'][K]>;
};

export function isBlockType(v: unknown): v is BlockType {
  // OWN keys only: `constructor`, `toString` and `__proto__` are "in" every
  // object and must never be mistaken for a block type.
  return typeof v === 'string' && Object.hasOwn(BLOCKS, v);
}

export const DEFAULT_BLOCK_MAX = 10;
export function blockMax(type: BlockType): number {
  const def: BlockDef = BLOCKS[type];
  return def.max ?? DEFAULT_BLOCK_MAX;
}
