/**
 * The words of Print Cloud's store and orders (src/cloud/pages/store): the
 * catalogue of printing hours, filament and accessories, the cart, the
 * quote, paying an order and following it. Read through `useCloudText()`.
 *
 * Every price the screens put into these sentences is the server's own figure,
 * filled in at render (`{price}`, `{total}`) — a string here never carries a
 * number of its own (tests/printCloudUiShell.test.ts). «Levonis» stays in
 * Latin letters in every language; a Sorani slot is written in Sorani, never
 * copied from the Arabic (docs/DECISIONS.md row 183, tests/printCloudUiStore.test.ts).
 */
import type { Tri } from '../types';

/** The catalogue: tabs, search, chips, the cart and orders doors. */
export const store = {
  title: { ar: 'المتجر', en: 'Store', ckb: 'فرۆشگا' },
  subtitle: {
    ar: 'ساعات الطباعة والخيوط والملحقات، بأسعار الورشة نفسها.',
    en: 'Printing hours, filament and accessories, at the workshop’s own prices.',
    ckb: 'کاتژمێری چاپ و فیلامێنت و پێداویستییەکان، بە نرخەکانی خودی کارگە.',
  },
  tabsLabel: { ar: 'ماذا تشتري', en: 'What to buy', ckb: 'چی دەکڕیت' },
  tabHours: { ar: 'ساعات الطباعة', en: 'Printing hours', ckb: 'کاتژمێری چاپ' },
  tabMaterials: { ar: 'الخيوط', en: 'Filament', ckb: 'فیلامێنت' },
  tabAccessories: { ar: 'الملحقات', en: 'Accessories', ckb: 'پێداویستییەکان' },
  searchLabel: { ar: 'البحث في المتجر', en: 'Search the store', ckb: 'گەڕان لە فرۆشگادا' },
  searchGoods: { ar: 'ابحث عن خيط أو ملحق أو ماركة أو لون…', en: 'Search filament, accessories, brands or colours…', ckb: 'بگەڕێ بۆ فیلامێنت، پێداویستی، براند یان ڕەنگ…' },
  searchHours: { ar: 'ابحث عن باقة أو طابعة…', en: 'Search packages or printers…', ckb: 'بگەڕێ بۆ پاکێج یان چاپکەر…' },
  clearSearch: { ar: 'مسح البحث', en: 'Clear search', ckb: 'سڕینەوەی گەڕان' },
  all: { ar: 'الكل', en: 'All', ckb: 'هەموو' },
  categories: { ar: 'الفئات', en: 'Categories', ckb: 'پۆلەکان' },
  cart: { ar: 'السلة', en: 'Cart', ckb: 'سەبەتە' },
  // «عدد … : n» agrees with any number, where «n عناصر» is wrong for one, two and from eleven.
  cartCount: { ar: 'عدد البنود في السلة: {n}', en: 'Items in cart: {n}', ckb: 'ژمارەی دێڕەکانی سەبەتە: {n}' },
  myOrders: { ar: 'طلباتي', en: 'My orders', ckb: 'داواکارییەکانم' },
  addToCart: { ar: 'أضف إلى السلة', en: 'Add to cart', ckb: 'زیادکردن بۆ سەبەتە' },
  signInToBuy: { ar: 'سجّل الدخول للشراء', en: 'Sign in to buy', ckb: 'بچۆ ژوورەوە بۆ کڕین' },
  added: { ar: 'أُضيف إلى سلتك', en: 'Added to your cart', ckb: 'زیادکرا بۆ سەبەتەکەت' },
  merged: { ar: 'زِيدت الكمية في سلتك', en: 'Quantity updated in your cart', ckb: 'بڕەکە لە سەبەتەکەتدا نوێکرایەوە' },
  viewCart: { ar: 'عرض السلة', en: 'View cart', ckb: 'سەیری سەبەتە بکە' },
  cartFull: {
    ar: 'تتسع السلة لـ {n} بندًا على الأكثر. اطلب هذه أولًا ثم أضف المزيد.',
    en: 'Your cart holds at most {n} lines. Order these first, then add more.',
    ckb: 'سەبەتەکەت زۆرترین {n} دێڕ هەڵدەگرێت. سەرەتا ئەمانە داوا بکە، پاشان زیاتر زیاد بکە.',
  },
  quantityRefused: { ar: 'لا يمكن شراء هذه الكمية.', en: 'This quantity cannot be bought.', ckb: 'ناتوانرێت ئەم بڕە بکڕدرێت.' },
  showMore: { ar: 'عرض المزيد', en: 'Show more', ckb: 'زیاتر پیشان بدە' },
  shownOf: { ar: 'معروض {shown} من {total}', en: 'Showing {shown} of {total}', ckb: '{shown} لە {total} پیشان دراوە' },
  noMatchTitle: { ar: 'لا شيء يطابق بحثك', en: 'Nothing matches your search', ckb: 'هیچ شتێک لەگەڵ گەڕانەکەت ناگونجێت' },
  noMatchBody: { ar: 'جرّب كلمة أخرى، أو امسح البحث.', en: 'Try another word, or clear the search.', ckb: 'وشەیەکی تر تاقی بکەرەوە، یان گەڕانەکە بسڕەوە.' },
} satisfies Record<string, Tri>;

