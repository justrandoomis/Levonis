/**
 * THE PRODUCT DISCOUNT WORLD (docs/ux/PRODUCT-DISCOUNT.md §12).
 *
 * The spec's worked example as rows: a printer with two models — P1S and P1S Combo — sold direct
 * and by land pre-order, priced price-first by the REAL V2 writer at U = 1,500 (P1S $600, Combo
 * $750, land Δ $50): direct 900,000 / 1,125,000, land 825,000 / 1,050,000. A second product is
 * cost-first (EUR supplier cost, Germany by land, minimum profit $120) for the role rules. The
 * owner (the verified owner, boss@x.co), a price editor and a buyer with an address and a funded
 * wallet; the admin door, the storefront, the cart, the checkout and the invoices are the real
 * routes, mounted as worker/index.ts mounts them.
 *
 * `through` builds the world on an OLDER database (CLAUDE.md rule 2): '0195' is the live database
 * before 0197.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, post, put, send, stubApp, type App, type StubUser } from './app';
import { applyRate, OWNER_ROW_SQL } from './fx';
import { seedOptionless, writeV2 } from './pricingV2';
import { acceptedPolicies } from '../lib/policies';
import { noStoreUnlessSet } from '../../worker/lib/edgePolicy';
import { adminOffersRoutes } from '../../worker/routes/offers';
import { productRoutes, homeRoutes } from '../../worker/routes/products';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { invoiceRoutes } from '../../worker/routes/invoices';

export const PID = 'p_p1s';
export const SLUG = 'bambu-p1s';
export const M1 = 'p_p1s_std';
export const M2 = 'p_p1s_combo';
export const COST_PID = 'p_cost';
export const COST_SLUG = 'cost-first-ams';
export const COST_M = 'p_cost_std';

export const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
export const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
export const BUYER: StubUser = { id: 'u_buyer', role: 'customer', email: 'buyer@x.co' };

const sql = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** One product with models; each model sells direct and by land pre-order. */
function seedPrinter(raw: DatabaseSync, id: string, slug: string, models: Array<{ id: string; en: string; ar: string; ckb: string }>, price: number) {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports,
                          inventory_mode, package_weight_g, package_depth_mm, package_width_mm, package_height_mm, net_weight_g)
    VALUES (${sql(id)}, ${sql(slug)}, ${sql(`Bambu Lab ${slug}`)}, 'طابعة بامبو', 'چاپکەری بامبو', 'active', ${price}, 5, 'direct_sale',
            '["direct_sale","pre_order"]', '[]', 'OPTION', 2500, 400, 300, 300, 2200);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${sql(`${id}_g`)}, ${sql(id)}, 'Model', 0, 1);
  `);
  models.forEach((m, j) => {
    raw.exec(`
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label)
      VALUES (${sql(m.id)}, ${sql(id)}, ${sql(`${id}_g`)}, ${sql(m.en)}, ${sql(m.ar)}, ${sql(m.ckb)}, ${j}, 1, 5, ${sql(`m${j}`)}, ${sql(m.en)});
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_d`)}, ${sql(id)}, ${sql(m.id)}, 'direct_sale', 1);
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_p`)}, ${sql(id)}, ${sql(m.id)}, 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES (${sql(`${m.id}_p_land`)}, ${sql(id)}, ${sql(`${m.id}_p`)}, 'land', 1);
    `);
  });
}

export const option = (scope_id: string, usd: string) => ({ scope: 'option' as const, scope_id, kind: 'fixed' as const, usd });
export const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });

/** The world. `rate` is the approved U the V2 writer prices at. */
export async function discountWorld(opts: { through?: string | null; rate?: string; costFirst?: boolean } = {}) {
  const raw = opts.through ? dbThrough(opts.through) : freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES
      ('usr_editor','Editor','editor@x.co','h','admin','2026-01-01T00:00:00.000Z'),
      ('u_buyer','Sara','buyer@x.co','h','customer','2026-01-01T00:00:00.000Z');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','u_buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','u_buyer','deposit','USD',1000000,'approved');
  `);
  applyRate(raw, 'USD_IQD', opts.rate ?? '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
            UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
            UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  seedPrinter(
    raw,
    PID,
    SLUG,
    [
      { id: M1, en: 'P1S', ar: 'P1S', ckb: 'P1S' },
      { id: M2, en: 'P1S Combo', ar: 'P1S كومبو', ckb: 'P1S کۆمبۆ' },
    ],
    900_000
  );
  const db = asD1(raw);
  await writeV2(db, PID, { method: 'usd', points: [option(M1, '600'), option(M2, '750')], discounts: [off('50')] });
  if (opts.costFirst !== false) {
    seedPrinter(raw, COST_PID, COST_SLUG, [{ id: COST_M, en: 'AMS', ar: 'AMS', ckb: 'AMS' }], 1_000_000);
    await writeV2(db, COST_PID, {
      method: 'cost',
      inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
      minimumProfitUsd: '120',
      discounts: [off('50')],
    });
  }
  return { raw, db, ...doors(raw) };
}

