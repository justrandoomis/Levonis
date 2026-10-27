/**
 * LEVONIS PRINT CLOUD — the shapes of the customer API's answers
 * (`/api/print-cloud/v1`, worker/routes/printCloud.ts; OpenAPI in
 * worker/lib/printCloud/openapi.ts), as the handlers build them.
 *
 * Every answer arrives as `{ success: true, data }`; `src/cloud/api.ts`
 * unwraps it, so these are the `data`. Units are the server's own and never
 * converted here: money is INTEGER IQD, time is INTEGER SECONDS, a quantity is
 * an integer in its variant's base unit (`unit_code`: g, pc, set, mm…), a
 * build volume is millimetres and a nozzle micrometres. A field the server may
 * not know is `null`, and the interface says so — the screen then says so too
 * (docs/PRINT_CLOUD.md: no invented estimate, price, stock, status or ETA).
 *
 * Rows the server reads straight from a table keep its 0/1 integers and its
 * JSON text where the handler sends them that way; `api.ts` turns the few the
 * pages read most (printer models, packages, store products) into the parsed
 * forms at the bottom of this file.
 */

/** A text in the three languages of the platform. */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

/** `{ hours, minutes, seconds }` as the server's `hoursMinutes` writes it (seconds = the whole figure). */
export interface HoursMinutes {
  hours: number;
  minutes: number;
  seconds: number;
}

// ------------------------------------------------------------------ status

export type SlicerAvailability = 'connected' | 'stale' | 'never_connected' | 'not_connected';

export type IntegrationName =
  | 'identity'
  | 'notification'
  | 'wallet_payment'
  | 'product_catalog'
  | 'inventory'
  | 'orders'
  | 'membership'
  | 'accounting';

/** GET /status — public, answered even while the service is closed or not installed. */
export interface CloudStatus {
  /** False on a database without migration 0215: every read is empty and every write is refused. */
  installed: boolean;
  /** The owner's switch. Closed: customer doors answer 503 PRINT_CLOUD_DISABLED except to platform admins. */
  enabled: boolean;
  /** `connected` only when a slicer agent called in within the staleness window. */
  slicer: SlicerAvailability;
  delivery: { enabled: boolean; pickup_enabled: boolean };
  integrations: Array<{ name: IntegrationName | string; connected: boolean }>;
}

// ------------------------------------------------------------------ catalogue (public)

export type ExtruderConfig = 'single' | 'dual' | 'idex' | 'toolchanger';

/** GET /printers row, as the server sends it. */
export interface PrinterModelRow {
  id: string;
  code: string;
  brand: string;
  model_name: string;
  tier_id: string;
  tier_code: string;
  tier_name_ar: string;
  tier_name_en: string;
  tier_name_ckb: string;
  build_x_mm: number;
  build_y_mm: number;
  build_z_mm: number;
  /** JSON text: micrometres, e.g. `[400]`. */
  nozzle_options_um: string;
  extruder_config: ExtruderConfig | string;
  /** JSON text: the colour systems' names, e.g. `["AMS 2 Pro"]`. */
  ams_systems_json: string;
  max_colors: number;
  /** JSON text: material codes, e.g. `["PLA","PETG"]`. */
  supported_materials_json: string;
  max_nozzle_temp_c: number | null;
  max_bed_temp_c: number | null;
  enclosed: number;
  camera: number;
  quality_rank: number;
  /** JSON text: free-form specification the owner wrote. */
  spec_json: string;
  /** Machines of this model in service (`status = 'active'`). */
  machines_active: number;
  /** Machines that can take work NOW, by the scheduler's own test (fresh, idle, reachable, not running their own print). */
  machines_idle: number;
}

/** GET /packages row (and `packages` of GET /printers/{id}). */
export interface CreditPackageRow {
  id: string;
  tier_id: string;
  code: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  kind: 'standard' | 'promotional' | 'bundle' | string;
  seconds: number;
  price_iqd: number;
  min_quantity: number;
  max_quantity: number;
  max_per_customer: number | null;
  /** Null: the hours never expire. Otherwise stated to the customer before purchase. */
  expires_after_days: number | null;
  /** JSON text: material a bundle grants with its hours, `[{variant_id, qty, value_iqd}]`. */
  bundle_json: string;
  valid_from: string | null;
  valid_until: string | null;
  sort: number;
}

/** GET /printers/{id}/availability. */
export interface PrinterAvailability {
  printer_model_id: string;
  machines_total: number;
  machines_active: number;
  /** Idle as the scheduler means it. */
  machines_idle: number;
  /** Active agent machines not heard from within the window, or that their agent cannot reach. */
  machines_offline: number;
  machines_in_maintenance: number;
  jobs_waiting: number;
}

export type CategoryKind = 'filament' | 'accessory' | 'tool';

