/**
 * LEVONIS PRINT CLOUD — the public and customer API, mounted at
 * /api/print-cloud/v1 (docs/PRINT_CLOUD.md; OpenAPI at /openapi.json).
 *
 * Every door: the host gate (main host, cloud.<root>, operator hosts — never a
 * merchant storefront), the installed gate (503 on a database without 0215),
 * the enabled gate (503 until the owner opens the service; admins may test).
 * Customer doors require a session and see ONLY the caller's own rows: an id
 * that belongs to someone else answers 404 exactly like one that does not
 * exist. Money-moving doors take an `Idempotency-Key`.
 *
 * The routes are thin: every rule lives in worker/lib/printCloud/*.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { jsonObject, requireAuth } from '../lib/http';
import { limitRoute } from '../lib/ratelimit';
import { mediaBucket } from '../lib/mediaStorage';
import { canViewCost } from '../lib/costAccess';
import { ADAPTERS } from '../lib/printCloud/adapters';
import { runPrintCloudTasks } from '../lib/printCloud/background';
import { buybackQuote, cancelBuyback, requestBuyback } from '../lib/printCloud/buyback';
import { categories, publicPackages, publicPrinterModels, publicStoreCatalog } from '../lib/printCloud/catalog';
import { activeReservationForJob, convertCredits, type ConversionRule } from '../lib/printCloud/credits';
import { idempotent, many, one, printCloudInstalled, runBatch } from '../lib/printCloud/db';
import { invalid, pcError } from '../lib/printCloud/errors';
import { fileView, liveJobsUsingFile, signFileToken, storeModelFile, validateUpload, verifyFileToken, type FileRow } from '../lib/printCloud/files';
import { cancelShipmentByCustomer, parseDeliveryRequest, planShipmentRequest, shipmentView } from '../lib/printCloud/fulfillment';
import { afterResponse, currentUser, customerActor, enabledGate, idempotencyKey, ok, pcGate, queryInt, requestConfig } from '../lib/printCloud/http';
import { startImport } from '../lib/printCloud/imports';
import { inventoryAccountId } from '../lib/printCloud/inventory';
import {
  cancelJob,
  createJob,
  editJob,
  jobEvent,
  jobView,
  loadJob,
  planConfirm,
  projection,
  requestAnalysis,
  reviewJob,
  type JobRow,
} from '../lib/printCloud/jobs';
import { confirmPayment, closeUnpaidOrder, createQuote, orderDetail, planOrderFromQuote, type OrderRow } from '../lib/printCloud/orders';
import { openApiDocument } from '../lib/printCloud/openapi';
import { PAYMENT_PROVIDERS, verifyGatewaySignature, type PaymentProvider } from '../lib/printCloud/payments';
import { parseQuoteLines, priceQuote, ownedQty, topUpQuantity } from '../lib/printCloud/pricing';
import { addProjectModel, createPlate, createProject, duplicateProject, projectView, saveProfile, updateProject, updateProjectModel } from '../lib/printCloud/projects';
import { accessorySuggestions, decideRecommendation, printerRecommendations } from '../lib/printCloud/recommendations';
import { machineReadySql, slicerAvailability, telemetryFresh } from '../lib/printCloud/printers';
import { estimateQueue, reschedule } from '../lib/printCloud/queue';
import { dashboardCredits, dashboardFiles, dashboardInventory, dashboardJobs, dashboardPrinters, transactions } from '../lib/printCloud/reports';
import { enqueueTask } from '../lib/printCloud/tasks';
import { sha256OfBytes } from '../lib/printCloud/files';
import { addSeconds, iso, optString, parseJson, reqInt, reqString } from '../lib/printCloud/util';
import { membershipTier } from '../lib/printCloud/adapters';

export const printCloudRoutes = new Hono<AppContext>();

printCloudRoutes.use('*', pcGate);

// ------------------------------------------------------------------ public

// The owner's copy also names the cost fields only the owner may send.
printCloudRoutes.get('/openapi.json', (c) => c.json(openApiDocument({ withCost: canViewCost(c.env, c.get('user')) })));

printCloudRoutes.get('/status', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, {
    installed: await printCloudInstalled(c.env.DB),
    enabled: config.enabled,
    // `connected` only for a slicer agent heard from within the staleness window — never for a token alone.
    slicer: await slicerAvailability(c.env.DB, config.telemetry_stale_seconds, new Date()),
    delivery: { enabled: config.delivery.enabled, pickup_enabled: config.delivery.pickup_enabled },
    integrations: ADAPTERS.map((a) => ({ name: a.name, connected: a.connected })),
  });
});

printCloudRoutes.use('*', enabledGate);

/** The scheduler's own test of a machine that can take work now: no other count of «idle» machines is shown. */
const machinesReady = async (c: Context<AppContext>) => machineReadySql((await requestConfig(c)).config.telemetry_stale_seconds, new Date());

