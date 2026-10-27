/**
 * «استوديو Levonis الإبداعي» — EVERY WORD OF THE STUDIO, IN ARABIC, ENGLISH AND
 * SORANI (DECISIONS row 183: a ckb slot is its own Sorani, never the Arabic or
 * the English pasted across). Feature-local on purpose: these strings ride in
 * the studio’s lazy chunk, never in `translations.ts`, which every first page
 * load downloads. tests/creativeStudioUiStrings.test.ts walks every table
 * below, including a sentence for EVERY server error code in
 * packages/creativeDoc/src/api.ts. Pure: no React, no request.
 */
import type { Language } from '../../translations';
import type { AssetKind, DocStatus, Effort, ErrorCode, ExportKind, JobStatus, OpportunityDto, VersionOrigin, AiTask, RejectReason } from '../../../packages/creativeDoc/src/api';
import type { CheckName, QualityCode } from '../../../packages/creativeDoc/src/quality';
import type { ConflictCode, ConflictOption } from '../../../packages/creativeDoc/src/layout';
import type { RefusalCode } from '../../../packages/creativeDoc/src/ops';
import type { Annotation, Density, FormatId, LayerRole, Objective, VisualPriority } from '../../../packages/creativeDoc/src/schema';
import type { PriceStatus, SnapshotAvailability, SnapshotChange } from '../../../packages/creativeDoc/src/snapshot';

export type Lang = Language;
export interface Tri { ar: string; en: string; ckb: string }
const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

/** One entry in the reader’s language. */
export function tx(entry: Tri, lang: Lang): string {
  return entry[lang] || entry.en;
}

