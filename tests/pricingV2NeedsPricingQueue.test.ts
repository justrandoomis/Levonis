/**
 * «يحتاج تسعيرًا» — THE QUEUE (spec addendum A.8, A.12.4; DECISIONS row 222).
 *
 *   - every product not V2-published is listed with its state; a published
 *     product leaves the queue; compositions are `composition_pending` (Q7);
 *   - a price editor's projection: no cost code's name (a cost-first product's
 *     gaps are one OWNER_DATA item), no owner-only filter, `can_finish` false
 *     on cost-first and true on price-first;
 *   - the products list carries `needs_pricing`, `from_iqd` and the filter,
 *     and never a legacy dinar figure for a hidden product;
 *   - every string in ar/en/ckb, the Sorani never a copy of the Arabic.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2NeedsPricingQueue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, OWNER, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { publishV2 } from './fixtures/v2Publish';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { NEEDS_PRICING, hiddenBanner } from '../src/components/adminProducts/needsPricingStrings';

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };

async function world() {
  const raw = freshDb();
  const ids = seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  const db = asD1(raw);
  const appAs = (user: StubUser) => stubApp(db, user, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  return { raw, ids, appAs };
}

type Row = { id: string; state: string; method: string | null; can_finish: boolean; missing: Array<{ code: string; field: string | null }>; composition: string };

async function allRows(app: ReturnType<typeof stubApp>, filter = 'all'): Promise<{ rows: Row[]; first: Record<string, unknown> }> {
  const first = await json(await get(app, `/api/admin/products-v2/needs-pricing?filter=${filter}&page=1`));
  const rows = [...(first.products as Row[])];
  for (let p = 2; p <= Number(first.pages); p++) rows.push(...((await json(await get(app, `/api/admin/products-v2/needs-pricing?filter=${filter}&page=${p}`))).products as Row[]));
  return { rows, first };
}

test('every product not V2-published is in the queue; a published one leaves it; compositions wait for Q7', async () => {
  const { raw, ids, appAs } = await world();
  const owner = appAs(OWNER);
  const before = await allRows(owner);
  const ordinary = raw.prepare("SELECT COUNT(*) AS n FROM products WHERE COALESCE(composition, '') = ''").get() as { n: number };
  assert.equal(before.rows.filter((r) => r.composition === '').length, Number(ordinary.n));
  assert.equal((before.first.counts as Record<string, number>).hidden, before.rows.length);
  // No approved USD/IQD yet: the banner says nothing can be published.
  assert.equal(before.first.rate_ready, false);
  assert.ok(before.rows.every((r) => ['needs_pricing', 'saved', 'ready', 'composition_pending'].includes(r.state)));
  assert.ok(before.rows.length <= 200);
  await publishV2(raw, ids[0]!);
  const after = await allRows(owner);
  assert.equal(after.rows.length, before.rows.length - 1);
  assert.ok(!after.rows.some((r) => r.id === ids[0]));
  assert.equal(after.first.rate_ready, true, 'the fixture approved U = 1,500 to publish');
  // Paged by 20.
  assert.ok((before.first.products as unknown[]).length <= 20);
});

test('a price editor sees no cost code, no owner-only filter, and can finish price-first products only', async () => {
  const { raw, ids, appAs } = await world();
  // One cost-first product (a stored method), the rest without one.
  await publishV2(raw, ids[1]!);
  // Staged as a cost-first product whose results are gone (a «محفوظ، غير مكتمل» one): the guards are lifted for this SQL only.
  const guards = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('product_pricing_state', 'pricing_v2_sku_results')").all() as Array<{ name: string }>).map((t) => t.name);
  withoutTriggers(raw, guards, `UPDATE product_pricing_state SET pricing_method = 'cost' WHERE product_id = '${ids[1]!}'; DELETE FROM pricing_v2_sku_results WHERE product_id = '${ids[1]!}';`);
  const editor = appAs(EDITOR);
  const { rows, first } = await allRows(editor);
  const counts = first.counts as Record<string, number>;
  assert.equal('below_min_profit' in counts, false);
  assert.equal('purchase_review' in counts, false);
  const refused = await json(await get(editor, '/api/admin/products-v2/needs-pricing?filter=below_min_profit'));
  assert.equal(refused.filter, 'all', 'an owner-only filter falls back to all for an editor');
  const costFirst = rows.find((r) => r.id === ids[1]);
  assert.ok(costFirst, 'the cost-first product is still hidden');
  assert.equal(costFirst!.can_finish, false);
  for (const m of costFirst!.missing) assert.equal(m.code, 'OWNER_DATA');
  assert.ok(rows.filter((r) => r.id !== ids[1] && r.composition === '').every((r) => r.can_finish));
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /SUPPLIER_COST|supplier_cost|replacement|_cost_iqd/, 'no cost code name for an editor');
});

test('the products list: `needs_pricing`, `from_iqd` and the filter; no legacy dinar figure for a hidden product', async () => {
  const { raw, ids, appAs } = await world();
  await publishV2(raw, ids[0]!);
  const owner = appAs(OWNER);
  const list = await json(await get(owner, '/api/admin/products-v2?limit=100'));
  const items = list.products as Array<{ id: string; needs_pricing: boolean; from_iqd: number | null; price_iqd: number | null }>;
  const published = items.find((p) => p.id === ids[0])!;
  assert.equal(published.needs_pricing, false);
  assert.ok(Number(published.from_iqd) >= 1000 && Number(published.from_iqd) % 1000 === 0);
  for (const p of items.filter((x) => x.id !== ids[0])) {
    assert.equal(p.needs_pricing, true, p.id);
    assert.equal(p.from_iqd, null);
    assert.equal(p.price_iqd, null, 'a hidden product shows no legacy price');
  }
  const filtered = await json(await get(owner, '/api/admin/products-v2?needs_pricing=1&limit=1'));
  assert.equal(Number(filtered.total), items.length - 1);
});

test('every queue string exists in ar, en and real Sorani (the Sorani never copies the Arabic)', () => {
  const walk = (o: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      const t = v as { ar?: string; en?: string; ckb?: string };
      if (typeof t.ar === 'string') {
        assert.ok(t.ar && t.en && t.ckb, `${path}.${k}`);
        assert.notEqual(t.ckb, t.ar, `${path}.${k}: ckb copies the Arabic`);
        // ی (U+06CC) and ک (U+06A9) are Kurdish letters Arabic never writes (it has ي and ك): «دیاریکردنی نرخ».
        assert.match(t.ckb!, /[ڕڵۆێەپچژگڤیک]/, `${path}.${k}: no Sorani letter`);
      } else walk(v as Record<string, unknown>, `${path}.${k}`);
    }
  };
  walk(NEEDS_PRICING as unknown as Record<string, unknown>, 'NEEDS_PRICING');
  // DECISIONS row 240: an unpriced product is SHOWN without a price, no longer hidden.
  assert.match(hiddenBanner(3, 'ar'), /^3 منتجًا ظاهرًا للزبائن بلا سعر/);
  assert.match(hiddenBanner(3, 'en'), /^3 products are shown to customers without a price/);
  assert.match(hiddenBanner(3, 'ckb'), /بێ نرخ/);
});