printCloudRoutes.get('/printers', async (c) => ok(c, await publicPrinterModels(c.env.DB, await machinesReady(c))));

printCloudRoutes.get('/printers/:id', async (c) => {
  const models = await publicPrinterModels(c.env.DB, await machinesReady(c));
  const model = models.find((m) => m.id === c.req.param('id'));
  if (!model) throw pcError('NOT_FOUND');
  return ok(c, { ...model, packages: await publicPackages(c.env.DB, new Date(), String(model.tier_id)) });
});

printCloudRoutes.get('/printers/:id/availability', async (c) => {
  const db = c.env.DB;
  const model = await one<{ id: string }>(db, 'SELECT id FROM pc_printer_models WHERE id = ? AND active = 1', c.req.param('id'));
  if (!model) throw pcError('NOT_FOUND');
  const { config } = await requestConfig(c);
  const now = new Date();
  const ready = machineReadySql(config.telemetry_stale_seconds, now);
  const machines = await many<{ status: string; adapter: string; machine_state: string | null; received_at: string | null; ready: number }>(
    db,
    `SELECT p.status, p.adapter, t.machine_state, t.received_at, (${ready.sql}) AS ready
       FROM pc_printers p LEFT JOIN pc_printer_telemetry t ON t.printer_id = p.id WHERE p.model_id = ?`,
    ...ready.params,
    model.id
  );
  const queued = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pc_print_jobs WHERE printer_model_id = ? AND status = 'queued'", model.id);
  return ok(c, {
    printer_model_id: model.id,
    machines_total: machines.length,
    machines_active: machines.filter((m) => m.status === 'active').length,
    // Idle as the scheduler means it: a machine silent, unreachable, in error or running its own print is not available.
    machines_idle: machines.filter((m) => m.ready).length,
    // Active agent machines not heard from, or that their agent cannot reach.
    machines_offline: machines.filter(
      (m) => m.status === 'active' && m.adapter === 'agent' && (!telemetryFresh(m.received_at, config.telemetry_stale_seconds, now) || m.machine_state === 'offline')
    ).length,
    machines_in_maintenance: machines.filter((m) => m.status === 'maintenance').length,
    jobs_waiting: Number(queued?.n ?? 0),
  });
});

printCloudRoutes.get('/packages', async (c) => ok(c, await publicPackages(c.env.DB, new Date(), c.req.query('tier_id') ?? null)));
printCloudRoutes.get('/store/categories', async (c) => ok(c, await categories(c.env.DB)));
printCloudRoutes.get('/store/products', async (c) => ok(c, await publicStoreCatalog(c.env.DB, c.req.query('category') ?? null)));
printCloudRoutes.get('/units', async (c) => ok(c, await many(c.env.DB, 'SELECT code, dimension, base_code, factor_to_base, is_base, label_ar, label_en, label_ckb FROM pc_units ORDER BY dimension, factor_to_base')));

/** A price calculation for anyone (nothing stored, nothing reserved). Signed in, it applies the customer's own limits. */
printCloudRoutes.post('/pricing/quote', limitRoute('pc_price', 600), async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const user = c.get('user');
  const priced = await priceQuote(c.env.DB, parseQuoteLines(body.lines), {
    userId: user?.id ?? '',
    config,
    now: new Date(),
    coupon: typeof body.coupon === 'string' ? body.coupon : null,
    membership: user ? await membershipTier(c.env.DB, user.id) : null,
  });
  return ok(c, priced);
});

// ------------------------------------------------------------------ payments webhook (no session; signed)

printCloudRoutes.post('/payments/webhook', limitRoute('pc_webhook', 3000), async (c) => {
  const secret = c.env.PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) throw pcError('PAYMENT_ADAPTER_DISABLED', { provider: 'gateway' });
  const raw = await c.req.text();
  const now = new Date();
  if (!(await verifyGatewaySignature(secret, raw, c.req.header('X-PrintCloud-Signature'), now))) throw pcError('PAYMENT_SIGNATURE_INVALID');
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw invalid('body', 'json_required');
  }
  if (event.status !== 'succeeded') return ok(c, { outcome: 'ignored', reason: 'not_a_success_event' });
  const eventId = reqString(event.event_id, 'event_id', { max: 200 });
  const orderId = reqString(event.order_id, 'order_id', { max: 120 });
  const amount = reqInt(event.amount_iqd, 'amount_iqd', { min: 0, max: 10_000_000_000 });
  const result = await confirmPayment(c.env.DB, {
    provider: 'gateway',
    eventId,
    orderId,
    amountIqd: amount,
    actorId: 'system',
    payloadHash: await sha256OfBytes(new TextEncoder().encode(raw)),
    now,
  });
  return ok(c, result);
});

