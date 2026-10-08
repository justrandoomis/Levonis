import type { Language } from '../../translations';

/**
 * The scanner's words, in all three languages. The Sorani lines that already
 * existed for the warranty scanner (src/components/warranty/strings.ts) are
 * reused verbatim; the rest were written for the serial scan at order
 * preparation (2026-10-07) — a `ckb` line never carries the Arabic
 * (docs/DECISIONS.md row 183; serial spec §5.8).
 */
export interface ScannerStrings {
  title: string;
  close: string;
  starting: string;
  slow: string;
  looking: string;
  lookingLabel: string;
  denied: string;
  deniedHelp: string;
  unavailable: string;
  insecure: string;
  failed: string;
  paused: string;
  nothing: string;
  decoding: string;
  choosePhoto: string;
  captured: string;
  aimAtSn: string;
  boxOnly: string;
  torchOn: string;
  torchOff: string;
  tapToFocus: string;
  manualLabel: string;
  manualPlaceholder: string;
  manualSubmit: string;
  retry: string;
  added: string;
  duplicate: string;
  invalid: string;
  /** Continuous mode, while the read is being registered. */
  registering: string;
}

const ar: ScannerStrings = {
  title: 'مسح الرمز',
  close: 'إغلاق',
  starting: 'جارٍ تشغيل الكاميرا…',
  slow: 'ما زلنا ننتظر إذن الكاميرا — يمكنك كتابة الرقم أو اختيار صورة بدلًا من ذلك.',
  looking: 'ضع الرمز داخل الإطار.',
  lookingLabel: 'ضع ملصق العلبة كاملًا داخل الإطار — يُقرأ الرقم التسلسلي وباركودات العلبة معًا.',
  denied: 'تم رفض الوصول إلى الكاميرا — اكتب الرقم بدلًا من ذلك.',
  deniedHelp: 'لإعادة السماح: من إعدادات المتصفح ← أذونات الموقع ← الكاميرا، ثم أعد المحاولة.',
  unavailable: 'لا توجد كاميرا متاحة على هذا الجهاز — اكتب الرقم أو اختر صورة.',
  insecure: 'الكاميرا تعمل فقط على اتصال آمن (https) — اكتب الرقم أو اختر صورة.',
  failed: 'تعذّر تشغيل الكاميرا — اكتب الرقم أو اختر صورة.',
  paused: 'توقفت الكاميرا لأن الصفحة لم تعد ظاهرة — تعود تلقائيًا.',
  nothing: 'لم يُعثر على رمز في الصورة — جرّب صورة أوضح أو اكتب الرقم.',
  decoding: 'جارٍ قراءة الصورة…',
  choosePhoto: 'اختر صورة',
  captured: 'تم التقاط الرمز — جارٍ التحقق…',
  aimAtSn: 'هذا باركود العلبة أو EAN — وجّه الكاميرا إلى الباركود تحت سطر «Product SN».',
  boxOnly: 'قُرئ رقم العلبة (BOX SN) فقط — سنستعمله إن لم يظهر باركود «Product SN».',
  torchOn: 'تشغيل الإضاءة',
  torchOff: 'إطفاء الإضاءة',
  tapToFocus: 'المس الصورة لإعادة التركيز، وقرّب الملصق أو أبعده قليلًا حتى تتضح الخطوط.',
  manualLabel: 'أو اكتب الرقم يدويًا',
  manualPlaceholder: 'كما هو مطبوع على الملصق',
  manualSubmit: 'متابعة',
  retry: 'إعادة المحاولة',
  added: 'أُضيف',
  duplicate: 'مكرّر',
  invalid: 'غير صالح',
  registering: 'جارٍ التسجيل…',
};

