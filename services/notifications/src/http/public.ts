/**
 * `/api/notifications/*` — the SPA's in-app inbox.
 *
 * These shapes are today's core responses field for field
 * (`worker/routes/notifications.ts`, pinned by
 * `packages/contracts/src/http/notifications.ts`): the Phase 4 prefix flip must
 * be invisible to the SPA, so this file is a port, not a redesign.
 *
 * WHO the caller is comes from the gateway's signed principal
 * (`01-TARGET.md` §3.4), forwarded verbatim in `x-levonis-principal` — and
 * this service VERIFIES it itself (§4 item 2): the Ed25519 signature against
 * Identity's registered key, `iat`/`exp` and the issuing service. `host_kind`
 * is deliberately NOT pinned here — the inbox is read on the apex and on every
 * merchant storefront alike, unlike the admin surfaces, which are apex-only. A
 * header this Worker cannot verify is not a principal, so the route answers
 * 401. That is not a formality: an inbox keyed on an unverified `sub` is an
 * inbox anyone can read and mark read as anyone else.
 *
 * While `ALLOWED_CALLER_KIDS` is empty — every deployment before the gateway
 * mints principals — the ring holds no key and every request here is 401,
 * which is the state these routes are specified to be in until Phase 3.
 */
import { Hono } from 'hono';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import type { MarkReadResponse, NotificationListResponse, UnreadCountResponse } from '@levonis/contracts/http/notifications';
import { verifyPrincipal } from '@levonis/platform-kit/principal';
import type { Principal } from '@levonis/contracts/rpc/common';
import type { Env } from '../env';
import { producerKeys } from '../keys';
import { listNotifications, markRead, unreadCount } from '../store';

/**
 * Identity signs principals; until Phase 9 that is the core
 * (`01-TARGET.md` §3.4 "Strangler mode"), so both names are accepted.
 */
export const PRINCIPAL_ISSUERS = ['identity', 'core'];

/**
 * The verified principal, or null.
 *
 * Every refusal is the same 401 and no reason travels back: which of
 * `UNKNOWN_KID`, `BAD_SIGNATURE` or `EXPIRED` it was is a fact about our keys,
 * not about the caller's right to know. `anon:` subjects are refused too — an
 * anonymous marker identifies nobody, and this inbox is per person.
 */
export async function principalOf(env: Env, header: string | undefined): Promise<Principal | null> {
  if (!header) return null;
  const v = await verifyPrincipal(header, await producerKeys(env), {
    nowSeconds: Math.floor(Date.now() / 1000),
    issuers: PRINCIPAL_ISSUERS,
  });
  if (!v.ok) return null;
  if (!v.principal.sub || v.principal.sub.startsWith('anon:') || v.principal.role === 'anonymous') return null;
  return v.principal;
}

const unauthorized = { success: false as const, error: 'Authentication required', code: 'UNAUTHORIZED' };

export function publicRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  /** `GET /api/notifications?limit=&before=&unread=1` */
  app.get('/', async (c) => {
    const principal = await principalOf(c.env, c.req.header(PRINCIPAL_HEADER));
    if (!principal) return c.json(unauthorized, 401);
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
    const rows = await listNotifications(c.env.DB, principal.sub, {
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      before: c.req.query('before') || undefined,
      unreadOnly: c.req.query('unread') === '1',
    });
    const body: NotificationListResponse = {
      success: true,
      unread: await unreadCount(c.env.DB, principal.sub),
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title_ar: r.title_ar,
        title_en: r.title_en,
        body_ar: r.body_ar || null,
        body_en: r.body_en || null,
        link: r.link || null,
        entity_type: r.entity_type || null,
        entity_id: r.entity_id || null,
        // the timestamp itself is not exposed, only whether it is set
        read: r.read_at !== null,
        created_at: r.created_at,
      })),
      next_before: rows.length ? rows[rows.length - 1].created_at : null,
    };
    return c.json(body);
  });

  app.get('/unread-count', async (c) => {
    const principal = await principalOf(c.env, c.req.header(PRINCIPAL_HEADER));
    if (!principal) return c.json(unauthorized, 401);
    const body: UnreadCountResponse = { success: true, unread: await unreadCount(c.env.DB, principal.sub) };
    return c.json(body);
  });

  /** `POST /api/notifications/read` with `{ id? }` — no id marks everything read. */
  app.post('/read', async (c) => {
    const principal = await principalOf(c.env, c.req.header(PRINCIPAL_HEADER));
    if (!principal) return c.json(unauthorized, 401);
    const payload = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof payload?.id === 'string' && payload.id ? payload.id : undefined;
    const marked = await markRead(c.env.DB, principal.sub, id);
    const body: MarkReadResponse = { success: true, marked, unread: await unreadCount(c.env.DB, principal.sub) };
    return c.json(body);
  });

  return app;
}
