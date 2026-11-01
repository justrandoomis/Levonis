/**
 * «التسعير التقديري» — THE OWNER'S ESTIMATES WORKSPACE, ITS WIRE
 * (docs/SMART_PRICING.md §3.4–§3.9, §4.8–§4.9, §7; DECISIONS rows 278–282).
 *
 * Every call of the workspace, the Links tab and the product form's banner
 * goes to /api/admin/pricing — the two owner routers mounted inside it:
 *
 *   /supplier-prices  worker/routes/adminSupplierPrices.ts (snapshots, matching,
 *                     review, manual entry, lookup, one store page, links)
 *   /estimates        worker/routes/adminPriceEstimates.ts (switches, types,
 *                     compute, apply, the stored previews, confirm)
 *
 * Both sit behind requireCostRead (the owner only; everyone else hears 403
 * COST_ACCESS_DENIED) and every write behind assertCostWrite. On a database
 * without migration 0218 they answer 503 PRICE_ESTIMATES_NOT_INSTALLED (the
 * links reads answer an empty list).
 *
 * THE BROWSER NEVER PRICES. Every figure here is the server's: decimal TEXT
 * for supplier prices, profits and volumes, whole numbers for grams,
 * millimetres and dinars. What the owner types travels as TEXT too (the
 * server refuses a binary float). A supplier link is the server's builder
 * output (packages/catalog/src/supplierPrices/links.ts) or null — the client
 * never builds one; `safeSupplierHref` only refuses anything that is not one
 * of the three fixed https origins.
 *
 * The workspace's own request and response types live here (§12 WP12), not
 * in src/lib/api.ts. Nothing is kept in browser storage: cost data never
 * persists in the browser.
 */
import { ApiError, api, type RequestOptions } from '../../lib/api';

export const ESTIMATE_PRICING_API = '/api/admin/pricing';
export const SUPPLIER_PRICES_API = `${ESTIMATE_PRICING_API}/supplier-prices`;
export const ESTIMATES_API = `${ESTIMATE_PRICING_API}/estimates`;

// ---------------------------------------------------------------- shared names

export type SupplierSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us';
export type SupplierCurrency = 'CNY' | 'EUR' | 'USD';
export const SUPPLIER_SOURCES: readonly SupplierSource[] = ['tmall_cn', 'bambu_eu', 'bambu_us'];
export const SUPPLIER_CURRENCIES: readonly SupplierCurrency[] = ['CNY', 'EUR', 'USD'];
/** The one currency each source sells in (the 0218 snapshot CHECK). */
export const SOURCE_CURRENCY: Readonly<Record<SupplierSource, SupplierCurrency>> = { tmall_cn: 'CNY', bambu_eu: 'EUR', bambu_us: 'USD' };

export type EstimateRoute = 'land' | 'sea' | 'air';
export type EstimateSourcing = 'EU_STORE_EUR' | 'CHINA_CNY';
export const ESTIMATE_ROUTES: readonly EstimateRoute[] = ['sea', 'air', 'land'];
export const ESTIMATE_SOURCINGS: readonly EstimateSourcing[] = ['EU_STORE_EUR', 'CHINA_CNY'];
export type ProductEstimateState = 'candidate' | 'estimated' | 'confirmed' | 'paused';

/** `[A-Za-z0-9_:.-]{1,80}` — a product id as the owner routes accept it. */
export const isEstimateProductId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(v);

const enc = encodeURIComponent;

// ---------------------------------------------------------------- the links (§3.9)

export type LinkState = 'auto' | 'confirmed' | 'suggested' | 'rejected' | 'manual';
export type LinkSource = SupplierSource | 'typed' | 'store_page';

/** One supplier fact of one SKU (worker/lib/supplierPrices/links.ts `SupplierLink`). */
export interface SupplierLink {
  source: LinkSource;
  state: LinkState;
  /** The Tmall item id or the store handle (null for the owner's own price). */
  item_key: string | null;
  /** The Tmall SKU id or the store variant id. */
  sku_key: string | null;
  title: string | null;
  name_en: string | null;
  options: Record<string, string> | null;
  options_en: Record<string, string> | null;
  codes: string[];
  /** Decimal text in `currency`; null when the key left the catalogue. */
  price: string | null;
  currency: SupplierCurrency | null;
  /** The words printed beside the price (Tmall: 优惠前), never a figure. */
  price_label: string | null;
  captured_on: string | null;
  quantity: number | null;
  /** https only, built by the server from validated ids; null when an id fails its grammar. */
  item_url: string | null;
  sku_url: string | null;
  /** A matched key absent from its source's current complete snapshot (EST_SOURCE_ITEM_MISSING). */
  missing: boolean;
  match_confidence: string | null;
  match_method: string | null;
  match_reasons: string[];
  units_per_offer: number;
  decided_at: string | null;
  /** The owner's note on his own price. */
  note: string;
}

