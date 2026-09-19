import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env } from './lib/types';
import { HttpError, originCheck, requireMainHost, securityHeaders } from './lib/http';
import { loadSessionUser } from './lib/session';
import { isAnonymousPublicMediaKey } from './lib/mediaStorage';
import { injectSocialPreview, productSlugFromPath, resolveProductPreview } from './lib/socialPreview';
import { trustedOrigin } from './lib/appOrigin';
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
import { webManifestRoute } from './routes/manifest';
import { miscRoutes } from './routes/misc';
import { adminRoutes } from './routes/admin';
import { adminProductsRoutes } from './routes/adminProducts';
import { templateRoutes } from './routes/template';
import { mediaRoutes } from './routes/media';
import { adminTaxonomyRoutes } from './routes/adminTaxonomy';
import { adminMembershipBenefitRoutes } from './routes/adminMembershipBenefits';
import { warrantyAdminRoutes, warrantyPublicRoutes } from './routes/warranty';
import { adminImportRoutes } from './routes/adminImport';
import { adminProductRelationsRoutes } from './routes/adminProductRelations';
import { adminPriceGridRoutes } from './routes/adminPriceGrid';
import { printRequestRoutes } from './routes/printRequests';
import { notificationRoutes } from './routes/notifications';
import { stockAlertRoutes } from './routes/stockAlerts';
import { compareRoutes } from './routes/compare';
import { priceReportRoutes, adminPriceReportRoutes } from './routes/priceReports';
import { merchantPrinterRoutes } from './routes/merchantPrinters';
import { printQuoteRoutes } from './routes/printQuote';
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
import { safeErrorCode } from './lib/membershipBenefits';
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
  /**
   * A PUBLIC IMAGE DOES NOT NEED TO KNOW WHO YOU ARE.
   *
   * `loadSessionUser` is a D1 JOIN (`sessions` x `users`). It was registered on
   * '*', so it ran before R2 was touched for EVERY request — including the
   * twenty-odd storefront images on a page. The session cookie is deliberately
   * scoped to the parent domain, so it is sent on every one of those requests,
   * which means a signed-in shopper paid one database read per image tile.
   * (A signed-out visitor escaped it only because `loadSessionUser` returns
   * early when there is no cookie.)
   *
   * The `/files` handler consults `user` ONLY in its private branch — an
   * anonymous-public key is served to anyone who asks. So for exactly those
   * keys the lookup is skipped. `isAnonymousPublicMediaKey` is the same
   * predicate the handler itself authorises with, so the two cannot disagree:
   * if a key is not recognised as public here, the session still loads and the
   * handler still does its own check.
   */
  const path = c.req.path;
  if (path.startsWith('/files/') && isAnonymousPublicMediaKey(path.slice('/files/'.length))) {
    await next();
    return;
  }
  /**
   * NEITHER DOES A PRODUCT PAGE'S HTML — and it now reaches the Worker.
   *
   * Putting the product paths in `run_worker_first` (wrangler.jsonc) so a
   * shared link can carry the product's own card means the Worker is invoked
   * for the DOCUMENT too, not just for the API calls the page makes after it
   * boots. Without this, a signed-in shopper opening a product page paid a
   * `sessions` x `users` JOIN for the shell itself, before the page had asked
   * for anything.
   *
   * Nothing on these paths reads `user`: they match no route, so the only
   * handler is the SPA fallback below, and the card it injects is the same
   * public product every visitor sees. The predicate is the same one that
   * decides whether to inject, so the skip cannot cover a path the fallback
   * treats differently.
   */
  if (productSlugFromPath(path)) {
    await next();
    return;
  }
  /**
   * NOR DOES THE MANIFEST, AND EVERY INSTALLING BROWSER ASKS FOR IT.
   *
   * `/manifest.webmanifest` joins `run_worker_first` below for the same
   * reason the product paths did, and it inherits the same cost: the Worker is
   * now invoked for a document that every page load links to. The handler
   * answers from the Host header and, on a merchant subdomain, from one store
   * row — it never reads `user`, and it never can: an installed app's name and
   * icon are the same for a signed-in customer and an anonymous one. Without
   * this branch a shared `.levonis-iq.com` cookie would buy a
   * `sessions` x `users` JOIN on every install check, for an answer that
   * cannot depend on the result.
   */
  if (path === '/manifest.webmanifest') {
    await next();
    return;
  }
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
// The print cost/quote engine. Mounted before the '/api' misc catch-all for the
// same reason the farm is, and it carries no requireAuth of its own: a guest
// may upload and be quoted, and each route states its own guard.
app.route('/api/print-quote', printQuoteRoutes);
// «المقارنة» — comparing two machines on the shop's own spec sheet. Mounted
// before the '/api' misc catch-all for the same reason the farm is, and
// deliberately with NO auth of its own: a comparison is a reason to visit the
// shop, and a sign-in wall in front of the page that answers «أي وحدة أشتري؟»
// turns it into a page that asks for an email address instead.
app.route('/api/compare', compareRoutes);
// «لكيتها بمكان أرخص» — the customer's competitor-price report (0093). Its own
// prefix rather than a branch of /api/products, and every route inside is
// behind its own requireAuth: an anonymous form that writes a row the owner
// reads is a spam endpoint.
app.route('/api/price-reports', priceReportRoutes);
app.route('/api', miscRoutes);
app.route('/api/admin', adminRoutes);
// The farm's balancing console. Under /api/admin/* on purpose: the apex-only
// host guard above covers it, and the generic settings PUT refuses its key so
// this normalising, versioned, audited route is the only way to change it.
app.route('/api/admin/farm', farmAdminRoutes);
// The owner's competitor-price queue. Under /api/admin/* so the apex-only host
// guard above covers it, and it carries its own requireAdmin as well — that
// function is where the host rule lives, so neither guard depends on a mount
// somebody remembered to write.
app.route('/api/admin/price-reports', adminPriceReportRoutes);
app.route('/api/admin/products-v2', adminProductsRoutes);
app.route('/api/admin/template', templateRoutes);
app.route('/api/admin/media', mediaRoutes);
app.route('/api/admin/taxonomy', adminTaxonomyRoutes);
// Every commercial value PRO and PREMIUM shopping benefits are made of (§6).
app.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
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
// «خبرني لما يرجع» — the customer's standing restock requests (0092). Its own
// prefix rather than a branch of /api/products, and mounted on every host: the
// shopper arms the alert from the product page wherever that page is served,
// and the shared parent-domain cookie carries their session there. Every route
// inside is behind its own requireAuth — a standing request belongs to an
// account, never to a browser.
app.route('/api/stock-alerts', stockAlertRoutes);
// Checkout for merchant store products — the other merchant commerce path.
app.route('/api/store-orders', storeOrderRoutes);
// Customer-side reviews and store follows.
app.route('/api/community-reviews', communityReviewRoutes);
app.route('/api/community-favorites', communityFavoriteRoutes);
app.route('/files', fileRoutes);

