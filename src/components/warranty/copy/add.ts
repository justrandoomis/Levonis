import type { Language } from '../../../translations';

/**
 * «إضافة طابعة»: by serial or receipt number, from the account's delivered
 * orders, or by scanning. The 404 of the serial door stays ONE fixed sentence
 * in every language — the server does not say why, and neither does this.
 */
export interface AddStrings {
  addTitle: string;
  addIntro: string;
  tabSerial: string;
  tabOrders: string;
  tabScan: string;
  serialLabel: string;
  serialPlaceholder: string;
  link: string;
  linking: string;
  linkedOk: string;
  alreadyLinked: string;
  registerHint: string;
  notFound: string;
  notFoundNext: string;
  rateLimited: string;
  eligibleIntro: string;
  eligibleEmpty: string;
  eligibleEmptyDesc: string;
  linkedElsewhere: string;
  linkRow: string;
  scanIntro: string;
  scanCta: string;
  scanTitle: string;
  /** Serial inventory (0139): scanning the box label's Product SN barcode. */
  scanBarcode: string;
  inventoryHint: string;
  requestReview: string;
  reviewHint: string;
  reviewSubject: (serial: string) => string;
}

const ar: AddStrings = {
  addTitle: 'إضافة طابعة',
  addIntro: 'بالرقم التسلسلي، من طلباتك المُسلَّمة، أو بمسح الرمز.',
  tabSerial: 'الرقم التسلسلي',
  tabOrders: 'من طلباتي',
  tabScan: 'مسح',
  serialLabel: 'الرقم التسلسلي أو رقم الإيصال',
  serialPlaceholder: 'كما هو مطبوع على ملصق الجهاز أو الإيصال (WR-…)',
  link: 'ربط هذه الطابعة',
  linking: 'جارٍ التحقق…',
  linkedOk: 'تم ربط الطابعة بحسابك.',
  alreadyLinked: 'هذه الطابعة مرتبطة بحسابك مسبقًا.',
  registerHint: 'الربط لا يغيّر تواريخ الضمان إطلاقًا.',
  notFound: 'غير موجود أو مستخدم مسبقًا.',
  notFoundNext: 'تحقق من الرقم، أو جرّب «من طلباتي»، أو تواصل مع الدعم.',
  rateLimited: 'محاولات كثيرة — حاول مجددًا بعد بضع دقائق.',
  eligibleIntro: 'الأجهزة المُسلَّمة في طلباتك التي لم تُربط بحسابك بعد.',
  eligibleEmpty: 'لا توجد أجهزة غير مرتبطة في طلباتك المُسلَّمة.',
  eligibleEmptyDesc: 'كل طابعاتك المُسلَّمة مرتبطة بحسابك، أو لم يُسلَّم أي طلب بعد.',
  linkedElsewhere: 'مرتبط بحساب آخر — يجب أن يفكّ ذلك الحساب الارتباط أولًا، أو تواصل مع الدعم.',
  linkRow: 'ربط',
  scanIntro: 'امسح رمز QR على إيصال الضمان أو الباركود على ملصق الجهاز.',
  scanCta: 'افتح الكاميرا',
  scanTitle: 'مسح الرمز',
  scanBarcode: 'امسح الباركود',
  inventoryHint: 'اشتريت طابعتك من Levonis؟ امسح باركود «Product SN» على ملصق العلبة أو اكتب الرقم — تُربط تلقائيًا بطابعتك المُسلَّمة.',
  requestReview: 'اطلب مراجعة يدوية',
  reviewHint: 'الرقم صحيح والجهاز اشتريته من Levonis؟ أرسله لفريق الدعم ليتحقق منه ويربطه لك.',
  reviewSubject: (serial) => `مراجعة رقم تسلسلي: ${serial}`,
};

