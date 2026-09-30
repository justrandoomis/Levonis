/**
 * THE STORE BUILDER'S WORDS IN ARABIC, ENGLISH AND SORANI — one table per
 * part of «تصميم المتجر» (docs/MERCHANT_PLATFORM_V2.md storefront §7), every
 * key in all three languages, the Sorani written by hand under the rule
 * docs/DECISIONS.md rows 166–168 (D6) set: real Sorani in the feature's own
 * table, never the Arabic standing in.
 *
 * Each part keeps its own table, its own type and its own `use…Strings()`
 * hook, so the builders who add a part here never edit each other's lines.
 * A surface OUTSIDE the builder that needs one of these phrases (the
 * workspace's Pulse line) copies it VERBATIM and a test holds the copy to
 * the table — it never imports this file, so Today never downloads the
 * builder's words.
 *
 * Numbers are never typed into a sentence: `{placeholders}` are filled with
 * figures formatted at render time, and a placeholder in one language is a
 * placeholder in all three (tests/speedPanelUi.test.ts).
 */
import { useLanguage } from '../../../LanguageContext';

// ------------------------------------------------------------ «سرعة متجري» (P4)

/**
 * «سرعة متجري» — the builder's «السرعة» tab (storefront §3.9 / §3.10, §4.5
 * S4–S7): the real-user verdict and its tiles, the first-screen weight, the
 * closed finding codes of worker/lib/storeSpeed.ts as sentences, the lab
 * tile and the honesty line. The server sends keys and numbers only.
 */
const SPEED_AR = {
  tab: 'السرعة',
  title: 'سرعة متجري',
  lead: 'كيف تظهر صفحتك لزبائنك الحقيقيين، وما الذي يثقل شاشتها الأولى.',
  device: { label: 'الجهاز', phone: 'هاتف', desktop: 'حاسوب' },
  days: { label: 'المدة', d7: 'آخر 7 أيام', d28: 'آخر 28 يومًا' },
  visits: '{n} زيارة مقاسة · {period}',
  bucket: { good: 'جيد', ok: 'مقبول', poor: 'ضعيف' },
  collecting: 'قيد الجمع',
  verdict: 'الحكم',
  vital: { lcp: 'ظهور الصفحة', inp: 'الاستجابة', cls: 'ثبات الصفحة', ttfb: 'أول بايت' },
  goodUpTo: 'جيد حتى {limit}',
  average: 'المتوسط {value}',
  seconds: '{n} ث',
  millis: '{n} مث',
  empty: {
    title: 'لا قياسات كافية بعد',
    body: 'نحكم على السرعة بعد {min} زيارة على الأقل من زوار حقيقيين — وصلت {n} في هذه المدة. وزن الشاشة الأولى أدناه لا يحتاج زوارًا.',
  },
  spread: { title: 'كيف ظهرت الصفحة لزوارك', share: '{word}: {pct} من الزيارات' },
  weight: {
    title: 'وزن الشاشة الأولى',
    lead: 'ما ينزّله هاتف الزائر قبل أول صف من المنتجات — لا يحتاج زوارًا.',
    source: { label: 'أي نسخة', published: 'المنشورة', draft: 'المسودة' },
    defaultPage: 'لم تنشر تصميمًا بعد — هذا وزن الصفحة التي يراها زبائنك الآن.',
    none: 'لا صور ولا فيديو في الشاشة الأولى.',
    unmeasured: 'غير مقاس',
    fixed: 'التطبيق والخط — ثابت لكل المتاجر',
    open: 'افتح',
  },
  label: {
    background: 'خلفية الصفحة',
    background_poster: 'صورة الخلفية الثابتة',
    logo: 'الشعار',
    banner: 'صورة الغلاف',
    hero_image: 'صورة واجهة المتجر',
    hero_video: 'فيديو واجهة المتجر',
    hero_poster: 'ملصق فيديو الواجهة',
    block_image: 'صورة في قسم',
    block_video: 'فيديو في قسم',
    block_poster: 'ملصق فيديو القسم',
    product_image: 'صور المنتجات (أول صف)',
  },
  hints: {
    title: 'ما الذي يسرّع متجرك',
    none: 'لا شيء يثقل شاشتك الأولى الآن.',
    gone: 'هذا القسم لم يعد في مسودتك.',
    unmeasured: 'بعض ملفات الشاشة الأولى غير مقاسة، فلا حكم عليها هنا.',
  },
  finding: {
    HERO_GIF: 'صورة الواجهة GIF بحجم {size} — استبدلها بفيديو قصير أو صورة WebP.',
    HERO_HEAVY: 'صورة الواجهة {size}، أثقل من {max} — اضغطها أو اختر صورة أخف.',
    BACKGROUND_VIDEO_ON_PHONE: 'فيديو الخلفية ({size}) يعمل على الهواتف — اعرض صورته الثابتة على الهاتف بدلًا منه.',
    AUTOPLAY_VIDEO_COUNT: 'فيديو يعمل وحده في الشاشة الأولى: {count} ({size}) — أوقف التشغيل التلقائي أو انقله إلى الأسفل.',
    POSTER_MISSING: 'فيديو بلا صورة ملصق — يرى الزائر فراغًا حتى يبدأ. اختر صورة ملصق.',
    PRODUCT_IMAGES_LARGE: 'صور أول صف من المنتجات ثقيلة: {size} في المتوسط، والمناسب حتى {max} — ارفع صورًا أخف لهذه المنتجات.',
    ABOVE_FOLD_BLOCKS: 'أقسام قبل أول منتج: {count} — أبقِ {max} أو أقل فوقه ليظهر ما تبيعه أسرع.',
    OK_IMAGES: 'صور الشاشة الأولى بأحجام مناسبة: {count} ({size}).',
  },
  door: {
    section: 'افتح القسم',
    sections: 'افتح الأقسام',
    background: 'افتح الخلفية',
    settings: 'افتح إعدادات المتجر',
    products: 'افتح المنتجات',
  },
  lab: {
    title: 'قياس مختبري',
    body: 'أداة Google تقيس صفحتك مرة واحدة من خوادمها — رقم مختلف عن زوارك الحقيقيين، ولا يدخل في الحكم أعلاه.',
    open: 'افحص في PageSpeed',
    external: 'يفتح في نافذة جديدة',
  },
  honesty:
    'الأرقام من زوار حقيقيين لمتجرك، لا من أداة: كل زائر يُحسب مرة في اليوم لكل جهاز، والحكم هو الفئة التي يقع فيها 75٪ من الزيارات — مقدَّر من الفئات، لا رقم دقيق.',
  error: 'تعذّر تحميل قياس السرعة.',
  loading: 'جارٍ تحميل قياس السرعة…',
  pulse: { poor: 'سرعة الصفحة على الهاتف: ضعيفة' },
};

