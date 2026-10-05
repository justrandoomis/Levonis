import { reconcileStaffOrderCosts } from './financeParticipants';
import { isConfirmedOrderCost } from './financeLedger';
import { recognizeLateCosts, syncInvestorOrder } from './investorFinance';
import { recordFinancialFailure } from './financePostingErrors';
import { getOrderProfitBase, syncOrderWorkspaceAccounting } from './orderProfit';
import { reconcileEmploymentCutoff } from './financeEmployment';

/** A source mutation has already committed. Keep its financial projections
 * current, or retain a durable, operator-visible retry instead of losing it. */
export async function reconcileFinanceOrder(db:D1Database,orderId:string,opts:{actor?:string;day?:string}={}) {
  try {
    if(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lot_cost_adjustment_shares'").first())
      await recognizeLateCosts(db,orderId,opts.day,opts.actor);
    await reconcileEmploymentCutoff(db,orderId,opts.actor,opts.day);
    await reconcileStaffOrderCosts(db,orderId,opts);
    await syncOrderWorkspaceAccounting(db,orderId,opts);
    // A known cost is not proof that its expense reached the journal. Staff
    // rechecks deliberately skip native sale/COGS posting. Only a posted COGS
    // entry, a reconciled manual overlay or a genuine zero can clear this error.
    const basis=await getOrderProfitBase(db,orderId);
    if(basis.order.status==='delivered' && basis.lines.length>0 && basis.lines.every((line)=>line.cogs_iqd!==null && isConfirmedOrderCost(line.cost_confidence)) &&
      await db.prepare("SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted'").bind(`sale:${orderId}`).first()) {
      const accounted=basis.lines.some(line=>line.cost_confidence==='manual_verified') || basis.totals.cogs_iqd===0 ||
        !!await db.prepare("SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted'").bind(`cogs:${orderId}`).first();
      if(accounted)await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`cogs:${orderId}`).run();
      else await db.prepare('UPDATE finance_posting_errors SET message=? WHERE event_key=?')
        .bind('تكلفة البضاعة مثبتة، لكن قيد مصروفها المحاسبي لم يُرحّل؛ أعد ترحيل مالية الطلب من تنبيهات المحاسبة.',`cogs:${orderId}`).run();
    }
    await syncInvestorOrder(db,orderId,opts);
    await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`investor:${orderId}`).run();
    return {complete:true};
  }catch(e){
    await recordFinancialFailure(db,orderId,'investor',e);
    return {complete:false};
  }
}
