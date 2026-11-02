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
 * cost writes, behind the same door, each write with `assertCostWrite`. FX-5
 * adds the three previews before an owner rate act (cost reads).
 *
 * «التسعير التقديري» (docs/SMART_PRICING.md §3.4–§3.9, §4.8–§4.9; migration
 * 0218; DECISIONS rows 278–282) mounts two owner routers INSIDE this one —
 * `/supplier-prices` (worker/routes/adminSupplierPrices.ts) and `/estimates`
 * (worker/routes/adminPriceEstimates.ts) — so Hono lists their routes here, on
 * adminPricingRoutes, and the door above refuses every caller but the owner
 * before either router runs (each also keeps its own requireCostRead, and every
 * write its assertCostWrite). Every supplier price, match, typed price, type
 * figure, flag and replacement cost they read or write is the owner's alone
 * (invariant I6), so every one of their routes is COST: the reads cost_read,
 * the writes cost_write. A compute is a write: it stores the owner-only
 * preview (`price_estimate_lines`), though it writes no V2 table.
 */
import type { RouteClassFile } from './_types';
import { adminPricingRoutes } from '../../worker/routes/adminPricing';

/** The costly product's one sellable SKU (tests/fixtures/costlyProduct.ts: model v_a1 in black). */
const RM_SKU = 'o:v_a1|c:c_blk';

