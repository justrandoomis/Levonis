/**
 * The words of the PRINT section (src/cloud/pages/print): uploading a model or
 * importing a link, the file library, projects, the print settings, the
 * estimate and what confirming reserves, and a job followed through its
 * fourteen states. Read through `useCloudText()` (src/cloud/text.ts).
 *
 * No figure lives in a sentence here: times, grams, hours, sizes and prices
 * are the server's, written by src/cloud/format.ts and filled into a
 * `{placeholder}` (tests/printCloudUiPrint.test.ts holds that). Every slot is
 * real Arabic, English and Sorani; a Sorani slot is never the Arabic one
 * (docs/DECISIONS.md row 183). «Levonis», «Print Cloud» and the file formats
 * (STL, 3MF, OBJ) stay in Latin letters in every language.
 */
import type { Tri } from '../types';

/** The /print page: the two ways in, and what to pick up again. */
export const print = {
  subtitle: {
    ar: 'ارفع نموذجًا أو استورد رابطًا، ثم اختر المادة والطابعة واطلب تقديرًا من الورشة.',
    en: 'Upload a model or import a link, then choose the material and printer and ask the workshop for an estimate.',
    ckb: 'مۆدێلێک بار بکە یان بەستەرێک هاوردە بکە، پاشان کەرەستە و چاپکەر هەڵبژێرە و داوای خەمڵاندن لە کارگە بکە.',
  },
  quickStart: { ar: 'تابع من حيث توقفت', en: 'Pick up where you left off', ckb: 'لەو شوێنەوە بەردەوام بە کە وەستایت' },
  recentFiles: { ar: 'آخر الملفات', en: 'Recent files', ckb: 'دوایین فایلەکان' },
  printAgain: { ar: 'اطبع مجددًا', en: 'Print again', ckb: 'دووبارە چاپی بکە' },
  noRecent: {
    ar: 'لا ملفات بعد. ارفع نموذجك الأول من الأعلى.',
    en: 'No files yet. Upload your first model above.',
    ckb: 'هێشتا هیچ فایلێک نییە. یەکەم مۆدێلت لە سەرەوە بار بکە.',
  },
  library: { ar: 'مكتبة الملفات', en: 'File library', ckb: 'کتێبخانەی فایل' },
  projects: { ar: 'المشاريع', en: 'Projects', ckb: 'پڕۆژەکان' },
  myPrints: { ar: 'طباعاتي', en: 'My prints', ckb: 'چاپەکانم' },
  sections: { ar: 'أقسام الطباعة', en: 'Print sections', ckb: 'بەشەکانی چاپ' },
  refreshFailed: {
    ar: 'تعذّر التحديث — المعروض آخر ما وصل من الخادم.',
    en: 'Could not refresh — this is the last answer from the server.',
    ckb: 'نوێ نەکرایەوە — ئەوەی پیشان دەدرێت دوایین وەڵامی ڕاژەکارە.',
  },
  showMore: { ar: 'عرض المزيد', en: 'Show more', ckb: 'زیاتر پیشان بدە' },
  capNote: {
    ar: 'تُعرض الأحدث فقط، بحدٍّ أقصى {n}.',
    en: 'Only the most recent are shown, up to {n}.',
    ckb: 'تەنها نوێترینەکان پیشان دەدرێن، تا {n} دانە.',
  },
  untitled: { ar: 'طباعة بلا عنوان', en: 'Untitled print', ckb: 'چاپی بێ ناونیشان' },
  updated: { ar: 'آخر تحديث {when}', en: 'Updated {when}', ckb: 'دوایین نوێکردنەوە {when}' },
  created: { ar: 'أُنشئ {when}', en: 'Created {when}', ckb: '{when} دروستکرا' },
  save: { ar: 'حفظ', en: 'Save', ckb: 'پاشەکەوتکردن' },
  send: { ar: 'إرسال', en: 'Send', ckb: 'ناردن' },
} satisfies Record<string, Tri>;

/** Uploading a file and importing a link — and the server's answer to each. */
export const upload = {
  title: { ar: 'ارفع نموذجك ثلاثي الأبعاد', en: 'Upload your 3D model', ckb: 'مۆدێلە سێ ڕەهەندییەکەت بار بکە' },
  formats: { ar: 'ملفات STL أو 3MF أو OBJ', en: 'STL, 3MF or OBJ files', ckb: 'فایلی STL یان 3MF یان OBJ' },
  choose: { ar: 'اختر ملفًا', en: 'Choose a file', ckb: 'فایلێک هەڵبژێرە' },
  dropHint: { ar: 'أو اسحبه وأفلته هنا', en: 'or drag and drop it here', ckb: 'یان ڕایبکێشە و لێرە دایبنێ' },
  dropNow: { ar: 'أفلت الملف لرفعه', en: 'Drop the file to upload it', ckb: 'فایلەکە دابنێ بۆ ئەوەی بار بکرێت' },
  wrongType: { ar: 'هذا الملف ليس STL أو 3MF أو OBJ.', en: 'This file is not an STL, 3MF or OBJ.', ckb: 'ئەم فایلە STL یان 3MF یان OBJ نییە.' },
  oneFile: { ar: 'ارفع ملفًا واحدًا في كل مرة.', en: 'Upload one file at a time.', ckb: 'هەر جارێک یەک فایل بار بکە.' },
  uploading: { ar: 'جارٍ رفع {name}', en: 'Uploading {name}', ckb: '{name} بار دەکرێت' },
  sentOf: { ar: 'أُرسل {done} من {total}', en: '{done} of {total} sent', ckb: '{done} لە {total} نێردرا' },
  progressLabel: { ar: 'تقدّم رفع الملف', en: 'Upload progress', ckb: 'پێشکەوتنی بارکردن' },
  waitingAnswer: {
    ar: 'وصل الملف كاملًا؛ ينتظر ردّ الخادم.',
    en: 'The whole file has been sent; waiting for the server’s answer.',
    ckb: 'هەموو فایلەکە نێردرا؛ چاوەڕێی وەڵامی ڕاژەکارە.',
  },
  stop: { ar: 'إيقاف الرفع', en: 'Stop the upload', ckb: 'ڕاگرتنی بارکردن' },
  stopped: { ar: 'أوقفت الرفع، ولم يُحفظ شيء.', en: 'You stopped the upload; nothing was saved.', ckb: 'بارکردنەکەت ڕاگرت، هیچ شتێک پاشەکەوت نەکرا.' },
  failed: { ar: 'تعذّر رفع الملف', en: 'The file could not be uploaded', ckb: 'فایلەکە بار نەکرا' },
  limit: { ar: 'أكبر ملف يقبله الخادم: {size}.', en: 'The largest file the server accepts: {size}.', ckb: 'گەورەترین فایل کە ڕاژەکار وەریدەگرێت: {size}.' },
  overLimit: {
    ar: 'هذا الملف ({size}) أكبر من الحد الذي ذكره الخادم ({limit}).',
    en: 'This file ({size}) is over the limit the server stated ({limit}).',
    ckb: 'ئەم فایلە ({size}) لەو سنوورە گەورەترە کە ڕاژەکار گوتی ({limit}).',
  },
  tooLarge: { ar: 'الملف أكبر مما يقبله الخادم.', en: 'The file is larger than the server accepts.', ckb: 'فایلەکە لەوە گەورەترە کە ڕاژەکار وەریدەگرێت.' },
  readAs: {
    ar: 'محتوى الملف لا يطابق امتداده — قرأه الخادم على أنه {detected}.',
    en: 'The file’s content does not match its extension — the server read it as {detected}.',
    ckb: 'ناوەڕۆکی فایلەکە لەگەڵ پاشگرەکەیدا ناگونجێت — ڕاژەکار وەک {detected} خوێندییەوە.',
  },
  notAModel: {
    ar: 'لم يتعرّف الخادم على محتوى الملف كنموذج ثلاثي الأبعاد.',
    en: 'The server did not recognise the file’s content as a 3D model.',
    ckb: 'ڕاژەکار ناوەڕۆکی فایلەکەی وەک مۆدێلی سێ ڕەهەندی نەناسییەوە.',
  },
  serverChecks: {
    ar: 'يتحقق الخادم من محتوى الملف نفسه، لا من اسمه فقط.',
    en: 'The server checks the file’s own content, not just its name.',
    ckb: 'ڕاژەکار ناوەڕۆکی خودی فایلەکە دەپشکنێت، نەک تەنها ناوەکەی.',
  },
  continue: { ar: 'متابعة إلى إعدادات الطباعة', en: 'Continue to print settings', ckb: 'بەردەوامبوون بۆ ڕێکخستنەکانی چاپ' },
  continueHint: {
    ar: 'ننشئ مشروعًا لهذا النموذج تختار فيه المادة والطابعة.',
    en: 'We create a project for this model, where you choose the material and printer.',
    ckb: 'پڕۆژەیەک بۆ ئەم مۆدێلە دروست دەکەین کە تێیدا کەرەستە و چاپکەر هەڵدەبژێریت.',
  },
  another: { ar: 'رفع ملف آخر', en: 'Upload another file', ckb: 'فایلێکی تر بار بکە' },
  inLibrary: { ar: 'عرض في المكتبة', en: 'View in the library', ckb: 'لە کتێبخانەدا ببینە' },
  importTitle: { ar: 'استورد من رابط', en: 'Import from a link', ckb: 'لە بەستەرێکەوە هاوردە بکە' },
  importHint: {
    ar: 'رابط من MakerWorld أو Printables أو Thingiverse.',
    en: 'A link from MakerWorld, Printables or Thingiverse.',
    ckb: 'بەستەرێک لە MakerWorld یان Printables یان Thingiverse.',
  },
  importField: { ar: 'رابط النموذج', en: 'Model link', ckb: 'بەستەری مۆدێل' },
  importButton: { ar: 'استيراد', en: 'Import', ckb: 'هاوردەکردن' },
  needsHttps: { ar: 'الصق رابطًا يبدأ بـ https://', en: 'Paste a link that starts with https://', ckb: 'بەستەرێک دابنێ کە بە https:// دەست پێدەکات' },
  importHonesty: {
    ar: 'لا يُنزَّل الملف إلا إن سمح الموقع بذلك؛ وإلا يُحفظ الرابط وحده وترفع الملف بنفسك.',
    en: 'The file is downloaded only where the site permits it; otherwise only the link is saved and you upload the file yourself.',
    ckb: 'فایلەکە تەنها لەو شوێنەی ماڵپەڕەکە ڕێگە بدات دادەگیرێت؛ ئەگەر نا تەنها بەستەرەکە پاشەکەوت دەکرێت و فایلەکە خۆت بار دەکەیت.',
  },
  processing: { ar: 'يعالج الخادم الرابط…', en: 'The server is processing the link…', ckb: 'ڕاژەکار بەستەرەکە ئامادە دەکات…' },
  https_required: { ar: 'يجب أن يبدأ الرابط بـ https://', en: 'The link must start with https://', ckb: 'بەستەرەکە دەبێت بە https:// دەست پێبکات' },
  provider_not_supported: {
    ar: 'لا تستورد الخدمة من هذا الموقع.',
    en: 'The service does not import from this site.',
    ckb: 'خزمەتگوزارییەکە لەم ماڵپەڕەوە هاوردە ناکات.',
  },
  invalid_or_private_address: { ar: 'هذا الرابط غير صالح.', en: 'This link is not valid.', ckb: 'ئەم بەستەرە دروست نییە.' },
  too_long: { ar: 'الرابط طويل جدًا.', en: 'The link is too long.', ckb: 'بەستەرەکە زۆر درێژە.' },
} satisfies Record<string, Tri>;

/** An import's status, said exactly: «only the link was saved» is never «imported». */
export const importStatus = {
  pending: { ar: 'قيد المعالجة', en: 'Processing', ckb: 'لە ئامادەکردندایە' },
  link_saved: { ar: 'حُفظ الرابط فقط', en: 'Only the link was saved', ckb: 'تەنها بەستەرەکە پاشەکەوت کرا' },
  file_imported: { ar: 'نُزّل الملف', en: 'File downloaded', ckb: 'فایلەکە داگیرا' },
  failed: { ar: 'تعذّر الاستيراد', en: 'Import failed', ckb: 'هاوردەکردن سەرکەوتوو نەبوو' },
  rejected: { ar: 'رُفض الملف المنزَّل', en: 'Downloaded file rejected', ckb: 'فایلە داگیراوەکە ڕەتکرایەوە' },
} satisfies Record<string, Tri>;