export type SpeedStrings = typeof SPEED_AR;
export type SpeedLang = 'ar' | 'en' | 'ckb';

const SPEED_EN: SpeedStrings = {
  tab: 'Speed',
  title: 'Store speed',
  lead: 'How your page appears to your real customers, and what weighs its first screen down.',
  device: { label: 'Device', phone: 'Phone', desktop: 'Computer' },
  days: { label: 'Period', d7: 'Last 7 days', d28: 'Last 28 days' },
  visits: '{n} measured visits · {period}',
  bucket: { good: 'Good', ok: 'Fair', poor: 'Poor' },
  collecting: 'Collecting',
  verdict: 'Verdict',
  vital: { lcp: 'Page appears', inp: 'Response', cls: 'Stability', ttfb: 'First byte' },
  goodUpTo: 'Good up to {limit}',
  average: 'Average {value}',
  seconds: '{n} s',
  millis: '{n} ms',
  empty: {
    title: 'Not enough measurements yet',
    body: 'The speed is judged after at least {min} visits from real visitors — {n} so far in this period. The first-screen weight below needs no visitors.',
  },
  spread: { title: 'How the page appeared to your visitors', share: '{word}: {pct} of visits' },
  weight: {
    title: 'First-screen weight',
    lead: 'What a visitor’s phone downloads before the first row of products — needs no visitors.',
    source: { label: 'Which version', published: 'Published', draft: 'Draft' },
    defaultPage: 'You have not published a design yet — this is the weight of the page your customers see now.',
    none: 'No pictures or video on the first screen.',
    unmeasured: 'Not measured',
    fixed: 'The app and font — the same for every store',
    open: 'Open',
  },
  label: {
    background: 'Page background',
    background_poster: 'Background still',
    logo: 'Logo',
    banner: 'Cover picture',
    hero_image: 'Store header picture',
    hero_video: 'Store header video',
    hero_poster: 'Header video poster',
    block_image: 'Picture in a section',
    block_video: 'Video in a section',
    block_poster: 'Section video poster',
    product_image: 'Product pictures (first row)',
  },
  hints: {
    title: 'What will speed up your store',
    none: 'Nothing weighs down your first screen right now.',
    gone: 'This section is no longer in your draft.',
    unmeasured: 'Some first-screen files are not measured, so they are not judged here.',
  },
  finding: {
    HERO_GIF: 'Your header picture is a {size} GIF — replace it with a short video or a WebP picture.',
    HERO_HEAVY: 'Your header picture is {size}, heavier than {max} — compress it or pick a lighter one.',
    BACKGROUND_VIDEO_ON_PHONE: 'The background video ({size}) plays on phones — show its still picture on phones instead.',
    AUTOPLAY_VIDEO_COUNT: 'Videos that play on their own on the first screen: {count} ({size}) — turn autoplay off or move them lower.',
    POSTER_MISSING: 'A video has no poster — visitors see an empty box until it starts. Pick a poster picture.',
    PRODUCT_IMAGES_LARGE: 'The first row of product pictures is heavy: {size} on average, where up to {max} is fine — upload lighter pictures for these products.',
    ABOVE_FOLD_BLOCKS: 'Sections before the first product: {count} — keep {max} or fewer above it so what you sell shows sooner.',
    OK_IMAGES: 'The first screen’s pictures are a sensible size: {count} ({size}).',
  },
  door: {
    section: 'Open the section',
    sections: 'Open sections',
    background: 'Open the background',
    settings: 'Open store settings',
    products: 'Open products',
  },
  lab: {
    title: 'Lab test',
    body: 'Google’s tool measures your page once, from its own servers — a different number from your real visitors, and not part of the verdict above.',
    open: 'Test on PageSpeed',
    external: 'opens in a new window',
  },
  honesty:
    'These figures come from real visitors to your store, not from a tool: each visitor counts once a day per device, and the verdict is the band that holds 75% of visits — estimated from the bands, not an exact number.',
  error: 'Could not load the speed report.',
  loading: 'Loading the speed report…',
  pulse: { poor: 'Page speed on phones: poor' },
};

