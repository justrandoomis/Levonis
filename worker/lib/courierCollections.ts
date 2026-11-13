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
 * delivery (question 6's default) — and the transfer records the real one. THE OWNER'S RULE (2026-11-13): «Al-Zaeem or
 * any delivery money received must be equal or higher than on web» — what arrives is never less than the parcels' cash
 * less their fees, so a smaller amount is refused until a parcel's cash or fee is corrected from the courier's statement;
 * a larger one (the courier kept less than the estimate) is kept on the transfer and booked against the courier fees.
 * Recording collections makes the orders' investor shares stale (their fingerprint reads collections); the minute
 * recovery recomputes them, two orders a run, so a transfer never replays every order inside its own request.
 *
 * THE SECOND ROUND (the owner, 2026-11-13; DECISIONS row 338; migration 0233):
 *   PREPAID      a courier parcel paid before delivery has no cash at the door, yet Al-Zaeem takes its fee from a transfer.
 *                The transfer carries that fee as a line of its own — an expense linked to the order, so the order's profit
 *                counts it, and an entry taking it from the cash that arrived — and the owner's rule compares what arrived
 *                with the ticked parcels' cash less every fee. A fee of 0 settles an old prepaid parcel with no expense.
 *   UNDO         a transfer recorded by mistake and not yet checked is taken back, once, with a reason: its collections and
 *                fee lines go, so its parcels are with the courier again; their fee expenses are voided and locked; each
 *                journal entry is reversed on the transfer's own day, so the day's books and its collections agree. The
 *                transfer stays in the list as undone, with what it held. Investor shares and wages follow on their own:
 *                their fingerprints read the collections and the order's expenses, and the minute recovery recomputes them.
 */
import { badRequest, conflict, notFound, unavailable } from './http';
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
/** At most this many parcels in one transfer, prepaid ones included: each writes a collection or a fee line, an expense, a
 * journal entry and an audit row. */
export const MAX_REMITTANCE_PARCELS = 40;
/** The page lists at most this many prepaid parcels waiting for their fee, oldest first, and says when there are more. */
export const PREPAID_LIST_LIMIT = 300;

/** A parcel of the courier's: a Levonis order delivered by the courier method. */
export const courierParcelSql = (o = 'o') => `${o}.seller_type='levonis' AND ${o}.status='delivered' AND ${o}.delivery_method_id='${COURIER_METHOD}'`;
/** Cash still at the courier for an order: what the customer pays at the door less what was recorded as collected there. */
export const courierDueSql = (o = 'o') =>
  `(${o}.due_on_delivery_iqd-(SELECT COALESCE(SUM(fc.amount_iqd),0) FROM finance_collections fc WHERE fc.order_id=${o}.id AND fc.payer<>'bank'))`;
/** The fee estimate before Al-Zaeem's invoice says: the standard fee quoted for the parcel, even when it was free to the customer. */
export const courierFeeEstimateSql = (o = 'o') => `MAX(COALESCE(${o}.shipping_iqd,0),COALESCE(${o}.shipping_before_benefit_iqd,0))`;
/** A prepaid parcel: one of the courier's with nothing to pay at the door (paid online, from the wallet or by bank). */
export const courierPrepaidSql = (o = 'o') => `${courierParcelSql(o)} AND COALESCE(${o}.due_on_delivery_iqd,0)=0`;

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
  /** Set once the transfer is undone (migration 0233): when, by whom and why. */
  undone_at: string | null;
  undone_by_name: string | null;
  undo_reason: string;
}