export interface LinkSku {
  combo_key: string;
  labels: { ar: string; en: string; ckb: string };
  supplier_prices: SupplierLink[];
}

/** The version tokens a decision carries back (PUT /matches, PUT /manual). */
export interface LinkVersions {
  matches: string;
  manual: string;
}

export interface ProductLinks {
  product_id: string;
  name: string;
  names: { ar: string; en: string; ckb: string };
  versions: LinkVersions;
  skus: LinkSku[];
}

export interface LinksPage {
  products: ProductLinks[];
  next_cursor: string | null;
}

export interface ProductLinksAnswer extends LinksPage {
  /** The tokens even with no link yet: «تحديث السعر» opens the manual entry on any product. */
  versions: LinkVersions;
}

export function fetchLinks(q: { q?: string; source?: SupplierSource | ''; cursor?: string | null }, opts?: RequestOptions): Promise<LinksPage> {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.source) p.set('source', q.source);
  if (q.cursor) p.set('cursor', q.cursor);
  const qs = p.toString() ? `?${p.toString()}` : '';
  return api.get<LinksPage>(`${SUPPLIER_PRICES_API}/links${qs}`, opts);
}

export function fetchProductLinks(productId: string, opts?: RequestOptions): Promise<ProductLinksAnswer> {
  return api.get<ProductLinksAnswer>(`${SUPPLIER_PRICES_API}/links/${enc(productId)}`, opts);
}

/**
 * The only addresses a supplier link may hold: the builder's three fixed
 * https origins. The server already builds them from validated ids; this is
 * the second net — anything else (a `javascript:` address, another host, an
 * http link) is shown as text, never as a link. Nothing is repaired.
 */
const SUPPLIER_ORIGINS = ['https://detail.tmall.com/item.htm?id=', 'https://eu.store.bambulab.com/products/', 'https://us.store.bambulab.com/products/'];
export function safeSupplierHref(url: string | null | undefined): string | null {
  // Whitespace, quotes, angle brackets, a backslash or a backtick (written as escapes: no quote in the source).
  if (typeof url !== 'string' || url.length > 600 || /[\s\u0022\u0027<>\\\u0060]/.test(url)) return null;
  return SUPPLIER_ORIGINS.some((o) => url.startsWith(o)) ? url : null;
}

/** Which store an item link opens (for its words): Tmall, the EU store or the US store. */
export function linkStore(source: LinkSource): SupplierSource | null {
  return source === 'tmall_cn' || source === 'bambu_eu' || source === 'bambu_us' ? source : null;
}

// ---------------------------------------------------------------- snapshots (§3.4)

export type SnapshotState = 'loading' | 'complete' | 'superseded' | 'discarded';

export interface SnapshotDto {
  id: string;
  source: SupplierSource;
  currency: string;
  snapshot_price_basis: string;
  capture: string;
  captured_on: string;
  captured_by: string;
  file_sha256: string;
  item_count: number;
  sku_count: number;
  state: SnapshotState | string;
  created_at: string;
  completed_at: string | null;
  age_days: number | null;
  stored_items: number;
  stored_skus: number;
  matched_items: number;
  unmatched_items: number;
}

export interface SnapshotCreateBody {
  source: SupplierSource;
  currency: SupplierCurrency;
  price_basis: string;
  capture: string;
  captured_on: string;
  captured_by: string;
  file_sha256: string;
  item_count: number;
}

export interface UploadChunkAnswer {
  chunk: { items: number; skus: number };
  totals: { items: number; skus: number };
}

export function fetchSnapshots(opts?: RequestOptions): Promise<{ snapshots: SnapshotDto[] }> {
  return api.get<{ snapshots: SnapshotDto[] }>(`${SUPPLIER_PRICES_API}/snapshots`, opts);
}

