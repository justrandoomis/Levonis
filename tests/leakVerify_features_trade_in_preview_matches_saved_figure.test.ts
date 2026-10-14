/**
 * LEAK VERIFY (features) — the trade-in wizard's live figure, now priced by the
 * Worker (POST /api/trade-in/requests/:id/preview, DECISIONS row 220), is the
 * same figure the request carries once the answers are saved.
 *
 * Before row 220 the wizard ran the engine on the phone over the rules it was
 * sent; now `TradeInWizard` posts `{ components: inputs, target }` to the
 * preview door every time an answer changes and shows what it answers. No
 * test exercised the door. This one drives the real routes the way the wizard
 * does: the same body to the preview and to PATCH (the save), for one part,
 * for a Combo's two parts, with and without the target the wizard quoted.
 * The figures must agree, nothing may be stored by a preview, and a customer
 * answer that the save would refuse must be refused the same way.
 *
 * Since Services V2 (trade-in G11) the preview is COUNTED and a draft's own
 * view carries no figure for its customer — saving answers and reading the
 * draft back would be an uncounted door to the same figure. So "the figure
 * the request then carries" is read where it still lives: the desk's view of
 * the saved draft (GET /api/admin/trade-in/requests/:id), which is the figure
 * the submit fixes.
 *
 * LOCAL ONLY: in-memory SQLite, the real trade-in routes, a stub session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, post, get, json, send, OWNER, type StubUser } from './fixtures/app';
import { tradeInRoutes, adminTradeInRoutes } from '../worker/routes/tradeIn';
import { blankInputs } from '../packages/pricing/src/tradeIn';

const CUSTOMER: StubUser = { id: 'cust', role: 'customer', email: 'sara@x.co' };
const DELIVERED = '2025-09-26T00:00:00.000Z';

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('${OWNER.id}','owner','${OWNER.email}','h','admin','2026-01-01T00:00:00.000Z','ar');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',850000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_p1s','p1s','Bambu Lab P1S','بامبو P1S',1500000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_resin','saturn','Elegoo Saturn 4','إليغو ساتورن 4',600000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_resin');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a1','p_a1','Model',0,1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, sort, active, regular_price_iqd, variant_key) VALUES
      ('v_a1','p_a1','g_a1','A1','A1',0,1,850000,'a1'),
      ('v_a1c','p_a1','g_a1','A1 Combo','A1 كومبو',1,1,1150000,'a1-combo');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-DLV','cust','delivered','delivered','{}','standard','{}','cash',1700000,0,1400,1700000,0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_combo','ORD-DLV','p_a1','Bambu Lab A1','','A1 Combo',1,1100000,1100000,'v_a1c','["v_a1c"]'),
      ('oi_resin','ORD-DLV','p_resin','Elegoo Saturn 4','','',1,600000,600000,'','[]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_combo','ORD-DLV','oi_combo','p_a1','cust',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-09-26T00:00:00.000Z','{}');
  `);
  return raw;
}
const appOf = (raw: DatabaseSync) => stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes));
const deskOf = (raw: DatabaseSync) => stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes));

type Est = { total_iqd: number; components: Array<{ role: string; value_iqd: number }>; settlement: { difference_iqd?: number } | null };
type DeskEst = { total_iqd: number; components: Array<{ role: string; valuation: { value_iqd: number } }>; settlement: { difference_iqd?: number } | null };

/** The saved draft's figure, as the desk reads it (and the submit will fix it). */
async function carried(raw: DatabaseSync, id: string): Promise<Est> {
  const res = await get(deskOf(raw), `/api/admin/trade-in/requests/${id}`);
  assert.equal(res.status, 200, await res.clone().text());
  const e = (await json(res)).request.estimate as DeskEst;
  assert.ok(e, 'the desk reads the saved draft\'s figure');
  return { total_iqd: e.total_iqd, components: e.components.map((c) => ({ role: c.role, value_iqd: c.valuation.value_iqd })), settlement: e.settlement };
}

