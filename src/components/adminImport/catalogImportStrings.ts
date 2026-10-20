/**
 * «استيراد Bambu Lab» — THE DASHBOARD'S WORDS (the Bambu import spec §H.2,
 * §H.3; docs/DECISIONS.md rows 2, 183 and 241). Arabic, English and Sorani;
 * the Sorani is its own and never the Arabic pasted across (row 183;
 * tests/catalogImportDashboard.test.ts walks every entry).
 *
 * The state labels and the blocked item's resume instruction are the spec's
 * tables word for word. There is no word for «skip» or «advance the cursor»:
 * the dashboard has no such control (§H.2).
 */
export type ImportLang = 'ar' | 'en' | 'ckb';
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}
const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });
export const tri = (w: Tri, lang: ImportLang): string => w[lang] || w.en;

export type ItemState =
  | 'DISCOVERED'
  | 'EXTRACTING'
  | 'ENRICHING'
  | 'VALIDATING'
  | 'INGESTING_MEDIA'
  | 'WRITING'
  | 'PUBLISHING'
  | 'VERIFYING_LIVE'
  | 'COMPLETE'
  | 'RETRYING'
  | 'BLOCKED'
  | 'WITHDRAWN_AT_SOURCE';

/** §H.2 «State labels», exactly. */
export const ITEM_STATE_LABELS: Readonly<Record<ItemState, Tri>> = {
  DISCOVERED: t('مكتشَف', 'Discovered', 'دۆزراوە'),
  EXTRACTING: t('استخراج', 'Extracting', 'دەرهێنان'),
  ENRICHING: t('إثراء', 'Enriching', 'دەوڵەمەندکردن'),
  VALIDATING: t('تدقيق', 'Validating', 'پشکنین'),
  INGESTING_MEDIA: t('حفظ الصور', 'Saving images', 'پاشەکەوتکردنی وێنەکان'),
  WRITING: t('حفظ', 'Writing', 'پاشەکەوتکردن'),
  PUBLISHING: t('نشر', 'Publishing', 'بڵاوکردنەوە'),
  VERIFYING_LIVE: t('تحقق حي', 'Verifying live', 'پشتڕاستکردنەوەی ڕاستەوخۆ'),
  COMPLETE: t('مكتمل', 'Complete', 'تەواو'),
  RETRYING: t('إعادة المحاولة', 'Retrying', 'هەوڵدانەوە'),
  BLOCKED: t('متوقف لعائق', 'Blocked', 'ڕاگیراوە بەهۆی ڕێگرێک'),
  WITHDRAWN_AT_SOURCE: t('سُحب من المصدر (غير مكتمل)', 'Withdrawn at the source (not complete)', 'لە سەرچاوەوە کشێنرایەوە (تەواو نییە)'),
};

export const ITEM_STATES = Object.keys(ITEM_STATE_LABELS) as ItemState[];

/** §H.2: under a blocked item, after its blocker. */
export const RESUME_INSTRUCTION = t(
  'لاستئناف هذا المنتج: عالج السبب أعلاه ثم شغّل سير العمل 60 بوضع run مع resume.',
  'To resume this product: fix the cause above, then run workflow 60 in run mode with resume.',
  'بۆ دەستپێکردنەوەی ئەم بەرهەمە: هۆکارەکەی سەرەوە چارەسەر بکە، پاشان ڕێڕەوی کاری 60 بە دۆخی run لەگەڵ resume کار پێبکە.'
);

export type RunState = 'open' | 'running' | 'blocked' | 'closed' | 'partial';

export const RUN_STATE_LABELS: Readonly<Record<RunState, Tri>> = {
  open: t('مفتوح', 'Open', 'کراوە'),
  running: t('قيد التشغيل', 'Running', 'لە کارکردندایە'),
  blocked: t('متوقف لعائق', 'Blocked', 'ڕاگیراوە بەهۆی ڕێگرێک'),
  closed: t('مغلق', 'Closed', 'داخراوە'),
  partial: t('مغلق جزئياً', 'Closed (partial)', 'بە بەشێکی داخراوە'),
};

