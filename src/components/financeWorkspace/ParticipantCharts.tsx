import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLanguage } from '../../LanguageContext';
import { useRemote } from '../financePeople/shared';
import { Money, Surface, formatMoney } from './ui';

type Report = { participants: { kind: string; earned_iqd: number; paid_iqd: number; pending_costs?: number }[]; adjustments: { day: string; positive_iqd: number; negative_iqd: number }[]; capital: { received_iqd: number; recovered_iqd: number; remaining_iqd: number; paid_iqd: number; period_recovered_iqd: number; period_paid_iqd: number }; batches: { id: string; name: string; received_qty: number; remaining_qty: number; sold_qty: number }[] };
const compact = (n: number) => Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}m` : Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
export default function ParticipantCharts({ from, to, revision }: { from: string; to: string; revision: number }) {
  const { loc } = useLanguage();
  const remote = useRemote<Report>(`/api/admin/finance-workspace/participant-report?from=${from}&to=${to}&revision=${revision}`);
  const d = remote.data;
  if (!d) return <p className="fw-note" role={remote.error ? 'alert' : 'status'}>{remote.error || loc('تحميل الاستحقاقات وأداء الدفعات…', 'Loading earnings and batch performance…')}</p>;
  const axes = { tick: { fill: 'var(--fw-muted)', fontSize: 11 }, axisLine: false, tickLine: false };
  const tip = <Tooltip formatter={(n) => formatMoney(Number(n))} contentStyle={{ background: 'var(--fw-surface)', border: '1px solid var(--fw-line)', borderRadius: 12 }} />;
  const participants = d.participants.map((p) => ({ ...p, name: p.kind === 'staff' ? loc('الموظفون', 'Staff') : loc('المستثمرون', 'Investors') }));
  const batches = [...d.batches].sort((a, b) => b.sold_qty - a.sold_qty || b.remaining_qty - a.remaining_qty).slice(0, 8);
  return <div className="fw-two-columns">
    <Surface title={loc('الاستحقاق والتسديد في الفترة', 'Period accrual and payments')} subtitle={loc('المستحق حسب التسليم، والمسدد حسب يوم الدفع؛ قد يخص الدفع استحقاقًا أقدم.', 'Accrual follows delivery; payments follow payment day and may settle older earnings.')}>
      <div className="fw-chart" dir="ltr"><ResponsiveContainer><BarChart data={participants} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="name" {...axes} /><YAxis {...axes} tickFormatter={compact} width={52} />{tip}<Legend /><Bar dataKey="earned_iqd" fill="#9980ce" name={loc('المستحق', 'Earned')} radius={[4, 4, 0, 0]} isAnimationActive={false} /><Bar dataKey="paid_iqd" fill="#6d96d7" name={loc('المسدد', 'Paid')} radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
      {participants.some((p) => p.pending_costs) && <p className="fw-note">{loc('توجد أجور معلقة تحتاج تثبيت التكلفة؛ لا تشملها الأعمدة المكتملة.', 'Some earnings await verified costs and are excluded from confirmed bars.')}</p>}
    </Surface>
    <Surface title={loc('رأس المال المستثمر', 'Investor capital')} subtitle={loc('تراكمي، مستقل عن الأرباح والأجور.', 'Cumulative, separate from profit and wages.')}>
      <div className="fw-chart" dir="ltr"><ResponsiveContainer><BarChart data={[{ name: loc('مسترد من المبيعات', 'Recovered'), amount: d.capital.recovered_iqd }, { name: loc('لم يُسترد بعد', 'Not yet recovered'), amount: d.capital.remaining_iqd }]} layout="vertical" accessibilityLayer><CartesianGrid horizontal={false} stroke="var(--fw-line)" /><XAxis type="number" {...axes} tickFormatter={compact} /><YAxis type="category" dataKey="name" {...axes} width={115} />{tip}<Bar dataKey="amount" fill="#6d96d7" name={loc('رأس المال', 'Principal')} radius={[0, 4, 4, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
      <p className="fw-note">{loc('المسترد في الفترة', 'Recovered in period')}: <Money value={d.capital.period_recovered_iqd} /> · {loc('مسدد كرأس مال في الفترة', 'Capital paid in period')}: <Money value={d.capital.period_paid_iqd} /></p>
    </Surface>
    <Surface title={loc('أثر التسويات', 'Effect of corrections')} subtitle={loc('حسب يوم تسجيلها في الدفتر المفتوح؛ تاريخ الاستحقاق محفوظ في سجل الحركة.', 'By posting day in the open ledger; original earning dates remain in the activity log.')}>
      {d.adjustments.length ? <div className="fw-chart" dir="ltr"><ResponsiveContainer><BarChart data={d.adjustments} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="day" {...axes} tickFormatter={(v: string) => v.slice(5)} /><YAxis {...axes} tickFormatter={compact} width={52} /><ReferenceLine y={0} stroke="var(--fw-line)" />{tip}<Legend /><Bar dataKey="positive_iqd" fill="#6d96d7" name={loc('زيادة الاستحقاق', 'Increase')} isAnimationActive={false} /><Bar dataKey="negative_iqd" fill="#ce7775" name={loc('تخفيض الاستحقاق', 'Decrease')} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="fw-note">{loc('لا تسويات مسجلة في هذه الفترة.', 'No corrections posted in this period.')}</p>}
    </Surface>
    <Surface title={loc('حركة دفعات المخزون', 'Inventory batch movement')} subtitle={loc('المباع المسلّم خلال الفترة مقابل المتبقي الآن؛ أعلى ٨ دفعات.', 'Delivered sales in the period versus remaining now; top 8 batches.')}>
      {batches.length ? <div className="fw-chart" dir="ltr"><ResponsiveContainer><BarChart data={batches} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="name" {...axes} /><YAxis {...axes} allowDecimals={false} width={36} /><Tooltip contentStyle={{ background: 'var(--fw-surface)', border: '1px solid var(--fw-line)' }} /><Legend /><Bar dataKey="sold_qty" fill="#9980ce" name={loc('مباع مسلّم', 'Delivered')} isAnimationActive={false} /><Bar dataKey="remaining_qty" fill="#c59957" name={loc('متبقٍ الآن', 'Remaining now')} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="fw-note">{loc('لا دفعات مخزون بعد.', 'No inventory batches yet.')}</p>}
      <p className="fw-note">{loc('جميع الدفعات: مباع في الفترة', 'All batches: delivered in period')} {d.batches.reduce((n, b) => n + b.sold_qty, 0)} · {loc('متبقٍ الآن', 'Remaining now')} {d.batches.reduce((n, b) => n + b.remaining_qty, 0)}</p>
    </Surface>
  </div>;
}
