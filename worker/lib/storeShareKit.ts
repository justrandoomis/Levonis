/**
 * THE SHARE KIT — everything a merchant needs to hand their store to someone,
 * answered from the same functions the crawler and the installer read.
 *
 * `GET /api/merchant/store/share` (worker/routes/merchant.ts) returns it to
 * the store's OWNER only (`requireStoreOwner`: the store comes from the
 * session, never from the request). The `ShareStore` panel
 * (src/components/merchant/share/) renders it: the link to copy, share or
 * scan, a preview of the card that link unfurls as, and the app icon a
 * customer's phone will install.
 *
 * NO SECOND IMPLEMENTATION OF ANY OF IT. The card is `resolveStorePreview` —
 * the function `assetWithPreview` writes into the document a chat app's
 * crawler reads — and the icon is `storeIconStatus` over the same row the
 * manifest and `/store-icon/*` serve from. A preview that computed its own
 * idea of the card would be a preview of something no customer ever sees.
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { trustedOrigin } from './appOrigin';
import { rootDomainFrom, storeUrl } from './hosts';
import { storeIsSuspended, type StoreContext } from './merchantAuth';
import { resolveStorePreview } from './socialPreview';
import {
  readStoreIconsQuietly,
  scheduleStoreIconRefresh,
  storeIconStatus,
  storeSurface,
  type StoreIconState,
} from './storeIcons';
import { buildWebManifest } from './webManifest';

export interface StoreShareKit {
  store_id: string;
  /** The absolute address to copy, share and encode — the store's own host when one is configured. */
  url: string;
  /** The host a person reads (`ali3d.levonis-iq.com`), or '' when the store lives at an in-app path. */
  host: string;
  /**
   * What the link unfurls as in a chat — exactly what the crawler is handed.
   * Null for a suspended store: its link shows «المتجر غير متاح حاليًا» and
   * unfurls as nothing of the store.
   */
  card: { title: string; description: string; image: string; site_name: string; url: string } | null;
  app_icon: {
    state: StoreIconState;
    /** Stable code when not `ready` (the panel maps it to words). */
    reason: string | null;
    /** The 180 px rendition — the iPhone home-screen icon — when servable. */
    icon: string | null;
    /** The 512 px maskable rendition (Android), when servable. */
    maskable: string | null;
    /** The label an installed app carries, and the ground it sits on. */
    name: string;
    short_name: string;
    background: string;
  };
  suspended: boolean;
}

export async function storeShareKit(c: Context<AppContext>, ctx: StoreContext): Promise<StoreShareKit> {
  const root = rootDomainFrom(c.env);
  const address = storeUrl(ctx.store.slug, root, ctx.store.id);
  // `storeUrl` falls back to the in-app route when no root domain is
  // configured; a link handed to another phone has to be absolute.
  const onOwnHost = /^https?:\/\//i.test(address);
  const url = onOwnHost ? address : `${trustedOrigin(c)}${address}`;
  const origin = new URL(url).origin;
  const suspended = storeIsSuspended(ctx);

  const row = await readStoreIconsQuietly(c.env.DB, ctx.store.id);
  const status = storeIconStatus(c.env, ctx.store, row);
  // The merchant opening this panel is one more door to the lazy backfill —
  // and the one whose person is waiting to see the result.
  if (status.due && !suspended) scheduleStoreIconRefresh(c, ctx.store);

  let card: StoreShareKit['card'] = null;
  if (!suspended) {
    try {
      const preview = await resolveStorePreview(
        c.env.DB,
        origin,
        onOwnHost ? { storeSlug: ctx.store.slug } : { storeRef: ctx.store.id }
      );
      if (preview) {
        card = {
          title: preview.title,
          description: preview.description,
          image: preview.image,
          site_name: preview.siteName,
          url,
        };
      }
    } catch {
      card = null;
    }
  }

  const manifest = buildWebManifest({ name: ctx.store.name, tagline: ctx.store.tagline });
  const icons = status.icons;
  return {
    store_id: ctx.store.id,
    url,
    host: onOwnHost ? new URL(url).host : '',
    card,
    app_icon: {
      state: status.state,
      reason: status.reason,
      icon: icons ? `${origin}/files/${icons.keys.apple180}` : null,
      maskable: icons ? `${origin}/files/${icons.keys.maskable512}` : null,
      name: manifest.name,
      short_name: manifest.short_name,
      background: storeSurface(ctx.store).background,
    },
    suspended,
  };
}
