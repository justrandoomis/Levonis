/**
 * WRITE «LEGACY» ROWS INTO THE OLD `merchant_payout_ledger` IN A TEST.
 *
 * Migration 0134 sealed the old table (inserts and updates RAISE) and dropped
 * 0121's deploy-window mirror. Tests that stand for a database whose history
 * predates the append-only ledger still need such rows — carried into
 * `merchant_ledger_entries` exactly as 0121's backfill/mirror carried them. This
 * runs `sql` with 0121's mirror triggers put back and 0134's seal lifted, then
 * restores the database as 0134 left it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './d1';

const M0121 = readFileSync(join(ROOT, 'migrations/0121_merchant_ledger.sql'), 'utf8');
const MIRROR = M0121.slice(M0121.indexOf('CREATE TRIGGER IF NOT EXISTS trg_mpl_mirror_insert'));
const M0134 = readFileSync(join(ROOT, 'migrations/0134_review_w25_confidential_estimate_old_ledger.sql'), 'utf8');
const SEAL = M0134.slice(M0134.indexOf('CREATE TRIGGER IF NOT EXISTS trg_mpl_no_insert'));

export function legacyLedgerWrite(raw: DatabaseSync, sql: string): void {
  raw.exec('DROP TRIGGER IF EXISTS trg_mpl_no_insert; DROP TRIGGER IF EXISTS trg_mpl_no_update;');
  raw.exec(MIRROR);
  try {
    raw.exec(sql);
  } finally {
    raw.exec('DROP TRIGGER IF EXISTS trg_mpl_mirror_insert; DROP TRIGGER IF EXISTS trg_mpl_mirror_update;');
    raw.exec(SEAL);
  }
}
