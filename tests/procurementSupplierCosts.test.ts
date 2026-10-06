import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, count, row } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { productSelections } from '../worker/lib/inventorySelection';
import { exactProcurementUnitDefault, roundProcurementProduct } from '../packages/contracts/src/procurementCost';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES ('owner','boss@x.co','admin','full'),('assistant','staff@x.co','admin','assistant');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode,net_weight_g,package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES ('printer','X2D','procurement-x2d',2000000,1523109,0,'OPTION',20000,22300,400,500,200),
      ('part','Part','procurement-part',20000,12000,0,'BASE',1000,NULL,NULL,NULL,NULL);
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','printer','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','printer','model','Combo',0),('solo','printer','model','Solo',0);`);
  const real = asD1(raw);
  let gate: { entered: () => void; resumed: Promise<void> } | undefined;
  const db = { prepare: (sql: string) => real.prepare(sql), async batch(statements: SqliteStatement[]) {
    if (gate && statements.some(s => s.sql.includes('INSERT INTO purchase_orders'))) { const current = gate; gate = undefined; current.entered(); await current.resumed; }
    return real.batch(statements as unknown as D1PreparedStatement[]);
  } } as unknown as D1Database;
  const app = stubApp(db, { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => a.route('/p', adminProcurementRoutes));
  const payload = (extra: Record<string, unknown> = {}) => ({ operation_id: crypto.randomUUID(), currency: 'EUR', exchange_rate: 1626.25,
    cost_profile_id: 'germany_land', cost_profile_version: 1, shipping_rate_iqd: 5950, status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 1, source_unit_amount: 855, weight_g: 22300, volume_mm3: 40000000 }], charges: [], ...extra });
  async function create(body = payload()) { const res = await post(app, '/p/documents', body), data = await json(res); assert.equal(res.status, 200, JSON.stringify(data)); return { body, id: data.id as string, detail: await json(await get(app, `/p/documents/${data.id}`)) }; }
  const pause = () => { let entered!: () => void, resume!: () => void; const waiting = new Promise<void>(r => { entered = r; }), resumed = new Promise<void>(r => { resume = r; }); gate = { entered, resumed }; return { waiting, resume }; };
  return { raw, db, app, payload, create, pause };
}

test('supplier profile defaults start unset; old catalogue and received costs do not become raw defaults', async () => {
  const x = setup(), config = await json(await get(x.app, '/p/config'));
  assert.deepEqual(config.cost_profiles.map((p: Record<string, unknown>) => [p.id, p.currency, p.shipping_basis, p.exchange_rate, p.shipping_rate_iqd]), [
    ['germany_land', 'EUR', 'weight', null, null], ['china_air', 'CNY', 'weight', null, null], ['china_sea', 'CNY', 'volume', null, null],
  ]);
  x.raw.exec("INSERT INTO product_colors(id,product_id,name_en,hex) VALUES('black','printer','Black','#000000'),('white','printer','White','#ffffff')");
  const selections = await productSelections(x.db, 'printer');
  assert.equal(selections[0].procurement_shared_colors, true);
  assert.equal(selections[0].purchase_unit_iqd, 1523109);
  assert.deepEqual(selections[0].procurement_defaults, []);
  assert.equal(selections[0].packed_weight_g, 22300);
  const noPacked = (await productSelections(x.db, 'part'))[0];
  assert.equal(noPacked.weight_g, 1000); // compatibility only, NOT a packed suggestion
  assert.equal(noPacked.packed_weight_g, null);
  assert.equal(noPacked.packed_volume_mm3, null);
});

test('855 EUR plus packed 22.3kg gives distinct raw/shipping snapshots and exact landed FIFO costs', async () => {
  const x = setup(), p = await x.create();
  assert.equal(p.detail.lines[0].purchase_total_iqd, 1390444);
  assert.equal(p.detail.lines[0].auto_shipping_iqd, 132685);
  assert.equal(p.detail.lines[0].charges_iqd, 132685);
  assert.equal(p.detail.lines[0].shipping_total_iqd, 132685);
  assert.equal(p.detail.ordered_total_iqd, 1523129);
  assert.deepEqual(p.detail.charges, []);
  const receipt = await post(x.app, `/p/documents/${p.id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: p.detail.lines[0].line_id, qty: 1 }] });
  assert.equal(receipt.status, 200, JSON.stringify(await json(receipt)));
  assert.deepEqual(row(x.raw, 'SELECT purchase_unit_iqd,unit_cost_iqd,total_cost_iqd FROM inventory_lots'), { purchase_unit_iqd: 1390444, unit_cost_iqd: 1523129, total_cost_iqd: 1523129 });
  assert.equal(count(x.raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1200'"), 1523129);
});

test('profile raw price rounds the complete quantity once and preserves remainder through partial receipts', async () => {
  const x = setup(), p = await x.create(x.payload({ lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 5, source_unit_amount: 855, weight_g: 22300 }] }));
  assert.equal(p.detail.lines[0].purchase_total_iqd, 6952219);
  assert.equal(p.detail.lines[0].purchase_unit_iqd, 1390443);
  assert.equal(p.detail.ordered_total_iqd, 7615644);
  for (const qty of [2, 3]) {
    const r = await post(x.app, `/p/documents/${p.id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: p.detail.lines[0].line_id, qty }] });
    assert.equal(r.status, 200, JSON.stringify(await json(r)));
  }
  assert.equal(count(x.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 7615644);
  assert.equal(count(x.raw, 'SELECT SUM(purchase_unit_iqd*qty_received) n FROM inventory_lots'), 6952219);
});

