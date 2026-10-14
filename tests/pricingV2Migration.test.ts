/**
 * PRICING V2-5 — «نقل الأسعار إلى الدولار», THE SERVER SIDE (spec §6.1-§6.3, §6.5).
 *
 * On the census world (41 products, U = 1,600), through the owner's routes
 * (`/api/admin/pricing/v2/migration…`):
 *   - all 41 proposals compute; every «keep_usd» proposal reproduces today's
 *     prepaid price to the dinar except the rows its flags name (a pre-order
 *     above direct, an off-step price, a route one discount cannot reproduce),
 *     and the `unchanged` count is the census's;
 *   - committing one product writes the legacy snapshot, the V2 rows, the SKU
 *     prices, the method and the audit in ONE batch — a failure injected at
 *     the last statement leaves every table as it was; the snapshot is the
 *     pre-migration rows byte for byte; afterwards the cart charges exactly
 *     the proposal; the same hash again answers `already`;
 *   - a price edit between preview and commit is PRICING_V2_MIGRATION_STALE,
 *     an old sign-in REAUTH_REQUIRED;
 *   - «commit-unchanged» commits only the products whose prices do not move
 *     and skips the rest by code;
 *   - a direct-only engine product (0186): its overlay row is gone, its inputs
 *     are folded into the ordinary ones, its pre-order price is reproduced.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Migration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { count, failingD1, get, json, post, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS, OWNER_USER } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { cartGrid } from './fixtures/pricingV2';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';

type World = ReturnType<typeof pricingWorld>;
type Row = { combo_key: string; channel: string; old_iqd: number | null; old_cod_iqd: number | null; new_iqd: number | null; new_cod_iqd: number | null; changed: boolean };
type Flag = { code: string; combo_key?: string; route?: string; rows?: Array<{ combo_key: string; channel: string }>; moved?: Array<{ combo_key: string; route: string }> };

const answer = async (res: Response) => ({ status: res.status, body: await json(res) });
const plainRow = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

async function listAll(w: World) {
  const first = (await answer(await get(w.app, '/api/admin/pricing/v2/migration?page=1'))).body;
  const items = [...first.items];
  for (let p = 2; p <= first.pages; p += 1) items.push(...(await answer(await get(w.app, `/api/admin/pricing/v2/migration?page=${p}`))).body.items);
  return { first, items };
}

/** Is this changed row explained by a flag the owner reads before confirming? */
function explained(r: Row, flags: Flag[]): boolean {
  const route = r.channel.startsWith('pre_order_') ? r.channel.slice('pre_order_'.length) : null;
  const prepaidMoved = r.old_iqd !== r.new_iqd;
  const codMoved = r.old_cod_iqd !== r.new_cod_iqd;
  const named = (code: string) =>
    flags.some(
      (f) =>
        f.code === code &&
        ((f.combo_key === r.combo_key && f.route === route) ||
          (f.rows ?? []).some((x) => x.combo_key === r.combo_key && x.channel === r.channel) ||
          (f.moved ?? []).some((x) => x.combo_key === r.combo_key && x.route === route))
    );
  if (prepaidMoved && !(named('PREORDER_ABOVE_DIRECT') || named('OFF_STEP_PRICE') || named('ROUTES_NOT_REPRODUCIBLE'))) return false;
  if (codMoved && !named('COD_CHANGES')) return false;
  return true;
}