/** Both tables exist (migration 0232). */
export async function courierInstalled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('courier_remittances','courier_remittance_orders')").first<{ n: number }>();
  return (row?.n ?? 0) === 2;
}
/** The second round's tables exist as well (migration 0233): prepaid parcels' fees and undo. */
export async function courierUndoInstalled(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
    ('courier_remittances','courier_remittance_orders','courier_remittance_fees','courier_remittance_voids','courier_remittance_undone')`).first<{ n: number }>();
  return (row?.n ?? 0) === 5;
}
const NOT_READY = 'تحديث أموال شركة التوصيل لم يطبق على قاعدة البيانات بعد';

/** The refusal of the expense routes for an expense a courier transfer holds (courierHeldExpense). */
export const COURIER_HELD_EXPENSE = 'هذه أجرة يحملها تحويل من شركة التوصيل؛ تُصحَّح من «أموال لدى شركة التوصيل»: تراجع عن التحويل ثم سجّله من جديد';
/**
 * An expense a courier transfer holds — a prepaid parcel's fee on a live transfer, or a fee of an undone one, voided — is
 * changed only from the courier page (undo the transfer, record it again). The database refuses any other change (migration
 * 0233's triggers); the expense routes ask here first, so the owner reads why instead of a failure. False before 0233.
 */
export async function courierHeldExpense(db: D1Database, expenseId: string): Promise<boolean> {
  if (!await courierUndoInstalled(db)) return false;
  return !!(await db.prepare('SELECT 1 FROM courier_remittance_fees WHERE expense_id=?1 UNION ALL SELECT 1 FROM courier_remittance_undone WHERE expense_id=?1 LIMIT 1')
    .bind(expenseId).first());
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

/** The prepaid parcels no transfer has taken a fee for yet, oldest first; none before migration 0233. */
export async function prepaidParcels(db: D1Database, limit = PREPAID_LIST_LIMIT): Promise<CourierParcel[]> {
  if (!await courierUndoInstalled(db)) return [];
  return (await db.prepare(`SELECT ${PARCEL_COLUMNS},0 AS due_iqd,${courierFeeEstimateSql()} AS fee_estimate_iqd
      FROM orders o LEFT JOIN users u ON u.id=o.user_id
      WHERE ${courierPrepaidSql()} AND NOT EXISTS(SELECT 1 FROM courier_remittance_fees f WHERE f.order_id=o.id)
      ORDER BY o.delivered_at,o.id LIMIT ?`).bind(limit).all<CourierParcel>()).results ?? [];
}

const REMITTANCE_COLUMNS = `r.id,r.kind,r.reference,r.received_day,r.amount_iqd,r.collected_iqd,r.fee_iqd,r.difference_iqd,r.parcels,r.state,r.note,
  cu.name AS created_by_name,r.created_at,ru.name AS reconciled_by_name,r.reconciled_at,r.reconcile_note`;
/** The transfers' rows, with who undid each once the undo's table exists (migration 0233). */
const remittanceFrom = (undo: boolean) => undo
  ? `SELECT ${REMITTANCE_COLUMNS},v.created_at AS undone_at,vu.name AS undone_by_name,COALESCE(v.reason,'') AS undo_reason
      FROM courier_remittances r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users ru ON ru.id=r.reconciled_by
      LEFT JOIN courier_remittance_voids v ON v.remittance_id=r.id LEFT JOIN users vu ON vu.id=v.actor_id`
  : `SELECT ${REMITTANCE_COLUMNS},NULL AS undone_at,NULL AS undone_by_name,'' AS undo_reason
      FROM courier_remittances r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users ru ON ru.id=r.reconciled_by`;

export async function courierRemittances(db: D1Database, limit = 60): Promise<CourierRemittance[]> {
  return (await db.prepare(`${remittanceFrom(await courierUndoInstalled(db))} ORDER BY r.received_day DESC,r.created_at DESC,r.id LIMIT ?`)
    .bind(limit).all<CourierRemittance>()).results ?? [];
}

export async function courierRemittance(db: D1Database, id: string) {
  // Before migration 0232 there is no transfer to find: the same answer as an unknown id.
  if (!await courierInstalled(db)) throw notFound('Transfer not found');
  const undo = await courierUndoInstalled(db);
  const remittance = await db.prepare(`${remittanceFrom(undo)} WHERE r.id=?`).bind(id).first<CourierRemittance>();
  if (!remittance) throw notFound('Transfer not found');
  // A live transfer's parcels with cash, then its prepaid parcels' fees; an undone transfer's as the undo kept them.
  const held = !undo ? `SELECT order_id,'cash' AS kind,collected_iqd,fee_iqd FROM courier_remittance_orders WHERE remittance_id=?1`
    : remittance.undone_at ? 'SELECT order_id,kind,collected_iqd,fee_iqd FROM courier_remittance_undone WHERE remittance_id=?1'
    : `SELECT order_id,'cash' AS kind,collected_iqd,fee_iqd FROM courier_remittance_orders WHERE remittance_id=?1
        UNION ALL SELECT order_id,'fee',0,fee_iqd FROM courier_remittance_fees WHERE remittance_id=?1`;
  const parcels = (await db.prepare(`SELECT ${PARCEL_COLUMNS},x.kind,x.collected_iqd,x.fee_iqd,x.collected_iqd-x.fee_iqd AS net_iqd
      FROM (${held}) x JOIN orders o ON o.id=x.order_id LEFT JOIN users u ON u.id=o.user_id ORDER BY x.kind,o.delivered_at,o.id`).bind(id).all()).results ?? [];
  return { remittance, parcels };
}

/** The page's figures: what is still at the courier, what arrived and is not yet checked, and whether this is the first time. */
export async function courierOverview(db: D1Database) {
  // The parcels read only older tables; before migration 0232 there is simply no transfer yet, and before 0233 no prepaid
  // parcel's fee and no undo (a deploy can run ahead of its migration).
  const installed = await courierInstalled(db);
  const undo = installed && await courierUndoInstalled(db);
  // An undone transfer is no transfer: it waits for no check, and without it the first-time opening is offered again.
  const live = undo ? ' WHERE NOT EXISTS(SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id=courier_remittances.id)' : '';
  const [parcels, prepaid, remittances, counts, category] = await Promise.all([
    pendingParcels(db),
    undo ? prepaidParcels(db, PREPAID_LIST_LIMIT + 1) : Promise.resolve([] as CourierParcel[]),
    installed ? courierRemittances(db) : Promise.resolve([] as CourierRemittance[]),
    !installed ? Promise.resolve(null) : db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='transfer' THEN 1 ELSE 0 END),0) AS transfers,COALESCE(SUM(CASE WHEN state='received' THEN 1 ELSE 0 END),0) AS unreconciled,
        COALESCE(SUM(CASE WHEN state='received' THEN amount_iqd ELSE 0 END),0) AS unreconciled_iqd FROM courier_remittances${live}`)
      .first<{ transfers: number; unreconciled: number; unreconciled_iqd: number }>(),
    lastFeeCategory(db),
  ]);
  const sum = (f: (p: CourierParcel) => number) => parcels.reduce((n, p) => n + f(p), 0);
  const listed = prepaid.slice(0, PREPAID_LIST_LIMIT);
  return {
    pending: {
      parcels,
      count: parcels.length,
      due_iqd: sum((p) => p.due_iqd),
      fee_estimate_iqd: sum((p) => Math.min(p.fee_estimate_iqd, p.due_iqd)),
      net_estimate_iqd: sum((p) => p.due_iqd - Math.min(p.fee_estimate_iqd, p.due_iqd)),
      oldest_days: parcels.length ? Math.max(...parcels.map((p) => p.days)) : 0,
    },
    /** Prepaid parcels whose fee no transfer took yet (migration 0233), oldest first: ticked with a transfer, each with its fee. */
    prepaid: { parcels: listed, count: listed.length, more: prepaid.length > PREPAID_LIST_LIMIT },
    remittances,
    unreconciled: { count: counts?.unreconciled ?? 0, amount_iqd: counts?.unreconciled_iqd ?? 0 },
    /** No transfer recorded yet: the page offers the opening (question 8). An opening entry is not a transfer, so an opening
     *  cut short (forty parcels a time) can be finished the same way; an undone transfer does not count. */
    first_time: (counts?.transfers ?? 0) === 0,
    fee_category: category,
    /** Prepaid parcels' fees and undo can be recorded: migration 0233 is on the database. */
    undo,
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
  /** What arrived; an opening's is computed: the parcels' cash less every fee. */
  amount: number | null;
  note: string;
  categoryId: string;
  parcels: Array<{ orderId: string; collected: number | null; fee: number }>;
  /** Prepaid parcels whose fee the courier took from this transfer (migration 0233); a fee of 0 settles one with no fee. */
  fees?: Array<{ orderId: string; fee: number }>;
}