export function createSnapshot(body: SnapshotCreateBody): Promise<{ snapshot: SnapshotDto }> {
  return api.post<{ snapshot: SnapshotDto }>(`${SUPPLIER_PRICES_API}/snapshots`, body);
}

/** One chunk (≤ 50 items, ≤ 256 KB). `offset` is the first item's index in the file, so a refusal names the file's position. */
export function uploadSnapshotItems(id: string, items: readonly unknown[], offset: number, opts?: RequestOptions): Promise<UploadChunkAnswer> {
  return api.post<UploadChunkAnswer>(`${SUPPLIER_PRICES_API}/snapshots/${enc(id)}/items`, { items, offset }, { mascot: 'silent', ...opts });
}

export function completeSnapshot(id: string, body: { item_count: number; sku_count: number; file_sha256: string }): Promise<{ snapshot: SnapshotDto }> {
  return api.post<{ snapshot: SnapshotDto }>(`${SUPPLIER_PRICES_API}/snapshots/${enc(id)}/complete`, body);
}

export function discardSnapshot(id: string): Promise<{ snapshot: SnapshotDto }> {
  return api.post<{ snapshot: SnapshotDto }>(`${SUPPLIER_PRICES_API}/snapshots/${enc(id)}/discard`, {});
}

// ---------------------------------------------------------------- matching and review (§3.5, §3.6)

export interface MatchProductSummary {
  product_id: string;
  confirmed: number;
  suggested: number;
  carried: number;
  pruned: number;
  missing: Array<{ combo_key: string; source: SupplierSource; item_key: string; sku_key: string }>;
  refused: Array<{ source: SupplierSource; item_key: string; reason: string }>;
  skipped: 'SKU_GRID_TOO_LARGE' | null;
}

export interface MatchPageAnswer {
  products: MatchProductSummary[];
  next_cursor: string | null;
}

export function runMatchPage(body: { cursor: string } | { product_ids: string[] }): Promise<MatchPageAnswer> {
  return api.post<MatchPageAnswer>(`${SUPPLIER_PRICES_API}/match`, body, { mascot: 'silent' });
}

export type ReviewState = 'suggested' | 'auto' | 'rejected' | 'missing';
export const REVIEW_STATES: readonly ReviewState[] = ['suggested', 'auto', 'rejected', 'missing'];

export interface MatchesPage {
  state: ReviewState;
  products: ProductLinks[];
  next_cursor: string | null;
}

export function fetchMatches(state: ReviewState, cursor: string | null, opts?: RequestOptions): Promise<MatchesPage> {
  const p = new URLSearchParams({ state });
  if (cursor) p.set('cursor', cursor);
  return api.get<MatchesPage>(`${SUPPLIER_PRICES_API}/matches?${p.toString()}`, opts);
}

/** One decision: confirm or re-point a SKU (`sku_key`), or reject an item for it (`sku_key: null`). */
export interface MatchDecisionBody {
  combo_key: string;
  source: SupplierSource;
  item_key: string;
  sku_key: string | null;
  /** Only when the owner divides a pack (EST_UNITS_DIVIDED); absent means one unit. */
  units_per_offer?: number;
}

export function decideMatches(productId: string, body: { version: string; skus: MatchDecisionBody[] }): Promise<{ product: ProductLinks | null }> {
  return api.put<{ product: ProductLinks | null }>(`${SUPPLIER_PRICES_API}/matches/${enc(productId)}`, body);
}

/** The owner's typed price of one SKU; `amount: null` removes it. */
export interface ManualEntryBody {
  combo_key: string;
  amount: string | null;
  currency: SupplierCurrency | null;
  note: string;
}

export function setManualPrices(productId: string, body: { version: string; skus: ManualEntryBody[] }): Promise<{ product: ProductLinks | null }> {
  return api.put<{ product: ProductLinks | null }>(`${SUPPLIER_PRICES_API}/manual/${enc(productId)}`, body);
}

// ---------------------------------------------------------------- lookup and one store page (§3.6)

export interface LookupProduct {
  product_id: string;
  name: string;
  combo_key: string;
  state: 'auto' | 'confirmed' | 'suggested';
}

