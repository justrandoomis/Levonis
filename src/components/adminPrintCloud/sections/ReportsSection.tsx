/**
 * REPORTS — one date range, three reports, each shown only to whom the server
 * serves it:
 *
 *   Operations  every admin (`GET /reports/operations`): machine utilisation,
 *               completed and failed jobs, failures by responsible party,
 *               material that left the shelf.
 *   Revenue     money scope (`GET /reports/revenue`): cash collected,
 *               recognised revenue, the deferred liability (prepaid hours and
 *               material not used yet), refunds and buybacks.
 *   Profit      the owner (`GET /reports/profit`): material cost, operating
 *               costs, gross and net profit. While the server says
 *               `cost_complete: false`, some material came from lots whose
 *               cost is not stated yet — the profit is overstated and the
 *               screen says so first, with what is pending.
 *
 * Tables and plain bars (ui.tsx `Bar`) — no chart library: the figure beside
 * each bar is the fact; the bar is only its share.
 */
import { useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Coins } from 'lucide-react';
import { KpiTile } from '../../ui/KpiTile';
import { Money } from '../../ui/Money';
import { usePcAccess } from '../access';
import { pc, query, type OperationsReport, type ProfitReport, type RevenueReport } from '../api';
import { RESPONSIBLE, labelOf, tri, type Tri } from '../i18n';
import { duration, formatDate, num, permille, qty } from '../format';
import { useRefs } from '../refs';
import { Act, Bar, Chips, KV, LoadState, Note, SectionHead, T, TextField, Tray, useLoad, usePcLang } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('التقارير', 'Reports', 'ڕاپۆرتەکان'),
  desc: tri(
    'تقارير الفترة المختارة من الخادم مباشرة. المبالغ بالدينار العراقي.',
    'Reports for the chosen period, straight from the server. Amounts in Iraqi dinars.',
    'ڕاپۆرتەکانی ماوەی هەڵبژێردراو، ڕاستەوخۆ لە ڕاژەکارەوە. بڕەکان بە دیناری عێراقی.'
  ),
  from: tri('من', 'From', 'لە'),
  to: tri('إلى (شاملاً)', 'To (inclusive)', 'تا (لەگەڵیدا)'),
  apply: tri('عرض الفترة', 'Show the period', 'پیشاندانی ماوە'),
  last7: tri('آخر 7 أيام', 'Last 7 days', '7 ڕۆژی ڕابردوو'),
  last30: tri('آخر 30 يوماً', 'Last 30 days', '30 ڕۆژی ڕابردوو'),
  last90: tri('آخر 90 يوماً', 'Last 90 days', '90 ڕۆژی ڕابردوو'),
  badRange: tri('تاريخ البداية بعد تاريخ النهاية.', 'The start date is after the end date.', 'بەرواری دەستپێک دوای بەرواری کۆتاییە.'),
  report: tri('التقرير', 'Report', 'ڕاپۆرت'),
  operations: tri('التشغيل', 'Operations', 'کارپێکردن'),
  revenue: tri('الإيرادات', 'Revenue', 'داهات'),
  profit: tri('الربح (للمالك)', 'Profit (owner)', 'قازانج (خاوەن)'),
  period: tri('الفترة', 'Period', 'ماوە'),
  // operations
  completed: tri('مهام مكتملة', 'Jobs completed', 'کاری تەواوکراو'),
  failed: tri('مهام فاشلة', 'Jobs failed', 'کاری سەرنەکەوتوو'),
  failureRate: tri('نسبة الفشل', 'Failure rate', 'ڕێژەی شکست'),
  printers: tri('الطابعات', 'Printers', 'چاپکەرەکان'),
  noPrinters: tri('لا طابعات مسجّلة.', 'No printers registered.', 'هیچ چاپکەرێک تۆمار نەکراوە.'),
  printed: tri('وقت الطباعة', 'Printed time', 'کاتی چاپکردن'),
  jobs: tri('المهام', 'Jobs', 'کارەکان'),
  utilisation: tri('الاستغلال', 'Utilisation', 'بەکارهێنان'),
  utilisationHelp: tri('وقت الطباعة المنتهية ÷ طول الفترة.', 'Finished printing time ÷ the length of the period.', 'کاتی چاپی تەواوبوو ÷ درێژیی ماوەکە.'),
  failuresBy: tri('الأعطال حسب المسؤول', 'Failures by responsible party', 'شکستەکان بەپێی بەرپرس'),
  noFailures: tri('لا أعطال في الفترة.', 'No failures in the period.', 'هیچ شکستێک لەم ماوەیەدا نییە.'),
  materialUsed: tri('المواد التي خرجت من الرف', 'Material that left the shelf', 'ئەو کەرەستانەی لە ڕەف دەرچوون'),
  materialHelp: tri('استهلاك العملاء والورشة والهدر.', 'Customer use, workshop use and waste.', 'بەکارهێنانی کڕیار و کارگە و بەفیڕۆچوون.'),
  noMaterial: tri('لم تخرج مواد في الفترة.', 'No material left the shelf in the period.', 'هیچ کەرەستەیەک لەم ماوەیەدا لە ڕەف دەرنەچوو.'),
  // revenue
  cash: tri('النقد المحصَّل', 'Cash collected', 'پارەی وەرگیراو'),
  cashHelp: tri('ما دُفع فعلاً في الفترة — ليس إيراداً حتى يُستعمل.', 'What was actually paid in the period — not revenue until it is used.', 'ئەوەی بەڕاستی لەم ماوەیەدا درا — تا بەکارنەهێنرێت داهات نییە.'),
  recognised: tri('الإيراد المعترف به', 'Recognised revenue', 'داهاتی ناسێنراو'),
  recognisedHelp: tri('ما استُعمل فعلاً بقيمة شرائه، ورسوم التوصيل المدفوعة.', 'What was actually used, at its purchase value, and delivery fees once paid.', 'ئەوەی بەڕاستی بەکارهات بە بەهای کڕینەکەی، و کرێی گەیاندنی دراو.'),
  deferred: tri('التزام مؤجَّل الآن', 'Deferred liability now', 'پابەندبوونی دواخراو ئێستا'),
  deferredHelp: tri('ساعات ومواد دفعها العملاء ولم تُستعمل بعد.', 'Hours and material customers paid for and have not used yet.', 'کاتژمێر و کەرەستەیەک کە کڕیاران پارەیان داوە و هێشتا بەکاریان نەهێناوە.'),
  hours: tri('ساعات الطباعة', 'Printing hours', 'کاتژمێرەکانی چاپ'),
  materials: tri('المواد', 'Materials', 'کەرەستەکان'),
  deliveryFees: tri('رسوم التوصيل', 'Delivery fees', 'کرێی گەیاندن'),
  total: tri('المجموع', 'Total', 'کۆ'),
  byCategory: tri('المواد حسب الفئة', 'Materials by category', 'کەرەستەکان بەپێی پۆل'),
  refunds: tri('الاستردادات المسجّلة', 'Refunds recorded', 'گەڕاندنەوە تۆمارکراوەکان'),
  refundsUnused: tri('منها استرداد قيمة غير مستعملة', 'Of which unused value returned', 'لەوانە بەهای بەکارنەهاتوو گەڕێنرایەوە'),
  buybacks: tri('إعادة الشراء', 'Buybacks', 'کڕینەوە'),
  buybacksApproved: tri('قيمة مقبولة', 'Value approved', 'بەهای پەسەندکراو'),
  buybacksPaid: tri('دُفع للعملاء', 'Paid out', 'بە کڕیاران درا'),
  // profit
  costIncomplete: tri(
    'تكلفة بعض المواد غير مسجّلة بعد: جاءت من دفعات لم يُذكر سعر شرائها، فالربح هنا أعلى من الحقيقة بقدر تكلفتها. سجّل تكلفة هذه الدفعات من «مخزون الورشة».',
    'Some material’s cost is not recorded yet: it came from lots whose purchase cost is not stated, so the profit here is higher than the truth by that cost. State those lots’ cost in “Workshop stock”.',
    'تێچووی هەندێک کەرەستە هێشتا تۆمار نەکراوە: لە کۆمەڵەیەکەوە هاتووە کە نرخی کڕینیان نەنووسراوە، بۆیە قازانجی ئێرە بە ئەندازەی تێچووەکەیان لە ڕاستی زیاترە. تێچووی ئەو کۆمەڵانە لە «کۆگای کارگە» تۆمار بکە.'
  ),
  costComplete: tri('كل تكلفة مستعملة في الفترة مسجّلة.', 'Every cost used in the period is recorded.', 'هەموو تێچوویەکی بەکارهاتوو لەم ماوەیەدا تۆمارکراوە.'),
  pendingUse: tri('استعمال بلا تكلفة مسجّلة', 'Use without a recorded cost', 'بەکارهێنان بێ تێچووی تۆمارکراو'),
  pendingLots: tri('دفعات تنتظر تكلفتها', 'Lots waiting for their cost', 'ئەو کۆمەڵانەی چاوەڕێی تێچووەکەیانن'),
  cogs: tri('تكلفة المواد المستعملة', 'Cost of material used', 'تێچووی کەرەستەی بەکارهاتوو'),
  gross: tri('مجمل الربح', 'Gross profit', 'کۆی قازانج'),
  operating: tri('تكاليف التشغيل', 'Operating costs', 'تێچووەکانی کارپێکردن'),
  waste: tri('الهدر واستعمال الورشة', 'Waste and workshop use', 'بەفیڕۆچوون و بەکارهێنانی کارگە'),
  electricity: tri('الكهرباء (تقدير)', 'Electricity (estimate)', 'کارەبا (خەمڵاندن)'),
  electricityBasis: tri('متوسط قدرة الطراز × وقت الطباعة × التعرفة', 'Model average power × printed time × tariff', 'تێکڕای توانای مۆدێل × کاتی چاپ × نرخی کارەبا'),
  tariff: tri('التعرفة', 'Tariff', 'نرخی کارەبا'),
  perKwh: tri('دينار/كيلوواط ساعة', 'IQD/kWh', 'دینار/کیلۆوات کاتژمێر'),
  reserve: tri('احتياطي الصيانة (محسوب بالساعة)', 'Maintenance reserve (per printed hour)', 'یەدەگی چاکسازی (بە کاتژمێری چاپ)'),
  maintenance: tri('صيانة مسجّلة', 'Maintenance recorded', 'چاکسازیی تۆمارکراو'),
  depreciation: tri('الإهلاك (من تكلفة الطابعة وعمرها)', 'Depreciation (from machine cost and life)', 'داخوران (لە تێچوو و تەمەنی ئامێرەکە)'),
  statedLater: tri('تكلفة ذُكرت بعد الاستعمال', 'Cost stated after use', 'تێچووی دوای بەکارهێنان نووسراو'),
  refundsEffect: tri('أثر الاستردادات على الربح', 'Refunds’ effect on profit', 'کاریگەریی گەڕاندنەوەکان لەسەر قازانج'),
  net: tri('صافي الربح', 'Net profit', 'قازانجی پوخت'),
} satisfies Record<string, Tri>;