const SPEED_CKB: SpeedStrings = {
  tab: 'خێرایی',
  title: 'خێرایی فرۆشگاکەم',
  lead: 'پەڕەکەت چۆن بۆ کڕیارە ڕاستەقینەکانت دەردەکەوێت، و چی یەکەم شاشەکەی قورس دەکات.',
  device: { label: 'ئامێر', phone: 'مۆبایل', desktop: 'کۆمپیوتەر' },
  days: { label: 'ماوە', d7: '٧ ڕۆژی ڕابردوو', d28: '٢٨ ڕۆژی ڕابردوو' },
  visits: '{n} سەردانی پێوراو · {period}',
  bucket: { good: 'باش', ok: 'مامناوەند', poor: 'لاواز' },
  collecting: 'لە کۆکردنەوەدایە',
  verdict: 'بڕیار',
  vital: { lcp: 'دەرکەوتنی پەڕە', inp: 'وەڵامدانەوە', cls: 'جێگیری پەڕە', ttfb: 'یەکەم بایت' },
  goodUpTo: 'تا {limit} باشە',
  average: 'تێکڕا {value}',
  seconds: '{n} چرکە',
  millis: '{n} ملیچرکە',
  empty: {
    title: 'هێشتا پێوانەی پێویست نییە',
    body: 'خێرایی دوای لانیکەم {min} سەردانی سەردانکەری ڕاستەقینە هەڵدەسەنگێندرێت — تا ئێستا {n} لەم ماوەیەدا. قورسایی یەکەم شاشە لە خوارەوە پێویستی بە سەردانکەر نییە.',
  },
  spread: { title: 'پەڕەکە چۆن بۆ سەردانکەرانت دەرکەوت', share: '{word}: {pct}ی سەردانەکان' },
  weight: {
    title: 'قورسایی یەکەم شاشە',
    lead: 'ئەوەی مۆبایلی سەردانکەر پێش یەکەم ڕیزی بەرهەمەکان دایدەگرێت — پێویستی بە سەردانکەر نییە.',
    source: { label: 'کام وەشان', published: 'بڵاوکراوە', draft: 'ڕەشنووس' },
    defaultPage: 'هێشتا دیزاینێکت بڵاونەکردۆتەوە — ئەمە قورسایی ئەو پەڕەیەیە کە کڕیارەکانت ئێستا دەیبینن.',
    none: 'هیچ وێنە و ڤیدیۆیەک لە یەکەم شاشەدا نییە.',
    unmeasured: 'نەپێوراوە',
    fixed: 'بەرنامەکە و فۆنت — بۆ هەموو فرۆشگاکان وەک یەکە',
    open: 'بیکەرەوە',
  },
  label: {
    background: 'باکگراوندی پەڕە',
    background_poster: 'وێنەی جێگیری باکگراوند',
    logo: 'لۆگۆ',
    banner: 'وێنەی بەرگ',
    hero_image: 'وێنەی سەرەوەی فرۆشگا',
    hero_video: 'ڤیدیۆی سەرەوەی فرۆشگا',
    hero_poster: 'پۆستەری ڤیدیۆی سەرەوە',
    block_image: 'وێنە لە بەشێکدا',
    block_video: 'ڤیدیۆ لە بەشێکدا',
    block_poster: 'پۆستەری ڤیدیۆی بەش',
    product_image: 'وێنەی بەرهەمەکان (یەکەم ڕیز)',
  },
  hints: {
    title: 'چی فرۆشگاکەت خێراتر دەکات',
    none: 'ئێستا هیچ شتێک یەکەم شاشەکەت قورس ناکات.',
    gone: 'ئەم بەشە ئیتر لە ڕەشنووسەکەتدا نییە.',
    unmeasured: 'هەندێک فایلی یەکەم شاشە نەپێوراون، بۆیە لێرە هەڵناسەنگێندرێن.',
  },
  finding: {
    HERO_GIF: 'وێنەی سەرەوەکەت GIFـێکی {size}ـە — بە ڤیدیۆیەکی کورت یان وێنەیەکی WebP بیگۆڕە.',
    HERO_HEAVY: 'وێنەی سەرەوەکەت {size}ـە، لە {max} قورسترە — بچووکی بکەرەوە یان وێنەیەکی سووکتر هەڵبژێرە.',
    BACKGROUND_VIDEO_ON_PHONE: 'ڤیدیۆی باکگراوند ({size}) لە مۆبایلدا لێدەدرێت — لە جیاتی ئەو، وێنە جێگیرەکەی لە مۆبایلدا پیشان بدە.',
    AUTOPLAY_VIDEO_COUNT: 'ڤیدیۆی خۆکار لە یەکەم شاشەدا: {count} ({size}) — لێدانی خۆکار بکوژێنەوە یان بیانبە خوارەوە.',
    POSTER_MISSING: 'ڤیدیۆیەک پۆستەری نییە — سەردانکەر تا دەست پێدەکات بۆشایی دەبینێت. وێنەیەکی پۆستەر هەڵبژێرە.',
    PRODUCT_IMAGES_LARGE: 'وێنەکانی یەکەم ڕیزی بەرهەمەکان قورسن: بە تێکڕا {size}، کە تا {max} گونجاوە — وێنەی سووکتر بۆ ئەم بەرهەمانە باربکە.',
    ABOVE_FOLD_BLOCKS: 'بەشەکانی پێش یەکەم بەرهەم: {count} — {max} یان کەمتر لە سەرەوەی بهێڵەوە تا ئەوەی دەیفرۆشیت زووتر دەربکەوێت.',
    OK_IMAGES: 'وێنەکانی یەکەم شاشە قەبارەیان گونجاوە: {count} ({size}).',
  },
  door: {
    section: 'بەشەکە بکەرەوە',
    sections: 'بەشەکان بکەرەوە',
    background: 'باکگراوند بکەرەوە',
    settings: 'ڕێکخستنەکانی فرۆشگا بکەرەوە',
    products: 'بەرهەمەکان بکەرەوە',
  },
  lab: {
    title: 'پێوانی تاقیگەیی',
    body: 'ئامرازی Google جارێک لە ڕاژەکارەکانی خۆیەوە پەڕەکەت دەپێوێت — ژمارەیەکی جیاواز لە سەردانکەرە ڕاستەقینەکانت، و بەشێک نییە لە بڕیارەکەی سەرەوە.',
    open: 'لە PageSpeed تاقی بکەرەوە',
    external: 'لە پەنجەرەیەکی نوێدا دەکرێتەوە',
  },
  honesty:
    'ژمارەکان لە سەردانکەرە ڕاستەقینەکانی فرۆشگاکەتەوەن، نەک لە ئامرازێک: هەر سەردانکەرێک ڕۆژانە بۆ هەر ئامێرێک یەک جار دەژمێردرێت، و بڕیارەکە ئەو ئاستەیە کە ٧٥٪ی سەردانەکانی تێدایە — لە ئاستەکانەوە خەمڵێنراوە، نەک ژمارەیەکی ورد.',
  error: 'ڕاپۆرتی خێرایی بار نەکرا.',
  loading: 'ڕاپۆرتی خێرایی بار دەکرێت…',
  pulse: { poor: 'خێرایی پەڕە لە مۆبایلدا: لاواز' },
};

