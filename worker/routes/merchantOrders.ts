/**
 * ONE STORE ORDER, AS A STORY — GET /api/merchant/orders/:id/timeline (W3-B).
 *
 * The order detail screen (src/components/merchant/orders/**) reads the order
 * itself from GET /api/merchant/orders/:id (worker/routes/merchant.ts: the
 * customer, the address, the totals) and everything that HAPPENED to it from
 * here, in one answer:
 *
 *   events    every recorded fact about the order, oldest first
 *   money     the order's own merchant-ledger lines, summed — gross, the
 *             commission line, the delivery line, reversals, and where the
 *             net sits now (pending / available)
 *   delivery  what the checkout applied: governorate, rule, fee, preparation
 *             days, pickup or delivery — the snapshot, never recomputed
 *   items     the lines with their variant / SKU snapshot
 *   chat      the order's conversation, when the owner is in it
 *
 * NOTHING IS INVENTED. Every event is a row that already exists — no new
 * tracking was added, because every change of a store order's state is
 * already recorded somewhere:
 *
 *   placed              orders.created_at
 *   status / cancelled  order_status_history (the merchant's moves, the stage
 *                       door, the courier sync, the sweeps and the one
 *                       cancellation, whose anchor row is `osh_cancel_<id>`)
 *                       and audit_log `order.status` — the admin's status
 *                       dropdown, the one door that writes no history row
 *   refunded            the customer's wallet refund row (`wtx_refund_<id>_usd`)
 *   receipt_confirmed   orders.receipt_confirmed_at («استلمت طلبي»)
 *   credit_*            merchant_ledger_entries for this order (W2-B)
 *   dispute_*           community_complaints / support_tickets on the order
 *   chat_started        the order's chat, when the owner participates
 *   release_due         EXPECTED, not happened: three days after delivery the
 *                       money releases on its own (owner decision) — marked
 *                       `expected: true`, and `frozen` while a dispute is open
 *
 * WHAT NEVER LEAVES. No free text a third party wrote (history notes, admin
 * notes, complaint descriptions, ticket subjects), no admin or staff id, no
 * user id: an actor is a ROLE — the store, the customer, Levonis, the
 * courier, or the system.
 *
 * OWNER-ISOLATED IN SQL: the order is read `WHERE id = ? AND merchant_id = ?`
 * with the merchant from the session, and nothing else is read before that
 * row exists. Another store's order is the same 404 as no order at all.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, requireAuth } from '../lib/http';
import { requireStoreOwner } from '../lib/merchantAuth';
import { orderCreditStateSql } from '../lib/merchantLedger';
import { STORE_RELEASE_DAYS, cancelAnchorId, openDisputeSql } from '../lib/storeOrderOps';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

export const merchantOrderRoutes = new Hono<AppContext>();
merchantOrderRoutes.use('*', requireAuth);

/** The same shape the workspace router accepts for an id (packages/contracts). */
const ORDER_ID_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,80}$/;

export type TimelineActor = 'store' | 'customer' | 'levonis' | 'courier' | 'system';

export type TimelineEvent =
  | { kind: 'placed'; at: string; actor: 'customer'; total_iqd: number }
  | { kind: 'status'; at: string; status: string; stage: string; actor: TimelineActor }
  | { kind: 'cancelled'; at: string; actor: TimelineActor }
  | { kind: 'refunded'; at: string; actor: 'system' }
  | { kind: 'receipt_confirmed'; at: string; actor: 'customer' }
  | { kind: 'credit_recorded' | 'credit_reversed'; at: string; lines: Array<{ kind: string; amount_iqd: number }>; bucket: string }
  | { kind: 'credit_released'; at: string; amount_iqd: number; actor: TimelineActor }
  | { kind: 'ledger_adjustment'; at: string; amount_iqd: number; bucket: string }
  | { kind: 'dispute_opened' | 'dispute_closed'; at: string; source: 'complaint' | 'ticket' }
  | { kind: 'chat_started'; at: string }
  | { kind: 'release_due'; at: string; expected: true; frozen: boolean };

/** Where an event sits among others at the same instant — the order things really happen in. */
const RANK: Record<TimelineEvent['kind'], number> = {
  placed: 0,
  credit_recorded: 1,
  chat_started: 2,
  status: 3,
  dispute_opened: 4,
  dispute_closed: 5,
  cancelled: 6,
  credit_reversed: 7,
  refunded: 8,
  receipt_confirmed: 9,
  credit_released: 10,
  ledger_adjustment: 11,
  release_due: 99,
};

/** Statuses a store order can be in — anything else in a row is not repeated to the client. */
const STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
const CREDIT_KINDS = new Set(['sale_gross', 'commission', 'delivery_fee']);
const REVERSAL_KINDS = new Set(['refund', 'commission_refund', 'delivery_refund']);

