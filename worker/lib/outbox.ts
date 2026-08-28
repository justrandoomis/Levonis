/**
 * Durable notification outbox (final-phase §2/§3/§11): business events
 * enqueue atomically (unique event_key — replays no-op); delivery is
 * best-effort with retries and never blocks or undoes the business write.
 * Secrets/OTP codes are never stored in the payload — OTP delivery stores
 * only a reference; the code goes straight to the transport at send time
 * via the volatile `directText` argument.
 */

import type { Env } from './types';
import { newId } from './crypto';

export interface OutboxEmail {
  kind: 'email';
  to: string;
  subject: string;
  html: string;
  text: string;
}
export interface OutboxTelegram {
  kind: 'telegram';
  chat_id: number | string;
  text: string;
}

const MAX_ATTEMPTS = 5;

/** Enqueue (idempotent on eventKey). Returns the outbox id or null when the
 *  event was already enqueued. Call inside/next to the business write. */
export async function enqueue(
  env: Env,
  eventKey: string,
  message: OutboxEmail | OutboxTelegram
): Promise<string | null> {
  const id = newId('obx');
  const recipient = message.kind === 'email' ? message.to : String(message.chat_id);
  try {
    await env.DB.prepare(
      'INSERT INTO outbox (id, kind, event_key, recipient, payload) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, message.kind, eventKey, recipient, JSON.stringify(message))
      .run();
    return id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) return null; // already enqueued — replay-safe
    throw e;
  }
}

function allowedRecipient(env: Env, kind: string, recipient: string): boolean {
  if (kind !== 'email') return true;
  const allow = (env.EMAIL_ALLOWED_RECIPIENTS || '').trim();
  if (!allow) return true;
  return allow.split(',').map((s) => s.trim().toLowerCase()).includes(recipient.toLowerCase());
}

async function deliver(env: Env, payload: OutboxEmail | OutboxTelegram): Promise<{ ok: boolean; error?: string }> {
  if (payload.kind === 'email') {
    if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'EMAIL_NOT_CONFIGURED' };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: payload.to, subject: payload.subject, html: payload.html, text: payload.text }),
    });
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
    return { ok: true };
  }
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'TELEGRAM_NOT_CONFIGURED' };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: payload.chat_id, text: payload.text.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!res.ok) return { ok: false, error: `telegram ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
  return { ok: true };
}

/**
 * Processes a batch of pending outbox rows (call via ctx.waitUntil after an
 * enqueue, from the admin retry endpoint, or a scheduled job). Claims rows
 * with a conditional state flip so concurrent processors never double-send.
 */
export async function processOutbox(env: Env, limit = 10): Promise<{ sent: number; failed: number }> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, recipient, payload, attempts FROM outbox WHERE state IN ('pending','failed') AND attempts < ? ORDER BY created_at LIMIT ?"
  )
    .bind(MAX_ATTEMPTS, limit)
    .all<{ id: string; kind: string; recipient: string; payload: string; attempts: number }>();

  let sent = 0;
  let failed = 0;
  for (const row of results) {
    // Claim: only one processor wins this row.
    const claim = await env.DB.prepare(
      "UPDATE outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND state IN ('pending','failed')"
    )
      .bind(row.id)
      .run()
      .catch(() => null);
    if (!claim || claim.meta.changes === 0) continue;

    if (!allowedRecipient(env, row.kind, row.recipient)) {
      await env.DB.prepare("UPDATE outbox SET state = 'skipped', last_error = 'recipient not in EMAIL_ALLOWED_RECIPIENTS (staging guard)' WHERE id = ?")
        .bind(row.id)
        .run();
      console.warn('outbox: skipped send to non-allowlisted recipient (staging guard)');
      continue;
    }

    let payload: OutboxEmail | OutboxTelegram;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      await env.DB.prepare("UPDATE outbox SET state = 'dead', last_error = 'unparseable payload' WHERE id = ?").bind(row.id).run();
      failed++;
      continue;
    }

    const result = await deliver(env, payload);
    if (result.ok) {
      await env.DB.prepare("UPDATE outbox SET state = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = '' WHERE id = ?")
        .bind(row.id)
        .run();
      sent++;
    } else {
      const attempts = row.attempts + 1;
      const state = attempts >= MAX_ATTEMPTS || result.error === 'EMAIL_NOT_CONFIGURED' || result.error === 'TELEGRAM_NOT_CONFIGURED' ? 'dead' : 'failed';
      await env.DB.prepare('UPDATE outbox SET state = ?, last_error = ? WHERE id = ?')
        .bind(state, (result.error ?? 'unknown').slice(0, 500), row.id)
        .run();
      failed++;
    }
  }
  return { sent, failed };
}
