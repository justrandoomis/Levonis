/**
 * FX-5 — THE PREVIEW BEFORE AN OWNER RATE ACT (FX programme plan §7.8, §8;
 * owner decisions 8 and 11).
 *
 * Every scenario runs the real owner routes, the real engine writer and the
 * real automatic repricing on a real 0181 database with the 41 census
 * products. Proves:
 *   - …/manual/preview, …/review/preview and …/shipping/:profile/preview
 *     answer the repricing the act would cause — every affected engine
 *     product, today's customer price → the new one per model × channel, the
 *     deficit, the flags — and WRITE NOTHING;
 *   - once a product is engine-priced, the act without `preview_hash` is 409
 *     PRICING_PREVIEW_REQUIRED with the preview, a hash read before something
 *     moved is 409 PRICING_PREVIEW_STALE with a fresh one, and neither writes;
 *   - with the hash the act commits and the cart then charges exactly the
 *     preview's new prices;
 *   - a customer price moving more than 15% needs the explicit confirmation;
 *   - a stale session is refused (401 REAUTH_REQUIRED) and the preview says so
 *     beforehand (`fresh_sign_in`);
 *   - no engine product: the acts answer as before, no hash needed;
 *   - every key of the preview is classified, every amount in the net.
 *
 * Run: node --import tsx --test tests/fxRatePreview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { count, get, json, post, put, row } from './fixtures/app';
import { fxEnv, market, pairOf } from './fixtures/fx';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { loadPreviewContext, loadProducts, listPricedProducts } from '../worker/lib/pricingEngine/load';
import { evaluateLegacy } from '../worker/lib/pricingEngine/legacy';
import { previewRateAct } from '../worker/lib/pricingEngine/ratePreview';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import type { Env } from '../worker/lib/types';

type World = ReturnType<typeof pricingWorld>;

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};
const usdDraft = (usd: number) => ({
  inputs: [{ scope: 'base', supplier_cost_amount: String(usd), supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '20' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 15_000 },
  ],
});

const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

async function adoptWith(w: World, pid: string, draft: Record<string, unknown>): Promise<boolean> {
  const first = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft });
  if (first.status !== 409 || first.body.code !== 'PRICING_PREVIEW_REQUIRED') return false;
  const hash = first.body.details?.preview?.preview_hash;
  if (typeof hash !== 'string') return false;
  const saved = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft, preview_hash: hash, confirm_large_change: true });
  return saved.status === 200 && saved.body.mode === 'engine';
}
const adoptAms = async (w: World) => assert.equal(await adoptWith(w, AMS, COMPLETE), true, 'the brief product adopts');

async function adoptUsdProducts(w: World, costs: readonly number[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of await listPricedProducts(w.db)) {
    if (out.length === costs.length) break;
    if (p.id === AMS) continue;
    if (await adoptWith(w, p.id, usdDraft(costs[out.length]!))) out.push(p.id);
  }
  assert.equal(out.length, costs.length);
  return out;
}

async function cartPrices(w: World, pid = AMS) {
  const loaded = (await loadProducts(w.db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(w.db);
  const ev = evaluateLegacy(pid, loaded.doc, loaded.view, ctx);
  return Object.fromEntries(ev.models.flatMap((m) => m.channels.filter((c) => c.ok).map((c) => [`${m.option_id}@${c.channel}`, c.prepaid_iqd])));
}

/** Every table but the rate limiter's and the security log's, hashed row by row. */
function snapshot(raw: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'security_events') ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = (raw.prepare(`SELECT * FROM "${name}"`).all() as object[]).map((r) => JSON.stringify(r)).sort();
    out.set(name, createHash('sha256').update(rows.join('\n')).digest('hex'));
  }
  return out;
}
const changed = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter((k) => a.get(k) !== b.get(k));

