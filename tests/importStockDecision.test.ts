/**
 * THE IMPORT STOCK GATE — «إعداد المخزون للمنتج المستورد» (Bambu import spec
 * §B.10, §C.11; docs/DECISIONS.md row 241; owner decision L-16).
 *
 * An empty stock means "untracked, no limit" in Levonis, so a product the
 * catalogue import created would sell every combination without a limit the
 * moment it is priced. The import records `stock_decision = 'not_configured'`
 * (migration 0194) and the Pricing V2 write — the one door that makes a
 * product SELLABLE — refuses to publish it until an admin chooses a stock mode.
 *
 * On the catalog-only world (tests/fixtures/catalogOnly.ts) whose visible,
 * unpriced H2D is made an imported product (its `product_source_refs` row, its
 * stock columns NULL as the import leaves them):
 *
 *   1. its V2 publish is refused at the batch (the fence) and at the HTTP door
 *      (409 IMPORT_STOCK_NOT_CONFIGURED, section ٣), nothing is written, and a
 *      customer still meets PRICE_NOT_AVAILABLE;
 *   2. «بلا تتبّع (حسب الطلب)» sells by pre-order: refused (400
 *      IMPORT_STOCK_UNTRACKED_NEEDS_PREORDER) while the product offers none —
 *      a direct sale needs a recorded stock (worker/routes/products.ts
 *      `directUsable`), so it would publish a price no customer can order —
 *      and once pre-order is on it publishes and a customer orders it by
 *      pre-order (the direct shelf still says OUT_OF_STOCK);
 *   3. «تتبّع الكمية» is refused (400 IMPORT_STOCK_TRACKED_EMPTY) while a row a
 *      sale can reach has no number; with stock 3 it sells 3 and refuses the 4th;
 *   4. a merged product (its stock is the owner's existing setup) is never gated;
 *   5. a database without 0194 publishes exactly as before and has nothing to decide;
 *   6. the decision is written outside any import batch, so 0195's guard
 *      triggers let it through — and inside an import batch they refuse it;
 *   7. the decision is staff-only: the admin read carries it, no customer answer does,
 *      and a customer is refused at the route;
 *   8. the product form's «نشر» of the visible, unpriced product with no price typed is a
 *      content save (`isContentOnlySave`): it lands, the product stays active, and the
 *      typed stock is saved, so «تتبّع الكمية» can follow — never through «مسودة»;
 *   9. «تتبّع الكمية» per inventory mode (TRACKED_STOCK_SQL), and its fence form.
 *
 * Run: node --import tsx --test tests/importStockDecision.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, post, put, stubApp } from './fixtures/app';
import { CAT, CAT_SEL, CUSTOMER_ROLES, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { isV2Published, publishV2 } from './fixtures/v2Publish';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { isImportStockMiss, TRACKED_STOCK_SQL, trackedStockBinds, trackedStockReady } from '../worker/lib/importStock';
import { fence } from '../worker/lib/operations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { docWithoutLegacyMoney, isContentOnlySave, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { catalogKnowledgeInstalled } from '../worker/lib/catalogKnowledge';

const OWNER = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const FULL = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const CUSTOMER = CUSTOMER_ROLES.customer!;
const SELECTION = { optionValueIds: [CAT_SEL.std], colorId: CAT_SEL.grey };
const point = (usd: string) => ({ scope: 'product', id: '', kind: 'fixed', usd });

/** The admin routers on worker/index.ts's prefixes, as `user`. */
const admin = (w: CatalogOnlyWorld, user: Record<string, unknown> = FULL) =>
  stubApp(
    w.db,
    user as never,
    (a) => {
      a.route('/api/admin/products', adminProductRelationsRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );

/**
 * The H2D as the import leaves a product it created: a `product_source_refs`
 * row with `stock_decision` (default `not_configured`), no stock anywhere —
 * NULL is untracked and unlimited in Levonis, the thing the gate is for — and
 * the form-default sale type (direct sale), with no pre-order cell or route.
 */
function makeImported(raw: DatabaseSync, o: { match?: 'created' | 'merged'; decision?: string; preorder?: boolean } = {}): void {
  const match = o.match ?? 'created';
  const decision = o.decision ?? (match === 'created' ? 'not_configured' : 'not_required');
  // `preorder`: the owner has since enabled pre-order (the fixture's own cell and air route stay).
  if (!o.preorder) {
    raw.exec(`
      DELETE FROM product_option_transports WHERE product_id = '${CAT.id}';
      DELETE FROM product_option_fulfillment WHERE product_id = '${CAT.id}';
      UPDATE products SET sale_types = '["direct_sale"]', selling_type = 'direct_sale' WHERE id = '${CAT.id}';
    `);
  }
  // No money of any kind: the import writes none (the fixture's archived legacy ladder is not an imported product's).
  raw.exec(`
    UPDATE products SET stock = NULL, price_iqd = 0, prime_price_iqd = NULL, pro_price_iqd = NULL, original_price_iqd = NULL,
           direct_surcharge_iqd = NULL, membership_prices = '{}', product_cost_iqd = NULL WHERE id = '${CAT.id}';
    UPDATE product_option_values SET regular_price_iqd = NULL, prime_price_iqd = NULL, pro_price_iqd = NULL, regular_adjust_iqd = NULL,
           cost_iqd = NULL, cost_adjust_iqd = NULL WHERE product_id = '${CAT.id}';
    UPDATE product_colors SET regular_price_iqd = NULL, prime_price_iqd = NULL, pro_price_iqd = NULL, regular_adjust_iqd = NULL,
           cost_iqd = NULL, cost_adjust_iqd = NULL WHERE product_id = '${CAT.id}';
    UPDATE product_variants SET regular_price_iqd = NULL, prime_price_iqd = NULL, pro_price_iqd = NULL, cost_iqd = NULL WHERE product_id = '${CAT.id}';
    UPDATE product_option_values SET stock = NULL WHERE product_id = '${CAT.id}';
    UPDATE product_colors SET stock = NULL WHERE product_id = '${CAT.id}';
    UPDATE product_variants SET stock = NULL WHERE product_id = '${CAT.id}';
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision,
                                     fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', '581025672340700001', '${CAT.id}', 'h2d', 'https://us.store.bambulab.com/products/h2d', '${match}', '${decision}',
              'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
  `);
}

/** Stock on every level a sale can reach, whatever the product's inventory mode. */
function stockEverywhere(raw: DatabaseSync, n: number): void {
  raw.exec(`
    UPDATE products SET stock = ${n} WHERE id = '${CAT.id}';
    UPDATE product_option_values SET stock = ${n} WHERE product_id = '${CAT.id}';
    UPDATE product_colors SET stock = ${n} WHERE product_id = '${CAT.id}';
    UPDATE product_variants SET stock = ${n} WHERE product_id = '${CAT.id}';
  `);
}

const decisionRow = (raw: DatabaseSync) =>
  raw.prepare('SELECT stock_decision AS d, stock_decided_by AS by, stock_decided_at AS at FROM product_source_refs WHERE product_id = ?').get(CAT.id) as
    | { d: string; by: string; at: string }
    | undefined;
const count = (raw: DatabaseSync, sql: string, ...args: string[]) => Number((raw.prepare(sql).get(...args) as { n: number }).n);

async function cartAdd(w: CatalogOnlyWorld, qty: number) {
  const res = await post(w.as(CUSTOMER), '/api/cart/items', { productId: CAT.id, qty, ...SELECTION });
  return { status: res.status, body: await json(res) };
}

test('an imported product is refused at the V2 door until its stock mode is chosen; nothing is written', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw);
  assert.equal(await catalogKnowledgeInstalled(w.db), true);

  // The batch: the fence is the authority, whatever caller built it.
  await assert.rejects(publishV2(w.raw, CAT.id), (e: unknown) => isImportStockMiss(e), 'the V2 batch refuses on the import stock fence');
  assert.equal(isV2Published(w.raw, CAT.id), false);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ?', CAT.id), 0, 'no result row');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'no guard row is left behind');

  // The HTTP door (the product form's prices-only write): the reason, in ar / en, naming section ٣ — not PRICING_CHANGED.
  const app = admin(w, OWNER);
  const read = await json(await get(app, `/api/admin/products-v2/${CAT.id}/pricing`));
  const refused = await put(app, `/api/admin/products-v2/${CAT.id}/pricing`, { seq: read.seq, pricing: { method: 'usd', points: [point('1000')] } });
  const body = await json(refused);
  assert.equal(refused.status, 409, JSON.stringify(body).slice(0, 300));
  assert.equal(body.code, 'IMPORT_STOCK_NOT_CONFIGURED');
  assert.equal(body.error, serverMessage('IMPORT_STOCK_NOT_CONFIGURED'));
  assert.equal(body.details.section, 3);
  assert.equal(isV2Published(w.raw, CAT.id), false);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ?', CAT.id), 0);

  // The customer still meets the catalog-only answer.
  const add = await cartAdd(w, 1);
  assert.equal(add.status, 409);
  assert.equal(add.body.code, 'PRICE_NOT_AVAILABLE');
});