async function open(raw: DatabaseSync, order_item_id: string, scope: string) {
  const body = await json(await post(appOf(raw), '/api/trade-in/requests', { order_item_id, unit_index: 1, scope }));
  assert.ok(body.request?.id, JSON.stringify(body));
  // The customer's own draft carries no figure (trade-in G11): the preview door is the only one.
  assert.equal(body.request.estimate, null, JSON.stringify(body.request.estimate));
  assert.equal(body.request.estimated_iqd, null);
  return body.request as { id: string; components: Array<{ role: string; family: 'fdm' | 'ams' | 'resin' }> };
}

function answersFor(req: Awaited<ReturnType<typeof open>>, over: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(req.components.map((c) => [c.role, { ...blankInputs(c.family), ...(over[c.role] ?? {}) }]));
}

const parts = (e: Est) => e.components.map((c) => [c.role, c.value_iqd]);

for (const [label, item, scope, over] of [
  ['one part (resin)', 'oi_resin', 'whole', { device: { exterior: 2, scratches: 3, repairs_count: 1, original_accessories: 'partial' } }],
  ['a Combo, two parts', 'oi_combo', 'whole', { device: { hours: 900, cleanliness: 3 }, ams: { exterior: 1, original_accessories: 'none' } }],
] as const) {
  test(`preview = save, ${label}: the live figure the wizard shows is the figure the request then carries`, async () => {
    const raw = seed();
    const a = appOf(raw);
    const req = await open(raw, item, scope);
    const components = answersFor(req, over as Record<string, Record<string, unknown>>);

    const before = raw.prepare('SELECT inputs_json FROM trade_in_components WHERE request_id = ? ORDER BY role').all(req.id);
    const preview = await post(a, `/api/trade-in/requests/${req.id}/preview`, { components });
    assert.equal(preview.status, 200, await preview.clone().text());
    const live = (await json(preview)).estimate as Est;
    assert.deepEqual(raw.prepare('SELECT inputs_json FROM trade_in_components WHERE request_id = ? ORDER BY role').all(req.id), before, 'a preview stores nothing');

    const blank = (await json(await post(a, `/api/trade-in/requests/${req.id}/preview`, {}))).estimate as Est;
    const saved = (await json(await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { components }))).request;
    assert.equal(saved.estimate, null, 'saving answers does not hand the customer a figure');
    const desk = await carried(raw, req.id);
    assert.deepEqual(parts(live), parts(desk), 'each part: the wizard\'s live value = the saved value');
    assert.equal(live.total_iqd, desk.total_iqd, 'the total: live = saved');
    assert.ok(live.total_iqd > 0, 'a real figure');
    assert.notEqual(live.total_iqd, blank.total_iqd, 'the answers moved the figure (the door read them)');
  });
}

test('preview = save with the target the wizard quoted: the settlement agrees, and the stored target is untouched by a preview', async () => {
  const raw = seed();
  const a = appOf(raw);
  const req = await open(raw, 'oi_resin', 'whole');
  const components = answersFor(req, { device: { exterior: 3 } });
  const target = { product_id: 'p_p1s', option_value_ids: [], color_id: null };

  const live = (await json(await post(a, `/api/trade-in/requests/${req.id}/preview`, { components, target }))).estimate as Est;
  assert.ok(live.settlement, `the wizard shows a settlement once a target is quoted: ${JSON.stringify(live)}`);
  assert.equal(raw.prepare('SELECT target_product_id t FROM trade_in_requests WHERE id = ?').get(req.id)!.t, null, 'a preview chooses no target');

  await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { components });
  await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { target });
  const saved = await carried(raw, req.id);
  assert.deepEqual(live.settlement, saved.settlement, 'the settlement the wizard showed = the one saved');
  assert.equal(live.total_iqd, saved.total_iqd);
});

test('an answer the save refuses, the preview refuses the same way (the wizard shows no invented figure)', async () => {
  const raw = seed();
  const a = appOf(raw);
  const req = await open(raw, 'oi_resin', 'whole');
  const bad = answersFor(req, { device: { faults: ['not-a-fault'] } });
  const p = await post(a, `/api/trade-in/requests/${req.id}/preview`, { components: bad });
  const s = await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { components: bad });
  assert.equal(p.status, s.status, 'same status');
  assert.equal((await json(p)).code, (await json(s)).code, 'same refusal code');
});
