/**
 * The shop's display rate WRITTEN FOR READING — «1,703.9167» — as text, never
 * through a float (FX programme plan §13). Its own module so the first paint
 * does not carry it: only the top-bar menu and the Settings page print a rate.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** «1,703.9167» — the rate grouped for reading; an unexpected shape is shown as sent. */
export function groupRateText(rateText: string): string {
  const m = DECIMAL.exec(rateText);
  if (!m) return rateText;
  const grouped = m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return m[2] ? `${grouped}.${m[2]}` : grouped;
}