/** The hours tab: packages by printer class. */
export const hours = {
  intro: {
    ar: 'تُشترى الساعات لفئة طابعة، وتستخدمها طباعاتك على أي طابعة من تلك الفئة.',
    en: 'Hours are bought for a printer class and used by your prints on any printer of that class.',
    ckb: 'کاتژمێرەکان بۆ پۆلێکی چاپکەر دەکڕدرێن و چاپەکانت لەسەر هەر چاپکەرێکی ئەو پۆلە بەکاریان دەهێنن.',
  },
  classes: { ar: 'فئات الطابعات', en: 'Printer classes', ckb: 'پۆلەکانی چاپکەر' },
  allClasses: { ar: 'كل الفئات', en: 'All classes', ckb: 'هەموو پۆلەکان' },
  classFallback: { ar: 'فئة طابعات', en: 'Printer class', ckb: 'پۆلی چاپکەر' },
  printsOn: { ar: 'تطبع على: {models}', en: 'Prints on: {models}', ckb: 'چاپ دەکات لەسەر: {models}' },
  noPackagesTitle: { ar: 'لا توجد باقات ساعات معروضة الآن', en: 'No hour packages on sale right now', ckb: 'ئێستا هیچ پاکێجێکی کاتژمێر بۆ فرۆشتن نییە' },
  noPackagesForClass: {
    ar: 'لا توجد باقات ساعات معروضة الآن لفئة {class}',
    en: 'No hour packages are on sale for {class} right now',
    ckb: 'ئێستا هیچ پاکێجێکی کاتژمێر بۆ {class} بۆ فرۆشتن نییە',
  },
  noPackagesBody: {
    ar: 'لم تعرض الورشة باقات ساعات للبيع بعد. عُد لاحقًا.',
    en: 'The workshop has not put hour packages on sale yet. Check back soon.',
    ckb: 'کارگە هێشتا پاکێجی کاتژمێری بۆ فرۆشتن دانەناوە. دواتر سەردان بکەرەوە.',
  },
  perHour: { ar: '≈ {price} للساعة', en: '≈ {price} per hour', ckb: '≈ {price} بۆ هەر کاتژمێرێک' },
  validFor: { ar: 'صالحة لمدة {days} بعد الشراء', en: 'Valid for {days} after purchase', ckb: 'تا {days} دوای کڕین بەکاردێت' },
  neverExpires: { ar: 'لا تنتهي صلاحيتها', en: 'Never expires', ckb: 'هەرگیز بەسەرناچێت' },
  offerEnds: { ar: 'ينتهي العرض في {date}', en: 'Offer ends {date}', ckb: 'ئۆفەرەکە لە {date} کۆتایی دێت' },
  offer: { ar: 'عرض', en: 'Offer', ckb: 'ئۆفەر' },
  bundle: { ar: 'مع مواد', en: 'With materials', ckb: 'لەگەڵ کەرەستە' },
  includes: { ar: 'تشمل: {items}', en: 'Includes: {items}', ckb: 'لەخۆدەگرێت: {items}' },
  limitPerCustomer: { ar: 'الحد: {n} لكل عميل', en: 'Limit: {n} per customer', ckb: 'سنوور: {n} بۆ هەر کڕیارێک' },
} satisfies Record<string, Tri>;

