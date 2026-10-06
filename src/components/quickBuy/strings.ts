/**
 * EVERY QUICK BUY SENTENCE, in Arabic, English and Sorani Kurdish — the
 * page-local STRINGS pattern, one table for the whole feature (the product
 * page's toasts, the activation sheet and its address and printer faces, the
 * orders card, the settings section and every refusal the server sends,
 * docs/GIFTS_QUICK_BUY.md §3.6).
 *
 * Imported only by Quick Buy's lazy chunks. The few words the app chrome
 * needs before any of them loads — the purchase bar's two capsules — live
 * in ./chromeStrings.ts, and the navigation chip's in ./navStrings.ts, so the
 * product's opening and the first paint do not carry this table.
 *
 * The Sorani is written by hand and reuses the shop's own wording wherever it
 * already exists: «جزدانی Levo», «پڕکردنەوەی جزدان», «گەیاندنی ئاسایی
 * بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo» (the plan of record's own
 * label), «مەرجەکانی بەکارهێنان», «سیاسەتی تایبەتمەندی», «هێشتنەوەی داواکاری».
 * No Arabic stands in for it anywhere in this file.
 *
 * «30» in three sentences is the window the plan of record fixes (D10); the
 * live clock itself always comes from the server's `expires_at`.
 */
import { ApiError } from '../../lib/api';
import { isQuickBuyRefusal, refusalNumber, type QuickBuyRefusalCode } from '../../lib/quickBuy';
import type { QuickBuyLang } from './chromeStrings';

export interface QuickBuyStrings {
  // the product page
  added: string;
  remaining: (time: string) => string;
  viewOrder: string;
  retry: string;
  topUp: string;
  activateNow: string;
  balance: (available: string, required: string) => string;
  onlyLeft: (n: number) => string;
  failed: string;
  network: string;
  activated: string;
  activatedHint: string;
  reconsented: string;
  // the activation sheet
  sheetTitle: string;
  sheetReconsentTitle: string;
  sheetIntro: string;
  sheetReconsentIntro: string;
  close: string;
  stepConsents: string;
  stepConsentsHint: string;
  consentWallet: string;
  consentWalletHelp: string;
  consentTerms: string;
  consentPrivacy: string;
  consentPolicy: string;
  version: (n: number) => string;
  read: string;
  readAria: (name: string) => string;
  policyTerms: string;
  policyPrivacy: string;
  policyQuickBuy: string;
  stepAddress: string;
  stepAddressHint: string;
  addressesLoading: string;
  noAddresses: string;
  addAddress: string;
  defaultTag: string;
  activate: string;
  saveConsent: string;
  activating: string;
  consentsLeft: (n: number) => string;
  chooseAddress: string;
  readyToActivate: string;
  loadFailed: string;
  policyChanged: string;
  // the sheet's address face: the saved address was deleted
  sheetAddressTitle: string;
  sheetAddressIntro: string;
  saveAddress: string;
  addressSaved: string;
  // the sheet's printer face: the standard-delivery warning, once per session
  printerTitle: string;
  printerIntro: string;
  /** The warning in the reader's language for `PRINTER_WARNING_TRANSLATED_VERSION` ('' in Arabic: the server's own text is it). */
  printerTranslation: string;
  /** Introduces the server's Arabic text under a translation ('' in Arabic). */
  printerOriginal: string;
  printerAccept: string;
  printerAdd: string;
  printerHint: string;
  // the orders card
  cardTitle: string;
  collecting: string;
  sending: string;
  regionLabel: string;
  timeLeft: string;
  timerAria: (time: string) => string;
  autoSend: string;
  itemsHeading: (n: number) => string;
  each: (price: string) => string;
  qtyOf: (name: string) => string;
  remove: string;
  removeAria: (name: string) => string;
  openProduct: string;
  subtotal: string;
  discount: string;
  delivery: string;
  freeDelivery: string;
  total: string;
  held: string;
  deliverTo: string;
  deliveryMethod: string;
  standard: string;
  locked: string;
  /** The one line a session the server could not submit leaves on «طلباتي». */
  failedNotice: string;
  refresh: string;
  submittedTitle: string;
  submittedBody: (id: string) => string;
  cancelSession: string;
  cancelTitle: string;
  cancelConsequence: string;
  cancelConfirm: string;
  keepOrder: string;
  removeLastTitle: string;
  removeLastConsequence: string;
  removeConfirm: string;
  cancelled: string;
  removed: string;
  expiredEdit: string;
  // the settings section
  settingsTitle: string;
  switchLabel: string;
  switchOn: string;
  switchOff: string;
  addressRow: string;
  noAddressYet: string;
  change: string;
  manageAddresses: string;
  addressMissing: string;
  consentsRow: string;
  acceptedOn: (date: string) => string;
  notAccepted: string;
  currentVersion: (n: number) => string;
  reconsentNeeded: string;
  reviewAndAccept: string;
  saved: string;
  saveFailed: string;
  howItWorks: string;
  loading: string;
}

/**
 * The printer warning's version the translations below were written against
 * (packages/shipping/src/printerDeliveryPolicy.ts). Any other version shows
 * the server's Arabic text alone — the one the Checkout shows — rather than
 * a translation of a text that has changed.
 */
export const PRINTER_WARNING_TRANSLATED_VERSION = 1;