test('small yuan prices retain all quantity value; decimal exact arithmetic avoids binary half-rounding loss', async () => {
  const x = setup(), p = await x.create(x.payload({ currency: 'CNY', exchange_rate: 235.25, cost_profile_id: 'china_air', shipping_rate_iqd: 0,
    lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 50000, source_unit_amount: 0.01, weight_g: 10 }] }));
  assert.equal(p.detail.lines[0].purchase_total_iqd, 117625);
  assert.equal(p.detail.lines[0].charges_iqd, 0);
  assert.equal(roundProcurementProduct(['1.005', 100]), 101);
  assert.equal(roundProcurementProduct(['0.1', '0.2', 25]), 1);
});

test('sea freight uses packed CBM only and supports cartons larger than one CBM', async () => {
  const x = setup(), p = await x.create(x.payload({ currency: 'CNY', exchange_rate: 235.25, cost_profile_id: 'china_sea', shipping_rate_iqd: 188200,
    lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 5, source_unit_amount: 100, weight_g: 999999, volume_mm3: 40000000 },
      { product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 0, weight_g: 0, volume_mm3: 1250000000 }] }));
  const combo = p.detail.lines.find((l: {scope_id: string}) => l.scope_id === 'combo'), part = p.detail.lines.find((l: {product_id: string}) => l.product_id === 'part');
  assert.equal(combo.auto_shipping_iqd, 37640);
  assert.equal(part.auto_shipping_iqd, 235250);
});

test('draft does not overwrite defaults; confirming saves exact selection only, profile updates preserve old purchases', async () => {
  const x = setup(), draft = await x.create(x.payload({ status: 'draft' }));
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM procurement_selection_cost_defaults'), 0);
  assert.equal(count(x.raw, "SELECT version n FROM procurement_cost_profiles WHERE id='germany_land'"), 1);
  const saved = await put(x.app, `/p/documents/${draft.id}`, { ...draft.body, version: 1, status: 'ordered' });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const selections = await productSelections(x.db, 'printer');
  assert.equal(selections.find(s => s.scope_id === 'combo')!.procurement_defaults[0].source_unit_amount, 855);
  assert.deepEqual(selections.find(s => s.scope_id === 'solo')!.procurement_defaults, []);
  const settings = await put(x.app, '/p/cost-profiles/germany_land', { version: 2, exchange_rate: 1700, shipping_rate_iqd: 6500 });
  assert.equal(settings.status, 200, JSON.stringify(await json(settings)));
  const old = await json(await get(x.app, `/p/documents/${draft.id}`));
  assert.equal(old.purchase.exchange_rate, 1626.25);
  assert.equal(old.purchase.shipping_rate_iqd, 5950);
  assert.equal(old.ordered_total_iqd, 1523129);
  const cfg = await json(await get(x.app, '/p/config'));
  assert.equal(cfg.cost_profiles[0].exchange_rate, 1700);
  assert.equal(cfg.cost_profiles[0].version, 3);
});

test('reopening and cloning a profiled purchase never counts computed freight twice', async () => {
  const x = setup(), p = await x.create();
  const edit = { ...p.body, version: 1, cost_profile_version: 2, lines: p.detail.lines, charges: p.detail.charges };
  assert.equal((await put(x.app, `/p/documents/${p.id}`, edit)).status, 200);
  const after = await json(await get(x.app, `/p/documents/${p.id}`));
  assert.equal(after.ordered_total_iqd, p.detail.ordered_total_iqd);
  const clone = await x.create({ ...edit, operation_id: crypto.randomUUID(), cost_profile_version: 3 });
  assert.equal(clone.detail.ordered_total_iqd, p.detail.ordered_total_iqd);
  assert.equal((await post(x.app, '/p/documents', clone.body)).status, 200);
  assert.equal(count(x.raw, "SELECT version n FROM procurement_cost_profiles WHERE id='germany_land'"), 4);
});

test('server rejects mismatched route currency/basis, missing packed measure and old landed cost as raw input', async () => {
  const x = setup();
  for (const change of [
    { currency: 'IQD' }, { shipping_basis: 'volume' }, { cost_profile_version: 100 },
    { lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', option_id: 'solo', qty_ordered: 1, source_unit_amount: 10, weight_g: 1000 }] },
    { lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', color_id: 'unbound-color', qty_ordered: 1, source_unit_amount: 10, weight_g: 1000 }] },
    { lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 10 }] },
    { lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 1, purchase_unit_iqd: 1523129, weight_g: 22300 }] },
    { lines: [{ product_id: 'part', scope: 'option', scope_id: 'combo', qty_ordered: 1, source_unit_amount: 10, weight_g: 1000 }] },
  ]) {
    const result = await post(x.app, '/p/documents', x.payload(change));
    assert.ok([400, 409].includes(result.status), JSON.stringify(await json(result)));
  }
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM procurement_selection_cost_defaults'), 0);
});

