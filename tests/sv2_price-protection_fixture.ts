/**
 * Services V2 survey — price protection reproductions (local only).
 *
 * One fresh database (every migration), three accounts — the buyer, the owner
 * (boss@x.co is INITIAL_ADMIN_EMAIL in stubApp) and an assistant-scope admin —
 * and helpers that place a DELIVERED order line exactly the way checkout
 * stores it, so the real claim / decide / return routes run on it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, json, post, get, stubApp } from './fixtures/app';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { discountReproducing, ensureUsdRate, publishV2, repriceV2, usdReproducing } from './fixtures/v2Publish';
import { writeV2 } from './fixtures/pricingV2';

export interface LineSpec {
  orderId?: string;
  itemId?: string;
  productId: string;
  unit: number;
  qty?: number;
  optionId?: string;
  colorId?: string;
  pricing?: Record<string, unknown>;
  transport?: Record<string, unknown> | null;
  deliveredAt?: string;
  createdAt?: string;
}

/**
 * An order created before `price_protection` v5 (2026-10-09). Since the clean start every product a
 * customer can buy is V2- (engine-) priced, so a v5 order's claim takes owner decision 6's base-USD
 * rule; a pre-v5 order keeps the dinar rule of 10.4, which is what the like-with-like rules
 * (rung, channel, class — S-P0a) are pinned under here.
 */
export const PRE_V5 = '2026-10-08T09:00:00.000Z';

export function ppWorld() {
  const raw: DatabaseSync = freshDb();
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES
    ('buyer','Sara','s@x.co','h','customer'),
    ('usr_owner','Owner','boss@x.co','h','admin'),
    ('helper','Assistant','helper@x.co','h','admin');`);
  const db = asD1(raw);
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
    a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/returns', returnRoutes);
  };
  const buyer = stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, mount);
  const owner = stubApp(db, { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, mount);
  const assistant = stubApp(db, { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' }, mount);

  /** A delivered order of one line, stored the way checkout stores it. */
  function deliveredLine(s: LineSpec) {
    const orderId = s.orderId ?? `ORD-${Math.random().toString(36).slice(2, 8)}`;
    const itemId = s.itemId ?? `oi_${orderId}`;
    const qty = s.qty ?? 1;
    const now = Date.now();
    const deliveredAt = s.deliveredAt ?? new Date(now - 60_000).toISOString();
    const createdAt = s.createdAt ?? new Date(now - 120_000).toISOString();
    const total = s.unit * qty;
    raw
      .prepare(
        `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                             subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,created_at)
         VALUES (?, 'buyer', 'delivered', '{}', 'standard', '{}', 'wallet', ?, 0, 1400, ?, 0, ?, ?)`
      )
      .run(orderId, total, total, deliveredAt, createdAt);
    const pricing = { applied_tier: 'regular', applied_iqd: s.unit, regular_iqd: s.unit, pricing_basis: 'direct', ...(s.pricing ?? {}) };
    raw
      .prepare(
        `INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
                                  option_id,option_value_ids,color_id,pricing_snapshot,transport_snapshot)
         VALUES (?, ?, ?, 'Item', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        itemId, orderId, s.productId, s.optionId ? 'Model' : '', qty, s.unit, total,
        s.optionId ?? '', JSON.stringify(s.optionId ? [s.optionId] : []), s.colorId ?? '',
        JSON.stringify(pricing), s.transport ? JSON.stringify(s.transport) : null
      );
    return { orderId, itemId };
  }

  /** A price change recorded the way a product save records it (price_history, 0003). */
  function priceRow(productId: string, variantKey: string, oldIqd: number, newIqd: number, at = new Date().toISOString(), field = 'regular') {
    raw
      .prepare(`INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, 'usr_owner', ?)`)
      .run(productId, variantKey, field, oldIqd, newIqd, at);
  }

  const claim = async (itemId: string, app = buyer) => {
    const res = await post(app, '/api/price-protection/claims', { orderItemId: itemId });
    return { status: res.status, body: await json(res) };
  };
  const decide = async (app: ReturnType<typeof stubApp>, claimId: string, decision: 'approved' | 'rejected' = 'approved', reason?: string) => {
    const res = await post(app, `/api/price-protection/admin/claims/${claimId}/decide`, { decision, ...(reason ? { reason } : {}) });
    return { status: res.status, body: await json(res) };
  };
  const myClaims = async () => json(await get(buyer, '/api/price-protection/claims'));
  const n = (sql: string, ...args: unknown[]) => Number((raw.prepare(sql).get(...(args as never[])) as { n: number }).n);

  // ---- the clean start (DECISIONS row 222) -------------------------------------------------------
  // A product a customer can buy is V2-published, and its prices move only through the V2 writer (the
  // engine locks refuse an UPDATE of a V2 product's price cells); the writer records each move in the
  // product's own `sku:` price history.

  /** Publish a seeded product in V2, its seeded prices reproduced (the USD/IQD applied first). */
  const publish = (productId: string) => publishV2(raw, productId);
  /** One price for every SKU of a product, through the V2 writer. */
  const reprice = (productId: string, iqd: number) => repriceV2(raw, productId, iqd);
  /** A published product's V2 prices: the product's, each model's own, and the pre-order price under the direct one. */
  async function priceV2(productId: string, o: { product: number; models?: Record<string, number>; preorder?: number }) {
    const u = ensureUsdRate(raw);
    const direct = usdReproducing(o.product, u);
    await writeV2(db, productId, {
      method: 'usd',
      points: [
        { scope: 'product', scope_id: '', kind: 'fixed', usd: direct },
        ...Object.entries(o.models ?? {}).map(([id, iqd]) => ({ scope: 'option' as const, scope_id: id, kind: 'fixed' as const, usd: usdReproducing(iqd, u) })),
      ],
      discounts: o.preorder === undefined ? [] : [{ scope: 'product', scope_id: '', usd: discountReproducing(direct, o.preorder, u) }],
    });
  }
  /**
   * A structure edit of a V2 product (a channel opened or closed), made the way the product save makes
   * it: inside the V2 writer's `engine-price:<id>` token (worker/lib/pricingEngine/v2/write.ts), with its
   * prices re-written by `priceV2` right after.
   */
  function structure(productId: string, sql: string) {
    raw.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').run(`engine-price:${productId}`);
    try {
      raw.exec(sql);
    } finally {
      raw.prepare('DELETE FROM ops_guards WHERE id = ?').run(`engine-price:${productId}`);
    }
  }
  /** A membership benefit on one product — since the clean start a member price is a rule over the V2 price, never a typed rung. */
  async function memberRule(tier: 'prime' | 'pro', productId: string, percent: number) {
    const app = stubApp(db, { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes));
    const res = await post(app, '/api/admin/membership-benefits', { tier, benefit_type: 'product_discount', scope: 'product', product_id: productId, discount_mode: 'percent', percent });
    if (res.status !== 200) throw new Error(`membership rule refused: ${await res.text()}`);
  }

  return { raw, db, buyer, owner, assistant, deliveredLine, priceRow, claim, decide, myClaims, n, publish, reprice, priceV2, structure, memberRule };
}
export type PpWorld = ReturnType<typeof ppWorld>;
