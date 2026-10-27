/**
 * THE PRINT CLOUD CLIENT — one typed function per customer door of
 * `/api/print-cloud/v1` (worker/routes/printCloud.ts; the OpenAPI table is
 * worker/lib/printCloud/openapi.ts), plus the Levonis-wallet pair of the
 * wallet contract (GET /me/wallet, POST /orders/{id}/pay/wallet).
 * tests/printCloudUiShell.test.ts holds this file to that table: a customer
 * route with no function here, or a function naming a route that does not
 * exist, fails it.
 *
 * Every call goes through the house client (src/lib/api.ts: cookie session,
 * deadline, `ApiError` with `status`, `code`, `details`) and answers the
 * envelope's `data`. A refusal is an `ApiError` whose `details.messages`
 * carries the server's own words in the three languages; `cloudErrorText`
 * picks the reader's.
 *
 * MONEY DOORS TAKE AN IDEMPOTENCY KEY: placing an order, paying it from the
 * wallet, confirming a job (it reserves hours and grams), requesting a
 * shipment, converting hours, requesting a sell-back (it reserves the grams).
 * The CALLER makes the key once per intent — when
 * the customer opens the confirmation, not when they press — sends the same
 * key on every retry of that intent, and makes a new one only for a new
 * intent (after a success, or when what is sent changes: the same key with a
 * different body is refused IDEMPOTENCY_KEY_REUSED). A replay answers the
 * first answer, `replayed: true`. `useIdempotencyKey()` is that rule as a hook.
 */
import { useCallback, useState } from 'react';
import { api, ApiError, type RequestOptions } from '../lib/api';
import type { Language } from '../translations';
import { common } from './strings/common';
import { tx } from './text';
import type * as T from './types';

/** Where the customer API is mounted, on this host. */
export const CLOUD_API = '/api/print-cloud/v1';

type Envelope<D> = { success?: boolean; data: D };
type Query = Record<string, string | number | null | undefined>;

const enc = encodeURIComponent;

/** `?a=1&b=x` from the values that are set; '' when none is. */
export function qs(params: Query): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const get = async <D>(path: string, opts?: RequestOptions): Promise<D> => (await api.get<Envelope<D>>(`${CLOUD_API}${path}`, opts)).data;
const post = async <D>(path: string, body: unknown = {}, opts?: RequestOptions): Promise<D> =>
  (await api.post<Envelope<D>>(`${CLOUD_API}${path}`, body, opts)).data;
const patch = async <D>(path: string, body: unknown, opts?: RequestOptions): Promise<D> => (await api.patch<Envelope<D>>(`${CLOUD_API}${path}`, body, opts)).data;
const put = async <D>(path: string, body: unknown, opts?: RequestOptions): Promise<D> => (await api.put<Envelope<D>>(`${CLOUD_API}${path}`, body, opts)).data;
const del = async <D>(path: string, opts?: RequestOptions): Promise<D> => (await api.delete<Envelope<D>>(`${CLOUD_API}${path}`, opts)).data;

/** The options of a money door: the caller's own, plus its Idempotency-Key. */
function keyed(idempotencyKey: string, opts?: RequestOptions): RequestOptions {
  return { ...opts, headers: { ...opts?.headers, 'Idempotency-Key': idempotencyKey } };
}

// ------------------------------------------------------------------ idempotency

