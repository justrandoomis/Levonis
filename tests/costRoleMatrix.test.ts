/**
 * THE ROLE MATRIX: every GET route a non-financial caller can reach, swept for
 * cost.
 *
 * tests/costLeaksPhase0.test.ts pins the leaks the audit found, one by one.
 * This file is the net for the ones nobody has found yet: it mounts every
 * product-, cart-, order-, inventory-, procurement-, pricing- and
 * finance-facing router the way worker/index.ts does, enumerates each one's
 * GET routes from Hono itself (so a route added tomorrow is swept tomorrow),
 * fills the path parameters with the seeded product's ids, and calls each as
 * a guest, a customer, a merchant and an assistant admin.
 *
 * Any 2xx answer is walked to its last leaf. It fails on a key naming cost
 * that carries a number, and on ANY value — number, or digits inside a string
 * such as an exported .txt or .csv — equal to one of the seeded costs. A
 * refusal (401/403/404/400) is a pass: what is not served cannot leak.
 *
 * The financial admin is swept too, but in the opposite direction: at least
 * one route must show it a seeded cost, or the fixture is not reaching the
 * places this file claims to search.
 *
 * Run: node --import tsx --test tests/costRoleMatrix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { asD1, freshDb, stubApp, type StubUser } from './fixtures/app';
import { leaks, seedCostlyProduct, seedCostlyStock } from './fixtures/costlyProduct';
import type { AppContext } from '../worker/lib/types';

import { productRoutes, homeRoutes } from '../worker/routes/products';
import { bundlesRoutes, adminCompositionAnalyticsRoutes } from '../worker/routes/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { quickBuyRoutes, quickBuyAdminRoutes } from '../worker/routes/quickBuy';
import { compareRoutes } from '../worker/routes/compare';
import { catalogRoutes } from '../worker/routes/catalog';
import { printerFinderRoutes } from '../worker/routes/printerFinder';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { miscRoutes } from '../worker/routes/misc';
import { giftRoutes } from '../worker/routes/gifts';
import { adminTradeInRoutes, tradeInRoutes } from '../worker/routes/tradeIn';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { adminRoutes } from '../worker/routes/admin';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { adminOffersRoutes } from '../worker/routes/offers';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { templateRoutes } from '../worker/routes/template';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceReportRoutes } from '../worker/routes/adminFinanceReport';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { farmAdminRoutes } from '../worker/routes/farmAdmin';
import { adminPrintQuoteRoutes, printQuoteRoutes } from '../worker/routes/printQuote';
import { adminPriceReportRoutes, priceReportRoutes } from '../worker/routes/priceReports';
import { warrantyAdminRoutes, warrantyPublicRoutes } from '../worker/routes/warranty';

type Router = Hono<AppContext>;

/** Mounted as worker/index.ts mounts them — same prefixes, same order where it matters. */
const MOUNTS: Array<[string, Router]> = [
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
  ['/api/compare', compareRoutes as Router],
  ['/api/catalog', catalogRoutes as Router],
  ['/api/printer-finder', printerFinderRoutes as Router],
  ['/api/public/v1', publicApiRoutes as Router],
  ['/api', miscRoutes as Router],
  ['/api/admin', adminRoutes as Router],
  ['/api/admin/quick-buy', quickBuyAdminRoutes as Router],
  ['/api/admin/products-v2', adminProductsRoutes as Router],
  ['/api/admin/template', templateRoutes as Router],
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
  ['/api/admin/import', adminImportRoutes as Router],
  ['/api/admin/products', adminProductRelationsRoutes as Router],
  ['/api/admin/products', adminPriceGridRoutes as Router],
  ['/api/admin/finance', adminFinanceRoutes as Router],
  ['/api/admin/finance/report', adminFinanceReportRoutes as Router],
  ['/api/gifts', giftRoutes as Router],
  ['/api/returns', returnRoutes as Router],
  ['/api/price-protection', priceProtectionRoutes as Router],
  ['/api/admin/farm', farmAdminRoutes as Router],
  ['/api/print-quote', printQuoteRoutes as Router],
  ['/api/admin/print-quote', adminPrintQuoteRoutes as Router],
  ['/api/price-reports', priceReportRoutes as Router],
  ['/api/admin/price-reports', adminPriceReportRoutes as Router],
  ['/api/warranty', warrantyPublicRoutes as Router],
  ['/api/admin/warranties', warrantyAdminRoutes as Router],
];

/**
 * Answers that name cost but carry none of the shop's private cost. Each says
 * why; a new one needs the same justification, not a shrug. Matched on the
 * route AND the key path, so the same key anywhere else still fails.
 */
