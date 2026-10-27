/**
 * PRINT CLOUD ADMIN — the three languages, as data.
 *
 * Every word this console shows exists in Arabic, English AND Sorani Kurdish
 * (DECISIONS row 183: a `ckb` slot never carries the Arabic). Words that name
 * a server state — a job, an order, a shipment, a printer — live here in one
 * table each, keyed by the server's own code, so a state the server adds
 * tomorrow shows its raw code (honest) instead of a wrong word, and
 * tests/printCloudAdminUi.test.ts walks every table for a Sorani that is the
 * Arabic, or that carries a letter Sorani does not write (ي ك ة ى).
 *
 * Pure data, no React: the test imports it.
 */

export type Lang = 'ar' | 'en' | 'ckb';

/** One phrase in the three languages. */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const tri = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

/** The phrase in `lang`; English when a slot is empty (never the Arabic for a Sorani reader). */
export const pick = (t: Tri | undefined, lang: Lang): string => (t ? t[lang] || t.en : '');

/** A label for a server code, or the code itself when the table does not know it. */
export function labelOf(table: Readonly<Record<string, Tri>>, code: string | null | undefined, lang: Lang): string {
  if (!code) return '—';
  return Object.prototype.hasOwnProperty.call(table, code) ? pick(table[code], lang) : code;
}

// ------------------------------------------------------------------ jobs

export const JOB_STATUS: Readonly<Record<string, Tri>> = {
  draft: tri('مسودة', 'Draft', 'ڕەشنووس'),
  uploaded: tri('الملفات مرفوعة', 'Files uploaded', 'فایلەکان بارکران'),
  analyzing: tri('قيد التقدير', 'Being estimated', 'لە خەمڵاندندایە'),
  ready: tri('جاهزة لمراجعة العميل', 'Ready for the customer’s review', 'ئامادەیە بۆ پێداچوونەوەی کڕیار'),
  awaiting_confirmation: tri('بانتظار تأكيد العميل', 'Awaiting the customer’s confirmation', 'چاوەڕێی دڵنیاکردنەوەی کڕیارە'),
  confirmed: tri('مؤكَّدة — بانتظار الموافقة', 'Confirmed — awaiting approval', 'دڵنیاکراوە — چاوەڕێی پەسەندکردنە'),
  queued: tri('في الطابور', 'Queued', 'لە ڕیزدایە'),
  preparing: tri('قيد التحضير على طابعة', 'Preparing on a printer', 'لەسەر چاپکەر ئامادە دەکرێت'),
  printing: tri('قيد الطباعة', 'Printing', 'لە چاپکردندایە'),
  paused: tri('متوقفة مؤقتاً', 'Paused', 'بۆ ماوەیەک ڕاگیراوە'),
  completed: tri('مكتملة', 'Completed', 'تەواوبوو'),
  failed: tri('فشلت', 'Failed', 'سەرکەوتوو نەبوو'),
  cancelled: tri('ملغاة', 'Cancelled', 'هەڵوەشێنرایەوە'),
  reprint_requested: tri('أُنشئت إعادة طباعتها', 'Reprint created', 'دووبارە چاپکردنەوە دروستکرا'),
};

export const QUEUE_BASIS: Readonly<Record<string, Tri>> = {
  simulated: tri('تقدير بالمحاكاة', 'Simulated estimate', 'خەمڵاندن بە لاسایی'),
  no_compatible_printer: tri('لا طابعة متوافقة الآن', 'No compatible printer now', 'ئێستا هیچ چاپکەرێکی گونجاو نییە'),
  waiting_for_dependency: tri('بانتظار مهمة تسبقها', 'Waiting for an earlier job', 'چاوەڕێی کارێکی پێشترە'),
  dependency_cannot_complete: tri('المهمة السابقة لن تكتمل', 'The earlier job cannot complete', 'کارە پێشووەکە تەواو نابێت'),
};

export const PROVENANCE: Readonly<Record<string, Tri>> = {
  slicer: tri('مُقاس بالسلايسر (وكيل الورشة)', 'Measured by the slicer (workshop agent)', 'بە سلایسەر پێوراوە (بریکاری کارگە)'),
  operator: tri('أدخله مشغّل يدوياً من سلايسر مكتبي', 'Entered by an operator from a desktop slicer', 'کارپێکەرێک بە دەست لە سلایسەرێکی سەرمێز تۆماری کردووە'),
};

export const RESPONSIBLE: Readonly<Record<string, Tri>> = {
  workshop: tri('الورشة', 'The workshop', 'کارگە'),
  customer: tri('العميل', 'The customer', 'کڕیار'),
  model: tri('ملف النموذج', 'The model file', 'فایلی مۆدێل'),
  undetermined: tri('غير محدد', 'Undetermined', 'دیاری نەکراو'),
};

