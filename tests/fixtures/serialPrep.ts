/**
 * The serial-scan world (migration 0177): a real database with every
 * migration, the real routes mounted as worker/index.ts mounts them, and only
 * the session stubbed (tests/fixtures/app.ts). Shared by the serialPrep*
 * tests.
 *
 *   boss  — the owner (INITIAL_ADMIN_EMAIL = boss@x.co), sees full serials
 *   adm   — a full-scope admin (not the owner)
 *   ast   — an assistant-scope admin (masked serials)
 *   u1/u2 — customers
 *
 * Products: pA1 «Bambu Lab A1 Combo» and pX2D «Bambu Lab X2D Combo» filed
 * under a printer catalog; pAMS «Bambu Lab AMS Lite» under an AMS section of
 * the accessories; pPLA a filament.
 */
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, type StubUser } from './app';
import { serialD1 } from './serialD1';
import { adminOrderSerialRoutes } from '../../worker/routes/adminOrderSerials';
import { adminRoutes } from '../../worker/routes/admin';
import { deviceRoutes } from '../../worker/routes/devices';
import { adminTaxonomyRoutes } from '../../worker/routes/adminTaxonomy';
import { returnRoutes } from '../../worker/routes/returns';
import { warrantyAdminRoutes } from '../../worker/routes/warranty';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';
import { orderRoutes } from '../../worker/routes/orders';

export const SN = '03919D580607841';
export const SN2 = '03919D580607842';
export const SN3 = '03919D580607843';
export const BOX = 'B07119G5811000AB';
export const EAN = '6977252425445';

export const USERS: Record<string, StubUser> = {
  boss: { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
  adm: { id: 'adm', role: 'admin', email: 'adm@x.co', admin_scope: 'full' },
  ast: { id: 'ast', role: 'admin', email: 'ast@x.co', admin_scope: 'assistant' },
  u1: { id: 'u1', role: 'customer', email: 'u1@x.co' },
  u2: { id: 'u2', role: 'customer', email: 'u2@x.co' },
};

export function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('boss','Owner','boss@x.co','h','admin',NULL), ('adm','Admin','adm@x.co','h','admin','full'),
      ('ast','Assistant','ast@x.co','h','admin','assistant'),
      ('u1','Sara','u1@x.co','h','customer',NULL), ('u2','Omar','u2@x.co','h','customer',NULL);
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, is_printer_catalog) VALUES
      ('ct_print', NULL, 'sp-printers', 'طابعات', 'Printers', 1),
      ('ct_acc', NULL, 'sp-acc', 'ملحقات', 'Accessories', 0),
      ('ct_ams', 'ct_acc', 'sp-ams', 'AMS', 'AMS', 0),
      ('ct_fil', 'ct_acc', 'sp-fil', 'خيوط', 'Filament', 0);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy) VALUES
      ('pA1','sp-a1','Bambu Lab A1 Combo','طابعة A1 كومبو',899000,'{}'),
      ('pX2D','sp-x2d','Bambu Lab X2D Combo','طابعة X2D',2899000,'{}'),
      ('pAMS','sp-ams-lite','Bambu Lab AMS Lite','AMS لايت',399000,'{}'),
      ('pPLA','sp-pla','PLA spool','خيط PLA',25000,'{}');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES
      ('pA1','ct_print',1), ('pX2D','ct_print',2), ('pAMS','ct_ams',1), ('pPLA','ct_fil',1);
  `);
}

export interface LineSpec {
  id: string;
  product: string;
  qty?: number;
  name?: string;
  option_value_ids?: string[];
}

export function order(
  raw: DatabaseSync,
  id: string,
  lines: LineSpec[],
  o: { status?: string; stage?: string; shipping_type?: string; user?: string; created_at?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
         subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,created_at,updated_at)
       VALUES (?,?,?,'{"name":"Sara","phone":"0770"}','home','{}','cash',899000,1400,899000,0,?,?,?,?)`
    )
    .run(
      id,
      o.user ?? 'u1',
      o.status ?? 'processing',
      o.shipping_type ?? 'direct',
      o.stage ?? 'preparing',
      o.created_at ?? new Date().toISOString(),
      new Date().toISOString()
    );
  for (const l of lines) {
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd, option_value_ids)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(l.id, id, l.product, l.name ?? l.product, l.qty ?? 1, 899000, 899000 * (l.qty ?? 1), JSON.stringify(l.option_value_ids ?? []));
  }
}

/** `serial`: the single-writer adapter (tests/fixtures/serialD1.ts) for tests that race two requests. */
export function world(opts: { through?: string; serial?: boolean } = {}) {
  const raw = opts.through ? dbThrough(opts.through) : freshDb();
  seed(raw);
  const db = opts.serial ? serialD1(raw) : asD1(raw);
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
    a.route('/api/admin/orders', adminOrderSerialRoutes);
    a.route('/api/admin/taxonomy', adminTaxonomyRoutes);
    a.route('/api/admin/warranties', warrantyAdminRoutes);
    a.route('/api/admin/products-v2', adminProductsRoutes);
    a.route('/api/admin', adminRoutes);
    a.route('/api/devices', deviceRoutes);
    a.route('/api/returns', returnRoutes);
    a.route('/api/orders', orderRoutes);
  };
  const as = (who: keyof typeof USERS) => stubApp(db, USERS[who], mount);
  return { raw, db, as, env: { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never };
}

let opSeq = 0;
/** One client read → one op_id, as the camera sheet sends. */
export const op = () => `op-test-${Date.now().toString(36)}-${++opSeq}`;
