/**
 * THE ROLE MATRIX FIXTURE — owner decision 2 (2026-10-07), step S1.
 *
 * «Main Admin / Owner فقط … لا يستطيع رؤية بيانات التكلفة: Assistant Admin،
 * Employee، Merchant، Investor، Support، Customer، User، Guest».
 *
 * One place that knows every role the decision names, the routers a cost can
 * travel through, and how to sweep them. tests/costRoleMatrix.test.ts sweeps
 * the base mounts with it; every later step that adds a private router adds
 * its own matrix test that imports THIS file (master plan §4.0), so a new
 * role or a new sentinel reaches every sweep at once.
 *
 *   BASE_MOUNTS   the routers, mounted on the prefixes worker/index.ts uses
 *   ROLES         every caller who must see NO cost, the full-scope admin and
 *                 the legacy NULL-scope admin included (they move money, they
 *                 never see a cost), plus a "grantee" whose grant row is
 *                 ignored while PRIVATE_DELEGATION_ENABLED is false, and the
 *                 three roles critique G-2 adds: an employee on a profit-share
 *                 wage, an investor with a funded contract, and a support
 *                 assistant holding an operations capability
 *   OWNER         the one account that sees cost (INITIAL_ADMIN_EMAIL)
 *   seedRoleMatrix  the costly product + stock, and one account per role
 *   sweepGets     every GET of the mounts, per role, walked with `leaks`
 *   sweepWrites   every POST/PUT/PATCH/DELETE of the mounts, per role, with an
 *                 empty body and the route's own valid body where one is
 *                 given; success AND error bodies walked (critique A3)
 *   leaks         re-exported from costlyProduct.ts: cost-named numbers,
 *                 FINANCIAL_FIELDS keys with a value, and every sentinel
 */
import type { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER, asD1, freshDb, stubApp, type StubUser } from './app';
import { resetPolicyCorpusMemo } from '../../worker/lib/policySync';
import { leaks, seedCostlyOrder, seedCostlyProduct, seedCostlyPurchase, seedCostlyStock, type LeakExtra } from './costlyProduct';
import type { AppContext } from '../../worker/lib/types';