/** The progress fields of §H.3 the dashboard shows (counts only), with their words. */
export const PROGRESS_LABELS: ReadonlyArray<[string, Tri]> = [
  ['discovered_total', t('المكتشفة', 'Discovered', 'دۆزراوەکان')],
  ['queued_total', t('في الطابور', 'Queued', 'لە ڕیزدا')],
  ['complete_count', t('المكتملة', 'Complete', 'تەواوبووەکان')],
  ['remaining_count', t('المتبقية', 'Remaining', 'ماوەکان')],
  ['blocked_count', t('المتوقفة لعائق', 'Blocked', 'ڕاگیراوەکان')],
  ['withdrawn_count', t('المسحوبة من المصدر', 'Withdrawn at the source', 'کشێنراوەکان لە سەرچاوە')],
  ['created_count', t('منتجات جديدة', 'Created', 'بەرهەمی نوێ')],
  ['updated_existing_count', t('منتجات موجودة حُدّثت', 'Existing updated', 'بەرهەمی هەبوو نوێکراوەتەوە')],
  ['option_count', t('الخيارات', 'Options', 'هەڵبژاردەکان')],
  ['variant_count', t('التركيبات', 'Variants', 'جۆرەکان')],
  ['color_count', t('الألوان', 'Colours', 'ڕەنگەکان')],
  ['saved_media_count', t('الصور المحفوظة', 'Images saved', 'وێنە پاشەکەوتکراوەکان')],
  ['linked_variant_media_count', t('صور مربوطة بخيار', 'Images bound to a choice', 'وێنەی بەستراو بە هەڵبژاردە')],
  ['failed_media_count', t('صور تعذّر حفظها', 'Images failed', 'وێنەی پاشەکەوت نەکراو')],
  ['first_frame_media_count', t('صور GIF متحركة حُفظ إطارها الأول', 'Animated GIFs saved as their first frame', 'GIFی جووڵاو کە چوارچێوەی یەکەمی پاشەکەوت کرا')],
  ['extracted_specs_count', t('المواصفات المستخرجة', 'Specs extracted', 'تایبەتمەندییە دەرهێنراوەکان')],
  ['verified_specs_count', t('المواصفات المؤكَّدة', 'Specs verified', 'تایبەتمەندییە پشتڕاستکراوەکان')],
  ['document_count', t('المستندات', 'Documents', 'بەڵگەنامەکان')],
  ['tds_count', t('أوراق TDS', 'TDS sheets', 'پەڕەکانی TDS')],
  ['sds_count', t('أوراق SDS', 'SDS sheets', 'پەڕەکانی SDS')],
];