// ------------------------------------------------------------------ customer

const auth = new Hono<AppContext>();
auth.use('*', requireAuth);

auth.get('/me/dashboard', async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const ready = await machinesReady(c);
  const [credits, printers, inventory, jobs, files] = await Promise.all([
    dashboardCredits(db, user.id),
    dashboardPrinters(db, user.id, ready),
    dashboardInventory(db, user.id, null),
    dashboardJobs(db, user.id),
    dashboardFiles(db, user.id),
  ]);
  return ok(c, { credits, printers, inventory, jobs, files });
});

auth.get('/me/credits', async (c) => ok(c, await dashboardCredits(c.env.DB, currentUser(c).id)));

auth.get('/me/credits/ledger', async (c) => {
  const user = currentUser(c);
  const before = c.req.query('before') ?? '9999-12-31';
  const rows = await many(
    c.env.DB,
    `SELECT id, tier_id, entry_type, delta_available, delta_reserved, delta_consumed, job_id, order_id, value_iqd, note, created_at
       FROM pc_credit_ledger WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    user.id,
    before,
    queryInt(c, 'limit', 50, 1, 200)
  );
  return ok(c, rows);
});

auth.get('/me/credits/reservations', async (c) =>
  ok(
    c,
    await many(
      c.env.DB,
      'SELECT id, tier_id, job_id, seconds_reserved, seconds_consumed, seconds_released, state, created_at, settled_at FROM pc_credit_reservations WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      currentUser(c).id
    )
  )
);

/** Move hours between tiers — only under a rule the owner enabled, at the customer's explicit request. */
auth.post('/me/credits/convert', limitRoute('pc_write', 300), async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const from = reqString(body.from_tier_id, 'from_tier_id', { max: 120 });
  const to = reqString(body.to_tier_id, 'to_tier_id', { max: 120 });
  const seconds = reqInt(body.seconds, 'seconds', { min: 60, max: 100_000_000 });
  const now = new Date();
  const key = idempotencyKey(c);
  const out = await idempotent(c.env.DB, { actorId: user.id, scope: 'credits.convert', key, request: { from, to, seconds }, now }, async () => {
    const rule = await one<ConversionRule>(c.env.DB, 'SELECT * FROM pc_credit_conversion_rules WHERE from_tier_id = ? AND to_tier_id = ?', from, to);
    if (!rule || !rule.enabled) throw pcError('CONVERSION_DISABLED');
    const conv = await convertCredits(c.env.DB, { userId: user.id, rule, seconds, opKey: `${user.id}:${key}`, actorId: user.id, now });
    return { statements: conv.statements, result: { converted_seconds: seconds, received_seconds: conv.receivedSeconds, from_tier_id: from, to_tier_id: to } };
  });
  return ok(c, { ...out.result, replayed: out.replayed });
});

auth.get('/me/printers', async (c) => ok(c, await dashboardPrinters(c.env.DB, currentUser(c).id, await machinesReady(c))));

auth.get('/me/inventory', async (c) => ok(c, await dashboardInventory(c.env.DB, currentUser(c).id, c.req.query('category') ?? null)));

auth.get('/me/inventory/ledger', async (c) => {
  const user = currentUser(c);
  const variant = c.req.query('variant_id');
  const rows = await many(
    c.env.DB,
    `SELECT id, variant_id, entry_type, delta_available, delta_reserved, delta_consumed, ref_type, ref_id, value_iqd, note, created_at
       FROM pc_inventory_ledger WHERE user_id = ? ${variant ? 'AND variant_id = ?' : ''} AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...(variant ? [user.id, variant] : [user.id]),
    c.req.query('before') ?? '9999-12-31',
    queryInt(c, 'limit', 50, 1, 200)
  );
  return ok(c, rows);
});