export const FAILURE_POLICY: Readonly<Record<string, Tri>> = {
  no_charge: tri('بلا رسوم على العميل', 'No charge to the customer', 'هیچ پارەیەک لە کڕیار وەرناگیرێت'),
  charge_printed: tri('يُحتسب ما طُبع فقط', 'Charge only what was printed', 'تەنها ئەوەی چاپکرا حیساب دەکرێت'),
  manual_review: tri('مراجعة يدوية (مدير مالي)', 'Manual review (full admin)', 'پێداچوونەوەی دەستی (بەڕێوەبەری دارایی)'),
};

export const FAILURE_STATUS: Readonly<Record<string, Tri>> = {
  reported: tri('بانتظار القرار', 'Awaiting a decision', 'چاوەڕێی بڕیارە'),
  resolved: tri('محسوم', 'Resolved', 'یەکلاکرایەوە'),
};

export const OVERAGE: Readonly<Record<string, Tri>> = {
  cap_at_reserved: tri('لا يُحتسب أكثر مما حُجز', 'Never beyond what was reserved', 'هەرگیز زیاتر لەوەی گیرا حیساب ناکرێت'),
  charge_from_balance: tri('الزيادة من الرصيد المتاح', 'The extra from the available balance', 'زیادەکە لە باڵانسی بەردەست'),
};

// ------------------------------------------------------------------ orders and money

export const ORDER_STATUS: Readonly<Record<string, Tri>> = {
  awaiting_payment: tri('بانتظار الدفع', 'Awaiting payment', 'چاوەڕێی پارەدانە'),
  fulfilled: tri('مدفوع ومنفَّذ', 'Paid and fulfilled', 'پارەدراو و جێبەجێکراو'),
  cancelled: tri('ملغى', 'Cancelled', 'هەڵوەشێنراوە'),
  expired: tri('انتهت مهلته', 'Expired', 'بەسەرچووە'),
  refunded: tri('مسترد بالكامل', 'Refunded in full', 'بە تەواوی گەڕێنرایەوە'),
  partially_refunded: tri('مسترد جزئياً', 'Partly refunded', 'بەشێکی گەڕێنرایەوە'),
};

export const ORDER_KIND: Readonly<Record<string, Tri>> = {
  purchase: tri('شراء', 'Purchase', 'کڕین'),
  shipping: tri('رسوم توصيل', 'Delivery fee', 'کرێی گەیاندن'),
};

export const LINE_KIND: Readonly<Record<string, Tri>> = {
  credit_package: tri('باقة ساعات', 'Hour package', 'پاکێجی کاتژمێر'),
  credit_hours: tri('ساعات مخصّصة', 'Custom hours', 'کاتژمێری تایبەت'),
  material: tri('مادة', 'Material', 'کەرەستە'),
  shipping_fee: tri('رسوم توصيل', 'Delivery fee', 'کرێی گەیاندن'),
};

export const PROVIDER: Readonly<Record<string, Tri>> = {
  manual: tri('يدوي (نقد أو تحويل)', 'Manual (cash or transfer)', 'دەستی (نەقد یان گواستنەوە)'),
  gateway: tri('بوابة دفع', 'Payment gateway', 'دەروازەی پارەدان'),
  dev: tri('تطوير (تجريبي)', 'Development (test)', 'گەشەپێدان (تاقیکردنەوە)'),
  levonis_wallet: tri('محفظة Levonis', 'Levonis wallet', 'جزدانی Levonis'),
};

export const PAYMENT_OUTCOME: Readonly<Record<string, Tri>> = {
  applied: tri('طُبِّق ونُفِّذ الطلب', 'Applied — the order was fulfilled', 'جێبەجێکرا و داواکارییەکە ئەنجامدرا'),
  duplicate_event: tri('مسجَّل من قبل — لم يتغيّر شيء', 'Already recorded — nothing changed', 'پێشتر تۆمارکراوە — هیچ نەگۆڕا'),
  duplicate_order: tri('الطلب مدفوع من قبل — سُجّل لمكتب الاسترداد', 'Order already paid — recorded for the refund desk', 'داواکارییەکە پێشتر پارەی دراوە — بۆ بەشی گەڕاندنەوە تۆمارکرا'),
  amount_mismatch: tri('المبلغ لا يطابق مجموع الطلب — لم يُطبَّق', 'Amount differs from the order total — not applied', 'بڕەکە جیاوازە لە کۆی داواکاری — جێبەجێ نەکرا'),
  order_not_payable: tri('الطلب لا يقبل الدفع — لم يُطبَّق', 'The order cannot be paid — not applied', 'داواکارییەکە پارەدان وەرناگرێت — جێبەجێ نەکرا'),
  unknown_order: tri('طلب غير معروف', 'Unknown order', 'داواکاریی نەناسراو'),
  rejected_signature: tri('توقيع مرفوض', 'Signature rejected', 'واژۆ ڕەتکرایەوە'),
};

export const PAYMENT_STATUS: Readonly<Record<string, Tri>> = {
  pending: tri('معلّق', 'Pending', 'هەڵپەسێردراو'),
  confirmed: tri('مؤكَّد', 'Confirmed', 'پشتڕاستکراوە'),
  rejected: tri('مرفوض', 'Rejected', 'ڕەتکراوە'),
};

