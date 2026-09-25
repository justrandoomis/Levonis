/**
 * THE MERCHANT LEDGER — the one place a merchant's money is written and read
 * (docs/MERCHANT_PLATFORM.md §4.3, migration 0121, stream W2-B).
 *
 * WHAT IT IS. `merchant_ledger_entries` is APPEND-ONLY (triggers refuse UPDATE
 * and DELETE). Money sits in four buckets — pending → available → reserved →
 * paid — and a move between them is two lines that sum to zero. Every figure
 * a merchant or an admin sees is a SUM over these lines; nothing here stores a
 * balance. The kind decides the sign and the bucket (a CHECK), so a positive
 * commission or a "release" into `reserved` cannot be written at all, and no
 * NEW line may take a merchant's bucket below zero (a trigger) — except a
 * customer refund clawing back money already released, which the platform owes
 * the customer whatever the merchant withdrew.
 *
 * WHY EVERY WRITER COMES THROUGH HERE. The old ledger had seven writers in five
 * files, each with its own idea of "pending", and a payout that never lowered
 * «available» (audit 02 B3). Now:
 *
 *   store sale ............ `storeSaleLedgerStatements`   (worker/routes/storeOrders.ts)
 *   receipt / 3-day release `releaseOrderCreditStatements` (worker/lib/storeOrderOps.ts)
 *   cancel / take-back ..... `reverseOrderCreditStatement`  (worker/lib/storeOrderOps.ts)
 *   custom-order escrow .... `escrowCreditStatements`       (worker/lib/escrowOps.ts)
 *   admin adjustment ....... `adjustMerchantBalance`
 *   payouts ................ `requestPayout` · `cancelPayout` · `approvePayout`
 *                            · `markPayoutPaid` · `failPayout` · `recordAdminPayout`
 *
 * and every reader asks `merchantBuckets` (or the SQL it is built on).
 *
 * THE DISPUTE FREEZE is not a line: a freeze moves no money. The release
 * statements carry the owner's condition (no open complaint or ticket) inside
 * the statement that would move it, and the finance summary reports the
 * pending money a dispute is holding (`pending_frozen`).
 *
 * EVERY GUARD IS INSIDE THE STATEMENT THAT WRITES (the file-wide rule of
 * worker/lib/walletOps.ts): a payout reserves only if the INSERT itself finds
 * enough available, a leg lands only beside the state change it belongs to,
 * and a fence aborts the batch — audit row included — when the change it
 * guards did not happen.
 *
 * FOR THE NOTIFICATION STREAM (W2-E): the release functions report
 * `{ merchantId, amountIqd }` of what became available, and `payoutFacts`
 * gives what a «payout_paid» notice needs; both are plain reads, safe to call
 * after the money moved.
 */
import { newId } from './crypto';
import { auditStatements } from './audit';

export type LedgerBucket = 'pending' | 'available' | 'reserved' | 'paid';
export type LedgerKind =
  | 'sale_gross'
  | 'commission'
  | 'delivery_fee'
  | 'refund'
  | 'commission_refund'
  | 'delivery_refund'
  | 'escrow_release'
  | 'adjustment'
  | 'release'
  | 'payout'
  | 'payout_reversal';

export const LEDGER_KINDS: readonly LedgerKind[] = [
  'sale_gross', 'commission', 'delivery_fee', 'refund', 'commission_refund', 'delivery_refund',
  'escrow_release', 'adjustment', 'release', 'payout', 'payout_reversal',
];
export const LEDGER_BUCKETS: readonly LedgerBucket[] = ['pending', 'available', 'reserved', 'paid'];

const NOW = () => new Date().toISOString();

const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

// ------------------------------------------------------------------ balances

/** One bucket of one merchant, as SQL — `m` is a placeholder or a column. */
export const bucketSumSql = (m: string, bucket: LedgerBucket) =>
  `(SELECT COALESCE(SUM(amount_iqd), 0) FROM merchant_ledger_entries WHERE merchant_id = ${m} AND bucket = '${bucket}')`;

/**
 * WHAT A MERCHANT MAY BE PAID OUT NOW — the SQL the payout INSERT carries, so
 * the figure the merchant is shown and the figure the database enforces are
 * the same expression.
 */
export const merchantAvailableSql = (m: string) => bucketSumSql(m, 'available');

export interface Buckets {
  pending: number;
  available: number;
  reserved: number;
  paid: number;
}

/** THE balance function: one SUM per bucket. Every surface reads this. */
export async function merchantBuckets(db: D1Database, merchantId: string): Promise<Buckets> {
  const { results } = await db
    .prepare(
      `SELECT bucket, COALESCE(SUM(amount_iqd), 0) AS total
         FROM merchant_ledger_entries WHERE merchant_id = ? GROUP BY bucket`
    )
    .bind(merchantId)
    .all<{ bucket: LedgerBucket; total: number }>();
  const out: Buckets = { pending: 0, available: 0, reserved: 0, paid: 0 };
  for (const r of results ?? []) if (r.bucket in out) out[r.bucket] = Number(r.total) || 0;
  return out;
}

/**
 * The wave-1 shape, kept for the screens and tests that read it:
 * `paid_iqd` is NEGATIVE (money that left), as the old payout rows were.
 * Derived from `merchantBuckets` — not a second computation.
 */
export async function merchantBalance(
  db: D1Database,
  merchantId: string
): Promise<{ available_iqd: number; pending_iqd: number; paid_iqd: number }> {
  const b = await merchantBuckets(db, merchantId);
  return { available_iqd: b.available, pending_iqd: b.pending, paid_iqd: b.paid === 0 ? 0 : -b.paid };
}

// ------------------------------------------------------------ one order

/**
 * A store order's money, as one SQL column: `pending` (waiting for the
 * customer or the three days), `available` (released), `reversed` (cancelled
 * or taken back), or NULL when the order has no lines. `o` is the SQL for the
 * order id.
 */
export const orderCreditStateSql = (o: string) => `(SELECT CASE
     WHEN COUNT(*) = 0 THEN NULL
     WHEN SUM(CASE WHEN bucket = 'pending' THEN amount_iqd ELSE 0 END) > 0 THEN 'pending'
     WHEN SUM(CASE WHEN bucket = 'available' THEN amount_iqd ELSE 0 END) > 0 THEN 'available'
     WHEN SUM(CASE WHEN kind IN ('refund','delivery_refund','commission_refund') THEN 1 ELSE 0 END) > 0 THEN 'reversed'
     ELSE 'settled' END
   FROM merchant_ledger_entries WHERE order_id = ${o})`;

export interface OrderCredit {
  state: 'pending' | 'available' | 'reversed' | 'settled' | null;
  pending_iqd: number;
  available_iqd: number;
  merchant_id: string | null;
}