auth.patch('/me/inventory/:variantId/alert', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const qty = body.low_stock_alert_qty === null ? null : reqInt(body.low_stock_alert_qty, 'low_stock_alert_qty', { min: 0, max: 100_000_000 });
  const acct = await one<{ id: string }>(c.env.DB, 'SELECT id FROM pc_inventory_accounts WHERE id = ?', inventoryAccountId(user.id, c.req.param('variantId')));
  if (!acct) throw pcError('NOT_FOUND');
  await runBatch(c.env.DB, [c.env.DB.prepare('UPDATE pc_inventory_accounts SET low_stock_alert_qty = ?, low_stock_notified_at = NULL WHERE id = ?').bind(qty, acct.id)]);
  return ok(c, { variant_id: c.req.param('variantId'), low_stock_alert_qty: qty });
});

/** «Top up to 1 kg»: the quantity that brings the balance to the target, priced as a NEW purchase. */
auth.post('/me/inventory/top-up-quote', limitRoute('pc_price', 600), async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const variantId = reqString(body.variant_id, 'variant_id', { max: 120 });
  const v = await one<{ purchase_step_qty: number; min_purchase_qty: number }>(c.env.DB, 'SELECT purchase_step_qty, min_purchase_qty FROM pc_variants WHERE id = ? AND active = 1', variantId);
  if (!v) throw pcError('NOT_FOUND');
  const owned = await ownedQty(c.env.DB, user.id, variantId);
  const target = body.target_qty === undefined ? 1000 : reqInt(body.target_qty, 'target_qty', { min: 1, max: 100_000_000 });
  const qty = body.quantity === undefined ? topUpQuantity(owned, target, Number(v.purchase_step_qty), Number(v.min_purchase_qty)) : reqInt(body.quantity, 'quantity', { min: 1, max: 100_000_000 });
  if (qty <= 0) return ok(c, { owned_qty: owned, target_qty: target, quantity: 0, quote: null });
  const { config } = await requestConfig(c);
  const quote = await createQuote(c.env.DB, {
    userId: user.id,
    inputs: [{ kind: 'material', variant_id: variantId, quantity: qty, unit: null, fulfillment: 'inventory', project_id: null }],
    coupon: null,
    config,
    now: new Date(),
  });
  return ok(c, { owned_qty: owned, target_qty: target, quantity: qty, balance_after_qty: owned + qty, quote }, 201);
});

/** Material the customer's pending jobs need beyond what they own: «you own 490 g, queued jobs need 650 g». */
auth.get('/me/inventory/reorder-suggestions', async (c) => {
  const user = currentUser(c);
  const rows = await many<{ variant_id: string; needed: number; available: number; unit_code: string; purchase_step_qty: number; min_purchase_qty: number }>(
    c.env.DB,
    `SELECT r.variant_id, SUM(r.qty) AS needed, COALESCE(a.available_qty, 0) AS available, v.unit_code, v.purchase_step_qty, v.min_purchase_qty
       FROM pc_job_requirements r JOIN pc_print_jobs j ON j.id = r.job_id JOIN pc_variants v ON v.id = r.variant_id
       LEFT JOIN pc_inventory_accounts a ON a.user_id = j.user_id AND a.variant_id = r.variant_id
      WHERE j.user_id = ? AND j.status IN ('ready', 'awaiting_confirmation')
      GROUP BY r.variant_id`,
    user.id
  );
  return ok(
    c,
    rows
      .filter((r) => Number(r.needed) > Number(r.available))
      .map((r) => {
        const shortfall = Number(r.needed) - Number(r.available);
        const step = Number(r.purchase_step_qty);
        return { variant_id: r.variant_id, unit_code: r.unit_code, needed_qty: Number(r.needed), owned_qty: Number(r.available), shortfall_qty: shortfall, suggested_purchase_qty: Math.max(Number(r.min_purchase_qty), Math.ceil(shortfall / step) * step) };
      })
  );
});

auth.get('/me/transactions', async (c) => ok(c, await transactions(c.env.DB, currentUser(c).id, c.req.query('before') ?? null, queryInt(c, 'limit', 50, 1, 200))));

// ------------------------------------------------------------------ quotes and orders

auth.post('/quotes', limitRoute('pc_price', 600), async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const quote = await createQuote(c.env.DB, {
    userId: currentUser(c).id,
    inputs: parseQuoteLines(body.lines),
    coupon: typeof body.coupon === 'string' ? body.coupon : null,
    config,
    now: new Date(),
  });
  return ok(c, quote, 201);
});

auth.get('/quotes/:id', async (c) => {
  const q = await one<{ snapshot_json: string; status: string; user_id: string }>(c.env.DB, 'SELECT snapshot_json, status, user_id FROM pc_quotes WHERE id = ?', c.req.param('id'));
  if (!q || q.user_id !== currentUser(c).id) throw pcError('NOT_FOUND');
  return ok(c, { ...parseJson<Record<string, unknown>>(q.snapshot_json, {}), status: q.status });
});

