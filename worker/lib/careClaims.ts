/**
 * LEVO CARE CLAIMS AND THE MONEY OF A CLAIM — printer services phase 3 (owner rulings 2026-11-18;
 * DECISIONS row 347; migration 0236). The warranty claims desk is reused; nothing here is a second
 * claims system.
 *
 *   careClaimsInstalled(db)          0236 present? (memoised per database, «present» only — the
 *                                    claimFiledColumnsInstalled pattern); every reader tolerates absence
 *   careEntitlements(db, units, at)  each unit's Levo Care: from the device's ROOT unit (a replacement
 *                                    resolves to the unit first sold) — delivered_at → + (warranty_months + 12) of
 *                                    its line's frozen services snapshot (phase 5: Care runs after the warranty); closed when the device came
 *                                    back (warranty_closed_at); the terms frozen for the line's
 *                                    policy_version (printer_care_policies); the claims and the discount
 *                                    already approved on that root (the caps)
 *   parseCareQuote / priceCareQuote  the desk's quote and the one function that prices it:
 *                                    eligible = eligible parts (+ labour / shipping when the terms say
 *                                    'discounted'); benefit = min(floor(eligible × pct / 100), money cap
 *                                    left); co-pay = list − benefit. Integer IQD.
 *   CARE_REFUSALS / careRefusal      every refusal of this phase, in ar / en / ckb (src/lib/refusalStrings.ts
 *                                    carries the same codes for the screens)
 *
 * Money rules (owner): a claim's out-of-pocket costs are GENERAL expenses of their cost day, never written
 * back to an order; the co-pay is service income (account 4300); investor and staff shares are untouched.
 */
import type { CareTerms, Text3 } from '@levonis/pricing/printerServices';
import { addMonths } from './membershipOps';
import { carePolicies } from './printerServices';
import { MAX_REPLACEMENT_HOPS } from './deviceCustody';
import { HttpError } from './http';
import { isSchemaMissing } from './membershipBenefits';

// ------------------------------------------------------------------ refusals