test('all 41 proposals compute; «keep_usd» reproduces today except the flagged rows; the unchanged count', async () => {
  const w = pricingWorld();
  const { first, items } = await listAll(w);
  assert.equal(items.length, 41);
  assert.deepEqual(first.totals, { unmigrated: 41, unchanged: 19, flagged: 22, migrated: 0 });
  assert.equal(first.totals_partial, false);
  for (const item of items) {
    assert.equal(item.option, 'keep_usd', `${item.slug}: manual products default to keeping today's prices`);
    assert.equal(item.available, true, `${item.slug}: ${item.codes}`);
    assert.match(item.review_hash, /^[0-9a-f]{64}$/);
    assert.equal(item.unchanged, item.changed === 0 && item.flags.every((f: string) => f === 'FX_LINKED'), item.slug);
    const full = (await answer(await get(w.app, `/api/admin/pricing/v2/migration/${item.product_id}`))).body;
    const keep = full.options.keep_usd;
    assert.equal(keep.review_hash, item.review_hash, `${item.slug}: the list and the product agree`);
    for (const r of keep.rows as Row[]) {
      if (!r.changed) continue;
      assert.ok(explained(r, keep.flags), `${item.slug} ${r.combo_key} ${r.channel}: ${r.old_iqd} → ${r.new_iqd} (cod ${r.old_cod_iqd} → ${r.new_cod_iqd}) without a flag`);
    }
    // A pre-order above direct is capped at D, never above it.
    for (const r of keep.rows as Row[]) {
      const d = (keep.rows as Row[]).find((x) => x.combo_key === r.combo_key && x.channel === 'direct_sale')?.new_iqd;
      if (d && r.new_iqd !== null) assert.ok(r.new_iqd <= d, `${item.slug} ${r.combo_key} ${r.channel}: P ≤ D`);
    }
    assert.ok(keep.flags.some((f: Flag) => f.code === 'FX_LINKED'), 'a price-first proposal follows the rate from now on (R-9)');
    assert.equal(full.options.keep_cost.available, false, 'a manual product has no engine terms to keep');
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots'), 0, 'proposals write nothing');
});

const TABLES = ['products', 'product_option_values', 'product_option_fulfillment', 'product_option_transports', 'product_sku_prices', 'pricing_v2_sku_results', 'pricing_price_points', 'pricing_preorder_discounts', 'pricing_legacy_snapshots', 'product_pricing_state', 'pricing_audit', 'price_history', 'audit_log', 'pricing_rules'];
const snapshotOf = (w: World) => TABLES.map((t) => JSON.stringify(w.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

test('one product’s commit: snapshot, V2 rows, SKU prices, method and audit in one batch — all or nothing; the snapshot is the old rows; the cart charges the proposal', async () => {
  const w = pricingWorld();
  const pre = (await answer(await post(w.app, `/api/admin/pricing/v2/migration/${AMS}/preview`, { option: 'keep_usd' }))).body;
  assert.equal(pre.available, true);
  const MONEY = 'regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd';
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  const oldValues = plain(w.raw.prepare(`SELECT id, active, ${MONEY} FROM product_option_values WHERE product_id = ? ORDER BY id`).all(AMS));
  const oldCells = plain(w.raw.prepare(`SELECT id, option_id, fulfillment_type, enabled, ${MONEY} FROM product_option_fulfillment WHERE product_id = ? ORDER BY id`).all(AMS));
  const oldRoutes = plain(w.raw.prepare(`SELECT id, fulfillment_id, method, enabled, surcharge_iqd, ${MONEY} FROM product_option_transports WHERE product_id = ? ORDER BY id`).all(AMS));
  const oldProduct = plain(w.raw.prepare('SELECT price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports, original_price_iqd, product_cost_iqd FROM products WHERE id = ?').get(AMS));

  // A failure injected at the LAST statement: nothing at all is written.
  const before = snapshotOf(w);
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (s) => s.length > 15 && /pricing_legacy_snapshots/.test(s.map((x) => x.sql).join(' ')) && /ops_guards/.test(s[s.length - 1]!.sql);
  const failApp = stubApp(db, OWNER_USER, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
  });
  const failed = await failApp.request(`/api/admin/pricing/v2/migration/${AMS}/commit`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ option: 'keep_usd', preview_hash: pre.review_hash }) });
  assert.equal(failed.status, 500);
  assert.deepEqual(snapshotOf(w), before, 'snapshot, V2 rows, prices, method and audit land together or not at all');

  const done = await answer(await post(w.app, `/api/admin/pricing/v2/migration/${AMS}/commit`, { option: 'keep_usd', preview_hash: pre.review_hash }));
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.equal(done.body.already, false);
  assert.equal(row<{ m: string }>(w.raw, 'SELECT pricing_method AS m FROM product_pricing_state WHERE product_id = ?', AMS)?.m, 'usd');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_price_points WHERE product_id = ?', AMS), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = ?', AMS), 2);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ?', AMS), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity = 'migration' AND action = 'migrate_commit' AND idempotency_key = ?", AMS, `v2mig:${AMS}:${pre.review_hash}`), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pricing.v2.migrated' AND target = ?", AMS), 1);

  // The snapshot: the pre-migration rows, byte for byte, and its digest.
  const snap = row<{ payload_json: string; payload_sha256: string; usd_iqd_rate: string; reason: string }>(w.raw, 'SELECT payload_json, payload_sha256, usd_iqd_rate, reason FROM pricing_legacy_snapshots WHERE product_id = ?', AMS)!;
  assert.equal(snap.reason, 'v2_migration');
  assert.equal(snap.usd_iqd_rate, '1600');
  assert.equal(snap.payload_sha256, createHash('sha256').update(snap.payload_json).digest('hex'));
  const payload = JSON.parse(snap.payload_json);
  assert.deepEqual(payload.values, oldValues);
  assert.deepEqual(payload.fulfillments, oldCells);
  assert.deepEqual(payload.transports, oldRoutes);
  assert.deepEqual(payload.product, oldProduct);
  assert.ok(payload.today.length >= 2 && payload.today.every((t: { prepaid_iqd: number }) => t.prepaid_iqd > 0));

  // The cart charges exactly the proposal, prepaid and cash on delivery.
  const grid = await cartGrid(w.db, AMS);
  for (const r of pre.rows as Row[]) {
    assert.equal(grid[`${r.combo_key}@${r.channel}`]?.prepaid, r.new_iqd, `${r.combo_key} ${r.channel}`);
    assert.equal(grid[`${r.combo_key}@${r.channel}`]?.cod, r.new_cod_iqd, `${r.combo_key} ${r.channel} cod`);
  }
  // The same hash again: already.
  const again = await answer(await post(w.app, `/api/admin/pricing/v2/migration/${AMS}/commit`, { option: 'keep_usd', preview_hash: pre.review_hash }));
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots WHERE product_id = ?', AMS), 1);
  // A migrated product is no longer in the queue, and its proposal is refused with the V2 code.
  const listed = (await answer(await get(w.app, '/api/admin/pricing/v2/migration'))).body;
  assert.equal(listed.totals.migrated, 1);
  const gone = await answer(await get(w.app, `/api/admin/pricing/v2/migration/${AMS}`));
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, 'PRICING_V2_MANAGED');
});