export const importBody = {
  pending: { ar: 'لم يُنزَّل أي ملف بعد.', en: 'No file has been downloaded yet.', ckb: 'هێشتا هیچ فایلێک دانەگیراوە.' },
  link_saved: {
    ar: 'لم يُنزَّل أي ملف: حُفظ الرابط وحده. نزّل الملف من الموقع بنفسك ثم ارفعه هنا.',
    en: 'No file was downloaded: only the link was saved. Download the file from the site yourself, then upload it here.',
    ckb: 'هیچ فایلێک دانەگیرا: تەنها بەستەرەکە پاشەکەوت کرا. فایلەکە خۆت لە ماڵپەڕەکە دابگرە، پاشان لێرە باری بکە.',
  },
  file_imported: {
    ar: 'نزّل الخادم الملف من {provider} بإذن الموقع، وهو الآن في مكتبتك.',
    en: 'The server downloaded the file from {provider}, as the site permits, and it is now in your library.',
    ckb: 'ڕاژەکار فایلەکەی لە {provider} داگرت، بە ڕێگەپێدانی ماڵپەڕەکە، و ئێستا لە کتێبخانەکەتدایە.',
  },
  failed: {
    ar: 'لم يكتمل الاستيراد. يمكنك رفع الملف بنفسك.',
    en: 'The import did not complete. You can upload the file yourself.',
    ckb: 'هاوردەکردنەکە تەواو نەبوو. دەتوانیت فایلەکە خۆت بار بکەیت.',
  },
  rejected: {
    ar: 'نُزّل ملف من الرابط لكن الفحص رفضه: {reason}',
    en: 'A file was downloaded from the link but the check rejected it: {reason}',
    ckb: 'فایلێک لە بەستەرەکەوە داگیرا بەڵام پشکنین ڕەتیکردەوە: {reason}',
  },
} satisfies Record<string, Tri>;

/** The import's own log (worker/lib/printCloud/imports.ts), one line per step. */
export const importLog = {
  LINK_ACCEPTED: { ar: 'قُبل الرابط', en: 'Link accepted', ckb: 'بەستەرەکە وەرگیرا' },
  PROVIDER_DISABLED: { ar: 'الاستيراد من هذا الموقع متوقف', en: 'Importing from this site is switched off', ckb: 'هاوردەکردن لەم ماڵپەڕەوە ڕاگیراوە' },
  NO_MODEL_ID_IN_LINK: { ar: 'لا يحدد الرابط نموذجًا بعينه', en: 'The link does not name a specific model', ckb: 'بەستەرەکە مۆدێلێکی دیاریکراو دیاری ناکات' },
  NO_PROVIDER_API_CONFIGURED: {
    ar: 'لا اتصال مُعدّ بهذا الموقع لتنزيل الملفات',
    en: 'No connection to this site is set up for downloading files',
    ckb: 'هیچ پەیوەندییەک بەم ماڵپەڕەوە بۆ داگرتنی فایل ڕێکنەخراوە',
  },
  PROVIDER_API_URL_INVALID: { ar: 'إعداد الاتصال بالموقع غير صالح', en: 'The site connection is set up incorrectly', ckb: 'ڕێکخستنی پەیوەندی بە ماڵپەڕەکەوە هەڵەیە' },
  PROVIDER_API_FAILED: { ar: 'لم يُجب الموقع', en: 'The site did not answer', ckb: 'ماڵپەڕەکە وەڵامی نەدایەوە' },
  METADATA_SAVED: { ar: 'حُفظ وصف النموذج دون ملف', en: 'The model’s details were saved, without a file', ckb: 'وردەکاریی مۆدێلەکە پاشەکەوت کرا، بەبێ فایل' },
  FILE_IMPORTED: { ar: 'نُزّل الملف', en: 'The file was downloaded', ckb: 'فایلەکە داگیرا' },
  DOWNLOADED_FILE_REJECTED: { ar: 'رُفض الملف المنزَّل', en: 'The downloaded file was rejected', ckb: 'فایلە داگیراوەکە ڕەتکرایەوە' },
  DOWNLOAD_FAILED: { ar: 'تعذّر تنزيل الملف', en: 'The file could not be downloaded', ckb: 'فایلەکە دانەگیرا' },
  other: { ar: 'خطوة: {code}', en: 'Step: {code}', ckb: 'هەنگاو: {code}' },
} satisfies Record<string, Tri>;

/** A model file's status, as the server's check left it. */
export const fileStatus = {
  uploaded: { ar: 'رُفع — بانتظار الفحص', en: 'Uploaded — waiting to be checked', ckb: 'بارکرا — چاوەڕێی پشکنین' },
  processing: { ar: 'قيد الفحص والقياس', en: 'Being checked and measured', ckb: 'پشکنین و پێوانە دەکرێت' },
  ready: { ar: 'جاهز للطباعة', en: 'Ready to print', ckb: 'ئامادەیە بۆ چاپ' },
  rejected: { ar: 'مرفوض', en: 'Rejected', ckb: 'ڕەتکراوەتەوە' },
  failed: { ar: 'تعذّر الفحص', en: 'Could not be checked', ckb: 'نەپشکنرا' },
} satisfies Record<string, Tri>;

export const fileBody = {
  checking: {
    ar: 'يقيس الخادم أبعاد النموذج وحجمه وسلامة سطحه. لا يُعرض أي قياس قبل أن ينتهي.',
    en: 'The server is measuring the model’s size, volume and mesh. No measurement is shown until it finishes.',
    ckb: 'ڕاژەکار قەبارە و ناوەڕۆک و تۆڕی مۆدێلەکە دەپێوێت. هیچ پێوانەیەک پیشان نادرێت تا تەواو دەبێت.',
  },
  ready: { ar: 'قِيس النموذج ويمكن طباعته.', en: 'The model was measured and can be printed.', ckb: 'مۆدێلەکە پێوانە کرا و دەکرێت چاپ بکرێت.' },
  rejected: { ar: 'رفض الفحص هذا الملف: {reason}', en: 'The check rejected this file: {reason}', ckb: 'پشکنینەکە ئەم فایلەی ڕەتکردەوە: {reason}' },
  failed: { ar: 'تعذّر فحص الملف: {reason}', en: 'The file could not be checked: {reason}', ckb: 'فایلەکە نەپشکنرا: {reason}' },
} satisfies Record<string, Tri>;

/** Why a file was refused — at upload (the request) or after measuring (the background check). */
export const rejection = {
  EMPTY_FILE: { ar: 'الملف فارغ.', en: 'The file is empty.', ckb: 'فایلەکە بەتاڵە.' },
  ARCHIVE_UNREADABLE: { ar: 'تعذّرت قراءة ملف 3MF.', en: 'The 3MF archive could not be read.', ckb: 'ئەرشیفی 3MF نەخوێندرایەوە.' },
  ARCHIVE_TOO_MANY_ENTRIES: { ar: 'ملف 3MF يحتوي ملفات كثيرة جدًا.', en: 'The 3MF archive holds too many files.', ckb: 'ئەرشیفی 3MF فایلی زۆر زۆری تێدایە.' },
  ARCHIVE_PATH_TRAVERSAL: { ar: 'ملف 3MF يحتوي مسارات غير آمنة.', en: 'The 3MF archive contains unsafe paths.', ckb: 'ئەرشیفی 3MF ڕێڕەوی نائاسایشی تێدایە.' },
  ARCHIVE_DANGEROUS_ENTRY: {
    ar: 'ملف 3MF يحتوي برنامجًا أو أرشيفًا آخر.',
    en: 'The 3MF archive contains a program or another archive.',
    ckb: 'ئەرشیفی 3MF بەرنامەیەک یان ئەرشیفێکی تری تێدایە.',
  },
  ARCHIVE_NO_MODEL: { ar: 'ملف 3MF لا يحتوي نموذجًا.', en: 'The 3MF archive contains no model.', ckb: 'ئەرشیفی 3MF هیچ مۆدێلێکی تێدا نییە.' },
  ARCHIVE_TOO_LARGE_WHEN_INFLATED: {
    ar: 'ملف 3MF يصبح كبيرًا جدًا عند فكّه.',
    en: 'The 3MF archive is too large once unpacked.',
    ckb: 'ئەرشیفی 3MF دوای کردنەوە زۆر گەورە دەبێت.',
  },
  noShape: { ar: 'لا يحتوي الملف أي شكل قابل للطباعة.', en: 'The file contains no printable shape.', ckb: 'فایلەکە هیچ شێوەیەکی چاپکراوی تێدا نییە.' },
  zeroSize: { ar: 'للنموذج حجم أو بُعد صفري.', en: 'The model has zero volume or a zero dimension.', ckb: 'قەبارە یان ڕەهەندێکی مۆدێلەکە سفرە.' },
  TOO_MANY_TRIANGLES: {
    ar: 'النموذج مفصّل أكثر مما يستطيع الخادم قياسه.',
    en: 'The model is more detailed than the server can measure.',
    ckb: 'مۆدێلەکە وردەکاریی زیاترە لەوەی ڕاژەکار بتوانێت بیپێوێت.',
  },
  unreadable: {
    ar: 'تعذّرت قراءة النموذج — قد يكون الملف تالفًا.',
    en: 'The model could not be read — the file may be damaged.',
    ckb: 'مۆدێلەکە نەخوێندرایەوە — لەوانەیە فایلەکە تێکچووبێت.',
  },
  OBJECT_MISSING: { ar: 'لم يُعثر على الملف في التخزين.', en: 'The stored file could not be found.', ckb: 'فایلە هەڵگیراوەکە نەدۆزرایەوە.' },
  notMeasurable: { ar: 'لا يمكن قياس هذا النوع من الملفات.', en: 'This kind of file cannot be measured.', ckb: 'ئەم جۆرە فایلە ناپێورێت.' },
  other: { ar: 'السبب: {code}', en: 'Reason: {code}', ckb: 'هۆکار: {code}' },
} satisfies Record<string, Tri>;

/** What the measurement noticed about a mesh (worker/lib/modelGeometry.ts `ModelWarning`). */
export const geometryWarning = {
  NOT_WATERTIGHT: { ar: 'سطح النموذج غير مغلق بالكامل.', en: 'The model’s surface is not fully closed.', ckb: 'ڕووکاری مۆدێلەکە بە تەواوی داخراو نییە.' },
  ZERO_VOLUME: { ar: 'حجم النموذج صفر.', en: 'The model has zero volume.', ckb: 'قەبارەی مۆدێلەکە سفرە.' },
  INVERTED_NORMALS: { ar: 'بعض أوجه النموذج مقلوبة.', en: 'Some faces of the model point inward.', ckb: 'هەندێک لە ڕووەکانی مۆدێلەکە بەرەو ناوەوەن.' },
  DEGENERATE_TRIANGLES: { ar: 'في النموذج مثلثات فارغة.', en: 'The model has empty triangles.', ckb: 'مۆدێلەکە سێگۆشەی بەتاڵی تێدایە.' },
  MANY_PARTS: { ar: 'عدد الأجزاء المنفصلة في النموذج: {parts}.', en: 'Separate parts in the model: {parts}.', ckb: 'ژمارەی پارچە جیاوازەکانی مۆدێلەکە: {parts}.' },
  TOPOLOGY_NOT_ANALYSED: {
    ar: 'النموذج كبير فلم تُفحص سلامة سطحه كلها.',
    en: 'The model is large, so its mesh was not fully checked.',
    ckb: 'مۆدێلەکە گەورەیە، بۆیە تۆڕەکەی بە تەواوی نەپشکنرا.',
  },
  HUGE_MESH: { ar: 'النموذج مفصّل جدًا.', en: 'The model is very detailed.', ckb: 'مۆدێلەکە وردەکاریی زۆری هەیە.' },
  VERY_LARGE: { ar: 'النموذج كبير جدًا — أطول بُعد: {size}.', en: 'The model is very large — longest side: {size}.', ckb: 'مۆدێلەکە زۆر گەورەیە — درێژترین لا: {size}.' },
  VERY_SMALL: { ar: 'النموذج صغير جدًا — أطول بُعد: {size}.', en: 'The model is very small — longest side: {size}.', ckb: 'مۆدێلەکە زۆر بچووکە — درێژترین لا: {size}.' },
  THIN_FEATURES: {
    ar: 'في النموذج أجزاء رفيعة قد لا تُطبع جيدًا.',
    en: 'The model has thin parts that may not print well.',
    ckb: 'مۆدێلەکە بەشی باریکی هەیە کە لەوانەیە باش چاپ نەبن.',
  },
  HEAVY_OVERHANG: {
    ar: 'في النموذج أجزاء معلّقة كثيرة؛ قد يحتاج دعامات.',
    en: 'The model has many overhangs; it may need supports.',
    ckb: 'مۆدێلەکە بەشی هەڵواسراوی زۆری هەیە؛ لەوانەیە پاڵپشتی پێویست بێت.',
  },
  UNIT_ASSUMED: {
    ar: 'الملف لا يذكر وحدته؛ قُرئ بالمليمتر.',
    en: 'The file does not state its unit; it was read in millimetres.',
    ckb: 'فایلەکە یەکەکەی دیاری ناکات؛ بە ملیمەتر خوێندرایەوە.',
  },
  other: { ar: 'ملاحظة: {code}', en: 'Note: {code}', ckb: 'تێبینی: {code}' },
} satisfies Record<string, Tri>;

