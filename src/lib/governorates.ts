/**
 * Iraq's eighteen governorates, for the client.
 *
 * Mirrors worker/lib/iraqGovernorates.ts. Kept as a separate file rather than
 * imported across the boundary because the SPA and the Worker are built
 * independently — and pinned by tests/governorates.test.ts, so the two lists
 * cannot drift apart silently.
 */
export interface GovernorateOption {
  id: string;
  ar: string;
  en: string;
  ckb: string;
}

export const GOVERNORATES: GovernorateOption[] = [
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

export const GOVERNORATE_LABELS: Record<string, { ar: string; en: string; ckb: string }> =
  Object.fromEntries(GOVERNORATES.map((g) => [g.id, { ar: g.ar, en: g.en, ckb: g.ckb }]));
