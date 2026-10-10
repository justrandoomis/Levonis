import { calculateGoods, profitSourceFingerprint, type GoodsLine } from './orderProfit';
import { membershipDiscountAtLine } from './orderMembership';
import { fence, journalPlan, periodOpen } from './operations';
import { conflict } from './http';
import { serverMessage } from '../../packages/contracts/src/costRefusals';

type Row = Record<string, unknown>;
const accounts = ['1100', '2300', '4000', '4100'] as const;
// Classification is a journal fact, not the order's delivery status. A
// delivered order may still be waiting for its sale journal to be posted.
export const advanceCollectionsSql = `SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) FROM finance_collections c
  JOIN accounting_entries e ON e.event_key='collection:'||c.id AND e.state='posted'
  JOIN accounting_lines l ON l.entry_id=e.id AND l.account_code='2300' WHERE c.order_id=?`;

/** Correct only a native sale that exactly matches the former double-discount
 * calculation. Its original lines, cash collections and refunds stay intact.
 * The correction is a new balanced journal in the current open period. */
export async function correctMembershipSale(
  db: D1Database, orderId: string, day: string,
) {
  const source = await profitSourceFingerprint(db, orderId);
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first<Row>();
  if (!order || order.status !== 'delivered') return;
  const key = `membership-sale:${orderId}`;
  if (await db.prepare('SELECT 1 FROM accounting_entries WHERE event_key=?').bind(key).first()) return;
  const items = (await db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').bind(orderId).all<GoodsLine>()).results;
  if (!items.some(item => Number(item.membership_discount_iqd) > membershipDiscountAtLine(order, item))) return;
  const nativeSql = `SELECT l.account_code, SUM(l.debit_iqd-l.credit_iqd) amount
    FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE e.event_key=? AND e.state='posted' GROUP BY l.account_code ORDER BY l.account_code`;
  const native = (await db.prepare(nativeSql).bind(`sale:${orderId}`).all<{ account_code: string; amount: number }>()).results;
  if (!native.length) return;
  const prepaid = Number((await db.prepare(`SELECT (${advanceCollectionsSql}) value`).bind(orderId).first<{ value: number }>())?.value ?? 0);
  const amounts = (snapshot: Row) => {
    const goods = calculateGoods(snapshot, items, []);
    const revenue = goods.lines.reduce((sum, line) => sum + line.net_goods_iqd, 0);
    const shipping = Number(goods.order.shipping_iqd) + Number(goods.order.cod_tax_iqd);
    const total = revenue + shipping;
    const receivable = Math.max(0, Math.min(total, Number(order.due_on_delivery_iqd ?? 0) + Number(order.gini_paid_iqd ?? 0) - prepaid));
    return [receivable, total - receivable, -revenue, -shipping];
  };
  const recorded = accounts.map(account => native.find(line => line.account_code === account)?.amount ?? 0);
  const current = amounts(order);
  if (native.every(line => accounts.some(account => account === line.account_code)) && recorded.every((amount, i) => amount === current[i])) return;
  const legacy = amounts({ ...order, benefit_snapshot: null });
  if (native.some(line => !accounts.some(account => account === line.account_code)) || recorded.some((amount, i) => amount !== legacy[i]))
    throw conflict(serverMessage('MEMBERSHIP_SALE_REVIEW_REQUIRED'), 'MEMBERSHIP_SALE_REVIEW_REQUIRED');
  await periodOpen(db, day);
  const journal = journalPlan(db, { key, day, title: 'تصحيح تطبيق خصم العضوية في قيد البيع', source: 'order_membership', sourceId: orderId },
    accounts.map((account, i) => {
      const delta = current[i] - recorded[i];
      return { account, debit: Math.max(0, delta), credit: Math.max(0, -delta) };
    }));
  await db.batch([
    ...fence(db, `(${source.sql.replace(/\?1/g, '?2')})=?3 AND (${advanceCollectionsSql.replace(/\?/g, '?2')})=?4
      AND EXISTS(SELECT 1 FROM accounting_entries WHERE event_key='sale:'||?2 AND state='posted')
      AND NOT EXISTS(SELECT 1 FROM accounting_entries WHERE event_key=?5)`, [orderId, source.value, prepaid, key]),
    ...journal.statements,
  ]);
}
