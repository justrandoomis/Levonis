/**
 * WHO MAY DO WHAT ON THIS CONSOLE — the server's hints, read fail-closed.
 *
 * The roles are the platform's (worker/lib/adminScope.ts), applied by
 * worker/routes/printCloudAdmin.ts per route and, on the mixed doors, per
 * field:
 *
 *   any admin (the workshop operator)   jobs, queue, printers, stock counts,
 *                                       shipments, estimates, tasks
 *   money  (`can_move_money`)           prices, payments, refunds, balance
 *                                       adjustments, buybacks, agent tokens,
 *                                       revenue, reconciliation, audit
 *   cost   (`can_view_cost`/`_write`)   what the workshop paid; profit
 *
 * Each hint is compared with `=== true` (tests/costClientHints.test.ts's
 * rule): a session payload without the flag HIDES the control. The server
 * refuses regardless; this only keeps the screen from offering what it would
 * refuse — and keeps a cost column from being drawn at all for a reader who
 * may not see it (the server already strips the values).
 */
import { useAuth } from '../../AuthContext';

export interface PcAccess {
  /** Owner or full admin. */
  money: boolean;
  /** The owner: cost and profit may be read. */
  costRead: boolean;
  /** The owner: cost may be written. */
  costWrite: boolean;
  /** The main admin — the one who opens or closes the service. */
  owner: boolean;
}

export function usePcAccess(): PcAccess {
  const { user } = useAuth();
  return {
    money: user?.can_move_money === true,
    costRead: user?.can_view_cost === true,
    costWrite: user?.can_write_cost === true,
    owner: user?.is_owner === true,
  };
}
