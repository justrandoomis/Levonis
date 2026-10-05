import { investmentLegacy } from '../lib/investmentLegacy';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, requireAuth, requireMainHost, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { whole } from '../lib/operations';
import { changeWithdrawalState, participantOverview, requestWithdrawal } from '../lib/financeParticipants';

export const financeEarningsRoutes = new Hono<AppContext>();
financeEarningsRoutes.use('*', requireMainHost, requireAuth);
financeEarningsRoutes.get('/eligibility',async(c)=>{
  const db=c.env.DB,id=c.get('user')!.id;
  const staff=await db.prepare('SELECT 1 FROM finance_staff WHERE user_id=? LIMIT 1').bind(id).first();
  const installed=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_contracts'").first();
  const profiles=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_profiles'").first();
  const registered=profiles?await db.prepare("SELECT 1 FROM investment_profiles WHERE user_id=?").bind(id).first():null;
  const investor=registered||(installed?await db.prepare('SELECT 1 FROM investment_contracts WHERE user_id=? LIMIT 1').bind(id).first():null);
  return c.json({success:true,eligible:!!staff||!!investor,staff:!!staff,investor:!!investor});
});
financeEarningsRoutes.get('/legacy',async c=>c.json({success:true,...await investmentLegacy(c.env.DB,c.get('user')!.id)}));
financeEarningsRoutes.get('/', async (c) => c.json({ success:true,...await participantOverview(c.env.DB,c.get('user')!.id) }));
financeEarningsRoutes.post('/withdrawals', async (c) => {
  await rateLimit(c,'finance-earnings-withdrawal',10,3600);
  const b=await c.req.json<Record<string,unknown>>();
  const type=b.balance_type??'earnings';
  if(type!=='earnings'&&type!=='capital'&&type!=='all')throw badRequest('اختر أرباحًا أو رأس مال مستردًا');
  return c.json({success:true,...await requestWithdrawal(c.env,c.get('user')!.id,
    str(b.operation_id,'رقم العملية',{min:8,max:80}),whole(b.amount_iqd,'مبلغ السحب',1),type)});
});
financeEarningsRoutes.post('/withdrawals/:id/cancel',async(c)=>{
  await rateLimit(c,'finance-earnings-cancel',30,3600);
  return c.json({success:true,...await changeWithdrawalState(c.env.DB,c.req.param('id'),c.get('user')!.id,'cancel',c.get('user')!.id)});
});