export const REFUND_STATUS: Readonly<Record<string, Tri>> = {
  recorded: tri('مسجَّل', 'Recorded', 'تۆمارکراوە'),
  paid_out: tri('دُفع للعميل', 'Paid out', 'پارەکە درا'),
};

// ------------------------------------------------------------------ fulfilment

export const SHIPMENT_STATUS: Readonly<Record<string, Tri>> = {
  awaiting_payment: tri('بانتظار دفع رسوم التوصيل', 'Awaiting the delivery fee', 'چاوەڕێی پارەدانی کرێی گەیاندنە'),
  preparing: tri('قيد التجهيز', 'Being prepared', 'ئامادە دەکرێت'),
  ready_for_pickup: tri('جاهزة للاستلام', 'Ready for pickup', 'ئامادەیە بۆ وەرگرتن'),
  shipped: tri('شُحنت', 'Shipped', 'نێردرا'),
  delivered: tri('سُلّمت', 'Delivered', 'گەیەنرا'),
  picked_up: tri('استلمها العميل', 'Picked up', 'کڕیار وەریگرت'),
  cancelled: tri('ملغاة', 'Cancelled', 'هەڵوەشێنرایەوە'),
};

export const SHIPMENT_KIND: Readonly<Record<string, Tri>> = {
  pickup: tri('استلام من الورشة', 'Pickup at the workshop', 'وەرگرتن لە کارگە'),
  delivery: tri('توصيل', 'Delivery', 'گەیاندن'),
};

export const BUYBACK_STATUS: Readonly<Record<string, Tri>> = {
  requested: tri('مطلوب', 'Requested', 'داواکراوە'),
  approved: tri('مقبول', 'Approved', 'پەسەندکرا'),
  rejected: tri('مرفوض', 'Rejected', 'ڕەتکرایەوە'),
  cancelled: tri('ألغاه العميل', 'Cancelled by the customer', 'کڕیار هەڵیوەشاندەوە'),
};

export const PAYOUT_STATUS: Readonly<Record<string, Tri>> = {
  none: tri('لا دفعة', 'No payout', 'هیچ پارەدانێک نییە'),
  pending: tri('بانتظار الدفع للعميل', 'Payout pending', 'پارەدان بە کڕیار چاوەڕێیە'),
  paid: tri('دُفع للعميل', 'Paid out', 'پارەکە درا'),
};

// ------------------------------------------------------------------ the workshop

export const PRINTER_STATUS: Readonly<Record<string, Tri>> = {
  active: tri('في الخدمة', 'In service', 'لە خزمەتدایە'),
  maintenance: tri('صيانة', 'Maintenance', 'چاکسازی'),
  retired: tri('خارج الخدمة', 'Retired', 'لە خزمەت دەرچووە'),
};

export const CONNECTIVITY: Readonly<Record<string, Tri>> = {
  manual: tri('يدوية — بلا وكيل', 'Manual — no agent', 'دەستی — بێ بریکار'),
  never_connected: tri('لم تتصل أبداً', 'Never connected', 'هەرگیز پەیوەست نەبووە'),
  offline: tri('غير متصلة', 'Offline', 'پەیوەست نییە'),
  online: tri('متصلة', 'Online', 'پەیوەستە'),
};

export const MACHINE_STATE: Readonly<Record<string, Tri>> = {
  idle: tri('خاملة', 'Idle', 'بێکار'),
  preparing: tri('تحضير', 'Preparing', 'ئامادەکردن'),
  printing: tri('تطبع', 'Printing', 'چاپ دەکات'),
  paused: tri('متوقفة', 'Paused', 'ڕاگیراوە'),
  finished: tri('انتهت — القطعة على السرير', 'Finished — the plate is on the bed', 'تەواوبوو — پارچەکە لەسەر تەختەیە'),
  error: tri('خطأ', 'Error', 'هەڵە'),
  offline: tri('لا يصلها الوكيل', 'The agent cannot reach it', 'بریکار پێی ناگات'),
};

export const MAINTENANCE_KIND: Readonly<Record<string, Tri>> = {
  scheduled: tri('مجدولة', 'Scheduled', 'خشتەکراو'),
  unscheduled: tri('طارئة', 'Unscheduled', 'لەناکاو'),
  repair: tri('إصلاح', 'Repair', 'چاککردنەوە'),
  calibration: tri('معايرة', 'Calibration', 'ڕێکخستنی ورد'),
};

export const MAINTENANCE_STATUS: Readonly<Record<string, Tri>> = {
  planned: tri('مخطَّطة', 'Planned', 'پلاندانراو'),
  done: tri('منجزة', 'Done', 'ئەنجامدرا'),
  cancelled: tri('ملغاة', 'Cancelled', 'هەڵوەشێنرایەوە'),
};

export const AGENT_CAPABILITY: Readonly<Record<string, Tri>> = {
  telemetry: tri('قراءات الطابعات', 'Printer readings', 'خوێندنەوەی چاپکەرەکان'),
  job_control: tri('التحكم بالمهام', 'Job control', 'کۆنترۆڵی کارەکان'),
  slicer: tri('التقطيع (السلايسر)', 'Slicing', 'سلایسکردن'),
  camera: tri('الكاميرا', 'Camera', 'کامێرا'),
};

