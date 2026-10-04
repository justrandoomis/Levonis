import { reconcileStaffOrderCosts } from './financeParticipants';
import { recognizeLateCosts, syncInvestorOrder } from './investorFinance';
import { recordFinancialFailure } from './financePostingErrors';
import { getOrderProfitBase, syncOrderWorkspaceAccounting } from './orderProfit';

/** A source mutation has already committed. Keep its financial projections
 * current, or retain a durable, operator-visible retry instead of losing it. */
export async function reconcileFinanceOrder(db:D1Database,orderId:string,opts:{actor?:string;day?:string}={}) {
  try {
    if(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lot_cost_adjustment_shares'").first())
      await recognizeLateCosts(db,orderId,opts.day,opts.actor);
    await reconcileStaffOrderCosts(db,orderId,opts);
    await syncOrderWorkspaceAccounting(db,orderId,opts);
    // A verified per-order cost is an accepted accounting basis even when the
    // original FIFO posting was incomplete. Clear only that old COGS warning
    // after the delivered sale and its accounting overlay have reconciled.
    const basis=await getOrderProfitBase(db,orderId);
    if(basis.order.status==='delivered' && basis.lines.length>0 && basis.lines.every((line)=>line.cogs_iqd!==null && ['fifo','manual_verified'].includes(line.cost_confidence)) &&
      await db.prepare("SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted'").bind(`sale:${orderId}`).first())
      await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`cogs:${orderId}`).run();
    await syncInvestorOrder(db,orderId,opts);
    await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`investor:${orderId}`).run();
    return {complete:true};
  }catch(e){
    await recordFinancialFailure(db,orderId,'investor',e);
    return {complete:false};
  }
}
