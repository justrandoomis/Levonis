import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import {
  Barcode, RefreshCw, Search, ShieldCheck, AlertTriangle, Repeat, CalendarClock,
  MessageSquare, Send, ChevronDown, ChevronUp, PackageCheck, Unlink, X, Crown, History, ExternalLink, Paperclip,
} from 'lucide-react';
import { api, ApiError, uploadTimeoutMs } from '../lib/api';
import { apiRefusal, refusalLang } from '../lib/refusalStrings';
import { useOptionalAuth } from '../AuthContext';
import { Overlay } from './ui/Overlay';
import { dateLocale } from './orders/format';
import UnitHistory from './adminWarranty/UnitHistory';
import { isVideoUrl } from './warranty/types';

// The §16 serial / warranty page (serial scan, 0178), opened from a unit's serial.
const SerialDetail = React.lazy(() => import('./adminWarranty/serial/SerialDetail'));

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
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    delivered: 'تاريخ التسليم',
    correctDelivery: 'تصحيح',
    deliveryTitle: 'تصحيح تاريخ التسليم',
    deliveryBody: 'نافذة الضمان تتحرك مع تاريخ التسليم. تاريخ أبكر يقصّر الضمان؛ وتاريخ أحدث يطيله، وهذا قرار المالك وحده.',
    deliveryLabel: 'تاريخ ووقت التسليم الصحيح (بتوقيت جهازك)',
    deliveryCurrent: 'التاريخ الحالي',
    deliveryLaterOwner: 'هذا التاريخ أحدث من الحالي فيطيل الضمان — لا يحفظه إلا المالك.',
    deliveryInvalid: 'اختر تاريخًا ووقتًا صحيحين.',
    saveDelivery: 'حفظ التاريخ',
    deliverySaved: 'تم تصحيح تاريخ التسليم.',
    warrantyEnd: 'نهاية الضمان',
    replace: 'استبدال',
    replaceNote: 'الجهاز البديل يحمل تاريخ نهاية ضمان الجهاز الأصلي: الضمان لا يُعاد بدؤه أبدًا (قرار المالك).',
    replacedOk: 'سُجّل الجهاز البديل، وهو يحمل تاريخ نهاية ضمان الجهاز الأصلي.',
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
    stClosed: 'الضمان مُغلق',
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
    // W-1 (row 237): the cover the claim was filed under, as its INSERT recorded it.
    filedInCover: 'قُدِّمت ضمن الضمان',
    filedInUsedSale: 'قُدِّمت ضمن مدة المستعمل',
    filedOutOfCover: 'قُدِّمت بعد انتهاء الضمان',
    messagesN: (n: number) => `${n} رسالة`,
    compatibleParts: (n: number) => `قطع الغيار المتوافقة (${n})`,
    stageLabels: {
      received: 'مُستلَمة',
      diagnosing: 'قيد الفحص',
      approved: 'مقبولة',
      rejected: 'مرفوضة',
      repairing: 'قيد الإصلاح',
      replaced: 'استُبدل الجهاز',
      resolved: 'منتهية',
    } as Record<string, string>,
    decisionLabels: { repair: 'إصلاح', replace: 'استبدال', reject: 'رفض', misuse: 'سوء استخدام' } as Record<string, string>,
    decision: 'القرار',
    moveTitle: (stage: string) => `نقل المطالبة إلى «${stage}»`,
    decisionPick: 'اختر القرار',
    decisionRequired: 'اختر القرار قبل النقل.',
    reasonToCustomer: 'السبب (يصل للزبون مع الإشعار ويُسجَّل، 5 أحرف على الأقل)',
    noteToCustomer: 'ملاحظة للزبون (اختيارية، تصله مع الإشعار)',
    financialOnly: 'قبول المطالبة أو رفضها أو تسجيل الاستبدال يحتاج الصلاحية المالية. يمكنك الفحص والرد ونقل المطالبة المقبولة إلى الإصلاح وإغلاقها.',
    replacedFirst: 'سجّل الجهاز البديل أولاً من زر «استبدال» في تبويب الوحدات، ثم اختر هذه المرحلة.',
    confirmMove: 'نقل المطالبة',
    threadClosed: 'المطالبة مغلقة، فلا يكتب فيها الزبون ولا الفريق. كلمة الفريق الأخيرة هي السبب المكتوب عند إغلاقها.',
    threadReopen: 'المطالبة مرفوضة ومغلقة. أعِدها إلى «قيد الفحص» لمراسلة الزبون من جديد.',
    attachFile: 'إرفاق صورة أو فيديو',
    uploading: 'جارٍ الرفع…',
    video: 'فيديو',
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
    reasonRequired: 'A reason is required (min 5 characters).',
    delivered: 'Delivered',
    correctDelivery: 'Correct',
    deliveryTitle: 'Correct the delivery date',
    deliveryBody: 'The warranty window moves with the delivery date. An earlier date shortens the warranty; a later one lengthens it, which is the owner’s decision alone.',
    deliveryLabel: 'Correct delivery date and time (your device’s time)',
    deliveryCurrent: 'Current date',
    deliveryLaterOwner: 'This date is later than the current one, so it lengthens the warranty — only the owner can save it.',
    deliveryInvalid: 'Choose a valid date and time.',
    saveDelivery: 'Save the date',
    deliverySaved: 'Delivery date corrected.',
    warrantyEnd: 'Warranty end',
    replace: 'Replace',
    replaceNote: 'The replacement carries the ORIGINAL warranty end date: a warranty is never restarted (owner decision).',
    replacedOk: 'Replacement recorded. It carries the original device’s warranty end date.',
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
    stClosed: 'Warranty closed',
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
    filedInCover: 'Filed in warranty',
    filedInUsedSale: 'Filed in used-sale period',
    filedOutOfCover: 'Filed out of warranty',
    messagesN: (n: number) => (n === 1 ? '1 message' : `${n} messages`),
    compatibleParts: (n: number) => `Compatible spare parts (${n})`,
    stageLabels: {
      received: 'Received',
      diagnosing: 'Diagnosing',
      approved: 'Approved',
      rejected: 'Rejected',
      repairing: 'Repairing',
      replaced: 'Replaced',
      resolved: 'Resolved',
    } as Record<string, string>,
    decisionLabels: { repair: 'Repair', replace: 'Replace', reject: 'Reject', misuse: 'Misuse' } as Record<string, string>,
    decision: 'Decision',
    moveTitle: (stage: string) => `Move the claim to “${stage}”`,
    decisionPick: 'Choose the decision',
    decisionRequired: 'Choose the decision first.',
    reasonToCustomer: 'Reason (sent to the customer with the notice and recorded; at least 5 characters)',
    noteToCustomer: 'Note to the customer (optional, sent with the notice)',
    financialOnly: 'Approving, rejecting or recording a replacement needs the financial scope. You can diagnose, reply, move an approved claim into repair, and close it.',
    replacedFirst: 'Record the replacement unit first with “Replace” on the units tab, then choose this stage.',
    confirmMove: 'Move the claim',
    threadClosed: 'The claim is closed: neither the customer nor the team can write in it. The team’s last word is the reason given when it was closed.',
    threadReopen: 'The claim is rejected and closed. Move it back to “Diagnosing” to write to the customer again.',
    attachFile: 'Attach a photo or video',
    uploading: 'Uploading…',
    video: 'Video',
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
    reasonRequired: 'هۆکار پێویستە (لانیکەم ٥ پیت).',
    delivered: 'گەیاندن',
    correctDelivery: 'ڕاستکردنەوە',
    deliveryTitle: 'ڕاستکردنەوەی بەرواری گەیاندن',
    deliveryBody: 'ماوەی گەرەنتی لەگەڵ بەرواری گەیاندن دەجووڵێت. بەروارێکی زووتر گەرەنتی کورت دەکاتەوە؛ بەروارێکی درەنگتر درێژی دەکاتەوە، و ئەوە تەنها بڕیاری خاوەنە.',
    deliveryLabel: 'بەروار و کاتی ڕاستی گەیاندن (بە کاتی ئامێرەکەت)',
    deliveryCurrent: 'بەرواری ئێستا',
    deliveryLaterOwner: 'ئەم بەروارە لە بەرواری ئێستا درەنگترە و گەرەنتی درێژ دەکاتەوە — تەنها خاوەن دەتوانێت پاشەکەوتی بکات.',
    deliveryInvalid: 'بەروار و کاتێکی دروست هەڵبژێرە.',
    saveDelivery: 'پاشەکەوتکردنی بەروار',
    deliverySaved: 'بەرواری گەیاندن ڕاستکرایەوە.',
    warrantyEnd: 'کۆتایی گەرەنتی',
    replace: 'گۆڕینەوە',
    replaceNote: 'ئامێرە جێگرەوەکە هەمان بەرواری کۆتایی گەرەنتی ئامێرە ڕەسەنەکە هەڵدەگرێت: گەرەنتی هەرگیز لە سەرەتاوە دەست پێناکاتەوە (بڕیاری خاوەن).',
    replacedOk: 'ئامێرە جێگرەوەکە تۆمارکرا، و هەمان بەرواری کۆتایی گەرەنتی ئامێرە ڕەسەنەکە هەڵدەگرێت.',
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
    stClosed: 'گەرەنتی داخراوە',
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
    // Sorani of its own, never the Arabic (DECISIONS row 183), in the words
    // this table already uses.
    warrantyStart: 'سەرەتا',
    history: 'مێژووی گۆڕانکارییەکان',
    hideHistory: 'شاردنەوەی مێژوو',
    loadMore: 'زیاتر پیشان بدە',
    awaitingStaff: 'کڕیار چاوەڕێی وەڵامە',
    filedInCover: 'لە ماوەی گەرەنتیدا پێشکەشکرا',
    filedInUsedSale: 'لە ماوەی بەکارهاتوودا پێشکەشکرا',
    filedOutOfCover: 'دوای گەرەنتی پێشکەشکرا',
    messagesN: (n: number) => `${n} نامە`,
    compatibleParts: (n: number) => `پارچە یەدەگە گونجاوەکان (${n})`,
    stageLabels: {
      received: 'وەرگیراوە',
      diagnosing: 'لە پشکنیندایە',
      approved: 'پەسەندکراوە',
      rejected: 'ڕەتکراوەتەوە',
      repairing: 'لە چاککردنەوەدایە',
      replaced: 'ئامێرەکە گۆڕدراوەتەوە',
      resolved: 'تەواوبووە',
    } as Record<string, string>,
    decisionLabels: { repair: 'چاککردنەوە', replace: 'گۆڕین', reject: 'ڕەتکردنەوە', misuse: 'خراپ بەکارهێنان' } as Record<string, string>,
    decision: 'بڕیار',
    moveTitle: (stage: string) => `گواستنەوەی داواکارییەکە بۆ «${stage}»`,
    decisionPick: 'بڕیارەکە هەڵبژێرە',
    decisionRequired: 'سەرەتا بڕیارەکە هەڵبژێرە.',
    reasonToCustomer: 'هۆکار (لەگەڵ ئاگادارکردنەوەکە بۆ کڕیار دەنێردرێت و تۆمار دەکرێت، لانیکەم ٥ پیت)',
    noteToCustomer: 'تێبینی بۆ کڕیار (ئارەزوومەندانە، لەگەڵ ئاگادارکردنەوەکە دەنێردرێت)',
    financialOnly: 'پەسەندکردن، ڕەتکردنەوە یان تۆمارکردنی گۆڕین پێویستی بە دەسەڵاتی دارایی هەیە. دەتوانیت پشکنین بکەیت، وەڵام بدەیتەوە، داواکارییە پەسەندکراوەکە بگوازیتەوە بۆ چاککردنەوە و دایبخەیت.',
    replacedFirst: 'سەرەتا ئامێرە جێگرەوەکە بە دوگمەی «گۆڕینەوە» لە تابی یەکەکان تۆمار بکە، پاشان ئەم قۆناغە هەڵبژێرە.',
    confirmMove: 'گواستنەوەی داواکارییەکە',
    threadClosed: 'داواکارییەکە داخراوە: نە کڕیار و نە تیم ناتوانن تێیدا بنووسن. دوایین قسەی تیم ئەو هۆکارەیە کە لە کاتی داخستندا نووسراوە.',
    threadReopen: 'داواکارییەکە ڕەتکراوەتەوە و داخراوە. بیگەڕێنەوە بۆ «لە پشکنیندایە» بۆ ئەوەی دووبارە نامە بۆ کڕیار بنێریت.',
    attachFile: 'هاوپێچکردنی وێنە یان ڤیدیۆ',
    uploading: 'بارکردن…',
    video: 'ڤیدیۆ',
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
    /** `closed` (migration 0178): the warranty ended by a return or a cancelled sale — its dates are kept. */
    state: 'active' | 'expired' | 'needs_config' | 'not_delivered' | 'closed';
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
  | { kind: 'warranty'; device: AdminDevice }
  | { kind: 'delivery'; device: AdminDevice };

