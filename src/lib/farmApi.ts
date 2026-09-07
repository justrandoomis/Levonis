/**
 * LEVO Printer Farm — the client's view of `/api/farm`.
 *
 * Every type here mirrors docs/PRINTER_FARM.md §4 field for field. The client
 * renders these and nothing else: it holds no balance, no timer that decides
 * an outcome and no rule the server does not also hold. Where the contract is
 * silent about a shape (the public config, the tutorial object, an event's
 * payload) the type below is deliberately loose and the reading code treats a
 * missing field as "not sent", never as zero.
 *
 * Farm Coins are an in-game integer currency. Nothing in this module touches
 * Levonis Points, the wallet or any points route — Phase 1 mints none.
 */
import { api } from './api';

// ------------------------------------------------------------------ enums

export type PrinterState = 'idle' | 'printing' | 'done' | 'maintenance' | 'broken';
export type JobState =
  | 'offered'
  | 'accepted'
  | 'printing'
  | 'ready'
  | 'delivered'
  | 'late'
  | 'cancelled'
  | 'rejected'
  | 'expired';
export type AssignmentState = 'queued' | 'printing' | 'done' | 'failed' | 'collected';
export type PrintQuality = 'draft' | 'standard' | 'fine' | 'ultra';
export type CustomerTier = 'individual' | 'small_business' | 'merchant' | 'company' | 'industrial';
export type PrinterFamily = 'A' | 'P' | 'X' | 'H';
export type LeaderboardBoard = 'reputation' | 'farm_value' | 'jobs_delivered';
export type FarmProfileState = 'active' | 'recovery';

export const PRINT_QUALITIES: PrintQuality[] = ['draft', 'standard', 'fine', 'ultra'];

/** Names the config carries in the three UI languages. The engine sends these for titles, customers, models and places. */
export interface LocalizedName {
  ar: string;
  en: string;
  ckb: string;
}
/** A name that may arrive as a plain string (the contract's wording) or localised (what the engine sends). */
export type Localized = string | LocalizedName;
export const LEADERBOARD_BOARDS: LeaderboardBoard[] = ['reputation', 'farm_value', 'jobs_delivered'];

// ---------------------------------------------------------------- profile

export interface FarmLocation {
  key: string;
  name?: Localized;
  max_printers: number;
  storage_grams: number;
}

/**
 * `stats_json` as the server sends it. Every field is optional on purpose: a
 * stat the server did not send is shown as "—", never as a fabricated 0.
 */
export interface FarmStats {
  /** The engine's keys. */
  delivered?: number;
  late?: number;
  cancelled?: number;
  parts?: number;
  /** The contract's wording for the same three counters. */
  jobs_delivered?: number;
  jobs_late?: number;
  jobs_cancelled?: number;
  prints?: number;
  failures?: number;
  streak?: number;
  lifetime_coins?: number;
  [key: string]: number | undefined;
}

