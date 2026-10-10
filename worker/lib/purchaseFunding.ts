import { allocateExact, baghdadDay, dateValue, fence, journalPlan, periodOpen, whole } from './operations';
import { badRequest, conflict, notFound, str } from './http';
import { newId } from './crypto';
import { auditStatements } from './audit';
import { planInvestorSources, type InvestmentContract } from './investorFinance';
import { surplusReturnStatements } from './investorSurplus';
import { serverMessage } from '../../packages/contracts/src/costRefusals';

export interface InvestorProfile {user_id:string;state:string;default_profit_share_bps:number;default_capital_share_bps:number;default_loss_share_bps:number;version:number}
export async function eligibleInvestorProfile(db:D1Database,id:string){
  const profile=await db.prepare("SELECT p.* FROM investment_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND p.state='active' AND u.role='admin' AND u.admin_scope='assistant'").bind(id).first<InvestorProfile>();
  if(!profile)throw badRequest('اختر مستثمرًا نشطًا مرتبطًا بحساب مساعد مؤهل','INVESTOR_ACCOUNT_REQUIRED');return profile;
}
export type FundedPurchaseLine={incoming_id:string;total_iqd:number;label:string};
export function fundingDistribution(agreed:number,lines:FundedPurchaseLine[]){
  const cost=lines.reduce((n,l)=>n+l.total_iqd,0),allocated=Math.min(agreed,cost);
  return {cost,allocated,unallocated:agreed-allocated,store_contribution:Math.max(0,cost-agreed),shares:cost?allocateExact(allocated,lines.map(l=>l.total_iqd)):lines.map(()=>0)};
}
type FundingAllocation={contract:InvestmentContract;principal_iqd:number;funded_iqd:number};
/**
 * One receipt of the investor's cash. It fills the purchase's contracts first
 * (capacity = Σ principal); whatever no contract takes — the investment
 * remainder (agreed − landed cost) once the agreed amount has arrived, and any
 * cash above the agreed amount — is the investor's returned capital
 * (worker/lib/investorSurplus.ts): its audit row and the investor's notice
 * commit in this same batch, keyed by the receipt id, so a replay neither
 * credits nor notifies twice. Every receipt is audited (amounts only).
 */
async function fundingReceiptPlan(db:D1Database,purchaseId:string,investorId:string,allocations:FundingAllocation[],priorReceived:number,input:Record<string,unknown>,actor:string){
  const amount=whole(input.received_iqd??input.amount_iqd,'المبلغ المستلم',1),day=dateValue(input.received_day??input.payment_day,baghdadDay()),reference=str(input.reference,'مرجع استلام التمويل',{min:1,max:300});
  const operation=str(input.operation_id,'رقم استلام التمويل',{min:8,max:100}),request=JSON.stringify({purchase_id:purchaseId,amount_iqd:amount,payment_day:day,reference});
  const prior=await db.prepare('SELECT request_json FROM purchase_investor_receipts WHERE id=?').bind(operation).first<{request_json:string}>();
  if(prior){if(prior.request_json!==request)throw conflict('مرجع العملية مستخدم لاستلام تمويل مختلف');return {statements:[] as D1PreparedStatement[],already:true};}
  await periodOpen(db,day);
  const capacity=allocations.reduce((n,a)=>n+a.principal_iqd,0),funded=allocations.reduce((n,a)=>n+a.funded_iqd,0);
  const total=Math.min(capacity,funded+amount),newShares=capacity>funded?allocateExact(total-funded,allocations.map(a=>a.principal_iqd-a.funded_iqd)):allocations.map(()=>0);
  const targets=allocations.map((a,i)=>a.funded_iqd+newShares[i]);
  const now=new Date().toISOString(),statements:D1PreparedStatement[]=[
    ...fence(db,'(SELECT COALESCE(SUM(amount_iqd),0) FROM purchase_investor_receipts WHERE purchase_id=?)=?',[purchaseId,priorReceived]),
    db.prepare('INSERT INTO purchase_investor_receipts(id,purchase_id,amount_iqd,allocated_iqd,payment_day,reference,actor_id,created_at,request_json) VALUES (?,?,?,?,?,?,?,?,?)').bind(operation,purchaseId,amount,total-funded,day,reference,actor,now,request),
    ...journalPlan(db,{key:`purchase-investment:${operation}`,day,title:'استلام تمويل دفعة مخزون',source:'purchase_investment',sourceId:purchaseId,actor},[{account:'1000',debit:amount},{account:'3100',credit:amount}]).statements];
  // Never negative: the contracts take at most this receipt's amount.
  const returned=amount-(total-funded);
  statements.push(...(await auditStatements(db,actor,'purchase.investor_funding_received',purchaseId,{receipt_id:operation,amount_iqd:amount,allocated_iqd:total-funded})).statements,
    ...await surplusReturnStatements(db,{purchaseId,userId:investorId,receiptId:operation,amount:returned,actor}));
  for(const [i,a] of allocations.entries()){
    const delta=targets[i]-a.funded_iqd;if(delta<0)throw conflict('راجع التمويل السابق قبل إعادة توزيعه');
    // A previously unfunded contract can be voided while this receipt is being
    // prepared. Abort the whole receipt in that case: the retry excludes the
    // voided contract and returns its unallocated cash to the investor.
    statements.push(...fence(db,"EXISTS(SELECT 1 FROM investment_contracts WHERE id=? AND user_id=? AND state='active' AND version=? AND principal_iqd=?)",[a.contract.id,investorId,a.contract.version,a.principal_iqd]));
    statements.push(...fence(db,"(SELECT COALESCE(SUM(amount_iqd),0) FROM investor_finance_events WHERE contract_id=? AND kind='funding')=?",[a.contract.id,a.funded_iqd]));
    if(delta)statements.push(db.prepare("INSERT INTO investor_finance_events(id,event_key,contract_id,kind,amount_iqd,event_day,actor_id,snapshot,created_at) VALUES (?,?,?,'funding',?,?,?,?,?)").bind(newId('ive'),`purchase-funding:${operation}:${a.contract.id}`,a.contract.id,delta,day,actor,JSON.stringify({purchase_id:purchaseId,receipt_id:operation,reference,allocated_iqd:delta}),now));
    statements.push(...planInvestorSources(db,a.contract,day));
  }
  return {statements,already:false};
}