/** GET /store/categories row. */
export interface StoreCategory {
  code: string;
  kind: CategoryKind | string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  buyback_enabled: number;
  buyback_rate_bps: number;
  storable: number;
  sort: number;
}

export interface PriceTier {
  variant_id: string;
  mode: 'pack' | 'bracket';
  min_qty: number;
  /** `pack`: the price of exactly `min_qty`. */
  pack_price_iqd: number | null;
  /** `bracket`: thousandths of a dinar per base unit from `min_qty` up. */
  unit_price_milli_iqd: number | null;
}

/** GET /store/products row, as the server sends it. */
export interface StoreProductRow {
  id: string;
  product_id: string;
  sku: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  color_name: string;
  color_hex: string;
  diameter_um: number | null;
  unit_code: string;
  min_purchase_qty: number;
  purchase_step_qty: number;
  max_purchase_qty: number;
  max_per_customer_qty: number | null;
  /** JSON text: `["inventory","delivery","project"]`. */
  fulfillment_modes_json: string;
  category_code: string;
  brand: string;
  material: string | null;
  grade: string | null;
  product_name_ar: string;
  product_name_en: string;
  product_name_ckb: string;
  /** JSON text. */
  tags_json: string;
  /** On the workshop's shelf and free to sell (on hand − held − allocated), never below 0. */
  sellable_qty: number;
  price_tiers: PriceTier[];
}

export type UnitDimension = 'mass' | 'count' | 'set' | 'length';

/** GET /units row. */
export interface UnitRow {
  code: string;
  dimension: UnitDimension;
  base_code: string;
  factor_to_base: number;
  is_base: number;
  label_ar: string;
  label_en: string;
  label_ckb: string;
}

// ------------------------------------------------------------------ pricing, quotes, orders

export type FulfillmentMode = 'inventory' | 'delivery' | 'project';

export type QuoteLineInput =
  | { kind: 'credit_package'; package_id: string; quantity?: number }
  | { kind: 'credit_hours'; tier_id: string; seconds: number }
  | { kind: 'material'; variant_id: string; quantity: number; unit?: string; fulfillment?: FulfillmentMode; project_id?: string };

export interface QuoteRequest {
  lines: QuoteLineInput[];
  coupon?: string;
}

export interface BundleItem {
  variant_id: string;
  qty: number;
  value_iqd: number;
}

export interface PricedLine {
  line_no: number;
  kind: 'credit_package' | 'credit_hours' | 'material';
  tier_id: string | null;
  package_id: string | null;
  variant_id: string | null;
  category_code: string | null;
  quantity: number;
  seconds: number;
  base_price_iqd: number;
  discount_iqd: number;
  final_price_iqd: number;
  fulfillment: 'credits' | FulfillmentMode;
  project_id: string | null;
  expires_after_days: number | null;
  bundle: BundleItem[];
  breakdown: Record<string, unknown>;
  stock: { available: boolean; sellable_qty: number } | null;
}

/** POST /pricing/quote (nothing stored). */
export interface PricedQuote {
  lines: PricedLine[];
  subtotal_iqd: number;
  discount_iqd: number;
  total_iqd: number;
  promotions: Array<{ id: string; code: string | null; discount_iqd: number }>;
  orderable: boolean;
  problems: Array<{ line_no: number; code: string }>;
}

/** POST /quotes (stored, expiring). */
export interface StoredQuote extends PricedQuote {
  quote_id: string;
  expires_at: string;
  created_at: string;
}

/** GET /quotes/{id}. */
export interface QuoteView extends StoredQuote {
  status: 'open' | 'ordered' | 'expired';
}

export type PaymentProvider = 'manual' | 'gateway' | 'dev' | 'levonis_wallet';

export interface DeliveryAddress {
  recipient_name: string;
  phone: string;
  /** One of the eighteen governorates (the server normalises and refuses others). */
  governorate: string;
  city: string;
  address_line: string;
  notes?: string;
}

export interface OrderRequest {
  quote_id: string;
  /** Default `manual`. */
  payment_method?: PaymentProvider;
  /** Required when a line is delivered. */
  delivery_address?: DeliveryAddress;
}

/** What the customer is told to do next, per payment adapter (worker/lib/printCloud/payments.ts). */
export interface PaymentInstructions {
  provider: PaymentProvider;
  action: 'pay_at_workshop' | 'redirect_to_processor' | 'dev_confirm' | 'not_connected' | string;
  reference: string;
  amount_iqd: number;
  messages?: Tri;
  development_only?: boolean;
}

export type OrderStatus = 'awaiting_payment' | 'fulfilled' | 'cancelled' | 'expired' | 'refunded' | 'partially_refunded';