test('«بلا تتبّع (حسب الطلب)»: refused while the product offers no pre-order; once it does, written with who and when, published, ordered by pre-order', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw);
  const app = admin(w);

  // Direct sale only (the import's form default): «بلا تتبّع» would publish a price no customer can order.
  const refused = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  const refusedBody = await json(refused);
  assert.equal(refused.status, 400, JSON.stringify(refusedBody));
  assert.equal(refusedBody.code, 'IMPORT_STOCK_UNTRACKED_NEEDS_PREORDER');
  assert.equal(refusedBody.error, serverMessage('IMPORT_STOCK_UNTRACKED_NEEDS_PREORDER'));
  assert.equal(decisionRow(w.raw)!.d, 'not_configured', 'nothing written');

  // The owner enables pre-order (a cell and a route): now the choice lands.
  w.raw.exec(`DELETE FROM product_source_refs WHERE product_id = '${CAT.id}'`);
  const w2 = await catalogOnlyWorld();
  makeImported(w2.raw, { preorder: true });
  const app2 = admin(w2);
  const res = await put(app2, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.import_stock.decision, 'untracked');
  assert.equal(body.unchanged, false);
  const stored = decisionRow(w2.raw)!;
  assert.equal(stored.d, 'untracked');
  assert.equal(stored.by, FULL.id);
  assert.match(stored.at, /^\d{4}-\d\d-\d\dT/);
  const audit = w2.raw.prepare("SELECT detail FROM audit_log WHERE action = 'product.import_stock_decision' AND target = ?").get(CAT.id) as
    | { detail: string }
    | undefined;
  assert.ok(audit, 'an audit row is written');
  assert.deepEqual(JSON.parse(audit.detail), { product_id: CAT.id, before: 'not_configured', after: 'untracked' }, 'ids and the two decisions, never a quantity');

  // The same choice again writes nothing.
  const again = await json(await put(app2, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' }));
  assert.equal(again.unchanged, true);
  assert.equal(count(w2.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.import_stock_decision'"), 1);
  const read = await json(await get(app2, `/api/admin/products-v2/${CAT.id}`));
  assert.equal(read.import_stock.decision, 'untracked');

  await publishV2(w2.raw, CAT.id);
  assert.equal(isV2Published(w2.raw, CAT.id), true, 'published: SELLABLE');
  // Ordered by pre-order, with no limit; the direct shelf names no stock and stays closed, as for any product.
  const pre = await post(w2.as(CUSTOMER), '/api/cart/items', { productId: CAT.id, qty: 25, ...SELECTION, fulfillmentType: 'pre_order', transportMethod: 'air' });
  const preBody = await json(pre);
  assert.equal(pre.status, 200, JSON.stringify(preBody).slice(0, 300));
  const direct = await post(w2.as(CUSTOMER_ROLES.prime!), '/api/cart/items', { productId: CAT.id, qty: 1, ...SELECTION, fulfillmentType: 'direct_sale' });
  assert.equal((await json(direct)).code, 'OUT_OF_STOCK');
});

test('«تتبّع الكمية» needs a number on every row a sale can reach; with stock 3 it sells 3 and refuses the 4th', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw);
  const app = admin(w);

  const empty = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'tracked' });
  const emptyBody = await json(empty);
  assert.equal(empty.status, 400, JSON.stringify(emptyBody));
  assert.equal(emptyBody.code, 'IMPORT_STOCK_TRACKED_EMPTY');
  assert.equal(emptyBody.error, serverMessage('IMPORT_STOCK_TRACKED_EMPTY'));
  assert.equal(decisionRow(w.raw)!.d, 'not_configured', 'nothing written');

  // One reachable row without a number is still "empty": the whole level must carry one.
  stockEverywhere(w.raw, 3);
  w.raw.exec(`UPDATE product_variants SET stock = NULL WHERE id = 'pv_cat_2'`);
  const mode = (w.raw.prepare('SELECT inventory_mode AS m FROM products WHERE id = ?').get(CAT.id) as { m: string }).m;
  if (mode === 'VARIANT_COMBINATION') {
    const partial = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'tracked' });
    assert.equal(partial.status, 400, `a ${mode} product with one untracked variant is not tracked`);
  }
  stockEverywhere(w.raw, 3);

  const ok = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'tracked' });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal(decisionRow(w.raw)!.d, 'tracked');

  await publishV2(w.raw, CAT.id);
  assert.equal(isV2Published(w.raw, CAT.id), true);
  const four = await cartAdd(w, 4);
  assert.notEqual(four.status, 200, 'a 4th unit is more than the shelf holds');
  assert.ok(['OUT_OF_STOCK', 'QTY_UNAVAILABLE'].includes(String(four.body.code)), JSON.stringify(four.body).slice(0, 300));
  const three = await cartAdd(w, 3);
  assert.equal(three.status, 200, JSON.stringify(three.body).slice(0, 300));
});

