/**
 * THE CATALOG-ONLY WORLD (DECISIONS rows 239 (3) and 240).
 *
 * The live catalogue of 2026-09-25 (tests/fixtures/liveCatalog.ts), every
 * product V2-published through the real writer EXCEPT one printer, the H2D,
 * which stays as the clean start left it: shown, never priced. It carries a
 * legacy SENTINEL on every money column the catalogue holds — the product's
 * own ladder and fees, each option value, each colour, each SKU variant, each
 * order-type cell and each pre-order route — so a projection that read the
 * archive instead of the product's commercial state publishes a number this
 * file names. The sentinels are whole thousands (a dinar price is), distinct
 * from each other and from `COST` (tests/fixtures/costlyProduct.ts); the H2D's
 * own costs are `COST` sentinels, so the same walk finds a cost too.
 *
 * Customer routes are mounted on `stubApp` WITHOUT the fixture's auto-publish
 * (`publishV2: false`), so the H2D is never published behind the test's back;
 * `guest` reaches the real Worker (sitemap, social preview, edge paths).
 */
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb, stubApp, type StubUser } from './app';
import { COST, leaks } from './costlyProduct';
import { P, seedLiveCatalog } from './liveCatalog';
import { isV2Published, publishV2 } from './v2Publish';
import worker from '../../worker/index';

import { productRoutes, homeRoutes } from '../../worker/routes/products';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { quickBuyRoutes } from '../../worker/routes/quickBuy';
import { compareRoutes } from '../../worker/routes/compare';
import { catalogRoutes } from '../../worker/routes/catalog';
import { printerFinderRoutes } from '../../worker/routes/printerFinder';
import { publicApiRoutes } from '../../worker/routes/publicApi';
import { communitySearchRoutes } from '../../worker/routes/communitySearch';
import { communityFavoriteRoutes } from '../../worker/routes/communityFavorites';
import { profileRoutes } from '../../worker/routes/profile';
import { priceReportRoutes } from '../../worker/routes/priceReports';
import { stockAlertRoutes } from '../../worker/routes/stockAlerts';
import { tradeInRoutes } from '../../worker/routes/tradeIn';
import { printQuoteRoutes } from '../../worker/routes/printQuote';
import { supportRoutes } from '../../worker/routes/support';
import { giftRoutes } from '../../worker/routes/gifts';
import { returnRoutes } from '../../worker/routes/returns';
import { notificationRoutes } from '../../worker/routes/notifications';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';

/** The catalog-only printer: the live H2D, never V2-published. */
export const CAT = { id: P.H2D, slug: 'bambu-lab-h2d', name: 'Levo Catalog Printer H2D' } as const;

/** Its option values, colours and their SKU keys (skuComboKey). */
export const CAT_SEL = {
  std: 'v_cat_std',
  combo: 'v_cat_combo',
  grey: 'c_cat_grey',
  white: 'c_cat_white',
  key: (value: string, color: string) => `o:${value}|c:${color}`,
} as const;

/**
 * LEGACY SENTINELS — the archived dinar ladder migration 0190 left in the
 * rows. None may reach a customer answer in any form (number, digits in a
 * text, grouped digits).
 */
export const LEGACY = {
  price: 7_101_000,
  prime: 7_202_000,
  pro: 7_303_000,
  original: 7_404_000,
  surcharge: 7_011_000,
  memberPrime: 7_212_000,
  memberPro: 7_313_000,
  valueRegular: 7_505_000,
  valuePrime: 7_515_000,
  valuePro: 7_525_000,
  valueAdjust: 7_535_000,
  value2Regular: 7_545_000,
  value2Prime: 7_555_000,
  value2Pro: 7_565_000,
  value2Adjust: 7_575_000,
  colorRegular: 7_606_000,
  colorPrime: 7_616_000,
  colorPro: 7_626_000,
  colorAdjust: 7_636_000,
  color2Regular: 7_646_000,
  color2Prime: 7_656_000,
  color2Pro: 7_666_000,
  color2Adjust: 7_676_000,
  variantRegular: 7_707_000,
  variantPrime: 7_717_000,
  variantPro: 7_727_000,
  variant2Regular: 7_737_000,
  cellRegular: 7_808_000,
  cellPrime: 7_818_000,
  cellPro: 7_828_000,
  cellAdjust: 7_838_000,
  routeSurcharge: 7_909_000,
  routeRegular: 7_919_000,
  routePrime: 7_929_000,
  routeAdjust: 7_939_000,
} as const;

