import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, notFound, str, badRequest } from '../lib/http';
import { newId } from '../lib/crypto';
import { addressMatchesSnapshot, getApprovedAddress } from './kyc';
import { normalizeGovernorate } from '../lib/iraqGovernorates';

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
  // 0026: the parts a courier's form actually asks for. Optional, because
  // every address saved before this migration has them empty and editing an
  // old address must not suddenly become impossible without re-entering them.
  // The governorate is a closed list — free text there is the admin's problem
  // on every order, since dispatch routes on it.
  const governorate = normalizeGovernorate(body.governorate);
  if (body.governorate && !governorate) throw badRequest('Unknown governorate');
  const area = str(body.area, 'area', { max: 120, required: false });
  const notes = str(body.notes, 'notes', { max: 500, required: false });
  return { name, phone, address, label, landmark, governorate, area, notes };
}

addressRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
  )
    .bind(user.id)
    .all();

  // PRO approved-address awareness (final-phase §9): the approved snapshot
  // in approved_addresses is an immutable COPY — editing a saved address
  // never changes it. Here we only annotate which saved row backs the
  // current snapshot and whether it still matches, so the UI/checkout can
  // explain eligibility. Ordinary address CRUD is never blocked by this.
  const approved = await getApprovedAddress(c.env.DB, user.id);
  const addresses = results.map((a) => {
    const backs = !!approved && approved.source_address_id === (a as { id: string }).id;
    return {
      ...a,
      backs_approved_snapshot: backs,
      matches_approved_snapshot: backs
        ? addressMatchesSnapshot(
            a as { name: string; phone: string; address: string; landmark: string },
            approved!
          )
        : null,
    };
  });
  return c.json({
    success: true,
    addresses,
    approved_snapshot: approved
      ? { version: Number(approved.version), source_address_id: approved.source_address_id || null }
      : null,
  });
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
      `INSERT INTO addresses (id, user_id, label, name, phone, address, landmark,
                              governorate, area, notes, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, user.id, a.label, a.name, a.phone, a.address, a.landmark,
      a.governorate, a.area, a.notes, makeDefault ? 1 : 0
    )
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
    `UPDATE addresses
        SET label = ?, name = ?, phone = ?, address = ?, landmark = ?,
            governorate = ?, area = ?, notes = ?
      WHERE id = ? AND user_id = ?`
  )
    .bind(a.label, a.name, a.phone, a.address, a.landmark, a.governorate, a.area, a.notes, id, user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Address not found');

  // If this saved address backs the current approved PRO snapshot, tell the
  // client when the edit made it diverge — the snapshot itself is an
  // immutable copy and is deliberately NOT updated here (a change to the
  // approved record goes through the admin-reviewed request flow). The edit
  // is never blocked.
  let mismatch: boolean | null = null;
  const approved = await getApprovedAddress(c.env.DB, user.id);
  if (approved && approved.source_address_id === id) {
    mismatch = !addressMatchesSnapshot(
      { name: a.name, phone: a.phone, address: a.address, landmark: a.landmark },
      approved
    );
  }
  return c.json({ success: true, approved_snapshot_mismatch: mismatch });
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
