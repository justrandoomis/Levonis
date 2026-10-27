/**
 * LEVONIS PRINT CLOUD — the ADMINISTRATION API, mounted at
 * /api/admin/print-cloud (docs/PRINT_CLOUD.md §10.2).
 *
 * Under /api/admin/* on purpose: the apex-only host guard, the no-store layer
 * and the security-events door in worker/index.ts cover it, and its own
 * `requireAdmin` carries the host rule too. Roles are the platform's own
 * (worker/lib/adminScope.ts), applied per route and, where a route mixes
 * them, per field:
 *
 *   assistant admin  = the workshop OPERATOR: queue, jobs, printers, stock
 *                      counts, shipments, estimates (op);
 *   full admin       = money: prices, payments, refunds, balance
 *                      adjustments, buybacks, revenue (requireFinancialScope);
 *   owner            = cost: what the workshop paid for stock and machines,
 *                      and the profit computed from it (requireCostRead/Write).
 *
 * Every act on money, stock, credits, balances, printers, order status or
 * prices is audited in its own batch (worker/lib/printCloud/audit.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { jsonObject, requireAdmin } from '../lib/http';
import { limitByMethod } from '../lib/ratelimit';
import { canMoveMoney, canViewCost, canWriteCost, requireCostRead, requireCostWrite } from '../lib/costAccess';
import { requireFinancialScope } from '../lib/walletAdjust';
import { countingD1 } from '../lib/d1Count';
import { adapterStatuses, integrationBacklog } from '../lib/printCloud/adapters';
import { pcAudit } from '../lib/printCloud/audit';
import { roomWithin, runTasksByHand, schedulerRoom, taskOverview } from '../lib/printCloud/background';
import { approveBuyback, markBuybackPaid, rejectBuyback } from '../lib/printCloud/buyback';
import { ENTITIES, categories, createEntity, listEntity, replacePriceTiers, stripCost, updateCategoryBuyback, updateEntity, type EntityKey } from '../lib/printCloud/catalog';
import { creditAccountId, debitAvailable, grantCredits } from '../lib/printCloud/credits';
import { fence, idempotent, many, one, runBatch, type Stmt } from '../lib/printCloud/db';
import { invalid, pcError } from '../lib/printCloud/errors';
import { advanceShipment, shipmentView } from '../lib/printCloud/fulfillment';
import { currentUser, idempotencyKey, ok, pcGate, queryInt, requestConfig, staffActor } from '../lib/printCloud/http';
import { debitInventory, grantInventory } from '../lib/printCloud/inventory';
import {
  approveJob,
  cancelJob,
  completeJob,
  failJob,
  jobView,
  loadJob,
  parseConsumption,
  parseEstimate,
  parseFailure,
  pauseJob,
  recordEstimate,
  resolveFailure,
  resumeJob,
  startJob,
  autoConfirmReprint,
  JOB_STATUSES,
  type FailureDecision,
} from '../lib/printCloud/jobs';
import { pcNotify } from '../lib/printCloud/notify';
import { closeUnpaidOrder, confirmPayment, orderDetail, planLineRefund, REFUND_METHODS, type OrderRow, type RefundMethod } from '../lib/printCloud/orders';
import { createAgent, printerStatuses, queueCommand, revokeAgent } from '../lib/printCloud/printers';
import { assignJob, estimateQueue, runScheduler, setPriority, unassignJob } from '../lib/printCloud/queue';
import { reconcile } from '../lib/printCloud/reconcile';
import { operationsReport, parseRange, profitReport, revenueReport } from '../lib/printCloud/reports';
import { COST_SETTING_KEYS, configWrite, publicSettings } from '../lib/printCloud/settings';
import { adjustUp, allocateWithoutSale, deallocate, position, receiveStock, removePhysical, stockOverview } from '../lib/printCloud/warehouse';
import { iso, mulDivRound, optIso, optString, parseJson, pcId, reqInt, reqString } from '../lib/printCloud/util';
import type { ShipmentStatus } from '../lib/printCloud/shipments';

export const adminPrintCloudRoutes = new Hono<AppContext>();

adminPrintCloudRoutes.use('*', requireAdmin);
adminPrintCloudRoutes.use('*', limitByMethod(['pc_admin_read', 6000], ['pc_admin_write', 1500]));
adminPrintCloudRoutes.use('*', pcGate);

/** A path parameter, always present on the routes that name it. */
const param = (c: Context<AppContext>, name: string): string => c.req.param(name) ?? '';

const costView = (c: Context<AppContext>) => canViewCost(c.env, c.get('user'));
const access = (c: Context<AppContext>) => ({ canWriteCost: canWriteCost(c.env, c.get('user')), canMoveMoney: canMoveMoney(c.env, c.get('user')) });

// ------------------------------------------------------------------ overview, settings, adapters

adminPrintCloudRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const jobs = await many<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM pc_print_jobs GROUP BY status');
  const printers = await many<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM pc_printers GROUP BY status');
  const lowStock = (await stockOverview(db)).filter((s) => s.low).length;
  const failures = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pc_failures WHERE status = 'reported'");
  const awaiting = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pc_print_jobs WHERE status = 'confirmed'");
  return ok(c, {
    jobs_by_status: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
    printers_by_status: Object.fromEntries(printers.map((p) => [p.status, Number(p.n)])),
    low_stock_variants: lowStock,
    open_failures: Number(failures?.n ?? 0),
    jobs_awaiting_approval: Number(awaiting?.n ?? 0),
  });
});

adminPrintCloudRoutes.get('/settings', async (c) => {
  const { config, version } = await requestConfig(c);
  return ok(c, { version, config: costView(c) ? config : publicSettings(config) });
});

