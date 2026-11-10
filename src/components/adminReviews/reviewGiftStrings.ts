/**
 * THE ADMIN'S WORDS FOR THE SCORE AND THE CODE (DECISIONS row 301), in Arabic,
 * English and Sorani. A key missing from a language is a compile error, and the
 * Sorani is its own (row 183): tests/reviewGiftAdmin.test.ts holds that.
 *
 * `readySentence` is what the admin copies and sends by hand, in the customer's
 * language: nothing here is ever sent automatically, and the owner approves
 * customer messages (CLAUDE.md).
 */
export type ReviewGiftLang = 'ar' | 'en' | 'ckb';

const ar = {
  scoreLabel: 'الدرجة النهائية (من {from} إلى {to})',
  scoreInvalid: 'اكتب عددًا صحيحًا من {from} إلى {to}.',
  scoreHint: 'مسبقًا درجة النظام. غيّرها إن رأيت غير ذلك؛ الدرجة مستقلة عن عدد النجوم.',
  systemScore: 'درجة النظام: {n}',
  opensOne: 'يفتح المستوى {list}',
  opensMany: 'يفتح المستويات {list}',
  partText: 'النص',
  partImages: 'الصور',
  partVideo: 'الفيديو',
  partStory: 'ستوري إنستغرام',
  partStars: 'النجوم',
  warnOff: 'المستوى {n} موقوف: لن تظهر هداياه للزبون.',
  warnEmpty: 'المستوى {n} بلا هدايا.',
  warnSold: 'هدايا المستوى {n} نفدت الآن.',
  allEmpty: 'كل المستويات التي تفتحها هذه الدرجة فارغة، فلا يمكن الاعتماد الآن. أضف هدية إلى أحدها أو فعّله أولًا.',
  openLevels: 'افتح مستويات الهدايا',
  approve: 'اعتماد وإصدار الكود',
  codeTitle: 'كود الهدية',
  copyCode: 'نسخ الكود',
  copied: 'نُسخ',
  copyFailed: 'تعذّر النسخ: الكود ظاهر لتنسخه بنفسك',
  sentenceTitle: 'رسالة جاهزة بلغة الزبون',
  sentenceHint: 'تُنسخ فقط، ولا يُرسل شيء تلقائيًا: أرسلها أنت للزبون.',
  copySentence: 'نسخ الرسالة',
  stateWaiting: 'بانتظار أن يكتبه الزبون',
  stateRedeemed: 'استخدمه الزبون في {date}',
  stateVoidReturned: 'بطل الكود: أُعيدت الطابعة التي قُيّمت إلى المتجر، فلا يفتح هدية.',
  stateVoidCancelled: 'بطل الكود: أُلغي طلب الطابعة التي قُيّمت، فلا يفتح هدية.',
  regenerate: 'إصدار كود جديد',
  regenerateTitle: 'إصدار كود جديد؟',
  regenerateBody: 'يتوقف الكود الحالي فورًا، وعليك إعطاء الزبون الكود الجديد.',
  regenerateGo: 'إصدار الكود',
  regenerateFailed: 'تعذّر إصدار كود جديد. أعد المحاولة.',
  cancel: 'إلغاء',
  finalLine: 'الدرجة النهائية: {score} من {max}',
  oldPath: 'اعتُمدت قبل نظام الكود: هديتها في «الهدايا الممنوحة».',
};

export type ReviewGiftKey = keyof typeof ar;

const en: Record<ReviewGiftKey, string> = {
  scoreLabel: 'Final score ({from} to {to})',
  scoreInvalid: 'Enter a whole number from {from} to {to}.',
  scoreHint: "Starts at the system's score. Change it if you see it differently; the score is independent of the stars.",
  systemScore: 'System score: {n}',
  opensOne: 'Opens level {list}',
  opensMany: 'Opens levels {list}',
  partText: 'Text',
  partImages: 'Photos',
  partVideo: 'Video',
  partStory: 'Instagram story',
  partStars: 'Stars',
  warnOff: 'Level {n} is switched off: its gifts will not show to the customer.',
  warnEmpty: 'Level {n} has no gifts.',
  warnSold: "Level {n}'s gifts are sold out right now.",
  allEmpty: 'Every level this score opens is empty, so it cannot be approved yet. Add a gift to one of them, or switch it on, first.',
  openLevels: 'Open the gift levels',
  approve: 'Approve and issue the code',
  codeTitle: 'Gift code',
  copyCode: 'Copy the code',
  copied: 'Copied',
  copyFailed: "Couldn't copy: the code is shown so you can copy it yourself",
  sentenceTitle: "A ready message in the customer's language",
  sentenceHint: 'Copy only; nothing is sent automatically. You send it to the customer.',
  copySentence: 'Copy the message',
  stateWaiting: 'Waiting for the customer to write it',
  stateRedeemed: 'Used by the customer on {date}',
  stateVoidReturned: 'Code void: the reviewed printer went back to the shop, so it opens no gift.',
  stateVoidCancelled: "Code void: the reviewed printer's order was cancelled, so it opens no gift.",
  regenerate: 'Issue a new code',
  regenerateTitle: 'Issue a new code?',
  regenerateBody: 'The current code stops working at once, and you must give the customer the new one.',
  regenerateGo: 'Issue the code',
  regenerateFailed: "The new code couldn't be issued. Try again.",
  cancel: 'Cancel',
  finalLine: 'Final score: {score} of {max}',
  oldPath: 'Approved before the code system: its gift is under «Granted gifts».',
};