test('a merged product keeps its own stock setup and is never gated; it has nothing to decide', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw, { match: 'merged' });
  await publishV2(w.raw, CAT.id);
  assert.equal(isV2Published(w.raw, CAT.id), true);
  const res = await put(admin(w), `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  assert.equal(res.status, 404);
  assert.equal(decisionRow(w.raw)!.d, 'not_required');
});

test('a database without 0194 publishes exactly as before and has nothing to decide (CLAUDE.md rule 2)', async () => {
  const w = await catalogOnlyWorld({ raw: dbThrough('0193') });
  assert.equal(await catalogKnowledgeInstalled(asD1(w.raw)), false);
  await publishV2(w.raw, CAT.id);
  assert.equal(isV2Published(w.raw, CAT.id), true);
  const app = admin(w);
  const read = await json(await get(app, `/api/admin/products-v2/${CAT.id}`));
  assert.equal(read.import_stock, null);
  const res = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  assert.equal(res.status, 404);
});

test('the decision passes 0195\'s guard triggers outside an import batch, and an import batch can never write one', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw, { preorder: true });
  // Inside an import batch (the guard row armed): the import may record "not configured", never a decision.
  w.raw.exec("INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
  assert.throws(
    () => w.raw.exec(`UPDATE product_source_refs SET stock_decision = 'untracked', stock_decided_by = 'x', stock_decided_at = 'y' WHERE product_id = '${CAT.id}'`),
    /IMPORT_FINANCIAL_WRITE_REFUSED/
  );
  w.raw.exec("DELETE FROM ops_guards WHERE id = 'catalog-import-batch'");
  // Outside one: the admin's decision is the one write the guards let through.
  const res = await put(admin(w), `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  assert.equal(res.status, 200);
  assert.equal(decisionRow(w.raw)!.d, 'untracked');
});

