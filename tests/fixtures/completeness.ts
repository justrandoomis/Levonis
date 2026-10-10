/**
 * «ناقص» / «إخفاء المنتجات الناقصة عن الزبائن» — the shared world of the
 * completeness tests (owner brief 2026-10-10; worker/lib/productCompleteness.ts,
 * worker/lib/listing.ts, migration 0184).
 *
 * Two ordinary products in one real section: `p_full` meets every field of the
 * central list, `p_gap` misses exactly its cost. Admin doors run through
 * `stubApp` (the owner, a full admin, an assistant); customer surfaces through
 * the real Worker (`worker.fetch`), signed out, exactly as a shopper reaches
 * them.
 */
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb, stubApp, type StubUser } from './app';
import worker from '../../worker/index';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';
import { templateRoutes } from '../../worker/routes/template';
import { adminRoutes } from '../../worker/routes/admin';
import { cartRoutes } from '../../worker/routes/cart';

export const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
export const FULL_ADMIN: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
export const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
export const CUSTOMER: StubUser = { id: 'usr_cust', role: 'customer', email: 'cust@x.co' };

const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export interface ProductSeed {
  id: string;
  slug: string;
  name?: string;
  name_ar?: string;
  price_iqd?: number;
  product_cost_iqd?: number | null;
  category_id?: string | null;
  package_weight_g?: number | null;
  box?: [number, number, number] | null;
  image?: boolean;
  status?: string;
  composition?: string;
}

export function seedCatalog(raw: DatabaseSync): void {
  // Migration 0184 ships the owner's switch ON (owner decision 2026-10-10). These fixtures test the
  // switch itself, so they start from OFF; tests/catalogHideIncompleteDefault.test.ts holds the seed.
  try {
    raw.exec("DELETE FROM admin_settings WHERE key = 'catalogHideIncomplete'");
  } catch {
    /* a database before 0001's admin_settings — nothing to clear */
  }
  raw.exec(`INSERT INTO catalogs (id, slug, name_ar, name_en, name_ckb, sort, active) VALUES ('cat_p', 'completeness-test-section', 'قسم الاختبار', 'Test section', 'بەشی تاقیکردنەوە', 0, 1)`);
}

export function seedProduct(raw: DatabaseSync, p: ProductSeed): void {
  const box = p.box === undefined ? [300, 200, 100] : p.box;
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, product_cost_iqd, stock, selling_type, sale_types,
                          category_id, package_weight_g, package_width_mm, package_depth_mm, package_height_mm, composition, updated_at)
    VALUES (${q(p.id)}, ${q(p.slug)}, ${q(p.name ?? p.slug)}, ${q(p.name_ar ?? `منتج ${p.slug}`)}, ${q(`بەرهەمی ${p.slug}`)}, ${q(p.status ?? 'active')},
            ${q(p.price_iqd ?? 100000)}, ${q(p.product_cost_iqd === undefined ? 70000 : p.product_cost_iqd)}, 5, 'direct_sale', '["direct_sale"]',
            ${q(p.category_id === undefined ? 'cat_p' : p.category_id)}, ${q(p.package_weight_g === undefined ? 1200 : p.package_weight_g)},
            ${q(box?.[0] ?? null)}, ${q(box?.[1] ?? null)}, ${q(box?.[2] ?? null)}, ${q(p.composition ?? '')}, '2026-10-01T00:00:00.000Z');
  `);
  if (p.image !== false) {
    raw.exec(`
      INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary)
      VALUES (${q(`img_${p.id}`)}, ${q(p.id)}, ${q(`/files/products/${p.id}.webp`)}, ${q(`products/${p.id}.webp`)}, 'image/webp', 1000, 800, 600, 0, 1);
    `);
  }
}

export function world(opts: { raw?: DatabaseSync } = {}) {
  const raw = opts.raw ?? freshDb();
  seedCatalog(raw);
  seedProduct(raw, { id: 'p_full', slug: 'full-printer', name: 'Full Printer' });
  seedProduct(raw, { id: 'p_gap', slug: 'gap-printer', name: 'Gap Printer', product_cost_iqd: null });
  raw.exec("INSERT INTO users (id, name, email, password_hash, role, username) VALUES ('usr_cust', 'Buyer', 'cust@x.co', 'h', 'customer', 'usr_cust')");
  const db = asD1(raw);
  const admin = (user: StubUser = OWNER) =>
    stubApp(db, user, (a) => {
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/template', templateRoutes);
      a.route('/api/admin', adminRoutes);
    });
  const shopper = (user: StubUser = CUSTOMER) => stubApp(db, user, (a) => a.route('/api/cart', cartRoutes));
  const env = {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  let ip = 0;
  /** A signed-out shopper on the apex, through the real Worker (a fresh address a call: no rate limit trips). */
  const guest = (path: string, init: { method?: string; body?: unknown } = {}) =>
    worker.fetch(
      new Request(`https://${APEX}${path}`, {
        method: init.method ?? 'GET',
        headers: { Host: APEX, 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
      env as never,
      ctx
    );
  return { raw, db, admin, shopper, guest, env };
}

export type World = ReturnType<typeof world>;

/** Every ordinary product re-evaluated by the owner's recount (25 a call). */
export async function recount(w: World): Promise<void> {
  const { post } = await import('./app');
  for (let i = 0; i < 10; i++) {
    const res = await post(w.admin(), '/api/admin/products-v2/completeness/refresh', {});
    const body = (await res.json()) as { stale_left?: number };
    if (res.status !== 200) throw new Error(`refresh ${res.status} ${JSON.stringify(body)}`);
    if (!body.stale_left) return;
  }
}
