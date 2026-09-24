/**
 * One catalogue world for the W2-F tests (tests/catalog*.test.ts): two
 * merchants with live PLUS stores, an admin, a buyer, and the upload ledger
 * rows their media keys need (pictures and one real video of Ali's, a key the
 * ledger says is a picture despite its .mp4 name, and one of Zain's).
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp } from './app';
import { merchantRoutes } from '../../worker/routes/merchant';
import { merchantCatalogRoutes } from '../../worker/routes/merchantCatalog';
import { storefrontRoutes } from '../../worker/routes/storefront';

const FUTURE = '2099-01-01T00:00:00.000Z';

export function seedCatalog(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('ali','Ali','ali@x.co','h','merchant'), ('zain','Zain','zain@x.co','h','merchant'),
      ('boss','Boss','boss@x.co','h','admin'), ('buyer','Sara','buyer@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active'), ('s_zain','m_zain','zain','zainprint','Zain','active');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size) VALUES
      ('merchants/ali/public/aaaa1111.webp','public','merchants','ali','image/webp',10),
      ('merchants/ali/public/bbbb2222.webp','public','merchants','ali','image/webp',10),
      ('merchants/ali/public/cccc3333.mp4','public','merchants','ali','video/mp4',10),
      ('merchants/ali/public/dddd4444.mp4','public','merchants','ali','image/webp',10),
      ('merchants/zain/public/eeee5555.webp','public','merchants','zain','image/webp',10);
  `);
}

export const merchantApp = (raw: DatabaseSync, id = 'ali') =>
  stubApp(asD1(raw), { id, role: 'merchant', email: `${id}@x.co` }, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant', merchantCatalogRoutes); // W2-F: the catalogue's own router
    a.route('/api/storefront', storefrontRoutes);
  });
/** A two-group product: size S/M × colour red, M/red at its own price. */
export const variantBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Dragon figure',
  price_iqd: 10_000,
  state: 'published',
  track_stock: true,
  variant_model: {
    groups: [
      { ref: 'size', name: 'Size', name_ar: 'المقاس', values: [{ ref: 's', name: 'S' }, { ref: 'm', name: 'M', name_ar: 'وسط' }] },
      { ref: 'col', name: 'Colour', kind: 'color', values: [{ ref: 'red', name: 'Red', name_ar: 'أحمر', swatch: 'red' }] },
    ],
    variants: [
      { values: ['s', 'red'], stock: 2, sku: 'DR-S' },
      { values: ['m', 'red'], stock: 5, price_iqd: 14_000, compare_at_iqd: 16_000, sku: 'DR-M' },
    ],
  },
  ...extra,
});