export const LEGACY_NUMBERS: readonly number[] = Object.values(LEGACY);

/** Every cost, private step and legacy sentinel in a response (an empty list is a clean answer). */
export const catalogLeaks = (value: unknown): string[] => leaks(value, { numbers: LEGACY_NUMBERS });

/** The roles that reach a customer route. */
export const CUSTOMER_ROLES: Readonly<Record<string, StubUser | null>> = {
  guest: null,
  customer: { id: 'u_cust', role: 'customer', email: 'cust@x.co' },
  prime: { id: 'u_prime', role: 'customer', email: 'prime@x.co' },
  pro: { id: 'u_pro', role: 'customer', email: 'pro@x.co' },
  assistant: { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' },
  full: { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' },
};

const FUTURE = '2099-01-01T00:00:00.000Z';

/** The H2D's catalogue structure, every money column on a legacy sentinel. */
export function seedCatalogOnlyPrinter(raw: DatabaseSync): void {
  const L = LEGACY;
  raw.exec(`
    UPDATE products SET name = '${CAT.name}', name_ar = 'طابعة الكتالوج H2D', name_ku = 'چاپکەری کەتەلۆگ H2D',
           price_iqd = ${L.price}, prime_price_iqd = ${L.prime}, pro_price_iqd = ${L.pro}, original_price_iqd = ${L.original},
           direct_surcharge_iqd = ${L.surcharge}, product_cost_iqd = ${COST.product},
           membership_prices = '{"prime":${L.memberPrime},"pro":${L.memberPro}}', stock = 0
     WHERE id = '${CAT.id}';
    INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary)
      VALUES ('img_cat', '${CAT.id}', '/files/products/cat.webp', 'products/cat.webp', 'image/webp', 1000, 800, 600, 0, 1);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_cat_model', '${CAT.id}', 'Model', 0, 1);
    INSERT INTO product_option_values
      (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, regular_price_iqd, prime_price_iqd, pro_price_iqd,
       regular_adjust_iqd, cost_iqd, cost_adjust_iqd)
    VALUES
      ('${CAT_SEL.std}', '${CAT.id}', 'g_cat_model', 'H2D', 'H2D العادية', 'H2D ئاسایی', 0, 1, 0, ${L.valueRegular}, ${L.valuePrime}, ${L.valuePro},
       ${L.valueAdjust}, ${COST.option}, ${COST.optionAdjust}),
      ('${CAT_SEL.combo}', '${CAT.id}', 'g_cat_model', 'H2D Combo', 'H2D كومبو', 'H2D کۆمبۆ', 1, 1, 0, ${L.value2Regular}, ${L.value2Prime}, ${L.value2Pro},
       ${L.value2Adjust}, ${COST.option}, ${COST.optionAdjust});
    INSERT INTO product_colors
      (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock, regular_price_iqd, prime_price_iqd, pro_price_iqd,
       regular_adjust_iqd, cost_iqd, cost_adjust_iqd)
    VALUES
      ('${CAT_SEL.grey}', '${CAT.id}', 'Grey', 'رمادي', 'خۆڵەمێشی', '#777777', 0, 1, 0, ${L.colorRegular}, ${L.colorPrime}, ${L.colorPro},
       ${L.colorAdjust}, ${COST.color}, ${COST.colorAdjust}),
      ('${CAT_SEL.white}', '${CAT.id}', 'White', 'أبيض', 'سپی', '#ffffff', 1, 1, 0, ${L.color2Regular}, ${L.color2Prime}, ${L.color2Pro},
       ${L.color2Adjust}, ${COST.color}, ${COST.colorAdjust});
    INSERT INTO product_variants (id, product_id, combo_key, sku, active, stock, regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
    VALUES
      ('pv_cat_1', '${CAT.id}', '${CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey)}', 'H2D-G', 1, 0, ${L.variantRegular}, ${L.variantPrime}, ${L.variantPro}, ${COST.option}),
      ('pv_cat_2', '${CAT.id}', '${CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white)}', 'H2DC-W', 1, 0, ${L.variant2Regular}, NULL, NULL, ${COST.option});
    INSERT INTO product_option_fulfillment
      (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, cost_iqd, cost_adjust_iqd)
    VALUES
      ('f_cat_d', '${CAT.id}', '${CAT_SEL.std}', 'direct_sale', 1, ${L.cellRegular}, ${L.cellPrime}, ${L.cellPro}, ${L.cellAdjust}, ${COST.cell}, ${COST.cellAdjust}),
      ('f_cat_p', '${CAT.id}', '${CAT_SEL.std}', 'pre_order', 1, ${L.cellRegular}, ${L.cellPrime}, ${L.cellPro}, ${L.cellAdjust}, ${COST.cell}, ${COST.cellAdjust});
    INSERT INTO product_option_transports
      (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd, prime_price_iqd, regular_adjust_iqd, cost_iqd, cost_adjust_iqd)
    VALUES ('t_cat_air', '${CAT.id}', 'f_cat_p', 'air', 1, ${L.routeSurcharge}, ${L.routeRegular}, ${L.routePrime}, ${L.routeAdjust}, ${COST.route}, ${COST.routeAdjust});
  `);
}

/** One account per customer role (PRIME and PRO through an active membership) and the two admin scopes. */
export function seedCustomerRoles(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role, username, admin_scope, email_verified_at) VALUES
      ('u_cust', 'Buyer', 'cust@x.co', 'h', 'customer', 'u_cust', NULL, '2026-01-01T00:00:00.000Z'),
      ('u_prime', 'Prime', 'prime@x.co', 'h', 'customer', 'u_prime', NULL, '2026-01-01T00:00:00.000Z'),
      ('u_pro', 'Pro', 'pro@x.co', 'h', 'customer', 'u_pro', NULL, '2026-01-01T00:00:00.000Z'),
      ('usr_asst', 'Asst', 'asst@x.co', 'h', 'admin', 'usr_asst', 'assistant', NULL),
      ('usr_full', 'Full', 'full@x.co', 'h', 'admin', 'usr_full', 'full', '2026-01-01T00:00:00.000Z'),
      ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin', 'usr_owner', NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, starts_at, expires_at) VALUES
      ('m_prime', 'u_prime', 'prime_12mo', 'prime', 'active', 12, '2026-01-01T00:00:00.000Z', '${FUTURE}'),
      ('m_pro', 'u_pro', 'pro_12mo', 'pro', 'active', 12, '2026-01-01T00:00:00.000Z', '${FUTURE}');
  `);
}

/** Every product but `except` published in V2 through the real writer (the priced shelf). */
export async function publishAllBut(raw: DatabaseSync, except: readonly string[]): Promise<string[]> {
  const skip = new Set(except);
  const rows = raw.prepare("SELECT id FROM products WHERE COALESCE(composition, '') = '' ORDER BY id").all() as Array<{ id: string }>;
  const done: string[] = [];
  for (const { id } of rows) {
    if (skip.has(id) || isV2Published(raw, id)) continue;
    await publishV2(raw, id);
    done.push(id);
  }
  return done;
}

/** Every customer router the catalog-only tests reach, on the prefixes worker/index.ts uses. */
export function mountCustomer(a: Parameters<Parameters<typeof stubApp>[2]>[0]): void {
  a.route('/api/products', productRoutes);
  a.route('/api/home', homeRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/quick-buy', quickBuyRoutes);
  a.route('/api/compare', compareRoutes);
  a.route('/api/catalog', catalogRoutes);
  a.route('/api/printer-finder', printerFinderRoutes);
  a.route('/api/public/v1', publicApiRoutes);
  a.route('/api/community', communitySearchRoutes);
  a.route('/api/community-favorites', communityFavoriteRoutes);
  a.route('/api/profile', profileRoutes);
  a.route('/api/price-reports', priceReportRoutes);
  a.route('/api/stock-alerts', stockAlertRoutes);
  a.route('/api/trade-in', tradeInRoutes);
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/support', supportRoutes);
  a.route('/api/gifts', giftRoutes);
  a.route('/api/returns', returnRoutes);
  a.route('/api/notifications', notificationRoutes);
}

export interface CatalogOnlyWorld {
  raw: DatabaseSync;
  db: D1Database;
  /** The customer routes as `user` (null = signed out); the H2D is never auto-published. */
  as: (user: StubUser | null) => ReturnType<typeof stubApp>;
  /** The owner's admin products router. */
  admin: (user?: StubUser) => ReturnType<typeof stubApp>;
  /** A signed-out visitor through the real Worker (a fresh address a call). */
  guest: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Response>;
  priced: string[];
}

/** The live catalogue, the catalog-only H2D, the role accounts, everything else priced. */
export async function catalogOnlyWorld(opts: { raw?: DatabaseSync; publish?: boolean; alsoUnpriced?: readonly string[] } = {}): Promise<CatalogOnlyWorld> {
  const raw = opts.raw ?? freshDb();
  seedLiveCatalog(raw);
  seedCatalogOnlyPrinter(raw);
  seedCustomerRoles(raw);
  const priced = opts.publish === false ? [] : await publishAllBut(raw, [CAT.id, ...(opts.alsoUnpriced ?? [])]);
  const db = asD1(raw);
  const env = {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('<!doctype html><html><head><title>Levonis</title></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
  };
  let ip = 0;
  return {
    raw,
    db,
    priced,
    as: (user) => stubApp(db, user, mountCustomer, { publishV2: false }),
    admin: (user = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }) =>
      stubApp(db, user, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false }),
    guest: async (path, init = {}) =>
      worker.fetch(
        new Request(`https://${APEX}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            Host: APEX,
            'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...(init.headers ?? {}),
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        }),
        env as never,
        ctx
      ),
  };
}

