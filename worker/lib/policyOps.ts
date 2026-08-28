import type { Env } from './types';
import { badRequest } from './http';
import { newId, sha256Hex } from './crypto';

/**
 * Versioned policy documents + acceptance recording (tables in migration
 * 0003: policy_documents, policy_acceptances).
 *
 * Contract consumed by checkout (worker/routes/orders.ts): a policy key
 * gates checkout only once a PUBLISHED version of it exists — drafts never
 * block orders, so consent enforcement turns on exactly when the owner
 * publishes the documents.
 */

export interface PolicyRef {
  key: string;
  version: number;
}

/** Policy keys whose acceptance is required to place an order. */
export const CHECKOUT_POLICY_KEYS = ['terms', 'privacy'] as const;

/** All policy document keys the store publishes (final-phase brief §7). */
export const POLICY_KEYS = [
  'terms', // terms of sale
  'site_terms', // website-use terms (kept separate from sale terms)
  'privacy',
  'warranty', // warranty + extensions
  'returns', // returns and replacement
  'delivery', // delivery and fees
  'price_protection',
  'payment', // payment methods + BNPL
  'membership', // membership restrictions
  'rewards', // points / reviews / gifts / referrals
  'support', // support and contact
] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

export const POLICY_LANGS = ['ar', 'en', 'ckb'] as const;
export type PolicyLang = (typeof POLICY_LANGS)[number];

/**
 * Content hash stored on the document row and copied into acceptance
 * records. Binds key+version+lang+title+body so any post-publication edit
 * would be detectable (published rows are additionally refused edits).
 */
export function policyDocHash(
  key: string,
  version: number,
  lang: string,
  title: string,
  body: string
): Promise<string> {
  return sha256Hex(`policy:${key}:v${version}:${lang}:${title}\n${body}`);
}

export async function getRequiredCheckoutPolicies(env: Env): Promise<PolicyRef[]> {
  const rows = await env.DB.prepare(
    `SELECT key, MAX(version) AS version FROM policy_documents
     WHERE status = 'published' AND key IN ('terms','privacy')
     GROUP BY key`
  ).all<{ key: string; version: number }>();
  return (rows.results || []).map((r) => ({ key: r.key, version: Number(r.version) }));
}

/**
 * Verify that the client-supplied acceptance list covers every required
 * checkout policy at its current published version, then persist the
 * acceptance rows (idempotent via the table's UNIQUE constraint).
 * Throws 400 POLICY_ACCEPTANCE_REQUIRED when anything is missing/stale.
 */
export async function verifyAndRecordAcceptance(
  env: Env,
  userId: string,
  context: string,
  accepted: Array<{ key: string; version: number }> | undefined
): Promise<PolicyRef[]> {
  const required = await getRequiredCheckoutPolicies(env);
  if (required.length === 0) return [];
  const list = Array.isArray(accepted) ? accepted : [];
  const missing = required.filter(
    (r) => !list.some((a) => a && a.key === r.key && Number(a.version) === r.version)
  );
  if (missing.length > 0) {
    throw badRequest(
      'Please review and accept the current policies',
      'POLICY_ACCEPTANCE_REQUIRED'
    );
  }
  const now = new Date().toISOString();
  for (const r of required) {
    const doc = await env.DB.prepare(
      `SELECT hash FROM policy_documents WHERE key = ? AND version = ? AND status = 'published'
       ORDER BY CASE lang WHEN 'ar' THEN 0 ELSE 1 END LIMIT 1`
    )
      .bind(r.key, r.version)
      .first<{ hash: string }>();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO policy_acceptances (id, user_id, policy_key, version, hash, context, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('pac'), userId, r.key, r.version, doc?.hash || '', context, now)
      .run();
  }
  return required;
}

// ---------------------------------------------------------------------------
// ORIGINAL LEVONIS policy drafts (final-phase brief §7).
//
// These are ORIGINAL drafts written from what this codebase actually
// implements and from docs/DECISIONS.md — NOT copied from Bambu Lab or any
// other company, and NOT a claim of legal compliance. Every commercially
// unresolved value is stated as "subject to announcement". Each body carries
// an explicit draft banner; the seeding endpoint inserts them with
// status='draft' and nothing here publishes them — publication is a separate
// explicit, audited owner action.
// ---------------------------------------------------------------------------

const DRAFT_AR =
  '⚠️ مسودة أولية — بانتظار مراجعة المالك والمراجعة القانونية المحلية المختصة. هذه الوثيقة غير منشورة وغير ملزمة بعد، وقد تتغير قبل النشر.';
const DRAFT_EN =
  '⚠️ Initial draft — pending owner review and qualified local legal review. This document is not published and not yet binding; it may change before publication.';
const DRAFT_CKB =
  '⚠️ ڕەشنووسی سەرەتایی — چاوەڕوانی پێداچوونەوەی خاوەن و پێداچوونەوەی یاسایی شارەزایە. ئەم بەڵگەنامەیە بڵاونەکراوەتەوە و هێشتا پابەندکەر نییە و لەوانەیە پێش بڵاوکردنەوە بگۆڕدرێت.';

export interface PolicyDraft {
  key: PolicyKey;
  title: { ar: string; en: string; ckb: string };
  body: { ar: string; en: string; ckb: string };
}

