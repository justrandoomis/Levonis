import { useRef, useState } from 'react';
import { ArrowDownToLine, CircleDollarSign, RefreshCw, Wallet } from 'lucide-react';
import { NumberInput } from '../ui/NumberInput';
import { api, Button, dateLabel, Dialog, EARNINGS, Empty, Feedback, Field, Loading, Money, StateBadge, Surface, useLanguage, useMutation, useRemote, type Withdrawal } from './shared';

type Entry = { id: string; kind: 'staff' | 'investor_profit' | 'investor_capital'; title: string; order_id?: string; day: string; amount_iqd: number; accrued_iqd?: number; paid_iqd: number; held_iqd: number; available_iqd: number; state: string };
export type EarningsData = {
  summary: { earned_iqd: number; available_iqd: number; held_iqd: number; paid_iqd: number; pending_iqd: number; staff_iqd: number; investor_profit_iqd: number; capital_iqd: number; earnings_paid_iqd?: number; earnings_held_iqd?: number; earnings_available_iqd?: number; capital_available_iqd?: number; pending_costs?: number; debt_iqd?: number; advance_balance_iqd?: number; reconciliation_pending?: boolean };
  entries: Entry[]; withdrawals: Withdrawal[];
};

export default function MyEarnings() {
  const { loc, lang, dir } = useLanguage();
  const remote = useRemote<EarningsData>(EARNINGS), op = useMutation();
  const [open, setOpen] = useState(false), [amount, setAmount] = useState<number | null>(null), [kind, setKind] = useState('all'), [balanceType, setBalanceType] = useState<'earnings' | 'capital'>('earnings');
  const operationId = useRef('');
  const data = remote.data, s = data?.summary;
  const balance = (type: 'earnings' | 'capital') => type === 'capital' ? s?.capital_available_iqd ?? 0 : s?.earnings_available_iqd ?? s?.available_iqd ?? 0;
  const startWithdrawal = (type: 'earnings' | 'capital' = 'earnings') => { setBalanceType(type); operationId.current = crypto.randomUUID(); setAmount(balance(type)); op.clear(); setOpen(true); };
  const request = () => op.run(async () => {
    await api.post(`${EARNINGS}/withdrawals`, { operation_id: operationId.current, amount_iqd: amount, balance_type: balanceType });
    setOpen(false); await remote.load();
  }, loc('تم إرسال طلب السحب وحجز المبلغ. سيظهر التسديد بعد تسوية الإدارة.', 'Withdrawal requested and funds reserved. Payment appears after settlement.'));
  const rows = data?.entries.filter((e) => kind === 'all' || e.kind === kind) ?? [];
  return <div className="ap fp fp-stack" dir={dir}>
    <header className="fp-heading"><div><h2>{loc('أرباحي', 'My earnings')}</h2><p>{loc('مستحقاتك من العمل والاستثمار، في مكان واحد.', 'Your work and investment earnings, together.')}</p></div><Button variant="ghost" aria-label={loc('تحديث الأرباح', 'Refresh earnings')} icon={<RefreshCw size={17} />} onClick={remote.load} loading={remote.loading} /></header>
    <Feedback error={op.error} notice={op.notice} />
    {!data ? <Loading error={remote.error} retry={remote.load} /> : <>
      <Feedback error={remote.error} />
      <section className="fp-hero"><div><p className="flex items-center gap-2"><Wallet size={17} aria-hidden="true" />{loc('المتاح للسحب', 'Available to withdraw')}</p><Money value={balance('earnings')} /><p className="text-xs mt-1">{loc('بعد خصم المسدد وطلبات السحب المفتوحة', 'After paid amounts and open withdrawal requests')}</p></div><Button variant="primary" icon={<ArrowDownToLine size={17} />} disabled={balance('earnings') <= 0} onClick={() => startWithdrawal('earnings')}>{loc('طلب سحب الأرباح', 'Request withdrawal')}</Button></section>
      <div className="fp-stats">
        <div className="fp-stat"><span>{loc('إجمالي المستحق', 'Total earned')}</span><Money value={s.earned_iqd} /></div>
        <div className="fp-stat"><span>{loc('قيد الاستحقاق', 'Pending')}</span><Money value={data.entries.filter((e) => e.kind !== 'investor_capital').reduce((sum, e) => sum + Math.max(0, (e.accrued_iqd ?? e.amount_iqd) - e.amount_iqd) + (['due', 'approved', 'available'].includes(e.state) ? 0 : Math.max(0, e.amount_iqd - e.paid_iqd)), 0)} /></div>
        <div className="fp-stat"><span>{loc('محجوز للسحب', 'Reserved')}</span><Money value={s.earnings_held_iqd ?? s.held_iqd} /></div>
        <div className="fp-stat"><span>{loc('تم تسديده', 'Paid')}</span><Money value={s.earnings_paid_iqd ?? s.paid_iqd} /></div>
      </div>
      {!!s.reconciliation_pending && <p className="fp-note">{loc('توجد تسوية مالية قيد المراجعة؛ تتاح الأرباح بعد إكمالها.', 'A financial reconciliation is under review. Earnings become available when it is complete.')}</p>}
      {!!s.advance_balance_iqd && <p className="fp-note">{loc('حُسمت السلف غير المسواة من المبلغ المتاح: ', 'Unsettled advances deducted from available earnings: ')}<Money value={s.advance_balance_iqd} /></p>}
      {!!s.pending_costs && <p className="fp-note">{loc(`يوجد ${s.pending_costs} استحقاق بانتظار تثبيت التكلفة؛ لم يدخل في المجموع بعد.`, `${s.pending_costs} earnings await final costs and are not included in the total yet.`)}</p>}
      {!!s.debt_iqd && <p className="fp-note">{loc('رصيد تسوية يُخصم من المستحقات المتاحة: ', 'A carried settlement is deducted from available earnings: ')}<Money value={s.debt_iqd} /></p>}
      <Surface title={loc('مصادر مستحقاتك', 'Your earnings sources')}><div className="fp-rows">
        <div className="fp-row"><span>{loc('أجور العمل', 'Work earnings')}</span><Money value={s.staff_iqd} /></div>
        <div className="fp-row"><span>{loc('أرباح الاستثمار', 'Investment profits')}</span><Money value={s.investor_profit_iqd} /></div>
        <div className="fp-row"><span>{loc('رأس المال المسترد', 'Recovered capital')}</span><Money value={s.capital_iqd} /></div>{balance('capital') > 0 && <div className="fp-row"><div><span>{loc('رأس المال المتاح للسحب', 'Capital available to withdraw')}</span><p className="fp-row-meta"><Money value={balance('capital')} /></p></div><Button size="sm" onClick={() => startWithdrawal('capital')}>{loc('سحب رأس المال', 'Withdraw capital')}</Button></div>}
      </div></Surface>
      <Surface title={loc('طلبات السحب', 'Withdrawal requests')} hint={loc('طلب السحب يحجز الرصيد إلى أن تسدده الإدارة.', 'A withdrawal reserves your balance until the administrator pays it.')}>
        {!data.withdrawals.length ? <Empty>{loc('لا توجد طلبات سحب بعد.', 'No withdrawal requests yet.')}</Empty> : <div className="fp-rows">{data.withdrawals.map((w) => <div className="fp-row" key={w.id}><div className="min-w-0"><StateBadge state={w.state} /><div className="fp-row-meta">{dateLabel(w.created_at, lang)}</div>{w.reference && <div className="fp-row-meta">{loc('مرجع التسديد: ', 'Payment reference: ')}<bdi>{w.reference}</bdi></div>}{w.state === 'requested' && <Button size="sm" variant="ghost" loading={op.busy} onClick={() => op.run(async () => { await api.post(`${EARNINGS}/withdrawals/${encodeURIComponent(w.id)}/cancel`, {}); await remote.load(); }, loc('ألغي الطلب وأعيد المبلغ إلى المتاح.', 'Request cancelled and funds released.'))}>{loc('إلغاء الطلب', 'Cancel request')}</Button>}</div><div className="text-end"><Money value={w.amount_iqd} />{w.paid_iqd > 0 && w.state !== 'paid' && <p className="fp-row-meta">{loc('المسدد: ', 'Paid: ')}<Money value={w.paid_iqd} /></p>}</div></div>)}</div>}
      </Surface>
      <Surface title={loc('تفاصيل الأرباح', 'Earning details')} action={<CircleDollarSign size={20} className="fp-muted" aria-hidden="true" />}>
        <div className="fp-chips mb-5">{[['all', loc('الكل', 'All')], ['staff', loc('العمل', 'Work')], ['investor_profit', loc('الاستثمار', 'Investment')], ['investor_capital', loc('رأس المال', 'Capital')]].map(([id, label]) => <button key={id} type="button" className="fp-chip" aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div>
        {!rows.length ? <Empty>{loc('ستظهر مستحقاتك هنا عند تسجيلها.', 'Your earnings will appear here when recorded.')}</Empty> : <div className="fp-rows">{rows.map((e) => <div className="fp-row" key={`${e.kind}:${e.id}`}><div className="min-w-0"><div className="fp-row-title">{e.title || loc('مستحق مالي', 'Earning')}</div><div className="fp-row-meta">{dateLabel(e.day, lang)}{e.order_id && <> · {loc('طلب ', 'Order ')}<bdi>{e.order_id}</bdi></>}</div><StateBadge state={e.state} /></div><div className="text-end"><Money value={e.state === 'pending_cost' ? null : e.accrued_iqd ?? e.amount_iqd} />{e.available_iqd > 0 && <p className="fp-row-meta">{loc('متاح: ', 'Available: ')}<Money value={e.available_iqd} /></p>}</div></div>)}</div>}
      </Surface>
    </>}
    <Dialog open={open} onClose={() => setOpen(false)} title={balanceType === 'capital' ? loc('طلب سحب رأس المال المسترد', 'Withdraw recovered capital') : loc('طلب سحب الأرباح', 'Request withdrawal')} busy={op.busy}>
      <div className="fp-stack"><p className="fp-muted">{loc('اختر المبلغ. تُبلّغ الإدارة بطلبك ويُحجز من الرصيد المتاح لحين التسديد.', 'Choose an amount. Your administrator is notified and the balance is reserved until payment.')}</p><Field label={loc('مبلغ السحب', 'Withdrawal amount')}><NumberInput kind="money" min={1} max={balance(balanceType)} value={amount} onValueChange={(n, valid) => setAmount(valid ? n : null)} /></Field><div className="flex justify-between items-center gap-3"><span className="fp-muted">{loc('المتاح: ', 'Available: ')}<Money value={balance(balanceType)} /></span><Button size="sm" variant="ghost" onClick={() => setAmount(balance(balanceType))}>{loc('سحب الكل', 'Withdraw all')}</Button></div><Feedback error={op.error} /></div>
      <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => setOpen(false)}>{loc('رجوع', 'Back')}</Button><Button variant="primary" loading={op.busy} disabled={amount == null || amount <= 0 || amount > balance(balanceType)} onClick={request}>{loc('إرسال طلب السحب', 'Send withdrawal request')}</Button></footer>
    </Dialog>
  </div>;
}
export { MyEarnings };
