/**
 * COLLECTIONS, AND THE MONEY AL-ZAEEM HOLDS.
 *
 * `planCollection` is what recording one collection writes — the checks the collection form has always made, the
 * courier fee's expense row, the collection row, its journal entry (cash and fee against the sale's receivable) and its
 * audit row — as statements for one batch. The collection form (POST /api/admin/finance-operations/collections) and a
 * courier transfer use it alike, so a parcel paid by a transfer is an ordinary collection to every report.
 *
 * MONEY WITH THE COURIER (the owner's brief, 2026-11-12, part 3; DECISIONS row 332; migration 0232). Al-Zaeem collects
 * the cash at the door of every parcel it delivers and transfers it later, less its fee, in one transfer for many parcels.
 *   PENDING      a delivered Levonis order sent by the standard courier method with cash still due at the door
 *                (personal delivery and pickup are not the courier's money: the owner's question 7);
 *   RECEIVED     a transfer recorded: the parcels it paid, each with its cash and the fee kept, and what arrived;
 *   RECONCILED   the owner checked the transfer against Al-Zaeem's own statement.
 * The fee for a parcel not paid out yet is an estimate — the standard fee quoted for it, even when the customer got free
 * delivery (question 6's default) — and the transfer records the real one. A transfer whose amount is not the parcels'
 * cash less their fees keeps the difference, with a note, and books it against the courier-fee account.
 * Recording collections makes the orders' investor shares stale (their fingerprint reads collections); the minute
 * recovery recomputes them, two orders a run, so a transfer never replays every order inside its own request.
 */
import { badRequest, conflict, notFound } from './http';
import { newId } from './crypto';
import { auditStatements } from './audit';
import { fence, isFenceMiss, journalPlan, periodOpen } from './operations';

export type CollectionPayer = 'customer' | 'courier' | 'bank';
export interface CollectionInput {
  /** The operation id: a retry with the same content is `already`, other content is refused. */
  id: string;
  orderId: string;
  payer: CollectionPayer;
  /** Gross cash collected for the order, the courier's fee included. */
  amount: number;
  fee: number;
  day: string;
  reference: string;
  /** The expense category of the fee; required when there is a fee. */
  categoryId: string;
  actor: string;
  /** Set when a courier transfer records the collection: named in its audit row. */
  remittanceId?: string;
}
export type CollectionPlan = { already: true } | { already: false; statements: D1PreparedStatement[] };

export async function planCollection(db: D1Database, input: CollectionInput): Promise<CollectionPlan> {
  const { id, orderId, payer, amount, fee, day } = input;
  if (fee > amount) throw badRequest('أجرة الشركة تتجاوز المبلغ الإجمالي');
  const existing = await db
    .prepare('SELECT order_id,amount_iqd,fee_iqd FROM finance_collections WHERE id=?')
    .bind(id)
    .first<{ order_id: string; amount_iqd: number; fee_iqd: number }>();
  if (existing) {
    if (existing.order_id !== orderId || existing.amount_iqd !== amount || existing.fee_iqd !== fee)
      throw conflict('عملية التحصيل مستخدمة لمحتوى مختلف');
    return { already: true };
  }
  const order = await db
    .prepare('SELECT status,due_on_delivery_iqd,gini_paid_iqd,seller_type FROM orders WHERE id=?')
    .bind(orderId)
    .first<{ status: string; due_on_delivery_iqd: number; gini_paid_iqd: number; seller_type: string }>();
  if (!order || order.seller_type !== 'levonis') throw notFound('Platform order not found');
  if (order.status === 'cancelled') throw badRequest('الطلب ملغى');
  const salePosted = !!(await db
    .prepare("SELECT id FROM accounting_entries WHERE event_key=? AND state='posted'")
    .bind(`sale:${orderId}`)
    .first());
  const giniRefunds = (await db
    .prepare("SELECT COALESCE(SUM(refund_iqd),0) AS n FROM finance_refund_facts WHERE order_id=? AND channel='gini'")
    .bind(orderId)
    .first<{ n: number }>())?.n ?? 0;
  const collected = (await db
    .prepare("SELECT COALESCE(SUM(amount_iqd),0) AS n FROM finance_collections WHERE order_id=? AND (payer='bank')=?")
    .bind(orderId, payer === 'bank' ? 1 : 0)
    .first<{ n: number }>())?.n ?? 0;
  if (collected + amount > (payer === 'bank' ? order.gini_paid_iqd - giniRefunds : order.due_on_delivery_iqd))
    throw badRequest('التحصيل يتجاوز المبلغ المتبقي للطلب');
  await periodOpen(db, day);
  const expense = fee ? newId('opex') : null;
  const statements: D1PreparedStatement[] = [
    ...fence(
      db,
      "(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_collections WHERE order_id=? AND (payer='bank')=?)=? AND EXISTS(SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted')=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status<>'cancelled') AND (SELECT COALESCE(SUM(refund_iqd),0) FROM finance_refund_facts WHERE order_id=? AND channel='gini')=?",
      [orderId, payer === 'bank' ? 1 : 0, collected, `sale:${orderId}`, salePosted ? 1 : 0, orderId, orderId, giniRefunds],
    ),
  ];
  if (expense) {
    if (!input.categoryId) throw badRequest('اختر تصنيف مصروف أجرة التوصيل');
    statements.push(
      db
        .prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note,created_by) VALUES (?,?,?,?,?,?,?)')
        .bind(expense, input.categoryId, fee, day, 'أجرة شركة التوصيل', orderId, input.actor),
    );
  }
  statements.push(
    db
      .prepare('INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,reference,actor_id,created_at,expense_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, orderId, payer, amount, fee, day, input.reference, input.actor, new Date().toISOString(), expense),
    ...journalPlan(
      db,
      { key: `collection:${id}`, day, title: 'تحصيل طلب', source: 'collection', sourceId: id, actor: input.actor },
      [
        { account: '1000', debit: amount - fee },
        { account: '5200', debit: fee },
        { account: salePosted ? '1100' : '2300', credit: amount },
      ],
    ).statements,
    ...(await auditStatements(db, input.actor, 'finance.collection_recorded', id, {
      order_id: orderId, payer, amount_iqd: amount, fee_iqd: fee, net_iqd: amount - fee, collection_day: day, reference: input.reference,
      ...(input.remittanceId ? { remittance_id: input.remittanceId } : {}),
    })).statements,
  );
  return { already: false, statements };
}