/** The server's own rule for a key (worker/lib/printCloud/db.ts `validIdempotencyKey`). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

/** A fresh key for ONE intent: `pc:<uuid>` (or `<scope>:<uuid>`). */
export function newIdempotencyKey(scope = 'pc'): string {
  const c = globalThis.crypto;
  let id: string;
  if (typeof c?.randomUUID === 'function') id = c.randomUUID();
  else {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const safeScope = scope.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'pc';
  return `${safeScope}:${id}`;
}

/**
 * One key per intent, kept across re-renders and retries:
 *
 *   const intent = useIdempotencyKey('order');
 *   await createOrder({ quote_id }, intent.key);   // a retry sends the same key
 *   intent.renew();                                // after success, or when the body changes
 */
export function useIdempotencyKey(scope = 'pc'): { key: string; renew: () => void } {
  const [key, setKey] = useState(() => newIdempotencyKey(scope));
  const renew = useCallback(() => setKey(newIdempotencyKey(scope)), [scope]);
  return { key, renew };
}

// ------------------------------------------------------------------ refusals

/** The refusal's stable code (`PRINT_CLOUD_DISABLED`, `INSUFFICIENT_CREDIT`…), or null for anything else. */
export function cloudErrorCode(e: unknown): string | null {
  return e instanceof ApiError && typeof e.code === 'string' && e.code ? e.code : null;
}

/**
 * The words to show for a failed call, in the reader's language: the
 * server's own `details.messages[lang]` when the refusal carries them (every
 * Print Cloud refusal does — worker/lib/printCloud/errors.ts), else the
 * error's message (the house client already words network and server
 * failures in the reader's language), else a plain «something went wrong».
 */
export function cloudErrorText(e: unknown, lang: Language): string {
  if (e instanceof ApiError) {
    const messages = (e.details as { messages?: unknown } | undefined)?.messages;
    if (messages && typeof messages === 'object') {
      const own = (messages as Record<string, unknown>)[lang];
      if (typeof own === 'string' && own.trim()) return own;
    }
  }
  if (e instanceof Error && e.message.trim()) return e.message;
  return tx(common.unknownError, lang);
}

// ------------------------------------------------------------------ parsing

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const stringList = (text: unknown): string[] => {
  const v = parseJson(text);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
const numberList = (text: unknown): number[] => {
  const v = parseJson(text);
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
};
const objectOf = (text: unknown): Record<string, unknown> => {
  const v = parseJson(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

/** A printer model row with its JSON text parsed and its 0/1 flags as booleans. */
export function toPrinterModel(r: T.PrinterModelRow): T.PrinterModel {
  return {
    id: r.id,
    code: r.code,
    brand: r.brand,
    model_name: r.model_name,
    tier_id: r.tier_id,
    tier_code: r.tier_code,
    tier_name: { ar: r.tier_name_ar, en: r.tier_name_en, ckb: r.tier_name_ckb },
    build_mm: { x: Number(r.build_x_mm), y: Number(r.build_y_mm), z: Number(r.build_z_mm) },
    nozzle_options_um: numberList(r.nozzle_options_um),
    extruder_config: r.extruder_config,
    ams_systems: stringList(r.ams_systems_json),
    max_colors: Number(r.max_colors),
    supported_materials: stringList(r.supported_materials_json),
    max_nozzle_temp_c: r.max_nozzle_temp_c ?? null,
    max_bed_temp_c: r.max_bed_temp_c ?? null,
    enclosed: !!r.enclosed,
    camera: !!r.camera,
    quality_rank: Number(r.quality_rank ?? 0),
    spec: objectOf(r.spec_json),
    machines_active: Number(r.machines_active ?? 0),
    machines_idle: Number(r.machines_idle ?? 0),
  };
}

/** A package row with its bundle parsed and its name as a `Tri`. */
export function toCreditPackage(r: T.CreditPackageRow): T.CreditPackage {
  const { bundle_json, name_ar, name_en, name_ckb, ...rest } = r;
  const raw = parseJson(bundle_json);
  const bundle = Array.isArray(raw)
    ? raw.filter(
        (b): b is T.BundleItem =>
          !!b && typeof b === 'object' && typeof (b as T.BundleItem).variant_id === 'string' && Number.isFinite((b as T.BundleItem).qty) && Number.isFinite((b as T.BundleItem).value_iqd)
      )
    : [];
  return { ...rest, name: { ar: name_ar, en: name_en, ckb: name_ckb }, bundle };
}

/** A store variant row with its JSON text parsed and its names as `Tri`s. */
export function toStoreProduct(r: T.StoreProductRow): T.StoreProduct {
  const { fulfillment_modes_json, tags_json, name_ar, name_en, name_ckb, product_name_ar, product_name_en, product_name_ckb, ...rest } = r;
  const modes = stringList(fulfillment_modes_json).filter((m): m is T.FulfillmentMode => m === 'inventory' || m === 'delivery' || m === 'project');
  return {
    ...rest,
    name: { ar: name_ar, en: name_en, ckb: name_ckb },
    product_name: { ar: product_name_ar, en: product_name_en, ckb: product_name_ckb },
    fulfillment_modes: modes,
    tags: stringList(tags_json),
  };
}

// ------------------------------------------------------------------ public

/** GET /openapi.json — the API's own description (not enveloped). */
export const getOpenApi = () => api.get<Record<string, unknown>>(`${CLOUD_API}/openapi.json`);

/** GET /status — installed, open, slicer, delivery and integrations. Answered even while closed. */
export const getStatus = (opts?: RequestOptions) => get<T.CloudStatus>('/status', opts);

/** GET /printers — every active printer model with its class and machine counts. */
export const listPrinters = async (opts?: RequestOptions) => (await get<T.PrinterModelRow[]>('/printers', opts)).map(toPrinterModel);

/** GET /printers/{id} — one model with the packages of its class. */
export async function getPrinter(id: string, opts?: RequestOptions): Promise<T.PrinterModelDetail> {
  const row = await get<T.PrinterModelRow & { packages: T.CreditPackageRow[] }>(`/printers/${enc(id)}`, opts);
  return { ...toPrinterModel(row), packages: (row.packages ?? []).map(toCreditPackage) };
}

/** GET /printers/{id}/availability — machines active, free now, offline, in maintenance; prints waiting. */
export const getPrinterAvailability = (id: string, opts?: RequestOptions) => get<T.PrinterAvailability>(`/printers/${enc(id)}/availability`, opts);

/** GET /packages — hour packages on sale now, optionally of one class. */
export const listPackages = async (tierId?: string, opts?: RequestOptions) => (await get<T.CreditPackageRow[]>(`/packages${qs({ tier_id: tierId })}`, opts)).map(toCreditPackage);

/** GET /store/categories. */
export const listStoreCategories = (opts?: RequestOptions) => get<T.StoreCategory[]>('/store/categories', opts);

/** GET /store/products — materials and accessories with price tiers and sellable stock (optionally one category). */
export const listStoreProducts = async (category?: string, opts?: RequestOptions) =>
  (await get<T.StoreProductRow[]>(`/store/products${qs({ category })}`, opts)).map(toStoreProduct);

/** GET /units — measurement units and their base units. */
export const listUnits = (opts?: RequestOptions) => get<T.UnitRow[]>('/units', opts);

/** POST /pricing/quote — prices lines without storing or reserving anything (signed in: the customer's own limits apply). */
export const priceQuote = (body: T.QuoteRequest, opts?: RequestOptions) => post<T.PricedQuote>('/pricing/quote', body, opts);

// POST /payments/webhook is the payment processor's signed callback, never the browser's: no function.

// ------------------------------------------------------------------ the customer's balances

/** GET /me/dashboard — credits, printers, inventory, jobs and files in one answer. */
export const getDashboard = (opts?: RequestOptions) => get<T.Dashboard>('/me/dashboard', opts);

/** GET /me/credits — hours by class and the purchase lots. */
export const getCredits = (opts?: RequestOptions) => get<T.CreditsSummary>('/me/credits', opts);

/**
 * GET /me/credits/ledger — newest first. The next page is EXACT with the last
 * row's `created_at` as `before` and its `id` as `before_id` (rows one batch
 * wrote at one instant are never skipped); `before` alone means «strictly
 * before that instant».
 */
export const listCreditLedger = (page: { before?: string; before_id?: string; limit?: number } = {}, opts?: RequestOptions) =>
  get<T.CreditLedgerEntry[]>(`/me/credits/ledger${qs(page)}`, opts);

/** GET /me/credits/reservations. */
export const listCreditReservations = (opts?: RequestOptions) => get<T.CreditReservation[]>('/me/credits/reservations', opts);

/** GET /me/credits/conversions — the conversions the workshop allows out of the customer's classes (enabled rules, with their ratio). */
export const listCreditConversions = (opts?: RequestOptions) => get<T.CreditConversionRule[]>('/me/credits/conversions', opts);

/** POST /me/credits/convert — MONEY DOOR: only under a rule the owner enabled. */
export const convertCredits = (body: T.ConvertRequest, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.ConvertResult>('/me/credits/convert', body, keyed(idempotencyKey, opts));

/** POST /me/credits/convert/quote — what the same body would give now, by the conversion's own plan; nothing is written. */
export const quoteCreditConversion = (body: T.ConvertRequest, opts?: RequestOptions) => post<T.ConvertQuote>('/me/credits/convert/quote', body, opts);

/** GET /me/printers — the printer models the customer holds hours for. */
export const listMyPrinters = (opts?: RequestOptions) => get<T.MyPrinterModel[]>('/me/printers', opts);

/** GET /me/inventory — the customer's own material at the workshop (optionally one category). */
export const listInventory = (category?: string, opts?: RequestOptions) => get<T.InventoryBalance[]>(`/me/inventory${qs({ category })}`, opts);

/** GET /me/inventory/ledger — newest first (optionally one variant), paged exactly like the credit ledger: `before` + `before_id`. */
export const listInventoryLedger = (page: { variant_id?: string; before?: string; before_id?: string; limit?: number } = {}, opts?: RequestOptions) =>
  get<T.InventoryLedgerEntry[]>(`/me/inventory/ledger${qs(page)}`, opts);

/** PATCH /me/inventory/{variantId}/alert — the low-balance threshold (null: the default). */
export const setInventoryAlert = (variantId: string, lowStockAlertQty: number | null, opts?: RequestOptions) =>
  patch<T.InventoryAlert>(`/me/inventory/${enc(variantId)}/alert`, { low_stock_alert_qty: lowStockAlertQty }, opts);

/** POST /me/inventory/top-up-quote — «top up to N» priced as a NEW purchase of the missing quantity (default 1 kg). */
export const inventoryTopUpQuote = (body: { variant_id: string; target_qty?: number; quantity?: number }, opts?: RequestOptions) =>
  post<T.TopUpQuote>('/me/inventory/top-up-quote', body, opts);

/** GET /me/inventory/reorder-suggestions — what pending jobs need beyond what is owned. */
export const listReorderSuggestions = (opts?: RequestOptions) => get<T.ReorderSuggestion[]>('/me/inventory/reorder-suggestions', opts);

/** GET /me/transactions — every movement, newest first; pass the previous page's `next_before`. */
export const listTransactions = (page: { before?: string; limit?: number } = {}, opts?: RequestOptions) =>
  get<T.TransactionPage>(`/me/transactions${qs(page)}`, opts);

// ------------------------------------------------------------------ quotes, orders, the wallet

/** POST /quotes — a stored quote that expires; an order is made only from a live one. */
export const createQuote = (body: T.QuoteRequest, opts?: RequestOptions) => post<T.StoredQuote>('/quotes', body, opts);

/** GET /quotes/{id}. */
export const getQuote = (id: string, opts?: RequestOptions) => get<T.QuoteView>(`/quotes/${enc(id)}`, opts);

/** POST /orders — MONEY DOOR: the order a quote becomes; holds the stock it needs. */
export const createOrder = (body: T.OrderRequest, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.OrderCreated>('/orders', body, keyed(idempotencyKey, opts));

/** GET /orders. */
export const listOrders = (opts?: RequestOptions) => get<T.OrderSummary[]>('/orders', opts);

/** GET /orders/{id} — lines, payments and refunds. */
export const getOrder = (id: string, opts?: RequestOptions) => get<T.OrderDetail>(`/orders/${enc(id)}`, opts);

/** POST /orders/{id}/cancel — an unpaid order; its holds are released. */
export const cancelOrder = (id: string, opts?: RequestOptions) => post<T.OrderCancelled>(`/orders/${enc(id)}/cancel`, {}, opts);

/**
 * POST /orders/{id}/dev-pay — DEVELOPMENT ONLY (PRINT_CLOUD_DEV_PAYMENTS=on on
 * a local Worker). A deployed Worker refuses it PAYMENT_ADAPTER_DISABLED; no
 * screen may offer it.
 */
export const devPayOrder = (id: string, body: { event_id?: string; amount_iqd?: number } = {}, opts?: RequestOptions) =>
  post<T.DevPayResult>(`/orders/${enc(id)}/dev-pay`, body, opts);

/** GET /me/wallet — the Levonis wallet's dinar balance, as the wallet page shows it. */
export const getWallet = (opts?: RequestOptions) => get<T.WalletSummary>('/me/wallet', opts);

/**
 * POST /orders/{id}/pay/wallet — MONEY DOOR: pays the order's whole total from
 * the Levonis wallet in one batch with its fulfilment. Refusals:
 * INSUFFICIENT_BALANCE (details `available_iqd`, `required_iqd`; nothing
 * debited), ORDER_NOT_PAYABLE, PAYMENT_ADAPTER_DISABLED.
 */
export const payOrderFromWallet = (id: string, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.WalletPayment>(`/orders/${enc(id)}/pay/wallet`, {}, keyed(idempotencyKey, opts));

// ------------------------------------------------------------------ files and imports

/** POST /files — an STL, 3MF or OBJ (multipart field `file`); the bytes must prove the format. */
export function uploadFile(file: Blob, name?: string, opts?: RequestOptions): Promise<T.FileUploaded> {
  const form = new FormData();
  form.append('file', file, name ?? (file as File).name ?? 'model');
  // A large model on a slow connection outlasts the default deadline.
  return post<T.FileUploaded>('/files', form, { timeoutMs: 180_000, ...opts });
}

/** GET /files. */
export const listFiles = (opts?: RequestOptions) => get<T.ModelFileSummary[]>('/files', opts);

/** The path GET /files/signed answers on: the bytes behind a link from `createFileDownloadLink`. */
export const signedFilePath = (token: string) => `${CLOUD_API}/files/signed${qs({ token })}`;

/** GET /files/{id} — status, geometry once measured, and which printer models it fits. */
export const getFile = (id: string, opts?: RequestOptions) => get<T.ModelFileView>(`/files/${enc(id)}`, opts);

/** DELETE /files/{id} — refused while a live job needs the file. */
export const deleteFile = (id: string, opts?: RequestOptions) => del<T.FileDeleted>(`/files/${enc(id)}`, opts);

/** The path GET /files/{id}/download streams the original from (for a link the browser follows). */
export const fileDownloadPath = (id: string) => `${CLOUD_API}/files/${enc(id)}/download`;

/** POST /files/{id}/download-link — a five-minute signed link. */
export const createFileDownloadLink = (id: string, opts?: RequestOptions) => post<T.FileDownloadLink>(`/files/${enc(id)}/download-link`, {}, opts);

/** POST /imports — a MakerWorld / Printables / Thingiverse link. `link_saved` later means only the link was kept. */
export const startImport = (url: string, opts?: RequestOptions) => post<T.ImportStarted>('/imports', { url }, opts);

/** GET /imports. */
export const listImports = (opts?: RequestOptions) => get<T.ImportSummary[]>('/imports', opts);

/** GET /imports/{id} — the import, its log, and `file_imported`. */
export const getImport = (id: string, opts?: RequestOptions) => get<T.ImportView>(`/imports/${enc(id)}`, opts);

// ------------------------------------------------------------------ projects, plates, profiles, recommendations

/** POST /projects. */
export const createProject = (body: T.ProjectRequest & { name: string }, opts?: RequestOptions) => post<{ project_id: string }>('/projects', body, opts);

/** GET /projects. */
export const listProjects = (opts?: RequestOptions) => get<T.ProjectSummary[]>('/projects', opts);

/** GET /projects/{id} — models, plates and jobs. */
export const getProject = (id: string, opts?: RequestOptions) => get<T.ProjectView>(`/projects/${enc(id)}`, opts);

/** PATCH /projects/{id} — answers the project as it now is. */
export const updateProject = (id: string, body: T.ProjectRequest, opts?: RequestOptions) => patch<T.ProjectView>(`/projects/${enc(id)}`, body, opts);

/** POST /projects/{id}/duplicate — print again without uploading again. */
export const duplicateProject = (id: string, opts?: RequestOptions) => post<{ project_id: string }>(`/projects/${enc(id)}/duplicate`, {}, opts);

/** POST /projects/{id}/models — a file or an import, with quantity and materials. */
export const addProjectModel = (projectId: string, body: T.ProjectModelRequest, opts?: RequestOptions) =>
  post<{ project_model_id: string }>(`/projects/${enc(projectId)}/models`, body, opts);

/** PATCH /projects/{id}/models/{modelId} — answers the project as it now is. */
export const updateProjectModel = (projectId: string, modelId: string, body: T.ProjectModelRequest, opts?: RequestOptions) =>
  patch<T.ProjectView>(`/projects/${enc(projectId)}/models/${enc(modelId)}`, body, opts);

/** POST /projects/{id}/plates — manual placements, or `arrange: true`. */
export const createPlate = (projectId: string, body: T.PlateRequest, opts?: RequestOptions) => post<T.PlateCreated>(`/projects/${enc(projectId)}/plates`, body, opts);

/** GET /projects/{id}/accessory-suggestions. */
export const listAccessorySuggestions = (projectId: string, opts?: RequestOptions) =>
  get<T.AccessorySuggestion[]>(`/projects/${enc(projectId)}/accessory-suggestions`, opts);

/** POST /recommendations/{id} — accept (optionally another quantity) or reject a suggestion. */
export const decideRecommendation = (id: string, body: T.RecommendationDecision, opts?: RequestOptions) =>
  post<{ recommendation_id: string }>(`/recommendations/${enc(id)}`, body, opts);

/** GET /projects/{id}/printer-recommendations — compared with reasons; cost only from a measured estimate. */
export const getPrinterRecommendations = (projectId: string, jobId?: string, opts?: RequestOptions) =>
  get<T.PrinterRecommendations>(`/projects/${enc(projectId)}/printer-recommendations${qs({ job_id: jobId })}`, opts);

/** GET /profiles. */
export const listProfiles = (opts?: RequestOptions) => get<T.PrintProfile[]>('/profiles', opts);

/** POST /profiles. */
export const createProfile = (body: T.ProfileRequest, opts?: RequestOptions) => post<{ profile_id: string }>('/profiles', body, opts);

/** PUT /profiles/{id}. */
export const replaceProfile = (id: string, body: T.ProfileRequest, opts?: RequestOptions) => put<{ profile_id: string }>(`/profiles/${enc(id)}`, body, opts);

// ------------------------------------------------------------------ jobs and the queue

/** POST /jobs. */
export const createJob = (body: T.JobRequest, opts?: RequestOptions) => post<T.JobCreated>('/jobs', body, opts);

/** GET /jobs — grouped: current, queued, in preparation, completed, failed, cancelled. */
export const listJobs = (opts?: RequestOptions) => get<T.JobGroups>('/jobs', opts);

/** GET /jobs/{id} — estimate, reservations, printer, telemetry (`live` / `stale`), events. */
export const getJob = (id: string, opts?: RequestOptions) => get<T.JobView>(`/jobs/${enc(id)}`, opts);

/** PATCH /jobs/{id} — settings changed: back to draft, the estimate invalidated. */
export const editJob = (id: string, body: T.JobEditRequest, opts?: RequestOptions) => patch<{ job_id: string; status: 'draft' }>(`/jobs/${enc(id)}`, body, opts);

/** POST /jobs/{id}/analyze — ask the slicer; `awaiting_slicer` when none is connected. */
export const requestJobAnalysis = (id: string, opts?: RequestOptions) => post<T.AnalysisRequested>(`/jobs/${enc(id)}/analyze`, {}, opts);

/** GET /jobs/{id}/projection — required against available hours and materials. */
export const getJobProjection = (id: string, opts?: RequestOptions) => get<T.JobProjection>(`/jobs/${enc(id)}/projection`, opts);

/** POST /jobs/{id}/review — ready → awaiting your confirmation, with the projection. */
export const reviewJob = (id: string, opts?: RequestOptions) => post<T.JobReviewed>(`/jobs/${enc(id)}/review`, {}, opts);

/** POST /jobs/{id}/confirm — MONEY DOOR: reserves the hours and every material; into the queue. */
export const confirmJob = (id: string, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.JobConfirmed>(`/jobs/${enc(id)}/confirm`, {}, keyed(idempotencyKey, opts));

/** POST /jobs/{id}/cancel — every reservation released once. */
export const cancelJob = (id: string, reason?: string, opts?: RequestOptions) =>
  post<T.JobCancelled>(`/jobs/${enc(id)}/cancel`, reason ? { reason } : {}, opts);

/** POST /jobs/{id}/requests — ask the workshop to pause or stop: recorded for an operator, never executed. */
export const sendJobRequest = (id: string, action: 'pause' | 'cancel' | 'note', message?: string, opts?: RequestOptions) =>
  post<T.JobRequestRecorded>(`/jobs/${enc(id)}/requests`, message ? { action, message } : { action }, opts);

/** POST /jobs/{id}/reschedule — hold a queued job until a time (null: no hold). */
export const rescheduleJob = (id: string, notBefore: string | null, opts?: RequestOptions) =>
  post<T.JobRescheduled>(`/jobs/${enc(id)}/reschedule`, { not_before: notBefore }, opts);

/** GET /queue — the customer's queued jobs with SIMULATED start and end times. */
export const getQueue = (opts?: RequestOptions) => get<T.QueueAnswer>('/queue', opts);

// ------------------------------------------------------------------ shipments and buybacks

/** POST /shipments — MONEY DOOR: pickup or delivery of finished prints and owned material. */
export const createShipment = (body: T.ShipmentRequest, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.ShipmentCreated>('/shipments', body, keyed(idempotencyKey, opts));

/** POST /shipments/quote — the fee, its rule, the start and what would leave, for the same body; the same refusals; nothing is written. */
export const quoteShipment = (body: T.ShipmentRequest, opts?: RequestOptions) => post<T.ShipmentQuote>('/shipments/quote', body, opts);

/** GET /shipments. */
export const listShipments = (opts?: RequestOptions) => get<T.ShipmentSummary[]>('/shipments', opts);

/** GET /shipments/{id}. */
export const getShipment = (id: string, opts?: RequestOptions) => get<T.ShipmentView>(`/shipments/${enc(id)}`, opts);

/** POST /shipments/{id}/cancel — before it leaves; material released. */
export const cancelShipment = (id: string, opts?: RequestOptions) => post<T.ShipmentStatusChange>(`/shipments/${enc(id)}/cancel`, {}, opts);

/** POST /buybacks/quote — what selling material back would pay, lot by lot. */
export const buybackQuote = (variantId: string, qty: number, opts?: RequestOptions) => post<T.BuybackQuote>('/buybacks/quote', { variant_id: variantId, qty }, opts);

/** POST /buybacks — MONEY DOOR: request a buyback (the units are reserved); a replay of the key answers the first request. */
export const requestBuyback = (variantId: string, qty: number, idempotencyKey: string, opts?: RequestOptions) =>
  post<T.BuybackRequested>('/buybacks', { variant_id: variantId, qty }, keyed(idempotencyKey, opts));

/** GET /buybacks. */
export const listBuybacks = (opts?: RequestOptions) => get<T.BuybackSummary[]>('/buybacks', opts);

/** POST /buybacks/{id}/cancel — a pending request; the units return once. */
export const cancelBuyback = (id: string, opts?: RequestOptions) => post<T.BuybackCancelled>(`/buybacks/${enc(id)}/cancel`, {}, opts);
