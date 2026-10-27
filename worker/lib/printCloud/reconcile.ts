/**
 * RECONCILIATION (docs/PRINT_CLOUD.md §11): prove every cache equals the
 * ledger it caches, every lot equals its own draws, every credit hold is
 * recorded on its lot and its reservation alike, every reservation belongs
 * to a live job, every printer and job holds at most one active assignment,
 * every paid order has exactly one confirmed payment, and every gram a
 * customer used left the shelf. It REPORTS inconsistencies with the evidence;
 * it never writes a corrective value, because a correction is a decision with
 * an author.
 *
 * Per lot, not only in total: units moved from one lot's remainder to
 * another's leave every total intact, so each lot is held to the draws that
 * took from it — what was drawn equals the sum of its draws, and their value
 * is exactly the cumulative valuation of lots.ts, round(paid × drawn / total)
 * (`roundedShare`), so never more than was paid for the lot.
 */
import { many } from './db';

/** round(value × qty / total) half up in SQLite integers — lots.ts `drawValue`'s cumulative share (util.ts `mulDivRound`). */
const roundedShare = (value: string, qty: string, total: string) => `(2 * ${value} * ${qty} + ${total}) / (2 * ${total})`;

/** States in which a job is on a machine: an active printer assignment exists exactly for them (queue.ts, jobs.ts). */
const ON_THE_FLOOR = "('preparing', 'printing', 'paused')";

export interface Check {
  name: string;
  ok: boolean;
  issues: Array<Record<string, unknown>>;
}

async function check(name: string, rows: Promise<Array<Record<string, unknown>>>): Promise<Check> {
  const issues = await rows;
  return { name, ok: issues.length === 0, issues: issues.slice(0, 50) };
}