export const SPEED_STRINGS: Readonly<Record<SpeedLang, SpeedStrings>> = { ar: SPEED_AR, en: SPEED_EN, ckb: SPEED_CKB };

export function speedLang(lang: string): SpeedLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

/** The speed table for the current language. */
export function useSpeedStrings(): SpeedStrings {
  const { lang } = useLanguage();
  return SPEED_STRINGS[speedLang(lang)];
}

/** «{n} زيارة» → «312 زيارة»: every `{name}` replaced; a missing value leaves nothing behind. */
export function fillSpeed(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : '')).replace(/\s{2,}/g, ' ').trim();
}

// -------------------------------------------------------- media everywhere (P5)

/**
 * MEDIA EVERYWHERE — the builder's words for storefront L3–L8 and B1–B3
 * (docs/MERCHANT_PLATFORM_V2.md): the media library v2 (bytes, «مستخدم في»,
 * delete, the slot's weight cap, poster capture), the hero video, a block's
 * schedule, the Page panel's notice / footer links / background, and the
 * «معاينة على هاتفي» QR. The four refusal sentences (`tooHeavy`, `inUse`,
 * `notFound`, `posterRequired`) are src/lib/refusalStrings.ts's VERBATIM —
 * the picker says before an upload exactly what the server would say after
 * it (tests/storeDesignPagePanel.test.ts holds the copies to the table).
 */
