import { Hono } from 'hono';
import type { AppContext, Env } from './lib/types';
import { HttpError, originCheck, requireMainHost, securityHeaders } from './lib/http';
import { loadSessionUser } from './lib/session';
import { runDurableJobs } from './lib/jobs';
import { authRoutes } from './routes/auth';
import { productRoutes, homeRoutes } from './routes/products';
import { cartRoutes } from './routes/cart';
import { orderRoutes } from './routes/orders';
import { addressRoutes } from './routes/addresses';
import { walletRoutes } from './routes/wallet';
import { rewardRoutes } from './routes/rewards';
import { subscriptionRoutes } from './routes/subscription';
import { investRoutes } from './routes/invest';
import { communityRoutes } from './routes/community';
import { chatRoutes } from './routes/chats';
import { profileRoutes } from './routes/profile';
import { uploadRoutes, fileRoutes } from './routes/uploads';
import { miscRoutes } from './routes/misc';
import { adminRoutes } from './routes/admin';
import { adminProductsRoutes } from './routes/adminProducts';
import { templateRoutes } from './routes/template';
import { mediaRoutes } from './routes/media';
import { adminTaxonomyRoutes } from './routes/adminTaxonomy';
import { warrantyAdminRoutes, warrantyPublicRoutes } from './routes/warranty';
import { adminImportRoutes } from './routes/adminImport';
import { adminProductRelationsRoutes } from './routes/adminProductRelations';
import { adminPriceGridRoutes } from './routes/adminPriceGrid';
import { printRequestRoutes } from './routes/printRequests';
import { notificationRoutes } from './routes/notifications';
import { merchantPrinterRoutes } from './routes/merchantPrinters';
import { membershipsRoutes } from './routes/memberships';
import { telegramRoutes } from './routes/telegram';
import { invoiceRoutes } from './routes/invoices';
import { deviceRoutes } from './routes/devices';
import { reviewRoutes } from './routes/reviews';
import { returnRoutes, priceProtectionRoutes } from './routes/returns';
import { policiesRoutes } from './routes/policies';
import { kycRoutes } from './routes/kyc';
import { supportRoutes } from './routes/support';
import { referralRoutes } from './routes/referrals';
import { studioRoutes } from './routes/studio';
import { classifyHost, rootDomainFrom } from './lib/hosts';
import { merchantRoutes } from './routes/merchant';
import { storefrontRoutes } from './routes/storefront';
import { marketplaceRoutes } from './routes/marketplace';
import { storeOrderRoutes } from './routes/storeOrders';
import { communityReviewRoutes } from './routes/merchantReviews';
import { communityFavoriteRoutes } from './routes/communityFavorites';
import { adminCommunityRoutes } from './routes/adminCommunity';
import { bundlesRoutes } from './routes/bundles';
// The bundles PANEL is its own router (docs/BUNDLES_MYSTERY.md §11): a bundle
// is a `products` row now, so the admin side rides productPersistence rather
// than the legacy `bundles` table the public route still reads.
import { adminBundlesRoutes } from './routes/adminBundles';
// The mystery panel is its OWN router with its OWN `.use('*', requireAdmin)`
// (docs/BUNDLES_MYSTERY.md §10): requireMainHost below is a HOST check and
// never a role check, so a mount without that guard would expose pool weights
// and the eligible-stock preview to any signed-in customer.
import { adminMysteryRoutes } from './routes/mystery';
// The special-offers panel and the composition analytics screens, each its own
// router with its own `.use('*', requireAdmin)` for the same reason.
import { adminOffersRoutes } from './routes/offers';
import { adminCompositionAnalyticsRoutes } from './routes/bundles';
import { farmRoutes } from './routes/farm';
import { farmAdminRoutes } from './routes/farmAdmin';
import { configureEventBus } from './lib/eventBus';
import { gatewayAssertion } from './entrypoints/gatewayAssertion';

const app = new Hono<AppContext>();

/**
 * The inbound gateway assertion (`01-TARGET.md` §4 item 1, Phase 1.6). At
 * `GATEWAY_ONLY=off` — its default and the only value any deployment has today
 * — it returns immediately, before reading a header or building a key ring, so
 * this line changes nothing until the gateway exists. Then `log` counts the
 * requests that did not come through the gateway and `on` refuses them.
 */
// SECURITY HEADERS OUTERMOST, so they are set even on a refusal thrown further
// in — the gateway's own app says the same thing for the same reason
// (`services/gateway/src/app.ts`). `gatewayAssertion` short-circuits with a 403
// NOT_VIA_GATEWAY and never calls `next()`, and Hono composes in registration
// order, so registering it FIRST meant that refusal carried no CSP and no HSTS.
app.use('*', securityHeaders());
app.use('*', gatewayAssertion);
app.use('*', originCheck());

