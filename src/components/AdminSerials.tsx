import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import {
  Barcode, RefreshCw, Search, ShieldCheck, AlertTriangle, Repeat, CalendarClock,
  MessageSquare, Send, ChevronDown, ChevronUp, PackageCheck, Unlink, X, Crown, History,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Overlay } from './ui/Overlay';
import { dateLocale } from './orders/format';
import UnitHistory from './adminWarranty/UnitHistory';

/**
 * Admin — serialized devices: order-units view with serial entry, per-unit
 * delivery correction, replacement, and the warranty-claims workflow. Every
 * mutation asks for a reason where the API requires one and the server
 * writes the audit trail; nothing here shows success before the server
 * confirms.
 */

const STRINGS = {
  ar: {
    title: 'الأجهزة والأرقام التسلسلية',
    tabUnits: 'وحدات الطلبات',
    tabClaims: 'مطالبات الضمان',
    orderPlaceholder: 'رقم الطلب (ORD-…)',
    emailPlaceholder: 'بريد الزبون',
    load: 'عرض',
    loading: 'جارٍ التحميل…',
    noUnits: 'لا توجد وحدات مسجّلة لهذا البحث.',
    notSerialized: 'لا يحتوي هذا الطلب على منتجات مُرقّمة (ops_policy.serialized).',
    backfill: 'إنشاء الوحدات (إعادة المحاولة آمنة)',
    backfillDone: (n: number) => `تم إنشاء ${n} وحدة.`,
    backfillAll: 'إنشاء وحدات كل الطلبات المُسلَّمة الناقصة',
    backfillAllHint: 'طابعات سُلِّمت عبر شركة التوصيل قبل أن يُنشئ التسليم وحداتها. يُصلحها النظام تلقائيًا كل دورة، وهذا الزر يُصلحها الآن.',
    backfillAllDone: (orders: number, units: number) => `تم إنشاء ${units} وحدة في ${orders} طلب.`,
    backfillAllMore: 'بقيت طلبات أخرى — اضغط مرة أخرى.',
    orderNotDelivered: 'تُنشأ الوحدات من حدث التسليم — هذا الطلب غير مُسلَّم بعد.',
    unit: 'وحدة',
    serial: 'الرقم التسلسلي',
    assign: 'تعيين',
    serialPlaceholder: 'أدخل الرقم كما هو على الملصق',
    reassignConfirm: 'هذا الرقم/الوحدة معيّن مسبقًا. إعادة التعيين إجراء مُدقَّق يتطلب سببًا. المتابعة؟',
    reasonPrompt: 'السبب (سيُسجَّل في سجل التدقيق):',
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    delivered: 'تاريخ التسليم',
    correctDelivery: 'تصحيح',
    deliveryPrompt: 'تاريخ/وقت التسليم الصحيح لهذه الوحدة (ISO مثل 2026-08-20T14:00:00Z):',
    warrantyEnd: 'نهاية الضمان',
    replace: 'استبدال',
    replaceNote: 'الاستبدال يحمل تاريخ نهاية الضمان الأصلي (قاعدة "المتبقي مقابل الجديد" بانتظار قرار المالك).',
    reassignTitle: 'إعادة تعيين الرقم التسلسلي؟',
    confirmReassign: 'إعادة التعيين',
    replaceTitle: 'استبدال هذا الجهاز؟',
    replaceBody: 'الاستبدال إجراء مُدقَّق يتطلب سببًا يُسجَّل في سجل التدقيق.',
    replaceSerialLabel: 'الرقم التسلسلي للجهاز البديل (اختياري — يمكن تعيينه لاحقًا)',
    working: 'جارٍ التنفيذ…',
    registered: 'مُفعَّل',
    notRegistered: 'غير مُفعَّل',
    stActive: 'ساري',
    stExpired: 'منتهي',
    stNeedsConfig: 'بحاجة إعداد',
    stNotDelivered: 'غير مُسلَّم',
    daysLeft: (n: number) => `${n} يوم متبقٍ`,
    claimsEmpty: 'لا توجد مطالبات.',
    priorityBadge: 'أولوية PRO',
    priorityHint: 'عضو PRO: تُعالج المطالبة قبل غيرها في الطابور.',
    stage: 'المرحلة',
    moveTo: 'نقل إلى…',
    decisionReason: 'سبب القرار (سيُبلَّغ للزبون ويُسجَّل):',
    reply: 'رد للزبون…',
    send: 'إرسال',
    replaced: 'مُستبدَل',
    viewThread: 'عرض المحادثة',
    hideThread: 'إخفاء المحادثة',
    all: 'الكل',
    refreshed: 'تحديث',
    error: 'حدث خطأ',
    customer: 'الزبون',
    subject: 'الموضوع',
    serialSearchPlaceholder: 'الرقم التسلسلي / رقم الإيصال (WR-…)',
    account: 'الحساب',
    buyer: 'المشتري',
    holder: 'الحامل',
    noHolder: 'غير مرتبط بأي حساب',
    registeredAt: 'تاريخ الربط',
    unlink: 'فكّ الربط من الحساب',
    unlinkTitle: 'فكّ ربط الجهاز من حساب الحامل؟',
    unlinkBody: 'سيُفكّ الجهاز من حساب الحامل الحالي ويمكن لأي حساب مؤهل ربطه من جديد. تواريخ الضمان لا تتغيّر. الإجراء مُدقَّق ويتطلب سببًا.',
    reasonLabel: 'السبب (5 أحرف على الأقل، يُسجَّل في سجل التدقيق)',
    confirmUnlink: 'فكّ الربط',
    unlinking: 'جارٍ فكّ الربط…',
    unlinkedOk: 'تم فكّ ربط الجهاز.',
    editWarranty: 'تعديل مدة الضمان',
    warrantyTitle: 'تعديل مدة ضمان هذه الوحدة؟',
    warrantyBody: 'مدة الضمان تُحسب مرة واحدة عند التسليم. تغييرها هنا قرار متعمّد — منحة من المالك أو تصحيح مدة أساسية مُدخلة بالخطأ — ويُسجَّل في سجل التدقيق باسمك وتاريخه.',
    warrantyNote: 'لا يُعاد إصدار وصل الضمان المطبوع: الوصل لقطة بتاريخه، وإعادة إصداره إجراء منفصل من شاشة «الضمانات».',
    baseMonths: 'المدة الأساسية (شهر)',
    extMonths: 'التمديد (شهر)',
    currentEnd: 'نهاية الضمان الحالية',
    monthsRequired: 'أدخل مدة أساسية صحيحة (1 إلى 240 شهرًا).',
    saveWarranty: 'حفظ المدة',
    warrantySaved: 'تم تحديث مدة الضمان.',
    shorterTitle: 'هذا التغيير يُقصّر ضمانًا قائمًا',
    shorterBody: 'المدة الجديدة تُنهي التغطية قبل تاريخها الحالي. قد يكون الزبون قد أُبلغ بالتاريخ القديم. أكّد أنك تقصد ذلك.',
    shorterConfirm: 'نعم، قصّر التغطية',
    carriedEnd: 'هذه وحدة بديلة تحمل تاريخ نهاية الجهاز الأصلي — عدّل ضمان الوحدة الأصلية.',
    cancel: 'إلغاء',
    close: 'إغلاق',
    warrantyStart: 'البداية',
    history: 'سجل التعديلات',
    hideHistory: 'إخفاء السجل',
    loadMore: 'عرض المزيد',
    awaitingStaff: 'الزبون ينتظر الرد',
    messagesN: (n: number) => `${n} رسالة`,
  },
  en: {
    title: 'Serials & Devices',
    tabUnits: 'Order units',
    tabClaims: 'Warranty claims',
    orderPlaceholder: 'Order ID (ORD-…)',
    emailPlaceholder: 'Customer email',
    load: 'Load',
    loading: 'Loading…',
    noUnits: 'No units recorded for this search.',
    notSerialized: 'This order has no serialized products (ops_policy.serialized).',
    backfill: 'Create units (safe to retry)',
    backfillDone: (n: number) => `${n} unit(s) created.`,
    backfillAll: 'Create missing units for all delivered orders',
    backfillAllHint: 'Printers the courier delivered before deliveries created their units. The system repairs them on every cron run; this button repairs them now.',
    backfillAllDone: (orders: number, units: number) => `${units} ${units === 1 ? 'unit' : 'units'} created across ${orders} ${orders === 1 ? 'order' : 'orders'}.`,
    backfillAllMore: 'More orders remain — press again.',
    orderNotDelivered: 'Units are created from the delivery event — this order is not delivered yet.',
    unit: 'Unit',
    serial: 'Serial',
    assign: 'Assign',
    serialPlaceholder: 'Enter exactly as printed on the label',
    reassignConfirm: 'This serial/unit is already assigned. Reassignment is an audited action that requires a reason. Continue?',
    reasonPrompt: 'Reason (recorded in the audit trail):',
    reasonRequired: 'A reason is required (min 5 characters).',
    delivered: 'Delivered',
    correctDelivery: 'Correct',
    deliveryPrompt: 'Correct delivery timestamp for THIS unit (ISO, e.g. 2026-08-20T14:00:00Z):',
    warrantyEnd: 'Warranty end',
    replace: 'Replace',
    replaceNote: 'The replacement carries the ORIGINAL warranty end date (remaining-vs-new rule pending owner decision).',
    reassignTitle: 'Reassign this serial?',
    confirmReassign: 'Reassign',
    replaceTitle: 'Replace this device?',
    replaceBody: 'Replacement is an audited action that requires a reason, recorded in the audit trail.',
    replaceSerialLabel: 'Serial of the replacement device (optional — can be assigned later)',
    working: 'Working…',
    registered: 'Registered',
    notRegistered: 'Not registered',
    stActive: 'Active',
    stExpired: 'Expired',
    stNeedsConfig: 'Needs config',
    stNotDelivered: 'Not delivered',
    daysLeft: (n: number) => `${n} days left`,
    claimsEmpty: 'No claims.',
    priorityBadge: 'PRO priority',
    priorityHint: 'PRO member: this claim is served ahead of the queue.',
    stage: 'Stage',
    moveTo: 'Move to…',
    decisionReason: 'Decision reason (shown to the customer, audited):',
    reply: 'Reply to the customer…',
    send: 'Send',
    replaced: 'Replaced',
    viewThread: 'View thread',
    hideThread: 'Hide thread',
    all: 'All',
    refreshed: 'Refresh',
    error: 'Something went wrong',
    customer: 'Customer',
    subject: 'Subject',
    serialSearchPlaceholder: 'Serial / receipt no. (WR-…)',
    account: 'Account',
    buyer: 'Buyer',
    holder: 'Holder',
    noHolder: 'Not linked to any account',
    registeredAt: 'Linked',
    unlink: 'Unlink from account',
    unlinkTitle: 'Unlink this device from the holder’s account?',
    unlinkBody: 'The device will be unlinked from its current holder and any eligible account will be able to link it again. Warranty dates do not change. This action is audited and requires a reason.',
    reasonLabel: 'Reason (min 5 characters, recorded in the audit trail)',
    confirmUnlink: 'Unlink',
    unlinking: 'Unlinking…',
    unlinkedOk: 'Device unlinked.',
    editWarranty: 'Change warranty duration',
    warrantyTitle: 'Change this unit’s warranty duration?',
    warrantyBody: 'A warranty duration is computed once, at delivery. Changing it here is a deliberate decision — an owner’s goodwill grant, or a base period that was entered wrong — and it is recorded in the audit trail with your name and the time.',
    warrantyNote: 'The printed receipt is NOT reissued: the paper is a snapshot of its own date, and reissuing it is a separate action on the Warranties screen.',
    baseMonths: 'Base months',
    extMonths: 'Extension months',
    currentEnd: 'Current warranty end',
    monthsRequired: 'Enter a valid base duration (1 to 240 months).',
    saveWarranty: 'Save duration',
    warrantySaved: 'Warranty duration updated.',
    shorterTitle: 'This shortens an existing warranty',
    shorterBody: 'The new duration ends the coverage earlier than it ends today. The customer may already have been told the old date. Confirm that you mean it.',
    shorterConfirm: 'Yes, shorten the coverage',
    carriedEnd: 'This is a replacement unit carrying the original device’s end date — change the original unit’s warranty instead.',
    cancel: 'Cancel',
    close: 'Close',
    warrantyStart: 'Start',
    history: 'Change history',
    hideHistory: 'Hide history',
    loadMore: 'Load more',
    awaitingStaff: 'Customer waiting for a reply',
    messagesN: (n: number) => (n === 1 ? '1 message' : `${n} messages`),
  },
  ckb: {
    title: 'ئامێرەکان و ژمارە زنجیرەییەکان',
    tabUnits: 'یەکەکانی داواکاری',
    tabClaims: 'داواکاریيەکانی گەرەنتی',
    orderPlaceholder: 'ژمارەی داواکاری (ORD-…)',
    emailPlaceholder: 'ئیمەیلی کڕیار',
    load: 'پیشاندان',
    loading: 'باردەکرێت…',
    noUnits: 'هیچ یەکەیەک بۆ ئەم گەڕانە تۆمار نەکراوە.',
    notSerialized: 'ئەم داواکارییە بەرهەمی ژمارە زنجیرەیی تێدا نییە (ops_policy.serialized).',
    backfill: 'دروستکردنی یەکەکان (دووبارەکردنەوە سەلامەتە)',
    backfillDone: (n: number) => `${n} یەکە دروستکرا.`,
    backfillAll: 'إنشاء وحدات كل الطلبات المُسلَّمة الناقصة', // OWNER: Sorani to be written by hand.
    backfillAllHint: 'طابعات سُلِّمت عبر شركة التوصيل قبل أن يُنشئ التسليم وحداتها. يُصلحها النظام تلقائيًا كل دورة، وهذا الزر يُصلحها الآن.', // OWNER: Sorani to be written by hand.
    backfillAllDone: (orders: number, units: number) => `تم إنشاء ${units} وحدة في ${orders} طلب.`, // OWNER: Sorani to be written by hand.
    backfillAllMore: 'بقيت طلبات أخرى — اضغط مرة أخرى.', // OWNER: Sorani to be written by hand.
    orderNotDelivered: 'یەکەکان لە ڕووداوی گەیاندنەوە دروستدەکرێن — ئەم داواکارییە هێشتا نەگەیەنراوە.',
    unit: 'یەکە',
    serial: 'ژمارە زنجیرەیی',
    assign: 'دیاریکردن',
    serialPlaceholder: 'وەک لەسەر لەیبڵەکە نووسراوە بینووسە',
    reassignConfirm: 'ئەم ژمارە/یەکەیە پێشتر دیاریکراوە. گۆڕینەوە کردارێکی وردبینیکراوە و هۆکاری دەوێت. بەردەوامبوون؟',
    reasonPrompt: 'هۆکار (لە تۆماری وردبینیدا تۆماردەکرێت):',
    reasonRequired: 'هۆکار پێویستە (لانیکەم ٥ پیت).',
    delivered: 'گەیاندن',
    correctDelivery: 'ڕاستکردنەوە',
    deliveryPrompt: 'کاتی گەیاندنی ڕاست بۆ ئەم یەکەیە (ISO وەک 2026-08-20T14:00:00Z):',
    warrantyEnd: 'کۆتایی گەرەنتی',
    replace: 'گۆڕینەوە',
    replaceNote: 'گۆڕینەوەکە هەمان بەرواری کۆتایی گەرەنتی ڕەسەن هەڵدەگرێت (یاسای "ماوە بەرامبەر نوێ" چاوەڕوانی بڕیاری خاوەنە).',
    reassignTitle: 'ئەم ژمارە زنجیرەییە دووبارە دیاری بکرێت؟',
    confirmReassign: 'دووبارە دیاریکردن',
    replaceTitle: 'ئەم ئامێرە بگۆڕدرێتەوە؟',
    replaceBody: 'گۆڕینەوە کردارێکی وردبینیکراوە و هۆکاری دەوێت کە لە تۆماری وردبینیدا تۆماردەکرێت.',
    replaceSerialLabel: 'ژمارە زنجیرەیی ئامێرە نوێیەکە (ئارەزوومەندانە — دواتر دەکرێت دیاری بکرێت)',
    working: 'جێبەجێدەکرێت…',
    registered: 'چالاککراوە',
    notRegistered: 'چالاک نەکراوە',
    stActive: 'کارا',
    stExpired: 'بەسەرچووە',
    stNeedsConfig: 'پێویستی بە ڕێکخستنە',
    stNotDelivered: 'نەگەیەنراوە',
    daysLeft: (n: number) => `${n} ڕۆژ ماوە`,
    claimsEmpty: 'هیچ داواکارییەک نییە.',
    priorityBadge: 'پێشینەیی PRO',
    priorityHint: 'ئەندامی PRO: ئەم داواکارییە پێش ئەوانی تر لە ڕیزەکە دەکرێت.',
    stage: 'قۆناغ',
    moveTo: 'گواستنەوە بۆ…',
    decisionReason: 'هۆکاری بڕیار (بۆ کڕیار پیشاندەدرێت و تۆماردەکرێت):',
    reply: 'وەڵامدانەوەی کڕیار…',
    send: 'ناردن',
    replaced: 'گۆڕدراوەتەوە',
    viewThread: 'بینینی گفتوگۆ',
    hideThread: 'شاردنەوەی گفتوگۆ',
    all: 'هەموو',
    refreshed: 'نوێکردنەوە',
    error: 'هەڵەیەک ڕوویدا',
    customer: 'کڕیار',
    subject: 'بابەت',
    serialSearchPlaceholder: 'ژمارە زنجیرەیی / ژمارەی پسووڵە (WR-…)',
    account: 'هەژمار',
    buyer: 'کڕیار',
    holder: 'هەڵگر',
    noHolder: 'بە هیچ هەژمارێک نەبەستراوە',
    registeredAt: 'بەستراوە',
    unlink: 'لابردنی بەستن لە هەژمار',
    unlinkTitle: 'بەستنی ئەم ئامێرە لە هەژماری هەڵگر لابردرێت؟',
    unlinkBody: 'ئامێرەکە لە هەژماری هەڵگری ئێستا دەکرێتەوە و هەر هەژمارێکی شیاو دەتوانێت دووبارە بیبەستێت. بەروارەکانی گەرەنتی ناگۆڕێن. ئەم کردارە وردبینیکراوە و هۆکاری دەوێت.',
    reasonLabel: 'هۆکار (لانیکەم ٥ پیت، لە تۆماری وردبینیدا تۆماردەکرێت)',
    confirmUnlink: 'لابردنی بەستن',
    unlinking: 'لابردنی بەستن…',
    unlinkedOk: 'بەستنی ئامێرەکە لابرا.',
    // OWNER: THE SORANI FOR THE WARRANTY-DURATION BLOCK IS YOURS TO WRITE BY
    // HAND. Every key below carries the ARABIC text on purpose — it is never
    // machine-translated Kurdish, and this screen is the one that SHORTENS a
    // customer's live warranty, so a confirm button phrased by a machine is
    // the worst possible place to start. The Sorani entries elsewhere in this
    // table are the owner's own earlier wording and are untouched.
    editWarranty: 'تعديل مدة الضمان', // OWNER: Sorani to be written by hand.
    warrantyTitle: 'تعديل مدة ضمان هذه الوحدة؟', // OWNER: Sorani to be written by hand.
    warrantyBody: 'مدة الضمان تُحسب مرة واحدة عند التسليم. تغييرها هنا قرار متعمّد — منحة من المالك أو تصحيح مدة أساسية مُدخلة بالخطأ — ويُسجَّل في سجل التدقيق باسمك وتاريخه.', // OWNER: Sorani to be written by hand.
    warrantyNote: 'لا يُعاد إصدار وصل الضمان المطبوع: الوصل لقطة بتاريخه، وإعادة إصداره إجراء منفصل من شاشة «الضمانات».', // OWNER: Sorani to be written by hand.
    baseMonths: 'المدة الأساسية (شهر)', // OWNER: Sorani to be written by hand.
    extMonths: 'التمديد (شهر)', // OWNER: Sorani to be written by hand.
    currentEnd: 'نهاية الضمان الحالية', // OWNER: Sorani to be written by hand.
    monthsRequired: 'أدخل مدة أساسية صحيحة (1 إلى 240 شهرًا).', // OWNER: Sorani to be written by hand.
    saveWarranty: 'حفظ المدة', // OWNER: Sorani to be written by hand.
    warrantySaved: 'تم تحديث مدة الضمان.', // OWNER: Sorani to be written by hand.
    shorterTitle: 'هذا التغيير يُقصّر ضمانًا قائمًا', // OWNER: Sorani to be written by hand.
    shorterBody: 'المدة الجديدة تُنهي التغطية قبل تاريخها الحالي. قد يكون الزبون قد أُبلغ بالتاريخ القديم. أكّد أنك تقصد ذلك.', // OWNER: Sorani to be written by hand.
    shorterConfirm: 'نعم، قصّر التغطية', // OWNER: Sorani to be written by hand.
    carriedEnd: 'هذه وحدة بديلة تحمل تاريخ نهاية الجهاز الأصلي — عدّل ضمان الوحدة الأصلية.', // OWNER: Sorani to be written by hand.
    cancel: 'هەڵوەشاندنەوە',
    close: 'داخستن',
    // OWNER: the six labels below carry the ARABIC text on purpose, like the
    // warranty-duration block above — Sorani to be written by hand.
    warrantyStart: 'البداية', // OWNER: Sorani to be written by hand.
    history: 'سجل التعديلات', // OWNER: Sorani to be written by hand.
    hideHistory: 'إخفاء السجل', // OWNER: Sorani to be written by hand.
    loadMore: 'عرض المزيد', // OWNER: Sorani to be written by hand.
    awaitingStaff: 'الزبون ينتظر الرد', // OWNER: Sorani to be written by hand.
    messagesN: (n: number) => `${n} رسالة`, // OWNER: Sorani to be written by hand.
  },
} as const;