/** POST /orders. */
export interface OrderCreated {
  order_id: string;
  status: OrderStatus;
  total_iqd: number;
  subtotal_iqd: number;
  discount_iqd: number;
  shipping_fee_iqd: number;
  payment_method: PaymentProvider;
  stock_hold_expires_at: string;
  lines: Array<{
    line_no: number;
    kind: string;
    quantity: number;
    seconds: number;
    final_price_iqd: number;
    fulfillment: string;
    variant_id: string | null;
    package_id: string | null;
    tier_id: string | null;
  }>;
  payment: PaymentInstructions;
  /** True when this answer is the stored first answer to the same Idempotency-Key. */
  replayed: boolean;
}

/** GET /orders row. */
export interface OrderSummary {
  id: string;
  kind: 'purchase' | 'shipping';
  status: OrderStatus;
  total_iqd: number;
  paid_iqd: number;
  refunded_iqd: number;
  payment_method: PaymentProvider;
  stock_hold_expires_at: string;
  created_at: string;
  paid_at: string | null;
}

export interface OrderLine {
  id: string;
  order_id: string;
  line_no: number;
  kind: 'credit_package' | 'credit_hours' | 'material' | 'shipping_fee';
  tier_id: string | null;
  package_id: string | null;
  variant_id: string | null;
  quantity: number;
  seconds: number;
  final_price_iqd: number;
  refunded_iqd: number;
  fulfillment: 'credits' | 'inventory' | 'delivery' | 'project' | 'fee';
  project_id: string | null;
  expires_after_days: number | null;
  breakdown_json: string;
  breakdown: Record<string, unknown>;
}

/** GET /orders/{id}. */
export interface OrderDetail {
  id: string;
  user_id: string;
  quote_id: string | null;
  kind: 'purchase' | 'shipping';
  status: OrderStatus;
  subtotal_iqd: number;
  discount_iqd: number;
  total_iqd: number;
  paid_iqd: number;
  refunded_iqd: number;
  payment_method: PaymentProvider;
  promotion_ids_json: string;
  promotion_ids: string[];
  delivery_address_json: string | null;
  delivery_address: DeliveryAddress | null;
  shipment_id: string | null;
  stock_hold_expires_at: string;
  created_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at?: string | null;
  updated_at?: string;
  lines: OrderLine[];
  payments: Array<{ id: string; provider: PaymentProvider; amount_iqd: number; status: 'pending' | 'confirmed' | 'rejected'; created_at: string; confirmed_at: string | null }>;
  refunds: Array<{ id: string; order_line_id: string | null; amount_iqd: number; quantity: number; reason: string; method: string; status: string; created_at: string }>;
}

/** POST /orders/{id}/cancel. */
export interface OrderCancelled {
  order_id: string;
  status: 'cancelled';
}

/** POST /orders/{id}/dev-pay — DEVELOPMENT ONLY. */
export interface DevPayResult {
  outcome?: string;
  development_only: true;
  [key: string]: unknown;
}

// ------------------------------------------------------------------ the Levonis wallet (contract-wallet.md)

/** GET /me/wallet. */
export interface WalletSummary {
  /** False only when the owner switched wallet payments off. */
  connected: boolean;
  /** The same dinar figure the Levonis wallet page shows. */
  available_iqd: number;
  /** The platform's official IQD per USD, or null. */
  exchange_rate: number | null;
}

/** POST /orders/{id}/pay/wallet. */
export interface WalletPayment {
  order_id: string;
  status: 'paid';
  provider: 'levonis_wallet';
  amount_iqd: number;
  charged_usd_cents: number;
  exchange_rate: number;
  wallet_tx_id: string;
}

// ------------------------------------------------------------------ the customer's balances

export interface CreditTierBalance {
  tier_id: string;
  code: string;
  name: Tri;
  available_seconds: number;
  reserved_seconds: number;
  consumed_seconds: number;
  available: HoursMinutes;
  reserved: HoursMinutes;
  consumed: HoursMinutes;
}

/** One purchase lot of hours (the customer's own payment, never a workshop cost). */
export interface CreditLot {
  id: string;
  tier_id: string;
  source: string;
  seconds_total: number;
  seconds_remaining: number;
  seconds_held: number;
  paid_iqd: number;
  expires_at: string | null;
  created_at: string;
  order_line_id: string | null;
}

/** GET /me/credits (and `credits` of the dashboard). */
export interface CreditsSummary {
  tiers: CreditTierBalance[];
  /** The 100 most recent lots. */
  purchases: CreditLot[];
}

/** GET /me/credits/ledger row. */
export interface CreditLedgerEntry {
  id: string;
  tier_id: string;
  entry_type: string;
  delta_available: number;
  delta_reserved: number;
  delta_consumed: number;
  job_id: string | null;
  order_id: string | null;
  value_iqd: number | null;
  note: string | null;
  created_at: string;
}