export const PRINTER_COMMAND: Readonly<Record<string, Tri>> = {
  pause: tri('إيقاف مؤقت', 'Pause', 'ڕاگرتنی کاتی'),
  resume: tri('استئناف', 'Resume', 'درێژەپێدان'),
  stop: tri('إيقاف نهائي', 'Stop', 'وەستاندنی تەواو'),
  light_on: tri('تشغيل الإضاءة', 'Light on', 'هەڵکردنی ڕووناکی'),
  light_off: tri('إطفاء الإضاءة', 'Light off', 'کوژاندنەوەی ڕووناکی'),
  camera_snapshot: tri('لقطة كاميرا', 'Camera snapshot', 'وێنەی کامێرا'),
};

export const ADAPTER: Readonly<Record<string, Tri>> = {
  identity: tri('الهوية (حساب Levonis)', 'Identity (Levonis account)', 'ناسنامە (هەژماری Levonis)'),
  notification: tri('الإشعارات داخل التطبيق', 'In-app notifications', 'ئاگادارکردنەوە لەناو ئەپ'),
  wallet_payment: tri('الدفع من محفظة Levonis', 'Levonis wallet payments', 'پارەدان لە جزدانی Levonis'),
  product_catalog: tri('كتالوج منتجات Levonis', 'Levonis product catalogue', 'کاتالۆگی بەرهەمەکانی Levonis'),
  inventory: tri('مخزون Levonis', 'Levonis inventory', 'کۆگای Levonis'),
  orders: tri('سجل طلبات Levonis', 'Levonis order history', 'مێژووی داواکارییەکانی Levonis'),
  membership: tri('العضويات', 'Memberships', 'ئەندامێتییەکان'),
  accounting: tri('المحاسبة', 'Accounting', 'ژمێریاری'),
};

/**
 * What each integration does, in the reader's language (the server's own
 * `note` in worker/lib/printCloud/adapters.ts is a technical English line).
 * `wallet_payment_off` is the wallet adapter while the owner has it switched off.
 */
export const ADAPTER_NOTE: Readonly<Record<string, Tri>> = {
  identity: tri(
    'عملاء Print Cloud هم مستخدمو Levonis؛ الجلسة المشتركة تعرّفهم على كل نطاق.',
    'Customers are Levonis users; the shared session identifies them on every host.',
    'کڕیارەکانی Print Cloud بەکارهێنەرانی Levonisن؛ دانیشتنە هاوبەشەکە لەسەر هەموو دۆمەینێک دەیانناسێتەوە.'
  ),
  notification: tri('إشعارات داخل التطبيق عبر صندوق إشعارات Levonis.', 'In-app notifications through the Levonis inbox.', 'ئاگادارکردنەوەی ناو ئەپ لە ڕێگەی سندوقی ئاگادارکردنەوەکانی Levonis.'),
  wallet_payment: tri(
    'تُدفع الطلبات من محفظة العميل في Levonis: خصم واحد من رصيده القابل للصرف مع التأكيد نفسه، ويُردّ استرداد هذه الطلبات إلى المحفظة.',
    'Orders are paid from the customer’s Levonis wallet: one debit of the spendable balance with the confirmation itself; refunds of such orders are credited back to the wallet.',
    'داواکارییەکان لە جزدانی Levonis ی کڕیار دەدرێن: یەک بڕین لە باڵانسی خەرجکراو لەگەڵ هەمان پشتڕاستکردنەوە؛ گەڕاندنەوەی پارەی ئەم داواکارییانە دەچێتەوە بۆ جزدانەکە.'
  ),
  wallet_payment_off: tri(
    'مبنيّ لكن المالك أوقفه: الدفعات الجديدة من المحفظة تُرفض، أما استرداد الطلبات المدفوعة من المحفظة فيعود إليها كما هو.',
    'Built, but switched off by the owner: new wallet payments are refused; refunds of orders already paid from the wallet still go back to it.',
    'دروستکراوە، بەڵام خاوەن کوژاندوویەتییەوە: پارەدانی نوێ لە جزدان ڕەت دەکرێتەوە؛ گەڕاندنەوەی پارەی ئەو داواکارییانەی لە جزدان دراون هەر بۆ جزدانەکە دەچێتەوە.'
  ),
  product_catalog: tri(
    'قد يحمل منتج Print Cloud رقم منتج في Levonis كرابط فقط؛ لا مزامنة.',
    'A Print Cloud product may carry a Levonis product id as a link only; no sync.',
    'بەرهەمێکی Print Cloud دەتوانێت ژمارەی بەرهەمێکی Levonis تەنها وەک بەستەر هەڵبگرێت؛ هاوکاتکردن نییە.'
  ),
  inventory: tri(
    'يحتفظ Print Cloud بسجل مستودعه الخاص إلى أن يُربط بمخزون Levonis.',
    'Print Cloud keeps its own warehouse ledger until it is integrated with the Levonis inventory.',
    'Print Cloud تۆماری کۆگای خۆی دەپارێزێت تا لەگەڵ کۆگای Levonis دەبەسترێتەوە.'
  ),
  orders: tri('أحداث الطلبات تنتظر في الطابور إلى أن يُربط المحوّل.', 'Order events are queued until the adapter is connected.', 'ڕووداوەکانی داواکاری لە ڕیزدا دەمێننەوە تا ئەداپتەرەکە دەبەسترێت.'),
  membership: tri('العروض المقصورة على عضوية لا تُطبَّق قبل الربط.', 'Membership-limited promotions do not apply until connected.', 'ئەو پرۆمۆشنانەی تایبەتن بە ئەندامێتی تا بەستنەوە جێبەجێ نابن.'),
  accounting: tri('أحداث المحاسبة تنتظر في الطابور إلى أن يُربط المحوّل.', 'Accounting events are queued until the adapter is connected.', 'ڕووداوەکانی ژمێریاری لە ڕیزدا دەمێننەوە تا ئەداپتەرەکە دەبەسترێت.'),
};