/** `{n}`-style placeholders filled in after the language is picked. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export const S = {
  // Shell
  studioTitle: t('استوديو Levonis الإبداعي', 'Levonis Creative Studio', 'ستۆدیۆی داهێنەرانەی Levonis'),
  studioShort: t('الاستوديو الإبداعي', 'Creative Studio', 'ستۆدیۆی داهێنەرانە'),
  backToAdmin: t('العودة إلى لوحة الإدارة', 'Back to the admin', 'گەڕانەوە بۆ پانێڵی بەڕێوەبردن'),
  tabHome: t('الرئيسية', 'Home', 'سەرەکی'),
  tabNew: t('تصميم جديد', 'New design', 'دیزاینی نوێ'),
  tabEditor: t('المحرر', 'Editor', 'دەستکاریکەر'),
  tabBrand: t('الهوية', 'Brand', 'ناسنامەی براند'),
  tabAssets: t('الأصول', 'Assets', 'کەرەستەکان'),
  tabArchive: t('الأرشيف', 'Archive', 'ئەرشیف'),
  tabSettings: t('الإعدادات', 'Settings', 'ڕێکخستنەکان'),
  loading: t('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…'),
  retry: t('أعد المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە'),
  close: t('إغلاق', 'Close', 'داخستن'),
  cancel: t('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
  save: t('حفظ', 'Save', 'پاشەکەوتکردن'),
  apply: t('تطبيق', 'Apply', 'جێبەجێکردن'),
  discard: t('تجاهل', 'Discard', 'فڕێدان'),
  open: t('فتح', 'Open', 'کردنەوە'),
  next: t('التالي', 'Next', 'دواتر'),
  back: t('رجوع', 'Back', 'گەڕانەوە'),
  remove: t('حذف', 'Delete', 'سڕینەوە'),
  none: t('لا شيء', 'None', 'هیچ'),
  yes: t('نعم', 'Yes', 'بەڵێ'),
  no: t('لا', 'No', 'نەخێر'),
  notMigrated: t('جداول الاستوديو غير موجودة بعد في قاعدة البيانات. يعمل الاستوديو بعد تطبيق الترحيل.', 'The studio tables are not in the database yet. The studio works once the migration is applied.', 'خشتەکانی ستۆدیۆ هێشتا لە بنکەدراوەکەدا نین. ستۆدیۆکە دوای جێبەجێکردنی گواستنەوەکە کار دەکات.'),
  assistantRefused: t('الاستوديو للمالك والمسؤولين بصلاحية كاملة فقط.', 'The studio is for the owner and full-scope admins only.', 'ستۆدیۆکە تەنها بۆ خاوەن و بەڕێوەبەرانی دەسەڵاتی تەواوە.'),

  // Home
  homeQuestion: t('شنو أنشر اليوم؟', 'What should I post today?', 'ئەمڕۆ چی بڵاو بکەمەوە؟'),
  homeEvidenceNote: t('هذه فرص محسوبة من سجلات المتجر نفسها، وتظهر مع الذكاء الاصطناعي أو بدونه.', 'These are computed from the shop’s own records and show with or without AI.', 'ئەمانە لە تۆمارەکانی فرۆشگا خۆیەوە هەژمار کراون و لەگەڵ یان بەبێ AI پیشان دەدرێن.'),
  homeNoOpportunities: t('لا توجد فرص مسجلة الآن. ابدأ تصميماً من منتج أو خدمة.', 'No opportunities are recorded right now. Start a design from a product or a service.', 'ئێستا هیچ دەرفەتێک تۆمار نەکراوە. دیزاینێک لە بەرهەمێک یان خزمەتگوزارییەکەوە دەست پێ بکە.'),
  homeIdeas: t('أفكار Claude', 'Claude’s ideas', 'بیرۆکەکانی Claude'),
  homeAskIdeas: t('اطلب أفكاراً', 'Ask for ideas', 'داوای بیرۆکە بکە'),
  homeIdeaWhy: t('لماذا', 'Why', 'بۆچی'),
  homeIdeaEvidence: t('الدليل', 'Evidence', 'بەڵگە'),
  homeUseIdea: t('صمّم من هذه الفكرة', 'Design from this idea', 'لەم بیرۆکەیەوە دیزاین بکە'),
  homeIdeasRejected: t('رُفضت {n} أفكار لم تحقق القواعد.', '{n} ideas were refused for breaking the rules.', '{n} بیرۆکە ڕەتکرانەوە چونکە یاساکانیان نەپاراست.'),
  homeRecent: t('آخر المسودات', 'Recent drafts', 'دوایین ڕەشنووسەکان'),
  homeNoDrafts: t('لا توجد مسودات بعد.', 'No drafts yet.', 'هێشتا هیچ ڕەشنووسێک نییە.'),
  homeStartProduct: t('منشور منتج', 'Product post', 'پۆستی بەرهەم'),
  homeStartService: t('منشور خدمة', 'Service post', 'پۆستی خزمەتگوزاری'),

  // AI readiness
  aiNotReady: t('الذكاء الاصطناعي غير جاهز', 'AI is not ready', 'AI ئامادە نییە'),
  aiManualStillWorks: t('التحرير اليدوي يعمل كالمعتاد.', 'Manual editing keeps working.', 'دەستکاریی دەستی وەک خۆی کار دەکات.'),
  aiGoSettings: t('افتح الإعدادات', 'Open settings', 'ڕێکخستنەکان بکەرەوە'),
  aiBusy: t('Claude يعمل…', 'Claude is working…', 'Claude کار دەکات…'),
  aiEstimated: t('تقديري', 'estimated', 'خەمڵێنراو'),

  // New design flow
  newStepProduct: t('المنتج', 'Product', 'بەرهەم'),
  newStepVariant: t('النسخة', 'Variant', 'جۆر'),
  newStepPicture: t('الصورة', 'Picture', 'وێنە'),
  newStepGoal: t('الهدف والأولوية', 'Goal and priority', 'ئامانج و پێشینە'),
  newStepTemplate: t('القالب', 'Template', 'قاڵب'),
  newStepCompose: t('التكوينات', 'Compositions', 'پێکهاتەکان'),
  newSearch: t('ابحث عن منتج بالاسم', 'Search a product by name', 'بەدوای بەرهەمێکدا بگەڕێ بە ناو'),
  newSearchEmpty: t('لا توجد منتجات بهذا الاسم.', 'No product has that name.', 'هیچ بەرهەمێک بەم ناوە نییە.'),
  newNoVariants: t('هذا المنتج بلا نسخ: يُستعمل المنتج كله.', 'This product has no variants: the product as a whole is used.', 'ئەم بەرهەمە جۆری نییە: هەموو بەرهەمەکە بەکار دێت.'),
  newWholeProduct: t('المنتج كله', 'The whole product', 'هەموو بەرهەمەکە'),
  newRemotePicture: t('صورة من موقع آخر — لا يمكن رسمها في التصدير', 'A picture from another site — it cannot be drawn into an export', 'وێنەیەک لە ماڵپەڕێکی ترەوە — ناتوانرێت لە هەناردەدا بکێشرێت'),
  newNoPictures: t('لا توجد صورة من المتجر لهذه النسخة يمكن رسمها.', 'This variant has no shop picture that can be drawn.', 'ئەم جۆرە هیچ وێنەیەکی فرۆشگای نییە کە بکێشرێت.'),
  newPictureSize: t('{w}×{h} بكسل', '{w}×{h} px', '{w}×{h} پیکسڵ'),
  newObjective: t('هدف المنشور', 'The post’s goal', 'ئامانجی پۆستەکە'),
  newPriority: t('ما الذي يبرز أولاً', 'What stands out first', 'چی یەکەم دەردەکەوێت'),
  newDensity: t('كثافة النص', 'Amount of text', 'بڕی دەق'),
  newFormat: t('المقاس', 'Size', 'قەبارە'),
  newLocale: t('لغة الإعلان', 'Ad language', 'زمانی ڕیکلام'),
  newTemplateAuto: t('اختير لهذا القالب من نسب الصورة الحقيقية؛ يمكنك تغييره.', 'Picked from the picture’s real proportions; you can switch it.', 'بەپێی ڕێژەی ڕاستەقینەی وێنەکە هەڵبژێردرا؛ دەتوانیت بیگۆڕیت.'),
  newBrief: t('كلماتك عن هذا المنشور (اختياري)', 'Your words about this post (optional)', 'وشەکانت دەربارەی ئەم پۆستە (ئارەزوومەندانە)'),
  newComposeAi: t('اقترح ثلاثة تكوينات مع Claude', 'Propose three compositions with Claude', 'سێ پێکهاتە لەگەڵ Claude پێشنیار بکە'),
  newManualCopy: t('النص بيدك', 'Your own copy', 'دەقی خۆت'),
  newManualHint: t('اكتب العنوان والنص؛ السعر والتوفر واسم المنتج تُرسم من بيانات المتجر ولا تُكتب هنا.', 'Write the headline and copy; the price, availability and product name are drawn from store data and are not typed here.', 'سەردێڕ و دەقەکە بنووسە؛ نرخ و بەردەستبوون و ناوی بەرهەم لە داتای فرۆشگاوە دەکێشرێن و لێرە نانووسرێن.'),
  newHeadline: t('العنوان', 'Headline', 'سەردێڕ'),
  newSubhead: t('سطر ثانوي', 'Subhead', 'هێڵی لاوەکی'),
  newFeatures: t('ميزات (سطر لكل ميزة)', 'Features (one per line)', 'تایبەتمەندییەکان (هەر هێڵێک بۆ یەکێک)'),
  newCta: t('الدعوة للإجراء', 'Call to action', 'بانگەواز بۆ کردار'),
  newBuild: t('ابنِ التكوينات', 'Build the compositions', 'پێکهاتەکان دروست بکە'),
  newChoose: t('اختر هذا التكوين', 'Choose this composition', 'ئەم پێکهاتەیە هەڵبژێرە'),
  newCreating: t('جارٍ إنشاء التصميم…', 'Creating the design…', 'دیزاینەکە دروست دەکرێت…'),
  newProposalReason: t('السبب', 'Reason', 'هۆکار'),
  newProposalDropped: t('حُذف لعدم المساحة: {list}', 'Left out for lack of room: {list}', 'بەهۆی نەبوونی شوێن لابرا: {list}'),
  newProposalConflicts: t('يحتاج مراجعة: {list}', 'Needs a look: {list}', 'پێویستی بە سەیرکردنە: {list}'),
  newMissingFacts: t('معلومات ناقصة طلبها Claude: {list}', 'Facts Claude asked for: {list}', 'زانیاریی کەم کە Claude داوای کرد: {list}'),
  newHeadlineRequired: t('اكتب عنواناً أولاً.', 'Write a headline first.', 'سەرەتا سەردێڕێک بنووسە.'),
  newPriceInCopy: t('النص يحتوي سعراً أو رقماً كبيراً. السعر يُرسم من بيانات المتجر فقط.', 'The copy contains a price or a large number. The price is drawn from store data only.', 'دەقەکە نرخ یان ژمارەیەکی گەورەی تێدایە. نرخ تەنها لە داتای فرۆشگاوە دەکێشرێت.'),
  newServiceTitle: t('منشور خدمة من مطالبة معتمدة', 'A service post from an approved claim', 'پۆستی خزمەتگوزاری لە بانگەشەیەکی پەسەندکراوەوە'),
  newNoClaims: t('لا توجد مطالبات خدمة معتمدة. يضيفها المالك ويعتمدها أولاً.', 'There are no approved service claims. The owner adds and approves them first.', 'هیچ بانگەشەیەکی خزمەتگوزاریی پەسەندکراو نییە. خاوەن سەرەتا زیادیان دەکات و پەسەندیان دەکات.'),
  newClaimConditions: t('الشروط', 'Conditions', 'مەرجەکان'),
  newTestSnapshot: t('بيانات تجريبية — ليست سعراً حقيقياً', 'Test data — not a real price', 'داتای تاقیکاری — نرخی ڕاستەقینە نییە'),

  // Editor chrome
  saveIdle: t('لا تغييرات', 'No changes', 'هیچ گۆڕانکارییەک نییە'),
  saveDirty: t('تغييرات لم تُحفظ', 'Unsaved changes', 'گۆڕانکاریی پاشەکەوتنەکراو'),
  saveSaving: t('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…'),
  saveSaved: t('محفوظ', 'Saved', 'پاشەکەوت کرا'),
  saveFailed: t('فشل الحفظ', 'Save failed', 'پاشەکەوتکردن سەرکەوتوو نەبوو'),
  saveOffline: t('لا اتصال — المسودة محفوظة على هذا الجهاز', 'Offline — the draft is kept on this device', 'پەیوەندی نییە — ڕەشنووسەکە لەسەر ئەم ئامێرە پارێزراوە'),
  saveConflict: t('تعارض نسخة', 'Version conflict', 'ناکۆکیی وەشان'),
  saveVersion: t('النسخة {n}', 'Version {n}', 'وەشانی {n}'),
  conflictTitle: t('غيّر شخص آخر هذا التصميم', 'Someone else changed this design', 'کەسێکی تر ئەم دیزاینەی گۆڕیوە'),
  conflictBody: t('النسخة على الخادم أحدث من التي بدأت منها. لن يُستبدل عمل أحد بصمت.', 'The server copy is newer than the one you started from. Nobody’s work is overwritten silently.', 'وەشانی سەر ڕاژەکار نوێترە لەوەی تۆ لێیەوە دەستت پێکرد. کاری هیچ کەسێک بە بێدەنگی ناگۆڕدرێت.'),
  conflictReload: t('افتح نسختهم', 'Open their version', 'وەشانەکەی ئەوان بکەرەوە'),
  conflictKeepMine: t('احفظ نسختي كتصميم جديد', 'Keep mine as a new design', 'وەشانەکەی من وەک دیزاینێکی نوێ پاشەکەوت بکە'),
  recoveryTitle: t('مسودة محلية أحدث', 'A newer local draft', 'ڕەشنووسێکی ناوخۆیی نوێتر'),
  recoveryBody: t('على هذا الجهاز نسخة من {time} لم تصل إلى الخادم.', 'This device holds a copy from {time} that never reached the server.', 'ئەم ئامێرە کۆپییەکی {time}ی هەیە کە نەگەیشتووەتە ڕاژەکار.'),
  recoveryRestore: t('استعد المسودة', 'Restore the draft', 'ڕەشنووسەکە بگەڕێنەرەوە'),
  recoveryDrop: t('احذفها', 'Delete it', 'بیسڕەوە'),
  leaveUnsaved: t('في التصميم تغييرات لم تُحفظ بعد. هل تغادر؟', 'The design has unsaved changes. Leave anyway?', 'دیزاینەکە گۆڕانکاریی پاشەکەوتنەکراوی تێدایە. هەر دەڕۆیت؟'),
  undo: t('تراجع', 'Undo', 'گەڕانەوە'),
  redo: t('إعادة', 'Redo', 'دووبارەکردنەوە'),
  zoomIn: t('تكبير', 'Zoom in', 'گەورەکردن'),
  zoomOut: t('تصغير', 'Zoom out', 'بچووککردنەوە'),
  zoomFit: t('ملاءمة الشاشة', 'Fit to screen', 'گونجاندن لەگەڵ شاشە'),
  panelLayers: t('الطبقات', 'Layers', 'چینەکان'),
  panelProperties: t('الخصائص', 'Properties', 'تایبەتمەندییەکان'),
  panelAssets: t('الأصول', 'Assets', 'کەرەستەکان'),
  panelChat: t('المحادثة', 'Chat', 'گفتوگۆ'),
  panelQa: t('الفحص', 'Checks', 'پشکنین'),
  panelPhone: t('الهاتف', 'Phone', 'مۆبایل'),
  panelExport: t('التصدير', 'Export', 'هەناردەکردن'),
  panelFormats: t('المقاسات', 'Sizes', 'قەبارەکان'),
  showPanel: t('أظهر {name}', 'Show {name}', '{name} پیشان بدە'),
  hidePanel: t('أخفِ {name}', 'Hide {name}', '{name} بشارەوە'),
  editorEmpty: t('افتح تصميماً من الرئيسية أو الأرشيف، أو ابدأ تصميماً جديداً.', 'Open a design from Home or the Archive, or start a new one.', 'دیزاینێک لە سەرەکی یان ئەرشیفەوە بکەرەوە، یان دیزاینێکی نوێ دەست پێ بکە.'),
  editorLoadFailed: t('تعذر فتح التصميم.', 'The design could not be opened.', 'نەتوانرا دیزاینەکە بکرێتەوە.'),
  editorTitle: t('اسم التصميم', 'Design name', 'ناوی دیزاین'),
  fontsLoading: t('جارٍ تحميل الخطوط…', 'Loading fonts…', 'فۆنتەکان بار دەکرێن…'),
  fontFailed: t('تعذر تحميل الخط {name}. لن يُستبدل بخط آخر؛ يظهر كمشكلة في الفحص.', 'The font {name} could not be loaded. It is not replaced by another; it shows as a problem in the checks.', 'فۆنتی {name} بار نەکرا. بە فۆنتێکی تر ناگۆڕدرێت؛ لە پشکنیندا وەک کێشە پیشان دەدرێت.'),
  imageFailed: t('تعذر تحميل صورة في التصميم.', 'A picture in the design could not be loaded.', 'وێنەیەک لە دیزاینەکەدا بار نەکرا.'),
  refused: t('لم يُطبّق التعديل:', 'The edit was not applied:', 'دەستکارییەکە جێبەجێ نەکرا:'),
  canvasLabel: t('لوحة التصميم. اضغط مزدوجاً على نص لتعديله.', 'Design canvas. Double-click a text to edit it.', 'تابلۆی دیزاین. دووجار کرتە لەسەر دەقێک بکە بۆ دەستکاریکردنی.'),
  testDataBanner: t('هذا التصميم مبني على بيانات تجريبية موسومة', 'This design is built on marked test data', 'ئەم دیزاینە لەسەر داتای تاقیکاریی نیشانکراو دروستکراوە'),
  rebuildDone: t('أُعيد ترتيب التصميم من القالب.', 'The design was re-laid from its template.', 'دیزاینەکە لە قاڵبەکەیەوە دووبارە ڕێکخرایەوە.'),
  rebuildUnavailable: t('هذا التصميم بلا قالب؛ لا يمكن إعادة ترتيبه آلياً.', 'This design has no template; it cannot be re-laid automatically.', 'ئەم دیزاینە قاڵبی نییە؛ ناتوانرێت خۆکارانە دووبارە ڕێکبخرێتەوە.'),

  // Layers panel
  layerHide: t('إخفاء', 'Hide', 'شاردنەوە'),
  layerShow: t('إظهار', 'Show', 'پیشاندان'),
  layerLock: t('قفل', 'Lock', 'قوفڵدان'),
  layerUnlock: t('فتح القفل', 'Unlock', 'کردنەوەی قوفڵ'),
  layerForward: t('للأمام', 'Bring forward', 'بۆ پێشەوە'),
  layerBackward: t('للخلف', 'Send backward', 'بۆ دواوە'),
  layerLocked: t('مقفلة', 'Locked', 'قوفڵدراو'),
  layerHidden: t('مخفية', 'Hidden', 'شاراوە'),
  addText: t('أضف نصاً', 'Add text', 'دەق زیاد بکە'),
  newTextDefault: t('نص جديد', 'New text', 'دەقی نوێ'),

  // Properties
  propNothing: t('اختر عنصراً من اللوحة أو من قائمة الطبقات.', 'Select an element on the canvas or in the layers list.', 'توخمێک لەسەر تابلۆکە یان لە لیستی چینەکان هەڵبژێرە.'),
  propMany: t('{n} عناصر محددة', '{n} elements selected', '{n} توخم هەڵبژێردراون'),
  propX: t('الموضع الأفقي (بكسل)', 'X position (px)', 'شوێنی ئاسۆیی (پیکسڵ)'),
  propY: t('الموضع العمودي (بكسل)', 'Y position (px)', 'شوێنی ستوونی (پیکسڵ)'),
  propW: t('العرض (بكسل)', 'Width (px)', 'پانی (پیکسڵ)'),
  propH: t('الارتفاع (بكسل)', 'Height (px)', 'بەرزی (پیکسڵ)'),
  propFontSize: t('حجم الخط (بكسل)', 'Font size (px)', 'قەبارەی فۆنت (پیکسڵ)'),
  propMinSize: t('الحد الأدنى المقروء: {n} بكسل', 'Readable floor: {n} px', 'کەمترین قەبارەی خوێندراو: {n} پیکسڵ'),
  propScale: t('المقياس (نسبة واحدة للمحورين)', 'Scale (one ratio for both axes)', 'پێوەر (یەک ڕێژە بۆ هەردوو تەوەر)'),
  propRotation: t('الدوران (درجة)', 'Rotation (degrees)', 'سووڕانەوە (پلە)'),
  propAlign: t('المحاذاة', 'Alignment', 'ڕیزکردن'),
  alignStart: t('البداية', 'Start', 'سەرەتا'),
  alignCenter: t('الوسط', 'Centre', 'ناوەڕاست'),
  alignEnd: t('النهاية', 'End', 'کۆتایی'),
  propColor: t('اللون (من ألوان الهوية فقط)', 'Colour (brand palette only)', 'ڕەنگ (تەنها لە ڕەنگەکانی براند)'),
  propColorSwatch: t('اللون {hex}', 'Colour {hex}', 'ڕەنگی {hex}'),
  propBound: t('هذا النص مربوط ببيانات المتجر ({source}) ويُرسم منها. لا يُكتب يدوياً ولا من Claude.', 'This text is bound to store data ({source}) and drawn from it. It is never typed by hand or by Claude.', 'ئەم دەقە بە داتای فرۆشگاوە بەستراوە ({source}) و لەوەوە دەکێشرێت. هەرگیز بە دەست یان لەلایەن Claude نانووسرێت.'),
  propBoundProduct: t('المنتج', 'product', 'بەرهەم'),
  propBoundService: t('مطالبة الخدمة المعتمدة', 'approved service claim', 'بانگەشەی پەسەندکراوی خزمەتگوزاری'),
  propBoundSlide: t('رقم الشريحة', 'slide number', 'ژمارەی سلاید'),
  propEditText: t('عدّل النص', 'Edit text', 'دەستکاریی دەق'),
  propLockedNote: t('العنصر مقفل. افتح القفل من قائمة الطبقات لتعديله.', 'The element is locked. Unlock it in the layers list to edit it.', 'توخمەکە قوفڵدراوە. لە لیستی چینەکان قوفڵەکەی بکەرەوە بۆ دەستکاریکردن.'),
  propProductRatio: t('صورة المنتج تُحجَّم بنسبة واحدة فقط ولا تُدار.', 'The product picture scales uniformly only and is never rotated.', 'وێنەی بەرهەم تەنها بە یەک ڕێژە قەبارەی دەگۆڕێت و ناسووڕێتەوە.'),
  propReplacePicture: t('بدّل بصورة أخرى من نفس النسخة', 'Swap for another picture of the same variant', 'بیگۆڕە بە وێنەیەکی تری هەمان جۆر'),
  propDelete: t('احذف العنصر', 'Delete the element', 'توخمەکە بسڕەوە'),
  propName: t('اسم العنصر', 'Element name', 'ناوی توخم'),
  nudge: t('تحريك دقيق', 'Nudge', 'جووڵاندنی ورد'),
  postText: t('نص المنشور (خارج الصورة)', 'Post text (outside the picture)', 'دەقی پۆست (لە دەرەوەی وێنەکە)'),
  caption: t('نص المنشور', 'Caption', 'ڕوونکردنەوەی پۆست'),
  altText: t('النص البديل للصورة', 'Alt text', 'دەقی جێگرەوەی وێنە'),
  postTextHint: t('الوسوم والنص الطويل مكانها هنا، لا داخل الصورة.', 'Hashtags and long text belong here, not inside the picture.', 'هاشتاگ و دەقی درێژ شوێنیان ئێرەیە، نەک ناو وێنەکە.'),

  // Text editing
  textEditLabel: t('تعديل النص — Ctrl+Enter للحفظ وEscape للإلغاء', 'Edit text — Ctrl+Enter to keep, Escape to cancel', 'دەستکاریی دەق — Ctrl+Enter بۆ هێشتنەوە، Escape بۆ هەڵوەشاندنەوە'),
  textBoundRefused: t('هذا النص يُرسم من البيانات ولا يُكتب فيه.', 'This text is drawn from data and cannot be typed into.', 'ئەم دەقە لە داتاوە دەکێشرێت و ناتوانرێت تێیدا بنووسرێت.'),

  // Assets panel
  assetsProductPictures: t('صور هذا المنتج', 'This product’s pictures', 'وێنەکانی ئەم بەرهەمە'),
  assetsApproved: t('أصول معتمدة', 'Approved assets', 'کەرەستە پەسەندکراوەکان'),
  assetsBackgrounds: t('خلفيات الهوية', 'Brand backgrounds', 'باکگراوندەکانی براند'),
  assetsSelectProductFirst: t('حدد صورة المنتج على اللوحة لتبديلها.', 'Select the product picture on the canvas to swap it.', 'وێنەی بەرهەم لەسەر تابلۆکە هەڵبژێرە بۆ گۆڕینی.'),
  assetsAdd: t('أضف إلى التصميم', 'Add to the design', 'زیادی بکە بۆ دیزاینەکە'),
  assetsNone: t('لا توجد أصول معتمدة بعد.', 'No approved assets yet.', 'هێشتا هیچ کەرەستەیەکی پەسەندکراو نییە.'),
  assetsUseBackground: t('استعمل هذه الخلفية', 'Use this background', 'ئەم باکگراوندە بەکاربهێنە'),

  // Chat
  chatScopeSelection: t('المحدد ({n}): {names}', 'Selected ({n}): {names}', 'هەڵبژێردراو ({n}): {names}'),
  chatScopeWhole: t('التصميم كله', 'The whole design', 'هەموو دیزاینەکە'),
  chatScopeNone: t('حدد عناصر على اللوحة، أو اختر «التصميم كله» صراحة.', 'Select elements on the canvas, or choose «the whole design» explicitly.', 'توخم لەسەر تابلۆکە هەڵبژێرە، یان بە ڕوونی «هەموو دیزاینەکە» هەڵبژێرە.'),
  chatWholeToggle: t('طلب على التصميم كله', 'A request for the whole design', 'داوایەک بۆ هەموو دیزاینەکە'),
  chatPlaceholder: t('مثال: كبّر الطابعة مع الحفاظ على نسبها', 'For example: make the printer bigger, keeping its proportions', 'بۆ نموونە: چاپکەرەکە گەورەتر بکە و ڕێژەکانی بپارێزە'),
  chatSend: t('أرسل إلى Claude', 'Send to Claude', 'بینێرە بۆ Claude'),
  chatCancel: t('أوقف الطلب', 'Stop the request', 'داواکارییەکە ڕابگرە'),
  chatToolPin: t('علامة', 'Pin', 'نیشانە'),
  chatToolBox: t('مستطيل', 'Box', 'لاکێشە'),
  chatToolArrow: t('سهم', 'Arrow', 'تیر'),
  chatToolOff: t('تحديد', 'Select', 'هەڵبژاردن'),
  chatToolHint: t('ارسم على اللوحة ثم اكتب ملاحظتك. العلامات لا تظهر في التصدير.', 'Draw on the canvas, then write your note. Marks never appear in an export.', 'لەسەر تابلۆکە بکێشە پاشان تێبینییەکەت بنووسە. نیشانەکان هەرگیز لە هەناردەدا دەرناکەون.'),
  chatNote: t('ملاحظة العلامة', 'The mark’s note', 'تێبینیی نیشانە'),
  chatAnnotations: t('العلامات ({n})', 'Marks ({n})', 'نیشانەکان ({n})'),
  chatDiffTitle: t('ما سيتغير', 'What will change', 'چی دەگۆڕێت'),
  chatDiffChanged: t('العناصر المعدّلة', 'Changed elements', 'توخمە گۆڕاوەکان'),
  chatDiffMoved: t('عناصر تابعة تحركت', 'Dependent elements that moved', 'توخمە پەیوەستەکان کە جوڵان'),
  chatDiffConflicts: t('تعارضات بعد التطبيق', 'Conflicts after applying', 'ناکۆکییەکان دوای جێبەجێکردن'),
  chatDiffNothing: t('لا تغييرات في هذا الرد.', 'This answer changes nothing.', 'ئەم وەڵامە هیچ ناگۆڕێت.'),
  chatClarify: t('Claude يسأل:', 'Claude asks:', 'Claude دەپرسێت:'),
  chatStale: t('تغيّر التصميم أثناء انتظار الرد، فأُهمل الرد. أعد الطلب على النسخة الحالية.', 'The design changed while the answer was on its way, so the answer was dropped. Ask again on the current version.', 'دیزاینەکە لە کاتی چاوەڕوانیی وەڵامدا گۆڕا، بۆیە وەڵامەکە فڕێدرا. لەسەر وەشانی ئێستا دووبارە داوا بکە.'),
  chatRetryCurrent: t('أعد الطلب على النسخة الحالية', 'Ask again on the current version', 'لەسەر وەشانی ئێستا دووبارە داوا بکە'),
  chatApplied: t('طُبّق تعديل Claude وحُفظ.', 'Claude’s edit was applied and saved.', 'دەستکارییەکەی Claude جێبەجێ کرا و پاشەکەوت کرا.'),
  chatUsage: t('{in} رمز دخول، {out} رمز خروج', '{in} input tokens, {out} output tokens', '{in} نیشانەی هاتنەژوورەوە، {out} نیشانەی دەرچوون'),
  chatRejectedPatch: t('رفض التطبيق رد Claude لأنه خالف القواعد: {code}', 'The app refused Claude’s answer for breaking the rules: {code}', 'ئەپەکە وەڵامی Claude ی ڕەتکردەوە چونکە یاساکانی شکاند: {code}'),
  chatReason: t('السبب', 'Reason', 'هۆکار'),
  chatWarnings: t('تنبيهات', 'Warnings', 'ئاگادارکردنەوەکان'),

  // Conflicts dialog
  conflictsDialogTitle: t('التعديل يسبب تعارضاً', 'The edit causes a conflict', 'دەستکارییەکە ناکۆکی دروست دەکات'),
  conflictsDialogBody: t('التصميم السابق باقٍ حتى تختار. هذه الخيارات الحقيقية:', 'The previous design stays until you choose. These are the real options:', 'دیزاینی پێشوو دەمێنێتەوە تا هەڵدەبژێریت. ئەمانە بژاردە ڕاستەقینەکانن:'),
  conflictsKeepAnyway: t('طبّق مع التعارض', 'Apply with the conflict', 'لەگەڵ ناکۆکییەکە جێبەجێ بکە'),
  conflictsOptionManual: t('يحتاج قرارك أو Claude — غير متاح آلياً', 'Needs you or Claude — not automatic', 'پێویستی بە بڕیاری تۆ یان Claude هەیە — خۆکار نییە'),
  conflictsOptionFailed: t('هذا الخيار لا يحل هذا التعارض هنا.', 'This option does not resolve this conflict here.', 'ئەم بژاردەیە ئەم ناکۆکییە لێرە چارەسەر ناکات.'),

  // QA
  qaRun: t('افحص الآن', 'Run the checks', 'ئێستا بپشکنە'),
  qaVerify: t('أعد التحقق من بيانات المتجر', 'Re-verify the store data', 'دووبارە داتای فرۆشگا پشتڕاست بکەرەوە'),
  qaVerified: t('تحقق الخادم من البيانات', 'The server verified the data', 'ڕاژەکار داتاکەی پشتڕاست کردەوە'),
  qaBlockers: t('موانع ({n})', 'Blockers ({n})', 'ڕێگرەکان ({n})'),
  qaReview: t('تحتاج مراجعة ({n})', 'Needs a look ({n})', 'پێویستی بە سەیرکردن ({n})'),
  qaOptional: t('اقتراحات ({n})', 'Suggestions ({n})', 'پێشنیارەکان ({n})'),
  qaRan: t('الفحوص التي جرت', 'Checks that ran', 'ئەو پشکنینانەی ئەنجامدران'),
  qaSkipped: t('فحوص لم تجرِ', 'Checks that did not run', 'ئەو پشکنینانەی ئەنجام نەدران'),
  qaNoIssues: t('لم تجد الفحوص التي جرت أي مشكلة.', 'The checks that ran found no problem.', 'ئەو پشکنینانەی ئەنجامدران هیچ کێشەیەکیان نەدۆزییەوە.'),
  qaNotAScore: t('هذه فحوص حتمية فقط، وليست تقييماً لجودة التصميم.', 'These are deterministic checks only, not a quality score.', 'ئەمانە تەنها پشکنینی دیاریکراون، نمرەی کوالیتی نین.'),
  qaVisualReview: t('مراجعة بصرية اختيارية من Claude', 'Optional visual review by Claude', 'پێداچوونەوەی بینراوی ئارەزوومەندانە لەلایەن Claude'),
  qaVisualAdvice: t('ملاحظات للاستئناس فقط؛ لا تعتمد التصميم ولا تمنعه.', 'Advice only; it neither approves nor blocks the design.', 'تەنها ئامۆژگارییە؛ دیزاینەکە نە پەسەند دەکات و نە ڕێگری لێ دەکات.'),
  qaVisualDisabled: t('المراجعة البصرية غير مفعلة في الإعدادات.', 'Visual review is not enabled in settings.', 'پێداچوونەوەی بینراو لە ڕێکخستنەکاندا چالاک نەکراوە.'),
  qaFinalMode: t('فحص للتصدير النهائي', 'Check for a final export', 'پشکنین بۆ هەناردەی کۆتایی'),

  // Phone preview
  phoneSimulation: t('محاكاة عرض فقط؛ لا تضمن مطابقة كل جهاز أو تطبيق.', 'A display simulation only; no guarantee every device or app matches.', 'تەنها لاساییکردنەوەی پیشاندانە؛ گەرەنتی نییە هەموو ئامێر و ئەپێک وەک ئەوە بێت.'),
  phoneFeed: t('في الصفحة الرئيسية (عرض {w} بكسل)', 'In a feed ({w} px wide)', 'لە فیددا (پانیی {w} پیکسڵ)'),
  phoneGrid: t('في شبكة الملف الشخصي (قص 3:4 في الوسط)', 'In a profile grid (centre crop 3:4)', 'لە تۆڕی پرۆفایلدا (بڕینی ناوەڕاست 3:4)'),
  phoneRefresh: t('حدّث المعاينة', 'Refresh the preview', 'پێشبینینەکە نوێ بکەرەوە'),

  // Export
  exportJson: t('ملف المشروع (JSON)', 'Project file (JSON)', 'پەڕگەی پڕۆژە (JSON)'),
  exportBackground: t('الخلفية وحدها', 'Background only', 'تەنها باکگراوند'),
  exportDraft: t('نزّل مسودة', 'Download a draft', 'ڕەشنووسێک دابەزێنە'),
  exportFinal: t('صدّر نسخة نهائية', 'Export a final copy', 'کۆپییەکی کۆتایی هەناردە بکە'),
  exportDraftNote: t('المسودة تُنزّل باسم ينتهي بـ ‎-draft ولا تُسجَّل كنسخة نهائية.', 'A draft downloads with a name ending in -draft and is never recorded as final.', 'ڕەشنووس بە ناوێک دادەبەزێت کە بە ‎-draft کۆتایی دێت و هەرگیز وەک کۆتایی تۆمار ناکرێت.'),
  exportFinalBlocked: t('التصدير النهائي يحتاج صفر موانع وتحقق الخادم من البيانات أولاً.', 'A final export needs zero blockers and the server’s data verification first.', 'هەناردەی کۆتایی پێویستی بە سفر ڕێگر و پشتڕاستکردنەوەی داتا لەلایەن ڕاژەکار هەیە.'),
  exportWebpUnsupported: t('هذا المتصفح لا يستطيع ترميز WebP. استعمل PNG أو JPEG.', 'This browser cannot encode WebP. Use PNG or JPEG.', 'ئەم وێبگەڕە ناتوانێت WebP دروست بکات. PNG یان JPEG بەکاربهێنە.'),
  exportDone: t('صُدّر الملف: {name}', 'Exported: {name}', 'هەناردە کرا: {name}'),
  exportRecorded: t('سُجّل كنسخة نهائية للنسخة {n}.', 'Recorded as the final copy of version {n}.', 'وەک کۆپیی کۆتایی وەشانی {n} تۆمار کرا.'),
  exportSize: t('{w}×{h} بكسل بالضبط', 'Exactly {w}×{h} px', 'ڕێک {w}×{h} پیکسڵ'),
  exportNeedsSave: t('احفظ التصميم أولاً.', 'Save the design first.', 'سەرەتا دیزاینەکە پاشەکەوت بکە.'),
  importJson: t('استورد ملف مشروع', 'Import a project file', 'پەڕگەی پڕۆژە هاوردە بکە'),
  importRefused: t('رُفض الملف: {issues}', 'The file was refused: {issues}', 'پەڕگەکە ڕەتکرایەوە: {issues}'),
  importDone: t('استُورد الملف كتصميم جديد.', 'The file was imported as a new design.', 'پەڕگەکە وەک دیزاینێکی نوێ هاوردە کرا.'),

  // Formats
  formatsIntro: t('يُعاد ترتيب التصميم من القالب للمقاس الجديد في تصميم مرتبط؛ لا تُمدَّد أي صورة.', 'The design is re-laid from its template for the new size, as a linked design; no picture is stretched.', 'دیزاینەکە لە قاڵبەکەیەوە بۆ قەبارە نوێیەکە وەک دیزاینێکی پەیوەست دووبارە ڕێکدەخرێتەوە؛ هیچ وێنەیەک ناکێشرێت.'),
  formatsMake: t('أنشئ نسخة {name}', 'Make a {name} version', 'وەشانێکی {name} دروست بکە'),
  formatsCustom: t('مقاس مخصص', 'Custom size', 'قەبارەی تایبەت'),
  formatsLimits: t('بين {min} و{max} بكسل، ونسبة لا تتجاوز {aspect}:1', 'Between {min} and {max} px, aspect at most {aspect}:1', 'لە نێوان {min} و {max} پیکسڵ، ڕێژە زیاتر نەبێت لە {aspect}:1'),
  formatsCreated: t('أُنشئ تصميم مرتبط بالمقاس الجديد.', 'A linked design in the new size was created.', 'دیزاینێکی پەیوەست بە قەبارە نوێیەکە دروست کرا.'),
  variantSwitch: t('بدّل التكوين', 'Switch composition', 'پێکهاتە بگۆڕە'),
  priorityPick: t('الأولوية البصرية', 'Visual priority', 'پێشینەی بینراو'),

  // Brand
  brandVersionPending: t('بانتظار اعتماد المالك', 'Waiting for the owner’s approval', 'چاوەڕێی پەسەندکردنی خاوەن'),
  brandVersionApproved: t('معتمدة', 'Approved', 'پەسەندکراو'),
  brandVersionDefault: t('الهوية الافتراضية — لم يحفظ المالك نسخة بعد', 'The default kit — the owner has not saved a version yet', 'ناسنامەی بنەڕەت — خاوەن هێشتا هیچ وەشانێکی پاشەکەوت نەکردووە'),
  brandRules: t('قواعد ملزمة (يفرضها التطبيق دائماً)', 'Binding rules (always enforced by the app)', 'یاسا پابەندکەرەکان (هەمیشە ئەپەکە جێبەجێیان دەکات)'),
  brandPrefs: t('التفضيلات', 'Preferences', 'هەڵبژاردەکان'),
  brandColors: t('الألوان', 'Colours', 'ڕەنگەکان'),
  brandPalette: t('لوحة الألوان المسموحة', 'Allowed palette', 'ڕەنگە ڕێگەپێدراوەکان'),
  brandFonts: t('الخطوط', 'Fonts', 'فۆنتەکان'),
  brandTypeScale: t('أحجام النص (عند عرض 1080)', 'Type sizes (at 1080 wide)', 'قەبارەکانی دەق (لە پانیی 1080)'),
  brandLogo: t('الشعار', 'Logo', 'لۆگۆ'),
  brandLogoSite: t('شعار الموقع الأصلي', 'The site’s own logo', 'لۆگۆی ڕەسەنی ماڵپەڕ'),
  brandLogoWidth: t('عرض الشعار (بكسل)', 'Logo width (px)', 'پانیی لۆگۆ (پیکسڵ)'),
  brandLogoCorner: t('زاوية الشعار', 'Logo corner', 'گۆشەی لۆگۆ'),
  brandDigits: t('الأرقام في الإعلان', 'Digits in ads', 'ژمارەکان لە ڕیکلامدا'),
  brandDigitsLatn: t('لاتينية 1,250,000', 'Latin 1,250,000', 'لاتینی 1,250,000'),
  brandDigitsArab: t('عربية ١٬٢٥٠٬٠٠٠', 'Arabic-Indic ١٬٢٥٠٬٠٠٠', 'عەرەبی ١٬٢٥٠٬٠٠٠'),
  brandCurrency: t('رمز العملة', 'Currency label', 'هێمای دراو'),
  brandNotes: t('ملاحظات للمصمم وClaude (سطر لكل ملاحظة)', 'Notes for the designer and Claude (one per line)', 'تێبینییەکان بۆ دیزاینەر و Claude (هەر هێڵێک یەکێک)'),
  brandAvoid: t('ما يُتجنب (سطر لكل بند)', 'What to avoid (one per line)', 'ئەوەی دووری لێ دەکرێتەوە (هەر هێڵێک یەکێک)'),
  brandVersionNote: t('ملاحظة النسخة', 'Version note', 'تێبینیی وەشان'),
  brandSaveVersion: t('احفظ كنسخة جديدة', 'Save as a new version', 'وەک وەشانێکی نوێ پاشەکەوت بکە'),
  brandSaved: t('حُفظت نسخة جديدة من الهوية.', 'A new brand version was saved.', 'وەشانێکی نوێی براند پاشەکەوت کرا.'),
  brandVersions: t('النسخ', 'Versions', 'وەشانەکان'),
  brandApprove: t('اعتمد هذه النسخة', 'Approve this version', 'ئەم وەشانە پەسەند بکە'),
  brandApproved: t('اعتُمدت النسخة.', 'The version was approved.', 'وەشانەکە پەسەند کرا.'),
  brandOwnerOnly: t('تعديل الهوية للمالك فقط؛ يمكنك القراءة.', 'Only the owner edits the brand; you can read it.', 'تەنها خاوەن براند دەستکاری دەکات؛ دەتوانیت بیخوێنیتەوە.'),
  brandUploadHint: t('ارفع شعاراً أو خلفية من تبويب الأصول، ثم يعتمدها المالك.', 'Upload a logo or a background in the Assets tab; the owner then approves it.', 'لۆگۆ یان باکگراوندێک لە بەشی کەرەستەکان باربکە؛ پاشان خاوەن پەسەندی دەکات.'),
  brandInvalidHex: t('لون غير صالح: اكتبه بصيغة ‎#RRGGBB', 'Invalid colour: write it as #RRGGBB', 'ڕەنگی نادروست: بە شێوەی ‎#RRGGBB بینووسە'),
  brandAddColor: t('أضف لوناً', 'Add a colour', 'ڕەنگێک زیاد بکە'),
  brandSize: t('الحجم', 'Size', 'قەبارە'),
  brandFloor: t('الحد الأدنى', 'Floor', 'کەمترین'),

  // Assets tab
  assetsUpload: t('ارفع أصلاً', 'Upload an asset', 'کەرەستەیەک باربکە'),
  assetsKind: t('النوع', 'Kind', 'جۆر'),
  assetsLabel: t('الوصف', 'Label', 'وەسف'),
  assetsFile: t('الملف (PNG أو JPEG أو WebP)', 'File (PNG, JPEG or WebP)', 'پەڕگە (PNG یان JPEG یان WebP)'),
  assetsChoose: t('اختر ملفاً', 'Choose a file', 'پەڕگەیەک هەڵبژێرە'),
  assetsNoFile: t('لم يُختر ملف', 'No file chosen', 'هیچ پەڕگەیەک هەڵنەبژێردراوە'),
  assetsUploaded: t('رُفع الأصل وينتظر المراجعة.', 'The asset was uploaded and waits for review.', 'کەرەستەکە بارکرا و چاوەڕێی پێداچوونەوەیە.'),
  assetsApprove: t('اعتمد', 'Approve', 'پەسەند بکە'),
  assetsReject: t('ارفض', 'Reject', 'ڕەتی بکەرەوە'),
  assetsEmpty: t('لا توجد أصول بعد.', 'No assets yet.', 'هێشتا هیچ کەرەستەیەک نییە.'),
  assetsProvenance: t('المصدر: {p}', 'Source: {p}', 'سەرچاوە: {p}'),
  assetsDeleted: t('حُذف الأصل.', 'The asset was deleted.', 'کەرەستەکە سڕایەوە.'),
  provUploaded: t('رفعه شخص', 'uploaded by a person', 'کەسێک باری کردووە'),
  provCatalog: t('صورة الكتالوج الأصلية', 'original catalogue picture', 'وێنەی ڕەسەنی کاتالۆگ'),
  provGenerated: t('مولّد', 'generated', 'دروستکراو'),
  provDerived: t('مشتق', 'derived', 'وەرگیراو'),

  // Archive
  archiveSearch: t('ابحث في العناوين', 'Search titles', 'لە ناونیشانەکاندا بگەڕێ'),
  archiveStatus: t('الحالة', 'Status', 'دۆخ'),
  archiveFormat: t('المقاس', 'Size', 'قەبارە'),
  archiveFrom: t('من تاريخ', 'From', 'لە بەرواری'),
  archiveTo: t('إلى تاريخ', 'To', 'بۆ بەرواری'),
  archiveProduct: t('معرّف المنتج', 'Product id', 'ناسنامەی بەرهەم'),
  archiveAll: t('الكل', 'All', 'هەموو'),
  archiveEmpty: t('لا توجد تصاميم تطابق.', 'No design matches.', 'هیچ دیزاینێک ناگونجێت.'),
  archiveVersions: t('النسخ', 'Versions', 'وەشانەکان'),
  archiveCompare: t('قارن نسختين', 'Compare two versions', 'دوو وەشان بەراورد بکە'),
  archiveCompareHint: t('اختر نسختين من القائمة.', 'Pick two versions from the list.', 'دوو وەشان لە لیستەکە هەڵبژێرە.'),
  archiveRestore: t('استعد هذه النسخة', 'Restore this version', 'ئەم وەشانە بگەڕێنەرەوە'),
  archiveRestored: t('استُعيدت النسخة كنسخة جديدة.', 'The version was restored as a new version.', 'وەشانەکە وەک وەشانێکی نوێ گەڕێنرایەوە.'),
  archiveNeedsReview: t('يحتاج مراجعة: {list}', 'Needs review: {list}', 'پێویستی بە پێداچوونەوە: {list}'),
  archiveUpdated: t('آخر تعديل {time}', 'Updated {time}', 'دوایین دەستکاری {time}'),
  archiveBy: t('بواسطة {name}', 'by {name}', 'لەلایەن {name}'),
  archiveCompareRender: t('النسخة {n}', 'Version {n}', 'وەشانی {n}'),

  // Settings
  setProvider: t('مزوّد الذكاء الاصطناعي: Anthropic', 'AI provider: Anthropic', 'دابینکەری AI: Anthropic'),
  setKey: t('مفتاح Anthropic API', 'Anthropic API key', 'کلیلی Anthropic API'),
  setKeyHint: t('يُرسل إلى الخادم ويُشفّر هناك، ولا يُحفظ في المتصفح، ولا يُعرض مرة أخرى — فقط آخر 4 أحرف.', 'Sent to the server and sealed there; never kept in the browser and never shown again — only its last 4 characters.', 'دەنێردرێت بۆ ڕاژەکار و لەوێ مۆر دەکرێت؛ هەرگیز لە وێبگەڕدا هەڵناگیرێت و دووبارە پیشان نادرێتەوە — تەنها 4 پیتی کۆتایی.'),
  setKeySave: t('احفظ المفتاح', 'Save the key', 'کلیلەکە پاشەکەوت بکە'),
  setKeySaved: t('حُفظ المفتاح وشُفّر.', 'The key was saved and sealed.', 'کلیلەکە پاشەکەوت و مۆرکرا.'),
  setKeyRemove: t('احذف المفتاح المحفوظ', 'Remove the stored key', 'کلیلی پاشەکەوتکراو بسڕەوە'),
  setKeyRemoved: t('حُذف المفتاح المحفوظ.', 'The stored key was removed.', 'کلیلی پاشەکەوتکراو سڕایەوە.'),
  setKeySourceStored: t('مفتاح محفوظ ومشفّر (…{hint})', 'A stored, sealed key (…{hint})', 'کلیلێکی پاشەکەوتکراو و مۆرکراو (…{hint})'),
  setKeySourceWorker: t('مفتاح سري في إعدادات الخادم (ANTHROPIC_API_KEY)', 'A Worker secret (ANTHROPIC_API_KEY)', 'کلیلێکی نهێنی لە ڕێکخستنەکانی ڕاژەکار (ANTHROPIC_API_KEY)'),
  setKeySourceNone: t('لا يوجد مفتاح', 'No key', 'هیچ کلیلێک نییە'),
  setEncryptionMissing: t('لتخزين مفتاح من هنا يلزم السر CREATIVE_STUDIO_ENC_KEY في الخادم. مفتاح ANTHROPIC_API_KEY السري يعمل دونه.', 'Storing a key from here needs the Worker secret CREATIVE_STUDIO_ENC_KEY. The ANTHROPIC_API_KEY secret works without it.', 'پاشەکەوتکردنی کلیل لێرەوە پێویستی بە نهێنیی CREATIVE_STUDIO_ENC_KEY لە ڕاژەکار هەیە. نهێنیی ANTHROPIC_API_KEY بەبێ ئەو کار دەکات.'),
  setTest: t('اختبر الاتصال', 'Test the connection', 'پەیوەندییەکە تاقی بکەرەوە'),
  setTestOk: t('نجح آخر اختبار ({time})', 'The last test passed ({time})', 'دوایین تاقیکردنەوە سەرکەوتوو بوو ({time})'),
  setTestFailed: t('فشل آخر اختبار ({time}): {code}', 'The last test failed ({time}): {code}', 'دوایین تاقیکردنەوە سەرکەوتوو نەبوو ({time}): {code}'),
  setTestNever: t('لم يُختبر الاتصال بعد.', 'The connection has not been tested yet.', 'پەیوەندییەکە هێشتا تاقی نەکراوەتەوە.'),
  setModel: t('النموذج', 'Model', 'مۆدێل'),
  setModelPick: t('اختر من قائمة Anthropic الحية', 'Pick from Anthropic’s live list', 'لە لیستە زیندووەکەی Anthropic هەڵبژێرە'),
  setModelLoad: t('حمّل قائمة النماذج', 'Load the model list', 'لیستی مۆدێلەکان بار بکە'),
  setModelNone: t('لم يُختر نموذج.', 'No model selected.', 'هیچ مۆدێلێک هەڵنەبژێردراوە.'),
  setEffort: t('الجهد', 'Effort', 'هەوڵ'),
  setBudget: t('حدود الاستهلاك', 'Usage limits', 'سنووری بەکارهێنان'),
  setDailyRequests: t('طلبات يومياً', 'Requests a day', 'داواکاری لە ڕۆژێکدا'),
  setDailyTokens: t('رموز يومياً', 'Tokens a day', 'نیشانە لە ڕۆژێکدا'),
  setDailyUsd: t('دولار يومياً (تقديري)', 'USD a day (estimated)', 'دۆلار لە ڕۆژێکدا (خەمڵێنراو)'),
  setMonthlyUsd: t('دولار شهرياً (تقديري)', 'USD a month (estimated)', 'دۆلار لە مانگێکدا (خەمڵێنراو)'),
  setMaxParallel: t('طلبات متزامنة', 'Parallel requests', 'داواکاریی هاوکات'),
  setFixRounds: t('جولات الإصلاح الآلي', 'Automatic fix rounds', 'گەڕەکانی چاککردنی خۆکار'),
  setRates: t('الأسعار المرجعية للتقدير', 'Reference rates for estimates', 'نرخە سەرچاوەکان بۆ خەمڵاندن'),
  setRateIn: t('دولار لكل مليون رمز دخول', 'USD per million input tokens', 'دۆلار بۆ هەر ملیۆن نیشانەی هاتنەژوورەوە'),
  setRateOut: t('دولار لكل مليون رمز خروج', 'USD per million output tokens', 'دۆلار بۆ هەر ملیۆن نیشانەی دەرچوون'),
  setRateSource: t('مصدر الأسعار', 'Where the rates come from', 'سەرچاوەی نرخەکان'),
  setRateDate: t('تاريخ الأسعار', 'Rates as of', 'بەرواری نرخەکان'),
  setRatesNote: t('التكاليف المعروضة تقديرية من هذه الأسعار، وليست فاتورة.', 'Costs shown are estimates from these rates, not billing.', 'تێچووە پیشاندراوەکان خەمڵاندنن لەم نرخانەوە، پسوولە نین.'),
  setRatesClear: t('بلا أسعار (حدود الطلبات والرموز فقط)', 'No rates (request and token caps only)', 'بێ نرخ (تەنها سنووری داواکاری و نیشانە)'),
  setVision: t('المراجعة البصرية للتصاميم', 'Visual review of designs', 'پێداچوونەوەی بینراوی دیزاینەکان'),
  setVisionHint: t('يرسل صورة مصغرة للتصميم إلى Claude عند طلبك فقط.', 'Sends a small image of the design to Claude only when you ask.', 'وێنەیەکی بچووکی دیزاینەکە دەنێرێت بۆ Claude تەنها کاتێک داوا دەکەیت.'),
  setSaveSettings: t('احفظ الإعدادات', 'Save the settings', 'ڕێکخستنەکان پاشەکەوت بکە'),
  setSaved: t('حُفظت الإعدادات.', 'The settings were saved.', 'ڕێکخستنەکان پاشەکەوت کران.'),
  setUsage: t('سجل الاستهلاك', 'Usage log', 'تۆماری بەکارهێنان'),
  setUsageEmpty: t('لا استهلاك مسجل.', 'No usage recorded.', 'هیچ بەکارهێنانێک تۆمار نەکراوە.'),
  setToday: t('اليوم', 'Today', 'ئەمڕۆ'),
  setMonth: t('هذا الشهر', 'This month', 'ئەم مانگە'),
  setReadOnly: t('هذه الإعدادات للمالك؛ تراها للقراءة فقط.', 'These settings belong to the owner; you see them read-only.', 'ئەم ڕێکخستنانە هی خاوەنن؛ تەنها بۆ خوێندنەوە دەیانبینیت.'),
  setReady: t('جاهز لطلبات الذكاء الاصطناعي', 'Ready for AI requests', 'ئامادەیە بۆ داواکارییەکانی AI'),
  setCapabilities: t('قدرات النموذج', 'Model capabilities', 'تواناکانی مۆدێل'),
  capStructured: t('مخرجات منظمة', 'Structured outputs', 'دەرچوونی ڕێکخراو'),
  capVision: t('رؤية الصور', 'Vision', 'بینینی وێنە'),
  capEffort: t('ضبط الجهد', 'Effort control', 'کۆنترۆڵی هەوڵ'),
  capUnknown: t('غير معروف', 'unknown', 'نەزانراو'),
  usageWhen: t('الوقت', 'When', 'کات'),
  usageTask: t('المهمة', 'Task', 'ئەرک'),
  usageStatus: t('الحالة', 'Status', 'دۆخ'),
  usageTokens: t('الرموز', 'Tokens', 'نیشانەکان'),
  usageCost: t('التكلفة التقديرية', 'Estimated cost', 'تێچووی خەمڵێنراو'),
  usageWho: t('بواسطة', 'By', 'لەلایەن'),
  usageRequests: t('{n} طلب', '{n} requests', '{n} داواکاری'),
  capabilitiesNotConnected: t('محركات متقدمة غير متصلة', 'Advanced engines not connected', 'بزوێنەرە پێشکەوتووەکان پەیوەست نین'),
  capabilitiesNote: t('توليد الصور وإزالة الخلفية والمجسمات والتعرف على النص تحتاج محركاً مرخصاً أو خدمة GPU؛ لا يوجد زر لها حتى تُربط فعلاً.', 'Image generation, background removal, 3D and text recognition need a licensed engine or a GPU service; there is no button for them until one is really connected.', 'دروستکردنی وێنە، لابردنی باکگراوند، سێ ڕەهەندی و ناسینەوەی دەق پێویستیان بە بزوێنەرێکی مۆڵەتدار یان خزمەتگوزاریی GPU هەیە؛ هیچ دوگمەیەکیان نییە تا بە ڕاستی پەیوەست دەکرێن.'),
} as const satisfies Record<string, Tri>;

export type StringKey = keyof typeof S;

/** Every server error code, said plainly — the screen never shows a bare code. */
export const ERROR_TEXT: Readonly<Record<ErrorCode | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE', Tri>> = {
  CREATIVE_SCHEMA_MISSING: t('جداول الاستوديو غير موجودة بعد؛ يلزم تطبيق الترحيل.', 'The studio tables are missing; the migration must be applied.', 'خشتەکانی ستۆدیۆ نین؛ پێویستە گواستنەوەکە جێبەجێ بکرێت.'),
  CREATIVE_SCOPE_REQUIRED: t('الاستوديو للمالك والمسؤولين بصلاحية كاملة.', 'The studio is for the owner and full-scope admins.', 'ستۆدیۆکە بۆ خاوەن و بەڕێوەبەرانی دەسەڵاتی تەواوە.'),
  OWNER_ONLY: t('هذا الإجراء للمالك فقط.', 'Only the owner can do this.', 'تەنها خاوەن دەتوانێت ئەمە بکات.'),
  OWNER_EMAIL_UNVERIFIED: t('أكّد بريد المالك أولاً.', 'Verify the owner’s email first.', 'سەرەتا ئیمەیڵی خاوەن پشتڕاست بکەرەوە.'),
  FRESH_SESSION_REQUIRED: t('سجّل الدخول من جديد لهذا الإجراء الحساس.', 'Sign in again for this sensitive action.', 'بۆ ئەم کردارە هەستیارە دووبارە بچۆ ژوورەوە.'),
  NOT_FOUND: t('غير موجود.', 'Not found.', 'نەدۆزرایەوە.'),
  INVALID_INPUT: t('بعض القيم غير صالحة.', 'Some values are not valid.', 'هەندێک بەها دروست نین.'),
  INVALID_DOCUMENT: t('رفض الخادم التصميم لأنه لا يجتاز قواعد المستند.', 'The server refused the design: it does not pass the document rules.', 'ڕاژەکار دیزاینەکەی ڕەتکردەوە چونکە یاساکانی بەڵگەنامە تێناپەڕێنێت.'),
  VERSION_CONFLICT: t('النسخة على الخادم أحدث؛ لم يُستبدل شيء.', 'The server copy is newer; nothing was overwritten.', 'وەشانی سەر ڕاژەکار نوێترە؛ هیچ شتێک نەگۆڕدرا.'),
  STALE_VERSION: t('الرد يخص نسخة قديمة من التصميم فأُهمل.', 'The answer was for an older version of the design and was dropped.', 'وەڵامەکە بۆ وەشانێکی کۆنی دیزاینەکە بوو و فڕێدرا.'),
  IDEMPOTENCY_KEY_REUSED: t('أُرسل هذا الطلب من قبل بمحتوى مختلف.', 'This request was already sent with different content.', 'ئەم داواکارییە پێشتر بە ناوەڕۆکێکی جیاواز نێردراوە.'),
  KEY_NOT_CONFIGURED: t('لا يوجد مفتاح Anthropic. أضفه من الإعدادات.', 'There is no Anthropic key. Add one in settings.', 'هیچ کلیلێکی Anthropic نییە. لە ڕێکخستنەکانەوە زیادی بکە.'),
  ENCRYPTION_NOT_CONFIGURED: t('تشفير المفاتيح غير مهيأ في الخادم (CREATIVE_STUDIO_ENC_KEY).', 'Key sealing is not set up on the server (CREATIVE_STUDIO_ENC_KEY).', 'مۆرکردنی کلیل لە ڕاژەکار ڕێکنەخراوە (CREATIVE_STUDIO_ENC_KEY).'),
  MODEL_NOT_SELECTED: t('لم يُختر نموذج بعد. اختره من الإعدادات.', 'No model is selected yet. Pick one in settings.', 'هێشتا هیچ مۆدێلێک هەڵنەبژێردراوە. لە ڕێکخستنەکان هەڵیبژێرە.'),
  BUDGET_EXCEEDED: t('بلغ الاستهلاك الحد المسموح. يمكن رفعه من الإعدادات.', 'The usage limit is reached. It can be raised in settings.', 'بەکارهێنان گەیشتە سنوور. دەتوانرێت لە ڕێکخستنەکانەوە بەرز بکرێتەوە.'),
  PARALLEL_LIMIT: t('طلبات كثيرة تعمل الآن؛ انتظر قليلاً.', 'Too many requests are running; wait a moment.', 'داواکارییەکی زۆر ئێستا کار دەکەن؛ کەمێک چاوەڕێ بکە.'),
  KEY_REJECTED: t('رفضت Anthropic المفتاح.', 'Anthropic rejected the key.', 'Anthropic کلیلەکەی ڕەتکردەوە.'),
  MODEL_GONE: t('النموذج المختار لم يعد متاحاً. اختر غيره.', 'The selected model is no longer available. Pick another.', 'مۆدێلە هەڵبژێردراوەکە چیتر بەردەست نییە. یەکێکی تر هەڵبژێرە.'),
  PROVIDER_RATE_LIMITED: t('Anthropic تحد الطلبات الآن؛ حاول بعد قليل.', 'Anthropic is limiting requests right now; try again shortly.', 'Anthropic ئێستا داواکارییەکان سنووردار دەکات؛ کەمێکی تر هەوڵ بدەرەوە.'),
  PROVIDER_OVERLOADED: t('خدمة Anthropic مزدحمة؛ حاول بعد قليل.', 'Anthropic is overloaded; try again shortly.', 'خزمەتگوزاریی Anthropic قەرەباڵغە؛ کەمێکی تر هەوڵ بدەرەوە.'),
  PROVIDER_TIMEOUT: t('لم تُجب Anthropic في الوقت المحدد.', 'Anthropic did not answer in time.', 'Anthropic لە کاتی خۆیدا وەڵامی نەدایەوە.'),
  PROVIDER_ERROR: t('خطأ من خدمة Anthropic.', 'An error from Anthropic.', 'هەڵەیەک لە خزمەتگوزاریی Anthropic.'),
  PROVIDER_REFUSED: t('رفض النموذج هذا الطلب.', 'The model refused this request.', 'مۆدێلەکە ئەم داواکارییەی ڕەتکردەوە.'),
  OUTPUT_TRUNCATED: t('انقطع رد النموذج قبل اكتماله.', 'The model’s answer was cut off before it finished.', 'وەڵامی مۆدێلەکە پێش تەواوبوون بڕا.'),
  INVALID_OUTPUT: t('رد النموذج لا يطابق العقد المطلوب فرُفض.', 'The model’s answer did not match the required contract and was refused.', 'وەڵامی مۆدێلەکە لەگەڵ گرێبەستە داواکراوەکە نەگونجا و ڕەتکرایەوە.'),
  JOB_CANCELLED: t('أُلغي الطلب؛ لن يُطبق رده.', 'The request was cancelled; its answer will not be applied.', 'داواکارییەکە هەڵوەشێنرایەوە؛ وەڵامەکەی جێبەجێ ناکرێت.'),
  JOB_ALREADY_APPLIED: t('طُبق هذا الرد من قبل.', 'This answer was already applied.', 'ئەم وەڵامە پێشتر جێبەجێ کراوە.'),
  SOURCE_CHANGED: t('تغيرت بيانات المنتج منذ التصميم؛ راجعها قبل التصدير النهائي.', 'The product data changed since the design was made; review it before a final export.', 'داتای بەرهەم لە دوای دیزاینەکەوە گۆڕاوە؛ پێش هەناردەی کۆتایی پێیدا بچۆرەوە.'),
  QA_BLOCKERS: t('في التصميم موانع تمنع الاعتماد أو التصدير النهائي.', 'The design has blockers that prevent approval or a final export.', 'دیزاینەکە ڕێگری تێدایە کە ڕێ لە پەسەندکردن یان هەناردەی کۆتایی دەگرن.'),
  APPROVAL_STALE: t('تغير التصميم بعد الاعتماد؛ يلزم اعتماد جديد.', 'The design changed after approval; it needs approving again.', 'دیزاینەکە دوای پەسەندکردن گۆڕا؛ پێویستی بە پەسەندکردنەوە هەیە.'),
  UNSUPPORTED_MEDIA: t('نوع الملف غير مدعوم.', 'This file type is not supported.', 'ئەم جۆرە پەڕگەیە پشتگیری ناکرێت.'),
  FILE_TOO_LARGE: t('الملف أكبر من المسموح.', 'The file is larger than allowed.', 'پەڕگەکە گەورەترە لە ڕێگەپێدراو.'),
  ASSET_IN_USE: t('الأصل مستعمل في تصميم؛ لا يمكن حذفه.', 'The asset is used in a design; it cannot be deleted.', 'کەرەستەکە لە دیزاینێکدا بەکارهاتووە؛ ناتوانرێت بسڕدرێتەوە.'),
  RATE_LIMITED: t('طلبات كثيرة؛ انتظر قليلاً ثم أعد المحاولة.', 'Too many requests; wait a moment and try again.', 'داواکارییەکی زۆر؛ کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدەرەوە.'),
  NETWORK: t('لا اتصال بالخادم.', 'No connection to the server.', 'هیچ پەیوەندییەک بە ڕاژەکارەوە نییە.'),
  TIMEOUT: t('انتهت مهلة الطلب؛ ربما اكتمل على الخادم.', 'The request timed out; it may still have completed on the server.', 'کاتی داواکارییەکە تەواو بوو؛ لەوانەیە لە ڕاژەکار تەواو بووبێت.'),
  REAUTH_REQUIRED: t('سجّل الدخول من جديد لإتمام هذا الإجراء.', 'Sign in again to complete this action.', 'دووبارە بچۆ ژوورەوە بۆ تەواوکردنی ئەم کارە.'),
  VISION_REVIEW_DISABLED: t('المراجعة البصرية غير مفعّلة؛ يفعّلها المالك من الإعدادات.', 'Visual review is turned off; the owner can turn it on in Settings.', 'پێداچوونەوەی بینراو ناچالاکە؛ خاوەنەکە دەتوانێت لە ڕێکخستنەکانەوە چالاکی بکات.'),
  STORAGE_UNAVAILABLE: t('تخزين الملفات غير متاح الآن؛ حاول لاحقاً.', 'File storage is not available right now; try again later.', 'هەڵگرتنی فایل ئێستا بەردەست نییە؛ دواتر هەوڵ بدەرەوە.'),
  JOB_IN_PROGRESS: t('هذا الطلب ما زال قيد التنفيذ؛ انتظر نتيجته.', 'This request is still running; wait for its result.', 'ئەم داواکارییە هێشتا بەردەوامە؛ چاوەڕێی ئەنجامەکەی بکە.'),
  INVALID_RESPONSE: t('رد غير متوقع من الخادم.', 'An unexpected answer from the server.', 'وەڵامێکی چاوەڕواننەکراو لە ڕاژەکارەوە.'),
};

