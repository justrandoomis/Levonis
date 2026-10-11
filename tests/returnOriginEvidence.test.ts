import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, dbThrough, asD1, stubApp, get, post, json } from './fixtures/app';
import { planLotConsumption, planLotRestore, cogsByLine } from '../worker/lib/inventoryLots';
import { planCreateUnitOrigins, planReceiveUnitOrigins, resolveReturnedOriginIds } from '../worker/lib/inventoryUnitOrigins';
import { listReturnUnitOrigins, planReturnUnitEvidence, assertReturnUnitEvidenceReplay } from '../worker/lib/returnOriginEvidence';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';

async function setup() {
  const raw = freshDb(), db = asD1(raw);
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('buyer','Buyer','buyer@example.test','h','customer');
    INSERT INTO products(id,name,slug,price_iqd,inventory_mode,stock) VALUES ('product','A1','a1',2000,'BASE',3);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('order','buyer','pending','{}','std','{}','cod',6000,1400,6000,6000),('other','buyer','pending','{}','std','{}','cod',2000,1400,2000,2000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('line','order','product','A1',3,2000,6000),('line2','other','product','A1',1,2000,2000);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('old','product','base','',1,1,100,'received','2026-01-01'),('new','product','base','',2,2,150,'received','2026-02-01');`);
  await db.batch(planCreateUnitOrigins(db, { incomingId: 'incoming', purchaseLineId: 'purchase-line', purchaseId: 'purchase', actorId: 'admin',
    units: [1, 2].map(unit_index => ({ unit_index, supplier_order_no: `PO-${unit_index}`, tracking_no: `TRACK-${unit_index}` })) }));
  await db.batch(await planReceiveUnitOrigins(db, { incomingId: 'incoming', lotId: 'new', qty: 2 }));
  await db.batch((await planLotConsumption(db, 'order', [{ product_id: 'product', line_id: 'line', qty: 3, targets: [{ scope: 'base', scope_id: '', stock: 3, reserved: 0, low_stock_threshold: null, label: 'A1' }] }])).statements);
  raw.exec(`INSERT INTO order_item_units(id,order_id,order_item_id,owner_user_id,unit_index,inventory_lot_id)
    VALUES ('unit1','order','line','buyer',1,'old'),('unit2','order','line','buyer',2,'new'),('unit3','order','line','buyer',3,'new');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason)
    VALUES ('case1','order','line','buyer',2,'defective'),('case2','order','line','buyer',1,'defective');`);
  const origins = raw.prepare('SELECT origin_id FROM order_item_inventory_unit_assignments ORDER BY unit_index').all().map(r => String(r.origin_id));
  return { raw, db, origins };
}

test('inspection lists and saves exact mixed legacy/tracked units without changing stock or COGS', async () => {
  const ctx = await setup();
  try {
    const listed = await listReturnUnitOrigins(ctx.db);
    assert.equal(listed.length, 3);
    assert.equal(listed[0].origin_id, null);
    assert.equal(listed[0].unit_id, 'unit1');
    assert.equal(listed[2].supplier_order_no, 'PO-2');
    const evidence = await planReturnUnitEvidence(ctx.db, { caseId: 'case1', itemId: 'line', qty: 2, unitIds: ['unit1', 'unit3'], originIds: [ctx.origins[1]] });
    assert.equal(evidence.allocations?.length, 2);
    await ctx.db.batch(evidence.statements);
    assert.equal(ctx.raw.prepare('SELECT SUM(qty_remaining) AS qty FROM inventory_lots').get()?.qty, 0);
    assert.equal((await cogsByLine(ctx.db, ['order'])).get('line')?.cogs_iqd, 400);
    const selected = await resolveReturnedOriginIds(ctx.db, { orderId: 'order', itemId: 'line', qty: 2, returnCaseId: 'case1' });
    assert.deepEqual(selected?.originIds, [ctx.origins[1]]);
    assert.equal(Object.values(selected?.allocationQty ?? {}).reduce((n, qty) => n + qty, 0), 2);
    await ctx.db.batch((await planLotRestore(ctx.db, 'order', { qtyByLine: { line: 2 }, operation: 'return:case1', originIds: selected?.originIds, allocationQty: selected?.allocationQty })).statements);
    assert.equal(ctx.raw.prepare("SELECT qty_remaining FROM inventory_lots WHERE id='old'").get()?.qty_remaining, 1);
    assert.equal(ctx.raw.prepare("SELECT qty_remaining FROM inventory_lots WHERE id='new'").get()?.qty_remaining, 1);
    assert.equal(ctx.raw.prepare('SELECT origin_id FROM order_item_inventory_unit_assignments WHERE released_at IS NULL').get()?.origin_id, ctx.origins[0]);
  } finally { ctx.raw.close(); }
});

test('unit-specific legacy case saves precise evidence before its tracked siblings are returned', async () => {
  const ctx = await setup();
  try {
    ctx.raw.exec("UPDATE return_cases SET unit_id='unit1' WHERE id='case2'");
    const evidence = await planReturnUnitEvidence(ctx.db, { caseId: 'case2', itemId: 'line', qty: 1, caseUnitId: 'unit1' });
    await ctx.db.batch(evidence.statements);
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_unit_evidence').get()?.n, 0);
    assert.equal(ctx.raw.prepare('SELECT unit_id FROM stock_return_order_unit_evidence').get()?.unit_id, 'unit1');
    const selected = await resolveReturnedOriginIds(ctx.db, { orderId: 'order', itemId: 'line', qty: 1, returnCaseId: 'case2' });
    assert.deepEqual(selected?.originIds, []);
    assert.equal(Object.values(selected?.allocationQty ?? {}).reduce((n, qty) => n + qty, 0), 1);
  } finally { ctx.raw.close(); }
});

test('inspection rejects mismatched, duplicate, missing or case-inconsistent piece identities', async () => {
  const ctx = await setup();
  try {
    const base = { caseId: 'case2', itemId: 'line', qty: 1 };
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, base), /حدد كل قطعة/);
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...base, originIds: [ctx.origins[0], ctx.origins[0]] }));
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...base, originIds: ['foreign-origin'] }));
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...base, unitIds: ['unit3'], originIds: [ctx.origins[0]] }));
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...base, unitIds: ['unit3'], caseUnitId: 'unit1' }));
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...base, unitIds: ['unit3'], itemId: 'line2' }));
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_unit_evidence').get()?.n, 0);
  } finally { ctx.raw.close(); }
});

test('fully historical unit-specific inspection retains the existing serial-link fallback', async () => {
  const ctx = await setup();
  try {
    ctx.raw.exec(`INSERT INTO order_item_units(id,order_id,order_item_id,owner_user_id,unit_index)
      VALUES ('legacy-unit','other','line2','buyer',1);
      INSERT INTO return_cases(id,order_id,order_item_id,unit_id,user_id,qty,reason)
      VALUES ('legacy-case','other','line2','legacy-unit','buyer',1,'defective')`);
    assert.deepEqual(await planReturnUnitEvidence(ctx.db, { caseId: 'legacy-case', itemId: 'line2', qty: 1, caseUnitId: 'legacy-unit' }), { statements: [] });
  } finally { ctx.raw.close(); }
});

test('two preplanned inspections cannot claim the same origin or legacy unit', async () => {
  const ctx = await setup();
  try {
    ctx.raw.exec("UPDATE return_cases SET qty=1 WHERE id='case1'");
    const args = { itemId: 'line', qty: 1, originIds: [ctx.origins[1]], unitIds: ['unit3'] };
    const first = await planReturnUnitEvidence(ctx.db, { ...args, caseId: 'case1' });
    const racing = await planReturnUnitEvidence(ctx.db, { ...args, caseId: 'case2' });
    await ctx.db.batch(first.statements);
    await assert.rejects(() => ctx.db.batch(racing.statements));
    await assert.rejects(() => planReturnUnitEvidence(ctx.db, { ...args, caseId: 'case2' }), /مرتجع آخر/);
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_unit_evidence').get()?.n, 1);
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_order_unit_evidence').get()?.n, 1);
  } finally { ctx.raw.close(); }
});

test('inspection replay accepts identical exact identities and rejects a changed selection', async () => {
  const ctx = await setup();
  try {
    await ctx.db.batch((await planReturnUnitEvidence(ctx.db, { caseId: 'case2', itemId: 'line', qty: 1, unitIds: ['unit3'], originIds: [ctx.origins[1]] })).statements);
    await assertReturnUnitEvidenceReplay(ctx.db, 'case2', [ctx.origins[1]], ['unit3']);
    await assert.rejects(() => assertReturnUnitEvidenceReplay(ctx.db, 'case2', [ctx.origins[0]], ['unit2']), /لقطع مختلفة/);
  } finally { ctx.raw.close(); }
});

test('a returned piece can later be sold and inspected again without its old claim blocking it', async () => {
  const ctx = await setup();
  try {
    await ctx.db.batch((await planReturnUnitEvidence(ctx.db, { caseId: 'case2', itemId: 'line', qty: 1, unitIds: ['unit3'], originIds: [ctx.origins[1]] })).statements);
    const selected = await resolveReturnedOriginIds(ctx.db, { orderId: 'order', itemId: 'line', qty: 1, returnCaseId: 'case2' });
    await ctx.db.batch((await planLotRestore(ctx.db, 'order', { qtyByLine: { line: 1 }, operation: 'return:case2', originIds: selected?.originIds, allocationQty: selected?.allocationQty })).statements);
    ctx.raw.exec("UPDATE return_cases SET state='resolved' WHERE id='case2'");
    await ctx.db.batch((await planLotConsumption(ctx.db, 'other', [{ product_id: 'product', line_id: 'line2', qty: 1, targets: [{ scope: 'base', scope_id: '', stock: 1, reserved: 0, low_stock_threshold: null, label: 'A1' }] }])).statements);
    ctx.raw.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason) VALUES ('case3','other','line2','buyer',1,'defective')");
    assert.equal((await listReturnUnitOrigins(ctx.db)).find(r => r.order_item_id === 'line2')?.claimed, 0);
    await ctx.db.batch((await planReturnUnitEvidence(ctx.db, { caseId: 'case3', itemId: 'line2', qty: 1, originIds: [ctx.origins[1]] })).statements);
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_unit_evidence WHERE origin_id=?').get(ctx.origins[1])?.n, 2);
  } finally { ctx.raw.close(); }
});

test('deploy ahead leaves historical inspection routes available while rejecting unsupported evidence', async () => {
  const raw = dbThrough('0186'), db = asD1(raw);
  try {
    assert.deepEqual(await listReturnUnitOrigins(db), []);
    assert.deepEqual(await planReturnUnitEvidence(db, { caseId: 'case', itemId: 'item', qty: 1 }), { statements: [] });
    await assert.rejects(() => planReturnUnitEvidence(db, { caseId: 'case', itemId: 'item', qty: 1, originIds: ['origin'] }), /لم يطبق/);
  } finally { raw.close(); }
});

test('assistant route exposes internal evidence and saves the UI payload; customers cannot read it', async () => {
  const ctx = await setup();
  try {
    ctx.raw.exec("INSERT INTO users(id,email,role,admin_scope) VALUES ('assistant','assistant@example.test','admin','assistant')");
    const mount = (a: Parameters<typeof stubApp>[2] extends (app: infer T) => void ? T : never) => a.route('/s', adminStockOperationsRoutes);
    const app = stubApp(ctx.db, { id: 'assistant', email: 'assistant@example.test', role: 'admin', admin_scope: 'assistant' }, mount);
    const response = await get(app, '/s/trace'), trace = await json(response);
    assert.equal(response.status, 200);
    assert.equal(trace.return_unit_origins.find((r: { unit_id: string }) => r.unit_id === 'unit3').supplier_order_no, 'PO-2');
    const body = { operation_id: crypto.randomUUID(), return_case_id: 'case2', disposition: 'restock', inventory_origin_ids: [ctx.origins[1]], unit_ids: ['unit3'] };
    const saved = await post(app, '/s/return-inspections', body);
    assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM stock_return_unit_evidence').get()?.n, 1);
    assert.equal((await post(app, '/s/return-inspections', body)).status, 200);
    assert.equal((await post(app, '/s/return-inspections', { ...body, inventory_origin_ids: [ctx.origins[0]], unit_ids: ['unit2'] })).status, 409);
    const customer = stubApp(ctx.db, { id: 'buyer', email: 'buyer@example.test', role: 'customer' }, mount);
    assert.equal((await get(customer, '/s/trace')).status, 403);
  } finally { ctx.raw.close(); }
});