import { productRoutes, homeRoutes } from '../../worker/routes/products';
import { bundlesRoutes, adminCompositionAnalyticsRoutes } from '../../worker/routes/bundles';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { quickBuyRoutes } from '../../worker/routes/quickBuy';
import { compareRoutes } from '../../worker/routes/compare';
import { catalogRoutes } from '../../worker/routes/catalog';
import { printerFinderRoutes } from '../../worker/routes/printerFinder';
import { publicApiRoutes } from '../../worker/routes/publicApi';
import { miscRoutes } from '../../worker/routes/misc';
import { giftRoutes } from '../../worker/routes/gifts';
import { adminTradeInRoutes, tradeInRoutes } from '../../worker/routes/tradeIn';
import { priceProtectionRoutes, returnRoutes } from '../../worker/routes/returns';
import { adminRoutes } from '../../worker/routes/admin';
import { adminBundlesRoutes } from '../../worker/routes/adminBundles';
import { adminMysteryRoutes } from '../../worker/routes/mystery';
import { adminOffersRoutes } from '../../worker/routes/offers';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';
import { templateRoutes } from '../../worker/routes/template';
import { adminTaxonomyRoutes } from '../../worker/routes/adminTaxonomy';
import { adminInventoryRoutes } from '../../worker/routes/adminInventory';
import { adminProcurementRoutes } from '../../worker/routes/adminProcurement';
import { adminStockOperationsRoutes } from '../../worker/routes/adminStockOperations';
import { adminImportRoutes } from '../../worker/routes/adminImport';
import { adminProductRelationsRoutes } from '../../worker/routes/adminProductRelations';
import { adminPriceGridRoutes } from '../../worker/routes/adminPriceGrid';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../../worker/routes/orderPriceAdjust';
import { adminMembershipBenefitRoutes } from '../../worker/routes/adminMembershipBenefits';
import { adminFinanceOperationsRoutes } from '../../worker/routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from '../../worker/routes/adminFinanceWorkspace';
import { adminFinancePeopleRoutes } from '../../worker/routes/adminFinancePeople';
import { adminInvestmentFinanceRoutes } from '../../worker/routes/adminInvestmentFinance';
import { adminFinanceRoutes } from '../../worker/routes/adminFinance';
import { adminFinanceReportRoutes } from '../../worker/routes/adminFinanceReport';
import { financeEarningsRoutes } from '../../worker/routes/financeEarnings';
import { farmAdminRoutes } from '../../worker/routes/farmAdmin';
import { adminPrintQuoteRoutes, printQuoteRoutes } from '../../worker/routes/printQuote';
import { adminPriceReportRoutes, priceReportRoutes } from '../../worker/routes/priceReports';
import { warrantyAdminRoutes, warrantyPublicRoutes } from '../../worker/routes/warranty';
import { adminCommunityRoutes } from '../../worker/routes/adminCommunity';
import { adminChatRoutes } from '../../worker/routes/adminChats';
import { adminWalletAdjustRoutes } from '../../worker/routes/adminWalletAdjust';
import { mediaRoutes } from '../../worker/routes/media';
import { investRoutes } from '../../worker/routes/invest';
import { walletRoutes } from '../../worker/routes/wallet';
import { notificationRoutes } from '../../worker/routes/notifications';
import { supportRoutes } from '../../worker/routes/support';
import { invoiceRoutes } from '../../worker/routes/invoices';
import { stockAlertRoutes } from '../../worker/routes/stockAlerts';
import { membershipsRoutes } from '../../worker/routes/memberships';
import { chatRoutes } from '../../worker/routes/chats';
import { authRoutes } from '../../worker/routes/auth';
import { addressRoutes } from '../../worker/routes/addresses';
import { rewardRoutes } from '../../worker/routes/rewards';
import { subscriptionRoutes } from '../../worker/routes/subscription';
import { communityRoutes } from '../../worker/routes/community';
import { communityPostRoutes } from '../../worker/routes/communityPosts';
import { communitySocialRoutes } from '../../worker/routes/communitySocial';
import { communitySearchRoutes } from '../../worker/routes/communitySearch';
import { chatCommerceRoutes } from '../../worker/routes/chatCommerce';
import { linkCardRoutes } from '../../worker/routes/linkCards';
import { profileRoutes } from '../../worker/routes/profile';
import { fileRoutes, uploadRoutes } from '../../worker/routes/uploads';
import { uploadSessionRoutes } from '../../worker/routes/uploadSessions';
import { farmRoutes } from '../../worker/routes/farm';
import { telegramRoutes } from '../../worker/routes/telegram';
import { deviceRoutes } from '../../worker/routes/devices';
import { reviewRoutes } from '../../worker/routes/reviews';
import { legacyGiftRoutes } from '../../worker/routes/gifts';
import { policiesRoutes } from '../../worker/routes/policies';
import { kycRoutes } from '../../worker/routes/kyc';
import { referralRoutes } from '../../worker/routes/referrals';
import { studioRoutes } from '../../worker/routes/studio';
import { merchantCustomerRoutes } from '../../worker/routes/merchantCustomers';
import { merchantWorkshopRoutes } from '../../worker/routes/merchantWorkshop';
import { merchantRoutes } from '../../worker/routes/merchant';
import { merchantPrinterRoutes } from '../../worker/routes/merchantPrinters';
import { merchantCatalogRoutes } from '../../worker/routes/merchantCatalog';
import { merchantProductFileRoutes, publicProductFileRoutes } from '../../worker/routes/productFiles';
import { storeLayoutRoutes } from '../../worker/routes/storeLayout';
import { merchantNotificationRoutes } from '../../worker/routes/merchantNotifications';
import { merchantInboxRoutes } from '../../worker/routes/merchantInbox';
import { merchantAnalyticsRoutes } from '../../worker/routes/merchantAnalytics';
import { merchantOrderRoutes } from '../../worker/routes/merchantOrders';
import { merchantFinanceRoutes, merchantPayoutRoutes } from '../../worker/routes/merchantFinance';
import { merchantAttentionRoutes, merchantSearchRoutes } from '../../worker/routes/merchantWorkspace';
import { storefrontEventRoutes } from '../../worker/routes/storefrontEvents';
import { storefrontRoutes } from '../../worker/routes/storefront';
import { printRequestRoutes } from '../../worker/routes/printRequests';
import { marketplaceRoutes } from '../../worker/routes/marketplace';
import { requestDiscussionRoutes } from '../../worker/routes/requestDiscussion';
import { communityOrderTimelineRoutes } from '../../worker/routes/communityOrderTimeline';
import { storeOrderRoutes } from '../../worker/routes/storeOrders';
import { communityReviewRoutes } from '../../worker/routes/merchantReviews';
import { communityFavoriteRoutes } from '../../worker/routes/communityFavorites';

export { leaks, OWNER };
export type { LeakExtra };