export const QUICK_BUY_STRINGS: Record<QuickBuyLang, QuickBuyStrings> = {
  ar: {
    added: 'تمت الإضافة إلى طلب الشراء السريع\u00a0⚡',
    remaining: (time) => `الوقت المتبقي\u00a0${time}`,
    viewOrder: 'عرض الطلب',
    retry: 'إعادة المحاولة',
    topUp: 'شحن المحفظة',
    activateNow: 'تفعيل الآن',
    balance: (available, required) => `المتاح ${available} · المطلوب ${required}`,
    onlyLeft: (n) => `المتوفر الآن ${n} فقط.`,
    failed: 'تعذّر إتمام الشراء السريع. حاول مرة أخرى.',
    network: 'انقطع الاتصال قبل أن نتأكد من الإضافة. أعد المحاولة — لن يُضاف المنتج مرتين.',
    activated: 'تم تفعيل الشراء السريع\u00a0⚡',
    activatedHint: 'اضغط «شراء سريع» لإتمام الشراء.',
    reconsented: 'تم حفظ موافقتك.',

    sheetTitle: 'تفعيل الشراء السريع',
    sheetReconsentTitle: 'مراجعة موافقات الشراء السريع',
    sheetIntro: 'اشترِ بلمسة واحدة: يُحجز ثمن ما تضيفه من محفظة Levo، وتُجمع إضافاتك خلال 30 دقيقة في طلب واحد يُرسل تلقائيًا.',
    sheetReconsentIntro: 'تغيّرت بعض السياسات منذ موافقتك الأخيرة. راجعها ووافق عليها لتتابع الشراء السريع.',
    close: 'إغلاق',
    stepConsents: 'الموافقات',
    stepConsentsHint: 'اقرأ كل بند ووافق عليه — لا شيء مُحدَّد مسبقًا.',
    consentWallet: 'أوافق على حجز المبلغ وخصمه تلقائيًا من محفظة Levo',
    consentWalletHelp: 'يُحجز ثمن كل إضافة فور الضغط، ويُخصم عند إرسال الطلب، ويعود ما لا يُستخدم إلى رصيدك.',
    consentTerms: 'أوافق على شروط الاستخدام',
    consentPrivacy: 'أوافق على سياسة الخصوصية',
    consentPolicy: 'أوافق على سياسة الشراء السريع',
    version: (n) => `الإصدار ${n}`,
    read: 'قراءة',
    readAria: (name) => `قراءة ${name} في نافذة جديدة`,
    policyTerms: 'شروط الاستخدام',
    policyPrivacy: 'سياسة الخصوصية',
    policyQuickBuy: 'سياسة الشراء السريع',
    stepAddress: 'عنوان التوصيل الافتراضي',
    stepAddressHint: 'تصل طلبات الشراء السريع إلى هذا العنوان بالتوصيل العادي.',
    addressesLoading: 'جارٍ تحميل عناوينك…',
    noAddresses: 'لا توجد عناوين محفوظة بعد — أضف عنوانًا للمتابعة.',
    addAddress: 'إضافة عنوان جديد',
    defaultTag: 'الافتراضي',
    activate: 'تفعيل الشراء السريع',
    saveConsent: 'حفظ الموافقة',
    activating: 'جارٍ التفعيل…',
    consentsLeft: (n) => (n === 1 ? 'بقيت موافقة واحدة' : n === 2 ? 'بقيت موافقتان' : `بقيت ${n} موافقات`),
    chooseAddress: 'اختر عنوانًا للتوصيل',
    readyToActivate: 'كل شيء جاهز.',
    loadFailed: 'تعذّر تحميل بيانات الشراء السريع.',
    policyChanged: 'تغيّرت إحدى السياسات للتو. راجعها ووافق عليها من جديد.',

    sheetAddressTitle: 'عنوان جديد للشراء السريع',
    sheetAddressIntro: 'حُذف العنوان المحفوظ للشراء السريع. اختر عنوانًا آخر أو أضف واحدًا — يُستعمل من طلبك القادم.',
    saveAddress: 'حفظ العنوان',
    addressSaved: 'تم حفظ عنوان الشراء السريع.',
    printerTitle: 'تحذير التوصيل العادي للطابعات',
    printerIntro: 'الشراء السريع يُرسَل بالتوصيل العادي فقط. اقرأ التحذير ووافق عليه لإضافة الطابعة، أو استعمل السلة لاختيار طريقة توصيل أخرى.',
    printerTranslation: '',
    printerOriginal: '',
    printerAccept: 'قرأت تحذير النقل وأوافق على اختيار التوصيل العادي لهذا الطلب.',
    printerAdd: 'موافقة وإضافة',
    printerHint: 'لن يُضاف المنتج قبل موافقتك.',

    cardTitle: 'شراء سريع',
    collecting: 'قيد التجميع',
    sending: 'قيد الإرسال',
    regionLabel: 'طلب الشراء السريع',
    timeLeft: 'الوقت المتبقي',
    timerAria: (time) => `الوقت المتبقي ${time}`,
    autoSend: 'يُرسل الطلب تلقائيًا عند انتهاء الوقت. أضف منتجات أخرى بزر «شراء سريع» في صفحاتها.',
    itemsHeading: (n) => `المنتجات (${n})`,
    each: (price) => `${price} للقطعة`,
    qtyOf: (name) => `الكمية — ${name}`,
    remove: 'حذف',
    removeAria: (name) => `حذف ${name} من الطلب`,
    openProduct: 'عرض المنتج',
    subtotal: 'المنتجات',
    discount: 'الخصم',
    delivery: 'التوصيل العادي',
    freeDelivery: 'توصيل عادي مجاني — للدفع الكامل من محفظة Levo',
    total: 'الإجمالي',
    held: 'المحجوز من محفظة Levo',
    deliverTo: 'التوصيل إلى',
    deliveryMethod: 'طريقة التوصيل',
    standard: 'توصيل عادي',
    locked: 'انتهى وقت التجميع — يجري إرسال طلبك…',
    failedNotice: 'تعذّر إرسال طلب الشراء السريع تلقائيًا — المبلغ ما زال محجوزًا لك ويتابعه فريقنا.',
    refresh: 'تحديث',
    submittedTitle: 'تم إرسال طلب الشراء السريع',
    submittedBody: (id) => `رقم الطلب ${id}`,
    cancelSession: 'إلغاء طلب الشراء السريع',
    cancelTitle: 'إلغاء طلب الشراء السريع؟',
    cancelConsequence: 'تُزال كل المنتجات ويعود المبلغ المحجوز إلى محفظة Levo.',
    cancelConfirm: 'إلغاء الطلب',
    keepOrder: 'الإبقاء على الطلب',
    removeLastTitle: 'حذف آخر منتج؟',
    removeLastConsequence: 'حذف آخر منتج يلغي طلب الشراء السريع ويعيد المبلغ المحجوز إلى محفظتك.',
    removeConfirm: 'حذف',
    cancelled: 'أُلغي طلب الشراء السريع وعاد المبلغ المحجوز إلى محفظتك.',
    removed: 'أُزيل المنتج من طلب الشراء السريع.',
    expiredEdit: 'انتهى وقت التعديل — يجري إرسال طلبك.',

    settingsTitle: 'الشراء السريع',
    switchLabel: 'الشراء السريع',
    switchOn: 'مفعّل — يظهر زر ⚡ بجانب «أضف إلى السلة» في صفحات المنتجات.',
    switchOff: 'متوقف — فعّله لتشتري بلمسة واحدة من محفظة Levo.',
    addressRow: 'عنوان الشراء السريع',
    noAddressYet: 'لم يُحدَّد عنوان بعد',
    change: 'تغيير',
    manageAddresses: 'إدارة العناوين',
    addressMissing: 'حُذف العنوان المحفوظ للشراء السريع. اختر عنوانًا جديدًا ليعمل من جديد.',
    consentsRow: 'الموافقات',
    acceptedOn: (date) => `وافقت في ${date}`,
    notAccepted: 'لم توافق بعد',
    currentVersion: (n) => `الإصدار الحالي ${n}`,
    reconsentNeeded: 'تم تحديث سياسات الشراء السريع. وافق عليها من جديد قبل الشراء التالي.',
    reviewAndAccept: 'مراجعة والموافقة',
    saved: 'تم الحفظ',
    saveFailed: 'تعذّر الحفظ. حاول مرة أخرى.',
    howItWorks: 'ما تضيفه بالشراء السريع خلال 30 دقيقة من أول منتج يُجمع في طلب واحد يُرسل تلقائيًا بالتوصيل العادي، ويُدفع بالكامل من محفظة Levo.',
    loading: 'جارٍ التحميل…',
  },
  en: {
    added: 'Added to your Quick Buy order\u00a0⚡',
    remaining: (time) => `Time left\u00a0${time}`,
    viewOrder: 'View order',
    retry: 'Try again',
    topUp: 'Top up wallet',
    activateNow: 'Activate now',
    balance: (available, required) => `Available ${available} · Needed ${required}`,
    onlyLeft: (n) => `Only ${n} available now.`,
    failed: 'Quick Buy could not be completed. Please try again.',
    network: 'The connection dropped before we could confirm. Try again — the item will not be added twice.',
    activated: 'Quick Buy is on\u00a0⚡',
    activatedHint: 'Tap “Quick Buy” to buy.',
    reconsented: 'Your consent was saved.',

    sheetTitle: 'Activate Quick Buy',
    sheetReconsentTitle: 'Review Quick Buy consents',
    sheetIntro: 'Buy in one tap: each add is held from your Levo Wallet, and everything you add within 30 minutes becomes one order that is sent automatically.',
    sheetReconsentIntro: 'Some policies changed since you last agreed. Review and accept them to keep using Quick Buy.',
    close: 'Close',
    stepConsents: 'Consents',
    stepConsentsHint: 'Read and accept each one — nothing is pre-ticked.',
    consentWallet: 'I agree to the amount being held and charged automatically from my Levo Wallet',
    consentWalletHelp: 'Each add is held the moment you tap, charged when the order is sent, and anything unused returns to your balance.',
    consentTerms: 'I accept the Terms of Use',
    consentPrivacy: 'I accept the Privacy Policy',
    consentPolicy: 'I accept the Quick Buy Policy',
    version: (n) => `Version ${n}`,
    read: 'Read',
    readAria: (name) => `Read the ${name} in a new tab`,
    policyTerms: 'Terms of Use',
    policyPrivacy: 'Privacy Policy',
    policyQuickBuy: 'Quick Buy Policy',
    stepAddress: 'Default delivery address',
    stepAddressHint: 'Quick Buy orders go to this address by standard delivery.',
    addressesLoading: 'Loading your addresses…',
    noAddresses: 'No saved addresses yet — add one to continue.',
    addAddress: 'Add a new address',
    defaultTag: 'Default',
    activate: 'Activate Quick Buy',
    saveConsent: 'Save consent',
    activating: 'Activating…',
    consentsLeft: (n) => (n === 1 ? '1 consent left' : `${n} consents left`),
    chooseAddress: 'Choose a delivery address',
    readyToActivate: 'All set.',
    loadFailed: 'Couldn’t load your Quick Buy details.',
    policyChanged: 'A policy changed just now. Review it and accept again.',

    sheetAddressTitle: 'A new Quick Buy address',
    sheetAddressIntro: 'Your saved Quick Buy address was deleted. Choose another one or add one — it applies from your next order.',
    saveAddress: 'Save address',
    addressSaved: 'Quick Buy address saved.',
    printerTitle: 'Printer standard-delivery warning',
    printerIntro: 'Quick Buy ships by standard delivery only. Read and accept the warning to add the printer, or use the cart to choose another delivery method.',
    printerTranslation:
      'Standard delivery can damage the order in transit, and we are not responsible for transport damage. If it is damaged in delivery, the order does not qualify for a free return.',
    printerOriginal: 'The original, in Arabic:',
    printerAccept: 'I have read the transport warning and agree to standard delivery for this order.',
    printerAdd: 'Accept and add',
    printerHint: 'Nothing is added until you accept.',

    cardTitle: 'Quick Buy',
    collecting: 'Collecting',
    sending: 'Sending',
    regionLabel: 'Quick Buy order',
    timeLeft: 'Time left',
    timerAria: (time) => `Time left ${time}`,
    autoSend: 'The order is sent automatically when time runs out. Add more with the “Quick Buy” button on any product page.',
    itemsHeading: (n) => `Items (${n})`,
    each: (price) => `${price} each`,
    qtyOf: (name) => `Quantity — ${name}`,
    remove: 'Remove',
    removeAria: (name) => `Remove ${name} from the order`,
    openProduct: 'View product',
    subtotal: 'Items',
    discount: 'Discount',
    delivery: 'Standard delivery',
    freeDelivery: 'Free standard delivery — paid in full from Levo Wallet',
    total: 'Total',
    held: 'Held from Levo Wallet',
    deliverTo: 'Deliver to',
    deliveryMethod: 'Delivery',
    standard: 'Standard delivery',
    locked: 'Time’s up — sending your order…',
    failedNotice: 'Your Quick Buy order couldn’t be sent automatically — the amount is still held for you, and our team is on it.',
    refresh: 'Refresh',
    submittedTitle: 'Quick Buy order sent',
    submittedBody: (id) => `Order ${id}`,
    cancelSession: 'Cancel Quick Buy order',
    cancelTitle: 'Cancel this Quick Buy order?',
    cancelConsequence: 'Every item is removed and the held amount returns to your Levo Wallet.',
    cancelConfirm: 'Cancel order',
    keepOrder: 'Keep order',
    removeLastTitle: 'Remove the last item?',
    removeLastConsequence: 'Removing the last item cancels the Quick Buy order and returns the held amount to your wallet.',
    removeConfirm: 'Remove',
    cancelled: 'Quick Buy order cancelled — the held amount is back in your wallet.',
    removed: 'Item removed from your Quick Buy order.',
    expiredEdit: 'Editing time is over — your order is being sent.',

    settingsTitle: 'Quick Buy',
    switchLabel: 'Quick Buy',
    switchOn: 'On — a ⚡ button appears beside “Add to cart” on product pages.',
    switchOff: 'Off — turn it on to buy in one tap from your Levo Wallet.',
    addressRow: 'Quick Buy address',
    noAddressYet: 'No address chosen yet',
    change: 'Change',
    manageAddresses: 'Manage addresses',
    addressMissing: 'Your saved Quick Buy address was deleted. Choose a new one to keep using Quick Buy.',
    consentsRow: 'Consents',
    acceptedOn: (date) => `Accepted on ${date}`,
    notAccepted: 'Not accepted yet',
    currentVersion: (n) => `current version ${n}`,
    reconsentNeeded: 'The Quick Buy policies were updated. Accept them again before your next purchase.',
    reviewAndAccept: 'Review and accept',
    saved: 'Saved',
    saveFailed: 'Could not save. Try again.',
    howItWorks: 'Everything you add with Quick Buy within 30 minutes of the first item becomes one order, sent automatically by standard delivery and paid in full from your Levo Wallet.',
    loading: 'Loading…',
  },
  ckb: {
    added: 'زیادکرا بۆ داواکاری کڕینی خێرا\u00a0⚡',
    remaining: (time) => `کاتی ماوە\u00a0${time}`,
    viewOrder: 'بینینی داواکاری',
    retry: 'دووبارە هەوڵ بدەرەوە',
    topUp: 'پڕکردنەوەی جزدان',
    activateNow: 'ئێستا چالاکی بکە',
    balance: (available, required) => `بەردەست ${available} · پێویست ${required}`,
    onlyLeft: (n) => `تەنها ${n} بەردەستە ئێستا.`,
    failed: 'کڕینی خێرا تەواو نەبوو. تکایە دووبارە هەوڵ بدەرەوە.',
    network: 'پەیوەندی پچڕا پێش ئەوەی دڵنیا ببینەوە. دووبارە هەوڵ بدەرەوە — بەرهەمەکە دوو جار زیاد ناکرێت.',
    activated: 'کڕینی خێرا چالاک کرا\u00a0⚡',
    activatedHint: 'دەست لە «کڕینی خێرا» بدە بۆ کڕین.',
    reconsented: 'ڕەزامەندییەکەت پاشەکەوت کرا.',

    sheetTitle: 'چالاککردنی کڕینی خێرا',
    sheetReconsentTitle: 'پێداچوونەوەی ڕەزامەندییەکانی کڕینی خێرا',
    sheetIntro: 'بە یەک دەستلێدان بکڕە: نرخی هەر زیادکردنێک لە جزدانی Levo دەگیرێت، و هەرچی لە ماوەی 30 خولەکدا زیادی دەکەیت دەبێتە یەک داواکاری کە خۆکارانە دەنێردرێت.',
    sheetReconsentIntro: 'هەندێک لە سیاسەتەکان لە دوای دوایین ڕەزامەندیتەوە گۆڕاون. پێیاندا بچۆرەوە و ڕەزامەندی بدە بۆ بەردەوامبوون لە کڕینی خێرا.',
    close: 'داخستن',
    stepConsents: 'ڕەزامەندییەکان',
    stepConsentsHint: 'هەر بەندێک بخوێنەوە و ڕەزامەندی لەسەر بدە — هیچ شتێک پێشوەخت دیاری نەکراوە.',
    consentWallet: 'ڕازیم بە گرتن و بڕینی خۆکارانەی بڕەکە لە جزدانی Levo',
    consentWalletHelp: 'نرخی هەر زیادکردنێک هەر کە دەستی لێدەدەیت دەگیرێت، لە کاتی ناردنی داواکاریدا دەبڕدرێت، و ئەوەی بەکارنەهێنرێت دەگەڕێتەوە بۆ باڵانسەکەت.',
    consentTerms: 'ڕازیم بە مەرجەکانی بەکارهێنان',
    consentPrivacy: 'ڕازیم بە سیاسەتی تایبەتمەندی',
    consentPolicy: 'ڕازیم بە سیاسەتی کڕینی خێرا',
    version: (n) => `وەشانی ${n}`,
    read: 'خوێندنەوە',
    readAria: (name) => `خوێندنەوەی ${name} لە پەنجەرەیەکی نوێدا`,
    policyTerms: 'مەرجەکانی بەکارهێنان',
    policyPrivacy: 'سیاسەتی تایبەتمەندی',
    policyQuickBuy: 'سیاسەتی کڕینی خێرا',
    stepAddress: 'ناونیشانی گەیاندنی بنەڕەتی',
    stepAddressHint: 'داواکارییەکانی کڕینی خێرا بە گەیاندنی ئاسایی بۆ ئەم ناونیشانە دەنێردرێن.',
    addressesLoading: 'ناونیشانەکانت بار دەکرێن…',
    noAddresses: 'هێشتا هیچ ناونیشانێکی پاشەکەوتکراو نییە — ناونیشانێک زیاد بکە بۆ بەردەوامبوون.',
    addAddress: 'زیادکردنی ناونیشانی نوێ',
    defaultTag: 'بنەڕەتی',
    activate: 'چالاککردنی کڕینی خێرا',
    saveConsent: 'پاشەکەوتکردنی ڕەزامەندی',
    activating: 'چالاک دەکرێت…',
    consentsLeft: (n) => `${n} ڕەزامەندی ماوە`,
    chooseAddress: 'ناونیشانێکی گەیاندن هەڵبژێرە',
    readyToActivate: 'هەموو شتێک ئامادەیە.',
    loadFailed: 'زانیارییەکانی کڕینی خێرا بار نەبوون.',
    policyChanged: 'یەکێک لە سیاسەتەکان ئێستا گۆڕا. پێیدا بچۆرەوە و دووبارە ڕەزامەندی بدە.',

    sheetAddressTitle: 'ناونیشانێکی نوێ بۆ کڕینی خێرا',
    sheetAddressIntro: 'ناونیشانی پاشەکەوتکراوی کڕینی خێرا سڕایەوە. ناونیشانێکی تر هەڵبژێرە یان یەکێک زیاد بکە — لە داواکاری داهاتووتەوە بەکاردێت.',
    saveAddress: 'پاشەکەوتکردنی ناونیشان',
    addressSaved: 'ناونیشانی کڕینی خێرا پاشەکەوت کرا.',
    printerTitle: 'ئاگاداری گەیاندنی ئاسایی بۆ چاپکەر',
    printerIntro: 'کڕینی خێرا تەنها بە گەیاندنی ئاسایی دەنێردرێت. ئاگادارییەکە بخوێنەوە و ڕەزامەندی لەسەر بدە بۆ زیادکردنی چاپکەرەکە، یان سەبەتە بەکاربهێنە بۆ هەڵبژاردنی ڕێگایەکی تری گەیاندن.',
    printerTranslation:
      'لەوانەیە داواکارییەکە لە کاتی گەیاندنی ئاسایی زیانی پێبگات، و ئێمە بەرپرسیارێتی زیانەکانی گواستنەوە ناگرینە ئەستۆ. ئەگەر لە کاتی گەیاندندا زیانی پێگەیشت، داواکارییەکە گەڕاندنەوەی بەخۆڕایی ناگرێتەوە.',
    printerOriginal: 'دەقە ڕەسەنەکە، بە عەرەبی:',
    printerAccept: 'ئاگادارییەکەی گواستنەوەم خوێندەوە و ڕازیم بە گەیاندنی ئاسایی بۆ ئەم داواکارییە.',
    printerAdd: 'ڕازیبوون و زیادکردن',
    printerHint: 'هیچ شتێک زیاد ناکرێت تا ڕەزامەندی نەدەیت.',

    cardTitle: 'کڕینی خێرا',
    collecting: 'کۆدەکرێتەوە',
    sending: 'دەنێردرێت',
    regionLabel: 'داواکاری کڕینی خێرا',
    timeLeft: 'کاتی ماوە',
    timerAria: (time) => `کاتی ماوە ${time}`,
    autoSend: 'داواکارییەکە کاتێک کات تەواو دەبێت خۆکارانە دەنێردرێت. بەرهەمی تر بە دوگمەی «کڕینی خێرا» لە پەڕەکانیانەوە زیاد بکە.',
    itemsHeading: (n) => `بەرهەمەکان (${n})`,
    each: (price) => `${price} بۆ هەر دانەیەک`,
    qtyOf: (name) => `بڕ — ${name}`,
    remove: 'لابردن',
    removeAria: (name) => `لابردنی ${name} لە داواکارییەکە`,
    openProduct: 'بینینی بەرهەم',
    subtotal: 'بەرهەمەکان',
    discount: 'داشکاندن',
    delivery: 'گەیاندنی ئاسایی',
    freeDelivery: 'گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo',
    total: 'کۆی گشتی',
    held: 'گیراوە لە جزدانی Levo',
    deliverTo: 'گەیاندن بۆ',
    deliveryMethod: 'شێوازی گەیاندن',
    standard: 'گەیاندنی ئاسایی',
    locked: 'کات تەواو بوو — داواکارییەکەت دەنێردرێت…',
    failedNotice: 'نەتوانرا داواکاری کڕینی خێرا خۆکارانە بنێردرێت — بڕەکە هێشتا بۆت گیراوە و تیمەکەمان بەدواداچوونی بۆ دەکات.',
    refresh: 'نوێکردنەوە',
    submittedTitle: 'داواکاری کڕینی خێرا نێردرا',
    submittedBody: (id) => `ژمارەی داواکاری ${id}`,
    cancelSession: 'هەڵوەشاندنەوەی داواکاری کڕینی خێرا',
    cancelTitle: 'داواکاری کڕینی خێرا هەڵدەوەشێنیتەوە؟',
    cancelConsequence: 'هەموو بەرهەمەکان لادەبرێن و بڕی گیراو دەگەڕێتەوە بۆ جزدانی Levo.',
    cancelConfirm: 'هەڵوەشاندنەوەی داواکاری',
    keepOrder: 'هێشتنەوەی داواکاری',
    removeLastTitle: 'دوایین بەرهەم لادەبەیت؟',
    removeLastConsequence: 'لابردنی دوایین بەرهەم داواکاری کڕینی خێرا هەڵدەوەشێنێتەوە و بڕی گیراو دەگەڕێنێتەوە بۆ جزدانەکەت.',
    removeConfirm: 'لابردن',
    cancelled: 'داواکاری کڕینی خێرا هەڵوەشێنرایەوە — بڕی گیراو گەڕایەوە بۆ جزدانەکەت.',
    removed: 'بەرهەمەکە لە داواکاری کڕینی خێرا لابرا.',
    expiredEdit: 'کاتی دەستکاری تەواو بوو — داواکارییەکەت دەنێردرێت.',

    settingsTitle: 'کڕینی خێرا',
    switchLabel: 'کڕینی خێرا',
    switchOn: 'چالاکە — دوگمەی ⚡ لە تەنیشت «زیادکردن بۆ سەبەتە» لە پەڕەی بەرهەمەکاندا دەردەکەوێت.',
    switchOff: 'ناچالاکە — چالاکی بکە بۆ ئەوەی بە یەک دەستلێدان لە جزدانی Levo بکڕیت.',
    addressRow: 'ناونیشانی کڕینی خێرا',
    noAddressYet: 'هێشتا ناونیشانێک دیاری نەکراوە',
    change: 'گۆڕین',
    manageAddresses: 'بەڕێوەبردنی ناونیشانەکان',
    addressMissing: 'ناونیشانی پاشەکەوتکراوی کڕینی خێرا سڕایەوە. ناونیشانێکی نوێ هەڵبژێرە بۆ ئەوەی کڕینی خێرا دووبارە کار بکات.',
    consentsRow: 'ڕەزامەندییەکان',
    acceptedOn: (date) => `ڕەزامەندیت دا لە ${date}`,
    notAccepted: 'هێشتا ڕەزامەندیت نەداوە',
    currentVersion: (n) => `وەشانی ئێستا ${n}`,
    reconsentNeeded: 'سیاسەتەکانی کڕینی خێرا نوێ کرانەوە. پێش کڕینی داهاتوو دووبارە ڕەزامەندییان لەسەر بدە.',
    reviewAndAccept: 'پێداچوونەوە و ڕەزامەندی',
    saved: 'پاشەکەوت کرا',
    saveFailed: 'پاشەکەوت نەکرا. دووبارە هەوڵ بدەرەوە.',
    howItWorks: 'هەرچی بە کڕینی خێرا لە ماوەی 30 خولەک لە یەکەم بەرهەمەوە زیادی دەکەیت دەبێتە یەک داواکاری، بە گەیاندنی ئاسایی خۆکارانە دەنێردرێت و بە تەواوی لە جزدانی Levo پارەی دەدرێت.',
    loading: 'بار دەکرێت…',
  },
};