/** The request as stored: a retry compares it whole. A transfer with no prepaid parcel keeps the first round's form. */
const canonical = (input: RemittanceInput, categoryId: string) => JSON.stringify({
  kind: input.kind, day: input.day, reference: input.reference, amount: input.amount, note: input.note, category: categoryId,
  parcels: input.parcels.map((p) => [p.orderId, p.collected, p.fee]),
  ...(input.fees?.length ? { fees: input.fees.map((f) => [f.orderId, f.fee]) } : {}),
});

/**
 * Record a transfer from the courier: per parcel the collection `planCollection` writes (payer courier), then the
 * transfer and its parcels, each prepaid parcel's fee line (its expense, linked to the order, and its entry), the
 * difference's journal entry when there is one, and the audit row — one batch.
 */
export async function recordRemittance(db: D1Database, actor: string, input: RemittanceInput): Promise<{ already: boolean; id: string; parcels: number }> {
  const fees = input.fees ?? [];
  if (!input.parcels.length)
    throw fees.length
      ? badRequest('يحتاج التحويل طردًا واحدًا على الأقل له نقد؛ أجور الطرود المدفوعة مسبقًا تُسجَّل معه', 'COURIER_FEES_ONLY')
      : badRequest('اختر الطرود التي دفعها هذا التحويل', 'COURIER_NO_PARCELS');
  if (input.parcels.length + fees.length > MAX_REMITTANCE_PARCELS)
    throw badRequest(`سجّل التحويل على دفعات: ${MAX_REMITTANCE_PARCELS} طردًا في كل مرة كحد أقصى`, 'COURIER_TOO_MANY_PARCELS');
  const orderIds = [...input.parcels.map((p) => p.orderId), ...fees.map((f) => f.orderId)];
  if (new Set(orderIds).size !== orderIds.length) throw badRequest('طلب مكرر في التحويل', 'COURIER_DUPLICATE_PARCEL');
  const undo = await courierUndoInstalled(db);
  if (fees.length && !undo) throw unavailable(NOT_READY, 'COURIER_NOT_CONFIGURED');
  const category = input.categoryId || (await lastFeeCategory(db))?.id || '';
  const request = canonical(input, category);
  const existing = await db.prepare(`SELECT r.request_json,${undo ? 'EXISTS(SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id=r.id)' : '0'} AS undone
      FROM courier_remittances r WHERE r.id=?`).bind(input.id).first<{ request_json: string; undone: number }>();
  if (existing) {
    if (existing.request_json !== request) throw conflict('عملية التحويل مستخدمة لمحتوى مختلف', 'COURIER_OPERATION_REUSED');
    // A retry of a transfer since undone must not answer «recorded» for parcels that are with the courier again.
    if (existing.undone) throw conflict('تم التراجع عن هذا التحويل؛ سجّله من جديد', 'COURIER_OPERATION_UNDONE');
    return { already: true, id: input.id, parcels: orderIds.length };
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
  // A prepaid parcel: the courier's, delivered, nothing to pay at the door, its fee not on another live transfer.
  const prepaid = new Map(!fees.length ? [] : ((await db.prepare(`SELECT o.id,COALESCE(o.due_on_delivery_iqd,0) AS door,
      EXISTS(SELECT 1 FROM courier_remittance_fees f WHERE f.order_id=o.id) AS settled FROM orders o
      WHERE o.id IN (SELECT value FROM json_each(?)) AND ${courierParcelSql()}`)
    .bind(JSON.stringify(fees.map((f) => f.orderId))).all<{ id: string; door: number; settled: number }>()).results ?? []).map((r) => [r.id, r]));
  const feeLines = fees.map((f) => {
    const row = prepaid.get(f.orderId);
    if (!row) throw badRequest(`الطلب ${f.orderId} ليس طردًا مُسلَّمًا عبر شركة التوصيل`, 'COURIER_NOT_A_PARCEL');
    if (row.door > 0) throw badRequest(`الطلب ${f.orderId} يُدفع نقده عند الباب: حدّده مع الطرود التي لها نقد`, 'COURIER_NOT_PREPAID');
    if (row.settled) throw badRequest(`أجرة الطلب ${f.orderId} مسجّلة في تحويل سابق`, 'COURIER_FEE_RECORDED');
    if (!Number.isSafeInteger(f.fee) || f.fee < 0) throw badRequest(`أجرة الطلب ${f.orderId} غير صحيحة`, 'COURIER_FEE_RANGE');
    return f;
  });
  const collectedTotal = lines.reduce((n, l) => n + l.collected, 0), feeTotal = lines.reduce((n, l) => n + l.fee, 0);
  const prepaidTotal = feeLines.reduce((n, f) => n + f.fee, 0);
  const expected = collectedTotal - feeTotal - prepaidTotal;
  if (expected < 0)
    throw badRequest('أجور الطرود المحدَّدة أكبر من نقدها: لا يبقى ما تحوّله شركة التوصيل. أزل طردًا مدفوعًا مسبقًا أو صحّح أجرته', 'COURIER_FEES_EXCEED');
  const amount = input.kind === 'opening' ? expected : input.amount;
  if (amount === null || !Number.isSafeInteger(amount) || amount < 0) throw badRequest('اكتب المبلغ الذي وصل', 'COURIER_AMOUNT');
  const difference = amount - expected;
  if (difference < 0) throw badRequest('وصل أقل مما يُظهره الموقع لهذه الطرود بعد أجورها، ويجب أن يساوي ما وصل من شركة التوصيل ما في الموقع أو يزيد عليه: صحّح نقد الطرد أو أجرته من كشف الشركة', 'COURIER_SHORT');
  if (prepaidTotal > 0 && !category) throw badRequest('اختر تصنيف مصروف أجرة التوصيل');
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
      .bind(input.id, COURIER, input.kind, reference, input.day, amount, collectedTotal, feeTotal + prepaidTotal, difference, lines.length + feeLines.length, input.note, request, actor, now),
    ...lines.map((l, i) => db.prepare('INSERT INTO courier_remittance_orders(remittance_id,order_id,collection_id,collected_iqd,fee_iqd) VALUES (?,?,?,?,?)')
      .bind(input.id, l.orderId, ids[i], l.collected, l.fee)),
  );
  if (feeLines.length) {
    // Still prepaid courier parcels inside the batch; the fee's unique order keeps a parcel on one live transfer.
    statements.push(...fence(db, `(SELECT COUNT(*) FROM orders o WHERE o.id IN (SELECT value FROM json_each(?)) AND ${courierPrepaidSql()})=?`,
      [JSON.stringify(feeLines.map((f) => f.orderId)), feeLines.length]));
    for (const f of feeLines) {
      const expense = f.fee ? newId('opex') : null;
      if (expense)
        statements.push(
          db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note,created_by) VALUES (?,?,?,?,?,?,?)')
            .bind(expense, category, f.fee, input.day, 'أجرة شركة التوصيل', f.orderId, actor),
          db.prepare('INSERT INTO finance_expense_links(expense_id,order_id) VALUES (?,?)').bind(expense, f.orderId),
        );
      statements.push(db.prepare('INSERT INTO courier_remittance_fees(remittance_id,order_id,fee_iqd,expense_id) VALUES (?,?,?,?)').bind(input.id, f.orderId, f.fee, expense));
      // The courier kept the fee out of what it sent: an expense paid from the cash that arrived.
      if (expense)
        statements.push(...journalPlan(
          db,
          { key: `courier-fee:${input.id}:${f.orderId}`, day: input.day, title: 'أجرة شركة التوصيل لطرد مدفوع مسبقًا', source: 'courier_remittance', sourceId: input.id, actor },
          [{ account: '5200', debit: f.fee }, { account: '1000', credit: f.fee }],
        ).statements);
    }
  }
  if (difference !== 0)
    statements.push(...journalPlan(
      db,
      { key: `courier-difference:${input.id}`, day: input.day, title: 'فرق تحويل شركة التوصيل', source: 'courier_remittance', sourceId: input.id, actor },
      difference > 0
        ? [{ account: '1000', debit: difference }, { account: '5200', credit: difference }]
        : [{ account: '5200', debit: -difference }, { account: '1000', credit: -difference }],
    ).statements);
  statements.push(...(await auditStatements(db, actor, 'finance.courier_remittance_recorded', input.id, {
    kind: input.kind, reference, received_day: input.day, amount_iqd: amount, collected_iqd: collectedTotal, fee_iqd: feeTotal + prepaidTotal,
    difference_iqd: difference, parcels: lines.length + feeLines.length, order_ids: lines.map((l) => l.orderId),
    ...(feeLines.length ? { prepaid: feeLines.map((f) => [f.orderId, f.fee]) } : {}),
  })).statements);
  try {
    await db.batch(statements);
  } catch (e) {
    // Another request recorded one of these parcels or fees, or this same transfer, between the reads and the batch.
    if (isFenceMiss(e) || /UNIQUE constraint failed: courier_remittance(s\.id|_fees)/.test(String(e)))
      throw conflict('تغيّر تحصيل أحد الطرود أثناء التسجيل؛ أعد فتح الصفحة وحاول مجددًا', 'COURIER_CHANGED');
    throw e;
  }
  return { already: false, id: input.id, parcels: lines.length + feeLines.length };
}

