/**
 * The share kit's client contract — `GET /api/merchant/store/share`
 * (worker/routes/merchant.ts → worker/lib/storeShareKit.ts).
 *
 * Kept inside this feature folder rather than in `src/lib/merchant.ts` so the
 * `ShareStore` panel is self-contained: the wave-3 Merchant Workspace mounts
 * the folder unchanged. Nothing here is authoritative — every field is what
 * the server said: the card is the one its crawler-facing document carries,
 * the icon the one its manifest serves.
 */
import { api } from '../../../lib/api';

/** Where the store's app icon stands (worker/lib/storeIcons.ts `StoreIconState`). */
export type AppIconState = 'ready' | 'pending' | 'failed' | 'unavailable' | 'none';

export interface StoreShareCard {
  title: string;
  description: string;
  /** Absolute, or '' when the store has no picture a crawler may fetch. */
  image: string;
  site_name: string;
  url: string;
}

export interface StoreShareKit {
  store_id: string;
  /** The absolute address to copy, share and encode. */
  url: string;
  /** What a person reads (`ali3d.levonis-iq.com`), or '' for an in-app address. */
  host: string;
  /** Null when the store is suspended: its link unfurls as nothing of it. */
  card: StoreShareCard | null;
  app_icon: {
    state: AppIconState;
    /** A stable code (see `iconStateLine`), never text to show as-is. */
    reason: string | null;
    icon: string | null;
    maskable: string | null;
    name: string;
    short_name: string;
    background: string;
  };
  suspended: boolean;
}

export const shareStoreApi = {
  kit: () => api.get<{ success: true } & StoreShareKit>('/api/merchant/store/share'),
};
