/**
 * THE WORKSPACE SHELL'S WORDS.
 *
 * Sorani is never machine-written (docs/DECISIONS.md row 11). Every `ckb`
 * below already existed, hand-written, elsewhere in the repo and is copied
 * verbatim: the tab names from the dashboard page this shell replaces
 * (src/pages/MerchantDashboardPage.tsx before W3-A), the sidebar words from
 * src/components/DashboardLayout.tsx, the store-status reasons from
 * src/components/merchant/StoreCta.tsx `reasonText`, the order states from
 * src/components/merchant/dashboard/SalesTabs.tsx `statusLabel`. A phrase
 * nobody has written in Sorani carries only ar/en — `loc` then shows the
 * Arabic — and says so: `// OWNER: Sorani to be written by hand.`
 */
export type Loc = (ar: string, en: string, ckb?: string) => string;

/** A label as its three hand-written spellings (ckb absent = not written yet). */
export type Words = readonly [ar: string, en: string, ckb?: string];

export const say = (loc: Loc, w: Words): string => loc(w[0], w[1], w[2]);

export const W = {
  // ---- navigation (the dashboard's own tab names, verbatim)
  overview: ['نظرة عامة', 'Overview', 'گشتی'],
  orders: ['الطلبات', 'Orders', 'داواکاری'],
  customOrders: ['طلبات مخصصة', 'Custom orders', 'داواکاری تایبەت'],
  customers: ['العملاء', 'Customers', 'کڕیاران'],
  coupons: ['الكوبونات', 'Coupons', 'کۆبۆن'],
  products: ['المنتجات', 'Products', 'بەرهەم'],
  collections: ['الأقسام', 'Sections', 'بەشەکان'],
  services: ['الخدمات', 'Services', 'خزمەتگوزاری'],
  showcase: ['المعرض', 'Showcase', 'پیشانگا'],
  printers: ['الطابعات', 'Printers', 'چاپکەرەکان'],
  costing: ['تسعير الطباعة', 'Print costing', 'نرخی چاپ'],
  requests: ['طلبات الزبائن', 'Customer requests', 'داواکاری کڕیاران'],
  // OWNER: Sorani to be written by hand.
  storeDesign: ['تصميم المتجر', 'Store design'],
  storeSettings: ['إعداد المتجر', 'Store setup', 'ڕێکخستنی فرۆشگا'],
  delivery: ['التوصيل', 'Delivery', 'گەیاندن'],
  money: ['الأرباح', 'Earnings', 'قازانج'],
  analytics: ['تحليلات', 'Analytics', 'شیکاری'],
  reviews: ['التقييمات', 'Reviews', 'هەڵسەنگاندن'],
  inbox: ['الرسائل', 'Messages', 'نامەکان'],
  notifications: ['الإشعارات', 'Notifications', 'ئاگادارکردنەوە'],

  // ---- groups
  sales: ['المبيعات', 'Sales', 'فرۆش'],
  // OWNER: Sorani to be written by hand.
  catalogue: ['الكتالوج', 'Catalogue'],
  // OWNER: Sorani to be written by hand.
  workshop: ['الورشة', 'Workshop'],
  // OWNER: Sorani to be written by hand.
  store: ['المتجر', 'Store'],
  more: ['المزيد', 'More', 'زیاتر'],

  // ---- chrome
  search: ['بحث', 'Search', 'گەڕان'],
  // OWNER: Sorani to be written by hand.
  searchPlaceholder: ['ابحث عن طلب أو منتج أو عميل أو صفحة…', 'Search orders, products, customers, pages…'],
  create: ['إنشاء', 'Create', 'دروستکردن'],
  newProduct: ['منتج جديد', 'New product', 'بەرهەمی نوێ'],
  newCoupon: ['كوبون جديد', 'New coupon', 'کۆبۆنی نوێ'],
  // OWNER: Sorani to be written by hand.
  newCollection: ['قسم جديد', 'New section'],
  viewStore: ['عرض المتجر', 'View store', 'بینینی فرۆشگا'],
  mainMenu: ['القائمة الرئيسية', 'Main menu', 'لیستی سەرەکی'],
  collapse: ['طيّ الشريط الجانبي', 'Collapse sidebar', 'نوقاندنی لای لیست'],
  expand: ['توسيع الشريط الجانبي', 'Expand sidebar', 'فراوانکردنی لای لیست'],
  // OWNER: Sorani to be written by hand.
  goTo: ['الانتقال إلى', 'Go to'],
  // OWNER: Sorani to be written by hand.
  actions: ['إجراءات', 'Actions'],
  // OWNER: Sorani to be written by hand.
  results: ['نتائج البحث', 'Search results'],
  // OWNER: Sorani to be written by hand.
  skipToContent: ['تخطَّ إلى المحتوى', 'Skip to content'],
  // OWNER: Sorani to be written by hand.
  storeStatus: ['حالة المتجر', 'Store status'],

  // ---- store status (the pill)
  open: ['مفتوح', 'Open', 'کراوە'],
  paused: ['متوقّف', 'Paused', 'ڕاگیراوە'],
  // OWNER: Sorani to be written by hand.
  suspended: ['موقوف', 'Suspended'],
  // OWNER: Sorani to be written by hand.
  lapsed: ['PLUS منتهٍ', 'PLUS lapsed'],
  // OWNER: Sorani to be written by hand.
  restricted: ['مقيّد', 'Restricted'],
} as const satisfies Record<string, Words>;