/** A stat under either spelling; undefined when the server sent neither (shown as "—"). */
export function statValue(stats: FarmStats | null | undefined, ...keys: string[]): number | undefined {
  if (!stats) return undefined;
  for (const k of keys) {
    const v = stats[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * `tutorial_json`. The client reads `step` (0 = has never taken a job) and
 * `done`; it never writes either — the server advances them.
 */
export interface FarmTutorial {
  step?: number;
  done?: boolean;
  [key: string]: unknown;
}

export interface FarmProfile {
  farm_name: string;
  level: number;
  xp: number;
  /** XP needed for the next level; null at the top level. */
  xp_next: number | null;
  /** Reputation in basis points 0–5000. */
  reputation_bp: number;
  /** Reputation as stars 0.00–5.00, computed by the server. */
  stars: number;
  location: FarmLocation;
  state: FarmProfileState;
  /** SUM(farm_ledger.amount) — there is no stored balance. */
  coins: number;
  stats: FarmStats;
  tutorial: FarmTutorial | null;
}

export interface FarmUnlocks {
  market: boolean;
  inventory: boolean;
  maintenance: boolean;
  store: boolean;
  upgrades: boolean;
  employees: boolean;
  [key: string]: boolean;
}

// --------------------------------------------------------------- printers

export interface PrinterCurrent {
  assignment_id: string;
  job_id: string;
  title: Localized;
  qty: number;
  /** printing | done | failed — a failed batch waits on the printer until collected. */
  state?: AssignmentState;
  quality?: PrintQuality;
  started_at: string;
  ends_at: string;
  /** 0–1 at `now`, computed by the server. The client re-derives it locally between polls. */
  progress: number;
  failure_kind?: string | null;
  failure_p?: number;
}

/** True when the batch on the printer has ended (well or badly) and can be collected. */
export function batchEnded(printer: Pick<FarmPrinter, 'state' | 'current'>): boolean {
  const cur = printer.current;
  if (!cur) return false;
  if (cur.state) return cur.state !== 'printing';
  return printer.state === 'done';
}

export interface PrinterQueueItem {
  assignment_id: string;
  job_id: string;
  title: Localized;
  qty: number;
  /** Game seconds this batch will take on this printer. */
  seconds: number;
}

export interface FarmPrinter {
  id: string;
  model_key: string;
  /** Defaults to "<model name> <slot + 1>" on the server; older rows may still be ''. Display through `printerName`. */
  nickname: string;
  slot: number;
  /** The exact credit a sale pays now, priced by the server. Absent on older rows — then no figure is shown. */
  resale_coins?: number;
  /** 0–100 */
  health: number;
  state: PrinterState;
  /** Server time when maintenance / repair finishes; null otherwise. */
  state_until: string | null;
  /** Operating hours (the engine divides its ×100 column before sending). */
  hours: number;
  prints: number;
  failures: number;
  current: PrinterCurrent | null;
  queue: PrinterQueueItem[];
}

export interface FarmSpool {
  id: string;
  material: string;
  color: string;
  grams_left: number;
  grams_total: number;
  quality: number;
}

// ------------------------------------------------------------------- jobs

/**
 * Per-job rollup of its assignments, in parts (qty). Optional throughout:
 * the contract names the field but not its keys.
 */
export interface AssignmentsSummary {
  assigned?: number;
  queued?: number;
  printing?: number;
  done?: number;
  failed?: number;
  collected?: number;
  remaining?: number;
  [key: string]: number | undefined;
}

export interface FarmJob {
  id: string;
  state: JobState;
  customer_tier: CustomerTier;
  customer_name: Localized;
  title: Localized;
  product_key: string;
  qty: number;
  material: string;
  colors: string[];
  grams: number;
  /** Game seconds on the reference machine at standard quality, whole job. */
  print_seconds: number;
  quality: PrintQuality;
  reward_coins: number;
  /** Reputation gained on an on-time delivery, in basis points (either spelling). */
  reputation_gain_bp?: number;
  reputation_gain?: number;
  late_penalty_bp: number;
  cancel_penalty_coins: number;
  cancel_penalty_bp: number;
  offer_expires_at: string | null;
  deadline_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  /**
   * Set when every part was handed over but the day's cap (jobs or coins)
   * held the payout: the job stays `ready`/`late` and the resolver pays it on
   * a later Baghdad day (§9a). Absent from an older server's answer.
   */
  payout_deferred_day?: string | null;
  assignments_summary: AssignmentsSummary | null;
}

/** Reputation gain of a job in basis points, whichever key the server used. */
export function reputationGainBp(job: Pick<FarmJob, 'reputation_gain_bp' | 'reputation_gain'>): number {
  return job.reputation_gain_bp ?? job.reputation_gain ?? 0;
}

export interface FarmEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  seen_at?: string | null;
}

// ----------------------------------------------------------------- config

export interface FarmPrinterModel {
  name: Localized;
  family: PrinterFamily;
  price: number;
  /** mm/s reference — a duration factor against the reference machine. */
  speed: number;
  volume_mm: [number, number, number];
  materials: string[];
  /** Multi-colour capable. */
  ams: boolean;
  /** 0–1 */
  reliability: number;
  watts: number;
  wear_per_hour: number;
  min_level: number;
  sort: number;
}

export interface FarmMaterialDef {
  name?: Localized;
  price_per_gram: number;
  /** Spool quality 0–1 the market sells. */
  quality?: number;
  /** 0–1 */
  difficulty: number;
  min_level: number;
  colors: string[];
}

export interface FarmColorDef {
  name: Localized;
  hex: string;
}

export interface FarmProductDef {
  key?: string;
  name?: Localized;
  name_ar?: string;
  name_en?: string;
  name_ckb?: string;
  grams_per_part: number;
  seconds_per_part: number;
  complexity: number;
  max_colors: number;
  size_mm: [number, number, number];
  materials: string[];
  min_tier: CustomerTier;
}

export interface FarmCustomerTierDef {
  name?: Localized;
  min_reputation_bp: number;
  min_level: number;
  qty_range: [number, number];
  deadline_factor: number;
  reward_margin: number;
  late_penalty_bp: number;
  cancel_penalty_bp: number;
  cancel_penalty_coins?: number;
  reputation_gain_bp: number;
  weight: number;
}

export interface FarmQualityDef {
  time_factor: number;
  failure_factor: number;
  reputation_factor: number;
}

export interface FarmLocationDef {
  name?: Localized;
  max_printers: number;
  storage_grams: number;
  employees?: number;
  price: number;
  min_level: number;
}

/**
 * The subset of the config the server lets the client see (`publicFarmConfig`).
 * `limits` and the rewards budget never arrive; `rewards.levonis_points` may
 * arrive as a flag block — while `enabled` is false (the Phase 1 default) the
 * redeem page says conversion is not open.
 */
export interface PublicFarmConfig {
  schema?: number;
  version?: number;
  time: {
    time_scale: number;
    offer_refresh_minutes: number;
    away_summary_after_minutes: number;
    /** mm/s of the machine the product times are quoted on. */
    reference_speed_mms?: number;
  };
  economy: {
    starter_coins: number;
    resale_factor: number;
    spool_sizes_g: number[];
    maintenance: { cost: number; minutes: number; health_restore: number; recommend_below?: number };
    repair: { cost: number; minutes: number; health: number };
    energy: { coins_per_kwh: number };
  };
  printers: Record<string, FarmPrinterModel>;
  materials: Record<string, FarmMaterialDef>;
  colors?: Record<string, FarmColorDef>;
  products: Record<string, FarmProductDef> | FarmProductDef[];
  customers: Record<CustomerTier, FarmCustomerTierDef> | Record<string, FarmCustomerTierDef>;
  jobs: {
    offers_visible: number;
    offer_lifetime_minutes: number;
    late_grace_minutes: number;
    deadline_buffer_minutes?: number;
    max_active_jobs: number[] | Record<string, number>;
    reward_formula?: Record<string, unknown>;
  };
  quality: Record<PrintQuality, FarmQualityDef>;
  failure?: Record<string, unknown>;
  progression: {
    xp_per_job: number;
    xp_per_part: number;
    level_thresholds: number[];
    reputation_start_bp: number;
    reputation_cap_bp: number;
    failure_reputation_bp?: number;
    unlocks?: Record<string, number>;
    [key: string]: unknown;
  };
  locations: Record<string, FarmLocationDef>;
  starter: {
    printer_model: string;
    spool: { material: string; color: string; grams: number; quality?: number };
    first_job?: Record<string, unknown>;
  };
  /** Absent in Phase 1: `publicFarmConfig` omits the rewards section, so conversion reads as not open. */
  rewards?: {
    levonis_points?: {
      enabled: boolean;
      coins_per_point?: number;
      daily_cap_points?: number;
      weekly_cap_points?: number;
      min_level?: number;
      min_reputation_bp?: number;
    };
  };
}

// ------------------------------------------------------------------ state

export interface FarmState {
  success: true;
  /** Server clock at the time of the answer — the only clock the client trusts. */
  now: string;
  config_version: number;
  unlocks: FarmUnlocks;
  profile: FarmProfile;
  printers: FarmPrinter[];
  spools: FarmSpool[];
  jobs: { offered: FarmJob[]; active: FarmJob[] };
  events_unseen: FarmEvent[];
  /** Feature → level, computed by the server (preferred over the config's table). */
  unlock_levels?: Record<string, number>;
  /** Null when the absence was shorter than `away_summary_after_minutes`. */
  away?: { since: string; minutes: number; counts: Record<string, number> } | null;
  /**
   * The caps the server enforces and today's tallies against them. Every field
   * is optional so an older server's answer still renders; a missing figure is
   * not shown, never invented.
   */
  limits?: {
    max_active_jobs?: number;
    storage_grams?: number;
    daily_jobs_cap?: number;
    daily_coins_cap?: number;
    jobs_today?: number;
    coins_today?: number;
  };
  /** True when a mutation's idempotency key had already been applied (every route answers this on a retried intent). */
  replayed?: boolean;
  config: PublicFarmConfig;
}

/** "today: X of Y jobs" — both numbers from the server's `limits`, or null when either is missing. */
export function dailyJobs(limits: FarmState['limits']): { jobs: number; cap: number } | null {
  if (!limits) return null;
  const { jobs_today: jobs, daily_jobs_cap: cap } = limits;
  if (typeof jobs !== 'number' || typeof cap !== 'number') return null;
  return { jobs, cap };
}

/**
 * A mutation answers with the state but WITHOUT the public config (§9: the
 * config travels on GET /state and GET /config only). When the answer's
 * `config_version` is the one the client already holds, the held config is
 * carried over so the screen re-renders from the answer; when the version
 * moved, the answer is left as it is and fails `isFarmState`, which makes the
 * caller re-read the state — config included — from the server.
 */
export function withPreviousConfig(res: unknown, previous: FarmState | null): unknown {
  if (!res || typeof res !== 'object' || !previous?.config) return res;
  const o = res as Record<string, unknown>;
  if (o.config !== undefined) return res;
  if (typeof o.now !== 'string' || !o.profile || !Array.isArray(o.printers)) return res;
  if (o.config_version !== previous.config_version) return res;
  return { ...o, config: previous.config };
}

/** True when a response carries the whole state (every mutation is expected to). */
export function isFarmState(x: unknown): x is FarmState {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.now === 'string' &&
    !!o.profile &&
    Array.isArray(o.printers) &&
    Array.isArray(o.spools) &&
    !!o.jobs &&
    !!o.config
  );
}

// -------------------------------------------------------------- mutations

/**
 * What every mutation answers: the whole state WITHOUT the public config
 * (§9: the config travels on GET /state and GET /config only) plus the
 * route's own result fields. `withPreviousConfig` puts the held config back so
 * `isFarmState` accepts the body and the screen re-renders from it.
 */
export type FarmMutation<T = Record<never, never>> = Omit<FarmState, 'config'> & {
  config?: PublicFarmConfig;
  /** True when the idempotency key had already been applied: the stored result, nothing paid twice. */
  replayed: boolean;
} & T;

/** The batch `collect` took off the bed. `outcome` is the assignment's state as the server stored it. */
export interface CollectedBatch {
  assignment_id: string;
  job_id: string;
  qty: number;
  /** 'done' → the parts count towards the job; 'failed' → they must be printed again. */
  outcome: AssignmentState | string;
  failure_kind: string | null;
}

/** `deliveryPlan`'s summary (§9a) — what the server paid when the last part was collected. */
export interface DeliverySummary {
  job_id: string;
  reward_coins: number;
  late: boolean;
  /** Signed: the gain, or the late penalty. */
  reputation_delta_bp: number;
  reputation_bp: number;
  xp_gained: number;
  level: number;
  level_up: boolean;
}

export type PayoutDeferReason = 'daily_jobs_cap' | 'daily_coins_cap';

/** The job was handed over but today's cap held the coins; the resolver pays it on a later Baghdad day (§9a). */
export interface PayoutDeferred {
  job_id: string;
  reward_coins: number;
  /** The Baghdad day of the hand-over. */
  day: string;
  late: boolean;
  reason: PayoutDeferReason | string;
}

/** `POST /printers/:id/collect` — the route's fields; the state rides along (`FarmMutation<CollectResult>`). */
export interface CollectResult {
  printer_id: string;
  collected: CollectedBatch;
  /** Paid in this same batch, or null (parts still missing, a failed batch, a deferred payout, a replay). */
  delivered: DeliverySummary | null;
  payout_deferred: PayoutDeferred | null;
}

export type CollectResponse = FarmMutation<CollectResult>;

/** The collect result read off a response, or null when the body does not carry one (an older server, a stub). */
export function collectResultOf(res: unknown): (CollectResult & { replayed: boolean }) | null {
  if (!res || typeof res !== 'object') return null;
  const o = res as Record<string, unknown>;
  const c = o.collected as Record<string, unknown> | null | undefined;
  if (typeof o.printer_id !== 'string' || !c || typeof c !== 'object') return null;
  if (typeof c.assignment_id !== 'string' || typeof c.job_id !== 'string' || typeof c.qty !== 'number' || typeof c.outcome !== 'string') return null;
  const d = o.delivered;
  const delivered =
    d && typeof d === 'object' && typeof (d as DeliverySummary).reward_coins === 'number' && typeof (d as DeliverySummary).job_id === 'string'
      ? (d as DeliverySummary)
      : null;
  const p = o.payout_deferred;
  const payout_deferred =
    p && typeof p === 'object' && typeof (p as PayoutDeferred).reward_coins === 'number' && typeof (p as PayoutDeferred).reason === 'string'
      ? (p as PayoutDeferred)
      : null;
  return {
    replayed: o.replayed === true,
    printer_id: o.printer_id,
    collected: {
      assignment_id: c.assignment_id,
      job_id: c.job_id,
      qty: c.qty,
      outcome: c.outcome,
      failure_kind: typeof c.failure_kind === 'string' ? c.failure_kind : null,
    },
    delivered,
    payout_deferred,
  };
}

export interface LedgerEntry {
  id: string;
  kind: string;
  amount: number;
  balance_after: number;
  note: string | null;
  ref_type: string | null;
  ref_id: string | null;
  created_at: string;
}

export interface LedgerPage {
  success: true;
  entries: LedgerEntry[];
  next_before: string | null;
}

export interface LeaderboardRow {
  username: string | null;
  avatar_key: string | null;
  farm_name: string;
  score: number;
  rank?: number;
}

export interface LeaderboardResponse {
  success: true;
  board: LeaderboardBoard;
  rows: LeaderboardRow[];
  generated_at?: string;
}

export interface FarmConfigResponse {
  success: true;
  version: number;
  config: PublicFarmConfig;
}

export interface FarmEventsResponse {
  success: true;
  events: FarmEvent[];
}

// ---------------------------------------------------------------- intents

export interface AssignAllocation {
  printer_id: string;
  qty: number;
  spool_id: string;
}

export interface AssignBody {
  allocations: AssignAllocation[];
  quality: PrintQuality;
  allow_partial?: boolean;
}

const BASE = '/api/farm';

/**
 * Thin typed wrapper. Every mutation takes the caller's idempotency key (8–80
 * chars, one per attempt, reused only on a retry of that same attempt) and is
 * typed to answer with the full state; `isFarmState` guards the assumption.
 */
export const farmApi = {
  state: () => api.get<FarmState>(`${BASE}/state`),
  config: () => api.get<FarmConfigResponse>(`${BASE}/config`),
  ledger: (before?: string | null) =>
    api.get<LedgerPage>(`${BASE}/ledger${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  events: () => api.get<FarmEventsResponse>(`${BASE}/events?all=1`),
  /** Public read — works signed out. */
  leaderboard: (board: LeaderboardBoard, limit = 50) =>
    api.get<LeaderboardResponse>(`${BASE}/leaderboard?board=${board}&limit=${limit}`),

  markEventsSeen: (ids: string[], idempotencyKey: string) =>
    api.post<FarmState | { success: true }>(`${BASE}/events/seen`, { ids, idempotencyKey }),

  acceptJob: (id: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/jobs/${encodeURIComponent(id)}/accept`, { idempotencyKey }),
  rejectJob: (id: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/jobs/${encodeURIComponent(id)}/reject`, { idempotencyKey }),
  assignJob: (id: string, body: AssignBody, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/jobs/${encodeURIComponent(id)}/assign`, { ...body, idempotencyKey }),
  cancelJob: (id: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`, { idempotencyKey }),

  reorderQueue: (printerId: string, order: string[], idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/printers/${encodeURIComponent(printerId)}/queue`, { order, idempotencyKey }),
  /** Answers the state plus `collected`, `delivered` and `payout_deferred` (§4, §9a); `collectResultOf` reads them. */
  collect: (printerId: string, idempotencyKey: string) =>
    api.post<CollectResponse>(`${BASE}/printers/${encodeURIComponent(printerId)}/collect`, { idempotencyKey }),
  maintain: (printerId: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/printers/${encodeURIComponent(printerId)}/maintain`, { idempotencyKey }),
  repair: (printerId: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/printers/${encodeURIComponent(printerId)}/repair`, { idempotencyKey }),
  rename: (printerId: string, nickname: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/printers/${encodeURIComponent(printerId)}/rename`, { nickname, idempotencyKey }),

  buyFilament: (material: string, color: string, grams: number, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/market/filament`, { material, color, grams, idempotencyKey }),
  buyPrinter: (model_key: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/market/printers`, { model_key, idempotencyKey }),
  sellPrinter: (printerId: string, idempotencyKey: string) =>
    api.post<FarmState>(`${BASE}/market/printers/${encodeURIComponent(printerId)}/sell`, { idempotencyKey }),
};

// ---------------------------------------------------------------- lookups

/** The config's products, whether the server keyed them or listed them. */
export function productList(config: PublicFarmConfig | null | undefined): FarmProductDef[] {
  const p = config?.products;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  return Object.entries(p).map(([key, def]) => ({ ...def, key: def.key || key }));
}

export function productByKey(config: PublicFarmConfig | null | undefined, key: string): FarmProductDef | null {
  const p = config?.products;
  if (!p) return null;
  if (Array.isArray(p)) return p.find((d) => d.key === key) ?? null;
  const direct = p[key];
  if (direct) return { ...direct, key: direct.key || key };
  return Object.values(p).find((d) => d.key === key) ?? null;
}

export function printerModel(config: PublicFarmConfig | null | undefined, modelKey: string): FarmPrinterModel | null {
  return config?.printers?.[modelKey] ?? null;
}

/** Catalog in the admin's `sort` order. */
export function printerCatalog(config: PublicFarmConfig | null | undefined): Array<{ key: string; model: FarmPrinterModel }> {
  const printers = config?.printers ?? {};
  return Object.entries(printers)
    .map(([key, model]) => ({ key, model }))
    .sort((a, b) => (a.model.sort ?? 0) - (b.model.sort ?? 0) || a.model.price - b.model.price);
}

export function materialList(config: PublicFarmConfig | null | undefined): Array<{ key: string; def: FarmMaterialDef }> {
  const materials = config?.materials ?? {};
  return Object.entries(materials)
    .map(([key, def]) => ({ key, def }))
    .sort((a, b) => (a.def.min_level ?? 0) - (b.def.min_level ?? 0) || a.key.localeCompare(b.key));
}

/** The level a feature unlocks at: the state's `unlock_levels` first, then the config's table. */
export function unlockLevel(config: PublicFarmConfig | null | undefined, feature: string, levels?: Record<string, number> | null): number | null {
  const fromState = levels?.[feature];
  if (typeof fromState === 'number') return fromState;
  const v = config?.progression?.unlocks?.[feature];
  return typeof v === 'number' ? v : null;
}

/** The colour's CSS value from the config, or null when the config has no colour table. */
export function colorHex(config: PublicFarmConfig | null | undefined, key: string): string | null {
  const hex = config?.colors?.[key]?.hex;
  return typeof hex === 'string' && hex ? hex : null;
}

/** The colour's localised name from the config, or null. */
export function colorNameOf(config: PublicFarmConfig | null | undefined, key: string): Localized | null {
  return config?.colors?.[key]?.name ?? null;
}
