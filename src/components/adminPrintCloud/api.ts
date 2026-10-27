/**
 * PRINT CLOUD ADMIN — the client of /api/admin/print-cloud
 * (worker/routes/printCloudAdmin.ts; documented in
 * worker/lib/printCloud/openapi.ts).
 *
 * Every answer is the envelope `{ success: true, data }`; these helpers return
 * `data`. A refusal is the platform `ApiError` with a stable `code` and
 * `details.messages` in three languages (refusal.ts reads it).
 *
 * IDEMPOTENCY. The server takes an `Idempotency-Key` on exactly six admin
 * doors — credit and inventory adjustments, refunds, and the stock receipt,
 * count correction and write-off — and the callers mint one per dialog
 * (`newIdempotencyKey`), reused by every retry of it. The
 * manual payment door takes none: its receipt (order, amount, reference) IS
 * the event id, so the same receipt entered twice is recorded once.
 *
 * Two reads come from the customer API on the same host (admins pass its
 * closed-service gate): `/status` (installed, open, slicer, integrations) and
 * `/units`, plus `/store/products` for a variant's current price tiers.
 */
import { api, newIdempotencyKey, type RequestOptions } from '../../lib/api';

export const PC_ADMIN = '/api/admin/print-cloud';
export const PC_PUBLIC = '/api/print-cloud/v1';

interface Envelope<T> {
  success: true;
  data: T;
}

const headers = (key?: string) => (key ? { headers: { 'Idempotency-Key': key } } : undefined);

export const pc = {
  get: async <T>(path: string, opts?: RequestOptions): Promise<T> => (await api.get<Envelope<T>>(`${PC_ADMIN}${path}`, opts)).data,
  post: async <T>(path: string, body: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> =>
    (await api.post<Envelope<T>>(`${PC_ADMIN}${path}`, body, headers(idempotencyKey))).data,
  patch: async <T>(path: string, body: Record<string, unknown>): Promise<T> => (await api.patch<Envelope<T>>(`${PC_ADMIN}${path}`, body)).data,
  put: async <T>(path: string, body: Record<string, unknown>): Promise<T> => (await api.put<Envelope<T>>(`${PC_ADMIN}${path}`, body)).data,
  /** A read of the customer API (admins pass its closed-service gate). */
  public: async <T>(path: string): Promise<T> => (await api.get<Envelope<T>>(`${PC_PUBLIC}${path}`)).data,
};

export { newIdempotencyKey };

/**
 * The admin doors that take an Idempotency-Key (openapi.ts `idempotent:
 * true`) — the console sends one on these and on nothing else
 * (tests/printCloudAdminUi.test.ts holds both lists together).
 */
export const IDEMPOTENT_DOORS = [
  '/customers/{userId}/credits/adjust',
  '/customers/{userId}/inventory/adjust',
  '/orders/{id}/refunds',
  '/stock/receive',
  '/stock/adjust',
  '/stock/waste',
] as const;

/** `?a=1&b=2` from the defined, non-empty values only. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const enc = encodeURIComponent;

// ------------------------------------------------------------------ shapes (as the handlers return them)

export type Row = Record<string, unknown>;

export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  slicer: 'connected' | 'stale' | 'never_connected' | 'not_connected';
  delivery: { enabled: boolean; pickup_enabled: boolean };
  integrations: Array<{ name: string; connected: boolean }>;
}

export interface Overview {
  jobs_by_status: Record<string, number>;
  printers_by_status: Record<string, number>;
  low_stock_variants: number;
  open_failures: number;
  jobs_awaiting_approval: number;
}

export interface AdapterStatus {
  name: string;
  connected: boolean;
  implementation: string;
  note: string;
}

export interface AdaptersAnswer {
  adapters: AdapterStatus[];
  backlog: Array<{ adapter: string; kind: string; status: string; n: number }>;
}

export interface ImportProvider {
  id: string;
  hosts: string[];
  api_url: string;
  download_hosts: string[];
  enabled: boolean;
}

export interface PrintCloudConfig {
  enabled: boolean;
  quote_ttl_minutes: number;
  stock_hold_minutes: number;
  confirmation_ttl_minutes: number;
  material_price_rounding_iqd: number;
  cap_custom_price_at_next_pack: boolean;
  time_overage_policy: string;
  material_overage_policy: string;
  require_operator_approval: boolean;
  agent_reports_need_verification: boolean;
  telemetry_stale_seconds: number;
  failure_policy: Record<string, string>;
  free_reprint_on_workshop_failure: boolean;
  max_upload_bytes: number;
  max_active_jobs_per_customer: number;
  low_inventory_default_g: number;
  delivery: { enabled: boolean; pickup_enabled: boolean; flat_fee_iqd: number; fee_by_governorate: Record<string, number> };
  import_providers: ImportProvider[];
  /** Present for the owner only (publicSettings strips it for everyone else). */
  cost_electricity_iqd_per_kwh?: number;
}