export const ROLE_TEXT: Readonly<Record<LayerRole, Tri>> = {
  background: t('الخلفية', 'Background', 'باکگراوند'),
  product: t('صورة المنتج', 'Product picture', 'وێنەی بەرهەم'),
  product_shadow: t('ظل المنتج', 'Product shadow', 'سێبەری بەرهەم'),
  logo: t('الشعار', 'Logo', 'لۆگۆ'),
  headline: t('العنوان', 'Headline', 'سەردێڕ'),
  subhead: t('السطر الثانوي', 'Subhead', 'هێڵی لاوەکی'),
  body: t('النص', 'Body text', 'دەقی سەرەکی'),
  feature: t('ميزة', 'Feature', 'تایبەتمەندی'),
  product_name: t('اسم المنتج', 'Product name', 'ناوی بەرهەم'),
  price: t('السعر', 'Price', 'نرخ'),
  price_note: t('ملاحظة السعر', 'Price note', 'تێبینیی نرخ'),
  availability: t('التوفر', 'Availability', 'بەردەستبوون'),
  cta: t('الدعوة للإجراء', 'Call to action', 'بانگەواز بۆ کردار'),
  badge: t('شارة', 'Badge', 'باج'),
  decor: t('زخرفة', 'Decoration', 'ڕازاندنەوە'),
  icon: t('أيقونة', 'Icon', 'ئایکۆن'),
  slide_number: t('رقم الشريحة', 'Slide number', 'ژمارەی سلاید'),
};

