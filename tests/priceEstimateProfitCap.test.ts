/**
 * THE PROFIT CEILING, END TO END ON A REAL DATABASE (owner decisions 2026-11-05, DECISIONS row 291;
 * docs/SMART_PRICING.md §4.11; migration 0222; packages/pricing/src/charmPrice.ts).
 *
 * The owner: «dont make 25% on all product . it called the smart pricing so priced from 0% to 25% or 30 or 35 or
 * even 50 and 100», «we want cheap price so we need to become cheapest iraqi supplier», «still nor cheapest enough .
 * more cheaper» — ceilings of 3–10% per type — and «make the price for product be like that 9.99$ , 19.99$ 24.99$
 * and ect …»; a dollar costs him 1,600 IQD («1,600 is my real cost now»). On the pricing world at that rate
 * (U = 1,600; CNY 0.15 USD = 240 IQD; EUR 1.11 USD = 1,776 IQD; China sea 400,000 IQD/m³, Germany land 3,200 IQD/kg),
 * through the owner's real routes:
 *
 *   - THE NOZZLE WIPING PLATE: a spare part at 15 CNY in a 119 × 50 × 25 mm box, R = 3,600 + 59.5 = 3,659.5 IQD; at
 *     the type's $6 it sells at 13,500. Under a 10% ceiling, under $5: the house price 4,000 IQD (its route floor
 *     exactly), $2.50 — «التحديث» lists the drop as large, an apply without the tick is refused
 *     (PRICING_LARGE_CHANGE_CONFIRM) and writes nothing, with it the product rule $0.212812 is written, the published
 *     dollar price is $2.50 and the record says so; compute and apply agree on the hash over the two evaluations; a
 *     later FX-5 run moves the price and never the rule;
 *   - FROM $5 UP THE CHARM PRICE: THE FLUSH CUTTER (an accessory at $4.50, 25,750 → $11.99, 19,250 at 10%), AN AMS
 *     ($45 at 4%: 530,250 → $294.99, 472,000) and A PRINTER ($135 at 3%: 3,145,000 → $1,879.99, 3,008,000), every
 *     published dollar price on the grid; no ceiling (or an emptied one) is today's estimate byte for byte;
 *   - TODAY'S DINAR PRICE SHOWS c (the lead's ruling for the owner, 2026-11-05): a SKU whose charm price's dinar price
 *     IS today's sells there at c's own profit — 105,750 at $65.99, not $66.09 — no line moves, so «التحديث» does not
 *     list it, and its fresh hash applies through POST /apply; one whose dollar figure already is c keeps T, the same
 *     hash, lines and record. THE HARDENED-STEEL COMBO as it sold on the live day (an accessory at $4.50 and 10%, a 57.98
 *     EUR store page, the type's default box, one pre-order SKU by sea): 110,500 at $69.04 → 110,500 at $68.99, stored
 *     usd_ceil6 68.99, the storefront card 6,899 cents; the soccerbot (nothing goes up: 162,500 at $101.44) and a twin
 *     the owner prices himself exactly as they were. Its two limits: PAST 19 SKUS TODAY'S PLAN STANDS, compute after
 *     compute (62 SKUs at today's dinar price keep T and their hash; one colour's supplier price moves: 117,000 at $72.99
 *     on rules of its own, not a shared 117,750; a re-compute with nothing changed, a new rate, an emptied ceiling, never
 *     blocked; 19 colours show c, 20 keep T); and FX-5 KEEPS c'S PROFIT IN DOLLARS: between applies such a SKU can sell a
 *     250 IQD step from where T would, above or under (106,250 where T sells 106,000 at 1,607; 109,000 where T sells
 *     109,250 at 1,650), its dollar figure still c, until the next compute and apply price it as today's code;
 *   - THE OWNER'S OWN PRICES WIN: a product whose every model carries the owner's option rule keeps its rules and
 *     prices; on a product where he priced one model only, the other models are priced on ONE option group and his
 *     rule is never touched (no tie, no override);
 *   - COLOUR AND SKU RULES travel the form's own parser (`parseRuleWrites`) and are written;
 *   - 0% IS THE FLOOR, NEVER BELOW IT: a part just above 1,000 IQD sells at 1,500 (the lowest house price that keeps
 *     one rounding step over its cost), a part under 1,000 IQD at its cost plus a dinar; nothing is blocked, the type
 *     carries no warning;
 *   - LEFT ALONE: a paused and a confirmed product are untouched; an apply still makes every firm SKU an estimate
 *     again (pinned — the live run skips those products);
 *   - NEVER STUCK ON ITS OWN RULE: a SKU priced under 1,000 IQD whose supplier price then moves its cost past 1,000
 *     IQD is read at T by the first evaluation and priced again by the next compute, never blocked by its stale rule;
 *   - THE MARGIN UNDER FX-5: every ceiling price keeps one rounding step over its cost, so a rate move after the apply
 *     — the CNY rate alone, the dollar to 1,700, the yuan up 2% — never closes a route: FX-5 follows the cost, none
 *     sells at or under its new cost, and only its own 15% guard holds a move — one 250 IQD step on the cheapest
 *     price, 1,500 — for the owner; his next compute and apply put the prices back under the ceiling;
 *   - THE OWNER'S OWN: his cost-first colour difference stays on top of the ceiling's price (gold +$1.30: 6,000
 *     beside red's 4,000, both under $5); a model at his own fixed dollar price keeps T and his price;
 *   - THE 62-SKU FILAMENT (31 colours × spool / refill, the cost by colour, the box by model): no exact
 *     representation fits the wire, so its colours carry the dearer profit of their two SKUs (EST_CEILING_SHARED,
 *     information) — priced and applied, never blocked, never above today's rule;
 *   - THE OWNER'S PRODUCT RULE after a ceiling apply: the next compute takes the ceiling's colour rules back to
 *     inherit, so his $8 decides every colour as before — a reviewed rise, applied only with the tick;
 *   - THE ROLLBACK: the ceiling emptied, its rules go back to inherit and T to the product (an owner-priced product
 *     to his own rule); the record keeps nothing of the ceiling; the rises need the tick.
 *
 * Run: node --import tsx --test tests/priceEstimateProfitCap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { charmTargetBefore } from './fixtures/charmBeforeRuling';
import { applyRate, fxEnv } from './fixtures/fx';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { productRoutes } from '../worker/routes/products';
import { repriceStaleEngineProducts } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import { LOWEST_USED_CHARM_CENTS, isCharmCents } from '../packages/pricing/src/charmPrice';
import { roundPriceIqd } from '../packages/pricing/src/priceRounding';
import { skuComboKey } from '../packages/pricing/src/skuChannel';
import { usdCeilCentsOf } from '../packages/pricing/src/usdCents';
import { addProcurementExact, mulProcurementExact, procurementExact, procurementExactText } from '../packages/contracts/src/procurementCost';
import type { Env } from '../worker/lib/types';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const mount = (raw: DatabaseSync) =>
  stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );
type App = ReturnType<typeof mount>;
/** The public storefront, a guest, as levonis-iq.com/api/products answers it. */
const storefront = (raw: DatabaseSync) => stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes), { publishV2: false });

/** The pricing world at the owner's rate, his type figures (no ceiling yet), a current Tmall capture, «apply» on. */
function world() {
  const w = pricingWorld();
  // The pricing world already prices at U = 1,600 — the owner's rate since 2026-11-05 (re-applying the same rate
  // would break the FX version discipline).
  assert.equal(row<{ r: string }>(w.raw, "SELECT effective_rate AS r FROM fx_rate_pairs WHERE pair = 'USD_IQD'")!.r, '1600');
  applyRate(w.raw, 'CNY_USD', '0.15');
  applyRate(w.raw, 'EUR_USD', '1.11');
  w.raw.exec(`
    UPDATE price_estimate_types SET min_profit_usd = '6' WHERE key = 'spare_part';
    UPDATE price_estimate_types SET min_profit_usd = '4.5', additional_cost_iqd = 220 WHERE key = 'accessory';
    UPDATE price_estimate_types SET min_profit_usd = '45' WHERE key = 'ams';
    UPDATE price_estimate_types SET min_profit_usd = '135', additional_cost_iqd = 25000 WHERE key = 'printer';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
  `);
  return { ...w, app: mount(w.raw) };
}

/**
 * A product as the Bambu import leaves one (direct sale only, no stock, no price), its type the owner's, its package
 * real — or none (`noPackage`: the type's default box and weight decide, EST_DEFAULT_BOX / EST_DEFAULT_WEIGHT).
 */
function seedProduct(
  raw: DatabaseSync,
  id: string,
  type: string,
  o: { models?: string[]; colours?: string[]; variants?: string[]; weight?: number; box?: [number, number, number]; noPackage?: boolean; slug?: string } = {}
): void {
  const box = o.box ?? [119, 50, 25];
  const mode = o.variants ? 'VARIANT_COMBINATION' : o.colours?.length ? 'COLOR' : 'BASE';
  const measures = o.noPackage ? 'NULL, NULL, NULL, NULL' : `${q(o.weight ?? 50)}, ${box[0]}, ${box[1]}, ${box[2]}`;
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES (${q(id)}, ${q(o.slug ?? `slug-${id}`)}, ${q(`Product ${id}`)}, 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', ${q(mode)},
            ${measures});
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', ${q(`sp_${id}`)}, ${q(id)}, ${q(`h-${id}`)}, ${q(`https://us.store.bambulab.com/products/h-${id}`)}, 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES (${q(id)}, ${q(type)}, 'owner', ${q(NOW)});
  `);
  if (o.models?.length) {
    raw.exec(`INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${q(`${id}_g`)}, ${q(id)}, 'Model', 0, 1)`);
    o.models.forEach((m, i) =>
      raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES (${q(`${id}_${m}`)}, ${q(id)}, ${q(`${id}_g`)}, ${q(m)}, 'موديل', 'مۆدێل', ${i}, 1)`)
    );
  }
  (o.colours ?? []).forEach((c, i) =>
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES (${q(`${id}_${c}`)}, ${q(id)}, ${q(c)}, 'لون', 'ڕەنگ', '#336699', ${i}, 1, NULL)`)
  );
  (o.variants ?? []).forEach((combo, i) => raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`${id}_v${i}`)}, ${q(id)}, ${q(combo)}, 1)`));
}

let skuSeq = 0;
/** A Tmall offer the owner confirmed for one SKU, in the current capture; answers its item key. */
function tmall(raw: DatabaseSync, pid: string, combo: string, price: string): string {
  const item = `9${String(++skuSeq).padStart(12, '0')}`;
  raw.exec(`
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', ${q(item)}, 'item', 'spare_part');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', ${q(item)}, ${q(`${item}1`)}, ${q(price)});
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES (${q(pid)}, ${q(combo)}, 'tmall_cn', ${q(item)}, ${q(`${item}1`)}, 'exact', 'owner', 'confirmed', 'usr_owner', ${q(NOW)}, 'sps_tmall', ${q(NOW)});
  `);
  return item;
}

const typed = (raw: DatabaseSync, pid: string, combo: string, amount: string, currency: string) =>
  raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
            VALUES (${q(pid)}, ${q(combo)}, ${q(amount)}, ${q(currency)}, 'typed', 'usr_owner', ${q(NOW)})`);
/** A store page the owner read for one SKU (EST_STORE_PAGE_PRICE), its evidence named. */
const storePage = (raw: DatabaseSync, pid: string, combo: string, amount: string, currency: string) =>
  raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, evidence_url, evidence_host, entered_by, entered_at)
            VALUES (${q(pid)}, ${q(combo)}, ${q(amount)}, ${q(currency)}, 'store_page', 'https://eu.store.bambulab.com/products/x', 'eu.store.bambulab.com', 'usr_owner', ${q(NOW)})`);

async function call(app: App, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const res = method === 'GET' ? await get(app, path) : method === 'POST' ? await post(app, path, body ?? {}) : await put(app, path, body ?? {});
  return { status: res.status, body: (await json(res)) as Json };
}

async function compute(app: App, ids: string[]): Promise<Map<string, Json>> {
  const r = await call(app, 'POST', `${BASE}/compute`, { product_ids: ids });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return new Map((r.body.products as Json[]).map((p) => [p.product_id as string, p] as const));
}

