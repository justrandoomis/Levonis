/**
 * THE ADMIN'S VIEW OF GRANTED GIFTS — the grants list, one grant's detail and
 * its audit timeline (docs/GIFTS_QUICK_BUY.md §1.2). Unlike the customer's
 * card this carries the internal note, who granted it and why it was
 * cancelled; it is served only under requireAdmin.
 */
import { badRequest, int, str } from '../http';
import { likePattern, sqlLikeClause } from '../sqlLike';
import { safeParse } from '../types';
import { chosenItemView, giftStatusOf, GIFT_ROW_SELECT, levelViewFrom, loadLevels, type GiftItemView, type GiftMode, type GiftReason, type GiftStatus, type LevelView } from './model';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : text(v));

export interface AdminGiftView {
  id: string;
  status: GiftStatus;
  state: string;
  mode: GiftMode;
  reason: GiftReason;
  level: LevelView | null;
  user: { id: string; name: string; email: string; username: string; phone: string };
  note: string;
  granted_by: { id: string; name: string; email: string } | null;
  granted_at: string;
  chosen: GiftItemView | null;
  item_id: string | null;
  cart_item_id: string | null;
  order: { id: string; status: string; stage: string | null } | null;
  order_seq: number;
  chosen_at: string | null;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string;
  version: number;
  reward_id: string | null;
  /** Legacy review boxes: what the old flow recorded. */
  legacy: { state: string; max_level: number; chosen_level: number | null; contents: unknown[]; selected_at: string | null } | null;
  actions: { cancel: boolean; edit_reason: boolean; convert: boolean; fulfill: boolean };
}

/** The grant row with its customer and the granting admin, for the admin list. */
export const ADMIN_GIFT_SELECT = `
SELECT x.*, u.name AS user_name, u.email AS user_email, u.username AS user_username, u.phone_e164 AS user_phone,
       a.name AS admin_name, a.email AS admin_email
  FROM (${GIFT_ROW_SELECT}) x
  JOIN users u ON u.id = x.user_id
  LEFT JOIN users a ON a.id = x.granted_by`;

export function adminGiftView(g: Record<string, unknown>, levels: Map<number, { view: LevelView }>): AdminGiftView {
  const mode = (text(g.grant_mode) || 'legacy') as GiftMode;
  const state = text(g.state);
  const n = Number(g.level);
  const legacy = mode === 'legacy';
  return {
    id: text(g.id),
    status: giftStatusOf(g),
    state,
    mode,
    reason: (text(g.reason) || 'legacy') as GiftReason,
    level: Number.isInteger(n) && n >= 1 && n <= 5 ? levels.get(n)?.view ?? levelViewFrom(undefined, n) : null,
    user: {
      id: text(g.user_id),
      name: text(g.user_name),
      email: text(g.user_email),
      username: text(g.user_username),
      phone: text(g.user_phone),
    },
    note: text(g.admin_note),
    granted_by: g.granted_by
      ? { id: text(g.granted_by), name: text(g.admin_name) || (g.granted_by === 'system' ? 'system' : ''), email: text(g.admin_email) }
      : null,
    granted_at: text(g.granted_at) || text(g.created_at),
    chosen: chosenItemView(g, null),
    item_id: orNull(g.gift_item_id),
    cart_item_id: state === 'redeemed' ? orNull(g.cart_item_id) : null,
    order: text(g.order_id) ? { id: text(g.order_id), status: text(g.order_status), stage: orNull(g.order_stage) } : null,
    order_seq: Number(g.order_seq) || 0,
    chosen_at: orNull(g.chosen_at),
    redeemed_at: orNull(g.redeemed_at),
    ordered_at: orNull(g.ordered_at),
    fulfilled_at: orNull(g.fulfilled_at),
    cancelled_at: orNull(g.cancelled_at),
    cancelled_by: orNull(g.cancelled_by),
    cancel_reason: text(g.cancel_reason),
    version: Number(g.version) || 1,
    reward_id: orNull(g.reward_id),
    legacy: legacy
      ? {
          state,
          max_level: Number(g.max_level) || 0,
          chosen_level: g.chosen_level == null ? null : Number(g.chosen_level),
          contents: safeParse<unknown[]>(text(g.contents) || '[]', []),
          selected_at: orNull(g.selected_at),
        }
      : null,
    actions: {
      cancel: legacy ? state === 'available' : ['granted', 'ready_to_redeem', 'redeemed'].includes(state),
      edit_reason: !legacy,
      convert: legacy && state === 'available',
      fulfill: legacy && state === 'selected',
    },
  };
}

export interface GrantFilters {
  status: string;
  level: number | null;
  reason: string;
  user: string;
  q: string;
  cursor: { at: string; id: string } | null;
  limit: number;
}