/** The owner checked the transfer against Al-Zaeem's own statement: it is reconciled, once and for good. */
export async function reconcileRemittance(db: D1Database, actor: string, id: string, note: string): Promise<{ already: boolean }> {
  const undo = await courierUndoInstalled(db);
  const r = await db.prepare(`SELECT r.state,r.difference_iqd,${undo ? 'EXISTS(SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id=r.id)' : '0'} AS undone
      FROM courier_remittances r WHERE r.id=?`).bind(id).first<{ state: string; difference_iqd: number; undone: number }>();
  if (!r) throw notFound('Transfer not found');
  if (r.undone) throw conflict('تم التراجع عن هذا التحويل فلا يُطابَق', 'COURIER_UNDONE');
  if (r.state === 'reconciled') return { already: true };
  const at = new Date().toISOString();
  try {
    await db.batch([
      ...fence(db, "EXISTS(SELECT 1 FROM courier_remittances WHERE id=? AND state='received')", [id]),
      db.prepare("UPDATE courier_remittances SET state='reconciled',reconciled_by=?,reconciled_at=?,reconcile_note=? WHERE id=? AND state='received'").bind(actor, at, note, id),
      ...(await auditStatements(db, actor, 'finance.courier_remittance_reconciled', id, { difference_iqd: r.difference_iqd, note })).statements,
    ]);
  } catch (e) {
    // Undone by someone else between the read and the batch (the database refuses it).
    if (/undone courier remittance cannot be reconciled/.test(String(e))) throw conflict('تم التراجع عن هذا التحويل فلا يُطابَق', 'COURIER_UNDONE');
    // Reconciled by someone else between the read and the batch.
    if (isFenceMiss(e)) return { already: true };
    throw e;
  }
  return { already: false };
}