const en: AddStrings = {
  addTitle: 'Add a printer',
  addIntro: 'By serial number, from your delivered orders, or by scanning a code.',
  tabSerial: 'Serial number',
  tabOrders: 'From my orders',
  tabScan: 'Scan',
  serialLabel: 'Serial number or receipt number',
  serialPlaceholder: 'As printed on the device label or receipt (WR-…)',
  link: 'Link this printer',
  linking: 'Checking…',
  linkedOk: 'Printer linked to your account.',
  alreadyLinked: 'This printer is already linked to your account.',
  registerHint: 'Linking never changes any warranty date.',
  notFound: 'Not found or already in use.',
  notFoundNext: 'Check the number, try “From my orders”, or contact support.',
  rateLimited: 'Too many attempts — try again in a few minutes.',
  eligibleIntro: 'Delivered devices on your orders that are not linked to your account yet.',
  eligibleEmpty: 'No unlinked devices on your delivered orders.',
  eligibleEmptyDesc: 'Every delivered printer is already linked to your account, or no order has been delivered yet.',
  linkedElsewhere: 'Linked to another account — that account must unlink it first, or contact support.',
  linkRow: 'Link',
  scanIntro: 'Scan the QR code on the warranty receipt or the barcode on the device label.',
  scanCta: 'Open the camera',
  scanTitle: 'Scan a code',
  scanBarcode: 'Scan the barcode',
  inventoryHint: 'Bought your printer from Levonis? Scan the “Product SN” barcode on the box label or type the number — it links to your delivered printer automatically.',
  requestReview: 'Request a manual review',
  reviewHint: 'The number is right and you bought the device from Levonis? Send it to support to check and link it for you.',
  reviewSubject: (serial) => `Serial review: ${serial}`,
};

const ckb: AddStrings = {
  addTitle: 'زیادکردنی پرینتەر',
  addIntro: 'بە ژمارە زنجیرەیی، لە داواکارییە گەیەنراوەکانت، یان بە سکانکردنی کۆد.',
  tabSerial: 'ژمارە زنجیرەیی',
  tabOrders: 'لە داواکارییەکانم',
  tabScan: 'سکان',
  serialLabel: 'ژمارە زنجیرەیی یان ژمارەی پسووڵە',
  serialPlaceholder: 'وەک لەسەر لەیبڵی ئامێر یان پسووڵە نووسراوە (WR-…)',
  link: 'بەستنی ئەم پرینتەرە',
  linking: 'پشکنین…',
  linkedOk: 'پرینتەرەکە بە هەژمارەکەت بەسترا.',
  alreadyLinked: 'ئەم پرینتەرە پێشتر بە هەژمارەکەت بەستراوە.',
  registerHint: 'بەستن هەرگیز بەرواری گەرەنتی ناگۆڕێت.',
  notFound: 'نەدۆزرایەوە یان پێشتر بەکارهاتووە.',
  notFoundNext: 'ژمارەکە بپشکنە، «لە داواکارییەکانم» تاقی بکەرەوە، یان پەیوەندی بە پشتگیری بکە.',
  rateLimited: 'هەوڵی زۆر — دوای چەند خولەکێک دووبارە هەوڵ بدەوە.',
  eligibleIntro: 'ئامێرە گەیەنراوەکانی داواکارییەکانت کە هێشتا بە هەژمارەکەت نەبەستراون.',
  eligibleEmpty: 'هیچ ئامێرێکی نەبەستراو لە داواکارییە گەیەنراوەکانت نییە.',
  eligibleEmptyDesc: 'هەموو پرینتەرە گەیەنراوەکانت بە هەژمارەکەت بەستراون، یان هێشتا هیچ داواکارییەک نەگەیەنراوە.',
  linkedElsewhere: 'بە هەژمارێکی دیکە بەستراوە — پێویستە ئەو هەژمارە سەرەتا بەستنەکە لاببات، یان پەیوەندی بە پشتگیری بکە.',
  linkRow: 'بەستن',
  scanIntro: 'کۆدی QR ی سەر پسووڵەی گەرەنتی یان بارکۆدی سەر لەیبڵی ئامێر سکان بکە.',
  scanCta: 'کامێرا بکەرەوە',
  scanTitle: 'سکانکردنی کۆد',
  scanBarcode: 'سکانکردنی بارکۆد',
  inventoryHint: 'پرینتەرەکەت لە Levonis کڕیوە؟ بارکۆدی «Product SN» ی سەر لەیبڵی کارتۆنەکە سکان بکە یان ژمارەکە بنووسە — خۆکارانە بە پرینتەرە گەیەنراوەکەتەوە دەبەسترێت.',
  requestReview: 'داوای پێداچوونەوەی دەستی بکە',
  reviewHint: 'ژمارەکە ڕاستە و ئامێرەکەت لە Levonis کڕیوە؟ بینێرە بۆ تیمی پشتگیری تا بیپشکنن و بۆت ببەستن.',
  reviewSubject: (serial) => `پێداچوونەوەی ژمارەی زنجیرەیی: ${serial}`,
};

export const ADD_STRINGS: Record<Language, AddStrings> = { ar, en, ckb };