async function apply(app: App, items: Json[]): Promise<Map<string, Json>> {
  const r = await call(app, 'POST', `${BASE}/apply`, { items });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return new Map((r.body.results as Json[]).map((x) => [x.product_id as string, x] as const));
}

/** Compute, then apply each product on its own reviewed hash (the tick given), asserting every one applies. */
async function computeAndApply(app: App, ids: string[], confirm = false): Promise<Map<string, Json>> {
  const previews = await compute(app, ids);
  for (let i = 0; i < ids.length; i += 5) {
    const items = ids.slice(i, i + 5).map((id) => ({ product_id: id, preview_hash: previews.get(id)!.preview_hash, ...(confirm ? { confirm_large_change: true } : {}) }));
    const out = await apply(app, items);
    for (const id of ids.slice(i, i + 5)) assert.equal(out.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(out.get(id)).slice(0, 300)}`);
  }
  return previews;
}

/** The owner sets a type's figures through his own door (version-fenced). */
async function setType(app: App, key: string, body: Json): Promise<Json> {
  const types = (await call(app, 'GET', `${BASE}/types`)).body.types as Json[];
  const r = await call(app, 'PUT', `${BASE}/types/${key}`, { version: types.find((t) => t.key === key)!.version, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return r.body.type;
}

/** The owner's minimum profit on models, saved in the product form (the V2 door, its preview reviewed). */
async function ownerModelProfits(app: App, pid: string, rules: Array<[string, string]>): Promise<void> {
  const stored = await json(await get(app, `/api/admin/products-v2/${pid}/pricing`));
  const pricing = { cost: { minimum_profit: rules.map(([model, usd]) => ({ kind: 'target_profit', scope: 'option', scope_id: `${pid}_${model}`, amount_usd: usd })) } };
  const sheet = await json(await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing, preview_hash: sheet.details.preview.review_hash });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 300));
}

/** The owner's minimum profit on the product itself, saved in the product form (the V2 door, its preview reviewed). */
async function ownerProductProfit(app: App, pid: string, usd: string): Promise<void> {
  const stored = await json(await get(app, `/api/admin/products-v2/${pid}/pricing`));
  const pricing = { cost: { minimum_profit: usd } };
  const sheet = await json(await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing, preview_hash: sheet.details.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 300));
}

const prices = (raw: DatabaseSync, pid: string) =>
  all<{ combo_key: string; final_price_iqd: number }>(raw, 'SELECT combo_key, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key', pid).map((r) => [r.combo_key, r.final_price_iqd]);
/** The published dollar prices (`usd_ceil6`, what the storefront's $ shows), in whole cents. */
const dollars = (raw: DatabaseSync, pid: string) =>
  all<{ combo_key: string; usd_ceil6: string | null }>(raw, 'SELECT combo_key, usd_ceil6 FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key', pid).map((r): [string, number | null] => [r.combo_key, usdCeilCentsOf(r.usd_ceil6)]);
const rules = (raw: DatabaseSync, pid: string) =>
  all<Json>(raw, "SELECT scope, scope_id, state, amount_usd, version FROM pricing_rules WHERE product_id = ? AND kind = 'target_profit' ORDER BY scope, scope_id", pid);
const record = (raw: DatabaseSync, pid: string) => JSON.parse(row<{ j: string }>(raw, 'SELECT applied_wire_json AS j FROM product_price_estimates WHERE product_id = ?', pid)!.j);
const lineOf = (p: Json, combo = '') => (p.lines as Json[]).find((l) => l.combo_key === combo)!;

/**
 * Every published dollar price of the product is the ceiling's (and these exact ones, when given): from $5 up a charm
 * price; under it the house price's own dollar figure, its dinar price ÷ 1,600 rounded up to the cent — no charm price.
 */
function onGrid(raw: DatabaseSync, pid: string, cents?: Array<[string, number]>): void {
  const got = dollars(raw, pid);
  const dinars = new Map(prices(raw, pid) as Array<[string, number]>);
  for (const [combo, c] of got) {
    assert.ok(c !== null, `${pid} ${combo}: a dollar price`);
    if (c >= LOWEST_USED_CHARM_CENTS) assert.ok(isCharmCents(c), `${pid} ${combo}: $${(c / 100).toFixed(2)} is not a charm price`);
    else assert.equal(c, Math.ceil(dinars.get(combo)! / 16), `${pid} ${combo}: $${(c / 100).toFixed(2)} is not ${dinars.get(combo)}'s own dollar figure`);
  }
  if (cents) assert.deepEqual(got, cents);
}