auth.post('/orders', limitRoute('pc_write', 300), async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const quoteId = reqString(body.quote_id, 'quote_id', { max: 120 });
  const provider = (body.payment_method ?? 'manual') as PaymentProvider;
  if (!PAYMENT_PROVIDERS.includes(provider)) throw invalid('payment_method', 'not_allowed');
  const now = new Date();
  const { config } = await requestConfig(c);
  const out = await idempotent(
    c.env.DB,
    { actorId: user.id, scope: 'order.create', key: idempotencyKey(c), request: { quoteId, provider, address: body.delivery_address ?? null }, now },
    () => planOrderFromQuote(c.env.DB, c.env as unknown as Record<string, unknown>, { userId: user.id, quoteId, provider, deliveryAddress: body.delivery_address, config, now })
  );
  return ok(c, { ...out.result, replayed: out.replayed }, out.replayed ? 200 : 201);
});

auth.get('/orders', async (c) =>
  ok(
    c,
    await many(
      c.env.DB,
      'SELECT id, kind, status, total_iqd, paid_iqd, refunded_iqd, payment_method, stock_hold_expires_at, created_at, paid_at FROM pc_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      currentUser(c).id
    )
  )
);

async function ownOrder(c: Context<AppContext>) {
  const o = await orderDetail(c.env.DB, c.req.param('id') ?? '');
  if (!o || o.user_id !== currentUser(c).id) throw pcError('NOT_FOUND');
  return o;
}

auth.get('/orders/:id', async (c) => ok(c, await ownOrder(c)));

auth.post('/orders/:id/cancel', async (c) => {
  const o = await ownOrder(c);
  const now = new Date();
  await runBatch(c.env.DB, await closeUnpaidOrder(c.env.DB, o as unknown as OrderRow, 'cancelled', currentUser(c).id, now, 'cancelled by customer'));
  return ok(c, { order_id: o.id, status: 'cancelled' });
});

/** DEVELOPMENT ONLY: the customer confirms their own order. Off unless PRINT_CLOUD_DEV_PAYMENTS === 'on'. */
auth.post('/orders/:id/dev-pay', async (c) => {
  if (c.env.PRINT_CLOUD_DEV_PAYMENTS !== 'on') throw pcError('PAYMENT_ADAPTER_DISABLED', { provider: 'dev' });
  const o = await ownOrder(c);
  if (o.payment_method !== 'dev') throw pcError('PAYMENT_ADAPTER_DISABLED', { provider: 'dev', reason: 'order_uses_another_method' });
  const body = await jsonObject(c);
  const eventId = typeof body.event_id === 'string' && body.event_id ? body.event_id.slice(0, 120) : `dev:${o.id}`;
  const result = await confirmPayment(c.env.DB, {
    provider: 'dev',
    eventId,
    orderId: o.id,
    amountIqd: body.amount_iqd === undefined ? o.total_iqd : reqInt(body.amount_iqd, 'amount_iqd', { min: 0, max: 10_000_000_000 }),
    actorId: currentUser(c).id,
    payloadHash: 'dev',
    now: new Date(),
  });
  return ok(c, { ...result, development_only: true });
});

// ------------------------------------------------------------------ files

auth.post('/files', limitRoute('pc_upload', 120), async (c) => {
  const user = currentUser(c);
  const { config } = await requestConfig(c);
  const length = Number(c.req.header('content-length') ?? '0');
  if (length > config.max_upload_bytes + 64 * 1024) throw pcError('FILE_TOO_LARGE', { max_bytes: config.max_upload_bytes });
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw invalid('file', 'multipart_required');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw invalid('file', 'required');
  if (file.size > config.max_upload_bytes) throw pcError('FILE_TOO_LARGE', { max_bytes: config.max_upload_bytes });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = await validateUpload(bytes, file.name, config.max_upload_bytes);
  const now = new Date();
  const stored = await storeModelFile(c.env, c.env.DB, { userId: user.id, bytes, originalName: file.name, validated, source: 'upload', now });
  await runBatch(c.env.DB, [
    stored.statement,
    enqueueTask(c.env.DB, { kind: 'analyze_model_file', payload: { file_id: stored.fileId }, dedupeKey: `analyze:${stored.fileId}`, now }),
  ]);
  afterResponse(c, runPrintCloudTasks(c.env, { limit: 2 }));
  return ok(c, { file_id: stored.fileId, status: 'uploaded', format: validated.format, size_bytes: validated.size, sha256: validated.sha256 }, 201);
});

auth.get('/files', async (c) => ok(c, (await dashboardFiles(c.env.DB, currentUser(c).id)).files));

