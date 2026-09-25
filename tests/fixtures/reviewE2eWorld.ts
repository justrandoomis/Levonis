/**
 * THE TWO JOURNEYS OF THE LIVE MERCHANT-PLATFORM REVIEW, AS FIXTURES.
 *
 * Adapted from the reviewer's probes (scratchpad/review-e2e/world.ts and
 * bworld.ts): the real routes, mounted as worker/index.ts mounts them, on a
 * D1 adapter that ENFORCES the live limits the local engine does not
 * (./d1Limits.ts — > 100 bound parameters, > 5 compound-SELECT terms).
 *
 *   - `storeWorld` + `openStore`: journey A — a community store with delivery
 *     rules, a product with variants and a 10% coupon, a buyer with a wallet.
 *   - `seedB` + `asB` + `publishedB`: journey B — a published custom print
 *     request, four workshops, a buyer with a wallet.
 */
import type { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { freshDb, stubApp, post, put, get, json, type Mount, type StubUser } from './app';
import { limitD1 } from './d1Limits';
import { variantBody } from './catalog';
import { cartRoutes } from '../../worker/routes/cart';
import { storeOrderRoutes } from '../../worker/routes/storeOrders';
import { orderRoutes } from '../../worker/routes/orders';
import { merchantRoutes } from '../../worker/routes/merchant';
import { merchantPrinterRoutes } from '../../worker/routes/merchantPrinters';
import { merchantCatalogRoutes } from '../../worker/routes/merchantCatalog';
import { merchantNotificationRoutes } from '../../worker/routes/merchantNotifications';
import { merchantAnalyticsRoutes } from '../../worker/routes/merchantAnalytics';
import { merchantOrderRoutes } from '../../worker/routes/merchantOrders';
import { merchantFinanceRoutes, merchantPayoutRoutes } from '../../worker/routes/merchantFinance';
import { merchantWorkshopRoutes } from '../../worker/routes/merchantWorkshop';
import { storefrontRoutes } from '../../worker/routes/storefront';
import { adminCommunityRoutes } from '../../worker/routes/adminCommunity';
import { adminRoutes } from '../../worker/routes/admin';
import { printRequestRoutes } from '../../worker/routes/printRequests';
import { marketplaceRoutes } from '../../worker/routes/marketplace';
import { notificationRoutes } from '../../worker/routes/notifications';
import { supportRoutes } from '../../worker/routes/support';
import { chatRoutes } from '../../worker/routes/chats';

export const FUTURE = '2099-01-01T00:00:00.000Z';

// ------------------------------------------------------------ journey A

export function storeWorld() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('ali','Ali','ali@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a_basra','buyer','Sara','+9647701234567','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep','buyer','deposit','USD',200000,'approved','seed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return { raw, db: limitD1(raw) };
}

export const buyerApp = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/support', supportRoutes);
    a.route('/api/storefront', storefrontRoutes);
    a.route('/api/notifications', notificationRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  });

export const merchantApp = (db: D1Database, id = 'ali', role: StubUser['role'] = 'customer') =>
  stubApp(db, { id, role, email: `${id}@x.co` }, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant', merchantCatalogRoutes);
    a.route('/api/merchant/notifications', merchantNotificationRoutes);
    a.route('/api/merchant/analytics', merchantAnalyticsRoutes);
    a.route('/api/merchant/orders', merchantOrderRoutes);
    a.route('/api/merchant/finance', merchantFinanceRoutes);
    a.route('/api/merchant/payouts', merchantPayoutRoutes);
  });

export const storeAdminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null }, (a) => {
    a.route('/api/admin/community', adminCommunityRoutes);
    a.route('/api/admin', adminRoutes);
  });

/** Onboard Ali's store: basra 4000, a variant product, coupon TEN (10%). */
export async function openStore(db: D1Database) {
  const m = merchantApp(db);
  const on = await post(m, '/api/merchant/onboard', { name: 'Ali 3D', slug: 'ali3d', governorate: 'baghdad' });
  const onBody = await json(on);
  assert.equal(on.status, 201, JSON.stringify(onBody));
  const d0 = await json(await get(m, '/api/merchant/delivery'));
  const dput = await put(m, '/api/merchant/delivery', {
    version: d0.profile.version,
    profile: { default_mode: 'fee', default_fee_iqd: 6000, free_over_iqd: null, pickup_enabled: false, prep_days: 1, note: '' },
    rules: [{ governorate_id: 'basra', mode: 'fee', fee_iqd: 4000 }],
  });
  assert.equal(dput.status, 200, JSON.stringify(await json(dput.clone())));
  const pr = await post(m, '/api/merchant/products', variantBody());
  const prBody = await json(pr);
  assert.equal(pr.status, 201, JSON.stringify(prBody));
  const cp = await post(m, '/api/merchant/coupons', { code: 'TEN', kind: 'percent', value: 10, max_uses: 50 });
  assert.equal(cp.status, 201, JSON.stringify(await json(cp)));
  return { m, store: onBody.store, product: prBody.product };
}