export const CARE_REFUSALS = {
  CARE_NOT_INSTALLED: {
    ar: 'مطالبات ليفو كير وتكاليفها غير مفعّلة بعد على قاعدة البيانات.',
    en: 'Levo Care claims and claim costs are not set up on the database yet.',
    ckb: 'داواکارییەکانی لیڤۆ کێر و تێچووەکانیان هێشتا لە بنکەدراوەکەدا ئامادە نەکراون.',
  },
  CARE_NOT_ACTIVE: {
    ar: 'هذا الجهاز ليس عليه ليفو كير سارية في تاريخ فتح المطالبة.',
    en: 'This device had no Levo Care in force on the day the claim was opened.',
    ckb: 'ئەم ئامێرە لە ڕۆژی کردنەوەی داواکارییەکەدا لیڤۆ کێری کارای نەبوو.',
  },
  CARE_TERMS_MISSING: {
    ar: 'شروط ليفو كير لهذا الجهاز لم تُنشر بعد — انشر الشروط من قائمة أسعار خدمات الطابعات أولاً.',
    en: 'The Levo Care terms for this device were never published — publish the terms from the printer services price list first.',
    ckb: 'مەرجەکانی لیڤۆ کێر بۆ ئەم ئامێرە هێشتا بڵاونەکراونەتەوە — سەرەتا مەرجەکان لە لیستی نرخی خزمەتگوزارییەکانی چاپکەرەوە بڵاو بکەرەوە.',
  },
  CARE_CLAIM_LIMIT: {
    ar: 'استُخدم عدد مطالبات ليفو كير المسموح لهذا الجهاز خلال فترة ليفو كير.',
    en: 'This device has used all the Levo Care claims its Care period allows.',
    ckb: 'ئەم ئامێرە هەموو ئەو داواکارییانەی لیڤۆ کێری بەکارهێناوە کە ماوەی لیڤۆ کێرەکەی ڕێگەی پێدەدات.',
  },
  CARE_PART_NOT_ELIGIBLE: {
    ar: 'هذه القطعة ليست ضمن قطع ليفو كير — ضع ثمنها في «أعمال أخرى» بسعرها الكامل.',
    en: 'This part is not one Levo Care covers — put its price under «Other work» at full price.',
    ckb: 'ئەم پارچەیە لەناو پارچەکانی لیڤۆ کێردا نییە — نرخەکەی لە «کاری تر» بە نرخی تەواو دابنێ.',
  },
  CARE_NOT_WARRANTY: {
    ar: 'الضمان ساري على هذا الجهاز ويغطي العطل — عالجها كمطالبة ضمان. ليفو كير لا تُجمع مع الضمان إلا عند سوء الاستخدام.',
    en: 'The warranty is in force on this device and covers the fault — handle it as a warranty claim. Levo Care does not stack with the warranty except for misuse.',
    ckb: 'گەرەنتی لەسەر ئەم ئامێرە کارایە و کێشەکە دەگرێتەوە — وەک داواکاریی گەرەنتی چارەسەری بکە. لیڤۆ کێر لەگەڵ گەرەنتیدا کۆ ناکرێتەوە جگە لە خراپ بەکارهێنان.',
  },
  CARE_CLAIM_NOT_OPEN: {
    ar: 'عرض ليفو كير يُعدّ أو يُعتمد فقط لمطالبة ما زالت قيد الاستلام أو الفحص.',
    en: 'A Levo Care quote is written or approved only on a claim still being received or diagnosed.',
    ckb: 'پێشنیاری لیڤۆ کێر تەنها بۆ داواکارییەک دەنووسرێت یان پەسەند دەکرێت کە هێشتا لە وەرگرتن یان پشکنیندایە.',
  },
  CARE_ALREADY_APPROVED: {
    ar: 'اعتُمدت ليفو كير لهذه المطالبة ولا يتغير عرضها. لتغييره يلغي مسؤول مالي اعتماد ليفو كير (ممكن فقط قبل استلام مساهمة الزبون)، فتعود المطالبة إلى الفحص لعرض جديد.',
    en: 'Levo Care was approved on this claim and its quote no longer changes. To change it, a financial admin voids the Levo Care approval (possible only before the customer’s co-pay is collected); the claim then returns to diagnosis for a new quote.',
    ckb: 'لیڤۆ کێر بۆ ئەم داواکارییە پەسەندکراوە و پێشنیارەکەی ناگۆڕێت. بۆ گۆڕینی، بەرپرسێکی دارایی پەسەندکردنی لیڤۆ کێر هەڵدەوەشێنێتەوە (تەنها پێش وەرگرتنی بەشداریی کڕیار دەکرێت)، ئینجا داواکارییەکە دەگەڕێتەوە بۆ پشکنین بۆ پێشنیارێکی نوێ.',
  },
  CARE_REJECT_COPAY_COLLECTED: {
    ar: 'استُلمت مساهمة الزبون في ليفو كير لهذه المطالبة، فلا تُرفض الآن — أكمل الإصلاح ثم أغلقها كمحلولة.',
    en: 'The customer’s Levo Care co-pay on this claim was collected, so it cannot be rejected now — finish the repair, then close it as resolved.',
    ckb: 'بەشداریی کڕیار لە لیڤۆ کێری ئەم داواکارییەدا وەرگیراوە، بۆیە ئێستا ڕەت ناکرێتەوە — چاککردنەوەکە تەواو بکە، پاشان وەک چارەسەرکراو دایبخە.',
  },
  CARE_COPAY_CLAIM_REJECTED: {
    ar: 'رُفضت هذه المطالبة، فلا تُستلم عليها مساهمة ليفو كير.',
    en: 'This claim was rejected, so no Levo Care co-pay is collected on it.',
    ckb: 'ئەم داواکارییە ڕەتکراوەتەوە، بۆیە هیچ بەشدارییەکی لیڤۆ کێر لەسەری وەرناگیرێت.',
  },
  CARE_QUOTE_CHANGED: {
    ar: 'تغيّر عرض ليفو كير منذ فتحته — حدّث الصفحة وراجعه من جديد.',
    en: 'The Levo Care quote changed since you opened it — reload and review it again.',
    ckb: 'پێشنیاری لیڤۆ کێر لەو کاتەوەی کردتەوە گۆڕاوە — لاپەڕەکە نوێ بکەرەوە و دووبارە پێیدا بچۆرەوە.',
  },
  CARE_QUOTE_NOT_ACCEPTED: {
    ar: 'لم يوافق الزبون على عرض ليفو كير بعد — يُعتمد بعد موافقته.',
    en: 'The customer has not accepted the Levo Care quote yet — it is approved after they accept.',
    ckb: 'کڕیار هێشتا پێشنیاری لیڤۆ کێری قبوڵ نەکردووە — دوای قبوڵکردنی پەسەند دەکرێت.',
  },
  CARE_APPROVAL_REQUIRED: {
    ar: 'هذه مطالبة ليفو كير: تُقبل باعتماد عرضها («اعتماد ليفو كير») من المسؤول المالي، لا بتغيير المرحلة.',
    en: 'This is a Levo Care claim: it is accepted by approving its quote («Approve Levo Care») by a financial admin, not by changing the stage.',
    ckb: 'ئەمە داواکاریی لیڤۆ کێرە: بە پەسەندکردنی پێشنیارەکەی («پەسەندکردنی لیڤۆ کێر») لەلایەن بەرپرسی داراییەوە قبوڵ دەکرێت، نەک بە گۆڕینی قۆناغ.',
  },
  CARE_COPAY_COLLECTED: {
    ar: 'استُلمت مساهمة الزبون في ليفو كير لهذه المطالبة، فلا يُلغى اعتمادها ولا تُستلم مرة ثانية.',
    en: 'The customer’s Levo Care co-pay on this claim was collected, so its approval cannot be voided and it is not collected twice.',
    ckb: 'بەشداریی کڕیار لە لیڤۆ کێری ئەم داواکارییەدا وەرگیراوە، بۆیە پەسەندکردنەکەی هەڵناوەشێتەوە و دوو جار وەرناگیرێت.',
  },
  CARE_NO_COPAY: {
    ar: 'لا توجد مساهمة على الزبون لاستلامها: اعتمد عرض ليفو كير أولاً، أو المساهمة صفر.',
    en: 'There is no co-pay to collect: approve the Levo Care quote first, or the co-pay is zero.',
    ckb: 'هیچ بەشدارییەک نییە بۆ وەرگرتن لە کڕیار: سەرەتا پێشنیاری لیڤۆ کێر پەسەند بکە، یان بەشدارییەکە سفرە.',
  },
  CARE_VOID_TOO_LATE: {
    ar: 'أُغلقت المطالبة (حُلّت أو استُبدل الجهاز)، فلا يُلغى عرض ليفو كير الآن.',
    en: 'The claim is closed (resolved or replaced), so its Levo Care quote cannot be voided now.',
    ckb: 'داواکارییەکە داخراوە (چارەسەرکرا یان ئامێرەکە گۆڕدرا)، بۆیە ئێستا پێشنیاری لیڤۆ کێرەکەی هەڵناوەشێتەوە.',
  },
  CARE_POLICY_VERSION_REUSED: {
    ar: 'شروط ليفو كير لهذا الإصدار نُشرت سابقًا ولا تتغير — ارفع رقم إصدار الشروط لتسري على المشترين الجدد.',
    en: 'The Levo Care terms of this version were already published and cannot change — raise the terms version so the new terms apply to new buyers.',
    ckb: 'مەرجەکانی لیڤۆ کێری ئەم وەشانە پێشتر بڵاوکراونەتەوە و ناگۆڕدرێن — ژمارەی وەشانی مەرجەکان بەرز بکەرەوە بۆ ئەوەی بۆ کڕیارە نوێیەکان جێبەجێ بن.',
  },
  CLAIM_COST_OPERATION_REUSED: {
    ar: 'رقم العملية هذا استُخدم لتكلفة أخرى — حدّث الصفحة وأعد الإدخال.',
    en: 'This operation id was used for another cost — reload the page and enter it again.',
    ckb: 'ئەم ژمارەی کردارە بۆ تێچوویەکی تر بەکارهاتووە — لاپەڕەکە نوێ بکەرەوە و دووبارە تۆماری بکە.',
  },
  CLAIM_COST_DAY_FUTURE: {
    ar: 'يوم التكلفة لا يكون في المستقبل.',
    en: 'The cost day cannot be in the future.',
    ckb: 'ڕۆژی تێچوو نابێت لە داهاتوودا بێت.',
  },
  CLAIM_HELD_EXPENSE: {
    ar: 'هذه تكلفة مطالبة ضمان أو ليفو كير؛ تُصحَّح من المطالبة نفسها في مكتب الضمان (ألغِ التكلفة هناك وسجّلها من جديد).',
    en: 'This is a warranty or Levo Care claim cost; correct it from the claim itself on the warranty desk (void the cost there and record it again).',
    ckb: 'ئەمە تێچووی داواکارییەکی گەرەنتی یان لیڤۆ کێرە؛ لە خودی داواکارییەکەوە لە مێزی گەرەنتی ڕاست بکرێتەوە (لەوێ تێچووەکە هەڵبوەشێنەوە و دووبارە تۆماری بکە).',
  },
  // ---- phase 5: the Care part offer (DECISIONS row 358; migration 0243)
  CARE_PART_INVALID: {
    ar: 'هذا المنتج لا يُعرض كقطعة ليفو كير: اختر منتجاً منشوراً في المتجر، ليس طابعة ولا باقة ولا اشتراكاً.',
    en: 'This product cannot be offered as a Levo Care part: pick a product on sale in the store that is not a printer, a bundle or a membership.',
    ckb: 'ئەم بەرهەمە وەک پارچەی لیڤۆ کێر پێشکەش ناکرێت: بەرهەمێک هەڵبژێرە کە لە فرۆشگاکەدا بۆ فرۆشتن دانرابێت و چاپکەر، پاکێج یان ئەندامێتی نەبێت.',
  },
  CARE_PART_PCT_INVALID: {
    ar: 'نسبة الخصم يجب أن تكون رقماً صحيحاً من 1 إلى الحد الأقصى المسموح في قائمة أسعار ليفو كير.',
    en: 'The discount must be a whole percent from 1 up to the maximum the Levo Care price list allows.',
    ckb: 'ڕێژەی داشکاندن دەبێت ژمارەیەکی تەواو بێت لە 1 تا ئەو زۆرترین ڕێژەیەی لیستی نرخی لیڤۆ کێر ڕێگەی پێدەدات.',
  },
  CARE_PART_ALREADY_OFFERED: {
    ar: 'لهذه المطالبة عرض سارٍ على هذه القطعة — ألغِه أولاً أو انتظر انتهاءه.',
    en: 'This claim already has a live offer on this part — revoke it first or wait for it to end.',
    ckb: 'ئەم داواکارییە پێشتر پێشنیارێکی کارای لەسەر ئەم پارچەیە هەیە — سەرەتا هەڵیبوەشێنەوە یان چاوەڕێی کۆتاییهاتنی بکە.',
  },
  CARE_PART_LIMIT: {
    ar: 'بلغت هذه المطالبة الحد الأقصى من عروض القطع السارية (5).',
    en: 'This claim has reached the maximum of live part offers (5).',
    ckb: 'ئەم داواکارییە گەیشتووەتە زۆرترین ژمارەی پێشنیاری پارچەی کارا (5).',
  },
  CARE_PART_USED: {
    ar: 'استخدم الزبون هذا العرض في طلب، فلا يُلغى الآن. إذا أُلغي الطلب قبل التسليم يعود العرض ويمكن إلغاؤه.',
    en: 'The customer used this offer on an order, so it cannot be revoked now. If that order is cancelled before delivery the offer comes back and can be revoked.',
    ckb: 'کڕیار ئەم پێشنیارەی لە داواکارییەکدا بەکارهێناوە، بۆیە ئێستا هەڵناوەشێتەوە. ئەگەر ئەو داواکارییە پێش گەیاندن هەڵبوەشێتەوە، پێشنیارەکە دەگەڕێتەوە و دەتوانرێت هەڵبوەشێنرێتەوە.',
  },
  CARE_OFFER_CHANGED: {
    ar: 'تغيّر خصم ليفو كير على هذا الطلب منذ عرض المجموع (انتهى العرض أو أُلغي أو استُخدم). لم يُسجَّل شيء — راجع المجموع الجديد ثم أكّد من جديد.',
    en: 'The Levo Care discount on this order changed since the total was shown (the offer ended, was revoked or was used). Nothing was placed — review the new total and confirm again.',
    ckb: 'داشکاندنی لیڤۆ کێر لەسەر ئەم داواکارییە لەو کاتەوەی کۆی گشتی پیشان درا گۆڕاوە (پێشنیارەکە کۆتایی هاتووە، هەڵوەشێنراوەتەوە یان بەکارهاتووە). هیچ شتێک تۆمار نەکرا — سەیری کۆی نوێ بکە و دووبارە پشتڕاستی بکەرەوە.',
  },
} as const satisfies Record<string, Text3>;
export type CareRefusalCode = keyof typeof CARE_REFUSALS;