/** The file library and one file's page. */
export const library = {
  subtitle: {
    ar: 'نماذجك المرفوعة والروابط التي استوردتها.',
    en: 'Your uploaded models and the links you imported.',
    ckb: 'مۆدێلە بارکراوەکانت و ئەو بەستەرانەی هاوردەت کردوون.',
  },
  tabsLabel: { ar: 'محتوى المكتبة', en: 'Library contents', ckb: 'ناوەڕۆکی کتێبخانە' },
  tabFiles: { ar: 'الملفات', en: 'Files', ckb: 'فایلەکان' },
  tabLinks: { ar: 'الروابط', en: 'Links', ckb: 'بەستەرەکان' },
  uploadModel: { ar: 'رفع نموذج', en: 'Upload a model', ckb: 'مۆدێلێک بار بکە' },
  noFiles: { ar: 'لا ملفات في مكتبتك', en: 'No files in your library', ckb: 'هیچ فایلێک لە کتێبخانەکەتدا نییە' },
  noFilesBody: {
    ar: 'ارفع ملف STL أو 3MF أو OBJ ليظهر هنا.',
    en: 'Upload an STL, 3MF or OBJ file and it appears here.',
    ckb: 'فایلێکی STL یان 3MF یان OBJ بار بکە و لێرە دەردەکەوێت.',
  },
  noLinks: { ar: 'لم تستورد أي رابط', en: 'You have not imported any link', ckb: 'هیچ بەستەرێکت هاوردە نەکردووە' },
  fromLink: { ar: 'من رابط', en: 'From a link', ckb: 'لە بەستەرەوە' },
  uploaded: { ar: 'مرفوع', en: 'Uploaded', ckb: 'بارکراو' },
  details: { ar: 'تفاصيل الملف', en: 'File details', ckb: 'وردەکاریی فایل' },
  format: { ar: 'الصيغة', en: 'Format', ckb: 'فۆرمات' },
  fileSize: { ar: 'حجم الملف', en: 'File size', ckb: 'قەبارەی فایل' },
  uploadedAt: { ar: 'تاريخ الرفع', en: 'Uploaded on', ckb: 'کاتی بارکردن' },
  source: { ar: 'المصدر', en: 'Source', ckb: 'سەرچاوە' },
  fingerprint: { ar: 'بصمة المحتوى', en: 'Content fingerprint', ckb: 'پەنجەمۆری ناوەڕۆک' },
  download: { ar: 'تنزيل', en: 'Download', ckb: 'داگرتن' },
  printThis: { ar: 'اطبع هذا النموذج', en: 'Print this model', ckb: 'ئەم مۆدێلە چاپ بکە' },
  delete: { ar: 'حذف الملف', en: 'Delete the file', ckb: 'سڕینەوەی فایل' },
  deleteQ: { ar: 'حذف هذا الملف؟', en: 'Delete this file?', ckb: 'ئەم فایلە بسڕدرێتەوە؟' },
  deleteBody: {
    ar: 'يُزال الملف من مكتبتك ولا يمكن تنزيله بعد ذلك، وتبقى الطباعات السابقة في سجلك. لا يُحذف ما دامت طباعة قائمة تحتاجه.',
    en: 'The file leaves your library and can no longer be downloaded; past prints stay in your history. It cannot be deleted while a live print needs it.',
    ckb: 'فایلەکە لە کتێبخانەکەت لادەبرێت و چیتر داناگیرێت؛ چاپە پێشووەکان لە مێژووەکەتدا دەمێننەوە. تا چاپێکی چالاک پێویستی پێ بێت ناسڕدرێتەوە.',
  },
  deleted: { ar: 'حُذف الملف', en: 'File deleted', ckb: 'فایلەکە سڕایەوە' },
  measurements: { ar: 'القياسات', en: 'Measurements', ckb: 'پێوانەکان' },
  dimensions: { ar: 'الأبعاد', en: 'Dimensions', ckb: 'ڕەهەندەکان' },
  volume: { ar: 'حجم النموذج', en: 'Model volume', ckb: 'قەبارەی مۆدێل' },
  volumeValue: { ar: '{n} سم مكعب', en: '{n} cm³', ckb: '{n} سانتیمەتری سێجا' },
  triangles: { ar: 'المثلثات', en: 'Triangles', ckb: 'سێگۆشەکان' },
  parts: { ar: 'الأجزاء المنفصلة', en: 'Separate parts', ckb: 'پارچە جیاوازەکان' },
  closed: { ar: 'سطح مغلق', en: 'Closed surface', ckb: 'ڕووکاری داخراو' },
  unit: { ar: 'الوحدة', en: 'Unit', ckb: 'یەکە' },
  unitDeclared: { ar: 'مذكورة في الملف', en: 'Stated in the file', ckb: 'لە فایلەکەدا دیاریکراوە' },
  unitAssumed: { ar: 'مفترضة بالمليمتر', en: 'Assumed millimetres', ckb: 'بە ملیمەتر گریمانەکراوە' },
  overhang: { ar: 'نسبة الأجزاء المعلّقة', en: 'Overhang share', ckb: 'ڕێژەی بەشی هەڵواسراو' },
  notes: { ar: 'ما لاحظه الفحص', en: 'What the check noticed', ckb: 'ئەوەی پشکنین تێبینی کرد' },
  fit: { ar: 'هل يتسع في الطابعات؟', en: 'Does it fit the printers?', ckb: 'لە چاپکەرەکاندا جێی دەبێتەوە؟' },
  fitNote: {
    ar: 'قارن الخادم أبعاد النموذج المقيسة بحجم طباعة كل طراز.',
    en: 'The server compared the model’s measured size with each printer model’s build volume.',
    ckb: 'ڕاژەکار قەبارەی پێوراوی مۆدێلەکەی بە قەبارەی چاپی هەر مۆدێلێکی چاپکەر بەراورد کرد.',
  },
  fitsCount: {
    ar: 'طرازات الطابعات التي يتسع فيها: {n} من {total}',
    en: 'Printer models it fits: {n} of {total}',
    ckb: 'ئەو مۆدێلە چاپکەرانەی جێی تێدا دەبێتەوە: {n} لە {total}',
  },
  fitsAsIs: { ar: 'يتسع كما هو', en: 'Fits as it is', ckb: 'وەک خۆی جێی دەبێتەوە' },
  fitsRotated: { ar: 'يتسع بعد تدويره', en: 'Fits once rotated', ckb: 'دوای سووڕاندن جێی دەبێتەوە' },
  noFit: { ar: 'لا يتسع', en: 'Does not fit', ckb: 'جێی نابێتەوە' },
  importTitle: { ar: 'استيراد من رابط', en: 'Link import', ckb: 'هاوردەکردن لە بەستەرەوە' },
  site: { ar: 'الموقع', en: 'Site', ckb: 'ماڵپەڕ' },
  license: { ar: 'الرخصة', en: 'Licence', ckb: 'مۆڵەت' },
  designer: { ar: 'المصمّم', en: 'Designer', ckb: 'دیزاینەر' },
  openLink: { ar: 'فتح الرابط الأصلي', en: 'Open the original link', ckb: 'بەستەری ڕەسەن بکەرەوە' },
  whatHappened: { ar: 'ما فعله الخادم', en: 'What the server did', ckb: 'ئەوەی ڕاژەکار کردی' },
  openFile: { ar: 'فتح الملف المنزَّل', en: 'Open the downloaded file', ckb: 'فایلە داگیراوەکە بکەرەوە' },
} satisfies Record<string, Tri>;

/** The eleven project types of worker/lib/printCloud/projects.ts. */
export const projectType = {
  generic: { ar: 'عام', en: 'General', ckb: 'گشتی' },
  keychain: { ar: 'ميدالية مفاتيح', en: 'Keychain', ckb: 'هەڵواسراوی کلیل' },
  medal: { ar: 'ميدالية', en: 'Medal', ckb: 'مەدالیا' },
  magnetic: { ar: 'مغناطيسي', en: 'Magnetic', ckb: 'موگناتیسی' },
  nfc: { ar: 'بطاقة NFC', en: 'NFC tag', ckb: 'تاگی NFC' },
  led: { ar: 'إضاءة LED', en: 'LED light', ckb: 'ڕووناکیی LED' },
  nameplate: { ar: 'لوحة اسم', en: 'Nameplate', ckb: 'تابلۆی ناو' },
  storage: { ar: 'تخزين', en: 'Storage', ckb: 'هەڵگرتن' },
  holder: { ar: 'حامل', en: 'Holder', ckb: 'هەڵگر' },
  figure: { ar: 'مجسّم', en: 'Figure', ckb: 'پەیکەر' },
  mechanical: { ar: 'ميكانيكي', en: 'Mechanical', ckb: 'میکانیکی' },
} satisfies Record<string, Tri>;

