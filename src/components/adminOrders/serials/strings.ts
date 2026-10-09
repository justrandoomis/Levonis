/**
 * THE WORDS OF THE SERIAL SCAN — the order screen's per-unit slots, the
 * camera sheet, the §19 blocker, the serial / warranty page, the policy
 * controls and the owner's gate switch (owner brief 2026-10-07, 33 sections).
 *
 * Every line exists in Arabic, English and Sorani, and the Sorani is written
 * for this screen — a `ckb` slot never carries a copy of the Arabic
 * (docs/DECISIONS.md row 183). The refusals themselves are NOT here: the
 * server sends a code and src/lib/refusalStrings.ts owns its sentence in the
 * three languages, with the brief's own Arabic (§31, §10, §11, §17, §19).
 */
import type { Language } from '../../../translations';

type Fmt<A extends unknown[]> = (...args: A) => string;

export interface SerialStrings {
  // ---- the slots (§1, §2, §21) -------------------------------------------
  sectionTitle: string;
  sectionHint: string;
  unit: Fmt<[number]>;
  scanSerial: string;
  /** The camera button's label on a narrow phone (the full one is its accessible name). */
  scanShort: string;
  inputPlaceholder: string;
  inputLabel: Fmt<[string, number]>;
  openCamera: Fmt<[string, number]>;
  link: string;
  linking: string;
  linked: string;
  /** Screen readers: an empty unit this viewer cannot fill (the screen shows «—»). */
  notLinked: string;
  /** Screen readers: a masked serial, read as its last digits rather than «star star star star». */
  endingIn: Fmt<[string]>;
  /** A reader's second scan that arrived while the first was being checked, and could not be placed. */
  queuedDropped: string;
  change: string;
  remove: string;
  more: Fmt<[number]>;
  cancel: string;
  removeTitle: string;
  removeBody: string;
  removeOutsideBody: string;
  removeConfirm: string;
  removed: string;
  warrantyAtDelivery: string;
  returnedCarry: Fmt<[string]>;
  returnedRestart: string;
  previous: Fmt<[string]>;
  previousTaken: Fmt<[string]>;
  relink: string;
  readOnly: string;
  ownerOutsideHint: string;
  shipmentLocked: string;
  progress: Fmt<[number, number]>;
  allLinked: string;
  openSerialPage: Fmt<[string]>;
  lot: Fmt<[string]>;
  overrideBadge: string;
  chipSerials: Fmt<[number, number]>;
  chipGoTo: string;
  /** The orders board's chip: its one word, the full sentence (title / accessible name), and the held move. */
  boardChip: string;
  boardChipTitle: Fmt<[number, number]>;
  boardHeld: string;
  flags: Record<string, string>;
  warnings: Record<string, string>;
  // ---- the camera sheet (§3, §22) ----------------------------------------
  sheetTitle: Fmt<[string, number]>;
  sheetChangeTitle: Fmt<[string, number]>;
  close: string;
  useScanner: string;
  checking: string;
  linkedLine: string;
  /** Closes the sheet when a link carries a warning worth reading (it does not close on its own then). */
  done: string;
  existingLine1: string;
  existingLine2: string;
  already: string;
  scanAgain: string;
  ownerOverride: string;
  overrideTitle: Record<string, string>;
  reasonLabel: string;
  reasonHint: string;
  warrantyMode: string;
  modeCarry: string;
  modeRestart: string;
  confirmOverride: string;
  otherOrder: Fmt<[string]>;
  expectedLots: string;
  lotLine: Fmt<[string, string]>;
  problems: Record<string, string>;
  deliveredActive: string;
  /** SERIAL_IN_USE_THIS_ORDER's detail: which unit of this order holds it. */
  inUseHere: Fmt<[number]>;
  failed: string;
  // ---- the §19 blocker ---------------------------------------------------
  blockerIntro: string;
  missingListedAbove: Fmt<[number]>;
  goToUnit: string;
  lotConflict: string;
  ownerProceed: string;
  ownerProceedHint: string;
  proceed: string;
  // ---- the owner's gate switch -------------------------------------------
  gateTitle: string;
  gateBody: string;
  gateOn: Fmt<[string]>;
  gateOff: string;
  turnOn: string;
  turnOff: string;
  ownerOnly: string;
  cutoverLabel: string;
  gateSaved: string;
  // ---- the serial / warranty page (§16) ----------------------------------
  pageTitle: string;
  copy: string;
  copied: string;
  serial: string;
  product: string;
  variant: string;
  sku: string;
  currentStatus: string;
  currentOrder: string;
  previousOrders: string;
  none: string;
  hiddenOrder: string;
  unitOf: Fmt<[number]>;
  warrantyCard: string;
  warrantyStatus: string;
  warrantyStart: string;
  warrantyEnd: string;
  /** A warranty date not known yet because it is set by the delivery. */
  atDelivery: string;
  remaining: Fmt<[number]>;
  mode: string;
  modes: Record<string, string>;
  batch: string;
  lotSources: Record<string, string>;
  history: string;
  historyEmpty: string;
  system: string;
  legacy: string;
  notFound: string;
  loading: string;
  retry: string;
  resaleTitle: string;
  resaleHint: string;
  save: string;
  saved: string;
  status: Record<string, string>;
  warranty: Record<string, string>;
  releaseReasons: Record<string, string>;
  action: {
    added: string;
    firstScan: string;
    updated: string;
    voided: string;
    restored: string;
    linked: Fmt<[string | null]>;
    cancelled: Fmt<[string | null]>;
    releasedToStock: string;
    released: Fmt<[string]>;
    removed: string;
    override: Fmt<[string]>;
    delivered: string;
    activated: string;
    returned: string;
    warrantyChanged: string;
    warrantyMode: Fmt<[string]>;
    gateOverride: Fmt<[string]>;
    /** A re-delivery after an undone delivery + cancel re-opened the warranty. */
    reopened: string;
    /** The serial left a warranty unit it no longer is (re-delivered with another device). */
    detached: string;
    gateBreach: string;
    deviceEvent: string;
    receiptEvent: string;
  };
  via: string;
  // ---- policy (§29) ------------------------------------------------------
  policyTitle: string;
  policyHint: string;
  policyInherit: string;
  policyRequired: string;
  policyOff: string;
  policyEffectiveOn: string;
  policyEffectiveOff: string;
  policyFromSection: Fmt<[string]>;
  policyFromPrinter: string;
  policyOwn: string;
  policyDefault: string;
  policyOwnerOnly: string;
  sectionPolicyTitle: string;
  sectionPolicyHint: string;
  sectionBadgeRequired: string;
  sectionBadgeOff: string;
  printerNeverOff: string;
  // ---- a graded (used / open box / refurbished) listing (owner decision 4) --
  /** The read-only line under the grade: «Serial tracking: {state} — {source}». */
  usedSerialLine: Fmt<[string, string]>;
  usedStateOn: string;
  usedStateOff: string;
  usedSourceProduct: string;
  usedSourcePrinter: string;
  usedSourceSection: Fmt<[string]>;
  usedSourceDefault: string;
  /** Beside the section's serial policy: what a used device that needs a serial asks of it. */
  sectionUsedHint: string;
}

