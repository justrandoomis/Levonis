/**
 * Deterministic (non-AI) support assistant, support tickets with REAL PRO
 * queue priority, and the PRO-operations console (final-phase brief §8 + §10).
 *
 * Assistant (/api/support/assistant):
 *   POST { intent?, params?, text?, locale? } → { reply }
 *   - Fixed allowlist of intents resolved by deterministic rules ONLY:
 *     button intents + per-language keyword dictionaries. No LLM, no external
 *     inference, no free-text SQL. Unknown/ambiguous input returns clarifying
 *     choices — never a guess.
 *   - Every account handler queries ONLY the signed-in user's own rows (or
 *     public catalog/published policies) and returns a small allowlisted DTO.
 *     A manipulated id (another user's order) gets the same
 *     not-found-in-your-account answer — existence is never revealed.
 *   - Honest delivery answers: only the recorded order status plus the
 *     documented 12–48h printer window WHEN the order qualifies.
 *
 * Tickets (/api/support/tickets...): explicit-confirmation creation, customer
 * thread + replies, staff replies and state changes (audited). Active PRO
 * (not gated by a restriction) snapshots priority=1; the admin queue REALLY
 * orders by priority then age, and age stays visible so nobody starves.
 *
 * PRO operations (/api/support/admin/...): member search/detail (subscription
 * term, identity state via kyc_cases READ — never decrypted identity or
 * evidence keys —, benefit context, BNPL account and repayment history,
 * restriction cases) and restriction-case management. Restrictions only ever
 * gate BENEFIT COMPUTATION — never orders, wallet, points, warranty or
 * support access.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { safeParse } from '../lib/types';
import { pricingCtx, publicWithDisplayPrice } from './products';
import { loadRelationsViews } from '../lib/productOverlay';
import {
  requireAuth,
  requireAdmin,
  badRequest,
  notFound,
  str,
  int,
  oneOf,
} from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { getBalances } from '../lib/wallet';
import { ENTITLEMENT_MINIMUM_TIER, benefits, getTierStatus, type MembershipEntitlement } from '../lib/entitlements';
import { bnplEligibility } from '../lib/bnpl';
import { coverageState, maskSerial } from '../lib/deviceOps';

export const supportRoutes = new Hono<AppContext>();

// ============================================================ shared helpers

/**
 * Benefit keys a restriction case may gate. They are generated from the
 * canonical entitlement contract rather than copied here, so adding or
 * renaming a membership capability cannot silently bypass support controls.
 * Support/warranty/data ACCESS is intentionally not restrictable — only
 * benefit computation.
 */
export const RESTRICTABLE_BENEFITS = Object.freeze(
  Object.keys(ENTITLEMENT_MINIMUM_TIER) as MembershipEntitlement[]
);

export const RESTRICTION_CASE_TYPES = [
  'dropshipping_suspected',
  'repeated_refusal',
  'abuse',
  'debt',
] as const;
type RestrictionCaseType = (typeof RESTRICTION_CASE_TYPES)[number];

/** Precise case type → the coarse 0003 CHECK-constrained kind column. */
const CASE_TYPE_TO_KIND: Record<RestrictionCaseType, string> = {
  dropshipping_suspected: 'fraud',
  repeated_refusal: 'refusal',
  abuse: 'other',
  debt: 'debt',
};

/**
 * Union of benefit flags gated by the user's ACTIVE restriction cases.
 * Exported so entitlement computation (checkout, memberships, community) can
 * consult decisions written here — see the integration note in the report:
 * an active restriction gates benefits, never data access.
 */
export async function activeRestrictionFlags(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT benefit_flags FROM restriction_cases WHERE user_id = ? AND state = 'active'")
    .bind(userId)
    .all<{ benefit_flags: string }>();
  const set = new Set<string>();
  for (const r of results) {
    for (const f of safeParse<unknown[]>(r.benefit_flags, [])) {
      if (typeof f === 'string') set.add(f);
    }
  }
  return set;
}

// ================================================================ assistant

const INTENTS = [
  'order_status',
  'delivery_estimate',
  'my_devices',
  'warranty_status',
  'points_balance',
  'membership_status',
  'return_help',
  'password_help',
  'product_search',
  'policy_question',
  'open_ticket',
  'human_handoff',
] as const;
type Intent = (typeof INTENTS)[number];

/** Intents that read the signed-in user's own data. */
const ACCOUNT_INTENTS = new Set<Intent>([
  'order_status',
  'delivery_estimate',
  'my_devices',
  'warranty_status',
  'points_balance',
  'membership_status',
  'open_ticket',
  'human_handoff',
]);

type Locale = 'ar' | 'en' | 'ckb';

/**
 * Deterministic keyword dictionaries (ar/en/ckb merged per intent — a user
 * may type Arabic while the UI is English). Plain lowercase substring match;
 * no scoring model, no inference.
 */
const KEYWORDS: Record<Intent, string[]> = {
  order_status: ['order', 'حالة الطلب', 'طلبي', 'طلباتي', 'وين طلبي', 'داواکاری', 'داواکاریەکەم', 'ord-'],
  delivery_estimate: ['delivery', 'arrive', 'shipping time', 'توصيل', 'يوصل', 'يصل', 'متى', 'وصول', 'گەیاندن', 'کەی دەگات'],
  my_devices: ['device', 'my printer', 'serial', 'جهاز', 'اجهزتي', 'أجهزتي', 'سيريال', 'ئامێر', 'ئامێرەکانم'],
  warranty_status: ['warranty', 'ضمان', 'الضمان', 'گەرەنتی', 'کفالة'],
  points_balance: ['point', 'نقاط', 'نقاطي', 'خاڵ', 'خاڵەکانم'],
  membership_status: ['membership', 'subscription', 'عضوية', 'اشتراك', 'اشتراكي', 'ئەندامێتی', 'بەشداری'],
  return_help: ['return', 'refund', 'ارجاع', 'إرجاع', 'استرجاع', 'استبدال', 'گەڕاندنەوە'],
  password_help: ['password', 'forgot', 'كلمة المرور', 'كلمة السر', 'نسيت', 'وشەی نهێنی', 'تێپەڕەوشە'],
  product_search: ['search', 'find product', 'بحث', 'ابحث', 'أبحث', 'منتج', 'گەڕان', 'بەرهەم'],
  policy_question: ['policy', 'policies', 'terms', 'privacy', 'سياسة', 'سياسات', 'شروط', 'خصوصية', 'سیاسەت', 'مەرج'],
  open_ticket: ['ticket', 'complaint', 'تذكرة', 'شكوى', 'مشكلة', 'تیکێت', 'سکاڵا'],
  human_handoff: ['human', 'agent', 'staff', 'talk to', 'موظف', 'انسان', 'إنسان', 'تحدث', 'اتواصل', 'کارمەند', 'مرۆڤ'],
};

/** Returns every intent with a keyword hit (deterministic, order-stable).
 *  Exported for unit tests only. */
export function matchIntents(text: string): Intent[] {
  const q = text.toLowerCase();
  const out: Intent[] = [];
  for (const intent of INTENTS) {
    if (KEYWORDS[intent].some((k) => q.includes(k))) out.push(intent);
  }
  return out;
}

// --------------------------------------------------------------- dictionary