export async function orderCredit(db: D1Database, orderId: string): Promise<OrderCredit> {
  const row = await db
    .prepare(
      `SELECT ${orderCreditStateSql('?1')} AS state,
              (SELECT COALESCE(SUM(amount_iqd), 0) FROM merchant_ledger_entries WHERE order_id = ?1 AND bucket = 'pending') AS pend,
              (SELECT COALESCE(SUM(amount_iqd), 0) FROM merchant_ledger_entries WHERE order_id = ?1 AND bucket = 'available') AS avail,
              (SELECT merchant_id FROM merchant_ledger_entries WHERE order_id = ?1 LIMIT 1) AS merchant_id`
    )
    .bind(orderId)
    .first<{ state: OrderCredit['state']; pend: number; avail: number; merchant_id: string | null }>();
  return {
    state: row?.state ?? null,
    pending_iqd: Number(row?.pend) || 0,
    available_iqd: Number(row?.avail) || 0,
    merchant_id: row?.merchant_id ?? null,
  };
}

// ------------------------------------------------------------ store sale

export interface StoreSaleInput {
  orderId: string;
  merchantId: string;
  storeId: string | null;
  /** The goods the customer paid for, after the merchant's coupon. */
  goodsIqd: number;
  /** The platform's commission on the goods (5% by default, admin-editable). */
  commissionIqd: number;
  /** The merchant's own delivery fee — never part of the commission base. */
  deliveryIqd: number;
  ts: string;
  createdBy?: string | null;
}

/** What the merchant is owed for a sale: goods − commission + delivery. */
export function storeSaleReceivable(p: Pick<StoreSaleInput, 'goodsIqd' | 'commissionIqd' | 'deliveryIqd'>): number {
  return p.goodsIqd - p.commissionIqd + p.deliveryIqd;
}

/**
 * A STORE SALE'S LINES, for the order's own batch: the gross, the commission
 * as its OWN line (the owner's rule), and the delivery fee as its own line —
 * all PENDING until the customer confirms receipt or three days pass after
 * delivery with no open complaint. Zero lines are not written. A malformed
 * figure is a programming error and throws before anything is written.
 */