const mirrored = (lines: string) =>
  (JSON.parse(lines) as Array<[string, number, number]>).map(([account, debit, credit]) => ({ account, debit: credit, credit: debit }));

/**
 * UNDO A TRANSFER (migration 0233): one recorded by mistake and not checked against the courier's statement is taken back,
 * once, with a reason. One batch: the undo row; the transfer's parcels, prepaid fee lines and collections go; their fee
 * expenses are voided, then kept with the undone parcels, which locks them; each journal entry the transfer wrote is
 * reversed on the transfer's own day, so that day's books and its collections still agree. A parcel whose sale was posted
 * after its cash was recorded (the cash then waited as an advance, 2300) has its receivable back on 1100, where the sale
 * now looks for it. The month must be open; a retry is `already`.
 */
export async function undoRemittance(db: D1Database, actor: string, id: string, reason: string): Promise<{ already: boolean; parcels: number }> {
  if (!await courierUndoInstalled(db)) throw unavailable(NOT_READY, 'COURIER_NOT_CONFIGURED');
  const why = reason.trim();
  const r = await db.prepare(`SELECT r.state,r.kind,r.received_day,r.amount_iqd,r.difference_iqd,
      EXISTS(SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id=r.id) AS undone FROM courier_remittances r WHERE r.id=?`)
    .bind(id).first<{ state: string; kind: string; received_day: string; amount_iqd: number; difference_iqd: number; undone: number }>();
  if (!r) throw notFound('Transfer not found');
  if (r.undone) return { already: true, parcels: 0 };
  if (r.state === 'reconciled') throw conflict('طوبق هذا التحويل مع كشف شركة التوصيل فلا يُتراجع عنه', 'COURIER_RECONCILED');
  if (!why) throw badRequest('اكتب سبب التراجع عن التحويل', 'COURIER_UNDO_REASON');
  await periodOpen(db, r.received_day);
  const cash = (await db.prepare(`SELECT ro.order_id,ro.collection_id,ro.collected_iqd,ro.fee_iqd,c.expense_id,e.id AS entry_id,
      EXISTS(SELECT 1 FROM accounting_entries s WHERE s.event_key='sale:'||ro.order_id AND s.state='posted') AS sale_posted
    FROM courier_remittance_orders ro JOIN finance_collections c ON c.id=ro.collection_id
    LEFT JOIN accounting_entries e ON e.event_key='collection:'||ro.collection_id AND e.state='posted'
    WHERE ro.remittance_id=? ORDER BY ro.collection_id`).bind(id)
    .all<{ order_id: string; collection_id: string; collected_iqd: number; fee_iqd: number; expense_id: string | null; entry_id: string | null; sale_posted: number }>()).results ?? [];
  const prepaid = (await db.prepare(`SELECT f.order_id,f.fee_iqd,f.expense_id,e.id AS entry_id FROM courier_remittance_fees f
    LEFT JOIN accounting_entries e ON e.event_key='courier-fee:'||f.remittance_id||':'||f.order_id AND e.state='posted'
    WHERE f.remittance_id=? ORDER BY f.order_id`).bind(id)
    .all<{ order_id: string; fee_iqd: number; expense_id: string | null; entry_id: string | null }>()).results ?? [];
  const difference = await db.prepare(`SELECT e.id,(SELECT json_group_array(json_array(l.account_code,l.debit_iqd,l.credit_iqd)) FROM accounting_lines l WHERE l.entry_id=e.id) AS lines
    FROM accounting_entries e WHERE e.event_key=? AND e.state='posted'`).bind(`courier-difference:${id}`).first<{ id: string; lines: string }>();
  const expenses = [...cash.map((c) => c.expense_id), ...prepaid.map((f) => f.expense_id)].filter((x): x is string => !!x);
  const at = new Date().toISOString();
  const day = r.received_day;
  const statements: D1PreparedStatement[] = [
    // Nothing moved since the reads: still received and not undone, the same parcels, the same sales posted.
    // (fence binds its guard id first, so the condition takes plain ? parameters.)
    ...fence(db, `EXISTS(SELECT 1 FROM courier_remittances WHERE id=? AND state='received') AND NOT EXISTS(SELECT 1 FROM courier_remittance_voids WHERE remittance_id=?)
      AND (SELECT COUNT(*) FROM courier_remittance_orders WHERE remittance_id=?)=? AND (SELECT COUNT(*) FROM courier_remittance_fees WHERE remittance_id=?)=?
      AND (SELECT COUNT(*) FROM accounting_entries WHERE event_key IN (SELECT 'sale:'||value FROM json_each(?)) AND state='posted')=?`,
    [id, id, id, cash.length, id, prepaid.length, JSON.stringify(cash.map((c) => c.order_id)), cash.filter((c) => c.sale_posted).length]),
    db.prepare('INSERT INTO courier_remittance_voids(remittance_id,reason,actor_id,created_at) VALUES (?,?,?,?)').bind(id, why, actor, at),
    db.prepare('DELETE FROM courier_remittance_orders WHERE remittance_id=?').bind(id),
    db.prepare('DELETE FROM courier_remittance_fees WHERE remittance_id=?').bind(id),
    db.prepare('DELETE FROM finance_collections WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(cash.map((c) => c.collection_id))),
  ];
  if (expenses.length)
    statements.push(db.prepare('UPDATE operating_expenses SET voided_at=?,voided_by=?,void_reason=?,updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND voided_at IS NULL')
      .bind(at, actor, `تراجع عن تحويل شركة التوصيل: ${why}`.slice(0, 300), at, JSON.stringify(expenses)));
  // Kept after the void: from here on the voided expenses are locked (migration 0233's triggers).
  statements.push(
    ...cash.map((c) => db.prepare("INSERT INTO courier_remittance_undone(remittance_id,order_id,kind,collected_iqd,fee_iqd,collection_id,expense_id) VALUES (?,?,'cash',?,?,?,?)")
      .bind(id, c.order_id, c.collected_iqd, c.fee_iqd, c.collection_id, c.expense_id)),
    ...prepaid.map((f) => db.prepare("INSERT INTO courier_remittance_undone(remittance_id,order_id,kind,collected_iqd,fee_iqd,collection_id,expense_id) VALUES (?,?,'fee',0,?,NULL,?)")
      .bind(id, f.order_id, f.fee_iqd, f.expense_id)),
  );
  const reversal = (key: string, reversalOf: string, title: string, lines: Array<{ account: string; debit?: number; credit?: number }>) =>
    journalPlan(db, { key, day, title, source: 'courier_remittance', sourceId: id, actor, reversalOf }, lines).statements;
  for (const c of cash)
    if (c.entry_id)
      statements.push(...reversal(`courier-undo:${c.collection_id}`, c.entry_id, 'تراجع عن تحصيل طلب في تحويل شركة التوصيل', [
        { account: c.sale_posted ? '1100' : '2300', debit: c.collected_iqd },
        { account: '1000', credit: c.collected_iqd - c.fee_iqd },
        { account: '5200', credit: c.fee_iqd },
      ]));
  for (const f of prepaid)
    if (f.entry_id)
      statements.push(...reversal(`courier-undo-fee:${id}:${f.order_id}`, f.entry_id, 'تراجع عن أجرة طرد مدفوع مسبقًا في تحويل شركة التوصيل',
        [{ account: '1000', debit: f.fee_iqd }, { account: '5200', credit: f.fee_iqd }]));
  if (difference) statements.push(...reversal(`courier-undo-difference:${id}`, difference.id, 'تراجع عن فرق تحويل شركة التوصيل', mirrored(difference.lines)));
  statements.push(...(await auditStatements(db, actor, 'finance.courier_remittance_undone', id, {
    reason: why, kind: r.kind, received_day: day, amount_iqd: r.amount_iqd, difference_iqd: r.difference_iqd,
    parcels: cash.map((c) => [c.order_id, c.collected_iqd, c.fee_iqd]), prepaid: prepaid.map((f) => [f.order_id, f.fee_iqd]),
    collections: cash.map((c) => c.collection_id), expenses,
  })).statements);
  try {
    await db.batch(statements);
  } catch (e) {
    const text = String(e);
    if (/reconciled courier remittance cannot be undone/.test(text)) throw conflict('طوبق هذا التحويل مع كشف شركة التوصيل فلا يُتراجع عنه', 'COURIER_RECONCILED');
    if (/Accounting period closed/.test(text)) throw conflict('الفترة المحاسبية مغلقة؛ سجّل التصحيح في فترة مفتوحة', 'PERIOD_CLOSED');
    if (isFenceMiss(e) || /UNIQUE constraint failed: courier_remittance_voids/.test(text)) {
      // Undone by another request in the meantime: the same outcome. Anything else moved: read again.
      if (await db.prepare('SELECT 1 FROM courier_remittance_voids WHERE remittance_id=?').bind(id).first()) return { already: true, parcels: 0 };
      throw conflict('تغيّر التحويل أو أحد طلباته أثناء التراجع؛ أعد فتح الصفحة وحاول مجددًا', 'COURIER_CHANGED');
    }
    throw e;
  }
  return { already: false, parcels: cash.length + prepaid.length };
}