adminPrintCloudRoutes.patch('/settings', requireFinancialScope, async (c) => {
  const body = await jsonObject(c);
  const patch = (body.config ?? {}) as Record<string, unknown>;
  if (typeof patch !== 'object' || Array.isArray(patch)) throw invalid('config', 'object_required');
  const expectedVersion = reqInt(body.version, 'version', { min: 0, max: 1_000_000 });
  const touchesCost = Object.keys(patch).some((k) => (COST_SETTING_KEYS as readonly string[]).includes(k));
  if (touchesCost && !canWriteCost(c.env, c.get('user'))) throw pcError('FORBIDDEN', { reason: 'cost_owner_only' }, 403);
  const current = await requestConfig(c);
  if (current.version !== expectedVersion) throw pcError('STATE_CHANGED', { version: current.version });
  const now = new Date();
  const user = currentUser(c);
  const { next, statements } = configWrite(c.env.DB, current, patch, user.id, now);
  await runBatch(c.env.DB, [...statements, ...(await pcAudit(c.env.DB, user.id, 'settings.update', 'config', { keys: Object.keys(patch) }))]);
  return ok(c, { version: current.version + 1, config: costView(c) ? next : publicSettings(next) });
});

adminPrintCloudRoutes.get('/adapters', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, { adapters: adapterStatuses(config), backlog: await integrationBacklog(c.env.DB) });
});

// ------------------------------------------------------------------ catalogue

function entitySpec(c: Context<AppContext>) {
  const key = param(c, 'entity') as EntityKey;
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, key)) throw pcError('NOT_FOUND');
  return ENTITIES[key];
}

adminPrintCloudRoutes.get('/catalog/:entity', async (c) => {
  const spec = entitySpec(c);
  const rows = await listEntity(c.env.DB, spec);
  return ok(c, rows.map((r) => stripCost(spec, r, costView(c))));
});

adminPrintCloudRoutes.post('/catalog/:entity', async (c) => {
  const spec = entitySpec(c);
  const user = currentUser(c);
  const now = new Date();
  const created = createEntity(c.env.DB, spec, await jsonObject(c), access(c), now);
  await runBatch(c.env.DB, [...created.statements, ...(await pcAudit(c.env.DB, user.id, `catalog.${spec.key}.create`, created.id, stripCost(spec, created.row, false)))]);
  if (spec.key === 'variants') await runBatch(c.env.DB, [c.env.DB.prepare('INSERT OR IGNORE INTO pc_stock_positions (variant_id, updated_at) VALUES (?, ?)').bind(created.id, iso(now))]);
  return ok(c, stripCost(spec, created.row, costView(c)), 201);
});

adminPrintCloudRoutes.patch('/catalog/:entity/:id', async (c) => {
  const spec = entitySpec(c);
  const user = currentUser(c);
  const now = new Date();
  const body = await jsonObject(c);
  const out = await updateEntity(c.env.DB, spec, param(c, 'id'), body, access(c), user.id, now);
  await runBatch(c.env.DB, [...out.statements, ...(await pcAudit(c.env.DB, user.id, `catalog.${spec.key}.update`, param(c, 'id'), { changed: out.changed }))]);
  const row = await one<Record<string, unknown>>(c.env.DB, `SELECT * FROM ${spec.table} WHERE id = ?`, param(c, 'id'));
  return ok(c, stripCost(spec, row ?? {}, costView(c)));
});

adminPrintCloudRoutes.put('/variants/:id/price-tiers', requireFinancialScope, async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const out = await replacePriceTiers(c.env.DB, param(c, 'id'), body.tiers, user.id, new Date());
  await runBatch(c.env.DB, [...out.statements, ...(await pcAudit(c.env.DB, user.id, 'pricing.tiers', param(c, 'id'), { tiers: out.tiers }))]);
  return ok(c, { variant_id: param(c, 'id'), tiers: out.tiers });
});

adminPrintCloudRoutes.get('/categories', async (c) => ok(c, await categories(c.env.DB)));

adminPrintCloudRoutes.patch('/categories/:code/buyback', requireFinancialScope, async (c) => {
  const user = currentUser(c);
  const statements = await updateCategoryBuyback(c.env.DB, param(c, 'code'), await jsonObject(c), user.id, new Date());
  await runBatch(c.env.DB, [...statements, ...(await pcAudit(c.env.DB, user.id, 'pricing.buyback', param(c, 'code')))]);
  return ok(c, (await categories(c.env.DB)).find((x) => x.code === param(c, 'code')));
});

adminPrintCloudRoutes.get('/price-changes', requireFinancialScope, async (c) =>
  ok(c, await many(c.env.DB, 'SELECT * FROM pc_price_changes ORDER BY created_at DESC LIMIT ?', queryInt(c, 'limit', 100, 1, 500)))
);

// ------------------------------------------------------------------ workshop stock

adminPrintCloudRoutes.get('/stock', async (c) => ok(c, await stockOverview(c.env.DB)));

adminPrintCloudRoutes.get('/stock/lots', requireCostRead, async (c) => {
  const variant = c.req.query('variant_id');
  return ok(
    c,
    await many(
      c.env.DB,
      `SELECT * FROM pc_stock_lots ${variant ? 'WHERE variant_id = ?' : ''} ORDER BY received_at DESC LIMIT 500`,
      ...(variant ? [variant] : [])
    )
  );
});

/**
 * A supplier delivery. Its cost is the owner's to state; an operator may
 * receive it with the cost PENDING (`cost_known` = 0, never a free zero),
 * which the owner states later at POST /stock/lots/:id/cost.
 */
