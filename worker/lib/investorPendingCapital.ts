import { newId } from './crypto';
import { fence, periodOpen } from './operations';

export type VerifiedCapitalAllocation = {
  allocation_id:string; lot_id:string; contract_id:string; contract_version:number; capital_iqd:number; qty:number; snapshot:string;
};

/** Record only proven principal while profit is unresolved. These rows remain
 * pending and ineligible; no profit or loss journal is invented. A later full
 * settlement compares against the already-recorded principal, so neither a
 * retry nor completing the missing cost can return that capital twice. */
export async function planPendingInvestorCapital(db:D1Database,orderId:string,allocations:VerifiedCapitalAllocation[],day:string,actor?:string) {
  const statements:D1PreparedStatement[]=[];
  let financialChange=false;
  for(const a of allocations) {
    const old=await db.prepare('SELECT * FROM investor_allocation_results WHERE allocation_id=? AND contract_id=?')
      .bind(a.allocation_id,a.contract_id).first<{profit_iqd:number;capital_iqd:number;loss_iqd:number;version:number;snapshot:string}>();
    const previous=old?JSON.parse(old.snapshot):{};
    if(old&&old.capital_iqd===a.capital_iqd&&previous.qty===a.qty)continue;
    const proof=JSON.parse(a.snapshot),version=(old?.version??0)+1;
    const snapshot=JSON.stringify({...previous,qty:a.qty,principal_iqd:a.capital_iqd,source_fingerprint:proof.source_fingerprint,
      capital_only_pending:old?previous.capital_only_pending===true:true,capital_proof:proof});
    statements.push(...fence(db,old
      ? 'EXISTS(SELECT 1 FROM investor_allocation_results WHERE allocation_id=? AND contract_id=? AND version=?)'
      : 'NOT EXISTS(SELECT 1 FROM investor_allocation_results WHERE allocation_id=? AND contract_id=?)',old?[a.allocation_id,a.contract_id,old.version]:[a.allocation_id,a.contract_id]),
      ...fence(db,"EXISTS(SELECT 1 FROM investment_contracts WHERE id=? AND version=? AND state='active')",[a.contract_id,a.contract_version]));
    const delta=a.capital_iqd-(old?.capital_iqd??0);
    if(delta) {
      financialChange=true;
      const kind=old?'capital_correction':'capital_recovered';
      statements.push(db.prepare(`INSERT INTO investor_finance_events(id,event_key,contract_id,kind,amount_iqd,event_day,order_id,allocation_id,lot_id,actor_id,snapshot,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(newId('ive'),`${a.contract_id}:${a.allocation_id}:${version}:${kind}`,a.contract_id,kind,delta,day,orderId,a.allocation_id,a.lot_id,actor??null,snapshot,new Date().toISOString()));
    }
    statements.push(db.prepare(`INSERT INTO investor_allocation_results(allocation_id,contract_id,profit_iqd,capital_iqd,loss_iqd,eligible,pending,snapshot,version)
      VALUES (?,?,?,?,?,0,1,?,?) ON CONFLICT(allocation_id,contract_id) DO UPDATE SET capital_iqd=excluded.capital_iqd,
      eligible=0,pending=1,snapshot=excluded.snapshot,version=excluded.version`)
      .bind(a.allocation_id,a.contract_id,old?.profit_iqd??0,a.capital_iqd,old?.loss_iqd??0,snapshot,version));
  }
  if(financialChange)await periodOpen(db,day);
  return statements;
}
