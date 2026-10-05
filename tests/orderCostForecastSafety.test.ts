import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, freshDb, get, json, row, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { participantSources, participantSummary } from '../worker/lib/financeParticipants';

function setup() {
  const raw = freshDb(), inner = asD1(raw), queries: string[] = [];
  const db = {
    prepare(sql: string) { queries.push(sql); return inner.prepare(sql); },
    batch(statements: D1PreparedStatement[]) { return inner.batch(statements); },
  } as D1Database;
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    UPDATE finance_staff SET user_id='employee' WHERE id='staff_hussein';
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,inventory_mode,stock)
      VALUES ('petg','PETG Basic','forecast-petg',18000,NULL,'VARIANT_COMBINATION',0);
    INSERT INTO product_option_groups(id,product_id,name_en,sort) VALUES ('model','petg','Model',0);
    INSERT INTO product_option_values(id,product_id,group_id,name_en,cost_iqd,sort)
      VALUES ('refill','petg','model','Refill',10000,0),('spool','petg','model','Spool',12500,1),('unknown','petg','model','Unknown',NULL,2),('free','petg','model','Free',0,3);
    INSERT INTO product_colors(id,product_id,name_en,hex,cost_iqd) VALUES
      ('black','petg','Black','#000000',NULL),('white','petg','White','#ffffff',6000);
    INSERT INTO product_variants(id,product_id,combo_key,stock,cost_iqd) VALUES
      ('refill-black','petg','o:refill|c:black',0,NULL),('spool-black','petg','o:spool|c:black',0,NULL),
      ('refill-white','petg','o:refill|c:white',0,NULL),('unknown-black','petg','o:unknown|c:black',0,NULL),('free-black','petg','o:free|c:black',0,NULL);`);
  const addOrder = (id: string, option = 'refill', color = 'black', status = 'pending', qty = 1) => {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES (?,'buyer',?,'{}','standard','{}','cash',?,1500,?,?, '2026-10-04T10:00:00Z',?)`)
      .run(id, status, qty * 18000, qty * 18000, qty * 18000, status === 'delivered' ? '2026-10-05T10:00:00Z' : null);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,option_id,option_value_ids,color_id)
      VALUES (?,?,'petg','PETG Basic',?,18000,?,NULL,'unpriced',?,?,?)`)
      .run(`line-${id}`, id, qty, qty * 18000, option, JSON.stringify([option]), color);
  };
  const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => a.route('/f', adminFinanceWorkspaceRoutes));
  const detail = async (id: string) => {
    const response = await get(app, `/f/orders/${id}`), value = await json(response);
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  return { raw, db, queries, app, addOrder, detail };
}

test('active main-store orders without variant IDs forecast the exact zero-stock option/colour while preserving historical unknown cost', async () => {
  const x = setup(); x.addOrder('refill'); x.addOrder('spool', 'spool'); x.addOrder('white', 'refill', 'white');
  const before = count(x.raw, 'SELECT total_changes() n');
  for (const [id, cost] of [['refill', 10000], ['spool', 12500], ['white', 6000]] as const) {
    const detail = await x.detail(id), line = detail.lines[0];
    assert.equal(detail.order.status, 'pending');
    assert.equal(detail.has_financial_activity, false);
    assert.equal(line.variant_id, null);
    assert.equal(line.cogs_iqd, null);
    assert.equal(line.cost_confidence, 'unknown');
    assert.equal(line.cost_projection.source, 'current_catalogue');
    assert.equal(line.cost_projection.total_cost_iqd, cost);
    assert.deepEqual(detail.projected_finance, { is_estimate: true, cogs_iqd: cost, gross_profit_iqd: 18000 - cost, owner_net_iqd: null });
    assert.equal(detail.totals.owner_net_iqd, null);
    assert.equal((await getOrderProfitBase(x.db, id)).totals.cogs_iqd, null, 'forecasts never feed the actual profit reader');
  }
  const response = await get(x.app, '/f/orders?from=2026-10-01&to=2026-10-31'), list = await json(response);
  assert.equal(response.status, 200, JSON.stringify(list));
  assert.equal(list.orders.find((order: { id: string }) => order.id === 'refill').projected_finance.gross_profit_iqd, 8000);
  assert.equal(count(x.raw, 'SELECT total_changes() n'), before, 'opening list/details cannot post or rewrite any history');
});

test('unallocated unpriced or insufficient stock uses only the exact catalogue estimate; a fully priced queue is a separate forecast source', async () => {
  const x = setup(); x.addOrder('queued');
  x.raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
    VALUES ('opening','petg','variant','refill-black',1,1,NULL,'opening_unpriced','2026-10-01');`);
  let detail = await x.detail('queued');
  assert.equal(detail.lines[0].cost_projection.source, 'current_catalogue');
  assert.equal(detail.projected_finance.cogs_iqd, 10000);
  assert.equal(detail.projected_finance.gross_profit_iqd, 8000);
  x.raw.exec("UPDATE inventory_lots SET unit_cost_iqd=7000,cost_basis='opening' WHERE id='opening'");
  detail = await x.detail('queued');
  assert.equal(detail.lines[0].cost_projection.source, 'confirmed_lot');
  assert.equal(detail.lines[0].cost_projection.source_id, 'opening');
  assert.equal(detail.projected_finance.cogs_iqd, 7000);
  x.addOrder('insufficient', 'refill', 'black', 'pending', 2);
  detail = await x.detail('insufficient');
  assert.equal(detail.lines[0].cost_projection.source, 'current_catalogue');
  assert.equal(detail.projected_finance.cogs_iqd, 20000, 'do not mix a partial queue with an unverified remainder');
  assert.equal(detail.lines[0].cogs_iqd, null);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM order_item_inventory_allocations'), 0);
  assert.equal(row(x.raw, "SELECT qty_remaining FROM inventory_lots WHERE id='opening'")?.qty_remaining, 1);
});

