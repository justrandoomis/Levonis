import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, int, str } from '../lib/http';
import { newId } from '../lib/crypto';

export const cartRoutes = new Hono<AppContext>();
cartRoutes.use('*', requireAuth);

interface ProductRow {
  id: string;
  name: string;
  name_ar: string;
  images: string;
  price_iqd: number;
  original_price_iqd: number | null;
  membership_prices: string;
  options: string;
  colors: string;
  shipping_methods: string;
  stock: number | null;
  status: string;
}

/**
 * Server-side unit price for a cart line: base price, replaced by the
 * option/color price when one is selected, replaced by the plan price when
 * the buyer's subscription is active. Never trusts a client-sent price.
 */
export function unitPriceIqd(
  product: ProductRow,
  optionId: string,
  colorId: string,
  shippingMethodId: string,
  plan: 'free' | 'plus' | 'pro',
  planActive: boolean
): { price: number; original: number | null; label: string } {
  let price = product.price_iqd;
  let original = product.original_price_iqd;
  const labels: string[] = [];

  const options = safeParse<Array<Record<string, unknown>>>(product.options, []);
  const colors = safeParse<Array<Record<string, unknown>>>(product.colors, []);
  const shipping = safeParse<Array<Record<string, unknown>>>(product.shipping_methods, []);

  if (optionId) {
    const opt = options.find((o) => o.id === optionId);
    if (!opt) throw badRequest('Selected option no longer exists');
    if (Number.isInteger(opt.price_iqd) && (opt.price_iqd as number) > 0) {
      price = opt.price_iqd as number;
      original = Number.isInteger(opt.original_price_iqd) ? (opt.original_price_iqd as number) : original;
    }
    labels.push(String(opt.name ?? optionId));
  }
  if (colorId) {
    const col = colors.find((o) => o.id === colorId);
    if (!col) throw badRequest('Selected color no longer exists');
    if (Number.isInteger(col.price_iqd) && (col.price_iqd as number) > 0) {
      price = col.price_iqd as number;
      original = Number.isInteger(col.original_price_iqd) ? (col.original_price_iqd as number) : original;
    }
    labels.push(String(col.name ?? colorId));
  }
  if (shippingMethodId) {
    const sm = shipping.find((s) => s.id === shippingMethodId);
    if (sm && Number.isInteger(sm.price_iqd) && (sm.price_iqd as number) > 0) {
      price = sm.price_iqd as number;
    }
  }
  if (planActive && (plan === 'plus' || plan === 'pro')) {
    const mp = safeParse<Record<string, number>>(product.membership_prices, {});
    const planPrice = mp[plan];
    if (Number.isInteger(planPrice) && planPrice > 0 && planPrice < price) {
      price = planPrice;
    }
  }
  return { price, original, label: labels.join(' / ') };
}

export function planIsActive(plan: string, expiry: number): boolean {
  return plan !== 'free' && (expiry === 0 || expiry > Date.now());
}

async function loadCart(c: Context<AppContext>) {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id, ci.shipping_method_id, p.*
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ? ORDER BY ci.created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  const active = planIsActive(user.subscription_plan, user.subscription_expiry);
  const items = [];
  for (const row of results) {
    if (row.status !== 'active') continue; // hidden products drop out of the cart view
    let priced;
    try {
      priced = unitPriceIqd(
        row as unknown as ProductRow,
        String(row.option_id ?? ''),
        String(row.color_id ?? ''),
        String(row.shipping_method_id ?? ''),
        user.subscription_plan,
        active
      );
    } catch {
      priced = { price: Number(row.price_iqd), original: row.original_price_iqd as number | null, label: '' };
    }
    items.push({
      id: row.cart_item_id,
      productId: row.id,
      slug: row.slug,
      name: row.name,
      name_ar: row.name_ar,
      image: safeParse<string[]>(row.images, [])[0] ?? '',
      qty: row.qty,
      option_id: row.option_id,
      color_id: row.color_id,
      shipping_method_id: row.shipping_method_id,
      variantLabel: priced.label,
      unit_price_iqd: priced.price,
      original_price_iqd: priced.original,
      stock: row.stock,
      options: safeParse(row.options, []),
      colors: safeParse(row.colors, []),
      shipping_methods: safeParse(row.shipping_methods, []),
    });
  }
  return items;
}

cartRoutes.get('/', async (c) => {
  const items = await loadCart(c);
  return c.json({ success: true, items });
});

cartRoutes.post('/items', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const qty = int(body.qty, 'qty', { min: 1, max: 99, def: 1 });
  const optionId = str(body.optionId, 'optionId', { max: 60, required: false });
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false });
  const shippingMethodId = str(body.shippingMethodId, 'shippingMethodId', { max: 60, required: false });

  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first<ProductRow>();
  if (!product) throw notFound('Product not found or unavailable');
  // Validates that the selected option/color still exist.
  unitPriceIqd(product, optionId, colorId, shippingMethodId, user.subscription_plan, planIsActive(user.subscription_plan, user.subscription_expiry));
  if (product.stock !== null && product.stock < qty) {
    throw badRequest(`Only ${product.stock} left in stock`);
  }

  await c.env.DB.prepare(
    `INSERT INTO cart_items (id, user_id, product_id, option_id, color_id, shipping_method_id, qty)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
     DO UPDATE SET qty = MIN(99, qty + excluded.qty)`
  )
    .bind(newId('ci'), user.id, productId, optionId, colorId, shippingMethodId, qty)
    .run();

  const items = await loadCart(c);
  return c.json({ success: true, items });
});

cartRoutes.patch('/items/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const existing = await c.env.DB.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  if (!existing) throw notFound('Cart item not found');

  const qty = body.qty !== undefined ? int(body.qty, 'qty', { min: 1, max: 99 }) : (existing.qty as number);
  const shippingMethodId =
    body.shippingMethodId !== undefined
      ? str(body.shippingMethodId, 'shippingMethodId', { max: 60, required: false })
      : String(existing.shipping_method_id);
  const optionId =
    body.optionId !== undefined ? str(body.optionId, 'optionId', { max: 60, required: false }) : String(existing.option_id);
  const colorId =
    body.colorId !== undefined ? str(body.colorId, 'colorId', { max: 60, required: false }) : String(existing.color_id);

  const product = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
    .bind(existing.product_id)
    .first<ProductRow>();
  if (product) {
    unitPriceIqd(product, optionId, colorId, shippingMethodId, user.subscription_plan, planIsActive(user.subscription_plan, user.subscription_expiry));
    if (product.stock !== null && product.stock < qty) throw badRequest(`Only ${product.stock} left in stock`);
  }

  await c.env.DB.prepare(
    'UPDATE cart_items SET qty = ?, option_id = ?, color_id = ?, shipping_method_id = ? WHERE id = ? AND user_id = ?'
  )
    .bind(qty, optionId, colorId, shippingMethodId, id, user.id)
    .run();

  const items = await loadCart(c);
  return c.json({ success: true, items });
});

cartRoutes.delete('/items/:id', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  const items = await loadCart(c);
  return c.json({ success: true, items });
});