type Lang = keyof typeof STRINGS;

interface AdminDevice {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  product: { id: string | null; name: string; name_ar: string; image: string };
  serial: string | null;
  delivered_at: string | null;
  warranty: {
    start_at: string | null;
    end_at: string | null;
    base_months: number | null;
    ext_months: number;
    state: 'active' | 'expired' | 'needs_config' | 'not_delivered';
    remaining_days: number | null;
  };
  replaced_by_unit_id: string | null;
  replacement_of_unit_id: string | null;
  registration: { user_id: string | null; registered_at: string; revoked_at: string | null } | null;
  /** WHO BOUGHT IT and WHO HOLDS IT — on every admin branch, not only the
   *  serial lookup: an admin searching by order number or by the customer's
   *  email is exactly the admin who does not know the serial yet. */
  buyer: AdminAccount | null;
  holder: AdminAccount | null;
}

/** An audited unit action waiting on the admin's confirmation and reason. */
type PendingUnitAction =
  | { kind: 'reassign'; device: AdminDevice; serial: string; detail: string }
  | { kind: 'replace'; device: AdminDevice }
  | { kind: 'warranty'; device: AdminDevice };

interface AdminAccount {
  id: string;
  email: string | null;
  username: string | null;
  name: string | null;
}

function accountLabel(a: AdminAccount | null | undefined): string {
  if (!a) return '—';
  return a.email || (a.username ? `@${a.username}` : '') || a.name || a.id;
}

