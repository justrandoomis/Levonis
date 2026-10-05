import LegacyInvestmentHistory from './LegacyInvestmentHistory';
import { useRef, useState } from 'react';
import { ArrowDownToLine, RefreshCw, Wallet } from 'lucide-react';
import { NumberInput } from '../ui/NumberInput';
import { useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { api, Button, dateLabel, Dialog, EARNINGS, Empty, Feedback, Field, Loading, Money, StateBadge, Surface, useLanguage, useMutation, useRemote, type Withdrawal } from './shared';

type Entry = { id: string; kind: 'staff' | 'investor_profit' | 'investor_capital'; title: string; order_id?: string; day: string; amount_iqd: number; accrued_iqd?: number; paid_iqd: number; held_iqd: number; available_iqd: number; state: string };
export type EarningsData = {
  summary: { earnings_pending_iqd?: number; net_balance_iqd?: number; staff_debt_iqd?: number; investor_profit_debt_iqd?: number; earned_iqd: number; available_iqd: number; held_iqd: number; paid_iqd: number; pending_iqd: number; staff_iqd: number; investor_profit_iqd: number; capital_iqd: number; earnings_paid_iqd?: number; earnings_held_iqd?: number; earnings_available_iqd?: number; capital_available_iqd?: number; pending_costs?: number; debt_iqd?: number; advance_balance_iqd?: number; reconciliation_pending?: boolean };
  entries: Entry[]; withdrawals: Withdrawal[];
  movements?: { id: string; account: string; kind: string; day: string; earning_day: string | null; amount_iqd: number; reason: string; balance_iqd: number; debt_covered_iqd: number }[];
  history_review_count?: number;
  investment?: {unallocated_iqd:number;batches:{id:string;name:string;state:string;principal_iqd:number;received_iqd:number;qty_received:number;delivered_qty:number;remaining_qty:number;earned_iqd:number;available_iqd:number;paid_iqd:number;recovered_capital_iqd:number;capital_paid_iqd:number}[]};
  employment?: { start_work_date: string | null; first_earning_day: string | null; active: number; archived: number; has_rules: number; reconciliation_state: string | null; processed_orders: number }[];
};

export default function MyEarnings() {
  const { loc, lang, dir } = useLanguage();
  const remote = useRemote<EarningsData>(EARNINGS), op = useMutation();
  const [open, setOpen] = useState(false), [amount, setAmount] = useState<number | null>(null), [balanceType, setBalanceType] = useState<'earnings' | 'capital'>('earnings');
  const operationId = useRef('');
  const data = remote.data, s = data?.summary;
  const calculating = data?.employment?.some((e) => ['pending', 'running'].includes(e.reconciliation_state ?? '')) ?? false;
  // The owner can change the start date from another device after this screen
  // was opened. Keep checking even when the last read had no pending job.
  // The shared hook pauses hidden tabs, deduplicates wake events and recovers
  // on browser-history restoration. Keep the withdrawal form stable mid-edit.
  useFreshOnReturn(remote.load, {
    pollWhileVisibleMs: calculating ? 15_000 : 30_000,
    minIntervalMs: 5_000,
    enabled: !remote.loading && !open && !op.busy,
  });
  const balance = (type: 'earnings' | 'capital') => type === 'capital' ? s?.capital_available_iqd ?? 0 : s?.earnings_available_iqd ?? s?.available_iqd ?? 0;
  const startWithdrawal = (type: 'earnings' | 'capital' = 'earnings') => { setBalanceType(type); operationId.current = crypto.randomUUID(); setAmount(balance(type)); op.clear(); setOpen(true); };
  const request = () => op.run(async () => {
    await api.post(`${EARNINGS}/withdrawals`, { operation_id: operationId.current, amount_iqd: amount, balance_type: balanceType });
    setOpen(false); await remote.load();
  }, loc('تم إرسال طلب السحب وحجز المبلغ. سيظهر التسديد بعد تسوية الإدارة.', 'Withdrawal requested and funds reserved. Payment appears after settlement.'));
  return <div className="ap fp fp-stack" dir={dir}>
    <header className="fp-heading"><div><h2>{loc('أرباحي', 'My earnings')}</h2><p>{loc('مستحقاتك من العمل والاستثمار، في مكان واحد.', 'Your work and investment earnings, together.')}</p></div><Button variant="ghost" aria-label={loc('تحديث الأرباح', 'Refresh earnings')} icon={<RefreshCw size={17} />} onClick={remote.load} loading={remote.loading} /></header>
    <Feedback error={op.error} notice={op.notice} />
    {!data ? <Loading error={remote.error} retry={remote.load} /> : <>
      <Feedback error={remote.error} />
      <section className="fp-hero"><div><p className="flex items-center gap-2"><Wallet size={17} aria-hidden="true" />{(s.net_balance_iqd ?? 0) < 0 ? loc('عليك', 'You owe') : loc('لك', 'Your balance')}</p><Money value={Math.abs(s.net_balance_iqd ?? balance('earnings'))} className={(s.net_balance_iqd ?? 0) < 0 ? 'fp-negative' : ''} /><p className="text-xs mt-1">{loc('رصيد الأرباح التراكمي بعد التسديد والسلف', 'Cumulative earnings after payments and advances')}</p></div><Button variant="primary" icon={<ArrowDownToLine size={17} />} disabled={balance('earnings') <= 0} onClick={() => startWithdrawal('earnings')}>{loc('طلب سحب الأرباح', 'Request withdrawal')}</Button></section>
      <div className="fp-stats">
        <div className="fp-stat"><span>{loc('متاح للسحب', 'Available to withdraw')}</span><Money value={balance('earnings')} /></div>
        <div className="fp-stat"><span>{loc('قيد الاستحقاق', 'Pending')}</span><Money value={s.earnings_pending_iqd ?? 0} /></div>
        <div className="fp-stat"><span>{loc('محجوز للسحب', 'Reserved')}</span><Money value={s.earnings_held_iqd ?? s.held_iqd} /></div>
        <div className="fp-stat"><span>{loc('تم تسديده', 'Paid')}</span><Money value={s.earnings_paid_iqd ?? s.paid_iqd} /></div>
      </div>
      {data.employment?.filter((e) => !e.archived && (e.first_earning_day || !e.active || !e.has_rules || (e.reconciliation_state && e.reconciliation_state !== 'complete'))).map((employment, index) => <div className="fp-note" key={index} role="status">
        {employment.first_earning_day && <p>{loc('تُحتسب أجورك على الطلبات المسلّمة من ', 'Delivery earnings start on ')}<strong>{dateLabel(employment.first_earning_day, lang)}</strong>{loc(' بتوقيت بغداد، ضمن الأقسام والمنتجات المحددة لك.', ' in Baghdad time, for your assigned categories and products.')}</p>}
        {!employment.active ? <p>{loc('احتساب الأجور الجديدة متوقف حاليًا. مستحقاتك السابقة محفوظة.', 'New work earnings are paused. Your past earnings are preserved.')}</p>
          : !employment.has_rules ? <p>{loc('لم تُحدّد قاعدة أجرك بعد. تحتاج الإدارة إلى تحديد الأجر والأقسام المشمولة.', 'Your pay rule has not been set up yet. The administrator needs to choose your pay and eligible products.')}</p>
          : ['pending', 'running'].includes(employment.reconciliation_state ?? '') ? <p>{loc(`جارٍ حساب مستحقاتك السابقة؛ تمت مراجعة ${employment.processed_orders} طلب. تتحدث الأرباح تلقائيًا عند الاكتمال.`, `Calculating past earnings; ${employment.processed_orders} orders reviewed. Your balance refreshes automatically when complete.`)}</p>
          : employment.reconciliation_state === 'failed' ? <p>{loc('تحتاج إعادة حساب المستحقات إلى متابعة من الإدارة. تاريخ بدايتك محفوظ.', 'The administrator needs to resume your earnings calculation. Your start date is saved.')}</p>
          : employment.first_earning_day && employment.reconciliation_state === 'complete' && employment.processed_orders === 0 && !s.staff_iqd ? <p>{loc('لم يجد آخر احتساب طلبات مسلّمة بعد تاريخ بدء عملك. يظهر الأجر عند تسليم طلب مشمول.', 'The last calculation found no deliveries after your work start date. Earnings appear when an eligible order is delivered.')}</p> : null}
      </div>)}
      {!!s.reconciliation_pending && !calculating && <p className="fp-note">{loc('بعض المستحقات تنتظر إكمال تسويتها المالية؛ الرصيد المتاح أعلاه قابل لطلب السحب.', 'Some earnings await reconciliation. The available balance above can be requested for withdrawal.')}</p>}
      {!!s.advance_balance_iqd && <p className="fp-note">{loc('حُسمت السلف غير المسواة من المبلغ المتاح: ', 'Unsettled advances deducted from available earnings: ')}<Money value={s.advance_balance_iqd} /></p>}
      {!!s.pending_costs && <p className="fp-note">{loc(`يوجد ${s.pending_costs} استحقاق بانتظار تثبيت التكلفة؛ لم يدخل في المجموع بعد.`, `${s.pending_costs} earnings await final costs and are not included in the total yet.`)}</p>}
      {!!s.debt_iqd && <p className="fp-note">{loc('الدين المتبقي الآن: ', 'Remaining debt now: ')}<Money value={s.debt_iqd} /> · {loc('ينخفض تلقائيًا من الأرباح الجديدة في الحساب نفسه، دون خصم إضافي أو مساس برأس المال.', 'Covered by future earnings in the same account, without another deduction or use of investment principal.')}</p>}
      <Surface title={loc('مصادر مستحقاتك', 'Your earnings sources')}><div className="fp-rows">
        <div className="fp-row"><span>{loc('أجور العمل', 'Work earnings')}</span><Money value={s.staff_iqd} /></div>
        <div className="fp-row"><span>{loc('أرباح الاستثمار', 'Investment profits')}</span><Money value={s.investor_profit_iqd} /></div>
        <div className="fp-row"><span>{loc('رأس المال المسترد', 'Recovered capital')}</span><Money value={s.capital_iqd} /></div>{balance('capital') > 0 && <div className="fp-row"><div><span>{loc('رأس المال المتاح للسحب', 'Capital available to withdraw')}</span><p className="fp-row-meta"><Money value={balance('capital')} /></p></div><Button size="sm" onClick={() => startWithdrawal('capital')}>{loc('سحب رأس المال', 'Withdraw capital')}</Button></div>}
      </div></Surface>
      {!!data.investment?.batches.length && <Surface title={loc('دفعات استثماري', 'My investment batches')} hint={loc('رأس المال مستقل عن الأرباح. الإتاحة تتطلب التسليم والتحصيل وتثبيت التكلفة والتمويل.', 'Principal is separate from profit. Availability requires delivery, collection, verified costs and funding.')}>
        {data.investment.unallocated_iqd>0 && <p className="fp-note">{loc('تمويل مستلم غير مخصص', 'Received funding not allocated')}: <Money value={data.investment.unallocated_iqd}/></p>}
        <div className="fp-stack">{data.investment.batches.map(b=><details className="fp-rule" key={b.id}><summary><strong>{b.name}</strong><p className="fp-muted">{({settlement:loc('بانتظار تثبيت التكلفة أو إكمال التسوية','Awaiting verified costs or settlement'),funding:loc('بانتظار إكمال التمويل','Awaiting funding'),incoming:loc('بانتظار وصول المخزون','Awaiting inventory'),delivery:loc('بانتظار البيع والتسليم','Awaiting sale and delivery'),collection:loc('تم التسليم وبانتظار التحصيل','Delivered, awaiting collection'),available:loc('متاح للسحب','Available to withdraw'),reserved:loc('محجوز للسحب','Reserved for withdrawal'),paid:loc('تم سحب الأرباح المستحقة','Accrued profit paid')} as Record<string,string>)[b.state]}</p></summary><div className="fp-stats">{[[loc('رأس المال المتفق / المستلم','Agreed / received principal'),b.principal_iqd,b.received_iqd],[loc('أرباح مستحقة / متاحة','Accrued / available profit'),b.earned_iqd,b.available_iqd],[loc('رأس مال مسترد / مسحوب','Recovered / paid principal'),b.recovered_capital_iqd,b.capital_paid_iqd]].map(([title,n,k])=><div className="fp-stat" key={String(title)}><span>{title}</span><Money value={Number(n)}/><Money value={Number(k)}/></div>)}</div><p className="fp-muted">{loc('مستلم / مباع مسلّم / متبقٍ','Received / sold and delivered / remaining')}: {b.qty_received} / {b.delivered_qty} / {b.remaining_qty}</p></details>)}</div>
      </Surface>}
      <Surface title={loc('سجل الحركات', 'Account activity')} hint={loc('استحقاقات وتسويات ومدفوعات، مع الرصيد الناتج في حساب الأجور أو الاستثمار.', 'Earnings, adjustments and payments, with the running wage or investment balance.')}>
        {!data.movements?.length ? <Empty>{loc('تظهر الحركات بعد أول استحقاق.', 'Activity appears after your first earning.')}</Empty> : <div className="fp-rows">{data.movements.map(m => <div className="fp-row" key={m.id}><div><strong>{m.kind === 'adjustment' ? loc('تسوية', 'Adjustment') : m.kind === 'payment' ? loc('تسديد', 'Payment') : m.kind === 'advance' ? loc('سلفة', 'Advance') : loc('استحقاق', 'Earning')}</strong><p className="fp-row-meta">{m.account === 'staff' ? loc('أجور العمل', 'Work earnings') : loc('أرباح الاستثمار', 'Investment profit')} · {dateLabel(m.day, lang)}</p><p className="fp-row-meta">{m.reason}</p>{m.debt_covered_iqd > 0 && <p className="fp-row-meta">{loc('منها تغطية دين: ', 'Includes debt coverage: ')}<Money value={m.debt_covered_iqd} /></p>}</div><div className="text-end"><Money value={m.amount_iqd} className={m.amount_iqd < 0 ? 'fp-negative' : 'fp-positive'} /><span className="fp-movement-balance">{loc('الرصيد: ', 'Balance: ')}<Money value={m.balance_iqd} /></span></div></div>)}</div>}
        {!!data.history_review_count && <p className="fp-note">{loc('بعض أدلة التسديد القديمة تحتاج مراجعة توزيعها؛ الأرصدة والمدفوعات الأصلية محفوظة.', 'Some historical payment allocations need review. Original balances and payments are preserved.')}</p>}
      </Surface>
      <Surface title={loc('طلبات السحب', 'Withdrawal requests')} hint={loc('طلب السحب يحجز الرصيد إلى أن تسدده الإدارة.', 'A withdrawal reserves your balance until the administrator pays it.')}>
        {!data.withdrawals.length ? <Empty>{loc('لا توجد طلبات سحب بعد.', 'No withdrawal requests yet.')}</Empty> : <div className="fp-rows">{data.withdrawals.map((w) => <div className="fp-row" key={w.id}><div className="min-w-0"><StateBadge state={w.state} /><div className="fp-row-meta">{dateLabel(w.created_at, lang)}</div>{w.reference && <div className="fp-row-meta">{loc('مرجع التسديد: ', 'Payment reference: ')}<bdi>{w.reference}</bdi></div>}{w.state === 'requested' && <Button size="sm" variant="ghost" loading={op.busy} onClick={() => op.run(async () => { await api.post(`${EARNINGS}/withdrawals/${encodeURIComponent(w.id)}/cancel`, {}); await remote.load(); }, loc('ألغي الطلب وأعيد المبلغ إلى المتاح.', 'Request cancelled and funds released.'))}>{loc('إلغاء الطلب', 'Cancel request')}</Button>}</div><div className="text-end"><Money value={w.amount_iqd} />{w.paid_iqd > 0 && w.state !== 'paid' && <p className="fp-row-meta">{loc('المسدد: ', 'Paid: ')}<Money value={w.paid_iqd} /></p>}</div></div>)}</div>}
      </Surface>
    </>}
    <Dialog open={open} onClose={() => setOpen(false)} title={balanceType === 'capital' ? loc('طلب سحب رأس المال المسترد', 'Withdraw recovered capital') : loc('طلب سحب الأرباح', 'Request withdrawal')} busy={op.busy}>
      <div className="fp-stack"><p className="fp-muted">{loc('اختر المبلغ. تُبلّغ الإدارة بطلبك ويُحجز من الرصيد المتاح لحين التسديد.', 'Choose an amount. Your administrator is notified and the balance is reserved until payment.')}</p><Field label={loc('مبلغ السحب', 'Withdrawal amount')}><NumberInput kind="money" min={1} max={balance(balanceType)} value={amount} onValueChange={(n, valid) => setAmount(valid ? n : null)} /></Field><div className="flex justify-between items-center gap-3"><span className="fp-muted">{loc('المتاح: ', 'Available: ')}<Money value={balance(balanceType)} /></span><Button size="sm" variant="ghost" onClick={() => setAmount(balance(balanceType))}>{loc('سحب الكل', 'Withdraw all')}</Button></div><Feedback error={op.error} /></div>
      <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => setOpen(false)}>{loc('رجوع', 'Back')}</Button><Button variant="primary" loading={op.busy} disabled={amount == null || amount <= 0 || amount > balance(balanceType)} onClick={request}>{loc('إرسال طلب السحب', 'Send withdrawal request')}</Button></footer>
    </Dialog>
  <LegacyInvestmentHistory /></div>;
}
export { MyEarnings };