const ar: SerialStrings = {
  sectionTitle: 'أرقام الأجهزة التسلسلية',
  sectionHint: 'اربط الرقم التسلسلي لكل جهاز قبل إنهاء التجهيز. لا يبدأ الضمان إلا عند التسليم.',
  unit: (n) => `الوحدة ${n}`,
  scanSerial: 'امسح الرقم التسلسلي',
  scanShort: 'امسح',
  inputPlaceholder: 'امسح بالقارئ أو اكتب الرقم',
  inputLabel: (p, n) => `الرقم التسلسلي لـ${p} · الوحدة ${n}`,
  openCamera: (p, n) => `امسح الرقم التسلسلي · ${p} · الوحدة ${n}`,
  link: 'ربط',
  linking: 'جارٍ الربط…',
  notLinked: 'غير مرتبطة برقم تسلسلي',
  endingIn: (d) => `رقم مخفي ينتهي بـ ${d}`,
  queuedDropped: 'وصلت قراءة ثانية أثناء الفحص ولم تُربط — امسحها مجددًا إن لزم.',
  linked: 'تم ربط الرقم التسلسلي',
  change: 'تغيير',
  remove: 'إزالة',
  more: (n) => `خيارات الوحدة ${n}`,
  cancel: 'إلغاء',
  removeTitle: 'إزالة الرقم من هذه الوحدة؟',
  removeBody: 'يبقى الجهاز مسجّلًا في المخزون بضمانه وسجله؛ يُحرَّر هذا الربط فقط ويُسجَّل في السجل.',
  removeOutsideBody: 'الطلب خارج مرحلة التجهيز — الإزالة الآن استثناء للمالك ويلزمها سبب يُسجَّل في سجل الجهاز.',
  removeConfirm: 'إزالة الربط',
  removed: 'أُزيل الرقم من الوحدة.',
  warrantyAtDelivery: 'الضمان يبدأ عند التسليم',
  returnedCarry: (d) => `جهاز مُرتجع — يستمر ضمانه حتى ${d}`,
  returnedRestart: 'جهاز مُرتجع — يبدأ ضمانه من جديد عند التسليم',
  previous: (s) => `كان مربوطًا قبل الإلغاء: ${s}`,
  previousTaken: (s) => `كان مربوطًا قبل الإلغاء: ${s} — صار مربوطًا بطلب آخر، امسح جهازًا آخر`,
  relink: 'أعد ربطه',
  readOnly: 'ربط الأرقام متاح أثناء تجهيز الطلب فقط.',
  ownerOutsideHint: 'الطلب خارج مرحلة التجهيز — الربط الآن استثناء للمالك، ويُطلب سببه بعد المسح.',
  shipmentLocked: 'أُنشئت شحنة التوصيل — تغيير الأرقام الآن للمالك فقط.',
  progress: (l, r) => `${l} من ${r} مرتبطة`,
  allLinked: 'كل الأرقام مرتبطة',
  openSerialPage: (s) => `صفحة الرقم ${s}`,
  lot: (d) => `الدفعة · ${d}`,
  overrideBadge: 'باستثناء المالك',
  chipSerials: (l, r) => `الأرقام ${l}/${r}`,
  chipGoTo: 'اذهب إلى أرقام هذا المنتج',
  boardChip: 'الأرقام',
  boardChipTitle: (l, r) => `الوحدات المرتبطة برقم تسلسلي: ${l} من ${r} — افتح الطلب`,
  boardHeld: 'النقل التالي بانتظار الأرقام التسلسلية',
  flags: {
    ALLOCATION_MISSING: 'لم تُصرف دفعة مخزون لهذا البند بعد.',
    STOCK_NOT_RETAKEN: 'أُعيد مخزون هذا البند عند الإلغاء ولم يُصرف مجددًا.',
    SERIAL_ACTIVATION_CONFLICT: 'تعذّر تفعيل ضمان هذه الوحدة عند التسليم — راجع صفحة الرقم.',
    SERIAL_MISSING_AT_DELIVERY: 'سُلّمت هذه الوحدة بلا رقم تسلسلي.',
  },
  warnings: {
    RESTART_SUGGESTED: 'للبند خطة ضمان مشتراة — للمالك أن يبدأ الضمان من جديد من صفحة الرقم.',
    BATCH_OVERRIDDEN: 'سُجِّل اختلاف الدفعة باستثناء المالك.',
    ALLOCATION_MISSING: 'لم تُصرف دفعة مخزون لهذا البند بعد.',
    STOCK_NOT_RETAKEN: 'أُعيد مخزون هذا البند عند الإلغاء ولم يُصرف مجددًا.',
    CANCELLED_AFTER_DISPATCH: 'أُلغي الطلب السابق بعد الشحن — تأكّد أن الجهاز عاد فعلًا.',
  },
  sheetTitle: (p, n) => `${p} · الوحدة ${n}`,
  sheetChangeTitle: (p, n) => `تغيير الرقم · ${p} · الوحدة ${n}`,
  close: 'إغلاق',
  useScanner: 'استخدم قارئًا أو لوحة مفاتيح',
  checking: 'جارٍ التحقق…',
  linkedLine: 'تم ربط الرقم التسلسلي بالطلب.',
  done: 'تم',
  existingLine1: 'الرقم التسلسلي موجود مسبقاً',
  existingLine2: 'تم ربطه الآن بهذا الطلب',
  already: 'هذا الرقم مربوط بهذه الوحدة بالفعل.',
  scanAgain: 'امسح مجددًا',
  ownerOverride: 'استثناء المالك',
  overrideTitle: {
    take_from_order: 'انقله من الطلب الآخر إلى هذا الطلب',
    delivered_device: 'اربط جهازًا سبق تسليمه',
    unavailable: 'اربط جهازًا غير متاح للبيع',
    outside_window: 'اربط خارج مرحلة التجهيز',
    batch: 'اقبل الجهاز من دفعة أخرى',
    model_family: 'اقبل الرقم رغم اختلاف الطراز',
  },
  reasonLabel: 'السبب (إلزامي)',
  reasonHint: '٥ أحرف على الأقل — يُسجَّل في سجل الجهاز باسمك.',
  warrantyMode: 'الضمان عند البيع من جديد',
  modeCarry: 'يستمر',
  modeRestart: 'يبدأ من جديد',
  confirmOverride: 'اربط باستثناء المالك',
  otherOrder: (id) => `الطلب: ${id}`,
  expectedLots: 'الدفعات المصروفة لهذا البند:',
  lotLine: (d, l) => (l ? `استلام ${d} · ${l}` : `استلام ${d}`),
  problems: {
    SERIAL_LOOKS_LIKE_EAN: 'هذا باركود المنتج (EAN) — امسح الباركود تحت «Product SN».',
    SERIAL_LOOKS_LIKE_RECEIPT: 'هذا رقم وصل ضمان، وليس رقم الجهاز.',
    BOX_ONLY: 'هذا رقم العلبة (BOX SN) ولا نعرف جهازه بعد — امسح «Product SN».',
    BOX_SN: 'هذا الرقم هو رقم علبة جهاز آخر مسجّل.',
    BOX_SN_IS_SERIAL: 'رقم العلبة المقروء هو رقم جهاز مسجّل — امسح الملصق من جديد.',
    SERIAL_TOO_SHORT: 'الرقم قصير جدًا (٦ أحرف على الأقل).',
    SERIAL_TOO_LONG: 'الرقم طويل جدًا.',
    SERIAL_CHARS: 'يحوي الرقم رموزًا غير مقبولة — أحرف إنجليزية وأرقام فقط.',
    SERIAL_EMPTY: 'اكتب الرقم أو امسحه.',
  },
  deliveredActive: 'هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.',
  inUseHere: (n) => `مربوط الآن بالوحدة ${n}.`,
  failed: 'تعذّر الربط — تحقّق من الاتصال وأعد المحاولة.',
  blockerIntro: 'الوحدات الناقصة:',
  missingListedAbove: (n) => (n === 1 ? 'وحدة واحدة ناقصة — مذكورة أعلى الصفحة.' : n === 2 ? 'وحدتان ناقصتان — مذكورتان أعلى الصفحة.' : `${n} وحدات ناقصة — مذكورة أعلى الصفحة.`),
  goToUnit: 'اذهب إلى الوحدة',
  lotConflict: 'رقم مربوط من دفعة لم تعد مصروفة لهذا البند — امسحه مجددًا.',
  ownerProceed: 'المتابعة دون الأرقام (المالك)',
  ownerProceedHint: 'يُنقل الطلب رغم النقص، ويُسجَّل استثناؤك وسببه في سجل الطلب.',
  proceed: 'تابع النقل',
  gateTitle: 'الأرقام التسلسلية شرط قبل الشحن',
  gateBody:
    'عند التفعيل لا يُنقل طلب إلى «في الطريق إليك» أو «تم التوصيل» ولا تُنشأ له شحنة قبل ربط رقم تسلسلي بكل جهاز فيه. الطلبات المنشأة قبل تاريخ التفعيل لا تتأثر.',
  gateOn: (d) => `مفعّل للطلبات المنشأة منذ ${d}`,
  gateOff: 'متوقف — الأرقام تُربط ولا تمنع الشحن.',
  turnOn: 'تفعيل',
  turnOff: 'إيقاف',
  ownerOnly: 'هذا الإعداد للمالك فقط.',
  cutoverLabel: 'يسري على الطلبات المنشأة من',
  gateSaved: 'حُفظ إعداد شرط الأرقام.',
  pageTitle: 'الرقم التسلسلي والضمان',
  copy: 'نسخ الرقم',
  copied: 'نُسخ',
  serial: 'الرقم التسلسلي',
  product: 'المنتج',
  variant: 'الخيار',
  sku: 'SKU',
  currentStatus: 'الحالة الحالية',
  currentOrder: 'الطلب الحالي',
  previousOrders: 'الطلبات السابقة',
  none: 'لا يوجد',
  hiddenOrder: 'مخفي لصلاحيتك',
  unitOf: (n) => `الوحدة ${n}`,
  warrantyCard: 'الضمان',
  warrantyStatus: 'حالة الضمان',
  warrantyStart: 'بداية الضمان',
  warrantyEnd: 'نهاية الضمان',
  atDelivery: 'عند التسليم',
  remaining: (n) => (n === 1 ? 'متبقٍ يوم واحد' : n === 2 ? 'متبقٍ يومان' : n >= 3 && n <= 10 ? `متبقٍ ${n} أيام` : `متبقٍ ${n} يومًا`),
  mode: 'طريقة الضمان',
  modes: { new: 'جديد مع هذا البيع', carry: 'يستمر من البيع الأول', restart: 'يبدأ من جديد' },
  batch: 'الدفعة',
  lotSources: { serial_link: 'من ملصق الدفعة', allocation: 'من صرف المخزون' },
  history: 'السجل',
  historyEmpty: 'لا أحداث بعد.',
  system: 'النظام',
  legacy: 'جهاز سبق مخزون الأرقام — بياناته من سجل الضمان.',
  notFound: 'لم يُعثر على هذا الرقم.',
  loading: 'جارٍ التحميل…',
  retry: 'إعادة المحاولة',
  resaleTitle: 'الضمان عند إعادة البيع',
  resaleHint: 'جهاز مُرتجع مربوط بطلب جديد: «يستمر» يحفظ نهاية ضمانه الأصلية، و«يبدأ من جديد» يعطي المشتري مدة كاملة.',
  save: 'حفظ',
  saved: 'حُفظ',
  status: {
    in_stock: 'متاح في المخزون',
    reserved: 'محجوز لطلب',
    sold: 'تم تسليمه',
    registered: 'تم تسليمه · مسجّل باسم زبون',
    returned: 'مُرتجع',
    unavailable: 'غير متاح',
    void: 'ملغى',
  },
  warranty: {
    PENDING_DELIVERY: 'بانتظار التسليم',
    NOT_ACTIVATED: 'لم يُفعّل',
    ACTIVE: 'فعّال',
    EXPIRED: 'منتهٍ',
    NEEDS_CONFIG: 'مدة الضمان غير محددة',
    RETURNED: 'أُغلق بالإرجاع',
    CLOSED: 'مُغلق',
  },
  releaseReasons: {
    order_cancelled: 'أُلغي الطلب',
    unlinked: 'أُزيل من الوحدة',
    changed: 'استُبدل برقم آخر',
    owner_override: 'استثناء المالك',
    returned: 'أُرجع',
    policy_changed: 'تغيّرت سياسة الرقم',
    replaced: 'استُبدل الجهاز',
    reassigned: 'نُقل إلى وحدة أخرى',
    order_deleted: 'حُذف الطلب',
  },
  action: {
    added: 'أُضيف إلى النظام',
    firstScan: 'أول مسح أثناء التجهيز',
    updated: 'عُدّلت بيانات الرقم',
    voided: 'أُلغي الرقم',
    restored: 'أُعيد تفعيل الرقم',
    linked: (id) => (id ? `رُبط بالطلب ${id}` : 'رُبط بطلب'),
    cancelled: (id) => (id ? `أُلغي الطلب ${id}` : 'أُلغي الطلب'),
    releasedToStock: 'أُعيد إلى المخزون',
    released: (r) => `حُرِّر من الطلب · ${r}`,
    removed: 'أُزيل من الوحدة',
    override: (r) => `استثناء المالك: ${r}`,
    delivered: 'سُلّم',
    activated: 'فُعّل الضمان',
    returned: 'أُرجع',
    warrantyChanged: 'تغيير في الضمان',
    warrantyMode: (m) => `طريقة الضمان عند إعادة البيع: ${m}`,
    gateOverride: (r) => `شُحن رغم نقص الأرقام (المالك): ${r}`,
    reopened: 'سُلّم مجددًا · فُتح الضمان من جديد',
    detached: 'فُكّ عن وحدة ضمان سابقة',
    gateBreach: 'شُحن وفيه أرقام ناقصة — سُجّل للمالك',
    deviceEvent: 'حدث على وحدة الضمان',
    receiptEvent: 'حدث على وصل الضمان',
  },
  via: 'بواسطة',
  policyTitle: 'تتبّع الرقم التسلسلي',
  policyHint: 'يُطلب رقم تسلسلي لكل وحدة عند التجهيز، وتُسجَّل وحدة ضمان لكل جهاز عند التسليم.',
  policyInherit: 'وراثة',
  policyRequired: 'مطلوب',
  policyOff: 'غير مطلوب',
  policyEffectiveOn: 'مطلوب لهذا المنتج',
  policyEffectiveOff: 'غير مطلوب لهذا المنتج',
  policyFromSection: (n) => `من القسم «${n}»`,
  policyFromPrinter: 'لأنه في قسم طابعات',
  policyOwn: 'محدد لهذا المنتج',
  policyDefault: 'الافتراضي للملحقات',
  policyOwnerOnly: 'يغيّره المالك فقط',
  sectionPolicyTitle: 'تتبّع الرقم التسلسلي لمنتجات القسم',
  sectionPolicyHint:
    'يسري على كل منتج في القسم وأقسامه الفرعية ما لم يُحدَّد له غير ذلك. لا يُطفئ هذا الإعداد الطابعات أبدًا. يُطبَّق فور الحفظ.',
  sectionBadgeRequired: 'رقم تسلسلي مطلوب',
  sectionBadgeOff: 'بلا رقم تسلسلي',
  printerNeverOff: 'الطابعات تبقى مُرقّمة دائمًا مهما كان إعداد القسم.',
  usedSerialLine: (state, source) => `تتبّع الرقم التسلسلي: ${state} — ${source}`,
  usedStateOn: 'مفعّل',
  usedStateOff: 'غير مفعّل',
  usedSourceProduct: 'إعداد المنتج',
  usedSourcePrinter: 'لأنه طابعة',
  usedSourceSection: (n) => `سياسة القسم «${n}»`,
  usedSourceDefault: 'الافتراضي',
  sectionUsedHint: 'للأجهزة المستعملة التي تحتاج رقمًا تسلسليًا (مثل AMS) اجعل سياسة قسمها «مطلوب»؛ الملحقات العادية لا تحتاجه.',
};

