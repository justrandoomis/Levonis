/**
 * THE STORE'S NOTIFICATION CENTRE — /api/merchant/notifications/*.
 *
 *   GET  /feed?cursor=&unread=1&kind=&limit=   one page, newest first
 *   GET  /unread-count                          the badge (total + per kind)
 *   POST /read  {id?}                           one, or every merchant notice
 *
 * (The switches stay at GET/PATCH /api/merchant/notifications, where the
 * settings screen has always read them — worker/routes/merchant.ts.)
 *
 * Only the store's OWNER reaches this (`requireStoreOwner`), and every query is
 * scoped to the owner's account and to the merchant kinds in SQL: a guessed id
 * of another account's notice reads nothing and marks nothing, and the
 * workspace never lists or clears the owner's PERSONAL notifications (their
 * own orders, support replies) — the header bell keeps those.
 *
 * Each row carries its workspace link as stored (`/merchant/…`); the client
 * re-bases it under `/admin` on the store's own host (`hostPath`).
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireStoreOwner } from '../lib/merchantAuth';
import { safeParse } from '../lib/types';
import {
  isMerchantKind,
  listMerchantNotifications,
  markMerchantRead,
  merchantUnreadCounts,
  type MerchantFeedRow,
} from '../lib/merchantNotify';

export const merchantNotificationRoutes = new Hono<AppContext>();
merchantNotificationRoutes.use('*', requireAuth);

function rowShape(n: MerchantFeedRow) {
  const meta = safeParse<Record<string, unknown>>(n.meta, {});
  return {
    id: n.id,
    kind: n.kind,
    title_ar: n.title_ar,
    title_en: n.title_en,
    body_ar: n.body_ar,
    body_en: n.body_en,
    // Hand-written Sorani, when a sender has it (the matcher composes it);
    // absent otherwise — the client then shows the Arabic.
    ...(typeof meta.title_ckb === 'string' && meta.title_ckb ? { title_ckb: meta.title_ckb } : {}),
    ...(typeof meta.body_ckb === 'string' && meta.body_ckb ? { body_ckb: meta.body_ckb } : {}),
    link: n.link,
    entity_type: n.entity_type,
    entity_id: n.entity_id,
    read: n.read_at !== null,
    created_at: n.created_at,
  };
}

merchantNotificationRoutes.get('/feed', async (c) => {
  await requireStoreOwner(c);
  const user = c.get('user')!;
  const q = c.req.query();
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 25 });
  const cursor = str(q.cursor, 'cursor', { max: 120, required: false });
  const kindRaw = str(q.kind, 'kind', { max: 40, required: false });
  const kind = kindRaw && isMerchantKind(kindRaw) ? kindRaw : null;
  const [page, unread] = await Promise.all([
    listMerchantNotifications(c.env.DB, user.id, { limit, cursor, unreadOnly: q.unread === '1', kind }),
    merchantUnreadCounts(c.env.DB, user.id),
  ]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    unread: unread.total,
    unread_by_kind: unread.by_kind,
    notifications: page.rows.map(rowShape),
    next_cursor: page.next_cursor,
  });
});

merchantNotificationRoutes.get('/unread-count', async (c) => {
  await requireStoreOwner(c);
  const unread = await merchantUnreadCounts(c.env.DB, c.get('user')!.id);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, unread: unread.total, unread_by_kind: unread.by_kind });
});

merchantNotificationRoutes.post('/read', async (c) => {
  await rateLimit(c, 'merchant-notifications-read', 120, 60);
  await requireStoreOwner(c);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(body.id, 'id', { max: 60, required: false });
  const marked = await markMerchantRead(c.env.DB, user.id, id || undefined);
  const unread = await merchantUnreadCounts(c.env.DB, user.id);
  return c.json({ success: true, marked, unread: unread.total, unread_by_kind: unread.by_kind });
});
