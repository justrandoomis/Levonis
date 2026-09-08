/**
 * The outbox pump — `worker/lib/outbox.ts` `processOutbox()`, moved.
 *
 * The claim-then-send order is the original's and is the reason two concurrent
 * pumps cannot double-send: the attempts bump is a compare-and-swap, and only
 * the processor whose UPDATE changed a row proceeds.
 *
 * Two gates the core does not have, both fail-closed:
 *
 *   * `NOTIFY_DELIVERY` — the master switch. While the monolith is still the
 *     sender, two Workers sending the same mail is the failure to avoid, so a
 *     dark or freshly deployed Notifications enqueues and records but sends
 *     nothing until the var says `on`.
 *   * the transport registry — a transport whose secret NAMES are absent is not
 *     called at all. Its row is recorded `dropped` with the transport's own
 *     reason (`EMAIL_NOT_CONFIGURED` / `TELEGRAM_NOT_CONFIGURED`), which is
 *     what the core already does, rather than counted as a failure.
 */
import type { Logger } from '@levonis/platform-kit/log';
import { allowedRecipient } from './transports/email';
import type { TransportRegistry } from './transports/registry';
import { claim, claimable, deliveryStatement, markSentStatement, markStateStatement, MAX_ATTEMPTS } from './store';
import type { NotificationChannel, OutboxMessage, OutboxRow } from './types';

export interface PumpDeps {
  db: D1Database;
  /** the Worker's vars + secret names; only a transport's `configured()`/`send()` reads a credential */
  env: Record<string, string | undefined>;
  transports: TransportRegistry;
  now?: () => string;
  fetchImpl?: typeof fetch;
  log?: Logger;
  limit?: number;
}

export interface PumpReport {
  claimed: number;
  sent: number;
  failed: number;
  dropped: number;
  skipped: number;
  /** the master switch was off: nothing was claimed and nothing was sent */
  disabled: boolean;
}

/** The master switch. Fails CLOSED: anything but the exact string `on` is off. */
export const deliveryEnabled = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';

export async function pump(deps: PumpDeps): Promise<PumpReport> {
  const report: PumpReport = { claimed: 0, sent: 0, failed: 0, dropped: 0, skipped: 0, disabled: false };
  if (!deliveryEnabled(deps.env.NOTIFY_DELIVERY)) {
    report.disabled = true;
    return report;
  }
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const rows = await claimable(deps.db, deps.limit ?? 10);

  for (const row of rows) {
    if (!(await claim(deps.db, row))) continue;
    report.claimed++;

    // the staging guard, before anything is parsed or sent
    if (
      row.kind === 'email' &&
      !allowedRecipient(deps.env.EMAIL_ALLOWED_RECIPIENTS, row.recipient, { requireAllowlist: deliveryEnabled(deps.env.EMAIL_ALLOWLIST_REQUIRED) })
    ) {
      await deps.db.batch([
        markStateStatement(deps.db, row.id, 'skipped', 'recipient not in EMAIL_ALLOWED_RECIPIENTS (staging guard)'),
        deliveryStatement(deps.db, { event_key: row.event_key, channel: 'email', template: '', status: 'dropped', attempts: row.attempts + 1, error: 'not in EMAIL_ALLOWED_RECIPIENTS', at }),
      ]);
      report.skipped++;
      // the recipient is NOT logged: an address is a contact
      deps.log?.warn('notify.skipped_recipient', { event_key: row.event_key });
      continue;
    }

    let payload: OutboxMessage;
    try {
      payload = JSON.parse(row.payload) as OutboxMessage;
    } catch {
      await deps.db.batch([
        markStateStatement(deps.db, row.id, 'dead', 'unparseable payload'),
        deliveryStatement(deps.db, { event_key: row.event_key, channel: row.kind, template: '', status: 'dead', attempts: row.attempts + 1, error: 'unparseable payload', at }),
      ]);
      report.failed++;
      continue;
    }

    const transport = deps.transports.get(row.kind);
    if (!transport || !transport.configured(deps.env)) {
      const reason = transport?.disabledReason ?? 'NO_TRANSPORT';
      await deps.db.batch([
        markStateStatement(deps.db, row.id, 'dead', reason),
        deliveryStatement(deps.db, { event_key: row.event_key, channel: row.kind, template: '', status: 'dropped', attempts: row.attempts + 1, error: reason, at }),
      ]);
      report.dropped++;
      continue;
    }

    const result = await transport.send(payload, deps.env, { eventKey: row.event_key, fetchImpl: deps.fetchImpl });
    if (result.ok) {
      await deps.db.batch([
        markSentStatement(deps.db, row.id, at),
        deliveryStatement(deps.db, { event_key: row.event_key, channel: row.kind, template: '', status: 'sent', attempts: row.attempts + 1, error: null, at, delivered_at: at }),
      ]);
      report.sent++;
      continue;
    }

    const attempts = row.attempts + 1;
    const state: OutboxRow['state'] = attempts >= MAX_ATTEMPTS || result.disabled || result.retryable === false ? 'dead' : 'failed';
    await deps.db.batch([
      markStateStatement(deps.db, row.id, state, result.error ?? 'unknown'),
      deliveryStatement(deps.db, {
        event_key: row.event_key,
        channel: row.kind as NotificationChannel,
        template: '',
        status: state === 'dead' ? 'dead' : 'failed',
        attempts,
        error: result.error ?? 'unknown',
        at,
      }),
    ]);
    report.failed++;
  }

  deps.log?.info('notify.pump', { ...report });
  return report;
}