/** The filament and accessories tabs, and a product's own page. */
export const goods = {
  noProductsTitle: { ar: 'لا شيء معروض هنا بعد', en: 'Nothing on sale here yet', ckb: 'هێشتا هیچ شتێک لێرە بۆ فرۆشتن نییە' },
  noProductsBody: {
    ar: 'لم تعرض الورشة أي صنف في هذا القسم بعد.',
    en: 'The workshop has not listed anything in this section yet.',
    ckb: 'کارگە هێشتا هیچ کاڵایەکی لەم بەشەدا دانەناوە.',
  },
  priceFor: { ar: '{price} لـ {qty}', en: '{price} for {qty}', ckb: '{price} بۆ {qty}' },
  fromPriceFor: { ar: 'من {price} لـ {qty}', en: 'From {price} for {qty}', ckb: 'لە {price} بۆ {qty}' },
  pricedByQuantity: { ar: 'يُسعَّر حسب الكمية التي تختارها', en: 'Priced by the quantity you choose', ckb: 'بەپێی ئەو بڕەی هەڵیدەبژێریت نرخ دادەنرێت' },
  outOfStock: { ar: 'نفد من المخزون', en: 'Out of stock', ckb: 'لە کۆگادا نەماوە' },
  colours: { ar: 'عدد الألوان: {n}', en: 'Colours: {n}', ckb: 'ژمارەی ڕەنگەکان: {n}' },
  options: { ar: 'عدد الخيارات: {n}', en: 'Options: {n}', ckb: 'ژمارەی هەڵبژاردنەکان: {n}' },
  notFoundTitle: { ar: 'هذا الصنف غير معروض للبيع', en: 'This item is not on sale', ckb: 'ئەم کاڵایە بۆ فرۆشتن نییە' },
  notFoundBody: {
    ar: 'ربما أُزيل من المتجر. تصفّح ما هو معروض الآن.',
    en: 'It may have been taken off the store. Browse what is on sale now.',
    ckb: 'لەوانەیە لە فرۆشگا لابرابێت. سەیری ئەوە بکە کە ئێستا بۆ فرۆشتنە.',
  },
  colour: { ar: 'اللون', en: 'Colour', ckb: 'ڕەنگ' },
  option: { ar: 'الخيار', en: 'Option', ckb: 'هەڵبژاردن' },
  sku: { ar: 'رمز الصنف', en: 'SKU', ckb: 'کۆدی کاڵا' },
  diameter: { ar: 'القطر', en: 'Diameter', ckb: 'تیرە' },
  material: { ar: 'المادة', en: 'Material', ckb: 'کەرەستە' },
  brand: { ar: 'الماركة', en: 'Brand', ckb: 'براند' },
  stock: { ar: 'المخزون في الورشة', en: 'Stock at the workshop', ckb: 'کۆگای کارگە' },
  quantity: { ar: 'الكمية', en: 'Quantity', ckb: 'بڕ' },
  quantityRule: { ar: 'من {min} إلى {max}، بخطوات {step}', en: 'From {min} to {max}, in steps of {step}', ckb: 'لە {min} تا {max}، بە هەنگاوی {step}' },
  quantityRange: { ar: 'من {min} إلى {max}', en: 'From {min} to {max}', ckb: 'لە {min} تا {max}' },
  snapped: {
    ar: 'تُشترى الكمية بخطوات {step}، فضُبطت على {qty}.',
    en: 'Quantities go in steps of {step}, so it was set to {qty}.',
    ckb: 'بڕەکە بە هەنگاوی {step} دەکڕدرێت، بۆیە کرا بە {qty}.',
  },
  raisedToLeast: {
    ar: 'ضُبطت الكمية على {qty}، وهي أقل كمية يمكنك شراؤها.',
    en: 'It was set to {qty}, the smallest quantity you can buy.',
    ckb: 'بڕەکە کرا بە {qty}، کە کەمترین بڕە دەتوانیت بیکڕیت.',
  },
  loweredToMost: {
    ar: 'ضُبطت الكمية على {qty}، وهي أكبر كمية يمكنك شراؤها الآن.',
    en: 'It was set to {qty}, the largest quantity you can buy right now.',
    ckb: 'بڕەکە کرا بە {qty}، کە زۆرترین بڕە ئێستا دەتوانیت بیکڕیت.',
  },
  decrease: { ar: 'إنقاص الكمية', en: 'Decrease quantity', ckb: 'کەمکردنەوەی بڕ' },
  increase: { ar: 'زيادة الكمية', en: 'Increase quantity', ckb: 'زیادکردنی بڕ' },
  packs: { ar: 'أحجام جاهزة', en: 'Packs', ckb: 'قەبارە ئامادەکان' },
  notPurchasableTitle: { ar: 'لا يمكن شراء هذا الصنف الآن', en: 'This item cannot be bought right now', ckb: 'ئێستا ناتوانرێت ئەم کاڵایە بکڕدرێت' },
  notPurchasableBody: {
    ar: 'لا توجد الآن كمية تستطيع الورشة بيعها.',
    en: 'There is no quantity the workshop can sell right now.',
    ckb: 'ئێستا هیچ بڕێک نییە کە کارگە بتوانێت بیفرۆشێت.',
  },
  whereTo: { ar: 'إلى أين تذهب؟', en: 'Where should it go?', ckb: 'بۆ کوێ بچێت؟' },
  keep: { ar: 'تُحفظ في الورشة', en: 'Keep at the workshop', ckb: 'لە کارگە هەڵبگیرێت' },
  deliver: { ar: 'توصَّل إليّ', en: 'Deliver to me', ckb: 'بۆم بگەیەنە' },
  keepNote: {
    ar: 'تُحفظ لك في الورشة جاهزةً لطباعاتك، ويمكنك طلب توصيلها لاحقًا.',
    en: 'Kept for you at the workshop, ready for your prints. You can ask for it to be delivered later.',
    ckb: 'لە کارگە بۆت هەڵدەگیرێت و ئامادەیە بۆ چاپەکانت. دواتر دەتوانیت داوای گەیاندنی بکەیت.',
  },
  deliverNote: {
    ar: 'توصَّل إلى عنوانك. تُضاف أجرة توصيل محافظتك عند تقديم الطلب.',
    en: 'Delivered to your address. The delivery fee for your governorate is added when you place the order.',
    ckb: 'بۆ ناونیشانەکەت دەگەیەندرێت. کرێی گەیاندنی پارێزگاکەت کاتی تۆمارکردنی داواکاری زیاد دەکرێت.',
  },
  deliveryOff: {
    ar: 'التوصيل غير متاح الآن، ولا يُباع هذا الصنف إلا للتوصيل.',
    en: 'Delivery is not available right now, and this item is sold for delivery only.',
    ckb: 'گەیاندن ئێستا بەردەست نییە، و ئەم کاڵایە تەنها بۆ گەیاندن دەفرۆشرێت.',
  },
  priceTitle: { ar: 'سعر هذه الكمية', en: 'Price for this quantity', ckb: 'نرخی ئەم بڕە' },
  priceNote: {
    ar: 'سعر اليوم من قائمة أسعار الورشة، ويُثبَّت لك عندما تحصل على عرض سعر.',
    en: 'Today’s price from the workshop’s price list. It is fixed for you when you get a quote.',
    ckb: 'نرخی ئەمڕۆ لە لیستی نرخەکانی کارگە. کاتێک نرخدان وەردەگریت بۆت جێگیر دەکرێت.',
  },
  askingPrice: { ar: 'جارٍ طلب السعر…', en: 'Asking for the price…', ckb: 'نرخ داوا دەکرێت…' },
  packPrice: { ar: 'سعر العبوة الجاهزة', en: 'Pack price', ckb: 'نرخی پاکەتی ئامادە' },
  bracketPrice: {
    ar: 'سعر حسب الكمية من شريحة {min} فأكثر، مقرّبًا للأعلى إلى أقرب {rounding}',
    en: 'Priced by quantity from the {min} tier up, rounded up to the nearest {rounding}',
    ckb: 'نرخ بەپێی بڕ لە ئاستی {min} بەرەوژوور، بەرزکراوەتەوە بۆ نزیکترین {rounding}',
  },
  bracketPlain: { ar: 'سعر حسب الكمية من شريحة {min} فأكثر', en: 'Priced by quantity from the {min} tier up', ckb: 'نرخ بەپێی بڕ لە ئاستی {min} بەرەوژوور' },
  cappedAtPack: { ar: 'لا يتجاوز سعر عبوة {pack}', en: 'Never more than the {pack} pack', ckb: 'هەرگیز لە نرخی پاکەتی {pack} زیاتر نییە' },
  beforeDiscount: { ar: 'قبل الخصم', en: 'Before discount', ckb: 'پێش داشکاندن' },
  discount: { ar: 'الخصم', en: 'Discount', ckb: 'داشکاندن' },
  limitNote: {
    ar: 'الحد: {qty} لكل عميل، وتُحسب معه طلباتك السابقة',
    en: 'Limit: {qty} per customer, counting your earlier orders',
    ckb: 'سنوور: {qty} بۆ هەر کڕیارێک، داواکارییەکانی پێشووت حیساب دەکرێن',
  },
  stockShort: { ar: 'المتوفر الآن {qty} فقط', en: 'Only {qty} in stock right now', ckb: 'ئێستا تەنها {qty} لە کۆگادا هەیە' },
  notEnoughStock: { ar: 'لا يكفي المخزون لهذه الكمية', en: 'Not enough in stock for this quantity', ckb: 'کۆگا بۆ ئەم بڕە بەس نییە' },
} satisfies Record<string, Tri>;

