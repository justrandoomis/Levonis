/**
 * THE STOREFRONT RUNTIME — what a block may DO, supplied by whoever renders it.
 *
 * Blocks are presentation plus the store's data. Everything that acts — follow,
 * message the store, share, save a product, install the app, load another page
 * of products — comes from the host through this context:
 *
 *   - the storefront page (src/pages/Storefront.tsx) supplies the live
 *     controls, signed-in state, the community gate and real loaders;
 *   - the builder's preview (and the design panel) supplies `previewRuntime()`
 *     (./preview.tsx): the same controls drawn inert, loaders that fetch
 *     nothing, links that go nowhere. A preview can never follow a store or
 *     open a chat.
 *
 * That is also why blocks never import builder or workspace code
 * (tests/storefrontBlocks.test.ts): everything they need arrives here.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { MerchantProduct } from '../../lib/merchant';
import type { LinkRoute } from '../../../packages/storeLayout/src/refs';
import type {
  CollectionData,
  ProductPage,
  ProductSource,
  ReviewsData,
  ServiceData,
  ShowcaseData,
} from '../../../packages/storeLayout/src/data';
import type { AccentClasses } from './theme';

export type TabKind = 'products' | 'collections' | 'deals' | 'services' | 'showcase' | 'about';

export interface ProductQueryRequest {
  source: ProductSource;
  collection_id: string;
  cursor: string | null;
}

export interface StorefrontRuntime {
  /** `live` on a real storefront; `preview` in the builder / design panel. */
  mode: 'live' | 'preview';
  /** Rendered on the store's own host (`slug.levonis-iq.com`). */
  onHost: boolean;
  /** A community merchant with no store row: the reference profile, no tabs of its own data. */
  profileOnly: boolean;
  /** Levo Community is open to this viewer (the request board and follows live there). */
  communityOpen: boolean;
  /** The tab the address asked for (`/about`, `/reviews`, `?tab=`), if any. */
  initialTab: TabKind | null;
  /** A collection the address asked to filter by (`?section=`), or ''. */
  section: string;
  /** Profile-only mode: the merchant's legacy products, already loaded. */
  injectedProducts: MerchantProduct[] | null;
  /** Save or unsave a product (the heart). The saved set is `useSavedIds()`. */
  toggleSave: (productId: string) => void;
  productHref: (productSlug: string) => string;
  /** A product the profile-only view links to its historical page. */
  legacyProductHref: (productSlug: string) => string;
  routeHref: (route: LinkRoute) => string;
  collectionHref: (collectionId: string) => string;
  /** The request board, on whichever host serves it. */
  requestsHref: string;
  loadProducts: (q: ProductQueryRequest) => Promise<{ items: MerchantProduct[]; next_cursor: string | null }>;
  loadCollections: () => Promise<CollectionData[]>;
  loadServices: () => Promise<ServiceData[]>;
  loadShowcase: () => Promise<ShowcaseData[]>;
  loadReviews: () => Promise<ReviewsData>;
  // ---- live controls the host draws
  /** The way out of the store, in the header's corner. */
  Back: ComponentType;
  /** The ⋯ menu in the header's other corner: share, copy the link (and the owner's own rows). */
  Menu: ComponentType;
  /** Contact + follow (with the share pin), the profile's action row. */
  ProfileActions: ComponentType<{ accent: AccentClasses }>;
  /** The real doors to buying a service: a quote through the board, or a chat. */
  ServiceDoors: ComponentType<{ accepts: boolean }>;
  /** «Message the store», as one button. */
  ChatButton: ComponentType<{ className?: string; children?: ReactNode }>;
  /** «Install the app», on the store's own host only. */
  InstallCard: ComponentType;
}

// ------------------------------------------------------------ no host

const Nothing = () => null;
const nothing = () => Promise.resolve([] as never[]);

function PlainChatButton({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <span className={className}>{children}</span>;
}

/**
 * What a block sees with no host above it: nothing drawn, nothing loaded,
 * links that go nowhere. Every real host provides a runtime — the storefront
 * page its live one, a preview `previewRuntime()` (./preview.tsx), which the
 * live storefront never downloads.
 */
export const NO_HOST: StorefrontRuntime = {
  mode: 'preview',
  onHost: false,
  profileOnly: false,
  communityOpen: false,
  initialTab: null,
  section: '',
  injectedProducts: null,
  toggleSave: () => {},
  productHref: () => '#',
  legacyProductHref: () => '#',
  routeHref: () => '#',
  collectionHref: () => '#',
  requestsHref: '#',
  loadProducts: () => Promise.resolve({ items: [], next_cursor: null }),
  loadCollections: nothing,
  loadServices: nothing,
  loadShowcase: nothing,
  loadReviews: () => Promise.resolve({ average: null, count: 0, distribution: {}, reviews: [], next_cursor: null }),
  Back: Nothing,
  Menu: Nothing,
  ProfileActions: Nothing,
  ServiceDoors: Nothing,
  ChatButton: PlainChatButton,
  InstallCard: Nothing,
};

const RuntimeContext = createContext<StorefrontRuntime>(NO_HOST);

export const StorefrontRuntimeProvider = RuntimeContext.Provider;

export function useStorefrontRuntime(): StorefrontRuntime {
  return useContext(RuntimeContext);
}

/**
 * The visitor's saved products, in their OWN context: the set changes on every
 * heart, and the runtime must not — blocks key their loading effects on it.
 */
const SavedIdsContext = createContext<ReadonlySet<string>>(new Set());

export const SavedIdsProvider = SavedIdsContext.Provider;

export function useSavedIds(): ReadonlySet<string> {
  return useContext(SavedIdsContext);
}


export type { ProductPage };