export const OBJECTIVE_TEXT: Readonly<Record<Objective, Tri>> = {
  sell: t('بيع منتج', 'Sell a product', 'فرۆشتنی بەرهەم'),
  arrival: t('وصول منتج جديد', 'A new arrival', 'گەیشتنی بەرهەمی نوێ'),
  back_in_stock: t('عودة التوفر', 'Back in stock', 'گەڕانەوەی بەردەستبوون'),
  feature: t('شرح ميزة', 'Explain a feature', 'ڕوونکردنەوەی تایبەتمەندییەک'),
  comparison: t('مقارنة', 'Comparison', 'بەراوردکردن'),
  education: t('تعليم', 'Education', 'فێرکاری'),
  service_trust: t('ثقة بخدمة', 'Trust in a service', 'متمانە بە خزمەتگوزاری'),
};

export const PRIORITY_TEXT: Readonly<Record<VisualPriority, Tri>> = {
  product: t('المنتج', 'The product', 'بەرهەمەکە'),
  price: t('السعر', 'The price', 'نرخەکە'),
  headline: t('الرسالة', 'The message', 'پەیامەکە'),
  feature: t('الميزة', 'The feature', 'تایبەتمەندییەکە'),
};

export const DENSITY_TEXT: Readonly<Record<Density, Tri>> = {
  brief: t('مختصر', 'Brief', 'کورت'),
  detailed: t('مفصل', 'Detailed', 'وردەکاری'),
};