/** The refusal with the server's own trilingual sentence (the screens show theirs by code). */
export function careRefusal(code: CareRefusalCode, status = 409, details?: Record<string, unknown>): HttpError {
  const t = CARE_REFUSALS[code];
  return new HttpError(status, `${t.ar} / ${t.en} / ${t.ckb}`, code, details);
}

// ------------------------------------------------------------------ presence

/**
 * An expense a claim cost holds (service_claim_costs.expense_id) is changed only from its claim — the
 * general expense routes refuse it, so the claim's cost list and the books never drift apart. False before 0236.
 */
export async function claimHeldExpense(db: D1Database, expenseId: string): Promise<boolean> {
  if (!await careClaimsInstalled(db)) return false;
  return !!(await db.prepare('SELECT 1 FROM service_claim_costs WHERE expense_id = ? LIMIT 1').bind(expenseId).first());
}

const installedDbs = new WeakMap<object, true>();
/** Is migration 0236 on this database? Only «present» is remembered (a later migration is seen at once). */
export async function careClaimsInstalled(db: D1Database): Promise<boolean> {
  if (installedDbs.has(db as object)) return true;
  try {
    await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM care_claim_benefits WHERE 0) AS a, (SELECT COUNT(*) FROM service_claim_costs WHERE 0) AS b,
                (SELECT COUNT(*) FROM printer_care_policies WHERE 0) AS c, (SELECT claim_kind FROM warranty_claims WHERE 0) AS d`
      )
      .first();
    installedDbs.set(db as object, true);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ entitlement

export type CareState = 'none' | 'not_delivered' | 'active' | 'expired' | 'closed' | 'terms_missing';

export interface CareEntitlement {
  state: CareState;
  /** The unit asked about, and the device's root unit the Care (and its caps) belong to. */
  unit_id: string;
  root_unit_id: string;
  /** The order line that sold the Care (the root unit's line), or null when none did. */
  order_item_id: string | null;
  policy_version: number | null;
  /** The Care bought (12), as before. The cover itself is `total_months` from delivery. */
  months: number;
  /** The warranty months bought with the printer (0 | 12 | 24), from the line's frozen services. */
  warranty_months: number;
  /** The whole Care cover from delivery: warranty_months + 12 after it (DECISIONS row 358). 0 without Care. */
  total_months: number;
  start_at: string | null;
  end_at: string | null;
  /** The day Care becomes the device's only cover (delivery + warranty_months); null before delivery. */
  care_only_from: string | null;
  /**
   * The caps (D5): a claim counts once when it has an approved benefit or a USED part offer; the money is the
   * approved benefits plus the discount each used part offer actually gave.
   */
  used_claims: number;
  used_benefit_iqd: number;
  /** What each claim used (approved benefit + used part offers): the desk prices a claim against the others. */
  usage: Array<{ claim_id: string; benefit_iqd: number }>;
  /** null when no terms are known. */
  claims_left: number | null;
  /** null when no terms are known, or the terms set no money cap. */
  benefit_left_iqd: number | null;
  terms: CareTerms | null;
}

interface UnitLink {
  id: string;
  order_item_id: string | null;
  delivered_at: string | null;
  replacement_of_unit_id: string | null;
  warranty_closed_at: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * The Care of each unit, judged at `atMs` (a claim is judged at the day it was filed; a device card
 * today). Units unknown to the database are absent from the map. Call only where
 * `careClaimsInstalled` said yes — every statement here reads 0236.
 */
export async function careEntitlements(db: D1Database, unitIds: string[], atMs = Date.now()): Promise<Map<string, CareEntitlement>> {
  const out = new Map<string, CareEntitlement>();
  const asked = [...new Set(unitIds.filter(Boolean))];
  if (!asked.length) return out;
  const units = new Map<string, UnitLink>();
  let frontier = asked;
  for (let hop = 0; hop <= MAX_REPLACEMENT_HOPS && frontier.length; hop++) {
    const { results } = await db
      .prepare(
        `SELECT id, order_item_id, delivered_at, replacement_of_unit_id, warranty_closed_at
           FROM order_item_units WHERE id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(frontier))
      .all<UnitLink>();
    for (const u of results ?? []) units.set(u.id, u);
    frontier = [...new Set((results ?? []).map((u) => u.replacement_of_unit_id).filter((x): x is string => !!x && !units.has(x)))];
  }
  const rootOf = (id: string): UnitLink | null => {
    let u = units.get(id) ?? null;
    for (let i = 0; u && u.replacement_of_unit_id && units.has(u.replacement_of_unit_id) && i < MAX_REPLACEMENT_HOPS; i++) {
      u = units.get(u.replacement_of_unit_id)!;
    }
    return u;
  };
  const roots = new Map<string, UnitLink>();
  for (const id of asked) {
    const r = rootOf(id);
    if (r) roots.set(id, r);
  }
  const lineIds = [...new Set([...roots.values()].map((r) => r.order_item_id).filter((x): x is string => !!x))];
  const rootIds = [...new Set([...roots.values()].map((r) => r.id))];
  const [lines, usage] = await Promise.all([
    lineIds.length
      ? db
          .prepare('SELECT id, services_snapshot FROM order_items WHERE id IN (SELECT value FROM json_each(?)) AND services_snapshot IS NOT NULL')
          .bind(JSON.stringify(lineIds))
          .all<{ id: string; services_snapshot: string }>()
      : Promise.resolve({ results: [] as Array<{ id: string; services_snapshot: string }> }),
    db
      .prepare(
        `SELECT entitlement_unit_id AS id, claim_id, benefit_iqd AS s FROM care_claim_benefits
          WHERE state = 'approved' AND entitlement_unit_id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(rootIds))
      .all<{ id: string; claim_id: string; s: number }>(),
  ]);
  // D5: a part offer the customer USED (its coupon spent on a live order) counts with the discount it gave.
  const partUse = await usedPartOffers(db, rootIds);
  const care = new Map<string, { months: number; version: number; warranty: number; total: number }>();
  for (const l of lines.results ?? []) {
    let v: { care_months?: unknown; care_total_months?: unknown; warranty_months?: unknown; lines?: Array<{ service?: unknown; policy_version?: unknown }> } | null = null;
    try { v = JSON.parse(l.services_snapshot); } catch { v = null; }
    const months = num(v?.care_months);
    if (!v || !(months > 0)) continue;
    const line = Array.isArray(v.lines) ? v.lines.find((x) => x?.service === 'care') : undefined;
    const version = Number.isInteger(line?.policy_version) && (line!.policy_version as number) >= 1 ? (line!.policy_version as number) : 1;
    // Care runs for the warranty and twelve months after it (owner 2026-11-18). A line frozen before the
    // snapshot carried `care_total_months` is computed from its own two figures.
    const warranty = Math.max(0, Math.trunc(num(v.warranty_months)));
    const total = num(v.care_total_months) > 0 ? Math.trunc(num(v.care_total_months)) : warranty + Math.trunc(months);
    care.set(l.id, { months: Math.trunc(months), version, warranty, total });
  }
  const policies = await carePolicies(db, [...care.values()].map((c) => c.version));
  const byRoot = new Map<string, Map<string, number>>();
  const addUse = (root: string, claim: string, iqd: number) => {
    const m = byRoot.get(root) ?? new Map<string, number>();
    m.set(claim, (m.get(claim) ?? 0) + iqd);
    byRoot.set(root, m);
  };
  for (const u of usage.results ?? []) addUse(u.id, u.claim_id, num(u.s));
  for (const u of partUse) addUse(u.entitlement_unit_id, u.claim_id, num(u.discount_iqd));
  for (const id of asked) {
    const unit = units.get(id);
    const root = roots.get(id);
    if (!unit || !root) continue;
    const c = root.order_item_id ? care.get(root.order_item_id) : undefined;
    const usageOfRoot = [...(byRoot.get(root.id) ?? new Map<string, number>())].map(([claim_id, benefit_iqd]) => ({ claim_id, benefit_iqd }));
    const u = { n: usageOfRoot.length, s: usageOfRoot.reduce((sum, x) => sum + x.benefit_iqd, 0) };
    const base: CareEntitlement = {
      state: 'none', unit_id: id, root_unit_id: root.id, order_item_id: c ? root.order_item_id : null,
      policy_version: c?.version ?? null, months: c?.months ?? 0, warranty_months: c?.warranty ?? 0, total_months: c?.total ?? 0,
      start_at: null, end_at: null, care_only_from: null,
      used_claims: u.n, used_benefit_iqd: u.s, usage: usageOfRoot, claims_left: null, benefit_left_iqd: null, terms: null,
    };
    if (!c) { out.set(id, base); continue; }
    const terms = policies.get(c.version) ?? null;
    const start = root.delivered_at;
    const end = start ? addMonths(start, c.total) : null;
    const careOnlyFrom = start ? (c.warranty > 0 ? addMonths(start, c.warranty) : start) : null;
    const left = terms
      ? {
          claims_left: Math.max(0, num(terms.max_claims) - u.n),
          benefit_left_iqd: terms.max_benefit_iqd === null || terms.max_benefit_iqd === undefined ? null : Math.max(0, num(terms.max_benefit_iqd) - u.s),
        }
      : { claims_left: null, benefit_left_iqd: null };
    const filled = { ...base, start_at: start, end_at: end, care_only_from: careOnlyFrom, terms, ...left };
    let state: CareState;
    // Owner ruling D5: Care follows the device and ends when it comes back (a return closes the unit).
    if (unit.warranty_closed_at && Date.parse(unit.warranty_closed_at) <= atMs) state = 'closed';
    else if (!start) state = 'not_delivered';
    else if (!end || Date.parse(end) <= atMs || Date.parse(start) > atMs) state = 'expired';
    else if (!terms) state = 'terms_missing';
    else state = 'active';
    out.set(id, { ...filled, state });
  }
  return out;
}

/**
 * The part offers USED on these root units (migration 0243): the offer's coupon is spent on a live order — in the
 * extras, where an offer always rides, or (never written, read for safety) as an order's own coupon. A cancelled
 * order released the use, so it no longer counts. [] on a database without 0243.
 */
async function usedPartOffers(db: D1Database, rootIds: string[]): Promise<Array<{ entitlement_unit_id: string; claim_id: string; discount_iqd: number }>> {
  if (!rootIds.length) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT g.entitlement_unit_id, g.claim_id,
                COALESCE((SELECT x.amount_iqd FROM coupon_redemption_extras x WHERE x.coupon_id = g.coupon_id AND x.state = 'active' LIMIT 1),
                         (SELECT r.amount_iqd FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active' LIMIT 1)) AS discount_iqd
           FROM care_part_grants g
          WHERE g.entitlement_unit_id IN (SELECT value FROM json_each(?))
            AND (EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = g.coupon_id AND x.state = 'active')
              OR EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active'))`
      )
      .bind(JSON.stringify(rootIds))
      .all<{ entitlement_unit_id: string; claim_id: string; discount_iqd: number | null }>();
    return (results ?? []).map((r) => ({ entitlement_unit_id: r.entitlement_unit_id, claim_id: r.claim_id, discount_iqd: num(r.discount_iqd) }));
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
}

/** What the customer reads of a device's Care: the window, what is left, and the terms they bought. */
export function carePublic(e: CareEntitlement | null | undefined) {
  if (!e || e.state === 'none') return null;
  return {
    state: e.state,
    policy_version: e.policy_version,
    start_at: e.start_at,
    end_at: e.end_at,
    // Phase 5: the cover's length from delivery (warranty + 12), and the day Care becomes the only cover.
    warranty_months: e.warranty_months,
    total_months: e.total_months,
    care_only_from: e.care_only_from,
    claims_left: e.claims_left,
    benefit_left_iqd: e.benefit_left_iqd,
    discount_pct: e.terms?.discount_pct ?? null,
    labor: e.terms?.labor ?? null,
    shipping: e.terms?.shipping ?? null,
    eligible_parts: e.terms?.eligible_parts ?? [],
    exclusions: e.terms?.exclusions ?? [],
  };
}

// ------------------------------------------------------------------ the quote

export interface CareQuotePart { key: string; qty: number; unit_iqd: number }
export interface CareQuoteInput {
  parts: CareQuotePart[];
  labor_iqd: number;
  shipping_iqd: number;
  /** Work Care does not cover (a part outside the list), at full price. */
  other_iqd: number;
  note: string;
}
export interface PricedCareQuote extends CareQuoteInput {
  parts_iqd: number;
  list_iqd: number;
  eligible_iqd: number;
  discount_pct: number;
  benefit_iqd: number;
  copay_iqd: number;
}

const MAX_IQD = 100_000_000;
const intIn = (v: unknown, name: string, min: number, max: number, def?: number): number => {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${name}: a whole number from ${min} to ${max}`, 'CARE_QUOTE_INVALID');
  return n;
};

/** The desk's quote as sent; integers only, sizes capped. Refuses 400 CARE_QUOTE_INVALID. */
export function parseCareQuote(body: Record<string, unknown>): CareQuoteInput {
  const rawParts = body.parts === undefined ? [] : body.parts;
  if (!Array.isArray(rawParts) || rawParts.length > 20) throw new HttpError(400, 'parts: at most 20', 'CARE_QUOTE_INVALID');
  const parts = rawParts.map((p: unknown, i) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key || o.key.length > 32) throw new HttpError(400, `parts[${i}].key`, 'CARE_QUOTE_INVALID');
    return { key: o.key, qty: intIn(o.qty, `parts[${i}].qty`, 1, 20, 1), unit_iqd: intIn(o.unit_iqd, `parts[${i}].unit_iqd`, 0, MAX_IQD) };
  });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  return {
    parts,
    labor_iqd: intIn(body.labor_iqd, 'labor_iqd', 0, MAX_IQD, 0),
    shipping_iqd: intIn(body.shipping_iqd, 'shipping_iqd', 0, MAX_IQD, 0),
    other_iqd: intIn(body.other_iqd, 'other_iqd', 0, MAX_IQD, 0),
    note,
  };
}

/**
 * THE ONE PRICE OF A CARE QUOTE. `used` = the claims and the discount already APPROVED on the
 * device (this claim's own quote never counts against itself). Refuses CARE_PART_NOT_ELIGIBLE
 * (a part outside the terms) and CARE_CLAIM_LIMIT (no claim left). The money cap never refuses:
 * the benefit is what is left of it (possibly 0) and the co-pay the rest.
 */
export function priceCareQuote(terms: CareTerms, q: CareQuoteInput, used: { claims: number; benefit_iqd: number }): PricedCareQuote {
  const keys = new Set(terms.eligible_parts.map((p) => p.key));
  for (const p of q.parts) if (!keys.has(p.key)) throw careRefusal('CARE_PART_NOT_ELIGIBLE', 400, { part_key: p.key });
  if (num(used.claims) >= num(terms.max_claims)) throw careRefusal('CARE_CLAIM_LIMIT');
  const partsIqd = q.parts.reduce((s, p) => s + p.qty * p.unit_iqd, 0);
  const list = partsIqd + q.labor_iqd + q.shipping_iqd + q.other_iqd;
  if (!Number.isSafeInteger(list) || list > 1_000_000_000) throw new HttpError(400, 'The quote is too large', 'CARE_QUOTE_INVALID');
  const eligible = partsIqd + (terms.labor === 'discounted' ? q.labor_iqd : 0) + (terms.shipping === 'discounted' ? q.shipping_iqd : 0);
  const pct = Math.max(0, Math.min(90, Math.trunc(num(terms.discount_pct))));
  const raw = Math.floor((eligible * pct) / 100);
  const capLeft = terms.max_benefit_iqd === null || terms.max_benefit_iqd === undefined ? Infinity : Math.max(0, num(terms.max_benefit_iqd) - num(used.benefit_iqd));
  const benefit = Math.max(0, Math.min(raw, capLeft));
  return { ...q, parts_iqd: partsIqd, list_iqd: list, eligible_iqd: eligible, discount_pct: pct, benefit_iqd: benefit, copay_iqd: list - benefit };
}

// ------------------------------------------------------------------ the benefit row

export interface CareBenefitRow {
  id: string;
  claim_id: string;
  entitlement_unit_id: string;
  order_item_id: string;
  policy_version: number;
  quote_json: string;
  list_iqd: number;
  eligible_iqd: number;
  discount_pct: number;
  benefit_iqd: number;
  copay_iqd: number;
  state: 'quoted' | 'accepted' | 'approved' | 'void';
  version: number;
  quoted_by: string | null;
  quoted_at: string;
  customer_accepted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decided_day: string | null;
  copay_collected_at: string | null;
  copay_collected_by: string | null;
  copay_collected_day: string | null;
  copay_operation_id: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

/**
 * The quote as the customer reads it: the lines (each part named in their language by the terms),
 * the figures, the state. Never who quoted or decided, never a cost of the claim.
 */
export function careQuotePublic(b: CareBenefitRow | null | undefined, terms: CareTerms | null, opts: { admin?: boolean } = {}) {
  if (!b) return null;
  let q: Partial<PricedCareQuote> = {};
  try { q = JSON.parse(b.quote_json) as PricedCareQuote; } catch { q = {}; }
  const label = new Map((terms?.eligible_parts ?? []).map((p) => [p.key, p.label]));
  return {
    state: b.state,
    version: num(b.version),
    policy_version: num(b.policy_version),
    parts: (q.parts ?? []).map((p) => ({ key: p.key, label: label.get(p.key) ?? null, qty: num(p.qty), unit_iqd: num(p.unit_iqd), total_iqd: num(p.qty) * num(p.unit_iqd) })),
    labor_iqd: num(q.labor_iqd),
    shipping_iqd: num(q.shipping_iqd),
    other_iqd: num(q.other_iqd),
    note: typeof q.note === 'string' ? q.note : '',
    list_iqd: num(b.list_iqd),
    eligible_iqd: num(b.eligible_iqd),
    discount_pct: num(b.discount_pct),
    benefit_iqd: num(b.benefit_iqd),
    copay_iqd: num(b.copay_iqd),
    quoted_at: b.quoted_at,
    customer_accepted_at: b.customer_accepted_at ?? null,
    decided_at: b.decided_at ?? null,
    copay_collected: !!b.copay_collected_at,
    voided_at: b.voided_at ?? null,
    ...(opts.admin
      ? {
          quoted_by: b.quoted_by ?? null,
          decided_by: b.decided_by ?? null,
          decided_day: b.decided_day ?? null,
          copay_collected_at: b.copay_collected_at ?? null,
          copay_collected_by: b.copay_collected_by ?? null,
          copay_collected_day: b.copay_collected_day ?? null,
          voided_by: b.voided_by ?? null,
          void_reason: b.void_reason ?? null,
          entitlement_unit_id: b.entitlement_unit_id,
          order_item_id: b.order_item_id,
        }
      : {}),
  };
}

export async function careBenefitOf(db: D1Database, claimId: string): Promise<CareBenefitRow | null> {
  return db.prepare('SELECT * FROM care_claim_benefits WHERE claim_id = ?').bind(claimId).first<CareBenefitRow>();
}

// ------------------------------------------------------------------ claim costs

export const CLAIM_COST_KINDS = ['part_purchase', 'labor', 'courier', 'replacement', 'other'] as const;
export type ClaimCostKind = (typeof CLAIM_COST_KINDS)[number];
export const CLAIM_COST_KIND_TEXT: Record<ClaimCostKind, Text3> = {
  part_purchase: { ar: 'شراء قطعة', en: 'Part bought', ckb: 'کڕینی پارچە' },
  labor: { ar: 'أجرة عمل', en: 'Labour', ckb: 'کرێی کار' },
  courier: { ar: 'توصيل', en: 'Courier', ckb: 'گەیاندن' },
  replacement: { ar: 'جهاز بديل', en: 'Replacement device', ckb: 'ئامێری جێگرەوە' },
  other: { ar: 'أخرى', en: 'Other', ckb: 'هی تر' },
};
/** The expense category a claim's cost is booked under (0236 seeds both). */
export const CLAIM_COST_CATEGORY: Record<'warranty' | 'care', string> = {
  warranty: 'exp_warranty_claims',
  care: 'exp_care_claims',
};

/** Account 4300 (0236): the co-pay as service income (owner ruling D2). */
export const SERVICE_INCOME_ACCOUNT = {
  code: '4300',
  name: { ar: 'إيرادات خدمات الصيانة', en: 'Repair service income', ckb: 'داهاتی خزمەتگوزارییەکانی چاککردنەوە' } as Text3,
} as const;

export interface ServiceClaimCostRow {
  id: string;
  claim_id: string;
  claim_kind: 'warranty' | 'care';
  kind: ClaimCostKind;
  amount_iqd: number;
  cost_day: string;
  expense_id: string;
  operation_id: string;
  note: string;
  created_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export function claimCostPublic(r: ServiceClaimCostRow) {
  return {
    id: r.id,
    claim_id: r.claim_id,
    claim_kind: r.claim_kind,
    kind: r.kind,
    amount_iqd: num(r.amount_iqd),
    cost_day: r.cost_day,
    expense_id: r.expense_id,
    note: r.note ?? '',
    created_by: r.created_by,
    created_at: r.created_at,
    voided: !!r.voided_at,
    voided_at: r.voided_at ?? null,
    voided_by: r.voided_by ?? null,
    void_reason: r.void_reason ?? null,
  };
}

/** Each claim's Care summary and live cost total, for the desk queue (one statement; empty when 0236 is absent). */
export async function claimMoneySummaries(db: D1Database, claimIds: string[]): Promise<Map<string, { benefit: { state: string; benefit_iqd: number; copay_iqd: number } | null; costs_total_iqd: number }>> {
  const out = new Map<string, { benefit: { state: string; benefit_iqd: number; copay_iqd: number } | null; costs_total_iqd: number }>();
  if (!claimIds.length || !(await careClaimsInstalled(db))) return out;
  const { results } = await db
    .prepare(
      `SELECT j.value AS id, b.state, b.benefit_iqd, b.copay_iqd,
              (SELECT COALESCE(SUM(c.amount_iqd), 0) FROM service_claim_costs c WHERE c.claim_id = j.value AND c.voided_at IS NULL) AS costs_total_iqd
         FROM json_each(?) j LEFT JOIN care_claim_benefits b ON b.claim_id = j.value`
    )
    .bind(JSON.stringify([...new Set(claimIds)]))
    .all<{ id: string; state: string | null; benefit_iqd: number | null; copay_iqd: number | null; costs_total_iqd: number }>();
  for (const r of results ?? []) {
    out.set(r.id, {
      benefit: r.state ? { state: r.state, benefit_iqd: num(r.benefit_iqd), copay_iqd: num(r.copay_iqd) } : null,
      costs_total_iqd: num(r.costs_total_iqd),
    });
  }
  return out;
}