export const OUTBOX_STATUS: Readonly<Record<string, Tri>> = {
  pending: tri('بانتظار ربط المحوّل', 'Waiting for the adapter', 'چاوەڕێی بەستنەوەی ئەداپتەرە'),
  delivered: tri('سُلّمت', 'Delivered', 'گەیەنرا'),
  failed: tri('فشلت', 'Failed', 'سەرکەوتوو نەبوو'),
  skipped: tri('تُجوهلت', 'Skipped', 'پشتگوێخرا'),
};

export const SLICER_STATE: Readonly<Record<string, Tri>> = {
  connected: tri('متصل', 'Connected', 'پەیوەستە'),
  stale: tri('صامت منذ مدة (قديم)', 'Silent for a while (stale)', 'ماوەیەکە بێدەنگە (کۆن)'),
  never_connected: tri('رمزه أُنشئ لكنه لم يتصل أبداً', 'Token issued, never connected', 'تۆکنەکەی دروستکراوە بەڵام هەرگیز پەیوەست نەبووە'),
  not_connected: tri('غير متصل', 'Not connected', 'پەیوەست نییە'),
};

// ------------------------------------------------------------------ background work

export const TASK_KIND: Readonly<Record<string, Tri>> = {
  analyze_model_file: tri('تحليل ملف نموذج', 'Analyse a model file', 'شیکردنەوەی فایلی مۆدێل'),
  import_model_url: tri('استيراد نموذج من رابط', 'Import a model from a link', 'هاوردەکردنی مۆدێل لە بەستەر'),
  expire_orders: tri('إنهاء الطلبات غير المدفوعة', 'Expire unpaid orders', 'بەسەربردنی داواکارییە پارە نەدراوەکان'),
  expire_credit_lots: tri('إنهاء الساعات المنتهية', 'Expire lapsed hours', 'بەسەربردنی کاتژمێرە بەسەرچووەکان'),
  low_inventory_scan: tri('فحص انخفاض أرصدة العملاء', 'Scan low customer balances', 'پشکنینی کەمیی باڵانسی کڕیاران'),
  schedule_queue: tri('جدولة الطابور', 'Schedule the queue', 'خشتەکردنی ڕیز'),
  slicing_lease_sweep: tri('تحرير مهام التقطيع العالقة', 'Release stuck slicing work', 'ئازادکردنی کاری سلایسی گیراو'),
  reconcile: tri('المطابقة اليومية', 'Daily reconciliation', 'هاوتاکردنی ڕۆژانە'),
};

export const TASK_STATUS: Readonly<Record<string, Tri>> = {
  queued: tri('في الانتظار', 'Queued', 'لە چاوەڕوانیدایە'),
  running: tri('قيد التنفيذ', 'Running', 'لە کاردایە'),
  succeeded: tri('نجحت', 'Succeeded', 'سەرکەوتوو بوو'),
  failed: tri('فشلت — ستُعاد', 'Failed — will retry', 'سەرکەوتوو نەبوو — دووبارە دەکرێتەوە'),
  dead: tri('توقفت نهائياً', 'Gave up', 'بە تەواوی وەستا'),
};

