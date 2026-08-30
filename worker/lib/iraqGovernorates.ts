/**
 * Iraq's eighteen governorates.
 *
 * A CLOSED LIST ON PURPOSE. The admin copies this field straight into a
 * courier's form, and couriers route on the governorate — "بغداد" and
 * "بقداد" and "Baghdad" are the same place to a person and three different
 * places to a dispatch system. Free text made that the admin's problem on
 * every single order.
 *
 * Ordered as the government lists them, not alphabetically, so the list reads
 * the way an Iraqi customer expects. Names are the official Arabic ones with
 * their common English and Kurdish forms; nothing here is translated by
 * machine.
 */
export interface Governorate {
  id: string;
  ar: string;
  en: string;
  ckb: string;
}

export const IRAQ_GOVERNORATES: Governorate[] = [
  { id: 'baghdad', ar: 'بغداد', en: 'Baghdad', ckb: 'بەغدا' },
  { id: 'basra', ar: 'البصرة', en: 'Basra', ckb: 'بەسرە' },
  { id: 'nineveh', ar: 'نينوى', en: 'Nineveh', ckb: 'نەینەوا' },
  { id: 'erbil', ar: 'أربيل', en: 'Erbil', ckb: 'هەولێر' },
  { id: 'sulaymaniyah', ar: 'السليمانية', en: 'Sulaymaniyah', ckb: 'سلێمانی' },
  { id: 'duhok', ar: 'دهوك', en: 'Duhok', ckb: 'دهۆک' },
  { id: 'kirkuk', ar: 'كركوك', en: 'Kirkuk', ckb: 'کەرکووک' },
  { id: 'diyala', ar: 'ديالى', en: 'Diyala', ckb: 'دیالە' },
  { id: 'anbar', ar: 'الأنبار', en: 'Anbar', ckb: 'ئەنبار' },
  { id: 'babil', ar: 'بابل', en: 'Babil', ckb: 'بابل' },
  { id: 'karbala', ar: 'كربلاء', en: 'Karbala', ckb: 'کەربەلا' },
  { id: 'najaf', ar: 'النجف', en: 'Najaf', ckb: 'نەجەف' },
  { id: 'wasit', ar: 'واسط', en: 'Wasit', ckb: 'واسیت' },
  { id: 'maysan', ar: 'ميسان', en: 'Maysan', ckb: 'مەیسان' },
  { id: 'dhi_qar', ar: 'ذي قار', en: 'Dhi Qar', ckb: 'زیقار' },
  { id: 'muthanna', ar: 'المثنى', en: 'Muthanna', ckb: 'موسەنا' },
  { id: 'qadisiyyah', ar: 'القادسية', en: 'Al-Qadisiyyah', ckb: 'قادسیە' },
  { id: 'salahuddin', ar: 'صلاح الدين', en: 'Salah Al-Din', ckb: 'سەلاحەدین' },
];

const BY_ID = new Map(IRAQ_GOVERNORATES.map((g) => [g.id, g]));

/** The stored id, or '' when the value is not one of the eighteen. */
export function normalizeGovernorate(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  if (!v) return '';
  if (BY_ID.has(v)) return v;
  // Accept a name in any of the three languages, so a client that sends the
  // label rather than the id still lands on the right governorate instead of
  // silently storing nothing.
  const found = IRAQ_GOVERNORATES.find(
    (g) => g.ar === v || g.en.toLowerCase() === v.toLowerCase() || g.ckb === v
  );
  return found ? found.id : '';
}

/** The display name for a stored id. Falls back to the raw value so an old
 *  row that holds a free-text governorate still shows what it holds. */
export function governorateName(id: string, lang: string): string {
  const g = BY_ID.get(id);
  if (!g) return id;
  return lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;
}