export interface SettingsAnswer {
  version: number;
  config: PrintCloudConfig;
}

export interface Category {
  code: string;
  kind: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  buyback_enabled: number;
  buyback_rate_bps: number;
  storable: number;
  sort: number;
}

export interface Unit {
  code: string;
  dimension: string;
  base_code: string;
  factor_to_base: number;
  is_base: number;
  label_ar: string;
  label_en: string;
  label_ckb: string;
}

export interface PriceTier {
  mode: 'pack' | 'bracket';
  min_qty: number;
  pack_price_iqd?: number | null;
  unit_price_milli_iqd?: number | null;
}

export interface StoreVariant {
  id: string;
  price_tiers: Array<PriceTier & { variant_id: string }>;
}

export interface PriceChange {
  id: string;
  entity_type: string;
  entity_id: string;
  before_json: string;
  after_json: string;
  actor_id: string;
  created_at: string;
}

export interface StockRow {
  variant_id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  unit_code: string;
  on_hand_qty: number;
  reserved_qty: number;
  allocated_qty: number;
  sellable_qty: number;
  low_stock_threshold_qty: number;
  low: number;
}

export interface StockLot {
  id: string;
  variant_id: string;
  location_id: string | null;
  lot_code: string;
  supplier: string;
  received_qty: number;
  on_hand_qty: number;
  unit_cost_milli_iqd: number;
  total_cost_iqd: number;
  cost_known: number;
  received_at: string;
  received_by: string;
  notes: string;
}

export interface Telemetry {
  stale: boolean;
  live: boolean;
  age_seconds: number | null;
  received_at: string;
  machine_state: string | null;
  job_id: string | null;
  progress_permille: number | null;
  layer: number | null;
  total_layers: number | null;
  remaining_seconds: number | null;
  nozzle_temp_dc: number | null;
  bed_temp_dc: number | null;
  chamber_temp_dc?: number | null;
  errors?: unknown[];
  camera?: Record<string, unknown>;
}

export interface PrinterStatus {
  id: string;
  name: string;
  model_id: string;
  model_code: string;
  status: string;
  adapter: string;
  location: string;
  nozzle_um: number;
  ams_slots: number;
  materials: string[];
  camera: boolean;
  operating_seconds: number;
  current_job_id: string | null;
  connectivity: 'manual' | 'never_connected' | 'offline' | 'online';
  telemetry: Telemetry | null;
}

export interface PrinterEvent {
  id: string;
  printer_id: string;
  kind: string;
  detail_json: string;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
}

