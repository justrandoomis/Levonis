/**
 * Services S-P2 privacy (DECISIONS row 238; spec §9, §13.6). Every new and changed answer, read as
 * the customer, an assistant, a financial admin and the owner:
 *
 *   - a recursive key scan: no customer and no staff answer carries the owner's valuation record
 *     (store cap, resale, costs, margins, the condition factor, the rule parameters, a component's
 *     USD reference, the stock cost basis, a lot's unit cost); the customer reads no ceiling, no
 *     desk notes and no count of previews either;
 *   - the leak scanner of tests/fixtures/costlyProduct.ts over the same bodies, with the lot cost of
 *     a resold trade-in seeded as a sentinel;
 *   - the owner's doors refuse everyone else with COST_ACCESS_DENIED, the same body for a real
 *     and an invented id.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/sv2_p2_privacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { blankInputs } from '@levonis/pricing/tradeIn';
import { get, json, post, send, stubApp, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { leaks } from './fixtures/costlyProduct';
import { adminServicesRoutes, myServicesRoutes } from '../worker/routes/myServices';
import { CUSTOMER, OWNER, STAFF, adminApp, customerApp, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
/** A traded-in device's lot cost, resold: no answer but the owner's may carry this number. */
const LOT_SENTINEL = 734_517;

const STAFF_FORBIDDEN = [
  'store_cap_iqd', 'resale_iqd', 'costs_iqd', 'margin_iqd', 'expected_margin_iqd', 'q_bp', 'cap_bp', 'floor_bp', 'resale_bp',
  'handling_iqd', 'warranty_reserve_bp', 'margin_bp', 'margin_min_iqd', 'max_offer_bp', 'factors', 'weight_bp', 'ams_reference_iqd',
  'ref_price_usd', 'cost_basis_iqd', 'unit_cost_iqd', 'params', 'components_json', 'store_cap', 'expected_margin', 'valuations',
];
const CUSTOMER_FORBIDDEN = [...STAFF_FORBIDDEN, 'ceiling_iqd', 'ceiling_at', 'above_ceiling', 'intake_json', 'intake_inputs', 'intake_photos', 'previews', 'serial_norm', 'findings'];

function keysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysIn(x, out);
    }
  }
  return out;
}

const problems: string[] = [];
function scan(label: string, body: unknown, forbidden: readonly string[]) {
  const keys = keysIn(body);
  for (const k of forbidden) if (keys.has(k)) problems.push(`${label}: key ${k}`);
  for (const l of leaks(body, { numbers: [LOT_SENTINEL] })) problems.push(`${label}: ${l}`);
}
async function read(label: string, res: Response, forbidden: readonly string[]) {
  const body = await json(res);
  assert.ok(res.status >= 200 && res.status < 300, `${label}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  scan(label, body, forbidden);
  return body;
}

function world(): DatabaseSync {
  const raw = seed();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope)
              VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
            UPDATE users SET phone_e164 = '+9647701234567' WHERE id = 'cust';`);
  return raw;
}

