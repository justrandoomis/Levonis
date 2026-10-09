/**
 * ROUTE CLASSIFICATION — «التسعير والشحن», the owner's pricing workspace
 * (pricing engine MVP P1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * Every route is COST: today's price next to the old landed cost, the minimum
 * profit and the Direct Sale Extra derived from them, the rate reference and the
 * what-if's replacement cost. The router's door — requireAdmin, the rate
 * limit, then `requireCostRead` on `use('*')` above the first route
 * (tests/costPredicateUsage.test.ts) — refuses every caller but the verified
 * owner before an id is read.
 *
 * The what-if is a POST only because it carries a body; it writes nothing
 * (tests/pricingPreviewNoWrite.test.ts), so it is a cost READ.
 *
 * FX-1 adds the central rates (FX programme plan §8): two cost reads and six
 * cost writes, behind the same door, each write with `assertCostWrite`.
 */
import type { RouteClassFile } from './_types';
import { adminPricingRoutes } from '../../worker/routes/adminPricing';

export default {
  family: 'pricing',
  mounts: [
    {
      prefix: '/api/admin/pricing',
      name: 'adminPricingRoutes',
      router: adminPricingRoutes,
      routes: {
        'GET /overview': 'cost_read',
        'GET /products/:id': 'cost_read',
        'POST /products/:id/what-if': {
          cls: 'cost_read',
          body: { supplier_cost: '100.5', currency: 'EUR' },
          why: 'a calculator: it prices in memory and writes nothing; POST only for its body',
        },
        // FX-1 (FX programme plan §8, §14.1(1)): the central exchange and
        // shipping rates. `:pair` and `:profile` are not product ids, so each
        // route names its real path (PARAM fills them with a product id).
        'GET /rates': {
          cls: 'cost_read',
          why: 'the three exchange-rate pairs, the derived IQD rates and the central shipping rates — every figure private',
        },
        'GET /rates/history': { cls: 'cost_read', why: 'the private exchange-rate history (fx_rate_log): before, after, held values' },
        // A body factory reads as the SAME caller: a refused caller reads no
        // pair, and sends version 1 (which the door refuses first anyway).
        'PUT /rates/fx/:pair/settings': {
          cls: 'cost_write',
          path: '/api/admin/pricing/rates/fx/USD_IQD/settings',
          body: async (read: (path: string) => Promise<Record<string, unknown>>) => ({
            owner_version: ((await read('/api/admin/pricing/rates')).pairs as Array<{ owner_version: number }> | undefined)?.[0]?.owner_version ?? 1,
            interval_hours: 12,
          }),
          why: 'the guard settings, mode, interval and adjustment of one pair (a fresh sign-in for any guard field)',
        },
        'PUT /rates/fx/:pair/manual': {
          cls: 'cost_write',
          path: '/api/admin/pricing/rates/fx/USD_IQD/manual',
          body: async (read: (path: string) => Promise<Record<string, unknown>>) => ({
            owner_version: ((await read('/api/admin/pricing/rates')).pairs as Array<{ owner_version: number }> | undefined)?.[0]?.owner_version ?? 1,
            rate: '1650',
          }),
          why: 'a manual exchange rate: moves the effective rate and the derived IQD rates, never a product price in FX-1',
        },
        'POST /rates/fx/:pair/confirm': {
          cls: 'cost_write',
          path: '/api/admin/pricing/rates/fx/USD_IQD/confirm',
          why: '«تأكيد السعر الحالي»: moves the drift anchor; the seeded database has no effective rate to confirm (409 FX_RATE_NOT_SET)',
        },
        'POST /rates/fx/refresh': {
          cls: 'cost_write',
          body: { pairs: ['USD_IQD'] },
          why: 'a provider check now; with no key configured USD/IQD is NOT_CONFIGURED and no request is made',
        },
        'POST /rates/fx/:pair/review': {
          cls: 'cost_write',
          path: '/api/admin/pricing/rates/fx/USD_IQD/review',
          why: 'approve, reject or keep as manual a held rate; the seeded database holds none (409 FX_REVIEW_NOT_PENDING)',
        },
        'PUT /rates/shipping/:profile': {
          cls: 'cost_write',
          path: '/api/admin/pricing/rates/shipping/GERMANY_LAND',
          body: { version: 1, rate_iqd: '12000' },
          why: 'a central shipping rate in IQD per kg or per CBM',
        },
        // The Inputs stage (USD design §3-§6.3; the owner's request of 2026-10-09:
        // pricing and shipping entered in the product form). Inputs and rules only —
        // never a price; each write with assertCostWrite.
        'POST /procurement/preview': {
          cls: 'cost_read',
          why: 'the procurement card’s 4-cell summary, «تفاصيل» and the review preview: prices in memory, writes nothing; POST only for its body',
        },
        'POST /products/:id/apply-purchase': {
          cls: 'cost_write',
          why: 'a confirmed purchase → the product’s current costs and typed minimum profits (pricing_inputs, pricing_rules); never a price',
        },
        'GET /products/:id/rules': { cls: 'cost_read', why: 'the product’s stored minimum profit (USD) and Direct Sale Extra' },
        'PUT /products/:id/rules': {
          cls: 'cost_write',
          body: { rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '100' }] },
          why: 'the minimum profit in USD and the Direct Sale Extra per product / option',
        },
        'GET /products/:id/inputs': { cls: 'cost_read', why: 'the product form’s «التسعير بالدولار»: inputs and rules per scope, each model’s bar' },
        'POST /products/:id/preview': {
          cls: 'cost_read',
          body: { draft: { rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '100' }] } },
          why: 'the product form’s live preview of a draft: prices in memory, writes nothing; POST only for its body',
        },
        'PUT /products/:id/inputs': {
          cls: 'cost_write',
          body: { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '100' }] },
          why: 'the product form’s save: supplier cost, route, weight or CBM, extras and the two rules, one fenced batch; never a price',
        },
        'POST /products/:id/targets/adopt': {
          cls: 'cost_write',
          why: '«قبول القيم المرحّلة»: the values the old prices carry, stored as migrated rules (fenced on legacy_hash)',
        },
        // The writer stage (owner decision 8; USD design §6.1-§6.5): the stale list, its preview, the
        // bulk save of previewed prices and the way back to manual — behind the same door, each write
        // with assertCostWrite.
        'GET /save-list': {
          cls: 'cost_read',
          why: 'engine products whose stored price was computed at a rate that moved, and complete-but-manual products (the counts the pricing page and the rates panel show)',
        },
        'POST /save-list/preview': {
          cls: 'cost_read',
          body: { product_ids: ['p_a1'] },
          why: 'each listed product’s six figures and preview hash: prices in memory, writes nothing; POST only for its body',
        },
        'POST /products/save-bulk': {
          cls: 'cost_write',
          why: 'writes the previewed engine prices of up to 20 products, each its own fenced batch carrying its preview hash',
        },
        'POST /products/:id/manual': {
          cls: 'cost_write',
          why: '«رجوع إلى التسعير اليدوي»: the product leaves the engine (fenced on write_seq); every price stays as written',
        },
      },
    },
  ],
} satisfies RouteClassFile;