// THE INSTALLED APP'S IDENTITY — the one SPA path the asset layer may not answer.
//
// GET /manifest.webmanifest is what a browser reads when a visitor asks to
// install this site, and it is a Worker route whose path is named in the
// run_worker_first list in wrangler.jsonc. Both halves of that sentence are
// load-bearing.
//
// WITHOUT THE wrangler.jsonc ENTRY THIS LINE IS DEAD CODE. Anything not named
// in run_worker_first is answered by the asset layer before the Worker exists
// for that request, and not_found_handling is "single-page-application" — so a
// path with no file behind it is answered with index.html, at HTTP 200, with
// Content-Type: text/html. It is not a 404. Every browser would then report
// "Manifest: Line: 1, column: 1, Syntax error" to a console nobody is
// watching, the install prompt would never appear on any device, and nothing
// in any log would say why.
//
// AND A FILE IN public/ COULD NOT DO THIS JOB. Merchant subdomains serve the
// same built bundle, so a single static manifest would install every
// merchant's shop as "LEVONIS", carrying the platform's mark, on the phone of
// a customer who believes they are installing that shop. The Host header is
// the only thing that tells the two apart, and it reaches nothing but the
// Worker.
//
// Top-level and on every host, deliberately: this is not admin surface, and a
// storefront that cannot be installed is the defect, not the risk.
app.get('/manifest.webmanifest', webManifestRoute);