/** GET /me/credits/reservations row. */
export interface CreditReservation {
  id: string;
  tier_id: string;
  job_id: string;
  seconds_reserved: number;
  seconds_consumed: number;
  seconds_released: number;
  state: 'active' | 'settled' | 'released' | string;
  created_at: string;
  settled_at: string | null;
}

export interface ConvertRequest {
  from_tier_id: string;
  to_tier_id: string;
  /** At least 60. */
  seconds: number;
}

/** POST /me/credits/convert. */
export interface ConvertResult {
  converted_seconds: number;
  received_seconds: number;
  from_tier_id: string;
  to_tier_id: string;
  replayed: boolean;
}

/** GET /me/printers row: a printer MODEL the customer holds hours for — not a machine they own. */
export interface MyPrinterModel {
  printer_model_id: string;
  code: string;
  brand: string;
  model_name: string;
  available_seconds: number;
  reserved_seconds: number;
  /** Machines of the model in service. */
  compatible_machines: number;
  /** Machines that can take work now (the scheduler's test). */
  idle_machines: number;
}

/** GET /me/inventory row. */
export interface InventoryBalance {
  account_id: string;
  variant_id: string;
  sku: string;
  unit_code: string;
  available_qty: number;
  reserved_qty: number;
  consumed_qty: number;
  low_stock_alert_qty: number | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  name: Tri;
  color_name: string;
  color_hex: string;
  product_id: string;
  category_code: string;
  category_kind: CategoryKind | string;
  material: string | null;
  brand: string;
  /** What the customer paid for the units still in their lots. */
  remaining_value_iqd: number;
}

/** GET /me/inventory/ledger row. */
export interface InventoryLedgerEntry {
  id: string;
  variant_id: string;
  entry_type: string;
  delta_available: number;
  delta_reserved: number;
  delta_consumed: number;
  ref_type: string | null;
  ref_id: string | null;
  value_iqd: number | null;
  note: string | null;
  created_at: string;
}

/** PATCH /me/inventory/{variantId}/alert. */
export interface InventoryAlert {
  variant_id: string;
  low_stock_alert_qty: number | null;
}

/** POST /me/inventory/top-up-quote. `quantity` 0 and `quote` null: already at or above the target. */
export interface TopUpQuote {
  owned_qty: number;
  target_qty: number;
  quantity: number;
  balance_after_qty?: number;
  quote: StoredQuote | null;
}

/** GET /me/inventory/reorder-suggestions row. */
export interface ReorderSuggestion {
  variant_id: string;
  unit_code: string;
  needed_qty: number;
  owned_qty: number;
  shortfall_qty: number;
  suggested_purchase_qty: number;
}

/** GET /me/transactions row. `ledger` names the history it came from. */
export interface TransactionRow {
  ledger: 'credits' | 'inventory' | 'orders' | 'refunds' | 'buybacks' | 'shipments';
  entry_type: string;
  subject_id: string | null;
  delta_available: number;
  delta_reserved: number;
  delta_consumed: number;
  value_iqd: number | null;
  ref_id: string | null;
  id: string;
  created_at: string;
}

export interface TransactionPage {
  items: TransactionRow[];
  /** The cursor of the next page («time~ledger~id»), or null at the end. */
  next_before: string | null;
}

// ------------------------------------------------------------------ files, imports, projects

export type FileStatus = 'uploaded' | 'processing' | 'ready' | 'rejected' | 'failed';

/** GET /files row (and `files.files` of the dashboard). */
export interface ModelFileSummary {
  id: string;
  original_name: string;
  extension: string;
  size_bytes: number;
  status: FileStatus;
  rejection_code: string | null;
  source: 'upload' | 'url_import';
  size_x_um: number | null;
  size_y_um: number | null;
  size_z_um: number | null;
  created_at: string;
}

/** GET /files/{id}: measured only once the background analysis has run (`geometry` null before). */
export interface ModelFileView {
  id: string;
  original_name: string;
  extension: string;
  format: string;
  size_bytes: number;
  content_sha256: string;
  status: FileStatus;
  rejection_code: string | null;
  source: 'upload' | 'url_import';
  import_id: string | null;
  created_at: string;
  deleted: boolean;
  geometry: {
    unit: 'mm';
    unit_source: string | null;
    dimensions_mm: { x: number; y: number; z: number } | null;
    bbox_min_mm: unknown;
    bbox_max_mm: unknown;
    volume_mm3: number | null;
    surface_area_mm2: number | null;
    triangle_count: number | null;
    shell_count: number | null;
    watertight: boolean | null;
    overhang_ratio: number | null;
    warnings: string[];
    title: string | null;
    suggested_material: string | null;
    suggested_colors: string[];
  } | null;
  printer_compatibility: Array<{ printer_model_id: string; code: string; as_oriented: boolean; any_orientation: boolean }>;
}

