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
import { clearSessionOutage, recordSessionOutage } from './channelReadiness';
import { emailConfigured, emailAllowsRecipient, sendEmailNow } from './emailSend';
import { telegramCanDeliver } from './telegram';
import { sendWhatsAppText, wasenderConfigured, whatsappErrorIsRetryable } from './wasender';

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
/**
 * WhatsApp, through WasenderAPI (migration 0087). Queued rather than sent
 * directly because the provider's send ceiling is as low as one message per
 * five seconds: a burst of order notifications is a 429, and a 429 here is a
 * retry instead of a lost message. `to` is E.164 and the transport refuses
 * anything else — the provider's `to` field also accepts group JIDs.
 */
export interface OutboxWhatsApp {
  kind: 'whatsapp';
  to: string;
  text: string;
}

export type OutboxMessage = OutboxEmail | OutboxTelegram | OutboxWhatsApp;

const MAX_ATTEMPTS = 5;

/** Enqueue (idempotent on eventKey). Returns the outbox id or null when the
 *  event was already enqueued. Call inside/next to the business write.
 *  `opts.state: 'skipped'` records the event honestly WITHOUT sending (e.g.
 *  invoice email for an unverified recipient address) — the row documents
 *  why in last_error and is never picked up by processOutbox. */
export async function enqueue(
  env: Env,
  eventKey: string,
  message: OutboxMessage,
  opts: { state?: 'pending' | 'skipped'; note?: string } = {}
): Promise<string | null> {
  const id = newId('obx');
  const recipient =
    message.kind === 'email' || message.kind === 'whatsapp' ? message.to : String(message.chat_id);
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
 * The same enqueue, as a STATEMENT the caller batches — and the reason it is
 * `ON CONFLICT DO NOTHING` rather than a plain INSERT.
 *
 * A sweep that notifies a customer has three writes that belong together: the
 * outbox rows, the in-app row, and the state flip that stops the next tick
 * doing it all again. `db.batch` is one transaction, which is exactly what
 * makes them safe — and exactly what breaks `enqueue()` above.
 *
 * `enqueue()`'s replay-safety is a try/catch around `.run()` that inspects the
 * error message for 'UNIQUE'. INSIDE a batch there is no such catch: a
 * collision on the unique `event_key` aborts the WHOLE batch, rolling back the
 * notification AND the state flip. The next sweep then builds the identical
 * batch, hits the identical collision, and fails identically — for ever. The
 * atomicity would destroy the idempotency it was added to protect.
 *
 * So the conflict is handled by the DATABASE, in the statement: a replay is a
 * zero-row no-op that leaves the rest of the batch to commit. `meta.changes`
 * on the result tells the caller whether this particular row was new.
 */
export interface OutboxStatement {
  id: string;
  event_key: string;
  stmt: D1PreparedStatement;
}

export function enqueueStatement(
  db: D1Database,
  eventKey: string,
  message: OutboxMessage,
  opts: { state?: 'pending' | 'skipped'; note?: string } = {}
): OutboxStatement {
  const id = newId('obx');
  const recipient =
    message.kind === 'email' || message.kind === 'whatsapp' ? message.to : String(message.chat_id);
  const stmt = db
    .prepare(
      `INSERT INTO outbox (id, kind, event_key, recipient, payload, state, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`
    )
    .bind(
      id,
      message.kind,
      eventKey,
      recipient,
      JSON.stringify(message),
      opts.state ?? 'pending',
      (opts.note ?? '').slice(0, 500)
    );
  return { id, event_key: eventKey, stmt };
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
  return emailAllowsRecipient(env, recipient);
}

/**
 * A 403 FROM sendMessage IS THE END OF A BINDING, NOT A BAD MINUTE.
 *
 * Telegram answers 403 "Forbidden: bot was blocked by the user" (also "user is
 * deactivated", "bot was kicked") when the recipient has ended the
 * conversation. Nothing about that changes in five minutes, and the old code
 * returned the bare string `telegram <status>`, which the terminal test in
 * processOutbox never matched: the row burned all five attempts and landed
 * dead with nothing anywhere recording that the binding is gone. The shopper
 * went on being told "we will message you on Telegram" for ever.
 *
 * So 403 is TERMINAL the way a WhatsApp REJECTED already is, and it REVOKES
 * the link (below) — which is what finally gives readiness a falsifiable
 * column to read instead of the constant-true `revoked_at IS NULL` filter that
 * six queries have been applying to a column nothing ever wrote.
 *
 * 400 is terminal too (a malformed payload does not improve on retry) but only
 * revokes when the description says the CHAT is gone rather than the message.
 * 429 and 5xx stay retryable: those are the outages the outbox exists for.
 */
function classifyTelegramFailure(status: number, body: string): { terminal: boolean; revoke: boolean } {
  const lowered = body.toLowerCase();
  if (status === 403) return { terminal: true, revoke: true };
  if (status === 400) {
    const gone =
      lowered.includes('chat not found') ||
      lowered.includes('user is deactivated') ||
      lowered.includes('peer_id_invalid');
    return { terminal: true, revoke: gone };
  }
  return { terminal: false, revoke: false };
}

/**
 * Write the column six queries already read.
 *
 * CONSEQUENCE, STATED ON PURPOSE: a revoked link also stops Telegram OTP
 * sign-in for that account (`sendOtp` filters on `revoked_at IS NULL`). That
 * is the honest outcome, not a regression — a bot the user has blocked cannot
 * deliver a code either, and today that path fails at SEND_FAILED after
 * pretending it might work. Re-linking clears it: `/api/telegram/link/confirm`
 * upserts with `revoked_at = NULL`.
 *
 * Keyed on chat_id because that is what the outbox payload carries, and never
 * throws: this is bookkeeping beside a delivery that has already failed.
 */
async function revokeTelegramBinding(env: Env, chatId: number | string, reason: string): Promise<void> {
  const id = typeof chatId === 'number' ? chatId : Number(String(chatId).trim());
  // chat_id is INTEGER in SQLite; binding a non-numeric string would silently
  // match nothing and look like a successful revoke.
  if (!Number.isFinite(id)) return;
  try {
    const res = await env.DB.prepare(
      `UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE chat_id = ? AND revoked_at IS NULL`
    )
      .bind(id)
      .run();
    if ((res.meta.changes ?? 0) > 0) {
      // No chat id in the log line — it identifies a person.
      console.warn(`outbox: telegram binding revoked after ${reason}`);
    }
  } catch (e) {
    console.error('outbox: telegram revoke failed:', e instanceof Error ? e.message : String(e));
  }
}

async function deliver(env: Env, payload: OutboxMessage, eventKey: string): Promise<{ ok: boolean; error?: string }> {
  if (payload.kind === 'email') {
    if (!emailConfigured(env)) return { ok: false, error: 'EMAIL_NOT_CONFIGURED' };
    // Provider-side dedup: retries of the same business event reuse the same
    // Idempotency-Key (the unique event_key), so an ambiguous first attempt
    // (timeout after the provider accepted) cannot double-send — which is
    // also what makes retrying this path safe at all.
    const ok = await sendEmailNow(env, payload.to, payload.subject, payload.html, payload.text, {
      idempotencyKey: eventKey || undefined,
    });
    return ok ? { ok: true } : { ok: false, error: 'resend send failed' };
  }
  if (payload.kind === 'whatsapp') {
    if (!wasenderConfigured(env)) return { ok: false, error: 'WHATSAPP_NOT_CONFIGURED' };
    const sent = await sendWhatsAppText(env, payload.to, payload.text);
    if (sent.ok) {
      // A message the shop's phone actually sent is the strongest available
      // proof that the session is linked RIGHT NOW — stronger than the status
      // endpoint and free. Clearing here instead of waiting for a probe is
      // what stops WhatsApp staying hidden from every shopper for up to a
      // full cron period after an operator reconnects the phone.
      await clearSessionOutage(env);
      return { ok: true };
    }
    if (sent.error === 'SESSION_NOT_CONNECTED' || sent.error === 'UNAUTHORIZED') {
      // The API key is valid and the account is still logged out (or the
      // subscription lapsed). Only the provider can tell us this, and this is
      // the one place in the system it says so without us paying for a probe,
      // so the answer is cached for readiness to read on a shopper request.
      await recordSessionOutage(env, sent.error);
    }
    // A terminal failure (a number that is not on WhatsApp, a malformed
    // payload) must not burn four more attempts and four more rate-limit
    // slots — the prefix is what processOutbox reads to kill the row.
    const prefix = whatsappErrorIsRetryable(sent.error) ? '' : 'TERMINAL ';
    return { ok: false, error: `${prefix}whatsapp ${sent.error}${sent.detail ? `: ${sent.detail}` : ''}` };
  }
  // ONE definition of "Telegram can deliver", shared with readiness and with
  // the activation gate — see lib/telegram.ts. The bare `!env.TELEGRAM_BOT_TOKEN`
  // that used to be here was the third of five disagreeing opinions.
  if (!telegramCanDeliver(env)) return { ok: false, error: 'TELEGRAM_NOT_CONFIGURED' };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: payload.chat_id, text: payload.text.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (res.ok) return { ok: true };

  const body = (await res.text().catch(() => '')).slice(0, 200);
  const { terminal, revoke } = classifyTelegramFailure(res.status, body);
  if (revoke) await revokeTelegramBinding(env, payload.chat_id, `telegram ${res.status}`);
  // The 'TERMINAL ' prefix is the same contract WhatsApp already uses, and the
  // same one processOutbox reads to kill the row instead of retrying a
  // conversation that no longer exists.
  return { ok: false, error: `${terminal ? 'TERMINAL ' : ''}telegram ${res.status}: ${body}` };
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

    let payload: OutboxMessage;
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
      const err = result.error ?? '';
      // Dead, not failed, when retrying provably cannot help: the channel is
      // unconfigured, or the provider rejected this exact payload.
      const terminal =
        err === 'EMAIL_NOT_CONFIGURED' ||
        err === 'TELEGRAM_NOT_CONFIGURED' ||
        err === 'WHATSAPP_NOT_CONFIGURED' ||
        err.startsWith('TERMINAL ');
      const state = attempts >= MAX_ATTEMPTS || terminal ? 'dead' : 'failed';
      await env.DB.prepare('UPDATE outbox SET state = ?, last_error = ? WHERE id = ?')
        .bind(state, (result.error ?? 'unknown').slice(0, 500), row.id)
        .run();
      failed++;
    }
  }
  return { sent, failed };
}
