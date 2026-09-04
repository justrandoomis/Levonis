import { Hono } from 'hono';
import type { AppContext, Env } from './lib/types';
import { HttpError, originCheck, securityHeaders } from './lib/http';
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
import { classifyHost, rootDomainFrom, adminAllowedOn } from './lib/hosts';
import { merchantRoutes } from './routes/merchant';
import { storefrontRoutes } from './routes/storefront';
import { marketplaceRoutes } from './routes/marketplace';
import { storeOrderRoutes } from './routes/storeOrders';
import { communityReviewRoutes } from './routes/merchantReviews';
import { communityFavoriteRoutes } from './routes/communityFavorites';
import { adminCommunityRoutes } from './routes/adminCommunity';
import { bundlesRoutes, adminBundlesRoutes } from './routes/bundles';

const app = new Hono<AppContext>();

app.use('*', securityHeaders());
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
app.use('/api/admin/*', async (c, next) => {
  // `adminAllowedOn`, not `kind === 'main'`: see the note on that function.
  // The short version is that a mistyped APP_ORIGIN classified the apex
  // itself as `foreign` and took the entire admin API down with a 404, while
  // protecting nobody.
  if (!adminAllowedOn(c.get('host'))) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  await next();
});

app.route('/api/auth', authRoutes);
app.route('/api/products', productRoutes);
// Members-only bundles section; mounted before the '/api' misc catch-all so
// nothing there can ever shadow it. Same for its admin CRUD below.
app.route('/api/bundles', bundlesRoutes);
app.route('/api/admin/bundles', adminBundlesRoutes);
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
app.route('/api', miscRoutes);
app.route('/api/admin', adminRoutes);
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
  fetch: app.fetch,
  // Durable jobs: outbox delivery (email/telegram), stale-challenge expiry,
  // gated BNPL overdue stub. Idempotent — safe under overlapping runs.
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDurableJobs(env));
  },
};