const en: SerialStrings = {
  sectionTitle: 'Device serial numbers',
  sectionHint: 'Link each device’s serial before finishing preparation. The warranty only starts at delivery.',
  unit: (n) => `Unit ${n}`,
  scanSerial: 'Scan Serial',
  scanShort: 'Scan',
  inputPlaceholder: 'Scan with a reader or type the number',
  inputLabel: (p, n) => `Serial number for ${p} · Unit ${n}`,
  openCamera: (p, n) => `Scan Serial · ${p} · Unit ${n}`,
  link: 'Link',
  linking: 'Linking…',
  notLinked: 'No serial linked',
  endingIn: (d) => `Hidden serial ending in ${d}`,
  queuedDropped: 'A second scan arrived while checking and was not linked — scan it again if needed.',
  linked: 'Serial linked',
  change: 'Change',
  remove: 'Remove',
  more: (n) => `Unit ${n} options`,
  cancel: 'Cancel',
  removeTitle: 'Remove the serial from this unit?',
  removeBody: 'The device stays on record with its warranty and history; only this link is released, and the release is logged.',
  removeOutsideBody: 'The order is outside the preparation stage — removing now is an owner exception and needs a reason, recorded in the device history.',
  removeConfirm: 'Remove link',
  removed: 'Serial removed from the unit.',
  warrantyAtDelivery: 'Warranty starts at delivery',
  returnedCarry: (d) => `Returned device — warranty continues to ${d}`,
  returnedRestart: 'Returned device — its warranty restarts at delivery',
  previous: (s) => `Linked before cancellation: ${s}`,
  previousTaken: (s) => `Linked before cancellation: ${s} — now linked to another order; scan a different device`,
  relink: 'Link again',
  readOnly: 'Serials can be linked only while the order is being prepared.',
  ownerOutsideHint: 'The order is outside the preparation stage — linking now is an owner exception, and its reason is asked for after the scan.',
  shipmentLocked: 'A courier shipment exists — only the owner can change serials now.',
  progress: (l, r) => `${l} of ${r} linked`,
  allLinked: 'All serials linked',
  openSerialPage: (s) => `Serial page for ${s}`,
  lot: (d) => `Batch · ${d}`,
  overrideBadge: 'Owner override',
  chipSerials: (l, r) => `Serials ${l}/${r}`,
  chipGoTo: 'Go to this product’s serials',
  boardChip: 'Serials',
  boardChipTitle: (l, r) => `Units with a serial linked: ${l} of ${r} — open the order`,
  boardHeld: 'The next move waits for the serials',
  flags: {
    ALLOCATION_MISSING: 'No stock batch has been issued to this line yet.',
    STOCK_NOT_RETAKEN: 'This line’s stock was returned at cancellation and not taken again.',
    SERIAL_ACTIVATION_CONFLICT: 'This unit’s warranty could not be activated at delivery — check the serial page.',
    SERIAL_MISSING_AT_DELIVERY: 'This unit was delivered without a serial.',
  },
  warnings: {
    RESTART_SUGGESTED: 'This line has a purchased warranty plan — the owner can restart the warranty from the serial page.',
    BATCH_OVERRIDDEN: 'Batch mismatch recorded under the owner’s override.',
    ALLOCATION_MISSING: 'No stock batch has been issued to this line yet.',
    STOCK_NOT_RETAKEN: 'This line’s stock was returned at cancellation and not taken again.',
    CANCELLED_AFTER_DISPATCH: 'The previous order was cancelled after dispatch — make sure the device is really back.',
  },
  sheetTitle: (p, n) => `${p} · Unit ${n}`,
  sheetChangeTitle: (p, n) => `Change serial · ${p} · Unit ${n}`,
  close: 'Close',
  useScanner: 'Use a scanner or keyboard',
  checking: 'Checking…',
  linkedLine: 'Serial number linked to the order.',
  done: 'Done',
  existingLine1: 'Serial already on record',
  existingLine2: 'Now linked to this order',
  already: 'This serial is already linked to this unit.',
  scanAgain: 'Scan again',
  ownerOverride: 'Owner override',
  overrideTitle: {
    take_from_order: 'Move it from the other order to this one',
    delivered_device: 'Link a device that was already delivered',
    unavailable: 'Link a device that isn’t available for sale',
    outside_window: 'Link outside the preparation stage',
    batch: 'Accept the device from another batch',
    model_family: 'Accept the serial despite the model difference',
  },
  reasonLabel: 'Reason (required)',
  reasonHint: 'At least 5 characters — recorded in the device history under your name.',
  warrantyMode: 'Warranty on resale',
  modeCarry: 'Continue',
  modeRestart: 'Restart',
  confirmOverride: 'Link with owner override',
  otherOrder: (id) => `Order: ${id}`,
  expectedLots: 'Batches issued to this line:',
  lotLine: (d, l) => (l ? `Received ${d} · ${l}` : `Received ${d}`),
  problems: {
    SERIAL_LOOKS_LIKE_EAN: 'That’s the product barcode (EAN) — scan the barcode under “Product SN”.',
    SERIAL_LOOKS_LIKE_RECEIPT: 'That’s a warranty receipt number, not the device serial.',
    BOX_ONLY: 'That’s the box number (BOX SN) and no device is known for it yet — scan the Product SN.',
    BOX_SN: 'That number is the box number of another recorded device.',
    BOX_SN_IS_SERIAL: 'The box number read is a recorded device serial — scan the label again.',
    SERIAL_TOO_SHORT: 'Too short (at least 6 characters).',
    SERIAL_TOO_LONG: 'Too long.',
    SERIAL_CHARS: 'The number has characters that aren’t allowed — English letters and digits only.',
    SERIAL_EMPTY: 'Type or scan the number.',
  },
  deliveredActive: 'This device was already delivered and is under an active warranty.',
  inUseHere: (n) => `It is on Unit ${n} now.`,
  failed: 'Couldn’t link — check the connection and try again.',
  blockerIntro: 'Units still missing:',
  missingListedAbove: (n) => (n === 1 ? 'One unit is missing — listed at the top of this tab.' : `${n} units are missing — listed at the top of this tab.`),
  goToUnit: 'Go to unit',
  lotConflict: 'A linked serial is from a batch no longer issued to this line — scan it again.',
  ownerProceed: 'Proceed without the serials (owner)',
  ownerProceedHint: 'The order moves despite the gap, and your exception and its reason are recorded in the order history.',
  proceed: 'Proceed',
  gateTitle: 'Serials required before dispatch',
  gateBody:
    'When on, an order can’t move to “On the way to you” or “Delivered”, and no courier shipment is created, until every device in it has a serial linked. Orders created before the switch-on date are not affected.',
  gateOn: (d) => `On for orders created since ${d}`,
  gateOff: 'Off — serials are linked but don’t hold dispatch.',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  ownerOnly: 'Only the owner can change this.',
  cutoverLabel: 'Applies to orders created from',
  gateSaved: 'Serial requirement saved.',
  pageTitle: 'Serial & warranty',
  copy: 'Copy serial',
  copied: 'Copied',
  serial: 'Serial number',
  product: 'Product',
  variant: 'Option',
  sku: 'SKU',
  currentStatus: 'Current status',
  currentOrder: 'Current order',
  previousOrders: 'Previous orders',
  none: 'None',
  hiddenOrder: 'Hidden for your access level',
  unitOf: (n) => `Unit ${n}`,
  warrantyCard: 'Warranty',
  warrantyStatus: 'Warranty status',
  warrantyStart: 'Warranty start',
  warrantyEnd: 'Warranty end',
  atDelivery: 'At delivery',
  remaining: (n) => (n === 1 ? '1 day left' : `${n} days left`),
  mode: 'Warranty mode',
  modes: { new: 'New with this sale', carry: 'Carried from the first sale', restart: 'Restarts' },
  batch: 'Batch',
  lotSources: { serial_link: 'From the batch label', allocation: 'From the stock issue' },
  history: 'History',
  historyEmpty: 'No events yet.',
  system: 'System',
  legacy: 'A device from before the serial inventory — read from the warranty records.',
  notFound: 'This serial wasn’t found.',
  loading: 'Loading…',
  retry: 'Retry',
  resaleTitle: 'Warranty on resale',
  resaleHint: 'A returned device linked to a new order: “Continue” keeps its original warranty end, “Restart” gives the buyer a full period.',
  save: 'Save',
  saved: 'Saved',
  status: {
    in_stock: 'In stock',
    reserved: 'Reserved for an order',
    sold: 'Delivered',
    registered: 'Delivered · registered to a customer',
    returned: 'Returned',
    unavailable: 'Unavailable',
    void: 'Voided',
  },
  warranty: {
    PENDING_DELIVERY: 'Pending delivery',
    NOT_ACTIVATED: 'Not activated',
    ACTIVE: 'Active',
    EXPIRED: 'Expired',
    NEEDS_CONFIG: 'Warranty length not set',
    RETURNED: 'Closed by return',
    CLOSED: 'Closed',
  },
  releaseReasons: {
    order_cancelled: 'Order cancelled',
    unlinked: 'Removed from the unit',
    changed: 'Replaced by another serial',
    owner_override: 'Owner override',
    returned: 'Returned',
    policy_changed: 'Serial policy changed',
    replaced: 'Device replaced',
    reassigned: 'Moved to another unit',
    order_deleted: 'Order deleted',
  },
  action: {
    added: 'Added to system',
    firstScan: 'First scanned at preparation',
    updated: 'Serial details changed',
    voided: 'Serial voided',
    restored: 'Serial restored',
    linked: (id) => (id ? `Linked to ${id}` : 'Linked to an order'),
    cancelled: (id) => (id ? `${id} cancelled` : 'Order cancelled'),
    releasedToStock: 'Released to inventory',
    released: (r) => `Released from the order · ${r}`,
    removed: 'Removed from unit',
    override: (r) => `Owner override: ${r}`,
    delivered: 'Delivered',
    activated: 'Warranty activated',
    returned: 'Returned',
    warrantyChanged: 'Warranty changed',
    warrantyMode: (m) => `Warranty on resale: ${m}`,
    gateOverride: (r) => `Shipped with serials missing (owner): ${r}`,
    reopened: 'Delivered again · warranty reopened',
    detached: 'Detached from a former warranty unit',
    gateBreach: 'Shipped with serials missing — recorded for the owner',
    deviceEvent: 'Warranty unit event',
    receiptEvent: 'Warranty receipt event',
  },
  via: 'by',
  policyTitle: 'Serial tracking',
  policyHint: 'A serial is required for every unit at preparation, and a warranty unit is recorded for each device at delivery.',
  policyInherit: 'Inherit',
  policyRequired: 'Required',
  policyOff: 'Not required',
  policyEffectiveOn: 'Required for this product',
  policyEffectiveOff: 'Not required for this product',
  policyFromSection: (n) => `From section “${n}”`,
  policyFromPrinter: 'Because it is in a printer section',
  policyOwn: 'Set on this product',
  policyDefault: 'The default for accessories',
  policyOwnerOnly: 'Only the owner can change it',
  sectionPolicyTitle: 'Serial tracking for this section’s products',
  sectionPolicyHint:
    'Applies to every product in the section and its sub-sections unless the product says otherwise. It never switches printers off. Applied as soon as you save.',
  sectionBadgeRequired: 'Serial required',
  sectionBadgeOff: 'No serial',
  printerNeverOff: 'Printers always stay serialized, whatever the section says.',
  usedSerialLine: (state, source) => `Serial tracking: ${state} — ${source}`,
  usedStateOn: 'on',
  usedStateOff: 'off',
  usedSourceProduct: 'the product’s own setting',
  usedSourcePrinter: 'because it is a printer',
  usedSourceSection: (n) => `the “${n}” section policy`,
  usedSourceDefault: 'the default',
  sectionUsedHint: 'For used devices that need a serial (such as an AMS), set their section’s policy to “Required”; ordinary accessories do not need one.',
};

