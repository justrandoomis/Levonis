/**
 * «خصص طابعتك» PHASE 4 fixture (DECISIONS row 355): a real SQLite with every
 * migration, the real routes, an enrolled printer, a colourless PLA, a PETG
 * whose colours carry the stock (customer-colour items), and a nozzle add-on.
 * Shared by tests/printerOffersCart.test.ts and tests/printerOffersMoney.test.ts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './d1';
import type { AppContext, Env } from '../../worker/lib/types';
import { HttpError } from '../../worker/lib/http';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { productRoutes } from '../../worker/routes/products';
import { policiesRoutes } from '../../worker/routes/policies';
import { returnRoutes } from '../../worker/routes/returns';
import { classifyHost } from '../../worker/lib/hosts';
import { acceptedPolicies } from '../lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../../packages/shipping/src/printerDeliveryPolicy';
import { resetPolicyCorpusMemo } from '../../worker/lib/policySync';
import { autoPublishFromEnv } from './autoPublish';
import {
  DEFAULT_PRINTER_SERVICES, presetSelection,
  type FilamentKit, type PrinterAddon, type PrinterServicesConfig, type ServiceSelection,
} from '../../packages/pricing/src/printerServices';

const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });

/** 2 × PLA per printer, 10% off each spool (25,000 → 22,500). */
export const KIT_FIXED: FilamentKit = {
  id: 'a1-starter', active: true, sort: 1,
  title: { ar: 'باقة البداية', en: 'Starter kit', ckb: 'پاکێجی دەستپێک' },
  items: [{ product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 2, color_mode: 'fixed' }],
  printers: [{ product_id: 'p_a1', option_value_id: null }],
  discount: { mode: 'percent', value: 10 },
};
/** 1 × PETG in the customer's colour + 1 × PLA; 5,000 off per printer, split over its 2 spools (2,500 each). */
export const KIT_COLOUR: FilamentKit = {
  id: 'a1-colour', active: true, sort: 2,
  title: { ar: 'باقة الألوان', en: 'Colour kit', ckb: 'پاکێجی ڕەنگ' },
  items: [
    { product_id: 'p_petg', option_value_ids: [], color_id: null, qty: 1, color_mode: 'customer' },
    { product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 1, color_mode: 'fixed' },
  ],
  printers: [{ product_id: 'p_a1', option_value_id: null }],
  discount: { mode: 'fixed_iqd', value: 5_000 },
};
/** One nozzle per printer, 20% off (10,000 → 8,000). */
export const ADDON_NOZZLE: PrinterAddon = {
  id: 'nozzle', active: true, sort: 1, title: { ar: 'فوهة 0.4', en: 'Nozzle 0.4', ckb: 'نۆزڵی 0.4' },
  product_id: 'p_nozzle', option_value_ids: [], color_id: null, color_mode: 'fixed', qty: 1,
  discount: { mode: 'percent', value: 20 }, printers: null,
};
/** One PETG in the customer's colour per printer, no discount. */
export const ADDON_PETG: PrinterAddon = {
  id: 'petg-extra', active: true, sort: 2, title: null,
  product_id: 'p_petg', option_value_ids: [], color_id: null, color_mode: 'customer', qty: 1,
  discount: null, printers: [{ product_id: 'p_a1', option_value_id: null }],
};

export function liveConfig(over: Partial<PrinterServicesConfig> = {}): PrinterServicesConfig {
  return {
    ...DEFAULT_PRINTER_SERVICES, revision: 7,
    products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: [] } },
    kits: [KIT_FIXED, KIT_COLOUR], addons: [ADDON_NOZZLE, ADDON_PETG], ...over,
  };
}

/** PETG colours: red 3 on the shelf, black 10, white sold out, blue 10 (sort 3). */
export function setup(opts: { config?: unknown; petg?: Partial<Record<'red' | 'black' | 'white' | 'blue', number>> } = {}) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('owner','Owner','owner@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',200000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images,inventory_mode)
       VALUES ('p_a1','a1-printer','Printer A1','طابعة A1',840000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]','BASE'),
              ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]','BASE'),
              ('p_petg','petg-basic','PETG Basic','PETG أساسي',30000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]','COLOR'),
              ('p_nozzle','nozzle-04','Nozzle 0.4','فوهة 0.4',10000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]','BASE')`
    )
    .run(OPS);
  const petg = { red: 3, black: 10, white: 0, blue: 10, ...(opts.petg ?? {}) };
  raw.prepare(`INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('c_red','p_petg','Red','أحمر','#FF0000',0,1,?),
      ('c_black','p_petg','Black','أسود','#000000',1,1,?),
      ('c_white','p_petg','White','أبيض','#FFFFFF',2,1,?),
      ('c_blue','p_petg','Blue','أزرق','#0000FF',3,1,?)`).run(petg.red, petg.black, petg.white, petg.blue);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES
      ('cat_p','test-po-printers','طابعات',1), ('cat_f','test-po-filaments','خيوط',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_pla','cat_f',0), ('p_petg','cat_f',1), ('p_nozzle','cat_f',2);
  `);
  const live = opts.config ?? liveConfig();
  setConfig(raw, live);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database, env: { DB: new SqliteD1(raw) } as unknown as Env };
}

export function setConfig(raw: DatabaseSync, live: unknown) {
  raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'printerServices',
    JSON.stringify({ draft: live, published: live, published_at: '2026-11-18T00:00:00.000Z', published_by: 'owner' })
  );
}

export function appAs(db: D1Database, userId: string | null) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role: 'customer', email: `${userId}@x.co`, username: userId, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@x.co' } as never;
    await next();
  });
  a.use('*', autoPublishFromEnv);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/returns', returnRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    throw err;
  });
  return a;
}

export const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
export const json = async (res: Response) => (await res.json()) as Json;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, undefined, ctx);
export const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'POST', path, body);
export const put = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PUT', path, body);
export const patch = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PATCH', path, body);
export const del = (a: ReturnType<typeof appAs>, path: string) => send(a, 'DELETE', path);
export const get = (a: ReturnType<typeof appAs>, path: string) => send(a, 'GET', path);

let seq = 0;
export const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `po-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});
export const smart = (delivery: ServiceSelection['delivery'] = 'economy'): ServiceSelection => ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, 'smart', delivery), confirmed: true });
export const printerId = (raw: DatabaseSync) => (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer' AND product_id = 'p_a1'").get() as { id: string }).id;
export const attachedRows = (raw: DatabaseSync) =>
  raw.prepare("SELECT * FROM cart_items WHERE user_id = 'buyer' AND kit_parent_id IS NOT NULL ORDER BY addon_id IS NOT NULL, product_id").all() as Array<Record<string, unknown>>;

/** Adds the printer with extras; asserts 200. */
export async function addPrinter(a: ReturnType<typeof appAs>, extras: Record<string, unknown>, qty = 1) {
  const res = await post(a, '/api/cart/items', { productId: 'p_a1', qty, services: smart(), ...extras });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}