const MEDIA_AR = {
  library: {
    usedIn: 'مستخدم في: {where}',
    unused: 'غير مستخدم',
    itemImage: 'صورة {n} من {total}',
    itemVideo: 'فيديو {n} من {total}',
    where: {
      layout: 'صفحة المتجر',
      showcase: 'معرض الأعمال',
      collection: 'مجموعة',
      product: 'منتج',
      service: 'خدمة',
      store: 'شعار المتجر أو غلافه',
      avatar: 'صورة الحساب',
      post: 'منشور في المجتمع',
      other: 'مكان آخر في متجرك',
    },
    cap: 'الحد هنا {max}',
    tooHeavy: 'الملف {size} يتجاوز حدّ هذا الموضع ({max}). اضغطه أو اختر ملفًا أخف.',
    tooHeavyShort: 'أثقل من حدّ هذا الموضع',
    inUse: 'هذا الملف مستخدم في: {where}. أزله من هناك أولًا.',
    notFound: 'هذا الملف لم يعد في مكتبة متجرك.',
    delete: 'حذف',
    deleteLabel: 'حذف هذا الملف من المكتبة',
    deleteTitle: 'حذف الملف من مكتبتك؟',
    deleteBody: 'يخرج من مكتبة متجرك ولا يعود. لا يُحذف ملف ما زال متجرك يعرضه.',
    deleteConfirm: 'احذف',
    deleted: 'حُذف الملف من المكتبة.',
    deleteFailed: 'تعذّر حذف الملف. حاول مجددًا.',
    uploading: 'جارٍ الرفع…',
    preparing: 'جارٍ تجهيز الصورة…',
    kindVideo: 'هذا ليس فيديو.',
    kindImage: 'هذه ليست صورة.',
    videoNote: 'MP4 أو WebM. يُعرض من متجرك مباشرة، بلا تضمين خارجي.',
    posterCapturing: 'جارٍ التقاط ملصق من الفيديو…',
    posterCaptured: 'التُقط ملصق من الفيديو.',
    posterFailed: 'تعذّر التقاط ملصق من هذا الفيديو — اختر صورة ملصق.',
    posterRequired: 'اختر صورة ملصق للفيديو حتى يظهر شيء قبل التشغيل.',
  },
  hero: {
    video: 'فيديو الواجهة',
    videoHint: 'يظهر الملصق أولًا، ويُشغَّل الفيديو صامتًا حين يلمسه الزائر.',
    videoOnPhone: 'يعمل على الهاتف أيضًا',
    videoOnPhoneHint: 'دونه يرى الهاتف الملصق وحده — أخف على بيانات زبائنك.',
    posterNote: 'هذه الصورة هي ملصق الفيديو أيضًا.',
  },
  schedule: {
    title: 'الجدولة',
    from: 'يظهر من',
    until: 'حتى',
    hint: 'فارغ = دائمًا. يراه زوارك بين الموعدين فقط؛ المعاينة تُظهره دائمًا.',
    clear: 'بلا جدولة',
    order: 'موعد النهاية يجب أن يأتي بعد موعد البداية.',
  },
  page: {
    notice: 'شريط الإعلان',
    noticeText: 'نص الإعلان',
    noticeHint: 'سطر قصير أعلى صفحتك — اتركه فارغًا لإخفاء الشريط.',
    noticeLink: 'عند الضغط عليه',
    from: 'يظهر من',
    until: 'حتى',
    windowHint: 'فارغ = يبقى ظاهرًا.',
    windowOrder: 'موعد النهاية يجب أن يأتي بعد موعد البداية.',
    links: 'روابط التذييل',
    linkLabel: 'نص الرابط',
    linkTarget: 'إلى',
    addLink: 'أضف رابطًا',
    moveUp: 'نقل الرابط للأعلى',
    moveDown: 'نقل الرابط للأسفل',
    removeLink: 'حذف الرابط',
    linksNone: 'لا تظهر الروابط إن كانت الصفحة بلا تذييل.',
    linkIncomplete: 'رابط بلا نص — لن يظهر حتى تكتب نصه.',
    background: 'الخلفية',
    backgroundHint: 'تظهر حول أقسامك؛ تبقى الأقسام على أرضية متجرك ليُقرأ كل شيء.',
    kindLabel: 'نوع الخلفية',
    kind: { none: 'بلا خلفية', image: 'صورة', video: 'فيديو' },
    image: 'صورة الخلفية',
    imageHint: 'صورة أو GIF متحرك ضمن الحد. الـGIF يتحرك على الشاشات الواسعة فقط، ويراه الهاتف ومن طلب تقليل الحركة صورةً ثابتة.',
    video: 'فيديو الخلفية',
    poster: 'ملصق الفيديو',
    posterHint: 'ما يظهر قبل التشغيل، وعلى الهاتف بدل الفيديو.',
    dim: 'التعتيم',
    dims: { light: 'خفيف', medium: 'متوسط', heavy: 'عميق' },
    phones: 'يعمل الفيديو على الهاتف أيضًا',
    phonesHint: 'على الهاتف تُعرض الصورة الثابتة بدل الفيديو.',
  },
  qr: {
    open: 'معاينة على هاتفي',
    title: 'افتح المسودة على هاتفك',
    body: 'امسح الرمز بكاميرا هاتفك. تفتح المعاينة لك وحدك وأنت مسجّل الدخول بحساب متجرك — زبائنك لا يرونها.',
    alt: 'رمز QR لمعاينة المسودة',
    copy: 'انسخ الرابط',
    copied: 'نُسخ الرابط',
    copyFailed: 'تعذّر النسخ — حدّد الرابط وانسخه بنفسك.',
    unavailable: 'الرابط أطول من أن يُرسم رمزًا — انسخه وافتحه على هاتفك.',
    close: 'إغلاق',
  },
};