adminPrintCloudRoutes.post('/stock/receive', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  if (body.total_cost_iqd !== undefined && !canWriteCost(c.env, user)) throw pcError('FORBIDDEN', { field: 'total_cost_iqd', reason: 'cost_owner_only' }, 403);
  const variantId = reqString(body.variant_id, 'variant_id', { max: 120 });
  if (!(await one(c.env.DB, 'SELECT id FROM pc_variants WHERE id = ?', variantId))) throw pcError('NOT_FOUND', { field: 'variant_id' });
  const r = receiveStock(c.env.DB, {
    variantId,
    qty: reqInt(body.qty, 'qty', { min: 1, max: 100_000_000 }),
    totalCostIqd: body.total_cost_iqd === undefined ? null : reqInt(body.total_cost_iqd, 'total_cost_iqd', { min: 0, max: 10_000_000_000 }),
    locationId: typeof body.location_id === 'string' ? body.location_id : null,
    lotCode: optString(body.lot_code, 'lot_code', 80),
    supplier: optString(body.supplier, 'supplier', 120),
    notes: optString(body.notes, 'notes', 500),
    actorId: user.id,
    now: new Date(),
  });
  await runBatch(c.env.DB, [...r.statements, ...(await pcAudit(c.env.DB, user.id, 'stock.receive', r.lotId, { variant_id: variantId, qty: body.qty }))]);
  return ok(c, { lot_id: r.lotId, position: await position(c.env.DB, variantId) }, 201);
});

/**
 * The owner states what a cost-pending lot cost — once: the batch is fenced
 * on the lot still being pending, so two statements of it cannot both land
 * (the same cost sent again answers as recorded). Units that already left
 * the lot keep their ledger rows; the profit report values them from this
 * cost (reports.ts `profitReport`). The audit names the act, never the cost:
 * full admins read that trail.
 */
adminPrintCloudRoutes.post('/stock/lots/:id/cost', requireCostWrite, async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const totalCostIqd = reqInt(body.total_cost_iqd, 'total_cost_iqd', { min: 0, max: 10_000_000_000 });
  const lot = await one<{ id: string; variant_id: string; received_qty: number; total_cost_iqd: number; cost_known: number }>(
    c.env.DB,
    'SELECT id, variant_id, received_qty, total_cost_iqd, cost_known FROM pc_stock_lots WHERE id = ?',
    param(c, 'id')
  );
  if (!lot) throw pcError('NOT_FOUND');
  const unitMilli = mulDivRound(totalCostIqd, 1000, Number(lot.received_qty));
  const answer = { lot_id: lot.id, variant_id: lot.variant_id, total_cost_iqd: totalCostIqd, unit_cost_milli_iqd: unitMilli, cost_known: true };
  if (Number(lot.cost_known) === 1) {
    if (Number(lot.total_cost_iqd) === totalCostIqd) return ok(c, { ...answer, replayed: true });
    throw pcError('INVALID_TRANSITION', { reason: 'cost_already_recorded' });
  }
  await runBatch(c.env.DB, [
    fence(c.env.DB, 'STATE_CHANGED', '(SELECT cost_known FROM pc_stock_lots WHERE id = ?) = 0', [lot.id]),
    c.env.DB.prepare('UPDATE pc_stock_lots SET total_cost_iqd = ?, unit_cost_milli_iqd = ?, cost_known = 1 WHERE id = ?').bind(totalCostIqd, unitMilli, lot.id),
    ...(await pcAudit(c.env.DB, user.id, 'stock.lot_cost', lot.id, { variant_id: lot.variant_id })),
  ]);
  return ok(c, { ...answer, replayed: false });
});

/** A count correction: positive adds an adjustment lot (its cost pending), negative takes units off the shelf. */
adminPrintCloudRoutes.post('/stock/adjust', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const variantId = reqString(body.variant_id, 'variant_id', { max: 120 });
  const delta = reqInt(body.qty_delta, 'qty_delta', { min: -100_000_000, max: 100_000_000 });
  if (delta === 0) throw invalid('qty_delta', 'zero');
  const reason = reqString(body.reason, 'reason', { max: 500 });
  const now = new Date();
  const ref = pcId('pcadj');
  const statements: Stmt[] =
    delta > 0
      ? adjustUp(c.env.DB, { variantId, qty: delta, reason, actorId: user.id, now })
      : (
          await removePhysical(c.env.DB, {
            variantId,
            qty: -delta,
            type: 'adjust_down',
            fromAllocated: false,
            refType: 'adjustment',
            refId: ref,
            entryKey: `adjust_down:${ref}`,
            reason,
            actorId: user.id,
            now,
          })
        ).statements;
  await runBatch(c.env.DB, [...statements, ...(await pcAudit(c.env.DB, user.id, 'stock.adjust', variantId, { qty_delta: delta, reason }))]);
  return ok(c, { position: await position(c.env.DB, variantId) });
});

adminPrintCloudRoutes.post('/stock/waste', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const variantId = reqString(body.variant_id, 'variant_id', { max: 120 });
  const type = body.type === 'damage' ? 'damage' : 'waste';
  const reason = reqString(body.reason, 'reason', { max: 500 });
  const ref = pcId('pcwst');
  const out = await removePhysical(c.env.DB, {
    variantId,
    qty: reqInt(body.qty, 'qty', { min: 1, max: 100_000_000 }),
    type,
    fromAllocated: false,
    refType: type,
    refId: ref,
    entryKey: `${type}:${ref}`,
    reason,
    actorId: user.id,
    now: new Date(),
  });
  await runBatch(c.env.DB, [...out.statements, ...(await pcAudit(c.env.DB, user.id, `stock.${type}`, variantId, { qty: body.qty, reason }))]);
  return ok(c, { position: await position(c.env.DB, variantId) });
});

// ------------------------------------------------------------------ customers (money)