/** The cart (/store/cart). */
export const cart = {
  title: { ar: 'سلتك', en: 'Your cart', ckb: 'سەبەتەکەت' },
  subtitle: {
    ar: 'تبقى هنا حتى تعيد تحميل الصفحة أو تغلقها، ولحسابك وحده.',
    en: 'Kept here until you reload or close this page, for your account alone.',
    ckb: 'هەتا پەڕەکە نوێ دەکەیتەوە یان دایدەخەیت لێرە دەمێنێتەوە، تەنها بۆ هەژمارەکەت.',
  },
  emptyTitle: { ar: 'سلتك فارغة', en: 'Your cart is empty', ckb: 'سەبەتەکەت بەتاڵە' },
  emptyBody: { ar: 'أضف ساعات طباعة أو خيوطًا أو ملحقات من المتجر.', en: 'Add printing hours, filament or accessories from the store.', ckb: 'کاتژمێری چاپ، فیلامێنت یان پێداویستی لە فرۆشگاوە زیاد بکە.' },
  browseHours: { ar: 'تصفّح الساعات', en: 'Browse hours', ckb: 'سەیری کاتژمێرەکان بکە' },
  browseMaterials: { ar: 'تصفّح الخيوط', en: 'Browse filament', ckb: 'سەیری فیلامێنت بکە' },
  removeNamed: { ar: 'إزالة {name}', en: 'Remove {name}', ckb: 'لابردنی {name}' },
  removed: { ar: 'أُزيل من سلتك', en: 'Removed from your cart', ckb: 'لە سەبەتەکەت لابرا' },
  undo: { ar: 'تراجع', en: 'Undo', ckb: 'گەڕاندنەوە' },
  hoursEach: { ar: '{hours} لكل باقة', en: '{hours} each', ckb: '{hours} بۆ هەر پاکێجێک' },
  todaysPrices: { ar: 'أسعار اليوم', en: 'Today’s prices', ckb: 'نرخەکانی ئەمڕۆ' },
  pricesNote: {
    ar: 'هذه أسعار اليوم من الخادم. احصل على عرض سعر لتثبيتها لك قبل الطلب.',
    en: 'These are today’s prices from the server. Get a quote to fix them for you before you order.',
    ckb: 'ئەمانە نرخەکانی ئەمڕۆن لە ڕاژەکارەوە. نرخدان وەربگرە بۆ ئەوەی پێش داواکردن بۆت جێگیر بکرێن.',
  },
  subtotal: { ar: 'المجموع قبل الخصم', en: 'Subtotal', ckb: 'کۆی پێش داشکاندن' },
  total: { ar: 'الإجمالي', en: 'Total', ckb: 'کۆی گشتی' },
  coupon: { ar: 'رمز القسيمة', en: 'Coupon code', ckb: 'کۆدی کۆپۆن' },
  applyCoupon: { ar: 'تطبيق', en: 'Apply', ckb: 'جێبەجێکردن' },
  couponApplied: { ar: 'القسيمة {code} مطبّقة', en: 'Coupon {code} applied', ckb: 'کۆپۆنی {code} جێبەجێکراوە' },
  couponNoDiscount: {
    ar: 'القسيمة {code} لا تمنح خصمًا على هذه السلة',
    en: 'Coupon {code} gives no discount on this cart',
    ckb: 'کۆپۆنی {code} هیچ داشکاندنێک بۆ ئەم سەبەتەیە نادات',
  },
  couponRefused: { ar: 'هذه القسيمة غير صالحة', en: 'This coupon is not valid', ckb: 'ئەم کۆپۆنە دروست نییە' },
  removeCoupon: { ar: 'إزالة القسيمة', en: 'Remove coupon', ckb: 'لابردنی کۆپۆن' },
  getQuote: { ar: 'احصل على عرض سعر', en: 'Get a quote', ckb: 'نرخدان وەربگرە' },
  gettingQuote: { ar: 'جارٍ إعداد عرض السعر…', en: 'Getting your quote…', ckb: 'نرخدانەکەت ئامادە دەکرێت…' },
  fixLines: {
    ar: 'غيّر البنود المعلَّمة أو أزلها للمتابعة.',
    en: 'Change or remove the marked lines to continue.',
    ckb: 'دێڕە نیشانەکراوەکان بگۆڕە یان لایان ببە بۆ بەردەوامبوون.',
  },
} satisfies Record<string, Tri>;