/** Projects: the list and one project's page. */
export const projectWords = {
  subtitle: {
    ar: 'كل مشروع يجمع نماذج وإعدادات تطبعها مرة أو أكثر.',
    en: 'Each project groups models and settings you print once or many times.',
    ckb: 'هەر پڕۆژەیەک مۆدێل و ڕێکخستن کۆدەکاتەوە کە یەک جار یان زیاتر چاپیان دەکەیت.',
  },
  none: { ar: 'لا مشاريع بعد', en: 'No projects yet', ckb: 'هێشتا هیچ پڕۆژەیەک نییە' },
  noneBody: {
    ar: 'يُنشأ مشروع حين تتابع من نموذج مرفوع إلى إعدادات الطباعة.',
    en: 'A project is created when you continue from an uploaded model to print settings.',
    ckb: 'پڕۆژە کاتێک دروست دەبێت کە لە مۆدێلێکی بارکراوەوە بەردەوام دەبیت بۆ ڕێکخستنەکانی چاپ.',
  },
  active: { ar: 'نشطة', en: 'Active', ckb: 'چالاک' },
  archived: { ar: 'مؤرشفة', en: 'Archived', ckb: 'ئەرشیفکراو' },
  statusLabel: { ar: 'حالة المشاريع', en: 'Project status', ckb: 'دۆخی پڕۆژەکان' },
  printProject: { ar: 'اطبع هذا المشروع', en: 'Print this project', ckb: 'ئەم پڕۆژەیە چاپ بکە' },
  duplicate: { ar: 'نسخ المشروع', en: 'Duplicate', ckb: 'لەبەرگرتنەوە' },
  duplicateQ: { ar: 'نسخ هذا المشروع؟', en: 'Duplicate this project?', ckb: 'ئەم پڕۆژەیە لەبەربگیرێتەوە؟' },
  duplicateBody: {
    ar: 'تُنشأ نسخة بالملفات والإعدادات نفسها لتطبعها مجددًا دون رفع جديد.',
    en: 'A copy is made with the same files and settings, so you can print again without uploading again.',
    ckb: 'لەبەرگیراوەیەک بە هەمان فایل و ڕێکخستنەکان دروست دەکرێت، بۆ ئەوەی بەبێ بارکردنی نوێ دووبارە چاپی بکەیت.',
  },
  duplicated: { ar: 'نُسخ المشروع', en: 'Project duplicated', ckb: 'پڕۆژەکە لەبەرگیرایەوە' },
  rename: { ar: 'إعادة التسمية', en: 'Rename', ckb: 'ناوگۆڕین' },
  name: { ar: 'اسم المشروع', en: 'Project name', ckb: 'ناوی پڕۆژە' },
  modelName: { ar: 'اسم النموذج', en: 'Model name', ckb: 'ناوی مۆدێل' },
  renamed: { ar: 'حُفظ الاسم', en: 'Name saved', ckb: 'ناوەکە پاشەکەوت کرا' },
  archive: { ar: 'أرشفة', en: 'Archive', ckb: 'ئەرشیفکردن' },
  restore: { ar: 'استعادة', en: 'Restore', ckb: 'گەڕاندنەوە' },
  type: { ar: 'النوع', en: 'Type', ckb: 'جۆر' },
  models: { ar: 'النماذج', en: 'Models', ckb: 'مۆدێلەکان' },
  noModels: { ar: 'لا نماذج في هذا المشروع.', en: 'This project has no models.', ckb: 'ئەم پڕۆژەیە هیچ مۆدێلێکی نییە.' },
  quantity: { ar: 'الكمية', en: 'Quantity', ckb: 'ژمارە' },
  quantityOf: { ar: 'الكمية: {n}', en: 'Quantity: {n}', ckb: 'ژمارە: {n}' },
  noFile: { ar: 'بلا ملف بعد', en: 'No file yet', ckb: 'هێشتا بێ فایل' },
  addModel: { ar: 'إضافة نموذج من المكتبة', en: 'Add a model from the library', ckb: 'زیادکردنی مۆدێل لە کتێبخانەوە' },
  pickFile: { ar: 'ملف جاهز', en: 'A ready file', ckb: 'فایلێکی ئامادە' },
  noReadyFiles: { ar: 'لا ملفات جاهزة في مكتبتك.', en: 'No ready files in your library.', ckb: 'هیچ فایلێکی ئامادە لە کتێبخانەکەتدا نییە.' },
  add: { ar: 'إضافة', en: 'Add', ckb: 'زیادکردن' },
  added: { ar: 'أُضيف النموذج', en: 'Model added', ckb: 'مۆدێلەکە زیاد کرا' },
  plates: { ar: 'ألواح الطباعة', en: 'Build plates', ckb: 'تەختەکانی چاپ' },
  noPlates: {
    ar: 'لا ألواح مرتّبة. إن لم تختر لوحًا، يرتّب برنامج التقطيع النماذج.',
    en: 'No arranged plates. If you do not choose one, the slicer arranges the models.',
    ckb: 'هیچ تەختەیەکی ڕێکخراو نییە. ئەگەر هەڵینەبژێریت، بەرنامەی بڕین مۆدێلەکان ڕێکدەخات.',
  },
  arrange: { ar: 'ترتيب على لوح', en: 'Arrange on a plate', ckb: 'ڕێکخستن لەسەر تەختە' },
  arrangeFor: { ar: 'لطابعة', en: 'For the printer', ckb: 'بۆ چاپکەری' },
  arrangeNote: {
    ar: 'ترتيب بمستطيلات الأبعاد ({algorithm}): ترتيب صادق، لا أفضل ترتيب ممكن.',
    en: 'A bounding-box arrangement ({algorithm}): an honest layout, not an optimised one.',
    ckb: 'ڕێکخستنێک بە چوارگۆشەی دەورەدەر ({algorithm}): ڕێکخستنێکی ڕاستگۆیانە، نەک باشترینی گونجاو.',
  },
  arranged: { ar: 'رُتّب اللوح', en: 'Plate arranged', ckb: 'تەختەکە ڕێکخرا' },
  plateValid: { ar: 'صالح', en: 'Valid', ckb: 'دروستە' },
  plateInvalid: { ar: 'فيه مشكلات', en: 'Has problems', ckb: 'کێشەی هەیە' },
  placed: { ar: 'وُضع: {placed} · لم يتسع: {unplaced}', en: 'Placed: {placed} · Did not fit: {unplaced}', ckb: 'دانرا: {placed} · جێی نەبووەوە: {unplaced}' },
  accessories: { ar: 'الملحقات المقترحة', en: 'Suggested accessories', ckb: 'پاشکۆ پێشنیارکراوەکان' },
  accessoriesNote: {
    ar: 'اقتراحات من قواعد كتبتها الورشة، بحسب كلمات في المشروع ونماذجه. اقبل ما تحتاجه أو تجاهله.',
    en: 'Suggestions from rules the workshop wrote, matched on words in the project and its models. Accept what you need or dismiss it.',
    ckb: 'پێشنیار لە ڕێساکانی کارگەوە، بەپێی وشەکانی پڕۆژە و مۆدێلەکانی. ئەوەی پێویستتە وەریبگرە یان پشتگوێی بخە.',
  },
  accept: { ar: 'قبول', en: 'Accept', ckb: 'وەرگرتن' },
  dismiss: { ar: 'تجاهل', en: 'Dismiss', ckb: 'پشتگوێخستن' },
  accepted: { ar: 'مقبول', en: 'Accepted', ckb: 'وەرگیراو' },
  dismissed: { ar: 'متجاهَل', en: 'Dismissed', ckb: 'پشتگوێخراو' },
  suggested: { ar: 'المقترح: {qty}', en: 'Suggested: {qty}', ckb: 'پێشنیارکراو: {qty}' },
  youHave: { ar: 'لديك: {qty}', en: 'You have: {qty}', ckb: 'هەتە: {qty}' },
  because: { ar: 'بسبب «{word}»', en: 'Because of “{word}”', ckb: 'بەهۆی «{word}»' },
  needsPause: {
    ar: 'تتوقف الطباعة عند طبقة ليضعه فني الورشة.',
    en: 'The print pauses at a layer for a workshop operator to insert it.',
    ckb: 'چاپەکە لە چینێکدا ڕادەگیرێت تا کارمەندێکی کارگە دایبنێت.',
  },
  jobs: { ar: 'طباعات هذا المشروع', en: 'Prints of this project', ckb: 'چاپەکانی ئەم پڕۆژەیە' },
  noJobs: { ar: 'لم يُطبع بعد', en: 'Not printed yet', ckb: 'هێشتا چاپ نەکراوە' },
  modelsInUse: {
    ar: 'لا تتغير النماذج ما دامت طباعة قائمة عليها. ألغِ تلك الطباعة أو انسخ المشروع.',
    en: 'The models cannot change while a print is under way on them. Cancel that print or duplicate the project.',
    ckb: 'مۆدێلەکان ناگۆڕدرێن تا چاپێک لەسەریان بەڕێوە بێت. ئەو چاپە هەڵبوەشێنەرەوە یان پڕۆژەکە لەبەربگرەوە.',
  },
} satisfies Record<string, Tri>;

/** Why a plate is not valid (worker/lib/printCloud/plates.ts `PlateIssue`). */
export const plateIssue = {
  OUT_OF_BED: { ar: 'نموذج يخرج عن حدود اللوح', en: 'A model goes past the edge of the bed', ckb: 'مۆدێلێک لە لێواری سەکۆکە دەردەچێت' },
  TOO_TALL: { ar: 'نموذج أطول مما تسمح به الطابعة', en: 'A model is taller than the printer allows', ckb: 'مۆدێلێک لەوەی چاپکەرەکە ڕێگە دەدات بەرزترە' },
  COLLISION: { ar: 'نماذج متداخلة', en: 'Models overlap', ckb: 'مۆدێلەکان بەسەر یەکدا دەکەون' },
  NOT_ARRANGEABLE: { ar: 'لم تتسع كل النسخ على اللوح', en: 'Not every copy fitted on the plate', ckb: 'هەموو دانەکان لەسەر تەختەکە جێیان نەبووەوە' },
  ORIENTATION_UNKNOWN: {
    ar: 'اتجاه بعض النماذج غير معروف قبل التقطيع',
    en: 'Some models’ orientation is unknown before slicing',
    ckb: 'ئاراستەی هەندێک مۆدێل پێش بڕین نەزانراوە',
  },
  MODEL_CHANGED: { ar: 'تغيّر نموذج بعد الترتيب', en: 'A model changed after the arrangement', ckb: 'مۆدێلێک دوای ڕێکخستن گۆڕا' },
  other: { ar: 'مشكلة: {code}', en: 'Problem: {code}', ckb: 'کێشە: {code}' },
} satisfies Record<string, Tri>;

/** Why a printer model does not suit a project (worker/lib/printCloud/recommendations.ts). */
export const printerReason = {
  model_exceeds_build_volume: { ar: 'النموذج أكبر من حجم الطباعة', en: 'The model is larger than the build volume', ckb: 'مۆدێلەکە لە قەبارەی چاپ گەورەترە' },
  material_not_supported: { ar: 'لا تطبع هذه المادة', en: 'It does not print this material', ckb: 'ئەم کەرەستەیە چاپ ناکات' },
  too_many_colours: { ar: 'ألوان أكثر مما تدعم', en: 'More colours than it supports', ckb: 'ڕەنگی زیاتر لەوەی پشتگیری دەکات' },
  no_active_machine: { ar: 'لا آلة منها في الخدمة', en: 'No machine of it in service', ckb: 'هیچ ئامێرێکی لە کاردا نییە' },
  other: { ar: 'غير متوافقة: {code}', en: 'Not compatible: {code}', ckb: 'گونجاو نییە: {code}' },
} satisfies Record<string, Tri>;

/** Print settings (worker/lib/printCloud/projects.ts `PrintSettings`). */
export const settingWords = {
  title: { ar: 'الجودة والإعدادات', en: 'Quality and settings', ckb: 'کوالیتی و ڕێکخستنەکان' },
  profile: { ar: 'ملف إعدادات محفوظ', en: 'Saved profile', ckb: 'پرۆفایلی پاشەکەوتکراو' },
  profileNone: { ar: 'إعدادات المشروع', en: 'The project’s settings', ckb: 'ڕێکخستنەکانی پڕۆژە' },
  saveProfile: { ar: 'حفظ كملف إعدادات', en: 'Save as a profile', ckb: 'وەک پرۆفایل پاشەکەوتی بکە' },
  updateProfile: { ar: 'تحديث «{name}»', en: 'Update “{name}”', ckb: 'نوێکردنەوەی «{name}»' },
  profileName: { ar: 'اسم ملف الإعدادات', en: 'Profile name', ckb: 'ناوی پرۆفایل' },
  profileSaved: { ar: 'حُفظ ملف الإعدادات', en: 'Profile saved', ckb: 'پرۆفایلەکە پاشەکەوت کرا' },
  layerHeight: { ar: 'ارتفاع الطبقة', en: 'Layer height', ckb: 'بەرزیی چین' },
  fine: { ar: 'دقيقة', en: 'Fine', ckb: 'ورد' },
  standard: { ar: 'قياسية', en: 'Standard', ckb: 'ئاسایی' },
  draft: { ar: 'سريعة', en: 'Draft', ckb: 'خێرا' },
  infill: { ar: 'نسبة الحشو', en: 'Infill', ckb: 'پڕکردنەوەی ناوەوە' },
  supports: { ar: 'الدعامات', en: 'Supports', ckb: 'پاڵپشتەکان' },
  supports_none: { ar: 'بدون', en: 'None', ckb: 'بێ پاڵپشت' },
  supports_auto: { ar: 'تلقائية', en: 'Automatic', ckb: 'خۆکار' },
  supports_tree: { ar: 'شجرية', en: 'Tree', ckb: 'درەختی' },
  supports_normal: { ar: 'عادية', en: 'Normal', ckb: 'ئاسایی' },
  plateType: { ar: 'سطح اللوح', en: 'Build plate', ckb: 'ڕووی تەختە' },
  textured_pei: { ar: 'PEI محبّب', en: 'Textured PEI', ckb: 'PEI ی زبر' },
  smooth_pei: { ar: 'PEI أملس', en: 'Smooth PEI', ckb: 'PEI ی لووس' },
  cool_plate: { ar: 'اللوح البارد', en: 'Cool plate', ckb: 'تەختەی سارد' },
  engineering_plate: { ar: 'اللوح الهندسي', en: 'Engineering plate', ckb: 'تەختەی ئەندازیاری' },
  high_temp_plate: { ar: 'لوح الحرارة العالية', en: 'High-temperature plate', ckb: 'تەختەی گەرمیی بەرز' },
  walls: { ar: 'عدد الجدران', en: 'Walls', ckb: 'ژمارەی دیوار' },
  brim: { ar: 'حافة لاصقة', en: 'Brim', ckb: 'لێواری لکاو' },
  brimHint: {
    ar: 'حافة رقيقة حول القاعدة تساعد على الالتصاق.',
    en: 'A thin rim around the base that helps it stick.',
    ckb: 'لێوارێکی تەنک بە دەوری بنکەکەدا کە یارمەتی لکان دەدات.',
  },
  nozzle: { ar: 'قطر الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' },
  orientation: { ar: 'الاتجاه', en: 'Orientation', ckb: 'ئاراستە' },
  orientation_as_uploaded: { ar: 'كما رُفع', en: 'As uploaded', ckb: 'وەک بارکراوە' },
  orientation_auto: { ar: 'يختاره برنامج التقطيع', en: 'Chosen by the slicer', ckb: 'بەرنامەی بڕین هەڵیدەبژێرێت' },
  plateNeedsFixed: {
    ar: 'اللوح المرتّب يتطلب الاتجاه «كما رُفع».',
    en: 'An arranged plate needs the orientation “as uploaded”.',
    ckb: 'تەختەی ڕێکخراو ئاراستەی «وەک بارکراوە»ی پێویستە.',
  },
  notes: { ar: 'ملاحظات للورشة', en: 'Notes for the workshop', ckb: 'تێبینی بۆ کارگە' },
  copies: { ar: 'عدد النسخ', en: 'Copies', ckb: 'ژمارەی دانە' },
  pauseLayers: { ar: 'توقف عند الطبقات: {layers}', en: 'Pauses at layers: {layers}', ckb: 'ڕاگرتن لە چینەکانی: {layers}' },
  plate: { ar: 'اللوح', en: 'Plate', ckb: 'تەختە' },
  noPlate: {
    ar: 'بدون لوح — يرتّب برنامج التقطيع النماذج',
    en: 'No plate — the slicer arranges the models',
    ckb: 'بێ تەختە — بەرنامەی بڕین مۆدێلەکان ڕێکدەخات',
  },
} satisfies Record<string, Tri>;