/**
 * A signed, short-lived download link (POST /files/:id/download-link). The
 * token names the file AND the account it was issued to; the session must
 * still be that account's.
 */
auth.get('/files/signed', async (c) => {
  const user = currentUser(c);
  const claim = await verifyFileToken(c.env.PRINT_CLOUD_FILE_URL_SECRET, c.req.query('token') ?? '', new Date());
  if (!claim || claim.userId !== user.id) throw pcError('NOT_FOUND');
  const f = await one<FileRow>(c.env.DB, 'SELECT * FROM pc_model_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', claim.fileId, user.id);
  if (!f) throw pcError('NOT_FOUND');
  return streamFile(c, f);
});

async function ownFile(c: Context<AppContext>): Promise<FileRow> {
  const f = await one<FileRow>(c.env.DB, 'SELECT * FROM pc_model_files WHERE id = ? AND user_id = ?', c.req.param('id'), currentUser(c).id);
  if (!f || f.deleted_at) throw pcError('NOT_FOUND');
  return f;
}

auth.get('/files/:id', async (c) => ok(c, await fileView(c.env.DB, await ownFile(c))));

auth.delete('/files/:id', async (c) => {
  const f = await ownFile(c);
  if ((await liveJobsUsingFile(c.env.DB, f.id)) > 0) throw pcError('INVALID_TRANSITION', { reason: 'file_used_by_a_live_job' });
  const now = new Date();
  await runBatch(c.env.DB, [c.env.DB.prepare('UPDATE pc_model_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(iso(now), iso(now), f.id)]);
  await mediaBucket(c.env, 'private').delete(f.storage_key).catch(() => undefined);
  return ok(c, { file_id: f.id, deleted: true });
});

async function streamFile(c: Context<AppContext>, f: FileRow) {
  const obj = await mediaBucket(c.env, 'private').get(f.storage_key);
  if (!obj) throw pcError('NOT_FOUND');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${f.original_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

auth.get('/files/:id/download', async (c) => streamFile(c, await ownFile(c)));

auth.post('/files/:id/download-link', async (c) => {
  const f = await ownFile(c);
  const expires = addSeconds(new Date(), 300);
  const token = await signFileToken(c.env.PRINT_CLOUD_FILE_URL_SECRET, f.id, currentUser(c).id, expires);
  return ok(c, { url: `/api/print-cloud/v1/files/signed?token=${encodeURIComponent(token)}`, expires_at: iso(expires) });
});

// ------------------------------------------------------------------ imports

auth.post('/imports', limitRoute('pc_import', 60), async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const result = await startImport(c.env.DB, { userId: currentUser(c).id, url: reqString(body.url, 'url', { max: 2000 }), config, now: new Date() });
  afterResponse(c, runPrintCloudTasks(c.env, { limit: 2 }));
  return ok(c, result, 202);
});

auth.get('/imports', async (c) => ok(c, (await dashboardFiles(c.env.DB, currentUser(c).id)).imports));

auth.get('/imports/:id', async (c) => {
  const imp = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM pc_model_imports WHERE id = ? AND user_id = ?', c.req.param('id'), currentUser(c).id);
  if (!imp) throw pcError('NOT_FOUND');
  const logs = await many(c.env.DB, 'SELECT level, code, detail_json, created_at FROM pc_model_import_logs WHERE import_id = ? ORDER BY created_at', imp.id);
  return ok(c, { ...imp, metadata: parseJson(String(imp.metadata_json), {}), metadata_json: undefined, file_imported: imp.status === 'file_imported', logs });
});

// ------------------------------------------------------------------ projects, plates, profiles, recommendations

auth.post('/projects', limitRoute('pc_write', 300), async (c) => ok(c, { project_id: await createProject(c.env.DB, currentUser(c).id, await jsonObject(c), new Date()) }, 201));
auth.get('/projects', async (c) => ok(c, (await dashboardFiles(c.env.DB, currentUser(c).id)).projects));
auth.get('/projects/:id', async (c) => ok(c, await projectView(c.env.DB, currentUser(c).id, c.req.param('id'))));
auth.patch('/projects/:id', async (c) => {
  await updateProject(c.env.DB, currentUser(c).id, c.req.param('id'), await jsonObject(c), new Date());
  return ok(c, await projectView(c.env.DB, currentUser(c).id, c.req.param('id')));
});
auth.post('/projects/:id/duplicate', limitRoute('pc_write', 300), async (c) => ok(c, { project_id: await duplicateProject(c.env.DB, currentUser(c).id, c.req.param('id'), new Date()) }, 201));
auth.post('/projects/:id/models', limitRoute('pc_write', 300), async (c) =>
  ok(c, { project_model_id: await addProjectModel(c.env.DB, currentUser(c).id, c.req.param('id'), await jsonObject(c), new Date()) }, 201)
);
auth.patch('/projects/:id/models/:modelId', async (c) => {
  await updateProjectModel(c.env.DB, currentUser(c).id, c.req.param('modelId'), await jsonObject(c), new Date());
  return ok(c, await projectView(c.env.DB, currentUser(c).id, c.req.param('id')));
});
auth.post('/projects/:id/plates', limitRoute('pc_write', 300), async (c) => ok(c, await createPlate(c.env.DB, currentUser(c).id, c.req.param('id'), await jsonObject(c), new Date()), 201));
auth.get('/projects/:id/accessory-suggestions', async (c) => ok(c, await accessorySuggestions(c.env.DB, currentUser(c).id, c.req.param('id'), new Date())));
auth.post('/recommendations/:id', async (c) => {
  await decideRecommendation(c.env.DB, currentUser(c).id, c.req.param('id'), await jsonObject(c), new Date());
  return ok(c, { recommendation_id: c.req.param('id') });
});
auth.get('/projects/:id/printer-recommendations', async (c) =>
  ok(c, await printerRecommendations(c.env.DB, currentUser(c).id, { projectId: c.req.param('id'), jobId: c.req.query('job_id') ?? null }))
);
auth.get('/profiles', async (c) => ok(c, (await dashboardFiles(c.env.DB, currentUser(c).id)).profiles));
auth.post('/profiles', async (c) => ok(c, { profile_id: await saveProfile(c.env.DB, currentUser(c).id, await jsonObject(c), new Date()) }, 201));
auth.put('/profiles/:id', async (c) => ok(c, { profile_id: await saveProfile(c.env.DB, currentUser(c).id, await jsonObject(c), new Date(), c.req.param('id')) }));

// ------------------------------------------------------------------ print jobs

auth.post('/jobs', limitRoute('pc_write', 300), async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const out = await createJob(
    c.env.DB,
    currentUser(c).id,
    {
      project_id: reqString(body.project_id, 'project_id', { max: 120 }),
      printer_model_id: reqString(body.printer_model_id, 'printer_model_id', { max: 120 }),
      plate_id: typeof body.plate_id === 'string' ? body.plate_id : null,
      title: optString(body.title, 'title', 120),
      settings: body.settings,
      profile_id: typeof body.profile_id === 'string' ? body.profile_id : null,
      copies: body.copies as number | undefined,
      accessories: body.accessories,
      depends_on_job_id: typeof body.depends_on_job_id === 'string' ? body.depends_on_job_id : null,
    },
    config,
    new Date()
  );
  return ok(c, out, 201);
});

auth.get('/jobs', async (c) => ok(c, await dashboardJobs(c.env.DB, currentUser(c).id)));

const ownJob = async (c: Context<AppContext>): Promise<JobRow> => loadJob(c.env.DB, c.req.param('id') ?? '', currentUser(c).id);

auth.get('/jobs/:id', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await jobView(c.env.DB, await ownJob(c), config.telemetry_stale_seconds, new Date()));
});

auth.patch('/jobs/:id', async (c) => {
  const job = await ownJob(c);
  await editJob(c.env.DB, job, customerActor(c), await jsonObject(c), new Date());
  return ok(c, { job_id: job.id, status: 'draft' });
});

auth.post('/jobs/:id/analyze', limitRoute('pc_write', 300), async (c) => {
  const job = await ownJob(c);
  const { config } = await requestConfig(c);
  const now = new Date();
  const slicer = await slicerAvailability(c.env.DB, config.telemetry_stale_seconds, now);
  return ok(c, await requestAnalysis(c.env.DB, job, customerActor(c), now, slicer === 'connected'), 202);
});

auth.get('/jobs/:id/projection', async (c) => ok(c, await projection(c.env.DB, await ownJob(c))));

auth.post('/jobs/:id/review', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await reviewJob(c.env.DB, await ownJob(c), customerActor(c), config, new Date()));
});

