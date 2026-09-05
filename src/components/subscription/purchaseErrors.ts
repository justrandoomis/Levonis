/**
 * The purchase refusals the server can return, said in the viewer's own
 * language. The server's message is bilingual ar/en in one string; the page
 * maps the CODE and falls back to that string only for a code it has never
 * seen, so nothing is invented and nothing arrives half-translated.
 */
import { asLang } from '../orders/format';

const MESSAGES: Record<string, { ar: string; en: string; ckb: string }> = {
  INSUFFICIENT_BALANCE: {
    ar: 'رصيد محفظتك لا يغطي هذا الاشتراك.',
    en: 'Your wallet balance does not cover this membership.',
    ckb: 'باڵانسی جزدانەکەت ئەم ئەندامێتییە ناگرێتەوە.',
  },
  ALREADY_SUBSCRIBED: {
    ar: 'لديك اشتراك فعال من هذه الفئة بالفعل — يمكنك التجديد بعد انتهائه.',
    en: 'You already have an active membership of this tier — you can renew when it expires.',
    ckb: 'پێشتر ئەندامێتیی چالاکی ئەم ئاستەت هەیە — دوای بەسەرچوونی دەتوانیت نوێی بکەیتەوە.',
  },
  TIER_ACTIVE: {
    ar: 'لديك اشتراك فعال من هذه الفئة بالفعل — يمكنك التجديد بعد انتهائه.',
    en: 'You already have an active membership of this tier — you can renew when it expires.',
    ckb: 'پێشتر ئەندامێتیی چالاکی ئەم ئاستەت هەیە — دوای بەسەرچوونی دەتوانیت نوێی بکەیتەوە.',
  },
  DOWNGRADE_BLOCKED: {
    ar: 'أنت مشترك في فئة أعلى — يمكنك الانتقال إلى فئة أدنى بعد انتهاء اشتراكك الحالي.',
    en: 'You hold a higher tier — you can switch to a lower one when your current membership expires.',
    ckb: 'ئاستێکی بەرزترت هەیە — دوای بەسەرچوونی ئەندامێتیی ئێستات دەتوانیت بۆ ئاستی نزمتر بگۆڕیت.',
  },
  ALREADY_PREPAID: {
    ar: 'لديك بالفعل حجز مدفوع مسبقًا لهذه الفئة بانتظار الإطلاق.',
    en: 'You already hold a prepaid reservation of this tier awaiting the launch.',
    ckb: 'پێشتر پارێزگاریی پێشپارەدراوت بۆ ئەم ئاستە هەیە کە چاوەڕێی دەستپێکردنە.',
  },
  PLAN_UNPRICED: {
    ar: 'هذه الخطة غير متاحة للشراء بعد — لم يُحدد سعرها.',
    en: 'This plan is not purchasable yet — its price has not been set.',
    ckb: 'ئەم پلانە هێشتا بۆ کڕین بەردەست نییە — نرخی دیاری نەکراوە.',
  },
  PLAN_NOT_FOUND: {
    ar: 'هذه الخطة لم تعد موجودة — أعد تحميل الصفحة.',
    en: 'This plan no longer exists — reload the page.',
    ckb: 'ئەم پلانە ئیتر بوونی نییە — پەڕەکە دووبارە بار بکە.',
  },
  QUOTE_CHANGED: {
    ar: 'تغير السعر أو سعر الصرف منذ عرض الملخص — راجع الأرقام الجديدة ثم أكد مرة أخرى.',
    en: 'The price or exchange rate changed since the summary was shown — review the new figures and confirm again.',
    ckb: 'نرخ یان نرخی ئاڵوگۆڕ گۆڕا لەو کاتەوەی پوختەکە پیشان درا — ژمارە نوێیەکان بپشکنە و دووبارە پشتڕاست بکەرەوە.',
  },
};

export function purchaseErrorText(code: string | undefined, fallback: string, lang: string): string {
  const m = code ? MESSAGES[code] : undefined;
  if (!m) return fallback;
  return m[asLang(lang)];
}

/** Refusals whose remedy is money, not waiting. */
export function needsTopUp(code: string | undefined): boolean {
  return code === 'INSUFFICIENT_BALANCE';
}