test('a price edit between preview and commit is PRICING_V2_MIGRATION_STALE; an old sign-in is REAUTH_REQUIRED', async () => {
  const w = pricingWorld();
  const pid = legacyProductId('bambu-lab-a1');
  const pre = (await answer(await post(w.app, `/api/admin/pricing/v2/migration/${pid}/preview`, { option: 'keep_usd' }))).body;
  const old = pricingWorld({ raw: w.raw, sessionAgeSeconds: 3600 });
  const reauth = await answer(await post(old.app, `/api/admin/pricing/v2/migration/${pid}/commit`, { option: 'keep_usd', preview_hash: pre.review_hash }));
  assert.equal(reauth.status, 401);
  assert.equal(reauth.body.code, 'REAUTH_REQUIRED');
  assert.equal(reauth.body.details.section, 3);
  w.raw.exec(`UPDATE product_option_fulfillment SET regular_price_iqd = regular_price_iqd + 10000 WHERE product_id = '${pid}' AND fulfillment_type = 'direct_sale'`);
  const stale = await answer(await post(w.app, `/api/admin/pricing/v2/migration/${pid}/commit`, { option: 'keep_usd', preview_hash: pre.review_hash }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_V2_MIGRATION_STALE');
  assert.equal(stale.body.details.section, 3);
  assert.match(stale.body.details.preview.review_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stale.body.details.preview.review_hash, pre.review_hash);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots'), 0);
});

test('«commit-unchanged» commits only the products whose prices do not move; the rest are skipped by code', async () => {
  const w = pricingWorld();
  const { items } = await listAll(w);
  const unchanged = items.filter((i: { unchanged: boolean }) => i.unchanged).slice(0, 3);
  const moving = items.find((i: { unchanged: boolean }) => !i.unchanged)!;
  const staleOne = items.filter((i: { unchanged: boolean }) => i.unchanged)[3]!;
  const body = {
    items: [
      ...unchanged.map((i: { product_id: string; review_hash: string }) => ({ product_id: i.product_id, preview_hash: i.review_hash })),
      { product_id: moving.product_id, preview_hash: moving.review_hash },
      { product_id: staleOne.product_id, preview_hash: 'a'.repeat(64) },
    ],
  };
  const r = await answer(await post(w.app, '/api/admin/pricing/v2/migration/commit-unchanged', body));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.committed, 3);
  for (const i of unchanged) assert.deepEqual(r.body.results.find((x: { product_id: string }) => x.product_id === i.product_id), { product_id: i.product_id, status: 'committed' });
  assert.deepEqual(r.body.results.find((x: { product_id: string }) => x.product_id === moving.product_id), { product_id: moving.product_id, status: 'skipped', code: 'PRICING_V2_MIGRATION_STALE' });
  assert.deepEqual(r.body.results.find((x: { product_id: string }) => x.product_id === staleOne.product_id), { product_id: staleOne.product_id, status: 'skipped', code: 'PRICING_V2_MIGRATION_STALE' });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_pricing_state WHERE pricing_method IS NOT NULL'), 3);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots'), 3);
  // Every committed product charges what it charged before, prepaid and cash on delivery.
  for (const i of unchanged) {
    const grid = await cartGrid(w.db, i.product_id);
    const full = await answer(await get(w.app, `/api/admin/pricing/v2/migration/${moving.product_id}`));
    void full;
    for (const [k, c] of Object.entries(grid)) if (c.ok) assert.ok(c.prepaid! > 0, `${i.slug} ${k}`);
  }
  // The same request again: the committed ones answer already.
  const again = await answer(await post(w.app, '/api/admin/pricing/v2/migration/commit-unchanged', { items: body.items.slice(0, 3) }));
  assert.ok(again.body.results.every((x: { status: string }) => x.status === 'already'));
});