// The previous architecture exposed raw SQL and schema management over HTTP.
// Those endpoints are gone; explicit 410s make the removal visible to any
// stale client instead of a confusing 404/SPA response.
app.all('/api/d1/query', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/d1/init', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/make-all-investors', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/upload', (c) => c.json({ success: false, error: 'Use POST /api/uploads.' }, 410));

// THE SPA FALLBACK, AND THE ONE THING IT REWRITES ON THE WAY OUT.
//
// Every non-API path is served the same built `index.html`; React reads the
// URL and renders the right screen. That is invisible to a human and fatal to
// a crawler, which reads the bytes it is handed and leaves. Before this, every
// product link pasted into Instagram, Telegram, WhatsApp or Messenger unfurled
// with the SHOP's card, because the shop's card is what the shell ships.
//
// So for the handful of paths that name a product — and ONLY those, see
// `productSlugFromPath` — the shell's four identifying tags are replaced with
// the product's own before the response leaves. Every other route pays nothing:
// no extra read, no buffering, the same `ASSETS.fetch` as before.
//
// NOTHING HERE MAY BREAK A PAGE LOAD. A slug that resolves to no published
// product, a database that is slow or unavailable, an asset response that is
// not HTML — each one falls through to the untouched response. A share card is
// worth a rewrite; it is not worth a white screen, so the whole rewrite sits
// inside a catch and the customer gets the app either way.
//
// LINE COMMENTS, NOT A BLOCK — the same reason as the note at the bottom of
// this file. The comment stripper in tests/storefrontIsolation.test.ts reads
// the slash-star inside the '/api/admin/*' mount string above as a comment
// opener, so the first block terminator below it deletes every route mount in
// between, and the admin host guard that test asserts on vanishes with them.
async function assetWithPreview(c: Context<AppContext>): Promise<Response> {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  const slug = productSlugFromPath(c.req.path);
  if (!slug || !asset.ok) return asset;
  if (!/^text\/html\b/i.test(asset.headers.get('Content-Type') || '')) return asset;

  try {
    const origin = trustedOrigin(c);
    const product = await resolveProductPreview(c.env.DB, slug, origin);
    if (!product) return asset;

    const url = new URL(c.req.url);
    const html = injectSocialPreview(await asset.text(), {
      ...product,
      // The URL the crawler was given, not the canonical one — query string
      // included. A shared link carries the supporter's handle as `?ref=`
      // (`productSupportPath`), and a crawler that is told the canonical
      // address will show and follow THAT, dropping the referral the sharer is
      // owed. Rebuilt from the trusted origin rather than echoed, so a spoofed
      // Host header cannot write its own domain into the card.
      url: `${origin}${url.pathname}${url.search}`,
    });

    const headers = new Headers(asset.headers);
    // The body is no longer the asset that was hashed. A stale validator would
    // let a browser or an intermediary answer a later request with the cached
    // ORIGINAL — the shop's card again, on a product page.
    headers.delete('ETag');
    headers.delete('Content-Length');
    return new Response(html, { status: asset.status, headers });
  } catch {
    // A card is an enhancement. The app is not.
    return asset;
  }
}

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // Anything else falls through to the static assets (SPA).
  return assetWithPreview(c);
});

// THE ONE THING A 500 MAY TELL THE CUSTOMER.
//
// «حدث خطأ من جهتنا» is true and useless: it cannot tell a customer whether to
// retry in ten seconds, come back later, or call the shop. `safeErrorCode`
// (worker/lib/membershipBenefits.ts, beside the `no such table` predicate the
// cart's own degrade is built on, so there is ONE definition of what that
// error means rather than two that can drift) recognises exactly two causes
// and names them:
//
//   SERVICE_SETUP  the deployment is ahead of its database — a table or column
//                  the code reads has not been created yet. Retrying now will
//                  fail identically; the owner has to run the migration.
//   SERVICE_BUSY   the database was locked or busy for this request. Retrying
//                  in a moment genuinely does work.
//
// WHAT DOES NOT CROSS THIS LINE. No stack, no table name, no column name, no
// SQL and no driver text ever reaches a customer — only which of the two
// shapes it was, as a code the storefront turns into its own sentence in the
// customer's own language (`src/components/ui/AsyncStates.tsx`). The full
// error keeps going to the server log, where it already went.
//
// LINE COMMENTS, NOT A BLOCK, and that is not a style choice: the naive
// comment stripper in tests/storefrontIsolation.test.ts treats the slash-star
// inside the '/api/admin/*' mount string far above as a comment opener, so the
// first block terminator below it swallows the admin host guard that test
// asserts on. Same reason as the note at the bottom of this file.
const SAFE_ERROR_TEXT: Record<'SERVICE_SETUP' | 'SERVICE_BUSY', string> = {
  SERVICE_SETUP: 'Part of the store has not finished being set up. Please try again shortly.',
  SERVICE_BUSY: 'The store is busy right now. Please try again in a moment.',
};

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      err.status as 400
    );
  }
  // Detailed diagnostics stay server-side; clients get a safe generic error.
  console.error('Unhandled error', c.req.method, c.req.path, err);
  const code = safeErrorCode(err);
  return c.json(
    code
      ? { success: false, error: SAFE_ERROR_TEXT[code], code }
      : { success: false, error: 'Something went wrong. Please try again.' },
    500
  );
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
