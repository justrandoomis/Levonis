/**
 * «ملف الورشة» — THE WORKSHOP PROFILE'S WORDS (Phase 5d, docs/
 * COMMUNITY_ECOSYSTEM.md §9.5 «Store settings: a «ملف الورشة» section»):
 * Arabic, English and hand-written Sorani, every key in all three (decision
 * rows 166–168, D6 — no Arabic standing in).
 *
 * The section lives in ./StoreSettingsTab.tsx. Its words are a table of their
 * own rather than lines in the Counter's table (merchant/counter/strings.ts):
 * that table ships with the workspace shell, whose 25 KB budget these words
 * have no business spending — this one rides with the settings screen only.
 */
import { useLanguage } from '../../../LanguageContext';

export type WorkshopLang = 'ar' | 'en' | 'ckb';

const ar = {
  title: 'ملف الورشة',
  description: 'ما يعرفه الزبائن عن ورشتك: في صفحة متجرك، وحين تُرتَّب العروض على طلباتهم.',
  intro: 'نبذة عن الورشة',
  introHint: 'سطران أو ثلاثة: ما تطبعه وما تتقنه. تظهر في صفحة متجرك.',
  introPlaceholder: 'مثل: ورشة في بغداد، نطبع قطع الغيار والمجسمات بدقة عالية منذ 2021.',
  turnaround: 'مدة التنفيذ المعتادة',
  // Latin digits, as the field's own error and counter write them (one digit system in the card).
  turnaroundHint: 'بالأيام، من 1 إلى 60. تقدّم ورشتك في ترتيب العروض، ولا تمنعك من أي طلب.',
  days: 'يوم',
  fromPrinters: 'من طابعاتك',
  fromPrintersHint: 'تُحسب تلقائيًا من الطابعات الفعّالة، ولا تُعدَّل من هنا.',
  technologies: 'التقنيات',
  build: 'أكبر حجم طباعة',
  buildValue: '{size} مم',
  noPrinters: 'لا طابعات فعّالة بعد',
  resin: 'ريزن',
  doorPrinters: 'طابعاتي',
  doorStock: 'مخزون الخامات',
  doorPrefs: 'تفضيلات الطلبات',
  save: 'احفظ ملف الورشة',
  saving: 'جارٍ الحفظ…',
  saved: 'حُفظ ملف الورشة.',
  unsaved: 'تغييرات غير محفوظة',
  failed: 'تعذّر حفظ ملف الورشة.',
  loadFailed: 'تعذّر تحميل ملف الورشة.',
  count: '{n} من {max}',
};

export type WorkshopStrings = typeof ar;

const en: WorkshopStrings = {
  title: 'Workshop profile',
  description: 'What customers know about your workshop: on your store page, and when offers on their requests are ranked.',
  intro: 'About the workshop',
  introHint: 'Two or three lines: what you print and what you do best. Shown on your store page.',
  introPlaceholder: 'e.g. A workshop in Baghdad printing spare parts and detailed models since 2021.',
  turnaround: 'Usual turnaround',
  turnaroundHint: 'In days, 1 to 60. It moves your workshop up in the offer ranking and never keeps you from a request.',
  days: 'days',
  fromPrinters: 'From your printers',
  fromPrintersHint: 'Worked out from your active printers; not edited here.',
  technologies: 'Technologies',
  build: 'Largest print',
  buildValue: '{size} mm',
  noPrinters: 'No active printers yet',
  resin: 'Resin',
  doorPrinters: 'My printers',
  doorStock: 'Material stock',
  doorPrefs: 'Request preferences',
  save: 'Save the workshop profile',
  saving: 'Saving…',
  saved: 'Workshop profile saved.',
  unsaved: 'Unsaved changes',
  failed: 'Could not save the workshop profile.',
  loadFailed: 'Could not load the workshop profile.',
  count: '{n} of {max}',
};

const ckb: WorkshopStrings = {
  title: 'پرۆفایلی وۆرکشۆپ',
  description: 'ئەوەی کڕیاران دەربارەی وۆرکشۆپەکەت دەیزانن: لە لاپەڕەی فرۆشگاکەت، و کاتێک ئۆفەرەکان لەسەر داواکارییەکانیان ڕیز دەکرێن.',
  intro: 'دەربارەی وۆرکشۆپەکە',
  introHint: 'دوو یان سێ دێڕ: چی چاپ دەکەیت و لە چیدا لێهاتوویت. لە لاپەڕەی فرۆشگاکەت دەردەکەوێت.',
  introPlaceholder: 'بۆ نموونە: وۆرکشۆپێک لە بەغدا، لە ساڵی 2021ـەوە پارچەی یەدەگ و مۆدێلی ورد چاپ دەکەین.',
  turnaround: 'ماوەی ئاسایی جێبەجێکردن',
  turnaroundHint: 'بە ڕۆژ، لە 1 تا 60. وۆرکشۆپەکەت لە ڕیزبەندی ئۆفەرەکاندا بەرز دەکاتەوە، و ڕێگرت نابێت لە هیچ داواکارییەک.',
  days: 'ڕۆژ',
  fromPrinters: 'لە چاپکەرەکانتەوە',
  fromPrintersHint: 'بە شێوەی خۆکار لە چاپکەرە چالاکەکانتەوە هەژمار دەکرێن، و لێرەوە دەستکاری ناکرێن.',
  technologies: 'تەکنەلۆژیاکان',
  build: 'گەورەترین قەبارەی چاپ',
  buildValue: '{size} میلیمەتر',
  noPrinters: 'هێشتا هیچ چاپکەرێکی چالاک نییە',
  resin: 'ڕەزین',
  doorPrinters: 'چاپکەرەکانم',
  doorStock: 'کۆگای ماددەکان',
  doorPrefs: 'ڕێکخستنەکانی داواکاری',
  save: 'پرۆفایلی وۆرکشۆپ پاشەکەوت بکە',
  saving: 'پاشەکەوت دەکرێت…',
  saved: 'پرۆفایلی وۆرکشۆپ پاشەکەوت کرا.',
  unsaved: 'گۆڕانکاریی پاشەکەوت نەکراو',
  failed: 'نەتوانرا پرۆفایلی وۆرکشۆپ پاشەکەوت بکرێت.',
  loadFailed: 'نەتوانرا پرۆفایلی وۆرکشۆپ باربکرێت.',
  count: '{n} لە {max}',
};

export const WORKSHOP_STRINGS: Record<WorkshopLang, WorkshopStrings> = { ar, en, ckb };

export function workshopLang(lang: string): WorkshopLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

export function useWorkshopStrings(): WorkshopStrings {
  const { lang } = useLanguage();
  return WORKSHOP_STRINGS[workshopLang(lang)];
}

/** `{x}`, `{n}` … filled in the sentence's own order. */
export function fillWorkshop(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
}
