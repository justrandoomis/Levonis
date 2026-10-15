/**
 * Services V2 survey (2026-10-13) — a shared fixture for the trade-in gap
 * reproductions (tests/sv2_tradein_*.test.ts). Same stubs as
 * tests/tradeInFlow.test.ts (R2, Images, Telegram/mail at fetch), real routes,
 * every migration applied. LOCAL ONLY.
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, stubApp, post, send, json, pending, ctx, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { tradeInRoutes, adminTradeInRoutes } from '../worker/routes/tradeIn';
import { fileRoutes } from '../worker/routes/uploads';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { REQUIRED_PHOTOS, blankInputs } from '../packages/pricing/src/tradeIn';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';

export const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
/** A full-scope admin who is NOT the owner — may move money (canMoveMoney), sees no cost. */
export const STAFF: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
export const CUSTOMER: StubUser = { id: 'cust', role: 'customer', email: 'sara@x.co' };

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: 1, chat: { id: 1 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
export const restoreFetch = () => void (globalThis.fetch = realFetch);

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return { body: new Blob([b as unknown as BlobPart]).stream(), size: b.byteLength, httpEtag: `"${key}"`, httpMetadata: { contentType: 'image/webp' }, writeHttpMetadata(h: Headers) { h.set('Content-Type', 'image/webp'); }, arrayBuffer: () => new Blob([b as unknown as BlobPart]).arrayBuffer() };
  }
  async head(key: string) {
    return this.objects.has(key) ? { key, size: this.objects.get(key)!.byteLength } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
function webp(): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  b.set([0x7f, 0x02, 0x00], 24);
  b.set([0xdf, 0x01, 0x00], 27);
  return b;
}
const images = {
  async info() { return { format: 'image/webp', fileSize: 30, width: 640, height: 480 }; },
  input() { return { async output() { return { response: () => new Response(webp() as unknown as BodyInit) }; } }; },
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const bucket = new MemoryBucket();
const ENV = { APP_ORIGIN: 'https://levonis.test', BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: new MemoryBucket(), IMAGES: images };

const dbOf = (raw: DatabaseSync) => new LimitD1(raw) as unknown as D1Database;
export const customerApp = (raw: DatabaseSync, user: StubUser = CUSTOMER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/trade-in', tradeInRoutes);
    a.route('/files', fileRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  }, { env: ENV });
export const adminApp = (raw: DatabaseSync, user: StubUser = OWNER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/admin/trade-in', adminTradeInRoutes);
  }, { env: ENV });

export const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
export const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/**
 * Sara bought an A1 (plain model) for `paid` and it was delivered `deliveredDaysAgo`
 * days ago with a 12-month warranty. The catalogue sells the A1 today at `a1Now`
 * (A1 Combo `comboNow`) and a P1S at 1,500,000, all directly.
 */