/** Another customer's device, traded in and resold: its lot at the sentinel cost. */
function seedResoldLot(raw: DatabaseSync) {
  const now = new Date().toISOString();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('other','Omar','omar@x.co','h','customer');
    INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, scope, created_at, updated_at, submitted_at, completed_at, credit_iqd, final_value_iqd)
      VALUES ('tin_resold_0000000001', 'other', 'completed', 'ORD-OTHER', 'oi_other', 1, 'fdm', 'whole', '${now}', '${now}', '${now}', '${now}', 0, 0);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id)
      VALUES ('prd_ti_resold','used-a1-resold','Bambu Lab A1 (used)','A1 مستعملة',0,'hidden',0,'[]','[]','direct_sale','["direct_sale"]','[]','cat_used');
    INSERT INTO inventory_lots (id, product_id, scope, qty_received, qty_remaining, unit_cost_iqd, total_cost_iqd, cost_basis, received_at)
      VALUES ('ilot_ti_resold', 'prd_ti_resold', 'base', 1, 0, ${LOT_SENTINEL}, ${LOT_SENTINEL}, 'received', '${now}');
    INSERT INTO trade_in_stock (request_id, lot_id, product_id, source_product_id, cost_basis_iqd, order_id, created_at)
      VALUES ('tin_resold_0000000001', 'ilot_ti_resold', 'prd_ti_resold', 'p_a1', ${LOT_SENTINEL}, 'ORD-OTHER', '${now}');
  `);
}

test('every customer and staff answer of the trade-in v2 doors carries no private key and no private figure; the owner’s doors refuse everyone else alike', async () => {
  const raw = world();
  seedResoldLot(raw);
  const a = customerApp(raw);

  // ---------------------------------------------------------------- the customer
  await read('customer GET /eligible', await get(a, '/api/trade-in/eligible'), CUSTOMER_FORBIDDEN);
  await read('customer GET /targets', await get(a, '/api/trade-in/targets?q=bambu'), CUSTOMER_FORBIDDEN);
  await read('customer GET /entry', await get(a, '/api/trade-in/entry?product_id=p_p1s'), CUSTOMER_FORBIDDEN);
  await read('customer POST /target-quote', await post(a, '/api/trade-in/target-quote', { target: { product_id: 'p_p1s', option_value_ids: [], color_id: null } }), CUSTOMER_FORBIDDEN);
  const draft = await read('customer POST /requests', await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }), CUSTOMER_FORBIDDEN);
  const draftId = draft.request.id as string;
  await read(
    'customer PATCH /requests/:id',
    await send(a, 'PATCH', `/api/trade-in/requests/${draftId}`, { components: { device: blankInputs('fdm') }, target: { product_id: 'p_p1s', option_value_ids: [], color_id: null } }),
    CUSTOMER_FORBIDDEN
  );
  await read('customer POST /preview', await post(a, `/api/trade-in/requests/${draftId}/preview`), CUSTOMER_FORBIDDEN);
  await read('customer POST /cancel (draft)', await post(a, `/api/trade-in/requests/${draftId}/cancel`), CUSTOMER_FORBIDDEN);

  const id = await submitted(raw);
  await read('customer GET /requests/:id (sent)', await get(a, `/api/trade-in/requests/${id}`), CUSTOMER_FORBIDDEN);

  // ---------------------------------------------------------------- the desk
  for (const [who, label] of [[ASSISTANT, 'assistant'], [STAFF, 'financial']] as const) {
    await read(`${label} GET /requests`, await get(adminApp(raw, who), '/api/admin/trade-in/requests?q=a1'), STAFF_FORBIDDEN);
    await read(`${label} GET /requests/:id`, await get(adminApp(raw, who), `/api/admin/trade-in/requests/${id}`), STAFF_FORBIDDEN);
    const badgeApp = stubApp(new LimitD1(raw) as unknown as D1Database, who, (x) => x.route('/api/admin/services', adminServicesRoutes));
    await read(`${label} GET /services/badge`, await get(badgeApp, '/api/admin/services/badge'), STAFF_FORBIDDEN);
  }
  const intake = await received(raw, id, { by: ASSISTANT });
  scan('assistant POST /intake', intake, STAFF_FORBIDDEN);
  await read('financial GET /requests/:id (received)', await get(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}`), STAFF_FORBIDDEN);
  await read('financial POST /value', await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 100_000, reason: 'Scratched bed and a worn nozzle' }), STAFF_FORBIDDEN);
  await settle();
  await read('customer GET /requests/:id (value proposed)', await get(a, `/api/trade-in/requests/${id}`), CUSTOMER_FORBIDDEN);
  await read('customer POST /accept', await post(a, `/api/trade-in/requests/${id}/accept`, { offer_no: 1 }), CUSTOMER_FORBIDDEN);
  await read('customer POST /checkout', await post(a, `/api/trade-in/requests/${id}/checkout`), CUSTOMER_FORBIDDEN);
  await read('customer GET /requests', await get(a, '/api/trade-in/requests'), CUSTOMER_FORBIDDEN);
  const services = stubApp(new LimitD1(raw) as unknown as D1Database, CUSTOMER, (x) => x.route('/api/me/services', myServicesRoutes));
  await read('customer GET /api/me/services', await get(services, '/api/me/services'), CUSTOMER_FORBIDDEN);

  // A second request approved at the ceiling by the financial admin.
  const raw2 = world();
  const id2 = await submitted(raw2);
  await received(raw2, id2);
  await read('financial POST /approve', await post(adminApp(raw2, STAFF), `/api/admin/trade-in/requests/${id2}/approve`), STAFF_FORBIDDEN);

  // ---------------------------------------------------------------- the owner's doors
  for (const path of [`/requests/${id}/valuation`, '/policy', '/component-refs', '/pnl', '/rules']) {
    for (const who of [ASSISTANT, STAFF]) {
      const res = await get(adminApp(raw, who), `/api/admin/trade-in${path}`);
      const body = await json(res);
      assert.deepEqual([res.status, body.code], [403, 'COST_ACCESS_DENIED'], `${who.id} ${path}`);
      scan(`${who.id} ${path} (refused)`, body, STAFF_FORBIDDEN);
    }
    assert.equal((await get(adminApp(raw, OWNER), `/api/admin/trade-in${path}`)).status, 200, `owner ${path}`);
  }
  const real = await json(await get(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/valuation`));
  const invented = await json(await get(adminApp(raw, STAFF), '/api/admin/trade-in/requests/tin_ffffffffffffffffffff/valuation'));
  assert.deepEqual(real, invented, 'the same refusal for a real and an invented id');
  // The owner reads the record — and the resold lot's cost is theirs alone.
  const pnl = (await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/pnl'))).pnl;
  assert.equal(typeof pnl.in_stock.cost_iqd, 'number');

  assert.deepEqual(problems, []);
});

test('review F-6: a Combo traded part by part, its AMS priced by the owner’s private reference — the request carries no paid split that would give the reference away', async () => {
  const { all, withoutTriggers } = await import('./fixtures/app');
  // Combo cheaper than the plain model today: no public gap, so the owner's USD reference prices the AMS.
  const raw = seed({ a1Now: 1_100_000, comboNow: 1_000_000 });
  const paid = 1_000_000;
  const d = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 345 * 86_400_000).toISOString();
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at)
      VALUES ('ORD-C','cust','delivered','delivered','{}','standard','{}','cash',${paid},0,1400,${paid},0,'${d}','${d}','${d}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids)
      VALUES ('oi_c','ORD-C','p_a1','Bambu Lab A1 Combo','','A1 Combo',1,${paid},${paid},'v_a1c','["v_a1c"]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_c','ORD-C','oi_c','p_a1','cust',1,'${d}',12,0,'${d}','${end}','{}');
    INSERT INTO trade_in_component_refs (product_id, option_value_id, role, ref_product_id, ref_price_usd, updated_by, updated_at)
      VALUES ('p_a1', '', 'ams', NULL, '213.37', 'boss', '${d}');
  `);
  await get(customerApp(raw), '/api/trade-in/eligible'); // publishes the seeded catalogue (V2)
  const triggers = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('product_option_values')").map((t) => t.name);
  withoutTriggers(raw, triggers, `UPDATE product_option_values SET regular_price_iqd = 2000000 WHERE id = 'v_a1c'; UPDATE product_option_values SET regular_price_iqd = 1000000 WHERE id = 'v_a1';`);
  const id = await submitted(raw, 'oi_c', 'ams_only');
  // The owner's record holds the AMS's private price; the request itself carries no split of what was paid.
  const val = raw.prepare('SELECT components_json FROM trade_in_valuations WHERE request_id = ?').get(id) as { components_json: string };
  const ams = (JSON.parse(val.components_json) as Array<{ role: string; now_source: string }>).find((c) => c.role === 'ams');
  assert.equal(ams?.now_source, 'owner_usd');
  assert.equal((raw.prepare('SELECT paid_net_iqd FROM trade_in_requests WHERE id = ?').get(id) as { paid_net_iqd: number | null }).paid_net_iqd, null);
  for (const [label, res] of [
    ['customer', await get(customerApp(raw), `/api/trade-in/requests/${id}`)],
    ['staff', await get(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}`)],
  ] as const) {
    const body = await json(res);
    assert.equal(res.status, 200, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.request.paid_net_iqd, null, label);
  }
});
