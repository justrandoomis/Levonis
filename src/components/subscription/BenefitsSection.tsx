/**
 * What each card actually gives — written from what the server ENFORCES
 * (worker/lib/entitlements.ts, shipping.ts, pricing.ts, rewards.ts,
 * membershipOps.ts, community.ts) and nothing else.
 *
 * Two kinds of line are conditional and appear only when the server says the
 * switch is on right now (`features` from GET /api/memberships/plans): the
 * PLUS gift on a printer purchase and the PRO filament gift on a prepaid
 * pre-order. The free-delivery thresholds are the server's too (`delivery`),
 * so the copy can never disagree with the checkout.
 *
 * Removed as fake, and not to be reintroduced without code behind them: game
 * tickets, a PRO-exclusive catalogue, ad eligibility, the two sections that
 * never existed, and the printable card block.
 */
import React from 'react';
import { Check, Clock, Info, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd } from '../../lib/api';
import { TIER_META, type PaidTier } from './tierMeta';
import type { DeliveryThresholds, PlanFeatures } from './types';

export interface BenefitsSectionProps {
  features: PlanFeatures | null;
  delivery: DeliveryThresholds | null;
  loading: boolean;
}

interface Line {
  text: string;
  soon?: boolean;
}

function SoonChip() {
  const { t } = useLanguage();
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 whitespace-nowrap shrink-0">
      {t('comingSoon')}
    </span>
  );
}

function BenefitCard({
  tier,
  title,
  lines,
  note,
  loading,
}: {
  tier: PaidTier;
  title: string;
  lines: Line[];
  note?: React.ReactNode;
  loading: boolean;
}) {
  const meta = TIER_META[tier];
  return (
    <div
      data-benefits={tier}
      className={`bg-zinc-900/30 border ${meta.panelBorder} rounded-[24px] p-5 sm:p-6 shadow-lg relative overflow-hidden`}
    >
      <div
        className="absolute top-0 end-0 w-32 h-32 rounded-es-[100px] pointer-events-none mix-blend-screen blur-xl opacity-70"
        style={{ background: `${meta.hex}22` }}
        aria-hidden
      />
      <h4 className={`${meta.heading} font-bold mb-4 flex items-center gap-2.5 text-[16px] relative z-10`}>
        <meta.Icon className="w-5 h-5" aria-hidden /> {title}
      </h4>
      {loading ? (
        <ul className="space-y-3" role="status" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-4 rounded bg-zinc-800/60 animate-pulse motion-reduce:animate-none" aria-hidden />
          ))}
        </ul>
      ) : (
        <ul className="space-y-3.5 relative z-10">
          {lines.map((l, i) => (
            <li key={i} className={`flex items-start gap-3 text-[14px] leading-normal ${l.soon ? 'text-zinc-500' : 'text-zinc-300'}`}>
              {l.soon ? (
                <Clock className="w-5 h-5 text-amber-500/70 shrink-0 mt-0.5" strokeWidth={2.5} aria-hidden />
              ) : (
                <Check className={`w-5 h-5 ${meta.check} shrink-0 mt-0.5`} strokeWidth={2.5} aria-hidden />
              )}
              <span className="min-w-0">{l.text}</span>
              {l.soon && <SoonChip />}
            </li>
          ))}
        </ul>
      )}
      {note && !loading && (
        <div className="mt-5 pt-4 border-t border-white/5 text-[11.5px] text-zinc-500 leading-relaxed space-y-2 relative z-10">{note}</div>
      )}
    </div>
  );
}