type Tab = 'operations' | 'revenue' | 'profit';

const day = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAgo = (n: number) => day(new Date(Date.now() - n * 86400_000));

/** A local calendar range as the server's half-open ISO instants: [from 00:00, the day after `to` 00:00). */
function isoRange(from: string, to: string): { from: string; to: string } | null {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) return null;
  t.setDate(t.getDate() + 1);
  return { from: f.toISOString(), to: t.toISOString() };
}

export default function ReportsSection(_props: SectionProps) {
  const { t } = usePcLang();
  const access = usePcAccess();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(day(new Date()));
  const [range, setRange] = useState(() => isoRange(daysAgo(30), day(new Date())) as { from: string; to: string });
  const [failure, setFailure] = useState<string | null>(null);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'operations', label: t(S.operations) },
    ...(access.money ? [{ id: 'revenue' as Tab, label: t(S.revenue) }] : []),
    ...(access.costRead ? [{ id: 'profit' as Tab, label: t(S.profit) }] : []),
  ];
  const [tab, setTab] = useState<Tab>('operations');
  const shown: Tab = tabs.some((x) => x.id === tab) ? tab : 'operations';

  const apply = (f = from, tt = to) => {
    const r = isoRange(f, tt);
    if (!r) return setFailure(t(S.badRange));
    setFailure(null);
    setRange(r);
  };
  const preset = (n: number) => {
    const f = daysAgo(n);
    const tt = day(new Date());
    setFrom(f);
    setTo(tt);
    apply(f, tt);
  };

  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <section className={`${T.surface} space-y-3 p-4`}>
        <div className="flex flex-wrap items-end gap-2">
          <TextField className="w-44" type="date" label={t(S.from)} value={from} onChange={setFrom} ltr />
          <TextField className="w-44" type="date" label={t(S.to)} value={to} onChange={setTo} ltr />
          <Act kind="primary" onClick={() => apply()}>
            {t(S.apply)}
          </Act>
        </div>
        <div className="flex flex-wrap gap-2">
          <Act kind="ghost" onClick={() => preset(7)}>
            {t(S.last7)}
          </Act>
          <Act kind="ghost" onClick={() => preset(30)}>
            {t(S.last30)}
          </Act>
          <Act kind="ghost" onClick={() => preset(90)}>
            {t(S.last90)}
          </Act>
        </div>
        {failure && <Note tone="danger">{failure}</Note>}
      </section>
      {tabs.length > 1 && <Chips<Tab> label={t(S.report)} value={shown} onChange={setTab} items={tabs} />}
      {shown === 'operations' && <Operations range={range} />}
      {shown === 'revenue' && access.money && <Revenue range={range} />}
      {shown === 'profit' && access.costRead && <Profit range={range} />}
    </div>
  );
}

