/**
 * LEVO Printer Farm — the admin console's view of `/api/admin/farm`
 * (docs/PRINTER_FARM.md §4 "Admin").
 *
 * The configuration is carried as a JSON document the panel edits WITHOUT a
 * client-side schema: every field is rendered from the value's own type and
 * the default beside it, so a section the backend adds tomorrow appears here
 * with no client change. The types below therefore describe the ENVELOPE
 * (version, problems, the public projection) and leave the document itself as
 * `Record<string, unknown>`.
 *
 * Nothing in this module touches Levonis Points, the wallet or any points
 * route — Farm Coins are the only currency an admin can move here.
 */
import { api, ApiError } from './api';
import type { FarmEvent, FarmJob, FarmPrinter, FarmProfile, FarmSpool, FarmUnlocks } from './farmApi';

export type FarmConfigDocument = Record<string, unknown>;

export interface FarmAdminConfigResponse {
  success: true;
  version: number;
  /** The stored document, normalised — what the engine runs on right now. */
  config: FarmConfigDocument;
  /** The code defaults, same shape; the placeholder beside every field. */
  defaults: FarmConfigDocument;
  /** What `publicFarmConfig` lets a player see — a subset of `config`'s keys. */
  public: FarmConfigDocument;
  /** Blocking problems of the STORED document (normally empty). */
  problems: string[];
  /** The section names the server accepts in PUT /config/:section. */
  sections?: string[];
}

export interface FarmAdminSaveResponse {
  success: true;
  version: number;
  config: FarmConfigDocument;
  problems: string[];
}

/** `farm_ledger` rows as the admin route returns them (no running balance). */
export interface FarmAdminLedgerRow {
  id: string;
  kind: string;
  amount: number;
  note: string | null;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

/** A raw `farm_jobs` row (the admin view lists the last 50, any state). */
export interface FarmAdminJobRow {
  id: string;
  state: string;
  customer_tier: string;
  product_key: string;
  qty: number;
  material: string;
  reward_coins: number;
  deadline_at: string | null;
  delivered_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface FarmAdminPlayerUser {
  id: string;
  username: string | null;
  name: string;
  email: string;
}

/** The player's farm as `stateBody` renders it, plus the admin-only tails. */
export interface FarmAdminPlayerFarm {
  now: string;
  config_version: number;
  unlocks: FarmUnlocks;
  profile: FarmProfile;
  printers: FarmPrinter[];
  spools: FarmSpool[];
  jobs: { offered: FarmJob[]; active: FarmJob[] };
  events_unseen: FarmEvent[];
  limits?: { max_active_jobs: number; storage_grams: number };
  raw_profile: Record<string, unknown>;
  ledger_tail: FarmAdminLedgerRow[];
  jobs_recent: FarmAdminJobRow[];
  events_recent: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
}

export interface FarmAdminPlayerResponse {
  success: true;
  user: FarmAdminPlayerUser;
  /** Null when the player has never opened the game. */
  farm: FarmAdminPlayerFarm | null;
}

export interface FarmAdminGrantBody {
  /** Signed integer Farm Coins; negative = deduction (`admin_adjust`). */
  amount: number;
  reason: string;
  idempotencyKey: string;
}

export interface FarmAdminGrantResponse {
  success: true;
  replayed: boolean;
  ledger_id: string;
  amount: number;
  /** The player's balance after the movement — SUM(farm_ledger.amount). */
  balance: number;
}

const BASE = '/api/admin/farm';

export const farmAdminApi = {
  config: () => api.get<FarmAdminConfigResponse>(`${BASE}/config`),
  saveSection: (section: string, value: unknown, expectedVersion: number) =>
    api.put<FarmAdminSaveResponse>(`${BASE}/config/${encodeURIComponent(section)}`, {
      value,
      expected_version: expectedVersion,
    }),
  resetSection: (section: string) =>
    api.post<FarmAdminSaveResponse>(`${BASE}/config/${encodeURIComponent(section)}/reset`, { confirm: 'RESET' }),
  player: (userId: string) => api.get<FarmAdminPlayerResponse>(`${BASE}/players/${encodeURIComponent(userId)}`),
  grant: (userId: string, body: FarmAdminGrantBody) =>
    api.post<FarmAdminGrantResponse>(`${BASE}/players/${encodeURIComponent(userId)}/grant`, body),
};

/** Error codes the panel maps to its own copy; anything else shows the server's message. */
export const FARM_ADMIN_CODES = {
  versionMismatch: 'CONFIG_VERSION_MISMATCH',
  invalid: 'FARM_CONFIG_INVALID',
  confirmRequired: 'CONFIRM_REQUIRED',
  insufficient: 'INSUFFICIENT_COINS',
} as const;

/** The server's own sentence when it sent one; the panel's fallback otherwise. */
export function farmAdminErrorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.message) return e.message;
  return fallback;
}

export function farmAdminErrorCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.code : undefined;
}

/** `details.problems` of a FARM_CONFIG_INVALID refusal, as strings; empty for any other error. */
export function farmAdminProblems(e: unknown): string[] {
  if (!(e instanceof ApiError) || e.code !== FARM_ADMIN_CODES.invalid) return [];
  const raw = e.details?.problems;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
}

/** `details.current_version` of a CONFIG_VERSION_MISMATCH refusal, or null. */
export function farmAdminCurrentVersion(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.code !== FARM_ADMIN_CODES.versionMismatch) return null;
  const v = e.details?.current_version;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