export function BenefitsSection({ features, delivery, loading }: BenefitsSectionProps) {
  const { t, loc } = useLanguage();
  // The thresholds are the server's. When the plans fetch failed (`delivery`
  // is null) the lines are written WITHOUT a figure — a wording that needs
  // none — never with an empty gap where a number should be.
  const pro = delivery ? formatIqd(delivery.pro_threshold_iqd) : null;
  const prime = delivery ? formatIqd(delivery.prime_threshold_iqd) : null;

  const bnpl: Line = {
    soon: true,
    text: loc('اشترِ الآن وادفع لاحقًا (BNPL)', 'Buy now, pay later (BNPL)', 'ئێستا بکڕە و دواتر پارە بدە (BNPL)'),
  };

  // ---------------------------------------------------------------- PLUS
  const plusLines: Line[] = [
    {
      text: loc(
        'متجرك الخاص برابطه الفرعي (اسمك.levonis-iq.com)',
        'Your own storefront with its own address (yourname.levonis-iq.com)',
        'فرۆشگای تایبەتی خۆت بە ناونیشانی خۆی (ناوەکەت.levonis-iq.com)'
      ),
    },
    {
      text: loc(
        'لوحة تحكم كاملة: المنتجات، الطلبات، الرسائل، التحليلات',
        'A full merchant dashboard: products, orders, messages, analytics',
        'داشبۆردی تەواوی بازرگان: بەرهەم، داواکاری، نامە، شیکاری'
      ),
    },
    {
      text: loc(
        'استقبال الطلبات والدفع عبر منصة ليفونيس',
        'Take orders and payments through the LEVONIS platform',
        'وەرگرتنی داواکاری و پارەدان لە ڕێگەی پلاتفۆرمی LEVONIS'
      ),
    },
    {
      text: loc(
        'تقديم عروض على طلبات العملاء في المجتمع',
        'Submit offers on customer requests in the community',
        'پێشکەشکردنی ئۆفەر بۆ داواکارییەکانی کڕیاران لە کۆمەڵگە'
      ),
    },
    {
      text: loc('ملف تاجر احترافي في مجتمع ليفو', 'A professional merchant profile in the Levo community', 'پڕۆفایلی بازرگانی پیشەیی لە کۆمەڵگەی Levo'),
    },
    { text: loc('الوصول إلى قسم البندلات', 'Access to the bundles section', 'دەستگەیشتن بە بەشی پاکێجەکان') },
    {
      text: loc(
        'كوبونات مخصصة لأعضاء PLUS عندما يوفرها المتجر',
        'PLUS-only coupons whenever the store issues them',
        'کۆپۆنی تایبەت بە ئەندامانی PLUS کاتێک فرۆشگا دەریدەکات'
      ),
    },
  ];
  plusLines.push(bnpl);
  // How one OBTAINS PLUS is not a PLUS benefit: it sits under the card, and
  // only while the gift is actually switched on (features.printer_gift).
  const plusNote = features?.printer_gift ? (
    <>
      <p className="font-bold text-zinc-400">{loc('كيف تحصل على PLUS مجانًا', 'How to get PLUS free', 'چۆن PLUS بە بێبەرامبەر وەربگریت')}</p>
      <p>
        {loc(
          'عضوية PLUS مجانية هديةً مع شراء طابعة.',
          'A free PLUS membership comes as a gift with a printer purchase.',
          'ئەندامێتیی PLUS ی بێبەرامبەر وەک دیاری لەگەڵ کڕینی پرینتەر دەدرێت.'
        )}
      </p>
    </>
  ) : undefined;

  // --------------------------------------------------------------- PRIME
  const primeLines: Line[] = [
    {
      text: loc(
        'أسعار PRIME على المنتجات التي حُدد لها سعر PRIME — وتتبع أسعار الأعضاء كل رسوم المنتج',
        'PRIME prices on products that state one — member prices follow every product surcharge',
        'نرخی PRIME بۆ ئەو بەرهەمانەی نرخی PRIME یان دانراوە — نرخی ئەندامان هەموو زیادکراوەکانی بەرهەم دەگرێتەوە'
      ),
    },
    {
      text: prime
        ? loc(
            `توصيل مجاني للطلبات فوق ${prime} بعد الكوبونات والنقاط (رسوم التوصيل الاعتيادية فقط)`,
            `Free delivery on orders above ${prime} after coupons and points (ordinary delivery fee only)`,
            `گەیاندنی بێبەرامبەر بۆ داواکارییەکانی سەرووی ${prime} دوای کۆپۆن و خاڵ (تەنها کرێی گەیاندنی ئاسایی)`
          )
        : loc(
            'توصيل مجاني للطلبات فوق حد التوصيل المجاني للمتجر بعد الكوبونات والنقاط (رسوم التوصيل الاعتيادية فقط)',
            "Free delivery on orders above the store's free-delivery threshold, after coupons and points (ordinary delivery fee only)",
            'گەیاندنی بێبەرامبەر بۆ داواکارییەکانی سەرووی سنووری گەیاندنی بێبەرامبەری فرۆشگا دوای کۆپۆن و خاڵ (تەنها کرێی گەیاندنی ئاسایی)'
          ),
    },
    { text: loc('الوصول إلى قسم البندلات', 'Access to the bundles section', 'دەستگەیشتن بە بەشی پاکێجەکان') },
    {
      text: loc(
        'كوبونات مخصصة لأعضاء PRIME عندما يوفرها المتجر',
        'PRIME coupons whenever the store issues them',
        'کۆپۆنی PRIME کاتێک فرۆشگا دەریدەکات'
      ),
    },
  ];

  // ----------------------------------------------------------------- PRO
  const proLines: Line[] = [
    { text: t('benefitPro1') },
    {
      text: loc(
        'أسعار PRO على المنتجات التي حُدد لها سعر PRO — على عنوانك الافتراضي المعتمد',
        'PRO prices on products that state one — at your approved default address',
        'نرخی PRO بۆ ئەو بەرهەمانەی نرخی PRO یان دانراوە — لە ناونیشانی بنەڕەتی پەسەندکراوت'
      ),
    },
    {
      text: pro
        ? loc(
            `توصيل مجاني (عادي ومحمي) للطلبات فوق ${pro} على العنوان المعتمد`,
            `Free delivery (standard and protected) on orders above ${pro} at the approved address`,
            `گەیاندنی بێبەرامبەر (ئاسایی و پارێزراو) بۆ داواکارییەکانی سەرووی ${pro} لە ناونیشانی پەسەندکراو`
          )
        : loc(
            'توصيل مجاني (عادي ومحمي) للطلبات فوق حد التوصيل المجاني للمتجر على العنوان المعتمد',
            "Free delivery (standard and protected) on orders above the store's free-delivery threshold at the approved address",
            'گەیاندنی بێبەرامبەر (ئاسایی و پارێزراو) بۆ داواکارییەکانی سەرووی سنووری گەیاندنی بێبەرامبەری فرۆشگا لە ناونیشانی پەسەندکراو'
          ),
    },
    {
      text: loc(
        'بلا رسوم إضافية بحسب نوع الشحن (عمولة الطلب المسبق أو علاوة البيع المباشر) على العنوان المعتمد',
        'No shipping-type surcharge (pre-order commission or direct-sale premium) at the approved address',
        'بەبێ زیادکراوی جۆری گەیاندن (کۆمیشنی پێش-داواکاری یان زیادەی فرۆشتنی ڕاستەوخۆ) لە ناونیشانی پەسەندکراو'
      ),
    },
    {
      text: loc(
        'أولوية الخدمة في طلبات الضمان والدعم',
        'Priority service on warranty claims and support',
        'پێشینەی خزمەتگوزاری لە داواکاری گەرەنتی و پشتیوانی'
      ),
    },
    { text: loc('نقاط تسجيل الدخول اليومي مضاعفة', 'Double daily check-in points', 'خاڵی چوونەژوورەوەی ڕۆژانە دووقات') },
    {
      text: loc(
        'مكافأة إحالة عندما يشتري صديق دعوته اشتراك PRO',
        'A referral reward when an invited friend buys PRO',
        'خەڵاتی بانگهێشت کاتێک هاوڕێیەکی بانگهێشتکراو PRO دەکڕێت'
      ),
    },
  ];
  if (features?.preorder_gift) {
    proLines.push({
      text: loc(
        'بكرة فلمنت هدية مع كل طلب مسبق مدفوع بالكامل',
        'A free filament spool with every fully prepaid pre-order',
        'لوولەیەکی فیلامێنتی بێبەرامبەر لەگەڵ هەر پێش-داواکارییەکی تەواو پێشپارەدراو'
      ),
    });
  }
  proLines.push(
    {
      text: loc('كوبونات مخصصة لأعضاء PRO عندما يوفرها المتجر', 'PRO coupons whenever the store issues them', 'کۆپۆنی PRO کاتێک فرۆشگا دەریدەکات'),
    },
    {
      text: loc('شارة تاجر موثّق على متجرك في المجتمع', 'A verified-merchant badge on your community store', 'نیشانەی بازرگانی پشتڕاستکراو لەسەر فرۆشگاکەت لە کۆمەڵگە'),
    },
    bnpl,
    { soon: true, text: loc('توصيل خلال 12 ساعة', '12-hour delivery', 'گەیاندن لە ماوەی ١٢ کاتژمێردا') },
    { soon: true, text: loc('نطاق خاص لمتجرك', 'A custom domain for your store', 'دۆمەینی تایبەت بۆ فرۆشگاکەت') }
  );

  return (
    <section aria-labelledby="benefits-title" className="relative z-10">
      <h3 id="benefits-title" className="text-[17px] font-bold text-white mb-5 flex items-center justify-center gap-2 px-1">
        {t('planComparisons')} <Info className="w-4 h-4 text-zinc-500" aria-hidden />
      </h3>

      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <BenefitCard tier="plus" title={t('plusBenefits')} lines={plusLines} loading={loading} note={plusNote} />
        <BenefitCard
          tier="prime"
          title={t('primeBenefits')}
          lines={primeLines}
          loading={loading}
          note={
            <>
              {/* The exact threshold, said plainly rather than rounded in prose:
                  the threshold itself is NOT free, one dinar above it is. */}
              <p className="flex items-start gap-2">
                <Truck className="w-4 h-4 shrink-0 mt-0.5 text-zinc-600" aria-hidden />
                <span>
                  {prime
                    ? loc(
                        `الإعفاء يشمل رسوم التوصيل الاعتيادية فقط ويبدأ فوق ${prime} تمامًا — طلب بقيمة ${prime} لا يُعفى.`,
                        `The waiver covers ordinary delivery only and starts strictly above ${prime} — an order of exactly ${prime} is not waived.`,
                        `لێبوردنەکە تەنها گەیاندنی ئاسایی دەگرێتەوە و بە تەواوی لە سەرووی ${prime} دەست پێدەکات — داواکاریی ${prime} لێی نابوردرێت.`
                      )
                    : loc(
                        'الإعفاء يشمل رسوم التوصيل الاعتيادية فقط ويبدأ فوق حد التوصيل المجاني للمتجر تمامًا — الطلب بقيمة الحد نفسه لا يُعفى.',
                        "The waiver covers ordinary delivery only and starts strictly above the store's free-delivery threshold — an order of exactly the threshold is not waived.",
                        'لێبوردنەکە تەنها گەیاندنی ئاسایی دەگرێتەوە و بە تەواوی لە سەرووی سنووری گەیاندنی بێبەرامبەری فرۆشگا دەست پێدەکات — داواکاریی هەر بەقەد سنوورەکە لێی نابوردرێت.'
                      )}
                </span>
              </p>
              <p>
                {loc(
                  'PRIME بطاقة للمشترين: لا تتضمن متجر PLUS ولا حقوق البيع.',
                  "PRIME is a buyer's card: it does not include the PLUS storefront or selling rights.",
                  'PRIME کارتی کڕیارانە: فرۆشگای PLUS و مافی فرۆشتن ناگرێتەوە.'
                )}
              </p>
            </>
          }
        />
        <BenefitCard
          tier="pro"
          title={t('proBenefits')}
          lines={proLines}
          loading={loading}
          note={
            <>
              <p>
                {pro
                  ? loc(
                      `مزايا الشراء في PRO (الأسعار، التوصيل، إعفاء الرسوم) تُطبَّق على العنوان الافتراضي المعتمد بعد التحقق من الهوية، والتوصيل المجاني يبدأ فوق ${pro} تمامًا.`,
                      `PRO purchase benefits (prices, delivery, surcharge waiver) apply at the approved default address after identity verification; free delivery starts strictly above ${pro}.`,
                      `سوودەکانی کڕینی PRO (نرخ، گەیاندن، لێبوردنی زیادکراو) لە ناونیشانی بنەڕەتی پەسەندکراو دوای پشتڕاستکردنەوەی ناسنامە جێبەجێ دەبن؛ گەیاندنی بێبەرامبەر بە تەواوی لە سەرووی ${pro} دەست پێدەکات.`
                    )
                  : loc(
                      'مزايا الشراء في PRO (الأسعار، التوصيل، إعفاء الرسوم) تُطبَّق على العنوان الافتراضي المعتمد بعد التحقق من الهوية، والتوصيل المجاني يبدأ فوق حد التوصيل المجاني للمتجر تمامًا.',
                      "PRO purchase benefits (prices, delivery, surcharge waiver) apply at the approved default address after identity verification; free delivery starts strictly above the store's free-delivery threshold.",
                      'سوودەکانی کڕینی PRO (نرخ، گەیاندن، لێبوردنی زیادکراو) لە ناونیشانی بنەڕەتی پەسەندکراو دوای پشتڕاستکردنەوەی ناسنامە جێبەجێ دەبن؛ گەیاندنی بێبەرامبەر بە تەواوی لە سەرووی سنووری گەیاندنی بێبەرامبەری فرۆشگا دەست پێدەکات.'
                    )}
              </p>
              <p>
                {loc(
                  'رسوم الضمان تُضاف دائمًا ولا تُعفى لأي فئة عضوية.',
                  'Warranty fees are always added and are never waived for any membership tier.',
                  'کرێی گەرەنتی هەمیشە زیاد دەکرێت و بۆ هیچ ئاستێکی ئەندامێتی نابەخشرێت.'
                )}
              </p>
            </>
          }
        />
      </div>
    </section>
  );
}

export default BenefitsSection;
