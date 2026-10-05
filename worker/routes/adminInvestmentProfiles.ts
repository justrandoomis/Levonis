import { investmentLegacy } from '../lib/investmentLegacy';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { isOwner } from '../lib/adminScope';
import { badRequest, conflict, forbidden, notFound, str } from '../lib/http';
import { auditStatements } from '../lib/audit';
import { fence, requireCapability, whole } from '../lib/operations';
import { financeRange, financeRangeArgs, inFinanceRangeSql } from '../lib/financeRange';
import { participantSources, participantSummary } from '../lib/financeParticipants';
import { purchaseFundingSummary, type InvestorProfile } from '../lib/purchaseFunding';

export const adminInvestmentProfilesRoutes=new Hono<AppContext>();
adminInvestmentProfilesRoutes.get('/profiles',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');const db=c.env.DB,range=financeRange(c.req.query());
  const profiles=(await db.prepare('SELECT p.*,u.name,u.email FROM investment_profiles p JOIN users u ON u.id=p.user_id ORDER BY p.state,u.name').all<InvestorProfile&{name:string;email:string}>()).results??[];
  const result=[];
  for(const profile of profiles){
    const sources=await participantSources(db,profile.user_id),balance=participantSummary(sources.filter(s=>s.kind!=='staff'));
    const capital=await db.prepare(`SELECT
      COALESCE((SELECT SUM(agreed_iqd) FROM purchase_investor_agreements WHERE user_id=?1),0)+COALESCE((SELECT SUM(principal_iqd) FROM investment_contracts c WHERE c.user_id=?1 AND c.state='active' AND NOT EXISTS(SELECT 1 FROM purchase_investor_allocations a WHERE a.contract_id=c.id)),0) AS agreed_iqd,
      COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e JOIN investment_contracts c ON c.id=e.contract_id WHERE c.user_id=?1 AND e.kind='funding'),0)+COALESCE((SELECT SUM(r.amount_iqd-r.allocated_iqd) FROM purchase_investor_receipts r JOIN purchase_investor_agreements a ON a.purchase_id=r.purchase_id WHERE a.user_id=?1),0) AS received_iqd,
      COALESCE((SELECT SUM(principal_iqd) FROM investment_contracts WHERE user_id=?1 AND state='active'),0) AS allocated_iqd,
      COALESCE((SELECT SUM(r.amount_iqd-r.allocated_iqd) FROM purchase_investor_receipts r JOIN purchase_investor_agreements a ON a.purchase_id=r.purchase_id WHERE a.user_id=?1),0) AS unallocated_iqd,
      COALESCE((SELECT SUM(l.amount_iqd) FROM investor_capital_losses l JOIN investment_contracts c ON c.id=l.contract_id WHERE c.user_id=?1),0) AS loss_iqd,
      COALESCE((SELECT SUM(MIN(c.principal_iqd*i.qty_received/i.qty_ordered,COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e WHERE e.contract_id=c.id AND e.kind='funding'),0))) FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id WHERE c.user_id=?1 AND c.state='active'),0) AS used_iqd,
      (SELECT COUNT(*) FROM investment_contracts WHERE user_id=?1 AND state='active') AS contracts_count`).bind(profile.user_id).first<{agreed_iqd:number;received_iqd:number;allocated_iqd:number;unallocated_iqd:number;loss_iqd:number;used_iqd:number;contracts_count:number}>();
    const period=(await db.prepare(`SELECT COALESCE(SUM(r.profit_iqd),0) AS earned_iqd,COALESCE(SUM(r.capital_iqd),0) AS recovered_capital_iqd FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id WHERE c.user_id=? AND o.status='delivered' AND ${inFinanceRangeSql("date(o.delivered_at,'+3 hours')")}`).bind(profile.user_id,...financeRangeArgs(range)).first())!;
    const adjustments=await db.prepare(`SELECT COALESCE(SUM(e.amount_iqd),0) AS adjustments_iqd FROM investor_finance_events e JOIN investment_contracts c ON c.id=e.contract_id WHERE c.user_id=? AND e.kind='profit_correction' AND ${inFinanceRangeSql('e.event_day')}`).bind(profile.user_id,...financeRangeArgs(range)).first();
    const paid=await db.prepare(`SELECT COALESCE(SUM(l.amount_iqd),0) AS paid_iqd FROM finance_withdrawal_payment_lines l JOIN finance_withdrawal_payments p ON p.id=l.payment_id JOIN finance_withdrawals w ON w.id=p.withdrawal_id WHERE w.user_id=? AND l.source_kind='investor_profit' AND ${inFinanceRangeSql('p.payment_day')}`).bind(profile.user_id,...financeRangeArgs(range)).first();
    result.push({...profile,capital:{...capital,recovered_iqd:balance.capital_iqd,paid_iqd:balance.capital_paid_iqd},balance,period:{...period,...adjustments,...paid}});
  }
  const accounts=(await db.prepare("SELECT id,name,email,role,admin_scope FROM users WHERE role='admin' AND admin_scope='assistant' ORDER BY name").all()).results??[];
  return c.json({success:true,profiles:result,accounts,range,totals:{agreed_iqd:result.reduce((n,p)=>n+(p.capital.agreed_iqd??0),0),received_iqd:result.reduce((n,p)=>n+(p.capital.received_iqd??0),0),available_profit_iqd:result.reduce((n,p)=>n+p.balance.available_earnings_iqd,0),period_profit_iqd:result.reduce((n,p)=>n+Number(p.period.earned_iqd??0),0)}});
});
adminInvestmentProfilesRoutes.post('/profiles',async c=>{
  const user=c.get('user')!;if(!isOwner(c.env,user))throw forbidden('إعداد المستثمرين للأدمن الرئيسي فقط');
  const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB,id=str(b.user_id,'حساب المستثمر',{min:1,max:100});
  const old=await db.prepare('SELECT * FROM investment_profiles WHERE user_id=?').bind(id).first<InvestorProfile>();
  if(!(old&&b.state==='archived')&&!await db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND admin_scope='assistant'").bind(id).first())throw badRequest('اختر حساب مساعد مؤهل');
  if(old&&whole(b.version,'إصدار الملف',1)!==old.version)throw conflict('تغير ملف المستثمر؛ حدّث القائمة');
  const profile={user_id:id,state:b.state==='archived'?'archived':'active',default_profit_share_bps:whole(b.default_profit_share_bps,'نسبة الربح',0,10000),default_capital_share_bps:whole(b.default_capital_share_bps??old?.default_capital_share_bps??10000,'نسبة رأس المال',1,10000),default_loss_share_bps:whole(b.default_loss_share_bps??old?.default_loss_share_bps??0,'نسبة الخسارة',0,10000),version:(old?.version??0)+1};
  const now=new Date().toISOString();
  const statements=[...fence(db,old?'EXISTS(SELECT 1 FROM investment_profiles WHERE user_id=? AND version=?)':'NOT EXISTS(SELECT 1 FROM investment_profiles WHERE user_id=?)',old?[id,old.version]:[id]),
    db.prepare('INSERT INTO investment_profiles(user_id,state,default_profit_share_bps,default_capital_share_bps,default_loss_share_bps,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,default_profit_share_bps=excluded.default_profit_share_bps,default_capital_share_bps=excluded.default_capital_share_bps,default_loss_share_bps=excluded.default_loss_share_bps,version=excluded.version,updated_at=excluded.updated_at').bind(...Object.values(profile),user.id,now,now),
    db.prepare('INSERT INTO investment_profile_history(user_id,version,snapshot,actor_id,recorded_at) VALUES (?,?,?,?,?)').bind(id,profile.version,JSON.stringify(profile),user.id,now),
    ...(await auditStatements(db,user.id,'investment.profile_updated',id,{before:old,after:profile,existing_contracts_unchanged:true})).statements];
  try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE/.test(String(e)))throw conflict('تغير الحساب أثناء الحفظ');throw e;}
  return c.json({success:true,profile});
});
adminInvestmentProfilesRoutes.get('/profiles/:id',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');const db=c.env.DB,id=c.req.param('id');
  const profile=await db.prepare('SELECT p.*,u.name,u.email FROM investment_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=?').bind(id).first();if(!profile)throw notFound('ملف المستثمر غير موجود');
  const agreements=(await db.prepare('SELECT purchase_id FROM purchase_investor_agreements WHERE user_id=? ORDER BY created_at DESC').bind(id).all<{purchase_id:string}>()).results??[];
  const contracts=(await db.prepare(`SELECT c.*,i.qty_ordered,i.qty_received,pl.label,pl.purchase_id,p.name_ar,p.name,
    (SELECT COALESCE(SUM(l.qty_remaining),0) FROM inventory_lots l WHERE l.incoming_id=i.id) AS remaining_qty,
    (SELECT COALESCE(SUM(json_extract(r.snapshot,'$.qty')),0) FROM investor_allocation_results r WHERE r.contract_id=c.id) AS delivered_qty
    FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id LEFT JOIN purchase_lines pl ON pl.incoming_id=i.id LEFT JOIN products p ON p.id=i.product_id WHERE c.user_id=? ORDER BY c.created_at DESC`).bind(id).all()).results??[];
  const history=(await db.prepare('SELECT * FROM investment_profile_history WHERE user_id=? ORDER BY version DESC').bind(id).all()).results??[];
  return c.json({success:true,profile,contracts,history,batches:await Promise.all(agreements.map(a=>purchaseFundingSummary(db,a.purchase_id)))});
});