/** POST /files. */
export interface FileUploaded {
  file_id: string;
  status: 'uploaded';
  format: string;
  size_bytes: number;
  sha256: string;
}

/** DELETE /files/{id}. */
export interface FileDeleted {
  file_id: string;
  deleted: true;
}

/** POST /files/{id}/download-link: a five-minute signed path (relative to this host). */
export interface FileDownloadLink {
  url: string;
  expires_at: string;
}

/**
 * `link_saved` means ONLY the link was kept — no file was imported and the
 * customer must upload one. Never shown as an import.
 */
export type ImportStatus = 'pending' | 'link_saved' | 'file_imported' | 'failed' | 'rejected';

/** POST /imports (202). */
export interface ImportStarted {
  import_id: string;
  status: 'pending';
  provider: string;
  external_id: string;
  canonical_url: string;
}

/** GET /imports row. */
export interface ImportSummary {
  id: string;
  url: string;
  provider: string;
  status: ImportStatus;
  error_code: string | null;
  file_id: string | null;
  license: string;
  attribution: string;
  created_at: string;
}

/** GET /imports/{id}: the row, its log, and whether a FILE was imported. */
export interface ImportView {
  id: string;
  user_id: string;
  url: string;
  canonical_url: string;
  provider: string;
  external_id: string;
  status: ImportStatus;
  metadata: Record<string, unknown>;
  license: string;
  attribution: string;
  file_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  file_imported: boolean;
  logs: Array<{ level: 'info' | 'warning' | 'error'; code: string; detail_json: string; created_at: string }>;
}

