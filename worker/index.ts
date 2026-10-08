import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env } from './lib/types';
import { noStoreUnlessSet } from './lib/edgePolicy';
import { HttpError, originCheck, requireMainHost, securityHeaders } from './lib/http';
import { loadSessionUser, sessionFreePublicGet } from './lib/session';
import { isAnonymousPublicMediaKey } from './lib/mediaStorage';
import {
  chunkPreloads,
  documentCacheControl,
  earlyHintsLink,
  entryStylesheets,
  framedByStore,
  heroCoverFrom,
  injectDocumentPreloads,
  productImagePreload,
  injectSocialPreview,
  MANIFEST_PATH,
  preloadImagePath,
  previewStoreRef,
  productSlugFromPath,
  resolveProductPreview,
  resolveStorePreview,
  routeModuleFor,
  storeHomeRef,
  type ViteManifest,
} from './lib/socialPreview';
import { conditional, weakEtag } from './lib/publicApi/cache';
import { trustedOrigin } from './lib/appOrigin';
import { runDurableJobs } from './lib/jobs';
import { drainStaffReconciliations } from './lib/financeStaffAccrual';
import { drainOrderFinanceRecovery } from './lib/financeOrderRecovery';
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
import { communityPostRoutes } from './routes/communityPosts';
import { communitySocialRoutes } from './routes/communitySocial';
import { communitySearchRoutes } from './routes/communitySearch';
import { chatRoutes } from './routes/chats';
import { chatCommerceRoutes } from './routes/chatCommerce';
import { linkCardRoutes } from './routes/linkCards';
import { profileRoutes } from './routes/profile';
import { uploadRoutes, fileRoutes } from './routes/uploads';
import { uploadSessionRoutes, sweepExpiredUploadSessions } from './routes/uploadSessions';
import { storeIconRoute, webManifestRoute } from './routes/manifest';
import { robotsRoute, sitemapRoute } from './routes/seo';
import { miscRoutes } from './routes/misc';
import { adminRoutes } from './routes/admin';
import { adminOrderPriceRoutes, orderPriceRoutes } from './routes/orderPriceAdjust';
import { adminTradeInRoutes, tradeInRoutes } from './routes/tradeIn';
import { adminProductsRoutes } from './routes/adminProducts';
import { templateRoutes } from './routes/template';
import { mediaRoutes } from './routes/media';
import { adminTaxonomyRoutes } from './routes/adminTaxonomy';
import { adminMembershipBenefitRoutes } from './routes/adminMembershipBenefits';
import { warrantyAdminRoutes, warrantyPublicRoutes } from './routes/warranty';
import { adminImportRoutes } from './routes/adminImport';
import { adminProductRelationsRoutes } from './routes/adminProductRelations';
import { adminPriceGridRoutes } from './routes/adminPriceGrid';
import { adminFinanceRoutes } from './routes/adminFinance';
import { adminFinanceReportRoutes } from './routes/adminFinanceReport';
import { adminInventoryRoutes } from './routes/adminInventory';
import { adminProcurementRoutes } from './routes/adminProcurement';
import { adminStockOperationsRoutes } from './routes/adminStockOperations';
import { adminFinanceOperationsRoutes } from './routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from './routes/adminFinanceWorkspace';
import { adminFinancePeopleRoutes } from './routes/adminFinancePeople';
import { adminInvestmentFinanceRoutes } from './routes/adminInvestmentFinance';
import { financeEarningsRoutes } from './routes/financeEarnings';
import { printRequestRoutes } from './routes/printRequests';
import { notificationRoutes } from './routes/notifications';
import { stockAlertRoutes } from './routes/stockAlerts';
import { compareRoutes } from './routes/compare';
import { catalogRoutes } from './routes/catalog';
import { printerFinderRoutes } from './routes/printerFinder';
import { priceReportRoutes, adminPriceReportRoutes } from './routes/priceReports';
import { merchantPrinterRoutes } from './routes/merchantPrinters';
import { merchantWorkshopRoutes } from './routes/merchantWorkshop';
import { merchantCatalogRoutes } from './routes/merchantCatalog';
// Files on products (§9.4): the merchant's editor and the shopfront's list/viewer/download.
import { merchantProductFileRoutes, publicProductFileRoutes } from './routes/productFiles';
import { adminPrintQuoteRoutes, printQuoteRoutes } from './routes/printQuote';
import { membershipsRoutes } from './routes/memberships';
import { telegramRoutes } from './routes/telegram';
import { invoiceRoutes } from './routes/invoices';
import { deviceRoutes } from './routes/devices';
import { reviewRoutes } from './routes/reviews';
import { giftRoutes, legacyGiftRoutes } from './routes/gifts';
import { returnRoutes, priceProtectionRoutes } from './routes/returns';
import { policiesRoutes } from './routes/policies';
import { kycRoutes } from './routes/kyc';
import { supportRoutes } from './routes/support';
import { referralRoutes } from './routes/referrals';
import { studioRoutes } from './routes/studio';
import { apexRedirectFor, classifyHost, rootDomainFrom } from './lib/hosts';
import { merchantRoutes } from './routes/merchant';
import { storeLayoutRoutes } from './routes/storeLayout';
import { merchantFinanceRoutes, merchantPayoutRoutes } from './routes/merchantFinance';
import { merchantAttentionRoutes, merchantSearchRoutes } from './routes/merchantWorkspace';
import { storefrontRoutes } from './routes/storefront';
// Merchant platform W2-E: the store's notification centre, inbox and
// analytics, and the storefront's first-party analytics beacon.
import { merchantNotificationRoutes } from './routes/merchantNotifications';
import { merchantInboxRoutes } from './routes/merchantInbox';
import { merchantAnalyticsRoutes } from './routes/merchantAnalytics';
import { merchantOrderRoutes } from './routes/merchantOrders';
import { merchantCustomerRoutes } from './routes/merchantCustomers';
import { storefrontEventRoutes } from './routes/storefrontEvents';
import { marketplaceRoutes } from './routes/marketplace';
import { requestDiscussionRoutes } from './routes/requestDiscussion';
import { communityOrderTimelineRoutes } from './routes/communityOrderTimeline';
import { storeOrderRoutes } from './routes/storeOrders';
import { communityReviewRoutes } from './routes/merchantReviews';
import { communityFavoriteRoutes } from './routes/communityFavorites';
import { adminCommunityRoutes } from './routes/adminCommunity';
import { adminChatRoutes } from './routes/adminChats';
import { adminWalletAdjustRoutes } from './routes/adminWalletAdjust';
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
// «الشراء السريع» (0176): the customer surface only — the system runs every
// session to its order without an administrator (DECISIONS row 188).
import { quickBuyRoutes } from './routes/quickBuy';
import { finalizeDueQuickBuySessions } from './lib/quickBuy/finalize';
import { publicApiRoutes } from './routes/publicApi';
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

