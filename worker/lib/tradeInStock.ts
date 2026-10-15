/**
 * THE OLD DEVICE BECOMES STOCK WHEN THE NEW ONE IS DELIVERED (Services S-P2 spec §6.8; owner
 * decision 2 and C10a; DECISIONS row 238; fixes M4/G8, M5/G9, G17).
 *
 * Completion is no longer a button pressed while the new order is still on its way: it happens
 * when that order is DELIVERED — from the delivered hook (`runOrderDeliveredEffects`, every door
 * that delivers an order), from the services sweep (catch-up), and from the owner's manual door
 * (after delivery only). One batch per request:
 *
 *   1. the request → completed, fenced on its status AND on an active use of its credit by THIS
 *      order, delivered (the order's state is asked inside the write);
 *   2. the request's own token fence;
 *   3. custody (the trader's link revoked, the serial released `traded_in`, audited) — not for an
 *      AMS on its own, which leaves the printer with its customer;
 *   4. a HIDDEN «used» draft product `prd_ti_<request>` copied from the source product by an
 *      allow-list (words, brand, family, photos of the MODEL, specs) — never a price, a cost, an
 *      option or a colour: the owner prices it in V2 before it lists (§16 D-8);
 *   5. its lot `ilot_ti_<request>`, one unit at cost = the credit given (0181's
 *      `inventory_lot_no_reinsert` makes a replay abort the batch);
 *   6. the provenance row in `trade_in_stock` (append-only, one per request);
 *   7. stock +1 on the draft; 8. the ledger row `trade_in_stock:<request>`;
 *   9. events, the customer's notice, the audit row.
 *
 * The draft's FIFO queue holds exactly this unit, so its resale carries the credit as its cost and
 * can never eat a new unit's lot (G9). `stock_serial_links` is not written: its single row per
 * serial keeps the FIRST sale's history (serialAssignments.ts).
 *
 * A request whose credit was spent before S-P2 without intake (cut-over, §7) completes on delivery
 * with custody only; its stock is booked when the device is received (`bookTradeInStock`, from the
 * intake door and the sweep). Everything here is TOTAL from the delivered hook: a failure is
 * logged and the sweep retries; the delivery itself never fails because of it.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { newId, randomToken } from './crypto';
import { notifyStatement } from './notifications';
import { auditStatements } from './audit';
import { tradeInV2Installed } from './tradeInSchema';
import { componentRefsFor } from './tradeInOffer';
import {
  creditOrders,
  custodyStatements,
  custodyTarget,
  eventStatement,
  fence,
  isAbort,
  loadComponents,
  loadRequest,
  loadRuleBook,
  refuse,
  requestPath,
  type RequestRow,
} from './tradeIn';
import { checklistOf, checklistLabelCkb, type ComponentInputs } from '@levonis/pricing/tradeIn';

export type CompletionActor = { id: string | null; role: 'system' | 'admin' };

export const draftIdOf = (requestId: string) => `prd_ti_${requestId}`;
export const lotIdOf = (requestId: string) => `ilot_ti_${requestId}`;

/** The order whose ACTIVE use of this request's credit is live (not cancelled), if any. */
async function liveCreditOrder(db: D1Database, requestId: string): Promise<{ order_id: string; status: string } | null> {
  const live = (await creditOrders(db, requestId)).find((o) => o.status !== 'cancelled' && o.redemption_state === 'active');
  return live ? { order_id: live.order_id, status: live.status } : null;
}

/** «excellent» / «good» / «fair» from the desk's condition chips (§16 D-8: never «like_new» automatically). */
function gradeOf(inputs: Partial<ComponentInputs> | null): 'excellent' | 'good' | 'fair' {
  const scores = [inputs?.cleanliness, inputs?.exterior, inputs?.scratches].map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const low = scores.length ? Math.min(...scores) : 4;
  return low >= 5 ? 'excellent' : low >= 4 ? 'good' : 'fair';
}

interface StockPlan {
  statements: D1PreparedStatement[];
  draftId: string;
  lotId: string;
}

/**
 * Statements 4–8 for one request: the hidden draft, its lot, the provenance, stock +1, the ledger.
 * Null when there is nothing to copy (the source product is gone) — the completion then moves the
 * custody alone and the event says why.
 */