export function storeSaleLedgerStatements(db: D1Database, p: StoreSaleInput): D1PreparedStatement[] {
  if (!p.orderId || !p.merchantId) throw new Error('storeSaleLedgerStatements: order and merchant are required');
  if (!isMoney(p.goodsIqd) || !isMoney(p.commissionIqd) || !isMoney(p.deliveryIqd) || p.commissionIqd > p.goodsIqd) {
    throw new Error(`storeSaleLedgerStatements: invalid figures for ${p.orderId}`);
  }
  const lines: Array<[string, LedgerKind, number, string]> = [
    ['gross', 'sale_gross', p.goodsIqd, 'store sale'],
    ['commission', 'commission', -p.commissionIqd, 'platform commission'],
    ['delivery', 'delivery_fee', p.deliveryIqd, 'your delivery fee'],
  ];
  return lines
    .filter(([, , amount]) => amount !== 0)
    .map(([part, kind, amount, note]) =>
      db
        .prepare(
          `INSERT INTO merchant_ledger_entries
             (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(newId('mle'), p.merchantId, p.storeId, p.orderId, kind, amount, `sale:${p.orderId}:${part}`, note, p.createdBy ?? null, p.ts)
    );
}

// --------------------------------------------------------------- release

export interface ReleaseInput {
  orderId: string;
  merchantId: string;
  actorId: string | null;
  note: string;
  ts: string;
  /**
   * A further condition, INSIDE the statement that moves the money. Its
   * placeholders are numbered from ?7 (the statement owns ?1–?6).
   */
  condition?: { sql: string; binds: unknown[] };
}

/**
 * PENDING → AVAILABLE FOR ONE STORE ORDER: two lines, `release:<order>`,
 * moving exactly what the order holds in pending — computed inside the
 * statement, so a cancellation or a second release that got there first
 * leaves nothing to move. Once per order, by its key.
 */
export function releaseOrderCreditStatements(db: D1Database, p: ReleaseInput): D1PreparedStatement[] {
  const outId = newId('mle');
  const cond = p.condition ? ` AND (${p.condition.sql})` : '';
  return [
    db
      .prepare(
        `INSERT INTO merchant_ledger_entries
           (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
         SELECT ?1, ?2, t.store_id, ?3, 'release', 'pending', -t.pend, 'release:' || ?3 || ':pending', ?4, ?5, ?6
           FROM (SELECT MAX(store_id) AS store_id,
                        COALESCE(SUM(CASE WHEN bucket = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pend
                   FROM merchant_ledger_entries WHERE order_id = ?3 AND merchant_id = ?2) t
          WHERE t.pend > 0
            AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries x WHERE x.event_key = 'release:' || ?3 || ':pending')${cond}`
      )
      .bind(outId, p.merchantId, p.orderId, p.note.slice(0, 300), p.actorId, p.ts, ...(p.condition?.binds ?? [])),
    db
      .prepare(
        `INSERT INTO merchant_ledger_entries
           (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
         SELECT ?1, merchant_id, store_id, order_id, 'release', 'available', -amount_iqd,
                'release:' || order_id || ':available', note, created_by, created_at
           FROM merchant_ledger_entries WHERE id = ?2`
      )
      .bind(newId('mle'), outId),
  ];
}

// -------------------------------------------------------------- reversal

export interface ReverseInput {
  orderId: string;
  merchantId: string;
  actorId: string | null;
  note: string;
  ts: string;
  /** This batch's id prefix; the lines are `<prefix>_refund` and so on. */
  idPrefix?: string;
  /** A further condition, INSIDE the statement; placeholders from ?7. */
  guard?: { sql: string; binds: unknown[] };
}

/**
 * THE SALE UNDONE: refund lines that zero what the order still holds —
 * in pending when it was never released, in available when it was (a
 * claw-back, which may leave the merchant owing). Mirrors the sale's own
 * lines: refund (the goods), commission_refund (the platform gives its cut
 * back), delivery_refund. ONE statement: the bucket and the figures are
 * computed once, before any line of it is written, and a second reversal
 * finds nothing left to reverse. Keys `reversal:<order>:<part>`.
 */
export function reverseOrderCreditStatement(db: D1Database, p: ReverseInput): { statement: D1PreparedStatement; idPrefix: string } {
  const prefix = p.idPrefix ?? newId('mle');
  const guard = p.guard ? ` AND (${p.guard.sql})` : '';
  const statement = db
    .prepare(
      `INSERT INTO merchant_ledger_entries
         (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
       SELECT ?1 || '_' || q.part, ?2, q.store_id, ?3, q.kind, q.bucket, q.amt, 'reversal:' || ?3 || ':' || q.part, ?4, ?5, ?6
         FROM (
           SELECT s.store_id, s.bucket, k.part, k.kind,
                  CASE WHEN s.total + s.f - s.d > 0
                       THEN CASE k.part WHEN 'refund' THEN -(s.total + s.f - s.d)
                                        WHEN 'commission_refund' THEN s.f
                                        ELSE -s.d END
                       ELSE CASE k.part WHEN 'refund' THEN -s.total ELSE 0 END
                  END AS amt
             FROM (
               SELECT t.store_id,
                      CASE WHEN t.pend > 0 THEN 'pending' WHEN t.avail > 0 THEN 'available' END AS bucket,
                      CASE WHEN t.pend > 0 THEN t.pend ELSE t.avail END AS total,
                      CASE WHEN t.f > 0 THEN t.f ELSE 0 END AS f,
                      CASE WHEN t.d > 0 THEN t.d ELSE 0 END AS d
                 FROM (
                   SELECT MAX(store_id) AS store_id,
                          COALESCE(SUM(CASE WHEN bucket = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pend,
                          COALESCE(SUM(CASE WHEN bucket = 'available' THEN amount_iqd ELSE 0 END), 0) AS avail,
                          -COALESCE(SUM(CASE WHEN kind = 'commission' THEN amount_iqd ELSE 0 END), 0)
                            - COALESCE(SUM(CASE WHEN kind = 'commission_refund' THEN amount_iqd ELSE 0 END), 0) AS f,
                          COALESCE(SUM(CASE WHEN kind IN ('delivery_fee','delivery_refund') THEN amount_iqd ELSE 0 END), 0) AS d
                     FROM merchant_ledger_entries WHERE order_id = ?3 AND merchant_id = ?2
                 ) t
             ) s
             CROSS JOIN (SELECT 'refund' AS part, 'refund' AS kind
                         UNION ALL SELECT 'commission_refund', 'commission_refund'
                         UNION ALL SELECT 'delivery_refund', 'delivery_refund') k
            WHERE s.bucket IS NOT NULL
         ) q
        WHERE q.amt <> 0
          AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries x WHERE x.event_key = 'reversal:' || ?3 || ':' || q.part)${guard}`
    )
    .bind(prefix, p.merchantId, p.orderId, p.note.slice(0, 300), p.actorId, p.ts, ...(p.guard?.binds ?? []));
  return { statement, idPrefix: prefix };
}

// ------------------------------------------------------------ custom orders

export interface EscrowCreditInput {
  escrowId: string;
  merchantId: string;
  communityOrderId: string;
  /** What the merchant's sale was worth: the escrow's gross (or the part kept). */
  grossIqd: number;
  /** The platform's part of it. */
  commissionIqd: number;
  stage: 'release' | 'partial';
  note: string;
  actorId: string | null;
  ts: string;
}

/**
 * A CUSTOM ORDER'S MONEY, released from escrow: `escrow_release` (+gross)
 * and its commission (−) straight into AVAILABLE — the escrow itself was the
 * waiting period. `guard` is the settlement's own "the customer's debit is
 * posted" predicate, its two placeholders bound first (?1, ?2), so money
 * enters the merchant's ledger only in a batch where it left the customer's.
 */
export function escrowCreditStatements(
  db: D1Database,
  guard: { sql: string; binds: [unknown, unknown] },
  p: EscrowCreditInput
): D1PreparedStatement[] {
  if (!isMoney(p.grossIqd) || !isMoney(p.commissionIqd) || p.commissionIqd > p.grossIqd) {
    throw new Error(`escrowCreditStatements: invalid figures for ${p.escrowId}`);
  }
  const lines: Array<[string, LedgerKind, number]> = [
    ['gross', 'escrow_release', p.grossIqd],
    ['commission', 'commission', -p.commissionIqd],
  ];
  return lines
    .filter(([, , amount]) => amount !== 0)
    .map(([part, kind, amount]) =>
      db
        .prepare(
          `INSERT INTO merchant_ledger_entries
             (id, merchant_id, store_id, community_order_id, escrow_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
           SELECT ?3, ?4, (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = ?4), ?5, ?6, ?7, 'available', ?8, ?9, ?10, ?11, ?12
            WHERE ${guard.sql}`
        )
        .bind(
          ...guard.binds,
          newId('mle'), p.merchantId, p.communityOrderId, p.escrowId, kind, amount,
          `escrow:${p.escrowId}:${p.stage}:${part}`, part === 'commission' ? 'platform commission' : p.note.slice(0, 300),
          p.actorId, p.ts
        )
    );
}

// ------------------------------------------------------------------ fences

/**
 * THE BATCH ABORTS UNLESS `condition` HOLDS — by inserting a zero-amount
 * line, which the table's `CHECK (amount_iqd <> 0)` refuses. It never writes
 * anything when the condition holds. `condition` placeholders start at ?2.
 */
function fence(db: D1Database, merchantId: string, condition: string, binds: unknown[] = []): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO merchant_ledger_entries (id, merchant_id, kind, bucket, amount_iqd, event_key, note)
       SELECT 'fence', ?1, 'adjustment', 'available', 0, 'fence', 'fence' WHERE NOT (${condition})`
    )
    .bind(merchantId, ...binds);
}

/**
 * THE DEBT FENCE (review W2-5 p4): aborts the batch while the merchant owes the
 * platform — «available» below zero after a claw-back. The decisions that SEND
 * money (approve, paid) carry it as their FIRST statement, so a payout reserved
 * before the claw-back cannot leave while the debt lasts; fail/cancel do not
 * (they return the reservation to «available», which reduces the debt).
 */
function debtFence(db: D1Database, merchantId: string): D1PreparedStatement {
  return fence(db, merchantId, `${merchantAvailableSql('?1')} >= 0`);
}

const isFenceAbort = (e: unknown) => /CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isOverdraw = (e: unknown) => /LEDGER_BUCKET_OVERDRAWN/.test(e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ payouts

export type PayoutState = 'requested' | 'approved' | 'paid' | 'failed' | 'cancelled';

export interface PayoutMethodSnapshot {
  /** The channel id from the owner's `payoutMethods` (or 'manual' for an admin record, 'legacy'). */
  channel: string;
  /** Its name as the owner wrote it, frozen at request time. */
  label: string;
  account: string;
  holder: string;
}

export interface PayoutRow {
  id: string;
  merchant_id: string;
  store_id: string | null;
  amount_iqd: number;
  state: PayoutState;
  method_snapshot: string;
  note: string;
  reference: string;
  decision_reason: string;
  source: 'merchant' | 'admin' | 'legacy';
  requested_by: string | null;
  decided_by: string | null;
  event_key: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
}

export type PayoutFailure =
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_BALANCE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  /** Approve / paid refused: the merchant's «available» is below zero (a claw-back). */
  | 'MERCHANT_IN_DEBT';

export type PayoutResult =
  | { ok: true; payout: PayoutRow; replayed: boolean }
  | { ok: false; reason: PayoutFailure; availableIqd?: number; state?: PayoutState; debtIqd?: number };

export function getPayout(db: D1Database, id: string): Promise<PayoutRow | null> {
  return db.prepare('SELECT * FROM merchant_payouts WHERE id = ?').bind(id).first<PayoutRow>();
}

/** The payout as its merchant (or an admin) may read it: the snapshot parsed. */
export function payoutPublic(p: PayoutRow) {
  let method: Partial<PayoutMethodSnapshot> = {};
  try {
    method = JSON.parse(p.method_snapshot || '{}');
  } catch {
    method = {};
  }
  return {
    id: p.id,
    amount_iqd: Number(p.amount_iqd) || 0,
    state: p.state,
    source: p.source,
    method: {
      channel: String(method.channel ?? ''),
      label: String(method.label ?? ''),
      account: String(method.account ?? ''),
      holder: String(method.holder ?? ''),
    },
    note: p.note || '',
    reference: p.reference || '',
    decision_reason: p.decision_reason || '',
    created_at: p.created_at,
    updated_at: p.updated_at,
    approved_at: p.approved_at,
    paid_at: p.paid_at,
    failed_at: p.failed_at,
    cancelled_at: p.cancelled_at,
  };
}

/** One leg of a payout move, landing only while `when` holds (placeholders from ?10). */
function payoutLeg(
  db: D1Database,
  p: {
    payoutId: string;
    kind: 'payout' | 'payout_reversal';
    bucket: LedgerBucket;
    sign: 1 | -1;
    eventKey: string;
    note: string;
    actorId: string | null;
    ts: string;
    when: string;
    whenBinds?: unknown[];
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO merchant_ledger_entries
         (id, merchant_id, store_id, payout_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
       SELECT ?1, p.merchant_id, p.store_id, p.id, ?3, ?4, ?5 * p.amount_iqd, ?6, ?7, ?8, ?9
         FROM merchant_payouts p
        WHERE p.id = ?2 AND (${p.when})
          AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries x WHERE x.event_key = ?6)`
    )
    .bind(newId('mle'), p.payoutId, p.kind, p.bucket, p.sign, p.eventKey, p.note.slice(0, 300), p.actorId, p.ts, ...(p.whenBinds ?? []));
}

/** The two legs that reserve a freshly inserted payout: available → reserved. */
function reserveLegs(db: D1Database, payoutId: string, actorId: string | null, ts: string): D1PreparedStatement[] {
  const when = `p.state = 'requested' AND p.created_at = ?10`;
  return [
    payoutLeg(db, { payoutId, kind: 'payout', bucket: 'available', sign: -1, eventKey: `payout:${payoutId}:reserve:available`, note: 'payout requested', actorId, ts, when, whenBinds: [ts] }),
    payoutLeg(db, { payoutId, kind: 'payout', bucket: 'reserved', sign: 1, eventKey: `payout:${payoutId}:reserve:reserved`, note: 'payout requested', actorId, ts, when, whenBinds: [ts] }),
  ];
}

function paidLegs(db: D1Database, payoutId: string, actorId: string | null, ts: string): D1PreparedStatement[] {
  const when = `p.state = 'paid' AND p.paid_at = ?10`;
  return [
    payoutLeg(db, { payoutId, kind: 'payout', bucket: 'reserved', sign: -1, eventKey: `payout:${payoutId}:paid:reserved`, note: 'payout sent', actorId, ts, when, whenBinds: [ts] }),
    payoutLeg(db, { payoutId, kind: 'payout', bucket: 'paid', sign: 1, eventKey: `payout:${payoutId}:paid:paid`, note: 'payout sent', actorId, ts, when, whenBinds: [ts] }),
  ];
}

function returnLegs(db: D1Database, payoutId: string, to: 'failed' | 'cancelled', actorId: string | null, ts: string): D1PreparedStatement[] {
  const stamp = to === 'failed' ? 'failed_at' : 'cancelled_at';
  const when = `p.state = '${to}' AND p.${stamp} = ?10`;
  const note = to === 'failed' ? 'payout failed — returned to available' : 'payout cancelled — returned to available';
  return [
    payoutLeg(db, { payoutId, kind: 'payout_reversal', bucket: 'reserved', sign: -1, eventKey: `payout:${payoutId}:return:reserved`, note, actorId, ts, when, whenBinds: [ts] }),
    payoutLeg(db, { payoutId, kind: 'payout_reversal', bucket: 'available', sign: 1, eventKey: `payout:${payoutId}:return:available`, note, actorId, ts, when, whenBinds: [ts] }),
  ];
}

export interface RequestPayoutInput {
  merchantId: string;
  storeId: string | null;
  amountIqd: number;
  method: PayoutMethodSnapshot;
  note?: string;
  requestedBy: string;
  /** The caller's idempotency key; namespaced here, never stored bare. */
  key: string;
  source?: 'merchant' | 'admin';
  ts?: string;
}

/** The server-minted event key of a payout request — per merchant, per source. */
export const payoutEventKey = (source: 'merchant' | 'admin', merchantId: string, key: string) =>
  source === 'admin' ? `admin:${merchantId}:${key}` : `${merchantId}:${key}`;

async function priorPayout(
  db: D1Database,
  eventKey: string,
  merchantId: string,
  amountIqd: number
): Promise<PayoutResult | null> {
  const prior = await db.prepare('SELECT * FROM merchant_payouts WHERE event_key = ?').bind(eventKey).first<PayoutRow>();
  if (!prior) return null;
  if (prior.merchant_id === merchantId && Number(prior.amount_iqd) === amountIqd) return { ok: true, payout: prior, replayed: true };
  return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
}

/**
 * A MERCHANT ASKS TO BE PAID: the request and its reservation, in ONE batch.
 *
 * The INSERT of the request carries the comparison with «available», so two
 * requests racing on one balance cannot both land (D1 runs one batch at a
 * time; the second sees the first's reservation). The two legs move exactly
 * the payout's amount from available to reserved, and a fence aborts the whole
 * batch — the audit row with it — when the request was not written.
 */
export async function requestPayout(db: D1Database, p: RequestPayoutInput): Promise<PayoutResult> {
  if (!(Number.isSafeInteger(p.amountIqd) && p.amountIqd > 0 && p.amountIqd <= 1_000_000_000)) {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  const source = p.source ?? 'merchant';
  const eventKey = payoutEventKey(source, p.merchantId, p.key);
  const prior = await priorPayout(db, eventKey, p.merchantId, p.amountIqd);
  if (prior) return prior;

  const ts = p.ts ?? NOW();
  const id = newId('mpo');
  const { statements: auditStmts } = await auditStatements(db, p.requestedBy, 'merchant.payout_requested', id, {
    merchant_id: p.merchantId,
    amount_iqd: p.amountIqd,
    channel: p.method.channel,
    source,
  });
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO merchant_payouts
           (id, merchant_id, store_id, amount_iqd, state, method_snapshot, note, source, requested_by, event_key, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, 'requested', ?5, ?6, ?7, ?8, ?9, ?10, ?10
          WHERE ${merchantAvailableSql('?2')} >= ?4`
      )
      .bind(id, p.merchantId, p.storeId, p.amountIqd, JSON.stringify(p.method), (p.note ?? '').slice(0, 300), source, p.requestedBy, eventKey, ts),
    fence(db, p.merchantId, 'EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2)', [id]),
    ...reserveLegs(db, id, p.requestedBy, ts),
    ...auditStmts,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const keyClash = /UNIQUE/i.test(msg) && /event_key/i.test(msg);
    if (!isFenceAbort(e) && !keyClash && !isOverdraw(e)) throw e;
    const again = await priorPayout(db, eventKey, p.merchantId, p.amountIqd);
    if (again) return again;
    const b = await merchantBuckets(db, p.merchantId);
    return { ok: false, reason: 'INSUFFICIENT_BALANCE', availableIqd: b.available };
  }
  const payout = await getPayout(db, id);
  return { ok: true, payout: payout!, replayed: false };
}

interface DecideInput {
  payoutId: string;
  actorId: string;
  ts?: string;
}

async function stateAnswer(db: D1Database, id: string, wanted: PayoutState): Promise<PayoutResult> {
  const now = await getPayout(db, id);
  if (!now) return { ok: false, reason: 'NOT_FOUND' };
  if (now.state === wanted) return { ok: true, payout: now, replayed: true };
  return { ok: false, reason: 'STATE_CONFLICT', state: now.state };
}

/** Run a decision batch; a fence abort is answered from the row as it is now. */
async function decide(
  db: D1Database,
  id: string,
  wanted: PayoutState,
  build: (payout: PayoutRow, ts: string) => Promise<D1PreparedStatement[]>,
  allowedFrom: PayoutState[],
  scope?: { merchantId: string },
  ts = NOW(),
  debtFenced = false
): Promise<PayoutResult> {
  const payout = await getPayout(db, id);
  if (!payout || (scope && payout.merchant_id !== scope.merchantId)) return { ok: false, reason: 'NOT_FOUND' };
  if (payout.state === wanted) return { ok: true, payout, replayed: true };
  if (!allowedFrom.includes(payout.state)) return { ok: false, reason: 'STATE_CONFLICT', state: payout.state };
  try {
    await db.batch(await build(payout, ts));
  } catch (e) {
    if (!isFenceAbort(e) && !/PAYOUT_STATE_TRANSITION/.test(e instanceof Error ? e.message : String(e))) throw e;
    if (debtFenced) {
      // The debt fence aborted the batch: say so, with the debt, while the row
      // is still where the decision found it (otherwise the state answers).
      const now = await getPayout(db, id);
      if (now && allowedFrom.includes(now.state)) {
        const b = await merchantBuckets(db, now.merchant_id);
        if (b.available < 0) return { ok: false, reason: 'MERCHANT_IN_DEBT', debtIqd: -b.available, availableIqd: b.available, state: now.state };
      }
    }
    return stateAnswer(db, id, wanted);
  }
  const after = await getPayout(db, id);
  return { ok: true, payout: after!, replayed: false };
}

/** The merchant takes back a request nobody has approved yet: reserved → available. */
export function cancelPayout(db: D1Database, p: DecideInput & { merchantId: string }): Promise<PayoutResult> {
  return decide(
    db,
    p.payoutId,
    'cancelled',
    async (payout, ts) => [
      db
        .prepare(
          `UPDATE merchant_payouts SET state = 'cancelled', cancelled_at = ?1, updated_at = ?1, decision_reason = 'cancelled by the merchant'
            WHERE id = ?2 AND merchant_id = ?3 AND state = 'requested'`
        )
        .bind(ts, p.payoutId, p.merchantId),
      fence(db, payout.merchant_id, `EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2 AND state = 'cancelled' AND cancelled_at = ?3)`, [p.payoutId, ts]),
      ...returnLegs(db, p.payoutId, 'cancelled', p.actorId, ts),
      ...(await auditStatements(db, p.actorId, 'merchant.payout_cancelled', p.payoutId, { merchant_id: payout.merchant_id, amount_iqd: payout.amount_iqd })).statements,
    ],
    ['requested'],
    { merchantId: p.merchantId },
    p.ts
  );
}

/** An admin accepts the request for transfer. No money moves: it stays reserved. */
export function approvePayout(db: D1Database, p: DecideInput): Promise<PayoutResult> {
  return decide(
    db,
    p.payoutId,
    'approved',
    async (payout, ts) => [
      debtFence(db, payout.merchant_id),
      db
        .prepare(
          `UPDATE merchant_payouts SET state = 'approved', approved_at = ?1, updated_at = ?1, decided_by = ?2
            WHERE id = ?3 AND state = 'requested'`
        )
        .bind(ts, p.actorId, p.payoutId),
      fence(db, payout.merchant_id, `EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2 AND state = 'approved' AND approved_at = ?3)`, [p.payoutId, ts]),
      ...(await auditStatements(db, p.actorId, 'admin.merchant_payout_approved', p.payoutId, { merchant_id: payout.merchant_id, amount_iqd: payout.amount_iqd })).statements,
    ],
    ['requested'],
    undefined,
    p.ts,
    true
  );
}

/** The transfer was made: reserved → paid, with the transfer's reference on the record. */
export function markPayoutPaid(db: D1Database, p: DecideInput & { reference: string }): Promise<PayoutResult> {
  const reference = p.reference.trim().slice(0, 120);
  return decide(
    db,
    p.payoutId,
    'paid',
    async (payout, ts) => [
      debtFence(db, payout.merchant_id),
      db
        .prepare(
          `UPDATE merchant_payouts SET state = 'paid', paid_at = ?1, updated_at = ?1, decided_by = ?2, reference = ?3
            WHERE id = ?4 AND state = 'approved'`
        )
        .bind(ts, p.actorId, reference, p.payoutId),
      fence(db, payout.merchant_id, `EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2 AND state = 'paid' AND paid_at = ?3)`, [p.payoutId, ts]),
      ...paidLegs(db, p.payoutId, p.actorId, ts),
      ...(await auditStatements(db, p.actorId, 'admin.merchant_payout_paid', p.payoutId, {
        merchant_id: payout.merchant_id,
        amount_iqd: payout.amount_iqd,
        reference,
      })).statements,
    ],
    ['approved'],
    undefined,
    p.ts,
    true
  );
}

/** The transfer did not go through (or was refused): reserved → available, with the reason. */
export function failPayout(db: D1Database, p: DecideInput & { reason: string }): Promise<PayoutResult> {
  const reason = p.reason.trim().slice(0, 300);
  return decide(
    db,
    p.payoutId,
    'failed',
    async (payout, ts) => [
      db
        .prepare(
          `UPDATE merchant_payouts SET state = 'failed', failed_at = ?1, updated_at = ?1, decided_by = ?2, decision_reason = ?3
            WHERE id = ?4 AND state IN ('requested','approved')`
        )
        .bind(ts, p.actorId, reason, p.payoutId),
      fence(db, payout.merchant_id, `EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2 AND state = 'failed' AND failed_at = ?3)`, [p.payoutId, ts]),
      ...returnLegs(db, p.payoutId, 'failed', p.actorId, ts),
      ...(await auditStatements(db, p.actorId, 'admin.merchant_payout_failed', p.payoutId, {
        merchant_id: payout.merchant_id,
        amount_iqd: payout.amount_iqd,
        reason,
      })).statements,
    ],
    ['requested', 'approved'],
    undefined,
    p.ts
  );
}

/**
 * AN ADMIN RECORDS A TRANSFER THEY ALREADY MADE (the wave-1 «تسجيل تحويل»
 * sheet): a payout on the merchant's behalf, requested, approved and paid in
 * ONE batch through exactly the statements the queue uses — reserved only if
 * available covers it, the reference on the record, audited once.
 */
export async function recordAdminPayout(
  db: D1Database,
  p: { merchantId: string; amountIqd: number; reference: string; adminId: string; key: string; ts?: string }
): Promise<PayoutResult> {
  if (!(Number.isSafeInteger(p.amountIqd) && p.amountIqd > 0 && p.amountIqd <= 1_000_000_000)) {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  const eventKey = payoutEventKey('admin', p.merchantId, p.key);
  const prior = await priorPayout(db, eventKey, p.merchantId, p.amountIqd);
  if (prior) return prior;
  const ts = p.ts ?? NOW();
  const id = newId('mpo');
  const reference = p.reference.trim().slice(0, 120) || 'recorded by Levonis';
  const method: PayoutMethodSnapshot = { channel: 'manual', label: '', account: '', holder: '' };
  const { statements: auditStmts } = await auditStatements(db, p.adminId, 'admin.merchant_payout', p.merchantId, {
    payout_id: id,
    amount: p.amountIqd,
    note: reference,
    idempotency_key: p.key,
  });
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO merchant_payouts
           (id, merchant_id, store_id, amount_iqd, state, method_snapshot, source, requested_by, event_key, created_at, updated_at)
         SELECT ?1, ?2, (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = ?2), ?3, 'requested', ?4, 'admin', ?5, ?6, ?7, ?7
          WHERE ${merchantAvailableSql('?2')} >= ?3`
      )
      .bind(id, p.merchantId, p.amountIqd, JSON.stringify(method), p.adminId, eventKey, ts),
    fence(db, p.merchantId, 'EXISTS (SELECT 1 FROM merchant_payouts WHERE id = ?2)', [id]),
    ...reserveLegs(db, id, p.adminId, ts),
    db
      .prepare(`UPDATE merchant_payouts SET state = 'approved', approved_at = ?1, updated_at = ?1, decided_by = ?2 WHERE id = ?3 AND state = 'requested'`)
      .bind(ts, p.adminId, id),
    db
      .prepare(`UPDATE merchant_payouts SET state = 'paid', paid_at = ?1, updated_at = ?1, reference = ?2 WHERE id = ?3 AND state = 'approved'`)
      .bind(ts, reference, id),
    ...paidLegs(db, id, p.adminId, ts),
    ...auditStmts,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const keyClash = /UNIQUE/i.test(msg) && /event_key/i.test(msg);
    if (!isFenceAbort(e) && !keyClash && !isOverdraw(e)) throw e;
    const again = await priorPayout(db, eventKey, p.merchantId, p.amountIqd);
    if (again) return again;
    const b = await merchantBuckets(db, p.merchantId);
    return { ok: false, reason: 'INSUFFICIENT_BALANCE', availableIqd: b.available };
  }
  return { ok: true, payout: (await getPayout(db, id))!, replayed: false };
}

/** What a «payout_paid» / «payout_failed» notice needs (stream W2-E), or null. */
export async function payoutFacts(db: D1Database, payoutId: string) {
  return db
    .prepare(
      `SELECT p.id, p.merchant_id, m.user_id AS merchant_user_id, p.amount_iqd, p.state, p.reference, p.decision_reason
         FROM merchant_payouts p JOIN community_merchants m ON m.id = p.merchant_id WHERE p.id = ?`
    )
    .bind(payoutId)
    .first<{ id: string; merchant_id: string; merchant_user_id: string; amount_iqd: number; state: PayoutState; reference: string; decision_reason: string }>();
}

// --------------------------------------------------------------- adjustment

export type AdjustResult =
  | { ok: true; replayed: boolean; entryId: string }
  | { ok: false; reason: 'INVALID_AMOUNT' | 'INSUFFICIENT_BALANCE' | 'IDEMPOTENCY_KEY_REUSED'; availableIqd?: number };

/**
 * A FINANCIAL ADMIN CORRECTS A MERCHANT'S AVAILABLE BALANCE, with a reason on
 * the line and an audit row in the same batch. A negative adjustment can
 * never take «available» below zero (the overdraw trigger refuses it).
 */
export async function adjustMerchantBalance(
  db: D1Database,
  p: { merchantId: string; amountIqd: number; reason: string; adminId: string; key: string; ts?: string }
): Promise<AdjustResult> {
  if (!(Number.isSafeInteger(p.amountIqd) && p.amountIqd !== 0 && Math.abs(p.amountIqd) <= 1_000_000_000)) {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  const eventKey = `adjust:${p.merchantId}:${p.key}`;
  const prior = async (): Promise<AdjustResult | null> => {
    const row = await db
      .prepare('SELECT id, merchant_id, amount_iqd FROM merchant_ledger_entries WHERE event_key = ?')
      .bind(eventKey)
      .first<{ id: string; merchant_id: string; amount_iqd: number }>();
    if (!row) return null;
    return row.merchant_id === p.merchantId && Number(row.amount_iqd) === p.amountIqd
      ? { ok: true, replayed: true, entryId: row.id }
      : { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
  };
  const before = await prior();
  if (before) return before;
  const id = newId('mle');
  const ts = p.ts ?? NOW();
  const reason = p.reason.trim().slice(0, 300);
  const { statements: auditStmts } = await auditStatements(db, p.adminId, 'admin.merchant_adjustment', p.merchantId, {
    entry_id: id,
    amount_iqd: p.amountIqd,
    reason,
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, kind, bucket, amount_iqd, event_key, note, created_by, created_at)
           VALUES (?1, ?2, (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = ?2), 'adjustment', 'available', ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(id, p.merchantId, p.amountIqd, eventKey, reason, p.adminId, ts),
      ...auditStmts,
    ]);
  } catch (e) {
    if (isOverdraw(e)) {
      return { ok: false, reason: 'INSUFFICIENT_BALANCE', availableIqd: (await merchantBuckets(db, p.merchantId)).available };
    }
    const again = await prior();
    if (again) return again;
    throw e;
  }
  return { ok: true, replayed: false, entryId: id };
}

// ------------------------------------------------------------------ reads

export interface FinanceSummary {
  /** Sales credited: store goods + custom orders released from escrow. */
  gross: number;
  store_gross: number;
  custom_gross: number;
  /** The platform's commission taken, net of commission given back on refunds. */
  commission: number;
  delivery_fees: number;
  /** Money returned to customers out of credited sales (goods + delivery). */
  refunds: number;
  adjustments: number;
  /** The merchant's total entitlement: every line summed (= the four buckets). */
  receivable: number;
  pending: number;
  /** The part of pending an open complaint or ticket is holding. */
  pending_frozen: number;
  available: number;
  reserved: number;
  paid_out: number;
  /** Custom-order money held in escrow for this merchant (their share). */
  escrow_held: number;
  /** Payout requests waiting for Levonis. */
  open_payouts: number;
}

/**
 * THE FINANCE PAGE'S FIGURES — every one a SUM over the ledger, except
 * `escrow_held`, which is money not yet the merchant's and is read from the
 * escrows themselves. Identity (tests pin it):
 *   receivable = gross − commission + delivery_fees − refunds + adjustments
 *              = pending + available + reserved + paid_out.
 */
export async function financeSummary(db: D1Database, merchantId: string): Promise<FinanceSummary> {
  const [kinds, frozen, escrow, open] = await Promise.all([
    db
      .prepare(
        `SELECT kind, bucket, COALESCE(SUM(amount_iqd), 0) AS total
           FROM merchant_ledger_entries WHERE merchant_id = ? GROUP BY kind, bucket`
      )
      .bind(merchantId)
      .all<{ kind: LedgerKind; bucket: LedgerBucket; total: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(l.amount_iqd), 0) AS total
           FROM merchant_ledger_entries l
           JOIN orders o ON o.id = l.order_id
          WHERE l.merchant_id = ?1 AND l.bucket = 'pending'
            AND (EXISTS (SELECT 1 FROM community_complaints cc
                          WHERE cc.order_id = o.id AND cc.status NOT IN ('resolved','rejected','closed'))
                 OR EXISTS (SELECT 1 FROM support_tickets st WHERE st.order_id = o.id AND st.state <> 'resolved'))`
      )
      .bind(merchantId)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(merchant_receivable_iqd), 0) AS total
           FROM community_escrows WHERE merchant_id = ? AND state IN ('held','disputed')`
      )
      .bind(merchantId)
      .first<{ total: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM merchant_payouts WHERE merchant_id = ? AND state IN ('requested','approved')`)
      .bind(merchantId)
      .first<{ n: number }>(),
  ]);
  const byKind = new Map<string, number>();
  const byBucket = new Map<string, number>();
  for (const r of kinds.results ?? []) {
    const t = Number(r.total) || 0;
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + t);
    byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + t);
  }
  const k = (name: LedgerKind) => byKind.get(name) ?? 0;
  const b = (name: LedgerBucket) => byBucket.get(name) ?? 0;
  const storeGross = k('sale_gross');
  const customGross = k('escrow_release');
  return {
    gross: storeGross + customGross,
    store_gross: storeGross,
    custom_gross: customGross,
    commission: -k('commission') - k('commission_refund'),
    delivery_fees: k('delivery_fee'),
    refunds: -(k('refund') + k('delivery_refund')),
    adjustments: k('adjustment'),
    receivable: b('pending') + b('available') + b('reserved') + b('paid'),
    pending: b('pending'),
    pending_frozen: Math.max(0, Number(frozen?.total) || 0),
    available: b('available'),
    reserved: b('reserved'),
    paid_out: b('paid'),
    escrow_held: Number(escrow?.total) || 0,
    open_payouts: Number(open?.n) || 0,
  };
}

export interface LedgerEntryPublic {
  id: string;
  kind: LedgerKind;
  bucket: LedgerBucket;
  amount_iqd: number;
  note: string;
  created_at: string;
  /** What the line belongs to, for the finance page to open. */
  link: { type: 'order' | 'custom_order' | 'payout' | 'none'; id: string | null };
  legacy: boolean;
}

export interface LedgerQuery {
  cursor?: string;
  kind?: LedgerKind | '';
  from?: string;
  to?: string;
  limit?: number;
}

/** A (created_at, id) keyset cursor: `<created_at>|<id>`. */
export function parseCursor(raw: string | undefined): { at: string; id: string } {
  const v = (raw ?? '').slice(0, 200);
  const bar = v.lastIndexOf('|');
  return bar === -1 ? { at: '', id: '' } : { at: v.slice(0, bar), id: v.slice(bar + 1) };
}

export function entryLink(r: { order_id?: string | null; community_order_id?: string | null; payout_id?: string | null }): LedgerEntryPublic['link'] {
  if (r.payout_id) return { type: 'payout', id: r.payout_id };
  if (r.order_id) return { type: 'order', id: r.order_id };
  if (r.community_order_id) return { type: 'custom_order', id: r.community_order_id };
  return { type: 'none', id: null };
}

/**
 * The merchant's lines, newest first, paged by (created_at, id); filtered by
 * kind and by an ISO date range (`from` inclusive, `to` exclusive).
 */
export async function ledgerPage(
  db: D1Database,
  merchantId: string,
  q: LedgerQuery
): Promise<{ entries: LedgerEntryPublic[]; next_cursor: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 50)));
  const c = parseCursor(q.cursor);
  const { results } = await db
    .prepare(
      `SELECT id, kind, bucket, amount_iqd, note, created_at, order_id, community_order_id, payout_id, legacy_id
         FROM merchant_ledger_entries
        WHERE merchant_id = ?1
          AND (?2 = '' OR kind = ?2)
          AND (?3 = '' OR created_at >= ?3)
          AND (?4 = '' OR created_at < ?4)
          AND (?5 = '' OR created_at < ?5 OR (created_at = ?5 AND id < ?6))
        ORDER BY created_at DESC, id DESC
        LIMIT ?7`
    )
    .bind(merchantId, q.kind ?? '', q.from ?? '', q.to ?? '', c.at, c.id, limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const entries = rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as LedgerKind,
    bucket: r.bucket as LedgerBucket,
    amount_iqd: Number(r.amount_iqd) || 0,
    note: String(r.note ?? ''),
    created_at: String(r.created_at),
    link: entryLink(r as { order_id: string | null; community_order_id: string | null; payout_id: string | null }),
    legacy: r.legacy_id !== null && r.legacy_id !== undefined,
  }));
  const last = rows[rows.length - 1];
  return { entries, next_cursor: rows.length === limit && last ? `${String(last.created_at)}|${String(last.id)}` : null };
}