// ─────────────────────────────────────────────────────────────── money with the courier

export const COURIER = 'alzaeem';
/** The checkout method the courier carries (settings.ts `checkoutDeliveryMethods`): «توصيل عادي». */
export const COURIER_METHOD = 'standard';
/** The books check (financeChecks.ts) names cash still at the courier this long after delivery, and a transfer not checked
 * against the courier's statement this long after it was recorded. */
export const COURIER_OVERDUE_DAYS = 14;
export const COURIER_UNCHECKED_DAYS = 7;
/** At most this many parcels in one transfer: each writes a collection, an expense, a journal entry and an audit row. */
export const MAX_REMITTANCE_PARCELS = 40;

/** A parcel of the courier's: a Levonis order delivered by the courier method. */
export const courierParcelSql = (o = 'o') => `${o}.seller_type='levonis' AND ${o}.status='delivered' AND ${o}.delivery_method_id='${COURIER_METHOD}'`;
/** Cash still at the courier for an order: what the customer pays at the door less what was recorded as collected there. */
export const courierDueSql = (o = 'o') =>
  `(${o}.due_on_delivery_iqd-(SELECT COALESCE(SUM(fc.amount_iqd),0) FROM finance_collections fc WHERE fc.order_id=${o}.id AND fc.payer<>'bank'))`;
/** The fee estimate before Al-Zaeem's invoice says: the standard fee quoted for the parcel, even when it was free to the customer. */
export const courierFeeEstimateSql = (o = 'o') => `MAX(COALESCE(${o}.shipping_iqd,0),COALESCE(${o}.shipping_before_benefit_iqd,0))`;

export interface CourierParcel {
  order_id: string;
  customer_name: string | null;
  governorate: string | null;
  tracking_no: string;
  delivered_day: string | null;
  days: number;
  due_iqd: number;
  fee_estimate_iqd: number;
}
export interface CourierRemittance {
  id: string;
  kind: 'transfer' | 'opening';
  reference: string;
  received_day: string;
  amount_iqd: number;
  collected_iqd: number;
  fee_iqd: number;
  difference_iqd: number;
  parcels: number;
  state: 'received' | 'reconciled';
  note: string;
  created_by_name: string | null;
  created_at: string;
  reconciled_by_name: string | null;
  reconciled_at: string | null;
  reconcile_note: string;
}

/** Both tables exist (migration 0232). */
export async function courierInstalled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('courier_remittances','courier_remittance_orders')").first<{ n: number }>();
  return (row?.n ?? 0) === 2;
}