test('a profile settings race rolls back document, incoming stock, funding and selection defaults', async () => {
  const x = setup(), gate = x.pause(), pending = post(x.app, '/p/documents', x.payload());
  await gate.waiting;
  assert.equal((await put(x.app, '/p/cost-profiles/germany_land', { version: 1, exchange_rate: 1800, shipping_rate_iqd: 7000 })).status, 200);
  gate.resume();
  assert.equal((await pending).status, 409);
  for (const table of ['purchase_orders', 'purchase_lines', 'incoming_inventory', 'procurement_selection_cost_defaults']) assert.equal(count(x.raw, `SELECT COUNT(*) n FROM ${table}`), 0);
  assert.equal(count(x.raw, "SELECT exchange_rate n FROM procurement_cost_profiles WHERE id='germany_land'"), 1800);
});

test('assistant cannot see saved raw prices or change procurement defaults', async () => {
  const x = setup(); await x.create();
  const app = stubApp(x.db, { id: 'assistant', email: 'staff@x.co', role: 'admin', admin_scope: 'assistant' }, a => a.route('/p', adminProcurementRoutes));
  const selections = await json(await get(app, '/p/selections/printer'));
  assert.equal('procurement_defaults' in selections.selections[0], false);
  assert.equal('purchase_unit_iqd' in selections.selections[0], false);
  assert.equal((await get(app, '/p/config')).status, 403);
  assert.equal((await put(app, '/p/cost-profiles/germany_land', { version: 2, exchange_rate: 1, shipping_rate_iqd: 1 })).status, 403);
});

test('source total invoice decimals survive document reads and clones instead of reconstructing from rounded IQD', async () => {
  const x = setup(), p = await x.create(x.payload({ exchange_rate: 1.5, shipping_rate_iqd: 0,
    lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 3, purchase_cost_mode: 'total', source_total_amount: 2.005, weight_g: 22300 }] }));
  assert.equal(p.detail.lines[0].source_total_amount, 2.005);
  assert.equal(p.detail.lines[0].purchase_total_iqd, 3);
  const cloned = await x.create({ ...p.body, operation_id: crypto.randomUUID(), cost_profile_version: 2, lines: p.detail.lines });
  assert.equal(cloned.detail.lines[0].source_total_amount, 2.005);
  assert.equal(cloned.detail.lines[0].purchase_total_iqd, 3);
});


test('a repeating supplier invoice average never becomes a silently rounded raw default', async () => {
  const x = setup(), p = await x.create(x.payload({ currency: 'CNY', cost_profile_id: 'china_air', exchange_rate: 235.5, shipping_rate_iqd: 0,
    lines: [{ product_id: 'printer', scope: 'option', scope_id: 'combo', qty_ordered: 3, purchase_cost_mode: 'total', source_total_amount: 1, weight_g: 22300 }] }));
  assert.equal(p.detail.lines[0].purchase_total_iqd, 236);
  const saved = (await productSelections(x.db, 'printer')).find(s => s.scope_id === 'combo')!.procurement_defaults[0];
  assert.equal(saved.source_unit_amount, null);
  assert.equal(saved.weight_g, 22300);
  const clone = await x.create({ ...p.body, operation_id: crypto.randomUUID(), cost_profile_version: 2, lines: p.detail.lines });
  assert.equal(clone.detail.lines[0].source_total_amount, 1);
  assert.equal(clone.detail.lines[0].purchase_total_iqd, 236);
  assert.equal(exactProcurementUnitDefault(1, 3), null);
  assert.equal(exactProcurementUnitDefault(1, 128), null); // terminating, but exceeds input precision
  assert.equal(exactProcurementUnitDefault(1, 8), 0.125);
  assert.equal(exactProcurementUnitDefault(2565, 3), 855);
  assert.equal(exactProcurementUnitDefault(0, 3), 0);
});


test('profile CSV suggestions never substitute net weight for unknown packed weight', async () => {
  const x = setup(); x.raw.exec("UPDATE products SET sku='PART-CSV' WHERE id='part'");
  const csv = 'sku,qty,unit_amount,weight_g,volume_mm3\nPART-CSV,1,10,,';
  const profiled = await json(await post(x.app, '/p/import-preview', { csv, cost_profile_id: 'germany_land' }));
  assert.equal(profiled.lines[0].weight_g, 0);
  assert.equal(profiled.lines[0].volume_mm3, 0);
  const manual = await json(await post(x.app, '/p/import-preview', { csv }));
  assert.equal(manual.lines[0].weight_g, 1000);
  const explicit = await json(await post(x.app, '/p/import-preview', { csv: 'sku,qty,unit_amount,weight_g,volume_mm3\nPART-CSV,1,10,1500.5,1250000000', cost_profile_id: 'china_sea' }));
  assert.equal(explicit.lines[0].weight_g, 1500.5);
  assert.equal(explicit.lines[0].volume_mm3, 1250000000);
});
