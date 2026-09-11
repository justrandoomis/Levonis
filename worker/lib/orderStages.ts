/**
 * Order tracking: five stages for a direct order, fourteen for a pre-order,
 * and the rules that move an order between them.
 *
 * WHY A SEPARATE COLUMN. `orders.status` has carried a CHECK constraint since
 * migration 0001 pinning it to six values (pending … cancelled), and every
 * existing reader — the stock lifecycle, the invoice writer, the admin filter,
 * the customer's order list — is built on those six. Nineteen tracking stages
 * cannot be forced into that column without either dropping the constraint or
 * rewriting all of them. So the stage lives in `orders.stage` and every stage
 * maps DOWN to one of the six. The legacy column stays the authority for
 * money and stock; the stage is the authority for what the customer is told.
 *
 * WHY THE TIMING IS HERE AND NOT IN THE BROWSER. The owner was explicit:
 * "لا تستخدم timers داخل الواجهة أو setTimeout". A timer in a tab dies when
 * the tab does, fires twice when the customer opens two, and never fires at
 * all for the customer who is asleep. The order carries its own schedule —
 * `next_stage`, `next_stage_at` — and a cron sweep promotes whatever is due.
 * This file computes that schedule and nothing else: no database, no clock of
 * its own, no I/O. Everything takes `now` as an argument so a test can put the
 * order anywhere in time.
 *
 * WHY TIMERS START AT ENTRY, NOT AT CHECKOUT. "المؤقتات تبدأ دائمًا من وقت
 * دخول الطلب إلى الحالة الحالية، وليس من وقت إنشاء الطلب." An order confirmed
 * three days after it was placed must wait the configured minutes from the
 * confirmation, not arrive pre-expired. So every duration below is measured
 * from `stage_changed_at`.
 */

import type { ShippingType } from './shippingType';

export type StageSource = 'manual' | 'automatic' | 'delivery_api';

export type OrderStage =
  // shared head
  | 'received'
  | 'confirmed'
  // direct only
  | 'preparing'
  // pre-order only
  | 'supplier_preparing'
  | 'at_origin_warehouse'
  | 'preparing_freight'
  | 'handed_to_carrier'
  | 'left_origin_warehouse'
  | 'en_route_to_iraq'
  | 'arrived_iraq'
  | 'en_route_to_levo'
  | 'at_levo_warehouse'
  | 'local_delivery_prep'
  // shared tail
  | 'out_for_delivery'
  | 'delivered'
  // off-path
  | 'cancelled';

/** المسار: تتبع الشحن المباشر — five stages, in order. */
export const DIRECT_STAGES: OrderStage[] = [
  'received',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
];

/** تتبع الطلب المسبق Air / Sea / Land — fourteen stages, in order. */
export const PREORDER_STAGES: OrderStage[] = [
  'received',
  'confirmed',
  'supplier_preparing',
  'at_origin_warehouse',
  'preparing_freight',
  'handed_to_carrier',
  'left_origin_warehouse',
  'en_route_to_iraq',
  'arrived_iraq',
  'en_route_to_levo',
  'at_levo_warehouse',
  'local_delivery_prep',
  'out_for_delivery',
  'delivered',
];

export function stagesFor(shippingType: ShippingType): OrderStage[] {
  return shippingType === 'direct' ? DIRECT_STAGES : PREORDER_STAGES;
}

/**
 * Who moves the order out of each stage.
 *
 *   manual        — an admin confirms something they actually know
 *   automatic     — the cron promotes it once the configured time has passed
 *   delivery_api  — only the courier's API may say this happened
 *
 * `delivery_api` is deliberately NOT `automatic`. The owner ruled out timers
 * for the last two stages — "لا تستخدم Timer للانتقال إلى في الطريق إليك أو
 * تم التوصيل" — because a guess about a delivery is a lie the customer can
 * check by looking out of the window. The cron never promotes these; the
 * courier sync or an admin acting as the documented fallback does.
 */
export const STAGE_SOURCE: Record<OrderStage, StageSource> = {
  received: 'automatic',
  confirmed: 'manual',
  preparing: 'automatic',
  supplier_preparing: 'automatic',
  at_origin_warehouse: 'manual',
  preparing_freight: 'automatic',
  handed_to_carrier: 'automatic',
  left_origin_warehouse: 'automatic',
  en_route_to_iraq: 'automatic',
  arrived_iraq: 'manual',
  en_route_to_levo: 'automatic',
  at_levo_warehouse: 'manual',
  local_delivery_prep: 'manual',
  out_for_delivery: 'delivery_api',
  delivered: 'delivery_api',
  cancelled: 'manual',
};