/**
 * Classify the request host ONCE, before anything else looks at it.
 *
 * Every merchant-scoped route reads `c.get('host')` rather than re-parsing
 * the Host header, so there is exactly one place in the Worker where a
 * hostname turns into a decision.
 */
app.use('*', async (c, next) => {
  c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
  await next();
});

app.use('*', async (c, next) => {
  await loadSessionUser(c);
  await next();
});

/**
 * GLOBAL ADMIN IS APEX-ONLY. This is the guard that makes wildcard merchant
 * subdomains survivable.
 *
 * The session cookie is scoped to `.levonis-iq.com`, so it is sent to every
 * storefront. A merchant controls the content of their own storefront. If
 * `evil.levonis-iq.com` could serve a page that calls
 * `evil.levonis-iq.com/api/admin/...`, that call would be SAME-ORIGIN —
 * `originCheck` sees a matching origin and allows it — and it would carry a
 * visiting platform admin's own session. One admin visiting one hostile shop
 * would be enough.
 *
 * So platform administration is refused on every host except the main site.
 * A merchant page cannot reach it at all, whatever it puts in the request
 * (§53). Merchant administration is NOT here: it lives under
 * /api/merchant/*, is scoped to the caller's own store, and is deliberately
 * a different thing with a different name.
 *
 * 404, not 403: a wrong-host caller learns the route does not exist here
 * rather than that it exists elsewhere.
 */
// `adminAllowedOn`, not `kind === 'main'`: see the note on that function.
// The short version is that a mistyped APP_ORIGIN classified the apex itself
// as `foreign` and took the entire admin API down with a 404, while protecting
// nobody. The same middleware guards credential changes in routes/auth.ts.
app.use('/api/admin/*', requireMainHost);

