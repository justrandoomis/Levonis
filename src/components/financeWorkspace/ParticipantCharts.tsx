import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLanguage } from '../../LanguageContext';
import { useRemote } from '../financePeople/shared';
import { Money, Surface, formatMoney } from './ui';

/**
 * The four charts of /participant-report: the period's accrual against payments, investor capital recovered and not yet,
 * the effect of corrections, and the inventory batches' movement. They stood on the old overview; the redesign's overview
 * keeps one chart drawn without the chart library, so these moved to «الأشخاص والدفعات → المستثمرون», behind a summary
 * the owner opens (independent review, 2026-11-11; DECISIONS row 315) — loaded, and read, only then — until step 6 draws
 * them without the library or the owner retires them.
 */
type Report = { participants: { kind: string; earned_iqd: number; paid_iqd: number; pending_costs?: number }[]; adjustments: { day: string; positive_iqd: number; negative_iqd: number }[]; capital: { received_iqd: number; recovered_iqd: number; remaining_iqd: number; paid_iqd: number; period_recovered_iqd: number; period_paid_iqd: number }; batches: { id: string; name: string; received_qty: number; remaining_qty: number; sold_qty: number }[] };
const compact = (n: number) => Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}m` : Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
/** A chart's box: ResponsiveContainer needs a height; the numbers stay left to right. */
const box = { height: 245, minWidth: 0 } as const;
export default function ParticipantCharts({ from, to, revision }: { from: string; to: string; revision: number }) {
  const { loc } = useLanguage();
  const remote = useRemote<Report>(`/api/admin/finance-workspace/participant-report?from=${from}&to=${to}&revision=${revision}`);
  const d = remote.data;
  if (!d) return <p className="fw-note" role={remote.error ? 'alert' : 'status'}>{remote.error || loc('تحميل الاستحقاقات وأداء الدفعات…', 'Loading earnings and batch performance…', 'بارکردنی شایستەکان و ئەدای بارەکان…')}</p>;
  const axes = { tick: { fill: 'var(--fw-muted)', fontSize: 11 }, axisLine: false, tickLine: false };
  // The legend's words in the sheet's muted ink, beside a swatch in the series colour: recharts
  // paints the label in the series colour by default, 2.1–2.6:1 on the cream.
  const legend = <Legend formatter={(value) => <span style={{ color: 'var(--fw-muted)' }}>{value}</span>} />;
  const tip = <Tooltip formatter={(n) => formatMoney(Number(n))} contentStyle={{ background: 'var(--fw-surface)', border: '1px solid var(--fw-line)', borderRadius: 12 }} />;
  const participants = d.participants.map((p) => ({ ...p, name: p.kind === 'staff' ? loc('الموظفون', 'Staff', 'کارمەندان') : loc('المستثمرون', 'Investors', 'وەبەرهێنەران') }));
  const batches = [...d.batches].sort((a, b) => b.sold_qty - a.sold_qty || b.remaining_qty - a.remaining_qty).slice(0, 8);
  return <div className="fw-grid" data-finance-participant-charts>
    <Surface title={loc('الاستحقاق والتسديد في الفترة', 'Period accrual and payments', 'شایستە و پارەدان لەم ماوەیەدا')} subtitle={loc('المستحق حسب التسليم، والمسدد حسب يوم الدفع؛ قد يخص الدفع استحقاقًا أقدم.', 'Accrual follows delivery; payments follow payment day and may settle older earnings.', 'شایستە بەپێی گەیاندنە و پارەدان بەپێی ڕۆژی پارەدان؛ ڕەنگە پارەدانێک شایستەیەکی کۆنتر یەکلا بکاتەوە.')}>
      <div style={box} dir="ltr"><ResponsiveContainer><BarChart data={participants} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="name" {...axes} /><YAxis {...axes} tickFormatter={compact} width={52} />{tip}{legend}<Bar dataKey="earned_iqd" fill="#9980ce" name={loc('المستحق', 'Earned', 'شایستە')} radius={[4, 4, 0, 0]} isAnimationActive={false} /><Bar dataKey="paid_iqd" fill="#6d96d7" name={loc('المسدد', 'Paid', 'دراوە')} radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
      {participants.some((p) => p.pending_costs) && <p className="fw-note">{loc('توجد أجور بانتظار اكتمال الحساب. الإجمالي يتضمن المبالغ المسجلة حاليًا وقد يتغير بعد التسوية؛ البنود التي لم يُحسب مبلغها بعد غير مشمولة.', 'Some wages await calculation. Totals include currently recorded amounts, which may change after reconciliation; amounts never calculated are excluded.', 'هەندێک کرێ چاوەڕوانی ژمێریارییە. کۆی گشتی بڕە تۆمارکراوەکانی ئێستا لەخۆ دەگرێت و دوای یەکلاکردنەوە ڕەنگە بگۆڕێت؛ بڕە نەژمێردراوەکان لە کۆدا نین.')}</p>}
    </Surface>
    <Surface title={loc('رأس المال المستثمر', 'Investor capital', 'سەرمایەی وەبەرهێنەران')} subtitle={loc('تراكمي، مستقل عن الأرباح والأجور.', 'Cumulative, separate from profit and wages.', 'کەڵەکەبوو، جیا لە قازانج و کرێکان.')}>
      <div style={box} dir="ltr"><ResponsiveContainer><BarChart data={[{ name: loc('مسترد من المبيعات', 'Recovered', 'گەڕاوە لە فرۆشتنەوە'), amount: d.capital.recovered_iqd }, { name: loc('لم يُسترد بعد', 'Not yet recovered', 'هێشتا نەگەڕاوەتەوە'), amount: d.capital.remaining_iqd }]} layout="vertical" accessibilityLayer><CartesianGrid horizontal={false} stroke="var(--fw-line)" /><XAxis type="number" {...axes} tickFormatter={compact} /><YAxis type="category" dataKey="name" {...axes} width={115} />{tip}<Bar dataKey="amount" fill="#6d96d7" name={loc('رأس المال', 'Principal', 'سەرمایە')} radius={[0, 4, 4, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
      <p className="fw-note">{loc('المسترد في الفترة', 'Recovered in period', 'گەڕاوە لەم ماوەیەدا')}: <Money value={d.capital.period_recovered_iqd} /> · {loc('مسدد كرأس مال في الفترة', 'Capital paid in period', 'سەرمایەی دراو لەم ماوەیەدا')}: <Money value={d.capital.period_paid_iqd} /></p>
      <p className="fw-note">{loc('الاسترداد ضمن رأس المال المموّل بعد الخسائر؛ يُوزّع على الفترات بحسب ترتيب التسليم.', 'Recovery is limited to funded principal after losses and attributed to periods in delivery order.', 'گەڕاندنەوە لە سنووری سەرمایەی دابینکراودایە دوای زیانەکان؛ بە ڕیزبەندی گەیاندن بۆ ماوەکان دابەش دەکرێت.')}</p>
    </Surface>
    <Surface title={loc('أثر التسويات', 'Effect of corrections', 'کاریگەریی ڕاستکردنەوەکان')} subtitle={loc('حسب يوم تسجيلها في الدفتر المفتوح؛ تاريخ الاستحقاق محفوظ في سجل الحركة.', 'By posting day in the open ledger; original earning dates remain in the activity log.', 'بەپێی ڕۆژی تۆمارکردنیان لە دەفتەری کراوەدا؛ بەرواری شایستەبوون لە تۆماری جووڵەکاندا پارێزراوە.')}>
      {d.adjustments.length ? <div style={box} dir="ltr"><ResponsiveContainer><BarChart data={d.adjustments} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="day" {...axes} tickFormatter={(v: string) => v.slice(5)} /><YAxis {...axes} tickFormatter={compact} width={52} /><ReferenceLine y={0} stroke="var(--fw-line)" />{tip}{legend}<Bar dataKey="positive_iqd" fill="#6d96d7" name={loc('زيادة الاستحقاق', 'Increase', 'زیادبوونی شایستە')} isAnimationActive={false} /><Bar dataKey="negative_iqd" fill="#ce7775" name={loc('تخفيض الاستحقاق', 'Decrease', 'کەمبوونەوەی شایستە')} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="fw-note">{loc('لا تسويات مسجلة في هذه الفترة.', 'No corrections posted in this period.', 'هیچ ڕاستکردنەوەیەک لەم ماوەیەدا تۆمار نەکراوە.')}</p>}
    </Surface>
    <Surface title={loc('حركة دفعات المخزون', 'Inventory batch movement', 'جووڵەی بارەکانی کۆگا')} subtitle={loc('المباع المسلّم خلال الفترة مقابل المتبقي الآن؛ أعلى ٨ دفعات.', 'Delivered sales in the period versus remaining now; top 8 batches.', 'فرۆشراوی گەیەندراو لەم ماوەیەدا بەرامبەر ئەوەی ئێستا ماوەتەوە؛ 8 باری سەرەکی.')}>
      {batches.length ? <div style={box} dir="ltr"><ResponsiveContainer><BarChart data={batches} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--fw-line)" /><XAxis dataKey="name" {...axes} /><YAxis {...axes} allowDecimals={false} width={36} /><Tooltip contentStyle={{ background: 'var(--fw-surface)', border: '1px solid var(--fw-line)' }} />{legend}<Bar dataKey="sold_qty" fill="#9980ce" name={loc('مباع مسلّم', 'Delivered', 'فرۆشراوی گەیەندراو')} isAnimationActive={false} /><Bar dataKey="remaining_qty" fill="#c59957" name={loc('متبقٍ الآن', 'Remaining now', 'ئێستا ماوە')} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="fw-note">{loc('لا دفعات مخزون بعد.', 'No inventory batches yet.', 'هێشتا هیچ بارێکی کۆگا نییە.')}</p>}
      <p className="fw-note">{loc('جميع الدفعات: مباع في الفترة', 'All batches: delivered in period', 'هەموو بارەکان: فرۆشراو لەم ماوەیەدا')} {d.batches.reduce((n, b) => n + b.sold_qty, 0)} · {loc('متبقٍ الآن', 'Remaining now', 'ئێستا ماوە')} {d.batches.reduce((n, b) => n + b.remaining_qty, 0)}</p>
    </Surface>
  </div>;
}
