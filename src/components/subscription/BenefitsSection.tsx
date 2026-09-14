/**
 * Compact, inheritance-first membership comparison. The customer sees only
 * what the Worker enforces; the expanded list makes inherited benefits
 * accessible without stretching every card on phones and tablets.
 */
import type { ReactNode } from 'react';
import { Check, ChevronDown, Info, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd } from '../../lib/api';
import { TIER_META, type PaidTier } from './tierMeta';
import type { DeliveryThresholds, PlanFeatures } from './types';

export interface BenefitsSectionProps {
  features: PlanFeatures | null;
  delivery: DeliveryThresholds | null;
  loading: boolean;
}

interface BenefitCardProps {
  tier: PaidTier;
  title: string;
  subtitle: string;
  inheritance?: string;
  lines: string[];
  inheritedLines?: string[];
  inheritedLabel?: string;
  note?: ReactNode;
  loading: boolean;
}

function BenefitList({ tier, lines, compact = false }: { tier: PaidTier; lines: string[]; compact?: boolean }) {
  const meta = TIER_META[tier];
  return (
    <ul className={compact ? 'space-y-2' : 'space-y-2.5'}>
      {lines.map((line) => (
        <li key={line} className={`flex items-start gap-2.5 ${compact ? 'text-[12px]' : 'text-[13px]'} leading-relaxed text-zinc-300`}>
          <Check className={`mt-0.5 h-4 w-4 shrink-0 ${meta.check}`} strokeWidth={2.6} aria-hidden="true" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function BenefitCard({ tier, title, subtitle, inheritance, lines, inheritedLines, inheritedLabel, note, loading }: BenefitCardProps) {
  const meta = TIER_META[tier];
  return (
    <article data-benefits={tier} className={`relative self-start overflow-hidden rounded-[22px] border ${meta.panelBorder} bg-zinc-900/35 p-4 shadow-lg sm:p-5`}>
      <div className="pointer-events-none absolute end-0 top-0 h-24 w-24 rounded-es-[100px] opacity-70 blur-xl mix-blend-screen" style={{ background: `${meta.hex}22` }} aria-hidden="true" />
      <div className="relative z-10 mb-3 flex items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${meta.panelBorder} bg-black/35`}>
          <meta.Icon className={`h-[18px] w-[18px] ${meta.heading}`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h4 className={`text-[15px] font-black ${meta.heading}`}>{title}</h4>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">{subtitle}</p>
        </div>
      </div>

      {inheritance && !loading && (
        <p className={`relative z-10 mb-3 rounded-xl border px-3 py-2 text-[11.5px] font-bold ${meta.chip}`} data-membership-inheritance={tier}>
          {inheritance}
        </p>
      )}

      {loading ? (
        <ul className="relative z-10 space-y-2.5" role="status" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <li key={i} className="h-3.5 animate-pulse rounded bg-zinc-800/60 motion-reduce:animate-none" />)}
        </ul>
      ) : (
        <div className="relative z-10">
          <BenefitList tier={tier} lines={lines} />
          {!!inheritedLines?.length && (
            <details className="group mt-3 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2">
              <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11.5px] font-semibold text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 [&::-webkit-details-marker]:hidden">
                <span>{inheritedLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="border-t border-white/[0.06] pt-2.5">
                <BenefitList tier={tier} lines={inheritedLines} compact />
              </div>
            </details>
          )}
          {note && <div className="mt-3 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-zinc-500">{note}</div>}
        </div>
      )}
    </article>
  );
}

export function BenefitsSection({ features, delivery, loading }: BenefitsSectionProps) {
  const { t, loc } = useLanguage();
  const premiumThreshold = delivery ? formatIqd(delivery.prime_threshold_iqd) : null;
  const proThreshold = delivery ? formatIqd(delivery.pro_threshold_iqd) : null;

  const plusLines = [
    loc('متجر شخصي على username.levonis-iq.com', 'Personal storefront at username.levonis-iq.com', 'فرۆشگای تایبەتی لە username.levonis-iq.com'),
    loc('لوحة تاجر كاملة: المنتجات والطلبات والرسائل والتحليلات', 'Full merchant dashboard: products, orders, messages and analytics', 'داشبۆردی تەواوی بازرگان: بەرهەم، داواکاری، نامە و شیکاری'),
    loc('استقبال طلبات العملاء ومدفوعاتهم عبر ليفونيس', 'Receive customer orders and payments through Levonis', 'وەرگرتنی داواکاری و پارەدانی کڕیار لە ڕێگەی Levonis'),
    loc('تقديم عروض احترافية على طلبات المجتمع', 'Professional merchant offers on Community requests', 'پێشکەشکردنی ئۆفەری پیشەیی لە داواکارییەکانی کۆمەڵگە'),
    loc('الوصول إلى البندلات وأدواتها المؤهلة', 'Access to Bundles and eligible bundle tools', 'دەستگەیشتن بە پاکێج و ئامرازە گونجاوەکانی'),
    loc('عروض وكوبونات PLUS عند توفيرها', 'PLUS offers and coupons when provided', 'ئۆفەر و کۆپۆنی PLUS کاتێک بەردەست بن'),
  ];

  const premiumLines = [
    loc('أسعار PREMIUM/PRIME على المنتجات المؤهلة وخصومات أفضل من PLUS عند ضبطها', 'PREMIUM/PRIME pricing on eligible products and better configured discounts than PLUS', 'نرخی PREMIUM/PRIME بۆ بەرهەمی گونجاو و داشکاندنی باشتر لە PLUS'),
    loc('عروض وكوبونات حصرية للعضوية', 'Membership-exclusive offers and PREMIUM coupons', 'ئۆفەر و کۆپۆنی تایبەت بە PREMIUM'),
    premiumThreshold
      ? loc(`توصيل عادي مجاني فوق ${premiumThreshold} بعد الكوبونات والنقاط ووفق القواعد المطبقة`, `Free standard delivery above ${premiumThreshold} after coupons and points, subject to shipping rules`, `گەیاندنی ئاسایی بێبەرامبەر لە سەرووی ${premiumThreshold} دوای کۆپۆن و خاڵ`)
      : loc('توصيل عادي مجاني فوق حد المتجر المعتمد ووفق قواعد الشحن', "Free standard delivery above the store's approved threshold and shipping rules", 'گەیاندنی ئاسایی بێبەرامبەر لە سەرووی سنووری پەسەندکراوی فرۆشگا'),
    loc('عروض بندلات خاصة بـ PREMIUM', 'PREMIUM-specific bundle offers', 'ئۆفەری پاکێجی تایبەت بە PREMIUM'),
    loc('نقاط تسجيل الدخول اليومية أعلى من PLUS (×1.5)', 'Higher daily login rewards than PLUS (1.5×)', 'خاڵی ڕۆژانەی زیاتر لە PLUS (×1.5)'),
  ];

  const proLines = [
    loc('أفضل أسعار وخصومات وعروض وكوبونات PRO المؤهلة', 'Best eligible PRO prices, discounts, offers and coupons', 'باشترین نرخ و داشکاندن و ئۆفەر و کۆپۆنی PRO'),
    proThreshold
      ? loc(`توصيل مؤهل مجاني فوق ${proThreshold} وإعفاء رسوم الشحن المطبقة على العنوان المعتمد`, `Eligible free delivery above ${proThreshold}, including applicable shipping-surcharge exemptions at the approved address`, `گەیاندنی گونجاوی بێبەرامبەر لە سەرووی ${proThreshold} لە ناونیشانی پەسەندکراو`)
      : loc('توصيل مؤهل مجاني وإعفاءات الشحن المطبقة على العنوان المعتمد', 'Eligible free delivery and applicable shipping exemptions at the approved address', 'گەیاندنی گونجاوی بێبەرامبەر لە ناونیشانی پەسەندکراو'),
    loc('أولوية تجهيز وتوصيل خلال 12 ساعة حيث تتوفر الخدمة', 'Priority preparation and delivery within 12 hours where available', 'پێشینەیی ئامادەکردن و گەیاندن لە ١٢ کاتژمێردا لە شوێنی بەردەست'),
    loc('أعلى أولوية للدعم وطلبات الضمان', 'Highest support and warranty-request priority', 'بەرزترین پێشینەیی پشتیوانی و داواکاری گەرەنتی'),
    loc('مضاعفة نقاط تسجيل الدخول اليومية (×2)', 'Double daily login reward points (2×)', 'دووقاتکردنی خاڵی چوونەژوورەوەی ڕۆژانە (×2)'),
    loc('مكافأة إحالة عند شراء المدعو عضوية PRO مؤهلة', 'Referral reward when an invited user buys an eligible PRO membership', 'خەڵاتی بانگهێشت کاتێک بانگهێشتکراوێک PRO ی گونجاو دەکڕێت'),
    loc('بندلات وعروض PRO حصرية ومعاملة تاجر مميزة', 'PRO-exclusive bundles and premium merchant/community treatment', 'پاکێجی تایبەتی PRO و مامەڵەی بازرگانی تایبەت'),
    loc('شارة تاجر PRO مميزة في المجتمع وملف المتجر', 'Distinctive PRO merchant badge in Community and the store profile', 'نیشانەی تایبەتی بازرگانی PRO لە کۆمەڵگە و پڕۆفایلی فرۆشگا'),
    loc('اشترِ الآن وادفع لاحقًا (BNPL) — حصريًا لـ PRO المؤهل', 'Buy Now, Pay Later (BNPL) — exclusively for eligible PRO members', 'ئێستا بکڕە و دواتر بدە (BNPL) — تەنها بۆ PRO ی گونجاو'),
  ];

  if (features?.preorder_gift) {
    proLines.push(loc('بكرة فلمنت هدية مع الطلب المسبق المدفوع بالكامل', 'A filament-spool gift with a fully prepaid pre-order', 'دیاریی لوولەی فیلامێنت لەگەڵ پێش-داواکاری تەواو پێشپارەدراو'));
  }

  const plusNote = features?.printer_gift ? (
    <p>{loc('يمكن منح PLUS هديةً مع شراء طابعة مؤهلة وفق إعداد المتجر.', 'PLUS may be gifted with an eligible printer purchase under the store setting.', 'PLUS دەتوانرێت وەک دیاری لەگەڵ کڕینی پرینتەری گونجاو بدرێت.')}</p>
  ) : undefined;

  const premiumNote = (
    <p className="flex items-start gap-2">
      <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{loc('يشمل الإعفاء رسم التوصيل العادي فقط، ويُحتسب بعد الخصومات والكوبونات والنقاط.', 'The waiver covers standard delivery only and is evaluated after discounts, coupons and points.', 'لێبوردنەکە تەنها گەیاندنی ئاسایی دەگرێتەوە و دوای داشکاندن و کۆپۆن و خاڵ هەژمار دەکرێت.')}</span>
    </p>
  );

  const proNote = (
    <div className="space-y-1.5">
      <p>{loc('خدمة 12 ساعة تُثبّت على الطلب فقط عند توفر التوصيل الشخصي ونوع الشحن والمنطقة والعنوان المعتمد.', 'The 12-hour service is stamped on an order only when its personal-delivery method, shipping type, service area and approved address qualify.', 'خزمەتی ١٢ کاتژمێر تەنها کاتێک لەسەر داواکاری تۆمار دەکرێت کە ڕێگا و ناوچە و ناونیشان گونجاو بن.')}</p>
      <p>{loc('يتطلب BNPL حسابًا معتمدًا وهوية مستوفية وعنوانًا معتمدًا، ويخضع للحد الائتماني وسجل السداد.', 'BNPL also requires an approved account, eligible verified identity and approved address, and enforces the credit limit and repayment ledger.', 'BNPL هەژماری پەسەندکراو و ناسنامە و ناونیشانی پەسەندکراو و سنووری قەرز و تۆماری گەڕاندنەوە دەوێت.')}</p>
    </div>
  );

  return (
    <section aria-labelledby="benefits-title" className="relative z-10">
      <h3 id="benefits-title" className="mb-4 flex items-center justify-center gap-2 px-1 text-[16px] font-bold text-white">
        {t('planComparisons')} <Info className="h-4 w-4 text-zinc-500" aria-hidden="true" />
      </h3>
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        <BenefitCard tier="plus" title={t('plusBenefits')} subtitle={loc('العضوية الأساسية للتاجر والمجتمع', 'Base merchant and Community membership', 'ئەندامێتی بنەڕەتی بازرگان و کۆمەڵگە')} lines={plusLines} note={plusNote} loading={loading} />
        <BenefitCard tier="prime" title={t('primeBenefits')} subtitle={loc('تسوق وعضوية بمزايا محسّنة', 'Enhanced shopping and member benefits', 'کڕین و ئەندامێتی بە سوودی باشتر')} inheritance={loc('يشمل جميع مزايا PLUS', 'Includes all PLUS benefits', 'هەموو سوودەکانی PLUS دەگرێتەوە')} lines={premiumLines} inheritedLines={plusLines} inheritedLabel={loc('عرض مزايا PLUS الموروثة', 'View inherited PLUS benefits', 'بینینی سوودە میراتکراوەکانی PLUS')} note={premiumNote} loading={loading} />
        <BenefitCard tier="pro" title={t('proBenefits')} subtitle={loc('أعلى مستوى من المزايا الحصرية', 'Highest-level exclusive benefits', 'بەرزترین ئاستی سوودە تایبەتەکان')} inheritance={loc('يشمل جميع مزايا PLUS وPREMIUM', 'Includes all PLUS and PREMIUM benefits', 'هەموو سوودەکانی PLUS و PREMIUM دەگرێتەوە')} lines={proLines} inheritedLines={[...plusLines, ...premiumLines]} inheritedLabel={loc('عرض جميع المزايا الموروثة', 'View all inherited benefits', 'بینینی هەموو سوودە میراتکراوەکان')} note={proNote} loading={loading} />
      </div>
    </section>
  );
}

export default BenefitsSection;
