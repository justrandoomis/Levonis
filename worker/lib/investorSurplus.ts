/**
 * THE INVESTMENT REMAINDER GOES BACK TO THE INVESTOR (owner request 2026-10-10:
 * «عند اضافة قيمه الاستثمار مثلا ١٣ مليون، وتكون قيمه شراء وتكاليف المنتجات اقل
 * … فان الباقي … تضاف وترجع لمحفظة المستثمر (نفسها محفظة الارباح للموظف) عند
 * تاكيد الشحنه»).
 *
 * The remainder is fixed when the purchase is confirmed: the agreement
 * (`purchase_investor_agreements`, immutable) records agreed and allocated
 * (allocated = min(agreed, landed cost of the funded lines)), so the remainder
 * is `agreed − allocated` (13,000,000 − 12,853,822 = 146,178) and can never
 * change afterwards: a funded purchase is frozen, a later lot-cost correction
 * never touches the agreement, and no correction edits a row here.
 *
 * WHAT THE INVESTOR CAN WITHDRAW IS CASH-BACKED. Every receipt of the
 * investor's cash (`purchase_investor_receipts`, immutable) fills the purchase's
 * contracts first and keeps the rest as `amount_iqd − allocated_iqd`. That rest
 * is exactly `max(0, received − Σ principal)`: the remainder once the agreed
 * amount has arrived, plus any cash above the agreed amount (which no contract
 * can take either). Money the store never received is never withdrawable.
 *
 * WHERE IT LIVES: the investor's own «أرباحي» (the same participant ledger an
 * employee's profits use), as RETURNED CAPITAL — kind `investor_capital`, id
 * `invsurplus:<purchase_id>`. The receipt booked Dr 1000 / Cr 3100 for every
 * dinar, and a capital payout debits 3100, so the books balance with no new
 * account, and staff debts or advances can never eat it (each ledger offsets
 * only its own earnings).
 *
 * NO STORED BALANCE, NO NEW TABLE. The source is derived from immutable rows,
 * so a replayed confirm, a double click or a replayed receipt cannot credit
 * twice: the receipt id is the idempotency key, the prior-receipt-sum fence
 * makes concurrent receipts serial, and the notice's event key is unique per
 * user. Old wallet, order and lot rows are never edited.
 *
 * ONE SQL FRAGMENT FEEDS BOTH READERS. `participantSources` (what the page and
 * a withdrawal see) and `sourceSetFence` (the snapshot a withdrawal commits
 * against) wrap the same `SURPLUS_ROWS_SQL` (financeParticipants.ts). If they
 * ever disagreed, every withdrawal of that investor would be refused.
 *
 * PRIVACY: the investor's notice and the audit row carry the returned amount
 * only — never the agreed amount, a cost, a supplier price or a margin.
 */
import { auditStatements } from './audit';
import { notifyStatement } from './notifications';

export const SURPLUS_PREFIX = 'invsurplus:';
export const SURPLUS_TABLES = ['purchase_investor_agreements', 'purchase_investor_receipts'] as const;

/** Both funding tables exist (migration 0168). Older databases have no surplus. */
export async function surplusInstalled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN (?,?)")
    .bind(...SURPLUS_TABLES)
    .first<{ n: number }>();
  return (row?.n ?? 0) === SURPLUS_TABLES.length;
}

/**
 * One row per funded purchase of the user (bound `?`) holding received cash
 * that no contract took. `version` is the purchase's receipt count, so any new
 * receipt moves a withdrawal's snapshot. The title is the purchase's name and
 * stays out of the fence (a rename never breaks a withdrawal).
 */
export const SURPLUS_ROWS_SQL = `SELECT '${SURPLUS_PREFIX}'||a.purchase_id AS id,'investor_capital' AS kind,
    COALESCE(NULLIF(p.invoice_no,''),substr(a.purchase_id,-8)) AS title,NULL AS order_id,x.last_day AS day,
    x.surplus AS amount_iqd,x.surplus AS accrued_iqd,x.receipts AS version,'available' AS state
  FROM purchase_investor_agreements a
  JOIN purchase_orders p ON p.id=a.purchase_id
  JOIN (SELECT purchase_id,SUM(amount_iqd-allocated_iqd) AS surplus,COUNT(*) AS receipts,MAX(payment_day) AS last_day
          FROM purchase_investor_receipts GROUP BY purchase_id) x ON x.purchase_id=a.purchase_id
  WHERE a.user_id=? AND x.surplus>0`;

/** The remainder still waiting for the investor's cash: Σ max(0, agreed − max(received, allocated)). */
export const PENDING_SURPLUS_SQL = `SELECT COALESCE(SUM(MAX(0,a.agreed_iqd-MAX(a.allocated_iqd,
    COALESCE((SELECT SUM(r.amount_iqd) FROM purchase_investor_receipts r WHERE r.purchase_id=a.purchase_id),0)))),0) AS n
  FROM purchase_investor_agreements a WHERE a.user_id=?`;

/** Received cash no contract took, per user (the returned surplus, paid or not). */
export const RETURNED_SURPLUS_SQL = `SELECT COALESCE(SUM(r.amount_iqd-r.allocated_iqd),0) AS n
  FROM purchase_investor_receipts r JOIN purchase_investor_agreements a ON a.purchase_id=r.purchase_id WHERE a.user_id=?`;

export const SURPLUS_STRINGS = {
  title: {
    ar: 'أُعيد فائض تمويل الشحنة إليك',
    en: 'Shipment funding surplus returned to you',
    ckb: 'زیادەی پارەدارکردنی بار بۆت گەڕێندرایەوە',
  },
  body: (shown: string) => ({
    ar: `${shown} د.ع متاحة للسحب في «أرباحي» كرأس مال مسترد`,
    en: `${shown} IQD is available to withdraw in My earnings as returned capital`,
    ckb: `${shown} د.ع لە «قازانجەکانم» وەک سەرمایەی گەڕاوە بەردەستە بۆ ڕاکێشان`,
  }),
} as const;

/**
 * The audit row and the investor's notice for one receipt's returned cash, to
 * commit in the receipt's own batch (the confirm batch, or «تسجيل تمويل مستلم»).
 * Nothing when the receipt returns nothing. The event key is the receipt id, so
 * a replay cannot notify twice.
 */
export async function surplusReturnStatements(
  db: D1Database,
  input: { purchaseId: string; userId: string; receiptId: string; amount: number; actor: string },
): Promise<D1PreparedStatement[]> {
  if (!(input.amount > 0)) return [];
  const shown = input.amount.toLocaleString('en-US');
  const body = SURPLUS_STRINGS.body(shown);
  return [
    ...(await auditStatements(db, input.actor, 'investment.surplus_returned', input.purchaseId, {
      receipt_id: input.receiptId,
      user_id: input.userId,
      amount_iqd: input.amount,
    })).statements,
    notifyStatement(db, {
      userId: input.userId,
      kind: 'payout_available',
      title_ar: SURPLUS_STRINGS.title.ar,
      title_en: SURPLUS_STRINGS.title.en,
      body_ar: body.ar,
      body_en: body.en,
      meta: { title_ckb: SURPLUS_STRINGS.title.ckb, body_ckb: body.ckb },
      link: '/earnings',
      eventKey: `investor-surplus:${input.receiptId}`,
    }).stmt,
  ];
}
