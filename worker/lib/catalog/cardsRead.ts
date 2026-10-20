/**
 * THE STOREFRONT CARD BUILDERS, AS ONE SEAM (assistant plan, step 2.1).
 *
 * The support assistant quotes the card the storefront draws: the same
 * listing, the same offers, the same tier price, the same mystery-pool rule.
 * It used to reach into `routes/products.ts` for them, which made a route file
 * the library of another route. Everything the assistant needs from the
 * catalogue now arrives through this module, and `worker/routes/support.ts`
 * and `worker/lib/assist/**` import from here only.
 *
 * Nothing is reimplemented: these are the live functions, re-exported. A price
 * computed anywhere else is the drift this seam exists to prevent.
 */
export {
  listCatalogProducts,
  pricingCtx,
  pricingCtxForUser,
  resolveListingCards,
  resolveProductCards,
  type CatalogListing,
  type PricingCtx,
} from '../../routes/products';