adminInvestmentProfilesRoutes.get('/legacy',async c=>{await requireCapability(c.env,c.get('user')!,'accounting');return c.json({success:true,...await investmentLegacy(c.env.DB)});});
adminInvestmentProfilesRoutes.post('/legacy/:id/link',async c=>{
 const actor=c.get('user')!;if(!isOwner(c.env,actor))throw forbidden('مراجعة السجل التاريخي للأدمن الرئيسي فقط');
 const db=c.env.DB,id=c.req.param('id'),b=await c.req.json<Record<string,unknown>>(),evidence=str(b.evidence,'دليل المطابقة',{min:10,max:2000}),contractId=b.contract_id?str(b.contract_id,'الاتفاق',{min:1,max:100}):null;
 const legacy=await db.prepare('SELECT user_id FROM investments WHERE id=?').bind(id).first<{user_id:string}>();if(!legacy)throw notFound('السجل التاريخي غير موجود');
 if(contractId&&!await db.prepare('SELECT 1 FROM investment_contracts WHERE id=? AND user_id=?').bind(contractId,legacy.user_id).first())throw badRequest('الاتفاق يجب أن يخص الحساب نفسه؛ أبقِ الهوية غير المطابقة للمراجعة');
 const old=await db.prepare('SELECT * FROM investment_legacy_links WHERE legacy_investment_id=?').bind(id).first<{recorded_at:string}>(),now=new Date().toISOString();
 await db.batch([...fence(db,old?'EXISTS(SELECT 1 FROM investment_legacy_links WHERE legacy_investment_id=? AND recorded_at=?)':'NOT EXISTS(SELECT 1 FROM investment_legacy_links WHERE legacy_investment_id=?)',old?[id,old.recorded_at]:[id]),db.prepare('INSERT INTO investment_legacy_links(legacy_investment_id,contract_id,state,evidence,actor_id,recorded_at) VALUES (?,?,?,?,?,?) ON CONFLICT(legacy_investment_id) DO UPDATE SET contract_id=excluded.contract_id,state=excluded.state,evidence=excluded.evidence,actor_id=excluded.actor_id,recorded_at=excluded.recorded_at').bind(id,contractId,contractId?'linked':'historical',evidence,actor.id,now),...(await auditStatements(db,actor.id,'investment.legacy_reviewed',id,{before:old,contract_id:contractId,evidence,currency:'USD',unit:'cent',no_financial_posting:true})).statements]);
 return c.json({success:true,withdrawable:false});
});
