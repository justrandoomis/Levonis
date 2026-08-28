import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, notFound, str, badRequest } from '../lib/http';
import { newId } from '../lib/crypto';

export const addressRoutes = new Hono<AppContext>();
addressRoutes.use('*', requireAuth);

const PHONE_RE = /^\+?[0-9\s-]{7,20}$/;

function validateAddress(body: Record<string, unknown>) {
  const name = str(body.name, 'name', { min: 2, max: 100 });
  const phone = str(body.phone, 'phone', { min: 7, max: 20 });
  if (!PHONE_RE.test(phone)) throw badRequest('Invalid phone number');
  const address = str(body.address, 'address', { min: 5, max: 300 });
  const label = str(body.label, 'label', { min: 1, max: 40 });
  const landmark = str(body.landmark, 'landmark', { max: 200, required: false });
  return { name, phone, address, label, landmark };
}

addressRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, addresses: results });
});

addressRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const a = validateAddress(body);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?')
    .bind(user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) throw badRequest('Address limit reached (20)');
  const id = newId('adr');
  const makeDefault = body.isDefault === true || (count?.n ?? 0) === 0;
  const stmts = [];
  if (makeDefault) {
    stmts.push(c.env.DB.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').bind(user.id));
  }
  stmts.push(
    c.env.DB.prepare(
      'INSERT INTO addresses (id, user_id, label, name, phone, address, landmark, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, a.label, a.name, a.phone, a.address, a.landmark, makeDefault ? 1 : 0)
  );
  await c.env.DB.batch(stmts);
  return c.json({ success: true, id });
});

addressRoutes.put('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const a = validateAddress(body);
  const res = await c.env.DB.prepare(
    'UPDATE addresses SET label = ?, name = ?, phone = ?, address = ?, landmark = ? WHERE id = ? AND user_id = ?'
  )
    .bind(a.label, a.name, a.phone, a.address, a.landmark, id, user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Address not found');
  return c.json({ success: true });
});

addressRoutes.post('/:id/default', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first();
  if (!exists) throw notFound('Address not found');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?').bind(id, user.id),
  ]);
  return c.json({ success: true });
});

addressRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Address not found');
  return c.json({ success: true });
});