export interface LookupSku {
  sku_key: string;
  options: Record<string, string>;
  options_en: Record<string, string>;
  price: string;
  price_label: string;
  quantity: number | null;
  sku_code: string;
  sku_url: string | null;
  highlight: boolean;
  products: LookupProduct[];
}

export interface LookupItem {
  source: SupplierSource;
  snapshot_id: string;
  captured_on: string;
  currency: SupplierCurrency;
  item_key: string;
  title: string;
  name_en: string;
  category: string;
  item_url: string | null;
  skus: LookupSku[];
}

export function lookupSupplier(q: string, opts?: RequestOptions): Promise<{ query: string; supplier_prices: LookupItem[] }> {
  return api.get<{ query: string; supplier_prices: LookupItem[] }>(`${SUPPLIER_PRICES_API}/lookup?q=${enc(q)}`, opts);
}

export interface StoreOffer {
  sku_key: string;
  name: string;
  /** What a save writes: on a sale page, the regular (struck-through) price. */
  price: string;
  /** Only on a sale page: the sale price the page shows, never saved. */
  sale_price?: string;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
}

export interface StorePageRead {
  requested_source: 'bambu_eu' | 'bambu_us';
  handle: string;
  variant_id: string | null;
  item_url: string | null;
  sku_url: string | null;
  source: 'bambu_eu' | 'bambu_us';
  host: string;
  redirected: boolean;
  offers: StoreOffer[];
  chosen_sku_key: string | null;
}

/** One owner-initiated read of one EU or US store page; with `save`, the chosen variant's price becomes his price of those SKUs. */
export function readStorePage(body: { url: string; save?: { product_id: string; combo_keys: string[] } }): Promise<{ saved: number; supplier_prices: StorePageRead }> {
  return api.post<{ saved: number; supplier_prices: StorePageRead }>(`${SUPPLIER_PRICES_API}/read-store-page`, body, { timeoutMs: 30000 });
}

/** The save's refusal when the page gives the named variant several prices: 502 PRICE_ESTIMATE_STORE_PAGE_UNREADABLE, `details.reason` 'copies_disagree'. */
export const isStoreCopiesDisagree = (e: unknown): boolean => e instanceof ApiError && e.code === 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE' && e.details?.reason === 'copies_disagree';

/** A read whose named variant is on the page with several prices in one currency (its copies disagree): none was chosen. */
export const storeCopiesDisagree = (read: StorePageRead): boolean => read.variant_id !== null && read.chosen_sku_key === null && read.offers.some((o) => o.sku_key === read.variant_id);

// ---------------------------------------------------------------- the switches and the types (§4.1, §7)

export interface EstimateControl {
  apply_enabled: boolean;
  ordering_enabled: boolean;
  version: number;
  updated_by: string;
  updated_at: string;
}

export interface ControlAnswer {
  control: EstimateControl;
  /** The published purchase policy carries the estimated-price clause (the «apply» switch can be turned on). */
  policy_ready: boolean;
}

export function fetchControl(opts?: RequestOptions): Promise<ControlAnswer> {
  return api.get<ControlAnswer>(`${ESTIMATES_API}/control`, opts);
}

export function setControl(body: { version: number; apply_enabled?: boolean; ordering_enabled?: boolean }): Promise<ControlAnswer> {
  return api.put<ControlAnswer>(`${ESTIMATES_API}/control`, body);
}

/** `price_estimate_types` as the server answers it, with its warnings (TypeAnswer). */
export interface EstimateType {
  key: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sourcing: EstimateSourcing;
  route: EstimateRoute;
  allow_air: boolean;
  us_reference_allowed: boolean;
  default_weight_g: number | null;
  default_length_mm: number | null;
  default_width_mm: number | null;
  default_height_mm: number | null;
  default_cbm: string | null;
  additional_cost_iqd: number | null;
  min_profit_usd: string | null;
  stale_after_days: number;
  version: number;
  updated_by: string;
  updated_at: string;
  warnings: string[];
}

/** PUT /types/:key: the version read and the fields the owner changed (null clears a figure). */
export type TypeUpdateBody = { version: number } & Partial<
  Pick<
    EstimateType,
    | 'route'
    | 'allow_air'
    | 'us_reference_allowed'
    | 'default_weight_g'
    | 'default_length_mm'
    | 'default_width_mm'
    | 'default_height_mm'
    | 'default_cbm'
    | 'additional_cost_iqd'
    | 'min_profit_usd'
    | 'stale_after_days'
    | 'name_ar'
    | 'name_en'
    | 'name_ckb'
  >
