import { Plus, X } from 'lucide-react';
import { Button, Field, Input, useLanguage } from './shared';

export type EmploymentPeriod = { from: string; to: string | null };
export const employmentDay = (value: string) => !value || value.length === 10 ? value : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const readEmploymentPeriods = (value?: string): EmploymentPeriod[] => JSON.parse(value || '[]') as EmploymentPeriod[];
export function validEmploymentPeriods(periods: EmploymentPeriod[]): boolean {
  const at = (value: string) => Date.parse(value.length === 10 ? `${value}T00:00:00+03:00` : value);
  const sorted = periods.map(p => ({ from: at(p.from), to: p.to ? at(p.to) : null })).sort((a, b) => a.from - b.from);
  return sorted.every((p, i) => Number.isFinite(p.from) && (p.to === null || Number.isFinite(p.to) && p.to > p.from) && (!i || sorted[i - 1].to !== null && p.from >= sorted[i - 1].to!));
}

export default function EmploymentPeriodsFields({ periods, onChange }: { periods: EmploymentPeriod[]; onChange: (value: EmploymentPeriod[]) => void }) {
  const { loc } = useLanguage();
  const today = employmentDay(new Date().toISOString());
  const update = (index: number, field: keyof EmploymentPeriod, value: string) => onChange(periods.map((p, i) => i === index ? { ...p, [field]: value || (field === 'to' ? null : '') } : p));
  return <section className="fp-stack" aria-label={loc('فترات التوقف والاستئناف', 'Pauses and resumptions')}>
    <h3>{loc('فترات التوقف والاستئناف', 'Pauses and resumptions')}</h3>
    <p className="fp-note">{loc('لا يُحتسب أجر من يوم الإيقاف حتى اليوم السابق للاستئناف. يبدأ الأجر مجددًا من يوم الاستئناف نفسه بتوقيت بغداد، وتبقى أجور ما قبل الإيقاف محفوظة.', 'No pay accrues from the pause date through the day before resumption. Pay resumes on the selected day in Baghdad time. Earlier earnings are preserved.')}</p>
    {periods.map((period, index) => <div className="fp-detail fp-stack" key={index}>
      <div className="fp-rule-heading"><strong>{loc(`فترة توقف ${index + 1}`, `Pause ${index + 1}`)}</strong><Button size="sm" variant="ghost" icon={<X size={14} />} aria-label={loc(`إزالة فترة التوقف ${index + 1}`, `Remove pause ${index + 1}`)} onClick={() => onChange(periods.filter((_, i) => i !== index))}>{loc('إزالة', 'Remove')}</Button></div>
      <Field label={loc('الإيقاف من يوم', 'Pause from')} required><Input type="date" dir="ltr" max={today} value={period.from ? employmentDay(period.from) : ''} onChange={e => update(index, 'from', e.target.value)} /></Field>
      <Field label={loc('استئناف العمل من يوم', 'Resume from')} optional hint={loc('اتركه فارغًا إذا كان التوقف مستمرًا. يمكن اختيار تاريخ استئناف قادم.', 'Leave empty while paused indefinitely. You can schedule a future resumption.')}><Input type="date" dir="ltr" value={period.to ? employmentDay(period.to) : ''} onChange={e => update(index, 'to', e.target.value)} /></Field>
    </div>)}
    {!periods.length && <p className="fp-muted">{loc('لا توجد فترات توقف مسجلة.', 'No pauses recorded.')}</p>}
    <Button size="sm" icon={<Plus size={14} />} disabled={periods.some(p => !p.to)} onClick={() => onChange([...periods, { from: today, to: null }])}>{loc('إضافة فترة توقف', 'Add pause')}</Button>
    {!validEmploymentPeriods(periods) && <p className="fp-negative" role="alert">{loc('اجعل الاستئناف بعد الإيقاف، دون تداخل بين الفترات.', 'Resumption must follow the pause date, with no overlapping intervals.')}</p>}
  </section>;
}