const ceil1000 = (n: number) => Math.ceil(n / 1000) * 1000;
/** The brief's product at U and the Germany-land rate: ceil_1000(EUR 450 × 1.1 × U + 2.5 kg × rate + $120 × U), in whole dinars (no float). */
const amsLand = (u: number, ship = 3200) => ceil1000(495 * u + (5 * ship) / 2 + 120 * u);
const ownerVersion = (w: World, pair = 'USD_IQD') => Number(pairOf(w.raw, pair as 'USD_IQD').owner_version);
const shipVersion = (w: World, profile = 'GERMANY_LAND') => row<{ v: number }>(w.raw, 'SELECT version AS v FROM pricing_shipping_rates WHERE profile = ?', profile)!.v;

type PreviewRow = { product_id: string; option_id: string; channel: string; today_prepaid_iqd: number; computed_price_iqd: number; change_pct: string; deficit_iqd: number; large: boolean };

// ------------------------------------------------------------- the manual rate

test('a manual rate: the preview lists the engine product old → new and writes nothing; the act without the hash is 409 PRICING_PREVIEW_REQUIRED with that preview; with it, the cart charges exactly the preview', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const before = snapshot(w.raw);
  const res = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const { preview } = await json(res);
  assert.deepEqual(changed(before, snapshot(w.raw)), [], 'the preview wrote nothing');
  assert.deepEqual(preview.act, { kind: 'manual', pair: 'USD_IQD', profile: null, effective_before: '1600', effective_after: '1650' });
  assert.equal(preview.engine_products, 1);
  assert.deepEqual(preview.affected, { products: 1, models: 2 });
  assert.equal(preview.changed_products, 1);
  assert.deepEqual(preview.blocked, []);
  assert.equal(preview.follows, 0);
  assert.match(preview.preview_hash, /^[0-9a-f]{64}$/);
  // ceil_1000(EUR 450 × 1.1 × 1,650 + 2.5 kg × 3,200 + $120 × 1,650)
  const land = amsLand(1650);
  const rows = preview.rows as PreviewRow[];
  const pre = rows.find((r) => r.channel === 'pre_order_land')!;
  assert.deepEqual([pre.product_id, pre.option_id, pre.today_prepaid_iqd, pre.computed_price_iqd], [AMS, AMS_MODEL, 992_000, land]);
  assert.equal(pre.change_pct, (((land - 992_000) / 992_000) * 100).toFixed(2));
  // The deficit: the new floor (replacement cost + minimum profit at 1,650) above today's price.
  assert.equal(pre.deficit_iqd, 495 * 1650 + 8000 + 120 * 1650 - 992_000);
  assert.ok(pre.deficit_iqd > 0, 'today the price lies below the new floor');
  const direct = rows.find((r) => r.channel === 'direct_sale')!;
  assert.equal(direct.computed_price_iqd, land + 50_000);

  // The act without the hash: 409 with the same preview; nothing moves.
  const missing = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1650' });
  assert.equal(missing.status, 409);
  const missingBody = await json(missing);
  assert.equal(missingBody.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(missingBody.details.preview.preview_hash, preview.preview_hash);
  assert.deepEqual(missingBody.details.preview.rows, preview.rows);
  assert.deepEqual(changed(before, snapshot(w.raw)), [], 'a refused act wrote nothing');
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600');

  // With the hash: the rate moves, the engine reprices, the cart charges exactly what the preview said.
  const ok = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1650', preview_hash: preview.preview_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1650');
  const cart = await cartPrices(w);
  for (const r of rows) assert.equal(cart[`${r.option_id}@${r.channel}`], r.computed_price_iqd, `${r.channel}: the cart charges the preview's price`);
  assert.equal((await json(await get(w.app, '/api/admin/pricing/rates'))).stale_products, 0);
});