function PeriodLine({ range }: { range: { from: string; to: string } }) {
  const { t, lang } = usePcLang();
  // The server's `to` is exclusive: the last day shown is the one before it.
  const last = new Date(Date.parse(range.to) - 1).toISOString();
  return (
    <p className={`text-[11.5px] ${T.text3}`}>
      {t(S.period)}: {formatDate(range.from, lang)} — {formatDate(last, lang)}
    </p>
  );
}

function Operations({ range }: { range: { from: string; to: string } }) {
  const { t, lang } = usePcLang();
  const report = useLoad(() => pc.get<OperationsReport>(`/reports/operations${query(range)}`), [range.from, range.to]);
  const refs = useRefs(['variants'], lang);
  return (
    <LoadState state={report}>
      {(r) => {
        const failures = Object.entries(r.failures_by_responsible);
        const failureTotal = failures.reduce((s, [, n]) => s + n, 0);
        const used = r.material_used.filter((m) => m.consumed > 0);
        const usedMax = Math.max(1, ...used.map((m) => m.consumed));
        return (
          <div className="space-y-4">
            <PeriodLine range={r.range} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiTile label={t(S.completed)} value={num(r.jobs.completed)} icon={<CheckCircle2 size={15} />} />
              <KpiTile label={t(S.failed)} value={num(r.jobs.failed)} icon={<AlertTriangle size={15} />} />
              <KpiTile label={t(S.failureRate)} value={r.jobs.completed + r.jobs.failed ? permille(r.jobs.failure_rate_permille) : '—'} icon={<Activity size={15} />} />
            </div>
            <Tray title={t(S.printers)} description={t(S.utilisationHelp)}>
              {r.printers.length === 0 ? (
                <p className={`text-[12.5px] ${T.text3}`}>{t(S.noPrinters)}</p>
              ) : (
                <ul className="space-y-3">
                  {r.printers.map((p) => (
                    <li key={p.id} className="space-y-1 text-[12.5px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`font-semibold ${T.text1}`}>{p.name}</span>
                        <span className={`tabular-nums ${T.text2}`}>
                          {t(S.printed)}: {duration(p.printed, lang)} · {t(S.jobs)}: {num(p.jobs)} · {t(S.utilisation)}: {permille(p.utilisation_permille)}
                        </span>
                      </div>
                      <Bar share={p.utilisation_permille / 1000} />
                    </li>
                  ))}
                </ul>
              )}
            </Tray>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Tray title={t(S.failuresBy)}>
                {failureTotal === 0 ? (
                  <p className={`text-[12.5px] ${T.text3}`}>{t(S.noFailures)}</p>
                ) : (
                  <ul className="space-y-2">
                    {failures.map(([who, n]) => (
                      <li key={who} className="space-y-1 text-[12.5px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className={T.text1}>{labelOf(RESPONSIBLE, who, lang)}</span>
                          <span className={`tabular-nums ${T.text2}`}>{num(n)}</span>
                        </div>
                        <Bar share={n / failureTotal} />
                      </li>
                    ))}
                  </ul>
                )}
              </Tray>
              <Tray title={t(S.materialUsed)} description={t(S.materialHelp)}>
                {used.length === 0 ? (
                  <p className={`text-[12.5px] ${T.text3}`}>{t(S.noMaterial)}</p>
                ) : (
                  <ul className="space-y-2">
                    {used.map((m) => (
                      <li key={m.variant_id} className="space-y-1 text-[12.5px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className={T.text1}>{refs.name('variants', m.variant_id)}</span>
                          <span className={`tabular-nums ${T.text2}`}>{qty(m.consumed, String(refs.row('variants', m.variant_id)?.unit_code ?? ''), lang)}</span>
                        </div>
                        <Bar share={m.consumed / usedMax} />
                      </li>
                    ))}
                  </ul>
                )}
              </Tray>
            </div>
          </div>
        );
      }}
    </LoadState>
  );
}

