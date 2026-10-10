/**
 * FX-5 — AUTOMATIC REPRICING WHEN A CONFIRMED RATE CHANGES (FX programme plan
 * §7; USD design §6.5; owner decisions 10 and 11).
 *
 * Every scenario runs the real scheduler, the real owner routes and the real
 * engine writer on a real 0181 database with the 41 census products; the
 * providers are fakes, the edge cache a recorder. Proves:
 *   - a USD/IQD move above the dead band reprices an engine product within the
 *     SAME tick: the cart charges the new price, price − cost ≥ the minimum
 *     profit at the new rate, `engine_fx` history, values only in
 *     pricing_audit (`reprice_auto`), ids and codes in audit_log, the
 *     product's pages purged, the stale list empty;
 *   - below the band: no write and no purge;
 *   - REVIEW_REQUIRED changes nothing until the owner approves — the approval
 *     then reprices; a rejection reprices nothing;
 *   - deficit first, within the statement budget, carried over tick by tick
 *     until the stale list is empty — and the statements really executed never
 *     exceed the budget;
 *   - a product that cannot be repriced keeps its prices, stays on the stale
 *     list with its code, rings the bell once, and the others proceed;
 *   - a shipping rate change reprices as the owner's cost change (`engine_owner`);
 *   - manual products are never touched;
 *   - the multi-product price image reads exactly the single one the writer fences on;
 *   - the storefront never imports the repricing.
 *
 * Run: node --import tsx --test tests/fxRepricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, get, json, post, put, row } from './fixtures/app';
import { applyRate, fxEnv, market, pairOf } from './fixtures/fx';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { ROOT, SqliteD1, type SqliteStatement } from './fixtures/d1';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import { listPricedProducts, loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { evaluateLegacy } from '../worker/lib/pricingEngine/legacy';
import { priceImageOf, priceImagesEach, priceImagesOf } from '../worker/lib/pricingEngine/engineWrite';
import type { Env } from '../worker/lib/types';

type World = ReturnType<typeof pricingWorld>;

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};

const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

/** The owner's completing save through the product form: 409 with the preview, then the save with its hash. */
async function adoptWith(w: World, pid: string, draft: Record<string, unknown>): Promise<boolean> {
  const first = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft });
  if (first.status !== 409 || first.body.code !== 'PRICING_PREVIEW_REQUIRED') return false;
  const hash = first.body.details?.preview?.preview_hash;
  if (typeof hash !== 'string') return false;
  const saved = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft, preview_hash: hash, confirm_large_change: true });
  return saved.status === 200 && saved.body.mode === 'engine';
}

const adoptAms = async (w: World) => assert.equal(await adoptWith(w, AMS, COMPLETE), true, 'the brief product adopts');

/** A plain dollar product: USD supplier cost, Germany by land, $20 minimum profit, 15,000 IQD Direct Sale Extra. */
const usdDraft = (usd: number) => ({
  inputs: [{ scope: 'base', supplier_cost_amount: String(usd), supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '20' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 15_000 },
  ],
});

/** The first `n` census products (not the brief's) that adopt with a USD supplier cost each. */
async function adoptUsdProducts(w: World, costs: readonly number[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of await listPricedProducts(w.db)) {
    if (out.length === costs.length) break;
    if (p.id === AMS) continue;
    if (await adoptWith(w, p.id, usdDraft(costs[out.length]!))) out.push(p.id);
  }
  assert.equal(out.length, costs.length, 'enough census products adopt');
  return out;
}