/** The row counts of every money and stock table (a price request or a refused purchase must change none). */
export const MONEY_TABLES = [
  'orders',
  'order_items',
  'cart_items',
  'wallet_transactions',
  'wallet_holds',
  'wallet_adjustments',
  'inventory_lots',
  'inventory_ledger',
  'quick_buy_sessions',
  'quick_buy_items',
  'gift_entitlements',
  'gift_redemptions',
  'price_history',
  'product_sku_prices',
  'pricing_v2_sku_results',
  'pricing_price_points',
  'pricing_inputs',
  'product_pricing_state',
] as const;

export function moneyCounts(raw: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of MONEY_TABLES) out[t] = Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  return out;
}

/** The H2D's row and every money column of its relations, as a fingerprint (a refused purchase changes none). */
export function catalogMoneyFingerprint(raw: DatabaseSync): string {
  const parts: unknown[] = [raw.prepare('SELECT * FROM products WHERE id = ?').all(CAT.id)];
  for (const t of ['product_option_values', 'product_colors', 'product_variants', 'product_option_fulfillment', 'product_option_transports']) {
    parts.push(raw.prepare(`SELECT * FROM ${t} WHERE product_id = ? ORDER BY id`).all(CAT.id));
  }
  return JSON.stringify(parts.map((rows) => (rows as object[]).map((r) => ({ ...r }))), (k, v) => (k === 'updated_at' ? undefined : v));
}