const ckb: SerialStrings = {
  sectionTitle: 'ژمارە زنجیرەییەکانی ئامێرەکان',
  sectionHint: 'پێش تەواوکردنی ئامادەکردن ژمارەی زنجیرەیی هەر ئامێرێک ببەستەوە. گەرەنتی تەنها لە کاتی گەیاندندا دەست پێدەکات.',
  unit: (n) => `یەکەی ${n}`,
  scanSerial: 'سکانی ژمارەی زنجیرەیی',
  scanShort: 'سکان',
  inputPlaceholder: 'بە خوێنەرەوە سکان بکە یان ژمارەکە بنووسە',
  inputLabel: (p, n) => `ژمارەی زنجیرەیی بۆ ${p} · یەکەی ${n}`,
  openCamera: (p, n) => `سکانی ژمارەی زنجیرەیی · ${p} · یەکەی ${n}`,
  link: 'بەستن',
  linking: 'دەبەسترێت…',
  notLinked: 'هیچ ژمارەیەکی زنجیرەیی پێوە نەبەستراوە',
  endingIn: (d) => `ژمارەیەکی شاراوە کە بە ${d} کۆتایی دێت`,
  queuedDropped: 'خوێندنەوەیەکی دووەم لە کاتی پشکنیندا گەیشت و نەبەسترا — ئەگەر پێویستە دووبارە سکانی بکە.',
  linked: 'ژمارەی زنجیرەیی بەسترا',
  change: 'گۆڕین',
  remove: 'لابردن',
  more: (n) => `هەڵبژاردنەکانی یەکەی ${n}`,
  cancel: 'پاشگەزبوونەوە',
  removeTitle: 'ژمارەکە لەم یەکەیە لاببرێت؟',
  removeBody: 'ئامێرەکە بە گەرەنتی و مێژووەکەیەوە لە کۆگادا تۆمارکراو دەمێنێتەوە؛ تەنها ئەم بەستنەوەیە ئازاد دەکرێت و لە مێژوودا تۆمار دەکرێت.',
  removeOutsideBody: 'داواکارییەکە لە دەرەوەی قۆناغی ئامادەکردندایە — لابردن ئێستا ڕێگەپێدانی خاوەنە و هۆکارێکی دەوێت کە لە مێژووی ئامێرەکەدا تۆمار دەکرێت.',
  removeConfirm: 'بەستنەوەکە لاببە',
  removed: 'ژمارەکە لە یەکەکە لابرا.',
  warrantyAtDelivery: 'گەرەنتی لە کاتی گەیاندندا دەست پێدەکات',
  returnedCarry: (d) => `ئامێری گەڕێنراوە — گەرەنتییەکەی تا ${d} بەردەوام دەبێت`,
  returnedRestart: 'ئامێری گەڕێنراوە — گەرەنتییەکەی لە کاتی گەیاندندا لە سەرەتاوە دەست پێدەکاتەوە',
  previous: (s) => `پێش هەڵوەشاندنەوە بەسترابوو: ${s}`,
  previousTaken: (s) => `پێش هەڵوەشاندنەوە بەسترابوو: ${s} — ئێستا بە داواکارییەکی ترەوە بەستراوە؛ ئامێرێکی تر سکان بکە`,
  relink: 'دووبارە ببەستەوە',
  readOnly: 'بەستنی ژمارەکان تەنها لە کاتی ئامادەکردنی داواکارییەکەدا دەکرێت.',
  ownerOutsideHint: 'داواکارییەکە لە دەرەوەی قۆناغی ئامادەکردندایە — بەستن ئێستا ڕێگەپێدانی خاوەنە، و هۆکارەکەی دوای سکان داوا دەکرێت.',
  shipmentLocked: 'بارنامەی گەیاندن دروستکراوە — ئێستا تەنها خاوەن دەتوانێت ژمارەکان بگۆڕێت.',
  progress: (l, r) => `${l} لە ${r} بەستراون`,
  allLinked: 'هەموو ژمارەکان بەستراون',
  openSerialPage: (s) => `پەڕەی ژمارەی ${s}`,
  lot: (d) => `وەجبە · ${d}`,
  overrideBadge: 'بە ڕێگەپێدانی خاوەن',
  chipSerials: (l, r) => `ژمارەکان ${l}/${r}`,
  chipGoTo: 'بڕۆ بۆ ژمارەکانی ئەم بەرهەمە',
  boardChip: 'ژمارەکان',
  boardChipTitle: (l, r) => `ئەو یەکانەی ژمارەی زنجیرەییان پێوە بەستراوە: ${l} لە ${r} — داواکارییەکە بکەرەوە`,
  boardHeld: 'گواستنەوەی داهاتوو چاوەڕێی ژمارە زنجیرەییەکانە',
  flags: {
    ALLOCATION_MISSING: 'هێشتا هیچ وەجبەیەکی کۆگا بۆ ئەم بەندە دەرنەکراوە.',
    STOCK_NOT_RETAKEN: 'کۆگای ئەم بەندە لە کاتی هەڵوەشاندنەوەدا گەڕایەوە و دووبارە دەرنەکراوەتەوە.',
    SERIAL_ACTIVATION_CONFLICT: 'گەرەنتی ئەم یەکەیە لە کاتی گەیاندندا چالاک نەکرا — پەڕەی ژمارەکە بپشکنە.',
    SERIAL_MISSING_AT_DELIVERY: 'ئەم یەکەیە بێ ژمارەی زنجیرەیی گەیەنرا.',
  },
  warnings: {
    RESTART_SUGGESTED: 'ئەم بەندە پلانی گەرەنتی کڕدراوی هەیە — خاوەن دەتوانێت لە پەڕەی ژمارەکەوە گەرەنتییەکە لە سەرەتاوە دەست پێبکاتەوە.',
    BATCH_OVERRIDDEN: 'جیاوازی وەجبە بە ڕێگەپێدانی خاوەن تۆمارکرا.',
    ALLOCATION_MISSING: 'هێشتا هیچ وەجبەیەکی کۆگا بۆ ئەم بەندە دەرنەکراوە.',
    STOCK_NOT_RETAKEN: 'کۆگای ئەم بەندە لە کاتی هەڵوەشاندنەوەدا گەڕایەوە و دووبارە دەرنەکراوەتەوە.',
    CANCELLED_AFTER_DISPATCH: 'داواکارییەکەی پێشوو دوای ناردن هەڵوەشێنرایەوە — دڵنیابە ئامێرەکە بەڕاستی گەڕاوەتەوە.',
  },
  sheetTitle: (p, n) => `${p} · یەکەی ${n}`,
  sheetChangeTitle: (p, n) => `گۆڕینی ژمارە · ${p} · یەکەی ${n}`,
  close: 'داخستن',
  useScanner: 'خوێنەرەوە یان تەختەکلیل بەکاربهێنە',
  checking: 'پشکنین…',
  linkedLine: 'ژمارە زنجیرەییەکە بە داواکارییەکەوە بەسترا.',
  done: 'تەواو',
  existingLine1: 'ژمارە زنجیرەییەکە پێشتر تۆمارکراوە',
  existingLine2: 'ئێستا بەم داواکارییەوە بەسترا',
  already: 'ئەم ژمارەیە پێشتر بەم یەکەیەوە بەستراوە.',
  scanAgain: 'دووبارە سکان بکە',
  ownerOverride: 'ڕێگەپێدانی خاوەن',
  overrideTitle: {
    take_from_order: 'لە داواکارییەکەی ترەوە بیگوازەرەوە بۆ ئەم داواکارییە',
    delivered_device: 'ئامێرێک ببەستەوە کە پێشتر گەیەنراوە',
    unavailable: 'ئامێرێک ببەستەوە کە بۆ فرۆشتن بەردەست نییە',
    outside_window: 'لە دەرەوەی قۆناغی ئامادەکردن ببەستەوە',
    batch: 'ئامێرەکە لە وەجبەیەکی ترەوە وەربگرە',
    model_family: 'ژمارەکە وەربگرە سەرەڕای جیاوازی مۆدێل',
  },
  reasonLabel: 'هۆکار (پێویستە)',
  reasonHint: 'لانیکەم ٥ پیت — بە ناوی تۆوە لە مێژووی ئامێرەکەدا تۆمار دەکرێت.',
  warrantyMode: 'گەرەنتی لە کاتی دووبارە فرۆشتن',
  modeCarry: 'بەردەوام بێت',
  modeRestart: 'لە سەرەتاوە دەست پێبکاتەوە',
  confirmOverride: 'بە ڕێگەپێدانی خاوەن ببەستەوە',
  otherOrder: (id) => `داواکاری: ${id}`,
  expectedLots: 'ئەو وەجبانەی بۆ ئەم بەندە دەرکراون:',
  lotLine: (d, l) => (l ? `وەرگیراو ${d} · ${l}` : `وەرگیراو ${d}`),
  problems: {
    SERIAL_LOOKS_LIKE_EAN: 'ئەمە بارکۆدی بەرهەمە (EAN) — ئەو بارکۆدە سکان بکە کە لەژێر «Product SN» دایە.',
    SERIAL_LOOKS_LIKE_RECEIPT: 'ئەمە ژمارەی پسوولەی گەرەنتییە، نەک ژمارەی ئامێرەکە.',
    BOX_ONLY: 'ئەمە ژمارەی سندووقە (BOX SN) و هێشتا ئامێرەکەی نەناسراوە — «Product SN» سکان بکە.',
    BOX_SN: 'ئەم ژمارەیە ژمارەی سندووقی ئامێرێکی تۆمارکراوی ترە.',
    BOX_SN_IS_SERIAL: 'ژمارەی سندووقی خوێندراوە ژمارەی ئامێرێکی تۆمارکراوە — لەیبڵەکە دووبارە سکان بکە.',
    SERIAL_TOO_SHORT: 'ژمارەکە زۆر کورتە (لانیکەم ٦ پیت).',
    SERIAL_TOO_LONG: 'ژمارەکە زۆر درێژە.',
    SERIAL_CHARS: 'ژمارەکە پیتی نەگونجاوی تێدایە — تەنها پیتی ئینگلیزی و ژمارە.',
    SERIAL_EMPTY: 'ژمارەکە بنووسە یان سکانی بکە.',
  },
  deliveredActive: 'ئەم ئامێرە پێشتر گەیەنراوە و گەرەنتییەکی چالاکی هەیە.',
  inUseHere: (n) => `ئێستا بە یەکەی ${n}ەوە بەستراوە.`,
  failed: 'بەستن سەرنەکەوت — پەیوەندییەکە بپشکنە و دووبارە هەوڵ بدەوە.',
  blockerIntro: 'ئەو یەکانەی هێشتا ماون:',
  missingListedAbove: (n) => (n === 1 ? 'یەکەیەک ماوە — لە سەرەوەی پەڕەکەدا ناوی هاتووە.' : `${n} یەکە ماون — لە سەرەوەی پەڕەکەدا ناویان هاتووە.`),
  goToUnit: 'بڕۆ بۆ یەکەکە',
  lotConflict: 'ژمارەیەکی بەستراو لە وەجبەیەکە کە ئیتر بۆ ئەم بەندە دەرنەکراوە — دووبارە سکانی بکە.',
  ownerProceed: 'بێ ژمارەکان بەردەوام بە (خاوەن)',
  ownerProceedHint: 'داواکارییەکە سەرەڕای کەموکوڕییەکە دەگوازرێتەوە، و ڕێگەپێدانەکەت و هۆکارەکەی لە مێژووی داواکارییەکەدا تۆمار دەکرێن.',
  proceed: 'گواستنەوە بەردەوام بێت',
  gateTitle: 'ژمارەی زنجیرەیی مەرجە پێش ناردن',
  gateBody:
    'کە چالاک بێت، هیچ داواکارییەک ناگوازرێتەوە بۆ «لە ڕێگەیە بۆ لات» یان «گەیەنرا» و بارنامەی گەیاندنی بۆ دروست ناکرێت تا ژمارەی زنجیرەیی بە هەموو ئامێرەکانییەوە نەبەسترێت. ئەو داواکارییانەی پێش بەرواری چالاککردن دروستکراون کاریان تێناکرێت.',
  gateOn: (d) => `چالاکە بۆ ئەو داواکارییانەی لە ${d}ەوە دروستکراون`,
  gateOff: 'ناچالاکە — ژمارەکان دەبەسترێن بەڵام ڕێگە لە ناردن ناگرن.',
  turnOn: 'چالاککردن',
  turnOff: 'ناچالاککردن',
  ownerOnly: 'تەنها خاوەن دەتوانێت ئەمە بگۆڕێت.',
  cutoverLabel: 'بۆ ئەو داواکارییانەی دروستکراون لە',
  gateSaved: 'ڕێکخستنی مەرجی ژمارەکان پاشەکەوتکرا.',
  pageTitle: 'ژمارەی زنجیرەیی و گەرەنتی',
  copy: 'لەبەرگرتنەوەی ژمارە',
  copied: 'لەبەرگیرایەوە',
  serial: 'ژمارەی زنجیرەیی',
  product: 'بەرهەم',
  variant: 'جۆر',
  sku: 'SKU',
  currentStatus: 'دۆخی ئێستا',
  currentOrder: 'داواکاری ئێستا',
  previousOrders: 'داواکارییەکانی پێشوو',
  none: 'نییە',
  hiddenOrder: 'بۆ ئاستی دەسەڵاتەکەت شاراوەیە',
  unitOf: (n) => `یەکەی ${n}`,
  warrantyCard: 'گەرەنتی',
  warrantyStatus: 'دۆخی گەرەنتی',
  warrantyStart: 'دەستپێکی گەرەنتی',
  warrantyEnd: 'کۆتایی گەرەنتی',
  atDelivery: 'لە کاتی گەیاندن',
  remaining: (n) => `${n} ڕۆژ ماوە`,
  mode: 'شێوازی گەرەنتی',
  modes: { new: 'نوێ لەگەڵ ئەم فرۆشتنە', carry: 'لە یەکەم فرۆشتنەوە بەردەوامە', restart: 'لە سەرەتاوە دەست پێدەکاتەوە' },
  batch: 'وەجبە',
  lotSources: { serial_link: 'لە لەیبڵی وەجبەکەوە', allocation: 'لە دەرکردنی کۆگاوە' },
  history: 'مێژوو',
  historyEmpty: 'هێشتا هیچ ڕووداوێک نییە.',
  system: 'سیستەم',
  legacy: 'ئامێرێکی پێش کۆگای ژمارەکان — زانیارییەکانی لە تۆمارەکانی گەرەنتییەوە هاتوون.',
  notFound: 'ئەم ژمارەیە نەدۆزرایەوە.',
  loading: 'بار دەکرێت…',
  retry: 'دووبارە هەوڵ بدەوە',
  resaleTitle: 'گەرەنتی لە کاتی دووبارە فرۆشتن',
  resaleHint: 'ئامێرێکی گەڕێنراوە کە بە داواکارییەکی نوێوە بەستراوە: «بەردەوام بێت» کۆتایی گەرەنتییە ڕەسەنەکەی دەپارێزێت، و «لە سەرەتاوە دەست پێبکاتەوە» ماوەیەکی تەواو دەداتە کڕیار.',
  save: 'پاشەکەوتکردن',
  saved: 'پاشەکەوتکرا',
  status: {
    in_stock: 'لە کۆگادا بەردەستە',
    reserved: 'بۆ داواکارییەک گیراوە',
    sold: 'گەیەنراوە',
    registered: 'گەیەنراوە · بە ناوی کڕیارێکەوە تۆمارکراوە',
    returned: 'گەڕێنراوەتەوە',
    unavailable: 'بەردەست نییە',
    void: 'هەڵوەشێنراوە',
  },
  warranty: {
    PENDING_DELIVERY: 'چاوەڕوانی گەیاندن',
    NOT_ACTIVATED: 'چالاک نەکراوە',
    ACTIVE: 'کارایە',
    EXPIRED: 'بەسەرچووە',
    NEEDS_CONFIG: 'ماوەی گەرەنتی دیاری نەکراوە',
    RETURNED: 'بە گەڕاندنەوە داخرا',
    CLOSED: 'داخراوە',
  },
  releaseReasons: {
    order_cancelled: 'داواکاری هەڵوەشێنرایەوە',
    unlinked: 'لە یەکەکە لابرا',
    changed: 'بە ژمارەیەکی تر گۆڕدرا',
    owner_override: 'ڕێگەپێدانی خاوەن',
    returned: 'گەڕێنرایەوە',
    policy_changed: 'سیاسەتی ژمارە گۆڕا',
    replaced: 'ئامێرەکە گۆڕدرایەوە',
    reassigned: 'گوازرایەوە بۆ یەکەیەکی تر',
    order_deleted: 'داواکارییەکە سڕایەوە',
  },
  action: {
    added: 'زیادکرا بۆ سیستەم',
    firstScan: 'یەکەم سکان لە کاتی ئامادەکردن',
    updated: 'زانیاری ژمارەکە گۆڕدرا',
    voided: 'ژمارەکە هەڵوەشێنرایەوە',
    restored: 'ژمارەکە گەڕێندرایەوە',
    linked: (id) => (id ? `بەسترا بە داواکاری ${id}` : 'بە داواکارییەکەوە بەسترا'),
    cancelled: (id) => (id ? `داواکاری ${id} هەڵوەشێنرایەوە` : 'داواکارییەکە هەڵوەشێنرایەوە'),
    releasedToStock: 'گەڕایەوە بۆ کۆگا',
    released: (r) => `لە داواکارییەکە ئازادکرا · ${r}`,
    removed: 'لە یەکەکە لابرا',
    override: (r) => `ڕێگەپێدانی خاوەن: ${r}`,
    delivered: 'گەیەنرا',
    activated: 'گەرەنتی چالاک کرا',
    returned: 'گەڕێنرایەوە',
    warrantyChanged: 'گەرەنتی گۆڕدرا',
    warrantyMode: (m) => `گەرەنتی لە کاتی دووبارە فرۆشتن: ${m}`,
    gateOverride: (r) => `بێ ژمارەکان نێردرا (خاوەن): ${r}`,
    reopened: 'دووبارە گەیەنرایەوە · گەرەنتییەکە دووبارە کرایەوە',
    detached: 'لە یەکەیەکی گەرەنتیی پێشوو جیاکرایەوە',
    gateBreach: 'بە ژمارەی ناتەواوەوە نێردرا — بۆ خاوەن تۆمارکرا',
    deviceEvent: 'ڕووداوێک لەسەر یەکەی گەرەنتی',
    receiptEvent: 'ڕووداوێک لەسەر پسوولەی گەرەنتی',
  },
  via: 'لەلایەن',
  policyTitle: 'بەدواداچوونی ژمارەی زنجیرەیی',
  policyHint: 'لە کاتی ئامادەکردندا بۆ هەر یەکەیەک ژمارەی زنجیرەیی داوا دەکرێت، و لە کاتی گەیاندندا بۆ هەر ئامێرێک یەکەیەکی گەرەنتی تۆمار دەکرێت.',
  policyInherit: 'لە بەشی سەرەوە',
  policyRequired: 'پێویستە',
  policyOff: 'پێویست نییە',
  policyEffectiveOn: 'بۆ ئەم بەرهەمە پێویستە',
  policyEffectiveOff: 'بۆ ئەم بەرهەمە پێویست نییە',
  policyFromSection: (n) => `لە بەشی «${n}»ەوە`,
  policyFromPrinter: 'چونکە لە بەشی چاپکەرەکاندایە',
  policyOwn: 'بۆ ئەم بەرهەمە دیاریکراوە',
  policyDefault: 'بنەڕەتی پاشکۆکان',
  policyOwnerOnly: 'تەنها خاوەن دەیگۆڕێت',
  sectionPolicyTitle: 'بەدواداچوونی ژمارەی زنجیرەیی بۆ بەرهەمەکانی ئەم بەشە',
  sectionPolicyHint:
    'بۆ هەموو بەرهەمێکی ئەم بەشە و بەشە لاوەکییەکانی جێبەجێ دەبێت، مەگەر بەرهەمەکە شتێکی تری بۆ دیاری کرابێت. هەرگیز چاپکەرەکان ناکوژێنێتەوە. هەر کە پاشەکەوت بکەیت جێبەجێ دەبێت.',
  sectionBadgeRequired: 'ژمارەی زنجیرەیی پێویستە',
  sectionBadgeOff: 'بێ ژمارەی زنجیرەیی',
  printerNeverOff: 'چاپکەرەکان هەمیشە ژمارەدار دەمێننەوە، هەرچی ڕێکخستنی بەشەکە بێت.',
  usedSerialLine: (state, source) => `بەدواداچوونی ژمارەی زنجیرەیی: ${state} — ${source}`,
  usedStateOn: 'چالاکە',
  usedStateOff: 'ناچالاکە',
  usedSourceProduct: 'ڕێکخستنی خودی بەرهەمەکە',
  usedSourcePrinter: 'چونکە چاپکەرە',
  usedSourceSection: (n) => `سیاسەتی بەشی «${n}»`,
  usedSourceDefault: 'بنەڕەت',
  sectionUsedHint: 'بۆ ئامێرە بەکارهاتووەکان کە ژمارەی زنجیرەییان پێویستە (وەک AMS)، سیاسەتی بەشەکەیان بکە بە «پێویستە»؛ پاشکۆ ئاساییەکان پێویستیان پێی نییە.',
};

export const SERIAL_STRINGS: Record<Language, SerialStrings> = { ar, en, ckb };

export function serialStrings(lang: Language | string): SerialStrings {
  return SERIAL_STRINGS[(lang === 'en' || lang === 'ckb' ? lang : 'ar') as Language];
}