/**
 * An ISO instant as the value a `datetime-local` field takes, in the browser's
 * own time zone (the admin's — Baghdad for the shop), and back. The field
 * replaces a hand-typed ISO timestamp in a browser prompt, which an admin on a
 * phone had to type to the second.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
  /** The server's one answer to «still open» (W-5); a closed claim's thread takes no messages (W-4). */
  open?: boolean;
  created_at: string;
  serial: string | null;
  email: string | null;
  evidence: Array<{ key: string; url: string }>;
  /** PRO membership's priority service, snapshotted when the claim was filed; the queue is sorted by it. */
  priority: boolean;
  message_count?: number;
  /** The customer wrote last — the thread is waiting on the warranty team. */
  awaiting_staff?: boolean;
  /** 0148 — the spare parts that fit the claimed printer's model, and where they are listed. */
  maintenance?: { printer_slug: string; count: number; path: string | null } | null;
  /** 0191 (W-1) — the cover the claim was filed under; null for a claim filed before it. */
  coverage_at_filing?: { state: string; via: 'original' | 'used_sale' | null; end_at: string | null; policy_version: string | null } | null;
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
/** Closed at these stages (worker/lib/deviceOps.ts CLOSED_CLAIM_STAGES) — read only when the server sends no `open`. */
const CLOSED_STAGES: ReadonlySet<string> = new Set(['rejected', 'replaced', 'resolved']);
const claimIsOpen = (cl: Pick<AdminClaim, 'open' | 'stage'>) => (typeof cl.open === 'boolean' ? cl.open : !CLOSED_STAGES.has(cl.stage));
/**
 * THE DECISION EACH MOVE RECORDS (G-3, worker/routes/devices.ts DECISIONS_AT):
 * an accepted claim is repaired or replaced, a rejected one is rejected or
 * misuse. The desk now SENDS it — it never did, so every desk decision was
 * stored empty.
 */