/** Parts of a total as rows with a bar each: the share is of the total, the figure is the server's. */
function Parts({ parts, total }: { parts: Array<[string, number]>; total: number }) {
  return (
    <ul className="space-y-2">
      {parts.map(([label, value]) => (
        <li key={label} className="space-y-1 text-[12.5px]">
          <div className="flex items-center justify-between gap-2">
            <span className={T.text2}>{label}</span>
            <Money iqd={value} />
          </div>
          <Bar share={total > 0 ? value / total : 0} />
        </li>
      ))}
    </ul>
  );
}

function Revenue({ range }: { range: { from: string; to: string } }) {
  const { t, lang } = usePcLang();
  const refs = useRefs(['categories'], lang);
  const report = useLoad(() => pc.get<RevenueReport>(`/reports/revenue${query(range)}`), [range.from, range.to]);
  return (
    <LoadState state={report}>
      {(r) => (
        <div className="space-y-4">
          <PeriodLine range={r.range} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label={t(S.cash)} value={<Money iqd={r.cash_collected.total} />} icon={<Coins size={15} />} hint={t(S.cashHelp)} />
            <KpiTile label={t(S.recognised)} value={<Money iqd={r.recognised_revenue.total} />} hint={t(S.recognisedHelp)} />
            <KpiTile label={t(S.deferred)} value={<Money iqd={r.deferred_liability_now.printing_hours + r.deferred_liability_now.materials} />} hint={t(S.deferredHelp)} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Tray title={t(S.cash)}>
              <Parts
                total={r.cash_collected.total}
                parts={[
                  [t(S.hours), r.cash_collected.printing_hours],
                  [t(S.materials), r.cash_collected.materials],
                  [t(S.deliveryFees), r.cash_collected.delivery_fees],
                ]}
              />
            </Tray>
            <Tray title={t(S.recognised)}>
              <Parts
                total={r.recognised_revenue.total}
                parts={[
                  [t(S.hours), r.recognised_revenue.printing_hours],
                  [t(S.materials), r.recognised_revenue.materials],
                  [t(S.deliveryFees), r.recognised_revenue.delivery_fees],
                ]}
              />
              {Object.keys(r.recognised_revenue.materials_by_category).length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className={`text-[11.5px] font-semibold ${T.text3}`}>{t(S.byCategory)}</p>
                  <Parts total={r.recognised_revenue.materials} parts={Object.entries(r.recognised_revenue.materials_by_category).map(([code, v]): [string, number] => [refs.name('categories', code), v])} />
                </div>
              )}
            </Tray>
            <Tray title={t(S.deferred)} description={t(S.deferredHelp)}>
              <KV
                rows={[
                  [t(S.hours), <Money key="h" iqd={r.deferred_liability_now.printing_hours} />],
                  [t(S.materials), <Money key="m" iqd={r.deferred_liability_now.materials} />],
                ]}
              />
            </Tray>
            <Tray title={`${t(S.refunds)} · ${t(S.buybacks)}`}>
              <KV
                rows={[
                  [t(S.refunds), <Money key="r" iqd={r.refunds_recorded} />],
                  [t(S.refundsUnused), <Money key="ru" iqd={r.refunds_of_unused_value} />],
                  [t(S.buybacksApproved), <Money key="ba" iqd={r.buybacks.approved_value} />],
                  [t(S.buybacksPaid), <Money key="bp" iqd={r.buybacks.paid_out} />],
                ]}
              />
            </Tray>
          </div>
        </div>
      )}
    </LoadState>
  );
}