/** Buy `qty` of variant #1 (14 000) with coupon TEN, delivered to Basra (4 000). */
export async function buyStoreOrder(db: D1Database, product: { id: string; variants: Array<{ id: string }> }, key: string, qty = 1): Promise<string> {
  const b = buyerApp(db);
  const add = await post(b, '/api/cart/merchant-items', { productId: product.id, variantId: product.variants[1].id, qty });
  assert.ok([200, 201].includes(add.status), JSON.stringify(await json(add)));
  const q = await json(await post(b, '/api/store-orders/quote', { addressId: 'a_basra', couponCode: 'TEN' }));
  const res = await post(b, '/api/store-orders', { idempotencyKey: key, addressId: 'a_basra', couponCode: 'TEN', quoteFingerprint: q.quote?.quote_fingerprint });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.order.id as string;
}

export async function deliverStoreOrder(m: ReturnType<typeof merchantApp>, orderId: string) {
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) {
    const r = await post(m, `/api/merchant/orders/${orderId}/status`, { status: s });
    assert.equal(r.status, 200, `${s} ${JSON.stringify(await json(r))}`);
  }
}

// ------------------------------------------------------------ journey B

export class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null;
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return {
      body: new Blob([v as unknown as BlobPart]).stream(),
      httpEtag: `"${key}"`,
      arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function seedB(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('ali','Ali','a@x.co','h','customer'), ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','ali','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,governorate) VALUES ('s1','m1','ali','ali3d','Ali 3D','baghdad');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max,model_id,brand,model) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250,'[]','fine','bbl-p1s','Bambu Lab','P1S');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area)
      VALUES ('a1','buyer','Home','Sara K','+9647700000009','Street 12','',1,'baghdad','Karrada');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep','buyer','deposit','USD',200000,'approved','seed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const mountB: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantPrinterRoutes);
  a.route('/api/merchant/notifications', merchantNotificationRoutes);
  a.route('/api/merchant/analytics', merchantAnalyticsRoutes);
  a.route('/api/merchant/finance', merchantFinanceRoutes);
  a.route('/api/notifications', notificationRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

export const asB = (raw: DatabaseSync, id: string | null, bucket = new MemoryBucket()) =>
  stubApp(limitD1(raw), id ? { id, role: id === 'boss' ? 'admin' : 'customer', email: `${id}@x.co` } : null, mountB, {
    env: { BUCKET: bucket },
  });

/** A closed 20 mm cube, binary STL. */
export function stl(w = 20, d = 20, h = 20): Uint8Array {
  const v: Array<[number, number, number]> = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const tris: Array<[number, number, number]> = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

async function uploadFile(raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  const res = await asB(raw, 'buyer', bucket).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).file.id as string;
}

export const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, governorate: 'baghdad' };

/** A published request with an analysed model: `{ id, model }`. */
export async function publishedB(raw: DatabaseSync, bucket: MemoryBucket, body: Record<string, unknown> = PLA) {
  const res = await post(asB(raw, 'buyer', bucket), '/api/marketplace/requests', { title: 'A bracket', description: 'Print me a bracket please' });
  const id = (await json(res)).request.id as string;
  const model = await uploadFile(raw, bucket, id, 'bracket.stl', stl());
  const an = await post(asB(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/files/${model}/analyze`);
  assert.equal(an.status, 200, JSON.stringify(await json(an.clone())));
  const pub = await post(asB(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/publish`, { ...body, primary_file_id: model });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return { id, model };
}

/** Ali offers `price` and the buyer accepts: `{ id, model, offerId, orderId, escrowId }`. */
export async function acceptedB(raw: DatabaseSync, bucket: MemoryBucket, price = 20_000) {
  const r = await publishedB(raw, bucket);
  const offer = await post(asB(raw, 'ali'), `/api/marketplace/requests/${r.id}/offers`, { price_iqd: price, completion_days: 3 });
  const o = (await json(offer)).offer;
  assert.ok(o?.id, 'the offer was made');
  const acc = await post(asB(raw, 'buyer'), `/api/marketplace/offers/${o.id}/accept`, { expected_price_iqd: price, offer_revision: 1, address_id: 'a1' });
  const accB = await json(acc);
  assert.equal(acc.status, 201, JSON.stringify(accB));
  return { ...r, offerId: o.id as string, orderId: accB.order.id as string, escrowId: accB.escrow_id as string };
}