export const RECONCILE_CHECK: Readonly<Record<string, Tri>> = {
  credit_accounts_equal_ledger: tri('أرصدة الساعات تساوي سجلها', 'Hour balances equal their ledger', 'باڵانسی کاتژمێرەکان یەکسانە بە تۆمارەکەیان'),
  credit_lots_cover_balance: tri('دفعات الساعات تغطي الرصيد', 'Hour lots cover the balance', 'کۆمەڵەکانی کاتژمێر باڵانسەکە دادەپۆشن'),
  credit_lots_equal_their_draws: tri('دفعات الساعات تساوي سحوباتها', 'Hour lots equal their draws', 'کۆمەڵەکانی کاتژمێر یەکسانن بە ڕاکێشانەکانیان'),
  credit_reservations_equal_their_holds: tri('حجوزات الساعات تساوي ما تحجزه على الدفعات', 'Hour reservations equal their lot holds', 'گلدانەوەی کاتژمێر یەکسانە بە گیراوەکانی سەر کۆمەڵەکان'),
  credit_lot_holds_equal_active_reservations: tri('المحجوز على الدفعات يساوي الحجوزات النشطة', 'Lot holds equal the active reservations', 'گیراوی سەر کۆمەڵەکان یەکسانە بە گلدانەوە چالاکەکان'),
  credit_reservations_equal_reserved: tri('الحجوزات تساوي الساعات المحجوزة', 'Reservations equal the reserved hours', 'گلدانەوەکان یەکسانن بە کاتژمێرە گیراوەکان'),
  inventory_accounts_equal_ledger: tri('أرصدة المواد تساوي سجلها', 'Material balances equal their ledger', 'باڵانسی کەرەستەکان یەکسانە بە تۆمارەکەیان'),
  inventory_lots_cover_balance: tri('دفعات المواد تغطي الرصيد', 'Material lots cover the balance', 'کۆمەڵەکانی کەرەستە باڵانسەکە دادەپۆشن'),
  inventory_lots_equal_their_draws: tri('دفعات المواد تساوي سحوباتها', 'Material lots equal their draws', 'کۆمەڵەکانی کەرەستە یەکسانن بە ڕاکێشانەکانیان'),
  inventory_reservations_equal_reserved: tri('حجوزات المواد تساوي المحجوز', 'Material reservations equal what is reserved', 'گلدانەوەی کەرەستە یەکسانە بە گیراوەکە'),
  warehouse_positions_equal_ledger: tri('أرصدة المستودع تساوي سجلها', 'Warehouse positions equal their ledger', 'بارودۆخی کۆگا یەکسانە بە تۆمارەکەی'),
  warehouse_lots_equal_on_hand: tri('دفعات المستودع تساوي الموجود', 'Warehouse lots equal what is on hand', 'کۆمەڵەکانی کۆگا یەکسانن بەوەی بەردەستە'),
  stock_lots_equal_their_draws: tri('دفعات المخزون تساوي سحوباتها', 'Stock lots equal their draws', 'کۆمەڵەکانی کۆگا یەکسانن بە ڕاکێشانەکانیان'),
  allocations_equal_customer_ownership: tri('المخصّص يساوي ما يملكه العملاء', 'Allocations equal customer ownership', 'تەرخانکراو یەکسانە بە موڵکی کڕیاران'),
  order_holds_equal_reserved_stock: tri('حجوزات الطلبات تساوي المخزون المحجوز', 'Order holds equal the held stock', 'گلدانەوەی داواکارییەکان یەکسانە بە کۆگای گیراو'),
  no_stock_deficit: tri('لا عجز في المخزون', 'No stock deficit', 'هیچ کەمییەکی کۆگا نییە'),
  reservations_belong_to_live_jobs: tri('الحجوزات تخص مهاماً حية', 'Reservations belong to live jobs', 'گلدانەوەکان هی کارە زیندووەکانن'),
  reserved_jobs_hold_their_credits: tri('المهام المحجوزة تحتفظ بساعاتها', 'Reserved jobs hold their hours', 'کارە گیراوەکان کاتژمێرەکانیان هەڵگرتووە'),
  one_active_assignment_per_printer_and_job: tri('تعيين نشط واحد لكل طابعة ومهمة', 'One active assignment per printer and job', 'یەک دیاریکردنی چالاک بۆ هەر چاپکەر و کارێک'),
  active_assignments_match_jobs_on_the_floor: tri('التعيينات النشطة تطابق المهام على الطابعات', 'Active assignments match jobs on machines', 'دیاریکردنە چالاکەکان لەگەڵ کارەکانی سەر ئامێرەکان دەگونجێن'),
  fulfilled_orders_have_one_confirmed_payment: tri('لكل طلب منفَّذ دفعة مؤكدة واحدة', 'Every fulfilled order has one confirmed payment', 'هەر داواکارییەکی جێبەجێکراو یەک پارەدانی پشتڕاستکراوی هەیە'),
  payments_needing_refund: tri('مدفوعات تحتاج استرداداً', 'Payments that need a refund', 'ئەو پارەدانانەی پێویستیان بە گەڕاندنەوەیە'),
  customer_usage_left_the_shelf: tri('ما استهلكه العملاء خرج من الرف', 'Customer usage left the shelf', 'بەکارهێنانی کڕیاران لە ڕەفەکە دەرچوو'),
  wallet_payments_match_the_wallet: tri('مدفوعات المحفظة تطابق محفظة Levonis', 'Wallet payments match the Levonis wallet', 'پارەدانەکانی جزدان لەگەڵ جزدانی Levonis دەگونجێن'),
};

// ------------------------------------------------------------------ refusals

/**
 * The machine-readable `details.reason` of a refusal, in words. The server's
 * own sentence (`details.messages`) always leads; this only names WHY when
 * the server said so in a code.
 */