const PARCEL_COLUMNS = `o.id AS order_id,COALESCE(CASE WHEN json_valid(o.address_snapshot) THEN json_extract(o.address_snapshot,'$.name') END,u.name) AS customer_name,
  CASE WHEN json_valid(o.address_snapshot) THEN json_extract(o.address_snapshot,'$.governorate') END AS governorate,o.delivery_tracking_no AS tracking_no,
  date(o.delivered_at,'+3 hours') AS delivered_day,MAX(0,CAST(julianday('now')-julianday(o.delivered_at) AS INTEGER)) AS days`;

/** The parcels whose cash is still at the courier, oldest first. */
export async function pendingParcels(db: D1Database, limit = 1000): Promise<CourierParcel[]> {
  return (await db.prepare(`SELECT ${PARCEL_COLUMNS},${courierDueSql()} AS due_iqd,${courierFeeEstimateSql()} AS fee_estimate_iqd
      FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${courierParcelSql()} AND ${courierDueSql()}>0 ORDER BY o.delivered_at,o.id LIMIT ?`)
    .bind(limit).all<CourierParcel>()).results ?? [];
}

const REMITTANCE_COLUMNS = `r.id,r.kind,r.reference,r.received_day,r.amount_iqd,r.collected_iqd,r.fee_iqd,r.difference_iqd,r.parcels,r.state,r.note,
  cu.name AS created_by_name,r.created_at,ru.name AS reconciled_by_name,r.reconciled_at,r.reconcile_note`;

export async function courierRemittances(db: D1Database, limit = 60): Promise<CourierRemittance[]> {
  return (await db.prepare(`SELECT ${REMITTANCE_COLUMNS} FROM courier_remittances r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users ru ON ru.id=r.reconciled_by
      ORDER BY r.received_day DESC,r.created_at DESC,r.id LIMIT ?`).bind(limit).all<CourierRemittance>()).results ?? [];
}

export async function courierRemittance(db: D1Database, id: string) {
  const remittance = await db.prepare(`SELECT ${REMITTANCE_COLUMNS} FROM courier_remittances r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users ru ON ru.id=r.reconciled_by
      WHERE r.id=?`).bind(id).first<CourierRemittance>();
  if (!remittance) throw notFound('Transfer not found');
  const parcels = (await db.prepare(`SELECT ${PARCEL_COLUMNS},ro.collected_iqd,ro.fee_iqd,ro.collected_iqd-ro.fee_iqd AS net_iqd
      FROM courier_remittance_orders ro JOIN orders o ON o.id=ro.order_id LEFT JOIN users u ON u.id=o.user_id
      WHERE ro.remittance_id=? ORDER BY o.delivered_at,o.id`).bind(id).all()).results ?? [];
  return { remittance, parcels };
}