export type DiscountWorld = Awaited<ReturnType<typeof discountWorld>>;

/** Re-price the printer so both models cost $600 (one before price for the whole product). */
export async function writeV2Uniform(w: { db: D1Database }): Promise<void> {
  await writeV2(w.db, PID, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '600' }], discounts: [off('50')] });
}

/** The shapes a dollar set cannot fit (§5.3 step 4), each V2-published by the real writer. */
export const SHAPES = {
  /** Colour-only, two colours, one dearer: no single before price. */
  colours: 'p_colours',
  /** Pre-order only: no direct price to discount from. */
  preorderOnly: 'p_preonly',
  /** Never priced: «يحتاج تسعيرًا». */
  unpriced: 'p_unpriced',
  /** A bundle (a composition). */
  bundle: 'p_bundle',
} as const;

export async function seedShapes(w: DiscountWorld): Promise<void> {
  seedOptionless(w.raw, SHAPES.colours, { routes: ['land'], colours: 2 });
  await writeV2(w.db, SHAPES.colours, {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '600' }, { scope: 'color', scope_id: `${SHAPES.colours}_c1`, kind: 'delta', usd: '+20' }],
    discounts: [off('50')],
  });
  seedOptionless(w.raw, SHAPES.preorderOnly, { saleTypes: ['pre_order'], routes: ['land'] });
  await writeV2(w.db, SHAPES.preorderOnly, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '600' }], discounts: [off('50')] });
  seedOptionless(w.raw, SHAPES.unpriced, { routes: ['land'] });
  w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, status, price_iqd, stock, composition) VALUES ('${SHAPES.bundle}', 'a-bundle', 'A bundle', 'باقة', 'active', 500000, 5, 'bundle')`);
}

/** The routes as one viewer reaches them. */
export function appFor(raw: DatabaseSync, user: StubUser | null): App {
  return stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/offers', adminOffersRoutes);
      a.route('/api/products', productRoutes);
      a.route('/api/home', homeRoutes);
      a.route('/api/cart', cartRoutes);
      a.route('/api/orders', orderRoutes);
      a.route('/api/invoices', invoiceRoutes);
    },
    { publishV2: false }
  );
}

let seq = 0;

function doors(raw: DatabaseSync) {
  const owner = appFor(raw, OWNER);
  const editor = appFor(raw, EDITOR);
  const buyer = appFor(raw, BUYER);
  const guest = appFor(raw, null);
  const call = async (app: App, method: string, path: string, body?: unknown) => {
    const res = method === 'GET' ? await get(app, path) : await send(app, method, path, body ?? {});
    return { status: res.status, body: await json(res) };
  };
  return {
    owner,
    editor,
    buyer,
    guest,
    call,
    /** The card's / tab's PUT. */
    saveOffer: (app: App, body: Record<string, unknown>, pid = PID) => call(app, 'PUT', `/api/admin/offers/${pid}`, body),
    previewOffer: (app: App, body: Record<string, unknown>, pid = PID) => call(app, 'POST', `/api/admin/offers/${pid}/preview`, body),
    readOffer: (app: App, pid = PID) => call(app, 'GET', `/api/admin/offers/${pid}`),
    deleteOffer: (app: App, pid = PID) => call(app, 'DELETE', `/api/admin/offers/${pid}`),
    addToCart: (body: Record<string, unknown>) => call(buyer, 'POST', '/api/cart/items', body),
    cart: () => call(buyer, 'GET', '/api/cart'),
    quote: (paymentMethodId = 'cash') =>
      call(buyer, 'POST', '/api/orders/quote', { addressId: 'addr_b', deliveryMethodId: 'standard', paymentMethodId, useWallet: false, usePoints: false, itemIds: [] }),
    placeOrder: (paymentMethodId = 'cash') =>
      call(buyer, 'POST', '/api/orders', {
        addressId: 'addr_b',
        deliveryMethodId: 'standard',
        paymentMethodId,
        useWallet: false,
        usePoints: false,
        itemIds: [],
        idempotencyKey: `pd-${Date.now()}-${++seq}`,
        policyAcceptance: acceptedPolicies(),
      }),
  };
}

export { post, put };
