/**
 * A WORLD FOR THE REWARDS TESTS OF THE CART AND THE ADMIN (DECISIONS row 298): the gift
 * world, a printer in a printer catalog, a filament in the FDM section, 0225 applied at a
 * chosen instant, and a way to hand the customer a coupon on today's terms.
 */
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, row, type App } from './app';
import { apps, get, giftWorld, json, paidLine, placeOrder, type J } from './giftWorld';
import type { Env } from '../../worker/lib/types';
import { newId } from '../../worker/lib/crypto';
import { REWARD_PROGRAM_DEFAULT, type RewardCouponKind } from '../../worker/lib/rewards/config';
import { mintStatements, rewardCouponCode, termsFor } from '../../worker/lib/rewards/coupons';
import { WEEKLY_MIGRATION } from '../../worker/lib/rewards/sweep';
import { runOrderDeliveredEffects } from '../../worker/lib/orderDeliveredEffects';

export const DAY = 86_400_000;
export const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;

/** A printer (`p_printer`), a filament (`p_plain`, in the FDM section), and the weekly programme started at `appliedAt`. */
export function rewardsWorld(appliedAt = Date.now()): DatabaseSync {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog)
      VALUES ('rw_printers',NULL,'rw-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','reward-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',200000,'active',60,'[]','[]','direct_sale','["direct_sale"]','[]','["https://cdn/a1.png"]','tracked');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0);
    UPDATE products SET category_id = 'cat_materials_fdm', stock = 60 WHERE id = 'p_plain';
    CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  raw.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(WEEKLY_MIGRATION, new Date(appliedAt).toISOString().replace('T', ' ').slice(0, 19));
  return raw;
}

/** One product at exactly this price, in stock. */
export function productAt(raw: DatabaseSync, id: string, priceIqd: number, extra: { category?: string } = {}) {
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,category_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 60, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'BASE', ?)`
    )
    .run(id, id, `Thing ${id}`, `شيء ${id}`, `شت ${id}`, priceIqd, extra.category ?? null);
}

/** A live coupon of today's terms in this customer's hands, from the team. Answers its code and ids. */
export async function handCoupon(raw: DatabaseSync, kind: RewardCouponKind, userId = 'buyer', over: { issuedAt?: string; expiresAt?: string } = {}) {
  const db = asD1(raw);
  const grantId = newId('rwg');
  const couponId = newId('cpn');
  const code = rewardCouponCode(kind);
  const issuedAt = over.issuedAt ?? new Date(Date.now() - 60_000).toISOString();
  const expiresAt = over.expiresAt ?? new Date(Date.now() + 7 * DAY).toISOString();
  await db.batch(
    mintStatements(db, {
      grantId,
      couponId,
      code,
      userId,
      source: 'admin',
      sourceRef: `admin:${grantId}`,
      orderId: null,
      orderItemId: null,
      unitIndex: null,
      // A hand-made coupon keeps one discount per piece (the switch off): the cases on a sale price say so themselves.
      terms: { ...termsFor(kind, REWARD_PROGRAM_DEFAULT), stacks: kind !== 'filament_discount' },
      issuedAt,
      expiresAt,
    })
  );
  return { code, grantId, couponId };
}

let seq = 0;

/** A printer order through the real checkout, delivered `deliveredAt`. The delivery's own coupons go unless `keepFirstPair`. */
export async function printerOrder(raw: DatabaseSync, qty = 1, deliveredAt = new Date(Date.now() - 60_000).toISOString(), keepFirstPair = false) {
  const a = apps(raw);
  paidLine(raw, `ci_rw_${seq++}`, 'p_printer', { qty, fulfillmentType: 'direct_sale' });
  const order = await placeOrder(a.buyer, { deliveryMethodId: 'pickup', paymentMethodId: 'cash' });
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(deliveredAt, order.id);
  await runOrderDeliveredEffects(envOf(raw), order.id);
  if (!keepFirstPair) wipeCoupons(raw, order.id);
  raw.prepare('UPDATE order_item_units SET delivered_at = ?, warranty_start_at = ? WHERE order_id = ?').run(deliveredAt, deliveredAt, order.id);
  const ends = new Date(Date.parse(deliveredAt) + 7 * DAY).toISOString();
  raw.prepare('UPDATE reward_grants SET issued_at = ?, expires_at = ? WHERE order_id = ?').run(deliveredAt, ends, order.id);
  raw.prepare('UPDATE coupons SET starts_at = ?, ends_at = ?, created_at = ? WHERE reward_grant_id IN (SELECT id FROM reward_grants WHERE order_id = ?)').run(deliveredAt, ends, deliveredAt, order.id);
  const item = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_printer'", order.id)!;
  return { orderId: String(order.id), itemId: item.id };
}

/** Every printer coupon of an order (or of all) gone, as if never issued, so the sweep would serve it again. */
export function wipeCoupons(raw: DatabaseSync, orderId?: string) {
  const where = orderId ? 'WHERE order_id = ?' : '';
  const binds = orderId ? [orderId] : [];
  raw.prepare(`UPDATE coupons SET reward_grant_id = NULL WHERE reward_grant_id IN (SELECT id FROM reward_grants ${where})`).run(...binds);
  raw.prepare(`DELETE FROM coupons WHERE id IN (SELECT coupon_id FROM reward_grants ${where})`).run(...binds);
  raw.prepare(`DELETE FROM reward_grants ${where}`).run(...binds);
  raw.exec("DELETE FROM user_notifications WHERE kind = 'reward'");
}

/** A row in a table with many NOT NULL columns: only what the test reads, the rest filled. */
export function looseRow(raw: DatabaseSync, table: string, fields: Record<string, string | number>) {
  raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  const columns = all<{ name: string; notnull: number; dflt_value: unknown; type: string }>(raw, `SELECT name, "notnull", dflt_value, type FROM pragma_table_info('${table}')`);
  const base: Record<string, string | number> = { ...fields };
  for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.name in base)) base[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
  const names = Object.keys(base).filter((n) => columns.some((c) => c.name === n));
  raw.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => base[n]));
  raw.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');
}

export const readCoupons = async (app: App, query: Record<string, string> = {}): Promise<J> => {
  const res = await get(app, `/api/cart/reward-coupons?${new URLSearchParams(query).toString()}`);
  const out = await json(res);
  if (res.status !== 200) throw new Error(`the read answered ${res.status}: ${JSON.stringify(out)}`);
  return out;
};