export function seed(opts: { paid?: number; a1Now?: number; comboNow?: number; deliveredDaysAgo?: number; through?: string } = {}): DatabaseSync {
  const paid = opts.paid ?? 850_000;
  const a1Now = opts.a1Now ?? 850_000;
  const comboNow = opts.comboNow ?? 1_150_000;
  const delivered = daysAgo(opts.deliveredDaysAgo ?? 20);
  const warrantyEnd = new Date(Date.parse(delivered) + 365 * 86_400_000).toISOString();
  // `through`: a database whose newest migration is that number (a Worker deployed ahead of its migration).
  const raw = dbThrough(opts.through ?? null);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('boss','Ali','boss@x.co','h','admin',NULL,'ar'),
      ('staff','Hadi','staff@x.co','h','admin',NULL,'ar'),
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar');
    UPDATE users SET admin_scope = 'full' WHERE id = 'staff';
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_c','cust','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',${a1Now},'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_p1s','p1s','Bambu Lab P1S','بامبو P1S',1500000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a1','p_a1','Model',0,1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, sort, active, regular_price_iqd, variant_key) VALUES
      ('v_a1','p_a1','g_a1','A1','A1',0,1,${a1Now},'a1'),
      ('v_a1c','p_a1','g_a1','A1 Combo','A1 كومبو',1,1,${comboNow},'a1-combo');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-OLD','cust','delivered','delivered','{}','standard','{}','cash',${paid},0,1400,${paid},0,'${daysAgo((opts.deliveredDaysAgo ?? 20) + 5)}','${delivered}','${delivered}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_a1','ORD-OLD','p_a1','Bambu Lab A1','','A1',1,${paid},${paid},'v_a1','["v_a1"]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_a1','ORD-OLD','oi_a1','p_a1','cust',1,'${delivered}',12,0,'${delivered}','${warrantyEnd}','{}');
  `);
  return raw;
}

export const settle = () => Promise.all(pending.splice(0));

function photoForm(component: string, angle: string): FormData {
  const f = new FormData();
  f.set('file', new File([JPEG as unknown as BlobPart], 'p.jpg', { type: 'image/jpeg' }));
  f.set('component', component);
  f.set('angle', angle);
  return f;
}

/** Opens, answers («good» everywhere), photographs and submits a trade-in of Sara's A1 toward the P1S. */
export async function submitted(raw: DatabaseSync, item = 'oi_a1', scope: 'whole' | 'printer_only' | 'ams_only' = 'whole'): Promise<string> {
  const a = customerApp(raw);
  const r = await json(await post(a, '/api/trade-in/requests', { order_item_id: item, unit_index: 1, scope }));
  assert.ok(r.success, JSON.stringify(r));
  const id = r.request.id as string;
  const comps = r.request.components as Array<{ role: 'device' | 'ams'; family: 'fdm' | 'ams' }>;
  const saved = await send(a, 'PATCH', `/api/trade-in/requests/${id}`, {
    components: Object.fromEntries(comps.map((c) => [c.role, blankInputs(c.family)])),
    target: { product_id: 'p_p1s', option_value_ids: [], color_id: null },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  for (const c of comps) {
    for (const angle of REQUIRED_PHOTOS[c.family]) {
      const res = await a.request(`/api/trade-in/requests/${id}/photos`, { method: 'POST', body: photoForm(c.role, angle.id), headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
      assert.equal(res.status, 201, await res.clone().text());
    }
  }
  const s = await post(a, `/api/trade-in/requests/${id}/submit`);
  assert.equal(s.status, 200, await s.clone().text());
  await settle();
  return id;
}

export function checkoutBody(extra: Record<string, unknown> = {}) {
  return {
    printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
    addressId: 'addr_c',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    useWallet: false,
    usePoints: false,
    itemIds: [],
    idempotencyKey: `sv2-${Math.random()}`,
    policyAcceptance: acceptedPolicies(),
    ...extra,
  };
}

/**
 * THE SHOP RECEIVED THE DEVICE (decision 2, «الجهاز أولاً», migration 0192): no
 * trade-in credit is spent before its device's intake is recorded
 * (`trg_trade_in_credit_needs_intake`). Through the real door, by STAFF (any
 * admin may receive; no money moves): the slot's unit gets a serial on record
 * when it has none, and the desk scans that serial — a match.
 */
export async function received(raw: DatabaseSync, id: string, opts: { by?: StubUser; body?: Record<string, unknown> } = {}): Promise<Record<string, any>> {
  const req = raw.prepare('SELECT order_item_id, unit_index, scope FROM trade_in_requests WHERE id = ?').get(id) as { order_item_id: string; unit_index: number; scope: string };
  let serial = '';
  if (req.scope !== 'ams_only') {
    const unit = raw.prepare('SELECT id FROM order_item_units WHERE order_item_id = ? AND unit_index = ?').get(req.order_item_id, req.unit_index) as { id: string } | undefined;
    if (unit) {
      const have = raw.prepare('SELECT serial_norm FROM device_serials WHERE unit_id = ?').get(unit.id) as { serial_norm: string } | undefined;
      serial = have?.serial_norm ?? `SN${unit.id.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}01`;
      if (!have) raw.prepare('INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, ?, ?)').run(serial, serial, unit.id, 'staff');
    }
  }
  const res = await post(adminApp(raw, opts.by ?? STAFF), `/api/admin/trade-in/requests/${id}/intake`, { serial, handover: 'store', ...(opts.body ?? {}) });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  await settle();
  return body;
}

/** Receives the device, approves the estimate, places the P1S order with the credit, returns the order id. */
export async function approvedAndOrdered(raw: DatabaseSync, id: string): Promise<{ orderId: string; value: number }> {
  await received(raw, id);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment', JSON.stringify(approved));
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s_${Math.random().toString(36).slice(2)}','cust','p_p1s','','[]','','','','',1)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code }));
  assert.equal(placed.status, 200, await placed.clone().text());
  await settle();
  return { orderId: (await json(placed)).order.id as string, value: approved.request.final_value_iqd as number };
}