/** Header, purchase lines, contracts, actual cash and allocations all commit in
 * the caller's existing purchase transaction. Agreement alone books no cash.
 *
 * This is the confirm («تأكيد الشراء القادم» / «تأكيد وإضافة المخزون»): it fixes
 * the agreement, so the remainder that returns to the investor is fixed here,
 * from the final cost (an estimated one is refused, INVESTMENT_NEEDS_FINAL_COST),
 * and a purchase keeps the one agreement it was confirmed with
 * (INVESTMENT_AGREEMENT_EXISTS, never the database's own key as a 500). */
export async function planPurchaseFunding(db:D1Database,purchaseId:string,input:unknown,lines:FundedPurchaseLine[],actor:string,opts:{costState?:string}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))return [];
  const body=input as Record<string,unknown>;if(body.mode!=='investor')return [];
  if(opts.costState!=='final')throw conflict(serverMessage('INVESTMENT_NEEDS_FINAL_COST'),'INVESTMENT_NEEDS_FINAL_COST');
  if(await db.prepare('SELECT 1 FROM purchase_investor_agreements WHERE purchase_id=?').bind(purchaseId).first())throw conflict(serverMessage('INVESTMENT_AGREEMENT_EXISTS'),'INVESTMENT_AGREEMENT_EXISTS');
  const userId=str(body.user_id,'المستثمر',{min:1,max:100}),profile=await eligibleInvestorProfile(db,userId);
  const agreed=whole(body.agreed_iqd,'الاستثمار المتفق عليه',1),profit=whole(body.profit_share_bps??profile.default_profit_share_bps,'نسبة الربح',0,10000),loss=whole(body.loss_share_bps??profile.default_loss_share_bps,'نسبة الخسارة',0,10000);
  const selection=Array.isArray(body.incoming_indexes)?body.incoming_indexes.map(v=>whole(v,'البند',0,lines.length-1)):lines.map((_,i)=>i);
  if(!selection.length||new Set(selection).size!==selection.length)throw badRequest('اختر بنود التمويل دون تكرار');
  const included=selection.map(i=>lines[i]),distribution=fundingDistribution(agreed,included),now=new Date().toISOString();
  const allCost=lines.reduce((n,l)=>n+l.total_iqd,0);
  const statements=[...fence(db,"EXISTS(SELECT 1 FROM investment_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND p.version=? AND p.state='active' AND u.role='admin' AND u.admin_scope='assistant')",[userId,profile.version]),
    db.prepare('INSERT INTO purchase_investor_agreements(purchase_id,user_id,agreed_iqd,allocated_iqd,batch_cost_iqd,profit_share_bps,loss_share_bps,actor_id,created_at,request_json) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(purchaseId,userId,agreed,distribution.allocated,allCost,profit,loss,actor,now,JSON.stringify(body))];
  const allocations:FundingAllocation[]=[];
  for(const [i,line] of included.entries()){
    const principal=distribution.shares[i];if(!principal)continue;
    const capital=Math.max(1,Math.min(10000,Number(BigInt(principal)*10000n/BigInt(line.total_iqd))));
    const contract:InvestmentContract={id:newId('ic'),incoming_id:line.incoming_id,user_id:userId,name:line.label.slice(0,120),principal_iqd:principal,capital_share_bps:capital,profit_share_bps:profit,loss_share_bps:loss,version:1};
    statements.push(db.prepare('INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(contract.id,line.incoming_id,userId,contract.name,principal,capital,profit,loss,actor,now,JSON.stringify({...contract,purchase_id:purchaseId,overhead_policy:'owner_only'})),
      db.prepare('INSERT INTO purchase_investor_allocations(purchase_id,incoming_id,contract_id,principal_iqd) VALUES (?,?,?,?)').bind(purchaseId,line.incoming_id,contract.id,principal));
    allocations.push({contract,principal_iqd:principal,funded_iqd:0});
  }
  const received=body.received_iqd===undefined||body.received_iqd===''?0:whole(body.received_iqd,'المستلم فعليًا');
  if(received)statements.push(...(await fundingReceiptPlan(db,purchaseId,userId,allocations,0,{...body,operation_id:`receipt:${purchaseId}`,received_iqd:received},actor)).statements);
  else for(const a of allocations)statements.push(...planInvestorSources(db,a.contract,baghdadDay()));
  if(body.save_default===true){
    const after={...profile,default_profit_share_bps:profit,default_loss_share_bps:loss,version:profile.version+1};
    statements.push(db.prepare('UPDATE investment_profiles SET default_profit_share_bps=?,default_loss_share_bps=?,version=version+1,updated_at=? WHERE user_id=?').bind(profit,loss,now,userId),
      db.prepare('INSERT INTO investment_profile_history(user_id,version,snapshot,actor_id,recorded_at) VALUES (?,?,?,?,?)').bind(userId,after.version,JSON.stringify(after),actor,now));
  }
  return statements;
}

/** «تسجيل تمويل مستلم»: cash recorded after the confirm. A voided contract takes
 * no cash, so what it would have taken returns to the investor as well. */
export async function receivePurchaseFunding(db:D1Database,purchaseId:string,body:Record<string,unknown>,actor:string){
  const agreement=await db.prepare('SELECT * FROM purchase_investor_agreements WHERE purchase_id=?').bind(purchaseId).first<{user_id:string}>();if(!agreement)throw notFound('اتفاق تمويل الدفعة غير موجود');
  const contracts=(await db.prepare("SELECT c.* FROM purchase_investor_allocations a JOIN investment_contracts c ON c.id=a.contract_id WHERE a.purchase_id=? AND c.state='active' ORDER BY a.incoming_id").bind(purchaseId).all<InvestmentContract>()).results??[];
  const allocations:FundingAllocation[]=[];
  for(const c of contracts){const funded=await db.prepare("SELECT COALESCE(SUM(amount_iqd),0) AS n FROM investor_finance_events WHERE contract_id=? AND kind='funding'").bind(c.id).first<{n:number}>();allocations.push({contract:c,principal_iqd:c.principal_iqd,funded_iqd:funded?.n??0});}
  const prior=await db.prepare('SELECT COALESCE(SUM(amount_iqd),0) AS n FROM purchase_investor_receipts WHERE purchase_id=?').bind(purchaseId).first<{n:number}>();
  const plan=await fundingReceiptPlan(db,purchaseId,agreement.user_id,allocations,prior?.n??0,body,actor);
  if(plan.statements.length)try{await db.batch(plan.statements);}catch(e){if(/CHECK constraint|UNIQUE/.test(String(e)))throw conflict('تغير رصيد التمويل أثناء التسجيل؛ حدّث الصفحة');throw e;}
  return {already:plan.already};
}

export async function purchaseFundingSummary(db:D1Database,purchaseId:string){
  const agreement=await db.prepare(`SELECT a.*,u.name AS investor_name,
    (SELECT COALESCE(SUM(amount_iqd),0) FROM purchase_investor_receipts WHERE purchase_id=a.purchase_id) AS received_iqd,
    (SELECT COALESCE(SUM(allocated_iqd),0) FROM purchase_investor_receipts WHERE purchase_id=a.purchase_id) AS allocated_received_iqd
    FROM purchase_investor_agreements a JOIN users u ON u.id=a.user_id WHERE purchase_id=?`).bind(purchaseId).first<Record<string,unknown>>();
  if(!agreement)return null;
  const received=Number(agreement.received_iqd),allocated=Number(agreement.allocated_iqd),cost=Number(agreement.batch_cost_iqd),agreed=Number(agreement.agreed_iqd);
  // returned_iqd: received cash no contract took — already the investor's
  // returned capital in «أرباحي». return_total_iqd: what returns once all the
  // cash has arrived (the remainder agreed − allocated, or more when more cash
  // came). unallocated_iqd is kept for older screens (it equals returned_iqd).
  const returned=Math.max(0,received-Number(agreement.allocated_received_iqd)),returnTotal=Math.max(returned,Math.max(agreed,received)-allocated);
  return {...agreement,unallocated_iqd:returned,returned_iqd:returned,return_total_iqd:returnTotal,return_pending_iqd:Math.max(0,returnTotal-returned),agreed_unallocated_iqd:agreed-allocated,
    store_contribution_iqd:Math.max(0,cost-allocated),funding_shortfall_iqd:Math.max(0,allocated-received),
    allocations:(await db.prepare('SELECT a.*,c.profit_share_bps,c.capital_share_bps,c.loss_share_bps FROM purchase_investor_allocations a JOIN investment_contracts c ON c.id=a.contract_id WHERE a.purchase_id=? ORDER BY a.incoming_id').bind(purchaseId).all()).results??[],
    receipts:(await db.prepare('SELECT * FROM purchase_investor_receipts WHERE purchase_id=? ORDER BY payment_day,id').bind(purchaseId).all()).results??[]};
}