const ckb: Record<ReviewGiftKey, string> = {
  scoreLabel: 'نمرەی کۆتایی (لە {from} تا {to})',
  scoreInvalid: 'ژمارەیەکی تەواو لە {from} تا {to} بنووسە.',
  scoreHint: 'لە نمرەی سیستەمەوە دەست پێدەکات. ئەگەر جیاواز دەبینیت بیگۆڕە؛ نمرەکە سەربەخۆیە لە ئەستێرەکان.',
  systemScore: 'نمرەی سیستەم: {n}',
  opensOne: 'ئاستی {list} دەکاتەوە',
  opensMany: 'ئاستەکانی {list} دەکاتەوە',
  partText: 'دەق',
  partImages: 'وێنەکان',
  partVideo: 'ڤیدیۆ',
  partStory: 'ستۆری ئینستاگرام',
  partStars: 'ئەستێرەکان',
  warnOff: 'ئاستی {n} ڕاگیراوە: دیارییەکانی بۆ کڕیار دەرناکەون.',
  warnEmpty: 'ئاستی {n} هیچ دیارییەکی تێدا نییە.',
  warnSold: 'دیارییەکانی ئاستی {n} ئێستا نەماون.',
  allEmpty: 'هەموو ئەو ئاستانەی ئەم نمرەیە دەیانکاتەوە بەتاڵن، بۆیە ئێستا پەسەند ناکرێت. سەرەتا دیارییەک بۆ یەکێکیان زیاد بکە یان چالاکی بکە.',
  openLevels: 'ئاستەکانی دیاری بکەرەوە',
  approve: 'پەسەندکردن و دەرکردنی کۆد',
  codeTitle: 'کۆدی دیاری',
  copyCode: 'کۆدەکە کۆپی بکە',
  copied: 'کۆپی کرا',
  copyFailed: 'کۆپی نەکرا: کۆدەکە دیارە بۆ ئەوەی خۆت کۆپی بکەیت',
  sentenceTitle: 'نامەیەکی ئامادە بە زمانی کڕیار',
  sentenceHint: 'تەنها کۆپی دەکرێت، و هیچ شتێک خۆکارانە نانێردرێت. خۆت بۆ کڕیاری بنێرە.',
  copySentence: 'نامەکە کۆپی بکە',
  stateWaiting: 'چاوەڕێی نووسینی لەلایەن کڕیارەوە',
  stateRedeemed: 'کڕیار لە {date} بەکاری هێنا',
  stateVoidReturned: 'کۆدەکە بەتاڵ بووەوە: ئەو چاپکەرەی هەڵسەنگێنرا گەڕێنرایەوە بۆ فرۆشگا، بۆیە دیاری ناکاتەوە.',
  stateVoidCancelled: 'کۆدەکە بەتاڵ بووەوە: داواکاریی ئەو چاپکەرەی هەڵسەنگێنرا هەڵوەشێنرایەوە، بۆیە دیاری ناکاتەوە.',
  regenerate: 'دەرکردنی کۆدێکی نوێ',
  regenerateTitle: 'کۆدێکی نوێ دەربکرێت؟',
  regenerateBody: 'کۆدی ئێستا یەکسەر لە کار دەکەوێت، و دەبێت کۆدە نوێیەکە بدەیت بە کڕیار.',
  regenerateGo: 'کۆدەکە دەربکە',
  regenerateFailed: 'کۆدی نوێ دەرنەکرا. دووبارە هەوڵ بدەرەوە.',
  cancel: 'پاشگەزبوونەوە',
  finalLine: 'نمرەی کۆتایی: {score} لە {max}',
  oldPath: 'پێش سیستەمی کۆد پەسەندکرا: دیارییەکەی لە «دیارییە بەخشراوەکان»دایە.',
};

export const REVIEW_GIFT_STRINGS: Readonly<Record<ReviewGiftLang, Readonly<Record<ReviewGiftKey, string>>>> = { ar, en, ckb };

export function reviewGiftText(lang: string, key: ReviewGiftKey, vars?: Record<string, string | number>): string {
  const table = REVIEW_GIFT_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
  const raw = table[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (mark, name: string) => (name in vars ? String(vars[name]) : mark));
}