const T: Record<Locale, Record<string, string>> = {
  ar: {
    sign_in_needed: 'هذه المعلومات خاصة بحسابك. سجّل الدخول للمتابعة.',
    sign_in: 'تسجيل الدخول',
    clarify: 'لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:',
    clarify_multi: 'قد تقصد أحد هذه المواضيع — اختر واحدًا:',
    c_order_status: 'حالة طلبي',
    c_delivery: 'موعد التوصيل',
    c_devices: 'أجهزتي المسجلة',
    c_warranty: 'حالة الضمان',
    c_points: 'رصيد النقاط',
    c_membership: 'حالة العضوية',
    c_returns: 'الإرجاع والاستبدال',
    c_password: 'مساعدة كلمة المرور',
    c_search: 'البحث عن منتج',
    c_policies: 'السياسات المنشورة',
    c_ticket: 'فتح تذكرة دعم',
    c_human: 'التحدث مع فريق ليفونيس',
    orders_none: 'لا توجد طلبات في حسابك بعد.',
    orders_pick: 'اختر أحد طلباتك:',
    order_not_found: 'لم أجد هذا الطلب في حسابك. اختر أحد طلباتك أو تواصل مع الدعم.',
    order_status_line: 'حالة الطلب {id}: {status} (أُنشئ بتاريخ {date}).',
    order_delivered_line: 'تم تسليم الطلب {id} بتاريخ {date}.',
    orders_link: 'فتح صفحة طلباتي',
    f_status: 'الحالة',
    f_total: 'المجموع',
    f_date: 'التاريخ',
    f_delivered: 'تاريخ التسليم',
    f_serial: 'الرقم التسلسلي',
    f_warranty: 'الضمان',
    f_price: 'السعر',
    est_pending: 'الطلب {id} بانتظار التأكيد — لا يسري أي موعد توصيل بعد.',
    est_cancelled: 'الطلب {id} ملغى.',
    est_printer:
      'الطلب {id} حالته: {status}. لتوصيل الطابعات، النافذة الموثقة هي 12–48 ساعة حيثما تتوفر الخدمة. أنقل لك الحالة المسجلة فقط ولا أستطيع وعدك بتاريخ محدد.',
    est_generic:
      'الطلب {id} حالته: {status}. أنقل لك الحالة المسجلة فقط — لا أستطيع اختراع تاريخ توصيل. سيتواصل الفريق معك عند التسليم.',
    est_preorder_note: 'يتضمن هذا الطلب بنود طلب مسبق؛ الوصول يعتمد على الشحن المختار (جوي/بحري/بري) الظاهر على الطلب.',
    devices_none: 'لا توجد أجهزة مسجلة في حسابك. سجّل جهازك بالرقم التسلسلي من صفحة الضمان.',
    devices_intro: 'أجهزتك المسجلة:',
    warranty_intro: 'حالة الضمان لأجهزتك المسجلة (يبدأ الضمان من تاريخ التسليم الفعلي، والتسجيل لا يغيّر المدة أبدًا):',
    w_active: 'فعال — متبقٍ {days} يومًا (ينتهي {date})',
    w_expired: 'منتهٍ ({date})',
    w_needs_config: 'مدة التغطية بحاجة إعداد — تواصل مع الدعم',
    w_not_delivered: 'لم يُسلَّم بعد — يبدأ الضمان عند التسليم',
    warranty_link: 'صفحة الضمان',
    points_line: 'رصيدك {points} نقطة. كل نقطة = 1 د.ع عند الدفع.',
    points_link: 'صفحة النقاط والمكافآت',
    member_none: 'لا توجد عضوية فعالة في حسابك. اطّلع على الخطط في صفحة الاشتراك.',
    member_active: 'عضوية {tier} فعالة حتى {date}.',
    member_pending_launch: 'عضوية {tier} مدفوعة ومحجوزة بالكامل؛ تبدأ مدتها عند الإطلاق المعلن.',
    member_link: 'صفحة العضوية',
    returns_help:
      'يمكنك طلب الإرجاع خلال 7 أيام من التسليم الفعلي في حالات: عيب مصنعي، خلل في التصنيع، اختلاف عن الوصف، منتج خاطئ، أو ضرر أثناء الشحن. تُحسب المدة من تسليم البند المتأثر نفسه، والطلب المقدَّم ضمن المدة يبقى ضمنها حتى لو تأخرت المراجعة. افتح الطلب لبدء الإرجاع.',
    password_signed_in:
      'لتغيير كلمة المرور: الإعدادات ← الأمان، مع إدخال كلمة المرور الحالية. إن نسيتها، سجّل الخروج ثم استخدم "نسيت كلمة المرور" في صفحة الدخول.',
    password_anon:
      'استخدم "نسيت كلمة المرور" في صفحة الدخول — أدخل بريد حسابك واتبع الرسالة التي تصلك. لأسباب أمنية تكون الاستجابة واحدة سواء كان البريد مسجلًا أم لا.',
    settings_link: 'فتح الإعدادات',
    search_empty: 'اكتب ما تبحث عنه (مثال: PLA، فوهة، A1).',
    search_none: 'لم أجد منتجات مطابقة في الكتالوج العام.',
    search_intro: 'هذا ما وجدته:',
    in_stock: 'متوفر',
    out_of_stock: 'غير متوفر',
    open_product: 'عرض المنتج',
    policies_none: 'لا توجد سياسات منشورة بعد — ستظهر هنا فور نشرها من المالك.',
    policies_pick: 'السياسات المنشورة:',
    policy_read: 'قراءة السياسة كاملة',
    ticket_prompt: 'أستطيع فتح تذكرة دعم حقيقية لفريق ليفونيس. ستراجع وتؤكد قبل الإرسال.',
    human_prompt:
      'سيجيبك موظف من فريق ليفونيس داخل تذكرة دعم — هذه هي قناة التواصل البشري المباشرة. ستراجع وتؤكد قبل إنشائها.',
    pro_priority_note: 'تذاكر أعضاء PRO الفعالين تحصل على أولوية حقيقية في قائمة الانتظار.',
  },
  en: {
    sign_in_needed: 'This information is private to your account. Please sign in to continue.',
    sign_in: 'Sign in',
    clarify: 'I did not fully understand. Please choose one of these topics:',
    clarify_multi: 'You might mean one of these — choose one:',
    c_order_status: 'My order status',
    c_delivery: 'Delivery estimate',
    c_devices: 'My registered devices',
    c_warranty: 'Warranty status',
    c_points: 'Points balance',
    c_membership: 'Membership status',
    c_returns: 'Returns & replacement',
    c_password: 'Password help',
    c_search: 'Search products',
    c_policies: 'Published policies',
    c_ticket: 'Open a support ticket',
    c_human: 'Talk to LEVONIS staff',
    orders_none: 'You have no orders in your account yet.',
    orders_pick: 'Choose one of your orders:',
    order_not_found: 'I could not find that order in your account. Choose one of your orders or contact support.',
    order_status_line: 'Order {id} is currently: {status} (placed {date}).',
    order_delivered_line: 'Order {id} was delivered on {date}.',
    orders_link: 'Open my orders',
    f_status: 'Status',
    f_total: 'Total',
    f_date: 'Date',
    f_delivered: 'Delivered',
    f_serial: 'Serial',
    f_warranty: 'Warranty',
    f_price: 'Price',
    est_pending: 'Order {id} is awaiting confirmation — no delivery window applies yet.',
    est_cancelled: 'Order {id} is cancelled.',
    est_printer:
      'Order {id} is: {status}. For printer delivery, the documented window is 12–48 hours where the service is available. I can only relay the recorded status — I cannot promise an exact date.',
    est_generic:
      'Order {id} is: {status}. I can only relay the recorded status — I will not invent a delivery date. Staff will contact you for handover.',
    est_preorder_note: 'This order includes pre-order items; arrival depends on the selected freight (air/sea/land) shown on the order.',
    devices_none: 'No registered devices on your account. Register a device with its serial number from the Warranty page.',
    devices_intro: 'Your registered devices:',
    warranty_intro:
      'Warranty status of your registered devices (coverage starts at the actual delivery time — registering never changes the dates):',
    w_active: 'Active — {days} days remaining (ends {date})',
    w_expired: 'Expired ({date})',
    w_needs_config: 'Coverage duration awaiting configuration — contact support',
    w_not_delivered: 'Not delivered yet — coverage starts at delivery',
    warranty_link: 'Warranty page',
    points_line: 'Your balance is {points} points. 1 point = 1 IQD at checkout.',
    points_link: 'Points & rewards',
    member_none: 'You have no active membership. See the plans on the Subscription page.',
    member_active: 'Your {tier} membership is active until {date}.',
    member_pending_launch: 'Your {tier} membership is paid and fully reserved; its term starts at the announced launch.',
    member_link: 'Membership page',
    returns_help:
      'You can request a return within 7 days of actual delivery for: defective items, manufacturing faults, not-as-described goods, wrong items, or shipping damage. The window is measured from the delivery of the affected item — a timely request stays timely even if review happens later. Open the order to start a return.',
    password_signed_in:
      'To change your password: Settings → Security, entering your current password. If you forgot it, sign out and use "Forgot password" on the sign-in page.',
    password_anon:
      'Use "Forgot password" on the sign-in page — enter your account email and follow the message you receive. For security, the response is the same whether or not the email is registered.',
    settings_link: 'Open settings',
    search_empty: 'Type what you are looking for (e.g. PLA, nozzle, A1).',
    search_none: 'No matching products found in the public catalog.',
    search_intro: 'Here is what I found:',
    in_stock: 'In stock',
    out_of_stock: 'Out of stock',
    open_product: 'View product',
    policies_none: 'No policies are published yet — they will appear here once the owner publishes them.',
    policies_pick: 'Published policies:',
    policy_read: 'Read the full policy',
    ticket_prompt: 'I can open a real support ticket for the LEVONIS team. You will review and confirm before it is sent.',
    human_prompt:
      'A LEVONIS staff member will answer you inside a support ticket — that is the direct human channel. You will review and confirm before it is created.',
    pro_priority_note: 'Tickets from active PRO members get real queue priority.',
  },
  ckb: {
    sign_in_needed: 'ئەم زانیارییە تایبەتە بە هەژمارەکەت. بۆ بەردەوامبوون بچۆ ژوورەوە.',
    sign_in: 'چوونەژوورەوە',
    clarify: 'بە تەواوی تێنەگەیشتم. یەکێک لەم بابەتانە هەڵبژێرە:',
    clarify_multi: 'لەوانەیە مەبەستت یەکێک لەمانە بێت — یەکێک هەڵبژێرە:',
    c_order_status: 'دۆخی داواکاریم',
    c_delivery: 'کاتی گەیاندن',
    c_devices: 'ئامێرە تۆمارکراوەکانم',
    c_warranty: 'دۆخی گەرەنتی',
    c_points: 'باڵانسی خاڵ',
    c_membership: 'دۆخی ئەندامێتی',
    c_returns: 'گەڕاندنەوە و گۆڕینەوە',
    c_password: 'یارمەتی وشەی نهێنی',
    c_search: 'گەڕان بۆ بەرهەم',
    c_policies: 'سیاسەتە بڵاوکراوەکان',
    c_ticket: 'کردنەوەی تیکێتی پشتگیری',
    c_human: 'قسەکردن لەگەڵ ستافی ليڤۆنیس',
    orders_none: 'هێشتا هیچ داواکارییەک لە هەژمارەکەتدا نییە.',
    orders_pick: 'یەکێک لە داواکارییەکانت هەڵبژێرە:',
    order_not_found: 'ئەم داواکارییەم لە هەژمارەکەتدا نەدۆزییەوە. یەکێک لە داواکارییەکانت هەڵبژێرە یان پەیوەندی بە پشتگیری بکە.',
    order_status_line: 'دۆخی داواکاری {id}: {status} (لە {date} دروستکراوە).',
    order_delivered_line: 'داواکاری {id} لە {date} گەیەنرا.',
    orders_link: 'کردنەوەی داواکارییەکانم',
    f_status: 'دۆخ',
    f_total: 'کۆی گشتی',
    f_date: 'بەروار',
    f_delivered: 'بەرواری گەیاندن',
    f_serial: 'ژمارەی زنجیرەیی',
    f_warranty: 'گەرەنتی',
    f_price: 'نرخ',
    est_pending: 'داواکاری {id} چاوەڕوانی پشتڕاستکردنەوەیە — هێشتا هیچ ماوەیەکی گەیاندن نییە.',
    est_cancelled: 'داواکاری {id} هەڵوەشێنراوەتەوە.',
    est_printer:
      'داواکاری {id} دۆخی: {status}. بۆ گەیاندنی پرینتەر، ماوە بەڵگەدارەکە 12–48 کاتژمێرە لەو شوێنانەی خزمەتگوزارییەکە بەردەستە. تەنها دۆخی تۆمارکراو دەگوازمەوە — ناتوانم بەرواری دیاریکراو بەڵێن بدەم.',
    est_generic:
      'داواکاری {id} دۆخی: {status}. تەنها دۆخی تۆمارکراو دەگوازمەوە — بەرواری گەیاندن دانانێم. ستاف بۆ گەیاندن پەیوەندیت پێوە دەکات.',
    est_preorder_note: 'ئەم داواکارییە بڕگەی پێش-داواکاری لەخۆدەگرێت؛ گەیشتن بەستراوە بە شێوازی گواستنەوەی هەڵبژێردراو (ئاسمانی/دەریایی/وشکانی).',
    devices_none: 'هیچ ئامێرێکی تۆمارکراو لە هەژمارەکەتدا نییە. لە پەڕەی گەرەنتی ئامێرەکەت بە ژمارە زنجیرەییەکەی تۆمار بکە.',
    devices_intro: 'ئامێرە تۆمارکراوەکانت:',
    warranty_intro: 'دۆخی گەرەنتی ئامێرە تۆمارکراوەکانت (گەرەنتی لە کاتی گەیاندنی ڕاستەقینەوە دەست پێدەکات و تۆمارکردن هەرگیز بەروارەکان ناگۆڕێت):',
    w_active: 'چالاکە — {days} ڕۆژ ماوە (لە {date} کۆتایی دێت)',
    w_expired: 'بەسەرچووە ({date})',
    w_needs_config: 'ماوەی گەرەنتی پێویستی بە ڕێکخستنە — پەیوەندی بە پشتگیری بکە',
    w_not_delivered: 'هێشتا نەگەیەنراوە — گەرەنتی لە کاتی گەیاندنەوە دەست پێدەکات',
    warranty_link: 'پەڕەی گەرەنتی',
    points_line: 'باڵانسەکەت {points} خاڵە. هەر خاڵێک = 1 د.ع لە کاتی پارەدان.',
    points_link: 'پەڕەی خاڵ و خەڵات',
    member_none: 'هیچ ئەندامێتییەکی چالاکت نییە. پلانەکان لە پەڕەی بەشداری ببینە.',
    member_active: 'ئەندامێتی {tier} چالاکە تا {date}.',
    member_pending_launch: 'ئەندامێتی {tier} پارەی دراوە و بە تەواوی حجزکراوە؛ ماوەکەی لە کاتی دەستپێکی ڕاگەیەنراودا دەست پێدەکات.',
    member_link: 'پەڕەی ئەندامێتی',
    returns_help:
      'دەتوانیت لە ماوەی 7 ڕۆژ لە گەیاندنی ڕاستەقینەوە داوای گەڕاندنەوە بکەیت بۆ: کەموکوڕی، هەڵەی دروستکردن، جیاوازی لە وەسف، بەرهەمی هەڵە، یان زیانی گواستنەوە. ماوەکە لە گەیاندنی بڕگە کاریگەرەکەوە دەژمێردرێت — داواکاری لە کاتی خۆیدا لە کاتی خۆیدا دەمێنێتەوە تەنانەت ئەگەر پێداچوونەوە دواکەوت. داواکارییەکە بکەرەوە بۆ دەستپێکردنی گەڕاندنەوە.',
    password_signed_in:
      'بۆ گۆڕینی وشەی نهێنی: ڕێکخستنەکان ← ئاسایش، بە نووسینی وشەی نهێنی ئێستات. ئەگەر لەبیرت چووە، بچۆ دەرەوە و "وشەی نهێنیم لەبیرچووە" لە پەڕەی چوونەژوورەوە بەکاربهێنە.',
    password_anon:
      '"وشەی نهێنیم لەبیرچووە" لە پەڕەی چوونەژوورەوە بەکاربهێنە — ئیمەیڵی هەژمارەکەت بنووسە و پەیامەکە جێبەجێ بکە. بۆ ئاسایش، وەڵامەکە هەمان شتە جا ئیمەیڵەکە تۆمارکرابێت یان نا.',
    settings_link: 'کردنەوەی ڕێکخستنەکان',
    search_empty: 'ئەوەی بۆی دەگەڕێیت بنووسە (نموونە: PLA، نۆزڵ، A1).',
    search_none: 'هیچ بەرهەمێکی هاوتا لە کاتالۆگی گشتیدا نەدۆزرایەوە.',
    search_intro: 'ئەمە ئەوەیە کە دۆزیمەوە:',
    in_stock: 'بەردەستە',
    out_of_stock: 'بەردەست نییە',
    open_product: 'بینینی بەرهەم',
    policies_none: 'هێشتا هیچ سیاسەتێک بڵاونەکراوەتەوە — کاتێک خاوەن بڵاویان دەکاتەوە لێرە دەردەکەون.',
    policies_pick: 'سیاسەتە بڵاوکراوەکان:',
    policy_read: 'خوێندنەوەی سیاسەتەکە بە تەواوی',
    ticket_prompt: 'دەتوانم تیکێتێکی پشتگیری ڕاستەقینە بۆ تیمی ليڤۆنیس بکەمەوە. پێش ناردن پێداچوونەوە و پشتڕاستکردنەوە دەکەیت.',
    human_prompt:
      'کارمەندێکی ليڤۆنیس لە ناو تیکێتی پشتگیریدا وەڵامت دەداتەوە — ئەمە کەناڵی مرۆیی ڕاستەوخۆیە. پێش دروستکردنی پێداچوونەوە و پشتڕاستکردنەوە دەکەیت.',
    pro_priority_note: 'تیکێتی ئەندامە چالاکەکانی PRO پێشینەیی ڕاستەقینەیان هەیە لە ڕیزەکەدا.',
  },
};

