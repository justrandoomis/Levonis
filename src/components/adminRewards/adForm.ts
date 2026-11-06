/**
 * THE AD FORM'S DATES (Admin → المكافآت → الإعلانات; migration 0227; DECISIONS row
 * 300). Pure, so they are proven without a browser. `datetime-local` speaks the
 * admin's own clock; the server speaks instants, and decides everything else.
 */

/** `yyyy-mm-ddThh:mm` in the admin's own clock, for a `datetime-local`. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How many dates the owner's first ad runs: «the ads will run for 10 days». */
export const AD_DEFAULT_DAYS = 10;

/**
 * THE WINDOW THE FORM STARTS WITH, and they may change it: from now to the last
 * minute of the tenth date, counting today as the first. Ten days added and then
 * run to 23:59 covered eleven dates.
 */
export function defaultAdWindow(now: Date = new Date()): { starts_at: string; ends_at: string } {
  const end = new Date(now);
  end.setDate(end.getDate() + AD_DEFAULT_DAYS - 1);
  end.setHours(23, 59, 0, 0);
  return { starts_at: toLocalInput(now.toISOString()), ends_at: toLocalInput(end.toISOString()) };
}

/**
 * The form's two fields as the server's instants, or null when either is empty or
 * not a date. `new Date('').toISOString()` throws, and that left the form on a
 * spinner for ever with no sentence: the form asks this first, and words a null.
 */
export function adWindowIso(form: { starts_at: string; ends_at: string }): { starts_at: string; ends_at: string } | null {
  const iso = (value: string) => {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  };
  const starts_at = iso(form.starts_at);
  const ends_at = iso(form.ends_at);
  return starts_at && ends_at ? { starts_at, ends_at } : null;
}