/** Why the store cannot sell, in the merchant's words (StoreCta.tsx `reasonText`, verbatim). */
export function sellingReason(reason: string, loc: Loc): string {
  switch (reason) {
    case 'subscription_inactive':
      return loc(
        'اشتراك PLUS غير فعّال. متجرك وسجلّه محفوظان — جدّد الاشتراك للبيع من جديد.',
        'Your PLUS subscription is not active. Your store and its history are kept — renew to sell again.',
        'ئەندامێتی PLUS چالاک نییە. فرۆشگا و مێژووەکەی پارێزراون — نوێی بکەرەوە بۆ فرۆشتنەوە.'
      );
    case 'store_paused':
      return loc(
        'متجرك متوقّف مؤقتًا بطلبك. أعِد فتحه من إعدادات المتجر.',
        'You paused your store. Re-open it from store settings.',
        'فرۆشگاکەت لەلایەن خۆتەوە ڕاگیراوە. لە ڕێکخستنەکانەوە بیکەرەوە.'
      );
    case 'store_suspended':
    case 'merchant_suspended':
      return loc(
        'المتجر موقوف من إدارة Levonis. تواصل مع الدعم لمعرفة التفاصيل.',
        'This store is suspended by Levonis. Contact support for details.',
        'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە. پەیوەندی بە پشتیوانییەوە بکە.'
      );
    case 'benefit_restricted':
      return loc(
        'تم تقييد ميزة المتجر مؤقتًا. اشتراكك المدفوع لم يُلغَ — تواصل مع الدعم.',
        'The store benefit is temporarily restricted. Your paid membership is not cancelled — contact support.',
        'تایبەتمەندی فرۆشگا کاتی سنووردارکراوە. ئەندامێتییە پارەدراوەکەت هەڵنەوەشێنراوەتەوە — پەیوەندی بکە.'
      );
    case 'merchant_restricted':
      // The dashboard's restriction notice, verbatim (ar/en only there).
      // OWNER: Sorani to be written by hand.
      return loc(
        'قيّدت Levonis حسابك: متجرك ظاهر ويمكنك تعديله، لكنه لا يستقبل طلبات جديدة ولا يمكنك تقديم عروض حتى يُرفع التقييد. طلباتك الحالية وأرباحك كما هي — تواصل مع الدعم.',
        'Levonis has restricted your account: your store stays visible and editable, but it takes no new orders and you cannot make offers until the restriction is lifted. Your current orders and earnings are unaffected — contact support.'
      );
    default:
      return loc('لا يمكن البيع حاليًا.', 'Selling is not available right now.', 'لە ئێستادا فرۆشتن بەردەست نییە.');
  }
}

/** The store-order states (SalesTabs.tsx `statusLabel`, verbatim). */
export function orderStatusLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'pending': return loc('جديد', 'New', 'نوێ');
    case 'confirmed': return loc('مؤكد', 'Confirmed', 'پشتڕاستکراو');
    case 'processing': return loc('قيد التجهيز', 'Preparing', 'ئامادەکردن');
    case 'shipped': return loc('تم الشحن', 'Shipped', 'نێردرا');
    case 'delivered': return loc('تم التسليم', 'Delivered', 'گەیشت');
    case 'cancelled': return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    default: return k;
  }
}