auth.post('/jobs/:id/confirm', limitRoute('pc_write', 300), async (c) => {
  const user = currentUser(c);
  const jobId = c.req.param('id');
  const now = new Date();
  const out = await idempotent(c.env.DB, { actorId: user.id, scope: 'job.confirm', key: idempotencyKey(c), request: { jobId }, now }, async () =>
    planConfirm(c.env.DB, await loadJob(c.env.DB, jobId, user.id), customerActor(c), now)
  );
  return ok(c, { ...out.result, replayed: out.replayed });
});

auth.post('/jobs/:id/cancel', async (c) => {
  const job = await ownJob(c);
  const body = await jsonObject(c);
  await cancelJob(c.env.DB, job, customerActor(c), new Date(), optString(body.reason, 'reason', 300) || 'customer request');
  const released = await activeReservationForJob(c.env.DB, job.id);
  return ok(c, { job_id: job.id, status: 'cancelled', reservations_released: released === null });
});

/** A customer asks the workshop to pause or stop: recorded for an operator, never executed directly. */
auth.post('/jobs/:id/requests', limitRoute('pc_write', 300), async (c) => {
  const job = await ownJob(c);
  const body = await jsonObject(c);
  const action = body.action;
  if (action !== 'pause' && action !== 'cancel' && action !== 'note') throw invalid('action', 'not_allowed');
  await runBatch(c.env.DB, [jobEvent(c.env.DB, job, 'customer_request', customerActor(c), new Date(), { action, message: optString(body.message, 'message', 500) })]);
  return ok(c, { job_id: job.id, request: action, status: 'recorded_for_operator' }, 202);
});