adminPrintCloudRoutes.get('/customers/:userId', requireFinancialScope, async (c) => {
  const db = c.env.DB;
  const userId = param(c, 'userId');
  return ok(c, {
    credits: await many(db, 'SELECT tier_id, available_seconds, reserved_seconds, consumed_seconds FROM pc_credit_accounts WHERE user_id = ?', userId),
    inventory: await many(db, 'SELECT variant_id, unit_code, available_qty, reserved_qty, consumed_qty FROM pc_inventory_accounts WHERE user_id = ?', userId),
    orders: await many(db, 'SELECT id, kind, status, total_iqd, paid_iqd, refunded_iqd, created_at FROM pc_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId),
    jobs: await many(db, 'SELECT id, title, status, created_at FROM pc_print_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId),
    credit_ledger: await many(db, 'SELECT * FROM pc_credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId),
    inventory_ledger: await many(db, 'SELECT * FROM pc_inventory_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId),
  });
});

/** A balance correction is a compensating, audited, idempotent ledger entry — never an edit. */
adminPrintCloudRoutes.post('/customers/:userId/credits/adjust', requireFinancialScope, async (c) => {
  const admin = currentUser(c);
  const userId = param(c, 'userId');
  const body = await jsonObject(c);
  const tierId = reqString(body.tier_id, 'tier_id', { max: 120 });
  const seconds = reqInt(body.seconds, 'seconds', { min: -100_000_000, max: 100_000_000 });
  if (seconds === 0) throw invalid('seconds', 'zero');
  const reason = reqString(body.reason, 'reason', { max: 500 });
  const key = idempotencyKey(c);
  const now = new Date();
  if (!(await one(c.env.DB, 'SELECT id FROM users WHERE id = ?', userId))) throw pcError('NOT_FOUND');
  const out = await idempotent(c.env.DB, { actorId: admin.id, scope: 'admin.credits.adjust', key, request: { userId, tierId, seconds, reason }, now }, async () => {
    const entryKey = `admin_adjust:${admin.id}:${key}`;
    const statements: Stmt[] =
      seconds > 0
        ? grantCredits(c.env.DB, { userId, tierId, seconds, paidIqd: 0, source: body.compensation === true ? 'compensation' : 'adjustment', entryKey, actorId: admin.id, note: reason, now }).statements
        : (await debitAvailable(c.env.DB, { userId, tierId, seconds: -seconds, type: 'adjust_debit', entryKey, actorId: admin.id, note: reason, now })).statements;
    statements.push(
      pcNotify(c.env.DB, { userId, notice: 'credits_adjusted', entity: 'print_cloud_order', entityId: tierId, link: '/print-cloud/credits', eventKey: entryKey }),
      ...(await pcAudit(c.env.DB, admin.id, 'credits.adjust', userId, { tier_id: tierId, seconds, reason }))
    );
    return { statements, result: { user_id: userId, tier_id: tierId, seconds } };
  });
  const acct = await one(c.env.DB, 'SELECT available_seconds, reserved_seconds, consumed_seconds FROM pc_credit_accounts WHERE id = ?', creditAccountId(userId, tierId));
  return ok(c, { ...out.result, account: acct, replayed: out.replayed });
});

adminPrintCloudRoutes.post('/customers/:userId/inventory/adjust', requireFinancialScope, async (c) => {
  const admin = currentUser(c);
  const userId = param(c, 'userId');
  const body = await jsonObject(c);
  const variantId = reqString(body.variant_id, 'variant_id', { max: 120 });
  const qty = reqInt(body.qty, 'qty', { min: -100_000_000, max: 100_000_000 });
  if (qty === 0) throw invalid('qty', 'zero');
  const reason = reqString(body.reason, 'reason', { max: 500 });
  const key = idempotencyKey(c);
  const now = new Date();
  if (!(await one(c.env.DB, 'SELECT id FROM users WHERE id = ?', userId))) throw pcError('NOT_FOUND');
  const out = await idempotent(c.env.DB, { actorId: admin.id, scope: 'admin.inventory.adjust', key, request: { userId, variantId, qty, reason }, now }, async () => {
    const entryKey = `admin_adjust:${admin.id}:${key}`;
    const statements: Stmt[] = [];
    if (qty > 0) {
      // Granting units means allocating workshop stock to the customer: fenced, never more than is on the shelf.
      statements.push(...allocateWithoutSale(c.env.DB, { variantId, qty, userId, refType: 'adjustment', refId: entryKey, entryKey: `allocate:${entryKey}`, actorId: admin.id, now }));
      statements.push(
        ...grantInventory(c.env.DB, { userId, variantId, qty, paidIqd: 0, source: body.compensation === true ? 'compensation' : 'adjustment', entryKey, actorId: admin.id, note: reason, now }).statements
      );
    } else {
      statements.push(...(await debitInventory(c.env.DB, { userId, variantId, qty: -qty, type: 'adjust_debit', entryKey, refType: 'adjustment', actorId: admin.id, note: reason, now })).statements);
      statements.push(...deallocate(c.env.DB, { variantId, qty: -qty, type: 'deallocate', userId, refType: 'adjustment', refId: entryKey, entryKey: `deallocate:${entryKey}`, actorId: admin.id, now }));
    }
    statements.push(...(await pcAudit(c.env.DB, admin.id, 'inventory.adjust', userId, { variant_id: variantId, qty, reason })));
    return { statements, result: { user_id: userId, variant_id: variantId, qty } };
  });
  return ok(c, { ...out.result, replayed: out.replayed });
});

// ------------------------------------------------------------------ orders and payments (money)

adminPrintCloudRoutes.get('/orders', requireFinancialScope, async (c) => {
  const status = c.req.query('status');
  return ok(
    c,
    await many(
      c.env.DB,
      `SELECT id, user_id, kind, status, total_iqd, paid_iqd, refunded_iqd, payment_method, created_at, paid_at FROM pc_orders
        ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 500`,
      ...(status ? [status] : [])
    )
  );
});

adminPrintCloudRoutes.get('/orders/:id', requireFinancialScope, async (c) => {
  const o = await orderDetail(c.env.DB, param(c, 'id'));
  if (!o) throw pcError('NOT_FOUND');
  return ok(c, o);
});

/**
 * The manual adapter: a cash or transfer receipt the workshop holds. Same
 * exactly-once door as every adapter. The event is the receipt AS ENTERED for
 * this order — order, amount and reference — so the same entry twice is one
 * event, while a corrected amount or one reference covering two orders is
 * not swallowed as a duplicate of a different entry.
 */
adminPrintCloudRoutes.post('/orders/:id/confirm-payment', requireFinancialScope, async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const reference = reqString(body.reference, 'reference', { max: 120 });
  const orderId = param(c, 'id');
  const amountIqd = reqInt(body.amount_iqd, 'amount_iqd', { min: 0, max: 10_000_000_000 });
  // One receipt pays an order once. Re-entering a receipt already APPLIED to this order — even with a
  // mistyped amount — is that receipt again, not new money to put on the refund desk.
  const applied = await one<{ amount_iqd: number }>(
    c.env.DB,
    "SELECT amount_iqd FROM pc_payment_events WHERE provider = 'manual' AND order_id = ? AND outcome = 'applied' AND provider_event_id = 'manual:' || order_id || ':' || amount_iqd || ':' || ?",
    orderId,
    reference
  );
  if (applied) return ok(c, { outcome: 'duplicate_event', order_id: orderId, previous_outcome: 'applied', previous_amount_iqd: Number(applied.amount_iqd) });
  const result = await confirmPayment(c.env.DB, {
    provider: 'manual',
    eventId: `manual:${orderId}:${amountIqd}:${reference}`,
    orderId,
    amountIqd,
    actorId: user.id,
    payloadHash: 'manual',
    now: new Date(),
  });
  return ok(c, result);
});

adminPrintCloudRoutes.post('/orders/:id/cancel', requireFinancialScope, async (c) => {
  const user = currentUser(c);
  const order = await one<OrderRow>(c.env.DB, 'SELECT * FROM pc_orders WHERE id = ?', param(c, 'id'));
  if (!order) throw pcError('NOT_FOUND');
  const body = await jsonObject(c);
  await runBatch(c.env.DB, await closeUnpaidOrder(c.env.DB, order, 'cancelled', user.id, new Date(), optString(body.reason, 'reason', 300) || 'cancelled by admin'));
  return ok(c, { order_id: order.id, status: 'cancelled' });
});

/**
 * Refund unused hours, grams or a fee of one line. An order paid from the
 * Levonis wallet is credited back to the wallet IN THIS BATCH (`method` left
 * out or 'levonis_wallet'; another method is refused for it); any other order
 * records the refund for the money desk under `method` ('manual' when left
 * out). orders.ts `planLineRefund` holds the rule.
 */
adminPrintCloudRoutes.post('/orders/:id/refunds', requireFinancialScope, async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  const now = new Date();
  // Left out: the order's own rail decides (the wallet for a wallet-paid order, else 'manual').
  const method = body.method === undefined || body.method === null ? null : body.method;
  if (method !== null && !(REFUND_METHODS as readonly unknown[]).includes(method)) throw invalid('method', 'not_allowed');
  const request = {
    orderId: param(c, 'id'),
    lineId: reqString(body.line_id, 'line_id', { max: 120 }),
    quantity: body.quantity === undefined ? null : reqInt(body.quantity, 'quantity', { min: 1, max: 100_000_000 }),
    amountIqd: body.amount_iqd === undefined ? null : reqInt(body.amount_iqd, 'amount_iqd', { min: 1, max: 10_000_000_000 }),
    reason: reqString(body.reason, 'reason', { max: 500 }),
    method: method as RefundMethod | null,
  };
  const out = await idempotent(c.env.DB, { actorId: user.id, scope: 'admin.order.refund', key: idempotencyKey(c), request, now }, () =>
    planLineRefund(c.env.DB, { ...request, actorId: user.id, now })
  );
  return ok(c, { ...out.result, replayed: out.replayed }, out.replayed ? 200 : 201);
});

adminPrintCloudRoutes.get('/payment-events', requireFinancialScope, async (c) =>
  ok(c, await many(c.env.DB, 'SELECT * FROM pc_payment_events ORDER BY received_at DESC LIMIT ?', queryInt(c, 'limit', 100, 1, 500)))
);

// ------------------------------------------------------------------ jobs (operators)

adminPrintCloudRoutes.get('/jobs', async (c) => {
  const status = c.req.query('status');
  if (status && !(JOB_STATUSES as readonly string[]).includes(status)) throw invalid('status', 'not_allowed');
  return ok(
    c,
    await many(
      c.env.DB,
      `SELECT id, user_id, title, status, printer_model_id, assigned_printer_id, priority, needs_operator_approval, queued_at, started_at, ended_at, created_at
         FROM pc_print_jobs ${status ? 'WHERE status = ?' : ''} ORDER BY priority DESC, created_at DESC LIMIT 500`,
      ...(status ? [status] : [])
    )
  );
});

adminPrintCloudRoutes.get('/jobs/:id', async (c) => {
  const { config } = await requestConfig(c);
  const job = await loadJob(c.env.DB, param(c, 'id'));
  const consumption = await many(c.env.DB, 'SELECT * FROM pc_consumption_records WHERE job_id = ? ORDER BY created_at', job.id);
  return ok(c, { ...(await jobView(c.env.DB, job, config.telemetry_stale_seconds, new Date())), user_id: job.user_id, consumption_records: consumption });
});

adminPrintCloudRoutes.post('/jobs/:id/approve', async (c) => {
  await approveJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date());
  return ok(c, { job_id: param(c, 'id'), status: 'queued' });
});

adminPrintCloudRoutes.post('/jobs/:id/reject', async (c) => {
  const body = await jsonObject(c);
  const job = await loadJob(c.env.DB, param(c, 'id'));
  if (job.status !== 'confirmed') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'cancelled' });
  await cancelJob(c.env.DB, job, staffActor(c), new Date(), `rejected: ${reqString(body.reason, 'reason', { max: 300 })}`);
  return ok(c, { job_id: job.id, status: 'cancelled' });
});