export type Router = Hono<AppContext>;
export type MountSpec = readonly [prefix: string, router: Router];

/**
 * Mounted as worker/index.ts mounts them — same prefixes, same order where it
 * matters (the two `/api/admin/products` routers, `/api/admin` before its
 * longer siblings). EVERY mount of worker/index.ts is here (critique G-30):
 * tests/costRouteClassification.test.ts fails on a mount that is neither in
 * this list nor exempted there with a reason, so a cost-bearing route added
 * to any router — admin, merchant, auth, chat, marketplace — is swept by both
 * the GET and the write sweep from the day it is mounted.
 */
export const BASE_MOUNTS: readonly MountSpec[] = [
  ['/api/products', productRoutes as Router],
  ['/api/bundles', bundlesRoutes as Router],
  ['/api/admin/bundles', adminBundlesRoutes as Router],
  ['/api/admin/mystery', adminMysteryRoutes as Router],
  ['/api/admin/offers', adminOffersRoutes as Router],
  ['/api/admin/analytics', adminCompositionAnalyticsRoutes as Router],
  ['/api/home', homeRoutes as Router],
  ['/api/cart', cartRoutes as Router],
  ['/api/orders', orderRoutes as Router],
  ['/api/quick-buy', quickBuyRoutes as Router],
  ['/api/orders', orderPriceRoutes as Router],
  ['/api/admin/orders', adminOrderPriceRoutes as Router],
  ['/api/trade-in', tradeInRoutes as Router],
  ['/api/admin/trade-in', adminTradeInRoutes as Router],
  ['/api/wallet', walletRoutes as Router],
  ['/api/invest', investRoutes as Router],
  ['/api/chats', chatRoutes as Router],
  ['/api/chats', chatCommerceRoutes as Router],
  ['/api/auth', authRoutes as Router],
  ['/api/addresses', addressRoutes as Router],
  ['/api/rewards', rewardRoutes as Router],
  ['/api/subscription', subscriptionRoutes as Router],
  ['/api/community', communityRoutes as Router],
  ['/api/community', communityPostRoutes as Router],
  ['/api/community', communitySocialRoutes as Router],
  ['/api/community', communitySearchRoutes as Router],
  ['/api/link-cards', linkCardRoutes as Router],
  ['/api/profile', profileRoutes as Router],
  ['/api/uploads', uploadRoutes as Router],
  ['/api/uploads/sessions', uploadSessionRoutes as Router],
  ['/api/farm', farmRoutes as Router],
  ['/api/compare', compareRoutes as Router],
  ['/api/catalog', catalogRoutes as Router],
  ['/api/printer-finder', printerFinderRoutes as Router],
  ['/api/public/v1', publicApiRoutes as Router],
  ['/api', miscRoutes as Router],
  ['/api/admin', adminRoutes as Router],
  ['/api/admin/farm', farmAdminRoutes as Router],
  ['/api/print-quote', printQuoteRoutes as Router],
  ['/api/admin/print-quote', adminPrintQuoteRoutes as Router],
  ['/api/price-reports', priceReportRoutes as Router],
  ['/api/admin/price-reports', adminPriceReportRoutes as Router],
  ['/api/admin/products-v2', adminProductsRoutes as Router],
  ['/api/admin/template', templateRoutes as Router],
  ['/api/admin/media', mediaRoutes as Router],
  ['/api/admin/taxonomy', adminTaxonomyRoutes as Router],
  ['/api/admin/inventory', adminInventoryRoutes as Router],
  ['/api/admin/procurement', adminProcurementRoutes as Router],
  ['/api/admin/stock-operations', adminStockOperationsRoutes as Router],
  ['/api/admin/finance-operations', adminFinanceOperationsRoutes as Router],
  ['/api/admin/finance-workspace', adminFinanceWorkspaceRoutes as Router],
  ['/api/admin/finance-people', adminFinancePeopleRoutes as Router],
  ['/api/admin/investment-finance', adminInvestmentFinanceRoutes as Router],
  ['/api/finance-earnings', financeEarningsRoutes as Router],
  ['/api/admin/membership-benefits', adminMembershipBenefitRoutes as Router],
  ['/api/warranty', warrantyPublicRoutes as Router],
  ['/api/admin/warranties', warrantyAdminRoutes as Router],
  ['/api/admin/community', adminCommunityRoutes as Router],
  ['/api/admin/chats', adminChatRoutes as Router],
  ['/api/admin/wallet-adjust', adminWalletAdjustRoutes as Router],
  ['/api/admin/import', adminImportRoutes as Router],
  ['/api/admin/products', adminProductRelationsRoutes as Router],
  ['/api/admin/products', adminPriceGridRoutes as Router],
  ['/api/admin/finance', adminFinanceRoutes as Router],
  ['/api/admin/finance/report', adminFinanceReportRoutes as Router],
  ['/api/memberships', membershipsRoutes as Router],
  ['/api/invoices', invoiceRoutes as Router],
  ['/api/gifts', giftRoutes as Router],
  ['/api/returns', returnRoutes as Router],
  ['/api/price-protection', priceProtectionRoutes as Router],
  ['/api/support', supportRoutes as Router],
  ['/api/notifications', notificationRoutes as Router],
  ['/api/stock-alerts', stockAlertRoutes as Router],
  ['/api/telegram', telegramRoutes as Router],
  ['/api/devices', deviceRoutes as Router],
  ['/api/reviews', reviewRoutes as Router],
  ['/api/reviews', legacyGiftRoutes as Router],
  ['/api/policies', policiesRoutes as Router],
  ['/api/kyc', kycRoutes as Router],
  ['/api/referrals', referralRoutes as Router],
  ['/api/studio', studioRoutes as Router],
  ['/api/merchant/customers', merchantCustomerRoutes as Router],
  ['/api/merchant/workshop', merchantWorkshopRoutes as Router],
  ['/api/merchant', merchantRoutes as Router],
  ['/api/merchant', merchantPrinterRoutes as Router],
  ['/api/merchant', merchantCatalogRoutes as Router],
  ['/api/merchant', merchantProductFileRoutes as Router],
  ['/api/merchant/store/layout', storeLayoutRoutes as Router],
  ['/api/merchant/notifications', merchantNotificationRoutes as Router],
  ['/api/merchant/inbox', merchantInboxRoutes as Router],
  ['/api/merchant/analytics', merchantAnalyticsRoutes as Router],
  ['/api/merchant/orders', merchantOrderRoutes as Router],
  ['/api/merchant/finance', merchantFinanceRoutes as Router],
  ['/api/merchant/payouts', merchantPayoutRoutes as Router],
  ['/api/merchant/attention', merchantAttentionRoutes as Router],
  ['/api/merchant/search', merchantSearchRoutes as Router],
  ['/api/storefront/events', storefrontEventRoutes as Router],
  ['/api/storefront', storefrontRoutes as Router],
  ['/api/product-files', publicProductFileRoutes as Router],
  ['/api/marketplace/print', printRequestRoutes as Router],
  ['/api/marketplace', marketplaceRoutes as Router],
  ['/api/marketplace', requestDiscussionRoutes as Router],
  ['/api/marketplace', communityOrderTimelineRoutes as Router],
  ['/api/store-orders', storeOrderRoutes as Router],
  ['/api/community-reviews', communityReviewRoutes as Router],
  ['/api/community-favorites', communityFavoriteRoutes as Router],
  ['/files', fileRoutes as Router],
];