export type MediaStrings = typeof MEDIA_AR;

const MEDIA_EN: MediaStrings = {
  library: {
    usedIn: 'Used in: {where}',
    unused: 'Not used',
    itemImage: 'Picture {n} of {total}',
    itemVideo: 'Video {n} of {total}',
    where: {
      layout: 'the store page',
      showcase: 'the showcase',
      collection: 'a collection',
      product: 'a product',
      service: 'a service',
      store: 'the store logo or banner',
      avatar: 'the account picture',
      post: 'a community post',
      other: 'somewhere else on your store',
    },
    cap: 'The limit here is {max}',
    tooHeavy: "The file is {size}, over this slot's {max} limit. Compress it or pick a lighter one.",
    tooHeavyShort: 'Heavier than this slot allows',
    inUse: 'This file is used in: {where}. Remove it there first.',
    notFound: "This file is no longer in your store's library.",
    delete: 'Delete',
    deleteLabel: 'Delete this file from the library',
    deleteTitle: 'Delete the file from your library?',
    deleteBody: 'It leaves your store’s library for good. A file your store still shows is never deleted.',
    deleteConfirm: 'Delete',
    deleted: 'The file was deleted from the library.',
    deleteFailed: 'The file could not be deleted. Try again.',
    uploading: 'Uploading…',
    preparing: 'Preparing the picture…',
    kindVideo: 'That is not a video.',
    kindImage: 'That is not a picture.',
    videoNote: 'MP4 or WebM. Played from your store directly, never embedded.',
    posterCapturing: 'Capturing a poster from the video…',
    posterCaptured: 'A poster was captured from the video.',
    posterFailed: 'A poster could not be captured from this video — pick a poster picture.',
    posterRequired: 'Pick a poster image so something shows before the video plays.',
  },
  hero: {
    video: 'Header video',
    videoHint: 'The poster shows first; the video plays, muted, when a visitor taps it.',
    videoOnPhone: 'Play on phones too',
    videoOnPhoneHint: 'Without it, phones show the poster only — lighter on your customers’ data.',
    posterNote: 'This picture is also the video’s poster.',
  },
  schedule: {
    title: 'Schedule',
    from: 'Shows from',
    until: 'Until',
    hint: 'Empty = always. Visitors see it only between the two times; the preview always shows it.',
    clear: 'No schedule',
    order: 'The end must come after the start.',
  },
  page: {
    notice: 'Announcement bar',
    noticeText: 'Announcement text',
    noticeHint: 'One short line at the top of your page — leave it empty to hide the bar.',
    noticeLink: 'When tapped',
    from: 'Shows from',
    until: 'Until',
    windowHint: 'Empty = always shown.',
    windowOrder: 'The end must come after the start.',
    links: 'Footer links',
    linkLabel: 'Link text',
    linkTarget: 'Goes to',
    addLink: 'Add a link',
    moveUp: 'Move the link up',
    moveDown: 'Move the link down',
    removeLink: 'Remove the link',
    linksNone: 'The links do not show when the page has no footer.',
    linkIncomplete: 'A link without text — it will not show until you write it.',
    background: 'Background',
    backgroundHint: 'It shows around your sections; the sections stay on your store’s ground so everything reads.',
    kindLabel: 'Background kind',
    kind: { none: 'No background', image: 'Picture', video: 'Video' },
    image: 'Background picture',
    imageHint: 'A picture or an animated GIF, within the limit. A GIF moves on wide screens only; phones and visitors who reduce motion see it still.',
    video: 'Background video',
    poster: 'Video poster',
    posterHint: 'What shows before it plays, and on phones instead of the video.',
    dim: 'Dim',
    dims: { light: 'Soft', medium: 'Medium', heavy: 'Deep' },
    phones: 'Play the video on phones too',
    phonesHint: 'Phones see the still image instead of the video.',
  },
  qr: {
    open: 'Preview on my phone',
    title: 'Open the draft on your phone',
    body: 'Scan the code with your phone’s camera. The preview opens for you alone, signed in to your store’s account — customers never see it.',
    alt: 'QR code for the draft preview',
    copy: 'Copy the link',
    copied: 'Link copied',
    copyFailed: 'Could not copy — select the link and copy it yourself.',
    unavailable: 'The link is too long for a code — copy it and open it on your phone.',
    close: 'Close',
  },
};