/** The stored quote and placing the order (/store/checkout/:quoteId). */
export const checkout = {
  title: { ar: 'عرض السعر', en: 'Your quote', ckb: 'نرخدانەکەت' },
  subtitle: { ar: 'أسعار مثبّتة لك حتى ينتهي الوقت.', en: 'Prices fixed for you until the time runs out.', ckb: 'نرخەکان تا کاتەکە تەواو دەبێت بۆت جێگیرن.' },
  heldFor: { ar: 'الأسعار مثبّتة لمدة {clock}', en: 'Prices held for {clock}', ckb: 'نرخەکان بۆ {clock} جێگیرن' },
  heldUntil: { ar: 'الأسعار مثبّتة حتى {date}', en: 'Prices held until {date}', ckb: 'نرخەکان تا {date} جێگیرن' },
  expiredTitle: { ar: 'انتهت صلاحية عرض السعر', en: 'This quote has expired', ckb: 'ئەم نرخدانە بەسەرچووە' },
  expiredBody: {
    ar: 'تُثبَّت الأسعار لوقت محدود. احصل على عرض جديد لترى أسعار اليوم.',
    en: 'Prices are held for a limited time. Get a new quote to see today’s prices.',
    ckb: 'نرخەکان بۆ ماوەیەکی دیاریکراو جێگیر دەکرێن. نرخدانێکی نوێ وەربگرە بۆ بینینی نرخەکانی ئەمڕۆ.',
  },
  newQuote: { ar: 'احصل على عرض جديد', en: 'Get a new quote', ckb: 'نرخدانێکی نوێ وەربگرە' },
  orderedTitle: { ar: 'قُدِّم طلب من هذا العرض مسبقًا', en: 'An order was already placed from this quote', ckb: 'پێشتر داواکارییەک لەم نرخدانە تۆمارکراوە' },
  orderedBody: { ar: 'افتح طلباتك لتدفعه أو تتابعه.', en: 'Open your orders to pay it or follow it.', ckb: 'داواکارییەکانت بکەرەوە بۆ پارەدان یان بەدواداچوونی.' },
  discounts: { ar: 'الخصومات المطبّقة', en: 'Discounts applied', ckb: 'داشکاندنە جێبەجێکراوەکان' },
  codeDiscount: { ar: 'القسيمة {code}', en: 'Coupon {code}', ckb: 'کۆپۆنی {code}' },
  autoDiscount: { ar: 'خصم تلقائي', en: 'Automatic discount', ckb: 'داشکاندنی خۆکار' },
  notOrderableTitle: { ar: 'بعض الأصناف لم تعد متوفرة', en: 'Some items are no longer available', ckb: 'هەندێک کاڵا ئیتر بەردەست نین' },
  notOrderableBody: {
    ar: 'عُد إلى سلتك وغيّر البنود المعلَّمة، ثم احصل على عرض جديد.',
    en: 'Go back to your cart, change the marked lines, then get a new quote.',
    ckb: 'بگەڕێوە بۆ سەبەتەکەت، دێڕە نیشانەکراوەکان بگۆڕە، پاشان نرخدانێکی نوێ وەربگرە.',
  },
  backToCart: { ar: 'العودة إلى السلة', en: 'Back to cart', ckb: 'گەڕانەوە بۆ سەبەتە' },
  payWith: { ar: 'كيف ستدفع؟', en: 'How will you pay?', ckb: 'چۆن پارە دەدەیت؟' },
  // The manual door's name in the two-option picker, short enough for half a phone-width pill.
  manualShort: { ar: 'الورشة أو التحويل', en: 'Workshop or transfer', ckb: 'کارگە یان گواستنەوە' },
  walletNote: {
    ar: 'تدفع المبلغ كاملًا من محفظتك في Levonis بعد تقديم الطلب مباشرة.',
    en: 'You pay the exact total from your Levonis wallet right after placing the order.',
    ckb: 'دوای تۆمارکردنی داواکاری یەکسەر هەموو بڕەکە لە جزدانەکەت لە Levonis دەدەیت.',
  },
  walletBalance: { ar: 'رصيد محفظتك: {amount}', en: 'Your wallet balance: {amount}', ckb: 'باڵانسی جزدانەکەت: {amount}' },
  walletShort: {
    ar: 'رصيد محفظتك أقل من هذا الإجمالي. أضف رصيدًا في Levonis قبل الدفع.',
    en: 'Your wallet holds less than this total. Add funds on Levonis before you pay.',
    ckb: 'باڵانسی جزدانەکەت لەم کۆیە کەمترە. پێش پارەدان لە Levonis پارە زیاد بکە.',
  },
  manualNote: {
    ar: 'ادفع نقدًا في الورشة أو بتحويل مصرفي مع ذكر رقم الطلب، ويؤكّد أحد المدراء الدفع.',
    en: 'Pay cash at the workshop or by bank transfer quoting your order number. An admin confirms the payment.',
    ckb: 'بە پارەی نەقد لە کارگە یان بە گواستنەوەی بانکی پارە بدە و ژمارەی داواکارییەکە بنووسە. بەڕێوەبەرێک پارەدانەکە پشتڕاست دەکاتەوە.',
  },
  deliveryTitle: { ar: 'عنوان التوصيل', en: 'Delivery address', ckb: 'ناونیشانی گەیاندن' },
  deliveryFeeNote: {
    ar: 'تُضاف أجرة التوصيل لهذه المحافظة إلى الإجمالي عند تقديم الطلب، ويمكنك إلغاؤه قبل الدفع.',
    en: 'The delivery fee for this governorate is added to the total when you place the order. You can cancel before paying.',
    ckb: 'کرێی گەیاندنی ئەم پارێزگایە کاتی تۆمارکردنی داواکاری دەخرێتە سەر کۆی گشتی. دەتوانیت پێش پارەدان هەڵیبوەشێنیتەوە.',
  },
  deliveryUnavailable: {
    ar: 'التوصيل غير متاح الآن. عُد إلى سلتك واحفظ هذه الأصناف في الورشة.',
    en: 'Delivery is not available right now. Go back to your cart and keep these items at the workshop.',
    ckb: 'گەیاندن ئێستا بەردەست نییە. بگەڕێوە بۆ سەبەتەکەت و ئەم کاڵایانە لە کارگە هەڵبگرە.',
  },
  addressIncomplete: { ar: 'أكمل عنوان التوصيل للمتابعة.', en: 'Complete the delivery address to continue.', ckb: 'ناونیشانی گەیاندن تەواو بکە بۆ بەردەوامبوون.' },
  placeOrder: { ar: 'تقديم الطلب', en: 'Place order', ckb: 'تۆمارکردنی داواکاری' },
  confirmTitle: { ar: 'تقديم هذا الطلب؟', en: 'Place this order?', ckb: 'ئەم داواکارییە تۆمار بکرێت؟' },
  confirmWallet: {
    ar: 'ستدفع بعدها {total} من محفظتك في Levonis. حتى تدفع، يحجز الطلب المخزون لوقت محدود.',
    en: 'You then pay {total} from your Levonis wallet. Until you pay, the order holds the stock for a limited time.',
    ckb: 'دواتر {total} لە جزدانەکەت لە Levonis دەدەیت. تا پارە دەدەیت، داواکارییەکە بۆ ماوەیەکی دیاریکراو کاڵاکان بۆت ڕادەگرێت.',
  },
  confirmManual: {
    ar: 'ادفع {total} في الورشة أو بالتحويل. حتى يؤكّد مدير الدفع، يحجز الطلب المخزون لوقت محدود.',
    en: 'Pay {total} at the workshop or by transfer. Until an admin confirms the payment, the order holds the stock for a limited time.',
    ckb: '{total} لە کارگە یان بە گواستنەوە بدە. تا بەڕێوەبەرێک پارەدانەکە پشتڕاست دەکاتەوە، داواکارییەکە بۆ ماوەیەکی دیاریکراو کاڵاکان ڕادەگرێت.',
  },
  confirmDeliveryFee: { ar: 'وتُضاف إليه أجرة التوصيل.', en: 'The delivery fee is added to it.', ckb: 'کرێی گەیاندنیشی دەخرێتە سەر.' },
  placed: { ar: 'قُدِّم الطلب', en: 'Order placed', ckb: 'داواکارییەکە تۆمارکرا' },
} satisfies Record<string, Tri>;

