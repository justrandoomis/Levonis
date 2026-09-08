/**
 * `POST /api/telegram/webhook` — the one unauthenticated ingress in the
 * platform (`packages/contracts/src/http/notifications.ts`).
 *
 * Three rules, all of them load-bearing:
 *
 *  1. **It answers 200 to every well-formed update.** Telegram retries anything
 *     else, forever, so an error status turns one bad update into a permanent
 *     flood. A refusal is an accepted update that did nothing.
 *  2. **Dedup is the primary key of `telegram_updates`**, exactly as
 *     `migrations/0003_final_phase.sql` already does it. A replay is
 *     `duplicate: true` and no side effect runs twice.
 *  3. **The secret token is compared in constant time.** When
 *     `TELEGRAM_WEBHOOK_SECRET` is unset the endpoint still dedups and still
 *     answers 200 but accepts nothing — an unauthenticated ingress with no
 *     shared secret is not an ingress, it is an open door.
 *
 * ROUTING IS A STUB in this slice, and deliberately so. A callback button on an
 * admin's phone becomes `LEDGER.decideDeposit` — a MONEY command — and Ledger
 * verifies the approval nonce itself, never trusting Notifications
 * (`01-TARGET.md` §6.5). That binding does not exist yet, so the update is
 * recorded and acknowledged and nothing else happens.
 */
import { Hono } from 'hono';
import { constantTimeEqual } from '@levonis/platform-kit/keys';
import type { TelegramWebhookResponse } from '@levonis/contracts/http/notifications';
import type { Env } from '../env';
import { recordUpdate } from '../store';

export const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

/** What the router will one day dispatch on. Recorded now so the shape is fixed before it matters. */
export type UpdateKind = 'identity' | 'wallet_approval' | 'unrouted';

export function classifyUpdate(update: Record<string, unknown>): UpdateKind {
  const cb = update.callback_query as { data?: unknown } | undefined;
  const data = typeof cb?.data === 'string' ? cb.data : '';
  if (/^(dep|wd):/.test(data)) return 'wallet_approval';
  if (/^(link|otp):/.test(data)) return 'identity';
  return 'unrouted';
}

export function webhookRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const ok: TelegramWebhookResponse = { ok: true };
    const secret = (c.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
    const given = c.req.header(TELEGRAM_SECRET_HEADER) ?? '';
    if (!secret || !constantTimeEqual(given, secret)) return c.json(ok);

    const update = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const updateId = typeof update?.update_id === 'number' ? update.update_id : null;
    if (updateId === null) return c.json(ok);

    const fresh = await recordUpdate(c.env.DB, updateId, new Date().toISOString());
    if (!fresh) return c.json({ ok: true, duplicate: true } satisfies TelegramWebhookResponse);

    // Routing lands with the LEDGER and IDENTITY bindings (Phase 4/6). The
    // classification runs now so the recorded shape is not invented later.
    classifyUpdate(update ?? {});
    return c.json(ok);
  });

  return app;
}