/**
 * Every stage maps to one of the six legacy statuses.
 *
 * The mapping is what keeps the stock lifecycle honest: `confirmed` and
 * everything after it maps to a status inside STOCK_DEDUCTED_STATES, so an
 * order that reaches a warehouse has already taken its units out of
 * inventory, exactly as before this file existed.
 */
export const STAGE_LEGACY_STATUS: Record<OrderStage, string> = {
  received: 'pending',
  confirmed: 'confirmed',
  preparing: 'processing',
  supplier_preparing: 'processing',
  at_origin_warehouse: 'processing',
  preparing_freight: 'processing',
  handed_to_carrier: 'shipped',
  left_origin_warehouse: 'shipped',
  en_route_to_iraq: 'shipped',
  arrived_iraq: 'shipped',
  en_route_to_levo: 'shipped',
  at_levo_warehouse: 'processing',
  local_delivery_prep: 'processing',
  out_for_delivery: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/**
 * The stage an order sits in when an admin sets the legacy status by hand.
 *
 * Several stages share a legacy status, so this is lossy on purpose: it picks
 * the EARLIEST stage carrying that status, which is the only choice that can
 * never claim more progress than the admin actually asserted. Moving an order
 * to "shipped" must not silently tell the customer it already reached Iraq.
 */
export function stageForLegacyStatus(status: string, shippingType: ShippingType): OrderStage {
  const path = stagesFor(shippingType);
  if (status === 'cancelled') return 'cancelled';
  const found = path.find((s) => STAGE_LEGACY_STATUS[s] === status);
  return found ?? 'received';
}

// --------------------------------------------------------------- the labels

interface StageText { ar: string; en: string; ckb: string }

/**
 * Owner-authored, never machine-translated. Stage 5 of the pre-order path
 * names the freight mode — "جارٍ التجهيز للشحن الجوي / البحري / البري" — so
 * it is resolved per shipping type rather than stored as a single string.
 */
const FREIGHT_WORD: Record<ShippingType, StageText> = {
  direct: { ar: 'المحلي', en: 'local', ckb: 'ناوخۆیی' },
  preorder_air: { ar: 'الجوي', en: 'air', ckb: 'ئاسمانی' },
  preorder_sea: { ar: 'البحري', en: 'sea', ckb: 'دەریایی' },
  preorder_land: { ar: 'البري', en: 'land', ckb: 'وشکانی' },
};

const STAGE_TEXT: Record<OrderStage, StageText> = {
  received: { ar: 'تم استلام الطلب', en: 'Order received', ckb: 'داواکاری وەرگیرا' },
  confirmed: { ar: 'تم تأكيد الطلب', en: 'Order confirmed', ckb: 'داواکاری پەسەندکرا' },
  preparing: { ar: 'جارٍ تجهيز الطلب', en: 'Preparing your order', ckb: 'داواکارییەکەت ئامادە دەکرێت' },
  supplier_preparing: {
    ar: 'جارٍ تجهيز الطلب لدى المورد',
    en: 'Being prepared at the supplier',
    ckb: 'لای دابینکەر ئامادە دەکرێت',
  },
  at_origin_warehouse: {
    ar: 'وصل إلى مخزن بلد المصدر',
    en: 'Arrived at the origin-country warehouse',
    ckb: 'گەیشتە کۆگای وڵاتی سەرچاوە',
  },
  // Placeholder text; the real string is built in stageLabel().
  preparing_freight: {
    ar: 'جارٍ التجهيز للشحن',
    en: 'Being prepared for freight',
    ckb: 'بۆ گواستنەوە ئامادە دەکرێت',
  },
  handed_to_carrier: {
    ar: 'تم تسليمه لشركة النقل',
    en: 'Handed to the freight carrier',
    ckb: 'درایە کۆمپانیای گواستنەوە',
  },
  left_origin_warehouse: {
    ar: 'غادر مخزن بلد المصدر',
    en: 'Left the origin-country warehouse',
    ckb: 'کۆگای وڵاتی سەرچاوەی بەجێهێشت',
  },
  en_route_to_iraq: { ar: 'في الطريق إلى العراق', en: 'On the way to Iraq', ckb: 'لە ڕێگەیە بۆ عێراق' },
  arrived_iraq: { ar: 'وصل إلى العراق', en: 'Arrived in Iraq', ckb: 'گەیشتە عێراق' },
  en_route_to_levo: {
    ar: 'في الطريق إلى مخزن LEVO',
    en: 'On the way to the LEVO warehouse',
    ckb: 'لە ڕێگەیە بۆ کۆگای LEVO',
  },
  at_levo_warehouse: { ar: 'وصل إلى مخزن LEVO', en: 'Arrived at the LEVO warehouse', ckb: 'گەیشتە کۆگای LEVO' },
  local_delivery_prep: {
    ar: 'جارٍ تجهيز التوصيل المحلي',
    en: 'Preparing local delivery',
    ckb: 'گەیاندنی ناوخۆیی ئامادە دەکرێت',
  },
  out_for_delivery: { ar: 'في الطريق إليك', en: 'On the way to you', ckb: 'لە ڕێگەیە بۆ لات' },
  delivered: { ar: 'تم التوصيل', en: 'Delivered', ckb: 'گەیەنرا' },
  cancelled: { ar: 'أُلغي الطلب', en: 'Order cancelled', ckb: 'داواکاری هەڵوەشێنرایەوە' },
};

export function stageLabel(stage: OrderStage, shippingType: ShippingType, lang: string): string {
  const pickText = (t: StageText) => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);
  if (stage === 'preparing_freight') {
    const word = pickText(FREIGHT_WORD[shippingType]);
    if (lang === 'en') return `Being prepared for ${word} freight`;
    if (lang === 'ckb') return `بۆ گواستنەوەی ${word} ئامادە دەکرێت`;
    return `جارٍ التجهيز للشحن ${word}`;
  }
  return pickText(STAGE_TEXT[stage]);
}