/** The customer's orders (/orders, /orders/:id): paying, cancelling, what was received. */
export const orders = {
  title: { ar: 'طلباتي', en: 'My orders', ckb: 'داواکارییەکانم' },
  subtitle: {
    ar: 'مشترياتك من الساعات والخيوط والملحقات، وأجور التوصيل.',
    en: 'Your purchases of hours, filament and accessories, and delivery fees.',
    ckb: 'کڕینەکانت لە کاتژمێر و فیلامێنت و پێداویستی، و کرێی گەیاندن.',
  },
  emptyTitle: { ar: 'لا توجد طلبات بعد', en: 'No orders yet', ckb: 'هێشتا هیچ داواکارییەک نییە' },
  emptyBody: { ar: 'ستظهر مشترياتك هنا.', en: 'Your purchases will appear here.', ckb: 'کڕینەکانت لێرە دەردەکەون.' },
  goToStore: { ar: 'إلى المتجر', en: 'Go to the store', ckb: 'بڕۆ بۆ فرۆشگا' },
  purchase: { ar: 'شراء', en: 'Purchase', ckb: 'کڕین' },
  deliveryFee: { ar: 'أجرة توصيل', en: 'Delivery fee', ckb: 'کرێی گەیاندن' },
  latestOnly: {
    ar: 'تُعرض أحدث طلباتك فقط (حتى {n}).',
    en: 'Only your latest orders are shown (up to {n}).',
    ckb: 'تەنها نوێترین داواکارییەکانت پیشان دەدرێن (تا {n}).',
  },
  orderTitle: { ar: 'الطلب', en: 'Order', ckb: 'داواکاری' },
  orderNumber: { ar: 'رقم الطلب', en: 'Order number', ckb: 'ژمارەی داواکاری' },
  placedOn: { ar: 'قُدِّم في {date}', en: 'Placed {date}', ckb: 'لە {date} تۆمارکرا' },
  placedNote: {
    ar: 'قُدِّم طلبك. ادفعه قبل أن ينتهي حجز المخزون.',
    en: 'Your order is placed. Pay it before the stock hold runs out.',
    ckb: 'داواکارییەکەت تۆمارکرا. پێش تەواوبوونی ڕاگرتنی کاڵاکان پارەکەی بدە.',
  },
  holdLeft: {
    ar: 'بقي {clock} للدفع، والمخزون محجوز لك حتى ذلك الحين',
    en: '{clock} left to pay; the stock is held for you until then',
    ckb: '{clock} ماوە بۆ پارەدان؛ تا ئەو کاتە کاڵاکان بۆت ڕاگیراون',
  },
  holdUntil: { ar: 'المخزون محجوز لك حتى {date}', en: 'The stock is held for you until {date}', ckb: 'کاڵاکان تا {date} بۆت ڕاگیراون' },
  holdPassedTitle: { ar: 'انتهى وقت الدفع', en: 'The time to pay has run out', ckb: 'کاتی پارەدان تەواو بوو' },
  holdPassedBody: {
    ar: 'سيُلغى هذا الطلب ويعود مخزونه إلى الرف. قدّم طلبًا جديدًا لشراء هذه الأصناف.',
    en: 'This order will be cancelled and its stock returned to the shelf. Place a new order to buy these items.',
    ckb: 'ئەم داواکارییە هەڵدەوەشێنرێتەوە و کاڵاکانی دەگەڕێنەوە بۆ ڕەفە. داواکارییەکی نوێ تۆمار بکە بۆ کڕینی ئەم کاڵایانە.',
  },
  payTitle: { ar: 'ادفع هذا الطلب', en: 'Pay this order', ckb: 'پارەی ئەم داواکارییە بدە' },
  payWallet: { ar: 'ادفع {total} من محفظتك', en: 'Pay {total} from your wallet', ckb: '{total} لە جزدانەکەت بدە' },
  payConfirmTitle: { ar: 'دفع {total} من محفظتك في Levonis؟', en: 'Pay {total} from your Levonis wallet?', ckb: '{total} لە جزدانەکەت لە Levonis بدرێت؟' },
  payConfirmBody: {
    ar: 'رصيدك الآن {balance}. يُخصم المبلغ مرة واحدة، ثم يُؤكَّد الطلب وتُضاف ساعاته وموادّه إلى حسابك.',
    en: 'Your balance is {balance} now. The amount is taken once, then the order is confirmed and its hours and materials are added to your account.',
    ckb: 'باڵانسی ئێستات: {balance}. بڕەکە یەک جار دەبڕدرێت، پاشان داواکارییەکە پشتڕاست دەکرێتەوە و کاتژمێر و کەرەستەکانی بۆ هەژمارەکەت زیاد دەکرێن.',
  },
  payConfirmPlain: {
    ar: 'يُخصم المبلغ مرة واحدة، ثم يُؤكَّد الطلب وتُضاف ساعاته وموادّه إلى حسابك.',
    en: 'The amount is taken once, then the order is confirmed and its hours and materials are added to your account.',
    ckb: 'بڕەکە یەک جار دەبڕدرێت، پاشان داواکارییەکە پشتڕاست دەکرێتەوە و کاتژمێر و کەرەستەکانی بۆ هەژمارەکەت زیاد دەکرێن.',
  },
  payNow: { ar: 'ادفع الآن', en: 'Pay now', ckb: 'ئێستا پارە بدە' },
  paid: { ar: 'دُفع الطلب وأُكِّد', en: 'Paid — your order is confirmed', ckb: 'پارەکەی درا و داواکارییەکە پشتڕاستکرایەوە' },
  insufficientTitle: { ar: 'رصيد محفظتك لا يكفي', en: 'Not enough in your wallet', ckb: 'باڵانسی جزدانەکەت بەس نییە' },
  insufficientBody: {
    ar: 'في محفظتك {available}، ويحتاج هذا الطلب {required}. لم يُخصم أي مبلغ.',
    en: 'Your wallet has {available}; this order needs {required}. Nothing was charged.',
    ckb: 'لە جزدانەکەتدا {available} هەیە و ئەم داواکارییە پێویستی بە {required} هەیە. هیچ پارەیەک نەبڕدرا.',
  },
  notPayableAlreadyPaid: { ar: 'هذا الطلب مدفوع مسبقًا.', en: 'This order is already paid.', ckb: 'پارەی ئەم داواکارییە پێشتر دراوە.' },
  notPayableCancelled: { ar: 'أُلغي هذا الطلب.', en: 'This order was cancelled.', ckb: 'ئەم داواکارییە هەڵوەشێنرایەوە.' },
  notPayableExpired: { ar: 'انتهى وقت دفع هذا الطلب.', en: 'The time to pay this order has run out.', ckb: 'کاتی پارەدانی ئەم داواکارییە تەواو بوو.' },
  notPayableShipment: { ar: 'لم يعد هذا التوصيل بانتظار أجرته.', en: 'This delivery no longer waits for its fee.', ckb: 'ئەم گەیاندنە ئیتر چاوەڕێی کرێکەی نییە.' },
  refreshBalance: { ar: 'تحديث الرصيد', en: 'Refresh balance', ckb: 'نوێکردنەوەی باڵانس' },
  manualTitle: { ar: 'الدفع في الورشة أو بالتحويل', en: 'Pay at the workshop or by transfer', ckb: 'پارەدان لە کارگە یان بە گواستنەوە' },
  manualBody: {
    ar: 'ادفع {total} نقدًا في الورشة أو بتحويل مصرفي مع ذكر رقم الطلب أدناه. يؤكّد أحد المدراء دفعتك، ثم يُنفَّذ الطلب.',
    en: 'Pay {total} in cash at the workshop or by bank transfer, quoting the order number below. An admin confirms your payment, and the order is then fulfilled.',
    ckb: '{total} بە پارەی نەقد لە کارگە یان بە گواستنەوەی بانکی بدە و ژمارەی داواکارییەکەی خوارەوە بنووسە. بەڕێوەبەرێک پارەدانەکەت پشتڕاست دەکاتەوە، پاشان داواکارییەکە جێبەجێ دەکرێت.',
  },
  cancelOrder: { ar: 'إلغاء الطلب', en: 'Cancel order', ckb: 'هەڵوەشاندنەوەی داواکاری' },
  cancelTitle: { ar: 'إلغاء هذا الطلب؟', en: 'Cancel this order?', ckb: 'ئەم داواکارییە هەڵبوەشێنرێتەوە؟' },
  cancelBody: {
    ar: 'يعود المخزون المحجوز له إلى الرف. لم يُخصم أي مبلغ.',
    en: 'The stock held for it goes back on the shelf. Nothing has been charged.',
    ckb: 'ئەو کاڵایانەی بۆی ڕاگیرابوون دەگەڕێنەوە بۆ ڕەفە. هیچ پارەیەک نەبڕدراوە.',
  },
  cancelBodyShipping: {
    ar: 'يُلغى معه طلب التوصيل أيضًا، وتبقى المطبوعات والمواد في الورشة. لم يُخصم أي مبلغ.',
    en: 'This also cancels the delivery request; the prints and material stay at the workshop. Nothing has been charged.',
    ckb: 'داوای گەیاندنەکەش لەگەڵیدا هەڵدەوەشێتەوە؛ چاپەکان و کەرەستەکان لە کارگە دەمێننەوە. هیچ پارەیەک نەبڕدراوە.',
  },
  keepOrder: { ar: 'الإبقاء على الطلب', en: 'Keep order', ckb: 'داواکارییەکە بهێڵەرەوە' },
  cancelled: { ar: 'أُلغي الطلب', en: 'Order cancelled', ckb: 'داواکارییەکە هەڵوەشێنرایەوە' },
  linesTitle: { ar: 'ما طلبته', en: 'What you ordered', ckb: 'ئەوەی داوات کرد' },
  summaryTitle: { ar: 'الملخّص', en: 'Summary', ckb: 'کورتە' },
  paidAmount: { ar: 'المدفوع', en: 'Paid', ckb: 'دراو' },
  refundedAmount: { ar: 'المُعاد', en: 'Refunded', ckb: 'گەڕێندراوە' },
  paymentsTitle: { ar: 'المدفوعات', en: 'Payments', ckb: 'پارەدانەکان' },
  refundsTitle: { ar: 'المبالغ المعادة', en: 'Refunds', ckb: 'گەڕاندنەوەکانی پارە' },
  refundToWallet: { ar: 'أُعيد إلى محفظتك', en: 'Returned to your wallet', ckb: 'گەڕێندرایەوە بۆ جزدانەکەت' },
  refundRecorded: {
    ar: 'سُجّل، ويُعاد المبلغ خارج النظام',
    en: 'Recorded; the money is returned outside the system',
    ckb: 'تۆمارکرا؛ پارەکە لە دەرەوەی سیستەم دەگەڕێندرێتەوە',
  },
  grantedTitle: { ar: 'أُضيف إلى حسابك', en: 'Added to your account', ckb: 'زیادکرا بۆ هەژمارەکەت' },
  grantedHours: { ar: '{hours} من ساعات {class}', en: '{hours} of {class} hours', ckb: '{hours} لە کاتژمێرەکانی {class}' },
  grantedKept: { ar: '{qty} من {name}، محفوظة لك في الورشة', en: '{qty} of {name}, kept for you at the workshop', ckb: '{qty} لە {name}، لە کارگە بۆت هەڵگیراوە' },
  grantedDelivered: { ar: '{qty} من {name}، في طريقها إليك', en: '{qty} of {name}, on its way to you', ckb: '{qty} لە {name}، لە ڕێگادایە بۆت' },
  grantedProject: { ar: '{qty} من {name}، مخصّصة لمشروعك', en: '{qty} of {name}, set aside for your project', ckb: '{qty} لە {name}، بۆ پرۆژەکەت جیاکراوەتەوە' },
  includedItem: { ar: 'ضمن الباقة: {qty} من {name}', en: 'Included: {qty} of {name}', ckb: 'لەگەڵ پاکێجەکە: {qty} لە {name}' },
  validDays: { ar: 'صالحة لمدة {days} من الدفع', en: 'Valid for {days} from payment', ckb: 'بۆ {days} لە پارەدانەوە بەکاردێت' },
  followDelivery: { ar: 'تابع التوصيل', en: 'Follow the delivery', ckb: 'بەدواداچوونی گەیاندن' },
  deliveryTo: { ar: 'التوصيل إلى', en: 'Delivered to', ckb: 'دەگەیەندرێت بۆ' },
  notFoundTitle: { ar: 'لم يُعثر على هذا الطلب', en: 'This order was not found', ckb: 'ئەم داواکارییە نەدۆزرایەوە' },
} satisfies Record<string, Tri>;