/** An operator enters what a desktop slicer measured (provenance 'operator'). */
adminPrintCloudRoutes.post('/jobs/:id/estimate', async (c) => {
  const actor = staffActor(c);
  const job = await loadJob(c.env.DB, param(c, 'id'));
  return ok(c, await recordEstimate(c.env.DB, job, parseEstimate(await jsonObject(c)), { provenance: 'operator', submittedBy: actor.id, actor, now: new Date() }));
});

adminPrintCloudRoutes.post('/jobs/:id/assign', async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  await assignJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), reqString(body.printer_id, 'printer_id', { max: 120 }), staffActor(c), config, new Date());
  return ok(c, { job_id: param(c, 'id'), status: 'preparing', printer_id: body.printer_id });
});

adminPrintCloudRoutes.post('/jobs/:id/unassign', async (c) => {
  const body = await jsonObject(c);
  await unassignJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date(), optString(body.reason, 'reason', 300) || 'operator');
  return ok(c, { job_id: param(c, 'id'), status: 'queued' });
});

adminPrintCloudRoutes.post('/jobs/:id/start', async (c) => {
  await startJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date());
  return ok(c, { job_id: param(c, 'id'), status: 'printing' });
});

adminPrintCloudRoutes.post('/jobs/:id/pause', async (c) => {
  const body = await jsonObject(c);
  await pauseJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date(), optString(body.reason, 'reason', 300) || 'operator');
  return ok(c, { job_id: param(c, 'id'), status: 'paused' });
});