/** The page's figures: what is still at the courier, what arrived and is not yet checked, and whether this is the first time. */
export async function courierOverview(db: D1Database) {
  const [parcels, remittances, counts, category] = await Promise.all([
    pendingParcels(db),
    courierRemittances(db),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='transfer' THEN 1 ELSE 0 END),0) AS transfers,COALESCE(SUM(CASE WHEN state='received' THEN 1 ELSE 0 END),0) AS unreconciled,
        COALESCE(SUM(CASE WHEN state='received' THEN amount_iqd ELSE 0 END),0) AS unreconciled_iqd FROM courier_remittances`)
      .first<{ transfers: number; unreconciled: number; unreconciled_iqd: number }>(),
    lastFeeCategory(db),
  ]);
  const sum = (f: (p: CourierParcel) => number) => parcels.reduce((n, p) => n + f(p), 0);
  return {
    pending: {
      parcels,
      count: parcels.length,
      due_iqd: sum((p) => p.due_iqd),
      fee_estimate_iqd: sum((p) => Math.min(p.fee_estimate_iqd, p.due_iqd)),
      net_estimate_iqd: sum((p) => p.due_iqd - Math.min(p.fee_estimate_iqd, p.due_iqd)),
      oldest_days: parcels.length ? Math.max(...parcels.map((p) => p.days)) : 0,
    },
    remittances,
    unreconciled: { count: counts?.unreconciled ?? 0, amount_iqd: counts?.unreconciled_iqd ?? 0 },
    /** No transfer recorded yet: the page offers the opening (question 8). An opening entry is not a transfer, so an opening
     *  cut short (forty parcels a time) can be finished the same way. */
    first_time: (counts?.transfers ?? 0) === 0,
    fee_category: category,
  };
}

/** The category of the last courier fee the owner recorded: a transfer's fees go there unless another is chosen. */
async function lastFeeCategory(db: D1Database): Promise<{ id: string; name_ar: string; name_en: string; name_ckb: string } | null> {
  return await db.prepare(`SELECT k.id,k.name_ar,k.name_en,k.name_ckb FROM finance_collections c JOIN operating_expenses e ON e.id=c.expense_id
      JOIN expense_categories k ON k.id=e.category_id WHERE k.active=1 ORDER BY c.created_at DESC,c.id DESC LIMIT 1`).first() ?? null;
}

export interface RemittanceInput {
  id: string;
  kind: 'transfer' | 'opening';
  day: string;
  reference: string;
  /** What arrived; an opening's is computed: the parcels' cash less their fees. */
  amount: number | null;
  note: string;
  categoryId: string;
  parcels: Array<{ orderId: string; collected: number | null; fee: number }>;
}

/** The request as stored: a retry compares it whole. */
const canonical = (input: RemittanceInput, categoryId: string) => JSON.stringify({
  kind: input.kind, day: input.day, reference: input.reference, amount: input.amount, note: input.note, category: categoryId,
  parcels: input.parcels.map((p) => [p.orderId, p.collected, p.fee]),
});

/**
 * Record a transfer from the courier: per parcel the collection `planCollection` writes (payer courier), then the
 * transfer and its parcels, the difference's journal entry when there is one, and the audit row — one batch.
 */
export async function recordRemittance(db: D1Database, actor: string, input: RemittanceInput): Promise<{ already: boolean; id: string; parcels: number }> {
  if (!input.parcels.length) throw badRequest('اختر الطرود التي دفعها هذا التحويل', 'COURIER_NO_PARCELS');
  if (input.parcels.length > MAX_REMITTANCE_PARCELS)
    throw badRequest(`سجّل التحويل على دفعات: ${MAX_REMITTANCE_PARCELS} طردًا في كل مرة كحد أقصى`, 'COURIER_TOO_MANY_PARCELS');
  if (new Set(input.parcels.map((p) => p.orderId)).size !== input.parcels.length) throw badRequest('طلب مكرر في التحويل', 'COURIER_DUPLICATE_PARCEL');
  const category = input.categoryId || (await lastFeeCategory(db))?.id || '';
  const request = canonical(input, category);
  const existing = await db.prepare('SELECT request_json FROM courier_remittances WHERE id=?').bind(input.id).first<{ request_json: string }>();
  if (existing) {
    if (existing.request_json !== request) throw conflict('عملية التحويل مستخدمة لمحتوى مختلف', 'COURIER_OPERATION_REUSED');
    return { already: true, id: input.id, parcels: input.parcels.length };
  }
  const due = new Map(((await db.prepare(`SELECT o.id,${courierDueSql()} AS due FROM orders o WHERE o.id IN (SELECT value FROM json_each(?)) AND ${courierParcelSql()}`)
    .bind(JSON.stringify(input.parcels.map((p) => p.orderId))).all<{ id: string; due: number }>()).results ?? []).map((r) => [r.id, r.due]));
  const lines = input.parcels.map((p) => {
    const left = due.get(p.orderId);
    if (left === undefined) throw badRequest(`الطلب ${p.orderId} ليس طردًا مُسلَّمًا عبر شركة التوصيل`, 'COURIER_NOT_A_PARCEL');
    if (left <= 0) throw badRequest(`الطلب ${p.orderId} لا يبقى من نقده شيء لدى شركة التوصيل`, 'COURIER_NOTHING_DUE');
    const collected = p.collected ?? left;
    if (collected <= 0 || collected > left) throw badRequest(`نقد الطلب ${p.orderId} بين 1 و${left}`, 'COURIER_COLLECTED_RANGE');
    if (p.fee < 0 || p.fee > collected) throw badRequest(`أجرة الطلب ${p.orderId} أكبر من نقده`, 'COURIER_FEE_RANGE');
    return { ...p, collected };
  });
  const collectedTotal = lines.reduce((n, l) => n + l.collected, 0), feeTotal = lines.reduce((n, l) => n + l.fee, 0);
  const amount = input.kind === 'opening' ? collectedTotal - feeTotal : input.amount;
  if (amount === null || !Number.isSafeInteger(amount) || amount < 0) throw badRequest('اكتب المبلغ الذي وصل', 'COURIER_AMOUNT');
  const difference = amount - (collectedTotal - feeTotal);
  if (difference !== 0 && !input.note.trim()) throw badRequest('المبلغ الواصل يختلف عن نقد الطرود بعد الأجور: اكتب السبب في الملاحظة', 'COURIER_DIFFERENCE_NOTE');
  const reference = input.reference || (input.kind === 'opening' ? 'رصيد افتتاحي' : '');
  const statements: D1PreparedStatement[] = [];
  // Every parcel's collection first: the transfer's own rows reference them.
  const ids = lines.map((_, i) => `${input.id}:${i + 1}`);
  for (const [i, l] of lines.entries()) {
    const plan = await planCollection(db, {
      id: ids[i], orderId: l.orderId, payer: 'courier', amount: l.collected, fee: l.fee, day: input.day, reference, categoryId: category, actor, remittanceId: input.id,
    });
    if (plan.already) throw conflict('عملية التحويل مستخدمة لمحتوى مختلف', 'COURIER_OPERATION_REUSED');
    statements.push(...plan.statements);
  }
  const now = new Date().toISOString();
  statements.push(
    db.prepare(`INSERT INTO courier_remittances(id,courier,kind,reference,received_day,amount_iqd,collected_iqd,fee_iqd,difference_iqd,parcels,state,note,request_json,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'received',?,?,?,?)`)
      .bind(input.id, COURIER, input.kind, reference, input.day, amount, collectedTotal, feeTotal, difference, lines.length, input.note, request, actor, now),
    ...lines.map((l, i) => db.prepare('INSERT INTO courier_remittance_orders(remittance_id,order_id,collection_id,collected_iqd,fee_iqd) VALUES (?,?,?,?,?)')
      .bind(input.id, l.orderId, ids[i], l.collected, l.fee)),
  );
  if (difference !== 0)
    statements.push(...journalPlan(
      db,
      { key: `courier-difference:${input.id}`, day: input.day, title: 'فرق تحويل شركة التوصيل', source: 'courier_remittance', sourceId: input.id, actor },
      difference > 0
        ? [{ account: '1000', debit: difference }, { account: '5200', credit: difference }]
        : [{ account: '5200', debit: -difference }, { account: '1000', credit: -difference }],
    ).statements);
  statements.push(...(await auditStatements(db, actor, 'finance.courier_remittance_recorded', input.id, {
    kind: input.kind, reference, received_day: input.day, amount_iqd: amount, collected_iqd: collectedTotal, fee_iqd: feeTotal,
    difference_iqd: difference, parcels: lines.length, order_ids: lines.map((l) => l.orderId),
  })).statements);
  try {
    await db.batch(statements);
  } catch (e) {
    // Another request recorded one of these parcels, or this same transfer, between the reads and the batch.
    if (isFenceMiss(e) || /UNIQUE constraint failed: courier_remittances\.id/.test(String(e)))
      throw conflict('تغيّر تحصيل أحد الطرود أثناء التسجيل؛ أعد فتح الصفحة وحاول مجددًا', 'COURIER_CHANGED');
    throw e;
  }
  return { already: false, id: input.id, parcels: lines.length };
}

/** The owner checked the transfer against Al-Zaeem's own statement: it is reconciled, once and for good. */
export async function reconcileRemittance(db: D1Database, actor: string, id: string, note: string): Promise<{ already: boolean }> {
  const r = await db.prepare('SELECT state,difference_iqd FROM courier_remittances WHERE id=?').bind(id).first<{ state: string; difference_iqd: number }>();
  if (!r) throw notFound('Transfer not found');
  if (r.state === 'reconciled') return { already: true };
  const at = new Date().toISOString();
  try {
    await db.batch([
      ...fence(db, "EXISTS(SELECT 1 FROM courier_remittances WHERE id=? AND state='received')", [id]),
      db.prepare("UPDATE courier_remittances SET state='reconciled',reconciled_by=?,reconciled_at=?,reconcile_note=? WHERE id=? AND state='received'").bind(actor, at, note, id),
      ...(await auditStatements(db, actor, 'finance.courier_remittance_reconciled', id, { difference_iqd: r.difference_iqd, note })).statements,
    ]);
  } catch (e) {
    // Reconciled by someone else between the read and the batch.
    if (isFenceMiss(e)) return { already: true };
    throw e;
  }
  return { already: false };
}
