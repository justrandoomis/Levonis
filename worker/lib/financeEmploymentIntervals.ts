import { badRequest } from './http';
import { dateValue } from './operations';

export type EmploymentInterval = { from: string; to: string | null };
type EmploymentState = { active: number; archived_at: string | null; inactive_periods_json: string };

export const inactiveAtSql = (periods: string, at: string) => `EXISTS(SELECT 1 FROM json_each(${periods}) ip WHERE julianday(${at})>=julianday(json_extract(ip.value,'$.from')) AND (json_extract(ip.value,'$.to') IS NULL OR julianday(${at})<julianday(json_extract(ip.value,'$.to'))))`;
export const inactiveAt = (periods: EmploymentInterval[], at: number) => periods.some(p => at >= Date.parse(p.from) && (!p.to || at < Date.parse(p.to)));
export function staffActiveAt(staff: EmploymentState, at = Date.now()): boolean {
  if (staff.archived_at) return false;
  const periods = JSON.parse(staff.inactive_periods_json) as EmploymentInterval[];
  // Intervals also describe scheduled resumptions; a cached active flag must
  // not keep someone paused after the saved resume boundary has passed.
  return periods.length ? !inactiveAt(periods, at) : !!staff.active;
}

/** Calendar inputs are Baghdad midnight, with an exclusive resume boundary.
 * Preserve existing timestamp precision when an old interval is left alone. */
export function employmentIntervals(value: unknown): EmploymentInterval[] {
  if (!Array.isArray(value) || value.length > 200) throw badRequest('فترات التوقف غير صحيحة');
  const boundary = (input: unknown): string => {
    if (typeof input !== 'string') throw badRequest('اختر تاريخًا صحيحًا لفترة التوقف');
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return new Date(`${dateValue(input)}T00:00:00+03:00`).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
      throw badRequest('اختر تاريخًا صحيحًا لفترة التوقف');
    return input;
  };
  const periods = value.map((item): EmploymentInterval => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('فترة التوقف غير صحيحة');
    const from = boundary(item.from), to = item.to === null || item.to === '' ? null : boundary(item.to);
    if (Date.parse(from) > Date.now()) throw badRequest('لا يمكن تسجيل إيقاف يبدأ في المستقبل؛ يمكنك تحديد استئناف مستقبلي');
    if (to && to <= from) throw badRequest('يجب أن يأتي تاريخ الاستئناف بعد تاريخ الإيقاف');
    return { from, to };
  }).sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < periods.length; i++) {
    if (!periods[i - 1].to || periods[i].from < periods[i - 1].to!) throw badRequest('فترات التوقف متداخلة؛ صحح التواريخ أولًا');
  }
  return periods;
}