function tr(loc: Locale, key: string, vars: Record<string, string | number> = {}): string {
  let s = T[loc][key] ?? T.ar[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const ORDER_STATUS_LABELS: Record<Locale, Record<string, string>> = {
  ar: { pending: 'قيد الانتظار', confirmed: 'مؤكد', processing: 'قيد التجهيز', shipped: 'مع المندوب', delivered: 'تم التسليم', cancelled: 'ملغى' },
  en: { pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' },
  ckb: { pending: 'چاوەڕوان', confirmed: 'پشتڕاستکراوە', processing: 'ئامادەکاری', shipped: 'نێردراوە', delivered: 'گەیەنراوە', cancelled: 'هەڵوەشاوە' },
};

function statusLabel(loc: Locale, status: string): string {
  return ORDER_STATUS_LABELS[loc][status] ?? status;
}

function fmtIqd(loc: Locale, n: number): string {
  const num = Math.round(n).toLocaleString('en-US');
  return loc === 'en' ? `${num} IQD` : `${num} د.ع`;
}

function fmtDate(iso: unknown): string {
  const s = typeof iso === 'string' ? iso : '';
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveLocale(c: Context<AppContext>, requested: unknown): Locale {
  if (requested === 'ar' || requested === 'en' || requested === 'ckb') return requested;
  const u = c.get('user');
  if (u?.locale === 'ar') return 'ar';
  if (u?.locale === 'ku') return 'ckb';
  if (u?.locale === 'en') return 'en';
  return 'ar';
}

// ----------------------------------------------------------- reply building

interface AssistantLink {
  label: string;
  to: string;
}
interface AssistantChoice {
  label: string;
  intent: Intent;
  params?: Record<string, unknown>;
}
interface AssistantCard {
  title: string;
  subtitle?: string;
  image?: string;
  badge?: string;
  fields?: Array<{ label: string; value: string }>;
  link?: AssistantLink;
}
interface AssistantReply {
  intent: string;
  text: string;
  cards?: AssistantCard[];
  choices?: AssistantChoice[];
  links?: AssistantLink[];
  auth_required?: boolean;
  handoff?: boolean;
}

const MENU_ITEMS: Array<{ intent: Intent; labelKey: string }> = [
  { intent: 'order_status', labelKey: 'c_order_status' },
  { intent: 'delivery_estimate', labelKey: 'c_delivery' },
  { intent: 'my_devices', labelKey: 'c_devices' },
  { intent: 'warranty_status', labelKey: 'c_warranty' },
  { intent: 'points_balance', labelKey: 'c_points' },
  { intent: 'membership_status', labelKey: 'c_membership' },
  { intent: 'return_help', labelKey: 'c_returns' },
  { intent: 'password_help', labelKey: 'c_password' },
  { intent: 'product_search', labelKey: 'c_search' },
  { intent: 'policy_question', labelKey: 'c_policies' },
  { intent: 'open_ticket', labelKey: 'c_ticket' },
  { intent: 'human_handoff', labelKey: 'c_human' },
];

function menuChoices(loc: Locale, only?: Intent[]): AssistantChoice[] {
  return MENU_ITEMS.filter((m) => !only || only.includes(m.intent)).map((m) => ({
    label: tr(loc, m.labelKey),
    intent: m.intent,
  }));
}

function signInReply(intent: string, loc: Locale): AssistantReply {
  return {
    intent,
    text: tr(loc, 'sign_in_needed'),
    auth_required: true,
    links: [{ label: tr(loc, 'sign_in'), to: '/auth' }],
  };
}

// ------------------------------------------------------------ data helpers

interface OrderLite extends Record<string, unknown> {
  id: string;
  status: string;
  total_iqd: number;
  created_at: string;
  delivered_at: string | null;
}

async function ownOrders(db: D1Database, userId: string, limit = 5): Promise<OrderLite[]> {
  const { results } = await db
    .prepare('SELECT id, status, total_iqd, created_at, delivered_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, limit)
    .all<OrderLite>();
  return results;
}

/** Ownership-filtered single-order lookup: WHERE id AND user_id — a foreign
 *  or unknown id is indistinguishable (same not-found answer). */
async function ownOrder(db: D1Database, userId: string, orderId: string): Promise<OrderLite | null> {
  const row = await db
    .prepare('SELECT id, status, total_iqd, created_at, delivered_at FROM orders WHERE id = ? AND user_id = ?')
    .bind(orderId, userId)
    .first<OrderLite>();
  return row ?? null;
}

function orderChoices(orders: OrderLite[], loc: Locale, intent: Intent): AssistantChoice[] {
  return orders.map((o) => ({
    label: `${o.id} · ${statusLabel(loc, o.status)} · ${fmtDate(o.created_at)}`,
    intent,
    params: { order_id: o.id },
  }));
}

async function orderPickReply(db: D1Database, userId: string, loc: Locale, intent: Intent, textKey: string): Promise<AssistantReply> {
  const orders = await ownOrders(db, userId);
  if (orders.length === 0) {
    return { intent, text: tr(loc, 'orders_none'), links: [{ label: tr(loc, 'orders_link'), to: '/orders' }] };
  }
  return {
    intent,
    text: tr(loc, textKey),
    choices: orderChoices(orders, loc, intent),
    links: [{ label: tr(loc, 'orders_link'), to: '/orders' }],
  };
}

interface DeviceLite extends Record<string, unknown> {
  id: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  serial_raw: string | null;
  name_snapshot: string | null;
  p_name: string | null;
  p_name_ar: string | null;
  p_name_ku: string | null;
}

async function ownDevices(db: D1Database, userId: string): Promise<DeviceLite[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.delivered_at, u.warranty_end_at, s.serial_raw, oi.name_snapshot,
              p.name AS p_name, p.name_ar AS p_name_ar, p.name_ku AS p_name_ku
         FROM device_registrations r
         JOIN order_item_units u ON u.id = r.unit_id
         LEFT JOIN device_serials s ON s.unit_id = u.id
         LEFT JOIN order_items oi ON oi.id = u.order_item_id
         LEFT JOIN products p ON p.id = u.product_id
        WHERE r.user_id = ? AND r.revoked_at IS NULL
        ORDER BY r.registered_at DESC
        LIMIT 10`
    )
    .bind(userId)
    .all<DeviceLite>();
  return results;
}

function pickName(loc: Locale, d: { p_name: string | null; p_name_ar: string | null; p_name_ku: string | null; name_snapshot: string | null }): string {
  const ar = d.p_name_ar || '';
  const en = d.p_name || '';
  const ckb = d.p_name_ku || '';
  const fallback = d.name_snapshot || en || ar || ckb || '—';
  if (loc === 'en') return en || fallback;
  if (loc === 'ckb') return ckb || ar || fallback;
  return ar || fallback;
}

function deviceCard(d: DeviceLite, loc: Locale): AssistantCard {
  const cov = coverageState(d.delivered_at, d.warranty_end_at);
  let w: string;
  if (cov.state === 'active') w = tr(loc, 'w_active', { days: cov.remaining_days ?? 0, date: fmtDate(d.warranty_end_at) });
  else if (cov.state === 'expired') w = tr(loc, 'w_expired', { date: fmtDate(d.warranty_end_at) });
  else if (cov.state === 'not_delivered') w = tr(loc, 'w_not_delivered');
  else w = tr(loc, 'w_needs_config');
  const fields: Array<{ label: string; value: string }> = [{ label: tr(loc, 'f_warranty'), value: w }];
  if (d.delivered_at) fields.unshift({ label: tr(loc, 'f_delivered'), value: fmtDate(d.delivered_at) });
  return {
    title: pickName(loc, d),
    subtitle: d.serial_raw ? `${tr(loc, 'f_serial')}: ${maskSerial(d.serial_raw)}` : undefined,
    fields,
    link: { label: tr(loc, 'warranty_link'), to: '/warranty' },
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ------------------------------------------------------------------ handlers

async function handleOrderStatus(c: Context<AppContext>, user: SessionUser, params: Record<string, unknown>, loc: Locale): Promise<AssistantReply> {
  const db = c.env.DB;
  const orderId = str(params.order_id, 'order_id', { max: 40, required: false }).toUpperCase();
  if (!orderId) return orderPickReply(db, user.id, loc, 'order_status', 'orders_pick');
  const order = await ownOrder(db, user.id, orderId);
  if (!order) {
    const pick = await orderPickReply(db, user.id, loc, 'order_status', 'orders_pick');
    return { ...pick, text: tr(loc, 'order_not_found') };
  }
  const text =
    order.status === 'delivered' && order.delivered_at
      ? tr(loc, 'order_delivered_line', { id: order.id, date: fmtDate(order.delivered_at) })
      : tr(loc, 'order_status_line', { id: order.id, status: statusLabel(loc, order.status), date: fmtDate(order.created_at) });
  const fields = [
    { label: tr(loc, 'f_total'), value: fmtIqd(loc, order.total_iqd) },
    { label: tr(loc, 'f_date'), value: fmtDate(order.created_at) },
  ];
  if (order.delivered_at) fields.push({ label: tr(loc, 'f_delivered'), value: fmtDate(order.delivered_at) });
  return {
    intent: 'order_status',
    text,
    cards: [{ title: order.id, badge: statusLabel(loc, order.status), fields, link: { label: tr(loc, 'orders_link'), to: '/orders' } }],
  };
}

async function handleDeliveryEstimate(c: Context<AppContext>, user: SessionUser, params: Record<string, unknown>, loc: Locale): Promise<AssistantReply> {
  const db = c.env.DB;
  const orderId = str(params.order_id, 'order_id', { max: 40, required: false }).toUpperCase();
  if (!orderId) return orderPickReply(db, user.id, loc, 'delivery_estimate', 'orders_pick');
  const order = await ownOrder(db, user.id, orderId);
  if (!order) {
    const pick = await orderPickReply(db, user.id, loc, 'delivery_estimate', 'orders_pick');
    return { ...pick, text: tr(loc, 'order_not_found') };
  }

  if (order.status === 'pending') return { intent: 'delivery_estimate', text: tr(loc, 'est_pending', { id: order.id }) };
  if (order.status === 'cancelled') return { intent: 'delivery_estimate', text: tr(loc, 'est_cancelled', { id: order.id }) };
  if (order.status === 'delivered') {
    return { intent: 'delivery_estimate', text: tr(loc, 'order_delivered_line', { id: order.id, date: fmtDate(order.delivered_at ?? order.created_at) }) };
  }

  // Qualification for the documented 12–48h printer window: the order holds a
  // printer-class item shipping DIRECT (not a preorder). No date is invented.
  const { results: items } = await db
    .prepare(
      `SELECT oi.shipping_method_id, p.ops_policy
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?`
    )
    .bind(order.id)
    .all<{ shipping_method_id: string; ops_policy: string | null }>();

  let printerDirect = false;
  let hasPreorder = false;
  for (const it of items) {
    const ship = it.shipping_method_id || '';
    const isPreorder = ship.startsWith('preorder');
    if (isPreorder) hasPreorder = true;
    const sizeClass = safeParse<Record<string, unknown>>(it.ops_policy, {}).size_class;
    const isPrinter = sizeClass === 'printer_small' || sizeClass === 'printer_large';
    if (isPrinter && !isPreorder) printerDirect = true;
  }

  const status = statusLabel(loc, order.status);
  let text = printerDirect
    ? tr(loc, 'est_printer', { id: order.id, status })
    : tr(loc, 'est_generic', { id: order.id, status });
  if (hasPreorder) text += ` ${tr(loc, 'est_preorder_note')}`;
  return { intent: 'delivery_estimate', text };
}

async function handleDevices(c: Context<AppContext>, user: SessionUser, loc: Locale, intent: 'my_devices' | 'warranty_status'): Promise<AssistantReply> {
  const devices = await ownDevices(c.env.DB, user.id);
  if (devices.length === 0) {
    return { intent, text: tr(loc, 'devices_none'), links: [{ label: tr(loc, 'warranty_link'), to: '/warranty' }] };
  }
  return {
    intent,
    text: tr(loc, intent === 'my_devices' ? 'devices_intro' : 'warranty_intro'),
    cards: devices.map((d) => deviceCard(d, loc)),
    links: [{ label: tr(loc, 'warranty_link'), to: '/warranty' }],
  };
}

async function handlePoints(c: Context<AppContext>, user: SessionUser, loc: Locale): Promise<AssistantReply> {
  const balances = await getBalances(c.env.DB, user.id);
  return {
    intent: 'points_balance',
    text: tr(loc, 'points_line', { points: balances.points.toLocaleString('en-US') }),
    links: [{ label: tr(loc, 'points_link'), to: '/points' }],
  };
}

async function handleMembership(c: Context<AppContext>, user: SessionUser, loc: Locale): Promise<AssistantReply> {
  const status = await getTierStatus(c.env.DB, user.id);
  const parts: string[] = [];
  if (status.active && status.tier !== 'free') {
    parts.push(tr(loc, 'member_active', { tier: status.tier.toUpperCase(), date: fmtDate(status.expires_at) }));
  }
  if (status.pending_launch) {
    parts.push(tr(loc, 'member_pending_launch', { tier: status.pending_launch.tier.toUpperCase() }));
  }
  if (parts.length === 0) parts.push(tr(loc, 'member_none'));
  return {
    intent: 'membership_status',
    text: parts.join(' '),
    links: [{ label: tr(loc, 'member_link'), to: '/subscription' }],
  };
}

function handleReturnHelp(loc: Locale, signedIn: boolean): AssistantReply {
  const links: AssistantLink[] = signedIn ? [{ label: tr(loc, 'orders_link'), to: '/orders' }] : [{ label: tr(loc, 'sign_in'), to: '/auth' }];
  return { intent: 'return_help', text: tr(loc, 'returns_help'), links };
}

function handlePasswordHelp(loc: Locale, signedIn: boolean): AssistantReply {
  return signedIn
    ? { intent: 'password_help', text: tr(loc, 'password_signed_in'), links: [{ label: tr(loc, 'settings_link'), to: '/settings' }] }
    : { intent: 'password_help', text: tr(loc, 'password_anon'), links: [{ label: tr(loc, 'sign_in'), to: '/auth' }] };
}

async function handleProductSearch(c: Context<AppContext>, params: Record<string, unknown>, freeText: string, loc: Locale): Promise<AssistantReply> {
  const q = str(params.q, 'q', { max: 100, required: false }) || freeText.trim();
  if (q.length < 2) return { intent: 'product_search', text: tr(loc, 'search_empty') };
  const like = `%${escapeLike(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM products
      WHERE status = 'active'
        AND (name LIKE ?1 ESCAPE '\\' OR name_ar LIKE ?1 ESCAPE '\\' OR name_ku LIKE ?1 ESCAPE '\\' OR brand LIKE ?1 ESCAPE '\\')
      ORDER BY is_featured DESC, created_at DESC
      LIMIT 5`
  )
    .bind(like)
    .all<Record<string, unknown>>();
  if (results.length === 0) return { intent: 'product_search', text: tr(loc, 'search_none') };

  // THE ASSISTANT QUOTES THE PRICE THE STOREFRONT QUOTES. It used to read
  // `products.price_iqd` — the BASE row — so a product whose cheapest option
  // costs less was announced at a price its own card contradicted, and a
  // product repriced only in the relational tables was announced at a stale
  // one. publicWithDisplayPrice is the same function the cards go through:
  // the relational overlay, the resolver, the viewer's own tier, and a public
  // shape that has never carried an internal cost.
  const ctx = await pricingCtx(c);
  const views = await loadRelationsViews(
    c.env.DB,
    results.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );
  const cards: AssistantCard[] = results.map((row) => {
    const p = publicWithDisplayPrice(row, ctx, views.get(String(row.id))) as Record<string, unknown>;
    const images = safeParse<unknown[]>(row.images, []);
    const image = typeof images[0] === 'string' ? (images[0] as string) : undefined;
    const stock = p.stock;
    const badge = typeof stock === 'number' ? (stock > 0 ? tr(loc, 'in_stock') : tr(loc, 'out_of_stock')) : undefined;
    const shown = Number(p.display_price_iqd ?? p.price_iqd ?? 0) || 0;
    return {
      title: pickName(loc, {
        p_name: String(row.name ?? ''),
        p_name_ar: String(row.name_ar ?? ''),
        p_name_ku: String(row.name_ku ?? ''),
        name_snapshot: null,
      }),
      subtitle: `${tr(loc, 'f_price')}: ${fmtIqd(loc, shown)}`,
      image,
      badge,
      link: { label: tr(loc, 'open_product'), to: `/product/${row.slug}` },
    };
  });
  return { intent: 'product_search', text: tr(loc, 'search_intro'), cards };
}

async function handlePolicyQuestion(c: Context<AppContext>, params: Record<string, unknown>, loc: Locale): Promise<AssistantReply> {
  const db = c.env.DB;
  const key = str(params.key, 'key', { max: 40, required: false });
  const dbLang = loc; // policy_documents stores 'ckb' directly (0003)
  if (key) {
    // Published documents only — drafts are never quoted.
    let doc = await db
      .prepare("SELECT title, body, version FROM policy_documents WHERE key = ? AND lang = ? AND status = 'published' ORDER BY version DESC LIMIT 1")
      .bind(key, dbLang)
      .first<{ title: string; body: string; version: number }>();
    if (!doc && dbLang !== 'ar') {
      doc = await db
        .prepare("SELECT title, body, version FROM policy_documents WHERE key = ? AND lang = 'ar' AND status = 'published' ORDER BY version DESC LIMIT 1")
        .bind(key)
        .first<{ title: string; body: string; version: number }>();
    }
    if (!doc) return { intent: 'policy_question', text: tr(loc, 'policies_none') };
    const snippet = doc.body.length > 320 ? `${doc.body.slice(0, 320)}…` : doc.body;
    return {
      intent: 'policy_question',
      text: snippet,
      cards: [{ title: doc.title, badge: `v${doc.version}`, link: { label: tr(loc, 'policy_read'), to: `/policies/${key}` } }],
    };
  }
  // No key: list the published policies as choices.
  const { results } = await db
    .prepare(
      `SELECT p.key, p.title FROM policy_documents p
        JOIN (SELECT key, MAX(version) AS v FROM policy_documents WHERE status = 'published' GROUP BY key) latest
          ON latest.key = p.key AND latest.v = p.version
       WHERE p.status = 'published' AND p.lang = ?
       ORDER BY p.key`
    )
    .bind(dbLang)
    .all<{ key: string; title: string }>();
  let rows = results;
  if (rows.length === 0 && dbLang !== 'ar') {
    const arRows = await db
      .prepare(
        `SELECT p.key, p.title FROM policy_documents p
          JOIN (SELECT key, MAX(version) AS v FROM policy_documents WHERE status = 'published' GROUP BY key) latest
            ON latest.key = p.key AND latest.v = p.version
         WHERE p.status = 'published' AND p.lang = 'ar'
         ORDER BY p.key`
      )
      .all<{ key: string; title: string }>();
    rows = arRows.results;
  }
  if (rows.length === 0) return { intent: 'policy_question', text: tr(loc, 'policies_none') };
  return {
    intent: 'policy_question',
    text: tr(loc, 'policies_pick'),
    choices: rows.map((r) => ({ label: r.title, intent: 'policy_question' as Intent, params: { key: r.key } })),
  };
}

function handleHandoff(intent: 'open_ticket' | 'human_handoff', loc: Locale): AssistantReply {
  return {
    intent,
    text: `${tr(loc, intent === 'open_ticket' ? 'ticket_prompt' : 'human_prompt')} ${tr(loc, 'pro_priority_note')}`,
    handoff: true,
  };
}

// ------------------------------------------------------------------- route

supportRoutes.post('/assistant', async (c) => {
  await rateLimit(c, 'support-assistant', 40, 300);
  const user = c.get('user'); // may be null — public intents work anonymously
  const body = await c.req.json().catch(() => ({}));
  const loc = resolveLocale(c, body.locale);
  const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>;
  const freeText = str(body.text, 'text', { max: 500, required: false });

  let intent: Intent | null = null;
  if (typeof body.intent === 'string' && (INTENTS as readonly string[]).includes(body.intent)) {
    intent = body.intent as Intent;
  } else if (freeText) {
    const matches = matchIntents(freeText);
    if (matches.length === 1) {
      intent = matches[0];
    } else {
      // Ambiguous or unknown → clarifying choices, never a guess.
      const subset = matches.length > 1 ? matches : undefined;
      return c.json({
        success: true,
        reply: {
          intent: 'clarify',
          text: tr(loc, subset ? 'clarify_multi' : 'clarify'),
          choices: menuChoices(loc, subset),
        } satisfies AssistantReply,
      });
    }
  } else {
    return c.json({
      success: true,
      reply: { intent: 'clarify', text: tr(loc, 'clarify'), choices: menuChoices(loc) } satisfies AssistantReply,
    });
  }

  if (ACCOUNT_INTENTS.has(intent) && !user) {
    return c.json({ success: true, reply: signInReply(intent, loc) });
  }

  let reply: AssistantReply;
  switch (intent) {
    case 'order_status':
      reply = await handleOrderStatus(c, user!, params, loc);
      break;
    case 'delivery_estimate':
      reply = await handleDeliveryEstimate(c, user!, params, loc);
      break;
    case 'my_devices':
    case 'warranty_status':
      reply = await handleDevices(c, user!, loc, intent);
      break;
    case 'points_balance':
      reply = await handlePoints(c, user!, loc);
      break;
    case 'membership_status':
      reply = await handleMembership(c, user!, loc);
      break;
    case 'return_help':
      reply = handleReturnHelp(loc, !!user);
      break;
    case 'password_help':
      reply = handlePasswordHelp(loc, !!user);
      break;
    case 'product_search':
      reply = await handleProductSearch(c, params, freeText, loc);
      break;
    case 'policy_question':
      reply = await handlePolicyQuestion(c, params, loc);
      break;
    case 'open_ticket':
    case 'human_handoff':
      reply = handleHandoff(intent, loc);
      break;
  }
  return c.json({ success: true, reply });
});

// ================================================================== tickets

const TICKET_STATES = ['open', 'waiting_customer', 'waiting_staff', 'resolved'] as const;

interface TicketRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  subject: string;
  order_id: string | null;
  unit_id: string | null;
  priority: number;
  state: string;
  source: string;
  assigned_staff: string | null;
  created_at: string;
  updated_at: string;
  last_customer_msg_at: string | null;
  last_staff_msg_at: string | null;
  resolved_at: string | null;
  email?: string | null;
  username?: string | null;
  message_count?: number;
}

function ticketPublic(t: TicketRow, opts: { admin?: boolean } = {}) {
  return {
    id: t.id,
    subject: t.subject,
    order_id: t.order_id,
    unit_id: t.unit_id,
    priority: t.priority,
    state: t.state,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_customer_msg_at: t.last_customer_msg_at,
    last_staff_msg_at: t.last_staff_msg_at,
    resolved_at: t.resolved_at,
    message_count: typeof t.message_count === 'number' ? t.message_count : undefined,
    ...(opts.admin
      ? { user_id: t.user_id, email: t.email ?? null, username: t.username ?? null, assigned_staff: t.assigned_staff ?? null, source: t.source }
      : {}),
  };
}

function messagePublic(m: Record<string, unknown>) {
  // Customer-safe: staff identity stays internal; only the is_staff flag ships.
  return { id: m.id, body: m.body, is_staff: !!m.is_staff, created_at: m.created_at };
}

supportRoutes.get('/tickets', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM support_tickets t WHERE t.user_id = ? ORDER BY t.updated_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<TicketRow>();
  return c.json({ success: true, tickets: results.map((t) => ticketPublic(t)) });
});

/**
 * Ticket creation — the UI runs an explicit confirmation step and sends
 * confirm:true; anything else is refused so an accidental tap cannot file a
 * ticket. Order/device references are ownership-checked server-side.
 */
supportRoutes.post('/tickets', requireAuth, async (c) => {
  await rateLimit(c, 'support-ticket-create', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== true) throw badRequest('Explicit confirmation is required before creating a ticket', 'CONFIRM_REQUIRED');
  const subject = str(body.subject, 'subject', { min: 3, max: 200 });
  const message = str(body.body, 'body', { min: 5, max: 4000 });
  const orderId = str(body.order_id, 'order_id', { max: 40, required: false }).toUpperCase();
  const unitId = str(body.unit_id, 'unit_id', { max: 40, required: false });
  const source = body.source === 'manual' ? 'manual' : 'assistant';

  if (orderId) {
    const own = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first();
    if (!own) throw badRequest('That order was not found in your account', 'ORDER_NOT_FOUND');
  }
  if (unitId) {
    const own = await c.env.DB.prepare('SELECT id FROM order_item_units WHERE id = ? AND owner_user_id = ?').bind(unitId, user.id).first();
    if (!own) throw badRequest('That device was not found in your account', 'UNIT_NOT_FOUND');
  }

  // REAL PRO priority snapshot: eligible active PRO, unless an active
  // restriction case gates the priorityService benefit.
  const tier = await getTierStatus(c.env.DB, user.id);
  const priority = benefits.priorityService(tier) ? 1 : 0;

  const ticketId = newId('tkt');
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO support_tickets (id, user_id, subject, order_id, unit_id, priority, state, source, created_at, updated_at, last_customer_msg_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).bind(ticketId, user.id, subject, orderId || null, unitId || null, priority, source, now, now, now),
    c.env.DB.prepare('INSERT INTO support_ticket_messages (id, ticket_id, sender_id, is_staff, body) VALUES (?, ?, ?, 0, ?)').bind(
      newId('tkm'),
      ticketId,
      user.id,
      message
    ),
  ]);

  const ticket = (await c.env.DB.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(ticketId).first<TicketRow>())!;
  return c.json({ success: true, ticket: ticketPublic(ticket) });
});

supportRoutes.get('/tickets/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const ticket = await c.env.DB.prepare('SELECT * FROM support_tickets WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<TicketRow>();
  if (!ticket) throw notFound('Ticket not found');
  const { results: messages } = await c.env.DB.prepare(
    'SELECT id, body, is_staff, created_at FROM support_ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC LIMIT 500'
  )
    .bind(ticket.id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, ticket: ticketPublic(ticket), messages: messages.map(messagePublic) });
});

supportRoutes.post('/tickets/:id/messages', requireAuth, async (c) => {
  await rateLimit(c, 'support-ticket-msg', 30, 3600);
  const user = c.get('user')!;
  const ticket = await c.env.DB.prepare('SELECT * FROM support_tickets WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<TicketRow>();
  if (!ticket) throw notFound('Ticket not found');
  const body = await c.req.json().catch(() => ({}));
  const message = str(body.body, 'body', { min: 1, max: 4000 });
  const now = new Date().toISOString();
  // A customer reply on a resolved ticket honestly reopens it (waiting_staff).
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO support_ticket_messages (id, ticket_id, sender_id, is_staff, body) VALUES (?, ?, ?, 0, ?)').bind(
      newId('tkm'),
      ticket.id,
      user.id,
      message
    ),
    c.env.DB.prepare(
      "UPDATE support_tickets SET state = 'waiting_staff', updated_at = ?, last_customer_msg_at = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?"
    ).bind(now, now, ticket.id),
  ]);
  return c.json({ success: true });
});

// ============================================================ admin surface

supportRoutes.use('/admin/*', requireAdmin);

/**
 * Support queue with REAL priority ordering: priority DESC then created_at
 * ASC (oldest first). Age is part of the payload so the console shows it
 * prominently — no invisible starvation of ordinary customers.
 */
supportRoutes.get('/admin/tickets', async (c) => {
  const stateFilter = str(c.req.query('state'), 'state', { max: 20, required: false });
  let where = "t.state <> 'resolved'";
  const params: unknown[] = [];
  if (stateFilter && (TICKET_STATES as readonly string[]).includes(stateFilter)) {
    where = 't.state = ?';
    params.push(stateFilter);
  } else if (stateFilter === 'all') {
    where = '1=1';
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, u.email, u.username,
            (SELECT COUNT(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM support_tickets t JOIN users u ON u.id = t.user_id
      WHERE ${where}
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT 200`
  )
    .bind(...params)
    .all<TicketRow>();
  return c.json({ success: true, tickets: results.map((t) => ticketPublic(t, { admin: true })) });
});

supportRoutes.get('/admin/tickets/:id', async (c) => {
  const ticket = await c.env.DB.prepare(
    'SELECT t.*, u.email, u.username FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?'
  )
    .bind(c.req.param('id'))
    .first<TicketRow>();
  if (!ticket) throw notFound('Ticket not found');
  const { results: messages } = await c.env.DB.prepare(
    'SELECT id, body, is_staff, created_at FROM support_ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC LIMIT 500'
  )
    .bind(ticket.id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, ticket: ticketPublic(ticket, { admin: true }), messages: messages.map(messagePublic) });
});

supportRoutes.post('/admin/tickets/:id/messages', async (c) => {
  const admin = c.get('user')!;
  const ticket = await c.env.DB.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(c.req.param('id')).first<TicketRow>();
  if (!ticket) throw notFound('Ticket not found');
  const body = await c.req.json().catch(() => ({}));
  const message = str(body.body, 'body', { min: 1, max: 4000 });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO support_ticket_messages (id, ticket_id, sender_id, is_staff, body) VALUES (?, ?, ?, 1, ?)').bind(
      newId('tkm'),
      ticket.id,
      admin.id,
      message
    ),
    c.env.DB.prepare("UPDATE support_tickets SET state = 'waiting_customer', updated_at = ?, last_staff_msg_at = ? WHERE id = ?").bind(
      now,
      now,
      ticket.id
    ),
  ]);
  await audit(c.env.DB, admin.id, 'support.ticket.reply', ticket.id, { chars: message.length });
  return c.json({ success: true });
});

supportRoutes.patch('/admin/tickets/:id', async (c) => {
  const admin = c.get('user')!;
  const ticket = await c.env.DB.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(c.req.param('id')).first<TicketRow>();
  if (!ticket) throw notFound('Ticket not found');
  const body = await c.req.json().catch(() => ({}));
  const state = oneOf(body.state, 'state', TICKET_STATES);
  const now = new Date().toISOString();
  if (state === 'resolved') {
    await c.env.DB.prepare("UPDATE support_tickets SET state = 'resolved', updated_at = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
      .bind(now, now, admin.id, ticket.id)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE support_tickets SET state = ?, updated_at = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?')
      .bind(state, now, ticket.id)
      .run();
  }
  await audit(c.env.DB, admin.id, 'support.ticket.state', ticket.id, { from: ticket.state, to: state });
  return c.json({ success: true });
});

// --------------------------------------------------------- member console

/**
 * Member search/filter for the PRO-operations console. Returns ONLY the
 * fields the console shows — never password hashes, encrypted identity
 * fields, KYC evidence keys, or internal notes.
 */
supportRoutes.get('/admin/members', async (c) => {
  const q = str(c.req.query('q'), 'q', { max: 100, required: false });
  const tier = str(c.req.query('tier'), 'tier', { max: 10, required: false });
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  const kyc = str(c.req.query('kyc'), 'kyc', { max: 20, required: false });
  const restriction = str(c.req.query('restriction'), 'restriction', { max: 10, required: false });
  const expiryDays = int(c.req.query('expiry_days'), 'expiry_days', { min: 1, max: 365, def: 0 });

  const nowIso = new Date().toISOString();
  const inner = `
    SELECT u.id, u.email, u.username, u.name, u.created_at,
           m.tier AS m_tier, m.state AS m_state, m.expires_at AS m_expires,
           (SELECT k.state FROM kyc_cases k WHERE k.user_id = u.id ORDER BY k.created_at DESC LIMIT 1) AS kyc_state,
           (SELECT COUNT(*) FROM restriction_cases r WHERE r.user_id = u.id AND r.state = 'active') AS active_restrictions,
           (SELECT COUNT(*) FROM approved_addresses a WHERE a.user_id = u.id AND a.state = 'approved') AS approved_addresses
      FROM users u
      LEFT JOIN memberships m ON m.id = (
        SELECT mm.id FROM memberships mm WHERE mm.user_id = u.id
         ORDER BY CASE mm.state WHEN 'active' THEN 0 WHEN 'prepaid_pending_launch' THEN 1 ELSE 2 END,
                  CASE mm.tier WHEN 'pro' THEN 0 ELSE 1 END,
                  mm.created_at DESC
         LIMIT 1)`;

  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conds.push("(email LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (tier === 'pro' || tier === 'prime' || tier === 'plus') {
    conds.push('m_tier = ?');
    params.push(tier);
  } else if (tier === 'free') {
    conds.push('m_tier IS NULL');
  }
  if (status === 'active') {
    conds.push("m_state = 'active' AND (m_expires IS NULL OR m_expires >= ?)");
    params.push(nowIso);
  } else if (status === 'expired') {
    conds.push("(m_state = 'expired' OR (m_state = 'active' AND m_expires < ?))");
    params.push(nowIso);
  } else if (status === 'pending_launch') {
    conds.push("m_state = 'prepaid_pending_launch'");
  } else if (status === 'none') {
    conds.push('m_tier IS NULL');
  }
  if (kyc) {
    conds.push('kyc_state = ?');
    params.push(kyc);
  }
  if (restriction === 'active') conds.push('active_restrictions > 0');
  if (expiryDays > 0) {
    conds.push("m_state = 'active' AND m_expires >= ? AND m_expires <= ?");
    params.push(nowIso, new Date(Date.now() + expiryDays * 86_400_000).toISOString());
  }

  const sql = `SELECT * FROM (${inner}) WHERE ${conds.length ? conds.join(' AND ') : '1=1'} ORDER BY created_at DESC LIMIT 100`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return c.json({
    success: true,
    members: results.map((r) => ({
      id: r.id,
      email: r.email,
      username: r.username,
      name: r.name,
      created_at: r.created_at,
      tier: r.m_tier ?? 'free',
      membership_state:
        r.m_state === 'active' && typeof r.m_expires === 'string' && r.m_expires < nowIso ? 'expired' : (r.m_state ?? 'none'),
      expires_at: r.m_expires ?? null,
      kyc_state: r.kyc_state ?? null,
      active_restrictions: Number(r.active_restrictions) || 0,
      has_approved_address: (Number(r.approved_addresses) || 0) > 0,
    })),
  });
});

interface RestrictionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  kind: string;
  case_type: string;
  state: string;
  reason: string;
  evidence: string;
  benefit_flags: string;
  decision: string | null;
  decision_reason: string;
  opened_by: string;
  opened_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  note: string;
}

function restrictionPublic(r: RestrictionRow) {
  const evidence = safeParse<unknown[]>(r.evidence, []);
  return {
    id: r.id,
    case_type: r.case_type || r.kind,
    kind: r.kind,
    state: r.state,
    reason: r.reason,
    evidence: evidence.filter((e): e is string => typeof e === 'string'),
    benefit_flags: safeParse<unknown[]>(r.benefit_flags, []).filter((f): f is string => typeof f === 'string'),
    decision: r.decision ?? null,
    decision_reason: r.decision_reason ?? '',
    opened_by: r.opened_by,
    opened_at: r.opened_at,
    resolved_by: r.resolved_by ?? null,
    resolved_at: r.resolved_at ?? null,
  };
}

/**
 * Member detail: subscription payment/term, identity STATE (kyc_cases read —
 * no decrypted fields, no evidence keys), benefit-eligibility context, BNPL
 * debt and live BNPL eligibility, plus restriction cases.
 */
supportRoutes.get('/admin/members/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = c.env.DB;
  const user = await db
    .prepare('SELECT id, email, username, name, role, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!user) throw notFound('User not found');

  const tierStatus = await getTierStatus(db, userId);
  const [memberships, kycCases, addresses, restrictions, bnplAccount, bnplLedger, bnplSum, ticketCount] = await Promise.all([
    db
      .prepare(
        `SELECT id, plan_id, tier, state, duration_months, price_paid_iqd, purchased_at, starts_at, expires_at, source
           FROM memberships WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    // Identity STATUS only — never the encrypted identity fields or evidence keys.
    db
      .prepare(
        `SELECT id, case_type, doc_type, state, reason, submitted_at, decided_at, retention_until, created_at
           FROM kyc_cases WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, version, state, name, address, landmark, reason, requested_at, approved_at
           FROM approved_addresses WHERE user_id = ? ORDER BY version DESC LIMIT 20`
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM restriction_cases WHERE user_id = ? ORDER BY opened_at DESC LIMIT 50').bind(userId).all<RestrictionRow>(),
    db.prepare('SELECT state, credit_limit_iqd FROM bnpl_accounts WHERE user_id = ?').bind(userId).first<Record<string, unknown>>(),
    db
      .prepare('SELECT id, kind, amount_iqd, due_at, note, created_at FROM bnpl_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
      .bind(userId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE kind WHEN 'charge' THEN amount_iqd WHEN 'repayment' THEN -amount_iqd ELSE amount_iqd END), 0) AS outstanding
           FROM bnpl_ledger WHERE user_id = ?`
      )
      .bind(userId)
      .first<{ outstanding: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ?').bind(userId).first<{ n: number }>(),
  ]);

  const gatedFlags = new Set<string>();
  for (const r of restrictions.results) {
    if (r.state === 'active') {
      for (const f of safeParse<unknown[]>(r.benefit_flags, [])) if (typeof f === 'string') gatedFlags.add(f);
    }
  }
  const bnpl = await bnplEligibility(db, userId);

  return c.json({
    success: true,
    member: {
      user: { id: user.id, email: user.email, username: user.username, name: user.name, role: user.role, created_at: user.created_at },
      // 1) Subscription payment/term — separate from everything else.
      tier_status: tierStatus,
      memberships: memberships.results,
      // 2) Identity status — states only, evidence stays in the KYC reviewer flow.
      kyc_cases: kycCases.results,
      // 3) Benefit-eligibility context: independent of login/data access.
      benefit_context: {
        tier: tierStatus.tier,
        tier_active: tierStatus.active,
        gated_benefit_flags: [...gatedFlags],
        restrictable_benefits: RESTRICTABLE_BENEFITS,
        note: 'Address selection is a per-order eligibility condition, never a sanction; restrictions gate benefit computation only.',
      },
      approved_addresses: addresses.results,
      // 4) Debt — the ledger is immutable here; approval lives on the audited
      // memberships admin endpoint.
      debt: {
        bnpl_enabled: benefits.bnpl(tierStatus),
        eligible: bnpl.eligible,
        eligibility_reason: bnpl.reason,
        available_iqd: bnpl.available_iqd,
        account_state: bnplAccount?.state ?? 'none',
        credit_limit_iqd: Number(bnplAccount?.credit_limit_iqd) || 0,
        outstanding_iqd: Number(bnplSum?.outstanding) || 0,
        ledger: bnplLedger.results,
      },
      // 5) Restriction cases.
      restriction_cases: restrictions.results.map(restrictionPublic),
      support_ticket_count: Number(ticketCount?.n) || 0,
    },
  });
});

/**
 * Open a restriction case. Cases gate SPECIFIC benefit flags — never orders,
 * wallet, points, warranty or support access (that separation is structural:
 * nothing here touches those tables). Audited.
 */
supportRoutes.post('/admin/members/:userId/restrictions', async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('userId');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');

  const body = await c.req.json().catch(() => ({}));
  const caseType = oneOf(body.case_type, 'case_type', RESTRICTION_CASE_TYPES);
  const evidence = str(body.evidence, 'evidence', { min: 5, max: 4000 });
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
  const decision = oneOf(body.decision, 'decision', ['pause', 'revoke'] as const);
  const rawFlags = Array.isArray(body.benefit_flags) ? body.benefit_flags : [];
  const flags = rawFlags.filter((f: unknown): f is string => typeof f === 'string' && (RESTRICTABLE_BENEFITS as readonly string[]).includes(f));
  if (flags.length === 0) throw badRequest('Select at least one benefit flag to gate', 'FLAGS_REQUIRED');

  const id = newId('rst');
  await c.env.DB.prepare(
    `INSERT INTO restriction_cases (id, user_id, kind, case_type, state, reason, evidence, benefit_flags, decision, opened_by)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, CASE_TYPE_TO_KIND[caseType], caseType, reason, JSON.stringify([evidence]), JSON.stringify(flags), decision, admin.id)
    .run();
  await audit(c.env.DB, admin.id, 'restriction.open', id, { user_id: userId, case_type: caseType, decision, flags, reason });

  const row = (await c.env.DB.prepare('SELECT * FROM restriction_cases WHERE id = ?').bind(id).first<RestrictionRow>())!;
  return c.json({ success: true, case: restrictionPublic(row) });
});

/**
 * Decide on an existing case: resume (resolve — benefits return), or update
 * the gated flags/decision while active. Audited with reason.
 */
supportRoutes.patch('/admin/restrictions/:id', async (c) => {
  const admin = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT * FROM restriction_cases WHERE id = ?').bind(c.req.param('id')).first<RestrictionRow>();
  if (!row) throw notFound('Restriction case not found');
  const body = await c.req.json().catch(() => ({}));
  const action = oneOf(body.action, 'action', ['resume', 'update'] as const);
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });

  if (action === 'resume') {
    if (row.state !== 'active') throw badRequest('This case is already resolved', 'ALREADY_RESOLVED');
    await c.env.DB.prepare(
      "UPDATE restriction_cases SET state = 'resolved', resolved_by = ?, resolved_at = ?, decision_reason = ? WHERE id = ? AND state = 'active'"
    )
      .bind(admin.id, new Date().toISOString(), reason, row.id)
      .run();
    await audit(c.env.DB, admin.id, 'restriction.resume', row.id, { user_id: row.user_id, reason });
  } else {
    if (row.state !== 'active') throw badRequest('Only active cases can be updated', 'NOT_ACTIVE');
    const decision = body.decision === undefined ? row.decision : oneOf(body.decision, 'decision', ['pause', 'revoke'] as const);
    let flagsJson = row.benefit_flags;
    if (body.benefit_flags !== undefined) {
      const rawFlags = Array.isArray(body.benefit_flags) ? body.benefit_flags : [];
      const flags = rawFlags.filter((f: unknown): f is string => typeof f === 'string' && (RESTRICTABLE_BENEFITS as readonly string[]).includes(f));
      if (flags.length === 0) throw badRequest('Select at least one benefit flag to gate', 'FLAGS_REQUIRED');
      flagsJson = JSON.stringify(flags);
    }
    await c.env.DB.prepare('UPDATE restriction_cases SET decision = ?, benefit_flags = ?, decision_reason = ? WHERE id = ?')
      .bind(decision, flagsJson, reason, row.id)
      .run();
    await audit(c.env.DB, admin.id, 'restriction.update', row.id, { user_id: row.user_id, decision, reason });
  }

  const updated = (await c.env.DB.prepare('SELECT * FROM restriction_cases WHERE id = ?').bind(row.id).first<RestrictionRow>())!;
  return c.json({ success: true, case: restrictionPublic(updated) });
});
