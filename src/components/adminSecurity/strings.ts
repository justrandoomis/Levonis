/**
 * «الأمان» — EVERY WORD OF THE OWNER'S SECURITY CONSOLE, IN ARABIC, ENGLISH
 * AND SORANI (DECISIONS rows 183, 206). Every `ckb` is its own Sorani, never
 * the Arabic or the English pasted across; tests/adminSecurity.test.ts walks
 * the table. Pure: no React, no request.
 */
import type { Language } from '../../translations';

type T = Record<Language, string>;
const t = (ar: string, en: string, ckb: string): T => ({ ar, en, ckb });

export const SECURITY_STRINGS = {
  tab: t('الأمان', 'Security', 'ئاسایش'),
  subtitle: t('الفخاخ والحظر وسجل الأمان', 'Decoys, blocks and the security log', 'تەڵەکان، قەدەغەکردن و تۆماری ئاسایش'),
  activeBlocks: t('حظر نشط', 'Active blocks', 'قەدەغەکردنی چالاک'),
  detections24h: t('اكتشافات آخر 24 ساعة', 'Detections (24 h)', 'دۆزینەوەکانی ٢٤ کاتژمێری ڕابردوو'),
  decoyHits7d: t('طلبات الملفات الوهمية (7 أيام)', 'Decoy hits (7 days)', 'داواکردنی پەڕگە ساختەکان (٧ ڕۆژ)'),
  canaryUses7d: t('استعمال بيانات الفخ (7 أيام)', 'Trap data used (7 days)', 'بەکارهێنانی زانیاریی تەڵە (٧ ڕۆژ)'),
  tabBlocks: t('الحظر', 'Blocks', 'قەدەغەکردنەکان'),
  tabLog: t('السجل', 'Log', 'تۆمار'),
  tabScores: t('النقاط', 'Scores', 'خاڵەکان'),
  showAll: t('عرض المرفوع والمنتهي أيضاً', 'Show lifted and expired too', 'لابراو و بەسەرچووەکانیش پیشان بدە'),
  more: t('المزيد', 'More', 'زیاتر'),
  kindAccount: t('حساب', 'Account', 'هەژمار'),
  kindDevice: t('جهاز', 'Device', 'ئامێر'),
  kindNetwork: t('شبكة', 'Network', 'تۆڕ'),
  reasonDecoy: t('طلب ملف وهمي', 'Requested a decoy file', 'داواکردنی پەڕگەی ساختە'),
  reasonCanary: t('استعمال بيانات فخّ', 'Used trap data', 'بەکارهێنانی زانیاریی تەڵە'),
  reasonScore: t('تراكم مؤشرات مشبوهة', 'Suspicious signals added up', 'کەڵەکەبوونی نیشانەی گومان'),
  until: t('حتى', 'Until', 'تا'),
  hits: t('محاولات بعد الحظر', 'Tries after the block', 'هەوڵەکانی دوای قەدەغەکردن'),
  lifted: t('مرفوع', 'Lifted', 'لابراو'),
  expired: t('منتهٍ', 'Expired', 'بەسەرچوو'),
  lift: t('رفع الحظر', 'Lift the block', 'لابردنی قەدەغەکردن'),
  liftIncident: t('رفع كل حظر هذه الحادثة', 'Lift every block of this incident', 'لابردنی هەموو قەدەغەکردنەکانی ئەم ڕووداوە'),
  liftConfirm: t(
    'رفع الحظر عن هذا الوصول؟ سيتمكّن من الدخول فوراً.',
    'Lift the block on this access? It can come in again at once.',
    'قەدەغەکردن لەسەر ئەم دەستگەیشتنە لاببرێت؟ دەستبەجێ دەتوانێت بچێتە ژوورەوە.'
  ),
  liftDone: t('رُفع الحظر.', 'The block was lifted.', 'قەدەغەکردنەکە لابرا.'),
  cancel: t('إلغاء', 'Cancel', 'پاشگەزبوونەوە'),
  details: t('التفاصيل', 'Details', 'وردەکاری'),
  close: t('إغلاق', 'Close', 'داخستن'),
  incident: t('الحادثة', 'Incident', 'ڕووداو'),
  reference: t('الرقم المرجعي', 'Reference', 'ژمارەی ئاماژە'),
  timeline: t('ما جرى', 'What happened', 'ئەوەی ڕوویدا'),
  evidence: t('الأدلة', 'Evidence', 'بەڵگەکان'),
  batch: t('دفعة بيانات الفخ', 'Trap data batch', 'کۆمەڵەی زانیاریی تەڵە'),
  firstUsed: t('أول استعمال', 'First used', 'یەکەم بەکارهێنان'),
  uses: t('مرات الاستعمال', 'Times used', 'ژمارەی بەکارهێنان'),
  notUsed: t('لم تُستعمل بعد', 'Not used yet', 'هێشتا بەکارنەهاتووە'),
  given: t('ما الذي أُعطي له', 'What he was given', 'چی پێدرا'),
  givenNote: t(
    'بيانات مزيّفة بالكامل، أُعيد توليدها من رقم الدفعة — لا شيء منها حقيقي.',
    'Entirely fake data, regenerated from the batch number — none of it is real.',
    'زانیاریی تەواو ساختە، لە ژمارەی کۆمەڵەکەوە دووبارە دروستکراوەتەوە — هیچ شتێکی ڕاستەقینە نییە.'
  ),
  empty: t('لا توجد حوادث — لم يقترب أحد من الفخاخ.', 'No incidents — nobody has come near the decoys.', 'هیچ ڕووداوێک نییە — کەس لە تەڵەکان نزیک نەبووەتەوە.'),
  emptyLog: t('السجل فارغ.', 'The log is empty.', 'تۆمارەکە بەتاڵە.'),
  emptyScores: t('لا نقاط حالياً.', 'No scores right now.', 'لە ئێستادا هیچ خاڵێک نییە.'),
  notInstalled: t(
    'جداول الحظر لم تُنشأ بعد على قاعدة البيانات هذه (الترحيل 0185).',
    'The block tables are not on this database yet (migration 0185).',
    'خشتەکانی قەدەغەکردن هێشتا لەسەر ئەم بنکەدراوەیە دروست نەکراون (گواستنەوەی 0185).'
  ),
  canariesOff: t(
    'بيانات الفخ متوقفة: لا يوجد مفتاح أمان في بيئة العامل. اضبط السر SECURITY_CANARY_KEY لتعمل الفخاخ والوسوم.',
    'Trap data is off: the Worker has no security key. Set the SECURITY_CANARY_KEY secret for the traps and device tags to work.',
    'زانیاریی تەڵە ڕاگیراوە: کلیلی ئاسایش لە ژینگەی وۆرکەردا نییە. نهێنیی SECURITY_CANARY_KEY دابنێ بۆ ئەوەی تەڵەکان و نیشانەکانی ئامێر کار بکەن.'
  ),
  failed: t('تعذّر التحميل. حاول مجدداً.', 'Could not load. Try again.', 'بارکردن سەرکەوتوو نەبوو. دووبارە هەوڵ بدەوە.'),
  retry: t('إعادة المحاولة', 'Retry', 'هەوڵدانەوە'),
  score: t('النقاط', 'Score', 'خاڵ'),
  signals: t('المؤشرات', 'Signals', 'نیشانەکان'),
  when: t('الوقت', 'When', 'کات'),
  count: t('العدد', 'Count', 'ژمارە'),
  code: t('الحدث', 'Event', 'ڕووداو'),
  route: t('المسار', 'Route', 'ڕێڕەو'),
  who: t('من', 'Who', 'کێ'),
  guest: t('زائر', 'Visitor', 'سەردانکەر'),
} as const;