export async function stockStatements(env: Env, req: RequestRow, opts: { orderId: string; actorId: string | null; now: string }): Promise<StockPlan | null> {
  const db = env.DB;
  const comps = await loadComponents(db, req.id);
  // An AMS on its own becomes a used AMS: the owner's linked standalone AMS product when there is one.
  let sourceId = req.source_product_id;
  if (!sourceId) {
    sourceId = (await db.prepare('SELECT product_id FROM order_items WHERE id = ?').bind(req.order_item_id).first<{ product_id: string | null }>())?.product_id ?? null;
  }
  if (!sourceId) return null;
  let modelId = sourceId;
  if (req.scope === 'ams_only') {
    const refs = await componentRefsFor(db, sourceId);
    const ams = refs.find((r) => r.role === 'ams' && r.ref_product_id);
    if (ams?.ref_product_id) modelId = ams.ref_product_id;
  }
  const model = await db.prepare('SELECT id, slug FROM products WHERE id = ?').bind(modelId).first<{ id: string; slug: string }>();
  if (!model) return null;
  const book = await loadRuleBook(db);
  const comp = comps.find((c) => c.role === (req.scope === 'ams_only' ? 'ams' : 'device')) ?? comps[0];
  const intakeInputs = comp ? safeParse<Partial<ComponentInputs> | null>(comp.intake_inputs_json ?? '{}', null) : null;
  const facts = safeParse<{ hours_seen?: number | null; findings?: string }>(req.intake_json ?? '{}', {});
  const faults = comp ? checklistOf(book[comp.family], 'faults').filter((f) => (intakeInputs?.faults ?? []).includes(f.id)) : [];
  const findings = typeof facts.findings === 'string' ? facts.findings : '';
  const repairs = typeof intakeInputs?.repair_notes === 'string' ? intakeInputs.repair_notes : '';
  const condition = {
    kind: 'used',
    grade: gradeOf(intakeInputs),
    usage_hours: typeof facts.hours_seen === 'number' ? facts.hours_seen : null,
    warranty_months: 1,
    new_product_id: modelId,
    fault_ar: faults.map((f) => f.label_ar).join('، '),
    fault_en: faults.map((f) => f.label_en).join(', '),
    fault_ckb: faults.map((f) => checklistLabelCkb(f.label_ar) ?? f.label_en).join('، '),
    // The desk's own words in every slot until the owner edits them.
    repair_ar: repairs,
    repair_en: repairs,
    repair_ckb: repairs,
    notes_ar: findings,
    notes_en: findings,
    notes_ckb: findings,
    // Never a customer's or an intake photograph: those are private evidence.
    unit_images: [],
  };
  const draftId = draftIdOf(req.id);
  const lotId = lotIdOf(req.id);
  const slug = `${model.slug}-used-${randomToken(3)}`.slice(0, 120);
  const usedSub = req.scope === 'ams_only' || comp?.family === 'ams' || comp?.family === 'accessory' ? 'cat_used_pacc' : 'cat_used_printers';
  const cost = Math.max(0, Math.trunc(req.credit_iqd ?? 0));
  const day = opts.now.slice(0, 10);
  const amsName = req.scope === 'ams_only' && modelId === sourceId;
  const statements: D1PreparedStatement[] = [
    // 4. The hidden used draft: an allow-list of the model's words, brand, family, photos and specs.
    db
      .prepare(
        `INSERT INTO products (id, slug, status, name, name_ar, name_ku, description, description_ar, description_ku, images, brand, brand_id,
                               template_family, spec_fields, specifications, category_id, sub_category_id, selling_type, sale_types, stock, condition_doc)
         SELECT ?1, ?2, 'hidden', src.name || ?6, src.name_ar || ?6, src.name_ku || ?6, src.description, src.description_ar, src.description_ku,
                src.images, src.brand, src.brand_id, src.template_family, src.spec_fields, src.specifications,
                COALESCE((SELECT id FROM catalogs WHERE id = 'cat_used'), src.category_id),
                COALESCE((SELECT id FROM catalogs WHERE id = ?4), src.sub_category_id),
                'direct_sale', '["direct_sale"]', 0, ?5
           FROM products src
          WHERE src.id = ?3 AND NOT EXISTS (SELECT 1 FROM products WHERE id = ?1)`
      )
      .bind(draftId, slug, modelId, usedSub, JSON.stringify(condition), amsName ? ' (AMS)' : ''),
    // 5. Its lot: one unit at cost = what was given for it. A replay aborts (0181 no-reinsert).
    db
      .prepare(
        `INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, purchase_unit_iqd,
                                     shipping_share_iqd, internal_share_iqd, total_cost_iqd, cost_basis, incoming_id, supplier_id,
                                     purchase_date, received_at, created_by)
         SELECT ?1, ?2, 'base', '', 1, 1, ?3, ?3, 0, 0, ?3, 'received', NULL, NULL, ?4, ?5, ?6
          WHERE EXISTS (SELECT 1 FROM products WHERE id = ?2 AND stock IS NOT NULL)`
      )
      .bind(lotId, draftId, cost, day, opts.now, opts.actorId),
    // 6. Provenance, append-only (PK + UNIQUE lot + no-reinsert).
    db
      .prepare(
        `INSERT INTO trade_in_stock (request_id, lot_id, product_id, source_product_id, serial_norm, cost_basis_iqd, order_id, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(req.id, lotId, draftId, sourceId, req.intake_serial_norm ?? null, cost, opts.orderId, opts.actorId, opts.now),
    // 7. Stock +1 on the draft, and 8. its ledger row.
    db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL').bind(draftId),
    db
      .prepare(
        `INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason)
         VALUES (?1, ?2, 'base', '', 'adjust_in', 1, NULL, ?3, ?4, 'trade-in intake')`
      )
      .bind(`ilg_ti_${req.id}`, draftId, `trade_in_stock:${req.id}`, opts.actorId),
  ];
  return { statements, draftId, lotId };
}

/** «اكتمل الاستبدال» — the customer's notice (ar/en/ckb). */
function completedNotice(db: D1Database, req: RequestRow): D1PreparedStatement {
  return notifyStatement(db, {
    userId: req.user_id,
    kind: 'trade_in',
    title_ar: 'اكتمل الاستبدال',
    title_en: 'Your trade-in is complete',
    meta: { title_ckb: 'گۆڕینەوەکە تەواو بوو' },
    link: requestPath(req.id),
    entity_type: 'trade_in',
    entity_id: req.id,
    eventKey: `trade_in:${req.id}:completed`,
  }).stmt;
}

/**
 * ONE REQUEST, COMPLETED BY ITS ORDER'S DELIVERY. `orderId` null: a request whose credit is zero
 * (nothing to buy), completed by the owner. Throws the honest refusal; callers on the delivered
 * path contain it.
 */
async function completeOne(env: Env, req: RequestRow, orderId: string | null, actor: CompletionActor): Promise<RequestRow> {
  const db = env.DB;
  const now = new Date().toISOString();
  const token = randomToken(12);
  const custody = await custodyStatements(env, req, actor.id, now);
  const stock = req.intake_at ? await stockStatements(env, req, { orderId: orderId ?? '', actorId: actor.id, now }) : null;
  const delivered = orderId
    ? `AND EXISTS (SELECT 1 FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
                    WHERE r.coupon_id = trade_in_requests.coupon_id AND r.state = 'active' AND o.id = ?4 AND o.status = 'delivered')`
    : `AND COALESCE(credit_iqd, 0) = 0 AND ?4 IS NULL`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE trade_in_requests SET status = 'completed', completed_at = ?2, updated_at = ?2, decision_token = ?3 WHERE id = ?1 AND status = 'awaiting_payment' ${delivered}`)
      .bind(req.id, now, token, orderId),
    fence(db, req.id, token),
    eventStatement(db, req.id, { id: actor.id, role: actor.role }, 'complete', 'awaiting_payment', 'completed', { order_id: orderId }, now),
    ...(stock
      ? [eventStatement(db, req.id, { id: actor.id, role: actor.role }, 'stock_booked', 'completed', 'completed', {}, now)]
      : req.intake_at
        ? [eventStatement(db, req.id, { id: actor.id, role: actor.role }, 'stock_skipped', 'completed', 'completed', { reason: 'source_missing' }, now)]
        : []),
    completedNotice(db, req),
    ...(await auditStatements(db, actor.id, 'trade_in.complete', req.id, { order_id: orderId, via: actor.role === 'system' ? 'delivery' : 'manual', stock: stock ? { lot_id: stock.lotId, product_id: stock.draftId } : null })).statements,
    // After the fences: a completion that lost its race moves no device and books nothing.
    ...custody.statements,
    ...(stock?.statements ?? []),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e) || /BATCH_COST_IMMUTABLE|TRADE_IN_STOCK_IMMUTABLE/.test(e instanceof Error ? e.message : String(e))) {
      if (custody.unitId && (await custodyTarget(db, req))?.linkedElsewhere) throw refuse('TRADE_IN_LINKED_ELSEWHERE');
      throw refuse('TRADE_IN_STALE');
    }
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

