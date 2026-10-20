/**
 * WHO IS ASKING, from the session only.
 *
 * The user id is the signed-in session's; no request body can name another.
 * The pricing context is the storefront's own for this viewer (tier, offers,
 * the PRO address rule), started only when a tool first needs a price, so a
 * turn the legacy handlers answer costs nothing extra.
 */
import { pricingCtxForUser, type PricingCtx } from '../catalog/cardsRead';
import type { Locale, Viewer } from './types';

export function viewerFor(db: D1Database, userId: string | null, locale: Locale): Viewer {
  let pricing: Promise<PricingCtx> | null = null;
  return {
    userId,
    locale,
    get pricing() {
      pricing ??= pricingCtxForUser(db, userId);
      return pricing;
    },
  };
}