/**
 * EVERY REFUSAL THE SERVER SENDS, one sentence each, keyed by `ApiError.code`
 * (docs/GIFTS_QUICK_BUY.md §3.6). The ones that carry numbers get them from
 * `quickBuyRefusal` below, in the reader's own currency setting.
 * SHIPPING_NEEDS_CONFIG and the printer warning say what the Checkout says
 * for the same refusals (src/pages/Checkout.tsx), in Quick Buy's words.
 */
export const QUICK_BUY_REFUSALS: Record<QuickBuyLang, Record<QuickBuyRefusalCode, string>> = {
  ar: {
    QUICK_BUY_NOT_ACTIVE: 'الشراء السريع غير مفعّل في حسابك. فعّله للمتابعة.',
    QUICK_BUY_RECONSENT_REQUIRED: 'تم تحديث سياسات الشراء السريع. وافق عليها من جديد للمتابعة.',
    QUICK_BUY_DIRECT_ONLY: 'الشراء السريع للبيع المباشر فقط — أضف الطلب المسبق إلى السلة.',
    QUICK_BUY_UNSUPPORTED_PRODUCT: 'هذا المنتج غير متاح للشراء السريع. أضفه إلى السلة.',
    OUT_OF_STOCK: 'نفد المخزون حاليًا.',
    QTY_UNAVAILABLE: 'الكمية المطلوبة غير متوفرة الآن.',
    QUICK_BUY_INSUFFICIENT_BALANCE: 'رصيد محفظة Levo غير كافٍ لإتمام الشراء السريع.',
    QUICK_BUY_EXPIRED: 'انتهى وقت طلب الشراء السريع. اضغط مرة أخرى لبدء طلب جديد.',
    QUICK_BUY_BUSY: 'طلبك قيد التحديث الآن. حاول بعد لحظة.',
    QUICK_BUY_PREVIOUS_PENDING: 'طلب الشراء السريع السابق قيد الإرسال الآن. أعد المحاولة بعد لحظة.',
    QUICK_BUY_NO_SESSION: 'لا يوجد طلب شراء سريع مفتوح الآن.',
    QUICK_BUY_FULL: 'يتسع طلب الشراء السريع لـ 20 منتجًا كحدّ أقصى.',
    QUICK_BUY_ITEM_NOT_FOUND: 'هذا المنتج لم يعد في طلب الشراء السريع.',
    QUICK_BUY_ADDRESS_INVALID: 'عنوان الشراء السريع لم يعد صالحًا. اختر عنوانًا آخر.',
    QUICK_BUY_WALLET_CONSENT_REQUIRED: 'وافق على حجز المبلغ وخصمه من محفظة Levo لتفعيل الشراء السريع.',
    PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED: 'اقرأ تحذير التوصيل العادي للطابعات ووافق عليه أولًا.',
    SHIPPING_NEEDS_CONFIG: 'رسوم توصيل جزء من هذا الطلب لم تُهيَّأ من الإدارة بعد، لذلك لا يمكن إتمام الشراء السريع حاليًا.',
    POLICY_ACCEPTANCE_REQUIRED: 'وافق على جميع البنود المطلوبة للمتابعة.',
    VALIDATION: 'تحقّق من اختيارك (الخيارات واللون والكمية) ثم حاول مرة أخرى.',
    IDEMPOTENCY_KEY_REUSED: 'تغيّر الطلب أثناء إعادة المحاولة. اضغط مرة أخرى.',
  },
  en: {
    QUICK_BUY_NOT_ACTIVE: 'Quick Buy is not active on your account. Activate it to continue.',
    QUICK_BUY_RECONSENT_REQUIRED: 'The Quick Buy policies were updated. Accept them again to continue.',
    QUICK_BUY_DIRECT_ONLY: 'Quick Buy is for direct sale only — add a pre-order to the cart.',
    QUICK_BUY_UNSUPPORTED_PRODUCT: 'This product isn’t available for Quick Buy. Add it to the cart instead.',
    OUT_OF_STOCK: 'Out of stock right now.',
    QTY_UNAVAILABLE: 'That quantity isn’t available right now.',
    QUICK_BUY_INSUFFICIENT_BALANCE: 'Your Levo Wallet balance isn’t enough to complete this Quick Buy.',
    QUICK_BUY_EXPIRED: 'That Quick Buy order’s time is up. Tap again to start a new one.',
    QUICK_BUY_BUSY: 'Your order is being updated. Try again in a moment.',
    QUICK_BUY_PREVIOUS_PENDING: 'Your previous Quick Buy order is being sent right now. Try again in a moment.',
    QUICK_BUY_NO_SESSION: 'There’s no open Quick Buy order right now.',
    QUICK_BUY_FULL: 'A Quick Buy order holds at most 20 products.',
    QUICK_BUY_ITEM_NOT_FOUND: 'This item is no longer in your Quick Buy order.',
    QUICK_BUY_ADDRESS_INVALID: 'Your Quick Buy address is no longer valid. Choose another one.',
    QUICK_BUY_WALLET_CONSENT_REQUIRED: 'Allow the Levo Wallet hold and charge to switch Quick Buy on.',
    PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED: 'Read and acknowledge the printer standard-delivery warning first.',
    SHIPPING_NEEDS_CONFIG: 'Delivery fees for part of this order aren’t configured by the store yet, so Quick Buy can’t complete it right now.',
    POLICY_ACCEPTANCE_REQUIRED: 'Accept every required item to continue.',
    VALIDATION: 'Check your selection (options, colour and quantity), then try again.',
    IDEMPOTENCY_KEY_REUSED: 'The request changed while it was being retried. Tap again.',
  },
  ckb: {
    QUICK_BUY_NOT_ACTIVE: 'کڕینی خێرا لە هەژمارەکەتدا چالاک نییە. بۆ بەردەوامبوون چالاکی بکە.',
    QUICK_BUY_RECONSENT_REQUIRED: 'سیاسەتەکانی کڕینی خێرا نوێ کرانەوە. بۆ بەردەوامبوون دووبارە ڕەزامەندییان لەسەر بدە.',
    QUICK_BUY_DIRECT_ONLY: 'کڕینی خێرا تەنها بۆ فرۆشتنی ڕاستەوخۆیە — پێشداواکاری بخەرە سەبەتەوە.',
    QUICK_BUY_UNSUPPORTED_PRODUCT: 'ئەم بەرهەمە بۆ کڕینی خێرا بەردەست نییە. بیخەرە سەبەتەوە.',
    OUT_OF_STOCK: 'ئێستا لە کۆگا نییە.',
    QTY_UNAVAILABLE: 'ئەو بڕەی داوات کردووە ئێستا بەردەست نییە.',
    QUICK_BUY_INSUFFICIENT_BALANCE: 'باڵانسی جزدانی Levo بەش ناکات بۆ تەواوکردنی کڕینی خێرا.',
    QUICK_BUY_EXPIRED: 'کاتی ئەو داواکارییەی کڕینی خێرا تەواو بوو. دووبارە دەستی لێبدە بۆ دەستپێکردنی داواکارییەکی نوێ.',
    QUICK_BUY_BUSY: 'داواکارییەکەت ئێستا نوێ دەکرێتەوە. دوای چرکەیەک دووبارە هەوڵ بدەرەوە.',
    QUICK_BUY_PREVIOUS_PENDING: 'داواکاری پێشووی کڕینی خێرا ئێستا دەنێردرێت. دوای چرکەیەک دووبارە هەوڵ بدەرەوە.',
    QUICK_BUY_NO_SESSION: 'ئێستا هیچ داواکارییەکی کراوەی کڕینی خێرا نییە.',
    QUICK_BUY_FULL: 'داواکاری کڕینی خێرا زۆرترین 20 بەرهەم لەخۆ دەگرێت.',
    QUICK_BUY_ITEM_NOT_FOUND: 'ئەم بەرهەمە چیتر لە داواکاری کڕینی خێرادا نییە.',
    QUICK_BUY_ADDRESS_INVALID: 'ناونیشانی کڕینی خێرا چیتر دروست نییە. ناونیشانێکی تر هەڵبژێرە.',
    QUICK_BUY_WALLET_CONSENT_REQUIRED: 'بۆ چالاککردنی کڕینی خێرا ڕەزامەندی بدە بە گرتن و بڕینی بڕەکە لە جزدانی Levo.',
    PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED: 'سەرەتا ئاگاداری گەیاندنی ئاسایی بۆ چاپکەر بخوێنەوە و ڕەزامەندی لەسەر بدە.',
    SHIPPING_NEEDS_CONFIG: 'کرێی گەیاندنی بەشێک لەم داواکارییە هێشتا لەلایەن بەڕێوەبەرایەتییەوە ڕێکنەخراوە، بۆیە ئێستا کڕینی خێرا تەواو ناکرێت.',
    POLICY_ACCEPTANCE_REQUIRED: 'بۆ بەردەوامبوون ڕەزامەندی لەسەر هەموو بەندە پێویستەکان بدە.',
    VALIDATION: 'هەڵبژاردنەکەت بپشکنە (هەڵبژاردەکان، ڕەنگ و بڕ)، پاشان دووبارە هەوڵ بدەرەوە.',
    IDEMPOTENCY_KEY_REUSED: 'داواکارییەکە لە کاتی دووبارە هەوڵدانەوەدا گۆڕا. دووبارە دەستی لێبدە.',
  },
};

