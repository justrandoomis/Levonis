/**
 * Print Cloud's customer notifications, through the EXISTING Levonis inbox
 * (`user_notifications`, worker/lib/notifications.ts — the NotificationAdapter
 * is the platform's own bell, connected). Every message exists in Arabic,
 * English and Sorani; the Sorani travels in `meta.title_ckb` / `meta.body_ckb`.
 *
 * Statements, not sends: a notification lands in the SAME batch as the event
 * it reports (a fulfilled order, a finished print), and its `eventKey` makes a
 * replay a no-op.
 */
import { notifyStatement, type NotificationInput } from '../notifications';
import type { Stmt } from './db';

export type PcNotice =
  | 'order_fulfilled'
  | 'estimate_ready'
  | 'estimate_unavailable'
  | 'job_queued'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'job_cancelled'
  | 'reprint_created'
  | 'shipment_ready'
  | 'shipment_shipped'
  | 'inventory_low'
  | 'buyback_approved'
  | 'buyback_rejected'
  | 'credits_adjusted';

interface Text {
  title_ar: string;
  title_en: string;
  title_ckb: string;
  body_ar: string;
  body_en: string;
  body_ckb: string;
}

const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

const TEXT: Record<PcNotice, Text> = {
  order_fulfilled: {
    title_ar: 'تم تأكيد الدفع',
    title_en: 'Payment confirmed',
    title_ckb: 'پارەدان پشتڕاستکرایەوە',
    body_ar: 'أُضيفت ساعات الطباعة والمواد التي اشتريتها إلى حسابك.',
    body_en: 'The printing hours and materials you bought are now in your account.',
    body_ckb: 'ئەو کاتژمێرە چاپ و کەرەستانەی کڕیوتن ئێستا لە هەژمارەکەتدان.',
  },
  estimate_ready: {
    title_ar: 'تقدير الطباعة جاهز',
    title_en: 'Print estimate ready',
    title_ckb: 'خەمڵاندنی چاپ ئامادەیە',
    body_ar: 'اكتمل تحليل «{title}» ويمكنك مراجعة الوقت والمواد قبل التأكيد.',
    body_en: '«{title}» has been analysed; review the time and materials before you confirm.',
    body_ckb: 'شیکاری «{title}» تەواو بوو؛ پێش پشتڕاستکردنەوە کات و کەرەستەکان ببینە.',
  },
  estimate_unavailable: {
    title_ar: 'تعذّر تحليل الملف',
    title_en: 'The model could not be analysed',
    title_ckb: 'شیکاریی مۆدێلەکە نەکرا',
    body_ar: 'لم يتمكن برنامج التقطيع من تحليل «{title}». راجع الملف أو تواصل مع الورشة.',
    body_en: 'The slicer could not analyse «{title}». Check the file or contact the workshop.',
    body_ckb: 'بەرنامەی بڕین نەیتوانی «{title}» شیکار بکات. فایلەکە بپشکنە یان پەیوەندی بە کارگەوە بکە.',
  },
  job_queued: {
    title_ar: 'دخلت مهمتك قائمة الطباعة',
    title_en: 'Your job is in the print queue',
    title_ckb: 'کارەکەت چووە ڕیزی چاپەوە',
    body_ar: 'حُجزت الساعات والمواد اللازمة لـ«{title}».',
    body_en: 'The hours and materials for «{title}» are reserved.',
    body_ckb: 'کاتژمێر و کەرەستەی پێویست بۆ «{title}» گیرانەوە.',
  },
  job_started: {
    title_ar: 'بدأت الطباعة',
    title_en: 'Printing started',
    title_ckb: 'چاپکردن دەستی پێکرد',
    body_ar: 'بدأت طباعة «{title}» في الورشة.',
    body_en: '«{title}» has started printing in the workshop.',
    body_ckb: 'چاپی «{title}» لە کارگەدا دەستی پێکرد.',
  },
  job_completed: {
    title_ar: 'اكتملت الطباعة',
    title_en: 'Print completed',
    title_ckb: 'چاپکردن تەواو بوو',
    body_ar: 'اكتملت طباعة «{title}» وحُدّثت أرصدتك حسب الاستهلاك الفعلي.',
    body_en: '«{title}» has finished printing; your balances reflect what was actually used.',
    body_ckb: 'چاپی «{title}» تەواو بوو؛ باڵانسەکانت بەپێی بەکارهێنانی ڕاستەقینە نوێکرانەوە.',
  },
  job_failed: {
    title_ar: 'تعذّرت الطباعة',
    title_en: 'Print failed',
    title_ckb: 'چاپکردن سەرکەوتوو نەبوو',
    body_ar: 'توقفت طباعة «{title}». ستراجع الورشة السبب وتطبّق سياسة الحماية.',
    body_en: '«{title}» failed. The workshop will review the cause and apply the protection policy.',
    body_ckb: 'چاپی «{title}» ڕاوەستا. کارگە هۆکارەکە دەپشکنێت و سیاسەتی پاراستن جێبەجێ دەکات.',
  },
  job_cancelled: {
    title_ar: 'أُلغيت المهمة',
    title_en: 'Job cancelled',
    title_ckb: 'کارەکە هەڵوەشێنرایەوە',
    body_ar: 'أُلغيت «{title}» وأُعيدت الساعات والمواد المحجوزة إلى رصيدك.',
    body_en: '«{title}» was cancelled and its reserved hours and materials are back in your balance.',
    body_ckb: '«{title}» هەڵوەشێنرایەوە و کاتژمێر و کەرەستە گیراوەکان گەڕانەوە سەر باڵانسەکەت.',
  },
  reprint_created: {
    title_ar: 'أُعيدت جدولة الطباعة',
    title_en: 'Reprint scheduled',
    title_ckb: 'چاپکردنەوە ڕێکخرا',
    body_ar: 'أُنشئت مهمة إعادة طباعة لـ«{title}».',
    body_en: 'A reprint of «{title}» has been created.',
    body_ckb: 'کاری چاپکردنەوەی «{title}» دروستکرا.',
  },
  shipment_ready: {
    title_ar: 'طلبك جاهز',
    title_en: 'Your order is ready',
    title_ckb: 'داواکارییەکەت ئامادەیە',
    body_ar: 'شحنتك جاهزة للاستلام من الورشة.',
    body_en: 'Your items are ready for pickup at the workshop.',
    body_ckb: 'کاڵاکانت ئامادەن بۆ وەرگرتن لە کارگە.',
  },
  shipment_shipped: {
    title_ar: 'شُحن طلبك',
    title_en: 'Your order has shipped',
    title_ckb: 'داواکارییەکەت نێردرا',
    body_ar: 'خرجت شحنتك للتوصيل.',
    body_en: 'Your shipment is on its way.',
    body_ckb: 'ناردنەکەت بەڕێوەیە.',
  },
  inventory_low: {
    title_ar: 'رصيد مادة منخفض',
    title_en: 'Material running low',
    title_ckb: 'کەرەستە کەم بووەتەوە',
    body_ar: 'بقي لديك {qty} {unit} من «{name}».',
    body_en: 'You have {qty} {unit} of «{name}» left.',
    body_ckb: '{qty} {unit} لە «{name}» ماوەتەوە.',
  },
  buyback_approved: {
    title_ar: 'قُبل طلب إعادة البيع',
    title_en: 'Buyback approved',
    title_ckb: 'فرۆشتنەوە پەسەندکرا',
    body_ar: 'قُبل بيع {qty} {unit} من «{name}» بقيمة {value} د.ع.',
    body_en: 'Selling back {qty} {unit} of «{name}» was approved for {value} IQD.',
    body_ckb: 'فرۆشتنەوەی {qty} {unit} لە «{name}» بە {value} دینار پەسەندکرا.',
  },
  buyback_rejected: {
    title_ar: 'رُفض طلب إعادة البيع',
    title_en: 'Buyback declined',
    title_ckb: 'فرۆشتنەوە ڕەتکرایەوە',
    body_ar: 'لم يُقبل طلب بيع «{name}»، وأُعيدت الكمية إلى رصيدك.',
    body_en: 'The buyback of «{name}» was declined and the quantity is back in your balance.',
    body_ckb: 'فرۆشتنەوەی «{name}» ڕەتکرایەوە و بڕەکە گەڕایەوە سەر باڵانسەکەت.',
  },
  credits_adjusted: {
    title_ar: 'تعديل على رصيدك',
    title_en: 'Your balance was adjusted',
    title_ckb: 'باڵانسەکەت دەستکاری کرا',
    body_ar: 'أجرت الإدارة تعديلاً على رصيدك في الطباعة السحابية.',
    body_en: 'An administrator adjusted your Print Cloud balance.',
    body_ckb: 'بەڕێوەبەرایەتی باڵانسی چاپی هەوریی تۆی دەستکاری کرد.',
  },
};

export type PcEntity = 'print_cloud_order' | 'print_cloud_job' | 'print_cloud_shipment' | 'print_cloud_inventory' | 'print_cloud_buyback';

/** The notification statement for one Print Cloud event, ready for the event's own batch. */
export function pcNotify(
  db: D1Database,
  p: { userId: string; notice: PcNotice; entity: PcEntity; entityId: string; link: string; vars?: Record<string, string>; eventKey: string }
): Stmt {
  const t = TEXT[p.notice];
  const vars = p.vars ?? {};
  const input: NotificationInput = {
    userId: p.userId,
    kind: 'print_cloud',
    title_ar: t.title_ar,
    title_en: t.title_en,
    body_ar: fill(t.body_ar, vars),
    body_en: fill(t.body_en, vars),
    link: p.link,
    entity_type: p.entity,
    entity_id: p.entityId,
    meta: { notice: p.notice, title_ckb: t.title_ckb, body_ckb: fill(t.body_ckb, vars) },
    eventKey: `pc:${p.eventKey}`,
  };
  return notifyStatement(db, input).stmt;
}

/** For tests and the OpenAPI document: every notice has all three languages. */
export const NOTICE_TEXT: Readonly<Record<PcNotice, Text>> = TEXT;