interface AdminOrderUnits {
  order: { id: string; user_id: string; email: string | null; status: string; delivered_at: string | null };
  items: Array<{ id: string; name: string; qty: number; serialized: boolean; base_months: number | null }>;
  units: AdminDevice[];
}

interface AdminClaim {
  id: string;
  unit_id: string | null;
  subject: string;
  product_name: string;
  description: string;
  stage: string;
  decision: string | null;
  decision_reason: string;
  created_at: string;
  serial: string | null;
  email: string | null;
  evidence: Array<{ key: string; url: string }>;
  /** PRO membership's priority service, snapshotted when the claim was filed; the queue is sorted by it. */
  priority: boolean;
  message_count?: number;
  /** The customer wrote last — the thread is waiting on the warranty team. */
  awaiting_staff?: boolean;
}

interface AdminClaimsPage {
  claims: AdminClaim[];
  has_more?: boolean;
  /** The last row's keyset — passed back as `after` for «عرض المزيد». */
  next_cursor?: string | null;
  /** The whole queue per stage (not the page) — each filter says what it holds. */
  counts?: Record<string, number>;
}

interface ClaimMessage {
  id: string;
  is_staff: boolean;
  body: string;
  file_url: string | null;
  created_at: string;
}

const CLAIM_STAGES = ['received', 'diagnosing', 'approved', 'rejected', 'repairing', 'replaced', 'resolved'] as const;
const CLAIM_NEXT: Record<string, string[]> = {
  received: ['diagnosing', 'approved', 'rejected'],
  diagnosing: ['approved', 'rejected'],
  approved: ['repairing', 'replaced', 'resolved', 'rejected'],
  repairing: ['resolved', 'replaced'],
  replaced: ['resolved'],
  rejected: ['diagnosing'],
  resolved: [],
};

