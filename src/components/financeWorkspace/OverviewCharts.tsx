import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLanguage } from '../../LanguageContext';
import { Empty, Money, Surface, formatMoney } from './ui';
import type { FinanceSummary } from './types';

const colors = { revenue: '#6d96d7', cost: '#c59957', net: '#9980ce', negative: '#ce7775' };
const short = (value: number) => Math.abs(value) >= 1e6 ? `${+(value / 1e6).toFixed(1)}m` : Math.abs(value) >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(value);
const tooltipStyle = { background: 'var(--fw-surface)', border: '1px solid var(--fw-line)', borderRadius: 12, color: 'var(--fw-text)', fontSize: 12, direction: 'rtl' as const };

/** This module (including Recharts) is loaded only when the finance overview opens. */
export default function OverviewCharts({ data }: { data: FinanceSummary }) {
  const { loc } = useLanguage();
  const charts = data.chart_data;
  if (!charts) return <Surface><Empty title={loc('بيانات الرسم غير متاحة', 'Chart data unavailable')} text={loc('يمكن مراجعة الأرقام وتفاصيل الطلبات أدناه.', 'You can review figures and order details below.')} /></Surface>;
  const labels = { revenue_iqd: loc('الإيراد', 'Revenue'), cost_iqd: loc('التكاليف', 'Costs'), owner_net_iqd: loc('صافي حصتك', 'Your net share') };
  const expenseNames = { goods: loc('البضاعة', 'Goods'), wages: loc('الأجور', 'Wages'), materials: loc('المواد', 'Materials'), other: loc('تكاليف إضافية', 'Additional costs'), delivery: loc('التوصيل والدفع', 'Delivery & payment'), promotion: loc('الترويج', 'Promotion'), general: loc('المصاريف العامة', 'General expenses') };
  const expenses = charts.expense_composition.map((row) => ({ ...row, name: expenseNames[row.key] }));
  const visibleExpenses = expenses.filter((row) => row.amount_iqd != null && row.amount_iqd !== 0);
  // Main sections only: counting child sections again would duplicate profit.
  const categories = data.categories.filter((row) => row.level === 'main');
  const ranked = [...categories].filter((row) => row.owner_net_iqd != null).sort((a, b) => Math.abs(b.owner_net_iqd!) - Math.abs(a.owner_net_iqd!)).slice(0, 8);
  const active = charts.daily.some((row) => row.orders_count > 0 || row.cost_iqd !== null && row.cost_iqd !== 0);
  const axis = { tick: { fill: 'var(--fw-muted)', fontSize: 10 }, axisLine: false, tickLine: false };
  const tooltip = <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatMoney(value == null ? null : Number(value))} cursor={{ stroke: 'var(--fw-line)' }} />;
  return <>
    <Surface title={loc('الإيراد والتكاليف والصافي', 'Revenue, costs & net')} subtitle={loc('القيم بالدينار؛ حسب يوم استلام الطلب بتوقيت بغداد.', 'Values in IQD, by delivered date in Baghdad time.')}>
      <div className="fw-chart-legend">{Object.entries(labels).map(([key, label], index) => <span key={key}><i style={{ background: [colors.revenue, colors.cost, colors.net][index] }} />{label}</span>)}</div>
      {active ? <div className="fw-chart" dir="ltr" role="img" aria-label={loc('اتجاه الإيراد والتكاليف وصافي حصة المالك؛ القيم متاحة في جدول البيانات.', 'Revenue, cost and owner net trend; exact values are available in the data table.')}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={charts.daily} margin={{ top: 12, right: 10, left: 0, bottom: 5 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--fw-line)" strokeDasharray="3 4" /><XAxis dataKey="day" {...axis} tickFormatter={(v: string) => v.slice(5)} minTickGap={35} /><YAxis {...axis} width={48} tickFormatter={short} />
          <ReferenceLine y={0} stroke="var(--fw-line)" />{tooltip}
          <Line dataKey="revenue_iqd" name={labels.revenue_iqd} stroke={colors.revenue} strokeWidth={2} dot={charts.daily.length === 1} isAnimationActive={false} />
          <Line dataKey="cost_iqd" name={labels.cost_iqd} stroke={colors.cost} strokeWidth={2} dot={charts.daily.length === 1} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="owner_net_iqd" name={labels.owner_net_iqd} stroke={colors.net} strokeWidth={2.5} dot={charts.daily.length === 1} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer>
      </div> : <Empty title={loc('لا نشاط مالي في الفترة', 'No financial activity in this range')} text={loc('اختر فترة أخرى؛ ستظهر المبيعات والمصاريف المسجلة فقط.', 'Choose another range. Only recorded sales and expenses are shown.')} />}
      <p className="fw-note">{loc('الصافي بعد حصص المستثمرين. الفراغ في الخط يعني حسابًا غير مكتمل. المرتجعات والتصحيحات تُنسب إلى يوم الطلب؛ المصاريف العامة إلى يوم تسجيلها.', 'Net is after investor shares. A gap means an incomplete calculation. Returns and corrections follow the order date; general expenses follow their recorded date.')}</p>
      <details className="fw-advanced"><summary>{loc('عرض بيانات الأيام', 'View daily figures')}</summary><div className="fw-chart-table"><table><caption>{loc('الإيراد والتكاليف وصافي المالك اليومي بالدينار', 'Daily revenue, costs and owner net in IQD')}</caption><thead><tr><th>{loc('اليوم', 'Day')}</th><th>{labels.revenue_iqd}</th><th>{labels.cost_iqd}</th><th>{labels.owner_net_iqd}</th><th>{loc('حصص المستثمرين', 'Investor shares')}</th><th>{loc('الطلبات', 'Orders')}</th></tr></thead><tbody>{charts.daily.map((row) => <tr key={row.day}><th scope="row">{row.day}</th><td><Money value={row.revenue_iqd} /></td><td><Money value={row.cost_iqd} /></td><td><Money value={row.owner_net_iqd} /></td><td><Money value={row.investor_iqd} /></td><td>{row.orders_count}</td></tr>)}</tbody></table></div></details>
    </Surface>
    <div className="fw-two-columns">
      <Surface title={loc('أين تذهب التكاليف؟', 'Where do costs go?')} subtitle={loc('تكاليف الفترة؛ حصص المستثمرين تظهر منفصلة.', 'Period costs; investor shares are shown separately.')}>
        {visibleExpenses.length ? <div className="fw-chart fw-chart--bars" dir="ltr" role="img" aria-label={loc('مقارنة بنود التكاليف؛ الأرقام في جدول البيانات.', 'Cost composition comparison; exact figures in the table.')}>
          <ResponsiveContainer width="100%" height="100%"><BarChart data={visibleExpenses} layout="vertical" margin={{ top: 5, right: 10, left: 5, bottom: 5 }} accessibilityLayer>
            <CartesianGrid horizontal={false} stroke="var(--fw-line)" strokeDasharray="3 4" /><XAxis type="number" {...axis} tickFormatter={short} /><YAxis type="category" dataKey="name" {...axis} width={98} tick={{ ...axis.tick, fontSize: 11 }} />{tooltip}<ReferenceLine x={0} stroke="var(--fw-line)" />
            <Bar dataKey="amount_iqd" name={loc('التكلفة', 'Cost')} barSize={13} radius={[0, 4, 4, 0]} isAnimationActive={false}>{visibleExpenses.map((row) => <Cell key={row.key} fill={row.amount_iqd! < 0 ? colors.negative : colors.cost} />)}</Bar>
          </BarChart></ResponsiveContainer>
        </div> : <Empty title={loc('لا تكاليف مثبتة للرسم', 'No confirmed costs to plot')} text={loc('القيم المجهولة تبقى غير مكتملة حتى مراجعتها.', 'Unknown values remain incomplete until reviewed.')} />}
        <details className="fw-advanced"><summary>{loc('عرض مبالغ التكاليف', 'View cost figures')}</summary><div className="fw-chart-table"><table><caption>{loc('تفصيل التكاليف بالدينار', 'Cost breakdown in IQD')}</caption><thead><tr><th>{loc('البند', 'Cost item')}</th><th>{loc('المبلغ', 'Amount')}</th></tr></thead><tbody>{expenses.map((row) => <tr key={row.key}><th scope="row">{row.name}</th><td><Money value={row.amount_iqd} /></td></tr>)}</tbody></table></div></details>
        <p className="fw-note">{loc('الترويج يحافظ على توزيعه على كل قطع الشهر. السالب يعني تخفيض تكلفة أو استردادًا.', 'Promotion retains its allocation across all units sold in its month. Negative costs are credits or reversals.')}</p>
      </Surface>
      <Surface title={loc('مساهمة الأقسام في حصتك', 'Sections contributing to your share')} subtitle={loc('أكثر ٨ أقسام رئيسية أثرًا، بعد التكاليف المخصصة وحصص المستثمرين.', 'The 8 main sections with greatest impact, after allocated costs and investor shares.')}>
        {ranked.length ? <div className="fw-chart fw-chart--bars" dir="ltr" role="img" aria-label={loc('صافي المالك لكل قسم؛ التفاصيل في الجدول.', 'Owner net by section; details in the table.')}>
          <ResponsiveContainer width="100%" height="100%"><BarChart data={ranked} layout="vertical" margin={{ top: 5, right: 10, left: 5, bottom: 5 }} accessibilityLayer>
            <CartesianGrid horizontal={false} stroke="var(--fw-line)" strokeDasharray="3 4" /><XAxis type="number" {...axis} tickFormatter={short} /><YAxis type="category" dataKey="name" {...axis} width={98} tick={{ ...axis.tick, fontSize: 11 }} />{tooltip}<ReferenceLine x={0} stroke="var(--fw-line)" />
            <Bar dataKey="owner_net_iqd" name={labels.owner_net_iqd} barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>{ranked.map((row) => <Cell key={row.id} fill={row.owner_net_iqd! < 0 ? colors.negative : colors.net} />)}</Bar>
          </BarChart></ResponsiveContainer>
        </div> : <Empty title={loc('لا ربح أقسام مكتمل للرسم', 'No confirmed section profit to plot')} text={loc('ستظهر الأقسام عندما تستلم الطلبات وتكتمل تكاليفها.', 'Sections appear once orders are delivered and their costs are confirmed.')} />}
        <details className="fw-advanced"><summary>{loc('عرض كل الأقسام', 'View every section')}</summary><div className="fw-chart-table"><table><caption>{loc('صافي المالك حسب القسم الرئيسي', 'Owner net by main section')}</caption><thead><tr><th>{loc('القسم', 'Section')}</th><th>{loc('القطع', 'Units')}</th><th>{labels.owner_net_iqd}</th></tr></thead><tbody>{categories.map((row) => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.qty}</td><td><Money value={row.owner_net_iqd} /></td></tr>)}</tbody></table></div></details>
        <p className="fw-note">{loc('المصاريف العامة والترويج دون مبيعات تُخصم من صافي الفترة، ولا تُوزع على الأقسام هنا.', 'General expenses and promotion without sales reduce period net, and are not allocated to these sections.')}</p>
      </Surface>
    </div>
  </>;
}