function Profit({ range }: { range: { from: string; to: string } }) {
  const { t, lang } = usePcLang();
  const report = useLoad(() => pc.get<ProfitReport>(`/reports/profit${query(range)}`), [range.from, range.to]);
  const refs = useRefs(['variants'], lang);
  return (
    <LoadState state={report}>
      {(r) => {
        const o = r.operating_costs;
        return (
          <div className="space-y-4">
            <PeriodLine range={r.range} />
            {r.cost_complete ? (
              <Note tone="success">{t(S.costComplete)}</Note>
            ) : (
              <div className="space-y-2">
                <Note tone="warning">{t(S.costIncomplete)}</Note>
                {r.cost_pending.length > 0 && (
                  <Tray title={t(S.pendingUse)}>
                    <ul className="space-y-1 text-[12.5px]">
                      {r.cost_pending.map((p, i) => (
                        <li key={`${p.variant_id}-${p.entry_type}-${i}`} className={T.text2}>
                          {refs.name('variants', p.variant_id)} · {qty(p.qty, String(refs.row('variants', p.variant_id)?.unit_code ?? ''), lang)} · <bdi dir="ltr" className="font-mono">{p.entry_type}</bdi>
                        </li>
                      ))}
                    </ul>
                  </Tray>
                )}
                {r.lots_cost_pending.length > 0 && (
                  <p className={`text-[12px] ${T.text3}`}>
                    {t(S.pendingLots)}: {num(r.lots_cost_pending.length)}
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiTile label={t(S.recognised)} value={<Money iqd={r.recognised_revenue} />} />
              <KpiTile label={t(S.gross)} value={<Money iqd={r.gross_profit} />} />
              <KpiTile label={t(S.net)} value={<Money iqd={r.net_profit} />} />
            </div>
            <Tray title={t(S.operating)}>
              <KV
                rows={[
                  [t(S.cogs), <Money key="c" iqd={r.cost_of_material_used} />],
                  [t(S.waste), <Money key="w" iqd={o.material_waste_and_workshop_use} />],
                  [
                    t(S.electricity),
                    <span key="e">
                      <Money iqd={o.electricity_estimate} />
                      <span className={`block text-[11px] ${T.text3}`}>
                        {t(S.electricityBasis)} · {t(S.tariff)}: <bdi dir="ltr">{num(o.electricity_basis.tariff_iqd_per_kwh)}</bdi> {t(S.perKwh)}
                      </span>
                    </span>,
                  ],
                  [t(S.reserve), <Money key="r" iqd={o.maintenance_reserve} />],
                  [t(S.maintenance), <Money key="m" iqd={o.maintenance_recorded} />],
                  [t(S.depreciation), <Money key="d" iqd={o.depreciation} />],
                  r.material_cost_stated_after_use > 0 && [t(S.statedLater), <Money key="s" iqd={r.material_cost_stated_after_use} />],
                  [t(S.refunds), <Money key="rf" iqd={r.refunds_recorded} />],
                  [t(S.refundsUnused), <Money key="ru" iqd={r.refunds_of_unused_value} />],
                  [t(S.refundsEffect), <Money key="re" iqd={r.refunds_profit_effect} signed />],
                  [t(S.buybacksApproved), <Money key="b" iqd={r.buybacks_approved} />],
                ]}
              />
            </Tray>
          </div>
        );
      }}
    </LoadState>
  );
}