test('the Nozzle Wiping Plate: 13,500 at the type’s $6, the house price 4,000 ($2.50) under a 10% ceiling — listed as a large drop, applied only with the tick, one hash over both evaluations; FX-5 moves its price, never its rule', async () => {
  const w = world();
  seedProduct(w.raw, 'p_nozzle', 'spare_part');
  tmall(w.raw, 'p_nozzle', '', '15');

  // Today: R = 15 × 240 + 0.00014875 m³ × 400,000 = 3,600 + 59.5 = 3,659.5; + $6 × 1,600 = 13,259.5 → 13,500.
  const first = (await computeAndApply(w.app, ['p_nozzle'])).get('p_nozzle')!;
  assert.deepEqual([lineOf(first).est_cost_iqd, lineOf(first).est_price_iqd], [3_660, 13_500]);
  assert.deepEqual(prices(w.raw, 'p_nozzle'), [['', 13_500]]);
  assert.deepEqual(rules(w.raw, 'p_nozzle').map((r) => [r.scope, r.amount_usd]), [['product', '6']]);
  const before = rules(w.raw, 'p_nozzle');

  // The owner sets the type's ceiling at 10% (his own door, audited) — and no warning: the floor is never crossed.
  const type = await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  assert.deepEqual([type.profit_cap_pct, type.warnings], ['10', []]);

  // Compute: R × 1.1 = 4,025.45, under $5 × 1,600 — no charm price: the highest house price within it, 4,000, which is
  // also the floor (3,659.5 rounded up is 3,750). T_sku = floor6((4,000 − 3,659.5) ÷ 1,600) = $0.212812; 3,659.5 +
  // 340.4992 = 3,999.9992 → 4,000.
  const priced = (await compute(w.app, ['p_nozzle'])).get('p_nozzle')!;
  assert.equal(priced.blocking, false, JSON.stringify(priced.blocked_by));
  assert.deepEqual(
    [lineOf(priced).est_cost_iqd, lineOf(priced).est_price_iqd, lineOf(priced).published_price_iqd, lineOf(priced).change_pct, lineOf(priced).large],
    [3_660, 4_000, 13_500, '-70.37', true]
  );
  assert.match(priced.preview_hash, /^[0-9a-f]{64}$/);
  assert.equal((await compute(w.app, ['p_nozzle'])).get('p_nozzle')!.preview_hash, priced.preview_hash, 'deterministic: the same hash again');
  assert.deepEqual(rules(w.raw, 'p_nozzle'), before, 'compute writes no rule');
  // «التحديث» lists the drop, marked large.
  const refresh = await call(w.app, 'GET', `${BASE}/products?state=refresh`);
  const listed = (refresh.body.products as Json[]).find((p) => p.product_id === 'p_nozzle')!;
  assert.ok(listed, 'listed in «التحديث»');
  assert.deepEqual([listed.lines[0].est_price_iqd, listed.lines[0].published_price_iqd, listed.lines[0].large], [4_000, 13_500, true]);

  // Without the tick: refused, nothing written.
  const untick = (await apply(w.app, [{ product_id: 'p_nozzle', preview_hash: priced.preview_hash }])).get('p_nozzle')!;
  assert.deepEqual([untick.outcome, untick.code], ['refused', 'PRICING_LARGE_CHANGE_CONFIRM']);
  assert.deepEqual(prices(w.raw, 'p_nozzle'), [['', 13_500]]);
  assert.deepEqual(rules(w.raw, 'p_nozzle'), before);

  // With it: the hash the owner reviewed is the one apply computes again over both evaluations.
  const done = (await apply(w.app, [{ product_id: 'p_nozzle', preview_hash: priced.preview_hash, confirm_large_change: true }])).get('p_nozzle')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(prices(w.raw, 'p_nozzle'), [['', 4_000]]);
  onGrid(w.raw, 'p_nozzle', [['', 250]]);
  assert.deepEqual(rules(w.raw, 'p_nozzle').map((r) => [r.scope, r.state, r.amount_usd]), [['product', 'ACTIVE', '0.212812']], 'one fixed USD rule; no percentage stored');
  const rec = record(w.raw, 'p_nozzle');
  assert.deepEqual(rec.minimum_profit, { amount_usd: '0.212812', source: 'type_default' });
  assert.equal('minimum_profit_scopes' in rec, false, 'one SKU: the product rule alone');
  assert.equal(row<{ l: number }>(w.raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_nozzle'")!.l, 1, 'still an estimate');

  // Nothing left to refresh.
  const again = (await compute(w.app, ['p_nozzle'])).get('p_nozzle')!;
  assert.deepEqual([lineOf(again).est_price_iqd, lineOf(again).published_price_iqd], [4_000, 4_000]);
  assert.equal(((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).some((p) => p.product_id === 'p_nozzle'), false);

  // FX-5: CNY 0.15 → 0.16 USD moves R to 3,899.5; the rule stays $0.212812: 3,899.5 + 340.4992 → 4,250, $2.65 — until
  // the owner's next compute and apply price it again under its ceiling.
  const ceilingRule = rules(w.raw, 'p_nozzle');
  applyRate(w.raw, 'CNY_USD', '0.16');
  const fx = await repriceStaleEngineProducts({ ...fxEnv(w.raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { trigger: 'fx', budget: statementBudget(600) });
  assert.deepEqual(fx.repriced, ['p_nozzle']);
  assert.deepEqual(prices(w.raw, 'p_nozzle'), [['', 4_250]]);
  assert.deepEqual(dollars(w.raw, 'p_nozzle'), [['', 265]]);
  assert.deepEqual(rules(w.raw, 'p_nozzle'), ceilingRule, 'FX-5 writes no rule: the ceiling is re-derived only by the owner’s compute and apply');
});

test('the Flush Cutter, an AMS and a printer: each at its highest charm price under today’s and its ceiling, every published dollar price on the grid; no ceiling is today’s estimate byte for byte', async () => {
  const w = world();
  // The Flush Cutter shape: an accessory at 75 CNY in a 160 × 110 × 30 mm box: R = 18,000 + 211.2 + 220 = 18,431.2.
  seedProduct(w.raw, 'p_cutter', 'accessory', { weight: 100, box: [160, 110, 30] });
  tmall(w.raw, 'p_cutter', '', '75');
  // An AMS shape: 249 EUR by land, 5 kg: R = 249 × 1,776 + 5 × 3,200 = 458,224.
  seedProduct(w.raw, 'p_ams', 'ams', { weight: 5_000, box: [400, 300, 300] });
  typed(w.raw, 'p_ams', '', '249', 'EUR');
  // A printer: 1,599 EUR by land, 20 kg, 25,000 extra: R = 2,839,824 + 64,000 + 25,000 = 2,928,824.
  seedProduct(w.raw, 'p_prn', 'printer', { weight: 20_000, box: [600, 500, 500] });
  typed(w.raw, 'p_prn', '', '1599', 'EUR');
  const ids = ['p_cutter', 'p_ams', 'p_prn'];

  // Today: 18,431.2 + $4.50 × 1,600 → 25,750; 458,224 + $45 × 1,600 → 530,250; 2,928,824 + $135 × 1,600 → 3,145,000.
  const today = await compute(w.app, ids);
  assert.deepEqual(
    ids.map((id) => [lineOf(today.get(id)!).est_cost_iqd, lineOf(today.get(id)!).est_price_iqd]),
    [
      [18_432, 25_750],
      [458_224, 530_250],
      [2_928_824, 3_145_000],
    ]
  );
  // No ceiling set, or one set and emptied again: today's estimate, byte for byte (the same hash and lines).
  await setType(w.app, 'printer', { profit_cap_pct: '3' });
  await setType(w.app, 'printer', { profit_cap_pct: null });
  const unchanged = await compute(w.app, ids);
  for (const id of ids) {
    assert.equal(unchanged.get(id)!.preview_hash, today.get(id)!.preview_hash, `${id}: the same hash`);
    assert.deepEqual(unchanged.get(id)!.lines, today.get(id)!.lines, `${id}: the same lines`);
  }
  const first = await apply(
    w.app,
    ids.map((id) => ({ product_id: id, preview_hash: unchanged.get(id)!.preview_hash }))
  );
  for (const id of ids) assert.equal(first.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(first.get(id)).slice(0, 300)}`);
  const recordsBefore = ids.map((id) => JSON.stringify(record(w.raw, id)));

  // The owner's ceilings: accessory 10, AMS 4, printer 3.
  await setType(w.app, 'accessory', { profit_cap_pct: '10' });
  await setType(w.app, 'ams', { profit_cap_pct: '4' });
  await setType(w.app, 'printer', { profit_cap_pct: '3' });
  // The cutter: R × 1.1 = 20,274.32 — $11.99 (19,184 → 19,250); $12.99 → 21,000 is over it.
  // The AMS: R × 1.04 = 476,552.96 — $294.99 (471,984 → 472,000); $299.99 → 480,000 is over it.
  // The printer: R × 1.03 = 3,016,688.72 — $1,879.99 (3,007,984 → 3,008,000); $1,889.99 → 3,024,000 is over it.
  const previews = await compute(w.app, ids);
  assert.deepEqual(
    ids.map((id) => [lineOf(previews.get(id)!).est_price_iqd, lineOf(previews.get(id)!).published_price_iqd, lineOf(previews.get(id)!).large]),
    [
      [19_250, 25_750, true],
      [472_000, 530_250, false],
      [3_008_000, 3_145_000, false],
    ]
  );
  const out = await apply(
    w.app,
    ids.map((id) => ({ product_id: id, preview_hash: previews.get(id)!.preview_hash, confirm_large_change: true }))
  );
  for (const id of ids) assert.equal(out.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(out.get(id)).slice(0, 300)}`);
  assert.deepEqual(
    ids.map((id) => [prices(w.raw, id)[0]![1], rules(w.raw, id).map((r) => [r.scope, r.amount_usd])]),
    [
      [19_250, [['product', '0.4705']]],
      [472_000, [['product', '8.6']]],
      [3_008_000, [['product', '49.475']]],
    ]
  );
  onGrid(w.raw, 'p_cutter', [['', 1_199]]);
  onGrid(w.raw, 'p_ams', [['', 29_499]]);
  onGrid(w.raw, 'p_prn', [['', 187_999]]);
  for (const [i, id] of ids.entries()) assert.notEqual(JSON.stringify(record(w.raw, id)), recordsBefore[i], `${id}: the record names the new profit`);
  // Nothing left to move.
  for (const p of (await compute(w.app, ids)).values()) assert.ok((p.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), p.product_id);
});

test('a SKU whose charm price’s dinar price is today’s shows c there — the same 105,750 at $65.99, not $66.09: no line moves, so «التحديث» does not list it, and its fresh hash applies through POST /apply; one whose dollar figure already is c keeps T — the same hash, lines and record', async () => {
  const w = world();
  // 400.33 CNY: R = 96,079.2 + 59.5 = 96,138.7; + $6 × 1,600 → 105,750, itself the dinar price of $65.99 (105,584);
  // today's own dollar figure 96,138.7 ÷ 1,600 + 6 = $66.0866875 → $66.09.
  seedProduct(w.raw, 'p_dear', 'spare_part');
  tmall(w.raw, 'p_dear', '', '400.33');
  // 406.3 CNY: R = 97,512 + 59.5 = 97,571.5 → 107,250 at $66.9821875 → $66.99, the very charm price whose dinar price it
  // is (107,184 → 107,250).
  seedProduct(w.raw, 'p_even', 'spare_part');
  tmall(w.raw, 'p_even', '', '406.3');
  const ids = ['p_dear', 'p_even'];
  const today = await computeAndApply(w.app, ids);
  assert.deepEqual(
    ids.map((id) => [lineOf(today.get(id)!).est_cost_iqd, lineOf(today.get(id)!).est_price_iqd]),
    [
      [96_139, 105_750],
      [97_572, 107_250],
    ]
  );
  assert.deepEqual([dollars(w.raw, 'p_dear'), dollars(w.raw, 'p_even')], [[['', 6_609]], [['', 6_699]]]);
  const settled = await compute(w.app, ids);

  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  const capped = await compute(w.app, ids);
  // p_even: nothing a customer sees would change — T stays: the same hash, lines and flags as with no ceiling.
  const even = capped.get('p_even')!;
  assert.equal(even.preview_hash, settled.get('p_even')!.preview_hash, 'the same hash: nothing moved');
  assert.deepEqual([even.lines, even.flags], [settled.get('p_even')!.lines, settled.get('p_even')!.flags]);
  // p_dear: every line the same — 105,750 against 105,750 — but its rule moves, so its hash is its own.
  const dear = capped.get('p_dear')!;
  assert.equal(dear.blocking, false, JSON.stringify(dear.blocked_by));
  assert.deepEqual(dear.lines, settled.get('p_dear')!.lines, 'no dinar figure moves');
  assert.notEqual(dear.preview_hash, settled.get('p_dear')!.preview_hash, 'the rule moves: a hash of its own');
  assert.equal((await compute(w.app, ['p_dear'])).get('p_dear')!.preview_hash, dear.preview_hash, 'deterministic over both evaluations');
  // «التحديث» lists price moves only: neither is listed — the dollar figure is applied through the API.
  const listed = ((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).map((p) => p.product_id);
  assert.deepEqual(
    listed.filter((id) => ids.includes(id)),
    [],
    'a change of the dollar figure alone is not listed'
  );
  const done = (await apply(w.app, [{ product_id: 'p_dear', preview_hash: dear.preview_hash }])).get('p_dear')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  // floor6(65.99 − 96,138.7 ÷ 1,600) = $5.903312: 96,138.7 + 9,445.2992 → 105,750, usd_ceil6 65.99.
  assert.deepEqual(rules(w.raw, 'p_dear').map((r) => [r.scope, r.amount_usd]), [['product', '5.903312']]);
  assert.deepEqual(prices(w.raw, 'p_dear'), [['', 105_750]]);
  assert.equal(row<{ u: string }>(w.raw, "SELECT usd_ceil6 AS u FROM pricing_v2_sku_results WHERE product_id = 'p_dear'")!.u, '65.99');
  onGrid(w.raw, 'p_dear', [['', 6_599]]);
  assert.deepEqual(record(w.raw, 'p_dear').minimum_profit, { amount_usd: '5.903312', source: 'type_default' });
  // p_even: T, its record as before the ceiling — no new key.
  assert.deepEqual(rules(w.raw, 'p_even').map((r) => [r.scope, r.amount_usd]), [['product', '6']]);
  assert.equal(
    row<{ j: string }>(w.raw, "SELECT applied_wire_json AS j FROM product_price_estimates WHERE product_id = 'p_even'")!.j.endsWith('"minimum_profit":{"amount_usd":"6","source":"type_default"}}'),
    true,
    'the record as before the ceiling: no new key'
  );
  onGrid(w.raw, 'p_even', [['', 6_699]]);
  // Nothing left to move.
  const again = await compute(w.app, ids);
  for (const id of ids) assert.ok((again.get(id)!.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), id);
  assert.deepEqual(rules(w.raw, 'p_dear').map((r) => [r.scope, r.amount_usd]), [['product', '5.903312']]);
});

test('the hardened-steel combo as it sold on 2026-11-05: 110,500 at $69.04, where $68.99 sells at the same 110,500 — now $68.99 (usd_ceil6 68.99, the card 6,899 cents) at the very same price; the soccerbot (nothing goes up) and a twin the owner prices himself exactly as they were', async () => {
  const w = world();
  // The live shapes. The combo: an accessory ($4.50, 220 IQD extra) with no package of its own — the type's default
  // box, 70 × 50 × 50 mm (0.000175 m³ × 400,000 = 70 IQD by sea), and 100 g — one model, one pre-order SKU by sea, a
  // 57.98 EUR store page: R = 57.98 × 1,776 + 70 + 220 = 103,262.48. Its twin: the same figures. The soccerbot: a
  // makers part ($1.50) at 662 CNY in a 100 × 100 × 255 mm box, R = 158,880 + 1,020 = 159,900.
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 100, default_length_mm = 70, default_width_mm = 50, default_height_mm = 50 WHERE key = 'accessory';
    UPDATE price_estimate_types SET min_profit_usd = '1.5' WHERE key = 'makers_supply';
  `);
  for (const id of ['p_hs', 'p_twin']) {
    seedProduct(w.raw, id, 'accessory', { models: ['p1'], variants: [`o:${id}_p1`], noPackage: true, ...(id === 'p_hs' ? { slug: 'hardened-steel-upgrade-combo' } : {}) });
    storePage(w.raw, id, `o:${id}_p1`, '57.98', 'EUR');
  }
  seedProduct(w.raw, 'p_sb', 'makers_supply', { box: [100, 100, 255], slug: 'cyberbrick-official-soccerbot' });
  tmall(w.raw, 'p_sb', '', '662');
  const ids = ['p_hs', 'p_twin', 'p_sb'];
  const shop = storefront(w.raw);
  const card = async (slug: string) => {
    const page = (await json(await get(shop, `/api/products/${slug}`))) as Json;
    return [page.product.display_price_iqd, page.product.display_price_usd_cents];
  };

  // Today, at T: 103,262.48 + 7,200 → 110,500 at $69.03905 → $69.04; 159,900 + 2,400 → 162,500 at $101.4375 → $101.44.
  const first = await computeAndApply(w.app, ids);
  assert.deepEqual([lineOf(first.get('p_hs')!, 'o:p_hs_p1').est_cost_iqd, lineOf(first.get('p_hs')!, 'o:p_hs_p1').est_price_iqd], [103_263, 110_500]);
  assert.deepEqual([lineOf(first.get('p_sb')!).est_cost_iqd, lineOf(first.get('p_sb')!).est_price_iqd], [159_900, 162_500]);
  assert.deepEqual(dollars(w.raw, 'p_hs'), [['o:p_hs_p1', 6_904]]);
  assert.deepEqual(await card('hardened-steel-upgrade-combo'), [110_500, 6_904]);
  // The owner prices the twin himself, $5 in the product form: 103,262.48 + 8,000 → 111,500 at $69.53905 → $69.54.
  await ownerProductProfit(w.app, 'p_twin', '5');
  assert.deepEqual([prices(w.raw, 'p_twin'), dollars(w.raw, 'p_twin')], [[['o:p_twin_p1', 111_500]], [['o:p_twin_p1', 6_954]]]);
  const asItWas = (pid: string) => JSON.stringify([rules(w.raw, pid), prices(w.raw, pid), dollars(w.raw, pid)]);
  const before = { twin: asItWas('p_twin'), sb: asItWas('p_sb') };

  // The owner's ceilings, 10% on both types.
  await setType(w.app, 'accessory', { profit_cap_pct: '10' });
  await setType(w.app, 'makers_supply', { profit_cap_pct: '10' });
  const previews = await compute(w.app, ids);
  // The combo: its ceiling is today's 110,500 (R × 1.1 = 113,588.728); the highest charm price within it, $68.99, sells
  // at 110,384 → 110,500 — today's very price — at floor6(68.99 − 64.53905) = $4.45095: no line moves.
  const hs = previews.get('p_hs')!;
  assert.equal(hs.blocking, false, JSON.stringify(hs.blocked_by));
  assert.deepEqual(
    (hs.lines as Json[]).map((l) => [l.combo_key, l.channel, l.est_cost_iqd, l.est_price_iqd, l.published_price_iqd]),
    [['o:p_hs_p1', 'pre_order_sea', 103_263, 110_500, 110_500]]
  );
  assert.deepEqual((hs.flags as Json[]).map((f) => f.code).sort(), ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT', 'EST_STORE_PAGE_PRICE']);
  assert.equal((await compute(w.app, ['p_hs'])).get('p_hs')!.preview_hash, hs.preview_hash, 'deterministic over both evaluations');
  // So «التحديث» lists none of the three; each is applied through POST /apply on its fresh hash.
  const listed = ((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).map((p) => p.product_id);
  assert.deepEqual(
    listed.filter((id) => ids.includes(id)),
    []
  );
  const out = await apply(
    w.app,
    ids.map((id) => ({ product_id: id, preview_hash: previews.get(id)!.preview_hash }))
  );
  for (const id of ids) assert.equal(out.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(out.get(id)).slice(0, 300)}`);

  // The combo: the same 110,500; its dollar price $68.99, stored and shown.
  assert.deepEqual(prices(w.raw, 'p_hs'), [['o:p_hs_p1', 110_500]]);
  assert.deepEqual(rules(w.raw, 'p_hs').map((r) => [r.scope, r.amount_usd]), [['product', '4.45095']]);
  const stored = row<{ usd: string; r: string; t: string }>(w.raw, "SELECT usd_ceil6 AS usd, replacement_exact AS r, target_profit_usd AS t FROM pricing_v2_sku_results WHERE product_id = 'p_hs'")!;
  assert.deepEqual([stored.usd, stored.r, stored.t], ['68.99', '103262.48', '4.45095']);
  onGrid(w.raw, 'p_hs', [['o:p_hs_p1', 6_899]]);
  assert.deepEqual(await card('hardened-steel-upgrade-combo'), [110_500, 6_899]);
  // The soccerbot: nothing goes up — $99.99 = 160,000 keeps 84 IQD over its cost, $104.99 = 168,000 is dearer than
  // today's 162,500 — so T stays: 162,500 at $101.44, exactly as before (no charm price has this dinar price).
  assert.equal(asItWas('p_sb'), before.sb);
  assert.deepEqual([prices(w.raw, 'p_sb'), dollars(w.raw, 'p_sb')], [[['', 162_500]], [['', 10_144]]]);
  assert.deepEqual(await card('cyberbrick-official-soccerbot'), [162_500, 10_144]);
  // The twin: the owner's own rule decides (EST_OWNER_EDITED) — no profit written, his $5, 111,500 and $69.54 untouched.
  assert.ok((previews.get('p_twin')!.flags as Json[]).some((f) => f.code === 'EST_OWNER_EDITED'));
  assert.equal(asItWas('p_twin'), before.twin);
  // Nothing left to move, and the rule stays the combo's own.
  const again = await compute(w.app, ids);
  for (const id of ids) assert.ok((again.get(id)!.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), id);
  assert.deepEqual(rules(w.raw, 'p_hs').map((r) => [r.scope, r.amount_usd]), [['product', '4.45095']]);
});

test('the owner’s own prices win: every model his — rules and prices kept; one model his — the others priced on one option group, his rule untouched', async () => {
  const w = world();
  // Two models (15 and 20 CNY): R 3,659.5 and 4,859.5. Three models (15, 20, 15 CNY) beside it.
  seedProduct(w.raw, 'p_owned', 'spare_part', { models: ['m1', 'm2'] });
  tmall(w.raw, 'p_owned', 'o:p_owned_m1', '15');
  tmall(w.raw, 'p_owned', 'o:p_owned_m2', '20');
  seedProduct(w.raw, 'p_half', 'spare_part', { models: ['m1', 'm2', 'm3'] });
  tmall(w.raw, 'p_half', 'o:p_half_m1', '15');
  tmall(w.raw, 'p_half', 'o:p_half_m2', '20');
  tmall(w.raw, 'p_half', 'o:p_half_m3', '15');
  await computeAndApply(w.app, ['p_owned', 'p_half']);
  assert.deepEqual(prices(w.raw, 'p_half'), [
    ['o:p_half_m1', 13_500],
    ['o:p_half_m2', 14_500],
    ['o:p_half_m3', 13_500],
  ]);

  // The owner prices models himself in the product form: $7 and $6.50 on both of one product, $7 on one model of the other.
  await ownerModelProfits(w.app, 'p_owned', [
    ['m1', '7'],
    ['m2', '6.5'],
  ]);
  await ownerModelProfits(w.app, 'p_half', [['m1', '7']]);
  // 3,659.5 + $7 × 1,600 = 14,859.5 → 15,000; 4,859.5 + $6.50 × 1,600 = 15,259.5 → 15,500.
  assert.deepEqual(prices(w.raw, 'p_owned'), [
    ['o:p_owned_m1', 15_000],
    ['o:p_owned_m2', 15_500],
  ]);
  const ownedRules = rules(w.raw, 'p_owned');
  const ownedPrices = prices(w.raw, 'p_owned');
  assert.deepEqual(
    ownedRules.map((r) => [r.scope, r.scope_id, r.amount_usd]),
    [
      ['option', 'p_owned_m1', '7'],
      ['option', 'p_owned_m2', '6.5'],
      ['product', '', '6'],
    ]
  );

  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  const previews = await compute(w.app, ['p_owned', 'p_half']);

  // Every model the owner's: nothing to price, nothing moves, nothing to refresh.
  const owned = previews.get('p_owned')!;
  assert.equal(owned.blocking, false, JSON.stringify(owned.blocked_by));
  assert.deepEqual(
    (owned.lines as Json[]).map((l) => [l.combo_key, l.est_price_iqd, l.published_price_iqd]),
    [
      ['o:p_owned_m1', 15_000, 15_000],
      ['o:p_owned_m2', 15_500, 15_500],
    ]
  );
  const listed = ((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).map((p) => p.product_id);
  assert.deepEqual(listed, ['p_half'], 'only the product the ceiling moves');

  // One model the owner's: his $7 stays; the other two are priced, each by a rule on the model group.
  // m2: R × 1.1 = 5,345.45 holds the house price 5,250, 390.5 over its cost: T_sku = floor6(390.5 ÷ 1,600) =
  // $0.244062; m3 as the Nozzle: 4,000.
  const half = previews.get('p_half')!;
  assert.deepEqual(
    (half.lines as Json[]).map((l) => [l.combo_key, l.est_cost_iqd, l.est_price_iqd, l.published_price_iqd]),
    [
      ['o:p_half_m1', 3_660, 15_000, 15_000],
      ['o:p_half_m2', 4_860, 5_250, 14_500],
      ['o:p_half_m3', 3_660, 4_000, 13_500],
    ]
  );

  const out = await apply(w.app, [
    { product_id: 'p_owned', preview_hash: owned.preview_hash },
    { product_id: 'p_half', preview_hash: half.preview_hash, confirm_large_change: true },
  ]);
  assert.equal(out.get('p_owned')!.outcome, 'applied', JSON.stringify(out.get('p_owned')).slice(0, 300));
  assert.equal(out.get('p_half')!.outcome, 'applied', JSON.stringify(out.get('p_half')).slice(0, 300));
  assert.deepEqual(rules(w.raw, 'p_owned'), ownedRules, 'the owner’s rules exactly as he left them — not even a version moved');
  assert.deepEqual(prices(w.raw, 'p_owned'), ownedPrices);
  assert.equal('minimum_profit_scopes' in record(w.raw, 'p_owned'), false);

  assert.deepEqual(
    rules(w.raw, 'p_half').map((r) => [r.scope, r.scope_id, r.state, r.amount_usd]),
    [
      ['option', 'p_half_m1', 'ACTIVE', '7'],
      ['option', 'p_half_m2', 'ACTIVE', '0.244062'],
      ['option', 'p_half_m3', 'ACTIVE', '0.212812'],
      ['product', '', 'ACTIVE', '6'],
    ]
  );
  assert.equal(rules(w.raw, 'p_half').find((r) => r.scope_id === 'p_half_m1')!.version, 1, 'his rule never rewritten');
  assert.deepEqual(prices(w.raw, 'p_half'), [
    ['o:p_half_m1', 15_000],
    ['o:p_half_m2', 5_250],
    ['o:p_half_m3', 4_000],
  ]);
  assert.deepEqual(
    dollars(w.raw, 'p_half').slice(1),
    [
      ['o:p_half_m2', 329],
      ['o:p_half_m3', 250],
    ],
    'the ceiling’s models at their house prices’ own dollar figures'
  );
  // The record names the ceiling's rules — never the owner's — so the next refresh tells them apart.
  const rec = record(w.raw, 'p_half');
  assert.deepEqual(rec.minimum_profit, { amount_usd: '6', source: 'type_default' });
  assert.deepEqual(rec.minimum_profit_scopes, [
    { scope: 'option', scope_id: 'p_half_m2', amount_usd: '0.244062', source: 'type_default' },
    { scope: 'option', scope_id: 'p_half_m3', amount_usd: '0.212812', source: 'type_default' },
  ]);
  const settled = (await compute(w.app, ['p_half'])).get('p_half')!;
  assert.ok((settled.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), 'nothing left to move');
});

test('colour and SKU rules travel the form’s own parser: a cost that follows the colour is priced per colour, one of its own per SKU', async () => {
  const w = world();
  // Two colours at 15 and 20 CNY: R 3,659.5 and 4,859.5.
  seedProduct(w.raw, 'p_tint', 'spare_part', { colours: ['red', 'gold'] });
  tmall(w.raw, 'p_tint', 'c:p_tint_red', '15');
  tmall(w.raw, 'p_tint', 'c:p_tint_gold', '20');
  // Two models × two colours, each its own cost (15, 16, 17, 18 CNY): R 3,659.5, 3,899.5, 4,139.5, 4,379.5.
  const cells = ['o:p_grid_m1|c:p_grid_red', 'o:p_grid_m1|c:p_grid_blue', 'o:p_grid_m2|c:p_grid_red', 'o:p_grid_m2|c:p_grid_blue'];
  seedProduct(w.raw, 'p_grid', 'spare_part', { models: ['m1', 'm2'], colours: ['red', 'blue'], variants: cells });
  cells.forEach((combo, i) => tmall(w.raw, 'p_grid', combo, String(15 + i)));
  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });

  const previews = await computeAndApply(w.app, ['p_tint', 'p_grid']);
  assert.deepEqual(
    (previews.get('p_tint')!.lines as Json[]).map((l) => [l.combo_key, l.est_price_iqd]).sort(),
    [
      ['c:p_tint_gold', 5_250],
      ['c:p_tint_red', 4_000],
    ]
  );
  assert.deepEqual(
    rules(w.raw, 'p_tint').map((r) => [r.scope, r.scope_id, r.amount_usd]),
    [
      ['color', 'p_tint_gold', '0.244062'],
      ['color', 'p_tint_red', '0.212812'],
      ['product', '', '6'],
    ]
  );
  assert.deepEqual(
    record(w.raw, 'p_tint').minimum_profit_scopes.map((s: Json) => [s.scope, s.scope_id]),
    [
      ['color', 'p_tint_gold'],
      ['color', 'p_tint_red'],
    ]
  );
  assert.deepEqual(prices(w.raw, 'p_tint'), [
    ['c:p_tint_gold', 5_250],
    ['c:p_tint_red', 4_000],
  ]);
  onGrid(w.raw, 'p_tint', [
    ['c:p_tint_gold', 329],
    ['c:p_tint_red', 250],
  ]);

  // Each under $5 at the house price under its ceiling: 15 CNY 4,000 (R × 1.1 = 4,025.45); 16 CNY 4,250 (4,289.45);
  // 17 CNY 4,500 (4,553.45); 18 CNY 4,750 (4,817.45) — each at a profit of its own.
  assert.deepEqual(
    rules(w.raw, 'p_grid').map((r) => [r.scope, r.scope_id, r.amount_usd]),
    [
      ['product', '', '6'],
      ['sku', 'o:p_grid_m1|c:p_grid_blue', '0.219062'],
      ['sku', 'o:p_grid_m1|c:p_grid_red', '0.212812'],
      ['sku', 'o:p_grid_m2|c:p_grid_blue', '0.231562'],
      ['sku', 'o:p_grid_m2|c:p_grid_red', '0.225312'],
    ]
  );
  assert.deepEqual(prices(w.raw, 'p_grid'), [
    ['o:p_grid_m1|c:p_grid_blue', 4_250],
    ['o:p_grid_m1|c:p_grid_red', 4_000],
    ['o:p_grid_m2|c:p_grid_blue', 4_750],
    ['o:p_grid_m2|c:p_grid_red', 4_500],
  ]);
  onGrid(w.raw, 'p_grid', [
    ['o:p_grid_m1|c:p_grid_blue', 266],
    ['o:p_grid_m1|c:p_grid_red', 250],
    ['o:p_grid_m2|c:p_grid_blue', 297],
    ['o:p_grid_m2|c:p_grid_red', 282],
  ]);
  assert.equal(record(w.raw, 'p_grid').minimum_profit_scopes.length, 4);
  // Nothing left to move: the rules as written price exactly what was reviewed.
  for (const p of (await compute(w.app, ['p_tint', 'p_grid'])).values()) {
    assert.ok((p.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), p.product_id);
  }
});

test('0% is the floor, never below it: a part just over 1,000 IQD sells at 1,500, the lowest house price 250 over its cost, a part under 1,000 IQD at its cost plus a dinar — nothing blocked, no warning', async () => {
  const w = world();
  // Accessories in a 100 × 100 × 5 mm box (20 IQD by sea) and 220 IQD extra: 3.4 CNY → R = 816 + 240 = 1,056;
  // 1.9 CNY → R = 456 + 240 = 696.
  seedProduct(w.raw, 'p_clip', 'accessory', { weight: 10, box: [100, 100, 5] });
  tmall(w.raw, 'p_clip', '', '3.4');
  seedProduct(w.raw, 'p_pin', 'accessory', { weight: 10, box: [100, 100, 5] });
  tmall(w.raw, 'p_pin', '', '1.9');
  const zero = await setType(w.app, 'accessory', { profit_cap_pct: '0' });
  assert.deepEqual([zero.profit_cap_pct, zero.warnings], ['0', []], 'no warning: the planner never crosses the floor');
  const types = (await call(w.app, 'GET', `${BASE}/types`)).body.types as Json[];
  assert.deepEqual(types.find((t) => t.key === 'accessory')!.warnings, []);

  // p_clip: 1,250 keeps only 194 over 1,056; 1,500 (444 over it) is the lowest house price that keeps one rounding
  // step — where the grid sold it at $0.99 = 1,750. p_pin: 0% of 696 is under 1,000 IQD: one dinar over its cost.
  const previews = await computeAndApply(w.app, ['p_clip', 'p_pin']);
  for (const id of ['p_clip', 'p_pin']) assert.equal(previews.get(id)!.blocking, false, `${id}: ${JSON.stringify(previews.get(id)!.blocked_by)}`);
  assert.deepEqual([lineOf(previews.get('p_clip')!).est_cost_iqd, lineOf(previews.get('p_clip')!).est_price_iqd], [1_056, 1_500]);
  assert.deepEqual([lineOf(previews.get('p_pin')!).est_cost_iqd, lineOf(previews.get('p_pin')!).est_price_iqd], [696, 697]);
  assert.deepEqual(rules(w.raw, 'p_clip').map((r) => [r.scope, r.amount_usd]), [['product', '0.2775']]);
  // One dinar of margin at or under 1,000 IQD: 1 ÷ 1,600 = $0.000625 (696 + 1 = 697).
  assert.deepEqual(rules(w.raw, 'p_pin').map((r) => [r.scope, r.amount_usd]), [['product', '0.000625']]);
  onGrid(w.raw, 'p_clip', [['', 94]]);
  // At 10% the part takes its ceiling, 765.6, in whole dinars: 765.
  await setType(w.app, 'accessory', { profit_cap_pct: '10' });
  assert.equal(lineOf((await compute(w.app, ['p_pin'])).get('p_pin')!).est_price_iqd, 765);
});

test('left alone: a paused and a confirmed product are untouched; an apply still makes every firm SKU an estimate again (pinned)', async () => {
  const w = world();
  seedProduct(w.raw, 'p_pause', 'spare_part');
  tmall(w.raw, 'p_pause', '', '15');
  seedProduct(w.raw, 'p_conf', 'spare_part');
  tmall(w.raw, 'p_conf', '', '15');
  seedProduct(w.raw, 'p_firm', 'spare_part', { models: ['m1', 'm2'] });
  tmall(w.raw, 'p_firm', 'o:p_firm_m1', '15');
  tmall(w.raw, 'p_firm', 'o:p_firm_m2', '15');
  await computeAndApply(w.app, ['p_pause', 'p_conf', 'p_firm']);
  const version = (pid: string) => row<{ version: number }>(w.raw, 'SELECT version FROM product_price_estimates WHERE product_id = ?', pid)!.version;

  // Paused by the owner; confirmed whole; one model of the third made firm.
  assert.equal((await call(w.app, 'PUT', `${BASE}/products/p_pause`, { version: version('p_pause'), state: 'paused' })).status, 200);
  const whole = await call(w.app, 'POST', `${BASE}/products/p_conf/confirm`, { version: version('p_conf'), accept_flags: [] });
  assert.equal(whole.status, 200, JSON.stringify(whole.body).slice(0, 300));
  const firm = await call(w.app, 'POST', `${BASE}/products/p_firm/confirm`, { version: version('p_firm'), accept_flags: [], combo_keys: ['o:p_firm_m1'] });
  assert.equal(firm.status, 200, JSON.stringify(firm.body).slice(0, 300));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_firm_skus WHERE product_id = 'p_firm'"), 1);

  const untouched = (pid: string) => JSON.stringify([row(w.raw, 'SELECT * FROM product_price_estimates WHERE product_id = ?', pid), rules(w.raw, pid), prices(w.raw, pid)]);
  const before = { pause: untouched('p_pause'), conf: untouched('p_conf') };
  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  const previews = await compute(w.app, ['p_pause', 'p_conf', 'p_firm']);
  assert.equal(previews.get('p_pause')!.state, 'paused');
  assert.equal(previews.get('p_pause')!.preview_hash, null);
  assert.equal(previews.get('p_conf')!.state, 'confirmed');
  assert.equal(untouched('p_pause'), before.pause, 'compute never touches a paused product');
  assert.equal(untouched('p_conf'), before.conf, 'nor a confirmed one: it keeps its old price');
  const refused = (await apply(w.app, [{ product_id: 'p_pause', preview_hash: 'f'.repeat(64), confirm_large_change: true }])).get('p_pause')!;
  assert.deepEqual([refused.outcome, refused.code], ['refused', 'PRICE_ESTIMATE_NOT_ELIGIBLE']);
  assert.equal(untouched('p_pause'), before.pause);

  // The firm SKU: the ceiling's apply makes it an estimate again, as every apply does (§4.8) — the live run skips such products.
  const p = previews.get('p_firm')!;
  assert.deepEqual((p.lines as Json[]).map((l) => l.est_price_iqd), [4_000, 4_000]);
  const done = (await apply(w.app, [{ product_id: 'p_firm', preview_hash: p.preview_hash, confirm_large_change: true }])).get('p_firm')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_firm_skus WHERE product_id = 'p_firm'"), 0, 'pinned: the firm SKU is an estimate again');
  assert.deepEqual(rules(w.raw, 'p_firm').map((r) => [r.scope, r.amount_usd]), [['product', '0.212812']], 'both models at one profit: the product rule alone');
});

const linesOf = (p: Json) => (p.lines as Json[]).map((l) => [l.combo_key, l.est_cost_iqd, l.est_price_iqd, l.published_price_iqd]);
const ruleRows = (raw: DatabaseSync, pid: string) => rules(raw, pid).map((r) => [r.scope, r.scope_id, r.state, r.amount_usd]);

test('a SKU priced under 1,000 IQD whose supplier then moves its cost just past 1,000 IQD: the next compute reads it at T and prices it again — never stuck on its own stale rule', async () => {
  const w = world();
  // An accessory (220 IQD extra) in a 100 × 100 × 5 mm box: R = CNY × 240 + 20 + 220 — m1 at 2 CNY 720, m2 at 2.5 CNY 840.
  seedProduct(w.raw, 'p_two', 'accessory', { models: ['m1', 'm2'], weight: 10, box: [100, 100, 5] });
  const m1 = tmall(w.raw, 'p_two', 'o:p_two_m1', '2');
  tmall(w.raw, 'p_two', 'o:p_two_m2', '2.5');
  await setType(w.app, 'accessory', { profit_cap_pct: '10' });
  await computeAndApply(w.app, ['p_two'], true);
  // Under 1,000 IQD the house price is whole dinars: each at its ceiling — m1 R × 1.1 = 792 (72 ÷ 1,600 = $0.045),
  // m2 924 ($0.0525).
  assert.deepEqual(ruleRows(w.raw, 'p_two'), [
    ['option', 'p_two_m1', 'ACTIVE', '0.045'],
    ['option', 'p_two_m2', 'ACTIVE', '0.0525'],
    ['product', '', 'ACTIVE', '4.5'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_two'), [
    ['o:p_two_m1', 792],
    ['o:p_two_m2', 924],
  ]);
  onGrid(w.raw, 'p_two', [
    ['o:p_two_m1', 50],
    ['o:p_two_m2', 58],
  ]);

  // m1's supplier price rises to 3.17 CNY: R = 1,000.8. Its stale $0.045 would sell it at 1,072.8 → 1,250, its own
  // cost rounded up — a closed route, no cost read, nothing to price from. Priced at T first, its cost is read and
  // priced again: 1,250 would keep 249.2 over it, so 1,500 (499.2 over it), $0.312.
  w.raw.exec(`UPDATE supplier_price_skus SET price = '3.17' WHERE item_key = ${q(m1)}`);
  const p = (await compute(w.app, ['p_two'])).get('p_two')!;
  assert.equal(p.blocking, false, JSON.stringify(p.blocked_by));
  assert.deepEqual(linesOf(p), [
    ['o:p_two_m1', 1_001, 1_500, 792],
    ['o:p_two_m2', 840, 924, 924],
  ]);
  assert.equal((await compute(w.app, ['p_two'])).get('p_two')!.preview_hash, p.preview_hash, 'deterministic over both evaluations');
  const done = (await apply(w.app, [{ product_id: 'p_two', preview_hash: p.preview_hash, confirm_large_change: true }])).get('p_two')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(ruleRows(w.raw, 'p_two'), [
    ['option', 'p_two_m1', 'ACTIVE', '0.312'],
    ['option', 'p_two_m2', 'ACTIVE', '0.0525'],
    ['product', '', 'ACTIVE', '4.5'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_two'), [
    ['o:p_two_m1', 1_500],
    ['o:p_two_m2', 924],
  ]);
  onGrid(w.raw, 'p_two', [
    ['o:p_two_m1', 94],
    ['o:p_two_m2', 58],
  ]);
  assert.ok(((await compute(w.app, ['p_two'])).get('p_two')!.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), 'nothing left to move');
});

test('the CNY rate alone after a ceiling apply: the margin keeps the route open, so FX-5 follows the cost and holds nothing; the owner’s next compute and apply put the prices back under the ceiling', async () => {
  const w = world();
  // Two colours of a spare part: 5.94 CNY (R = 1,425.6 + 59.5 = 1,485.1) and 20 CNY (R = 4,859.5).
  seedProduct(w.raw, 'p_fx', 'spare_part', { colours: ['cheap', 'dear'] });
  tmall(w.raw, 'p_fx', 'c:p_fx_cheap', '5.94');
  tmall(w.raw, 'p_fx', 'c:p_fx_dear', '20');
  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  await computeAndApply(w.app, ['p_fx'], true);
  // Cheap: its ceiling, 1,633.61, holds 1,500, which would keep only 14.9 IQD over its cost — the next rate tick would
  // round the cost up to the very price — so 1,750, 264.9 over it: $0.165562. Dear: 5,250 under 5,345.45, $0.244062.
  assert.deepEqual(ruleRows(w.raw, 'p_fx'), [
    ['color', 'p_fx_cheap', 'ACTIVE', '0.165562'],
    ['color', 'p_fx_dear', 'ACTIVE', '0.244062'],
    ['product', '', 'ACTIVE', '6'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_fx'), [
    ['c:p_fx_cheap', 1_750],
    ['c:p_fx_dear', 5_250],
  ]);
  onGrid(w.raw, 'p_fx', [
    ['c:p_fx_cheap', 110],
    ['c:p_fx_dear', 329],
  ]);

  // CNY 0.15 → 0.1517 USD (+1.1%): the cheap colour's R = 5.94 × 242.72 + 59.5 = 1,501.2568, rounded up 1,750 — its
  // price exactly. Its $0.165562 keeps 264.9: FX-5 reprices the product and holds nothing (+14.3%, under its 15%
  // guard), writing no rule — 1,501.2568 + 264.8992 → 2,000; 4,913.9 + 390.4992 → 5,500.
  const ceilingRules = rules(w.raw, 'p_fx');
  applyRate(w.raw, 'CNY_USD', '0.1517');
  const fx = await repriceStaleEngineProducts({ ...fxEnv(w.raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { trigger: 'fx', budget: statementBudget(600) });
  assert.deepEqual([fx.repriced, fx.blocked], [['p_fx'], []]);
  assert.deepEqual(prices(w.raw, 'p_fx'), [
    ['c:p_fx_cheap', 2_000],
    ['c:p_fx_dear', 5_500],
  ]);
  assert.deepEqual(rules(w.raw, 'p_fx'), ceilingRules, 'FX-5 writes no rule');
  // Its dollar prices follow the cost: 1,766.156 ÷ 1,600 → $1.11; 5,304.3992 ÷ 1,600 → $3.32.
  assert.deepEqual(dollars(w.raw, 'p_fx'), [
    ['c:p_fx_cheap', 111],
    ['c:p_fx_dear', 332],
  ]);

  // The owner's compute reads both costs at T and prices them under the ceiling again: cheap 2,000 (its ceiling,
  // 1,651.38, holds 1,500 — under its cost — and 1,750 keeps 248.7: the lowest house price that keeps the margin),
  // dear 5,250 under 5,405.29 — a drop from FX-5's 5,500, so «التحديث» lists it; applied on its hash: cheap (2,000 −
  // 1,501.2568) ÷ 1,600 = $0.311714, dear (5,250 − 4,913.9) ÷ 1,600 = $0.210062.
  const p = (await compute(w.app, ['p_fx'])).get('p_fx')!;
  assert.equal(p.blocking, false, JSON.stringify(p.blocked_by));
  assert.deepEqual(linesOf(p), [
    ['c:p_fx_cheap', 1_502, 2_000, 2_000],
    ['c:p_fx_dear', 4_914, 5_250, 5_500],
  ]);
  assert.equal(((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).some((r) => r.product_id === 'p_fx'), true, 'the dear colour’s price moves back under its ceiling');
  const done = (await apply(w.app, [{ product_id: 'p_fx', preview_hash: p.preview_hash }])).get('p_fx')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(ruleRows(w.raw, 'p_fx'), [
    ['color', 'p_fx_cheap', 'ACTIVE', '0.311714'],
    ['color', 'p_fx_dear', 'ACTIVE', '0.210062'],
    ['product', '', 'ACTIVE', '6'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_fx'), [
    ['c:p_fx_cheap', 2_000],
    ['c:p_fx_dear', 5_250],
  ]);
  onGrid(w.raw, 'p_fx', [
    ['c:p_fx_cheap', 125],
    ['c:p_fx_dear', 329],
  ]);
});

test('the owner’s own product rule after a ceiling apply: the next compute takes the ceiling’s colour rules back to inherit, so his rule decides every colour as before — a reviewed rise, applied only with the tick', async () => {
  const w = world();
  // Two colours at 15 and 20 CNY: R 3,659.5 and 4,859.5, priced per colour at 4,000 and 5,250.
  seedProduct(w.raw, 'p_tint', 'spare_part', { colours: ['red', 'gold'] });
  tmall(w.raw, 'p_tint', 'c:p_tint_red', '15');
  tmall(w.raw, 'p_tint', 'c:p_tint_gold', '20');
  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  await computeAndApply(w.app, ['p_tint']);
  assert.deepEqual(prices(w.raw, 'p_tint'), [
    ['c:p_tint_gold', 5_250],
    ['c:p_tint_red', 4_000],
  ]);

  // He sets the product's minimum profit to $8 in the product form. The ceiling's colour rules still decide both
  // colours (the form draws no colour rule), so his save moves no price.
  await ownerProductProfit(w.app, 'p_tint', '8');
  assert.deepEqual(ruleRows(w.raw, 'p_tint'), [
    ['color', 'p_tint_gold', 'ACTIVE', '0.244062'],
    ['color', 'p_tint_red', 'ACTIVE', '0.212812'],
    ['product', '', 'ACTIVE', '8'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_tint'), [
    ['c:p_tint_gold', 5_250],
    ['c:p_tint_red', 4_000],
  ]);
  const his = rules(w.raw, 'p_tint').find((r) => r.scope === 'product')!;

  // The next compute: his rule is the product's, so no profit is written and the ceiling's colour rules go back to
  // inherit — $8 on both: 3,659.5 + 12,800 → 16,500; 4,859.5 + 12,800 → 17,750. A large rise: listed, the tick needed.
  const p = (await compute(w.app, ['p_tint'])).get('p_tint')!;
  assert.equal(p.blocking, false, JSON.stringify(p.blocked_by));
  assert.ok((p.flags as Json[]).some((f) => f.code === 'EST_OWNER_EDITED'), 'his product rule: EST_OWNER_EDITED');
  assert.deepEqual(
    (p.lines as Json[]).map((l) => [l.combo_key, l.est_price_iqd, l.published_price_iqd, l.large]),
    [
      ['c:p_tint_red', 16_500, 4_000, true],
      ['c:p_tint_gold', 17_750, 5_250, true],
    ]
  );
  assert.ok(((await call(w.app, 'GET', `${BASE}/products?state=refresh`)).body.products as Json[]).some((r) => r.product_id === 'p_tint'), 'listed in «التحديث»');
  const untick = (await apply(w.app, [{ product_id: 'p_tint', preview_hash: p.preview_hash }])).get('p_tint')!;
  assert.deepEqual([untick.outcome, untick.code], ['refused', 'PRICING_LARGE_CHANGE_CONFIRM']);
  assert.deepEqual(prices(w.raw, 'p_tint'), [
    ['c:p_tint_gold', 5_250],
    ['c:p_tint_red', 4_000],
  ]);
  const done = (await apply(w.app, [{ product_id: 'p_tint', preview_hash: p.preview_hash, confirm_large_change: true }])).get('p_tint')!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(ruleRows(w.raw, 'p_tint'), [
    ['color', 'p_tint_gold', 'INHERIT', null],
    ['color', 'p_tint_red', 'INHERIT', null],
    ['product', '', 'ACTIVE', '8'],
  ]);
  assert.equal(rules(w.raw, 'p_tint').find((r) => r.scope === 'product')!.version, his.version, 'his rule never rewritten');
  assert.deepEqual(prices(w.raw, 'p_tint'), [
    ['c:p_tint_gold', 17_750],
    ['c:p_tint_red', 16_500],
  ]);
  const rec = record(w.raw, 'p_tint');
  assert.equal('minimum_profit_scopes' in rec, false, 'nothing of the ceiling left in the record');
  assert.deepEqual(rec.minimum_profit, { amount_usd: '6', source: 'type_default' }, 'the record of his changed rule stays (§4.5): still his');
  const settled = (await compute(w.app, ['p_tint'])).get('p_tint')!;
  assert.ok((settled.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), 'nothing left to move');
});

test('the rollback: the ceiling emptied, the next compute takes its rules back — T on the product, its scope rules to inherit, the record without them — and an owner-priced product follows his own rule; the rises need the tick', async () => {
  const w = world();
  // Two models at 15 and 20 CNY (R 3,659.5 and 4,859.5); and two colours at the same costs, priced by the owner later.
  seedProduct(w.raw, 'p_rb', 'spare_part', { models: ['m0', 'm1'] });
  tmall(w.raw, 'p_rb', 'o:p_rb_m0', '15');
  tmall(w.raw, 'p_rb', 'o:p_rb_m1', '20');
  seedProduct(w.raw, 'p_own', 'spare_part', { colours: ['red', 'gold'] });
  tmall(w.raw, 'p_own', 'c:p_own_red', '15');
  tmall(w.raw, 'p_own', 'c:p_own_gold', '20');
  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  await computeAndApply(w.app, ['p_rb', 'p_own']);
  assert.deepEqual(ruleRows(w.raw, 'p_rb'), [
    ['option', 'p_rb_m0', 'ACTIVE', '0.212812'],
    ['option', 'p_rb_m1', 'ACTIVE', '0.244062'],
    ['product', '', 'ACTIVE', '6'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_rb'), [
    ['o:p_rb_m0', 4_000],
    ['o:p_rb_m1', 5_250],
  ]);
  await ownerProductProfit(w.app, 'p_own', '8');

  // The ceiling emptied (the live procedure's rollback), then compute: T again, as before the ceiling — and $8 on his product.
  const type = await setType(w.app, 'spare_part', { profit_cap_pct: null });
  assert.equal(type.profit_cap_pct, null);
  const previews = await compute(w.app, ['p_rb', 'p_own']);
  assert.deepEqual(
    (previews.get('p_rb')!.lines as Json[]).map((l) => [l.combo_key, l.est_price_iqd, l.published_price_iqd, l.large]),
    [
      ['o:p_rb_m0', 13_500, 4_000, true],
      ['o:p_rb_m1', 14_500, 5_250, true],
    ]
  );
  assert.deepEqual(
    (previews.get('p_own')!.lines as Json[]).map((l) => [l.combo_key, l.est_price_iqd, l.published_price_iqd]),
    [
      ['c:p_own_red', 16_500, 4_000],
      ['c:p_own_gold', 17_750, 5_250],
    ]
  );
  const items = ['p_rb', 'p_own'].map((id) => ({ product_id: id, preview_hash: previews.get(id)!.preview_hash }));
  const untick = await apply(w.app, items);
  assert.deepEqual(
    [...untick.values()].map((r) => [r.product_id, r.outcome, r.code]),
    [
      ['p_rb', 'refused', 'PRICING_LARGE_CHANGE_CONFIRM'],
      ['p_own', 'refused', 'PRICING_LARGE_CHANGE_CONFIRM'],
    ]
  );
  const out = await apply(
    w.app,
    items.map((i) => ({ ...i, confirm_large_change: true }))
  );
  for (const id of ['p_rb', 'p_own']) assert.equal(out.get(id)!.outcome, 'applied', JSON.stringify(out.get(id)).slice(0, 300));
  assert.deepEqual(ruleRows(w.raw, 'p_rb'), [
    ['option', 'p_rb_m0', 'INHERIT', null],
    ['option', 'p_rb_m1', 'INHERIT', null],
    ['product', '', 'ACTIVE', '6'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_rb'), [
    ['o:p_rb_m0', 13_500],
    ['o:p_rb_m1', 14_500],
  ]);
  assert.deepEqual(record(w.raw, 'p_rb').minimum_profit, { amount_usd: '6', source: 'type_default' });
  assert.equal('minimum_profit_scopes' in record(w.raw, 'p_rb'), false);
  assert.deepEqual(ruleRows(w.raw, 'p_own'), [
    ['color', 'p_own_gold', 'INHERIT', null],
    ['color', 'p_own_red', 'INHERIT', null],
    ['product', '', 'ACTIVE', '8'],
  ]);
  assert.deepEqual(prices(w.raw, 'p_own'), [
    ['c:p_own_gold', 17_750],
    ['c:p_own_red', 16_500],
  ]);
  assert.equal('minimum_profit_scopes' in record(w.raw, 'p_own'), false);
  for (const p of (await compute(w.app, ['p_rb', 'p_own'])).values()) {
    assert.ok((p.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), `${p.product_id}: nothing left to move`);
  }
});

/** Compute in the door's pages of ten (product_ids ≤ 10). */
async function computePages(app: App, ids: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  for (let i = 0; i < ids.length; i += 10) for (const [id, p] of await compute(app, ids.slice(i, i + 10))) out.set(id, p);
  return out;
}

/** FX-5 until nothing is left stale: every product it repriced and every one it held. */
async function fxRun(raw: DatabaseSync): Promise<{ repriced: Set<string>; held: Array<{ product_id: string; code: string }> }> {
  const out = { repriced: new Set<string>(), held: [] as Array<{ product_id: string; code: string }> };
  for (let round = 0; round < 8; round++) {
    const fx = await repriceStaleEngineProducts({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { trigger: 'fx', budget: statementBudget(900) });
    fx.repriced.forEach((id) => out.repriced.add(id));
    out.held.push(...fx.blocked);
    if (!fx.deferred.length && !fx.repriced.length && !fx.blocked.length) break;
  }
  return out;
}

test('the margin under FX-5: twenty cheap parts under a 10% ceiling, then the dollar at 1,700 and the yuan up 2% — no route closes: FX-5 follows every one but the cheapest, which only its own 15% guard holds, and none sells at or under its new cost', async () => {
  const w = world();
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '1.5' WHERE key = 'makers_supply'`);
  // Makers-type parts at 5 to 36.35 CNY in a 50 × 50 × 20 mm box (20 IQD by sea): R from 1,220 to 8,744.
  const ids = Array.from({ length: 20 }, (_, i) => `p_mk${String(i).padStart(2, '0')}`);
  ids.forEach((id, i) => {
    seedProduct(w.raw, id, 'makers_supply', { weight: 10, box: [50, 50, 20] });
    tmall(w.raw, id, '', (5 + i * 1.65).toFixed(2));
  });
  await setType(w.app, 'makers_supply', { profit_cap_pct: '10' });
  const previews = await computePages(w.app, ids);
  for (let i = 0; i < ids.length; i += 5) {
    const out = await apply(w.app, ids.slice(i, i + 5).map((id) => ({ product_id: id, preview_hash: previews.get(id)!.preview_hash, confirm_large_change: true })));
    for (const id of ids.slice(i, i + 5)) assert.equal(out.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(out.get(id)).slice(0, 300)}`);
  }
  // Every one at its ceiling's price — a house price under $5, the two dearest on the grid ($5.49, $5.99) — that keeps
  // one rounding step over its cost (its line's cost is R rounded up). The cheapest, R 1,220: its ceiling 1,342 holds
  // 1,250, 30 over it — so 1,500.
  for (const id of ids) {
    onGrid(w.raw, id);
    const line = lineOf(previews.get(id)!);
    assert.ok(line.est_price_iqd - line.est_cost_iqd >= 249, `${id}: ${line.est_price_iqd} over ${line.est_cost_iqd}`);
  }
  assert.deepEqual([lineOf(previews.get('p_mk00')!).est_price_iqd, dollars(w.raw, 'p_mk18'), dollars(w.raw, 'p_mk19')], [1_500, [['', 549]], [['', 599]]]);

  for (const [pair, rate, held] of [
    ['USD_IQD', '1700', ['p_mk00 PRICING_V2_LARGE_CHANGE']],
    // The cheapest part is still held from the dollar's move: FX-5 retries a held product after 24 hours or a later
    // central rate (this fixture dates its rates earlier), and the owner has not reviewed it.
    ['CNY_USD', '0.153', []],
  ] as const) {
    applyRate(w.raw, pair, rate);
    const fx = await fxRun(w.raw);
    // No route closes (V2_ROUTE_BELOW_COST): FX-5's one hold is its own guard on a move of 15% or more, for the
    // owner's review — the cheapest part, whose next house price is one 250 IQD step up from 1,500: 1,295 + $0.175 ×
    // 1,700 = 1,592.5 → 1,750, +16.7%. It stays at its old price, above its new cost.
    assert.deepEqual([...new Set(fx.held.map((h) => `${h.product_id} ${h.code}`))], held, `${pair} ${rate}: FX-5 holds no route`);
    assert.equal(row<{ c: string | null }>(w.raw, "SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = 'p_mk00'")!.c, 'PRICING_V2_LARGE_CHANGE');
    assert.deepEqual([...fx.repriced].sort(), ids.slice(1), `${pair} ${rate}: every other product followed its cost`);
    assert.deepEqual(prices(w.raw, 'p_mk00'), [['', 1_500]], 'held at its old price');
    // None sells at or under its new cost: compute reads each cost at T (its first evaluation), writing nothing.
    const fresh = await computePages(w.app, ids);
    for (const id of ids) {
      const published = prices(w.raw, id)[0]![1] as number;
      assert.ok(published > lineOf(fresh.get(id)!).est_cost_iqd, `${pair} ${rate}: ${id} sells at ${published}, its cost now ${lineOf(fresh.get(id)!).est_cost_iqd}`);
    }
  }
});

/** The owner's own price points saved in the product form (the V2 door, its preview reviewed, the tick given). */
async function ownerPoints(app: App, pid: string, points: Json[]): Promise<void> {
  const stored = await json(await get(app, `/api/admin/products-v2/${pid}/pricing`));
  const pricing = { points };
  const sheet = await json(await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: stored.seq, pricing, preview_hash: sheet.details.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 300));
}

test('the owner’s own: his cost-first colour difference stays on top of the ceiling’s price; a model at his own fixed dollar price keeps T and his price', async () => {
  const w = world();
  // Two colours of the Nozzle shape, and two models of it (each R 3,659.5), applied at the type's $6: 13,500.
  seedProduct(w.raw, 'p_gold', 'spare_part', { colours: ['red', 'gold'] });
  tmall(w.raw, 'p_gold', 'c:p_gold_red', '15');
  tmall(w.raw, 'p_gold', 'c:p_gold_gold', '15');
  seedProduct(w.raw, 'p_fix', 'spare_part', { models: ['m1', 'm2'] });
  tmall(w.raw, 'p_fix', 'o:p_fix_m1', '15');
  tmall(w.raw, 'p_fix', 'o:p_fix_m2', '15');
  await computeAndApply(w.app, ['p_gold', 'p_fix']);
  // In the product form he adds +$1.30 on gold (3,659.5 + 9,600 + 2,080 → 15,500) and a fixed $20 on m1 (32,000).
  await ownerPoints(w.app, 'p_gold', [{ scope: 'color', scope_id: 'p_gold_gold', kind: 'delta', usd: '1.3' }]);
  await ownerPoints(w.app, 'p_fix', [{ scope: 'option', scope_id: 'p_fix_m1', kind: 'fixed', usd: '20' }]);
  assert.deepEqual(prices(w.raw, 'p_gold'), [
    ['c:p_gold_gold', 15_500],
    ['c:p_gold_red', 13_500],
  ]);
  assert.deepEqual(prices(w.raw, 'p_fix'), [
    ['o:p_fix_m1', 32_000],
    ['o:p_fix_m2', 13_500],
  ]);

  await setType(w.app, 'spare_part', { profit_cap_pct: '10' });
  const previews = await computeAndApply(w.app, ['p_gold', 'p_fix'], true);
  for (const id of ['p_gold', 'p_fix']) assert.equal(previews.get(id)!.blocking, false, `${id}: ${JSON.stringify(previews.get(id)!.blocked_by)}`);
  // Red 4,000; gold, his +$1.30 on top: its ceiling, 4,025.45 + 2,080 = 6,105.45, holds the house price 6,000 (T_sku
  // = floor6((6,000 − 5,739.5) ÷ 1,600) = $0.162812) — both under $5, one colour rule each.
  assert.deepEqual(prices(w.raw, 'p_gold'), [
    ['c:p_gold_gold', 6_000],
    ['c:p_gold_red', 4_000],
  ]);
  onGrid(w.raw, 'p_gold', [
    ['c:p_gold_gold', 375],
    ['c:p_gold_red', 250],
  ]);
  assert.deepEqual(ruleRows(w.raw, 'p_gold'), [
    ['color', 'p_gold_gold', 'ACTIVE', '0.162812'],
    ['color', 'p_gold_red', 'ACTIVE', '0.212812'],
    ['product', '', 'ACTIVE', '6'],
  ]);
  // m1 sells at his $20 and keeps T (its minimum profit is only its floor); m2 alone takes the ceiling, on its own rule.
  assert.deepEqual(prices(w.raw, 'p_fix'), [
    ['o:p_fix_m1', 32_000],
    ['o:p_fix_m2', 4_000],
  ]);
  assert.deepEqual(ruleRows(w.raw, 'p_fix'), [
    ['option', 'p_fix_m2', 'ACTIVE', '0.212812'],
    ['product', '', 'ACTIVE', '6'],
  ]);
  for (const p of (await compute(w.app, ['p_gold', 'p_fix'])).values()) {
    assert.ok((p.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), `${p.product_id}: nothing left to move`);
  }
});

test('the 62-SKU filament: 31 colours × spool / refill, the cost by colour, the box by model — no exact representation fits the wire, so its colours carry the dearer profit of their two: priced and applied, never blocked, never above today’s rule', async () => {
  const w = world();
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '7.5' WHERE key = 'filament'`);
  applyRate(w.raw, 'USD_IQD', '1690');
  const id = 'p_fil';
  const models = ['spool', 'refill'];
  const colours = Array.from({ length: 31 }, (_, i) => `k${String(i).padStart(2, '0')}`);
  const combos = models.flatMap((m) => colours.map((c) => [skuComboKey({ option_value_ids: [`${id}_${m}`], color_id: `${id}_${c}` }), c] as const));
  seedProduct(w.raw, id, 'filament', { models, colours, variants: combos.map(([k]) => k), weight: 1_200, box: [200, 200, 70] });
  // Each model its own package (the spool's box 70 mm high, the refill's 55); the price follows the colour (59–65 CNY).
  w.raw.exec(`UPDATE product_option_values SET package_depth_mm = 200, package_width_mm = 200, package_height_mm = CASE id WHEN ${q(`${id}_spool`)} THEN 70 ELSE 55 END, package_weight_g = 1100 WHERE product_id = ${q(id)}`);
  for (const [combo, c] of combos) tmall(w.raw, id, combo, String(59 + (Number(c.slice(1)) % 7)));
  // Priced at 1,690 at the type's $7.50, as before 2026-11-05.
  await computeAndApply(w.app, [id], true);
  // The rate falls to 1,600: today's rule prices it lower; under a 6% ceiling, lower still.
  applyRate(w.raw, 'USD_IQD', '1600');
  const today = (await compute(w.app, [id])).get(id)!;
  assert.equal(today.blocking, false, JSON.stringify(today.blocked_by));
  await setType(w.app, 'filament', { profit_cap_pct: '6' });
  const p = (await compute(w.app, [id])).get(id)!;
  assert.equal(p.blocking, false, JSON.stringify(p.blocked_by));
  assert.match(p.preview_hash, /^[0-9a-f]{64}$/);
  const shared = (p.flags as Json[]).find((f) => f.code === 'EST_CEILING_SHARED');
  assert.ok(shared, 'flagged: one SKU of each colour rides its sibling’s dearer profit');
  // Every line at or under today's rule at 1,600, and under the 1,690 price it replaces.
  const todayOf = new Map((today.lines as Json[]).map((l) => [l.combo_key as string, l.est_price_iqd as number]));
  assert.equal((p.lines as Json[]).length, 62);
  for (const l of p.lines as Json[]) assert.ok(l.est_price_iqd <= todayOf.get(l.combo_key)! && l.est_price_iqd < l.published_price_iqd, `${l.combo_key}: ${l.est_price_iqd}`);
  const done = (await apply(w.app, [{ product_id: id, preview_hash: p.preview_hash, confirm_large_change: true }])).get(id)!;
  assert.equal(done.outcome, 'applied', JSON.stringify(done).slice(0, 300));
  // One rule per colour (31, the wire takes 60) beside the type's $7.50 on the product.
  const written = rules(w.raw, id);
  assert.equal(written.filter((r) => r.scope === 'color' && r.state === 'ACTIVE').length, 31);
  assert.deepEqual(written.filter((r) => r.scope === 'product').map((r) => r.amount_usd), ['7.5']);
  // At least one SKU of each colour on the grid — the one whose profit its colour carries.
  const grid = dollars(w.raw, id).filter(([, c]) => c !== null && isCharmCents(c)).length;
  assert.ok(grid >= 31, `${grid} of 62 dollar prices on the grid`);
  assert.ok(((await compute(w.app, [id])).get(id)!.lines as Json[]).every((l) => l.est_price_iqd === l.published_price_iqd), 'nothing left to move');
});

/* ------------------------------ the ruling's two limits, through the real doors -- */

test('past 19 SKUs today’s plan stands at every compute: 62 SKUs at today’s dinar price keep T and the same hash; one colour’s supplier price moves to 450 CNY: 117,000 at $72.99 on rules of its own, not a shared 117,750; re-computed, moved again, at a new rate, the ceiling emptied — never blocked, every line as today’s code', async () => {
  const w = world();
  const id = 'p_many';
  // 31 colours × 2 models of one part ($6, ceiling 15%), the cost by colour, the box by model (119 × 50 × 25 mm, 59.5 IQD
  // by sea; 26 mm high, 61.88): x00–x29 at today's dinar price, $65.99's own 105,750, their dollar figures $66.00–$66.08;
  // x30 at 105,750 too, its figure already $65.99.
  const colours = Array.from({ length: 31 }, (_, i) => `x${String(i).padStart(2, '0')}`);
  const models = ['a', 'b'];
  const comboOf = (m: string, c: string) => skuComboKey({ option_value_ids: [`${id}_${m}`], color_id: `${id}_${c}` });
  seedProduct(w.raw, id, 'spare_part', { models, colours, variants: models.flatMap((m) => colours.map((c) => comboOf(m, c))) });
  w.raw.exec(`UPDATE product_option_values SET package_depth_mm = 119, package_width_mm = 50, package_height_mm = CASE id WHEN ${q(`${id}_a`)} THEN 25 ELSE 26 END, package_weight_g = 50 WHERE product_id = ${q(id)}`);
  const items = new Map(colours.map((c, i) => [c, models.map((m) => tmall(w.raw, id, comboOf(m, c), i < 30 ? (399.7 + 0.02 * i).toFixed(2) : '399.65'))] as const));
  const setCny = (c: string, cny: string) => {
    for (const item of items.get(c)!) w.raw.exec(`UPDATE supplier_price_skus SET price = ${q(cny)} WHERE snapshot_id = 'sps_tmall' AND item_key = ${q(item)}`);
  };
  const a00 = comboOf('a', 'x00');
  const a30 = comboOf('a', 'x30');
  const flagsOf = (p: Json) => (p.flags as Json[]).map((f) => f.code);
  const belowProduct = () => rules(w.raw, id).filter((r) => r.state === 'ACTIVE' && r.scope !== 'product').length;
  const est = (p: Json, combo: string) => lineOf(p, combo).est_price_iqd;
  const sold = (combo: string) => prices(w.raw, id).find(([k]) => k === combo)![1];
  const centsOf = (combo: string) => dollars(w.raw, id).find(([k]) => k === combo)![1];

  await computeAndApply(w.app, [id], true);
  const settled = (await compute(w.app, [id])).get(id)!;
  await setType(w.app, 'spare_part', { profit_cap_pct: '15' });
  // The ceiling leaves every price where it is. Past 19 SKUs no SKU takes c's own profit: the same hash, no rule.
  const capped = (await compute(w.app, [id])).get(id)!;
  assert.equal(capped.preview_hash, settled.preview_hash, 'today’s plan: nothing to write');
  await computeAndApply(w.app, [id]);
  assert.deepEqual([belowProduct(), sold(a00), centsOf(a00), sold(a30), centsOf(a30)], [0, 105_750, 6_600, 105_750, 6_599]);

  // x30's supplier price moves: 117,750 today, $72.99 = 117,000 under it, two SKU rules: exact, no flag. With the 60 at
  // today's dinar price on rules of their own it would be 60 to take back + 2: x30 shared at 117,750 and the 60 cleared.
  setCny('x30', '450');
  const moved = (await compute(w.app, [id])).get(id)!;
  assert.deepEqual([moved.blocking, flagsOf(moved).includes('EST_CEILING_SHARED'), est(moved, a30), est(moved, a00)], [false, false, 117_000, 105_750]);
  await computeAndApply(w.app, [id], true);
  assert.deepEqual([belowProduct(), sold(a30), centsOf(a30), sold(a00), centsOf(a00)], [2, 117_000, 7_299, 105_750, 6_600]);

  // x30 falls back within today's dinar price, its figure off c ($65.95): T. With 62 rules on record no wire could take
  // them back: EST_TOO_MANY_SCOPES on a re-compute with nothing changed, even with the ceiling emptied.
  setCny('x30', '399.40');
  await computeAndApply(w.app, [id], true);
  assert.deepEqual([belowProduct(), sold(a30), centsOf(a30)], [0, 105_750, 6_595]);
  const again = (await compute(w.app, [id])).get(id)!;
  assert.equal(again.blocking, false, JSON.stringify(again.blocked_by));
  assert.match(again.preview_hash, /^[0-9a-f]{64}$/);

  // The dollar at 1,605: x00 106,000 ($65.99's own dinar price), never blocked; nor with the ceiling emptied.
  applyRate(w.raw, 'USD_IQD', '1605');
  const dearer = (await compute(w.app, [id])).get(id)!;
  assert.deepEqual([dearer.blocking, est(dearer, a00), est(dearer, a30)], [false, 106_000, 106_000]);
  await setType(w.app, 'spare_part', { profit_cap_pct: null });
  assert.equal((await compute(w.app, [id])).get(id)!.blocking, false);
});

test('at the limit: 19 colours at today’s dinar price show c on rules of their own, one hash from compute to apply; 20 keep T and the hash they had with no ceiling', async () => {
  const w = world();
  const seedColours = (id: string, n: number) => {
    const colours = Array.from({ length: n }, (_, i) => `k${String(i).padStart(2, '0')}`);
    seedProduct(w.raw, id, 'spare_part', { colours });
    // 399.70 CNY up, by 0.02: 105,750 at $66.00–$66.06, $65.99's own dinar price.
    colours.forEach((c, i) => tmall(w.raw, id, skuComboKey({ option_value_ids: [], color_id: `${id}_${c}` }), (399.7 + 0.02 * i).toFixed(2)));
  };
  seedColours('p_19', 19);
  seedColours('p_20', 20);
  const ids = ['p_19', 'p_20'];
  await computeAndApply(w.app, ids);
  const settled = await compute(w.app, ids);
  await setType(w.app, 'spare_part', { profit_cap_pct: '15' });
  const capped = await compute(w.app, ids);
  assert.equal(capped.get('p_20')!.preview_hash, settled.get('p_20')!.preview_hash, '20 SKUs: today’s plan, nothing to write');
  assert.notEqual(capped.get('p_19')!.preview_hash, settled.get('p_19')!.preview_hash, '19 SKUs: a rule of its own for each');
  for (const id of ids) assert.deepEqual(capped.get(id)!.lines, settled.get(id)!.lines, `${id}: no dinar figure moves`);
  assert.equal((await compute(w.app, ['p_19'])).get('p_19')!.preview_hash, capped.get('p_19')!.preview_hash, 'deterministic');
  const out = await apply(
    w.app,
    ids.map((id) => ({ product_id: id, preview_hash: capped.get(id)!.preview_hash }))
  );
  for (const id of ids) assert.equal(out.get(id)!.outcome, 'applied', `${id}: ${JSON.stringify(out.get(id)).slice(0, 300)}`);
  assert.deepEqual(new Set(prices(w.raw, 'p_19').map(([, p]) => p)), new Set([105_750]));
  assert.deepEqual(new Set(dollars(w.raw, 'p_19').map(([, c]) => c)), new Set([6_599]));
  assert.equal(rules(w.raw, 'p_19').filter((r) => r.scope === 'color' && r.state === 'ACTIVE').length, 19);
  assert.deepEqual(new Set(prices(w.raw, 'p_20').map(([, p]) => p)), new Set([105_750]));
  assert.ok(dollars(w.raw, 'p_20').every(([, c]) => c !== 6_599), 'today’s own dollar figures');
  assert.deepEqual(rules(w.raw, 'p_20').map((r) => [r.scope, r.amount_usd]), [['product', '6']]);
  assert.equal(record(w.raw, 'p_19').minimum_profit_scopes.length, 19);
  assert.equal('minimum_profit_scopes' in record(w.raw, 'p_20'), false);
});

test('between applies FX-5 keeps c’s own profit in dollars: a SKU moved can sit one 250 IQD step from where T would sell it, above or under, its dollar figure still c — until the next compute and apply, which price it exactly as today’s code', async () => {
  const w = world();
  // Two parts at $6 under a ceiling that does not bind, both at $65.99's own 105,750: at T the first shows $65.94 (R
  // 95,903.5, T_sku $6.050312, above T), the second $66.09 (R 96,138.7, T_sku $5.903312, below T).
  seedProduct(w.raw, 'p_up', 'spare_part');
  tmall(w.raw, 'p_up', '', '399.35');
  seedProduct(w.raw, 'p_down', 'spare_part');
  tmall(w.raw, 'p_down', '', '400.33');
  const ids = ['p_up', 'p_down'];
  await computeAndApply(w.app, ids);
  assert.deepEqual([dollars(w.raw, 'p_up'), dollars(w.raw, 'p_down')], [[['', 6_594]], [['', 6_609]]]);
  await setType(w.app, 'spare_part', { profit_cap_pct: '25' });
  await computeAndApply(w.app, ids);
  const moved = ids.map((id) => rules(w.raw, id).map((r) => [r.scope, r.amount_usd]));
  assert.deepEqual(moved, [[['product', '6.050312']], [['product', '5.903312']]]);
  assert.deepEqual(ids.map((id) => [prices(w.raw, id), dollars(w.raw, id)]), [
    [[['', 105_750]], [['', 6_599]]],
    [[['', 105_750]], [['', 6_599]]],
  ]);

  // The cost and what today's code would sell it at, at a rate: the yuan at 0.15 USD, the box 59.5 IQD.
  const cost = (cny: string, u: string) => procurementExactText(addProcurementExact(mulProcurementExact(procurementExact(cny), procurementExact('0.15'), procurementExact(u)), procurementExact('59.5')));
  const atT = (cny: string, u: string) => roundPriceIqd(addProcurementExact(procurementExact(cost(cny, u)), mulProcurementExact(procurementExact('6'), procurementExact(u))));

  // The dollar at 1,607: FX-5 prices 96,322.8175 + $6.050312 × 1,607 → 106,250 where T sells it at 105,964.8 → 106,000: a
  // step ABOVE T's own price, until the owner's next compute and apply. The other lands on T's own 106,250.
  applyRate(w.raw, 'USD_IQD', '1607');
  const first = await fxRun(w.raw);
  assert.deepEqual([[...first.repriced].sort(), first.held], [['p_down', 'p_up'], []]);
  assert.deepEqual([prices(w.raw, 'p_up'), atT('399.35', '1607')], [[['', 106_250]], 106_000]);
  assert.deepEqual([prices(w.raw, 'p_down'), atT('400.33', '1607')], [[['', 106_250]], 106_250]);
  // The dollar at 1,650: the other way round: 109,000, a step UNDER T's own 109,250. The first lands on T's own 109,000.
  applyRate(w.raw, 'USD_IQD', '1650');
  await fxRun(w.raw);
  assert.deepEqual([prices(w.raw, 'p_up'), atT('399.35', '1650')], [[['', 109_000]], 109_000]);
  assert.deepEqual([prices(w.raw, 'p_down'), atT('400.33', '1650')], [[['', 109_000]], 109_250]);
  // FX-5 writes no rule, and the dollar figures stay c ($65.988… up to the cent).
  assert.deepEqual(ids.map((id) => rules(w.raw, id).map((r) => [r.scope, r.amount_usd])), moved);
  for (const id of ids) assert.deepEqual(dollars(w.raw, id), [['', 6_599]]);

  // The next compute reads the cost at T and prices it as today's code does; its apply puts each on its own price.
  const next = await compute(w.app, ids);
  for (const [id, cny] of [['p_up', '399.35'], ['p_down', '400.33']] as const) {
    const before = charmTargetBefore({ cost_iqd: cost(cny, '1650'), usd_iqd: '1650', min_profit_usd: '6', ceiling_pct: '25' })!;
    assert.equal(lineOf(next.get(id)!).est_price_iqd, before.price_iqd, `${id}: the next compute prices it as today’s code`);
  }
  assert.deepEqual(ids.map((id) => lineOf(next.get(id)!).est_price_iqd), [109_000, 109_000]);
  await computeAndApply(w.app, ids);
  assert.deepEqual(ids.map((id) => [prices(w.raw, id), dollars(w.raw, id)]), [
    [[['', 109_000]], [['', 6_599]]],
    [[['', 109_000]], [['', 6_599]]],
  ]);
});
