import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { publicUser, localeToDb } from '../lib/types';
import { requireAuth, badRequest, conflict, notFound, str, oneOf, username } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';

export const profileRoutes = new Hono<AppContext>();
profileRoutes.use('*', requireAuth);

const USERNAME_COOLDOWN_DAYS = 14;

profileRoutes.patch('/', async (c) => {
  await rateLimit(c, 'profile-save', 60, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const name = body.name !== undefined ? str(body.name, 'name', { max: 100, required: false }) : user.name;
  const bio = body.bio !== undefined ? str(body.bio, 'bio', { max: 500, required: false }) : user.bio;
  const website = body.website !== undefined ? str(body.website, 'website', { max: 200, required: false }) : user.website;
  // API speaks 'ckb'; the DB column stores 'ku' (see localeToDb).
  const locale =
    body.locale !== undefined
      ? localeToDb(oneOf(body.locale, 'locale', ['en', 'ar', 'ckb', 'ku'] as const))
      : user.locale;

  let profileJson = user.profile_json;
  if (body.profile !== undefined) {
    if (typeof body.profile !== 'object' || body.profile === null || Array.isArray(body.profile)) {
      throw badRequest('profile must be an object');
    }
    const s = JSON.stringify(body.profile);
    if (s.length > 8000) throw badRequest('profile data is too large');
    profileJson = s;
  }

  let newUsername = user.username;
  if (body.username !== undefined && body.username !== user.username) {
    const uname = username(body.username);
    // Server-enforced 14-day cooldown, from the audit trail of past changes.
    const recent = await c.env.DB.prepare(
      `SELECT created_at FROM audit_log WHERE actor_id = ? AND action = 'profile.username_change'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(user.id)
      .first<{ created_at: string }>();
    if (recent && Date.now() - new Date(recent.created_at).getTime() < USERNAME_COOLDOWN_DAYS * 86_400_000) {
      throw badRequest(`You can only change your username once every ${USERNAME_COOLDOWN_DAYS} days`);
    }
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?')
      .bind(uname, user.id)
      .first();
    if (taken) throw conflict('This username is taken');
    newUsername = uname;
  }

  const avatarKey =
    body.avatarKey !== undefined ? str(body.avatarKey, 'avatarKey', { max: 300, required: false }) || null : user.avatar_key;
  if (avatarKey && !avatarKey.startsWith(`avatars/${user.id}/`)) {
    throw badRequest('Invalid avatar reference');
  }

  await c.env.DB.prepare(
    `UPDATE users SET name = ?, bio = ?, website = ?, locale = ?, profile_json = ?, username = ?, avatar_key = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(name, bio, website, locale, profileJson, newUsername, avatarKey, user.id)
    .run();

  if (newUsername !== user.username) {
    await c.env.DB.prepare(
      "INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'profile.username_change', ?, ?)"
    )
      .bind(user.id, user.id, JSON.stringify({ to: newUsername }))
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return c.json({ success: true, user: publicUser(updated as never) });
});

// Favorites ("Collection") ----------------------------------------------------

profileRoutes.get('/favorites', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.name_ar, p.images, p.price_iqd
       FROM favorites f JOIN products p ON p.id = f.product_id
      WHERE f.user_id = ? AND p.status = 'active' ORDER BY f.created_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    favorites: results.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      name_ar: p.name_ar,
      image: (() => { try { return (JSON.parse(String(p.images)) as string[])[0] ?? ''; } catch { return ''; } })(),
      price_iqd: p.price_iqd,
    })),
  });
});

profileRoutes.put('/favorites/:productId', async (c) => {
  const user = c.get('user')!;
  const productId = c.req.param('productId');
  const product = await c.env.DB.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first();
  if (!product) throw notFound('Product not found');
  await c.env.DB.prepare('INSERT INTO favorites (user_id, product_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .bind(user.id, productId)
    .run();
  return c.json({ success: true, favorite: true });
});

profileRoutes.delete('/favorites/:productId', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?')
    .bind(user.id, c.req.param('productId'))
    .run();
  return c.json({ success: true, favorite: false });
});

// Warranty claims -------------------------------------------------------------

profileRoutes.get('/warranty-claims', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM warranty_claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, claims: results });
});

profileRoutes.post('/warranty-claims', async (c) => {
  await rateLimit(c, 'warranty', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productName = str(body.productName, 'productName', { min: 2, max: 200 });
  const description = str(body.description, 'description', { min: 10, max: 3000 });
  let orderItemId: string | null = null;
  if (body.orderItemId) {
    orderItemId = str(body.orderItemId, 'orderItemId', { max: 60 });
    const owned = await c.env.DB.prepare(
      `SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = ? AND o.user_id = ?`
    )
      .bind(orderItemId, user.id)
      .first();
    if (!owned) throw badRequest('That order item does not belong to your account');
  }
  const id = newId('wc');
  await c.env.DB.prepare(
    'INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, orderItemId, productName, description)
    .run();
  return c.json({ success: true, id, status: 'submitted' });
});