export const FORMAT_TEXT: Readonly<Record<FormatId, Tri>> = {
  square: t('مربع 1080×1080', 'Square 1080×1080', 'چوارگۆشە 1080×1080'),
  portrait: t('عمودي 1080×1350', 'Portrait 1080×1350', 'ستوونی 1080×1350'),
  story: t('قصة 1080×1920', 'Story 1080×1920', 'چیرۆک 1080×1920'),
  custom: t('مخصص', 'Custom', 'تایبەت'),
};

export const LOCALE_TEXT: Readonly<Record<'ar' | 'en' | 'ckb', Tri>> = {
  ar: t('العربية', 'Arabic', 'عەرەبی'),
  en: t('الإنجليزية', 'English', 'ئینگلیزی'),
  ckb: t('الكردية السورانية (يكتب نصها شخص)', 'Sorani Kurdish (its words typed by a person)', 'کوردیی سۆرانی (دەقەکەی کەسێک دەینووسێت)'),
};

export const STATUS_TEXT: Readonly<Record<DocStatus, Tri>> = {
  idea: t('فكرة', 'Idea', 'بیرۆکە'),
  draft: t('مسودة', 'Draft', 'ڕەشنووس'),
  in_review: t('قيد المراجعة', 'In review', 'لە پێداچوونەوەدا'),
  approved: t('معتمد', 'Approved', 'پەسەندکراو'),
  scheduled: t('مجدول', 'Scheduled', 'خشتەبەندکراو'),
  published: t('منشور', 'Published', 'بڵاوکراوە'),
  archived: t('مؤرشف', 'Archived', 'ئەرشیفکراو'),
  failed: t('فشل', 'Failed', 'سەرکەوتوو نەبوو'),
};

