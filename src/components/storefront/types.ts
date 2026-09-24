/**
 * The shapes the storefront renderer works with. The store is what
 * `/api/storefront/resolve` (or `/:slug`, `/by-id`) answers: the public profile
 * plus the published layout and the rows its blocks show.
 */
import type { MerchantStore } from '../../lib/merchant';
import type { BlockData } from '../../../packages/storeLayout/src/data';
import type { ThemeTokens } from '../../../packages/storeLayout/src/tokens';
import type { BlockType } from '../../../packages/storeLayout/src/blocks';
import type { BlockOf } from '../../../packages/storeLayout/src/schema';

export interface StorefrontStore extends MerchantStore {
  /** The server's layout. It is normalised AGAIN before anything renders. */
  layout?: unknown;
  layout_source?: 'published' | 'default';
  layout_revision?: number | null;
  blocks_data?: Partial<BlockData>;
  /** The product page's answer carries only the theme. */
  layout_theme?: { theme?: string; tokens?: Partial<ThemeTokens> };
}

export interface BlockProps<T extends BlockType> {
  block: BlockOf<T>;
  store: StorefrontStore;
  data: BlockData;
}