export type SecurityStringKey = keyof typeof SECURITY_STRINGS;
export const securityText = (key: SecurityStringKey, lang: Language): string => SECURITY_STRINGS[key][lang] ?? SECURITY_STRINGS[key].ar;

/** The log's event codes, in words. Unknown codes show as themselves. */
export const EVENT_CODE_TEXT: Record<string, T> = {
  DECOY_HIT: t('طلب ملف وهمي', 'Decoy file requested', 'داواکردنی پەڕگەی ساختە'),
  DECOY_INDUCED: t('طلب ملف وهمي بلا قصد (صورة أو رابط خارجي)', 'Decoy requested without intent (an image or an outside link)', 'داواکردنی پەڕگەی ساختە بەبێ مەبەست (وێنە یان بەستەری دەرەکی)'),
  CANARY_USED: t('استُعملت بيانات فخّ', 'Trap data used', 'زانیاریی تەڵە بەکارهات'),
  CANARY_INDUCED: t('بيانات فخّ في رابط بلا قصد', 'Trap data in a link, without intent', 'زانیاریی تەڵە لە بەستەرێکدا بەبێ مەبەست'),
  CANARY_FLOOD: t('نصوص كثيرة تشبه بيانات الفخ لإخفاء واحدة منها', 'Many strings shaped like trap data, to hide one', 'زۆر دەقی وەک زانیاریی تەڵە، بۆ شاردنەوەی یەکێکیان'),
  CANARY_UNCONFIRMED: t('معرّف يشبه بيانات الفخ دون تأكيد', 'An id shaped like trap data, unconfirmed', 'ناسنامەیەک وەک زانیاریی تەڵە، پشتڕاستنەکراوە'),
  ACTOR_BLOCKED: t('حُظر الوصول', 'Access blocked', 'دەستگەیشتن قەدەغە کرا'),
  CLIENT_PRICE_FIELDS: t('أُرسلت حقول سعر أو تكلفة من المتصفح', 'Price or cost fields sent by the browser', 'خانەی نرخ یان تێچوو لە وێبگەڕەوە نێردرا'),
  INJECTION_PATTERN: t('محاولة حقن في الرابط', 'Injection attempt in the address', 'هەوڵی تێخستن لە ناونیشاندا'),
  TAMPER_PARAMS: t('عبث بمعاملات الرابط', 'Tampered address parameters', 'دەستکاریکردنی پارامەترەکانی ناونیشان'),
  AUTH_BRUTE_FORCE: t('محاولات دخول متكررة', 'Repeated sign-in attempts', 'هەوڵی دووبارەی چوونەژوورەوە'),
  IDOR_PROBE: t('محاولة الوصول إلى سجلات الآخرين', 'Tried to reach other people’s records', 'هەوڵدان بۆ گەیشتن بە تۆماری کەسانی تر'),
};
export const eventCodeText = (code: string, lang: Language): string => EVENT_CODE_TEXT[code]?.[lang] ?? code;