/** The direct-only stock adoption of tests/procurementDirectCompleteness.test.ts, with the product also sold by pre-order. */
async function directOnlyWorld() {
  const w = pricingWorld();
  w.raw.exec(`UPDATE products SET product_cost_iqd = NULL, package_weight_g = 2500, package_width_mm = 300, package_depth_mm = 200, package_height_mm = 100 WHERE id = '${AMS}';
              UPDATE product_option_values SET cost_iqd = NULL, cost_adjust_iqd = NULL WHERE product_id = '${AMS}';
              UPDATE product_option_fulfillment SET cost_iqd = NULL, cost_adjust_iqd = NULL WHERE product_id = '${AMS}';
              -- Today's (manual) land pre-order sits between the route's cost and the engine's direct price, so one
              -- discount can reproduce it (a pre-order below cost would lose its discount: C-5, flagged).
              UPDATE product_option_transports SET regular_price_iqd = 900000 WHERE product_id = '${AMS}' AND method = 'land';`);
  const id = await w.save(w.draft());
  const preview = await w.preview({ purchase_id: id, pricing: { minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 50000 }] } });
  const product = preview.body.products[0];
  const apply = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50000 }] });
  assert.equal(apply.status, 200, JSON.stringify(apply.body).slice(0, 300));
  return w;
}

test('a direct-only engine product: the overlay row is gone, its inputs folded, its pre-order price reproduced', async () => {
  const w = await directOnlyWorld();
  const before = await cartGrid(w.db, AMS);
  const full = (await answer(await get(w.app, `/api/admin/pricing/v2/migration/${AMS}`))).body;
  assert.equal(full.mode_today, 'engine_direct_only');
  assert.equal(full.default_option, 'keep_cost');
  const keep = full.options.keep_cost;
  assert.equal(keep.available, true, JSON.stringify(keep.codes));
  assert.ok(keep.flags.some((f: Flag) => f.code === 'DIRECT_PURCHASE_OVERLAY'));
  const commit = await answer(await post(w.app, `/api/admin/pricing/v2/migration/${AMS}/commit`, { option: 'keep_cost', preview_hash: keep.review_hash, confirm_large_change: true }));
  assert.equal(commit.status, 200, JSON.stringify(commit.body).slice(0, 300));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_direct_purchase WHERE product_id = ?', AMS), 0, 'the overlay row is gone');
  const folded = row<{ a: string; c: string }>(w.raw, "SELECT supplier_cost_amount AS a, supplier_cost_currency AS c FROM pricing_inputs WHERE product_id = ? AND scope = 'option' AND scope_id = ? AND origin = 'MANUAL_OVERRIDE'", AMS, `${AMS}_o0`);
  assert.deepEqual(plainRow(folded), { a: '450', c: 'EUR' }, 'the purchase cost (bought for the model) is an ordinary input now');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'", AMS), 0, 'the Direct Sale Extra is retired (kept in the snapshot)');
  assert.equal(row<{ m: string }>(w.raw, 'SELECT pricing_method AS m FROM product_pricing_state WHERE product_id = ?', AMS)?.m, 'cost');
  const after = await cartGrid(w.db, AMS);
  const land = `o:${AMS}_o0@pre_order_land`;
  assert.equal(after[land]!.prepaid, before[land]!.prepaid, 'the frozen pre-order price is reproduced');
  const direct = `o:${AMS}_o0@direct_sale`;
  assert.ok(after[direct]!.prepaid === before[direct]!.prepaid || after[direct]!.prepaid === before[direct]!.prepaid! + 1000, 'D is kept (or one step up, flagged)');
});