/**
 * `www.` IS NOT A SECOND HOME: a document asked for on `www` moves to the apex
 * (301), so a Google sign-in can never begin on an origin the client id does
 * not allow (worker/lib/hosts.ts `apexRedirectFor`; the SPA covers the pages
 * the asset layer answers alone).
 */
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const to = apexRedirectFor(c.req.header('Host'), rootDomainFrom(c.env), c.req.method, url.pathname, url.search);
  if (to) return c.redirect(to, 301);
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
  /**
   * NOR DO THE TWO FILES CRAWLERS ASK FOR, and for the same reason twice over.
   *
   * `/robots.txt` and `/sitemap.xml` are answered from the Host header and, for
   * the sitemap, one products read. Neither can depend on who is signed in — a
   * crawler arrives with no cookie at all — so loading a session here would buy
   * a `sessions` x `users` JOIN for an answer that cannot use it, on requests
   * that arrive in bursts from every bot on the internet.
   */
  if (path === '/robots.txt' || path === '/sitemap.xml') {
    await next();
    return;
  }
  /**
   * NOR DO A STORE'S HOME DOCUMENT AND ITS ICONS (merchant platform W2-D).
   *
   * `/` joins `run_worker_first` so a shared store link carries the STORE's
   * card, and `/store-icon/*` so every host gets its own home-screen and tab
   * icon. Neither reads `user`: `/` matches no route (the SPA fallback below
   * answers it, with a card that is the same for every visitor), and an icon
   * cannot depend on who asks. `/community/store/<ref>` is the store's page
   * on the main site, rewritten the same way.
   */
  if (path === '/' || path === '/products' || path.startsWith('/store-icon/') || storeHomeRef(path) !== null) {
    await next();
    return;
  }
  /**
   * NOR DOES THE PUBLIC API — and here that is the guarantee, not an
   * optimisation. `/api/public/v1` answers exactly what a signed-out visitor
   * sees (worker/routes/publicApi.ts); with no session loaded, `user` is never
   * set on this prefix, so no handler under it can personalise a price or leak
   * an account even by mistake, whatever cookie arrives with the request.
   */
  if (path === '/api/public/v1' || path.startsWith('/api/public/v1/')) {
    await next();
    return;
  }
  /**
   * NOR DO THE PUBLIC READS WHOSE ANSWER IS THE SAME FOR EVERYONE (P2a, plan
   * §B.1 #4): the public settings, the whole storefront router but
   * `/:slug/delivery`, the print catalogue. Their anonymous variant is what
   * the colo caches (worker/lib/edgePolicy.ts), and their handlers never read
   * `user` — pinned by tests/edgeCachePolicy.test.ts, and the reason the list
   * is a named predicate in worker/lib/session.ts rather than a pattern here.
   * A signed-in shopper opening a store no longer pays the `sessions` x
   * `users` JOIN for the store, its products, its reviews or its shelves.
   */
  if (sessionFreePublicGet(c.req.method, path)) {
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

// No shared or stored copy of an admin or cart answer — see edgePolicy.ts.
app.use('/api/admin/*', noStoreUnlessSet);
app.use('/api/cart', noStoreUnlessSet);
app.use('/api/cart/*', noStoreUnlessSet);

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
app.route('/api/quick-buy', quickBuyRoutes);
// «تعديل السعر النهائي» (0140): the customer's decision and the admin's
// proposal on one order's price. Their own routers, beside their siblings.
app.route('/api/orders', orderPriceRoutes);
app.route('/api/admin/orders', adminOrderPriceRoutes);
// «الاستبدال» (0143): a delivered LEVONIS device traded against a new one —
// the customer's wizard and requests, and the admin's review and rules.
app.route('/api/trade-in', tradeInRoutes);
app.route('/api/admin/trade-in', adminTradeInRoutes);
app.route('/api/addresses', addressRoutes);
app.route('/api/wallet', walletRoutes);
app.route('/api/rewards', rewardRoutes);
app.route('/api/subscription', subscriptionRoutes);
app.route('/api/invest', investRoutes);
app.route('/api/community', communityRoutes);
// Projects, posts and creator pages — what the community makes (0153,
// docs/COMMUNITY_ECOSYSTEM.md Phase 1); inside the same maintenance wall.
app.route('/api/community', communityPostRoutes);
// The social graph — likes, saves, comments, follows, blocks, reports, the
// feed and the creators list (0154, Phase 2); same wall.
app.route('/api/community', communitySocialRoutes);
// Unified search, suggestions, trending and «قد يعجبك» over the lists above
// (Phase 3, docs/COMMUNITY_ECOSYSTEM.md §9.3); same wall, guests welcome.
app.route('/api/community', communitySearchRoutes);
app.route('/api/chats', chatRoutes);
// Custom work inside the store's conversation — print requests, quotes, the orders panel
// (docs/COMMUNITY_COMMERCE_CHAT.md); acceptance stays /api/marketplace/offers/:id/accept.
app.route('/api/chats', chatCommerceRoutes);
// Link cards (docs/COMMUNITY_ECOSYSTEM.md §9.4): the author's resolve (signed
// in, rate limited, the only door that fetches) and the reader's cached row
// (a guest may ask; never a fetch). Its own requireAuth on the resolve.
app.route('/api/link-cards', linkCardRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/uploads', uploadRoutes);
// Resumable multipart uploads (docs/COMMUNITY_ECOSYSTEM.md §9.4): a session per
// large file, parts, a resume point, a verified complete. Its own requireAuth.
app.route('/api/uploads/sessions', uploadSessionRoutes);
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
// Catalog discovery (docs/ux/CATALOG_DISCOVERY.md §11): the category map and the printer finder.
app.route('/api/catalog', catalogRoutes);
app.route('/api/printer-finder', printerFinderRoutes);
// The public read-only API: anonymous (no session is loaded for this prefix),
// GET/HEAD only, main host only — see worker/routes/publicApi.ts.
app.route('/api/public/v1', publicApiRoutes);
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
// «إدارة المخزون». Mounted under /api/admin/* so the apex-only host guard far
// above covers it, and declared `admin` rather than `admin:full` on purpose:
// §52 puts the assistant admin IN the warehouse — they count units, receive
// shipments and correct a miscount — and OUTSIDE every cost attached to them.
// The split is per FIELD, not per route, so the door stays open and every
// payload leaves through `projectForAdmin`, which keeps the cost for the owner
// alone (owner decision 2 — full-scope admins included).
app.route('/api/admin/inventory', adminInventoryRoutes);
app.route('/api/admin/procurement', adminProcurementRoutes);
app.route('/api/admin/stock-operations', adminStockOperationsRoutes);
app.route('/api/admin/finance-operations', adminFinanceOperationsRoutes);
app.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes);
app.route('/api/admin/finance-people', adminFinancePeopleRoutes);
app.route('/api/admin/investment-finance', adminInvestmentFinanceRoutes);
app.route('/api/finance-earnings', financeEarningsRoutes);
// Every commercial value PRO and PREMIUM shopping benefits are made of (§6).
app.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
// The issued warranty document: public verification by receipt number or by
// the serial on the device, and the admin side that issues and prints it.
app.route('/api/warranty', warrantyPublicRoutes);
app.route('/api/admin/warranties', warrantyAdminRoutes);
app.route('/api/admin/community', adminCommunityRoutes);
// The printer-model economics editor (Admin → مجتمع ليفو → تسعير الطباعة).
app.route('/api/admin/print-quote', adminPrintQuoteRoutes);
// «الرسائل» in the support console: the shop's order threads and the three
// waiting counts. Under /api/admin/* so the apex-only guard covers it, with its
// own requireAdmin inside.
app.route('/api/admin/chats', adminChatRoutes);
// «تعديل الرصيد والنقاط» and «فحص فروقات التقريب»: a member's wallet by hand.
// Financial scope, rate limit, idempotency and audit inside the router.
app.route('/api/admin/wallet-adjust', adminWalletAdjustRoutes);
app.route('/api/admin/import', adminImportRoutes);
// Mounted on the same prefix as adminProductsRoutes; the paths are distinct
// (/:id/relations, /:id/stock) so neither router shadows the other.
app.route('/api/admin/products', adminProductRelationsRoutes);
// Quick Edit pricing shares that prefix too; its paths (/:id/price-grid,
// /:id/price-history) are distinct from both routers above, so none shadows
// another.
app.route('/api/admin/products', adminPriceGridRoutes);
// The operating-expense ledger — «تكاليف اخرى ... خاصه في لوحه الادمن». Its own
// prefix, because an expense belongs to no product and must never be reachable
// through a product route. Every path under it carries the FINANCIAL scope on
// top of requireAdmin, inside the router itself, so the gate does not depend on
// this mount being remembered.
app.route('/api/admin/finance', adminFinanceRoutes);
// The PROFIT REPORTING that reads that ledger, mounted on the LONGER prefix
// and therefore AFTER it: Hono matches in registration order, and a router
// registered at '/api/admin/finance' first keeps its own paths while letting
// '/report/*' fall through to this one. Reversing these two lines would put
// the whole dashboard behind a 404 with nothing failing loudly — which is
// exactly what happened while this feature was being built, and why
// tests/financeReport.test.ts now reads THIS FILE and asserts both lines and
// their order rather than assembling its own app.
app.route('/api/admin/finance/report', adminFinanceReportRoutes);
app.route('/api/memberships', membershipsRoutes);
app.route('/api/telegram', telegramRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/devices', deviceRoutes);
app.route('/api/reviews', reviewRoutes);
// The gifts (owner brief 2026-10-06 §1, docs/GIFTS_QUICK_BUY.md): the customer's
// gifts and the admin's levels and grants. Their old `/api/reviews/gifts*` URLs
// keep answering for clients cached before the move; no path overlaps a review route.
app.route('/api/reviews', legacyGiftRoutes);
app.route('/api/gifts', giftRoutes);
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
// The store's customers (W3-B): the paged, searchable list at
// GET /api/merchant/customers (the older unpaged handler in merchant.ts was
// removed, review W2-5 #8).
app.route('/api/merchant/customers', merchantCustomerRoutes);
// The workshop's board «مناسب لي», live verdicts and private request costing (W5-B).
app.route('/api/merchant/workshop', merchantWorkshopRoutes);
app.route('/api/merchant', merchantRoutes);
// Printers and request-notification preferences: what a shop can make, and
// which of those jobs it wants to hear about.
app.route('/api/merchant', merchantPrinterRoutes);
// The catalogue — products, variants, media, bulk, import/export, insights —
// and the store's collections (merchant platform W2-F).
app.route('/api/merchant', merchantCatalogRoutes);
// The files of a catalogue product — /api/merchant/products/:id/files (§9.4).
// Its own router: the catalogue's `/products/:id` never matches the extra segment.
app.route('/api/merchant', merchantProductFileRoutes);
// The store page as data — its draft, publish, history and restore
// (merchant platform W2-C). Its own mount so the routing design can name it;
// the same session-scoped rules as the rest of /api/merchant.
app.route('/api/merchant/store/layout', storeLayoutRoutes);
// The store's notification centre (feed, badge, mark read), its inbox of
// store-owned conversations, and its analytics over a range (W2-E). Sub-paths
// only: GET/PATCH /api/merchant/notifications (the switches) and GET
// /api/merchant/analytics (lifetime totals) stay with merchantRoutes above.
app.route('/api/merchant/notifications', merchantNotificationRoutes);
app.route('/api/merchant/inbox', merchantInboxRoutes);
app.route('/api/merchant/analytics', merchantAnalyticsRoutes);
// One store order as a story — its timeline, ledger lines and delivery snapshot (W3-B).
app.route('/api/merchant/orders', merchantOrderRoutes);
// The merchant's money (W2-B): the finance summary and ledger, and payout
// requests — beside the append-only ledger they read (worker/lib/merchantLedger.ts).
app.route('/api/merchant/finance', merchantFinanceRoutes);
app.route('/api/merchant/payouts', merchantPayoutRoutes);
// The workspace's «what needs me now» and its command-palette search (W3-A):
// owner-scoped reads over the sources above, each its own mount so the
// routing design names it (worker/routes/merchantWorkspace.ts).
app.route('/api/merchant/attention', merchantAttentionRoutes);
app.route('/api/merchant/search', merchantSearchRoutes);
// The storefront's analytics beacon — POST only, before the public reads so
// `events` can never be taken for a store slug.
app.route('/api/storefront/events', storefrontEventRoutes);
// The public shopfront: readable by anyone, on any host.
app.route('/api/storefront', storefrontRoutes);
// A product's files as a shopper sees them, the viewer link and the download
// door (§9.4). NOT under /api/storefront: that router is served session-free
// for the guest cache, and these doors need to know who is asking.
app.route('/api/product-files', publicProductFileRoutes);
// The print journey EXTENDS the marketplace rather than starting a second one:
// it adds measuring, estimating, publishing and matching to the same requests.
// Mounted BEFORE the marketplace for the same reason the product routes put
// /brands before /:id — the more specific prefix is registered first so it can
// never be shadowed by a parameterised route above it.
app.route('/api/marketplace/print', printRequestRoutes);
// The customer-request marketplace: requests, offers, escrowed community orders.
app.route('/api/marketplace', marketplaceRoutes);
// The request's discussion and the order's timeline (Phase 5b, docs/COMMUNITY_ECOSYSTEM.md
// §9.5): the same prefix, their own routers — /requests/:id/comments,
// /orders/:id/updates, /orders/:id/timeline. After the marketplace, which
// registers no path of theirs, so nothing is shadowed either way.
app.route('/api/marketplace', requestDiscussionRoutes);
app.route('/api/marketplace', communityOrderTimelineRoutes);
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

// GET /store-icon/<name> — THE HOST'S OWN HOME-SCREEN AND TAB ICON (W2-D).
//
// index.html is one document on every host, so it links these stable paths
// and the Worker answers each with THIS host's rendition of its store's logo
// (or the platform icon on the apex and wherever a store has none) — see
// storeIconRoute in worker/routes/manifest.ts. Like the manifest, the path is
// named in run_worker_first in all three environments, or the asset layer
// answers it with the SPA shell at 200 and iOS draws a page screenshot.
// Line comments only, for the reason given at robots.txt below.
app.get('/store-icon/:name', storeIconRoute);

// GET /robots.txt and GET /sitemap.xml — see worker/routes/seo.ts for why
// these are routes rather than files in `public/`: one bundle serves the apex
// and every merchant subdomain, and a static copy of either would name the
// platform's URLs on a merchant's host.
//
// LINE COMMENTS, NOT A BLOCK, and the note beside `assetWithPreview` below
// explains why at length: the comment stripper in
// tests/storefrontIsolation.test.ts reads the slash-star inside the
// '/api/admin/*' mount string far above as a comment opener, so the FIRST
// star-slash under it deletes every route mount in between — including the
// apex-only admin host guard that test exists to assert on.
//
// AND NOT THE CHARACTERS EITHER, EVEN INSIDE A LINE COMMENT. The stripper
// runs on the raw text and does not know what a line comment is, so writing
// the terminator here — to explain the rule — closed the fake comment and
// took the same five tests down a second time. It is spelled out in words
// above for that reason. Do not put the two characters anywhere below the
// admin mount.
app.get('/robots.txt', robotsRoute);
app.get('/sitemap.xml', sitemapRoute);

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
// P2b — THE HEAD START (docs/MERCHANT_PLATFORM_V2.md §B.1 #3; worker/lib/
// socialPreview.ts explains each piece). On the same documents, and only
// those, the rewrite now also writes: a modulepreload for the route's chunk
// (from Vite's manifest, read once per isolate below), a high-priority preload
// for the picture the page paints largest, and the ANONYMOUS resolve answer
// as a JSON data block, so the app renders on its first frame instead of after
// a round trip. The response keeps a weak ETag computed from the REWRITTEN
// body (a 304 is honest again), carries the Early Hints `Link` for the entry
// stylesheet and the Arabic font, and — when nothing about it depended on a
// session — a shareable Cache-Control; a rewrite that saw a session keeps
// `no-cache`. tests/documentPreloads.test.ts holds every one of these.
//
// THE MANIFEST, ONCE PER ISOLATE. `dist/.vite/manifest.json` ships with the
// assets (vite.config.ts `build.manifest`). Memoised per ASSETS binding (one
// object for the life of an isolate; a fresh one per fake in the tests). A
// miss is remembered for a minute so a deploy without it costs one asset read
// per minute, not per document; a document served without it simply carries
// no modulepreload.
const manifestMemo = new WeakMap<object, { at: number; value: ViteManifest | null }>();
async function viteManifest(c: Context<AppContext>): Promise<ViteManifest | null> {
  const now = Date.now();
  const memo = manifestMemo.get(c.env.ASSETS);
  if (memo && (memo.value || now - memo.at < 60_000)) return memo.value;
  let value: ViteManifest | null = null;
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL(MANIFEST_PATH, c.req.url).toString()));
    // `not_found_handling: single-page-application` answers a missing file
    // with index.html at 200, so the type is the test, not the status.
    if (res.ok && /json/i.test(res.headers.get('Content-Type') || '')) {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') value = parsed as ViteManifest;
    }
  } catch {
    value = null;
  }
  manifestMemo.set(c.env.ASSETS, { at: now, value });
  return value;
}