const STATUS_SQL: Record<string, string> = {
  GRANTED: "x.state = 'granted'",
  READY_TO_REDEEM: "x.state = 'ready_to_redeem'",
  REDEEMED: "x.state = 'redeemed' AND x.cart_item_id IS NULL",
  ADDED_TO_ORDER: "x.state = 'redeemed' AND x.cart_item_id IS NOT NULL",
  ORDERED: "x.state = 'ordered'",
  FULFILLED: "x.state = 'fulfilled' AND x.grant_mode <> 'legacy'",
  CANCELLED: "x.state = 'cancelled' AND x.grant_mode <> 'legacy'",
  LEGACY: "x.grant_mode = 'legacy'",
};

export function encodeCursor(at: string, id: string): string {
  return btoa(unescape(encodeURIComponent(`${at}|${id}`))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const s = decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))));
    const i = s.indexOf('|');
    if (i < 1) return null;
    return { at: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export function parseGrantFilters(q: Record<string, string>): GrantFilters {
  const statusRaw = str(q.state ?? q.status, 'state', { max: 30, required: false }).toUpperCase();
  if (statusRaw && !STATUS_SQL[statusRaw]) throw badRequest(`state must be one of: ${Object.keys(STATUS_SQL).join(', ')}`);
  const reason = str(q.reason, 'reason', { max: 20, required: false });
  if (reason && !['legacy', 'review', 'reward', 'compensation', 'admin_gift'].includes(reason)) throw badRequest('Unknown reason');
  const cursorRaw = str(q.cursor, 'cursor', { max: 300, required: false });
  return {
    status: statusRaw,
    level: q.level ? int(q.level, 'level', { min: 1, max: 5 }) : null,
    reason,
    user: str(q.user, 'user', { max: 80, required: false }),
    q: str(q.q, 'q', { max: 100, required: false }),
    cursor: cursorRaw ? decodeCursor(cursorRaw) : null,
    limit: int(q.limit, 'limit', { min: 1, max: 100, def: 30 }),
  };
}

/** GET /api/gifts/admin/grants — newest first, keyset-paginated on (granted_at, id). */
export async function listGrants(db: D1Database, f: GrantFilters): Promise<{ grants: AdminGiftView[]; next_cursor: string | null }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status) where.push(STATUS_SQL[f.status]);
  if (f.level) {
    where.push('x.level = ?');
    binds.push(f.level);
  }
  if (f.reason) {
    where.push('x.reason = ?');
    binds.push(f.reason);
  }
  if (f.user) {
    where.push('x.user_id = ?');
    binds.push(f.user);
  }
  if (f.q) {
    const like = likePattern(f.q);
    where.push(`(${sqlLikeClause(['u.email', 'u.username', 'u.name', 'u.phone_e164'])} OR x.id = ? OR x.order_id = ?)`);
    binds.push(like, like, like, like, f.q, f.q);
  }
  const sortKey = "COALESCE(x.granted_at, x.created_at)";
  if (f.cursor) {
    where.push(`(${sortKey} < ? OR (${sortKey} = ? AND x.id < ?))`);
    binds.push(f.cursor.at, f.cursor.at, f.cursor.id);
  }
  const sql = `${ADMIN_GIFT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${sortKey} DESC, x.id DESC LIMIT ?`;
  binds.push(f.limit + 1);
  const [{ results }, levels] = await Promise.all([db.prepare(sql).bind(...binds).all<Record<string, unknown>>(), loadLevels(db)]);
  const rows = results ?? [];
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    grants: page.map((g) => adminGiftView(g, levels)),
    next_cursor: rows.length > f.limit && last ? encodeCursor(text(last.granted_at) || text(last.created_at), text(last.id)) : null,
  };
}

export async function loadAdminGift(db: D1Database, id: string): Promise<AdminGiftView | null> {
  const [row, levels] = await Promise.all([
    db.prepare(`${ADMIN_GIFT_SELECT} WHERE x.id = ?`).bind(id).first<Record<string, unknown>>(),
    loadLevels(db),
  ]);
  return row ? adminGiftView(row, levels) : null;
}

/** One gift's audit timeline: every gift.* row about it, oldest first, with the actor's name. */
export async function giftAuditTimeline(db: D1Database, id: string) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.actor_id, a.action, a.detail, a.created_at, u.name AS actor_name, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.target = ? AND a.action LIKE 'gift.%'
        ORDER BY a.id ASC LIMIT 200`
    )
    .bind(id)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    id: Number(r.id),
    action: text(r.action),
    actor: r.actor_id ? { id: text(r.actor_id), name: text(r.actor_name), email: text(r.actor_email) } : null,
    detail: safeParse<Record<string, unknown>>(text(r.detail) || '{}', {}),
    at: text(r.created_at),
  }));
}