const NOT_A_COST: Array<{ path: RegExp; leak: RegExp; why: string }> = [
  {
    path: /^\/api\/finance-earnings$/,
    leak: /\.pending_costs = /,
    why: 'a COUNT of the caller’s own wage rows still waiting for an amount — how many, never how much',
  },
  {
    path: /^\/api\/(print-quote\/accessories|admin\/settings)$/,
    leak: /\.(accessories|printAccessories)\[\d+\]\.cost_iqd = /,
    why: 'the per-piece accessory price a print quote bills — published by design (worker/routes/printQuote.ts)',
  },
  {
    path: /^\/api\/admin\/(farm\/config|settings)$/,
    leak: /\.economy\.(maintenance|repair)\.cost = /,
    why: 'in-game coins of the printer-farm game (worker/lib/farm/config.ts), not dinars',
  },
];

/** Every seeded id a path parameter can name. Unknown names get the product id. */
const PARAM: Record<string, string> = {
  slug: 'a1',
  productId: 'p_a1',
  product_id: 'p_a1',
  id: 'p_a1',
  optionId: 'v_a1',
  colorId: 'c_blk',
  lotId: 'lot1',
  incomingId: 'inc1',
};

function concrete(prefix: string, path: string): string[] {
  if (path.includes('*')) return [];
  const filled = path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) => PARAM[name] ?? 'p_a1');
  const full = `${prefix}${filled === '/' ? '' : filled}` || '/';
  // `:id` is a product on most routers and a lot or a purchase on the stock
  // ones; try both so neither reading is skipped.
  const alts = new Set([full]);
  if (/inventory|stock-operations|procurement|investment-finance/.test(prefix) && path.includes(':id')) {
    alts.add(`${prefix}${path.replace(/:id(\{[^}]*\})?/g, 'lot1').replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, 'p_a1')}`);
    alts.add(`${prefix}${path.replace(/:id(\{[^}]*\})?/g, 'inc1').replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, 'p_a1')}`);
  }
  return [...alts];
}

function getPaths(): string[] {
  const out = new Set<string>();
  for (const [prefix, router] of MOUNTS) {
    for (const r of router.routes) {
      if (r.method !== 'GET') continue;
      for (const p of concrete(prefix, r.path)) out.add(p);
    }
  }
  return [...out].sort();
}

const ROLES: Record<string, StubUser | null> = {
  guest: null,
  customer: { id: 'u1', role: 'customer', email: 's@x.co' },
  merchant: { id: 'u_m', role: 'merchant', email: 'm@x.co' },
  assistant: { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' },
};
const FINANCIAL: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: null };

function appFor(raw: ReturnType<typeof freshDb>, user: StubUser | null) {
  return stubApp(asD1(raw), user, (a) => {
    for (const [prefix, router] of MOUNTS) a.route(prefix, router);
  });
}

async function call(app: ReturnType<typeof appFor>, path: string): Promise<{ status: number; body: unknown }> {
  const timeout = new Promise<{ status: number; body: unknown }>((resolve) =>
    setTimeout(() => resolve({ status: 599, body: null }), 8000)
  );
  const run = (async () => {
    const res = await app.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let body: unknown = text;
    if (type.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the text */
      }
    }
    return { status: res.status, body };
  })();
  return Promise.race([run, timeout]);
}

function seeded() {
  const raw = freshDb();
  seedCostlyProduct(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
    ('u_m','Merchant','m@x.co','h','merchant'),
    ('usr_asst','Asst','asst@x.co','h','admin'),
    ('usr_owner','Owner','boss@x.co','h','admin')`);
  raw.prepare("UPDATE users SET admin_scope = 'assistant' WHERE id = 'usr_asst'").run();
  seedCostlyStock(raw);
  return raw;
}

const PATHS = getPaths();

test('the sweep reaches a real number of routes (or it proves nothing)', () => {
  assert.ok(PATHS.length > 150, `only ${PATHS.length} GET paths were enumerated`);
});

for (const [role, user] of Object.entries(ROLES)) {
  test(`no GET answer to a ${role} carries a cost (${PATHS.length} paths)`, async () => {
    const raw = seeded();
    const app = appFor(raw, user);
    const found: string[] = [];
    let answered = 0;
    for (const path of PATHS) {
      const { status, body } = await call(app, path);
      if (status < 200 || status >= 300) continue;
      answered += 1;
      for (const l of leaks(body)) {
        if (NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l))) continue;
        found.push(`${path}  ${l}`);
      }
    }
    assert.ok(answered > 10, `only ${answered} routes answered a ${role} — the sweep is not reaching anything`);
    assert.deepEqual(found, [], `cost reached a ${role}:\n${found.join('\n')}`);
  });
}

test('the financial admin does see the seeded costs somewhere (the fixture reaches the places swept)', async () => {
  const raw = seeded();
  const app = appFor(raw, FINANCIAL);
  const seen: string[] = [];
  for (const path of PATHS) {
    const { status, body } = await call(app, path);
    if (status >= 200 && status < 300 && leaks(body).length) seen.push(path);
  }
  assert.ok(seen.length >= 3, `the owner saw cost on only ${seen.length} routes: ${seen.join(', ')}`);
});
