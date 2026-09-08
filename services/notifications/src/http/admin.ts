/**
 * `/api/v1/notifications/admin/*` — the delivery history an operator reads when
 * a customer says the mail never arrived
 * (`packages/contracts/src/http/notifications.ts`).
 *
 * No row here carries a message body or a recipient: the body may hold a
 * one-time code and the recipient is a contact. What it carries is the
 * `event_key`, the channel, the status, the attempt count and the provider's
 * own error — everything needed to answer "what happened to it", nothing that
 * would make this table worth stealing.
 *
 * AUTHORISATION, and why it is here rather than only at the gateway. It still
 * names the `event_key` of every mail and message the platform sent, which is
 * an operational history no anonymous caller may read. `gatewayOnly()` in
 * front of this router proves only WHERE a request came from, never WHO sent
 * it, so the check that answers "who" is this one — a full-scope admin
 * principal signed by Identity, verified here, apex-only, exactly as Audit and
 * Analytics do it (`01-TARGET.md` §4 item 2, §4 item 6). No principal, one
 * this Worker cannot verify, or an assistant-scope admin → 401/403.
 */
import { Hono } from 'hono';
import type { NotificationChannel } from '@levonis/contracts/rpc/notifications';
import type { NotifyDeliveriesResponse, NotifyDeliveryStatus } from '@levonis/contracts/http/notifications';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { verifyPrincipal, isFullAdmin } from '@levonis/platform-kit/principal';
import { isKitError, forbidden, unauthorized } from '@levonis/platform-kit/errors';
import type { Env } from '../env';
import { producerKeys } from '../keys';
import { PRINCIPAL_ISSUERS } from './public';
import { listDeliveries, outboxLagSeconds } from '../store';

/**
 * Every route below runs this first. `expectHostKind: 'main'` is this
 * service's own copy of the apex-only rule for admin surfaces (§3.5): a
 * principal minted on a merchant storefront is refused here even if the
 * gateway forwarded it.
 */
export async function requireFullAdmin(env: Env, headers: Headers) {
  const header = headers.get(PRINCIPAL_HEADER);
  if (!header) throw unauthorized();
  const v = await verifyPrincipal(header, await producerKeys(env), {
    nowSeconds: Math.floor(Date.now() / 1000),
    issuers: PRINCIPAL_ISSUERS,
    expectHostKind: 'main',
  });
  if (!v.ok) throw unauthorized();
  if (!isFullAdmin(v.principal)) throw forbidden('Administrator access required');
  return v.principal;
}

const authFailure = (e: unknown) =>
  isKitError(e)
    ? { body: e.toBody(), status: e.status as 401 | 403 }
    : { body: { success: false as const, error: 'Authentication required', code: 'UNAUTHORIZED' }, status: 401 as const };

const CHANNELS: readonly NotificationChannel[] = ['inapp', 'email', 'telegram'];
const STATUSES: readonly NotifyDeliveryStatus[] = ['pending', 'sent', 'failed', 'dead', 'dropped'];

export function adminRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  /** `GET /deliveries?channel=&status=&limit=&cursor=` */
  app.get('/deliveries', async (c) => {
    try {
      await requireFullAdmin(c.env, c.req.raw.headers);
    } catch (e) {
      const f = authFailure(e);
      return c.json(f.body, f.status);
    }
    const channel = c.req.query('channel');
    const status = c.req.query('status');
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
    const rows = await listDeliveries(c.env.DB, {
      channel: channel && (CHANNELS as readonly string[]).includes(channel) ? (channel as NotificationChannel) : undefined,
      status: status && (STATUSES as readonly string[]).includes(status) ? (status as NotifyDeliveryStatus) : undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      cursor: c.req.query('cursor') || undefined,
    });
    const body: NotifyDeliveriesResponse = {
      success: true,
      rows,
      next: rows.length ? rows[rows.length - 1].created_at : null,
      outbox_lag_s: await outboxLagSeconds(c.env.DB, new Date().toISOString()),
    };
    return c.json(body);
  });

  return app;
}
