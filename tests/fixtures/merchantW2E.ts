/**
 * A world for the W2-E suites (merchant notifications, the inbox, the
 * storefront beacon and the analytics report): two stores with their owners
 * on an active PLUS, two customers and an admin, a few products, a delivered
 * store order and a custom request with one merchant's accepted job. Real
 * migrations, real routes — only the session is stubbed (./app.ts).
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, type Mount, type StubUser } from './app';

export const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
export const OWNER2: StubUser = { id: 'owner2', role: 'merchant', email: 'owner2@x.co' };
export const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
export const BUYER2: StubUser = { id: 'buyer2', role: 'customer', email: 'buyer2@x.co' };
export const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };

export const ORDER_COLS = `(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,platform_fee_iqd,merchant_receivable_iqd,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd,coupon_code,coupon_discount_iqd,created_at)`;

export function seedW2E(raw: DatabaseSync = freshDb()): DatabaseSync {
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role,locale) VALUES
      ('owner','Ali Hassan','ali','owner@x.co','h','merchant','ar'),
      ('owner2','Zahra K','zahra','owner2@x.co','h','merchant','en'),
      ('buyer','Sara Ahmed','sara','buyer@x.co','h','customer','ar'),
      ('buyer2','Omar Najm','omar','buyer2@x.co','h','customer','ar'),
      ('boss','Boss','boss','boss@x.co','h','admin','ar');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at,source) VALUES
      ('mm1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','purchase'),
      ('mm2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','purchase');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Zahra Prints');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','zahra','Zahra Prints');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp1','m1','s1','ali3d-vase','Vase','active','active',10000,5,1),
      ('cp2','m1','s1','ali3d-lamp','Lamp','active','active',25000,5,1),
      ('cp3','m1','s1','ali3d-draft','Draft','hidden','draft',5000,5,1),
      ('cp9','m2','s2','zahra-cup','Cup','active','active',7000,5,1);
  `);
  return raw;
}

/** A store order. `status` defaults to delivered; `at` to now. */
export function addOrder(
  raw: DatabaseSync,
  o: { id: string; user?: string; merchant?: string; store?: string; status?: string; total?: number; at?: string; coupon?: string; discount?: number; governorate?: string | null }
) {
  const snapshot = o.governorate === null ? '{}' : JSON.stringify({ governorate: o.governorate ?? 'baghdad', city: 'X' });
  raw.prepare(`INSERT INTO orders ${ORDER_COLS} VALUES (?,?,?,?,?,?,'merchant','store_product',?,?,?,'d','{}','wallet',?,1500,0,?,?,?)`).run(
    o.id,
    o.user ?? 'buyer',
    o.status ?? 'delivered',
    o.total ?? 10000,
    o.merchant ?? 'm1',
    o.store ?? 's1',
    Math.round((o.total ?? 10000) * 0.05),
    Math.round((o.total ?? 10000) * 0.95),
    snapshot,
    o.total ?? 10000,
    o.coupon ?? '',
    o.discount ?? 0,
    o.at ?? new Date().toISOString()
  );
}

export const appOf = (raw: DatabaseSync, user: StubUser | null, mount: Mount, env: Record<string, unknown> = {}, host?: string) =>
  stubApp(asD1(raw), user, mount, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com', ...env }, ...(host ? { host } : {}) });