>;

export interface TypeCreateBody {
  key: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sourcing: EstimateSourcing;
  route: EstimateRoute;
  allow_air?: boolean;
  us_reference_allowed?: boolean;
}

export interface MeasureSuggestion {
  key: string;
  count: number;
  weight_g: number | null;
  box: [number, number, number] | null;
  cbm: string | null;
}

export function fetchTypes(opts?: RequestOptions): Promise<{ types: EstimateType[] }> {
  return api.get<{ types: EstimateType[] }>(`${ESTIMATES_API}/types`, opts);
}

export function createType(body: TypeCreateBody): Promise<{ type: EstimateType }> {
  return api.post<{ type: EstimateType }>(`${ESTIMATES_API}/types`, body);
}

export function updateType(key: string, body: TypeUpdateBody): Promise<{ type: EstimateType }> {
  return api.put<{ type: EstimateType }>(`${ESTIMATES_API}/types/${enc(key)}`, body);
}

export function suggestType(key: string, opts?: RequestOptions): Promise<{ suggestion: MeasureSuggestion }> {
  return api.get<{ suggestion: MeasureSuggestion }>(`${ESTIMATES_API}/types/${enc(key)}/suggest`, opts);
}

// ---------------------------------------------------------------- compute, apply, the stored previews (§4.6–§4.9)

/** A flag of the estimator (§4.6): a CODE with the SKUs or fields it is about — never a value. */
export interface EstimateFlagEntry {
  code: string;
  combo_keys?: string[];
  fields?: string[];
  /** When the stored list was too long for its column, the number of SKUs instead of their keys. */
  count?: number;
}

export type MeasureSource = 'model' | 'colour' | 'product' | 'type_default' | 'owner' | 'none';
export type LinePriceSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'typed' | 'store_page' | 'none';

/** One SKU × route of a preview — owner-only. */
export interface EstimateLine {
  combo_key: string;
  channel: string;
  source: LinePriceSource;
  supplier_amount: string | null;
  supplier_currency: SupplierCurrency | null;
  measure_source: MeasureSource;
  flags: string[];
  /** R, the replacement cost in IQD (the engine's own). */
  est_cost_iqd: number | null;
  /** D, the estimated price an apply publishes. */
  est_price_iqd: number | null;
  /** What customers are charged today, or null. */
  published_price_iqd: number | null;
  change_pct: string | null;
  large: boolean;
}

/** What compute and apply answer per product (`EstimatePreview`). */
export interface EstimatePreview {
  product_id: string;
  name: string;
  state: ProductEstimateState;
  label: boolean;
  type: string | null;
  type_source: string;
  sourcing: EstimateSourcing | null;
  route: EstimateRoute | null;
  currency: 'EUR' | 'CNY' | null;
  structure: 'ready' | 'prepare' | 'owner' | null;
  measure_basis: string;
  flags: EstimateFlagEntry[];
  blocking: boolean;
  blocked_by: string[];
  preview_hash: string | null;
  computed_at: string;
  lines: EstimateLine[];
  version: number;
}

/** A product's stored estimate as the lists read it (`StoredEstimate`). */
export interface StoredEstimate {
  product_id: string;
  name: string;
  slug: string;
  label: boolean;
  state: ProductEstimateState;
  type: string | null;
  type_source: string;
  sourcing_override: EstimateSourcing | null;
  route_override: EstimateRoute | null;
  measure_basis: string;
  flags: EstimateFlagEntry[];
  preview_hash: string | null;
  computed_at: string | null;
  applied_at: string | null;
  confirmed_at: string | null;
  version: number;
  lines: EstimateLine[];
}

export type EstimateListFilter = 'all' | 'candidate' | 'ready' | 'estimated' | 'flags' | 'refresh' | 'paused' | 'confirmed';

export interface EstimatesPage {
  state: EstimateListFilter;
  products: StoredEstimate[];
  next_cursor: string | null;
}

export interface ComputeAnswer {
  products: EstimatePreview[];
  deferred: string[];
  next_cursor: string | null;
  spent: number;
}