/** One merchant's payouts, newest first, keyset-paged. */
export async function payoutsPage(
  db: D1Database,
  merchantId: string,
  q: { cursor?: string; limit?: number }
): Promise<{ payouts: ReturnType<typeof payoutPublic>[]; next_cursor: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 30)));
  const c = parseCursor(q.cursor);
  const { results } = await db
    .prepare(
      `SELECT * FROM merchant_payouts
        WHERE merchant_id = ?1 AND (?2 = '' OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
        ORDER BY created_at DESC, id DESC LIMIT ?4`
    )
    .bind(merchantId, c.at, c.id, limit)
    .all<PayoutRow>();
  const rows = results ?? [];
  const last = rows[rows.length - 1];
  return {
    payouts: rows.map(payoutPublic),
    next_cursor: rows.length === limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

/**
 * THE ADMIN QUEUE: payouts by state (`open` = requested + approved), oldest
 * open first so the longest wait is on top; each with its merchant, store and
 * that merchant's buckets — read in ONE query, not one per row.
 */
export async function adminPayoutQueue(
  db: D1Database,
  q: { state?: PayoutState | 'open' | ''; cursor?: string; limit?: number }
) {
  const limit = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 50)));
  const state = q.state || 'open';
  const states = state === 'open' ? ['requested', 'approved'] : [state];
  const openFirst = state === 'open';
  const c = parseCursor(q.cursor);
  const keyset = openFirst
    ? `(?2 = '' OR p.created_at > ?2 OR (p.created_at = ?2 AND p.id > ?3))`
    : `(?2 = '' OR p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3))`;
  const { results } = await db
    .prepare(
      `SELECT p.*, m.name AS merchant_name, m.status AS merchant_status, s.name AS store_name, s.slug AS store_slug,
              ${bucketSumSql('p.merchant_id', 'available')} AS merchant_available,
              ${bucketSumSql('p.merchant_id', 'reserved')} AS merchant_reserved
         FROM merchant_payouts p
         JOIN community_merchants m ON m.id = p.merchant_id
         LEFT JOIN merchant_stores s ON s.merchant_id = p.merchant_id
        WHERE p.state IN (SELECT value FROM json_each(?1)) AND ${keyset}
        ORDER BY p.created_at ${openFirst ? 'ASC' : 'DESC'}, p.id ${openFirst ? 'ASC' : 'DESC'}
        LIMIT ?4`
    )
    .bind(JSON.stringify(states), c.at, c.id, limit)
    .all<PayoutRow & Record<string, unknown>>();
  const rows = results ?? [];
  const last = rows[rows.length - 1];
  return {
    payouts: rows.map((r) => ({
      ...payoutPublic(r),
      merchant: {
        id: r.merchant_id,
        name: String(r.merchant_name ?? ''),
        status: String(r.merchant_status ?? ''),
        store_name: String(r.store_name ?? ''),
        store_slug: String(r.store_slug ?? ''),
        available_iqd: Number(r.merchant_available) || 0,
        reserved_iqd: Number(r.merchant_reserved) || 0,
        /** What the merchant owes the platform (0 when «available» ≥ 0): approve/paid refuse while > 0. */
        debt_iqd: Math.max(0, -(Number(r.merchant_available) || 0)),
      },
    })),
    next_cursor: rows.length === limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

/**
 * THE BACKFILL, RE-PROVED ON THE DATA (migration 0121): per merchant, the
 * wave-1 formulas over the old table beside the lines carried from it. Any
 * row in `mismatches` is a merchant whose carried balance differs — the list
 * is empty when the backfill was exact.
 */
export async function legacyParity(db: D1Database) {
  const { results } = await db
    .prepare(
      `WITH old AS (
         SELECT merchant_id,
                COALESCE(SUM(CASE WHEN state = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN state = 'available' OR kind = 'payout' THEN amount_iqd ELSE 0 END), 0) AS available,
                -COALESCE(SUM(CASE WHEN kind = 'payout' THEN amount_iqd ELSE 0 END), 0) AS paid
           FROM merchant_payout_ledger GROUP BY merchant_id
       ), carried AS (
         SELECT merchant_id,
                COALESCE(SUM(CASE WHEN bucket = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN bucket = 'available' THEN amount_iqd ELSE 0 END), 0) AS available,
                COALESCE(SUM(CASE WHEN bucket = 'reserved' THEN amount_iqd ELSE 0 END), 0) AS reserved,
                COALESCE(SUM(CASE WHEN bucket = 'paid' THEN amount_iqd ELSE 0 END), 0) AS paid
           FROM merchant_ledger_entries WHERE legacy_id IS NOT NULL GROUP BY merchant_id
       )
       SELECT o.merchant_id, o.pending AS old_pending, o.available AS old_available, o.paid AS old_paid,
              COALESCE(c.pending, 0) AS new_pending, COALESCE(c.available, 0) AS new_available,
              COALESCE(c.reserved, 0) AS new_reserved, COALESCE(c.paid, 0) AS new_paid
         FROM old o LEFT JOIN carried c ON c.merchant_id = o.merchant_id
        ORDER BY o.merchant_id`
    )
    .all<Record<string, number | string>>();
  const merchants = results ?? [];
  const mismatches = merchants.filter(
    (m) =>
      Number(m.old_pending) !== Number(m.new_pending) ||
      Number(m.old_available) !== Number(m.new_available) ||
      Number(m.old_paid) !== Number(m.new_paid) ||
      Number(m.new_reserved) !== 0
  );
  return { merchants: merchants.length, mismatches };
}