/** The configure screen: material, printer, settings, then «ask for an estimate». */
export const configure = {
  title: { ar: 'إعدادات الطباعة', en: 'Print settings', ckb: 'ڕێکخستنەکانی چاپ' },
  subtitle: {
    ar: 'اختر المادة والطابعة والجودة، ثم اطلب تقديرًا من الورشة. لا يُحجز شيء قبل أن تؤكد.',
    en: 'Choose the material, printer and quality, then ask the workshop for an estimate. Nothing is reserved until you confirm.',
    ckb: 'کەرەستە و چاپکەر و کوالیتی هەڵبژێرە، پاشان داوای خەمڵاندن لە کارگە بکە. هیچ شتێک ناگیرێت تا پشتڕاستی نەکەیتەوە.',
  },
  materials: { ar: 'المادة لكل نموذج', en: 'Material for each model', ckb: 'کەرەستە بۆ هەر مۆدێلێک' },
  inInventory: { ar: 'في مخزونك', en: 'In your inventory', ckb: 'لە کۆگاکەتدا' },
  notOwned: { ar: 'ليست في مخزونك بعد', en: 'Not in your inventory yet', ckb: 'هێشتا لە کۆگاکەتدا نییە' },
  buyMaterial: { ar: 'شراء مواد', en: 'Buy material', ckb: 'کڕینی کەرەستە' },
  noMaterials: {
    ar: 'لا خيوط في مخزونك أو في المتجر بعد.',
    en: 'No filament in your inventory or the store yet.',
    ckb: 'هێشتا هیچ فیلامێنتێک لە کۆگاکەت یان فرۆشگادا نییە.',
  },
  chooseMaterial: { ar: 'اختر مادة', en: 'Choose a material', ckb: 'کەرەستەیەک هەڵبژێرە' },
  yours: { ar: '{name} — لديك {qty}', en: '{name} — you have {qty}', ckb: '{name} — {qty}ت هەیە' },
  multiMaterial: { ar: 'عدد المواد المعيّنة: {n}', en: 'Materials assigned: {n}', ckb: 'ژمارەی کەرەستەی دیاریکراو: {n}' },
  materialSaved: { ar: 'حُفظت المادة', en: 'Material saved', ckb: 'کەرەستەکە پاشەکەوت کرا' },
  printer: { ar: 'الطابعة', en: 'Printer', ckb: 'چاپکەر' },
  printerNote: {
    ar: 'توافق كل طابعة كما يحسبه الخادم لنماذجك وموادها. تُحجز الساعات من فئة الطابعة.',
    en: 'Each printer’s fit as the server works it out for your models and their materials. The hours come from the printer’s class.',
    ckb: 'گونجانی هەر چاپکەرێک وەک ڕاژەکار بۆ مۆدێل و کەرەستەکانت دەیژمێرێت. کاتژمێرەکان لە پۆلی چاپکەرەکە دەگیرێن.',
  },
  hoursInClass: { ar: 'لديك {amount} في {class}', en: 'You hold {amount} in {class}', ckb: 'لە {class} {amount}ت هەیە' },
  jobsAhead: { ar: 'طباعات قبلك على هذا الطراز: {n}', en: 'Prints ahead on this model: {n}', ckb: 'چاپی پێش تۆ لەسەر ئەم مۆدێلە: {n}' },
  bestQuality: { ar: 'أعلى جودة', en: 'Best quality', ckb: 'باشترین کوالیتی' },
  shortestQueue: { ar: 'أقصر انتظار', en: 'Shortest queue', ckb: 'کورتترین ڕیز' },
  mostCredit: { ar: 'أكثر ساعات لديك', en: 'Most hours held', ckb: 'زۆرترین کاتژمێری هەتە' },
  lowestCost: { ar: 'أقل كلفة', en: 'Lowest cost', ckb: 'کەمترین تێچوو' },
  noPrinters: { ar: 'لا طابعات للاختيار.', en: 'No printers to choose from.', ckb: 'هیچ چاپکەرێک نییە بۆ هەڵبژاردن.' },
  noCompatible: {
    ar: 'لا طابعة متوافقة مع هذا المشروع كما هو.',
    en: 'No printer is compatible with this project as it is.',
    ckb: 'هیچ چاپکەرێک لەگەڵ ئەم پڕۆژەیە وەک خۆی گونجاو نییە.',
  },
  accessories: { ar: 'الملحقات', en: 'Accessories', ckb: 'پاشکۆکان' },
  accessoriesUsed: {
    ar: 'الملحقات المقبولة تُضاف إلى هذه الطباعة وتُحجز من مخزونك عند التأكيد.',
    en: 'Accepted accessories are added to this print and reserved from your inventory when you confirm.',
    ckb: 'پاشکۆ وەرگیراوەکان دەخرێنە سەر ئەم چاپە و کاتی پشتڕاستکردنەوە لە کۆگاکەت دەگیرێن.',
  },
  buyAccessories: { ar: 'شراء ملحقات', en: 'Buy accessories', ckb: 'کڕینی پاشکۆ' },
  accessoryUnnamed: { ar: 'ملحق تعذّر تحميل اسمه', en: 'An accessory whose name could not be loaded', ckb: 'پاشکۆیەک کە ناوەکەی بار نەکرا' },
  getEstimate: { ar: 'اطلب تقديرًا من الورشة', en: 'Ask the workshop for an estimate', ckb: 'داوای خەمڵاندن لە کارگە بکە' },
  getEstimateHint: {
    ar: 'لا يُعرض وقت ولا غرامات قبل أن يقيس برنامج التقطيع في الورشة نموذجك. لا يُحجز أو يُخصم شيء الآن.',
    en: 'No time or grams are shown until the workshop’s slicer measures your model. Nothing is reserved or charged now.',
    ckb: 'هیچ کات و گرامێک پیشان نادرێت تا بەرنامەی بڕینی کارگە مۆدێلەکەت دەپێوێت. ئێستا هیچ شتێک ناگیرێت و نابڕدرێت.',
  },
  needMaterial: { ar: 'اختر مادة لكل نموذج.', en: 'Choose a material for every model.', ckb: 'بۆ هەر مۆدێلێک کەرەستەیەک هەڵبژێرە.' },
  needPrinter: { ar: 'اختر طابعة متوافقة.', en: 'Choose a compatible printer.', ckb: 'چاپکەرێکی گونجاو هەڵبژێرە.' },
  filesPending: {
    ar: 'ما زالت بعض الملفات قيد الفحص؛ اطلب التقدير من صفحة الطباعة حين تجهز.',
    en: 'Some files are still being checked; ask for the estimate from the print’s page once they are ready.',
    ckb: 'هێشتا هەندێک فایل لە پشکنیندان؛ کاتێک ئامادە بوون لە پەڕەی چاپەکەوە داوای خەمڵاندن بکە.',
  },
  analyzeLater: {
    ar: 'أُنشئت الطباعة، لكن طلب التقدير لم يُقبل: {reason}',
    en: 'The print was created, but the estimate request was refused: {reason}',
    ckb: 'چاپەکە دروستکرا، بەڵام داوای خەمڵاندن ڕەتکرایەوە: {reason}',
  },
} satisfies Record<string, Tri>;

/** The list of jobs, grouped as GET /jobs groups them. */
export const jobsWords = {
  subtitle: { ar: 'كل طباعاتك بحسب مرحلتها.', en: 'All your prints, by where they are.', ckb: 'هەموو چاپەکانت، بەپێی ئەوەی لە کوێن.' },
  current: { ar: 'الآن', en: 'Now', ckb: 'ئێستا' },
  queued: { ar: 'في الانتظار', en: 'Waiting', ckb: 'چاوەڕوان' },
  in_preparation: { ar: 'قيد الإعداد', en: 'Being set up', ckb: 'لە ئامادەکردندا' },
  completed: { ar: 'المكتملة', en: 'Completed', ckb: 'تەواوبوو' },
  failed: { ar: 'المتعثرة', en: 'Failed', ckb: 'شکستخواردوو' },
  cancelled: { ar: 'الملغاة', en: 'Cancelled', ckb: 'هەڵوەشێنراو' },
  none: { ar: 'لا طباعات بعد', en: 'No prints yet', ckb: 'هێشتا هیچ چاپێک نییە' },
  noneBody: {
    ar: 'ارفع نموذجًا واختر إعداداته لتحصل على أول تقدير.',
    en: 'Upload a model and choose its settings to get your first estimate.',
    ckb: 'مۆدێلێک بار بکە و ڕێکخستنەکانی هەڵبژێرە بۆ وەرگرتنی یەکەم خەمڵاندن.',
  },
  start: { ar: 'ابدأ طباعة', en: 'Start a print', ckb: 'چاپێک دەست پێبکە' },
  showAll: { ar: 'عرض الكل ({n})', en: 'Show all ({n})', ckb: 'هەمووی پیشان بدە ({n})' },
} satisfies Record<string, Tri>;

/** The steps a job walks, as the customer reads them. */
export const stepWords = {
  label: { ar: 'مراحل الطباعة', en: 'Print stages', ckb: 'قۆناغەکانی چاپ' },
  estimate: { ar: 'التقدير', en: 'Estimate', ckb: 'خەمڵاندن' },
  confirm: { ar: 'تأكيدك', en: 'Your confirmation', ckb: 'پشتڕاستکردنەوەی تۆ' },
  approval: { ar: 'موافقة الورشة', en: 'Workshop approval', ckb: 'ڕەزامەندیی کارگە' },
  queue: { ar: 'قائمة الانتظار', en: 'Queue', ckb: 'ڕیز' },
  printing: { ar: 'الطباعة', en: 'Printing', ckb: 'چاپکردن' },
  done: { ar: 'اكتملت', en: 'Done', ckb: 'تەواو' },
  current: { ar: 'المرحلة الحالية', en: 'current stage', ckb: 'قۆناغی ئێستا' },
  passed: { ar: 'تمّت', en: 'done', ckb: 'تێپەڕی' },
} satisfies Record<string, Tri>;

