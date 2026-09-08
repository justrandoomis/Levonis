/**
 * The audit store's schema, in one place.
 *
 * `migrations/0001_audit_init.sql` is this text verbatim (a test compares them
 * statement by statement), so the DDL and the code that writes against it can
 * never drift — the same discipline `tests/coreEventBus.test.ts` applies to the
 * core's outbox migration. Every statement is `CREATE … IF NOT EXISTS`: the
 * migration is additive and re-runnable, which is what
 * `scripts/check-migrations-additive.mjs` asks of everything from `0055` on.
 *
 * Two tables of our own (`01-TARGET.md` §2.1: Audit owns `audit_events` and
 * `audit_chain_heads`) plus the platform tables every consumer has.
 */
import { processedEventsSchemaSql, idempotencySchemaSql } from '@levonis/platform-kit/idempotency';

export const AUDIT_PREFIX = 'audit';

/**
 * `audit_events` — append-only. Nothing ever updates a row except the sealing
 * pass, which fills `chain_index`/`prev_hash`/`hash`/`alg` once and never again
 * (its UPDATE is conditional on `chain_index IS NULL`), and `detail`, which a
 * producer may supply later for a row whose body did not travel in the envelope
 * (`03-EVENTS.md` §4: `AuditRecorded` carries `detail_hash` + `detail_ref`, not
 * the body). Filling the body cannot alter the chain, because the chain covers
 * `detail_hash`, not `detail` — which is the point: the hash proves the body
 * that was recorded, wherever it is stored.
 *
 * `seq` is AUTOINCREMENT so an id is never reused; `chain_index` is the
 * position in the hash chain, assigned in sealing order (see `chain.ts` for why
 * seal order, not `seq` order, is what verification walks).
 */
export const AUDIT_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  event_id       TEXT NOT NULL UNIQUE,
  event_type     TEXT NOT NULL,
  actor_id       TEXT,
  action         TEXT NOT NULL,
  target         TEXT NOT NULL DEFAULT '',
  detail_hash    TEXT NOT NULL,
  detail_ref     TEXT,
  detail         TEXT,
  source_service TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  chain_index    INTEGER UNIQUE,
  prev_hash      TEXT,
  hash           TEXT,
  alg            TEXT
);`;

/**
 * One row per chain (`main` today; an archive rotation would add others). The
 * head is the fence that makes concurrent sealing safe: a sealer writes the new
 * head only if the old one is still what it read, and a mismatch aborts the
 * whole batch (`chain_index` is NOT NULL and the conditional SET yields NULL).
 * `anchored_*` records the last head written to the R2 `audit-archive/` prefix
 * — the external witness of `01-TARGET.md` row 20; no bucket is bound in
 * Phase 1, so it stays NULL and `verifyChain` reports `anchored_head: null`.
 */
export const AUDIT_CHAIN_HEADS_DDL = `CREATE TABLE IF NOT EXISTS audit_chain_heads (
  chain          TEXT PRIMARY KEY,
  chain_index    INTEGER NOT NULL,
  head_hash      TEXT NOT NULL,
  alg            TEXT NOT NULL,
  sealed_at      TEXT NOT NULL,
  anchored_index INTEGER,
  anchored_hash  TEXT,
  anchored_at    TEXT
);`;

export const AUDIT_INDEXES_DDL = [
  'CREATE INDEX IF NOT EXISTS idx_audit_events_unsealed ON audit_events(seq) WHERE chain_index IS NULL;',
  'CREATE INDEX IF NOT EXISTS idx_audit_events_recorded ON audit_events(recorded_at);',
  'CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id, recorded_at);',
  'CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, recorded_at);',
  'CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target, recorded_at);',
].join('\n');

/** The whole store: our tables, then the platform tables of a consumer. */
export function auditSchemaSql(): string {
  return [
    AUDIT_EVENTS_DDL,
    AUDIT_INDEXES_DDL,
    AUDIT_CHAIN_HEADS_DDL,
    processedEventsSchemaSql(AUDIT_PREFIX),
    idempotencySchemaSql(AUDIT_PREFIX),
  ].join('\n\n');
}