app.route('/api/auth', authRoutes);
app.route('/api/products', productRoutes);
// Members-only bundles section; mounted before the '/api' misc catch-all so
// nothing there can ever shadow it. Same for its admin CRUD below.
app.route('/api/bundles', bundlesRoutes);
app.route('/api/admin/bundles', adminBundlesRoutes);
app.route('/api/admin/mystery', adminMysteryRoutes);
app.route('/api/admin/offers', adminOffersRoutes);
app.route('/api/admin/analytics', adminCompositionAnalyticsRoutes);
app.route('/api/home', homeRoutes);
app.route('/api/cart', cartRoutes);
app.route('/api/orders', orderRoutes);
app.route('/api/addresses', addressRoutes);
app.route('/api/wallet', walletRoutes);
app.route('/api/rewards', rewardRoutes);
app.route('/api/subscription', subscriptionRoutes);
app.route('/api/invest', investRoutes);
app.route('/api/community', communityRoutes);
app.route('/api/chats', chatRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/uploads', uploadRoutes);
// LEVO Printer Farm — the player API. Mounted before the '/api' misc catch-all
// so nothing there can shadow it; its one public route (the leaderboard) is
// registered inside the module ahead of its own requireAuth.
app.route('/api/farm', farmRoutes);
app.route('/api', miscRoutes);
app.route('/api/admin', adminRoutes);
// The farm's balancing console. Under /api/admin/* on purpose: the apex-only
// host guard above covers it, and the generic settings PUT refuses its key so
// this normalising, versioned, audited route is the only way to change it.
app.route('/api/admin/farm', farmAdminRoutes);
app.route('/api/admin/products-v2', adminProductsRoutes);
app.route('/api/admin/template', templateRoutes);
app.route('/api/admin/media', mediaRoutes);
app.route('/api/admin/taxonomy', adminTaxonomyRoutes);
// The issued warranty document: public verification by receipt number or by
// the serial on the device, and the admin side that issues and prints it.
app.route('/api/warranty', warrantyPublicRoutes);
app.route('/api/admin/warranties', warrantyAdminRoutes);
app.route('/api/admin/community', adminCommunityRoutes);
app.route('/api/admin/import', adminImportRoutes);
// Mounted on the same prefix as adminProductsRoutes; the paths are distinct
// (/:id/relations, /:id/stock) so neither router shadows the other.
app.route('/api/admin/products', adminProductRelationsRoutes);
// Quick Edit pricing shares that prefix too; its paths (/:id/price-grid,
// /:id/price-history) are distinct from both routers above, so none shadows
// another.
app.route('/api/admin/products', adminPriceGridRoutes);
app.route('/api/memberships', membershipsRoutes);
app.route('/api/telegram', telegramRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/devices', deviceRoutes);
app.route('/api/reviews', reviewRoutes);
app.route('/api/returns', returnRoutes);
app.route('/api/price-protection', priceProtectionRoutes);
app.route('/api/policies', policiesRoutes);
app.route('/api/kyc', kycRoutes);
app.route('/api/support', supportRoutes);
// Referrals & support codes (integrated mandate §3). Signup invites and
// purchase support codes live behind /api/referrals; the module itself keeps
// them separate and never lets a support code touch pricing.
app.route('/api/referrals', referralRoutes);
app.route('/api/studio', studioRoutes);
// Merchant store administration. Scoped to the caller's OWN store on every
// route — deliberately not under /api/admin, which is the platform's.
app.route('/api/merchant', merchantRoutes);
// Printers and request-notification preferences: what a shop can make, and
// which of those jobs it wants to hear about.
app.route('/api/merchant', merchantPrinterRoutes);
// The public shopfront: readable by anyone, on any host.
app.route('/api/storefront', storefrontRoutes);
// The print journey EXTENDS the marketplace rather than starting a second one:
// it adds measuring, estimating, publishing and matching to the same requests.
// Mounted BEFORE the marketplace for the same reason the product routes put
// /brands before /:id — the more specific prefix is registered first so it can
// never be shadowed by a parameterised route above it.
app.route('/api/marketplace/print', printRequestRoutes);
// The customer-request marketplace: requests, offers, escrowed community orders.
app.route('/api/marketplace', marketplaceRoutes);
// The in-app notification inbox. General, not print-specific: it is what was
// missing when a merchant needed to be told a matching request had been posted.
app.route('/api/notifications', notificationRoutes);
// Checkout for merchant store products — the other merchant commerce path.
app.route('/api/store-orders', storeOrderRoutes);
// Customer-side reviews and store follows.
app.route('/api/community-reviews', communityReviewRoutes);
app.route('/api/community-favorites', communityFavoriteRoutes);
app.route('/files', fileRoutes);

// The previous architecture exposed raw SQL and schema management over HTTP.
// Those endpoints are gone; explicit 410s make the removal visible to any
// stale client instead of a confusing 404/SPA response.
app.all('/api/d1/query', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/d1/init', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/make-all-investors', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/upload', (c) => c.json({ success: false, error: 'Use POST /api/uploads.' }, 410));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // Anything else falls through to the static assets (SPA).
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      err.status as 400
    );
  }
  // Detailed diagnostics stay server-side; clients get a safe generic error.
  console.error('Unhandled error', c.req.method, c.req.path, err);
  return c.json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
});

export default {
  // Unchanged behaviour: the same Hono app, called the same way. The one added
  // line hands this invocation's `env` to the event bus, which is how
  // `audit(db, …)` and the wallet/inventory helpers — all of which take a
  // database, not an environment — find their producer. With no
  // `EVENT_BUS_ENABLED=on` var that call builds one small object and nothing
  // else ever happens.
  //
  // (Line comments, not a block, and no comment terminator anywhere below the
  // admin mount: the naive comment stripper in tests/storefrontIsolation.test.ts
  // reads the slash-star inside the string '/api/admin/[star]' above as a
  // comment opener, so the next terminator after that line would swallow the
  // admin host guard the test is asserting on.)
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    configureEventBus(env);
    return app.fetch(request, env, ctx);
  },
  // Durable jobs: the event pump (step 0), outbox delivery (email/telegram),
  // stale-challenge expiry, gated BNPL overdue stub. Idempotent — safe under
  // overlapping runs.
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    configureEventBus(env);
    ctx.waitUntil(runDurableJobs(env));
  },
};

// THE NAMED ENTRYPOINTS (02-MIGRATION-PLAN.md 1.6). A binding of the form
// `{ binding: 'IDENTITY', service: 'levonis-core-dark', entrypoint:
// 'IdentityEntrypoint' }` reaches these classes and nothing else — the default
// export above is untouched, so every route this Worker serves today is served
// exactly as it was. Their methods are the contract
// (worker/entrypoints/CONTRACT.md, typed by packages/contracts/src/rpc/) and
// each one verifies the caller's signed hop before it touches anything.
export { IdentityEntrypoint } from './entrypoints/IdentityEntrypoint';
export { LedgerEntrypoint } from './entrypoints/LedgerEntrypoint';
export { CatalogEntrypoint } from './entrypoints/CatalogEntrypoint';
export { OrdersEntrypoint } from './entrypoints/OrdersEntrypoint';