export const ORIGIN_TEXT: Readonly<Record<VersionOrigin, Tri>> = {
  manual: t('تعديل يدوي', 'Manual edit', 'دەستکاریی دەستی'),
  ai: t('تعديل Claude', 'Claude’s edit', 'دەستکاریی Claude'),
  template: t('من قالب', 'From a template', 'لە قاڵبێکەوە'),
  restore: t('استعادة', 'Restore', 'گەڕاندنەوە'),
  relayout: t('إعادة ترتيب', 'Re-layout', 'دووبارە ڕێکخستنەوە'),
  import: t('استيراد', 'Import', 'هاوردەکردن'),
};

export const ASSET_KIND_TEXT: Readonly<Record<AssetKind, Tri>> = {
  logo: t('شعار', 'Logo', 'لۆگۆ'),
  background: t('خلفية', 'Background', 'باکگراوند'),
  reference_liked: t('مرجع أعجبني', 'Reference I liked', 'سەرچاوەیەک کە بەدڵم بوو'),
  reference_rejected: t('مرجع مرفوض', 'Rejected reference', 'سەرچاوەی ڕەتکراوە'),
  product_extra: t('صورة منتج إضافية', 'Extra product shot', 'وێنەی زیادەی بەرهەم'),
  icon: t('أيقونة', 'Icon', 'ئایکۆن'),
  element: t('عنصر', 'Element', 'توخم'),
};

