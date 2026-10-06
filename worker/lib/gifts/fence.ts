/**
 * THE LOST-RACE FENCE for a gift write (docs/GIFTS_QUICK_BUY.md §1.2).
 *
 * Every gift transition is ONE conditional UPDATE (or INSERT … SELECT … WHERE)
 * whose WHERE carries its precondition. A conditional statement that matches
 * nothing does not fail a batch, so on its own it would let the rest of the
 * batch — the audit row, the notice, the cart line — commit for a write that
 * never happened. Placed IMMEDIATELY after that statement, this pair rolls the
 * whole batch back unless it changed exactly one row: `ops_guards.ok` is
 * CHECK(ok = 1) (migration 0162), and `changes()` reads the statement just
 * completed on this connection, which is the D1 batch's own transaction.
 */
import { newId } from '../crypto';

export function changedExactlyOne(db: D1Database): D1PreparedStatement[] {
  const id = newId('guard');
  return [
    db.prepare('INSERT INTO ops_guards (id, ok) SELECT ?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END').bind(id),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(id),
  ];
}

/**
 * A failed batch whose cause was the fence: the race was lost and nothing was
 * written. SQLite names an unnamed CHECK by its expression —
 * `CHECK constraint failed: ok=1` — and `ok=1` is ops_guards' own (0162), the
 * only CHECK of that text in the schema.
 */
export function isLostRace(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /CHECK constraint failed: (?:ok ?= ?1\b|ops_guards)/.test(msg);
}