export interface MaintenanceWindow {
  id: string;
  printer_id: string;
  kind: string;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string;
  /** The owner only (stripped for everyone else). */
  cost_iqd?: number;
  created_by: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  capabilities_json: string;
  active: number;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface JobRow {
  id: string;
  user_id: string;
  title: string;
  status: string;
  printer_model_id: string;
  assigned_printer_id: string | null;
  priority: number;
  needs_operator_approval: number;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface JobEvent {
  from_status: string | null;
  to_status: string;
  event: string;
  actor_type: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface JobEstimate {
  id: string;
  provenance: string;
  duration_seconds: number;
  layer_count: number | null;
  model_grams: number;
  support_grams: number;
  purge_grams: number;
  color_changes: number;
  compatible: number;
  slicer_name?: string;
  slicer_version?: string;
  printer_profile?: string;
  warnings: string[];
  materials: Array<{ variant_id: string; model_grams: number; support_grams: number; purge_grams: number }>;
  created_at: string;
}

export interface ConsumptionRecord {
  id: string;
  job_id: string;
  reported_by_type: string;
  reported_by: string;
  printed_seconds: number;
  materials_json: string;
  verified: number;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface JobDetail {
  id: string;
  user_id: string;
  project_id: string;
  plate_id: string | null;
  printer_model_id: string;
  tier_id: string;
  title: string;
  status: string;
  settings: Record<string, unknown>;
  copies: number;
  priority: number;
  needs_operator_approval: boolean;
  depends_on_job_id: string | null;
  parent_job_id: string | null;
  operator_instructions: Array<Record<string, unknown>>;
  confirmation_expires_at: string | null;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  billable_seconds: number | null;
  printed_seconds: number | null;
  estimate: JobEstimate | null;
  requirements: Array<{ variant_id: string; kind: string; qty: number }>;
  /** What a slicer measures (admin view only): the job's own variants and model files; null when it cannot be sliced as it stands. */
  slicing?: { variants: Array<{ variant_id: string }>; models: Array<{ project_model_id: string; file_id: string; quantity: number }> } | null;
  reservations: {
    credits: { id: string; seconds_reserved: number; seconds_consumed: number; seconds_released: number; state: string } | null;
    materials: Array<{ variant_id: string; qty_reserved: number; qty_consumed: number; qty_released: number; state: string }>;
  };
  printer: { printer_id: string; name: string; assigned_at: string } | null;
  telemetry: (Telemetry & { age_seconds: number }) | null;
  failure: Row | null;
  events: JobEvent[];
  consumption_records: ConsumptionRecord[];
  created_at: string;
  updated_at: string;
}

export interface QueueEstimate {
  job_id: string;
  position: number;
  estimated_start_at: string | null;
  estimated_end_at: string | null;
  printer_id: string | null;
  basis: string;
}

export interface SchedulerRun {
  assigned: Array<{ job_id: string; printer_id: string }>;
  released: string[];
  waiting: number;
  deferred: string[];
  more: boolean;
}

export interface FailureRow {
  id: string;
  job_id: string;
  reason_code: string;
  responsible: string;
  description: string;
  printed_seconds: number;
  failed_materials_json: string;
  status: string;
  policy: string | null;
  billable_seconds: number | null;
  reprint_job_id: string | null;
  created_at: string;
  resolved_at: string | null;
  user_id: string;
  title: string;
}

export interface OrderRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  total_iqd: number;
  paid_iqd: number;
  refunded_iqd: number;
  payment_method: string;
  created_at: string;
  paid_at: string | null;
}

export interface OrderLine {
  id: string;
  line_no: number;
  kind: string;
  tier_id: string | null;
  package_id: string | null;
  variant_id: string | null;
  quantity: number;
  seconds: number;
  final_price_iqd: number;
  refunded_iqd: number;
  fulfillment: string;
  expires_after_days: number | null;
}

export interface OrderDetail extends OrderRow {
  subtotal_iqd: number;
  discount_iqd: number;
  stock_hold_expires_at: string;
  shipment_id: string | null;
  fulfilled_at: string | null;
  promotion_ids: string[];
  delivery_address: Record<string, string> | null;
  lines: OrderLine[];
  payments: Array<{ id: string; provider: string; amount_iqd: number; status: string; created_at: string; confirmed_at: string | null }>;
  refunds: Array<{ id: string; order_line_id: string | null; amount_iqd: number; quantity: number; reason: string; method: string; status: string; created_at: string }>;
}

export interface PaymentResult {
  outcome: string;
  order_id: string;
  previous_outcome?: string;
  previous_amount_iqd?: number;
}

export interface PaymentEvent {
  id: string;
  provider: string;
  provider_event_id: string;
  order_id: string | null;
  amount_iqd: number | null;
  outcome: string;
  received_at: string;
}

export interface CustomerView {
  credits: Array<{ tier_id: string; available_seconds: number; reserved_seconds: number; consumed_seconds: number }>;
  inventory: Array<{ variant_id: string; unit_code: string; available_qty: number; reserved_qty: number; consumed_qty: number }>;
  orders: Array<{ id: string; kind: string; status: string; total_iqd: number; paid_iqd: number; refunded_iqd: number; created_at: string }>;
  jobs: Array<{ id: string; title: string; status: string; created_at: string }>;
  credit_ledger: Row[];
  inventory_ledger: Row[];
}

export interface UserLookup {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: string;
}

export interface ShipmentRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  address_json: string | null;
  packaging: string;
  /** Money scope only (removed for everyone else). */
  fee_iqd?: number;
  fee_order_id?: string | null;
  carrier: string;
  tracking_ref: string;
  created_at: string;
  updated_at: string;
}

export interface ShipmentItem {
  id: string;
  item_type: 'print_job' | 'inventory';
  job_id: string | null;
  variant_id: string | null;
  qty: number;
  live: number;
}

/** `GET /shipments/{id}`: the row with its address read and its packing list. */
export interface ShipmentDetail extends Omit<ShipmentRow, 'address_json'> {
  address: Record<string, string> | null;
  notes: string;
  closed_at: string | null;
  items: ShipmentItem[];
}

export interface BuybackRow {
  id: string;
  user_id: string;
  variant_id: string;
  qty: number;
  rate_bps: number;
  estimated_value_iqd: number;
  final_value_iqd: number | null;
  lots_json: string;
  status: string;
  payout_method: string;
  payout_status: string;
  note: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface RevenueReport {
  range: { from: string; to: string };
  cash_collected: { printing_hours: number; materials: number; delivery_fees: number; total: number };
  recognised_revenue: { printing_hours: number; materials_by_category: Record<string, number>; materials: number; delivery_fees: number; total: number };
  deferred_liability_now: { printing_hours: number; materials: number };
  refunds_recorded: number;
  refunds_of_unused_value: number;
  buybacks: { approved_value: number; paid_out: number };
}

export interface ProfitReport {
  range: { from: string; to: string };
  recognised_revenue: number;
  cost_of_material_used: number;
  gross_profit: number;
  operating_costs: {
    material_waste_and_workshop_use: number;
    electricity_estimate: number;
    electricity_basis: { tariff_iqd_per_kwh: number; method: string };
    maintenance_reserve: number;
    maintenance_recorded: number;
    depreciation: number;
  };
  material_cost_stated_after_use: number;
  cost_complete: boolean;
  cost_pending: Array<{ variant_id: string; entry_type: string; qty: number }>;
  lots_cost_pending: Array<{ lot_id: string; variant_id: string; received_qty: number; on_hand_qty: number; received_at: string }>;
  refunds_recorded: number;
  refunds_of_unused_value: number;
  refunds_profit_effect: number;
  buybacks_approved: number;
  net_profit: number;
}

export interface OperationsReport {
  range: { from: string; to: string };
  printers: Array<{ id: string; name: string; printed: number; jobs: number; utilisation_permille: number }>;
  jobs: { completed: number; failed: number; failure_rate_permille: number };
  failures_by_responsible: Record<string, number>;
  material_used: Array<{ variant_id: string; consumed: number }>;
}

export interface ReconcileAnswer {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; issues: Row[] }>;
}

export interface TaskOverview {
  counts: Array<{ kind: string; status: string; n: number }>;
  recent_failures: Array<{ id: string; kind: string; status: string; attempts: number; max_attempts: number; last_error: string | null; updated_at: string }>;
}

export interface TaskRun {
  ran: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export interface AuditRow {
  id: number;
  actor_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

/** A JSON column read back as a value; `fallback` when it is empty or not JSON. */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