test('a stale hash: something moved between the preview and the act → 409 PRICING_PREVIEW_STALE with a fresh preview; nothing written', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const first = (await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' }))).preview;
  // The owner's central shipping rate moves meanwhile (the product's replacement cost moves with it).
  w.raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3300', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  const before = snapshot(w.raw);
  const res = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1650', preview_hash: first.preview_hash });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'PRICING_PREVIEW_STALE');
  const fresh = body.details.preview;
  assert.notEqual(fresh.preview_hash, first.preview_hash);
  const land = amsLand(1650, 3300);
  assert.equal((fresh.rows as PreviewRow[]).find((r) => r.channel === 'pre_order_land')!.computed_price_iqd, land, 'the fresh preview prices at the shipping rate now in force');
  assert.deepEqual(changed(before, snapshot(w.raw)), []);
  // A different rate than the one previewed is stale too.
  const other = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1660', preview_hash: fresh.preview_hash });
  assert.equal((await json(other)).code, 'PRICING_PREVIEW_STALE');
  // The fresh one goes through.
  const ok = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1650', preview_hash: fresh.preview_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`], land);
});

// ------------------------------------------------------------- approving a held rate

test('approving a held rate: the review preview prices at the candidate (the market figure at the CURRENT adjustment); the approval needs its hash and then charges exactly it', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const now = new Date();
  const m = market({ sell: 1680, usd: '1.1', cny: '7.857143' });
  m.state.at = now;
  m.state.ecbDay = now.toISOString().slice(0, 10);
  const report = await runFxScheduler({ ...fxEnv(w.raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { now, scheduledTime: now }, { trigger: 'cron', fetchImpl: m.f.fetch });
  assert.deepEqual(report.checked.find((c) => c.pair === 'USD_IQD'), { pair: 'USD_IQD', result: 'REVIEW_HELD', code: 'ANOMALY' });
  const before = snapshot(w.raw);
  const res = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review/preview', {});
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const { preview } = await json(res);
  assert.deepEqual(changed(before, snapshot(w.raw)), [], 'the preview wrote nothing');
  assert.deepEqual(preview.act, { kind: 'review', pair: 'USD_IQD', profile: null, effective_before: '1600', effective_after: '1680' });
  const land = amsLand(1680);
  assert.equal((preview.rows as PreviewRow[]).find((r) => r.channel === 'pre_order_land')!.computed_price_iqd, land);

  const missing = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: ownerVersion(w), decision: 'approve' });
  assert.equal((await json(missing)).code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(pairOf(w.raw, 'USD_IQD').status, 'REVIEW_REQUIRED', 'still held');
  // A rejection moves no price: no preview needed.
  const ok = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: ownerVersion(w), decision: 'approve', preview_hash: preview.preview_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1680');
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`], land);

  // Nothing held any more: the review preview answers 409 FX_REVIEW_NOT_PENDING, like the act.
  assert.equal((await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review/preview', {}))).code, 'FX_REVIEW_NOT_PENDING');
});

test('a rejection and «أبقِ سعري الحالي يدويًا» move no price: no preview is asked for', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const now = new Date();
  const m = market({ sell: 1680, usd: '1.1', cny: '7.857143' });
  m.state.at = now;
  m.state.ecbDay = now.toISOString().slice(0, 10);
  await runFxScheduler(fxEnv(w.raw), { now, scheduledTime: now }, { trigger: 'cron', fetchImpl: m.f.fetch });
  const res = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: ownerVersion(w), decision: 'reject' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600');
});

// ------------------------------------------------------------- the adjustment and a shipping rate

test('the adjustment: …/manual/preview {market_adjustment_iqd} previews the move; the settings act needs its hash', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const res = await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { market_adjustment_iqd: '20' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const { preview } = await json(res);
  assert.deepEqual(preview.act, { kind: 'adjustment', pair: 'USD_IQD', profile: null, effective_before: '1600', effective_after: '1620' });
  const land = amsLand(1620);
  assert.equal((preview.rows as PreviewRow[]).find((r) => r.channel === 'pre_order_land')!.computed_price_iqd, land);
  const missing = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/settings', { owner_version: ownerVersion(w), market_adjustment_iqd: '20' });
  assert.equal((await json(missing)).code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(pairOf(w.raw, 'USD_IQD').market_adjustment_iqd, '0');
  const ok = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/settings', { owner_version: ownerVersion(w), market_adjustment_iqd: '20', preview_hash: preview.preview_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1620');
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`], land);
  // Neither body field, or both: refused by name.
  assert.equal((await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', {}))).code, 'PRICING_INPUT_INVALID');
  assert.equal((await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650', market_adjustment_iqd: '1' }))).code, 'PRICING_INPUT_INVALID');
  assert.equal((await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650', owner_version: 1 }))).code, 'UNKNOWN_FIELD');
});

test('a central shipping rate: the preview lists the products on that route; the act needs its hash; a product on another route is not affected', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const res = await post(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND/preview', { rate_iqd: '3400' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const { preview } = await json(res);
  assert.deepEqual(preview.act, { kind: 'shipping', pair: null, profile: 'GERMANY_LAND', effective_before: '3200', effective_after: '3400' });
  assert.equal((preview.rows as PreviewRow[]).find((r) => r.channel === 'pre_order_land')!.computed_price_iqd, 993_000);
  const air = (await json(await post(w.app, '/api/admin/pricing/rates/shipping/CHINA_AIR/preview', { rate_iqd: '21000' }))).preview;
  assert.deepEqual(air.affected, { products: 0, models: 0 }, 'no engine product ships by China air');

  const missing = await put(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND', { version: shipVersion(w), rate_iqd: '3400' });
  assert.equal((await json(missing)).code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(row<{ r: string }>(w.raw, "SELECT rate_iqd AS r FROM pricing_shipping_rates WHERE profile = 'GERMANY_LAND'")!.r, '3200');
  const ok = await put(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND', { version: shipVersion(w), rate_iqd: '3400', preview_hash: preview.preview_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`], 993_000);
  // China air: no engine product on it, but one is engine-priced — the hash is still asked for (§8).
  const airAct = await put(w.app, '/api/admin/pricing/rates/shipping/CHINA_AIR', { version: shipVersion(w, 'CHINA_AIR'), rate_iqd: '21000' });
  assert.equal((await json(airAct)).code, 'PRICING_PREVIEW_REQUIRED');
});

// ------------------------------------------------------------- 15%, the fresh sign-in, no engine product

test('a customer price moving more than 15%: the preview flags it and the act needs the explicit confirmation as well as the hash', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  // A 40% shipping move is not 15% of the price; a rate of 1,900 (+18.75%) is.
  const { preview } = await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1900' }));
  assert.equal(preview.large_change, true);
  assert.ok((preview.rows as PreviewRow[]).every((r) => r.large));
  const unconfirmed = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1900', preview_hash: preview.preview_hash });
  assert.equal((await json(unconfirmed)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1600');
  const ok = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', {
    owner_version: ownerVersion(w),
    rate: '1900',
    preview_hash: preview.preview_hash,
    confirm_large_change: true,
  });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`], amsLand(1900));
});

test('a session older than ten minutes: the preview says a fresh sign-in is needed; the act with the hash is 401 REAUTH_REQUIRED and writes nothing', async () => {
  const fresh = pricingWorld();
  await adoptAms(fresh);
  const stale = pricingWorld({ raw: fresh.raw, sessionAgeSeconds: 3600 });
  const { preview } = await json(await post(stale.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' }));
  assert.equal(preview.fresh_sign_in, true);
  assert.equal((await json(await post(fresh.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' }))).preview.fresh_sign_in, false);
  const before = snapshot(fresh.raw);
  const res = await put(stale.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(fresh), rate: '1650', preview_hash: preview.preview_hash });
  assert.equal(res.status, 401);
  assert.equal((await json(res)).code, 'REAUTH_REQUIRED');
  assert.deepEqual(changed(before, snapshot(fresh.raw)), []);
});

test('no engine-priced product: the acts need no hash (FX-1 behaviour); the preview answers an empty list', async () => {
  const w = pricingWorld();
  const { preview } = await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' }));
  assert.equal(preview.engine_products, 0);
  assert.deepEqual(preview.rows, []);
  assert.equal(preview.fresh_sign_in, false);
  const res = await put(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: ownerVersion(w), rate: '1650' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const ship = await put(w.app, '/api/admin/pricing/rates/shipping/GERMANY_LAND', { version: shipVersion(w), rate_iqd: '3400' });
  assert.equal(ship.status, 200, JSON.stringify(await json(ship.clone())));
});

// ------------------------------------------------------------- deficit order, blocked products, the 15-minute tail

test('several products: rows in deficit order, a product the engine cannot price listed with its code (never a figure), and the tail the budget leaves to the sweep', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const [p900, p300, p100] = await adoptUsdProducts(w, [900, 300, 100]);
  // The brief's product loses its minimum profit outside the writer: the engine can no longer price it.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1);
              DELETE FROM pricing_rules WHERE product_id = '${AMS}' AND kind = 'target_profit';
              DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}';`);
  const { preview } = await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1700' }));
  assert.equal(preview.engine_products, 4);
  assert.equal(preview.affected.products, 4);
  assert.equal(preview.affected.models, preview.rows.length);
  const order = [...new Set((preview.rows as PreviewRow[]).map((r) => r.product_id))];
  assert.deepEqual(order, [p900, p300, p100], 'largest deficit first, as the run writes them');
  assert.equal(preview.blocked.length, 1);
  assert.equal(preview.blocked[0].product_id, AMS);
  assert.equal(preview.blocked[0].code, 'TARGET_PROFIT_MISSING');
  assert.deepEqual(Object.keys(preview.blocked[0]).sort(), ['code', 'name_ar', 'name_ckb', 'name_en', 'product_id']);
  assert.equal(preview.follows, 0, 'four products fit in one request');

  // With a request budget that covers about one product, the rest follow on the sweep.
  const rates = (await loadPricingRates(w.db))!;
  const move = { kind: 'fx' as const, act: 'manual' as const, pair: 'USD_IQD' as const, owner_version: ownerVersion(w), before: '1600', after: '1700', clears_pending: true };
  const roomy = await previewRateAct(w.db, move, rates, 600);
  const tight = await previewRateAct(w.db, move, rates, 80);
  const none = await previewRateAct(w.db, move, rates, 0);
  assert.equal(roomy.preview.follows, 0);
  assert.ok(tight.preview.follows >= 1 && tight.preview.follows <= 2, `follows ${tight.preview.follows}`);
  assert.equal(none.preview.follows, 3, 'no room: all three follow within 15 minutes');
  assert.equal(tight.preview.preview_hash, roomy.preview.preview_hash, 'the budget never changes the hash');
  assert.ok(roomy.statements <= 20, `the preview reads in a constant number of statements (${roomy.statements})`);
});

// ------------------------------------------------------------- the keys

test('every key of the preview is classified: amounts in FINANCIAL_FIELDS, the rest codes, names, counts and flags', async () => {
  const w = pricingWorld();
  await adoptAms(w);
  const { preview } = await json(await post(w.app, '/api/admin/pricing/rates/fx/USD_IQD/manual/preview', { rate: '1650' }));
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk(preview);
  const LIST = new Set<string>(FINANCIAL_FIELDS as readonly string[]);
  const money = [...keys].filter((k) => /_iqd$|_pct$|^effective_|_hash$/.test(k));
  assert.deepEqual(money.filter((k) => !LIST.has(k)), [], 'every amount, rate, percentage and hash is in the net');
  for (const k of ['today_prepaid_iqd', 'computed_price_iqd', 'change_iqd', 'change_pct', 'deficit_iqd', 'effective_before', 'effective_after', 'preview_hash']) assert.ok(keys.has(k), k);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'fx.%'"), 0, 'a preview is no act');
  const non = [...keys].filter((k) => !LIST.has(k)).sort();
  assert.deepEqual(non, [
    'act', 'affected', 'blocked', 'changed_products', 'channel', 'combo_key', 'drop_flag', 'engine_products', 'follows', 'fresh_sign_in', 'kind', 'large', 'large_change',
    'model_ar', 'model_ckb', 'model_en', 'models', 'name_ar', 'name_ckb', 'name_en', 'option_id', 'pair', 'product_id', 'products', 'profile', 'rows',
  ]);
});