export const POLICY_DRAFTS: PolicyDraft[] = [
  // ------------------------------------------------------------ warranty
  {
    key: 'warranty',
    title: {
      ar: 'سياسة الضمان والتمديدات',
      en: 'Warranty & Extensions Policy',
      ckb: 'سیاسەتی گەرەنتی و درێژکردنەوەکان',
    },
    body: {
      ar: `${DRAFT_AR}

## نطاق الضمان
- الضمان لدى LEVONIS ضمان لكل جهاز فعلي مُرقَّم (رقم تسلسلي)، وليس للطلب ككل. طلب يحتوي عدة أجهزة مؤهلة يحصل على سجل ضمان مستقل لكل جهاز.
- الطابعات ثلاثية الأبعاد المؤهلة: 12 شهرًا ميلاديًا من تاريخ التسليم الفعلي الموثَّق للجهاز إلى الزبون.
- مدة ضمان الأجهزة المؤهلة الأخرى (مثل وحدات AMS) تُعلَن لاحقًا لكل منتج على صفحته؛ لا نفترض مدة غير معلنة.

## بدء العد وتسجيل الجهاز
- يبدأ عد الضمان من وقت التسليم الموثَّق لكل جهاز، حتى لو سجّل الزبون الرقم التسلسلي في حسابه لاحقًا. التسجيل يفعّل ميزات الحساب فقط ولا يمدد الضمان ولا يعيد بدء العد.
- في التسليم الجزئي يبدأ ضمان كل جهاز من تاريخ تسليمه هو.

## التمديدات المدفوعة
- يمكن شراء تمديد +12 أو +24 شهرًا عند إتمام الطلب فقط (قبل الشراء)، ولا يتوفر تمديد اعتيادي بعد الشراء. رسوم التمديد تظهر لكل منتج قبل إتمام الطلب، وتُعلَن قيمها من الإدارة.

## ما يغطيه الضمان وما لا يغطيه
- يغطي عيوب التصنيع وفق هذه السياسة. الأضرار الناتجة عن سوء الاستخدام أو التعديل غير المصرّح ليست مشمولة تلقائيًا؛ قد تتوفر خصومات صيانة لأعضاء PRO تُعلَن لاحقًا.
- عند الاستبدال المعتمد يُربط الجهاز البديل بسجل الجهاز الأصلي؛ قاعدة الضمان بعد الاستبدال (المتبقي أم الجديد) تُعلَن لاحقًا.

## المطالبات
- تُقدَّم مطالبات الضمان من حساب الزبون (قسم الضمان) مع وصف وصور/فيديو، وتُراجع من موظف مخوَّل، ويظهر القرار وسببه في الحساب.
- هذا ضمان يقدمه المتجر LEVONIS؛ وهو منفصل عن أي ضمان من الشركة المصنّعة، ولا ندّعي صفة وكيل معتمد ما لم تُعلن رسميًا.`,
      en: `${DRAFT_EN}

## Scope
- LEVONIS warranty is per physical serialized device, not per order. An order containing several eligible devices gets an independent warranty record per device.
- Eligible 3D printers: 12 calendar months from the documented actual delivery time of the device to the customer.
- Warranty duration for other eligible devices (such as AMS units) is subject to announcement per product on its page; we do not assume an unannounced duration.

## Clock start and device registration
- The warranty clock starts at each device's documented delivery time, even if the customer registers the serial number in their account weeks later. Registration only activates account features — it never extends or restarts coverage.
- For partial shipments each device's warranty starts from its own delivery date.

## Paid extensions
- A +12 or +24 month extension can be purchased at checkout only (before completing the order). No ordinary post-purchase extension is offered. Extension fees are shown per product before checkout and are announced by the administration.

## What is and is not covered
- Manufacturing defects are covered under this policy. Damage from misuse or unauthorized modification is not automatically covered; PRO maintenance discounts may apply and are subject to announcement.
- On an approved replacement, the replacement device is linked to the original device record; the post-replacement coverage rule (remaining vs. new) is subject to announcement.

## Claims
- Warranty claims are opened from the customer account (Warranty section) with a description and photos/video, are reviewed by authorized staff, and the decision with its reason appears in the account.
- This is store coverage provided by LEVONIS; it is separate from any manufacturer coverage, and we claim no authorized-reseller status unless officially announced.`,
      ckb: `${DRAFT_CKB}

## چوارچێوەی گەرەنتی
- گەرەنتی LEVONIS بۆ هەر ئامێرێکی فیزیکی ژمارەدارە (ژمارەی زنجیرەیی)، نەک بۆ هەموو داواکارییەکە. داواکارییەک کە چەند ئامێرێکی شیاوی تێدابێت، بۆ هەر ئامێرێک تۆماری گەرەنتی سەربەخۆی هەیە.
- پرینتەرە سێ ڕەهەندییە شیاوەکان: ١٢ مانگی ساڵنامەیی لە کاتی گەیاندنی ڕاستەقینەی تۆمارکراوی ئامێرەکە بۆ کڕیار.
- ماوەی گەرەنتی ئامێرە شیاوەکانی تر (وەک یەکەکانی AMS) دواتر بۆ هەر بەرهەمێک لە پەڕەکەیدا ڕادەگەیەنرێت؛ ماوەی ڕانەگەیەنراو دانانرێت.

## دەستپێکی ژماردن و تۆمارکردنی ئامێر
- ژماردنی گەرەنتی لە کاتی گەیاندنی تۆمارکراوی هەر ئامێرێکەوە دەست پێدەکات، تەنانەت ئەگەر کڕیار ژمارە زنجیرەییەکە دواتر لە هەژمارەکەیدا تۆمار بکات. تۆمارکردن تەنها تایبەتمەندییەکانی هەژمار چالاک دەکات و گەرەنتی درێژ ناکاتەوە و ژماردن دەست پێ ناکاتەوە.
- لە گەیاندنی بەشەکیدا گەرەنتی هەر ئامێرێک لە ڕێکەوتی گەیاندنی خۆیەوە دەست پێدەکات.

## درێژکردنەوە بە پارە
- درێژکردنەوەی +١٢ یان +٢٤ مانگ تەنها لە کاتی تەواوکردنی داواکاریدا دەکڕدرێت (پێش کڕین). درێژکردنەوەی ئاسایی دوای کڕین نییە. نرخی درێژکردنەوەکان بۆ هەر بەرهەمێک پێش تەواوکردنی داواکاری پیشان دەدرێت و لەلایەن بەڕێوەبەرایەتییەوە ڕادەگەیەنرێت.

## چی دەگرێتەوە و چی ناگرێتەوە
- کەموکوڕی دروستکردن بەپێی ئەم سیاسەتە دەگیرێتەوە. زیانی بەکارهێنانی هەڵە یان دەستکاری بێ مۆڵەت بە شێوەی خۆکار ناگیرێتەوە؛ لەوانەیە داشکاندنی چاککردنەوە بۆ ئەندامانی PRO هەبێت کە دواتر ڕادەگەیەنرێت.
- لە گۆڕینەوەی پەسەندکراودا ئامێرە نوێیەکە بە تۆماری ئامێرە ڕەسەنەکەوە دەبەسترێتەوە؛ یاسای گەرەنتی دوای گۆڕینەوە دواتر ڕادەگەیەنرێت.

## داواکارییەکانی گەرەنتی
- داواکاری گەرەنتی لە هەژماری کڕیارەوە (بەشی گەرەنتی) لەگەڵ وەسف و وێنە/ڤیدیۆ پێشکەش دەکرێت، لەلایەن کارمەندی مۆڵەتدارەوە پێداچوونەوەی بۆ دەکرێت و بڕیارەکە لەگەڵ هۆکارەکەی لە هەژماردا دەردەکەوێت.
- ئەمە گەرەنتی فرۆشگای LEVONIS ـە؛ جیاوازە لە هەر گەرەنتییەکی کۆمپانیای دروستکەر، و داوای پلەی فرۆشیاری ڕەسمی ناکەین هەتا بە فەرمی ڕانەگەیەنرێت.`,
    },
  },
  // ------------------------------------------------------------- returns
  {
    key: 'returns',
    title: {
      ar: 'سياسة الإرجاع والاستبدال',
      en: 'Returns & Replacement Policy',
      ckb: 'سیاسەتی گەڕاندنەوە و گۆڕینەوە',
    },
    body: {
      ar: `${DRAFT_AR}

## نافذة الإرجاع
- يمكن تقديم طلب إرجاع خلال 7 أيام من التسليم الفعلي للقطعة المتأثرة (وليس من وقت الطلب أو الشحن)، للأسباب الآتية: منتج معيب، عيب تصنيع، مخالف للوصف، منتج خاطئ، أو ضرر أثناء الشحن.
- الطلب المقدَّم ضمن المدة يبقى ضمن المدة حتى لو تأخرت معالجة الإدارة بعد اليوم السابع.

## مسار الطلب
- المسار: طلب إرجاع ← تقييم ← موافقة/رفض ← استلام القطعة ← فحص ← استبدال/استرجاع/حل نهائي. تظهر الحالة وأسباب القرار في حساب الزبون مع إمكانية التواصل مع الدعم.
- تُرفق الأدلة (صور/فيديو) بشكل خاص ولا تُعرض علنًا.

## التعويض
- القطع المتضررة بعيب تصنيع تُستبدل مجانًا وفق شروط الضمان المعتمدة. سوء الاستخدام غير مشمول بالاستبدال المجاني.
- وجهة استرجاع المبلغ (محفظة/طريقة أخرى) وقواعد استرجاع رسوم الشحن تُعلَن لاحقًا من الإدارة قبل تفعيل الصرف الآلي.
- تُعالَج النقاط والإحالات والرسوم المرتبطة بالطلب عند الإرجاع بدون تعويض مزدوج.

## حقوقك القانونية
- هذه سياسة متجر طوعية ولا تنتقص من أي حقوق نظامية ملزمة للمستهلك في العراق.`,
      en: `${DRAFT_EN}

## Return window
- A return request can be submitted within 7 days of actual delivery of the affected item (not from checkout or dispatch time), for these reasons: defective item, manufacturing fault, not as described, wrong item, or shipping damage.
- A request submitted within the window stays timely even if administration processes it after day seven.

## Process
- The flow is: return requested → assessment → approved/rejected → item received → inspection → replacement/refund/resolved. Status and decision reasons appear in the customer account, with a support route.
- Evidence (photos/video) is submitted privately and never shown publicly.

## Compensation
- Parts damaged by manufacturing defects are replaced free of charge under the approved warranty terms. Misuse is excluded from free replacement.
- The refund destination (wallet/other) and shipping-fee refund rules are subject to announcement by the administration before automatic payout is enabled.
- Points, referrals and order fees are reconciled on return without double compensation.

## Your statutory rights
- This is a voluntary store policy and does not waive any mandatory consumer rights under applicable law in Iraq.`,
      ckb: `${DRAFT_CKB}

## ماوەی گەڕاندنەوە
- داواکاری گەڕاندنەوە دەتوانرێت لە ماوەی ٧ ڕۆژ لە گەیاندنی ڕاستەقینەی کاڵا کاریگەرەکەوە پێشکەش بکرێت (نەک لە کاتی داواکاری یان ناردن)، بۆ ئەم هۆکارانە: کاڵای خراپ، کەموکوڕی دروستکردن، جیاواز لە وەسفەکە، کاڵای هەڵە، یان زیانی گەیاندن.
- داواکارییەک کە لە ماوەکەدا پێشکەش کرابێت، لە ماوەکەدا دەمێنێتەوە تەنانەت ئەگەر بەڕێوەبەرایەتی دوای ڕۆژی حەوتەم مامەڵەی لەگەڵ بکات.

## ڕێڕەوی داواکاری
- ڕێڕەوەکە: داواکاری گەڕاندنەوە ← هەڵسەنگاندن ← پەسەندکردن/ڕەتکردنەوە ← وەرگرتنی کاڵا ← پشکنین ← گۆڕینەوە/گەڕاندنەوەی پارە/چارەسەر. دۆخ و هۆکاری بڕیارەکان لە هەژماری کڕیاردا دەردەکەون لەگەڵ ڕێگای پەیوەندی بە پشتگیری.
- بەڵگەکان (وێنە/ڤیدیۆ) بە شێوەی تایبەت پێشکەش دەکرێن و هەرگیز بە ئاشکرا پیشان نادرێن.

## قەرەبوو
- پارچەکانی زیانلێکەوتوو بە کەموکوڕی دروستکردن بەخۆڕایی دەگۆڕدرێنەوە بەپێی مەرجەکانی گەرەنتی پەسەندکراو. بەکارهێنانی هەڵە لە گۆڕینەوەی بەخۆڕایی ناگیرێتەوە.
- شوێنی گەڕاندنەوەی پارە (جزدان/ڕێگای تر) و یاساکانی گەڕاندنەوەی کرێی گەیاندن دواتر لەلایەن بەڕێوەبەرایەتییەوە ڕادەگەیەنرێن.
- خاڵەکان و ڕەوانەکردنەکان و کرێیەکانی داواکاری لە کاتی گەڕاندنەوەدا بێ قەرەبووی دووجار ڕێک دەخرێنەوە.

## مافە یاساییەکانت
- ئەمە سیاسەتێکی خۆویستی فرۆشگایە و هیچ مافێکی یاسایی پابەندکەری بەکاربەر لە عێراقدا ناسڕێتەوە.`,
    },
  },
  // ------------------------------------------------------------ delivery
  {
    key: 'delivery',
    title: {
      ar: 'سياسة التوصيل والرسوم',
      en: 'Delivery & Fees Policy',
      ckb: 'سیاسەتی گەیاندن و کرێیەکان',
    },
    body: {
      ar: `${DRAFT_AR}

## رسوم التوصيل
- المنتجات العادية: 5,000 دينار عراقي إلى جميع محافظات العراق.
- الطابعات: 25,000 أو 50,000 دينار حسب حجم الطابعة وموقع التسليم؛ خريطة الأحجام والمواقع الدقيقة تُعلَن من الإدارة، وحتى إعلانها تظهر واجهة صادقة "بحاجة إعداد" بدل رسم مُختلق.
- رسوم توصيل الطابعات تُدفع مقدمًا وفق حالة دفع موثَّقة.
- طلب يحتوي أكثر من 10 بكرات فلامنت قد يتطلب رسم كرتونة إضافية؛ المبلغ والحد يُعلَنان من الإدارة مع عرض واضح قبل إتمام الطلب.

## توصيل PRO المجاني
- إعفاء التوصيل لأعضاء PRO حصرًا يتطلب معًا: عضوية PRO فعّالة مؤهلة، واختيار العنوان الافتراضي الوحيد المعتمد، وقيمة طلب مؤهلة أكبر تمامًا من 75,000 دينار (75,000 بالضبط لا تؤهل).
- اختيار عنوان آخر يجعل الطلب بتسعيرة التوصيل العادية لذلك الطلب فقط، ويعود الإعفاء تلقائيًا عند العودة للعنوان المعتمد.

## مواعيد التسليم
- تقدير توصيل الطابعات: 12–48 ساعة حيث تتوفر الخدمة الفعلية.
- أولوية PRO: تحضير وتوصيل بأولوية خلال 12 ساعة حيث ومتى تتوفر الخدمة؛ الطلبات المسبقة تعرض تاريخ وصول واقعيًا ولا يشملها وعد الـ12 ساعة.
- عرض السعر النهائي في الصفحة الأخيرة قبل التأكيد هو المرجع، ويُبيَّن فيه سبب كل رسم أو إعفاء.`,
      en: `${DRAFT_EN}

## Delivery fees
- Ordinary products: 5,000 IQD to all Iraqi governorates.
- Printers: 25,000 or 50,000 IQD depending on printer size and delivery location; the exact size/location mapping is subject to announcement by the administration — until then the store honestly shows "needs configuration" instead of an invented fee.
- Printer delivery fees are paid in advance with a verified payment state.
- An order with more than 10 filament spools may require an extra carton charge; the amount and threshold are subject to announcement, with a clear quote before checkout.

## PRO free delivery
- The PRO-only delivery waiver requires all of: an eligible active PRO membership, selecting the single approved default address, and a qualifying order value strictly greater than 75,000 IQD (exactly 75,000 does not qualify).
- Selecting another address prices that order with ordinary delivery for that order only; the waiver returns automatically when the approved default address is selected again.

## Delivery estimates
- Printer delivery estimate: 12–48 hours where the actual service is available.
- PRO priority: priority preparation and delivery within 12 hours where and when the service is available; preorders show a realistic arrival date and are not covered by the 12-hour promise.
- The final quote on the last page before confirmation is authoritative and explains why each fee or waiver applies.`,
      ckb: `${DRAFT_CKB}

## کرێیەکانی گەیاندن
- کاڵا ئاساییەکان: ٥,٠٠٠ دیناری عێراقی بۆ هەموو پارێزگاکانی عێراق.
- پرینتەرەکان: ٢٥,٠٠٠ یان ٥٠,٠٠٠ دینار بەپێی قەبارەی پرینتەر و شوێنی گەیاندن؛ نەخشەی ورد دواتر لەلایەن بەڕێوەبەرایەتییەوە ڕادەگەیەنرێت — تا ئەو کاتە فرۆشگاکە بە ڕاستگۆیی "پێویستی بە ڕێکخستن هەیە" پیشان دەدات نەک کرێیەکی داهێنراو.
- کرێی گەیاندنی پرینتەر پێشوەخت دەدرێت بە دۆخی پارەدانی پشتڕاستکراو.
- داواکارییەک کە زیاتر لە ١٠ بۆبینی فلامێنتی تێدابێت لەوانەیە کرێی کارتۆنی زیادە بخوازێت؛ بڕەکە و سنوورەکە دواتر ڕادەگەیەنرێن و پێش تەواوکردنی داواکاری بە ڕوونی پیشان دەدرێن.

## گەیاندنی بەخۆڕایی PRO
- لێبووردنی کرێی گەیاندن تەنها بۆ PRO پێویستی بەمانە پێکەوەیە: ئەندامێتی PRO ی چالاکی شیاو، هەڵبژاردنی تاکە ناونیشانی بنەڕەتی پەسەندکراو، و بەهای داواکاری شیاو کە بە تەواوی گەورەتر بێت لە ٧٥,٠٠٠ دینار (٧٥,٠٠٠ بە تەواوی شیاو نییە).
- هەڵبژاردنی ناونیشانێکی تر ئەو داواکارییە بە نرخی گەیاندنی ئاسایی دەکات تەنها بۆ ئەو داواکارییە؛ لێبووردنەکە بە شێوەی خۆکار دەگەڕێتەوە کاتێک ناونیشانە پەسەندکراوەکە دووبارە هەڵدەبژێردرێت.

## کاتی گەیاندن
- خەمڵاندنی گەیاندنی پرینتەر: ١٢–٤٨ کاتژمێر لەو شوێنانەی خزمەتگوزارییە ڕاستەقینەکە بەردەستە.
- ئەولەویەتی PRO: ئامادەکردن و گەیاندن بە ئەولەویەت لە ماوەی ١٢ کاتژمێردا لەو شوێن و کاتانەی خزمەتگوزارییەکە بەردەستە؛ داواکارییە پێشوەختەکان ڕێکەوتی گەیشتنی واقیعی پیشان دەدەن و بەڵێنی ١٢ کاتژمێرییان ناگرێتەوە.
- نرخە کۆتاییەکە لە دوا پەڕەی پێش پشتڕاستکردنەوە بنچینەیە و هۆکاری هەر کرێیەک یان لێبووردنێک ڕوون دەکاتەوە.`,
    },
  },
  // ---------------------------------------------------- price protection
  {
    key: 'price_protection',
    title: {
      ar: 'سياسة حماية السعر (7 أيام)',
      en: 'Seven-Day Price Protection Policy',
      ckb: 'سیاسەتی پاراستنی نرخ (٧ ڕۆژ)',
    },
    body: {
      ar: `${DRAFT_AR}

## المبدأ
- إذا انخفض سعر المنتج نفسه (بنفس الخيار/اللون) خلال 7 أيام بعد تسليم طلبك، يمكنك تقديم مطالبة حماية سعر مرتبطة بالبند المُسلَّم وسعره الأصلي الصافي.
- يعتمد الاحتساب على سجل أسعار محفوظ لدى المتجر، لا على السعر الحالي وحده؛ الانخفاض الذي حدث داخل النافذة يبقى قابلًا للفحص لاحقًا.

## الحدود
- إجمالي التعويض لا يتجاوز فرق السعر التراكمي المؤهل، ولا يُصرف مرتين عبر انخفاضات أو مطالبات متكررة، ويُنسَّق مع الإرجاع/الاسترجاع لمنع التعويض الزائد.
- الأسعار المؤهلة للمقارنة (عروض العضويات، الكوبونات، العروض العامة) وقناة صرف التعويض (محفظة أم نقاط) تُعلَن لاحقًا من الإدارة قبل تفعيل الصرف الآلي.

## تغيّر الأسعار
- قد تتغير الأسعار مع سعر الصرف والشحن والضرائب/الجمارك وأسعار المورّدين؛ الطلب المقبول يحتفظ بسعره وقت إتمام الطلب، والتغيرات اللاحقة لا تعيد كتابة مشترياتك أو رسوم ضمانك.`,
      en: `${DRAFT_EN}

## Principle
- If the price of the same product (same option/color) drops within 7 days after your order is delivered, you may file a price-protection claim tied to the delivered item and its original net price.
- The calculation relies on the store's persisted price history, not the current price alone; a drop that occurred inside the window remains inspectable later.

## Limits
- Total compensation cannot exceed the eligible cumulative price difference, cannot be paid twice through repeated drops/claims, and is coordinated with returns/refunds to prevent overcompensation.
- Which prices qualify for comparison (membership offers, coupons, public promotions) and the compensation channel (wallet or points) are subject to announcement by the administration before automatic payout is enabled.

## Price changes
- Prices may change with exchange rates, shipping, taxes/customs and supplier prices; an accepted order keeps its checkout price, and later changes never rewrite your purchases or warranty fees.`,
      ckb: `${DRAFT_CKB}

## بنەما
- ئەگەر نرخی هەمان بەرهەم (هەمان هەڵبژاردە/ڕەنگ) لە ماوەی ٧ ڕۆژ دوای گەیاندنی داواکارییەکەت دابەزی، دەتوانیت داواکاری پاراستنی نرخ پێشکەش بکەیت کە بە کاڵا گەیەنراوەکە و نرخە ڕەسەنە پاکەکەیەوە بەستراوە.
- ژماردنەکە پشت بە مێژووی نرخی پاراستراوی فرۆشگا دەبەستێت، نەک تەنها نرخی ئێستا؛ دابەزینێک کە لەناو ماوەکەدا ڕوویدابێت دواتریش پشکنینی بۆ دەکرێت.

## سنوورەکان
- کۆی قەرەبوو لە جیاوازی نرخی کۆکراوەی شیاو تێناپەڕێت، دووجار نادرێت بە دابەزین/داواکاری دووبارە، و لەگەڵ گەڕاندنەوە/گەڕاندنەوەی پارە ڕێک دەخرێت بۆ ڕێگری لە قەرەبووی زیادە.
- کام نرخ شیاوە بۆ بەراوردکردن (ئۆفەری ئەندامێتی، کۆبۆن، ئۆفەری گشتی) و کەناڵی قەرەبوو (جزدان یان خاڵ) دواتر لەلایەن بەڕێوەبەرایەتییەوە ڕادەگەیەنرێن.

## گۆڕانی نرخەکان
- لەوانەیە نرخەکان بگۆڕدرێن لەگەڵ نرخی دراو و گەیاندن و باج/گومرگ و نرخی دابینکەران؛ داواکاری پەسەندکراو نرخی کاتی تەواوکردنی خۆی دەپارێزێت، و گۆڕانکارییەکانی دواتر هەرگیز کڕینەکانت یان کرێی گەرەنتیت ناگۆڕنەوە.`,
    },
  },
  // -------------------------------------------------------------- payment
  {
    key: 'payment',
    title: {
      ar: 'سياسة الدفع والشراء الآن والدفع لاحقًا (BNPL)',
      en: 'Payment & Buy-Now-Pay-Later (BNPL) Policy',
      ckb: 'سیاسەتی پارەدان و کڕین ئێستا و پارەدان دواتر (BNPL)',
    },
    body: {
      ar: `${DRAFT_AR}

## طرق الدفع
- الأسعار بالدينار العراقي (مبالغ صحيحة)؛ العرض بالدولار حسابي فقط وفق سعر صرف معلن.
- الطرق المتاحة: محفظة ليفو، الدفع عند الاستلام، الدفع المقدم الكامل أو الجزئي حسب المنتج. رسوم توصيل الطابعات تُدفع مقدمًا.
- الفاتورة تعرض حالة الدفع بصدق: الدفع عند الاستلام أو BNPL لا يوصفان أبدًا بأنهما "مدفوع بالكامل".

## الشراء الآن والدفع لاحقًا (BNPL)
- خدمة لأعضاء PRO فقط، وبشرط استيفاء متطلبات التحقق من الهوية والهاتف والعنوان المعتمد.
- الحد الأقصى للانكشاف الائتماني الفعّال: 200,000 دينار إجمالًا عبر كل الطلبات والحجوزات المتزامنة، وليس لكل طلب على حدة.
- مدة السداد: لا تتجاوز 7 أيام. حدث بدء العد وما إذا كان الانكشاف يشمل الرسوم يُعلَنان من الإدارة قبل التفعيل؛ الخدمة معطّلة حاليًا حتى اكتمال هذه القواعد. لا فوائد ولا غرامات مُخترعة ولا ادعاء تصنيف ائتماني.
- بعد تجاوز مهلة السداد مع دين غير مسدد تُقيَّد المشتريات الجديدة والمزايا القابلة للتقييد مؤقتًا حتى التسوية، مع بقاء تسجيل الدخول والسداد والدعم والفواتير والضمان متاحة دائمًا. تسوية الدين ترفع قيد الدين فقط ولا تعيد عضوية منتهية أو توقف قيدًا مستقلًا آخر.
- تعليق العضوية لدين غير مسدد لمدة شهر قاعدة تصعيد لاحقة مرجعها الزمني يُعلَن لاحقًا.`,
      en: `${DRAFT_EN}

## Payment methods
- Prices are in Iraqi dinar (integer amounts); USD display is derived only, at an announced exchange rate.
- Available methods: Levo wallet, cash on delivery, and full or partial advance payment depending on the product. Printer delivery fees are paid in advance.
- Invoices show payment status honestly: cash on delivery or BNPL is never described as "paid in full".

## Buy Now, Pay Later (BNPL)
- PRO members only, and only when identity, phone and approved-address verification requirements are satisfied.
- Maximum active credit exposure: 200,000 IQD in total across all concurrent orders and reservations — not per order.
- Repayment term: no more than 7 days. The event that starts the clock, and whether exposure includes fees, are subject to announcement before activation; the service is currently disabled until those rules are complete. No invented interest, fines or credit-scoring claims.
- After the repayment deadline with unpaid debt, new purchases and restrictable benefits are temporarily limited until settlement, while login, repayment, support, invoices and warranty always remain accessible. Settlement lifts only the debt restriction — it never revives an expired membership or clears an independent restriction.
- Membership suspension for debt unpaid for a month is a later escalation rule whose reference point is subject to announcement.`,
      ckb: `${DRAFT_CKB}

## ڕێگاکانی پارەدان
- نرخەکان بە دیناری عێراقین (بڕی تەواو)؛ پیشاندانی دۆلار تەنها ژماردنە بەپێی نرخی دراوی ڕاگەیەنراو.
- ڕێگا بەردەستەکان: جزدانی لیڤۆ، پارەدان لە کاتی وەرگرتن، و پارەدانی پێشوەختی تەواو یان بەشەکی بەپێی بەرهەمەکە. کرێی گەیاندنی پرینتەر پێشوەخت دەدرێت.
- پسوولە دۆخی پارەدان بە ڕاستگۆیی پیشان دەدات: پارەدان لە کاتی وەرگرتن یان BNPL هەرگیز وەک "بە تەواوی دراوە" وەسف ناکرێن.

## کڕین ئێستا و پارەدان دواتر (BNPL)
- تەنها بۆ ئەندامانی PRO، و تەنها کاتێک مەرجەکانی پشتڕاستکردنەوەی ناسنامە و تەلەفۆن و ناونیشانی پەسەندکراو جێبەجێ بوون.
- زۆرترین بەرکەوتنی قەرزی چالاک: ٢٠٠,٠٠٠ دینار بە گشتی بەسەر هەموو داواکاری و حجزکردنە هاوکاتەکاندا — نەک بۆ هەر داواکارییەک.
- ماوەی دانەوە: زیاتر لە ٧ ڕۆژ نییە. ئەو ڕووداوەی ژماردن دەست پێدەکات و ئایا بەرکەوتن کرێیەکان دەگرێتەوە، پێش چالاککردن ڕادەگەیەنرێن؛ خزمەتگوزارییەکە ئێستا ناچالاکە هەتا ئەو یاسایانە تەواو دەبن. هیچ سوود و سزا و پۆلێنبەندی قەرزی داهێنراو نییە.
- دوای بەسەرچوونی ماوەی دانەوە بە قەرزی نەدراوەوە، کڕینی نوێ و سوودە سنووردارەکان بە کاتی سنووردار دەکرێن هەتا یەکلاکردنەوە، بەڵام چوونەژوورەوە و دانەوە و پشتگیری و پسوولە و گەرەنتی هەمیشە بەردەست دەمێننەوە. یەکلاکردنەوە تەنها سنووری قەرزەکە لادەبات — ئەندامێتی بەسەرچوو ناژێنێتەوە و سنوورێکی سەربەخۆ لاناداتەوە.
- هەڵپەساردنی ئەندامێتی بۆ قەرزی مانگێک نەدراو یاسایەکی هەڵکشانی دواترە کە خاڵی سەرەتاکەی دواتر ڕادەگەیەنرێت.`,
    },
  },
  // ---------------------------------------------------------- membership
  {
    key: 'membership',
    title: {
      ar: 'سياسة العضويات وقيودها (PLUS / PRO)',
      en: 'Membership & Restrictions Policy (PLUS / PRO)',
      ckb: 'سیاسەتی ئەندامێتی و سنوورەکانی (PLUS / PRO)',
    },
    body: {
      ar: `${DRAFT_AR}

## الخطط
- LEVO PRO: اشتراك سنوي 12 شهرًا بسعر 499,000 دينار، ولا توجد خطة شهرية لـPRO. أسعار خطط PLUS تُعلَن من الإدارة، ولا تُباع خطة غير مسعّرة.

## متطلبات تفعيل PRO
- التحقق من الاسم الثلاثي الحقيقي وتاريخ الميلاد ورقم هاتف موثَّق (عبر مشاركة جهة الاتصال في محادثة بوت تيليغرام الخاصة)، ووثيقة واحدة فقط: البطاقة الوطنية أو جواز السفر.
- المراجعة بشرية من موظف مخوَّل؛ رفع صورة ليس تحققًا بحد ذاته، ولا نجري فحص قواعد بيانات حكومية أو تحققًا بيومتريًا. تظهر الحالة والأسباب في حسابك.
- التفعيل يتطلب أيضًا دفعًا صالحًا وعنوان توصيل افتراضيًا واحدًا معتمدًا وموافقة على هذه السياسة. سياسة الدفع عند رفض التحقق تُعلَن قبل أخذ أي دفع مشروط.

## العنوان والهاتف المعتمدان
- لكل عضو PRO عنوان افتراضي معتمد واحد وهاتف موثَّق واحد، بنسخ إصدارات محفوظة. تغيير أيّهما يتطلب طلبًا بسبب وموافقة إدارية، وتغيير الهاتف يتطلب إثبات ملكية جديدًا عبر تيليغرام.
- يجوز للعضو الطلب إلى عنوان آخر بشروط الزبون العادي لذلك الطلب (بدون أسعار PRO أو إعفاء الشحن أو BNPL)؛ هذا مسموح صراحة وليس مخالفة ولا يُلغي الاشتراك، وتعود مزايا PRO تلقائيًا عند العودة للعنوان المعتمد.

## التجارة المجتمعية
- يحق لعضو PLUS أو PRO الفعّال دخول مجتمع Levo كتاجر وبيع مطبوعاته؛ هذا مستقل تمامًا عن عنوان الدفع المختار ولا يمنح صلاحيات إدارة الموقع ولا شارة توثيق PRO تلقائيًا.

## القيود
- قيود الدين والاحتيال والتحقق حالات مستقلة بقرار موظف مخوَّل وسبب مسجَّل وإشعار وإمكانية اعتراض؛ اختيار عنوان بديل لا يُنشئ عقوبة ولا يمحوها. أي تقييد لا يمس الطلبات السابقة أو الضمان أو المحفظة أو الوصول للدعم والسداد.`,
      en: `${DRAFT_EN}

## Plans
- LEVO PRO: an annual 12-month subscription at 499,000 IQD; PRO has no monthly plan. PLUS plan prices are subject to announcement, and an unpriced plan is never sold.

## PRO activation requirements
- Verification of the true three-part full name, date of birth, a verified phone number (via contact sharing in the private Telegram bot chat), and exactly ONE document: national ID card or passport.
- Review is performed by an authorized human; uploading an image is not verification by itself, and we perform no government-database checks or biometric verification. Status and reasons appear in your account.
- Activation also requires valid payment, one approved default delivery address, and acceptance of this policy. The payment policy on verification rejection is announced before any conditional payment is taken.

## Approved address and phone
- Each PRO member has one approved default address and one verified phone, stored as versioned records. Changing either requires a reasoned request and admin approval; a phone change additionally requires fresh Telegram ownership proof.
- A member may order to another address under ordinary-customer conditions for that order (no PRO prices, shipping waiver or BNPL); this is explicitly allowed, is not a violation, does not cancel the subscription, and PRO benefits return automatically at the approved address.

## Community commerce
- Any active PLUS or PRO member may enter the Levo Community as a merchant and sell their own printed products; this is fully independent of the selected checkout address and grants neither site administration rights nor a PRO verification badge automatically.

## Restrictions
- Debt, fraud and verification restrictions are independent cases decided by authorized staff with a recorded reason, notice and an appeal route; selecting an alternate address neither creates nor clears a sanction. No restriction touches past orders, warranty, wallet balances, or access to support and repayment.`,
      ckb: `${DRAFT_CKB}

## پلانەکان
- LEVO PRO: بەشداریکردنی ساڵانەی ١٢ مانگ بە ٤٩٩,٠٠٠ دینار؛ PRO پلانی مانگانەی نییە. نرخی پلانەکانی PLUS دواتر ڕادەگەیەنرێن و پلانی بێ نرخ نافرۆشرێت.

## مەرجەکانی چالاککردنی PRO
- پشتڕاستکردنەوەی ناوی سیانی ڕاستەقینە و ڕێکەوتی لەدایکبوون و ژمارە تەلەفۆنی پشتڕاستکراو (بە هاوبەشکردنی پەیوەندی لە چاتی تایبەتی بۆتی تێلێگرامدا)، و تەنها یەک بەڵگەنامە: کارتی نیشتمانی یان پاسپۆرت.
- پێداچوونەوەکە لەلایەن مرۆڤێکی مۆڵەتدارەوەیە؛ بارکردنی وێنە بە تەنها پشتڕاستکردنەوە نییە، و هیچ پشکنینی داتابەیسی حکومی یان پشتڕاستکردنەوەی بایۆمەتری ناکەین. دۆخ و هۆکارەکان لە هەژمارەکەتدا دەردەکەون.
- چالاککردن هەروەها پێویستی بە پارەدانی دروست و یەک ناونیشانی بنەڕەتی پەسەندکراو و ڕازیبوون بەم سیاسەتەیە. سیاسەتی پارەدان لە کاتی ڕەتکردنەوەی پشتڕاستکردنەوەدا پێش وەرگرتنی هەر پارەدانێکی مەرجدار ڕادەگەیەنرێت.

## ناونیشان و تەلەفۆنی پەسەندکراو
- هەر ئەندامێکی PRO یەک ناونیشانی بنەڕەتی پەسەندکراو و یەک تەلەفۆنی پشتڕاستکراوی هەیە، وەک تۆماری وەشاندار پارێزراون. گۆڕینی هەرکامیان پێویستی بە داواکاری بە هۆکار و پەسەندکردنی بەڕێوەبەرایەتییە؛ گۆڕینی تەلەفۆن سەرباری ئەوە پێویستی بە بەڵگەی خاوەندارێتی نوێی تێلێگرامە.
- ئەندام دەتوانێت بۆ ناونیشانێکی تر داواکاری بکات بە مەرجەکانی کڕیاری ئاسایی بۆ ئەو داواکارییە (بێ نرخی PRO و لێبووردنی گەیاندن و BNPL)؛ ئەمە بە ڕوونی ڕێگەپێدراوە و سەرپێچی نییە و بەشداریکردنەکە هەڵناوەشێنێتەوە، و سوودەکانی PRO بە خۆکار دەگەڕێنەوە لە ناونیشانە پەسەندکراوەکەدا.

## بازرگانی کۆمەڵگا
- هەر ئەندامێکی چالاکی PLUS یان PRO دەتوانێت وەک بازرگان بچێتە ناو کۆمەڵگای Levo و بەرهەمە چاپکراوەکانی خۆی بفرۆشێت؛ ئەمە بە تەواوی سەربەخۆیە لە ناونیشانی هەڵبژێردراوی پارەدان و نە دەسەڵاتی بەڕێوەبردنی ماڵپەڕ و نە نیشانەی پشتڕاستکردنەوەی PRO بە خۆکار نابەخشێت.

## سنوورەکان
- سنوورەکانی قەرز و فێڵ و پشتڕاستکردنەوە دۆخی سەربەخۆن بە بڕیاری کارمەندی مۆڵەتدار و هۆکاری تۆمارکراو و ئاگادارکردنەوە و ڕێگای تانە؛ هەڵبژاردنی ناونیشانی جێگرەوە نە سزا دروست دەکات و نە لای دەبات. هیچ سنوورێک داواکارییە کۆنەکان و گەرەنتی و باڵانسی جزدان و گەیشتن بە پشتگیری و دانەوە ناگرێتەوە.`,
    },
  },
  // -------------------------------------------------------------- rewards
  {
    key: 'rewards',
    title: {
      ar: 'سياسة النقاط والمراجعات والهدايا والإحالات',
      en: 'Points, Reviews, Gifts & Referrals Policy',
      ckb: 'سیاسەتی خاڵەکان و پێداچوونەوەکان و دیارییەکان و ڕەوانەکردنەکان',
    },
    body: {
      ar: `${DRAFT_AR}

## النقاط
- كل 1,000 دينار من الإنفاق المدفوع فعلًا المؤهل يمنح نقطة واحدة، وكل نقطة تُصرف بقيمة دينار واحد بالضبط.
- تفاصيل "الإنفاق المؤهل" (الشحن، الرسوم، الأجزاء المدفوعة بالنقاط) وقواعد كسور المبالغ تُعلَن من الإدارة. لا تُمنح نقاط عن شحن المحفظة نفسه ولا عن مبالغ BNPL غير المسددة.
- المهام اليومية ونقاط مراجعات المنتجات الأخرى بقيم تحددها الإدارة وتُعلن في الموقع.

## مراجعات الطابعات وهدايا المستويات
- مكافأة مراجعة الطابعة تتطلب: شراءً حقيقيًا مُسلَّمًا لك، ومراجعة مكتوبة مفصّلة مع صور وفيديو، ودليل ستوري إنستغرام يُقدَّم بشكل خاص لمراجعة إدارية بشرية (لا يوجد تحقق آلي من إنستغرام).
- يقيّم موظف مخوَّل جودة المراجعة (فائدتها ووضوحها واكتمالها) بدرجة من 1 إلى 5. درجة الجودة ليست تقييم النجوم: المراجعة الناقدة أو ذات النجمة الواحدة قد تنال أعلى درجة جودة، ولا تُشترط المديح إطلاقًا.
- درجة N تفتح اختيار صندوق واحد فقط من المستويات 1 إلى N. محتويات الصناديق ومخزونها تُعلَن من الإدارة، والاختيار العشوائي يُجرى على الخادم من مخزون حقيقي ويُسجَّل مرة واحدة.
- إفصاح: المراجعات المكافأة مراجعات محفَّزة، والإشراف على نشرها منفصل عن الموافقة على المكافأة.

## الإحالات
- توجد حملتان منفصلتان: إحالة شراء طابعة (توصيل مجاني + بكرة مؤهلة واحدة بعد 7 أيام من الاستلام الفعلي)، وإحالة اشتراك PRO جديد مدفوع بتوقيت منح معتمد. لا تُجمع المكافأة نفسها مرتين ولا تُمنح هدايا المراجعات كمكافآت إحالة.`,
      en: `${DRAFT_EN}

## Points
- Each 1,000 IQD of qualifying actually-paid spend earns exactly 1 point, and each point redeems for exactly 1 IQD.
- The definition of "qualifying spend" (shipping, fees, points-funded portions) and fractional-remainder rules are subject to announcement. No points are earned for a wallet top-up itself, nor for unpaid BNPL principal.
- Daily tasks and other-product review points use administrator-configured values announced in the store.

## Printer reviews and gift levels
- A printer review reward requires: a genuine purchase delivered to you, a detailed written review with photos AND video, and Instagram story evidence submitted privately for human administrative review (there is no automated Instagram verification).
- An authorized staff member scores review QUALITY (usefulness, clarity, completeness) from 1 to 5. The quality score is not the star rating: a critical or one-star review can earn the highest quality score, and praise is never a condition.
- A score of N unlocks the choice of exactly ONE box from levels 1 through N. Box contents and stock are subject to announcement; random contents are chosen server-side from real approved stock and recorded once.
- Disclosure: rewarded reviews are incentivized reviews, and public-review moderation is separate from reward approval.

## Referrals
- Two separate campaigns exist: printer-purchase referral (free delivery + one eligible filament spool 7 days after actual receipt), and a new paid PRO subscription referral with its approved grant timing. The same reward is never collected twice, and review gifts are never granted as referral rewards.`,
      ckb: `${DRAFT_CKB}

## خاڵەکان
- هەر ١,٠٠٠ دیناری خەرجکردنی بەڕاستی دراوی شیاو یەک خاڵ بەدەست دەهێنێت، و هەر خاڵێک بە تەواوی بە ١ دینار دەگۆڕدرێتەوە.
- پێناسەی "خەرجکردنی شیاو" (گەیاندن، کرێیەکان، بەشە بە خاڵ دراوەکان) و یاساکانی پاشماوەی کەرتی دواتر ڕادەگەیەنرێن. خاڵ بۆ پڕکردنەوەی جزدان خۆی نادرێت، و نە بۆ بڕی BNPL ی نەدراو.
- ئەرکە ڕۆژانەکان و خاڵی پێداچوونەوەی بەرهەمەکانی تر بە بەهای دیاریکراوی بەڕێوەبەرایەتین کە لە فرۆشگادا ڕادەگەیەنرێن.

## پێداچوونەوەی پرینتەر و ئاستەکانی دیاری
- پاداشتی پێداچوونەوەی پرینتەر پێویستی بەمانەیە: کڕینێکی ڕاستەقینەی بۆ تۆ گەیەنراو، پێداچوونەوەیەکی نووسراوی وردەکاریدار لەگەڵ وێنە و ڤیدیۆ، و بەڵگەی ستۆری ئینستاگرام کە بە تایبەتی پێشکەش دەکرێت بۆ پێداچوونەوەی مرۆیی بەڕێوەبەرایەتی (هیچ پشتڕاستکردنەوەیەکی خۆکاری ئینستاگرام نییە).
- کارمەندێکی مۆڵەتدار کوالیتی پێداچوونەوەکە (سوودمەندی، ڕوونی، تەواوی) لە ١ بۆ ٥ هەڵدەسەنگێنێت. نمرەی کوالیتی هەڵسەنگاندنی ئەستێرە نییە: پێداچوونەوەی ڕەخنەگرانە یان یەک ئەستێرەیی دەتوانێت بەرزترین نمرەی کوالیتی بەدەست بهێنێت، و ستایش هەرگیز مەرج نییە.
- نمرەی N هەڵبژاردنی تەنها یەک سندوق لە ئاستەکانی ١ بۆ N دەکاتەوە. ناوەڕۆکی سندوقەکان و کۆگاکەیان دواتر ڕادەگەیەنرێن؛ ناوەڕۆکی هەڕەمەکی لە لایەن سێرڤەرەوە لە کۆگای ڕاستەقینەی پەسەندکراوەوە هەڵدەبژێردرێت و یەک جار تۆمار دەکرێت.
- ئاشکراکردن: پێداچوونەوە پاداشتدراوەکان پێداچوونەوەی هاندراون، و چاودێری بڵاوکردنەوەی گشتی جیاوازە لە پەسەندکردنی پاداشت.

## ڕەوانەکردنەکان
- دوو هەڵمەتی جیاواز هەن: ڕەوانەکردنی کڕینی پرینتەر (گەیاندنی بەخۆڕایی + یەک بۆبینی شیاو ٧ ڕۆژ دوای وەرگرتنی ڕاستەقینە)، و ڕەوانەکردنی بەشداریکردنی نوێی دراوی PRO بە کاتی بەخشینی پەسەندکراو. هەمان پاداشت دووجار کۆناکرێتەوە، و دیاری پێداچوونەوەکان هەرگیز وەک پاداشتی ڕەوانەکردن نادرێن.`,
    },
  },
  // ---------------------------------------------------------------- terms
  {
    key: 'terms',
    title: {
      ar: 'شروط البيع',
      en: 'Terms of Sale',
      ckb: 'مەرجەکانی فرۆشتن',
    },
    body: {
      ar: `${DRAFT_AR}

## الطلب والقبول
- إرسال الطلب عرض شراء؛ يُقبل الطلب عند تأكيده من المتجر. عرض السعر النهائي قبل التأكيد (البضاعة والتوصيل وعمولات الطلب المسبق ورسوم تمديد الضمان المختارة) هو الملزم، ويحتفظ الطلب المقبول بسعره حتى لو تغيرت الأسعار لاحقًا.
- أسعار المنتجات تشمل التأمين والضرائب المطبقة؛ لا رسوم مخفية تُضاف لاحقًا، والرسوم المختارة صراحة تُعرض قبل الإتمام.

## الموافقة على السياسات
- إتمام الشراء يتطلب موافقة صريحة غير مؤشَّرة مسبقًا على النسخ المنشورة الحالية من شروط البيع وسياسة الخصوصية، وتُسجَّل نسخة الوثيقة وبصمتها ووقت الموافقة في الخادم. تغيّر جوهري في عرض السعر يتطلب إعادة تأكيد.
- تعديل السياسات لاحقًا لا يغيّر حقوق طلب مقبول بأثر رجعي؛ النسخة الموافَق عليها تبقى محفوظة.

## الفواتير والإلغاء
- تصدر فاتورة لكل طلب بأرقام دقيقة وحالة دفع صادقة، ولا نختلق أرقام تسجيل ضريبي. لحظة إصدار الفاتورة الرسمية تُعلَن من الإدارة.
- إلغاء الطلبات قبل الشحن وقواعد استرجاع المدفوع المسبق تتبع سياسة الإرجاع وقرارات الإدارة المعلنة.

## التغطية والمسؤولية
- الضمان والإرجاع وحماية السعر بحسب سياساتها المنشورة. تغطية LEVONIS تغطية بائع، منفصلة عن أي ضمان مصنّع.
- لا تتنازل هذه الشروط عن حقوق نظامية ملزمة. الجهة القانونية للمتجر وبياناتها الرسمية تُعلَن ضمن هذه الشروط قبل النشر النهائي.`,
      en: `${DRAFT_EN}

## Orders and acceptance
- Submitting an order is an offer to buy; the order is accepted when the store confirms it. The final quote before confirmation (merchandise, delivery, preorder commissions and selected warranty-extension fees) is binding, and an accepted order keeps its price even if prices later change.
- Product prices include insurance and applicable taxes; no hidden charges are added later, and explicitly selected fees are shown before completion.

## Policy consent
- Completing a purchase requires explicit, un-prechecked acceptance of the current published versions of the Terms of Sale and Privacy Policy; the document version, content hash and acceptance time are recorded server-side. A material quote change requires reconfirmation.
- Later policy edits never retroactively change the rights of an accepted order; the accepted version is preserved.

## Invoices and cancellation
- Each order gets an invoice with accurate amounts and an honest payment status; we fabricate no tax registration numbers. The official invoice issuance moment is subject to announcement.
- Pre-shipment cancellation and advance-payment refunds follow the Returns policy and announced administrative rules.

## Coverage and liability
- Warranty, returns and price protection follow their published policies. LEVONIS coverage is seller coverage, separate from any manufacturer warranty.
- These terms waive no mandatory statutory rights. The store's legal entity and official details will be announced within these terms before final publication.`,
      ckb: `${DRAFT_CKB}

## داواکاری و پەسەندکردن
- ناردنی داواکاری پێشنیاری کڕینە؛ داواکارییەکە پەسەند دەکرێت کاتێک فرۆشگاکە پشتڕاستی دەکاتەوە. نرخە کۆتاییەکەی پێش پشتڕاستکردنەوە (کاڵا و گەیاندن و کۆمیسیۆنی داواکاری پێشوەخت و کرێی درێژکردنەوەی گەرەنتی هەڵبژێردراو) پابەندکەرە، و داواکاری پەسەندکراو نرخەکەی دەپارێزێت تەنانەت ئەگەر نرخەکان دواتر بگۆڕدرێن.
- نرخی بەرهەمەکان بیمە و باجە جێبەجێکراوەکان دەگرێتەوە؛ هیچ کرێیەکی شاراوە دواتر زیاد ناکرێت، و کرێیە بە ڕوونی هەڵبژێردراوەکان پێش تەواوکردن پیشان دەدرێن.

## ڕازیبوون بە سیاسەتەکان
- تەواوکردنی کڕین پێویستی بە ڕازیبوونی ڕوونی پێشتر نیشانە نەکراوە بە وەشانە بڵاوکراوە ئێستاکانی مەرجەکانی فرۆشتن و سیاسەتی تایبەتمەندی؛ وەشانی بەڵگەنامە و پەنجەمۆری ناوەڕۆک و کاتی ڕازیبوون لە سێرڤەردا تۆمار دەکرێن. گۆڕانی بنەڕەتی لە نرخەکەدا پێویستی بە دووبارە پشتڕاستکردنەوەیە.
- دەستکاری سیاسەتەکان لە داهاتوودا مافەکانی داواکاری پەسەندکراو بە پاشەوپاش ناگۆڕێت؛ وەشانە ڕازیبوونپێدراوەکە پارێزراو دەمێنێتەوە.

## پسوولەکان و هەڵوەشاندنەوە
- بۆ هەر داواکارییەک پسوولەیەک دەردەچێت بە بڕی ورد و دۆخی پارەدانی ڕاستگۆ؛ هیچ ژمارەی تۆماری باجی داهێنراو نییە. ساتی دەرچوونی پسوولەی فەرمی دواتر ڕادەگەیەنرێت.
- هەڵوەشاندنەوەی داواکاری پێش ناردن و یاساکانی گەڕاندنەوەی پارەی پێشوەخت دراو، سیاسەتی گەڕاندنەوە و بڕیارە ڕاگەیەنراوەکانی بەڕێوەبەرایەتی پەیڕەو دەکەن.

## داپۆشین و بەرپرسیارێتی
- گەرەنتی و گەڕاندنەوە و پاراستنی نرخ بەپێی سیاسەتە بڵاوکراوەکانیانن. داپۆشینی LEVONIS داپۆشینی فرۆشیارە، جیاوازە لە هەر گەرەنتییەکی دروستکەر.
- ئەم مەرجانە هیچ مافێکی یاسایی پابەندکەر ناسڕنەوە. لایەنی یاسایی فرۆشگاکە و زانیارییە فەرمییەکانی پێش بڵاوکردنەوەی کۆتایی لەم مەرجانەدا ڕادەگەیەنرێن.`,
    },
  },
  // ------------------------------------------------------------ site terms
  {
    key: 'site_terms',
    title: {
      ar: 'شروط استخدام الموقع',
      en: 'Website Terms of Use',
      ckb: 'مەرجەکانی بەکارهێنانی ماڵپەڕ',
    },
    body: {
      ar: `${DRAFT_AR}

## الحساب
- أنت مسؤول عن سرية بيانات دخولك وعن النشاط الجاري عبر حسابك. أبلغنا فورًا عن أي وصول غير مصرح.
- التحققات الأمنية (البريد، هاتف تيليغرام) تخص حسابك ولا يجوز إجراؤها ببيانات شخص آخر.

## الاستخدام المقبول
- يُمنع: محاولة الوصول لبيانات مستخدمين آخرين، التلاعب بالأسعار أو الطلبات أو النقاط أو التذاكر، الهندسة العكسية لتجاوز ضوابط الأمان، إنشاء حسابات وهمية لجمع مكافآت، ونشر محتوى غير قانوني أو مسيء في المجتمع.
- محتوى تجّار المجتمع مسؤولية ناشره؛ يدير كل تاجر متجره وبياناته فقط، وتحتفظ الإدارة بحق الإشراف المعلَّل.

## الملكية والخدمة
- أسماء LEVONIS وشعاراتها ومحتوى الموقع الأصلي ملك للمتجر أو مرخَّصة له؛ أسماء المنتجات والعلامات الأخرى لأصحابها ولا تعني شراكة أو اعتمادًا.
- قد تتوقف الخدمة مؤقتًا للصيانة أو لأسباب خارجة عن السيطرة؛ لا نعد بتوفر غير منقطع.
- المخالفات قد تؤدي لتقييد مزايا أو حساب بقرار معلَّل قابل للاعتراض، مع بقاء الحقوق المكتسبة (الطلبات، الضمان، الأرصدة) خاضعة لسياساتها لا للمصادرة التلقائية.`,
      en: `${DRAFT_EN}

## Accounts
- You are responsible for keeping your sign-in details confidential and for activity performed through your account. Report unauthorized access immediately.
- Security verifications (email, Telegram phone) belong to your own account and must not be performed with another person's details.

## Acceptable use
- Prohibited: attempting to access other users' data, manipulating prices, orders, points or tickets, reverse-engineering around security controls, creating fake accounts to collect rewards, and posting unlawful or abusive content in the community.
- Community merchant content is the responsibility of its publisher; each merchant manages only their own store and data, and administration retains a reasoned moderation right.

## Ownership and service
- LEVONIS names, logos and original site content belong to or are licensed to the store; other product names and brands belong to their owners and imply no partnership or endorsement.
- Service may pause temporarily for maintenance or causes beyond our control; we do not promise uninterrupted availability.
- Violations may lead to a reasoned, appealable restriction of benefits or accounts, while earned rights (orders, warranty, balances) remain governed by their policies, never automatic confiscation.`,
      ckb: `${DRAFT_CKB}

## هەژمارەکان
- تۆ بەرپرسیاریت لە پاراستنی نهێنی زانیاری چوونەژوورەوەکەت و لە چالاکی ئەنجامدراو لە ڕێگەی هەژمارەکەتەوە. دەستگەیشتنی بێ مۆڵەت دەستبەجێ ڕاپۆرت بکە.
- پشتڕاستکردنەوە ئەمنییەکان (ئیمەیل، تەلەفۆنی تێلێگرام) هی هەژماری خۆتن و نابێت بە زانیاری کەسێکی تر ئەنجام بدرێن.

## بەکارهێنانی پەسەندکراو
- قەدەغەیە: هەوڵدان بۆ دەستگەیشتن بە داتای بەکارهێنەرانی تر، دەستکاریکردنی نرخ و داواکاری و خاڵ و تیکێتەکان، ئەندازیاری پێچەوانە بۆ تێپەڕاندنی کۆنترۆڵە ئەمنییەکان، دروستکردنی هەژماری ساختە بۆ کۆکردنەوەی پاداشت، و بڵاوکردنەوەی ناوەڕۆکی نایاسایی یان سووکایەتیکەر لە کۆمەڵگادا.
- ناوەڕۆکی بازرگانانی کۆمەڵگا بەرپرسیارێتی بڵاوکەرەوەکەیەتی؛ هەر بازرگانێک تەنها فرۆشگا و داتای خۆی بەڕێوە دەبات، و بەڕێوەبەرایەتی مافی چاودێری بە هۆکار دەپارێزێت.

## خاوەندارێتی و خزمەتگوزاری
- ناوەکان و لۆگۆکانی LEVONIS و ناوەڕۆکی ڕەسەنی ماڵپەڕ هی فرۆشگاکەن یان مۆڵەتیان پێدراوە؛ ناوی بەرهەم و براندەکانی تر هی خاوەنەکانیانن و مانای هاوبەشی یان پشتگیری نییە.
- لەوانەیە خزمەتگوزارییەکە بە کاتی بوەستێت بۆ چاککردنەوە یان هۆکاری دەرەوەی کۆنترۆڵ؛ بەڵێنی بەردەستبوونی بێ پچڕان نادەین.
- سەرپێچییەکان لەوانەیە ببنە هۆی سنووردارکردنی سوودەکان یان هەژمار بە بڕیاری بە هۆکار و تانەلێدراو، لە کاتێکدا مافە بەدەستهێنراوەکان (داواکارییەکان، گەرەنتی، باڵانسەکان) بەپێی سیاسەتەکانیان دەمێننەوە، هەرگیز دەستبەسەرداگرتنی خۆکار نییە.`,
    },
  },
  // -------------------------------------------------------------- privacy
  {
    key: 'privacy',
    title: {
      ar: 'سياسة الخصوصية',
      en: 'Privacy Policy',
      ckb: 'سیاسەتی تایبەتمەندی',
    },
    body: {
      ar: `${DRAFT_AR}

## ما نجمعه ولماذا
- بيانات الحساب (البريد، اسم المستخدم، الاسم) لإدارة حسابك؛ الطلبات والعناوين والمحفظة لتنفيذ مشترياتك؛ سجلات تشغيل أمنية محدودة لحماية الحسابات.
- توثيق الهاتف: عند ربط تيليغرام نحفظ رقمك الموثَّق ومعرّف محادثة البوت لغرض التحقق وإشعارات تشغيلية اخترتها. محادثات بوت تيليغرام ليست مشفّرة من طرف لطرف، وتُعالج عبر منصة تيليغرام.
- تحقق هوية PRO فقط: الاسم الثلاثي وتاريخ الميلاد ونوع ورقم وثيقة واحدة (بطاقة وطنية أو جواز) وصور الأدلة — تُجمع حصرًا لغرض تفعيل عضوية PRO ولا تُطلب من المتسوق العادي.

## كيف نحمي بيانات الهوية
- حقول الهوية الحساسة تُخزَّن مشفّرة على مستوى التطبيق بمفاتيح مُدارة منفصلة عن قاعدة البيانات، وصور الأدلة في تخزين خاص لا يصل إليه رابط عام، ولا تُعرض إلا لموظف مخوَّل عبر مسار مصرَّح يسجَّل كل اطلاع فيه. هذا ليس تشفيرًا من طرف لطرف ولا نعد بأمان مطلق.
- مدد الاحتفاظ بأدلة الهوية بعد المراجعة تُعلَن ضمن هذه السياسة قبل تفعيل الخدمة في الإنتاج.

## من يعالج البيانات
- Cloudflare: استضافة الموقع وقاعدة البيانات وتخزين الملفات. Resend: إرسال رسائل البريد (تحقق، استعادة كلمة المرور، فاتورة الطلب فقط). Telegram: قناة توثيق الهاتف والإشعارات. لا نبيع بياناتك ولا نرسل بريدًا تسويقيًا دون طلب منفصل صريح.

## حقوقك
- ترى بياناتك من حسابك، ويمكنك طلب الوصول أو التصحيح أو الحذف عبر الدعم؛ تُلبى الطلبات ضمن حدود الالتزامات القانونية والسجلات المحاسبية الواجبة. بيانات التواصل الرسمية للمسؤول عن البيانات تُعلَن قبل النشر النهائي.`,
      en: `${DRAFT_EN}

## What we collect and why
- Account data (email, username, name) to manage your account; orders, addresses and wallet records to fulfil your purchases; limited security logs to protect accounts.
- Phone verification: when you link Telegram we store your verified number and the bot chat id for verification and operational notifications you opted into. Telegram bot conversations are NOT end-to-end encrypted and are processed by the Telegram platform.
- PRO identity verification only: the three-part name, date of birth, one document's type and number (national ID or passport) and evidence images — collected exclusively to activate PRO membership and never requested from ordinary shoppers.

## How identity data is protected
- Sensitive identity fields are stored application-layer encrypted with managed keys kept separate from the database; evidence images live in private storage with no public URL and are shown only to authorized staff through an authenticated route where every view is logged. This is not end-to-end encryption and we do not promise absolute security.
- Retention periods for identity evidence after review will be announced in this policy before the service activates in production.

## Who processes data
- Cloudflare: site hosting, database and file storage. Resend: email delivery (verification, password recovery, and the order invoice only). Telegram: the phone-verification and notification channel. We do not sell your data and send no marketing email without a separate explicit request.

## Your rights
- You can see your data in your account and request access, correction or deletion through support; requests are honoured within the limits of legal obligations and required accounting records. Official data-controller contact details will be announced before final publication.`,
      ckb: `${DRAFT_CKB}

## چی کۆدەکەینەوە و بۆچی
- داتای هەژمار (ئیمەیل، ناوی بەکارهێنەر، ناو) بۆ بەڕێوەبردنی هەژمارەکەت؛ داواکارییەکان و ناونیشانەکان و تۆمارەکانی جزدان بۆ جێبەجێکردنی کڕینەکانت؛ تۆماری ئەمنی سنووردار بۆ پاراستنی هەژمارەکان.
- پشتڕاستکردنەوەی تەلەفۆن: کاتێک تێلێگرام دەبەستیتەوە، ژمارە پشتڕاستکراوەکەت و ناسنامەی چاتی بۆتەکە هەڵدەگرین بۆ پشتڕاستکردنەوە و ئاگادارکردنەوە کارییەکان کە خۆت هەڵتبژاردوون. گفتوگۆکانی بۆتی تێلێگرام کۆدکراوی سەر بە سەر نین و لە ڕێگەی پلاتفۆرمی تێلێگرامەوە پرۆسێس دەکرێن.
- پشتڕاستکردنەوەی ناسنامەی تەنها PRO: ناوی سیانی و ڕێکەوتی لەدایکبوون و جۆر و ژمارەی یەک بەڵگەنامە (کارتی نیشتمانی یان پاسپۆرت) و وێنەکانی بەڵگە — تەنها بۆ چالاککردنی ئەندامێتی PRO کۆدەکرێنەوە و هەرگیز لە کڕیاری ئاسایی داوا ناکرێن.

## چۆن داتای ناسنامە دەپارێزرێت
- خانە هەستیارەکانی ناسنامە بە کۆدکردنی ئاستی ئەپلیکەیشن هەڵدەگیرێن بە کلیلی بەڕێوەبراوی جیاکراوە لە داتابەیسەکە؛ وێنەکانی بەڵگە لە کۆگای تایبەتدان بێ هیچ بەستەرێکی گشتی و تەنها بۆ کارمەندی مۆڵەتدار پیشان دەدرێن لە ڕێگایەکی ڕێگەپێدراوەوە کە هەر بینینێک تۆمار دەکرێت. ئەمە کۆدکردنی سەر بە سەر نییە و بەڵێنی ئاسایشی ڕەها نادەین.
- ماوەکانی هەڵگرتنی بەڵگەی ناسنامە دوای پێداچوونەوە، پێش چالاککردنی خزمەتگوزارییەکە لە بەرهەمهێناندا لەم سیاسەتەدا ڕادەگەیەنرێن.

## کێ داتا پرۆسێس دەکات
- Cloudflare: خانەخوێی ماڵپەڕ و داتابەیس و کۆگای فایل. Resend: ناردنی ئیمەیل (پشتڕاستکردنەوە، گەڕاندنەوەی وشەی نهێنی، و تەنها پسوولەی داواکاری). Telegram: کەناڵی پشتڕاستکردنەوەی تەلەفۆن و ئاگادارکردنەوەکان. داتاکانت نافرۆشین و بێ داواکاری جیاوازی ڕوون هیچ ئیمەیلێکی بازرگانی نانێرین.

## مافەکانت
- داتاکانت لە هەژمارەکەتدا دەبینیت و دەتوانیت داوای دەستگەیشتن یان ڕاستکردنەوە یان سڕینەوە بکەیت لە ڕێگەی پشتگیرییەوە؛ داواکارییەکان لە سنووری ئەرکە یاساییەکان و تۆمارە ژمێریارییە پێویستەکاندا جێبەجێ دەکرێن. زانیاری پەیوەندی فەرمی بەرپرسی داتا پێش بڵاوکردنەوەی کۆتایی ڕادەگەیەنرێت.`,
    },
  },
  // -------------------------------------------------------------- support
  {
    key: 'support',
    title: {
      ar: 'الدعم والتواصل',
      en: 'Support & Contact',
      ckb: 'پشتگیری و پەیوەندی',
    },
    body: {
      ar: `${DRAFT_AR}

## قنوات LEVONIS الرسمية
- من داخل حسابك: تذاكر الدعم، مطالبات الضمان، طلبات الإرجاع، والمحادثات — وهي القناة المرجعية لكل مطالبة.
- بوت تيليغرام الرسمي: @Levonisiq_bot لتوثيق الهاتف والإشعارات التشغيلية. لا يطلب موظفونا كلمة المرور أو رمز التحقق أبدًا، ولا نرسل وثائق الهوية عبر تيليغرام.
- البريد الرسمي يصلك من نطاق mail.levonis-iq.com حصرًا (رسائل الحساب وفاتورة الطلب فقط).

## توقعات صادقة
- تُعرض حالة كل تذكرة وقرارها وسببها في حسابك؛ تذاكر أعضاء PRO المؤهلة تحظى بأولوية معالجة حيث تنطبق.
- أوقات الاستجابة المستهدفة والعنوان القانوني وبيانات التواصل الرسمية للجهة المالكة تُعلَن قبل النشر النهائي لهذه الوثيقة؛ لا نختلق عناوين أو أرقام تسجيل.`,
      en: `${DRAFT_EN}

## Official LEVONIS channels
- From inside your account: support tickets, warranty claims, return requests and chats — the authoritative channel for every claim.
- The official Telegram bot: @Levonisiq_bot for phone verification and operational notifications. Our staff never ask for your password or verification code, and identity documents are never sent over Telegram.
- Official email reaches you exclusively from the mail.levonis-iq.com domain (account messages and the order invoice only).

## Honest expectations
- Every ticket's status, decision and reason are shown in your account; eligible PRO tickets receive processing priority where applicable.
- Target response times, the legal address and the owning entity's official contact details will be announced before this document's final publication; we fabricate no addresses or registration numbers.`,
      ckb: `${DRAFT_CKB}

## کەناڵە فەرمییەکانی LEVONIS
- لەناو هەژمارەکەتەوە: تیکێتەکانی پشتگیری، داواکارییەکانی گەرەنتی، داواکارییەکانی گەڕاندنەوە و گفتوگۆکان — کەناڵی بنچینەیی بۆ هەر داواکارییەک.
- بۆتی فەرمی تێلێگرام: @Levonisiq_bot بۆ پشتڕاستکردنەوەی تەلەفۆن و ئاگادارکردنەوە کارییەکان. کارمەندەکانمان هەرگیز داوای وشەی نهێنی یان کۆدی پشتڕاستکردنەوەت ناکەن، و بەڵگەنامەکانی ناسنامە هەرگیز بە تێلێگرام نانێردرێن.
- ئیمەیلی فەرمی تەنها لە دۆمەینی mail.levonis-iq.com ـەوە پێت دەگات (پەیامەکانی هەژمار و تەنها پسوولەی داواکاری).

## چاوەڕوانییە ڕاستگۆکان
- دۆخ و بڕیار و هۆکاری هەر تیکێتێک لە هەژمارەکەتدا پیشان دەدرێن؛ تیکێتە شیاوەکانی ئەندامانی PRO ئەولەویەتی پرۆسێسکردنیان هەیە لەو شوێنانەی جێبەجێ دەبێت.
- کاتە ئامانجەکانی وەڵامدانەوە و ناونیشانی یاسایی و زانیاری پەیوەندی فەرمی لایەنە خاوەندارەکە پێش بڵاوکردنەوەی کۆتایی ئەم بەڵگەنامەیە ڕادەگەیەنرێن؛ هیچ ناونیشان یان ژمارەی تۆمارێک داناهێنین.`,
    },
  },
];