export const REVIEW_STATE_TEXT: Readonly<Record<'approved' | 'needs_review' | 'rejected', Tri>> = {
  approved: t('معتمد', 'Approved', 'پەسەندکراو'),
  needs_review: t('بانتظار المراجعة', 'Waiting for review', 'چاوەڕێی پێداچوونەوە'),
  rejected: t('مرفوض', 'Rejected', 'ڕەتکراوە'),
};

export const OPPORTUNITY_TEXT: Readonly<Record<OpportunityDto['kind'], Tri>> = {
  arrival: t('وصل حديثاً', 'New arrival', 'تازە گەیشتووە'),
  back_in_stock: t('عاد للتوفر', 'Back in stock', 'دووبارە بەردەستە'),
  offer: t('عرض قائم', 'Live offer', 'ئۆفەری بەردەوام'),
  coverage_gap: t('لم يُنشر عنه منذ مدة', 'Not posted about for a while', 'ماوەیەکە دەربارەی بڵاونەکراوەتەوە'),
  service_claim: t('خدمة معتمدة', 'Approved service', 'خزمەتگوزاریی پەسەندکراو'),
  owner_priority: t('أولوية المالك', 'Owner’s priority', 'پێشینەی خاوەن'),
  education_topic: t('موضوع تعليمي', 'Education topic', 'بابەتی فێرکاری'),
  history: t('من السجل', 'From history', 'لە مێژووەوە'),
};

export const QUALITY_TEXT: Readonly<Record<QualityCode, Tri>> = {
  snapshot_missing: t('بيانات المنتج المرتبطة غير متاحة', 'The bound product data is missing', 'داتای بەرهەمی بەستراو بەردەست نییە'),
  wrong_variant_image: t('الصورة ليست لهذا المنتج أو لهذه النسخة', 'The picture is not of this product or variant', 'وێنەکە هی ئەم بەرهەم یان جۆرە نییە'),
  test_data: t('بيانات تجريبية موسومة', 'Marked test data', 'داتای تاقیکاریی نیشانکراو'),
  price_unavailable: t('لا يوجد سعر عام لهذا المنتج', 'This product has no public price', 'ئەم بەرهەمە نرخی گشتیی نییە'),
  unbound_price_text: t('نص حر يحتوي سعراً', 'Free text that states a price', 'دەقێکی ئازاد کە نرخ دەڵێت'),
  source_changed: t('تغيرت بيانات المتجر منذ التصميم', 'The store data changed since the design', 'داتای فرۆشگا لە دوای دیزاینەکەوە گۆڕاوە'),
  unverified_source: t('لم يتحقق الخادم من البيانات بعد', 'The server has not verified the data yet', 'ڕاژەکار هێشتا داتاکەی پشتڕاست نەکردووەتەوە'),
  product_transformed: t('صورة المنتج مدارة أو محوّلة', 'The product picture is rotated or transformed', 'وێنەی بەرهەم سووڕێنراوە یان گۆڕاوە'),
  product_detail_crop: t('صورة المنتج مقصوصة (لقطة تفصيل)', 'The product picture is cropped (a detail shot)', 'وێنەی بەرهەم بڕاوە (وێنەی وردەکاری)'),
  low_resolution: t('صورة مرسومة أكبر من دقتها', 'A picture drawn larger than its resolution', 'وێنەیەک گەورەتر لە وردییەکەی کێشراوە'),
  font_weight: t('وزن خط غير مسجل', 'An unregistered font weight', 'کێشی فۆنتی تۆمارنەکراو'),
  missing_glyph: t('حرف لا يملك الخط رسمه', 'A letter the font has no glyph for', 'پیتێک کە فۆنتەکە شێوەی نییە'),
  font_not_loaded: t('خط لم يُحمّل', 'A font that did not load', 'فۆنتێک کە بار نەکرا'),
  text_overflow: t('نص لا يتسع في صندوقه', 'Text that does not fit its box', 'دەقێک کە لە سندووقەکەیدا جێی نابێتەوە'),
  small_text: t('نص أصغر من الحد المقروء', 'Text below the readable floor', 'دەقێک بچووکتر لە سنووری خوێندنەوە'),
  outside_safe_area: t('عنصر أساسي خارج منطقة الأمان', 'An essential element outside the safe area', 'توخمێکی سەرەکی لە دەرەوەی ناوچەی پارێزراو'),
  overlap: t('عناصر متداخلة', 'Overlapping elements', 'توخمی تێکەڵ'),
  off_canvas: t('عنصر خارج اللوحة', 'An element off the canvas', 'توخمێک لە دەرەوەی تابلۆکە'),
  off_palette: t('لون خارج لوحة الهوية', 'A colour outside the brand palette', 'ڕەنگێک لە دەرەوەی ڕەنگەکانی براند'),
  asset_missing: t('صورة لم تُحمّل', 'A picture that did not load', 'وێنەیەک کە بار نەکرا'),
  dense: t('نصوص كثيرة', 'Too many texts', 'دەقی زۆر'),
  claim_missing: t('مطالبة الخدمة غير معتمدة أو منتهية', 'The service claim is not approved or has expired', 'بانگەشەی خزمەتگوزاری پەسەندنەکراوە یان بەسەرچووە'),
  claim_changed: t('تغيرت نسخة مطالبة الخدمة', 'The service claim has a newer version', 'وەشانی بانگەشەی خزمەتگوزاری گۆڕاوە'),
  conditions_missing: t('شروط الخدمة غير معروضة', 'The service conditions are not shown', 'مەرجەکانی خزمەتگوزاری پیشان نەدراون'),
  alt_text_missing: t('لا يوجد نص بديل', 'No alt text', 'هیچ دەقێکی جێگرەوە نییە'),
  caption_missing: t('لا يوجد نص للمنشور', 'No caption', 'هیچ ڕوونکردنەوەیەک بۆ پۆستەکە نییە'),
  not_sorani: t('نص بحروف عربية في إعلان سوراني', 'Arabic-only letters in a Sorani ad', 'پیتی تەنها عەرەبی لە ڕیکلامێکی سۆرانیدا'),
  headline_missing: t('لا يوجد عنوان', 'No headline', 'هیچ سەردێڕێک نییە'),
  bound_text_missing: t('نص مربوط بلا بيانات', 'A bound text with no data', 'دەقێکی بەستراو بێ داتا'),
};

export const CHECK_TEXT: Readonly<Record<CheckName, Tri>> = {
  data: t('بيانات المتجر', 'Store data', 'داتای فرۆشگا'),
  product: t('صورة المنتج', 'Product picture', 'وێنەی بەرهەم'),
  fonts: t('الخطوط', 'Fonts', 'فۆنتەکان'),
  text_fit: t('اتساع النص', 'Text fit', 'جێبوونەوەی دەق'),
  layout: t('التخطيط ومنطقة الأمان', 'Layout and safe area', 'ڕێکخستن و ناوچەی پارێزراو'),
  brand: t('الهوية', 'Brand', 'براند'),
  assets: t('الصور', 'Pictures', 'وێنەکان'),
  claims: t('مطالبات الخدمة', 'Service claims', 'بانگەشەکانی خزمەتگوزاری'),
  language: t('اللغة', 'Language', 'زمان'),
  meta: t('نص المنشور', 'Post text', 'دەقی پۆست'),
};

export const SKIP_TEXT: Readonly<Record<CheckName, Tri>> = {
  data: t('لم يُبلَّغ عن حالة البيانات', 'Data state not reported', 'دۆخی داتا ڕاپۆرت نەکرا'),
  product: t('لم يُبلَّغ عن حالة الصورة', 'Picture state not reported', 'دۆخی وێنە ڕاپۆرت نەکرا'),
  fonts: t('لم يُبلَّغ عن حالة تحميل الخطوط', 'Font load state not reported', 'دۆخی بارکردنی فۆنت ڕاپۆرت نەکرا'),
  text_fit: t('لا يوجد مقياس للنص', 'No text measurer', 'هیچ پێوەرێکی دەق نییە'),
  layout: t('لم يجرِ', 'Did not run', 'ئەنجام نەدرا'),
  brand: t('لم يجرِ', 'Did not run', 'ئەنجام نەدرا'),
  assets: t('لم يُبلَّغ عن حالة تحميل الصور', 'Picture load state not reported', 'دۆخی بارکردنی وێنە ڕاپۆرت نەکرا'),
  claims: t('لم يجرِ', 'Did not run', 'ئەنجام نەدرا'),
  language: t('لم يجرِ', 'Did not run', 'ئەنجام نەدرا'),
  meta: t('لم يجرِ', 'Did not run', 'ئەنجام نەدرا'),
};

export const CONFLICT_TEXT: Readonly<Record<ConflictCode, Tri>> = {
  content_too_long: t('المحتوى أطول من المساحة', 'The content is longer than the space', 'ناوەڕۆکەکە درێژترە لە شوێنەکە'),
  text_overflow: t('نص لا يتسع في صندوقه', 'Text does not fit its box', 'دەق لە سندووقەکەیدا جێی نابێتەوە'),
  outside_safe_area: t('عنصر أساسي خارج منطقة الأمان', 'An essential element is outside the safe area', 'توخمێکی سەرەکی لە دەرەوەی ناوچەی پارێزراوە'),
  overlap: t('عناصر متداخلة', 'Elements overlap', 'توخمەکان تێکەڵ دەبن'),
  product_too_small: t('صورة المنتج صغيرة جداً', 'The product picture is too small', 'وێنەی بەرهەم زۆر بچووکە'),
};

export const OPTION_TEXT: Readonly<Record<ConflictOption, Tri>> = {
  shorten_text: t('اختصر النص', 'Shorten the text', 'دەقەکە کورت بکەرەوە'),
  reduce_font: t('صغّر الخط حتى الحد المقروء', 'Reduce the font to its readable floor', 'فۆنتەکە بچووک بکەرەوە تا سنووری خوێندنەوە'),
  grow_box: t('وسّع صندوق النص', 'Grow the text box', 'سندووقی دەقەکە گەورە بکە'),
  shrink_product: t('صغّر صورة المنتج بنسبة واحدة', 'Shrink the product picture uniformly', 'وێنەی بەرهەم بە یەک ڕێژە بچووک بکەرەوە'),
  switch_density: t('بدّل كثافة النص', 'Switch the amount of text', 'بڕی دەق بگۆڕە'),
  switch_variant: t('بدّل التكوين', 'Switch the composition', 'پێکهاتەکە بگۆڕە'),
  split_carousel: t('قسّمه إلى كاروسيل', 'Split it into a carousel', 'بیکە بە کارۆسێل'),
  move_layer: t('حرّك العنصر بيدك', 'Move the element yourself', 'توخمەکە خۆت بجووڵێنە'),
  revert: t('تراجع عن التعديل', 'Undo the edit', 'لە دەستکارییەکە پاشگەز ببەرەوە'),
};