/** What the cart charges a guest today, per model × channel (the live resolver). */
async function cartPrices(w: World, pid = AMS) {
  const loaded = (await loadProducts(w.db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(w.db);
  const ev = evaluateLegacy(pid, loaded.doc, loaded.view, ctx);
  return Object.fromEntries(ev.models.flatMap((m) => m.channels.filter((c) => c.ok).map((c) => [`${m.option_id}@${c.channel}`, { prepaid: c.prepaid_iqd, cod: c.cod_iqd }])));
}

/** Every customer-price column of the products named (and their relations), as stored. */
const priceImage = (w: World, ids: readonly string[]) =>
  JSON.stringify(
    ids.map((pid) => [
      all(w.raw, 'SELECT id, price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports, updated_at FROM products WHERE id = ?', pid),
      all(w.raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', pid),
    ])
  );

const engineIds = (w: World) => all<{ product_id: string }>(w.raw, "SELECT product_id FROM product_pricing_state WHERE mode = 'engine' ORDER BY product_id").map((r) => r.product_id);
const manualIds = (w: World) => all<{ id: string }>(w.raw, "SELECT id FROM products WHERE id NOT IN (SELECT product_id FROM product_pricing_state WHERE mode = 'engine') ORDER BY id").map((r) => r.id);

/** The edge cache as a recorder of purged paths (Workers' `caches.default`). */
function trapPurges() {
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  const paths: string[] = [];
  g.caches = {
    default: {
      delete: async (req: Request) => {
        paths.push(new URL(req.url).pathname);
        return true;
      },
      match: async () => undefined,
      put: async () => undefined,
    },
  };
  return {
    paths,
    restore() {
      if (before === undefined) delete g.caches;
      else g.caches = before;
    },
  };
}

const APEX = 'levonis-iq.com';
const envOf = (raw: DatabaseSync, db?: D1Database): Env => ({ ...fxEnv(raw), ...(db ? { DB: db } : {}), STORE_ROOT_DOMAIN: APEX }) as Env;

/** A market whose ECB figures equal the world's applied EUR/USD 1.1 and CNY/USD 0.14, so only USD/IQD moves. */
function usdOnlyMarket(sell: number, now: Date) {
  const m = market({ sell, usd: '1.1', cny: '7.857143' });
  m.state.at = now;
  m.state.ecbDay = now.toISOString().slice(0, 10);
  return m;
}

const cronTick = (w: World, m: ReturnType<typeof market>, now: Date) =>
  runFxScheduler(envOf(w.raw), { now, scheduledTime: now }, { trigger: 'cron', fetchImpl: m.f.fetch });

const ceil1000 = (n: number) => Math.ceil(n / 1000) * 1000;

// ------------------------------------------------------------- the same tick

test('a USD/IQD move above the dead band reprices the engine product within the same cron tick: price − cost ≥ the minimum profit, engine_fx, audited, purged', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const manual = manualIds(w);
  const manualBefore = priceImage(w, manual);
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, 992_000, '$620 × 1,600');
  const history0 = count(w.raw, 'SELECT COUNT(*) AS n FROM price_history');
  const trap = trapPurges();
  let report: Awaited<ReturnType<typeof runFxScheduler>>;
  try {
    const now = new Date();
    report = await cronTick(w, usdOnlyMarket(1632, now), now);
  } finally {
    trap.restore();
  }
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1632', 'a 2% move: inside every guard, above the 0.5% band');
  assert.deepEqual(report.checked.find((c) => c.pair === 'USD_IQD'), { pair: 'USD_IQD', result: 'APPLIED', code: null });
  assert.equal(report.ratesMoved, true);
  assert.deepEqual(report.repricing?.repriced, [AMS]);
  assert.deepEqual(report.repricing?.changed, [AMS]);
  assert.deepEqual(report.repricing?.blocked, []);

  // ceil_1000(EUR 450 × 1.1 × 1,632 + 2.5 kg × 3,200 + $120 × 1,632) = ceil_1000(1,011,680)
  const land = ceil1000(450 * 1.1 * 1632 + 2.5 * 3200 + 120 * 1632);
  assert.equal(land, 1_012_000);
  const cart = await cartPrices(w);
  assert.deepEqual(cart[`${AMS_MODEL}@pre_order_land`], { prepaid: land, cod: land + 50_000 });
  assert.deepEqual(cart[`${AMS_MODEL}@direct_sale`], { prepaid: land + 50_000, cod: land + 50_000 });

  // The floor at the NEW rate: price − replacement cost ≥ the minimum profit ($120 × 1,632).
  const costs = all<{ channel: string; computed_price_iqd: number; replacement_cost_iqd: number; target_profit_iqd: number; usd_iqd_rate: string; direct_sale_extra_iqd: number | null }>(
    w.raw,
    'SELECT channel, computed_price_iqd, replacement_cost_iqd, target_profit_iqd, usd_iqd_rate, direct_sale_extra_iqd FROM pricing_sku_costs WHERE product_id = ? ORDER BY channel',
    AMS
  );
  assert.equal(costs.length, 2);
  for (const c of costs) {
    assert.equal(c.usd_iqd_rate, '1632');
    assert.equal(c.target_profit_iqd, 120 * 1632);
    assert.ok(c.computed_price_iqd - c.replacement_cost_iqd >= c.target_profit_iqd, `${c.channel}: price − cost ≥ the minimum profit`);
  }

  // Owner decision 6's observations: FX-only, so `engine_fx`, with the U the price was computed at.
  const history = all<Record<string, unknown>>(w.raw, 'SELECT variant_key, old_iqd, new_iqd, usd_iqd_rate, price_source FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 2', AMS);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM price_history') - history0, 2);
  assert.deepEqual(history.map((h) => [h.variant_key, h.old_iqd, h.new_iqd, h.usd_iqd_rate, h.price_source]).sort(), [
    [`sku:o:${AMS_MODEL}@direct_sale`, 1_042_000, land + 50_000, '1632', 'engine_fx'],
    [`sku:o:${AMS_MODEL}@pre_order_land`, 992_000, land, '1632', 'engine_fx'],
  ]);

  // Values in the owner-only pricing audit; ids and codes in audit_log; one run record.
  const entry = row<{ action: string; idempotency_key: string; pricing_after_json: string; actor_id: string }>(
    w.raw,
    "SELECT action, idempotency_key, pricing_after_json, actor_id FROM pricing_audit WHERE entity = 'sku_price' AND product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    AMS
  )!;
  assert.equal(entry.action, 'reprice_auto');
  assert.match(entry.idempotency_key, /^auto:lp_08:[0-9a-f]{64}$/);
  assert.match(entry.pricing_after_json, /1012000/);
  assert.equal(entry.actor_id, 'system:fx');
  const log = row<{ actor_id: string | null; detail: string }>(w.raw, "SELECT actor_id, detail FROM audit_log WHERE action = 'pricing.engine.repriced_auto'")!;
  assert.equal(log.actor_id, null, 'the cron is the system');
  assert.doesNotMatch(log.detail, /1012000|1062000|1632|992000/, 'audit_log carries ids and codes only');
  assert.match(log.detail, /"reasons":\["EUR","USD"\]/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' AND action = 'run_finished'"), 1);

  // The product's pages and the shelves were purged (and the display rate's).
  const slug = row<{ slug: string }>(w.raw, 'SELECT slug FROM products WHERE id = ?', AMS)!.slug;
  assert.ok(trap.paths.includes(`/api/products/${slug}`), JSON.stringify(trap.paths));
  assert.ok(trap.paths.includes('/api/products'));
  assert.ok(trap.paths.includes('/api/settings/public'));

  // Nothing is left: the stale list is empty, the status says the last run; every token deleted.
  const list = await json(await get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(list.stale.count, 0);
  assert.equal(list.auto.active, false);
  assert.equal(list.auto.last_run.repriced, 1);
  assert.equal(list.auto.last_run.trigger, 'fx');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
  // Manual products: never touched.
  assert.equal(priceImage(w, manual), manualBefore);
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM price_history WHERE product_id <> '${AMS}'`), 0);
});

test('below the dead band: a check is recorded and nothing else — no price write, no history, no audit, no purge', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const image = priceImage(w, [AMS, ...manualIds(w)]);
  const stamps = JSON.stringify(all(w.raw, 'SELECT * FROM pricing_sku_costs ORDER BY product_id, combo_key, channel'));
  const before = {
    history: count(w.raw, 'SELECT COUNT(*) AS n FROM price_history'),
    audits: count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'),
    logs: count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'pricing.%'"),
    state: JSON.stringify(all(w.raw, 'SELECT * FROM product_pricing_state')),
  };
  const trap = trapPurges();
  let report: Awaited<ReturnType<typeof runFxScheduler>>;
  try {
    const now = new Date();
    report = await cronTick(w, usdOnlyMarket(1604, now), now);
  } finally {
    trap.restore();
  }
  assert.deepEqual(report.checked.find((c) => c.pair === 'USD_IQD'), { pair: 'USD_IQD', result: 'UNCHANGED', code: null }, '0.25% < 0.5%');
  assert.equal(report.ratesMoved, false);
  assert.equal(report.repricing?.skipped, 'NOTHING_STALE');
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600');
  assert.equal(priceImage(w, [AMS, ...manualIds(w)]), image);
  assert.equal(JSON.stringify(all(w.raw, 'SELECT * FROM pricing_sku_costs ORDER BY product_id, combo_key, channel')), stamps);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM price_history'), before.history);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), before.audits);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'pricing.%'"), before.logs);
  assert.equal(JSON.stringify(all(w.raw, 'SELECT * FROM product_pricing_state')), before.state);
  assert.deepEqual(trap.paths, [], 'nothing purged');
});

test('REVIEW_REQUIRED reprices nothing until the owner approves; the approval reprices at the Confirmed Rate; a rejection reprices nothing', async () => {
  for (const decision of ['reject', 'approve'] as const) {
    const w = pricingWorld();
    await adoptAms(w);
    const image = priceImage(w, [AMS]);
    const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
    const now = new Date();
    const report = await cronTick(w, usdOnlyMarket(1680, now), now);
    assert.deepEqual(report.checked.find((c) => c.pair === 'USD_IQD'), { pair: 'USD_IQD', result: 'REVIEW_HELD', code: 'ANOMALY' }, '5% > 3%: held');
    assert.equal(pairOf(w.raw, 'USD_IQD').status, 'REVIEW_REQUIRED');
    assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600', 'the Confirmed Rate stays in force');
    assert.equal(report.ratesMoved, false);
    assert.equal(priceImage(w, [AMS]), image, 'held: no price moved');
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);

    // An approval moves prices: it carries the hash of the preview the owner read (FX-5, §7.8; tests/fxRatePreview.test.ts).
    const preview_hash =
      decision === 'approve' ? (await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review/preview', {}))).preview.preview_hash : undefined;
    const trap = trapPurges();
    let res: Response;
    try {
      res = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: Number(pairOf(w.raw, 'USD_IQD').owner_version), decision, ...(preview_hash ? { preview_hash } : {}) });
    } finally {
      trap.restore();
    }
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
    if (decision === 'reject') {
      assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600');
      assert.equal(priceImage(w, [AMS]), image, 'rejected: no price moved');
      assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE action = 'reprice_auto'"), 0);
      assert.deepEqual(trap.paths, []);
      continue;
    }
    // Approved: 1,680 is the Confirmed Rate (the anchor moves with it) and the product is repriced at it.
    const pair = pairOf(w.raw, 'USD_IQD');
    assert.equal(pair.effective_rate, '1680');
    assert.equal(pair.drift_anchor_rate, '1680');
    const land = ceil1000(450 * 1.1 * 1680 + 2.5 * 3200 + 120 * 1680);
    assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, land);
    const entry = row<{ action: string; actor_id: string }>(w.raw, "SELECT action, actor_id FROM pricing_audit WHERE entity = 'sku_price' ORDER BY created_at DESC, rowid DESC LIMIT 1")!;
    assert.deepEqual(entry, { action: 'reprice_auto', actor_id: 'usr_owner' });
    const log = row<{ actor_id: string }>(w.raw, "SELECT actor_id FROM audit_log WHERE action = 'pricing.engine.repriced_auto'")!;
    assert.equal(log.actor_id, 'usr_owner', "the owner's act repriced");
    const slug = row<{ slug: string }>(w.raw, 'SELECT slug FROM products WHERE id = ?', AMS)!.slug;
    assert.ok(trap.paths.includes(`/api/products/${slug}`));
    const rates = await json(await get(w.app, '/api/admin/pricing/rates'));
    assert.equal(rates.stale_products, 0);
    assert.equal(rates.reprice_blocked, 0);
  }
});

// ------------------------------------------------------------- deficit first, the budget, carry-over

/** A D1 that counts every statement it executes (a batch counts each of its statements). */
class CountStmt {
  constructor(readonly inner: SqliteStatement, private readonly counter: { n: number }) {}
  get yieldsRows() {
    return this.inner.yieldsRows;
  }
  bind(...values: unknown[]) {
    return new CountStmt(this.inner.bind(...values), this.counter);
  }
  run() {
    this.counter.n += 1;
    return this.inner.run();
  }
  first<T = Record<string, unknown>>() {
    this.counter.n += 1;
    return this.inner.first<T>();
  }
  all<T = Record<string, unknown>>() {
    this.counter.n += 1;
    return this.inner.all<T>();
  }
}
class CountD1 {
  readonly counter = { n: 0 };
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) {
    this.inner = new SqliteD1(raw);
  }
  prepare(sql: string) {
    return new CountStmt(this.inner.prepare(sql), this.counter);
  }
  async batch(statements: CountStmt[]) {
    this.counter.n += statements.length;
    return this.inner.batch(statements.map((s) => s.inner));
  }
}

test('deficit first, within the statement budget, carried over tick by tick until the stale list is empty; the statements executed never exceed the budget', async () => {
  const w = pricingWorld();
  await adoptAms(w); // EUR 450 + $120: about $615 of dollar-priced cost and profit
  const [p900, p300, p100] = await adoptUsdProducts(w, [900, 300, 100]); // $920, $320, $120
  const manual = manualIds(w);
  const manualBefore = priceImage(w, manual);
  applyRate(w.raw, 'USD_IQD', '1700'); // +6.25%: every engine product is now below its new floor
  const listed = await json(await get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(listed.stale.count, 4);
  assert.equal(listed.auto.active, true);

  const BUDGET = 75;
  const order: string[] = [];
  const perProduct: number[] = [];
  for (let tick = 0; tick < 8; tick++) {
    const d1 = new CountD1(w.raw);
    const budget = statementBudget(BUDGET);
    const r = await sweepStaleEnginePrices(envOf(w.raw, d1 as unknown as D1Database), { trigger: 'sweep', budget });
    assert.ok(d1.counter.n <= BUDGET, `tick ${tick}: ${d1.counter.n} statements executed, budget ${BUDGET}`);
    assert.ok(d1.counter.n <= budget.used, `tick ${tick}: every executed statement was charged (${d1.counter.n} ≤ ${budget.used})`);
    assert.deepEqual(r.blocked, []);
    assert.deepEqual(r.conflicts, []);
    if (r.skipped === 'NOTHING_STALE') break;
    assert.ok(r.repriced.length >= 1, `tick ${tick} reprices at least one product`);
    assert.equal(r.repriced.length + r.deferred.length, 4 - order.length, 'the rest wait for the next tick');
    if (r.repriced.length) perProduct.push((r.statements - 20) / r.repriced.length);
    order.push(...r.repriced);
  }
  assert.deepEqual(order, [p900!, AMS, p300!, p100!], 'largest deficit first, then each tick takes up where the last stopped');
  assert.ok(perProduct.every((n) => n <= 40), `statements per repriced product ≤ 40 (${perProduct.join(', ')})`);
  const after = await json(await get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(after.stale.count, 0, 'the stale list is empty');
  assert.equal(after.auto.active, false);
  // Every product at the new rate keeps price − cost ≥ the minimum profit.
  for (const c of all<{ product_id: string; computed_price_iqd: number; replacement_cost_iqd: number; target_profit_iqd: number; usd_iqd_rate: string }>(
    w.raw,
    'SELECT product_id, computed_price_iqd, replacement_cost_iqd, target_profit_iqd, usd_iqd_rate FROM pricing_sku_costs'
  )) {
    assert.equal(c.usd_iqd_rate, '1700', c.product_id);
    assert.ok(c.computed_price_iqd - c.replacement_cost_iqd >= c.target_profit_iqd, c.product_id);
  }
  assert.deepEqual(engineIds(w).sort(), [AMS, p900!, p300!, p100!].sort());
  assert.equal(priceImage(w, manual), manualBefore, 'manual products never touched');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('a product that cannot be repriced keeps its prices, stays listed with its code, rings the bell once — and never blocks the others', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const [ok, refused] = await adoptUsdProducts(w, [300, 100]);
  // The brief's product loses its minimum profit outside the writer (as a broken older build would):
  // the engine can no longer price it.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1);
              DELETE FROM pricing_rules WHERE product_id = '${AMS}' AND kind = 'target_profit';
              DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}';`);
  // A second product's write is refused by the database itself.
  w.raw.exec(`CREATE TRIGGER test_refuse BEFORE INSERT ON pricing_sku_costs WHEN NEW.product_id = '${refused}' BEGIN SELECT RAISE(ABORT, 'INJECTED'); END;`);
  const amsImage = priceImage(w, [AMS]);
  const refusedImage = priceImage(w, [refused!]);
  applyRate(w.raw, 'USD_IQD', '1700');

  const r = await sweepStaleEnginePrices(envOf(w.raw), { trigger: 'sweep', budget: statementBudget(600) });
  assert.deepEqual(r.repriced, [ok!], 'the other product proceeds');
  assert.deepEqual(
    [...r.blocked].sort((a, b) => a.product_id.localeCompare(b.product_id)),
    [
      { product_id: AMS, code: 'TARGET_PROFIT_MISSING' },
      { product_id: refused!, code: 'COMMIT_REFUSED' },
    ].sort((a, b) => a.product_id.localeCompare(b.product_id))
  );
  assert.equal(priceImage(w, [AMS]), amsImage, 'the blocked product keeps its prices');
  assert.equal(priceImage(w, [refused!]), refusedImage, 'a refused batch changes nothing (atomic)');
  assert.equal(row<{ c: string }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', AMS)!.c, 'TARGET_PROFIT_MISSING');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);

  // Listed, with its code (never a figure), on the owner's page and in the counts.
  const list = await json(await get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(list.stale.count, 2);
  assert.deepEqual(
    (list.stale.items as Array<{ product_id: string; blocked_code: string | null }>).map((i) => [i.product_id, i.blocked_code]).sort(),
    [
      [AMS, 'TARGET_PROFIT_MISSING'],
      [refused!, 'COMMIT_REFUSED'],
    ].sort()
  );
  assert.equal(list.auto.blocked, 2);
  const rates = await json(await get(w.app, '/api/admin/pricing/rates'));
  assert.equal(rates.reprice_blocked, 2);
  assert.equal(rates.stale_products, 2);

  // The bell, once per product, no figure.
  const bells = all<{ body_ar: string; body_en: string; meta: string }>(w.raw, "SELECT body_ar, body_en, meta FROM user_notifications WHERE kind = 'fx_attention'");
  assert.equal(bells.length, 2);
  for (const b of bells) {
    assert.doesNotMatch(`${b.body_ar} ${b.body_en}`, /[0-9٠-٩]/);
    assert.equal(JSON.parse(b.meta).reason, 'reprice_blocked');
  }
  // The next tick does not spend its budget on them again (24 hours, or a new rate, or the owner's save).
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
  const again = await sweepStaleEnginePrices(envOf(w.raw), { trigger: 'sweep', budget: statementBudget(200) });
  assert.equal(again.skipped, 'NOTHING_STALE');
  assert.equal(again.stale, 2);
  assert.ok(again.statements <= 4, `one indexed read and the rates (${again.statements})`);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'fx_attention'"), 2, 'no second bell');

  // A day later it is tried again; still refused, same code: the clock moves, no second bell.
  w.raw.exec(`UPDATE product_pricing_state SET reprice_blocked_at = '2026-01-01T00:00:00.000Z' WHERE reprice_blocked_code IS NOT NULL`);
  const later = await sweepStaleEnginePrices(envOf(w.raw), { trigger: 'sweep', budget: statementBudget(200) });
  assert.equal(later.blocked.length, 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'fx_attention'"), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE reprice_blocked_at = '2026-01-01T00:00:00.000Z'"), 0);

  // The database refusal clears: the next try reprices it and clears its code.
  w.raw.exec('DROP TRIGGER test_refuse');
  w.raw.exec(`UPDATE product_pricing_state SET reprice_blocked_at = '2026-01-01T00:00:00.000Z' WHERE product_id = '${refused}'`);
  const healed = await sweepStaleEnginePrices(envOf(w.raw), { trigger: 'sweep', budget: statementBudget(200) });
  assert.deepEqual(healed.repriced, [refused!]);
  assert.equal(row<{ c: string | null }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', refused)!.c, null);
});

test("a central shipping rate the owner changes reprices the products on that route — the owner's cost change (engine_owner)", async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const version = row<{ v: number }>(w.raw, "SELECT version AS v FROM pricing_shipping_rates WHERE profile = 'GERMANY_LAND'")!.v;
  const { preview } = await json(await post(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND/preview', { rate_iqd: '3400' }));
  const res = await put(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND', { version, rate_iqd: '3400', preview_hash: preview.preview_hash });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  // ceil_1000(EUR 450 × 1.1 × 1,600 + 2.5 kg × 3,400 + $120 × 1,600) = ceil_1000(992,500)
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, 993_000);
  assert.equal(ceil1000(450 * 1.1 * 1600 + 2.5 * 3400 + 120 * 1600), 993_000);
  const sources = all<{ s: string }>(w.raw, "SELECT DISTINCT price_source AS s FROM price_history WHERE batch_id LIKE 'fx_%'").map((r) => r.s);
  assert.deepEqual(sources, ['engine_owner']);
  const log = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'pricing.engine.repriced_auto'")!;
  assert.match(log.detail, /"trigger":"shipping"/);
  assert.match(log.detail, /"reasons":\["GERMANY_LAND"\]/);
});

// ------------------------------------------------------------- the image, and the customer path

test('the multi-product price image reads exactly the single image every engine write is fenced on (the whole census)', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const ids = (await listPricedProducts(w.db)).map((p) => p.id);
  const images = await priceImagesOf(w.db, [...ids, 'no_such_product']);
  const each = await priceImagesEach(w.db, ids);
  for (const id of ids) {
    const single = await priceImageOf(w.db, id);
    assert.equal(images.get(id), single, id);
    assert.equal(each.get(id), single, id);
  }
  assert.equal(images.get('no_such_product'), await priceImageOf(w.db, 'no_such_product'));

  // An engine that refuses the correlated one-statement form: the run falls back to one image per product and still reprices.
  applyRate(w.raw, 'USD_IQD', '1700');
  const refusing = new Proxy(w.db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('j.value AS product_id')) throw new Error('D1_ERROR: unsupported correlated subquery');
          return target.prepare(sql);
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const r = await sweepStaleEnginePrices(envOf(w.raw, refusing), { trigger: 'sweep', budget: statementBudget(200) });
  assert.deepEqual(r.repriced, [AMS]);
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, ceil1000(450 * 1.1 * 1700 + 2.5 * 3200 + 120 * 1700));
});

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') tsFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const importersOf = (pattern: RegExp) =>
  [...tsFiles(join(ROOT, 'worker')), ...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'packages')), ...tsFiles(join(ROOT, 'services'))]
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .sort();

test('static: the storefront never imports the repricing or the engine — only the cron, the FX run and the owner door do', () => {
  assert.deepEqual(importersOf(/from\s+['"][^'"]*fx\/reprice['"]|from\s+['"]\.\/reprice['"]/), ['worker/index.ts', 'worker/lib/fx/scheduler.ts', 'worker/routes/adminPricing.ts']);
  assert.deepEqual(importersOf(/from\s+['"][^'"]*(pricingEngine\/|\.\/)autoReprice['"]/), [
    'worker/lib/fx/read.ts',
    'worker/lib/fx/reprice.ts',
    'worker/lib/fx/scheduler.ts',
    'worker/lib/pricingEngine/ratePreview.ts',
    'worker/routes/adminPricing.ts',
  ]);
  // The client and every customer route import nothing of the engine.
  for (const f of tsFiles(join(ROOT, 'src'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /from\s+['"][^'"]*(pricingEngine|fx\/reprice)[^'"]*['"]/, relative(ROOT, f));
  for (const f of ['worker/routes/products.ts', 'worker/routes/cart.ts', 'worker/routes/orders.ts', 'worker/routes/misc.ts', 'worker/routes/catalog.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*(pricingEngine\/(autoReprice|engineWrite|writer)|fx\/(reprice|scheduler))['"]/, f);
  }
});

// ------------------------------------------------------------- the owner's words

test('«يُعاد التسعير تلقائياً» on «التسعير والشحن» and in the rates panel, in ar, en and real Sorani; the bell carries no figure', async () => {
  const { ENGINE_SAVE_STRINGS } = await import('../src/components/adminOperations/engineSaveStrings');
  const { REPRICE_BLOCKED_NOTICE } = await import('../worker/lib/fx/notify');
  assert.equal(ENGINE_SAVE_STRINGS.ar.autoTitle, 'يُعاد التسعير تلقائياً');
  for (const k of ['autoTitle', 'autoActive', 'autoIdle', 'autoPaused', 'autoLastRun', 'autoBlocked', 'blockedLine'] as const) {
    const text = (lang: 'ar' | 'en' | 'ckb') => {
      const v = ENGINE_SAVE_STRINGS[lang][k] as unknown;
      return typeof v === 'function' ? (v as (...a: string[]) => string)('X', 'Y') : String(v);
    };
    assert.notEqual(text('ckb'), text('ar'), k);
    assert.match(text('ckb'), /[ڕڵێۆەڤ]/, `${k}: Sorani`);
    assert.doesNotMatch(text('ckb'), /[ةىيك]/, `${k}: an Arabic-only letter in the Sorani`);
    assert.doesNotMatch(text('en'), /[؀-ۿ]/, k);
  }
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.doesNotMatch(`${REPRICE_BLOCKED_NOTICE.title[lang]} ${REPRICE_BLOCKED_NOTICE.body[lang]}`, /[0-9٠-٩۰-۹]/, lang);
  }
  assert.doesNotMatch(`${REPRICE_BLOCKED_NOTICE.title.ckb} ${REPRICE_BLOCKED_NOTICE.body.ckb}`, /[ةىيك]/);
  assert.match(REPRICE_BLOCKED_NOTICE.body.ckb, /[ڕڵێۆەڤ]/);
  // The status line sits in the stale list, which both screens mount.
  const list = readFileSync(join(ROOT, 'src/components/adminPricing/EngineSaveList.tsx'), 'utf8');
  assert.match(list, /<AutoRepriceLine /);
  assert.match(list, /data-engine-blocked-code/);
  assert.match(readFileSync(join(ROOT, 'src/components/adminPricing/RatesPanel.tsx'), 'utf8'), /<EngineSaveList lang=\{lang\} compact/);
  assert.match(readFileSync(join(ROOT, 'src/components/adminPricing/AdminPricing.tsx'), 'utf8'), /<EngineSaveList lang=\{lang\} \/>/);
});