// ------------------------------------------------------------ the schedule

/**
 * How long an order waits in each AUTOMATIC stage before the sweep promotes
 * it, in minutes. Every one of these is admin-editable — "اجعل جميع مدد
 * الانتقالات التلقائية قابلة للتعديل من إعدادات الإدارة، وخاصة Air / Sea /
 * Land" — these are only the defaults a fresh install starts with.
 *
 * A stage absent from this table is never promoted by the clock: its successor
 * is either manual (an admin knows something the clock does not) or
 * delivery_api (the courier knows). `received` is the notable absence —
 * confirmation is where money and stock become real, so no clock makes it.
 */
export interface StageDurations {
  /** direct: تلقائي بعد التأكيد بمدة قصيرة قابلة للضبط */
  preparing: number;
  /** pre-order: تلقائي بعد التأكيد خلال مدة متغيرة بين 30–120 دقيقة */
  supplier_preparing_min: number;
  supplier_preparing_max: number;
  /** المدة تختلف حسب نوع الشحن — one value per freight mode */
  preparing_freight_air: number;
  preparing_freight_sea: number;
  preparing_freight_land: number;
  /** تلقائي بعد عدة ساعات */
  handed_to_carrier: number;
  left_origin_warehouse: number;
  /** تلقائي بعد حوالي 6–12 ساعة من مغادرة المخزن */
  en_route_to_iraq_min: number;
  en_route_to_iraq_max: number;
  /** تلقائي بعد عدة ساعات من "وصل إلى العراق" */
  en_route_to_levo: number;
}

export const DEFAULT_STAGE_DURATIONS: StageDurations = {
  preparing: 20,
  supplier_preparing_min: 30,
  supplier_preparing_max: 120,
  preparing_freight_air: 12 * 60,
  preparing_freight_sea: 72 * 60,
  preparing_freight_land: 48 * 60,
  handed_to_carrier: 6 * 60,
  left_origin_warehouse: 8 * 60,
  en_route_to_iraq_min: 6 * 60,
  en_route_to_iraq_max: 12 * 60,
  en_route_to_levo: 5 * 60,
};

/** Merges stored admin settings over the defaults, ignoring junk values. */
export function resolveDurations(stored: unknown): StageDurations {
  const out: StageDurations = { ...DEFAULT_STAGE_DURATIONS };
  if (!stored || typeof stored !== 'object') return out;
  const raw = stored as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof StageDurations)[]) {
    const v = raw[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    // A duration of zero would promote instantly, which is a legitimate thing
    // for an owner to want on a test order. A negative or absurd one is not.
    if (Number.isFinite(n) && n >= 0 && n <= 365 * 24 * 60) out[key] = Math.round(n);
  }
  // A range that got saved inverted would otherwise produce a negative wait.
  if (out.supplier_preparing_max < out.supplier_preparing_min) {
    out.supplier_preparing_max = out.supplier_preparing_min;
  }
  if (out.en_route_to_iraq_max < out.en_route_to_iraq_min) {
    out.en_route_to_iraq_max = out.en_route_to_iraq_min;
  }
  return out;
}