export async function reconcile(db: D1Database): Promise<{ ok: boolean; checks: Check[] }> {
  const checks = await Promise.all([
    check(
      'credit_accounts_equal_ledger',
      many(
        db,
        `SELECT a.id AS account_id, a.available_seconds, a.reserved_seconds, a.consumed_seconds,
                COALESCE(l.av, 0) AS ledger_available, COALESCE(l.re, 0) AS ledger_reserved, COALESCE(l.co, 0) AS ledger_consumed
           FROM pc_credit_accounts a
           LEFT JOIN (SELECT account_id, SUM(delta_available) AS av, SUM(delta_reserved) AS re, SUM(delta_consumed) AS co FROM pc_credit_ledger GROUP BY account_id) l
             ON l.account_id = a.id
          WHERE a.available_seconds <> COALESCE(l.av, 0) OR a.reserved_seconds <> COALESCE(l.re, 0) OR a.consumed_seconds <> COALESCE(l.co, 0)`
      )
    ),
    check(
      // Not only in total: what is available is exactly the lots' free parts,
      // what is reserved exactly the seconds held on them.
      'credit_lots_cover_balance',
      many(
        db,
        `SELECT a.id AS account_id, a.available_seconds, a.reserved_seconds,
                COALESCE(SUM(l.seconds_remaining - l.seconds_held), 0) AS lots_free, COALESCE(SUM(l.seconds_held), 0) AS lots_held
           FROM pc_credit_accounts a LEFT JOIN pc_credit_lots l ON l.account_id = a.id
          GROUP BY a.id HAVING a.available_seconds <> lots_free OR a.reserved_seconds <> lots_held`
      )
    ),
    check(
      'credit_lots_equal_their_draws',
      many(
        db,
        `SELECT l.id AS lot_id, l.account_id, l.seconds_total - l.seconds_remaining AS drawn, COALESCE(SUM(d.seconds), 0) AS draws,
                l.paid_iqd, COALESCE(SUM(d.value_iqd), 0) AS drawn_value
           FROM pc_credit_lots l LEFT JOIN pc_credit_lot_draws d ON d.lot_id = l.id
          GROUP BY l.id
         HAVING drawn <> draws OR drawn_value <> ${roundedShare('l.paid_iqd', 'draws', 'l.seconds_total')}`
      )
    ),
    check(
      // Each active reservation holds exactly what it reserved, on lots of its own account.
      'credit_reservations_equal_their_holds',
      many(
        db,
        `SELECT r.id AS reservation_id, r.job_id, r.seconds_reserved, COALESCE(SUM(h.seconds), 0) AS held,
                COALESCE(SUM(CASE WHEN h.lot_id IS NOT NULL AND l.account_id IS NOT r.account_id THEN 1 ELSE 0 END), 0) AS foreign_lots
           FROM pc_credit_reservations r
           LEFT JOIN pc_credit_reservation_lots h ON h.reservation_id = r.id
           LEFT JOIN pc_credit_lots l ON l.id = h.lot_id
          WHERE r.state = 'active'
          GROUP BY r.id HAVING r.seconds_reserved <> held OR foreign_lots > 0`
      )
    ),
    check(
      // A lot holds exactly the holds of the ACTIVE reservations on it — a
      // settled or released reservation's rows stay, as history — and never
      // more than it has left (ck_pc_credit_lot_held, proven independently).
      'credit_lot_holds_equal_active_reservations',
      many(
        db,
        `SELECT l.id AS lot_id, l.account_id, l.seconds_remaining, l.seconds_held, COALESCE(x.held, 0) AS active_holds
           FROM pc_credit_lots l
           LEFT JOIN (SELECT h.lot_id, SUM(h.seconds) AS held FROM pc_credit_reservation_lots h
                        JOIN pc_credit_reservations r ON r.id = h.reservation_id AND r.state = 'active' GROUP BY h.lot_id) x
             ON x.lot_id = l.id
          WHERE l.seconds_held <> COALESCE(x.held, 0) OR l.seconds_held < 0 OR l.seconds_held > l.seconds_remaining`
      )
    ),
    check(
      'credit_reservations_equal_reserved',
      many(
        db,
        `SELECT a.id AS account_id, a.reserved_seconds, COALESCE(SUM(r.seconds_reserved), 0) AS active_reservations
           FROM pc_credit_accounts a LEFT JOIN pc_credit_reservations r ON r.account_id = a.id AND r.state = 'active'
          GROUP BY a.id HAVING a.reserved_seconds <> active_reservations`
      )
    ),
    check(
      'inventory_accounts_equal_ledger',
      many(
        db,
        `SELECT a.id AS account_id, a.available_qty, a.reserved_qty, a.consumed_qty,
                COALESCE(l.av, 0) AS ledger_available, COALESCE(l.re, 0) AS ledger_reserved, COALESCE(l.co, 0) AS ledger_consumed
           FROM pc_inventory_accounts a
           LEFT JOIN (SELECT account_id, SUM(delta_available) AS av, SUM(delta_reserved) AS re, SUM(delta_consumed) AS co FROM pc_inventory_ledger GROUP BY account_id) l
             ON l.account_id = a.id
          WHERE a.available_qty <> COALESCE(l.av, 0) OR a.reserved_qty <> COALESCE(l.re, 0) OR a.consumed_qty <> COALESCE(l.co, 0)`
      )
    ),
    check(
      'inventory_lots_cover_balance',
      many(
        db,
        `SELECT a.id AS account_id, a.available_qty + a.reserved_qty AS balance, COALESCE(SUM(l.qty_remaining), 0) AS lots_remaining
           FROM pc_inventory_accounts a LEFT JOIN pc_inventory_lots l ON l.account_id = a.id
          GROUP BY a.id HAVING balance <> lots_remaining`
      )
    ),
    check(
      'inventory_lots_equal_their_draws',
      many(
        db,
        `SELECT l.id AS lot_id, l.account_id, l.qty_total - l.qty_remaining AS drawn, COALESCE(SUM(d.qty), 0) AS draws,
                l.paid_iqd, COALESCE(SUM(d.value_iqd), 0) AS drawn_value
           FROM pc_inventory_lots l LEFT JOIN pc_inventory_lot_draws d ON d.lot_id = l.id
          GROUP BY l.id
         HAVING drawn <> draws OR drawn_value <> ${roundedShare('l.paid_iqd', 'draws', 'l.qty_total')}`
      )
    ),
    check(
      'inventory_reservations_equal_reserved',
      many(
        db,
        `SELECT a.id AS account_id, a.reserved_qty, COALESCE(SUM(r.qty_reserved), 0) AS active_reservations
           FROM pc_inventory_accounts a LEFT JOIN pc_inventory_reservations r ON r.account_id = a.id AND r.state = 'active'
          GROUP BY a.id HAVING a.reserved_qty <> active_reservations`
      )
    ),
    check(
      'warehouse_positions_equal_ledger',
      many(
        db,
        `SELECT p.variant_id, p.on_hand_qty, p.reserved_qty, p.allocated_qty, COALESCE(l.oh, 0) AS ledger_on_hand, COALESCE(l.re, 0) AS ledger_reserved,
                COALESCE(l.al, 0) AS ledger_allocated
           FROM pc_stock_positions p
           LEFT JOIN (SELECT variant_id, SUM(delta_on_hand) AS oh, SUM(delta_reserved) AS re, SUM(delta_allocated) AS al FROM pc_warehouse_ledger GROUP BY variant_id) l
             ON l.variant_id = p.variant_id
          WHERE p.on_hand_qty <> COALESCE(l.oh, 0) OR p.reserved_qty <> COALESCE(l.re, 0) OR p.allocated_qty <> COALESCE(l.al, 0)`
      )
    ),
    check(
      'warehouse_lots_equal_on_hand',
      many(
        db,
        `SELECT p.variant_id, p.on_hand_qty, COALESCE(SUM(l.on_hand_qty), 0) AS lots_on_hand
           FROM pc_stock_positions p LEFT JOIN pc_stock_lots l ON l.variant_id = p.variant_id
          GROUP BY p.variant_id HAVING p.on_hand_qty <> lots_on_hand`
      )
    ),
    check(
      // A stock lot's draws at a known cost are valued after the ones taken
      // while its cost was pending (cost 0): together, the lot's cumulative
      // share of what was drawn less the share of the pending prefix.
      'stock_lots_equal_their_draws',
      many(
        db,
        `SELECT l.id AS lot_id, l.variant_id, l.received_qty - l.on_hand_qty AS drawn, COALESCE(SUM(d.qty), 0) AS draws,
                COALESCE(SUM(CASE WHEN d.cost_known = 0 THEN d.qty ELSE 0 END), 0) AS draws_cost_pending,
                l.cost_known, COALESCE(SUM(d.cost_iqd), 0) AS drawn_cost
           FROM pc_stock_lots l LEFT JOIN pc_stock_lot_draws d ON d.lot_id = l.id
          GROUP BY l.id
         HAVING drawn <> draws
             OR (l.cost_known = 0 AND draws_cost_pending <> draws)
             OR drawn_cost <> ${roundedShare('l.total_cost_iqd', 'draws', 'l.received_qty')} - ${roundedShare('l.total_cost_iqd', 'draws_cost_pending', 'l.received_qty')}`
      )
    ),
    check(
      'allocations_equal_customer_ownership',
      many(
        db,
        `SELECT p.variant_id, p.allocated_qty, COALESCE(c.owned, 0) AS customers_own
           FROM pc_stock_positions p
           LEFT JOIN (SELECT variant_id, SUM(available_qty + reserved_qty) AS owned FROM pc_inventory_accounts GROUP BY variant_id) c ON c.variant_id = p.variant_id
          WHERE p.allocated_qty <> COALESCE(c.owned, 0)`
      )
    ),
    check(
      'order_holds_equal_reserved_stock',
      many(
        db,
        `SELECT p.variant_id, p.reserved_qty, COALESCE(SUM(h.qty), 0) AS active_holds
           FROM pc_stock_positions p LEFT JOIN pc_stock_holds h ON h.variant_id = p.variant_id AND h.state = 'active'
          GROUP BY p.variant_id HAVING p.reserved_qty <> active_holds`
      )
    ),
    check(
      'no_stock_deficit',
      many(
        db,
        'SELECT variant_id, on_hand_qty, reserved_qty, allocated_qty FROM pc_stock_positions WHERE reserved_qty + allocated_qty > on_hand_qty'
      )
    ),
    check(
      'reservations_belong_to_live_jobs',
      many(
        db,
        `SELECT 'credits' AS kind, r.id AS reservation_id, r.job_id, j.status FROM pc_credit_reservations r LEFT JOIN pc_print_jobs j ON j.id = r.job_id
          WHERE r.state = 'active' AND (j.id IS NULL OR j.status NOT IN ('confirmed', 'queued', 'preparing', 'printing', 'paused', 'failed'))
         UNION ALL
         SELECT 'inventory', r.id, r.ref_id, j.status FROM pc_inventory_reservations r LEFT JOIN pc_print_jobs j ON j.id = r.ref_id
          WHERE r.purpose = 'print_job' AND r.state = 'active' AND (j.id IS NULL OR j.status NOT IN ('confirmed', 'queued', 'preparing', 'printing', 'paused', 'failed'))`
      )
    ),
    check(
      'reserved_jobs_hold_their_credits',
      many(
        db,
        `SELECT j.id AS job_id, j.status FROM pc_print_jobs j
          WHERE j.status IN ('confirmed', 'queued', 'preparing', 'printing', 'paused')
            AND NOT EXISTS (SELECT 1 FROM pc_credit_reservations r WHERE r.job_id = j.id AND r.state = 'active')`
      )
    ),
    check(
      // The partial unique indexes refuse a second one; this proves it independently of them.
      'one_active_assignment_per_printer_and_job',
      many(
        db,
        `SELECT 'printer' AS kind, printer_id AS ref_id, COUNT(*) AS active FROM pc_printer_assignments WHERE state = 'active' GROUP BY printer_id HAVING COUNT(*) > 1
         UNION ALL
         SELECT 'job', job_id, COUNT(*) FROM pc_printer_assignments WHERE state = 'active' GROUP BY job_id HAVING COUNT(*) > 1`
      )
    ),
    check(
      'active_assignments_match_jobs_on_the_floor',
      many(
        db,
        `SELECT 'assignment_without_job_on_the_floor' AS kind, a.job_id, a.printer_id, j.status FROM pc_printer_assignments a LEFT JOIN pc_print_jobs j ON j.id = a.job_id
          WHERE a.state = 'active' AND (j.id IS NULL OR j.status NOT IN ${ON_THE_FLOOR})
         UNION ALL
         SELECT 'job_on_the_floor_without_assignment', j.id, NULL, j.status FROM pc_print_jobs j
          WHERE j.status IN ${ON_THE_FLOOR} AND NOT EXISTS (SELECT 1 FROM pc_printer_assignments a WHERE a.job_id = j.id AND a.state = 'active')`
      )
    ),
    check(
      'fulfilled_orders_have_one_confirmed_payment',
      many(
        db,
        `SELECT o.id AS order_id, o.status, (SELECT COUNT(*) FROM pc_payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS confirmed
           FROM pc_orders o
          WHERE (o.status IN ('fulfilled', 'partially_refunded', 'refunded') AND (SELECT COUNT(*) FROM pc_payments p WHERE p.order_id = o.id AND p.status = 'confirmed') <> 1)
             OR (o.status IN ('awaiting_payment', 'cancelled', 'expired') AND EXISTS (SELECT 1 FROM pc_payments p WHERE p.order_id = o.id AND p.status = 'confirmed'))`
      )
    ),
    check(
      'payments_needing_refund',
      many(
        db,
        "SELECT provider, provider_event_id, order_id, amount_iqd, outcome, received_at FROM pc_payment_events WHERE outcome IN ('duplicate_order', 'order_not_payable', 'amount_mismatch', 'unknown_order')"
      )
    ),
    check(
      'customer_usage_left_the_shelf',
      many(
        db,
        `SELECT u.job_id, u.variant_id, u.billed, COALESCE(w.removed, 0) AS removed_from_allocation
           FROM (SELECT r.ref_id AS job_id, r.variant_id, SUM(l.delta_consumed) AS billed FROM pc_inventory_ledger l
                   JOIN pc_inventory_reservations r ON r.id = l.reservation_id
                  WHERE l.entry_type = 'consume' AND r.purpose = 'print_job' GROUP BY r.ref_id, r.variant_id) u
           LEFT JOIN (SELECT ref_id AS job_id, variant_id, -SUM(delta_allocated) AS removed FROM pc_warehouse_ledger
                       WHERE entry_type = 'consume_customer' GROUP BY ref_id, variant_id) w ON w.job_id = u.job_id AND w.variant_id = u.variant_id
          WHERE u.billed <> COALESCE(w.removed, 0)`
      )
    ),
  ]);
  return { ok: checks.every((c) => c.ok), checks };
}