export function quickBuyLang(lang: string): QuickBuyLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

export function quickBuyStrings(lang: string): QuickBuyStrings {
  return QUICK_BUY_STRINGS[quickBuyLang(lang)];
}

/** A refusal said to the customer: a sentence, and the numbers that explain it when there are any. */
export interface QuickBuyRefusalMessage {
  /** The machine code ('' for an unknown failure, 'NETWORK' when no answer arrived). */
  code: string;
  title: string;
  description?: string;
}

/**
 * The customer's sentence for any failure of a Quick Buy request. `money`
 * formats a dinar figure the way the reader asked to read prices (the
 * wallet's amounts are dinars; `moneyBoth` keeps the dinar on screen).
 */
export function quickBuyRefusal(err: unknown, lang: string, money: (iqd: number) => string): QuickBuyRefusalMessage {
  const t = quickBuyStrings(lang);
  const said = QUICK_BUY_REFUSALS[quickBuyLang(lang)];
  if (!(err instanceof ApiError)) return { code: '', title: t.failed };
  if (err.status === 0) return { code: 'NETWORK', title: t.network };
  const code = err.code ?? '';
  if (code === 'QUICK_BUY_INSUFFICIENT_BALANCE') {
    const available = refusalNumber(err, 'available_iqd');
    const required = refusalNumber(err, 'required_iqd');
    return {
      code,
      title: said.QUICK_BUY_INSUFFICIENT_BALANCE,
      description: available !== null && required !== null ? t.balance(money(available), money(required)) : undefined,
    };
  }
  if (code === 'OUT_OF_STOCK' || code === 'QTY_UNAVAILABLE') {
    // 400 with `details.available` from the checkout's own check: some are
    // left, just not that many. 409 with `details.product_id` (a reservation
    // lost a race) or nothing left: out of stock.
    const left = refusalNumber(err, 'available');
    if (left !== null && left > 0) return { code, title: said.QTY_UNAVAILABLE, description: t.onlyLeft(left) };
    return { code, title: said.OUT_OF_STOCK };
  }
  if (isQuickBuyRefusal(code)) return { code, title: said[code] };
  // A failure the contract does not name: our sentence, and the server's own beside it.
  return { code, title: t.failed, description: err.status >= 500 ? undefined : err.message || undefined };
}