test('staff only: the admin read carries the decision, no customer answer does, and a customer is refused at the route', async () => {
  const w = await catalogOnlyWorld();
  makeImported(w.raw);
  const read = await json(await get(admin(w), `/api/admin/products-v2/${CAT.id}`));
  assert.deepEqual(read.import_stock, { decision: 'not_configured', decided_at: null });

  for (const path of [`/api/products/${CAT.slug}`, `/api/products?limit=50`, `/api/public/v1/products/${CAT.slug}`]) {
    const text = await (await get(w.as(CUSTOMER), path)).text();
    assert.doesNotMatch(text, /import_stock|stock_decision|not_configured|us\.store\.bambulab\.com/, path);
  }

  const asCustomer = stubApp(w.db, CUSTOMER as never, (a) => a.route('/api/admin/products', adminProductRelationsRoutes), { publishV2: false });
  const refused = await put(asCustomer, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'untracked' });
  assert.ok(refused.status === 401 || refused.status === 403, String(refused.status));
  assert.equal(decisionRow(w.raw)!.d, 'not_configured');

  const bad = await put(admin(w), `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'not_required' });
  assert.equal(bad.status, 400);
});

test('«نشر» of the visible, unpriced product with no price typed is a content save: it lands, stays active, saves the stock; «تتبّع الكمية» follows', async () => {
  // The rule the product form applies (src/components/adminProducts/form/v2/v2Model.ts).
  const base = { status: 'active' as const, storedStatus: 'active', needsMethod: true, touched: false, confirming: false };
  assert.equal(isContentOnlySave(base), true);
  assert.equal(isContentOnlySave({ ...base, touched: true }), false, 'a typed price travels');
  assert.equal(isContentOnlySave({ ...base, confirming: true }), false, "the review sheet's answer travels");
  assert.equal(isContentOnlySave({ ...base, needsMethod: false }), false, 'a priced product saves as today');
  assert.equal(isContentOnlySave({ ...base, storedStatus: 'hidden' }), false, 'publishing a hidden product keeps its rule');
  assert.equal(isContentOnlySave({ ...base, status: 'draft' }), false);

  // What that save is on the server: the form's own body, no pricing_v2 block.
  const w = await catalogOnlyWorld();
  makeImported(w.raw);
  // No IMAGES binding in this world to re-verify a stored picture: the save carries none.
  w.raw.exec(`DELETE FROM product_images WHERE product_id = '${CAT.id}'`);
  const app = admin(w, OWNER);
  const p = await json(await get(app, `/api/admin/products-v2/${CAT.id}`));
  const r = await json(await get(app, `/api/admin/products/${CAT.id}/relations`));
  const doc: Record<string, unknown> = { ...(toEditorDoc(p.product) as unknown as Record<string, unknown>), status: 'active' };
  const hydrated = hydrateRelations(r as unknown as RelationsResponse, p.product);
  const rel = {
    ...hydrated,
    variants: hydrated.variants.map((v) => ({ ...v, stock: 3 })),
    groups: hydrated.groups.map((g) => ({ ...g, values: g.values.map((v) => ({ ...v, stock: 3 })) })),
    colors: hydrated.colors.map((c) => ({ ...c, stock: 3 })),
  };
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  const saved = await post(app, '/api/admin/products-v2', {
    ...docWithoutLegacyMoney(docFields),
    relations: withoutLegacyMoney(relationsToWire(rel as never)),
    expected_updated_at: p.product.updated_at,
  });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
  const after = w.raw.prepare('SELECT status FROM products WHERE id = ?').get(CAT.id) as { status: string };
  assert.equal(after.status, 'active', 'still on the storefront');
  assert.equal(isV2Published(w.raw, CAT.id), false, 'and still unpriced');
  const tracked = await put(app, `/api/admin/products/${CAT.id}/import-stock-decision`, { decision: 'tracked' });
  assert.equal(tracked.status, 200, 'the saved stock lets «تتبّع الكمية» through');
});

/** «تتبّع الكمية» per inventory mode: every row a sale can reach carries a number (zero is a number). */
test('TRACKED_STOCK_SQL per inventory mode, and its fence form', async () => {
  const world = (mode: string) => {
    const raw = freshDb();
    raw.exec(`INSERT INTO products (id, slug, name, status, inventory_mode) VALUES ('p1', 'p1', 'P1', 'active', '${mode}')`);
    return { raw, db: asD1(raw) };
  };
  {
    const { raw, db } = world('VARIANT_COMBINATION');
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active, stock) VALUES ('v1','p1','o:a',1,3), ('v2','p1','o:b',1,NULL), ('v3','p1','o:c',0,NULL)`);
    assert.equal(await trackedStockReady(db, 'p1'), false, 'an active variant with no number');
    raw.exec(`UPDATE product_variants SET stock = 0 WHERE id = 'v2'`);
    assert.equal(await trackedStockReady(db, 'p1'), true, 'zero is a number; an inactive variant does not count');
    raw.exec(`DELETE FROM product_variants`);
    assert.equal(await trackedStockReady(db, 'p1'), false, 'no variant at all: nothing tracked');
  }
  {
    const { raw, db } = world('COLOR');
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, hex, active, stock) VALUES ('c1','p1','A','#000000',1,2), ('c2','p1','B','#ffffff',1,NULL)`);
    assert.equal(await trackedStockReady(db, 'p1'), false);
    raw.exec(`UPDATE product_colors SET active = 0 WHERE id = 'c2'`);
    assert.equal(await trackedStockReady(db, 'p1'), true);
  }
  {
    const { raw, db } = world('OPTION');
    raw.exec(`
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('gA','p1','A',0,1), ('gB','p1','B',1,1);
      INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock) VALUES
        ('a1','p1','gA','a1',0,1,5), ('a2','p1','gA','a2',1,1,NULL), ('b1','p1','gB','b1',0,1,NULL);
    `);
    assert.equal(await trackedStockReady(db, 'p1'), false, 'neither group tracked whole: a2 + b1 sells unlimited');
    raw.exec(`UPDATE product_option_values SET stock = 1 WHERE id = 'a2'`);
    assert.equal(await trackedStockReady(db, 'p1'), true, 'group A tracked whole: every selection meets a tracked row');
    raw.exec(`UPDATE product_option_groups SET active = 0 WHERE id = 'gA'`);
    assert.equal(await trackedStockReady(db, 'p1'), false, 'an inactive group is never chosen');
  }
  {
    const { raw, db } = world('BASE');
    assert.equal(await trackedStockReady(db, 'p1'), false);
    raw.exec(`UPDATE products SET stock = 0 WHERE id = 'p1'`);
    assert.equal(await trackedStockReady(db, 'p1'), true);
    assert.equal(await trackedStockReady(db, 'p_missing'), false, 'no product: not tracked');
  }
  {
    const { raw, db } = world('VARIANT_COMBINATION');
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active, stock) VALUES ('v1','p1','o:a',1,3)`);
    await db.batch(fence(db, TRACKED_STOCK_SQL, trackedStockBinds('p1')));
    raw.exec(`UPDATE product_variants SET stock = NULL`);
    await assert.rejects(db.batch(fence(db, TRACKED_STOCK_SQL, trackedStockBinds('p1'))), /CHECK constraint failed/);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'no guard row left behind');
  }
});