/** What each of the fourteen states means, in a sentence (worker/lib/printCloud/jobs.ts). */
export const jobExplain = {
  draft: {
    ar: 'الطباعة محفوظة كمسودة. إن كانت ملفاتها قيد الفحص، اطلب التقدير حين تجهز.',
    en: 'The print is saved as a draft. If its files are still being checked, ask for the estimate once they are ready.',
    ckb: 'چاپەکە وەک ڕەشنووس پاشەکەوت کراوە. ئەگەر فایلەکانی هێشتا لە پشکنیندان، کاتێک ئامادە بوون داوای خەمڵاندن بکە.',
  },
  uploaded: {
    ar: 'الملفات جاهزة. اطلب تقديرًا ليقيس برنامج التقطيع الوقت والغرامات.',
    en: 'The files are ready. Ask for an estimate so the slicer can measure the time and grams.',
    ckb: 'فایلەکان ئامادەن. داوای خەمڵاندن بکە بۆ ئەوەی بەرنامەی بڕین کات و گرامەکان بپێوێت.',
  },
  analyzing: {
    ar: 'بانتظار تقدير الورشة. لا يُعرض أي رقم قبل وصوله.',
    en: 'Waiting for the workshop’s estimate. No figure is shown before it arrives.',
    ckb: 'چاوەڕێی خەمڵاندنی کارگە. هیچ ژمارەیەک پیشان نادرێت تا دەگات.',
  },
  ready: {
    ar: 'وصل التقدير. راجع ما سيُحجز ثم أكّد.',
    en: 'The estimate is here. Review what will be reserved, then confirm.',
    ckb: 'خەمڵاندنەکە گەیشت. سەیری ئەوە بکە کە دەگیرێت، پاشان پشتڕاستی بکەرەوە.',
  },
  awaiting_confirmation: {
    ar: 'راجعت التقدير. أكّد قبل انتهاء المهلة لتُحجز الساعات والمواد.',
    en: 'You reviewed the estimate. Confirm before the window closes to reserve the hours and materials.',
    ckb: 'پێداچوونەوەت بە خەمڵاندنەکەدا کرد. پێش داخستنی ماوەکە پشتڕاستی بکەرەوە بۆ گرتنی کاتژمێر و کەرەستەکان.',
  },
  confirmed: {
    ar: 'أكّدت وحُجزت الساعات والمواد. تنتظر الطباعة موافقة الورشة لتدخل قائمة الانتظار.',
    en: 'You confirmed and the hours and materials are reserved. The print waits for the workshop’s approval to join the queue.',
    ckb: 'پشتڕاستت کردەوە و کاتژمێر و کەرەستەکان گیران. چاپەکە چاوەڕێی ڕەزامەندیی کارگەیە بۆ چوونە ڕیزەوە.',
  },
  queued: {
    ar: 'الطباعة في قائمة الانتظار حتى تفرغ طابعة جاهزة ومتوافقة.',
    en: 'The print is in the queue until a ready, compatible printer is free.',
    ckb: 'چاپەکە لە ڕیزدایە تا چاپکەرێکی ئامادە و گونجاو بەتاڵ دەبێت.',
  },
  preparing: {
    ar: 'أُسندت الطباعة إلى آلة والورشة تجهّزها.',
    en: 'The print is on a machine and the workshop is preparing it.',
    ckb: 'چاپەکە دراوەتە ئامێرێک و کارگە ئامادەی دەکات.',
  },
  printing: {
    ar: 'تُطبع الآن. يظهر التقدّم فقط من بيانات الطابعة المباشرة.',
    en: 'Printing now. Progress shows only from the printer’s live data.',
    ckb: 'ئێستا چاپ دەکرێت. پێشکەوتن تەنها لە زانیاریی ڕاستەوخۆی چاپکەرەوە پیشان دەدرێت.',
  },
  paused: { ar: 'الطباعة متوقفة مؤقتًا في الورشة.', en: 'The print is paused at the workshop.', ckb: 'چاپەکە لە کارگە بۆ ماوەیەک ڕاگیراوە.' },
  completed: {
    ar: 'اكتملت الطباعة. خُصم ما استُهلك فعلًا وعاد الباقي إلى رصيدك.',
    en: 'The print is complete. What was actually used was charged and the rest returned to your balance.',
    ckb: 'چاپەکە تەواو بوو. ئەوەی بەڕاستی بەکارهات بڕدرا و ئەوەی تر گەڕایەوە سەر باڵانسەکەت.',
  },
  failed: {
    ar: 'تعذّرت الطباعة. تراجع الورشة السبب وتقرر ما يُحتسب.',
    en: 'The print failed. The workshop reviews why and decides what is charged.',
    ckb: 'چاپەکە سەرکەوتوو نەبوو. کارگە هۆکارەکە دەپشکنێت و بڕیار دەدات چی دەبڕدرێت.',
  },
  cancelled: {
    ar: 'أُلغيت الطباعة، ولا يبقى لها شيء محجوز.',
    en: 'The print was cancelled; nothing stays reserved for it.',
    ckb: 'چاپەکە هەڵوەشێنرایەوە؛ هیچ شتێک بۆی گیراو نامێنێتەوە.',
  },
  reprint_requested: {
    ar: 'أُنشئت طباعة جديدة بدلًا من هذه.',
    en: 'A new print was created in place of this one.',
    ckb: 'چاپێکی نوێ لە جیاتی ئەمە دروستکرا.',
  },
} satisfies Record<string, Tri>;

