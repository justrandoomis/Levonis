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
 *  event was already enqueued. Call inside/next to the business write.
 *  `opts.state: 'skipped'` records the event honestly WITHOUT sending (e.g.
 *  invoice email for an unverified recipient address) — the row documents
 *  why in last_error and is never picked up by processOutbox. */
export async function enqueue(
  env: Env,
  eventKey: string,
  message: OutboxEmail | OutboxTelegram,
  opts: { state?: 'pending' | 'skipped'; note?: string } = {}
): Promise<string | null> {
  const id = newId('obx');
  const recipient = message.kind === 'email' ? message.to : String(message.chat_id);
  const state = opts.state ?? 'pending';
  try {
    await env.DB.prepare(
      'INSERT INTO outbox (id, kind, event_key, recipient, payload, state, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, message.kind, eventKey, recipient, JSON.stringify(message), state, (opts.note ?? '').slice(0, 500))
      .run();
    return id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) return null; // already enqueued — replay-safe
    throw e;
  }
}

/**
 * The staging guard. An empty allowlist normally means "everyone" — the live
 * Worker has to be able to mail real customers — but a deployment that must
 * NOT reach a real address (the dark core) sets `EMAIL_ALLOWLIST_REQUIRED=on`,
 * which flips the empty case to "nobody". Without that flip the dark config's
 * own comment ("must never be able to mail a real address") was the opposite
 * of what an empty var did.
 */
function allowedRecipient(env: Env, kind: string, recipient: string): boolean {
  if (kind !== 'email') return true;
  const allow = (env.EMAIL_ALLOWED_RECIPIENTS || '').trim();
  if (!allow) return (env.EMAIL_ALLOWLIST_REQUIRED || '').trim().toLowerCase() !== 'on';
  return allow.split(',').map((s) => s.trim().toLowerCase()).includes(recipient.toLowerCase());
}

async function deliver(env: Env, payload: OutboxEmail | OutboxTelegram, eventKey: string): Promise<{ ok: boolean; error?: string }> {
  if (payload.kind === 'email') {
    if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'EMAIL_NOT_CONFIGURED' };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    };
    // Provider-side dedup: retries of the same business event reuse the same
    // Idempotency-Key (the unique event_key), so an ambiguous first attempt
    // (timeout after the provider accepted) cannot double-send.
    if (eventKey) headers['Idempotency-Key'] = eventKey.slice(0, 256);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
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
    "SELECT id, kind, event_key, recipient, payload, attempts FROM outbox WHERE state IN ('pending','failed') AND attempts < ? ORDER BY created_at LIMIT ?"
  )
    .bind(MAX_ATTEMPTS, limit)
    .all<{ id: string; kind: string; event_key: string; recipient: string; payload: string; attempts: number }>();

  let sent = 0;
  let failed = 0;
  for (const row of results) {
    // Claim: compare-and-swap on attempts — only one processor wins this row.
    // (The state CHECK constraint has no transient 'sending' value, so the
    // claim is the attempts bump itself; a crash mid-send leaves the row
    // 'pending' with the attempt consumed, retried by the next run.)
    const claim = await env.DB.prepare(
      "UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND state IN ('pending','failed') AND attempts = ?"
    )
      .bind(row.id, row.attempts)
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

    const result = await deliver(env, payload, row.event_key);
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