export interface TimelineInput {
  order: {
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    delivered_at: string | null;
    receipt_confirmed_at: string | null;
    total_iqd: number;
  };
  ownerUserId: string;
  history: Array<{ id: string; stage: string; status: string; source: string; changed_at: string; changed_by: string }>;
  adminMoves: Array<{ detail: string; created_at: string }>;
  ledger: Array<{ id: string; kind: string; bucket: string; amount_iqd: number; created_at: string; created_by: string | null }>;
  refundAt: string | null;
  disputes: Array<{ source: 'complaint' | 'ticket'; created_at: string; closed_at: string | null; open: boolean }>;
  chatAt: string | null;
  creditState: string | null;
}

function actorOf(changedBy: string, source: string, input: TimelineInput): TimelineActor {
  if (changedBy && changedBy === input.ownerUserId) return 'store';
  if (changedBy && changedBy === input.order.user_id) return 'customer';
  if (source === 'delivery_api') return 'courier';
  if (!changedBy && (source === 'automatic' || source === 'system')) return 'system';
  return 'levonis';
}

/**
 * The events, oldest first. Pure: the route reads the rows, this decides what
 * they say — so the order and the completeness are tested without a database.
 */
export function buildOrderTimeline(input: TimelineInput): TimelineEvent[] {
  const o = input.order;
  const out: TimelineEvent[] = [{ kind: 'placed', at: o.created_at, actor: 'customer', total_iqd: Number(o.total_iqd) || 0 }];

  for (const h of input.history) {
    // The placement's own stage row, where a door writes one, is the «placed» above.
    if (h.stage === 'placed' && h.status === 'pending') continue;
    const actor = actorOf(h.changed_by, h.source, input);
    if (h.status === 'cancelled' || h.id === cancelAnchorId(o.id)) {
      out.push({ kind: 'cancelled', at: h.changed_at, actor });
      continue;
    }
    if (!STATUSES.has(h.status)) continue;
    out.push({ kind: 'status', at: h.changed_at, status: h.status, stage: String(h.stage ?? ''), actor });
  }
  // The admin's status dropdown writes the audit row only.
  for (const a of input.adminMoves) {
    const d = safeParse<{ to?: unknown; stage?: unknown; stage_recorded?: unknown }>(a.detail, {});
    const to = typeof d.to === 'string' ? d.to : '';
    if (!STATUSES.has(to)) continue;
    // The stage door already wrote this move's history row (review F13): one
    // walk-back is one event, and it is the history row, stage and all.
    if (d.stage_recorded === true && to !== 'cancelled') continue;
    if (to === 'cancelled') {
      // A store order's cancel goes through the one operation, which writes the
      // anchor — only an anchor-less cancellation is taken from the audit row.
      if (!out.some((e) => e.kind === 'cancelled')) out.push({ kind: 'cancelled', at: a.created_at, actor: 'levonis' });
      continue;
    }
    out.push({ kind: 'status', at: a.created_at, status: to, stage: typeof d.stage === 'string' ? d.stage : '', actor: 'levonis' });
  }

  if (input.refundAt) out.push({ kind: 'refunded', at: input.refundAt, actor: 'system' });
  if (o.receipt_confirmed_at) out.push({ kind: 'receipt_confirmed', at: o.receipt_confirmed_at, actor: 'customer' });

  // Ledger lines written by one batch share their timestamp: one event each.
  const groups = new Map<string, { kind: 'credit_recorded' | 'credit_reversed'; at: string; bucket: string; lines: Array<{ kind: string; amount_iqd: number }> }>();
  for (const l of input.ledger) {
    const amount = Number(l.amount_iqd) || 0;
    if (CREDIT_KINDS.has(l.kind) || REVERSAL_KINDS.has(l.kind)) {
      const kind = CREDIT_KINDS.has(l.kind) ? 'credit_recorded' : 'credit_reversed';
      const key = `${kind}|${l.created_at}|${l.bucket}`;
      const g = groups.get(key) ?? { kind, at: l.created_at, bucket: l.bucket, lines: [] };
      g.lines.push({ kind: l.kind, amount_iqd: amount });
      groups.set(key, g);
    } else if (l.kind === 'release' && l.bucket === 'available') {
      const actor: TimelineActor =
        l.created_by && l.created_by === o.user_id ? 'customer' : l.created_by ? 'levonis' : 'system';
      out.push({ kind: 'credit_released', at: l.created_at, amount_iqd: amount, actor });
    } else if (l.kind === 'adjustment') {
      out.push({ kind: 'ledger_adjustment', at: l.created_at, amount_iqd: amount, bucket: l.bucket });
    }
  }
  const lineOrder = ['sale_gross', 'commission', 'delivery_fee', 'refund', 'commission_refund', 'delivery_refund'];
  for (const g of groups.values()) {
    g.lines.sort((a, b) => lineOrder.indexOf(a.kind) - lineOrder.indexOf(b.kind));
    out.push(g);
  }

  for (const d of input.disputes) {
    out.push({ kind: 'dispute_opened', at: d.created_at, source: d.source });
    if (!d.open && d.closed_at) out.push({ kind: 'dispute_closed', at: d.closed_at, source: d.source });
  }
  if (input.chatAt) out.push({ kind: 'chat_started', at: input.chatAt });

  // What is still to come: the automatic release, three days after delivery.
  if (o.status === 'delivered' && !o.receipt_confirmed_at && input.creditState === 'pending' && o.delivered_at) {
    const at = Date.parse(o.delivered_at);
    if (Number.isFinite(at)) {
      out.push({
        kind: 'release_due',
        at: new Date(at + STORE_RELEASE_DAYS * 86_400_000).toISOString(),
        expected: true,
        frozen: input.disputes.some((d) => d.open),
      });
    }
  }

  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ea = a.e.kind === 'release_due';
      const eb = b.e.kind === 'release_due';
      if (ea !== eb) return ea ? 1 : -1;
      return a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : RANK[a.e.kind] - RANK[b.e.kind] || a.i - b.i;
    })
    .map((x) => x.e);
}

