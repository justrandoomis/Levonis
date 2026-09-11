/**
 * Farm Coin ledger statements.
 *
 * The balance is SUM(amount); it is never stored. Every movement is one row
 * with an idempotency key UNIQUE per user, and a debit that would overdraw is
 * refused by the database trigger ('FARM_INSUFFICIENT_COINS'), which aborts
 * the whole batch it travels in.
 *
 * IDS ARE DETERMINISTIC PER EVENT. Every business movement carries an id that
 * names the event, not the request — `fl_payout_<jobId>`, `fl_energy_<asg>`,
 * `fl_sale_<printerId>`, `fl_maint_<printerId>_<revision>`,
 * `fl_cancelpen_<jobId>` — so an accidental double (two resolutions, a
 * request that slipped past a stale read) collides on the primary key and its
 * whole batch rolls back. Purchases derive their id from the request's key
 * (`requestLedgerId`): the spool or printer they create is the event.
 *
 * TWO KEY NAMESPACES. The UNIQUE (user_id, idempotency_key) column stores
 * client keys as `req:<key>` and server rows as `sys:<ledger id>`. Before
 * this split a player could spend `fl_energy_<assignment>` as their own key
 * and the resolver's electricity row would never land — the print never
 * finished. The route additionally refuses keys that look like server ids.
 *
 * Statements are DATA ({ sql, params }); the route binds them.
 */

import { sha256Hex } from '../crypto';
import type { LedgerKind, SqlStatement } from './types';

/** The idempotency_key a client-keyed row stores. */
export function clientLedgerKey(idempotencyKey: string): string {
  return `req:${idempotencyKey}`;
}

/** The idempotency_key a server-generated row stores: its own deterministic id. */
export function systemLedgerKey(ledgerId: string): string {
  return `sys:${ledgerId}`;
}

/**
 * A client key may not impersonate a server key. Refused: anything with a
 * namespace separator, and the two server prefixes. Returns the reason or null.
 */
export function clientKeyProblem(key: string): string | null {
  if (key.includes(':')) return 'idempotencyKey must not contain ":"';
  if (key.startsWith('fl_')) return 'idempotencyKey must not start with "fl_"';
  if (key.startsWith('sys')) return 'idempotencyKey must not start with "sys"';
  return null;
}

export const LEDGER_KINDS: readonly LedgerKind[] = [
  'starter', 'job_payout', 'filament_purchase', 'printer_purchase', 'printer_sale',
  'maintenance', 'repair', 'electricity', 'penalty', 'refund', 'admin_grant', 'admin_adjust',
] as const;

export interface LedgerInsert {
  id: string;
  userId: string;
  kind: LedgerKind;
  /** Signed, never 0. */
  amount: number;
  refType: string;
  refId: string;
  idempotencyKey: string;
  note: string;
  createdAt: string;
}

export const BALANCE_SQL = 'SELECT COALESCE(SUM(amount), 0) AS balance FROM farm_ledger WHERE user_id = ?';

export function ledgerInsertStatement(row: LedgerInsert): SqlStatement {
  if (!Number.isInteger(row.amount) || row.amount === 0) {
    throw new Error(`ledger amount must be a non-zero integer (got ${row.amount})`);
  }
  return {
    sql: `INSERT INTO farm_ledger (id, user_id, kind, amount, ref_type, ref_id, idempotency_key, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [row.id, row.userId, row.kind, row.amount, row.refType, row.refId, row.idempotencyKey, row.note.slice(0, 200), row.createdAt],
  };
}

/** A deterministic id for a business event (payout of a job, energy of a batch). */
export function eventLedgerId(kind: string, ref: string): string {
  return `fl_${kind}_${ref}`.slice(0, 120);
}

/** A deterministic id for a player-triggered movement, from the request's key. */
export async function requestLedgerId(userId: string, idempotencyKey: string): Promise<string> {
  return `fl_${(await sha256Hex(`${userId}:${idempotencyKey}`)).slice(0, 24)}`;
}

/** The trigger's stable message — the route maps it to 400 INSUFFICIENT_COINS. */
export function isInsufficientCoins(message: string): boolean {
  return message.includes('FARM_INSUFFICIENT_COINS');
}

/** A replay: the same (user, key) or the same deterministic id already landed. */
export function isLedgerReplay(message: string): boolean {
  return (
    (message.includes('UNIQUE constraint failed') && message.includes('farm_ledger')) ||
    (message.includes('PRIMARY KEY') && message.includes('farm_ledger'))
  );
}

/** Finds the row a (user, client idempotency key) pair already produced — the replay check before writing. */
export function findByKeyStatement(userId: string, idempotencyKey: string): SqlStatement {
  return {
    sql: 'SELECT id, kind, amount, ref_type, ref_id FROM farm_ledger WHERE user_id = ? AND idempotency_key = ?',
    params: [userId, clientLedgerKey(idempotencyKey)],
  };
}