type Read = (path: string) => Promise<Record<string, unknown>>;

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
        // FX-6 (FX programme plan §8, §9 §16-§19): the owner's batch read model —
        // each batch's fixed IQD cost and its purchase-time rates.
        'GET /batches': {
          cls: 'cost_read',
          path: '/api/admin/pricing/batches?product_id=p_a1',
          why: 'what each batch actually cost in IQD and the exchange rates it was bought at (the 0182 snapshot) — every figure private',
        },
        'POST /products/:id/what-if': {
          cls: 'cost_read',
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
          why: 'the guard settings, mode, interval and adjustment of one pair (a guard field rings the guard bell; no fresh sign-in, DECISIONS row 285)',
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
        // FX-5 (FX programme plan §7.8, §8): the preview before an owner rate act —
        // each affected engine product's price before → after, the deficit and the
        // preview hash the act must carry. Priced in memory, nothing written; POST
        // only for its body.
        'POST /rates/fx/:pair/review/preview': {
          cls: 'cost_read',
          path: '/api/admin/pricing/rates/fx/USD_IQD/review/preview',
          why: 'what approving the held rate would reprice; the seeded database holds none (409 FX_REVIEW_NOT_PENDING)',
        },
        'POST /rates/fx/:pair/manual/preview': {
          cls: 'cost_read',
          path: '/api/admin/pricing/rates/fx/USD_IQD/manual/preview',
          body: { rate: '1650' },
          why: 'what a manual rate (or the adjustment) would reprice: old → new per model × channel and the deficits',
        },
        'POST /rates/shipping/:profile/preview': {
          cls: 'cost_read',
          path: '/api/admin/pricing/rates/shipping/GERMANY_LAND/preview',
          body: { rate_iqd: '12000' },
          why: 'what a central shipping rate would reprice on that route',
        },
        // THE CLEAN START (addendum A.6, DECISIONS row 222): every V1 door below — the product sheet, the
        // what-if, apply-purchase, rules, inputs, preview, the stale list, save-bulk, manual and adopt —
        // answers 409 PRICING_V2_MANAGED {section} to the owner, so none names a body any more; each keeps
        // its class (the door still refuses everyone else first).
        // The Inputs stage (USD design §3-§6.3; the owner's request of 2026-10-09:
        // pricing and shipping entered in the product form). Inputs and rules only —
        // never a price; each write with assertCostWrite.
        'POST /procurement/preview': {
          cls: 'cost_read',
          why: 'the procurement card’s 4-cell summary, «تفاصيل» and the review preview: prices in memory, writes nothing; POST only for its body',
        },
        'POST /procurement/line-pricing': {
          cls: 'cost_read',
          why: 'the owner’s inline final cost and minimum profit preview prepares a V2 draft in memory; writes nothing and uses POST only for its body',
        },
        'POST /products/:id/apply-purchase': {
          cls: 'cost_write',
          why: 'a confirmed purchase → the product’s current costs and typed minimum profits (pricing_inputs, pricing_rules); never a price',
        },
        'GET /products/:id/rules': { cls: 'cost_read', why: 'the product’s stored minimum profit (USD) and Direct Sale Extra' },
        'PUT /products/:id/rules': {
          cls: 'cost_write',
          why: 'the minimum profit in USD and the Direct Sale Extra per product / option',
        },
        'GET /products/:id/inputs': { cls: 'cost_read', why: 'the product form’s «التسعير بالدولار»: inputs and rules per scope, each model’s bar' },
        'POST /products/:id/preview': {
          cls: 'cost_read',
          why: 'the product form’s live preview of a draft: prices in memory, writes nothing; POST only for its body',
        },
        'PUT /products/:id/inputs': {
          cls: 'cost_write',
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
        // «أسعار المورّد» — the supplier price catalogue (§3.4–§3.9, worker/routes/adminSupplierPrices.ts).
        'GET /supplier-prices/snapshots': {
          cls: 'cost_read',
          why: 'every supplier price snapshot: source, capture date, state, item and SKU counts, matched and unmatched counts, age',
        },
        'POST /supplier-prices/snapshots': {
          cls: 'cost_write',
          body: {
            source: 'bambu_eu',
            currency: 'EUR',
            price_basis: 'list',
            capture: 'browser_sweep',
            captured_on: '2026-10-31',
            captured_by: 'browser sweep',
            file_sha256: '5f'.repeat(32),
            item_count: 1,
          },
          why: 'a new snapshot of supplier prices in state loading (the file’s header, its SHA-256 and its item count)',
        },
        // `:id` is a snapshot: a well-formed id the seeded database does not hold (404 for the owner).
        'POST /supplier-prices/snapshots/:id/items': {
          cls: 'cost_write',
          path: '/api/admin/pricing/supplier-prices/snapshots/sps_rm_no_such_snapshot/items',
          why: 'one chunk (≤ 50 items, ≤ 256 KB) of supplier prices, their SKUs and match keys, through the strict parser',
        },
        'POST /supplier-prices/snapshots/:id/complete': {
          cls: 'cost_write',
          path: '/api/admin/pricing/supplier-prices/snapshots/sps_rm_no_such_snapshot/complete',
          why: 'checks the counts and the hash, marks the snapshot complete and supersedes the source’s previous one',
        },
        'POST /supplier-prices/snapshots/:id/discard': {
          cls: 'cost_write',
          path: '/api/admin/pricing/supplier-prices/snapshots/sps_rm_no_such_snapshot/discard',
          why: 'deletes a snapshot’s supplier prices; superseded snapshots beyond three per source are pruned',
        },
        'POST /supplier-prices/match': {
          cls: 'cost_write',
          body: { product_ids: ['p_a1'] },
          why: 'one page of products matched against the catalogue: suggestions and automatic confirmations written, vanished combo keys pruned',
        },
        'GET /supplier-prices/matches': {
          cls: 'cost_read',
          why: 'the review grid: each product’s SKUs beside the candidate supplier items, their prices, price labels, confidence and reasons',
        },
        'PUT /supplier-prices/matches/:product_id': {
          cls: 'cost_write',
          why: 'confirms, re-points or rejects a product’s supplier matches (version-fenced); only here may the owner divide a pack price',
        },
        'PUT /supplier-prices/manual/:product_id': {
          cls: 'cost_write',
          // The panel’s round trip: the manual token the owner read on the links read, sent back with his price.
          body: async (read: Read) => ({
            version: ((await read('/api/admin/pricing/supplier-prices/links/p_a1')).versions as { manual?: string } | undefined)?.manual ?? '0.0.',
            skus: [{ combo_key: RM_SKU, amount: '1599', currency: 'EUR', note: '' }],
          }),
          why: 'the owner’s typed supplier price per SKU (USD, EUR or CNY), version-fenced on the token he read',
        },
        'GET /supplier-prices/lookup': {
          cls: 'cost_read',
          path: '/api/admin/pricing/supplier-prices/lookup?q=A1',
          why: 'searches the complete snapshots by URL, id, handle, code or words: ≤ 50 supplier items with their SKUs and prices',
        },
        'POST /supplier-prices/read-store-page': {
          cls: 'cost_write',
          why: 'one owner-initiated read of one EU or US store page (no network in the sweep: the empty body is refused before any fetch), optionally saved as his price',
        },
        'GET /supplier-prices/links': {
          cls: 'cost_read',
          why: '«روابط المورّد»: every linked product’s supplier ids, links, captured prices and the owner’s own prices, 25 a page',
        },
        'GET /supplier-prices/links/:product_id': {
          cls: 'cost_read',
          why: 'one product’s supplier ids, links, captured prices and the owner’s own prices (the product form’s banner reads it)',
        },
        // «التسعير التقديري» — the estimator (§4, §7, worker/routes/adminPriceEstimates.ts).
        'GET /estimates/control': { cls: 'cost_read', why: 'the owner’s two switches (apply, ordering) and whether the purchase policy carries the estimate clause' },
        'PUT /estimates/control': {
          cls: 'cost_write',
          body: async (read: Read) => ({
            version: ((await read('/api/admin/pricing/estimates/control')).control as { version?: number } | undefined)?.version ?? 1,
            ordering_enabled: true,
          }),
          why: 'the two switches, version-fenced (no fresh sign-in, DECISIONS row 285); «apply» is refused until the purchase policy carries the clause',
        },
        'GET /estimates/types': {
          cls: 'cost_read',
          why: 'every product type with its owner figures: route, default weight and box or CBM, extra cost in IQD, minimum profit in USD',
        },
        'POST /estimates/types': {
          cls: 'cost_write',
          body: {
            key: 'measuring_tool',
            name_ar: 'أدوات القياس',
            name_en: 'Measuring tools',
            name_ckb: 'ئامرازەکانی پێوان',
            sourcing: 'CHINA_CNY',
            route: 'sea',
            allow_air: true,
          },
          why: 'a new type key, every figure empty until the owner types it',
        },
        // `:key` is a type: the seeded `printer` (EU store, by land).
        'PUT /estimates/types/:key': {
          cls: 'cost_write',
          path: '/api/admin/pricing/estimates/types/printer',
          body: async (read: Read) => ({
            version: ((await read('/api/admin/pricing/estimates/types')).types as Array<{ key: string; version: number }> | undefined)?.find((t) => t.key === 'printer')?.version ?? 1,
            stale_after_days: 30,
          }),
          why: 'a type’s figures (route, US reference, default measures, extra cost, minimum profit, staleness), version-fenced and audited in pricing_audit',
        },
        'GET /estimates/types/:key/suggest': {
          cls: 'cost_read',
          path: '/api/admin/pricing/estimates/types/printer/suggest',
          why: 'the median of the real package measures of a type’s products, offered to the owner (nothing saved)',
        },
        'POST /estimates/compute': {
          cls: 'cost_write',
          body: { product_ids: ['p_a1'] },
          why: 'prices each product’s supplier price at the engine’s rates and stores the owner-only preview (R, D, flags, hash); no V2 table is written',
        },
        'POST /estimates/apply': {
          cls: 'cost_write',
          why: 'publishes reviewed estimates: one atomic V2 batch per product (pre-order structure, untracked stock decision, price, label), each bound to its preview hash',
        },
        'GET /estimates/products': { cls: 'cost_read', why: 'the stored previews, 25 a page: supplier amounts, R and D per SKU, the flags' },
        'GET /estimates/products/:id': { cls: 'cost_read', why: 'one product’s stored preview: supplier amounts, R and D per SKU, the flags (404 when none is stored)' },
        'PUT /estimates/products/:id': {
          cls: 'cost_write',
          why: 'a product’s estimate settings: pause or resume, the type and the sourcing or route override (version-fenced)',
        },
        'POST /estimates/products/:id/confirm': {
          cls: 'cost_write',
          why: 'removes the estimate label (the whole product, or firm SKUs); refused while a type-default measure prices a SKU',
        },
      },
    },
  ],
} satisfies RouteClassFile;