const STAGE_CLS: Record<string, string> = {
  received: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
  diagnosing: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  approved: 'bg-green-500/10 text-green-400 border-green-500/30',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/30',
  repairing: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  replaced: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  resolved: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
};

function fmtDate(iso: string | null, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
}

function CoverageBadge({ device, s }: { device: AdminDevice; s: (typeof STRINGS)[Lang] }) {
  const st = device.warranty.state;
  const cls =
    st === 'active'
      ? 'bg-green-500/10 text-green-400 border-green-500/30'
      : st === 'expired'
        ? 'bg-red-500/10 text-red-400 border-red-500/30'
        : st === 'needs_config'
          ? 'bg-orange-500/10 text-orange-400 border-orange-500/30'
          : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30';
  const label =
    st === 'active'
      ? `${s.stActive}${device.warranty.remaining_days !== null ? ` · ${s.daysLeft(device.warranty.remaining_days)}` : ''}`
      : st === 'expired'
        ? s.stExpired
        : st === 'needs_config'
          ? s.stNeedsConfig
          : s.stNotDelivered;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${cls}`}>{label}</span>;
}

export default function AdminSerials() {
  const { lang } = useLanguage();
  const s = STRINGS[lang];

  const [tab, setTab] = useState<'units' | 'claims'>('units');

  // ------------------------------------------------------------- units tab
  const [orderQuery, setOrderQuery] = useState('');
  const [emailQuery, setEmailQuery] = useState('');
  const [serialQuery, setSerialQuery] = useState('');
  const [orderData, setOrderData] = useState<AdminOrderUnits | null>(null);
  const [customerUnits, setCustomerUnits] = useState<AdminDevice[] | null>(null);
  const [serialUnits, setSerialUnits] = useState<AdminDevice[] | null>(null);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [unitsError, setUnitsError] = useState('');
  const [unitsNotice, setUnitsNotice] = useState('');
  const [serialDrafts, setSerialDrafts] = useState<Record<string, string>>({});
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  // «مَن غيّر ومتى» — a unit's audit trail, opened per row, refetched after
  // every change this screen makes so the row just written is in it.
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [historyTick, setHistoryTick] = useState(0);

  // Unlink-from-account confirmation (an in-app window, never window.confirm).
  const [unlinkTarget, setUnlinkTarget] = useState<AdminDevice | null>(null);
  const [unlinkReason, setUnlinkReason] = useState('');
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');

  // Serial reassignment and unit replacement are audited too: each confirms
  // in an in-app window that also collects the required reason — never a
  // browser confirm() or prompt().
  const [pending, setPending] = useState<PendingUnitAction | null>(null);
  const [pendingReason, setPendingReason] = useState('');
  const [pendingSerial, setPendingSerial] = useState('');
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState('');
  // The warranty-duration edit: the two month fields, and the second,
  // explicit consent the server demands before a window is pulled IN. The
  // flag is armed only after the server has refused once, so the admin can
  // never shorten a live warranty on the first click.
  const [pendingBase, setPendingBase] = useState('');
  const [pendingExt, setPendingExt] = useState('');
  const [pendingShorter, setPendingShorter] = useState(false);

  const loadBySerial = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setUnitsLoading(true);
    setUnitsError('');
    setUnitsNotice('');
    setOrderData(null);
    setCustomerUnits(null);
    try {
      const data = await api.get<{ units: AdminDevice[] }>(`/api/devices/admin/units?serial=${encodeURIComponent(q.trim())}`);
      setSerialUnits(data.units);
    } catch (e) {
      setSerialUnits(null);
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnitsLoading(false);
    }
  }, [s.error]);

  const loadOrder = useCallback(async (orderId: string) => {
    if (!orderId.trim()) return;
    setUnitsLoading(true);
    setUnitsError('');
    setUnitsNotice('');
    setCustomerUnits(null);
    setSerialUnits(null);
    try {
      const data = await api.get<AdminOrderUnits>(`/api/devices/admin/orders/${encodeURIComponent(orderId.trim())}/units`);
      setOrderData(data);
    } catch (e) {
      setOrderData(null);
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnitsLoading(false);
    }
  }, [s.error]);

  const loadCustomer = useCallback(async (email: string) => {
    if (!email.trim()) return;
    setUnitsLoading(true);
    setUnitsError('');
    setUnitsNotice('');
    setOrderData(null);
    setSerialUnits(null);
    try {
      const data = await api.get<{ units: AdminDevice[] }>(`/api/devices/admin/units?email=${encodeURIComponent(email.trim())}`);
      setCustomerUnits(data.units);
    } catch (e) {
      setCustomerUnits(null);
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnitsLoading(false);
    }
  }, [s.error]);

  const refreshCurrent = useCallback(() => {
    setHistoryTick((n) => n + 1);
    if (orderData) loadOrder(orderData.order.id);
    else if (customerUnits && emailQuery) loadCustomer(emailQuery);
    else if (serialUnits && serialQuery) loadBySerial(serialQuery);
  }, [orderData, customerUnits, emailQuery, serialUnits, serialQuery, loadOrder, loadCustomer, loadBySerial]);

  const openUnlink = (device: AdminDevice) => {
    setUnlinkTarget(device);
    setUnlinkReason('');
    setUnlinkError('');
  };

  const confirmUnlink = async () => {
    if (!unlinkTarget || unlinkBusy) return;
    const reason = unlinkReason.trim();
    if (reason.length < 5) {
      setUnlinkError(s.reasonRequired);
      return;
    }
    setUnlinkBusy(true);
    setUnlinkError('');
    try {
      await api.post(`/api/devices/admin/units/${encodeURIComponent(unlinkTarget.unit_id)}/unregister`, { reason });
      setUnlinkTarget(null);
      setUnitsNotice(s.unlinkedOk);
      refreshCurrent();
    } catch (e) {
      setUnlinkError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnlinkBusy(false);
    }
  };

  const backfill = async () => {
    if (!orderData) return;
    setUnitsError('');
    setUnitsNotice('');
    try {
      const res = await api.post<{ created: number }>(`/api/devices/admin/orders/${orderData.order.id}/units/backfill`);
      setUnitsNotice(s.backfillDone(res.created));
      await loadOrder(orderData.order.id);
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    }
  };

  // Every delivered printer order the courier left without units, at once —
  // the same pass the cron runs (POST /admin/units/backfill-delivered).
  const [backfillAllBusy, setBackfillAllBusy] = useState(false);
  const backfillAll = async () => {
    setUnitsError('');
    setUnitsNotice('');
    setBackfillAllBusy(true);
    try {
      const res = await api.post<{ orders: number; created: number; has_more: boolean }>('/api/devices/admin/units/backfill-delivered');
      setUnitsNotice(`${s.backfillAllDone(res.orders, res.created)}${res.has_more ? ` ${s.backfillAllMore}` : ''}`);
      if (orderData) await loadOrder(orderData.order.id);
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setBackfillAllBusy(false);
    }
  };

  const assignSerial = async (device: AdminDevice) => {
    const serial = (serialDrafts[device.unit_id] ?? '').trim();
    if (!serial) return;
    setBusyUnit(device.unit_id);
    setUnitsError('');
    try {
      await api.post(`/api/devices/admin/units/${device.unit_id}/serial`, { serial });
      setSerialDrafts((d) => ({ ...d, [device.unit_id]: '' }));
      refreshCurrent();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REASSIGN_REQUIRED') {
        // The server names the clash; the admin confirms it, with a reason,
        // in the window below.
        openPending({ kind: 'reassign', device, serial, detail: e.message });
      } else {
        setUnitsError(e instanceof ApiError ? e.message : s.error);
      }
    } finally {
      setBusyUnit(null);
    }
  };

  const openPending = (action: PendingUnitAction) => {
    setPending(action);
    setPendingReason('');
    setPendingSerial('');
    setPendingError('');
    setPendingShorter(false);
    setPendingBase(action.device.warranty.base_months !== null ? String(action.device.warranty.base_months) : '');
    setPendingExt(String(action.device.warranty.ext_months ?? 0));
  };

  const confirmPending = async () => {
    if (!pending || pendingBusy) return;
    const reason = pendingReason.trim();
    if (reason.length < 5) {
      setPendingError(s.reasonRequired);
      return;
    }
    setPendingBusy(true);
    setPendingError('');
    setBusyUnit(pending.device.unit_id);
    setUnitsError('');
    try {
      if (pending.kind === 'reassign') {
        await api.post(`/api/devices/admin/units/${pending.device.unit_id}/serial`, { serial: pending.serial, reassign: true, reason });
        setSerialDrafts((d) => ({ ...d, [pending.device.unit_id]: '' }));
      } else if (pending.kind === 'warranty') {
        const base = Number(pendingBase);
        if (!Number.isInteger(base) || base < 1 || base > 240) {
          setPendingError(s.monthsRequired);
          return;
        }
        const ext = Number(pendingExt || '0');
        if (!Number.isInteger(ext) || ext < 0 || ext > 240) {
          setPendingError(s.monthsRequired);
          return;
        }
        await api.patch(`/api/devices/admin/units/${pending.device.unit_id}/warranty`, {
          base_months: base,
          ext_months: ext,
          reason,
          // Sent only after the server has already refused this exact change
          // once and the admin ticked the box below.
          confirm_shorter: pendingShorter || undefined,
        });
        setUnitsNotice(s.warrantySaved);
      } else {
        const res = await api.post<{ note: string }>(`/api/devices/admin/units/${pending.device.unit_id}/replace`, {
          new_serial: pendingSerial.trim() || undefined,
          reason,
        });
        setUnitsNotice(res.note);
      }
      setPending(null);
      refreshCurrent();
    } catch (e) {
      // The server refuses a shortening it was not told about. That refusal
      // is the prompt, not an error to swallow: arm the confirmation and let
      // the admin say it again on purpose.
      if (e instanceof ApiError && e.code === 'CONFIRM_SHORTER_REQUIRED') setPendingShorter(true);
      setPendingError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setPendingBusy(false);
      setBusyUnit(null);
    }
  };

  const correctDelivery = async (device: AdminDevice) => {
    const ts = window.prompt(s.deliveryPrompt, device.delivered_at ?? '');
    if (!ts) return;
    const reason = window.prompt(s.reasonPrompt) || '';
    if (reason.trim().length < 5) {
      setUnitsError(s.reasonRequired);
      return;
    }
    setBusyUnit(device.unit_id);
    setUnitsError('');
    try {
      await api.patch(`/api/devices/admin/units/${device.unit_id}/delivery`, { delivered_at: ts.trim(), reason: reason.trim() });
      refreshCurrent();
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setBusyUnit(null);
    }
  };

  const replaceUnit = (device: AdminDevice) => openPending({ kind: 'replace', device });
  const editWarranty = (device: AdminDevice) => openPending({ kind: 'warranty', device });

  // ------------------------------------------------------------ claims tab
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  // The queue is paged by the server and filtered there too (it used to be
  // cut at 300 rows and THEN filtered, so older claims at a stage vanished).
  // Keyset, not page number: a claim moved to another stage while page 1 is
  // open would otherwise shift the next page and fall between the two.
  const [claimsCursor, setClaimsCursor] = useState<string | null>(null);
  const [claimsHasMore, setClaimsHasMore] = useState(false);
  const [claimCounts, setClaimCounts] = useState<Record<string, number> | null>(null);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [thread, setThread] = useState<ClaimMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  const loadClaims = useCallback(async (after: string | null = null) => {
    setClaimsLoading(true);
    setClaimsError('');
    try {
      const qs = new URLSearchParams();
      if (after) qs.set('after', after);
      if (stageFilter !== 'all') qs.set('stage', stageFilter);
      const data = await api.get<AdminClaimsPage>(`/api/devices/admin/claims?${qs.toString()}`);
      setClaims((prev) =>
        !after ? data.claims : [...prev, ...data.claims.filter((cl) => !prev.some((p) => p.id === cl.id))]
      );
      setClaimsCursor(data.next_cursor ?? null);
      setClaimsHasMore(data.has_more === true);
      setClaimCounts(data.counts ?? null);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimsLoading(false);
    }
  }, [stageFilter, s.error]);

  useEffect(() => {
    if (tab === 'claims') loadClaims(null);
  }, [tab, loadClaims]);

  const openThread = async (claimId: string) => {
    if (openClaim === claimId) {
      setOpenClaim(null);
      return;
    }
    setOpenClaim(claimId);
    setThread([]);
    setThreadLoading(true);
    try {
      const data = await api.get<{ messages: ClaimMessage[] }>(`/api/devices/claims/${claimId}`);
      setThread(data.messages);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setThreadLoading(false);
    }
  };

  const moveClaim = async (claim: AdminClaim, next: string) => {
    const needsReason = ['approved', 'rejected', 'replaced', 'resolved'].includes(next);
    let reason = '';
    if (needsReason) {
      reason = window.prompt(s.decisionReason) || '';
      if (reason.trim().length < 5) {
        setClaimsError(s.reasonRequired);
        return;
      }
    }
    setClaimBusy(true);
    setClaimsError('');
    try {
      await api.patch(`/api/devices/admin/claims/${claim.id}`, { stage: next, reason: reason.trim() || undefined });
      await loadClaims(null);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimBusy(false);
    }
  };

  const sendReply = async (claimId: string) => {
    if (!replyText.trim()) return;
    setClaimBusy(true);
    setClaimsError('');
    try {
      await api.post(`/api/devices/claims/${claimId}/messages`, { body: replyText.trim() });
      setReplyText('');
      const data = await api.get<{ messages: ClaimMessage[] }>(`/api/devices/claims/${claimId}`);
      setThread(data.messages);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimBusy(false);
    }
  };

  const renderUnitsTable = (units: AdminDevice[]) => (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[980px]">
          <thead>
            <tr className="bg-zinc-800/50 border-b border-zinc-700">
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.unit}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.serial}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.delivered}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.warrantyEnd}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.stage}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.account}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase" />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <React.Fragment key={u.unit_id}>
              <tr className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors align-top">
                <td className="py-3 px-4">
                  <div className="text-sm text-white font-bold">{u.product.name_ar || u.product.name || '—'}</div>
                  <div className="text-[11px] text-zinc-500 font-mono">#{u.unit_index} · {u.unit_id}</div>
                  <div className="text-[11px] text-zinc-500 font-mono">{u.order_id}</div>
                  {u.replaced_by_unit_id && (
                    <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-purple-300"><Repeat className="w-3 h-3" />{s.replaced}</span>
                  )}
                  <div className="text-[11px] mt-1">
                    {u.registration && !u.registration.revoked_at ? (
                      <span className="text-green-400 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{s.registered}</span>
                    ) : (
                      <span className="text-zinc-500">{s.notRegistered}</span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-4">
                  {u.serial ? (
                    <div className="font-mono text-sm text-white break-all">{u.serial}</div>
                  ) : null}
                  {!u.replaced_by_unit_id && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <input
                        value={serialDrafts[u.unit_id] ?? ''}
                        onChange={(e) => setSerialDrafts((d) => ({ ...d, [u.unit_id]: e.target.value }))}
                        placeholder={u.serial ? '' : s.serialPlaceholder}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white font-mono w-44 outline-none focus:border-olive/60"
                      />
                      <button
                        type="button"
                        onClick={() => assignSerial(u)}
                        disabled={busyUnit === u.unit_id || !(serialDrafts[u.unit_id] ?? '').trim()}
                        className="text-xs font-bold bg-olive/20 text-olive border border-olive/30 rounded-lg px-2.5 py-1.5 hover:bg-olive/30 disabled:opacity-40 transition-colors"
                      >
                        {s.assign}
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-zinc-300 whitespace-nowrap">{fmtDate(u.delivered_at, lang)}</div>
                  {!u.replaced_by_unit_id && (
                    <button
                      onClick={() => correctDelivery(u)}
                      disabled={busyUnit === u.unit_id}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] text-zinc-400 hover:text-white transition-colors disabled:opacity-40"
                    >
                      <CalendarClock className="w-3 h-3" />{s.correctDelivery}
                    </button>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-zinc-300 whitespace-nowrap">{fmtDate(u.warranty.end_at, lang)}</div>
                  <div className="text-[11px] text-zinc-500 whitespace-nowrap" data-unit-start={u.unit_id}>
                    {s.warrantyStart}: {fmtDate(u.warranty.start_at, lang)}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {u.warranty.base_months !== null ? `${u.warranty.base_months}m` : '—'}
                    {u.warranty.ext_months > 0 ? ` +${u.warranty.ext_months}m` : ''}
                  </div>
                  {/* The duration itself, not just the delivery date it is
                      measured from. A replaced unit is frozen here for the
                      same reason it is frozen everywhere else on this row. */}
                  {!u.replaced_by_unit_id && (
                    <button
                      type="button"
                      onClick={() => editWarranty(u)}
                      disabled={busyUnit === u.unit_id}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] text-zinc-400 hover:text-white transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded"
                    >
                      <ShieldCheck className="w-3 h-3" aria-hidden="true" />{s.editWarranty}
                    </button>
                  )}
                </td>
                <td className="py-3 px-4"><CoverageBadge device={u} s={s} /></td>
                <td className="py-3 px-4 text-[11px] leading-relaxed">
                  {u.buyer !== undefined || u.holder !== undefined ? (
                    <>
                      <div className="text-zinc-500 whitespace-nowrap">
                        {s.buyer}: <span className="text-zinc-300 break-all whitespace-normal">{accountLabel(u.buyer)}</span>
                      </div>
                      <div className="text-zinc-500 whitespace-nowrap">
                        {s.holder}:{' '}
                        {u.holder ? (
                          <span className="text-green-400 break-all whitespace-normal">{accountLabel(u.holder)}</span>
                        ) : (
                          <span className="text-zinc-400">{s.noHolder}</span>
                        )}
                      </div>
                      {u.holder && u.registration && !u.registration.revoked_at && (
                        <div className="text-zinc-500 whitespace-nowrap">
                          {s.registeredAt}: <span className="text-zinc-300">{fmtDate(u.registration.registered_at, lang)}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="flex flex-col items-start gap-1.5">
                    {!u.replaced_by_unit_id && (
                      <button
                        type="button"
                        onClick={() => replaceUnit(u)}
                        disabled={busyUnit === u.unit_id}
                        className="inline-flex items-center gap-1 text-xs font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30 rounded-lg px-2.5 py-1.5 hover:bg-purple-500/20 disabled:opacity-40 transition-colors"
                      >
                        <Repeat className="w-3 h-3" />{s.replace}
                      </button>
                    )}
                    {u.holder && (
                      <button
                        type="button"
                        onClick={() => openUnlink(u)}
                        disabled={busyUnit === u.unit_id}
                        className="inline-flex items-center gap-1 text-xs font-bold bg-red-500/10 text-red-300 border border-red-500/30 rounded-lg px-2.5 py-1.5 hover:bg-red-500/20 disabled:opacity-40 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                      >
                        <Unlink className="w-3 h-3" aria-hidden="true" />{s.unlink}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((h) => ({ ...h, [u.unit_id]: !h[u.unit_id] }))}
                      aria-expanded={!!historyOpen[u.unit_id]}
                      data-unit-history-toggle={u.unit_id}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded"
                    >
                      <History className="w-3 h-3" aria-hidden="true" />
                      {historyOpen[u.unit_id] ? s.hideHistory : s.history}
                    </button>
                  </div>
                </td>
              </tr>
              {historyOpen[u.unit_id] && (
                <tr className="border-b border-zinc-800 bg-zinc-950/30">
                  <td colSpan={7} className="px-4 py-3">
                    <UnitHistory unitId={u.unit_id} lang={lang} refreshKey={historyTick} />
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
            {units.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-zinc-500 font-medium">{s.noUnits}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-2xl font-black text-white flex items-center gap-2"><Barcode className="w-6 h-6 text-olive" />{s.title}</h2>
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(['units', 'claims'] as const).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tab === tb ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {tb === 'units' ? s.tabUnits : s.tabClaims}
            </button>
          ))}
        </div>
      </div>

      {tab === 'units' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadOrder(orderQuery); }}>
              <input
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
                placeholder={s.orderPlaceholder}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm font-mono outline-none focus:border-olive/50"
              />
              <button type="submit" className="inline-flex items-center gap-1.5 bg-olive/20 text-olive border border-olive/30 rounded-xl px-4 text-sm font-bold hover:bg-olive/30 transition-colors">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadCustomer(emailQuery); }}>
              <input
                value={emailQuery}
                onChange={(e) => setEmailQuery(e.target.value)}
                placeholder={s.emailPlaceholder}
                type="email"
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50"
              />
              <button type="submit" className="inline-flex items-center gap-1.5 bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-xl px-4 text-sm font-bold hover:bg-zinc-700 transition-colors">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadBySerial(serialQuery); }}>
              <input
                value={serialQuery}
                onChange={(e) => setSerialQuery(e.target.value)}
                placeholder={s.serialSearchPlaceholder}
                aria-label={s.serialSearchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm font-mono outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold"
              />
              <button type="submit" className="inline-flex items-center gap-1.5 bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-xl px-4 text-sm font-bold hover:bg-zinc-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                <Barcode className="w-4 h-4" aria-hidden="true" />{s.load}
              </button>
            </form>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <button
              type="button"
              onClick={() => void backfillAll()}
              disabled={backfillAllBusy}
              className="inline-flex items-center gap-1.5 bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-xl px-3 py-2 text-xs font-bold hover:bg-zinc-700 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              <PackageCheck className="w-4 h-4" aria-hidden="true" />{backfillAllBusy ? s.loading : s.backfillAll}
            </button>
            <span>{s.backfillAllHint}</span>
          </div>

          {unitsError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm font-medium">{unitsError}</div>}
          {unitsNotice && <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-2xl p-3 text-sm font-medium">{unitsNotice}</div>}
          {unitsLoading && <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.loading}</div>}

          {orderData && !unitsLoading && (
            <div className="space-y-3">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="font-mono text-white font-bold">{orderData.order.id}</span>
                <span className="text-zinc-400">{s.customer}: <span className="text-zinc-200">{orderData.order.email || orderData.order.user_id}</span></span>
                <span className="text-zinc-400 capitalize">{orderData.order.status}</span>
                <span className="text-zinc-400">{s.delivered}: {fmtDate(orderData.order.delivered_at, lang)}</span>
              </div>
              {orderData.items.some((it) => it.serialized) ? (
                <>
                  {orderData.order.delivered_at ? (
                    orderData.units.length <
                      orderData.items.filter((it) => it.serialized).reduce((n, it) => n + Number(it.qty), 0) && (
                      <button
                        onClick={backfill}
                        className="inline-flex items-center gap-2 bg-olive/20 text-olive border border-olive/30 rounded-xl px-4 py-2.5 text-sm font-bold hover:bg-olive/30 transition-colors"
                      >
                        <PackageCheck className="w-4 h-4" />{s.backfill}
                      </button>
                    )
                  ) : (
                    <div className="flex items-center gap-2 text-orange-400 text-sm font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0" />{s.orderNotDelivered}
                    </div>
                  )}
                  {renderUnitsTable(orderData.units)}
                </>
              ) : (
                <div className="text-zinc-500 text-sm font-medium py-4">{s.notSerialized}</div>
              )}
            </div>
          )}

          {customerUnits && !unitsLoading && renderUnitsTable(customerUnits)}
          {serialUnits && !unitsLoading && renderUnitsTable(serialUnits)}
        </div>
      )}

      {/* UNLINK FROM ACCOUNT — an audited action with a required reason, asked
          for in an in-app window rather than a browser prompt. The scrim and
          Escape are inert while the request is in flight. */}
      <Overlay
        open={!!unlinkTarget}
        onClose={() => { if (!unlinkBusy) setUnlinkTarget(null); }}
        labelledBy="admin-unlink-title"
        dismissOnScrim={!unlinkBusy}
        dismissOnEscape={!unlinkBusy}
        z={60}
        testId="admin-unlink-device"
        panelClassName="w-full max-w-md"
      >
        <div className="p-6 space-y-4">
          <button
            type="button"
            onClick={() => setUnlinkTarget(null)}
            disabled={unlinkBusy}
            aria-label={s.close}
            className="absolute top-4 end-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="pe-10">
            <h3 id="admin-unlink-title" className="text-white text-base font-bold">{s.unlinkTitle}</h3>
            {unlinkTarget && (
              <p className="text-zinc-400 text-[12px] mt-1">
                {unlinkTarget.product.name_ar || unlinkTarget.product.name}
                {unlinkTarget.serial ? <> · <span className="font-mono" dir="ltr">{unlinkTarget.serial}</span></> : null}
                {' · '}{s.holder}: <span className="text-zinc-200">{accountLabel(unlinkTarget.holder)}</span>
              </p>
            )}
          </div>
          <p className="text-zinc-400 text-sm leading-relaxed">{s.unlinkBody}</p>
          <div>
            <label htmlFor="admin-unlink-reason" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.reasonLabel}</label>
            <textarea
              id="admin-unlink-reason"
              value={unlinkReason}
              onChange={(e) => setUnlinkReason(e.target.value)}
              minLength={5}
              maxLength={500}
              rows={3}
              required
              disabled={unlinkBusy}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold resize-none"
            />
          </div>
          {unlinkError && (
            <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-[13px] font-medium">{unlinkError}</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setUnlinkTarget(null)}
              disabled={unlinkBusy}
              className="min-h-[44px] rounded-xl bg-zinc-800 text-zinc-200 border border-zinc-700 text-sm font-bold hover:bg-zinc-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              {s.cancel}
            </button>
            <button
              type="button"
              onClick={confirmUnlink}
              disabled={unlinkBusy || unlinkReason.trim().length < 5}
              className="min-h-[44px] rounded-xl bg-[#ef233c] text-snow text-sm font-bold hover:brightness-110 disabled:opacity-50 transition-[filter,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              {unlinkBusy ? s.unlinking : s.confirmUnlink}
            </button>
          </div>
        </div>
      </Overlay>

      {/* SERIAL REASSIGNMENT / UNIT REPLACEMENT — audited actions with a
          required reason, confirmed in an in-app window rather than a browser
          confirm()/prompt() pair. The scrim and Escape are inert while the
          request is in flight. */}
      <Overlay
        open={!!pending}
        onClose={() => { if (!pendingBusy) setPending(null); }}
        labelledBy="admin-unit-action-title"
        dismissOnScrim={!pendingBusy}
        dismissOnEscape={!pendingBusy}
        z={60}
        testId="admin-unit-action"
        panelClassName="w-full max-w-md"
      >
        <div className="p-6 space-y-4">
          <button
            type="button"
            onClick={() => setPending(null)}
            disabled={pendingBusy}
            aria-label={s.close}
            className="absolute top-4 end-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="pe-10">
            <h3 id="admin-unit-action-title" className="text-white text-base font-bold">
              {pending?.kind === 'replace' ? s.replaceTitle : pending?.kind === 'warranty' ? s.warrantyTitle : s.reassignTitle}
            </h3>
            {pending && (
              <p className="text-zinc-400 text-[12px] mt-1">
                {pending.device.product.name_ar || pending.device.product.name}
                {' · '}
                <span className="font-mono" dir="ltr">#{pending.device.unit_index} · {pending.device.unit_id}</span>
                {pending.kind === 'reassign' && (
                  <>
                    {' · '}{s.serial}: <span className="font-mono text-zinc-200" dir="ltr">{pending.serial}</span>
                  </>
                )}
              </p>
            )}
          </div>
          <p className="text-zinc-400 text-sm leading-relaxed">
            {pending?.kind === 'replace'
              ? `${s.replaceBody} ${s.replaceNote}`
              : pending?.kind === 'warranty'
                ? s.warrantyBody
                : s.reassignConfirm}
          </p>
          {/* The paper is a snapshot by design; moving the clock never
              rewrites a receipt already handed over. Saying so here is the
              difference between a snapshot and a document that went stale
              without anyone being told. */}
          {pending?.kind === 'warranty' && (
            <p className="text-zinc-500 text-[12px] leading-relaxed">{s.warrantyNote}</p>
          )}
          {/* The server's own account of the clash — which unit holds the serial today. */}
          {pending?.kind === 'reassign' && pending.detail && (
            <p className="text-zinc-500 text-[12px] leading-relaxed" dir="auto">{pending.detail}</p>
          )}
          {pending?.kind === 'replace' && (
            <div>
              <label htmlFor="admin-unit-action-serial" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.replaceSerialLabel}</label>
              <input
                id="admin-unit-action-serial"
                value={pendingSerial}
                onChange={(e) => setPendingSerial(e.target.value)}
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                disabled={pendingBusy}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm font-mono outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold"
              />
            </div>
          )}
          {pending?.kind === 'warranty' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="admin-unit-warranty-base" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.baseMonths}</label>
                  <input
                    id="admin-unit-warranty-base"
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    dir="ltr"
                    value={pendingBase}
                    onChange={(e) => setPendingBase(e.target.value)}
                    disabled={pendingBusy}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold"
                  />
                </div>
                <div>
                  <label htmlFor="admin-unit-warranty-ext" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.extMonths}</label>
                  <input
                    id="admin-unit-warranty-ext"
                    type="number"
                    min={0}
                    max={240}
                    step={1}
                    dir="ltr"
                    value={pendingExt}
                    onChange={(e) => setPendingExt(e.target.value)}
                    disabled={pendingBusy}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold"
                  />
                </div>
              </div>
              <p className="text-[12px] text-zinc-500">
                {s.currentEnd}: <span className="text-zinc-300">{fmtDate(pending.device.warranty.end_at, lang)}</span>
              </p>
              {pendingShorter && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-amber-200 text-[13px] font-bold">{s.shorterTitle}</p>
                  <p className="text-amber-200/80 text-[12px] leading-relaxed">{s.shorterBody}</p>
                  <p className="text-amber-200/80 text-[12px] font-bold">{s.shorterConfirm}</p>
                </div>
              )}
            </div>
          )}
          <div>
            <label htmlFor="admin-unit-action-reason" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.reasonLabel}</label>
            <textarea
              id="admin-unit-action-reason"
              value={pendingReason}
              onChange={(e) => setPendingReason(e.target.value)}
              minLength={5}
              maxLength={500}
              rows={3}
              required
              disabled={pendingBusy}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 focus-visible:ring-2 focus-visible:ring-gold resize-none"
            />
          </div>
          {pendingError && (
            <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-[13px] font-medium">{pendingError}</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={pendingBusy}
              className="min-h-[44px] rounded-xl bg-zinc-800 text-zinc-200 border border-zinc-700 text-sm font-bold hover:bg-zinc-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              {s.cancel}
            </button>
            <button
              type="button"
              onClick={confirmPending}
              disabled={pendingBusy || pendingReason.trim().length < 5}
              className="min-h-[44px] rounded-xl bg-[#ef233c] text-snow text-sm font-bold hover:brightness-110 disabled:opacity-50 transition-[filter,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              {pendingBusy
                ? s.working
                : pending?.kind === 'replace'
                  ? s.replace
                  : pending?.kind === 'warranty'
                    ? pendingShorter
                      ? s.shorterConfirm
                      : s.saveWarranty
                    : s.confirmReassign}
            </button>
          </div>
        </div>
      </Overlay>

      {tab === 'claims' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl overflow-x-auto">
              {(['all', ...CLAIM_STAGES] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setStageFilter(st)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize whitespace-nowrap transition-colors ${stageFilter === st ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {st === 'all' ? s.all : st}
                  {claimCounts && claimCounts[st] !== undefined && (
                    <span className="ms-1.5 tabular-nums text-zinc-500" data-claims-count={st}>
                      {claimCounts[st]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={() => loadClaims(null)}
              className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 hover:text-white transition-colors"
              title={s.refreshed}
            >
              <RefreshCw className={`w-4 h-4 ${claimsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {claimsError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm font-medium">{claimsError}</div>}
          {claimsLoading && claims.length === 0 && <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.loading}</div>}
          {!claimsLoading && claims.length === 0 && !claimsError && (
            <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.claimsEmpty}</div>
          )}

          <div className="space-y-3">
            {claims.map((cl) => (
              <div key={cl.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-white font-bold text-sm">{cl.subject}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {cl.product_name} · {cl.email || '—'} · {cl.serial ? <span className="font-mono">{cl.serial}</span> : '—'} · {fmtDate(cl.created_at, lang)}
                      {cl.message_count !== undefined && <> · {s.messagesN(cl.message_count)}</>}
                    </div>
                    {cl.awaiting_staff && (
                      <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-amber-300" data-claim-awaiting={cl.id}>
                        <MessageSquare className="w-3 h-3" aria-hidden="true" />
                        {s.awaitingStaff}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cl.priority && (
                      <span
                        title={s.priorityHint}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gold/40 bg-gold/10 text-gold text-[11px] font-bold whitespace-nowrap"
                      >
                        <Crown aria-hidden="true" className="w-3 h-3" />
                        {s.priorityBadge}
                      </span>
                    )}
                    <span className={`inline-flex px-2.5 py-1 rounded-full border text-[11px] font-bold capitalize ${STAGE_CLS[cl.stage] ?? STAGE_CLS.received}`}>{cl.stage}</span>
                    {(CLAIM_NEXT[cl.stage] ?? []).length > 0 && (
                      <select
                        value=""
                        disabled={claimBusy}
                        onChange={(e) => { if (e.target.value) moveClaim(cl, e.target.value); }}
                        className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none disabled:opacity-50"
                      >
                        <option value="" disabled>{s.moveTo}</option>
                        {(CLAIM_NEXT[cl.stage] ?? []).map((st) => (
                          <option key={st} value={st} className="capitalize">{st}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <p className="text-zinc-400 text-sm mt-2 whitespace-pre-wrap">{cl.description}</p>
                {cl.decision_reason && (
                  <p className="text-[12px] text-zinc-500 mt-1">{s.decisionReason} {cl.decision_reason}</p>
                )}
                {cl.evidence.length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {cl.evidence.map((ev) => (
                      <a key={ev.key} href={ev.url} target="_blank" rel="noreferrer" className="block w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
                        <img src={ev.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => openThread(cl.id)}
                  className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  {openClaim === cl.id ? s.hideThread : s.viewThread}
                  {openClaim === cl.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {openClaim === cl.id && (
                  <div className="mt-3 border-t border-zinc-800 pt-3 space-y-2">
                    {threadLoading && <div className="text-zinc-500 text-xs">{s.loading}</div>}
                    {thread.map((m) => (
                      <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.is_staff ? 'bg-olive/15 border border-olive/25 text-zinc-100 ms-auto' : 'bg-zinc-800/70 text-zinc-200'}`}>
                        {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                        {m.file_url && (
                          <a href={m.file_url} target="_blank" rel="noreferrer" className="block mt-1">
                            <img src={m.file_url} alt="" className="max-h-40 rounded-lg" loading="lazy" />
                          </a>
                        )}
                        <div className="text-[10px] text-zinc-500 mt-1">{new Date(m.created_at).toLocaleString()}</div>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <input
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={s.reply}
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-olive/50"
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(cl.id); } }}
                      />
                      <button
                        onClick={() => sendReply(cl.id)}
                        disabled={claimBusy || !replyText.trim()}
                        className="inline-flex items-center gap-1.5 bg-olive/20 text-olive border border-olive/30 rounded-xl px-3 text-sm font-bold hover:bg-olive/30 disabled:opacity-40 transition-colors"
                      >
                        <Send className="w-4 h-4" />{s.send}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          {claimsHasMore && (
            <button
              type="button"
              onClick={() => loadClaims(claimsCursor)}
              disabled={claimsLoading}
              data-claims-load-more
              className="w-full min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm font-bold hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              {claimsLoading ? s.loading : s.loadMore}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
