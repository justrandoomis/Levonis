import type { Env } from './types';
import { getBalances } from './wallet';

/**
 * Wallet availability with holds (integrated mandate §11) — contract stub.
 *
 * The wallet slice replaces the internals with the full ledger/hold model
 * (available vs held vs pending); the exported signature is frozen because
 * checkout and the points engine consult it before spending. Until the hold
 * table exists this returns the settled balances unchanged, which is exactly
 * the current behavior (no holds exist yet, so nothing is overstated).
 */
export interface AvailableBalances {
  /** Spendable wallet money (settled minus active holds), USD cents. */
  usd_cents_available: number;
  /** Redeemable points (released accruals minus active reservations). */
  points_available: number;
}

export async function getAvailableBalances(env: Env, userId: string): Promise<AvailableBalances> {
  const b = await getBalances(env.DB, userId);
  return { usd_cents_available: b.usd_cents, points_available: b.points };
}