const MEDIA_CKB: MediaStrings = {
  library: {
    usedIn: 'بەکارهاتووە لە: {where}',
    unused: 'بەکارنەهاتووە',
    itemImage: 'وێنەی {n} لە {total}',
    itemVideo: 'ڤیدیۆی {n} لە {total}',
    where: {
      layout: 'پەڕەی فرۆشگا',
      showcase: 'پیشانگای کارەکان',
      collection: 'کۆمەڵەیەک',
      product: 'بەرهەمێک',
      service: 'خزمەتگوزارییەک',
      store: 'لۆگۆ یان بەرگی فرۆشگا',
      avatar: 'وێنەی هەژمار',
      post: 'پۆستێک لە کۆمەڵگە',
      other: 'شوێنێکی تری فرۆشگاکەت',
    },
    cap: 'سنووری ئێرە: {max}',
    tooHeavy: 'فایلەکە {size}ـە و لە سنووری ئەم شوێنە ({max}) زیاترە. بچووکی بکەرەوە یان فایلێکی سووکتر هەڵبژێرە.',
    tooHeavyShort: 'لە سنووری ئەم شوێنە قورسترە',
    inUse: 'ئەم فایلە بەکارهاتووە لە: {where}. سەرەتا لەوێ لایبە.',
    notFound: 'ئەم فایلە چیتر لە کتێبخانەی فرۆشگاکەتدا نییە.',
    delete: 'سڕینەوە',
    deleteLabel: 'سڕینەوەی ئەم فایلە لە کتێبخانە',
    deleteTitle: 'فایلەکە لە کتێبخانەکەت بسڕدرێتەوە؟',
    deleteBody: 'لە کتێبخانەی فرۆشگاکەت دەردەچێت و ناگەڕێتەوە. فایلێک کە فرۆشگاکەت هێشتا پیشانی دەدات هەرگیز ناسڕدرێتەوە.',
    deleteConfirm: 'بیسڕەوە',
    deleted: 'فایلەکە لە کتێبخانە سڕایەوە.',
    deleteFailed: 'فایلەکە نەسڕایەوە. دووبارە هەوڵ بدە.',
    uploading: 'بار دەکرێت…',
    preparing: 'وێنەکە ئامادە دەکرێت…',
    kindVideo: 'ئەمە ڤیدیۆ نییە.',
    kindImage: 'ئەمە وێنە نییە.',
    videoNote: 'MP4 یان WebM. ڕاستەوخۆ لە فرۆشگاکەتەوە پیشان دەدرێت، بەبێ تێخستنی دەرەکی.',
    posterCapturing: 'پۆستەرێک لە ڤیدیۆکە دەگیرێت…',
    posterCaptured: 'پۆستەرێک لە ڤیدیۆکە گیرا.',
    posterFailed: 'نەتوانرا پۆستەرێک لەم ڤیدیۆیە بگیرێت — وێنەی پۆستەر هەڵبژێرە.',
    posterRequired: 'وێنەی پۆستەر بۆ ڤیدیۆکە هەڵبژێرە تا پێش لێدان شتێک دەربکەوێت.',
  },
  hero: {
    video: 'ڤیدیۆی سەرەوە',
    videoHint: 'سەرەتا پۆستەرەکە دەردەکەوێت، و ڤیدیۆکە بێدەنگ لێدەدرێت کاتێک سەردانکەر دەستی لێدەدات.',
    videoOnPhone: 'لە مۆبایلیشدا کار بکات',
    videoOnPhoneHint: 'بەبێ ئەمە مۆبایل تەنها پۆستەرەکە دەبینێت — سووکترە بۆ داتای کڕیارەکانت.',
    posterNote: 'ئەم وێنەیە پۆستەری ڤیدیۆکەشە.',
  },
  schedule: {
    title: 'خشتەکردن',
    from: 'پیشان دەدرێت لە',
    until: 'تا',
    hint: 'بەتاڵ = هەمیشە. سەردانکەرانت تەنها لە نێوان ئەو دوو کاتەدا دەیبینن؛ پێشبینین هەمیشە پیشانی دەدات.',
    clear: 'بەبێ خشتە',
    order: 'کاتی کۆتایی دەبێت دوای کاتی دەستپێکردن بێت.',
  },
  page: {
    notice: 'شریتی ڕاگەیاندن',
    noticeText: 'دەقی ڕاگەیاندن',
    noticeHint: 'دێڕێکی کورت لە سەرەوەی پەڕەکەت — بەتاڵی بهێڵەوە بۆ شاردنەوەی شریتەکە.',
    noticeLink: 'کاتێک دەستی لێدەدرێت',
    from: 'پیشان دەدرێت لە',
    until: 'تا',
    windowHint: 'بەتاڵ = هەمیشە دیارە.',
    windowOrder: 'کاتی کۆتایی دەبێت دوای کاتی دەستپێکردن بێت.',
    links: 'بەستەرەکانی خوارەوە',
    linkLabel: 'دەقی بەستەر',
    linkTarget: 'بۆ',
    addLink: 'بەستەرێک زیاد بکە',
    moveUp: 'بەستەرەکە بەرەو سەرەوە ببە',
    moveDown: 'بەستەرەکە بەرەو خوارەوە ببە',
    removeLink: 'سڕینەوەی بەستەر',
    linksNone: 'ئەگەر پەڕەکە خوارەوەی نەبێت، بەستەرەکان دەرناکەون.',
    linkIncomplete: 'بەستەرێک بەبێ دەق — تا دەقەکەی نەنووسیت دەرناکەوێت.',
    background: 'باکگراوند',
    backgroundHint: 'لە دەوری بەشەکانت دەردەکەوێت؛ بەشەکان لەسەر زەمینەی فرۆشگاکەت دەمێننەوە تا هەموو شتێک بخوێنرێتەوە.',
    kindLabel: 'جۆری باکگراوند',
    kind: { none: 'بەبێ باکگراوند', image: 'وێنە', video: 'ڤیدیۆ' },
    image: 'وێنەی باکگراوند',
    imageHint: 'وێنە، یان وێنەی جووڵاوی GIF، لە ناو سنووردا. GIF تەنها لە شاشەی پان دەجووڵێت؛ مۆبایل و ئەوانەی جووڵە کەم دەکەنەوە وەک وێنەی جێگیر دەیبینن.',
    video: 'ڤیدیۆی باکگراوند',
    poster: 'پۆستەری ڤیدیۆ',
    posterHint: 'ئەوەی پێش لێدان دەردەکەوێت، و لە مۆبایلدا لە جیاتی ڤیدیۆ.',
    dim: 'تاریککردن',
    dims: { light: 'سووک', medium: 'مامناوەند', heavy: 'قووڵ' },
    phones: 'ڤیدیۆکە لە مۆبایلیشدا کار بکات',
    phonesHint: 'لە مۆبایلدا وێنەی جێگیر دەبینرێت لە جیاتی ڤیدیۆ.',
  },
  qr: {
    open: 'پێشبینین لە مۆبایلەکەم',
    title: 'ڕەشنووسەکە لە مۆبایلەکەت بکەرەوە',
    body: 'کۆدەکە بە کامێرای مۆبایلەکەت بخوێنەوە. پێشبینینەکە تەنها بۆ تۆ دەکرێتەوە کاتێک بە هەژماری فرۆشگاکەت چوویتە ژوورەوە — کڕیارەکانت نایبینن.',
    alt: 'کۆدی QR بۆ پێشبینینی ڕەشنووس',
    copy: 'بەستەرەکە کۆپی بکە',
    copied: 'بەستەرەکە کۆپی کرا',
    copyFailed: 'کۆپی نەکرا — بەستەرەکە دیاری بکە و خۆت کۆپی بکە.',
    unavailable: 'بەستەرەکە درێژترە لەوەی بکرێتە کۆد — کۆپی بکە و لە مۆبایلەکەت بیکەرەوە.',
    close: 'داخستن',
  },
};

export const MEDIA_STRINGS: Readonly<Record<SpeedLang, MediaStrings>> = { ar: MEDIA_AR, en: MEDIA_EN, ckb: MEDIA_CKB };

/** The media table for the current language. */
export function useMediaStrings(): MediaStrings {
  const { lang } = useLanguage();
  return MEDIA_STRINGS[speedLang(lang)];
}

/** The media table for a language code (anything the app does not carry reads Arabic). */
export function mediaStrings(lang: string): MediaStrings {
  return MEDIA_STRINGS[speedLang(lang)];
}