export const REFUSAL_TEXT: Readonly<Record<RefusalCode, Tri>> = {
  unknown_op: t('عملية غير معروفة', 'Unknown operation', 'کرداری نەناسراو'),
  not_allowed_for_actor: t('غير مسموح لهذا الطرف', 'Not allowed for this actor', 'بۆ ئەم لایەنە ڕێگەپێدراو نییە'),
  unknown_layer: t('عنصر غير موجود', 'No such element', 'توخمێکی وا نییە'),
  unknown_relation: t('علاقة غير موجودة', 'No such relation', 'پەیوەندییەکی وا نییە'),
  locked_layer: t('العنصر مقفل', 'The element is locked', 'توخمەکە قوفڵدراوە'),
  wrong_layer_type: t('لا ينطبق على هذا النوع من العناصر', 'Does not apply to this kind of element', 'لەسەر ئەم جۆرە توخمە جێبەجێ نابێت'),
  bound_text: t('النص مربوط ببيانات المتجر', 'The text is bound to store data', 'دەقەکە بە داتای فرۆشگاوە بەستراوە'),
  price_like_text: t('نص يشبه السعر', 'Price-like text', 'دەقێکی وەک نرخ'),
  invented_link: t('رابط غير مسموح', 'A link is not allowed', 'بەستەر ڕێگەپێدراو نییە'),
  invalid_value: t('قيمة غير صالحة', 'Invalid value', 'بەهای نادروست'),
  below_min_size: t('أصغر من الحد المقروء', 'Below the readable floor', 'بچووکتر لە سنووری خوێندنەوە'),
  color_not_in_palette: t('لون خارج لوحة الهوية', 'A colour outside the brand palette', 'ڕەنگێک لە دەرەوەی ڕەنگەکانی براند'),
  asset_not_allowed: t('صورة غير مسموحة لهذا العنصر', 'A picture not allowed for this element', 'وێنەیەک کە بۆ ئەم توخمە ڕێگەپێدراو نییە'),
  unknown_background: t('خلفية غير موجودة', 'No such background', 'باکگراوندێکی وا نییە'),
  product_rotation: t('صورة المنتج والخلفية لا تُداران', 'The product picture and the background do not rotate', 'وێنەی بەرهەم و باکگراوند ناسووڕێنەوە'),
  background_order: t('الخلفية تبقى في الأسفل', 'The background stays at the bottom', 'باکگراوند لە خوارەوە دەمێنێتەوە'),
  duplicate_id: t('معرّف مكرر', 'Duplicate id', 'ناسنامەی دووبارە'),
  invalid_layer: t('عنصر غير صالح', 'Invalid element', 'توخمی نادروست'),
  rebuild_not_alone: t('إعادة الترتيب تُطلب وحدها', 'A re-layout must be requested alone', 'دووبارە ڕێکخستنەوە دەبێت بە تەنها داوا بکرێت'),
  unknown_variant: t('تكوين غير متاح', 'Composition not available', 'پێکهاتە بەردەست نییە'),
  unknown_annotation: t('علامة غير موجودة', 'No such mark', 'نیشانەیەکی وا نییە'),
};

export const CHANGE_TEXT: Readonly<Record<SnapshotChange, Tri>> = {
  price_changed: t('تغير السعر', 'The price changed', 'نرخ گۆڕا'),
  price_status_changed: t('تغيرت حالة السعر', 'The price status changed', 'دۆخی نرخ گۆڕا'),
  offer_changed: t('تغير العرض', 'The offer changed', 'ئۆفەر گۆڕا'),
  availability_changed: t('تغير التوفر', 'Availability changed', 'بەردەستبوون گۆڕا'),
  name_changed: t('تغير الاسم', 'The name changed', 'ناو گۆڕا'),
  image_removed: t('حُذفت صورة', 'A picture was removed', 'وێنەیەک سڕایەوە'),
  product_missing: t('المنتج لم يعد موجوداً', 'The product no longer exists', 'بەرهەمەکە چیتر بوونی نییە'),
};

export const PRICE_STATUS_TEXT: Readonly<Record<PriceStatus, Tri>> = {
  priced: t('بسعر عام', 'Publicly priced', 'نرخی گشتیی هەیە'),
  unpriced: t('السعر عند الطلب', 'Price on request', 'نرخ بە داواکاری'),
  members_only: t('سعر للأعضاء فقط', 'Members-only price', 'نرخ تەنها بۆ ئەندامان'),
};

export const AVAILABILITY_TEXT: Readonly<Record<SnapshotAvailability, Tri>> = {
  available: t('متوفر', 'Available', 'بەردەستە'),
  preorder: t('طلب مسبق', 'Pre-order', 'داواکاریی پێشوەختە'),
  unavailable: t('غير متوفر', 'Unavailable', 'بەردەست نییە'),
  unknown: t('غير معروف', 'Unknown', 'نەزانراو'),
};

export const ANNOTATION_TEXT: Readonly<Record<Annotation['kind'], Tri>> = {
  pin: t('علامة', 'Pin', 'نیشانە'),
  box: t('مستطيل', 'Box', 'لاکێشە'),
  arrow: t('سهم', 'Arrow', 'تیر'),
};

export const EFFORT_TEXT: Readonly<Record<Effort, Tri>> = {
  low: t('منخفض', 'Low', 'نزم'),
  medium: t('متوسط', 'Medium', 'مامناوەند'),
  high: t('مرتفع', 'High', 'بەرز'),
};

export const TASK_TEXT: Readonly<Record<AiTask, Tri>> = {
  test: t('اختبار الاتصال', 'Connection test', 'تاقیکردنەوەی پەیوەندی'),
  ideas: t('أفكار', 'Ideas', 'بیرۆکەکان'),
  compose: t('تكوينات', 'Compositions', 'پێکهاتەکان'),
  edit: t('تعديل', 'Edit', 'دەستکاری'),
  review: t('مراجعة بصرية', 'Visual review', 'پێداچوونەوەی بینراو'),
  carousel: t('كاروسيل', 'Carousel', 'کارۆسێل'),
};

export const JOB_TEXT: Readonly<Record<JobStatus | 'ok' | 'error' | 'refused', Tri>> = {
  queued: t('في الانتظار', 'Queued', 'لە ڕیزدا'),
  running: t('يعمل', 'Running', 'کار دەکات'),
  succeeded: t('نجح', 'Succeeded', 'سەرکەوتوو بوو'),
  failed: t('فشل', 'Failed', 'سەرکەوتوو نەبوو'),
  cancelled: t('أُلغي', 'Cancelled', 'هەڵوەشێنرایەوە'),
  ok: t('تم', 'Done', 'ئەنجامدرا'),
  error: t('خطأ', 'Error', 'هەڵە'),
  refused: t('مرفوض', 'Refused', 'ڕەتکراوە'),
};

export const EXPORT_KIND_TEXT: Readonly<Record<ExportKind, Tri>> = {
  png: t('صورة PNG', 'PNG image', 'وێنەی PNG'),
  jpeg: t('صورة JPEG', 'JPEG image', 'وێنەی JPEG'),
  webp: t('صورة WebP', 'WebP image', 'وێنەی WebP'),
  project_json: t('ملف المشروع', 'Project file', 'پەڕگەی پڕۆژە'),
  background: t('الخلفية وحدها', 'Background only', 'تەنها باکگراوند'),
};

export const REJECT_TEXT: Readonly<Record<RejectReason, Tri>> = {
  product_small: t('المنتج صغير', 'The product is small', 'بەرهەمەکە بچووکە'),
  crowded: t('مزدحم', 'Crowded', 'قەرەباڵغ'),
  text_long: t('النص طويل', 'The text is long', 'دەقەکە درێژە'),
  background_off: t('الخلفية لا تناسب', 'The background does not fit', 'باکگراوندەکە ناگونجێت'),
  wrong_variant_image: t('صورة نسخة خاطئة', 'Wrong variant picture', 'وێنەی جۆری هەڵە'),
  unclear: t('غير واضح', 'Unclear', 'ناڕوون'),
  other: t('سبب آخر', 'Another reason', 'هۆکارێکی تر'),
};

export const CORNER_TEXT: Readonly<Record<'top_start' | 'top_end' | 'bottom_start' | 'bottom_end', Tri>> = {
  top_start: t('أعلى البداية', 'Top start', 'سەرەوەی سەرەتا'),
  top_end: t('أعلى النهاية', 'Top end', 'سەرەوەی کۆتایی'),
  bottom_start: t('أسفل البداية', 'Bottom start', 'خوارەوەی سەرەتا'),
  bottom_end: t('أسفل النهاية', 'Bottom end', 'خوارەوەی کۆتایی'),
};

export const COLOR_KEY_TEXT: Readonly<Record<'background' | 'surface' | 'text' | 'text_muted' | 'accent' | 'accent_text' | 'price', Tri>> = {
  background: t('لون الخلفية', 'Background', 'ڕەنگی باکگراوند'),
  surface: t('لون السطح', 'Surface', 'ڕەنگی ڕووکار'),
  text: t('لون النص', 'Text', 'ڕەنگی دەق'),
  text_muted: t('نص ثانوي', 'Muted text', 'دەقی لاوەکی'),
  accent: t('لون التمييز', 'Accent', 'ڕەنگی جیاکەرەوە'),
  accent_text: t('نص على التمييز', 'Text on accent', 'دەق لەسەر ڕەنگی جیاکەرەوە'),
  price: t('لون السعر', 'Price', 'ڕەنگی نرخ'),
};

export const FONT_ROLE_TEXT: Readonly<Record<'primary' | 'display', Tri>> = {
  primary: t('خط النص', 'Text face', 'فۆنتی دەق'),
  display: t('خط العناوين', 'Display face', 'فۆنتی سەردێڕەکان'),
};

/** Every table above, for the strings walker test. */
export const ALL_TABLES: ReadonlyArray<readonly [string, Readonly<Record<string, Tri>>]> = [
  ['S', S], ['ERROR_TEXT', ERROR_TEXT], ['ROLE_TEXT', ROLE_TEXT], ['OBJECTIVE_TEXT', OBJECTIVE_TEXT], ['PRIORITY_TEXT', PRIORITY_TEXT],
  ['DENSITY_TEXT', DENSITY_TEXT], ['FORMAT_TEXT', FORMAT_TEXT], ['LOCALE_TEXT', LOCALE_TEXT], ['STATUS_TEXT', STATUS_TEXT], ['ORIGIN_TEXT', ORIGIN_TEXT],
  ['ASSET_KIND_TEXT', ASSET_KIND_TEXT], ['REVIEW_STATE_TEXT', REVIEW_STATE_TEXT], ['OPPORTUNITY_TEXT', OPPORTUNITY_TEXT], ['QUALITY_TEXT', QUALITY_TEXT],
  ['CHECK_TEXT', CHECK_TEXT], ['SKIP_TEXT', SKIP_TEXT], ['CONFLICT_TEXT', CONFLICT_TEXT], ['OPTION_TEXT', OPTION_TEXT], ['REFUSAL_TEXT', REFUSAL_TEXT],
  ['CHANGE_TEXT', CHANGE_TEXT], ['PRICE_STATUS_TEXT', PRICE_STATUS_TEXT], ['AVAILABILITY_TEXT', AVAILABILITY_TEXT], ['ANNOTATION_TEXT', ANNOTATION_TEXT],
  ['EFFORT_TEXT', EFFORT_TEXT], ['TASK_TEXT', TASK_TEXT], ['JOB_TEXT', JOB_TEXT], ['EXPORT_KIND_TEXT', EXPORT_KIND_TEXT], ['REJECT_TEXT', REJECT_TEXT],
  ['CORNER_TEXT', CORNER_TEXT], ['COLOR_KEY_TEXT', COLOR_KEY_TEXT], ['FONT_ROLE_TEXT', FONT_ROLE_TEXT],
];

/** The sentence for an error: by its code when the studio knows it, else the server’s own words. */
export function errorText(code: string | undefined, fallback: string, lang: Lang): string {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) return tx(ERROR_TEXT[code as keyof typeof ERROR_TEXT], lang);
  return fallback;
}