/**
 * EVERY TRADE-IN THIS DELIVERED ORDER COMPLETES — total: each request is contained, a failure is
 * logged and the services sweep retries it. Returns the ids completed.
 */
export async function completeTradeInsForOrder(env: Env, orderId: string, actor: CompletionActor = { id: null, role: 'system' }): Promise<string[]> {
  const db = env.DB;
  try {
    if (!(await tradeInV2Installed(db))) return [];
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>();
    if (order?.status !== 'delivered') return [];
    const { results } = await db
      .prepare(
        `SELECT t.id FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id JOIN trade_in_requests t ON t.id = c.trade_in_id
          WHERE r.order_id = ? AND r.state = 'active' AND t.status = 'awaiting_payment' AND t.coupon_id = c.id LIMIT 5`
      )
      .bind(orderId)
      .all<{ id: string }>();
    const done: string[] = [];
    for (const { id } of results ?? []) {
      try {
        const req = await loadRequest(db, id);
        if (!req || req.status !== 'awaiting_payment') continue;
        await completeOne(env, req, orderId, actor);
        done.push(id);
      } catch (e) {
        console.error('trade-in completion on delivery failed', id, e instanceof Error ? e.message : String(e));
      }
    }
    return done;
  } catch (e) {
    console.error('trade-in completion on delivery failed for order', orderId, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * THE OWNER'S MANUAL DOOR (decision 3; the route asks `trade_in_complete`, owner-only): only once
 * the device is received and the order its credit bought is delivered (TRADE_IN_ORDER_NOT_DELIVERED);
 * a request whose credit is zero has nothing to wait for.
 */
export async function completeManually(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  const db = env.DB;
  if (req.status !== 'awaiting_payment') throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (!req.intake_at) throw refuse('TRADE_IN_INTAKE_REQUIRED');
  const live = await liveCreditOrder(db, req.id);
  if ((req.credit_iqd ?? 0) > 0) {
    if (!live) throw refuse('TRADE_IN_NO_ORDER');
    if (live.status !== 'delivered') throw refuse('TRADE_IN_ORDER_NOT_DELIVERED', { order_id: live.order_id });
  }
  return completeOne(env, req, (req.credit_iqd ?? 0) > 0 ? live!.order_id : null, { id: adminId, role: 'admin' });
}

/**
 * A REQUEST COMPLETED WITHOUT ITS DEVICE'S INTAKE (before S-P2, or a credit spent on photos), whose
 * device has now been received: its stock is booked once (the sweep, and the intake door).
 */
export async function bookTradeInStock(env: Env, req: RequestRow, actor: CompletionActor = { id: null, role: 'system' }): Promise<boolean> {
  const db = env.DB;
  if (req.status !== 'completed' || !req.intake_at) return false;
  const already = await db.prepare('SELECT 1 AS x FROM trade_in_stock WHERE request_id = ?').bind(req.id).first();
  if (already) return false;
  const now = new Date().toISOString();
  const orderId =
    (await db
      .prepare(
        `SELECT r.order_id FROM coupons c JOIN coupon_redemptions r ON r.coupon_id = c.id JOIN orders o ON o.id = r.order_id
          WHERE c.trade_in_id = ? AND o.status <> 'cancelled' ORDER BY r.created_at DESC LIMIT 1`
      )
      .bind(req.id)
      .first<{ order_id: string }>())?.order_id ?? '';
  const stock = await stockStatements(env, req, { orderId, actorId: actor.id, now });
  if (!stock) {
    // The source model is gone: recorded once, so the services sweep stops asking (the owner books it by hand).
    await db
      .prepare(
        `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
         SELECT ?1, ?2, ?3, ?4, 'stock_skipped', 'completed', 'completed', '{"reason":"source_missing"}', ?5
          WHERE NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = ?2 AND e.action = 'stock_skipped')`
      )
      .bind(newId('tie'), req.id, actor.id, actor.role, now)
      .run();
    return false;
  }
  try {
    await db.batch([
      db.prepare(`UPDATE trade_in_requests SET status = CASE WHEN status = 'completed' AND intake_at IS NOT NULL THEN status ELSE NULL END WHERE id = ?`).bind(req.id),
      ...stock.statements,
      eventStatement(db, req.id, { id: actor.id, role: actor.role }, 'stock_booked', 'completed', 'completed', {}, now),
      ...(await auditStatements(db, actor.id, 'trade_in.stock_booked', req.id, { lot_id: stock.lotId, product_id: stock.draftId })).statements,
    ]);
    return true;
  } catch (e) {
    if (isAbort(e) || /BATCH_COST_IMMUTABLE|TRADE_IN_STOCK_IMMUTABLE/.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}