export interface ApplyItem {
  product_id: string;
  preview_hash: string;
  confirm_large_change?: boolean;
}

export type ApplyOutcome =
  | { product_id: string; outcome: 'applied'; preview: EstimatePreview }
  | { product_id: string; outcome: 'already' }
  | { product_id: string; outcome: 'refused'; code: string; details?: Record<string, unknown> };

export interface ApplyAnswer {
  results: ApplyOutcome[];
  /** Items not attempted (the invocation budget): send them again as `cursor`. */
  cursor: ApplyItem[] | null;
  spent: number;
}

export interface ConfirmAnswer {
  product_id: string;
  confirmed: 'whole' | 'skus';
  firm: string[];
  version: number;
}

export interface EstimateSettingsAnswer {
  product_id: string;
  state: ProductEstimateState;
  type_key: string | null;
  type_source: string;
  sourcing_override: EstimateSourcing | null;
  route_override: EstimateRoute | null;
  version: number;
}

export function computeEstimates(body: { cursor: string } | { product_ids: string[] }): Promise<ComputeAnswer> {
  return api.post<ComputeAnswer>(`${ESTIMATES_API}/compute`, body, { mascot: 'silent', timeoutMs: 60000 });
}

/** Up to five products, each in its own batch; `cursor` resends the items a previous answer deferred. */
export function applyEstimates(body: { items: ApplyItem[] } | { cursor: ApplyItem[] }): Promise<ApplyAnswer> {
  return api.post<ApplyAnswer>(`${ESTIMATES_API}/apply`, body, { timeoutMs: 60000 });
}

export function fetchEstimates(state: EstimateListFilter, cursor: string | null, opts?: RequestOptions): Promise<EstimatesPage> {
  const p = new URLSearchParams({ state });
  if (cursor) p.set('cursor', cursor);
  return api.get<EstimatesPage>(`${ESTIMATES_API}/products?${p.toString()}`, opts);
}

export function fetchEstimate(productId: string, opts?: RequestOptions): Promise<{ product: StoredEstimate }> {
  return api.get<{ product: StoredEstimate }>(`${ESTIMATES_API}/products/${enc(productId)}`, opts);
}

/** Pause or resume (`state`), the owner's type, sourcing and route overrides — fenced on the version read (0: no row yet). */
export function setEstimateProduct(
  productId: string,
  body: { version: number; state?: 'paused' | 'active'; type_key?: string | null; sourcing_override?: EstimateSourcing | null; route_override?: EstimateRoute | null }
): Promise<{ settings: EstimateSettingsAnswer }> {
  return api.put<{ settings: EstimateSettingsAnswer }>(`${ESTIMATES_API}/products/${enc(productId)}`, body);
}

/** Removes the label (no `combo_keys`, or every SKU) or makes the named SKUs firm; every open soft flag must be accepted by name. */
export function confirmEstimate(productId: string, body: { version: number; accept_flags: string[]; combo_keys?: string[] }): Promise<ConfirmAnswer> {
  return api.post<ConfirmAnswer>(`${ESTIMATES_API}/products/${enc(productId)}/confirm`, body);
}

// ---------------------------------------------------------------- addresses inside the admin

/** The product's editor, opened on section ٣ «الأسعار» (src/components/adminProducts/editLink.ts). Null for an id the link refuses. */
export function productEditorHref(productId: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(productId) ? `/admin?tab=products&edit=${enc(productId)}&section=3` : null;
}

export type WorkspaceTab = 'snapshots' | 'types' | 'review' | 'ready' | 'estimated' | 'flags' | 'refresh' | 'links';
export const WORKSPACE_TABS: readonly WorkspaceTab[] = ['links', 'review', 'ready', 'estimated', 'flags', 'refresh', 'snapshots', 'types'];
export const isWorkspaceTab = (v: unknown): v is WorkspaceTab => typeof v === 'string' && (WORKSPACE_TABS as readonly string[]).includes(v);

/** The workspace, opened on a tab — and on one product (the product form's banner). */
export function workspaceHref(tab: WorkspaceTab, productId?: string | null): string {
  const p = new URLSearchParams({ tab: 'pricing', view: 'estimates', etab: tab });
  if (productId && isEstimateProductId(productId)) p.set('product', productId);
  return `/admin?${p.toString()}`;
}