/** What an order line is (pc_order_lines.kind), and a count beside it. */
export const lineKind = {
  credit_package: { ar: 'باقة ساعات طباعة', en: 'Printing hours package', ckb: 'پاکێجی کاتژمێری چاپ' },
  credit_hours: { ar: 'ساعات طباعة', en: 'Printing hours', ckb: 'کاتژمێری چاپ' },
  material: { ar: 'مادة', en: 'Material', ckb: 'کەرەستە' },
  shipping_fee: { ar: 'أجرة التوصيل', en: 'Delivery fee', ckb: 'کرێی گەیاندن' },
  count: { ar: 'العدد: {n}', en: 'Qty: {n}', ckb: 'ژمارە: {n}' },
} satisfies Record<string, Tri>;

/** An order's state as the customer reads it (pc_orders.status). */
export const orderStatus = {
  awaiting_payment: { ar: 'بانتظار الدفع', en: 'Awaiting payment', ckb: 'چاوەڕێی پارەدان' },
  fulfilled: { ar: 'مدفوع ومُنفَّذ', en: 'Paid and fulfilled', ckb: 'پارەی دراوە و جێبەجێکرا' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', ckb: 'هەڵوەشێنراوە' },
  expired: { ar: 'انتهى دون دفع', en: 'Expired unpaid', ckb: 'بەبێ پارەدان بەسەرچوو' },
  refunded: { ar: 'مُعاد بالكامل', en: 'Refunded', ckb: 'هەمووی گەڕێندرایەوە' },
  partially_refunded: { ar: 'مُعاد جزئيًا', en: 'Partly refunded', ckb: 'بەشێکی گەڕێندرایەوە' },
} satisfies Record<string, Tri>;

/** How an order is (or was) paid (pc_orders.payment_method, pc_payments.provider). */
export const paymentMethod = {
  levonis_wallet: { ar: 'محفظة Levonis', en: 'Levonis wallet', ckb: 'جزدانی Levonis' },
  manual: { ar: 'في الورشة أو بالتحويل', en: 'At the workshop or by transfer', ckb: 'لە کارگە یان بە گواستنەوە' },
  gateway: { ar: 'دفع إلكتروني', en: 'Online payment', ckb: 'پارەدانی ئەلیکترۆنی' },
  dev: { ar: 'دفعة تجريبية', en: 'Test payment', ckb: 'پارەدانی تاقیکاری' },
} satisfies Record<string, Tri>;

/** A payment row's state (pc_payments.status). */
export const paymentState = {
  pending: { ar: 'بانتظار التأكيد', en: 'Waiting for confirmation', ckb: 'چاوەڕێی پشتڕاستکردنەوە' },
  confirmed: { ar: 'مؤكَّدة', en: 'Confirmed', ckb: 'پشتڕاستکراوە' },
  rejected: { ar: 'لم تُستخدم', en: 'Not used', ckb: 'بەکارنەهات' },
} satisfies Record<string, Tri>;

/** The delivery address form (the server's fields, worker/lib/printCloud/shipments.ts `parseAddress`). */
export const address = {
  recipient: { ar: 'اسم المستلم', en: 'Recipient name', ckb: 'ناوی وەرگر' },
  phone: { ar: 'رقم الهاتف', en: 'Phone number', ckb: 'ژمارەی تەلەفۆن' },
  phoneHint: { ar: 'أرقام فقط، ويمكن أن يبدأ بـ +', en: 'Digits only; it may start with +', ckb: 'تەنها ژمارە؛ دەتوانێت بە + دەست پێبکات' },
  governorate: { ar: 'المحافظة', en: 'Governorate', ckb: 'پارێزگا' },
  chooseGovernorate: { ar: 'اختر المحافظة', en: 'Choose a governorate', ckb: 'پارێزگایەک هەڵبژێرە' },
  city: { ar: 'المدينة', en: 'City', ckb: 'شار' },
  line: { ar: 'العنوان', en: 'Address', ckb: 'ناونیشان' },
  notes: { ar: 'ملاحظات لمندوب التوصيل (اختياري)', en: 'Notes for the courier (optional)', ckb: 'تێبینی بۆ گەیەنەر (ئارەزوومەندانە)' },
  required: { ar: 'هذا الحقل مطلوب', en: 'This field is required', ckb: 'ئەم خانەیە پێویستە' },
} satisfies Record<string, Tri>;