export const PROJECT_TYPES = ['generic', 'keychain', 'medal', 'magnetic', 'nfc', 'led', 'nameplate', 'storage', 'holder', 'figure', 'mechanical'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Print settings (worker/lib/printCloud/projects.ts). Unknown keys are refused by the server. */
export interface PrintSettings {
  layer_height_um: number;
  infill_percent: number;
  supports: 'none' | 'auto' | 'tree' | 'normal';
  nozzle_um: number;
  walls: number;
  brim: boolean;
  plate_type: string;
  orientation: 'as_uploaded' | 'auto';
  /** Pause at these layers (magnet / NFC insertion by an operator). */
  pause_at_layers: number[];
  notes: string;
}

/** GET /projects row. */
export interface ProjectSummary {
  id: string;
  name: string;
  project_type: ProjectType | string;
  status: 'active' | 'archived';
  updated_at: string;
}

export interface ProjectRequest {
  name?: string;
  description?: string;
  project_type?: ProjectType;
  status?: 'active' | 'archived';
  settings?: Partial<PrintSettings>;
}

export interface MaterialAssignment {
  part?: string;
  variant_id: string;
}

export interface ProjectModelRequest {
  file_id?: string;
  import_id?: string;
  name?: string;
  quantity?: number;
  transform?: Record<string, unknown>;
  material_assignments?: MaterialAssignment[];
  tags?: string[];
}

export interface ProjectModel {
  id: string;
  project_id: string;
  user_id: string;
  file_id: string | null;
  import_id: string | null;
  name: string;
  quantity: number;
  transform_json: string;
  material_assignments_json: string;
  tags_json: string;
  transform: Record<string, unknown>;
  material_assignments: MaterialAssignment[];
  tags: string[];
  created_at: string;
  updated_at: string;
  file_status: FileStatus | null;
  size_x_um: number | null;
  size_y_um: number | null;
  size_z_um: number | null;
  original_name: string | null;
  import_status: ImportStatus | null;
}

export interface PlateItem {
  id: string;
  plate_id: string;
  project_model_id: string;
  instance_no: number;
  x_um: number;
  y_um: number;
  rotation_z_mdeg: number;
  scale_ppm: number;
  variant_id: string | null;
}

export interface PlateIssue {
  code: string;
  [key: string]: unknown;
}

export interface Plate {
  id: string;
  project_id: string;
  user_id: string;
  printer_model_id: string;
  label: string;
  /** `arranged`: produced by the named algorithm (`bbox_shelf_v1`) — an arrangement, not an optimisation claim. */
  arrangement: 'manual' | 'arranged';
  algorithm: string;
  spacing_um: number;
  valid: number;
  issues_json: string;
  issues: PlateIssue[];
  items: PlateItem[];
  created_at: string;
  updated_at: string;
}

/** GET /projects/{id} (and PATCH answers). */
export interface ProjectView {
  id: string;
  user_id: string;
  name: string;
  description: string;
  project_type: ProjectType | string;
  status: 'active' | 'archived';
  settings_json: string;
  settings: PrintSettings;
  duplicated_from: string | null;
  created_at: string;
  updated_at: string;
  models: ProjectModel[];
  plates: Plate[];
  jobs: Array<{ id: string; title: string; status: JobStatus; printer_model_id: string; plate_id: string | null; copies: number; created_at: string; updated_at: string }>;
}

export interface PlateRequest {
  printer_model_id: string;
  label?: string;
  spacing_um?: number;
  /** True: the server arranges `instances` (or every model × its quantity). */
  arrange?: boolean;
  instances?: Array<{ project_model_id: string; count?: number }>;
  placements?: Array<{ project_model_id: string; x_um: number; y_um: number; rotation_z_mdeg?: number; scale_ppm?: number; variant_id?: string }>;
}

/** POST /projects/{id}/plates. */
export interface PlateCreated {
  plate_id: string;
  valid: boolean;
  issues: PlateIssue[];
  arrangement: 'manual' | 'arranged';
  algorithm: string;
  placed: number;
  unplaced: string[];
}

/** GET /profiles row. */
export interface PrintProfile {
  id: string;
  name: string;
  settings: PrintSettings;
  updated_at: string;
}

export interface ProfileRequest {
  name: string;
  settings?: Partial<PrintSettings>;
}

/** GET /projects/{id}/accessory-suggestions row. */
export interface AccessorySuggestion {
  recommendation_id: string;
  variant_id: string;
  suggested_qty: number;
  owned_qty: number;
  shortfall_qty: number;
  status: 'suggested' | 'accepted' | 'rejected' | string;
  needs_pause_at_layer: boolean;
  operator_note: Tri;
  reason: { method: 'lexical_rule'; matches: Array<Record<string, unknown>> };
}

export interface RecommendationDecision {
  status: 'accepted' | 'rejected';
  qty?: number;
}

/** GET /projects/{id}/printer-recommendations. */
export interface PrinterRecommendations {
  models: Array<{
    printer_model_id: string;
    code: string;
    name: string;
    compatible: boolean;
    reasons: string[];
    credit: {
      tier_id: string;
      available_seconds: number;
      /** Only from a MEASURED estimate for this very model; null otherwise. */
      estimated_seconds: number | null;
      estimated_cost_iqd: number | null;
      basis: 'needs_estimate_for_this_model' | 'measured_estimate' | string;
      enough_credit: boolean | null;
    };
    quality_rank: number;
    jobs_ahead_on_model: number;
  }>;
  best: {
    lowest_cost: string | null;
    best_quality: string | null;
    shortest_queue: string | null;
    most_credit_available: string | null;
  };
  note: string;
}

// ------------------------------------------------------------------ jobs and the queue

export const JOB_STATUSES = [
  'draft',
  'uploaded',
  'analyzing',
  'ready',
  'awaiting_confirmation',
  'confirmed',
  'queued',
  'preparing',
  'printing',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'reprint_requested',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job as the dashboard and GET /jobs list it. */
export interface JobSummary {
  id: string;
  title: string;
  status: JobStatus;
  printer_model_id: string;
  created_at: string;
  updated_at: string;
}

/** GET /jobs (and `jobs` of the dashboard): grouped by where they are. */
export interface JobGroups {
  /** preparing, printing, paused */
  current: JobSummary[];
  /** confirmed (awaiting the workshop's approval), queued */
  queued: JobSummary[];
  /** draft, uploaded, analyzing, ready, awaiting_confirmation */
  in_preparation: JobSummary[];
  completed: JobSummary[];
  /** failed, reprint_requested */
  failed: JobSummary[];
  cancelled: JobSummary[];
}

export interface JobRequirement {
  variant_id: string;
  kind: 'filament' | 'accessory';
  qty: number;
}

export interface EstimateMaterial {
  variant_id: string;
  model_grams: number;
  support_grams: number;
  purge_grams: number;
}

/** A job's estimate: from the workshop's slicer or an operator — never a platform guess. */
export interface JobEstimate {
  id: string;
  job_id: string;
  slicing_request_id: string | null;
  provenance: 'slicer' | 'operator';
  slicer_name: string;
  slicer_version: string;
  printer_profile: string;
  duration_seconds: number;
  layer_count: number | null;
  model_grams: number;
  support_grams: number;
  purge_grams: number;
  color_changes: number;
  compatible: number;
  warnings: string[];
  materials: EstimateMaterial[];
  created_at: string;
}

export type MachineState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'error' | 'offline';

/** The assigned printer's last reading — `live` only when fresh AND about this job; `stale` past the window. */
export interface JobTelemetry {
  machine_state: MachineState;
  job_id: string | null;
  progress_permille: number | null;
  layer: number | null;
  total_layers: number | null;
  remaining_seconds: number | null;
  nozzle_temp_dc: number | null;
  bed_temp_dc: number | null;
  received_at: string;
  stale: boolean;
  live: boolean;
  age_seconds: number;
}

export interface JobEvent {
  from_status: JobStatus | null;
  to_status: JobStatus;
  event: string;
  actor_type: 'customer' | 'operator' | 'admin' | 'agent' | 'system';
  detail: Record<string, unknown>;
  created_at: string;
}

/** GET /jobs/{id}. */
export interface JobView {
  id: string;
  project_id: string;
  plate_id: string | null;
  printer_model_id: string;
  tier_id: string;
  title: string;
  status: JobStatus;
  settings: PrintSettings;
  copies: number;
  priority: number;
  needs_operator_approval: boolean;
  depends_on_job_id: string | null;
  parent_job_id: string | null;
  operator_instructions: unknown[];
  confirmation_expires_at: string | null;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  billable_seconds: number | null;
  printed_seconds: number | null;
  estimate: JobEstimate | null;
  requirements: JobRequirement[];
  reservations: {
    credits: { id: string; seconds_reserved: number; seconds_consumed: number; seconds_released: number; state: string } | null;
    materials: Array<{ variant_id: string; qty_reserved: number; qty_consumed: number; qty_released: number; state: string }>;
  };
  printer: { printer_id: string; name: string; assigned_at: string } | null;
  /** Null when no machine is assigned or it never reported. */
  telemetry: JobTelemetry | null;
  failure: {
    id: string;
    reason_code: string;
    responsible: 'workshop' | 'customer' | 'model' | 'undetermined';
    status: string;
    policy: string;
    billable_seconds: number | null;
    reprint_job_id: string | null;
    created_at: string;
    resolved_at: string | null;
  } | null;
  events: JobEvent[];
  created_at: string;
  updated_at: string;
}

export interface JobRequest {
  project_id: string;
  printer_model_id: string;
  plate_id?: string;
  title?: string;
  settings?: Partial<PrintSettings>;
  profile_id?: string;
  copies?: number;
  accessories?: Array<{ variant_id: string; qty: number }>;
  depends_on_job_id?: string;
}

/** POST /jobs. */
export interface JobCreated {
  job_id: string;
  status: JobStatus;
}

export interface JobEditRequest {
  settings?: Partial<PrintSettings>;
  copies?: number;
  accessories?: Array<{ variant_id: string; qty: number }>;
}

/** POST /jobs/{id}/analyze (202): `awaiting_slicer` when no slicer is connected — the job waits, nothing is guessed. */
export interface AnalysisRequested {
  job_id: string;
  status: 'analyzing';
  slicing_request_id: string;
  slicer: 'queued' | 'awaiting_slicer';
}

/** GET /jobs/{id}/projection: what confirming would do to the balances. */
export interface JobProjection {
  estimate: {
    id: string;
    provenance: 'slicer' | 'operator';
    duration_seconds: number;
    layer_count: number | null;
    model_grams: number;
    support_grams: number;
    purge_grams: number;
    color_changes: number;
    warnings: string[];
  };
  credits: {
    tier_id: string;
    required_seconds: number;
    available_seconds: number;
    remaining_after_seconds: number;
    sufficient: boolean;
    shortfall_seconds: number;
  };
  materials: Array<{
    variant_id: string;
    kind: 'filament' | 'accessory';
    required: number;
    available: number;
    remaining_after: number;
    sufficient: boolean;
    shortfall: number;
  }>;
  sufficient: boolean;
}

/** POST /jobs/{id}/review. */
export interface JobReviewed extends JobProjection {
  status: 'awaiting_confirmation';
  confirmation_expires_at: string;
}

/** POST /jobs/{id}/confirm. `confirmed`: waiting for the workshop's approval; `queued`: in the queue. */
export interface JobConfirmed {
  job_id: string;
  status: 'confirmed' | 'queued';
  reserved_seconds: number;
  reserved_materials: JobRequirement[];
  replayed: boolean;
}

/** POST /jobs/{id}/cancel. */
export interface JobCancelled {
  job_id: string;
  status: 'cancelled';
  reservations_released: boolean;
}

/** POST /jobs/{id}/requests (202): recorded for an operator, never executed directly. */
export interface JobRequestRecorded {
  job_id: string;
  request: 'pause' | 'cancel' | 'note';
  status: 'recorded_for_operator';
}

/** POST /jobs/{id}/reschedule. */
export interface JobRescheduled {
  job_id: string;
  not_before: string | null;
}

export type QueueBasis = 'simulated' | 'no_compatible_printer' | 'waiting_for_dependency' | 'dependency_cannot_complete';

/** One of the customer's queued jobs, with its SIMULATED start and end (an estimate, never a promise). */
export interface QueueEstimate {
  job_id: string;
  position: number;
  estimated_start_at: string | null;
  estimated_end_at: string | null;
  printer_id: string | null;
  basis: QueueBasis;
}

/** GET /queue. */
export interface QueueAnswer {
  jobs: QueueEstimate[];
  note: string;
}

// ------------------------------------------------------------------ fulfilment and buyback

export type ShipmentStatus = 'awaiting_payment' | 'preparing' | 'ready_for_pickup' | 'shipped' | 'delivered' | 'picked_up' | 'cancelled';

export interface ShipmentRequest {
  kind: 'pickup' | 'delivery';
  /** Completed prints. */
  job_ids?: string[];
  /** Owned material to hand over. */
  items?: Array<{ variant_id: string; qty: number }>;
  delivery_address?: DeliveryAddress;
  packaging?: string;
  payment_method?: Exclude<PaymentProvider, 'levonis_wallet'>;
}

/** POST /shipments. A delivery with a fee is a separate shipping order (`fee_order_id`). */
export interface ShipmentCreated {
  shipment_id: string;
  status: ShipmentStatus;
  fee_iqd: number;
  fee_order_id: string | null;
  payment: PaymentInstructions | null;
  replayed: boolean;
}

/** GET /shipments row. */
export interface ShipmentSummary {
  id: string;
  kind: 'pickup' | 'delivery';
  status: ShipmentStatus;
  fee_iqd: number;
  fee_order_id: string | null;
  tracking_ref: string;
  created_at: string;
}

/** GET /shipments/{id}. */
export interface ShipmentView extends ShipmentSummary {
  user_id: string;
  address: DeliveryAddress | null;
  packaging: string;
  carrier: string;
  notes: string;
  updated_at: string;
  closed_at: string | null;
  items: Array<Record<string, unknown>>;
}

/** POST /shipments/{id}/cancel. */
export interface ShipmentStatusChange {
  shipment_id: string;
  status: ShipmentStatus;
}

/** POST /buybacks/quote: valued from the customer's own purchase lots. */
export interface BuybackQuote {
  variant_id: string;
  qty: number;
  unit_code: string;
  rate_bps: number;
  purchase_value_iqd: number;
  estimated_value_iqd: number;
  eligible_qty: number;
  lots: Array<{ lot_id: string; qty: number; purchase_value_iqd: number }>;
}

/** POST /buybacks (201). */
export interface BuybackRequested extends BuybackQuote {
  buyback_id: string;
  status: 'requested';
}

/** GET /buybacks row. */
export interface BuybackSummary {
  id: string;
  variant_id: string;
  qty: number;
  rate_bps: number;
  estimated_value_iqd: number;
  final_value_iqd: number | null;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  payout_status: 'none' | 'pending' | 'paid';
  created_at: string;
  decided_at: string | null;
}

/** POST /buybacks/{id}/cancel. */
export interface BuybackCancelled {
  buyback_id: string;
  status: 'cancelled';
}

// ------------------------------------------------------------------ the dashboard

export interface DashboardFiles {
  files: ModelFileSummary[];
  imports: ImportSummary[];
  projects: ProjectSummary[];
  profiles: PrintProfile[];
}

/** GET /me/dashboard. */
export interface Dashboard {
  credits: CreditsSummary;
  printers: MyPrinterModel[];
  inventory: InventoryBalance[];
  jobs: JobGroups;
  files: DashboardFiles;
}

// ------------------------------------------------------------------ parsed forms (api.ts)

/** A printer model with its JSON text parsed and its flags as booleans. */
export interface PrinterModel {
  id: string;
  code: string;
  brand: string;
  model_name: string;
  tier_id: string;
  tier_code: string;
  tier_name: Tri;
  build_mm: { x: number; y: number; z: number };
  nozzle_options_um: number[];
  extruder_config: ExtruderConfig | string;
  ams_systems: string[];
  max_colors: number;
  supported_materials: string[];
  max_nozzle_temp_c: number | null;
  max_bed_temp_c: number | null;
  enclosed: boolean;
  camera: boolean;
  quality_rank: number;
  spec: Record<string, unknown>;
  machines_active: number;
  machines_idle: number;
}

export interface CreditPackage extends Omit<CreditPackageRow, 'bundle_json' | 'name_ar' | 'name_en' | 'name_ckb'> {
  name: Tri;
  bundle: BundleItem[];
}

/** GET /printers/{id}: the model and the packages of its class. */
export interface PrinterModelDetail extends PrinterModel {
  packages: CreditPackage[];
}

export interface StoreProduct extends Omit<StoreProductRow, 'fulfillment_modes_json' | 'tags_json' | 'name_ar' | 'name_en' | 'name_ckb' | 'product_name_ar' | 'product_name_en' | 'product_name_ckb'> {
  name: Tri;
  product_name: Tri;
  fulfillment_modes: FulfillmentMode[];
  tags: string[];
}