test('real partial or unpriced FIFO cannot be replaced by a catalogue forecast or an old snapshot', async () => {
  const x = setup(); x.addOrder('partial', 'refill', 'black', 'pending', 2); x.addOrder('unpriced');
  x.raw.exec(`UPDATE order_items SET cost_iqd=10000,cost_basis='snapshot';
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('issued','petg','variant','refill-black',2,0,7000,'opening','2026-10-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES
      ('partial-issued','partial','line-partial','issued','variant','refill-black',1,7000,7000,'forecast-partial'),
      ('unknown-issued','unpriced','line-unpriced','issued','variant','refill-black',1,NULL,NULL,'forecast-unknown');`);
  const before = count(x.raw, 'SELECT total_changes() n');
  for (const [id, issue] of [['partial', 'fifo_quantity_incomplete'], ['unpriced', 'fifo_cost_missing']] as const) {
    const detail = await x.detail(id);
    assert.equal(detail.has_financial_activity, true);
    assert.equal(detail.lines[0].cogs_iqd, null);
    assert.equal(detail.lines[0].cost_projection, undefined);
    assert.equal(detail.projected_finance.cogs_iqd, null);
    assert.equal(detail.projected_finance.gross_profit_iqd, null);
    assert.ok(detail.lines[0].cost_review.issues.some((value: { code: string }) => value.code === issue));
  }
  assert.equal(count(x.raw, 'SELECT total_changes() n'), before);
});

test('terminal orders never create a new forecast and a delivered unknown cost remains unverified', async () => {
  const x = setup();
  for (const status of ['delivered', 'cancelled']) x.addOrder(status, 'refill', 'black', status);
  const before = count(x.raw, 'SELECT total_changes() n');
  for (const status of ['delivered', 'cancelled']) {
    const detail = await x.detail(status);
    assert.equal(detail.order.status, status);
    assert.equal(detail.projected_finance, undefined);
    assert.equal(detail.lines[0].cost_projection, undefined);
    assert.equal(detail.lines[0].cogs_iqd, null);
    assert.equal(detail.has_financial_activity, status === 'delivered');
    if (status === 'delivered') {
      assert.equal(detail.lines[0].cost_review.suggestion.total_cost_iqd, 10000);
      assert.equal(detail.lines[0].cost_review.suggestion.requires_confirmation, true);
    }
  }
  assert.equal(count(x.raw, 'SELECT total_changes() n'), before);
});