/** One job's page. */
export const jobWords = {
  notFound: { ar: 'هذه الطباعة غير موجودة', en: 'This print does not exist', ckb: 'ئەم چاپە بوونی نییە' },
  onModel: { ar: 'على {printer}', en: 'On {printer}', ckb: 'لەسەر {printer}' },
  analyze: { ar: 'اطلب التقدير', en: 'Ask for the estimate', ckb: 'داوای خەمڵاندن بکە' },
  analyzeSent: {
    ar: 'أُرسل الطلب إلى برنامج التقطيع في الورشة.',
    en: 'The request went to the workshop’s slicer.',
    ckb: 'داواکارییەکە نێردرا بۆ بەرنامەی بڕینی کارگە.',
  },
  analyzeWaiting: {
    ar: 'لا برنامج تقطيع متصل الآن؛ سيُدخل فني الورشة التقدير.',
    en: 'No slicer is connected right now; a workshop operator will enter the estimate.',
    ckb: 'ئێستا هیچ بەرنامەیەکی بڕین پەیوەست نییە؛ کارمەندێکی کارگە خەمڵاندنەکە دەنووسێت.',
  },
  lastAnalysisFailed: {
    ar: 'لم يكتمل آخر تقدير ({code}). يمكنك طلبه مجددًا.',
    en: 'The last estimate did not complete ({code}). You can ask again.',
    ckb: 'دوایین خەمڵاندن تەواو نەبوو ({code}). دەتوانیت دووبارە داوای بکەیتەوە.',
  },
  lastIncompatible: {
    ar: 'رأى برنامج التقطيع أن الطباعة غير متوافقة مع هذه الإعدادات.',
    en: 'The slicer found the print incompatible with these settings.',
    ckb: 'بەرنامەی بڕین چاپەکەی لەگەڵ ئەم ڕێکخستنانەدا بە نەگونجاو زانی.',
  },
  review: { ar: 'راجع وأكّد', en: 'Review and confirm', ckb: 'پێداچوونەوە و پشتڕاستکردنەوە' },
  confirm: { ar: 'تأكيد الطباعة', en: 'Confirm the print', ckb: 'پشتڕاستکردنەوەی چاپ' },
  edit: { ar: 'تغيير الإعدادات', en: 'Change settings', ckb: 'گۆڕینی ڕێکخستنەکان' },
  editBody: {
    ar: 'تغيير الإعدادات يلغي التقدير الحالي ويعيد الطباعة إلى المسودة لتطلب تقديرًا جديدًا.',
    en: 'Changing the settings discards the current estimate and returns the print to draft, to ask for a new one.',
    ckb: 'گۆڕینی ڕێکخستنەکان خەمڵاندنی ئێستا لادەبات و چاپەکە دەگەڕێنێتەوە بۆ ڕەشنووس، بۆ داوای خەمڵاندنێکی نوێ.',
  },
  editSaved: { ar: 'حُفظت الإعدادات. اطلب تقديرًا جديدًا.', en: 'Settings saved. Ask for a new estimate.', ckb: 'ڕێکخستنەکان پاشەکەوت کران. داوای خەمڵاندنێکی نوێ بکە.' },
  cancel: { ar: 'إلغاء الطباعة', en: 'Cancel the print', ckb: 'هەڵوەشاندنەوەی چاپ' },
  cancelQ: { ar: 'إلغاء هذه الطباعة؟', en: 'Cancel this print?', ckb: 'ئەم چاپە هەڵبوەشێنرێتەوە؟' },
  cancelBody: {
    ar: 'تُلغى الطباعة نهائيًا، ويعود إلى رصيدك كل ما حُجز لها من ساعات ومواد.',
    en: 'The print is cancelled for good, and any hours and materials reserved for it return to your balance.',
    ckb: 'چاپەکە بە یەکجاری هەڵدەوەشێتەوە، و هەر کاتژمێر و کەرەستەیەک بۆی گیرابێت دەگەڕێتەوە سەر باڵانسەکەت.',
  },
  keep: { ar: 'إبقاء الطباعة', en: 'Keep the print', ckb: 'چاپەکە بهێڵەرەوە' },
  cancelled: { ar: 'أُلغيت الطباعة', en: 'Print cancelled', ckb: 'چاپەکە هەڵوەشێنرایەوە' },
  openProject: { ar: 'فتح المشروع', en: 'Open the project', ckb: 'پڕۆژەکە بکەرەوە' },
  estimate: { ar: 'التقدير', en: 'Estimate', ckb: 'خەمڵاندن' },
  awaitingBody: {
    ar: 'لا تقدير بعد: لا وقت ولا غرامات تُعرض حتى يقيسها برنامج التقطيع أو فني الورشة.',
    en: 'No estimate yet: no time or grams are shown until the slicer or a workshop operator measures them.',
    ckb: 'هێشتا خەمڵاندن نییە: هیچ کات و گرامێک پیشان نادرێت تا بەرنامەی بڕین یان کارمەندێکی کارگە دەیانپێوێت.',
  },
  sourceSlicer: { ar: 'قاسه برنامج التقطيع في الورشة', en: 'Measured by the workshop’s slicer', ckb: 'بەرنامەی بڕینی کارگە پێوای' },
  sourceSlicerNamed: {
    ar: 'قاسه برنامج التقطيع في الورشة ({slicer})',
    en: 'Measured by the workshop’s slicer ({slicer})',
    ckb: 'بەرنامەی بڕینی کارگە پێوای ({slicer})',
  },
  sourceOperator: {
    ar: 'أدخله فني الورشة من برنامج التقطيع لديه',
    en: 'Entered by a workshop operator from their slicer',
    ckb: 'کارمەندێکی کارگە لە بەرنامەی بڕینەکەیەوە نووسیویەتی',
  },
  printTime: { ar: 'وقت الطباعة', en: 'Print time', ckb: 'کاتی چاپ' },
  material: { ar: 'المادة', en: 'Material', ckb: 'کەرەستە' },
  grams: {
    ar: 'النموذج {model} · الدعامات {support} · التنظيف {purge}',
    en: 'model {model} · supports {support} · purge {purge}',
    ckb: 'مۆدێل {model} · پاڵپشت {support} · پاککردنەوە {purge}',
  },
  layers: { ar: 'الطبقات', en: 'Layers', ckb: 'چینەکان' },
  colourChanges: { ar: 'تبديلات اللون', en: 'Colour changes', ckb: 'گۆڕینی ڕەنگ' },
  slicerNotes: { ar: 'ملاحظات برنامج التقطيع', en: 'The slicer’s notes', ckb: 'تێبینییەکانی بەرنامەی بڕین' },
  estimateNote: {
    ar: 'تقدير، لا فاتورة: بعد الطباعة يُخصم ما استُهلك فعلًا.',
    en: 'An estimate, not a bill: after printing, what was actually used is charged.',
    ckb: 'خەمڵاندنە، نەک پسوولە: دوای چاپ ئەوەی بەڕاستی بەکارهات دەبڕدرێت.',
  },
  projection: { ar: 'ما سيُحجز عند التأكيد', en: 'What confirming will reserve', ckb: 'ئەوەی پشتڕاستکردنەوە دەیگرێت' },
  hoursOf: { ar: 'ساعات {class}', en: '{class} hours', ckb: 'کاتژمێرەکانی {class}' },
  printingHours: { ar: 'ساعات الطباعة', en: 'Printing hours', ckb: 'کاتژمێرەکانی چاپ' },
  needed: { ar: 'المطلوب', en: 'Needed', ckb: 'پێویست' },
  have: { ar: 'لديك', en: 'You have', ckb: 'هەتە' },
  after: { ar: 'بعد الحجز', en: 'After', ckb: 'دوای گرتن' },
  short: { ar: 'ينقصك {amount}', en: '{amount} short', ckb: '{amount} کەمە' },
  enough: { ar: 'يكفي', en: 'Enough', ckb: 'بەسە' },
  buyHours: { ar: 'شراء ساعات {class}', en: 'Buy {class} hours', ckb: 'کڕینی کاتژمێری {class}' },
  buyHoursPlain: { ar: 'شراء ساعات', en: 'Buy hours', ckb: 'کڕینی کاتژمێر' },
  buy: { ar: 'شراء {name}', en: 'Buy {name}', ckb: 'کڕینی {name}' },
  shortTitle: { ar: 'رصيدك لا يكفي بعد', en: 'Your balance is not enough yet', ckb: 'باڵانسەکەت هێشتا بەس نییە' },
  shortBody: {
    ar: 'اشترِ ما ينقص ثم راجع مجددًا. لا يُحجز شيء حتى يكفي كل بند.',
    en: 'Buy what is missing, then review again. Nothing is reserved until every line is covered.',
    ckb: 'ئەوەی کەمە بیکڕە، پاشان دووبارە پێداچوونەوە بکە. هیچ شتێک ناگیرێت تا هەموو بڕگەیەک بەس دەبێت.',
  },
  covered: { ar: 'رصيدك يغطي هذه الطباعة.', en: 'Your balance covers this print.', ckb: 'باڵانسەکەت ئەم چاپە دادەپۆشێت.' },
  materialId: { ar: 'مادة {id}', en: 'Material {id}', ckb: 'کەرەستەی {id}' },
  filament: { ar: 'خيط', en: 'Filament', ckb: 'فیلامێنت' },
  accessory: { ar: 'ملحق', en: 'Accessory', ckb: 'پاشکۆ' },
  reviewing: {
    ar: 'نقارن التقدير برصيدك الآن…',
    en: 'Checking the estimate against your balance now…',
    ckb: 'ئێستا خەمڵاندنەکە لەگەڵ باڵانسەکەت بەراورد دەکەین…',
  },
  confirmLead: {
    ar: 'عند التأكيد تُحجز هذه الساعات والمواد من رصيدك:',
    en: 'Confirming reserves these hours and materials from your balance:',
    ckb: 'پشتڕاستکردنەوە ئەم کاتژمێر و کەرەستانە لە باڵانسەکەت دەگرێت:',
  },
  holdsUntil: { ar: 'هذه المراجعة صالحة حتى {time}.', en: 'This review holds until {time}.', ckb: 'ئەم پێداچوونەوەیە تا {time} دەمێنێت.' },
  approvalNext: {
    ar: 'بعد التأكيد توافق الورشة على الطباعة، ثم تدخل قائمة الانتظار.',
    en: 'After you confirm, the workshop approves the print, then it joins the queue.',
    ckb: 'دوای پشتڕاستکردنەوە، کارگە ڕەزامەندی دەدات، پاشان چاپەکە دەچێتە ڕیزەوە.',
  },
  queueNext: {
    ar: 'بعد التأكيد تدخل الطباعة قائمة الانتظار مباشرة.',
    en: 'After you confirm, the print joins the queue straight away.',
    ckb: 'دوای پشتڕاستکردنەوە، چاپەکە ڕاستەوخۆ دەچێتە ڕیزەوە.',
  },
  settleNote: {
    ar: 'بعد الطباعة يُخصم ما استُهلك فعلًا ويعود الباقي إلى رصيدك.',
    en: 'After printing, what was actually used is charged and the rest returns to your balance.',
    ckb: 'دوای چاپ، ئەوەی بەڕاستی بەکارهات دەبڕدرێت و ئەوەی تر دەگەڕێتەوە سەر باڵانسەکەت.',
  },
  confirmed: {
    ar: 'أُكّدت الطباعة وحُجزت الساعات والمواد.',
    en: 'Print confirmed; the hours and materials are reserved.',
    ckb: 'چاپەکە پشتڕاستکرایەوە و کاتژمێر و کەرەستەکان گیران.',
  },
  replayed: {
    ar: 'كانت هذه الطباعة مؤكدة من قبل؛ لم يُحجز شيء مرتين.',
    en: 'This print was already confirmed; nothing was reserved twice.',
    ckb: 'ئەم چاپە پێشتر پشتڕاستکرابووەوە؛ هیچ شتێک دوو جار نەگیرا.',
  },
  expired: {
    ar: 'انتهت مهلة المراجعة. راجع مجددًا لترى الأرقام الحالية.',
    en: 'The review window closed. Review again to see the current figures.',
    ckb: 'ماوەی پێداچوونەوە تەواو بوو. دووبارە پێداچوونەوە بکە بۆ بینینی ژمارەکانی ئێستا.',
  },
  reviewAgain: { ar: 'راجع مجددًا', en: 'Review again', ckb: 'دووبارە پێداچوونەوە بکە' },
  queue: { ar: 'قائمة الانتظار', en: 'The queue', ckb: 'ڕیز' },
  position: { ar: 'ترتيبك: {n}', en: 'Your position: {n}', ckb: 'ڕیزبەندیت: {n}' },
  startsAround: { ar: 'البدء المتوقع {when}', en: 'Estimated start {when}', ckb: 'دەستپێکی چاوەڕوانکراو {when}' },
  endsAround: { ar: 'الانتهاء المتوقع {when}', en: 'Estimated finish {when}', ckb: 'کۆتایی چاوەڕوانکراو {when}' },
  queueNote: {
    ar: 'الأوقات تقدير من محاكاة قائمة الانتظار الحالية، وليست وعدًا.',
    en: 'Times are an estimate from a simulation of the current queue, not a promise.',
    ckb: 'کاتەکان خەمڵاندنن لە لاساییکردنەوەی ڕیزی ئێستاوە، بەڵێن نین.',
  },
  noPosition: {
    ar: 'لا يذكر الخادم موقعًا لهذه الطباعة الآن.',
    en: 'The server gives no position for this print right now.',
    ckb: 'ڕاژەکار ئێستا هیچ شوێنێک بۆ ئەم چاپە دیاری ناکات.',
  },
  no_compatible_printer: { ar: 'بانتظار طابعة متوافقة', en: 'Waiting for a compatible printer', ckb: 'چاوەڕێی چاپکەرێکی گونجاو' },
  waiting_for_dependency: { ar: 'تنتظر اكتمال طباعة أخرى', en: 'Waiting for another print to finish', ckb: 'چاوەڕێی تەواوبوونی چاپێکی ترە' },
  dependency_cannot_complete: {
    ar: 'الطباعة التي تعتمد عليها لن تكتمل',
    en: 'The print it depends on cannot be completed',
    ckb: 'ئەو چاپەی پشتی پێ دەبەستێت تەواو نابێت',
  },
  holdUntil: { ar: 'لن تبدأ قبل {time}', en: 'Will not start before {time}', ckb: 'پێش {time} دەست پێناکات' },
  reschedule: { ar: 'تأجيل البدء', en: 'Hold the start', ckb: 'دواخستنی دەستپێک' },
  rescheduleBody: {
    ar: 'اختر وقتًا لا تبدأ الطباعة قبله. تبقى في ترتيبها في القائمة.',
    en: 'Choose a time the print will not start before. It keeps its order in the queue.',
    ckb: 'کاتێک هەڵبژێرە کە چاپەکە پێش ئەو دەست پێناکات. ڕیزبەندییەکەی لە ڕیزدا دەمێنێتەوە.',
  },
  notBefore: { ar: 'لا تبدأ قبل', en: 'Not before', ckb: 'نەک پێش' },
  clearHold: { ar: 'إزالة التأجيل', en: 'Remove the hold', ckb: 'لابردنی دواخستن' },
  rescheduled: { ar: 'حُفظ وقت البدء', en: 'Start time saved', ckb: 'کاتی دەستپێک پاشەکەوت کرا' },
  inPast: { ar: 'اختر وقتًا في المستقبل.', en: 'Choose a time in the future.', ckb: 'کاتێک لە داهاتوودا هەڵبژێرە.' },
  printerProgress: { ar: 'الطابعة والتقدّم', en: 'Printer and progress', ckb: 'چاپکەر و پێشکەوتن' },
  notOnMachine: { ar: 'لم تُسند إلى آلة بعد.', en: 'Not on a machine yet.', ckb: 'هێشتا نەدراوەتە هیچ ئامێرێک.' },
  liveFrom: { ar: 'بيانات مباشرة من {printer}', en: 'Live from {printer}', ckb: 'ڕاستەوخۆ لە {printer}' },
  staleSince: {
    ar: 'آخر قراءة من الطابعة {when} — ليست مباشرة.',
    en: 'The printer last reported {when} — this is not live.',
    ckb: 'دوایین ڕاپۆرتی چاپکەرەکە {when} بوو — ئەمە ڕاستەوخۆ نییە.',
  },
  noTelemetry: {
    ar: 'لم ترسل هذه الطابعة أي قراءة بعد؛ تتغير الحالة حين تحدّثها الورشة.',
    en: 'This printer has sent no reading yet; the status changes when the workshop updates it.',
    ckb: 'ئەم چاپکەرە هێشتا هیچ خوێندنەوەیەکی نەناردووە؛ دۆخەکە کاتێک کارگە نوێی دەکاتەوە دەگۆڕێت.',
  },
  elsewhere: {
    ar: 'آخر قراءة من الطابعة لا تخص هذه الطباعة.',
    en: 'The printer’s latest reading is not about this print.',
    ckb: 'دوایین خوێندنەوەی چاپکەرەکە پەیوەندی بەم چاپەوە نییە.',
  },
  progressLabel: { ar: 'تقدّم الطباعة كما تذكره الطابعة', en: 'Print progress, as the printer reports it', ckb: 'پێشکەوتنی چاپ، وەک چاپکەرەکە دەیڵێت' },
  remaining: { ar: 'المتبقي كما تذكره الطابعة', en: 'Remaining, as the printer reports', ckb: 'ماوە، وەک چاپکەرەکە دەیڵێت' },
  layer: { ar: 'الطبقة', en: 'Layer', ckb: 'چین' },
  nozzleTemp: { ar: 'حرارة الفوهة', en: 'Nozzle', ckb: 'گەرمیی نۆزڵ' },
  bedTemp: { ar: 'حرارة السرير', en: 'Bed', ckb: 'گەرمیی سەکۆ' },
  degrees: { ar: '{n}°م', en: '{n}°C', ckb: '{n} پلەی سەدی' },
  reportedAt: { ar: 'آخر قراءة {when}', en: 'Last reading {when}', ckb: 'دوایین خوێندنەوە {when}' },
  requests: { ar: 'اطلب من الورشة', en: 'Ask the workshop', ckb: 'داوا لە کارگە بکە' },
  requestsNote: {
    ar: 'تُسجَّل طلباتك لفني الورشة ولا تُنفَّذ تلقائيًا.',
    en: 'Your requests are recorded for a workshop operator; nothing is carried out automatically.',
    ckb: 'داواکانت بۆ کارمەندێکی کارگە تۆمار دەکرێن؛ هیچ شتێک خۆکارانە جێبەجێ ناکرێت.',
  },
  askPause: { ar: 'اطلب إيقافًا مؤقتًا', en: 'Ask to pause', ckb: 'داوای ڕاگرتنی کاتی بکە' },
  askStop: { ar: 'اطلب إيقاف الطباعة', en: 'Ask to stop', ckb: 'داوای وەستاندن بکە' },
  sendNote: { ar: 'أرسل ملاحظة', en: 'Send a note', ckb: 'تێبینییەک بنێرە' },
  message: { ar: 'رسالتك', en: 'Your message', ckb: 'نامەکەت' },
  recorded: { ar: 'سُجّل طلبك للورشة', en: 'Your request was recorded for the workshop', ckb: 'داواکەت بۆ کارگە تۆمار کرا' },
  reprintAsk: {
    ar: 'يمكنك أن تطلب إعادة الطباعة في ملاحظة؛ تقرر الورشة بحسب سبب التعثر.',
    en: 'You can ask for a reprint in a note; the workshop decides by the cause of the failure.',
    ckb: 'دەتوانیت لە تێبینییەکدا داوای چاپکردنەوە بکەیت؛ کارگە بەپێی هۆکاری شکستەکە بڕیار دەدات.',
  },
  reserved: { ar: 'المحجوز لهذه الطباعة', en: 'Reserved for this print', ckb: 'گیراو بۆ ئەم چاپە' },
  held: { ar: 'محجوز', en: 'Reserved', ckb: 'گیراو' },
  used: { ar: 'مستهلك', en: 'Used', ckb: 'بەکارهاتوو' },
  returned: { ar: 'مُعاد', en: 'Returned', ckb: 'گەڕاوە' },
  heldNow: { ar: 'محجوز الآن', en: 'Held now', ckb: 'ئێستا گیراوە' },
  settled: { ar: 'سُوّي', en: 'Settled', ckb: 'یەکلاکرایەوە' },
  released: { ar: 'أُعيد', en: 'Released', ckb: 'ئازادکرا' },
  nothingReserved: { ar: 'لا شيء محجوز لهذه الطباعة.', en: 'Nothing is reserved for this print.', ckb: 'هیچ شتێک بۆ ئەم چاپە نەگیراوە.' },
  result: { ar: 'النتيجة', en: 'Result', ckb: 'ئەنجام' },
  printedTime: { ar: 'زمن الطباعة الفعلي', en: 'Actual print time', ckb: 'کاتی ڕاستەقینەی چاپ' },
  billedTime: { ar: 'الساعات المحتسبة', en: 'Hours charged', ckb: 'کاتژمێری بڕدراو' },
  failure: { ar: 'ما الذي حدث', en: 'What went wrong', ckb: 'چی ڕوویدا' },
  reasonLabel: { ar: 'السبب', en: 'Reason', ckb: 'هۆکار' },
  responsible: { ar: 'المسؤول', en: 'Responsible', ckb: 'بەرپرسیار' },
  failureReported: {
    ar: 'تراجع الورشة التعثر، ولم يُحتسب شيء بعد.',
    en: 'The workshop is reviewing the failure; nothing has been charged yet.',
    ckb: 'کارگە شکستەکە دەپشکنێت؛ هێشتا هیچ شتێک نەبڕدراوە.',
  },
  failureResolved: { ar: 'حُسم التعثر: {policy}.', en: 'The failure was resolved: {policy}.', ckb: 'شکستەکە یەکلاکرایەوە: {policy}.' },
  reprint: { ar: 'افتح الطباعة البديلة', en: 'Open the reprint', ckb: 'چاپکردنەوەکە بکەرەوە' },
  reprintOf: { ar: 'هذه إعادة طباعة لطباعة سابقة.', en: 'This is a reprint of an earlier print.', ckb: 'ئەمە چاپکردنەوەی چاپێکی پێشووە.' },
  openOriginal: { ar: 'افتح الطباعة الأصلية', en: 'Open the original print', ckb: 'چاپە ڕەسەنەکە بکەرەوە' },
  settings: { ar: 'إعدادات هذه الطباعة', en: 'This print’s settings', ckb: 'ڕێکخستنەکانی ئەم چاپە' },
  timeline: { ar: 'السجل', en: 'Timeline', ckb: 'مێژوو' },
  by: { ar: 'بواسطة {actor}', en: 'by {actor}', ckb: 'لەلایەن {actor}' },
} satisfies Record<string, Tri>;