export const S = {
  title: t('استيراد Bambu Lab', 'Bambu Lab import', 'هاوردەکردنی Bambu Lab'),
  intro: t(
    'متابعة الاستيراد لمرة واحدة: منتج واحد في كل مرة، ولا يُكمَل منتج قبل التحقق منه على الموقع. هذه الصفحة للقراءة فقط.',
    'Following the one-time import: one product at a time, none complete before it is checked on the live site. This page is read-only.',
    'بەدواداچوونی هاوردەکردنی یەکجارەکی: هەر جارە یەک بەرهەم، و هیچ بەرهەمێک تەواو نابێت پێش ئەوەی لەسەر ماڵپەڕەکە پشتڕاست بکرێتەوە. ئەم پەڕەیە تەنها بۆ خوێندنەوەیە.'
  ),
  unavailable: t(
    'واجهة الاستيراد غير متاحة بعد على هذا الخادم.',
    'The import API is not available on this server yet.',
    'ڕووکاری هاوردەکردن هێشتا لەسەر ئەم ڕاژەکارە بەردەست نییە.'
  ),
  noRuns: t('لم يبدأ أي استيراد بعد.', 'No import has started yet.', 'هێشتا هیچ هاوردەکردنێک دەستی پێنەکردووە.'),
  loadFailed: t('تعذّر تحميل حالة الاستيراد.', 'The import state could not be loaded.', 'دۆخی هاوردەکردن بار نەکرا.'),
  retry: t('إعادة المحاولة', 'Try again', 'دووبارە هەوڵدانەوە'),
  run: t('التشغيل', 'Run', 'کارپێکردن'),
  started: t('البدء', 'Started', 'دەستپێک'),
  ended: t('الانتهاء', 'Ended', 'کۆتایی'),
  githubRun: t('تشغيل GitHub', 'GitHub run', 'کارپێکردنی GitHub'),
  reportJson: t('التقرير (JSON)', 'Report (JSON)', 'ڕاپۆرت (JSON)'),
  reportCsv: t('التقرير (CSV)', 'Report (CSV)', 'ڕاپۆرت (CSV)'),
  progress: t('التقدّم', 'Progress', 'پێشکەوتن'),
  current: t('المنتج الحالي', 'Current product', 'بەرهەمی ئێستا'),
  noCurrent: t('لا يُعالَج أي منتج الآن.', 'No product is being processed now.', 'ئێستا هیچ بەرهەمێک کاری لەسەر ناکرێت.'),
  stage: t('المرحلة', 'Stage', 'قۆناغ'),
  lastCheckpoint: t('آخر نقطة حفظ', 'Last checkpoint', 'دوایین خاڵی پاشەکەوت'),
  media: t('الصور', 'Images', 'وێنەکان'),
  options: t('الخيارات', 'Options', 'هەڵبژاردەکان'),
  lastVerified: t('آخر رابط تم التحقق منه', 'Last verified page', 'دوایین پەڕەی پشتڕاستکراو'),
  rate: t('المعدّل', 'Rate', 'ڕێژە'),
  perHour: t('منتج/ساعة', 'items / hour', 'بەرهەم / کاتژمێر'),
  median: t('الوسيط', 'Median', 'ناوەند'),
  p90: t('النسبة 90', 'P90', 'ڕێژەی 90'),
  eta: t('الانتهاء المتوقَّع (تقدير)', 'Expected finish (estimate)', 'کۆتایی چاوەڕوانکراو (خەمڵاندن)'),
  items: t('المنتجات', 'Products', 'بەرهەمەکان'),
  allStates: t('كل الحالات', 'All states', 'هەموو دۆخەکان'),
  search: t('بحث بالمعرّف أو العنوان', 'Search by handle or title', 'گەڕان بە ناسنامە یان ناونیشان'),
  loadMore: t('عرض المزيد', 'Show more', 'زیاتر پیشان بدە'),
  loadMoreFailed: t('تعذّر تحميل المزيد. حاول مرة أخرى.', 'Could not load more. Try again.', 'نەتوانرا زیاتر بار بکرێت. دووبارە هەوڵ بدەرەوە.'),
  noItems: t('لا منتجات بهذه الحالة.', 'No products in this state.', 'هیچ بەرهەمێک لەم دۆخەدا نییە.'),
  attempts: t('المحاولات', 'Attempts', 'هەوڵەکان'),
  position: t('الترتيب', 'Position', 'ڕیزبەندی'),
  livePage: t('الصفحة المنشورة', 'Live page', 'پەڕەی بڵاوکراوە'),
  blocker: t('سبب التوقف', 'Blocker', 'هۆکاری ڕاگرتن'),
  details: t('التفاصيل', 'Details', 'وردەکاری'),
  close: t('إغلاق', 'Close', 'داخستن'),
  events: t('السجل', 'Events', 'تۆمارەکان'),
  conflicts: t('التعارضات', 'Conflicts', 'ناکۆکییەکان'),
  missing: t('المعلومات الناقصة حسب السبب', 'Missing information by reason', 'زانیاریی کەم بەپێی هۆکار'),
  quality: t('مؤشرات الجودة', 'Quality counts', 'ژمارەکانی کوالیتی'),
  checks: t('فحوص الخادم مقابل فحوص الموقع', "The Worker's checks beside the live site's", 'پشکنینەکانی ڕاژەکار لەگەڵ پشکنینەکانی ماڵپەڕ'),
  d1Checks: t('فحوص الخادم', "Worker's checks", 'پشکنینەکانی ڕاژەکار'),
  edgeEvidence: t('ما شوهد على الموقع', 'Seen on the live site', 'ئەوەی لەسەر ماڵپەڕ بینرا'),
  mediaRows: t('ملفات الصور', 'Image files', 'فایلەکانی وێنە'),
  none: t('لا شيء', 'None', 'هیچ'),
  back: t('رجوع', 'Back', 'گەڕانەوە'),
} as const;