test('unknown costs and invalid selections remain null while a genuine zero stays known', async () => {
  const x = setup(); x.addOrder('unknown', 'unknown'); x.addOrder('zero', 'free'); x.addOrder('invalid');
  x.raw.exec("UPDATE order_items SET option_value_ids='[\"does-not-exist\"]' WHERE order_id='invalid'");
  for (const id of ['unknown', 'invalid']) {
    const detail = await x.detail(id);
    assert.equal(detail.projected_finance.cogs_iqd, null);
    assert.equal(detail.projected_finance.gross_profit_iqd, null);
    assert.equal(detail.lines[0].cogs_iqd, null);
  }
  const zero = await x.detail('zero');
  assert.equal(zero.lines[0].cost_projection.total_cost_iqd, 0);
  assert.equal(zero.projected_finance.gross_profit_iqd, 18000);
  assert.equal(zero.projected_finance.owner_net_iqd, null);
});

test('multiple option groups use checkout relation ordering including authored name ties rather than SQL ID ordering', async () => {
  const x = setup(); x.addOrder('multi-group');
  x.raw.exec(`INSERT INTO product_option_groups(id,product_id,name_en,sort) VALUES ('zz-addon-group','petg','Addon',0);
    INSERT INTO product_option_values(id,product_id,group_id,name_en,cost_iqd,sort) VALUES ('a-addon','petg','zz-addon-group','Addon',2000,0);
    INSERT INTO product_variants(id,product_id,combo_key,stock,cost_iqd) VALUES ('refill-addon-black','petg','o:a-addon|o:refill|c:black',0,NULL);
    UPDATE order_items SET option_id='a-addon',option_value_ids='["a-addon","refill"]' WHERE order_id='multi-group';`);
  const detail = await x.detail('multi-group');
  assert.equal(detail.lines[0].cost_projection.source_id, 'refill-addon-black');
  assert.equal(detail.lines[0].cost_projection.total_cost_iqd, 2000);
  assert.equal(detail.projected_finance.gross_profit_iqd, 16000);
  assert.equal(detail.lines[0].cogs_iqd, null);
});

test('API forecasts use a fixed batch of selection reads and never release a pending wage or write accounting', async () => {
  const x = setup(); x.addOrder('one');
  x.raw.exec(`INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','forecast-wages','أجور');
    INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('pending-wage','one','line-one','percent',1,'Percentage','profit','staff_hussein','wages','delivered',NULL,1,NULL,'2026-10-04','pending_cost','{"rule":{"basis":"profit_percent","amount":1000}}');`);
  const list = async () => {
    x.queries.length = 0;
    const response = await get(x.app, '/f/orders?from=2026-10-01&to=2026-10-31'), value = await json(response);
    assert.equal(response.status, 200, JSON.stringify(value));
    const selectionReads = x.queries.filter(sql => /FROM (?:product_option_values|product_colors|product_variants|product_option_fulfillment|product_option_transports|product_option_groups|product_color_option_links|inventory_lots)|SELECT \* FROM products WHERE id IN/.test(sql));
    return { value, selectionReads };
  };
  const single = await list();
  for (let i = 0; i < 24; i++) x.addOrder(`bulk-${i}`, i % 2 ? 'spool' : 'refill');
  const before = count(x.raw, 'SELECT total_changes() n'), many = await list();
  assert.equal(many.value.orders.length, 25);
  assert.equal(many.selectionReads.length, single.selectionReads.length, 'selection queries must not grow per order');
  assert.equal(many.selectionReads.length, 9);
  assert.ok(many.selectionReads.every(sql => sql.includes('json_each(?)')));
  await x.detail('one');
  assert.equal(participantSummary(await participantSources(x.db, 'employee')).available_earnings_iqd, 0);
  assert.equal(row(x.raw, "SELECT amount_iqd,state FROM finance_order_costs WHERE id='pending-wage'")?.state, 'pending_cost');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_order_adjustments'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_staff_payments'), 0);
  assert.equal(count(x.raw, 'SELECT total_changes() n'), before);
});
