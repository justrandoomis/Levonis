/**
 * THE WORDS FOR EVERY ELIGIBILITY REASON (W5-B) — the client half of the
 * stable codes worker/lib/eligibility.ts returns. The server never sends a
 * sentence; this maps each code to what the workshop can DO about it.
 * tests/eligibility.test.ts holds `REASON_CODES` equal to the server's list,
 * so a new reason cannot reach a merchant as a raw code.
 *
 * OWNER: Sorani to be written by hand. Every line below is Arabic and English
 * only (DECISIONS row 11); `loc` shows the Arabic to Sorani readers.
 */
import type { Loc } from '../dashboard/ui';

export const REASON_CODES = [
  'REQUEST_CLOSED', 'OWN_REQUEST', 'MERCHANT_INACTIVE', 'STORE_UNAVAILABLE', 'PLAN_LAPSED', 'NOT_TAKING_REQUESTS',
  'NO_PRINTER', 'PROCESS', 'BUILD_VOLUME', 'MATERIAL', 'ENCLOSURE', 'HARDENED_NOZZLE', 'QUALITY', 'NOZZLE', 'MULTICOLOR',
  'STOCK_MATERIAL', 'STOCK_COLOR', 'STOCK_GRAMS',
  'REACH_DELIVERY', 'REACH_PICKUP',
  'PREF_PROCESS', 'PREF_MATERIAL', 'PREF_COLOR', 'PREF_CAPABILITY', 'PREF_GOVERNORATE', 'PREF_DELIVERY', 'PREF_SIZE',
  'PREF_JOB_TOO_SMALL', 'PREF_JOB_TOO_LARGE',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonDimension = 'trade' | 'capability' | 'stock' | 'reach' | 'preference';

/** Where the workshop fixes it — the screen a reason points at. */
export type ReasonFix = 'printers' | 'stock' | 'preferences' | 'delivery' | 'store' | 'plan' | null;

export function reasonDimension(code: string): ReasonDimension {
  if (code.startsWith('PREF_')) return 'preference';
  if (code.startsWith('STOCK_')) return 'stock';
  if (code.startsWith('REACH_')) return 'reach';
  if (['REQUEST_CLOSED', 'OWN_REQUEST', 'MERCHANT_INACTIVE', 'STORE_UNAVAILABLE', 'PLAN_LAPSED', 'NOT_TAKING_REQUESTS'].includes(code)) return 'trade';
  return 'capability';
}

export function reasonFix(code: string): ReasonFix {
  const d = reasonDimension(code);
  if (d === 'capability') return 'printers';
  if (d === 'stock') return 'stock';
  if (d === 'preference') return 'preferences';
  if (d === 'reach') return 'delivery';
  if (code === 'PLAN_LAPSED') return 'plan';
  if (code === 'STORE_UNAVAILABLE' || code === 'NOT_TAKING_REQUESTS') return 'store';
  return null;
}

/** One sentence per reason: what is true, and what would change it. */
export function reasonText(code: string, loc: Loc): string {
  switch (code) {
    case 'REQUEST_CLOSED':
      return loc('الطلب لم يعد يستقبل عروضًا.', 'The request no longer takes offers.');
    case 'OWN_REQUEST':
      return loc('هذا طلبك أنت.', 'This is your own request.');
    case 'MERCHANT_INACTIVE':
      return loc('حساب التاجر ليس مفعّلًا الآن.', 'Your merchant account is not active right now.');
    case 'STORE_UNAVAILABLE':
      return loc('متجرك متوقف — افتحه من «إعدادات المتجر».', 'Your store is paused — reopen it in Store settings.');
    case 'PLAN_LAPSED':
      return loc('اشتراكك لا يشمل عروض المجتمع الآن.', 'Your plan does not include community offers right now.');
    case 'NOT_TAKING_REQUESTS':
      return loc('متجرك لا يستقبل الطلبات المخصصة — فعّلها من «إعدادات المتجر».', 'Your store is not taking custom requests — turn them on in Store settings.');
    case 'NO_PRINTER':
      return loc('لا توجد طابعة مفعّلة وغير متوقفة.', 'You have no active printer that is not offline.');
    case 'PROCESS':
      return loc('التقنية المطلوبة (FDM أو ريزن) ليست في طابعاتك.', 'None of your printers uses the requested technology (FDM or resin).');
    case 'BUILD_VOLUME':
      return loc('القطعة أكبر من مساحة الطباعة في كل طابعاتك، بأي اتجاه توضع.', 'The part is larger than every build volume you have, in any orientation.');
    case 'MATERIAL':
      return loc('الخامة المطلوبة ليست ضمن ما تطبعه طابعاتك.', 'The material is not one your printers run.');
    case 'ENCLOSURE':
      return loc('الخامة تحتاج حجرة مغلقة لا تملكها طابعاتك.', 'The material needs an enclosed printer, and yours are open.');
    case 'HARDENED_NOZZLE':
      return loc('الخامة كاشطة وتحتاج فوهة مقوّاة.', 'The material is abrasive and needs a hardened nozzle.');
    case 'QUALITY':
      return loc('الطلب يحتاج دقة أعلى من أقصى دقة سجّلتها لطابعاتك.', 'The job needs finer quality than your printers’ best.');
    case 'NOZZLE':
      return loc('الدقة العالية تحتاج فوهة 0.4 مم أو أدق.', 'Fine detail needs a 0.4 mm nozzle or smaller.');
    case 'MULTICOLOR':
      return loc('الطلب بعدة ألوان وطابعاتك تطبع لونًا واحدًا في المرة.', 'The job has several colours and your printers print one at a time.');
    case 'STOCK_MATERIAL':
      return loc('الخامة غير موجودة في مخزونك.', 'The material is not in your stock.');
    case 'STOCK_COLOR':
      return loc('اللون المطلوب غير موجود في مخزونك من هذه الخامة.', 'That colour of this material is not in your stock.');
    case 'STOCK_GRAMS':
      return loc('مخزونك من هذه الخامة أقل مما يحتاجه الطلب.', 'You have less of this material than the job needs.');
    case 'REACH_DELIVERY':
      return loc('توصيل متجرك لا يصل إلى محافظة العميل.', 'Your store does not deliver to the customer’s governorate.');
    case 'REACH_PICKUP':
      return loc('العميل يريد الاستلام بنفسه، والاستلام ليس متاحًا في محافظته عندك.', 'The customer wants to collect, and you offer no pickup in their governorate.');
    case 'PREF_PROCESS':
      return loc('استبعدت هذه التقنية في تفضيلاتك.', 'You excluded this technology in your preferences.');
    case 'PREF_MATERIAL':
      return loc('الخامة خارج الخامات التي اخترتها في تفضيلاتك.', 'The material is outside the ones you picked in your preferences.');
    case 'PREF_COLOR':
      return loc('اللون خارج الألوان التي اخترتها في تفضيلاتك.', 'The colour is outside the ones you picked in your preferences.');
    case 'PREF_CAPABILITY':
      return loc('الطلب يحتاج قدرة استبعدتها في تفضيلاتك.', 'The job needs a capability you filtered out.');
    case 'PREF_GOVERNORATE':
      return loc('محافظة العميل خارج المحافظات التي اخترتها.', 'The customer’s governorate is outside the ones you picked.');
    case 'PREF_DELIVERY':
      return loc('طريقة الاستلام خارج ما اخترته في تفضيلاتك.', 'The handover is outside what you picked in your preferences.');
    case 'PREF_SIZE':
      return loc('مقاس القطعة خارج نطاق المقاسات الذي وضعته.', 'The part’s size is outside the range you set.');
    case 'PREF_JOB_TOO_SMALL':
      return loc('قيمة الطلب التقديرية أقل من حدّك الأدنى.', 'The estimated job value is below your minimum.');
    case 'PREF_JOB_TOO_LARGE':
      return loc('قيمة الطلب التقديرية أعلى من حدّك الأعلى.', 'The estimated job value is above your maximum.');
    default:
      return loc('لم يُسجَّل سبب لهذا القرار.', 'No reason was recorded for this decision.');
  }
}

/** The label of the screen a fix lives on. */
export function fixLabel(fix: ReasonFix, loc: Loc): string {
  switch (fix) {
    case 'printers':
      return loc('طابعاتي', 'My printers');
    case 'stock':
      return loc('المخزون', 'Stock');
    case 'preferences':
      return loc('التفضيلات', 'Preferences');
    case 'delivery':
      return loc('التوصيل', 'Delivery');
    case 'store':
      return loc('إعدادات المتجر', 'Store settings');
    case 'plan':
      return loc('الاشتراك', 'Membership');
    default:
      return '';
  }
}