type Row3 = readonly [ar: string, en: string, ckb: string];

/** What the system saw in a review (worker/lib/reviewQuality.ts): its keys are for the server, these are for the team. */
export const REVIEW_FACT_WORDS: Readonly<Record<string, Row3>> = {
  text_40_chars: ['نص من 40 حرفًا فأكثر', 'Text of 40 letters or more', 'دەقی 40 پیت یان زیاتر'],
  meaningful_text: ['نص من 100 حرف فأكثر', 'Text of 100 letters or more', 'دەقی 100 پیت یان زیاتر'],
  detailed_text: ['نص مفصّل من 220 حرفًا فأكثر', 'Detailed text of 220 letters or more', 'دەقی ورد بە 220 پیت یان زیاتر'],
  varied_language: ['لغة متنوعة', 'Varied wording', 'زمانی هەمەچەشن'],
  unique_images: ['صور فريدة', 'Unique photos', 'وێنەی ڕەسەن'],
  three_or_more_images: ['ثلاث صور فأكثر', 'Three photos or more', 'سێ وێنە یان زیاتر'],
  high_quality_images: ['صور عالية الجودة', 'High-quality photos', 'وێنەی کوالیتی بەرز'],
  video_present: ['فيها فيديو', 'Has a video', 'ڤیدیۆی تێدایە'],
  useful_video: ['فيديو مفيد', 'A useful video', 'ڤیدیۆیەکی بەسوود'],
  supporting_evidence: ['دليل ستوري إنستغرام', 'Instagram story evidence', 'بەڵگەی ستۆری ئینستاگرام'],
  repetitive_text: ['نص مكرر', 'Repetitive text', 'دەقی دووبارەکراوە'],
  padded_text: ['نص محشو بالتكرار', 'Text padded with repeats', 'دەقی پڕکراو بە دووبارەکردنەوە'],
  duplicate_text: ['النص نفسه في مراجعة سابقة', 'The same text as an earlier review', 'هەمان دەقی هەڵسەنگاندنێکی پێشوو'],
  duplicate_media: ['الصورة نفسها أكثر من مرة', 'The same photo more than once', 'هەمان وێنە زیاتر لە جارێک'],
  reused_media: ['وسائط من مراجعة سابقة', 'Media from an earlier review', 'میدیا لە هەڵسەنگاندنێکی پێشوو'],
  low_quality_image: ['صورة منخفضة الجودة', 'A low-quality photo', 'وێنەیەکی کوالیتی نزم'],
  low_quality_video: ['فيديو منخفض الجودة', 'A low-quality video', 'ڤیدیۆیەکی کوالیتی نزم'],
};

/** A reason or a signal in the reader's language; a key a newer server adds reads as itself. */
export function reviewFactWord(lang: string, key: string): string {
  const row = REVIEW_FACT_WORDS[key];
  return row ? row[lang === 'en' ? 1 : lang === 'ckb' ? 2 : 0] : key;
}

/** A code, grouped so it can be read aloud: GFT-7KQ-4MZX. The server reads it with or without the dashes. */
export function formatGiftCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}` : code;
}

const SENTENCE: Readonly<Record<ReviewGiftLang, { hello: string; helloName: string; body: string }>> = {
  ar: {
    hello: 'مرحبًا',
    helloName: 'مرحبًا {name}',
    body: '{hello}، شكرًا على مراجعتك لـ «{printer}». كود هديتك من Levonis: {code}. أدخله في «قيّم طابعتك» ضمن المكافآت لتختار هديتك، وتدفع أجرة التوصيل فقط: {url}',
  },
  en: {
    hello: 'Hello',
    helloName: 'Hello {name}',
    body: '{hello}, thank you for your review of «{printer}». Your Levonis gift code is {code}. Enter it in «Rate your printer» under Rewards to choose your gift; you pay for delivery only: {url}',
  },
  ckb: {
    hello: 'سڵاو',
    helloName: 'سڵاو {name}',
    body: '{hello}، سوپاس بۆ هەڵسەنگاندنەکەت بۆ «{printer}». کۆدی دیارییەکەت لە Levonis ئەمەیە: {code}. لە «چاپکەرەکەت هەڵبسەنگێنە» لەناو خەڵاتەکاندا بینووسە بۆ هەڵبژاردنی دیارییەکەت، و تەنها کرێی گەیاندن دەدەیت: {url}',
  },
};

/** The message the admin copies, in the customer's language. Copy only. */
export function readySentence(lang: string, v: { name: string; printer: string; code: string; origin: string }): string {
  const s = SENTENCE[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
  const name = v.name.trim();
  return s.body
    .replace('{hello}', () => (name ? s.helloName.replace('{name}', () => name) : s.hello))
    .replace('{printer}', () => v.printer)
    .replace('{code}', () => formatGiftCode(v.code))
    .replace('{url}', () => `${v.origin}/rewards/rate`);
}