adminPrintCloudRoutes.post('/jobs/:id/resume', async (c) => {
  await resumeJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date());
  return ok(c, { job_id: param(c, 'id'), status: 'printing' });
});

/** Completion with consumption VERIFIED by the operator entering it. */
adminPrintCloudRoutes.post('/jobs/:id/complete', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await completeJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), parseConsumption(await jsonObject(c)), staffActor(c), config, new Date()));
});

/** Verify an agent's reported completion — as reported, or with the operator's corrections. */
adminPrintCloudRoutes.post('/jobs/:id/verify-completion', async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const job = await loadJob(c.env.DB, param(c, 'id'));
  const recordId = reqString(body.consumption_record_id, 'consumption_record_id', { max: 120 });
  const rec = await one<{ printed_seconds: number; materials_json: string }>(
    c.env.DB,
    'SELECT printed_seconds, materials_json FROM pc_consumption_records WHERE id = ? AND job_id = ? AND verified = 0',
    recordId,
    job.id
  );
  if (!rec) throw pcError('NOT_FOUND');
  const consumption = body.printed_seconds === undefined
    ? { printed_seconds: Number(rec.printed_seconds), materials: parseJson<Array<{ variant_id: string; qty: number }>>(rec.materials_json, []) }
    : parseConsumption(body);
  return ok(c, await completeJob(c.env.DB, job, consumption, staffActor(c), config, new Date(), recordId));
});

adminPrintCloudRoutes.post('/jobs/:id/fail', async (c) => {
  const report = parseFailure(await jsonObject(c));
  return ok(c, await failJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), report, staffActor(c), new Date()), 201);
});

adminPrintCloudRoutes.post('/jobs/:id/cancel', async (c) => {
  const body = await jsonObject(c);
  await cancelJob(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), staffActor(c), new Date(), reqString(body.reason, 'reason', { max: 300 }));
  return ok(c, { job_id: param(c, 'id'), status: 'cancelled' });
});

adminPrintCloudRoutes.post('/jobs/:id/priority', async (c) => {
  const body = await jsonObject(c);
  await setPriority(c.env.DB, await loadJob(c.env.DB, param(c, 'id')), reqInt(body.priority, 'priority', { min: -100, max: 100 }), staffActor(c), new Date());
  return ok(c, { job_id: param(c, 'id'), priority: body.priority });
});

adminPrintCloudRoutes.get('/failures', async (c) =>
  ok(
    c,
    await many(
      c.env.DB,
      `SELECT f.*, j.user_id, j.title FROM pc_failures f JOIN pc_print_jobs j ON j.id = f.job_id
        ${c.req.query('status') ? 'WHERE f.status = ?' : ''} ORDER BY f.created_at DESC LIMIT 200`,
      ...(c.req.query('status') ? [c.req.query('status')] : [])
    )
  )
);

/**
 * Resolve a failure under the configured policy. Stating billable amounts by
 * hand ('manual_review') is a money decision and needs a full admin.
 */
adminPrintCloudRoutes.post('/failures/:id/resolve', async (c) => {
  const body = await jsonObject(c);
  const { config } = await requestConfig(c);
  const responsible = body.responsible;
  if (!['workshop', 'customer', 'model', 'undetermined'].includes(String(responsible))) throw invalid('responsible', 'not_allowed');
  const decision: FailureDecision = {
    responsible: responsible as FailureDecision['responsible'],
    reprint: body.reprint === true,
    note: optString(body.note, 'note', 500),
  };
  if (body.billable_seconds !== undefined || body.billable_materials !== undefined) {
    if (!canMoveMoney(c.env, c.get('user'))) throw pcError('FORBIDDEN', { reason: 'financial_scope_required' }, 403);
    decision.billable_seconds = reqInt(body.billable_seconds ?? 0, 'billable_seconds', { min: 0, max: 60 * 24 * 3600 });
    decision.billable_materials = parseConsumption({ printed_seconds: 0, materials: body.billable_materials ?? [] }).materials;
  }
  const now = new Date();
  const result = await resolveFailure(c.env.DB, param(c, 'id'), decision, staffActor(c), config, now);
  const reprint = result.reprint_job_id && responsible === 'workshop' ? await autoConfirmReprint(c.env.DB, result.reprint_job_id, config, now) : null;
  return ok(c, { ...result, reprint_status: reprint });
});