/** Every caller the sweep runs as. */
export type RoleName =
  | 'guest'
  | 'customer'
  | 'merchant'
  | 'assistant'
  | 'full'
  | 'legacy_null'
  | 'grantee_off'
  | 'employee'
  | 'investor'
  | 'support_assistant';

/**
 * EVERY ONE OF THESE SEES NO COST. `full` and `legacy_null` are the two that
 * saw every cost before S1 (decision 2 keeps their money actions and removes
 * the cost). `grantee_off` carries both private grants — as a row in
 * admin_private_grants AND on the session — and must see nothing while
 * delegation is off. `employee` is a customer whose wage is a share of profit,
 * `investor` a customer with a funded contract (critique G-2): each sees their
 * own share only, never a cost. `support_assistant` holds the `receive`
 * operations capability.
 */
export const ROLES: Readonly<Record<RoleName, StubUser | null>> = {
  guest: null,
  customer: { id: 'u1', role: 'customer', email: 's@x.co' },
  merchant: { id: 'u_m', role: 'merchant', email: 'm@x.co' },
  assistant: { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' },
  full: { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' },
  legacy_null: { id: 'usr_legacy', role: 'admin', email: 'legacy@x.co', admin_scope: null },
  grantee_off: {
    id: 'usr_grant',
    role: 'admin',
    email: 'grant@x.co',
    admin_scope: 'full',
    private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'],
  },
  employee: { id: 'usr_emp', role: 'customer', email: 'emp@x.co' },
  investor: { id: 'usr_inv', role: 'customer', email: 'inv@x.co', is_investor: 1 },
  support_assistant: { id: 'usr_support', role: 'admin', email: 'support@x.co', admin_scope: 'assistant' },
};

/**
 * THE OWNER'S OWN SESSION BEFORE THE ADDRESS IS VERIFIED (DECISIONS row 185,
 * amendment of 2026-10-08). The owner's address on the admin row, no
 * verification stamp: sees NO cost anywhere — exactly like a non-owner — and
 * hears OWNER_EMAIL_UNVERIFIED (the way out) where the others hear
 * COST_ACCESS_DENIED. Not in ROLES: it needs its own database
 * (`seededCopyUnverifiedOwner`), whose owner row carries no stamp either.
 */
export const OWNER_UNVERIFIED: StubUser = { ...OWNER, email_verified_at: null };

/** The admin roles, the ones that get past `requireAdmin`. */
export const ADMIN_ROLES: readonly RoleName[] = ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'];

/**
 * One account per role, beside the costly product and its stock. Admin rows
 * are INSERTed with their scope (the 0177 promotion trigger fires on an
 * UPDATE of role, never on an INSERT), and the owner's row carries a verified
 * address (critique A10).
 */
export function seedRoleMatrix(raw: DatabaseSync = freshDb()): DatabaseSync {
  seedCostlyProduct(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES
      ('u_m','Merchant','m@x.co','h','merchant',NULL,0,NULL),
      ('usr_asst','Asst','asst@x.co','h','admin','assistant',0,NULL),
      ('usr_full','Full','full@x.co','h','admin','full',0,'2026-01-01T00:00:00.000Z'),
      ('usr_legacy','Legacy','legacy@x.co','h','admin',NULL,0,'2026-01-01T00:00:00.000Z'),
      ('usr_grant','Grantee','grant@x.co','h','admin','full',0,'2026-01-01T00:00:00.000Z'),
      ('usr_emp','Employee','emp@x.co','h','customer',NULL,0,NULL),
      ('usr_inv','Investor','inv@x.co','h','customer',NULL,1,NULL),
      ('usr_support','Support','support@x.co','h','admin','assistant',0,NULL),
      ('usr_owner','Owner','boss@x.co','h','admin',NULL,0,'2026-01-01T00:00:00.000Z');
    INSERT INTO ops_permissions (user_id,capability,allowed) VALUES ('usr_support','receive',1);
    INSERT INTO stock_locations (id,name,kind) VALUES ('loc1','الرف الأول','shelf');
    INSERT INTO expense_categories (id,slug,name_ar) VALUES ('rm_wages','rm-wages','أجور');
    INSERT INTO finance_staff (id,name,role,user_id) VALUES ('staff_rm','Employee','تجهيز','usr_emp');
    INSERT INTO finance_cost_rules (id,name,group_key,target_type,basis,amount,staff_id,category_id,milestone,
                                    effective_from,created_at,created_by)
      VALUES ('rule_rm','نسبة من الربح','prep','all','profit_percent',1000,'staff_rm','rm_wages','delivered',
              '2026-01-01','2026-01-01T00:00:00.000Z','usr_owner');
  `);
  seedCostlyStock(raw);
  seedCostlyOrder(raw);
  seedCostlyPurchase(raw);
  raw.exec(`
    INSERT INTO investment_contracts (id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,
                                      loss_share_bps,created_by,created_at,request_json)
      VALUES ('ic_rm','inc1','usr_inv','Investor contract',1000000,10000,3500,0,'usr_owner','2026-09-01T00:00:00.000Z','{}');
    INSERT INTO investment_profiles (user_id,state,default_profit_share_bps,created_by,created_at,updated_at)
      VALUES ('usr_inv','active',3500,'usr_owner','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
  `);
  // A grant row as delegation would read it: ignored while it is off.
  try {
    raw.exec(`
      INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES
        ('apg_r','usr_grant','PRICING_PRIVATE_READ','usr_owner','op-rm-read'),
        ('apg_w','usr_grant','PRICING_PRIVATE_WRITE','usr_owner','op-rm-write');
    `);
  } catch {
    // A database built through 0176 (a deploy-ahead test) has no grants table.
  }
  return raw;
}

/**
 * A FRESH COPY OF THE SEEDED DATABASE, IN MILLISECONDS.
 *
 * Applying every migration takes a second and a half, and the classification
 * test needs a clean database for every caller of every router. So the seeded
 * database is built ONCE per process, written to a temporary file with
 * `VACUUM INTO`, and each caller gets a byte copy of that file. Same schema,
 * same rows, same triggers — and each copy is its own throwaway database.
 */
let templateFile: string | null = null;
let scratchDir: string | null = null;
let copies = 0;
export function seededCopy(): DatabaseSync {
  if (!templateFile) {
    scratchDir = mkdtempSync(join(tmpdir(), 'levonis-role-matrix-'));
    templateFile = join(scratchDir, 'template.db');
    const raw = seedRoleMatrix();
    raw.exec(`VACUUM INTO '${templateFile.replace(/'/g, "''")}'`);
    raw.close();
    process.once('exit', () => {
      try {
        rmSync(scratchDir!, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
  }
  const file = join(scratchDir!, `copy-${process.pid}-${(copies += 1)}.db`);
  copyFileSync(templateFile, file);
  // A new database is a new policy archive (the same reset dbThrough makes).
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  return raw;
}

/** A seeded copy whose owner row has no verification stamp — the database `OWNER_UNVERIFIED` reads. */
export function seededCopyUnverifiedOwner(): DatabaseSync {
  const raw = seededCopy();
  raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_owner'");
  return raw;
}

/**
 * Answers that name cost but carry none of the shop's private cost. Each says
 * why; a new one needs the same justification, not a shrug. Matched on the
 * route AND the key path, so the same key anywhere else still fails.
 */
export interface NotACost {
  path: RegExp;
  leak: RegExp;
  why: string;
}
export const NOT_A_COST: readonly NotACost[] = [
  {
    path: /^\/api\/finance-earnings$/,
    leak: /\.pending_costs = /,
    why: 'a COUNT of the caller’s own wage rows still waiting for an amount — how many, never how much',
  },
  {
    path: /^\/api\/(print-quote\/accessories|marketplace\/print\/catalog|admin\/settings)$/,
    leak: /\.(accessories|printAccessories)\[\d+\]\.cost_iqd = /,
    why: 'the per-piece accessory price a print quote bills — published by design (worker/routes/printQuote.ts, and the print-request catalogue that lists the same accessories)',
  },
  {
    path: /^\/api\/(admin\/)?farm\/(config|state)$|^\/api\/admin\/settings$/,
    leak: /\.economy\.(maintenance|repair)\.cost = /,
    why: 'in-game coins of the printer-farm game (worker/lib/farm/config.ts), not dinars',
  },
  {
    path: /^\/api\/subscription\/plans$/,
    leak: /\.plans\.(plus|pro)\[\d+\]\.cost_iqd = /,
    why: 'a membership plan’s SALE price under its legacy key (`cost_iqd: p.price_iqd`, worker/routes/subscription.ts) — what the customer pays, published by design',
  },
  {
    path: /^\/api\/admin\/products(-v2)?\/[^/]+$/,
    leak: /\.rows_deleted_by_table\.\w+ = \d+$/,
    why: 'a product deletion reports how many ROWS it removed from each table (a table named …_cost_defaults included) — a count, never a value',
  },
];

/** Every seeded id a path parameter can name. Unknown names get the product id. */
export const PARAM: Readonly<Record<string, string>> = {
  slug: 'a1',
  productId: 'p_a1',
  product_id: 'p_a1',
  id: 'p_a1',
  optionId: 'v_a1',
  colorId: 'c_blk',
  lotId: 'lot1',
  incomingId: 'inc1',
  orderId: 'ord1',
};

/** One route pattern filled with seeded ids — and, for the stock routers, with a lot and a purchase too. */
export function concrete(prefix: string, path: string): string[] {
  if (path.includes('*')) return [];
  const fill = (p: string) => p.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) => PARAM[name] ?? 'p_a1');
  const filled = fill(path);
  const full = `${prefix}${filled === '/' ? '' : filled}` || '/';
  // `:id` is a product on most routers and a lot or a purchase on the stock
  // ones; try both so neither reading is skipped.
  const alts = new Set([full]);
  if (/inventory|stock-operations|procurement|investment-finance/.test(prefix) && path.includes(':id')) {
    alts.add(`${prefix}${fill(path.replace(/:id(\{[^}]*\})?/g, 'lot1'))}`);
    alts.add(`${prefix}${fill(path.replace(/:id(\{[^}]*\})?/g, 'inc1'))}`);
  }
  // …a purchase document on the procurement document and receiving routes…
  if (prefix.endsWith('/procurement') && (path.startsWith('/documents/:id') || path.startsWith('/receiving/:id'))) {
    alts.add(`${prefix}${fill(path.replace(/:id(\{[^}]*\})?/g, 'po1'))}`);
  }
  // …and an order on every order route: `ord1` carries a cost snapshot and a COGS.
  if (/\/orders?(\/|$)/.test(`${prefix}${path}`) && /:(id|orderId|order_id)\b/.test(path)) {
    alts.add(`${prefix}${fill(path.replace(/:(id|orderId|order_id)(\{[^}]*\})?/g, 'ord1'))}`);
  }
  return [...alts];
}

/** Every concrete GET path of the mounts, sorted. */
export function getPaths(mounts: readonly MountSpec[] = BASE_MOUNTS): string[] {
  const out = new Set<string>();
  for (const [prefix, router] of mounts) {
    for (const r of router.routes) {
      if (r.method !== 'GET') continue;
      for (const p of concrete(prefix, r.path)) out.add(p);
    }
  }
  return [...out].sort();
}

/** Every non-GET route of the mounts, as `{ method, prefix, path, key }`. */
export function writeRoutes(mounts: readonly MountSpec[] = BASE_MOUNTS) {
  const out: Array<{ method: string; prefix: string; path: string; key: string }> = [];
  const seen = new Set<string>();
  for (const [prefix, router] of mounts) {
    for (const r of router.routes) {
      if (r.method === 'GET' || r.method === 'ALL' || r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      const key = `${r.method} ${prefix}${r.path === '/' ? '' : r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method: r.method, prefix, path: r.path, key });
    }
  }
  return out;
}

export function appFor(raw: DatabaseSync, user: StubUser | null, mounts: readonly MountSpec[] = BASE_MOUNTS) {
  return stubApp(asD1(raw), user, (a) => {
    for (const [prefix, router] of mounts) a.route(prefix, router);
  });
}

export type MatrixApp = ReturnType<typeof appFor>;

export interface CallResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/** One request, answered or timed out (599) — a route that hangs is reported, not waited on. */
export async function call(
  app: MatrixApp,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 8000
): Promise<CallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 599, body: null, headers: new Headers() }), timeoutMs);
  });
  const run = (async () => {
    const init: RequestInit = { method, headers: { 'CF-Connecting-IP': '1.2.3.4' } };
    if (method !== 'GET' && method !== 'HEAD') {
      init.headers = { ...init.headers, 'content-type': 'application/json', origin: 'https://levonis-iq.com' };
      init.body = JSON.stringify(body ?? {});
    }
    const res = await app.request(path, init);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let parsed: unknown = text;
    if (type.includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep the text */
      }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SweepOptions {
  mounts?: readonly MountSpec[];
  seed?: () => DatabaseSync;
  roles?: Readonly<Partial<Record<string, StubUser | null>>>;
  extra?: LeakExtra;
  notACost?: readonly NotACost[];
}

export interface SweepResult {
  /** 2xx answers walked. */
  answered: number;
  /** Every leak, as `<path>  <where>`, minus the NOT_A_COST exceptions. */
  leaks: string[];
  /** Paths whose 2xx answer carried a cost (the owner's sweep reads this). */
  costSeen: string[];
  /** Every path's status, for "what did THIS role get where the owner saw cost". */
  statuses: Record<string, number>;
  /** The refusal code of every non-2xx answer that carried one. */
  codes: Record<string, string>;
}

const refusalCodeOf = (body: unknown): string | undefined =>
  body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined;

const filtered = (path: string, body: unknown, extra: LeakExtra | undefined, notACost: readonly NotACost[]) =>
  leaks(body, extra).filter((l) => !notACost.some((x) => x.path.test(path) && x.leak.test(l)));

/**
 * Every GET of the mounts, called as each role on its own seeded database;
 * every 2xx walked to its last leaf. A refusal (401/403/404/400) is a pass:
 * what is not served cannot leak.
 */
export async function sweepGets(opts: SweepOptions = {}): Promise<Record<string, SweepResult>> {
  const mounts = opts.mounts ?? BASE_MOUNTS;
  const roles = opts.roles ?? ROLES;
  const seed = opts.seed ?? seededCopy;
  const notACost = opts.notACost ?? NOT_A_COST;
  const paths = getPaths(mounts);
  const out: Record<string, SweepResult> = {};
  for (const [role, user] of Object.entries(roles)) {
    const app = appFor(seed(), user ?? null, mounts);
    const result: SweepResult = { answered: 0, leaks: [], costSeen: [], statuses: {}, codes: {} };
    for (const path of paths) {
      const { status, body } = await call(app, 'GET', path);
      result.statuses[path] = status;
      if (status < 200 || status >= 300) {
        const code = refusalCodeOf(body);
        if (code) result.codes[path] = code;
        // A refusal carries no cost either — walked like an answer.
        for (const l of filtered(path, body, opts.extra, notACost)) result.leaks.push(`${path}  ${l}`);
        continue;
      }
      result.answered += 1;
      const found = filtered(path, body, opts.extra, notACost);
      if (found.length) result.costSeen.push(path);
      for (const l of found) result.leaks.push(`${path}  ${l}`);
    }
    out[role] = result;
  }
  return out;
}

/**
 * A route's valid body for the write sweep. A function builds it from what the
 * SAME caller reads first — the round trip a panel makes (read the document,
 * send it back) — so a non-owner's body carries exactly what that caller was
 * allowed to see, never a cost it was not.
 */
export type BodyFactory = (read: (path: string) => Promise<Record<string, unknown>>) => unknown | Promise<unknown>;
export type WriteBody = unknown | BodyFactory;
export type WriteBodies = Readonly<Record<string, { body: WriteBody; path?: string } | { noBody: string; path?: string }>>;

/** Resolve a static or round-trip body as `app`'s caller. */
export async function resolveBody(app: MatrixApp, body: WriteBody): Promise<unknown> {
  if (typeof body !== 'function') return body;
  // A JSON answer as itself; a text answer (an exported template) as `{ text }`.
  const read = async (path: string) => {
    const r = await call(app, 'GET', path);
    if (typeof r.body === 'string') return { text: r.body };
    return (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
  };
  return (body as BodyFactory)(read);
}

export interface WriteSweepResult {
  /** Requests made. */
  called: number;
  /** Every refusal code answered, as `<METHOD path>` → code. */
  codes: Record<string, string>;
  /** Requests that answered 2xx. */
  succeeded: number;
  /** Requests that hung past the timeout. */
  timedOut: string[];
  /** Every leak in a success OR error body, as `<METHOD path>  <where>`. */
  leaks: string[];
}

/**
 * Every POST/PUT/PATCH/DELETE of the mounts, called as each role on its own
 * throwaway database (critique A3): once with an empty body — the invalid
 * body, which exercises every validation refusal — and once more with the
 * route's own valid body where `bodies` gives one. The success body AND the
 * error body (its `details` included) are walked: a refusal that names a
 * cost is a leak like any other.
 */
export async function sweepWrites(opts: SweepOptions & { bodies?: WriteBodies; filter?: (key: string) => boolean } = {}): Promise<Record<string, WriteSweepResult>> {
  const mounts = opts.mounts ?? BASE_MOUNTS;
  const roles = opts.roles ?? ROLES;
  const seed = opts.seed ?? seededCopy;
  const notACost = opts.notACost ?? NOT_A_COST;
  // DELETEs last: a sweep that deletes the seeded product first would leave
  // every later write answering 404 and prove nothing.
  const routes = writeRoutes(mounts)
    .filter((r) => !opts.filter || opts.filter(r.key))
    .sort((a, b) => Number(a.method === 'DELETE') - Number(b.method === 'DELETE'));
  const out: Record<string, WriteSweepResult> = {};
  for (const [role, user] of Object.entries(roles)) {
    const app = appFor(seed(), user ?? null, mounts);
    const result: WriteSweepResult = { called: 0, codes: {}, succeeded: 0, timedOut: [], leaks: [] };
    for (const r of routes) {
      const given = opts.bodies?.[r.key];
      const bodies: WriteBody[] = [{}];
      if (given && 'body' in given) bodies.push(given.body);
      // A route that needs a particular real target (a settings key, a user)
      // names it; otherwise every seeded reading of its parameters is tried.
      const paths = given?.path ? [given.path, ...concrete(r.prefix, r.path)] : concrete(r.prefix, r.path);
      for (const path of paths) {
        for (const body of bodies) {
          const res = await call(app, r.method, path, await resolveBody(app, body), 4000);
          result.called += 1;
          if (res.status === 599) {
            result.timedOut.push(`${r.method} ${path}`);
            continue;
          }
          if (res.status >= 200 && res.status < 300) result.succeeded += 1;
          else {
            const code = refusalCodeOf(res.body);
            if (code) result.codes[`${r.method} ${path}`] = code;
          }
          for (const l of filtered(path, res.body, opts.extra, notACost)) result.leaks.push(`${r.method} ${path}  ${l}`);
        }
      }
    }
    out[role] = result;
  }
  return out;
}