/** The money of one order, from its ledger lines only. Absent when it has none. */
export function orderMoney(ledger: TimelineInput['ledger']) {
  if (!ledger.length) return null;
  const sum = (pred: (l: TimelineInput['ledger'][number]) => boolean) =>
    ledger.filter(pred).reduce((s, l) => s + (Number(l.amount_iqd) || 0), 0);
  const gross = sum((l) => l.kind === 'sale_gross');
  const commission = sum((l) => l.kind === 'commission');
  const delivery = sum((l) => l.kind === 'delivery_fee');
  const reversed = sum((l) => REVERSAL_KINDS.has(l.kind));
  const adjustments = sum((l) => l.kind === 'adjustment');
  return {
    gross_iqd: gross,
    commission_iqd: commission,
    delivery_fee_iqd: delivery,
    reversed_iqd: reversed,
    adjustments_iqd: adjustments,
    // The release pair moves money between buckets and nets to zero.
    net_iqd: gross + commission + delivery + reversed + adjustments,
    pending_iqd: sum((l) => l.bucket === 'pending'),
    available_iqd: sum((l) => l.bucket === 'available'),
  };
}

const n = (v: unknown) => Number(v) || 0;
const s = (v: unknown) => (v == null ? '' : String(v));

merchantOrderRoutes.get('/:id/timeline', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = String(c.req.param('id') ?? '');
  if (!ORDER_ID_RE.test(id)) throw new HttpError(404, 'Order not found', 'ORDER_NOT_FOUND');
  const db = c.env.DB;
  const order = await db
    .prepare(
      `SELECT o.id, o.user_id, o.status, o.created_at, o.delivered_at, o.receipt_confirmed_at, o.total_iqd,
              o.shipping_iqd, o.shipping_type, o.delivery_governorate, o.delivery_rule, o.delivery_prep_days,
              o.delivery_method_snapshot, o.address_snapshot, o.commission_percent_x100,
              ${orderCreditStateSql('o.id')} AS credit_state,
              CASE WHEN ${openDisputeSql('o')} THEN 1 ELSE 0 END AS disputed
         FROM orders o
        WHERE o.id = ? AND o.merchant_id = ?`
    )
    .bind(id, ctx.merchant.id)
    .first<Record<string, unknown>>();
  if (!order) throw new HttpError(404, 'Order not found', 'ORDER_NOT_FOUND');

  const [history, audits, ledger, items, complaints, tickets, chat, refund] = await Promise.all([
    db
      .prepare(
        `SELECT id, stage, status, source, changed_at, changed_by
           FROM order_status_history WHERE order_id = ? ORDER BY changed_at, id`
      )
      .bind(id)
      .all<{ id: string; stage: string; status: string; source: string; changed_at: string; changed_by: string }>(),
    db
      .prepare(`SELECT detail, created_at FROM audit_log WHERE target = ? AND action = 'order.status' ORDER BY created_at, id`)
      .bind(id)
      .all<{ detail: string; created_at: string }>(),
    db
      .prepare(
        `SELECT id, kind, bucket, amount_iqd, created_at, created_by
           FROM merchant_ledger_entries WHERE order_id = ? AND merchant_id = ? ORDER BY created_at, id`
      )
      .bind(id, ctx.merchant.id)
      .all<TimelineInput['ledger'][number]>(),
    db
      .prepare(
        `SELECT id, community_product_id, variant_id, name_snapshot, image_snapshot, option_snapshot, sku_snapshot,
                qty, unit_price_iqd, line_total_iqd
           FROM order_items WHERE order_id = ? ORDER BY id`
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    db
      .prepare(`SELECT status, created_at, resolved_at FROM community_complaints WHERE order_id = ? ORDER BY created_at`)
      .bind(id)
      .all<{ status: string; created_at: string; resolved_at: string | null }>(),
    db
      .prepare(`SELECT state, created_at, resolved_at FROM support_tickets WHERE order_id = ? ORDER BY created_at`)
      .bind(id)
      .all<{ state: string; created_at: string; resolved_at: string | null }>(),
    // Only a conversation the owner is IN (the inbox's own rule, W2-E).
    db
      .prepare(
        `SELECT ch.id, ch.created_at FROM chats ch
           JOIN chat_participants p ON p.chat_id = ch.id AND p.user_id = ?2
          WHERE ch.order_id = ?1 OR (ch.context_type = 'store_order' AND ch.context_id = ?1)
          ORDER BY ch.created_at, ch.id LIMIT 1`
      )
      .bind(id, ctx.store.user_id)
      .first<{ id: string; created_at: string }>(),
    order.status === 'cancelled'
      ? db
          .prepare(`SELECT created_at FROM wallet_transactions WHERE id = ? AND user_id = ?`)
          .bind(`wtx_refund_${id}_usd`, s(order.user_id))
          .first<{ created_at: string }>()
      : Promise.resolve(null),
  ]);

  const disputes: TimelineInput['disputes'] = [
    ...(complaints.results ?? []).map((r) => ({
      source: 'complaint' as const,
      created_at: r.created_at,
      closed_at: r.resolved_at,
      open: !['resolved', 'rejected', 'closed'].includes(r.status),
    })),
    ...(tickets.results ?? []).map((r) => ({
      source: 'ticket' as const,
      created_at: r.created_at,
      closed_at: r.resolved_at,
      open: r.state !== 'resolved',
    })),
  ];
  const ledgerRows = ledger.results ?? [];
  const events = buildOrderTimeline({
    order: {
      id,
      user_id: s(order.user_id),
      status: s(order.status),
      created_at: s(order.created_at),
      delivered_at: (order.delivered_at as string | null) || null,
      receipt_confirmed_at: (order.receipt_confirmed_at as string | null) || null,
      total_iqd: n(order.total_iqd),
    },
    ownerUserId: ctx.store.user_id,
    history: history.results ?? [],
    adminMoves: audits.results ?? [],
    ledger: ledgerRows,
    refundAt: refund?.created_at ?? null,
    disputes,
    chatAt: chat?.created_at ?? null,
    creditState: (order.credit_state as string | null) ?? null,
  });

  // What the checkout applied — the snapshot, with its allow-listed fields only.
  const snap = safeParse<Record<string, unknown>>(order.delivery_method_snapshot, {});
  const addr = safeParse<Record<string, unknown>>(order.address_snapshot, {});
  const recorded = order.delivery_rule != null && order.delivery_rule !== '';
  const delivery = {
    // Orders placed before delivery by governorate (0120) applied no rule;
    // they say so instead of pretending one.
    recorded,
    fulfilment: recorded ? (s(snap.fulfilment) || (order.delivery_rule === 'pickup' ? 'pickup' : 'delivery')) : null,
    governorate: s(order.delivery_governorate) || s(snap.governorate) || s(addr.governorate) || null,
    rule: recorded ? s(order.delivery_rule) : null,
    fee_iqd: n(order.shipping_iqd),
    ...(recorded && snap.base_fee_iqd != null ? { base_fee_iqd: n(snap.base_fee_iqd) } : {}),
    ...(recorded && snap.free_over_iqd != null ? { free_over_iqd: n(snap.free_over_iqd) } : {}),
    prep_days: order.delivery_prep_days == null ? null : n(order.delivery_prep_days),
    shipping_type: s(order.shipping_type) || 'direct',
  };

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    order_id: id,
    status: s(order.status),
    credit_state: (order.credit_state as string | null) ?? null,
    disputed: n(order.disputed) === 1,
    commission_percent: n(order.commission_percent_x100) / 100,
    events,
    ...(orderMoney(ledgerRows) ? { money: orderMoney(ledgerRows) } : {}),
    delivery,
    items: (items.results ?? []).map((it) => ({
      id: s(it.id),
      product_id: it.community_product_id ? s(it.community_product_id) : null,
      variant_id: it.variant_id ? s(it.variant_id) : null,
      name: s(it.name_snapshot),
      image: it.image_snapshot ? s(it.image_snapshot) : null,
      option: s(it.option_snapshot),
      sku: s(it.sku_snapshot),
      qty: n(it.qty),
      unit_price_iqd: n(it.unit_price_iqd),
      line_total_iqd: n(it.line_total_iqd),
    })),
    ...(chat ? { chat: { id: chat.id, link: merchantHref.thread(chat.id) } } : {}),
  });
});