// ------------------------------------------------------------------ queue and printers

adminPrintCloudRoutes.get('/queue', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await estimateQueue(c.env.DB, config, new Date()));
});

adminPrintCloudRoutes.post('/queue/run', async (c) => {
  const { config } = await requestConfig(c);
  // One request is one D1 invocation: the pass stays within 600 statements of it. A release that does not
  // fit is deferred and named (`deferred`), and `more` asks the operator to run it again (queue.ts `runScheduler`).
  const counted = countingD1(c.env.DB);
  return ok(c, await runScheduler(counted.db, config, new Date(), 20, schedulerRoom(roomWithin(() => counted.executed, 600))));
});

adminPrintCloudRoutes.get('/printers', async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await printerStatuses(c.env.DB, config.telemetry_stale_seconds, new Date(), c.req.query('model_id') ?? undefined));
});

adminPrintCloudRoutes.get('/printers/:id/events', async (c) =>
  ok(c, await many(c.env.DB, 'SELECT * FROM pc_printer_events WHERE printer_id = ? ORDER BY created_at DESC LIMIT ?', param(c, 'id'), queryInt(c, 'limit', 100, 1, 500)))
);

/**
 * A printer's maintenance windows, latest start first — the ids `PATCH
 * /maintenance/{id}` closes or cancels. What a window cost is the owner's:
 * the column is removed for every other reader.
 */
adminPrintCloudRoutes.get('/printers/:id/maintenance', async (c) => {
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    'SELECT id, printer_id, kind, starts_at, ends_at, status, notes, cost_iqd, created_by, created_at FROM pc_printer_maintenance WHERE printer_id = ? ORDER BY starts_at DESC LIMIT ?',
    param(c, 'id'),
    queryInt(c, 'limit', 100, 1, 500)
  );
  const cost = costView(c);
  return ok(c, rows.map(({ cost_iqd, ...r }) => (cost ? { ...r, cost_iqd } : r)));
});

adminPrintCloudRoutes.post('/printers/:id/commands', async (c) => {
  const body = await jsonObject(c);
  const actor = staffActor(c);
  return ok(
    c,
    await queueCommand(c.env.DB, param(c, 'id'), reqString(body.command, 'command', { max: 40 }), typeof body.job_id === 'string' ? body.job_id : null, actor as { type: 'admin' | 'operator'; id: string }, new Date()),
    202
  );
});

adminPrintCloudRoutes.post('/printers/:id/maintenance', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  if (body.cost_iqd !== undefined && !canWriteCost(c.env, user)) throw pcError('FORBIDDEN', { field: 'cost_iqd', reason: 'cost_owner_only' }, 403);
  const printer = await one<{ id: string }>(c.env.DB, 'SELECT id FROM pc_printers WHERE id = ?', param(c, 'id'));
  if (!printer) throw pcError('NOT_FOUND');
  const startsAt = optIso(body.starts_at, 'starts_at');
  const endsAt = optIso(body.ends_at, 'ends_at');
  if (!startsAt || !endsAt || endsAt <= startsAt) throw invalid('ends_at', 'must_follow_starts_at');
  const kind = String(body.kind ?? 'scheduled');
  if (!['scheduled', 'unscheduled', 'repair', 'calibration'].includes(kind)) throw invalid('kind', 'not_allowed');
  const id = pcId('pcmt');
  const now = new Date();
  await runBatch(c.env.DB, [
    c.env.DB
      .prepare(
        "INSERT INTO pc_printer_maintenance (id, printer_id, kind, starts_at, ends_at, status, notes, cost_iqd, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)"
      )
      .bind(id, printer.id, kind, startsAt, endsAt, optString(body.notes, 'notes', 500), body.cost_iqd === undefined ? 0 : reqInt(body.cost_iqd, 'cost_iqd', { min: 0, max: 1_000_000_000 }), user.id, iso(now)),
    ...(await pcAudit(c.env.DB, user.id, 'printer.maintenance', printer.id, { maintenance_id: id, starts_at: startsAt, ends_at: endsAt, kind })),
  ]);
  return ok(c, { maintenance_id: id }, 201);
});

adminPrintCloudRoutes.patch('/maintenance/:id', async (c) => {
  const user = currentUser(c);
  const body = await jsonObject(c);
  if (body.cost_iqd !== undefined && !canWriteCost(c.env, user)) throw pcError('FORBIDDEN', { field: 'cost_iqd', reason: 'cost_owner_only' }, 403);
  const status = body.status;
  if (status !== 'done' && status !== 'cancelled' && status !== 'planned') throw invalid('status', 'not_allowed');
  const m = await one<{ id: string; printer_id: string }>(c.env.DB, 'SELECT id, printer_id FROM pc_printer_maintenance WHERE id = ?', param(c, 'id'));
  if (!m) throw pcError('NOT_FOUND');
  await runBatch(c.env.DB, [
    c.env.DB
      .prepare('UPDATE pc_printer_maintenance SET status = ?, cost_iqd = COALESCE(?, cost_iqd), notes = COALESCE(?, notes) WHERE id = ?')
      .bind(status, body.cost_iqd === undefined ? null : reqInt(body.cost_iqd, 'cost_iqd', { min: 0, max: 1_000_000_000 }), body.notes === undefined ? null : optString(body.notes, 'notes', 500), m.id),
    ...(await pcAudit(c.env.DB, user.id, 'printer.maintenance_update', m.printer_id, { maintenance_id: m.id, status })),
  ]);
  return ok(c, { maintenance_id: m.id, status });
});

