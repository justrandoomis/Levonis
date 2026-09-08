/**
 * `levonis-notifications` — the Worker.
 *
 * Thin on purpose: the pump (`pump.ts`), the consumers (`consumers.ts`), the
 * transports (`transports/*`) and the app (`app.ts`) are plain modules a test
 * drives with an in-memory database and an injected `fetch`. This file owns
 * only what needs the Workers runtime.
 *
 * The public methods of this class ARE the RPC contract (`CONTRACT.md`).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLogger } from '@levonis/platform-kit/log';
import { healthReport } from '@levonis/platform-kit/health';
import { KeyRing } from '@levonis/platform-kit/keys';
import { ownedDb } from '@levonis/platform-kit/db';
import { isUniqueViolation } from '@levonis/platform-kit/idempotency';
import type { DeliverResult, HealthReport, HopEnvelope, RpcCtx } from '@levonis/contracts/rpc/common';
import type { SendCommand } from '@levonis/contracts/rpc/notifications';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { Env } from './env';
import { isOn, retentionDays, versionOf } from './env';
import { createApp } from './app';
import { createNotificationsConsumer } from './consumers';
import { assertCaller } from './guard';
import { pump } from './pump';
import { TransportRegistry } from './transports/registry';
import { enqueueStatement, notifyStatement, NOTIFICATIONS_OWNS, NOTIFICATIONS_READS, outboxLagSeconds, pruneDeliveryLogStatement, pruneTelegramUpdatesStatement } from './store';
import type { OutboxMessage } from './types';

/** One per isolate. Holds no secret and no database handle. */
const transports = new TransportRegistry();

let ring: KeyRing | null = null;
async function keyRing(env: Env): Promise<KeyRing> {
  if (!ring) ring = await KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS);
  return ring;
}

const log = createLogger({ svc: 'notifications', sampleRate: 0.1 });

/** The owned-tables guard (ADR-003): the boundary is enforced by the driver, not only by a test. */
const guarded = (env: Env): D1Database =>
  ownedDb(env.DB, { service: 'notifications', owns: NOTIFICATIONS_OWNS, reads: NOTIFICATIONS_READS }, { mode: env.OWNERSHIP_GUARD === 'log' ? 'log' : 'throw' });

export default class NotificationsEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return createApp().fetch(request, this.env, this.ctx);
  }

  /** The bus consumer for the four types of slice 1.7 (`CONTRACT.md` §1). */
  async deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult> {
    const consumer = createNotificationsConsumer({
      keys: await keyRing(this.env),
      env: this.env as unknown as Record<string, string | undefined>,
      acceptFixtureSig: isOn(this.env.ACCEPT_FIXTURE_SIG),
      log,
    });
    const result = await consumer.deliver(guarded(this.env), batch, hop ?? null);
    // The message is enqueued, not sent, inside the delivery batch; the pump
    // owns the sending, and running it here only shortens the wait.
    this.ctx.waitUntil(this.runPump());
    return result;
  }

  /**
   * `NotificationsApi.send` — the command the core's `enqueue()` forwards to
   * from Phase 4b-i, with the same `event_key` semantics it has today: one
   * delivery per key, forever.
   *
   * `queued: false, replayed: true` is the honest answer to a replay: the key
   * was already enqueued, so nothing new was written and nothing will be sent
   * twice.
   *
   * THE FIRST LINE IS THE HOP ASSERTION and it has to be: everything after it
   * addresses a real person with the platform's own credentials
   * (`guard.ts` explains why this method in particular).
   */
  async send(cmd: SendCommand, ctx?: RpcCtx): Promise<{ queued: boolean; replayed: boolean }> {
    await assertCaller(this.env, 'send', [cmd], ctx);
    const db = guarded(this.env);
    const at = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const channel of cmd.channels ?? []) {
      if (channel === 'inapp') {
        statements.push(
          notifyStatement(
            db,
            {
              userId: cmd.user_id,
              kind: cmd.template,
              title_ar: String(cmd.params?.title_ar ?? ''),
              title_en: String(cmd.params?.title_en ?? ''),
              body_ar: String(cmd.params?.body_ar ?? ''),
              body_en: String(cmd.params?.body_en ?? ''),
              link: String(cmd.params?.link ?? ''),
              eventKey: cmd.event_key,
            },
            at
          ).stmt
        );
        continue;
      }
      const message = messageFor(channel, cmd);
      if (message) statements.push(enqueueStatement(db, `${cmd.event_key}:${channel}`, message, { at }).stmt);
    }
    if (statements.length === 0) return { queued: false, replayed: false };
    try {
      await db.batch(statements);
    } catch (e) {
      if (isUniqueViolation(e)) return { queued: false, replayed: true };
      throw e;
    }
    this.ctx.waitUntil(this.runPump());
    return { queued: true, replayed: false };
  }

  health(): Promise<HealthReport> {
    return healthReport({
      svc: 'notifications',
      ver: versionOf(this.env),
      db: this.env.DB ?? null,
      outboxLagS: () => outboxLagSeconds(this.env.DB, new Date().toISOString()),
    });
  }

  /**
   * The per-minute pump. The core's cron runs every fifteen minutes, which is
   * why a verification mail can take a quarter of an hour today.
   */
  async scheduled(): Promise<void> {
    await this.runPump();
    // The retention roll, after the pump. Bounded per run, so a first pass over
    // a large table is many small deletes rather than one that times the tick
    // out. See `store.ts` for what is deliberately NOT rolled.
    const db = guarded(this.env);
    const before = new Date(Date.now() - retentionDays(this.env) * 86_400_000).toISOString();
    const [log_, updates] = await db.batch([pruneDeliveryLogStatement(db, before), pruneTelegramUpdatesStatement(db, before)]);
    const pruned = Number(log_?.meta?.changes ?? 0) + Number(updates?.meta?.changes ?? 0);
    if (pruned > 0) log.info('notify.retention', { deliveries: log_?.meta?.changes ?? 0, telegram_updates: updates?.meta?.changes ?? 0, before });
  }

  private runPump(): Promise<unknown> {
    return pump({
      db: guarded(this.env),
      env: this.env as unknown as Record<string, string | undefined>,
      transports,
      log,
    });
  }
}

/** The provider-shaped payload for a channel, or null when the command cannot address it. */
function messageFor(channel: string, cmd: SendCommand): OutboxMessage | null {
  const p = cmd.params ?? {};
  if (channel === 'email') {
    const to = String(p.to ?? '');
    if (!to) return null;
    return { kind: 'email', to, subject: String(p.subject ?? ''), html: String(p.html ?? ''), text: String(p.text ?? '') };
  }
  if (channel === 'telegram') {
    const chatId = String(p.chat_id ?? '');
    if (!chatId) return null;
    return { kind: 'telegram', chat_id: chatId, text: String(p.text ?? '') };
  }
  return null;
}