export const REASON: Readonly<Record<string, Tri>> = {
  required: tri('مطلوب', 'required', 'پێویستە'),
  too_small: tri('أصغر من المسموح', 'below the minimum', 'لە کەمترین بڕ کەمترە'),
  too_large: tri('أكبر من المسموح', 'above the maximum', 'لە زۆرترین بڕ زیاترە'),
  too_long: tri('نص أطول من المسموح', 'text too long', 'دەقەکە زۆر درێژە'),
  out_of_range: tri('خارج المدى المسموح', 'out of the allowed range', 'لە دەرەوەی مەودای ڕێگەپێدراوە'),
  code_format: tri('الرمز: أحرف لاتينية وأرقام و . _ - فقط', 'code: Latin letters, digits and . _ - only', 'کۆد: تەنها پیتی لاتینی و ژمارە و . _ -'),
  integer_required: tri('يجب أن يكون عدداً صحيحاً', 'must be a whole number', 'دەبێت ژمارەیەکی تەواو بێت'),
  boolean_required: tri('يجب أن يكون نعم أو لا', 'must be yes or no', 'دەبێت بەڵێ یان نەخێر بێت'),
  not_allowed: tri('قيمة غير مسموحة', 'value not allowed', 'بەهایەکی ڕێگەپێنەدراوە'),
  object_required: tri('بنية غير صحيحة', 'wrong structure', 'پێکهاتەیەکی هەڵە'),
  array_required: tri('يجب أن تكون قائمة', 'must be a list', 'دەبێت لیست بێت'),
  iso_date_required: tri('تاريخ غير صالح', 'invalid date', 'بەروارێکی نادروست'),
  null_not_allowed: tri('لا يمكن تركه فارغاً', 'cannot be left empty', 'ناتوانرێت بەتاڵ بهێڵدرێت'),
  unknown_field: tri('حقل غير معروف', 'unknown field', 'خانەیەکی نەناسراو'),
  immutable: tri('لا يتغيّر بعد الإنشاء', 'cannot change after creation', 'دوای دروستکردن ناگۆڕدرێت'),
  reference: tri('مرجع غير صالح', 'invalid reference', 'سەرچاوەیەکی نادروست'),
  unknown_reference: tri('يشير إلى سجل غير موجود', 'points to a record that does not exist', 'ئاماژە بە تۆمارێک دەکات کە بوونی نییە'),
  format: tri('صيغة غير صحيحة', 'wrong format', 'شێوازێکی هەڵە'),
  no_discount: tri('حدّد نسبة أو مبلغ خصم', 'set a percentage or an amount off', 'ڕێژە یان بڕێکی داشکاندن دیاری بکە'),
  below_min: tri('الأقصى أقل من الأدنى', 'the maximum is below the minimum', 'زۆرترین لە کەمترین کەمترە'),
  duplicate: tri('مكرر — موجود من قبل', 'duplicate — already exists', 'دووبارەیە — پێشتر هەیە'),
  zero: tri('لا يمكن أن يكون صفراً', 'cannot be zero', 'ناتوانێت سفر بێت'),
  empty: tri('لا تغيير لحفظه', 'nothing to save', 'هیچ گۆڕانکارییەک نییە بۆ پاشەکەوت'),
  unknown_setting: tri('إعداد غير معروف', 'unknown setting', 'ڕێکخستنێکی نەناسراو'),
  invalid_value: tri('قيمة غير صالحة', 'invalid value', 'بەهایەکی نادروست'),
  too_many: tri('عدد أكبر من المسموح', 'too many', 'ژمارەکە زۆر زیاترە'),
  constraint: tri('ترفضه قاعدة البيانات', 'refused by the database rules', 'یاساکانی بنکەدراوە ڕەتیدەکەنەوە'),
  must_follow_starts_at: tri('النهاية يجب أن تأتي بعد البداية', 'the end must come after the start', 'کۆتایی دەبێت دوای دەستپێک بێت'),
  financial_scope_required: tri('يحتاج مديراً مالياً', 'needs a full (money) admin', 'پێویستی بە بەڕێوەبەری دارایی هەیە'),
  cost_owner_only: tri('التكلفة للمالك وحده', 'cost is the owner’s alone', 'تێچوو تەنها هی خاوەنە'),
  not_assigned: tri('المهمة ليست على طابعة', 'the job is not on a printer', 'کارەکە لەسەر هیچ چاپکەرێک نییە'),
  manual_printer_has_no_agent: tri('طابعة يدوية بلا وكيل', 'a manual printer has no agent', 'چاپکەری دەستی بریکاری نییە'),
  already_resolved: tri('حُسم من قبل', 'already resolved', 'پێشتر یەکلاکراوەتەوە'),
  required_for_manual_review: tri('المراجعة اليدوية تحتاج المحتسَب', 'manual review needs the billable amounts', 'پێداچوونەوەی دەستی پێویستی بە بڕی حیسابکراو هەیە'),
  variant_not_assigned_to_job: tri('المادة ليست من مواد هذه المهمة', 'the material is not one of this job’s', 'ئەم کەرەستەیە هی ئەم کارە نییە'),
  dependency_cannot_complete: tri('المهمة السابقة لن تكتمل', 'the earlier job cannot complete', 'کارە پێشووەکە تەواو نابێت'),
  paid_through_the_fee_order: tri('ينتقل بدفع رسوم التوصيل فقط', 'moves only when its delivery fee is paid', 'تەنها بە پارەدانی کرێی گەیاندن دەجووڵێت'),
  not_a_pickup: tri('ليست شحنة استلام', 'not a pickup', 'ئەمە وەرگرتن نییە'),
  not_a_delivery: tri('ليست شحنة توصيل', 'not a delivery', 'ئەمە گەیاندن نییە'),
  cost_already_recorded: tri('سُجّلت التكلفة من قبل بقيمة أخرى', 'a different cost is already recorded', 'تێچوویەکی تر پێشتر تۆمارکراوە'),
  append_only: tri('سجل لا يُعدَّل', 'an append-only record', 'تۆمارێکە دەستکاری ناکرێت'),
  lot_missing: tri('دفعة الشراء غير موجودة', 'the purchase lot is missing', 'کۆمەڵەی کڕینەکە نییە'),
  in_the_past: tri('في الماضي', 'in the past', 'لە ڕابردوودایە'),
  other_model: tri('طابعة من طراز آخر', 'a printer of another model', 'چاپکەرێکی مۆدێلێکی تر'),
  printer_maintenance: tri('الطابعة في الصيانة', 'printer in maintenance', 'چاپکەر لە چاکسازیدایە'),
  printer_retired: tri('الطابعة خارج الخدمة', 'printer retired', 'چاپکەر لە خزمەت دەرچووە'),
  printer_busy: tri('الطابعة مشغولة بمهمة أخرى', 'printer busy with another job', 'چاپکەر بە کارێکی ترەوە سەرقاڵە'),
  nozzle_mismatch: tri('قطر الفوهة لا يطابق', 'nozzle does not match', 'نۆزڵەکە ناگونجێت'),
  material_not_loadable: tri('المادة غير محمّلة عليها', 'material not loadable on it', 'کەرەستەکە لەسەری بار ناکرێت'),
  not_enough_ams_slots: tri('خانات الألوان لا تكفي', 'not enough colour slots', 'خانەکانی ڕەنگ بەس نین'),
  maintenance_window: tri('نافذة صيانة قريبة', 'a maintenance window is due', 'کاتی چاکسازییەک نزیکە'),
  printer_reports_error: tri('الطابعة تبلّغ عن خطأ', 'the printer reports an error', 'چاپکەرەکە هەڵەیەک ڕادەگەیەنێت'),
  telemetry_stale: tri('قراءاتها قديمة', 'its readings are stale', 'خوێندنەوەکانی کۆنن'),
  printer_offline: tri('الوكيل لا يصلها', 'the agent cannot reach it', 'بریکار پێی ناگات'),
  printer_occupied: tri('تطبع شيئاً لم يرسله النظام', 'printing something the cloud did not send', 'شتێک چاپ دەکات کە سیستەم نەیناردووە'),
  model_exceeds_build_volume: tri('النموذج أكبر من منطقة الطباعة', 'the model exceeds the build volume', 'مۆدێلەکە لە ناوچەی چاپ گەورەترە'),
  duplicate_variant: tri('المادة نفسها مذكورة مرتين', 'the same material is listed twice', 'هەمان کەرەستە دوو جار نووسراوە'),
  not_a_string: tri('يجب أن يكون نصاً', 'must be text', 'دەبێت دەق بێت'),
  material_not_supported: tri('الطابعة لا تدعم هذه المادة', 'the printer does not support this material', 'چاپکەرەکە پشتگیری ئەم کەرەستەیە ناکات'),
  holds_do_not_cover_reservation: tri('المحجوز على الدفعات لا يغطي الحجز', 'the lot holds do not cover the reservation', 'گیراوی سەر کۆمەڵەکان گلدانەوەکە داناپۆشێت'),
  lots_do_not_cover_balance: tri('الدفعات لا تغطي الرصيد', 'the lots do not cover the balance', 'کۆمەڵەکان باڵانسەکە داناپۆشن'),
  reservation_missing: tri('الحجز غير موجود', 'the reservation is missing', 'گلدانەوەکە نییە'),
  shipment_not_awaiting_payment: tri('الشحنة لا تنتظر دفعاً', 'the shipment is not awaiting payment', 'ناردنەکە چاوەڕێی پارەدان نییە'),
  fulfilment_refused: tri('تعذّر تنفيذ الطلب بعد الدفع', 'the order could not be fulfilled after payment', 'داواکارییەکە دوای پارەدان جێبەجێ نەکرا'),
  order_uses_another_method: tri('الطلب بطريقة دفع أخرى', 'the order uses another payment method', 'داواکارییەکە ڕێگایەکی تری پارەدانی هەیە'),
};