/** Who did it (an event's `actor_type`). */
export const actorWords = {
  customer: { ar: 'أنت', en: 'You', ckb: 'تۆ' },
  operator: { ar: 'فني الورشة', en: 'Workshop operator', ckb: 'کارمەندی کارگە' },
  admin: { ar: 'الإدارة', en: 'Administration', ckb: 'بەڕێوەبەرایەتی' },
  agent: { ar: 'برنامج الورشة', en: 'Workshop agent', ckb: 'بریکاری کارگە' },
  system: { ar: 'النظام', en: 'System', ckb: 'سیستەم' },
} satisfies Record<string, Tri>;

/** Who the workshop found responsible for a failure, and how it was settled. */
export const failureWords = {
  workshop: { ar: 'الورشة', en: 'The workshop', ckb: 'کارگە' },
  customer: { ar: 'أنت', en: 'You', ckb: 'تۆ' },
  model: { ar: 'النموذج نفسه', en: 'The model itself', ckb: 'خودی مۆدێلەکە' },
  undetermined: { ar: 'لم يُحدَّد بعد', en: 'Not determined yet', ckb: 'هێشتا دیاری نەکراوە' },
  no_charge: { ar: 'دون أي احتساب عليك', en: 'nothing charged to you', ckb: 'هیچ شتێک لە تۆ نەبڕدرا' },
  charge_printed: { ar: 'احتُسب ما طُبع فقط', en: 'only what printed was charged', ckb: 'تەنها ئەوەی چاپکرا بڕدرا' },
  manual_review: { ar: 'بمراجعة يدوية', en: 'by manual review', ckb: 'بە پێداچوونەوەی دەستی' },
} satisfies Record<string, Tri>;

/** Why a print failed (`pc_print_failures.reason_code`, the operator's short code). */
export const failureReason = {
  adhesion: { ar: 'انفصل النموذج عن سطح الطباعة', en: 'The print came loose from the bed', ckb: 'مۆدێلەکە لە ڕووی چاپ جیابووەوە' },
  spaghetti: { ar: 'تحوّلت الطباعة إلى خيوط متشابكة', en: 'The print turned into tangled strands', ckb: 'چاپەکە بوو بە داوی تێکئاڵاو' },
  nozzle_clog: { ar: 'انسدّت فوهة الطابعة', en: 'The nozzle clogged', ckb: 'نۆزڵی چاپکەرەکە گیرا' },
  layer_shift: { ar: 'انزاحت الطبقات عن مكانها', en: 'The layers shifted', ckb: 'چینەکان لە شوێنی خۆیان لایاندا' },
  warping: { ar: 'تقوّس النموذج', en: 'The model warped', ckb: 'مۆدێلەکە چەمایەوە' },
  filament_runout: { ar: 'نفد الخيط أثناء الطباعة', en: 'The filament ran out mid-print', ckb: 'فیلامێنت لە ناوەڕاستی چاپدا تەواو بوو' },
  filament_tangle: { ar: 'تشابك الخيط', en: 'The filament tangled', ckb: 'فیلامێنتەکە تێکئاڵا' },
  power_loss: { ar: 'انقطعت الكهرباء', en: 'The power went out', ckb: 'کارەبا بڕا' },
  printer_error: { ar: 'عطل في الطابعة', en: 'A printer fault', ckb: 'تێکچوونێک لە چاپکەرەکەدا' },
  model_issue: { ar: 'مشكلة في النموذج نفسه', en: 'A problem in the model itself', ckb: 'کێشەیەک لە خودی مۆدێلەکەدا' },
  other: { ar: 'سبب آخر ({code})', en: 'Another cause ({code})', ckb: 'هۆکارێکی تر ({code})' },
} satisfies Record<string, Tri>;

/** The job's events (`pc_print_job_events.event`), as a timeline reads them. */
export const eventWords = {
  created: { ar: 'أُنشئت', en: 'Created', ckb: 'دروستکرا' },
  created_as_reprint: { ar: 'أُنشئت كإعادة طباعة', en: 'Created as a reprint', ckb: 'وەک چاپکردنەوە دروستکرا' },
  files_ready: { ar: 'جهزت الملفات', en: 'Files ready', ckb: 'فایلەکان ئامادە بوون' },
  analysis_requested: { ar: 'طُلب التقدير', en: 'Estimate requested', ckb: 'داوای خەمڵاندن کرا' },
  estimate_recorded: { ar: 'وصل التقدير', en: 'Estimate received', ckb: 'خەمڵاندن گەیشت' },
  estimate_incompatible: { ar: 'رأى برنامج التقطيع أنها غير متوافقة', en: 'The slicer found it incompatible', ckb: 'بەرنامەی بڕین بە نەگونجاوی زانی' },
  analysis_failed: { ar: 'تعذّر التقدير', en: 'The estimate failed', ckb: 'خەمڵاندن سەرکەوتوو نەبوو' },
  reviewed: { ar: 'رُوجع التقدير', en: 'Estimate reviewed', ckb: 'پێداچوونەوە بە خەمڵاندندا کرا' },
  review_renewed: { ar: 'جُدّدت المراجعة', en: 'Review renewed', ckb: 'پێداچوونەوە نوێکرایەوە' },
  confirmed: { ar: 'أُكّدت وحُجزت الموارد', en: 'Confirmed and reserved', ckb: 'پشتڕاستکرایەوە و گیرا' },
  queued_without_approval: { ar: 'دخلت قائمة الانتظار', en: 'Joined the queue', ckb: 'چووە ڕیزەوە' },
  approved: { ar: 'وافقت الورشة', en: 'Approved by the workshop', ckb: 'کارگە ڕەزامەندی دا' },
  assigned: { ar: 'أُسندت إلى آلة', en: 'Assigned to a machine', ckb: 'درایە ئامێرێک' },
  unassigned: { ar: 'أُعيدت إلى قائمة الانتظار', en: 'Returned to the queue', ckb: 'گەڕێندرایەوە ڕیز' },
  started: { ar: 'بدأت الطباعة', en: 'Printing started', ckb: 'چاپ دەستی پێکرد' },
  paused: { ar: 'أُوقفت مؤقتًا', en: 'Paused', ckb: 'ڕاگیرا' },
  resumed: { ar: 'استؤنفت', en: 'Resumed', ckb: 'دەستی پێکردەوە' },
  completion_reported: { ar: 'أبلغت الطابعة بالانتهاء', en: 'The printer reported completion', ckb: 'چاپکەرەکە ڕاپۆرتی تەواوبوونی دا' },
  completed: { ar: 'اكتملت', en: 'Completed', ckb: 'تەواو بوو' },
  failed: { ar: 'تعذّرت', en: 'Failed', ckb: 'سەرکەوتوو نەبوو' },
  failure_resolved: { ar: 'حُسم التعثر', en: 'Failure resolved', ckb: 'شکست یەکلاکرایەوە' },
  reprint_created: { ar: 'أُنشئت إعادة طباعة', en: 'Reprint created', ckb: 'چاپکردنەوە دروستکرا' },
  cancelled: { ar: 'أُلغيت', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
  edited: { ar: 'عُدّلت الإعدادات', en: 'Settings changed', ckb: 'ڕێکخستنەکان گۆڕدران' },
  rescheduled: { ar: 'تغيّر وقت البدء', en: 'Start time changed', ckb: 'کاتی دەستپێک گۆڕدرا' },
  priority_changed: { ar: 'تغيّرت الأولوية', en: 'Priority changed', ckb: 'پێشینەیی گۆڕدرا' },
  customer_request: { ar: 'أرسلتَ طلبًا', en: 'You sent a request', ckb: 'داواکارییەکت نارد' },
  auto_confirm_failed: { ar: 'تعذّر التأكيد التلقائي', en: 'Automatic confirmation failed', ckb: 'پشتڕاستکردنەوەی خۆکار سەرکەوتوو نەبوو' },
  request_pause: { ar: 'طلبتَ إيقافًا مؤقتًا', en: 'You asked to pause', ckb: 'داوای ڕاگرتنی کاتیت کرد' },
  request_cancel: { ar: 'طلبتَ إيقاف الطباعة', en: 'You asked to stop', ckb: 'داوای وەستاندنت کرد' },
  request_note: { ar: 'أرسلتَ ملاحظة', en: 'You sent a note', ckb: 'تێبینییەکت نارد' },
  other: { ar: 'حدث: {event}', en: 'Event: {event}', ckb: 'ڕووداو: {event}' },
} satisfies Record<string, Tri>;