const DECISION_OPTIONS: Record<string, readonly string[]> = {
  approved: ['repair', 'replace'],
  rejected: ['reject', 'misuse'],
};
/** A recorded reason, told to the customer, is required on these moves. */
const REASON_STAGES: ReadonlySet<string> = new Set(['approved', 'rejected', 'replaced', 'resolved']);
/** The moves that DECIDE a claim — the financial scope's (owner decision 3). */
const MONEY_STAGES: ReadonlySet<string> = new Set(['approved', 'rejected', 'replaced']);
const CLAIM_NEXT: Record<string, string[]> = {
  received: ['diagnosing', 'approved', 'rejected'],
  diagnosing: ['approved', 'rejected'],
  approved: ['repairing', 'replaced', 'resolved', 'rejected'],
  repairing: ['resolved', 'replaced'],
  replaced: ['resolved'],
  rejected: ['diagnosing'],
  resolved: [],
};

/** A stage is information: a flat chip in its semantic tone (build plan §5). */
const STAGE_CLS: Record<string, string> = {
  received: 'bg-white/[0.06] text-text-secondary',
  diagnosing: 'lv-chip [--chip:var(--color-warning)]',
  approved: 'lv-chip [--chip:var(--color-success)]',
  rejected: 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]',
  repairing: 'lv-chip [--chip:var(--color-info)]',
  replaced: 'lv-chip [--chip:var(--color-info)]',
  resolved: 'lv-chip [--chip:var(--color-success)]',
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
      ? 'lv-chip [--chip:var(--color-success)]'
      : st === 'expired'
        ? 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]'
        : st === 'needs_config' || st === 'closed'
          ? 'lv-chip [--chip:var(--color-warning)]'
          : 'bg-white/[0.06] text-text-secondary';
  const label =
    st === 'active'
      ? `${s.stActive}${device.warranty.remaining_days !== null ? ` · ${s.daysLeft(device.warranty.remaining_days)}` : ''}`
      : st === 'expired'
        ? s.stExpired
        : st === 'needs_config'
          ? s.stNeedsConfig
          : st === 'closed'
            ? s.stClosed
            : s.stNotDelivered;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${cls}`}>{label}</span>;
}

/**
 * Also mounted as two views of the merged «الضمانات والأجهزة» tab
 * (AdminWarranties): given `view`, that view is shown alone, without this
 * page's own title and switcher.
 */
export default function AdminSerials({ view }: { view?: 'units' | 'claims' } = {}) {
  const { lang } = useLanguage();
  const s = STRINGS[lang];
  // SERVER HINTS, NEVER THE GATE (src/lib/api.ts): the routes refuse
  // regardless. They only decide what this screen offers and explains.
  const auth = useOptionalAuth();
  const canDecide = auth?.user?.can_move_money === true;
  const isOwner = auth?.user?.is_owner === true;

  const [tabState, setTab] = useState<'units' | 'claims'>(view ?? 'units');
  const tab = view ?? tabState;

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
  const [serialPage, setSerialPage] = useState<string | null>(null);
  // Mounted from the first open on, so the sheet can play its exit.
  const [serialPageMounted, setSerialPageMounted] = useState(false);
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
  // The corrected delivery instant, as the `datetime-local` field holds it.
  const [pendingDelivery, setPendingDelivery] = useState('');

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
        // By code where the shared table has one (SERIAL_WRITE_NOT_ALLOWED
        // when the owner turned «الاستلام» off): the server's sentence is Arabic only.
        setUnitsError(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error);
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
    setPendingDelivery(toLocalInput(action.device.delivered_at));
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
      } else if (pending.kind === 'delivery') {
        const deliveredAt = fromLocalInput(pendingDelivery);
        if (!deliveredAt) {
          setPendingError(s.deliveryInvalid);
          return;
        }
        // A later date is the owner's (G-2, OWNER_REQUIRED): the refusal reads
        // in the admin's language below.
        await api.patch(`/api/devices/admin/units/${pending.device.unit_id}/delivery`, { delivered_at: deliveredAt, reason });
        setUnitsNotice(s.deliverySaved);
      } else {
        await api.post(`/api/devices/admin/units/${pending.device.unit_id}/replace`, {
          new_serial: pendingSerial.trim() || undefined,
          reason,
        });
        // The screen's own sentence, in the admin's language (the route's
        // `note` is one English line).
        setUnitsNotice(s.replacedOk);
      }
      setPending(null);
      refreshCurrent();
    } catch (e) {
      // The server refuses a shortening it was not told about. That refusal
      // is the prompt, not an error to swallow: arm the confirmation and let
      // the admin say it again on purpose.
      if (e instanceof ApiError && e.code === 'CONFIRM_SHORTER_REQUIRED') setPendingShorter(true);
      setPendingError(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error);
    } finally {
      setPendingBusy(false);
      setBusyUnit(null);
    }
  };

  // The delivery correction is a sheet with a date-and-time field and the
  // reason, like every other audited unit action here — never two browser
  // prompts asking for an ISO timestamp typed by hand.
  const correctDelivery = (device: AdminDevice) => openPending({ kind: 'delivery', device });
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
  // The stage move, in a sheet: the decision the move records (G-3), and the
  // reason the customer is told — never a browser prompt.
  const [claimMove, setClaimMove] = useState<{ claim: AdminClaim; to: string } | null>(null);
  const [moveDecision, setMoveDecision] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState('');

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

  const openMove = (claim: AdminClaim, to: string) => {
    const options = DECISION_OPTIONS[to] ?? [];
    setClaimMove({ claim, to });
    // The decision already on the claim, when it still fits the move; else
    // none, so a decision is always a deliberate choice.
    setMoveDecision(claim.decision && options.includes(claim.decision) ? claim.decision : '');
    setMoveReason('');
    setMoveError('');
  };

  const confirmMove = async () => {
    if (!claimMove || moveBusy) return;
    const { claim, to } = claimMove;
    const reason = moveReason.trim();
    const options = DECISION_OPTIONS[to] ?? [];
    if (options.length > 0 && !options.includes(moveDecision)) {
      setMoveError(s.decisionRequired);
      return;
    }
    if (REASON_STAGES.has(to) && reason.length < 5) {
      setMoveError(s.reasonRequired);
      return;
    }
    setMoveBusy(true);
    setMoveError('');
    try {
      await api.patch(`/api/devices/admin/claims/${encodeURIComponent(claim.id)}`, {
        stage: to,
        reason: reason || undefined,
        // G-3: what the decision is, sent with the move that makes it.
        decision: options.length > 0 ? moveDecision : undefined,
      });
      setClaimMove(null);
      await loadClaims(null);
    } catch (e) {
      // A decision needs the financial scope; «replaced» needs the replacement
      // first; a decision must fit its stage — said in the admin's language.
      setMoveError(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error);
    } finally {
      setMoveBusy(false);
    }
  };

  /**
   * A STAFF REPLY MAY CARRY A PHOTO OR A VIDEO. The route always took a
   * `file_key` from staff (their own `claims/<staffId>/…` upload, which the
   * claimant may open through their claim); the desk only ever sent text.
   */
  const postReply = async (claimId: string, file?: File) => {
    const text = replyText.trim();
    if (!text && !file) return;
    setClaimBusy(true);
    setClaimsError('');
    try {
      let fileKey: string | undefined;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        const up = await api.post<{ key: string }>('/api/devices/claims/upload', form, { timeoutMs: uploadTimeoutMs(file.size) });
        fileKey = up.key;
      }
      await api.post(`/api/devices/claims/${encodeURIComponent(claimId)}/messages`, { body: text, file_key: fileKey });
      setReplyText('');
      const data = await api.get<{ messages: ClaimMessage[] }>(`/api/devices/claims/${encodeURIComponent(claimId)}`);
      setThread(data.messages);
    } catch (e) {
      // CLAIM_CLOSED (W-4): the claim was closed meanwhile — the queue is
      // reloaded, so its thread shows as closed.
      setClaimsError(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error);
      if (e instanceof ApiError && e.code === 'CLAIM_CLOSED') await loadClaims(null);
    } finally {
      setClaimBusy(false);
    }
  };
  const sendReply = (claimId: string) => postReply(claimId);

  const renderUnitsTable = (units: AdminDevice[]) => (
    <div className="lv-surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-start border-collapse min-w-[980px]">
          <thead>
            <tr className="bg-surface-raised border-b border-border-subtle">
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.unit}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.serial}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.delivered}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.warrantyEnd}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.stage}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase">{s.account}</th>
              <th className="py-3 px-4 text-xs font-bold text-text-secondary uppercase" />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <React.Fragment key={u.unit_id}>
              <tr className="border-b border-border-subtle hover:bg-surface-raised transition-colors align-top">
                <td className="py-3 px-4">
                  <div className="text-sm text-text-primary font-bold">{u.product.name_ar || u.product.name || '—'}</div>
                  <div className="text-[11px] text-text-muted font-mono">#{u.unit_index} · {u.unit_id}</div>
                  <div className="text-[11px] text-text-muted font-mono">{u.order_id}</div>
                  {u.replaced_by_unit_id && (
                    <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-info"><Repeat className="w-3 h-3" />{s.replaced}</span>
                  )}
                  <div className="text-[11px] mt-1">
                    {u.registration && !u.registration.revoked_at ? (
                      <span className="text-success inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{s.registered}</span>
                    ) : (
                      <span className="text-text-muted">{s.notRegistered}</span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-4">
                  {u.serial ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSerialPageMounted(true);
                        setSerialPage(u.serial);
                      }}
                      aria-haspopup="dialog"
                      className="font-mono text-sm text-text-primary break-all text-start underline decoration-zinc-700 underline-offset-4 hover:decoration-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold rounded"
                      data-unit-serial-page={u.unit_id}
                    >
                      {u.serial}
                    </button>
                  ) : null}
                  {!u.replaced_by_unit_id && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <input
                        className="lv-input w-44 min-h-9 px-2 py-1.5 text-xs font-mono"
                        value={serialDrafts[u.unit_id] ?? ''}
                        onChange={(e) => setSerialDrafts((d) => ({ ...d, [u.unit_id]: e.target.value }))}
                        placeholder={u.serial ? '' : s.serialPlaceholder}
                      />
                      <button
                        type="button"
                        onClick={() => assignSerial(u)}
                        disabled={busyUnit === u.unit_id || !(serialDrafts[u.unit_id] ?? '').trim()}
                        className="lv-button lv-button-secondary lv-button-sm"
                      >
                        {s.assign}
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-text-secondary whitespace-nowrap">{fmtDate(u.delivered_at, lang)}</div>
                  {!u.replaced_by_unit_id && (
                    <button
                      onClick={() => correctDelivery(u)}
                      disabled={busyUnit === u.unit_id}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                    >
                      <CalendarClock className="w-3 h-3" />{s.correctDelivery}
                    </button>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-text-secondary whitespace-nowrap">{fmtDate(u.warranty.end_at, lang)}</div>
                  <div className="text-[11px] text-text-muted whitespace-nowrap" data-unit-start={u.unit_id}>
                    {s.warrantyStart}: {fmtDate(u.warranty.start_at, lang)}
                  </div>
                  <div className="text-[11px] text-text-muted">
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
                      className="inline-flex items-center gap-1 mt-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded"
                    >
                      <ShieldCheck className="w-3 h-3" aria-hidden="true" />{s.editWarranty}
                    </button>
                  )}
                </td>
                <td className="py-3 px-4"><CoverageBadge device={u} s={s} /></td>
                <td className="py-3 px-4 text-[11px] leading-relaxed">
                  {u.buyer !== undefined || u.holder !== undefined ? (
                    <>
                      <div className="text-text-muted whitespace-nowrap">
                        {s.buyer}: <span className="text-text-secondary break-all whitespace-normal">{accountLabel(u.buyer)}</span>
                      </div>
                      <div className="text-text-muted whitespace-nowrap">
                        {s.holder}:{' '}
                        {u.holder ? (
                          <span className="text-success break-all whitespace-normal">{accountLabel(u.holder)}</span>
                        ) : (
                          <span className="text-text-secondary">{s.noHolder}</span>
                        )}
                      </div>
                      {u.holder && u.registration && !u.registration.revoked_at && (
                        <div className="text-text-muted whitespace-nowrap">
                          {s.registeredAt}: <span className="text-text-secondary">{fmtDate(u.registration.registered_at, lang)}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="flex flex-col items-start gap-1.5">
                    {!u.replaced_by_unit_id && (
                      <button
                        type="button"
                        onClick={() => replaceUnit(u)}
                        disabled={busyUnit === u.unit_id}
                        className="lv-button lv-button-secondary lv-button-sm"
                      >
                        <Repeat className="w-3 h-3" />{s.replace}
                      </button>
                    )}
                    {u.holder && (
                      <button
                        type="button"
                        onClick={() => openUnlink(u)}
                        disabled={busyUnit === u.unit_id}
                        className="lv-button lv-button-danger lv-button-sm whitespace-nowrap"
                      >
                        <Unlink className="w-3 h-3" aria-hidden="true" />{s.unlink}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((h) => ({ ...h, [u.unit_id]: !h[u.unit_id] }))}
                      aria-expanded={!!historyOpen[u.unit_id]}
                      data-unit-history-toggle={u.unit_id}
                      className="inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded"
                    >
                      <History className="w-3 h-3" aria-hidden="true" />
                      {historyOpen[u.unit_id] ? s.hideHistory : s.history}
                    </button>
                  </div>
                </td>
              </tr>
              {historyOpen[u.unit_id] && (
                <tr className="border-b border-border-subtle bg-[var(--clay-well-bg)]">
                  <td colSpan={7} className="px-4 py-3">
                    <UnitHistory unitId={u.unit_id} lang={lang} refreshKey={historyTick} />
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
            {units.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-text-muted font-medium">{s.noUnits}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {!view && <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-2xl font-black text-text-primary flex items-center gap-2"><Barcode className="w-6 h-6 text-olive" />{s.title}</h2>
        <div className="flex lv-well border border-border-subtle p-1 rounded-xl">
          {(['units', 'claims'] as const).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tab === tb ? 'bg-surface-raised text-text-primary shadow-1' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {tb === 'units' ? s.tabUnits : s.tabClaims}
            </button>
          ))}
        </div>
      </div>}

      {tab === 'units' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadOrder(orderQuery); }}>
              <input
                className="lv-input flex-1 text-sm font-mono"
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
                placeholder={s.orderPlaceholder}
              />
              <button type="submit" className="lv-button lv-button-secondary shrink-0">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadCustomer(emailQuery); }}>
              <input
                className="lv-input flex-1 text-sm"
                value={emailQuery}
                onChange={(e) => setEmailQuery(e.target.value)}
                placeholder={s.emailPlaceholder}
                type="email"
              />
              <button type="submit" className="lv-button lv-button-secondary shrink-0">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadBySerial(serialQuery); }}>
              <input
                className="lv-input flex-1 min-w-0 text-sm font-mono"
                value={serialQuery}
                onChange={(e) => setSerialQuery(e.target.value)}
                placeholder={s.serialSearchPlaceholder}
                aria-label={s.serialSearchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
              />
              <button type="submit" className="lv-button lv-button-secondary shrink-0">
                <Barcode className="w-4 h-4" aria-hidden="true" />{s.load}
              </button>
            </form>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <button
              type="button"
              onClick={() => void backfillAll()}
              disabled={backfillAllBusy}
              className="lv-button lv-button-secondary lv-button-sm"
            >
              <PackageCheck className="w-4 h-4" aria-hidden="true" />{backfillAllBusy ? s.loading : s.backfillAll}
            </button>
            <span>{s.backfillAllHint}</span>
          </div>

          {unitsError && <div className="lv-alert lv-alert-danger text-sm font-medium text-text-primary">{unitsError}</div>}
          {unitsNotice && <div className="lv-alert lv-alert-success text-sm font-medium text-text-primary">{unitsNotice}</div>}
          {unitsLoading && <div className="text-text-muted text-sm font-medium py-6 text-center">{s.loading}</div>}

          {orderData && !unitsLoading && (
            <div className="space-y-3">
              <div className="lv-surface p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="font-mono text-text-primary font-bold">{orderData.order.id}</span>
                <span className="text-text-secondary">{s.customer}: <span className="text-text-primary">{orderData.order.email || orderData.order.user_id}</span></span>
                <span className="text-text-secondary capitalize">{orderData.order.status}</span>
                <span className="text-text-secondary">{s.delivered}: {fmtDate(orderData.order.delivered_at, lang)}</span>
              </div>
              {orderData.items.some((it) => it.serialized) ? (
                <>
                  {orderData.order.delivered_at ? (
                    orderData.units.length <
                      orderData.items.filter((it) => it.serialized).reduce((n, it) => n + Number(it.qty), 0) && (
                      <button
                        onClick={backfill}
                        className="lv-button lv-button-secondary"
                      >
                        <PackageCheck className="w-4 h-4" />{s.backfill}
                      </button>
                    )
                  ) : (
                    <div className="flex items-center gap-2 text-warning text-sm font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0" />{s.orderNotDelivered}
                    </div>
                  )}
                  {renderUnitsTable(orderData.units)}
                </>
              ) : (
                <div className="text-text-muted text-sm font-medium py-4">{s.notSerialized}</div>
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
            className="absolute top-4 end-4 p-2 text-text-muted hover:text-text-primary hover:bg-white/[0.06] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="pe-10">
            <h3 id="admin-unlink-title" className="text-text-primary text-base font-bold">{s.unlinkTitle}</h3>
            {unlinkTarget && (
              <p className="text-text-secondary text-[12px] mt-1">
                {unlinkTarget.product.name_ar || unlinkTarget.product.name}
                {unlinkTarget.serial ? <> · <span className="font-mono" dir="ltr">{unlinkTarget.serial}</span></> : null}
                {' · '}{s.holder}: <span className="text-text-primary">{accountLabel(unlinkTarget.holder)}</span>
              </p>
            )}
          </div>
          <p className="text-text-secondary text-sm leading-relaxed">{s.unlinkBody}</p>
          <div>
            <label htmlFor="admin-unlink-reason" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.reasonLabel}</label>
            <textarea
              className="lv-input py-2.5 text-sm resize-none"
              id="admin-unlink-reason"
              value={unlinkReason}
              onChange={(e) => setUnlinkReason(e.target.value)}
              minLength={5}
              maxLength={500}
              rows={3}
              required
              disabled={unlinkBusy}
            />
          </div>
          {unlinkError && (
            <div role="alert" className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary">{unlinkError}</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setUnlinkTarget(null)}
              disabled={unlinkBusy}
              className="lv-button lv-button-secondary"
            >
              {s.cancel}
            </button>
            <button
              type="button"
              onClick={confirmUnlink}
              disabled={unlinkBusy || unlinkReason.trim().length < 5}
              className="lv-button lv-button-danger"
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
            className="absolute top-4 end-4 p-2 text-text-muted hover:text-text-primary hover:bg-white/[0.06] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
          <div className="pe-10">
            <h3 id="admin-unit-action-title" className="text-text-primary text-base font-bold">
              {pending?.kind === 'replace'
                ? s.replaceTitle
                : pending?.kind === 'warranty'
                  ? s.warrantyTitle
                  : pending?.kind === 'delivery'
                    ? s.deliveryTitle
                    : s.reassignTitle}
            </h3>
            {pending && (
              <p className="text-text-secondary text-[12px] mt-1">
                {pending.device.product.name_ar || pending.device.product.name}
                {' · '}
                <span className="font-mono" dir="ltr">#{pending.device.unit_index} · {pending.device.unit_id}</span>
                {pending.kind === 'reassign' && (
                  <>
                    {' · '}{s.serial}: <span className="font-mono text-text-primary" dir="ltr">{pending.serial}</span>
                  </>
                )}
              </p>
            )}
          </div>
          <p className="text-text-secondary text-sm leading-relaxed">
            {pending?.kind === 'replace'
              ? `${s.replaceBody} ${s.replaceNote}`
              : pending?.kind === 'warranty'
                ? s.warrantyBody
                : pending?.kind === 'delivery'
                  ? s.deliveryBody
                  : s.reassignConfirm}
          </p>
          {/* The paper is a snapshot by design; moving the clock never
              rewrites a receipt already handed over. Saying so here is the
              difference between a snapshot and a document that went stale
              without anyone being told. */}
          {pending?.kind === 'warranty' && (
            <p className="text-text-muted text-[12px] leading-relaxed">{s.warrantyNote}</p>
          )}
          {/* The server's own account of the clash — which unit holds the serial today. */}
          {pending?.kind === 'reassign' && pending.detail && (
            <p className="text-text-muted text-[12px] leading-relaxed" dir="auto">{pending.detail}</p>
          )}
          {pending?.kind === 'replace' && (
            <div>
              <label htmlFor="admin-unit-action-serial" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.replaceSerialLabel}</label>
              <input
                className="lv-input text-sm font-mono"
                id="admin-unit-action-serial"
                value={pendingSerial}
                onChange={(e) => setPendingSerial(e.target.value)}
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                disabled={pendingBusy}
              />
            </div>
          )}
          {/* THE DELIVERY CORRECTION: a date-and-time field in the admin's own
              time zone, sent as an ISO instant. Later than today's date
              lengthens the warranty — said before saving, refused by the
              server for anyone but the owner (G-2). */}
          {pending?.kind === 'delivery' && (
            <div className="space-y-2">
              <label htmlFor="admin-unit-delivery-at" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.deliveryLabel}</label>
              <input
                className="lv-input text-sm"
                id="admin-unit-delivery-at"
                type="datetime-local"
                dir="ltr"
                min="2015-01-01T00:00"
                max={toLocalInput(new Date(Date.now() + 48 * 3600_000).toISOString())}
                value={pendingDelivery}
                onChange={(e) => setPendingDelivery(e.target.value)}
                required
                disabled={pendingBusy}
                data-unit-delivery-input
              />
              <p className="text-[12px] text-text-muted">
                {s.deliveryCurrent}: <span className="text-text-secondary">{fmtDate(pending.device.delivered_at, lang)}</span>
              </p>
              {!isOwner &&
                !!pending.device.delivered_at &&
                (fromLocalInput(pendingDelivery) ?? '') > new Date(pending.device.delivered_at).toISOString() && (
                  <div className="lv-alert lv-alert-warning text-[12px] text-text-primary" data-unit-delivery-later>
                    {s.deliveryLaterOwner}
                  </div>
                )}
            </div>
          )}
          {pending?.kind === 'warranty' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="admin-unit-warranty-base" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.baseMonths}</label>
                  <input
                    className="lv-input text-sm"
                    id="admin-unit-warranty-base"
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    dir="ltr"
                    value={pendingBase}
                    onChange={(e) => setPendingBase(e.target.value)}
                    disabled={pendingBusy}
                  />
                </div>
                <div>
                  <label htmlFor="admin-unit-warranty-ext" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.extMonths}</label>
                  <input
                    className="lv-input text-sm"
                    id="admin-unit-warranty-ext"
                    type="number"
                    min={0}
                    max={240}
                    step={1}
                    dir="ltr"
                    value={pendingExt}
                    onChange={(e) => setPendingExt(e.target.value)}
                    disabled={pendingBusy}
                  />
                </div>
              </div>
              <p className="text-[12px] text-text-muted">
                {s.currentEnd}: <span className="text-text-secondary">{fmtDate(pending.device.warranty.end_at, lang)}</span>
              </p>
              {pendingShorter && (
                <div className="lv-alert lv-alert-warning space-y-2">
                  <p className="text-text-primary text-[13px] font-bold">{s.shorterTitle}</p>
                  <p className="text-text-secondary text-[12px] leading-relaxed">{s.shorterBody}</p>
                  <p className="text-text-primary text-[12px] font-bold">{s.shorterConfirm}</p>
                </div>
              )}
            </div>
          )}
          <div>
            <label htmlFor="admin-unit-action-reason" className="text-[12px] text-text-secondary mb-1.5 block font-medium">{s.reasonLabel}</label>
            <textarea
              className="lv-input py-2.5 text-sm resize-none"
              id="admin-unit-action-reason"
              value={pendingReason}
              onChange={(e) => setPendingReason(e.target.value)}
              minLength={5}
              maxLength={500}
              rows={3}
              required
              disabled={pendingBusy}
            />
          </div>
          {pendingError && (
            <div role="alert" className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary">{pendingError}</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={pendingBusy}
              className="lv-button lv-button-secondary"
            >
              {s.cancel}
            </button>
            <button
              type="button"
              onClick={confirmPending}
              disabled={pendingBusy || pendingReason.trim().length < 5}
              className="lv-button lv-button-danger"
            >
              {pendingBusy
                ? s.working
                : pending?.kind === 'replace'
                  ? s.replace
                  : pending?.kind === 'warranty'
                    ? pendingShorter
                      ? s.shorterConfirm
                      : s.saveWarranty
                    : pending?.kind === 'delivery'
                      ? s.saveDelivery
                      : s.confirmReassign}
            </button>
          </div>
        </div>
      </Overlay>

      {/* THE CLAIM MOVE — the next stage, the decision it records (G-3: the
          desk never sent one, so every desk decision was stored empty) and the
          reason the customer is told, in one in-app sheet instead of a
          browser prompt. Deciding is the financial scope's (owner decision
          3); the server refuses regardless of what this sheet offers. */}
      <Overlay
        open={!!claimMove}
        onClose={() => { if (!moveBusy) setClaimMove(null); }}
        labelledBy="admin-claim-move-title"
        dismissOnScrim={!moveBusy}
        dismissOnEscape={!moveBusy}
        z={60}
        testId="admin-claim-move"
        panelClassName="w-full max-w-md"
      >
        <div className="p-6 space-y-4">
          <button
            type="button"
            onClick={() => setClaimMove(null)}
            disabled={moveBusy}
            aria-label={s.close}
            className="absolute top-4 end-4 p-2 text-text-muted hover:text-text-primary hover:bg-white/[0.06] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
          {claimMove && (
            <>
              <div className="pe-10">
                <h3 id="admin-claim-move-title" className="text-text-primary text-base font-bold">
                  {s.moveTitle(s.stageLabels[claimMove.to] ?? claimMove.to)}
                </h3>
                <p className="text-text-secondary text-[12px] mt-1" dir="auto">
                  {claimMove.claim.subject} · {claimMove.claim.product_name}
                  {claimMove.claim.serial ? <> · <span className="font-mono" dir="ltr">{claimMove.claim.serial}</span></> : null}
                </p>
              </div>
              {MONEY_STAGES.has(claimMove.to) && !canDecide && (
                <div className="lv-alert lv-alert-warning text-[12px] text-text-primary leading-relaxed" data-claim-move-financial>
                  {s.financialOnly}
                </div>
              )}
              {claimMove.to === 'replaced' && (
                <p className="text-text-muted text-[12px] leading-relaxed">{s.replacedFirst}</p>
              )}
              {(DECISION_OPTIONS[claimMove.to] ?? []).length > 0 && (
                <fieldset disabled={moveBusy} data-claim-move-decision>
                  <legend className="text-[12px] text-text-secondary mb-1.5 font-medium">{s.decisionPick}</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {(DECISION_OPTIONS[claimMove.to] ?? []).map((d) => (
                      <label
                        key={d}
                        className={`lv-button ${moveDecision === d ? 'lv-button-primary' : 'lv-button-secondary'} cursor-pointer focus-within:ring-2 focus-within:ring-focus`}
                      >
                        <input
                          type="radio"
                          name="admin-claim-decision"
                          value={d}
                          checked={moveDecision === d}
                          onChange={() => setMoveDecision(d)}
                          className="sr-only"
                        />
                        {s.decisionLabels[d] ?? d}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div>
                <label htmlFor="admin-claim-move-reason" className="text-[12px] text-text-secondary mb-1.5 block font-medium">
                  {REASON_STAGES.has(claimMove.to) ? s.reasonToCustomer : s.noteToCustomer}
                </label>
                <textarea
                  className="lv-input py-2.5 text-sm resize-none"
                  id="admin-claim-move-reason"
                  value={moveReason}
                  onChange={(e) => setMoveReason(e.target.value)}
                  minLength={REASON_STAGES.has(claimMove.to) ? 5 : undefined}
                  maxLength={1000}
                  rows={3}
                  required={REASON_STAGES.has(claimMove.to)}
                  disabled={moveBusy}
                />
              </div>
              {moveError && (
                <div role="alert" className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary">{moveError}</div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setClaimMove(null)}
                  disabled={moveBusy}
                  className="lv-button lv-button-secondary"
                >
                  {s.cancel}
                </button>
                <button
                  type="button"
                  onClick={() => void confirmMove()}
                  disabled={
                    moveBusy ||
                    (MONEY_STAGES.has(claimMove.to) && !canDecide) ||
                    (REASON_STAGES.has(claimMove.to) && moveReason.trim().length < 5) ||
                    ((DECISION_OPTIONS[claimMove.to] ?? []).length > 0 && !moveDecision)
                  }
                  className="lv-button lv-button-primary"
                  data-claim-move-confirm
                >
                  {moveBusy ? s.working : s.confirmMove}
                </button>
              </div>
            </>
          )}
        </div>
      </Overlay>

      {tab === 'claims' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex lv-well border border-border-subtle p-1 rounded-xl overflow-x-auto">
              {(['all', ...CLAIM_STAGES] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setStageFilter(st)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${stageFilter === st ? 'bg-surface-raised text-text-primary shadow-1' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {st === 'all' ? s.all : s.stageLabels[st] ?? st}
                  {claimCounts && claimCounts[st] !== undefined && (
                    <span className="ms-1.5 tabular-nums text-text-muted" data-claims-count={st}>
                      {claimCounts[st]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={() => loadClaims(null)}
              className="lv-button lv-button-secondary w-11 px-0"
              title={s.refreshed}
            >
              <RefreshCw className={`w-4 h-4 ${claimsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {claimsError && <div className="lv-alert lv-alert-danger text-sm font-medium text-text-primary">{claimsError}</div>}
          {claimsLoading && claims.length === 0 && <div className="text-text-muted text-sm font-medium py-6 text-center">{s.loading}</div>}
          {!claimsLoading && claims.length === 0 && !claimsError && (
            <div className="text-text-muted text-sm font-medium py-6 text-center">{s.claimsEmpty}</div>
          )}

          <div className="space-y-3">
            {claims.map((cl) => (
              <div key={cl.id} className="lv-surface p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-text-primary font-bold text-sm">{cl.subject}</div>
                    <div className="text-[11px] text-text-muted mt-0.5">
                      {cl.product_name} · {cl.email || '—'} · {cl.serial ? <span className="font-mono">{cl.serial}</span> : '—'} · {fmtDate(cl.created_at, lang)}
                      {cl.message_count !== undefined && <> · {s.messagesN(cl.message_count)}</>}
                    </div>
                    {cl.awaiting_staff && (
                      <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-warning" data-claim-awaiting={cl.id}>
                        <MessageSquare className="w-3 h-3" aria-hidden="true" />
                        {s.awaitingStaff}
                      </div>
                    )}
                    {/* W-1 (policy 5.16): the cover the claim was FILED under — never today's. Nothing for an older claim. */}
                    {(cl.coverage_at_filing?.state === 'active' || cl.coverage_at_filing?.state === 'expired') && (
                      <div
                        className={`mt-1 ms-2 inline-flex items-center gap-1 text-[11px] font-bold ${cl.coverage_at_filing.state === 'active' ? 'text-success' : 'text-text-muted'}`}
                        data-claim-filed-cover={cl.id}
                        title={cl.coverage_at_filing.end_at ? fmtDate(cl.coverage_at_filing.end_at, lang) : undefined}
                      >
                        {cl.coverage_at_filing.state === 'expired'
                          ? s.filedOutOfCover
                          : cl.coverage_at_filing.via === 'used_sale'
                            ? s.filedInUsedSale
                            : s.filedInCover}
                      </div>
                    )}
                    {/* «تفيد في صيانة الطابعة» (0148): what the shop stocks
                        for the printer being repaired, one tap away. */}
                    {cl.maintenance?.path && (
                      <a
                        href={`${cl.maintenance.path}?fits=${encodeURIComponent(cl.maintenance.printer_slug)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-claim-parts={cl.id}
                        className="mt-1 ms-2 inline-flex items-center gap-1 text-[11px] font-bold text-text-secondary hover:text-text-primary transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        {s.compatibleParts(cl.maintenance.count)}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cl.priority && (
                      <span
                        title={s.priorityHint}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full lv-chip [--chip:var(--color-gold)] text-[11px] font-bold whitespace-nowrap"
                      >
                        <Crown aria-hidden="true" className="w-3 h-3" />
                        {s.priorityBadge}
                      </span>
                    )}
                    <span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-bold ${STAGE_CLS[cl.stage] ?? STAGE_CLS.received}`}>{s.stageLabels[cl.stage] ?? cl.stage}</span>
                    {/* Choosing the next stage opens the move sheet — the
                        decision and the reason are asked there, never in a
                        browser prompt. */}
                    {(CLAIM_NEXT[cl.stage] ?? []).length > 0 && (
                      <select
                        className="lv-input w-auto min-h-9 px-2 py-1.5 text-xs disabled:opacity-50"
                        value=""
                        disabled={claimBusy || moveBusy}
                        aria-label={s.moveTo}
                        data-claim-move={cl.id}
                        onChange={(e) => { if (e.target.value) openMove(cl, e.target.value); }}
                      >
                        <option value="" disabled>{s.moveTo}</option>
                        {(CLAIM_NEXT[cl.stage] ?? []).map((st) => (
                          <option key={st} value={st}>{s.stageLabels[st] ?? st}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <p className="text-text-secondary text-sm mt-2 whitespace-pre-wrap">{cl.description}</p>
                {cl.decision && (
                  <p className="text-[12px] text-text-secondary mt-1" data-claim-decision={cl.id}>
                    {s.decision}: <span className="font-bold text-text-primary">{s.decisionLabels[cl.decision] ?? cl.decision}</span>
                  </p>
                )}
                {cl.decision_reason && (
                  <p className="text-[12px] text-text-muted mt-1">{s.decisionReason} {cl.decision_reason}</p>
                )}
                {cl.evidence.length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {cl.evidence.map((ev) => (
                      <a key={ev.key} href={ev.url} target="_blank" rel="noreferrer" className="block w-16 h-16 rounded-sm overflow-hidden border border-border-subtle bg-surface-selected">
                        {isVideoUrl(ev.key) || isVideoUrl(ev.url) ? (
                          <span className="w-full h-full flex items-center justify-center text-[10px] font-bold text-text-secondary">{s.video}</span>
                        ) : (
                          <img src={ev.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                      </a>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => openThread(cl.id)}
                  className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-text-secondary hover:text-text-primary transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  {openClaim === cl.id ? s.hideThread : s.viewThread}
                  {openClaim === cl.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {openClaim === cl.id && (
                  <div className="mt-3 border-t border-border-subtle pt-3 space-y-2">
                    {threadLoading && <div className="text-text-muted text-xs">{s.loading}</div>}
                    {thread.map((m) => (
                      <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.is_staff ? 'bg-olive/15 border border-olive/25 text-text-primary ms-auto' : 'bg-surface-raised text-text-primary'}`}>
                        {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                        {m.file_url && (
                          <a href={m.file_url} target="_blank" rel="noreferrer" className="block mt-1">
                            {isVideoUrl(m.file_url) ? (
                              <video src={m.file_url} controls preload="none" className="max-h-40 rounded-lg" />
                            ) : (
                              <img src={m.file_url} alt="" className="max-h-40 rounded-lg" loading="lazy" />
                            )}
                          </a>
                        )}
                        <div className="text-[10px] text-text-muted mt-1">{new Date(m.created_at).toLocaleString(dateLocale(lang))}</div>
                      </div>
                    ))}
                    {/* W-4: a closed claim's thread takes no messages from
                        either side. A rejected claim can be reopened for
                        another look, which opens its thread again. */}
                    {!claimIsOpen(cl) ? (
                      <p className="text-[12px] text-text-muted leading-relaxed pt-1" data-claim-thread-closed={cl.id}>
                        {cl.stage === 'rejected' ? s.threadReopen : s.threadClosed}
                      </p>
                    ) : (
                      <div className="flex gap-2 pt-1">
                        <label
                          className={`lv-button lv-button-secondary w-11 px-0 shrink-0 cursor-pointer focus-within:ring-2 focus-within:ring-focus ${claimBusy ? 'opacity-50 pointer-events-none' : ''}`}
                          title={s.attachFile}
                        >
                          <Paperclip className="w-4 h-4" aria-hidden="true" />
                          <span className="sr-only">{claimBusy ? s.uploading : s.attachFile}</span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4"
                            className="sr-only"
                            disabled={claimBusy}
                            data-claim-reply-file={cl.id}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) void postReply(cl.id, file);
                            }}
                          />
                        </label>
                        <input
                          className="lv-input flex-1 min-w-0 text-sm"
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder={s.reply}
                          aria-label={s.reply}
                          maxLength={3000}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(cl.id); } }}
                        />
                        <button
                          onClick={() => void sendReply(cl.id)}
                          disabled={claimBusy || !replyText.trim()}
                          className="lv-button lv-button-primary shrink-0 px-3"
                        >
                          <Send className="w-4 h-4" />{s.send}
                        </button>
                      </div>
                    )}
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
              className="lv-button lv-button-secondary w-full"
            >
              {claimsLoading ? s.loading : s.loadMore}
            </button>
          )}
        </div>
      )}
      {serialPageMounted && (
        <React.Suspense fallback={null}>
          <SerialDetail serial={serialPage} onClose={() => setSerialPage(null)} />
        </React.Suspense>
      )}
    </div>
  );
}