adminPrintCloudRoutes.get('/agents', async (c) =>
  ok(c, await many(c.env.DB, 'SELECT id, name, capabilities_json, active, last_seen_at, created_at, revoked_at FROM pc_agents ORDER BY created_at DESC'))
);

/** A new agent credential, shown ONCE. A money-scope act: it controls machines. */
adminPrintCloudRoutes.post('/agents', requireFinancialScope, async (c) => {
  const body = await jsonObject(c);
  return ok(c, await createAgent(c.env.DB, { name: reqString(body.name, 'name', { max: 80 }), capabilities: body.capabilities, actorId: currentUser(c).id, now: new Date() }), 201);
});

adminPrintCloudRoutes.post('/agents/:id/revoke', requireFinancialScope, async (c) => {
  await revokeAgent(c.env.DB, param(c, 'id'), currentUser(c).id, new Date());
  return ok(c, { agent_id: param(c, 'id'), active: false });
});

// ------------------------------------------------------------------ shipments

adminPrintCloudRoutes.get('/shipments', async (c) => {
  const status = c.req.query('status');
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, user_id, kind, status, address_json, packaging, fee_iqd, fee_order_id, carrier, tracking_ref, created_at, updated_at
       FROM pc_shipments ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 500`,
    ...(status ? [status] : [])
  );
  const money = canMoveMoney(c.env, c.get('user'));
  return ok(c, rows.map((r) => (money ? r : { ...r, fee_iqd: undefined, fee_order_id: undefined })));
});

/** One shipment with what it carries — the packing list. The delivery fee, as in the list, for money scope only. */
adminPrintCloudRoutes.get('/shipments/:id', async (c) => {
  const view = await shipmentView(c.env.DB, param(c, 'id'));
  return ok(c, canMoveMoney(c.env, c.get('user')) ? view : { ...view, fee_iqd: undefined, fee_order_id: undefined });
});

adminPrintCloudRoutes.post('/shipments/:id/advance', async (c) => {
  const body = await jsonObject(c);
  const to = reqString(body.to, 'to', { max: 30 }) as ShipmentStatus;
  return ok(
    c,
    await advanceShipment(c.env.DB, param(c, 'id'), to, {
      carrier: body.carrier === undefined ? undefined : optString(body.carrier, 'carrier', 80),
      tracking_ref: body.tracking_ref === undefined ? undefined : optString(body.tracking_ref, 'tracking_ref', 120),
      note: body.note === undefined ? undefined : optString(body.note, 'note', 300),
      actorId: currentUser(c).id,
      now: new Date(),
    })
  );
});

// ------------------------------------------------------------------ buybacks (money)

adminPrintCloudRoutes.get('/buybacks', requireFinancialScope, async (c) => {
  const status = c.req.query('status');
  return ok(c, await many(c.env.DB, `SELECT * FROM pc_buyback_requests ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 500`, ...(status ? [status] : [])));
});
adminPrintCloudRoutes.post('/buybacks/:id/approve', requireFinancialScope, async (c) => {
  const body = await jsonObject(c);
  return ok(c, await approveBuyback(c.env.DB, param(c, 'id'), currentUser(c).id, new Date(), optString(body.note, 'note', 500)));
});
adminPrintCloudRoutes.post('/buybacks/:id/reject', requireFinancialScope, async (c) => {
  const body = await jsonObject(c);
  return ok(c, await rejectBuyback(c.env.DB, param(c, 'id'), currentUser(c).id, new Date(), reqString(body.note, 'note', { max: 500 })));
});
adminPrintCloudRoutes.post('/buybacks/:id/paid', requireFinancialScope, async (c) => {
  const body = await jsonObject(c);
  await markBuybackPaid(c.env.DB, param(c, 'id'), currentUser(c).id, reqString(body.reference, 'reference', { max: 200 }), new Date());
  return ok(c, { buyback_id: param(c, 'id'), payout_status: 'paid' });
});

// ------------------------------------------------------------------ reports, reconciliation, tasks, audit

adminPrintCloudRoutes.get('/reports/revenue', requireFinancialScope, async (c) =>
  ok(c, await revenueReport(c.env.DB, parseRange(c.req.query('from'), c.req.query('to'), new Date())))
);

adminPrintCloudRoutes.get('/reports/profit', requireCostRead, async (c) => {
  const { config } = await requestConfig(c);
  return ok(c, await profitReport(c.env.DB, parseRange(c.req.query('from'), c.req.query('to'), new Date()), config.cost_electricity_iqd_per_kwh));
});

adminPrintCloudRoutes.get('/reports/operations', async (c) => ok(c, await operationsReport(c.env.DB, parseRange(c.req.query('from'), c.req.query('to'), new Date()))));

adminPrintCloudRoutes.get('/reconcile', requireFinancialScope, async (c) => ok(c, await reconcile(c.env.DB)));

adminPrintCloudRoutes.get('/tasks', async (c) => ok(c, await taskOverview(c.env.DB)));

adminPrintCloudRoutes.post('/tasks/run', async (c) => {
  // One request is one D1 invocation: the run stays within 600 statements of it, a task at a time, a scheduling pass first.
  const counted = countingD1(c.env.DB);
  const room = roomWithin(() => counted.executed, 600);
  return ok(c, await runTasksByHand({ ...c.env, DB: counted.db }, { limit: queryInt(c, 'limit', 10, 1, 25), room }));
});

adminPrintCloudRoutes.get('/audit', requireFinancialScope, async (c) => {
  const target = c.req.query('target');
  return ok(
    c,
    await many(
      c.env.DB,
      `SELECT id, actor_id, action, target, detail, created_at FROM audit_log WHERE action LIKE 'print_cloud.%' ${target ? 'AND target = ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...(target ? [target] : []),
      queryInt(c, 'limit', 100, 1, 500)
    )
  );
});