const en: ScannerStrings = {
  title: 'Scan a code',
  close: 'Close',
  starting: 'Starting the camera…',
  slow: 'Still waiting for camera permission — you can type the serial or choose a photo instead.',
  looking: 'Hold the code inside the frame.',
  lookingLabel: 'Fit the whole box label inside the frame — the serial and the box barcodes are read together.',
  denied: 'Camera access was denied — type the serial instead.',
  deniedHelp: 'To allow it again: browser settings → site permissions → camera, then retry.',
  unavailable: 'No camera is available on this device — type the serial or choose a photo.',
  insecure: 'The camera only works over a secure (https) connection — type the serial or choose a photo.',
  failed: 'The camera could not be started — type the serial or choose a photo.',
  paused: 'The camera paused because the page is not visible — it resumes on its own.',
  nothing: 'No code found in the photo — try a clearer photo or type the serial.',
  decoding: 'Reading the photo…',
  choosePhoto: 'Choose a photo',
  captured: 'Code captured — checking…',
  aimAtSn: 'That is the box or EAN barcode — aim at the barcode under the “Product SN” line.',
  boxOnly: 'Only the BOX SN was read — it will be used if no “Product SN” barcode shows up.',
  torchOn: 'Turn the light on',
  torchOff: 'Turn the light off',
  tapToFocus: 'Tap the picture to refocus, and move the label a little closer or further until the bars are sharp.',
  manualLabel: 'Or type the number',
  manualPlaceholder: 'As printed on the label',
  manualSubmit: 'Continue',
  retry: 'Retry',
  added: 'Added',
  duplicate: 'Duplicate',
  invalid: 'Invalid',
  registering: 'Registering…',
};

const ckb: ScannerStrings = {
  title: 'سکانکردنی کۆد',
  close: 'داخستن',
  starting: 'کامێرا دەکرێتەوە…',
  slow: 'هێشتا چاوەڕوانی مۆڵەتی کامێراین — دەتوانیت ژمارەکە بنووسیت یان وێنەیەک هەڵبژێریت.',
  looking: 'کۆدەکە لەناو چوارچێوەکە ڕابگرە.',
  lookingLabel: 'لەیبڵی سندووقەکە بە تەواوی لەناو چوارچێوەکە دابنێ — ژمارە زنجیرەیی و بارکۆدەکانی سندووق پێکەوە دەخوێنرێنەوە.',
  denied: 'ڕێگە بە کامێرا نەدرا — لەبری ئەوە ژمارەکە بنووسە.',
  deniedHelp: 'بۆ ڕێگەدانەوە: ڕێکخستنەکانی وێبگەڕ ← مۆڵەتەکانی ماڵپەڕ ← کامێرا، پاشان دووبارە هەوڵ بدەوە.',
  unavailable: 'کامێرا لەم ئامێرە بەردەست نییە — ژمارەکە بنووسە یان وێنەیەک هەڵبژێرە.',
  insecure: 'کامێرا تەنها لەسەر پەیوەندییەکی پارێزراو (https) کار دەکات — ژمارەکە بنووسە یان وێنەیەک هەڵبژێرە.',
  failed: 'کامێرا نەکرایەوە — ژمارەکە بنووسە یان وێنەیەک هەڵبژێرە.',
  paused: 'کامێرا ڕاگیرا چونکە پەڕەکە دیار نییە — خۆی دەگەڕێتەوە.',
  nothing: 'هیچ کۆدێک لە وێنەکە نەدۆزرایەوە — وێنەیەکی ڕوونتر تاقی بکەرەوە یان ژمارەکە بنووسە.',
  decoding: 'وێنەکە دەخوێنرێتەوە…',
  choosePhoto: 'وێنەیەک هەڵبژێرە',
  captured: 'کۆد گیرا — پشکنین…',
  aimAtSn: 'ئەمە بارکۆدی سندووق یان EAN ـە — کامێرا بەرەو ئەو بارکۆدە بکە کە لەژێر هێڵی «Product SN» دایە.',
  boxOnly: 'تەنها ژمارەی سندووق (BOX SN) خوێندرایەوە — ئەگەر بارکۆدی «Product SN» دەرنەکەوت، ئەوە بەکاردێت.',
  torchOn: 'هەڵکردنی ڕووناکی',
  torchOff: 'کوژاندنەوەی ڕووناکی',
  tapToFocus: 'دەست لە وێنەکە بدە بۆ ڕوونکردنەوە، و لەیبڵەکە کەمێک نزیک یان دوور بکەرەوە تا هێڵەکان ڕوون دەبنەوە.',
  manualLabel: 'یان ژمارەکە بە دەست بنووسە',
  manualPlaceholder: 'وەک لەسەر لەیبڵەکە چاپکراوە',
  manualSubmit: 'بەردەوامبە',
  retry: 'دووبارە هەوڵ بدەوە',
  added: 'زیادکرا',
  duplicate: 'دووبارەیە',
  invalid: 'نادروستە',
  registering: 'تۆمار دەکرێت…',
};

export const SCANNER_STRINGS: Record<Language, ScannerStrings> = { ar, en, ckb };
