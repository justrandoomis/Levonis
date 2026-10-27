/**
 * What Print Cloud is and how it really works — the landing a visitor (or the
 * whole public, while the service is closed) sees, and «How it works». The
 * flow as built (docs/PRINT_CLOUD.md §§3–8), with no figure in it: prices,
 * hours and grams are the server's and are never written into a sentence.
 */
import type { Tri } from '../types';

export const guide = {
  title: { ar: 'كيف تعمل Print Cloud', en: 'How Print Cloud works', ckb: 'Print Cloud چۆن کار دەکات' },
  intro: {
    ar: 'استأجر وقتًا على طابعات الورشة الحقيقية: تشتري الساعات والخيوط، وترفع نموذجك، ونطبعه لك.',
    en: "Rent time on the workshop's real 3D printers: you buy hours and filament, upload your model, and we print it for you.",
    ckb: 'کات لەسەر چاپکەرە ڕاستەقینەکانی کارگە بە کرێ بگرە: کاتژمێر و فیلامێنت دەکڕیت، مۆدێلەکەت بار دەکەیت، و ئێمە بۆت چاپی دەکەین.',
  },
  stepsLabel: { ar: 'الخطوات', en: 'The steps', ckb: 'هەنگاوەکان' },
  hoursTitle: { ar: 'ساعات لكل فئة طابعة', en: 'Hours for each printer class', ckb: 'کاتژمێر بۆ هەر پۆلێکی چاپکەر' },
  hoursBody: {
    ar: 'تشتري ساعات الطباعة في باقات لفئة طابعة محددة. ساعات فئة ما تشغّل طابعات تلك الفئة فقط.',
    en: 'You buy printing hours in packages for one printer class. The hours of a class run only the printers of that class.',
    ckb: 'کاتژمێری چاپ لە پاکێجدا بۆ پۆلێکی دیاریکراوی چاپکەر دەکڕیت. کاتژمێرەکانی هەر پۆلێک تەنها چاپکەرەکانی هەمان پۆل کار پێدەکەن.',
  },
  filamentTitle: { ar: 'خيوط بالغرام في مخزونك', en: 'Filament by the gram, in your inventory', ckb: 'فیلامێنت بە گرام، لە کۆگاکەتدا' },
  filamentBody: {
    ar: 'تشتري الخيوط والملحقات بالغرام أو بالقطعة، وتبقى ملكك في مخزون الورشة حتى تُستعمل.',
    en: "You buy filament and accessories by the gram or the piece, and they stay yours in the workshop's inventory until they are used.",
    ckb: 'فیلامێنت و پاشکۆکان بە گرام یان بە دانە دەکڕیت، و لە کۆگای کارگەدا هی خۆت دەمێننەوە تا بەکاردێن.',
  },
  uploadTitle: { ar: 'ارفع نموذجك أو استورد رابطًا', en: 'Upload your model or import a link', ckb: 'مۆدێلەکەت بار بکە یان بەستەرێک هاوردە بکە' },
  uploadBody: {
    ar: 'ملفات STL و3MF وOBJ. إن لم يكن تنزيل الملف من الرابط مسموحًا، يُحفظ الرابط وحده وترفع الملف بنفسك.',
    en: 'STL, 3MF and OBJ files. When downloading the file from a link is not permitted, only the link is saved and you upload the file yourself.',
    ckb: 'فایلی STL و 3MF و OBJ. ئەگەر داگرتنی فایلەکە لە بەستەرەکەوە ڕێگەپێدراو نەبێت، تەنها بەستەرەکە پاشەکەوت دەکرێت و فایلەکە خۆت بار دەکەیت.',
  },
  estimateTitle: { ar: 'تقدير الوقت والغرامات', en: 'An estimate of time and grams', ckb: 'خەمڵاندنی کات و گرام' },
  estimateBody: {
    ar: 'يقدّر برنامج التقطيع في الورشة وقت الطباعة وغرامات كل مادة. إن لم يتوفر بعد، تنتظر المهمة التقدير ولا يُخمَّن أي رقم.',
    en: "The workshop's slicer estimates the print time and the grams of each material. When it is not available yet, the job waits for the estimate — no figure is guessed.",
    ckb: 'بەرنامەی بڕینی کارگە کاتی چاپ و گرامی هەر کەرەستەیەک دەخەمڵێنێت. ئەگەر هێشتا بەردەست نەبێت، کارەکە چاوەڕێی خەمڵاندن دەکات — هیچ ژمارەیەک بە گومان دانانرێت.',
  },
  confirmTitle: { ar: 'التأكيد يحجز الساعات والغرامات', en: 'Confirming reserves the hours and grams', ckb: 'پشتڕاستکردنەوە کاتژمێر و گرامەکان دەگرێت' },
  confirmBody: {
    ar: 'عند التأكيد تُحجز الساعات والمواد المقدّرة وتدخل المهمة قائمة الانتظار. بعد الطباعة يُخصم ما استُهلك فعلًا ويعود الباقي إلى رصيدك.',
    en: 'Confirming reserves the estimated hours and materials, and the job joins the queue. After printing, what was actually used is charged and the rest returns to your balance.',
    ckb: 'بە پشتڕاستکردنەوە کاتژمێر و کەرەستە خەمڵێنراوەکان دەگیرێن و کارەکە دەچێتە ڕیزەوە. دوای چاپ، تەنها ئەوەی بەڕاستی بەکارهاتووە دەبڕدرێت و ئەوەی تر دەگەڕێتەوە سەر باڵانسەکەت.',
  },
  queueTitle: { ar: 'قائمة الانتظار والطابعة', en: 'The queue and the printer', ckb: 'ڕیز و چاپکەر' },
  queueBody: {
    ar: 'تُسند المهمة إلى طابعة جاهزة ومتوافقة من فئتها، وتتابعها من هنا: البيانات المباشرة تظهر مباشرة، والقديمة تُوسم بأنها قديمة.',
    en: 'The job goes to a ready, compatible printer of its class, and you follow it here: live data shows as live, and old data is marked as old.',
    ckb: 'کارەکە دەدرێتە چاپکەرێکی ئامادە و گونجاوی پۆلەکەی، و لێرەوە بەدوایدا دەچیت: زانیاریی ڕاستەوخۆ وەک ڕاستەوخۆ دەردەکەوێت، و زانیاریی کۆن وەک کۆن نیشان دەدرێت.',
  },
  fulfilTitle: { ar: 'الاستلام أو التوصيل أو إعادة البيع', en: 'Pickup, delivery or buyback', ckb: 'وەرگرتن، گەیاندن یان فرۆشتنەوە' },
  fulfilBody: {
    ar: 'تستلم مطبوعاتك وموادك من الورشة أو تُوصَل إليك، ويمكنك بيع الخيوط غير المستعملة للورشة حيث تسمح فئتها بذلك.',
    en: 'Collect your prints and materials at the workshop or have them delivered, and sell unused filament back to the workshop where its category allows it.',
    ckb: 'چاپ و کەرەستەکانت لە کارگە وەربگرە یان بۆت دەگەیەنرێن، و دەتوانیت فیلامێنتی بەکارنەهاتوو بە کارگە بفرۆشیتەوە لەو شوێنانەی پۆلەکەی ڕێگە دەدات.',
  },
  readAll: { ar: 'اقرأ كيف تعمل الخدمة', en: 'Read how it works', ckb: 'بخوێنەوە چۆن کار دەکات' },
  open: { ar: 'مفتوحة', en: 'Open', ckb: 'کراوەیە' },
  signInToStart: { ar: 'سجّل الدخول لتبدأ', en: 'Sign in to start', ckb: 'بچۆ ژوورەوە بۆ دەستپێکردن' },
  signInHint: {
    ar: 'تستخدم Print Cloud حسابك نفسه في Levonis.',
    en: 'Print Cloud uses your Levonis account.',
    ckb: 'Print Cloud هەمان هەژمارەکەت لە Levonis بەکاردەهێنێت.',
  },
  adminHint: {
    ar: 'مدير المنصة؟ سجّل الدخول لمعاينة الخدمة قبل افتتاحها.',
    en: 'Platform admin? Sign in to preview the service before it opens.',
    ckb: 'بەڕێوەبەری پلاتفۆرمی؟ بچۆ ژوورەوە بۆ پێشبینینی خزمەتگوزارییەکە پێش کردنەوەی.',
  },
  visitLevonis: { ar: 'زيارة متجر Levonis', en: 'Visit the Levonis store', ckb: 'سەردانی فرۆشگای Levonis بکە' },
} satisfies Record<string, Tri>;