// THE ANONYMOUS RESOLVE ANSWER, FROM THE ROUTE ITSELF. The same handler the
// browser would call, dispatched inside this Worker with the request's Host
// and language but NO cookie — so it is exactly the answer a visitor with no
// session gets, and whatever edge cache that route gains later serves this
// too. Accepted only when it names the host this document is for: a lost Host
// header would otherwise inline the platform's answer on a store's page.
async function anonymousResolve(c: Context<AppContext>): Promise<Record<string, unknown> | null> {
  try {
    const host = c.get('host');
    const headers = new Headers();
    for (const name of ['Host', 'Accept-Language', 'CF-Connecting-IP', 'X-Forwarded-Proto']) {
      const v = c.req.header(name);
      if (v) headers.set(name, v);
    }
    const url = new URL(c.req.url);
    url.pathname = '/api/storefront/resolve';
    url.search = '';
    let executionCtx: unknown;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const res = await app.fetch(new Request(url.toString(), { headers }), c.env, executionCtx as never);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    if (!data || data.success === false || data.kind !== host.kind) return null;
    if (host.kind === 'merchant') {
      const store = data.store as { slug?: unknown } | null;
      if (!store || store.slug !== host.slug) return null;
    }
    return data;
  } catch {
    return null;
  }
}

// WHERE THIS DOCUMENT WAS SERVED FROM, sampled (about one document in fifty),
// after the response has left (`waitUntil`): the colo the Worker ran in, the
// `cf-placement` header when the platform adds one to the request, and the
// region D1 answered from (`meta.served_by_region` of one trivial statement),
// with its round trip. This is the evidence the Smart Placement and D1
// location decisions wait on (wrangler.jsonc «SMART PLACEMENT», DECISIONS row
// 171). Never on the request's own path, never a failure the visitor sees.
function logDocumentRegion(c: Context<AppContext>, path: string, docMs: number): void {
  if (Math.random() >= 0.02) return;
  try {
    const cf = (c.req.raw as Request & { cf?: { colo?: string; country?: string } }).cf;
    const t0 = Date.now();
    const probe = c.env.DB.prepare('SELECT 1')
      .all()
      .then((r) => {
        console.log(
          JSON.stringify({
            evt: 'document_region',
            path,
            colo: cf?.colo ?? null,
            country: cf?.country ?? null,
            cf_placement: c.req.header('cf-placement') ?? null,
            d1_region: (r.meta as { served_by_region?: string } | undefined)?.served_by_region ?? null,
            d1_ms: Date.now() - t0,
            doc_ms: docMs,
          })
        );
      })
      .catch(() => undefined);
    c.executionCtx.waitUntil(probe);
  } catch {
    // No execution context (a test), or no DB: nothing to log.
  }
}