/** The stage that follows this one on this order's path, or null at the end. */
export function nextStageOf(stage: OrderStage, shippingType: ShippingType): OrderStage | null {
  if (stage === 'cancelled') return null;
  const path = stagesFor(shippingType);
  const i = path.indexOf(stage);
  if (i < 0 || i === path.length - 1) return null;
  return path[i + 1];
}

/**
 * How many minutes an order waits in `stage` before moving on — or null when
 * nothing but a human or a courier may move it.
 *
 * The two ranges the owner gave (30–120 minutes at the supplier, 6–12 hours in
 * transit to Iraq) are resolved to a single number per order rather than a
 * random draw each time the sweep runs, so an order's promised time cannot
 * move backwards between two checks. `spread` is that order's fixed position
 * in the range, derived from its id by the caller.
 */
export function stageWaitMinutes(
  stage: OrderStage,
  shippingType: ShippingType,
  d: StageDurations,
  spread = 0.5
): number | null {
  const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const inRange = (min: number, max: number) => Math.round(min + (max - min) * clamp(spread));
  switch (stage) {
    // The order sits in `received` until an admin confirms it. The clock never
    // confirms an order on the owner's behalf: confirmation is where money and
    // stock become real, and it is manual for that reason.
    case 'received':
      return null;
    case 'confirmed':
      return shippingType === 'direct'
        ? d.preparing
        : inRange(d.supplier_preparing_min, d.supplier_preparing_max);
    case 'at_origin_warehouse':
      return shippingType === 'preorder_sea'
        ? d.preparing_freight_sea
        : shippingType === 'preorder_land'
          ? d.preparing_freight_land
          : d.preparing_freight_air;
    case 'preparing_freight':
      return d.handed_to_carrier;
    case 'handed_to_carrier':
      return d.left_origin_warehouse;
    case 'left_origin_warehouse':
      return inRange(d.en_route_to_iraq_min, d.en_route_to_iraq_max);
    case 'arrived_iraq':
      return d.en_route_to_levo;
    // Everything else waits on a person or on the courier's API.
    default:
      return null;
  }
}

export interface StageSchedule {
  next_stage: OrderStage | null;
  /** ISO, or null when nothing is scheduled — a manual or courier-owned wait. */
  next_stage_at: string | null;
}

/**
 * The schedule an order takes on the moment it ENTERS `stage`.
 *
 * `enteredAt` is the entry time, not the order's creation time — this is the
 * whole point of the rule. Called on every stage change, automatic or manual,
 * which is how a manual change cancels the transition that was pending: the
 * old next_stage_at is overwritten, never merely ignored.
 */
export function scheduleFrom(
  stage: OrderStage,
  shippingType: ShippingType,
  durations: StageDurations,
  enteredAt: string,
  spread = 0.5
): StageSchedule {
  const next = nextStageOf(stage, shippingType);
  if (!next) return { next_stage: null, next_stage_at: null };
  // Only the CLOCK's stages get a time. A stage whose successor is owned by a
  // person or by the courier is left unscheduled, so the sweep cannot promote
  // it by accident.
  if (STAGE_SOURCE[next] !== 'automatic') return { next_stage: next, next_stage_at: null };
  const wait = stageWaitMinutes(stage, shippingType, durations, spread);
  if (wait === null) return { next_stage: next, next_stage_at: null };
  const at = new Date(new Date(enteredAt).getTime() + wait * 60_000);
  if (Number.isNaN(at.getTime())) return { next_stage: next, next_stage_at: null };
  return { next_stage: next, next_stage_at: at.toISOString() };
}

/**
 * A stable number in [0,1) for an order id, so an order lands at the same
 * point of a 30–120 minute range every time the schedule is recomputed.
 * Not cryptographic and not meant to be — it only has to be stable.
 */
export function spreadFor(orderId: string): number {
  let h = 2166136261;
  for (let i = 0; i < orderId.length; i++) {
    h ^= orderId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Can an admin move an order from `from` to `to` on this path? */
export function canMoveStage(from: OrderStage, to: OrderStage, shippingType: ShippingType): boolean {
  if (from === to) return false;
  if (to === 'cancelled') return from !== 'delivered';
  const path = stagesFor(shippingType);
  if (from === 'cancelled') {
    // Re-opening a cancelled order puts it back on the path, but only at a
    // stage before dispatch — a cancelled order was never on a lorry.
    return path.indexOf(to) >= 0 && path.indexOf(to) <= path.indexOf('confirmed');
  }
  const i = path.indexOf(from);
  const j = path.indexOf(to);
  if (i < 0 || j < 0) return false;
  // Forward to anywhere ahead (an admin who already has the goods should not
  // have to tap through six screens), backward only one step to undo a mis-tap.
  return j > i || j === i - 1;
}