auth.post('/jobs/:id/reschedule', async (c) => {
  const body = await jsonObject(c);
  const notBefore = body.not_before === null || body.not_before === undefined ? null : new Date(reqString(body.not_before, 'not_before', { max: 40 })).toISOString();
  await reschedule(c.env.DB, await ownJob(c), notBefore, customerActor(c), new Date());
  return ok(c, { job_id: c.req.param('id'), not_before: notBefore });
});

auth.get('/queue', async (c) => {
  const user = currentUser(c);
  const { config } = await requestConfig(c);
  const mine = new Set((await many<{ id: string }>(c.env.DB, "SELECT id FROM pc_print_jobs WHERE user_id = ? AND status = 'queued'", user.id)).map((j) => j.id));
  const estimates = (await estimateQueue(c.env.DB, config, new Date())).filter((e) => mine.has(e.job_id));
  return ok(c, { jobs: estimates, note: 'Estimated times are a simulation of the current queue, not a promise.' });
});

// ------------------------------------------------------------------ shipments

auth.post('/shipments', limitRoute('pc_write', 300), async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const req = parseDeliveryRequest(body);
  const now = new Date();
  const { config } = await requestConfig(c);
  const out = await idempotent(c.env.DB, { actorId: user.id, scope: 'shipment.create', key: idempotencyKey(c), request: body, now }, () =>
    planShipmentRequest(c.env.DB, c.env as unknown as Record<string, unknown>, user.id, req, config, now)
  );
  return ok(c, { ...out.result, replayed: out.replayed }, out.replayed ? 200 : 201);
});

auth.get('/shipments', async (c) =>
  ok(c, await many(c.env.DB, 'SELECT id, kind, status, fee_iqd, fee_order_id, tracking_ref, created_at FROM pc_shipments WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', currentUser(c).id))
);
auth.get('/shipments/:id', async (c) => ok(c, await shipmentView(c.env.DB, c.req.param('id'), currentUser(c).id)));
auth.post('/shipments/:id/cancel', async (c) => ok(c, await cancelShipmentByCustomer(c.env.DB, currentUser(c).id, c.req.param('id'), new Date())));

// ------------------------------------------------------------------ buybacks

auth.post('/buybacks/quote', async (c) => {
  const body = await jsonObject(c);
  return ok(c, await buybackQuote(c.env.DB, currentUser(c).id, reqString(body.variant_id, 'variant_id', { max: 120 }), reqInt(body.qty, 'qty', { min: 1, max: 100_000_000 })));
});
auth.post('/buybacks', limitRoute('pc_write', 300), async (c) => {
  const body = await jsonObject(c);
  return ok(c, await requestBuyback(c.env.DB, currentUser(c).id, reqString(body.variant_id, 'variant_id', { max: 120 }), reqInt(body.qty, 'qty', { min: 1, max: 100_000_000 }), new Date()), 201);
});
auth.get('/buybacks', async (c) =>
  ok(
    c,
    await many(
      c.env.DB,
      'SELECT id, variant_id, qty, rate_bps, estimated_value_iqd, final_value_iqd, status, payout_status, created_at, decided_at FROM pc_buyback_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      currentUser(c).id
    )
  )
);
auth.post('/buybacks/:id/cancel', async (c) => ok(c, await cancelBuyback(c.env.DB, c.req.param('id'), currentUser(c).id, new Date())));

printCloudRoutes.route('/', auth);