async function assetWithPreview(c: Context<AppContext>): Promise<Response> {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  const slug = productSlugFromPath(c.req.path);
  // THE STORE'S OWN CARD (W2-D): a store's home on its own host (`/`, which
  // is in run_worker_first for exactly this), and its page on the main site
  // (`/community/store/<ref>`). Anywhere else a path that names no product
  // pays nothing: no read, no buffering, the asset as it came.
  const host = c.get('host');
  const onStore = host.kind === 'merchant' && !!host.slug;
  const homeRef = storeHomeRef(c.req.path);
  const storeHome = onStore ? c.req.path === '/' : homeRef !== null;
  const mainOpening = host.kind === 'main' && (c.req.path === '/' || c.req.path === '/products');
  if (mainOpening && asset.ok && /^text\/html\b/i.test(asset.headers.get('Content-Type') || '')) {
    try {
      const url = new URL(c.req.url);
      const params = new URLSearchParams();
      for (const key of ['search', 'category']) {
        const value = url.searchParams.get(key);
        if (value) params.set(key, value);
      }
      params.set('limit', '50');
      const openingPath = url.pathname === '/' ? '/api/home' : `/api/products?${params}`;
      // The main-host resolve answer is public configuration, with no DB read.
      // Start the actual viewer-priced API request in the HTML preload scanner
      // rather than after the entry bundle has downloaded and React mounted.
      const resolve = { success: true, kind: host.kind, store: null, root_domain: rootDomainFrom(c.env) };
      const manifest = url.pathname === '/products' ? await viteManifest(c) : null;
      const chunks = manifest ? chunkPreloads(manifest, 'src/pages/Products.tsx') : { scripts: [], styles: [] };
      const html = injectDocumentPreloads(await asset.clone().text(), { ...chunks, image: null, resolve, fetches: [openingPath] });
      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('ETag', await weakEtag(html));
      // There are no catalogue prices or session data in this document.
      return conditional(new Response(html, { status: asset.status, headers }), c.req.header('If-None-Match'), documentCacheControl(!!c.get('user') || headers.has('Set-Cookie')));
    } catch {
      return asset;
    }
  }
  if ((!slug && !storeHome) || !asset.ok) return asset;
  if (!/^text\/html\b/i.test(asset.headers.get('Content-Type') || '')) return asset;

  const startedAt = Date.now();
  try {
    // On a merchant host the card names THAT host and only that store's
    // products (audit 01 B15): the apex origin produced `https://<apex>/p/…`,
    // which is not an apex route, and any product slug unfurled on any shop.
    // `host.host` is the classified, normalised Host — a merchant kind is a
    // valid slug under the configured root, never a spoofed domain.
    const origin = onStore ? `https://${host.host}` : trustedOrigin(c);
    const scope = {
      storeSlug: onStore ? host.slug : null,
      storeRef: previewStoreRef(c.req.path) ?? homeRef,
    };
    // The reads that do not depend on each other leave together: the product
    // card, the store card a store host always needs, the manifest (memoised),
    // and the anonymous resolve answer. One wave, not four.
    const [product, storeOnHost, manifest, resolve] = await Promise.all([
      slug ? resolveProductPreview(c.env.DB, slug, origin, scope) : null,
      onStore ? resolveStorePreview(c.env.DB, origin, scope) : null,
      viteManifest(c),
      anonymousResolve(c),
    ]);
    // On a store's own host the store IS the site: its name heads every card,
    // its line and logo stand in for what a product lacks, and a link there
    // that names no product of it — the home, a product since removed — is
    // the store's card rather than the platform's. On the main site the store
    // card is only for the store's own page (or a product of it now gone).
    const store =
      storeOnHost ?? (!onStore && !product && scope.storeRef ? await resolveStorePreview(c.env.DB, origin, scope) : null);
    const card = product ? framedByStore(product, onStore ? store : null) : store;
    if (!card) return asset;

    const url = new URL(c.req.url);
    let html = injectSocialPreview(await asset.text(), {
      ...card,
      // The URL the crawler was given, not the canonical one — query string
      // included. A shared link carries the supporter's handle as `?ref=`
      // (`productSupportPath`), and a crawler that is told the canonical
      // address will show and follow THAT, dropping the referral the sharer is
      // owed. Rebuilt from the trusted origin rather than echoed, so a spoofed
      // Host header cannot write its own domain into the card.
      url: `${origin}${url.pathname}${url.search}`,
    });

    // Catalogue OG and the opening gallery can differ (saved theme or a
    // server-selected shelf). Only preload a lead whose identity is certain.
    // A store home keeps its cover and merchant/bundle behaviour is unchanged.
    const routeKey = routeModuleFor(url.pathname, onStore);
    const chunks = manifest && routeKey ? chunkPreloads(manifest, routeKey) : { scripts: [], styles: [] };
    const image = product
      ? preloadImagePath(routeKey === 'src/pages/Product.tsx' && product.preloadImage !== undefined ? product.preloadImage : product.image)
      : storeHome ? heroCoverFrom(resolve) : null;
    html = injectDocumentPreloads(html, {
      ...chunks, image, resolve,
      ...(routeKey === 'src/pages/Product.tsx' ? {
        ...productImagePreload(image),
        fetches: [`/api/products/${encodeURIComponent(slug!)}`],
      } : {}),
    });

    const headers = new Headers(asset.headers);
    // The body is no longer the asset that was hashed, so the asset's own
    // validator would let a browser or an intermediary answer a later request
    // with the cached ORIGINAL — the shop's card again, on a product page. A
    // validator of the REWRITTEN body keeps the 304 and loses that hazard.
    headers.delete('Content-Length');
    headers.set('ETag', await weakEtag(html));
    const entryCss = manifest ? entryStylesheets(manifest) : [];
    if (entryCss.length) headers.set('Link', earlyHintsLink(entryCss));
    // Shareable only when nothing here could differ by visitor: no session was
    // loaded for this request (these paths skip the lookup above, and the
    // inline answer is the anonymous one), and no cookie is being set.
    const viewerDependent = !!c.get('user') || headers.has('Set-Cookie');
    const cacheControl = documentCacheControl(viewerDependent);
    logDocumentRegion(c, url.pathname, Date.now() - startedAt);
    return conditional(new Response(html, { status: asset.status, headers }), c.req.header('If-None-Match'), cacheControl);
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
  // stale-challenge expiry, gated BNPL overdue stub, and — last in the run —
  // the R2 media-cleanup drain. Idempotent — safe under overlapping runs.
  //
  // THIS HANDLER IS THE ONLY THING THAT EMPTIES THE MEDIA CLEANUP QUEUE.
  // Removing one picture from a saved product no longer abandons the object in
  // R2: the save writes a `media_cleanup_jobs` row instead. But a row is not a
  // deletion. The only other drain is an admin POSTing the maintenance
  // endpoint by hand, and nothing in the product offers them a button that
  // does it — so with this handler gone the owner would pay for exactly the
  // same bytes as before AND carry a queue table that only grows.
  // `runDurableJobs`'s last step (`media_cleanup`) calls
  // `runGuardedMediaCleanup(env)`; tests/mediaCleanupSchedule.test.ts asserts
  // the whole chain, because "the drain exists" and "the cron runs it" are two
  // different facts and only the second one reclaims disk.
  //
  // HOW OFTEN, AND WHAT THAT COSTS. wrangler.jsonc's `triggers.crons` fires
  // the durable-jobs branch every fifteen minutes, in production and in both of the other
  // environments. So a detached image normally survives in the bucket for up
  // to one tick — under fifteen minutes — and with a backlog of N queued jobs
  // for about ceil(N / 50) ticks, because the drain takes fifty jobs per run.
  // That delay is the deliberate trade the queue was chosen for: an image that
  // is somehow still displayed can never be destroyed, where an inline delete
  // would leave a broken picture on a live page the moment anything errored.
  //
  // FOUR THINGS THAT MUST NOT HAPPEN, AND WHERE EACH IS ACTUALLY PREVENTED.
  // These are stated here because this is the line an operator reads when the
  // cron misbehaves, and three of the four are enforced in files this comment
  // does not own:
  //
  //  1. ONE STEP THROWING MUST NOT STARVE THE OTHERS. It cannot:
  //     `runDurableJobs` runs every step through its own `step(name, fn)`
  //     try/catch, which logs with console.error and pushes the message into
  //     `report.errors` — so the media drain is contained exactly like the
  //     fifteen steps before it, and a throw inside it costs one reported
  //     error, not the run.
  //
  //     BUT DO NOT GO LOOKING FOR AN ERROR ON A MISSING TABLE. A Worker
  //     deployed ahead of migration 0072 does NOT report one: the drain opens
  //     with `tableExists`, which goes through `columnsOf`, which swallows its
  //     own PRAGMA failure and answers "no such table", so the step returns
  //     all-zeros and `report.errors` stays empty. The only visible symptom is
  //     a queue that never shrinks — which is also the symptom of a coverage
  //     refusal. `report.media_cleanup.refusals` is the field that tells the
  //     two apart: non-empty means the guard refused, empty-with-zeros means
  //     the queue was never read at all. The one place the `step` containment
  //     did NOT reach was this call
  //     site: a promise handed to `ctx.waitUntil` that rejects is an unhandled
  //     rejection, and it would fail the whole scheduled invocation with
  //     nothing this codebase logs to say which job did it. `runDurableJobs`
  //     cannot reject today — every await inside it is already inside `step` —
  //     so the `.catch` below is not fixing a live failure; it is making the
  //     entrypoint honour the same rule as the steps, so that the first future
  //     line added outside `step` degrades to a log line instead of silently
  //     taking the outbox, the stage sweep and the restock alerts with it.
  //
  //  2. THE DRAIN MUST BE BOUNDED PER INVOCATION. It is, in
  //     worker/lib/mediaRefs.ts: `MEDIA_CLEANUP_RUN_LIMIT` (50) caps the jobs
  //     one run takes and `MEDIA_CLEANUP_VERIFY_CHUNK` (25) caps how many of
  //     them one reference snapshot may cover. A queue of ten thousand rows is
  //     therefore fifty bucket deletes and two coverage scans per tick, not
  //     ten thousand sub-requests against a CPU limit the tick would never
  //     survive. The rest stay `pending` and are re-read oldest-first next
  //     tick, so a partially drained queue resumes rather than restarting: a
  //     run that is cut off mid-way has still permanently finished the jobs it
  //     closed, because a job leaves `pending` exactly once.
  //
  //  3. IT MUST NEVER DELETE A KEY IT CANNOT PROVE IS UNREFERENCED. That
  //     guard is inside the drain, not here, and it is two guards.
  //     `verifyMediaCoverage` first asks the LIVE schema whether every
  //     key-bearing column is classified in `MEDIA_REFERENCE_SOURCES` or
  //     `NON_MEDIA_COLUMNS`, and whether every source read succeeded; if not,
  //     the run deletes NOTHING, returns the refusal sentences and leaves
  //     every job pending — an incomplete reference set cannot tell a live
  //     image from an orphan, and a delete made on one is a guess. When
  //     coverage does hold, each key is re-checked against that
  //     freshly-rebuilt reference set at the moment of deletion, and a key
  //     that came back — the admin moved the picture to another product or
  //     simply undid the edit — is closed `skipped_shared` and its bytes
  //     survive.
  //
  //  4. TWO OVERLAPPING TICKS MUST NOT BOTH CLAIM THE SAME JOB. SAID
  //     PLAINLY: THE CLAIM IS NOT ATOMIC. `pendingMediaCleanup` is a bare
  //     `SELECT … WHERE state = 'pending' ORDER BY created_at LIMIT ?` with no
  //     claiming UPDATE, unlike `processWalletNotifications`, which claims each
  //     row with a compare-and-swap on `attempts`. Two overlapping runs would
  //     read the same fifty rows. What keeps that survivable rather than
  //     merely unlikely: an R2 delete of a key that is already gone is a
  //     success, not an error, so the second run's delete is a no-op; and
  //     every ledger write behind it (`closeJob`, `bumpAttempt`) carries
  //     `AND state = 'pending'`, so exactly one run moves the job out of the
  //     queue and neither can double-count `attempts`. The cost of an overlap
  //     is therefore wasted sub-requests, not a wrong deletion or a corrupt
  //     queue. Overlap needs a run to exceed the fifteen-minute gap, which a
  //     fifty-job bound makes remote — but it is not impossible, and the right
  //     fix if it ever matters is a claiming UPDATE in
  //     worker/lib/productDeletion.ts, not a lock here.
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    configureEventBus(env);
    // Delivery itself awaits wage posting. This separate bounded recovery
    // repairs historical pending costs and interrupted postings without an
    // admin request, including orders whose old staff job already completed.
    // The minute trigger is only for financial recovery. Keep notification,
    // storage cleanup and other durable jobs on their existing cadence and
    // separate invocation budgets.
    if (_event.cron === '* * * * *') {
      ctx.waitUntil(
        drainOrderFinanceRecovery(env).catch((error) => {
          console.error('scheduled order finance recovery rejected:', error);
        })
      );
      // «الشراء السريع» (§13): a session whose 30 minutes have ended becomes
      // its order on the next tick even if every browser is closed. Time-
      // critical like the recovery above, and bounded (10 sessions a tick).
      // The same tick cancels and refunds a session the order door refused on
      // every attempt — no administrator in the loop (DECISIONS row 188).
      ctx.waitUntil(
        finalizeDueQuickBuySessions(env, ctx).catch((error) => {
          console.error('scheduled quick buy finalisation rejected:', error);
        })
      );
      return;
    }
    // Employment-date recalculation survives a closed admin tab. Each tick
    // processes a bounded batch; its durable cursor resumes on the next run.
    ctx.waitUntil(
      drainStaffReconciliations(env, { maxJobs: 2, maxOrders: 25 }).catch((error) => {
        console.error('scheduled staff reconciliation rejected:', error);
      })
    );
    ctx.waitUntil(
      // See (1) above: the entrypoint contains what the steps already contain.
      runDurableJobs(env).catch((error) => {
        console.error('scheduled durable jobs rejected outside any step:', error);
      })
    );
    // Upload sessions past `expires_at` (§9.4): abort the R2 multipart upload
    // so its parts stop costing storage, expire the row, ≤ 200 per tick.
    // Contained the same way as the durable jobs above.
    ctx.waitUntil(
      sweepExpiredUploadSessions(env).catch((error) => {
        console.error('scheduled upload-session sweep rejected:', error);
      })
    );
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
