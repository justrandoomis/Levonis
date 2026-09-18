/**
 * PROOF OF A DESTINATION, HELD WHILE SOMEBODY TYPES THEIR NAME.
 *
 * A six-digit code proves one thing — that the person is holding the phone or
 * reading the mailbox — and `auth_otp` consumes it the instant it does, because
 * single use is what a code is for. But creating an account needs more than the
 * proof: it needs a name, maybe a handle, maybe a password, and a person typing
 * those takes longer than a code should live.
 *
 * So the proof is exchanged for a ticket. Fifteen minutes, one use, and it
 * authorises EXACTLY ONE THING: creating one account on the one destination it
 * names. It is not a session and must never become one:
 *
 *   * it carries no user id, because no user exists yet;
 *   * it is consumed by the INSERT that creates the account, inside the same
 *     batch and guarded by `consumed_at IS NULL`, so two submissions racing
 *     cannot both make an account;
 *   * the destination is read from the TICKET, never from the request body —
 *     otherwise a ticket earned on one number would create an account on
 *     another, which is the whole attack this shape exists to prevent.
 *
 * The token itself is never stored, only its SHA-256. A stored token is an
 * account for whoever can read the table.
 */

import { newId, randomToken, sha256Hex } from './crypto';
import type { Env } from './types';

export const SIGNUP_TICKET_TTL_SECONDS = 15 * 60;

export type SignupTicketChannel = 'email' | 'whatsapp';

export interface IssuedTicket {
  token: string;
  expires_in_seconds: number;
}

/** Issue a ticket for a destination whose ownership was JUST proven. */
export async function issueSignupTicket(
  env: Env,
  channel: SignupTicketChannel,
  destination: string
): Promise<IssuedTicket> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SIGNUP_TICKET_TTL_SECONDS * 1000).toISOString();
  await env.DB.batch([
    // One live ticket per destination. A second `start → verify` supersedes
    // the first rather than leaving two roads to the same account.
    env.DB.prepare(
      "UPDATE signup_tickets SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE destination = ? AND consumed_at IS NULL"
    ).bind(destination),
    env.DB.prepare(
      'INSERT INTO signup_tickets (id, token_hash, channel, destination, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(newId('sgt'), await sha256Hex(token), channel, destination, expiresAt),
  ]);
  return { token, expires_in_seconds: SIGNUP_TICKET_TTL_SECONDS };
}

export interface LiveTicket {
  id: string;
  channel: SignupTicketChannel;
  destination: string;
}

/**
 * The live ticket this token names, or null.
 *
 * Reading it does NOT consume it: consumption belongs in the same batch as the
 * account insert, so a validation failure after this point (a taken username,
 * a rejected password) does not cost the person their proof and send them back
 * to the start of the flow.
 */
export async function findSignupTicket(env: Env, token: string): Promise<LiveTicket | null> {
  const hash = await sha256Hex(String(token ?? ''));
  const row = await env.DB.prepare(
    `SELECT id, channel, destination FROM signup_tickets
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
  )
    .bind(hash, new Date().toISOString())
    .first<{ id: string; channel: string; destination: string }>();
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel === 'email' ? 'email' : 'whatsapp',
    destination: row.destination,
  };
}

/**
 * The statement that spends a ticket. Returned rather than run, so the caller
 * puts it in the SAME batch as the account insert — a ticket consumed in a
 * separate write is a ticket that can be spent twice when the second write
 * fails, or wasted when the first one does.
 */
export function consumeTicketStatement(env: Env, ticketId: string): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE signup_tickets SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
  ).bind(ticketId);
}
