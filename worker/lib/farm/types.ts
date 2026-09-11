/**
 * Row shapes of the farm_* tables (migration 0053) and the in-memory state the
 * engine resolves. Pure types — the route loads rows, the engine reads them.
 */

export type PrinterState = 'idle' | 'printing' | 'done' | 'maintenance' | 'broken';
export type JobState =
  | 'offered' | 'accepted' | 'printing' | 'ready' | 'delivered' | 'late' | 'cancelled' | 'rejected' | 'expired';
export type AssignmentState = 'queued' | 'printing' | 'done' | 'failed' | 'collected' | 'cancelled';
export type FarmEventKind =
  | 'print_done' | 'print_failed' | 'printer_broken' | 'job_ready' | 'job_late' | 'job_cancelled_by_customer'
  | 'offer_expired' | 'maintenance_done' | 'repair_done' | 'level_up';
export type LedgerKind =
  | 'starter' | 'job_payout' | 'filament_purchase' | 'printer_purchase' | 'printer_sale'
  | 'maintenance' | 'repair' | 'electricity' | 'penalty' | 'refund' | 'admin_grant' | 'admin_adjust';

/** Job states a player still holds (everything but the closed ones). */
export const LIVE_JOB_STATES: readonly JobState[] = ['offered', 'accepted', 'printing', 'ready', 'late'] as const;
/** Accepted-and-not-closed: the states a deadline can still bite. */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['accepted', 'printing', 'ready', 'late'] as const;
/** Assignments that still occupy a printer or hold reserved grams. */
export const LIVE_ASSIGNMENT_STATES: readonly AssignmentState[] = ['queued', 'printing', 'done', 'failed'] as const;

/** A job whose every part was handed over but whose payout waits for a later day (0054). */
export function isPayoutDeferred(job: Pick<FarmJobRow, 'payout_deferred_day'>): boolean {
  return typeof job.payout_deferred_day === 'string' && job.payout_deferred_day.length > 0;
}

/** Sold printers park their slot at slot + PARKED_SLOT_BASE × n (migration 0054 header). */
export const PARKED_SLOT_BASE = 1_000_000;

export interface FarmProfileRow {
  user_id: string;
  farm_name: string;
  level: number;
  xp: number;
  reputation_bp: number;
  location_key: string;
  state: 'active' | 'recovery';
  last_seen_at: string;
  last_resolved_at: string;
  last_offer_at: string | null;
  offer_refresh_index: number;
  config_version: number;
  stats_json: string;
  tutorial_json: string;
  created_at: string;
  updated_at: string;
  /** Write fence (0054): every write batch expects this value and bumps it. */
  revision: number;
  /** Per-player secret seeding offer generation (0054). NEVER leaves the server. */
  offer_salt: string;
}

export interface FarmPrinterRow {
  id: string;
  user_id: string;
  model_key: string;
  slot: number;
  nickname: string;
  health: number;
  state: PrinterState;
  state_until: string | null;
  /** operating hours × 100 */
  hours: number;
  prints: number;
  failures: number;
  upgrades_json: string;
  created_at: string;
  updated_at: string;
  /** When sold; NULL while owned. Sold rows keep their history and never appear in state (0054). */
  sold_at: string | null;
}

export interface FarmSpoolRow {
  id: string;
  user_id: string;
  material: string;
  color: string;
  grams_left: number;
  grams_total: number;
  quality: number;
  cost_paid: number;
  created_at: string;
}

export interface FarmJobRow {
  id: string;
  user_id: string;
  state: JobState;
  customer_tier: string;
  /** JSON {ar,en,ckb} */
  customer_name: string;
  product_key: string;
  qty: number;
  material: string;
  colors_json: string;
  grams: number;
  print_seconds: number;
  quality: 'draft' | 'standard' | 'fine' | 'ultra';
  reward_coins: number;
  reputation_gain_bp: number;
  late_penalty_bp: number;
  cancel_penalty_coins: number;
  cancel_penalty_bp: number;
  offered_at: string;
  offer_expires_at: string;
  deadline_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  seed: string;
  created_at: string;
  updated_at: string;
  /** Baghdad day the payout was held on because of the daily cap; NULL otherwise (0054). */
  payout_deferred_day: string | null;
}

export interface FarmAssignmentRow {
  id: string;
  user_id: string;
  job_id: string;
  printer_id: string;
  spool_id: string;
  qty: number;
  grams: number;
  seconds: number;
  quality: 'draft' | 'standard' | 'fine' | 'ultra';
  position: number;
  state: AssignmentState;
  started_at: string | null;
  ends_at: string | null;
  failure_p: number;
  failure_kind: string | null;
  outcome_seed: string;
  collected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FarmEventRow {
  id: string;
  user_id: string;
  kind: FarmEventKind;
  payload_json: string;
  seen_at: string | null;
  created_at: string;
}

export interface FarmDailyRow {
  user_id: string;
  day: string;
  coins_earned: number;
  jobs_delivered: number;
  points_converted: number;
}

export interface FarmStats {
  delivered: number;
  late: number;
  cancelled: number;
  prints: number;
  parts: number;
  failures: number;
  streak: number;
  lifetime_coins: number;
}

export function emptyStats(): FarmStats {
  return { delivered: 0, late: 0, cancelled: 0, prints: 0, parts: 0, failures: 0, streak: 0, lifetime_coins: 0 };
}

export function parseStats(json: string | null | undefined): FarmStats {
  const base = emptyStats();
  if (!json) return base;
  try {
    const v = JSON.parse(json) as Partial<Record<keyof FarmStats, unknown>>;
    for (const k of Object.keys(base) as Array<keyof FarmStats>) {
      const n = v[k];
      if (typeof n === 'number' && Number.isFinite(n)) base[k] = Math.max(0, Math.round(n));
    }
  } catch {
    /* malformed → zeros */
  }
  return base;
}

/** Everything the engine needs about one player, loaded by the route. */
export interface FarmState {
  profile: FarmProfileRow;
  /** SUM(farm_ledger.amount) at load time. */
  balance: number;
  printers: FarmPrinterRow[];
  spools: FarmSpoolRow[];
  /** Live jobs only (LIVE_JOB_STATES). */
  jobs: FarmJobRow[];
  /** Live assignments only (LIVE_ASSIGNMENT_STATES). */
  assignments: FarmAssignmentRow[];
  daily: FarmDailyRow | null;
}

/** A SQL statement as data; the route binds it. */
export interface SqlStatement {
  sql: string;
  params: unknown[];
}
