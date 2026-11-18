import { Fragment } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Money, Surface } from './ui';
import type { FinanceSummary } from './types';

/**
 * «خدمات الطابعات والمطالبات» (printer phase 3, DECISIONS row 347) — the period's
 * serviced printer lines split into the printer and its services, the kits,
 * memberships and courier around them, and the warranty / Levo Care claim money.
 *
 * Information only: the claim costs are general expenses of their day and are
 * already in «المصاريف العامة» above (never subtracted twice); the co-pays are
 * service income, already in the period net. Money in dinars as the server sends
 * it; a field an older server leaves out is not drawn, and the card stays away
 * when there is nothing in it.
 */
type Lang = 'ar' | 'en' | 'ckb';
const S: Record<Lang, Record<string, string>> = {
  ar: {
    title: 'خدمات الطابعات والمطالبات', note: 'للاطلاع: داخل الأرقام أعلاه، لا تُطرح مرة أخرى.',
    printers: 'هامش الطابعات (صافيها دون الخدمات)', lines: 'سطر طابعة', services: 'الخدمات المباعة مع الطابعات',
    warranty: 'ضمان إضافي', care: 'ليفو كير', packaging: 'تغليف إضافي', inspection: 'فحص قبل الشحن', academy: 'الأكاديمية',
    kits: 'باقات الفلامنت', membership: 'العضويات', courier: 'أجور شركة التوصيل',
    claims: 'المطالبات', inspectionLabor: 'كلفة عمل الفحوص', notConfigured: 'غير محددة في قائمة الأسعار',
    inspectionsDone: 'فحص منجز', warrantyCost: 'تكاليف مطالبات الضمان', careCost: 'تكاليف مطالبات ليفو كير',
    inGeneral: 'ضمن المصاريف العامة', benefit: 'خصم ليفو كير الممنوح', copay: 'ما دفعه الزبائن (إيراد خدمات)',
    claimsCount: 'مطالبة عليها تكلفة',
  },
  en: {
    title: 'Printer services and claims', note: 'For information: already inside the figures above, never subtracted again.',
    printers: 'Printer margin (their net without services)', lines: 'printer line(s)', services: 'Services sold with printers',
    warranty: 'Extended warranty', care: 'Levo Care', packaging: 'Extra packaging', inspection: 'Pre-dispatch inspection', academy: 'Academy',
    kits: 'Filament kits', membership: 'Memberships', courier: 'Courier fees',
    claims: 'Claims', inspectionLabor: 'Inspection labour', notConfigured: 'not configured in the price list',
    inspectionsDone: 'inspection(s) done', warrantyCost: 'Warranty claim costs', careCost: 'Levo Care claim costs',
    inGeneral: 'in general expenses', benefit: 'Levo Care discount given', copay: 'Co-pays collected (service income)',
    claimsCount: 'claim(s) with a cost',
  },
  ckb: {
    title: 'خزمەتگوزارییەکانی پرینتەر و داواکارییەکان', note: 'بۆ زانیاری: لەناو ژمارەکانی سەرەوەدایە، دووبارە دەرناکرێت.',
    printers: 'قازانجی پرینتەرەکان (پوختەیان بەبێ خزمەتگوزاری)', lines: 'دێڕی پرینتەر', services: 'خزمەتگوزارییە فرۆشراوەکان لەگەڵ پرینتەر',
    warranty: 'گەرەنتی زیادە', care: 'لیڤۆ کێر', packaging: 'پێچانەوەی زیادە', inspection: 'پشکنین پێش ناردن', academy: 'ئەکادیمیا',
    kits: 'پاکێجەکانی فیلامێنت', membership: 'ئەندامێتییەکان', courier: 'کرێی کۆمپانیای گەیاندن',
    claims: 'داواکارییەکان', inspectionLabor: 'تێچووی کاری پشکنینەکان', notConfigured: 'لە لیستی نرخدا دیاری نەکراوە',
    inspectionsDone: 'پشکنینی تەواوکراو', warrantyCost: 'تێچووی داواکارییەکانی گەرەنتی', careCost: 'تێچووی داواکارییەکانی لیڤۆ کێر',
    inGeneral: 'لەناو خەرجییە گشتییەکاندا', benefit: 'داشکاندنی لیڤۆ کێری دراو', copay: 'ئەوەی کڕیاران دایان (داهاتی خزمەتگوزاری)',
    claimsCount: 'داواکاری کە تێچووی هەیە',
  },
};
const SERVICES = ['warranty', 'care', 'packaging', 'inspection', 'academy'] as const;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function PrinterServicesCard({ data }: { data: FinanceSummary }) {
  const { lang } = useLanguage();
  const s = S[(lang as Lang)] ?? S.ar;
  const b = data.printer_breakdown ?? null;
  const c = data.service_claims ?? null;
  const income = data.service_income_iqd ?? data.totals.service_income_iqd ?? c?.copay_iqd ?? 0;
  const anything = (b && (n(b.printer_lines) > 0 || n(b.kits_net_iqd) > 0 || n(b.membership_iqd) > 0 || n(b.courier_fee_iqd) > 0))
    || (c && (n(c.count) > 0 || n(c.inspections_done) > 0 || n(c.care_benefit_given_iqd) > 0 || n(c.copay_iqd) > 0 || n(c.warranty_cost_iqd) > 0 || n(c.care_cost_iqd) > 0))
    || n(income) > 0;
  if (!anything) return null;
  const inGeneral = c?.included_in_general_expenses !== false ? ` · ${s.inGeneral}` : '';
  return (
    <Surface title={s.title} subtitle={s.note}>
      <dl className="fw-kv" data-finance-printer-services>
        {b && <>
          <dt>{s.printers}<small>{`${n(b.printer_lines)} ${s.lines}`}</small></dt><dd><Money value={n(b.printer_net_iqd)} /></dd>
          <dt>{s.services}</dt><dd><Money value={n(b.services_net_iqd)} /></dd>
          {SERVICES.filter((k) => n(b.services?.[k]) > 0).map((k) => (
            <Fragment key={k}><dt><small>{s[k]}</small></dt><dd><Money value={n(b.services?.[k])} compact /></dd></Fragment>
          ))}
          {n(b.kits_net_iqd) > 0 && <><dt>{s.kits}</dt><dd><Money value={n(b.kits_net_iqd)} /></dd></>}
          {n(b.membership_iqd) > 0 && <><dt>{s.membership}</dt><dd><Money value={n(b.membership_iqd)} /></dd></>}
          {n(b.courier_fee_iqd) > 0 && <><dt>{s.courier}</dt><dd><Money value={n(b.courier_fee_iqd)} /></dd></>}
        </>}
        {c && <>
          <dt>{s.inspectionLabor}<small>{`${n(c.inspections_done)} ${s.inspectionsDone}`}</small></dt>
          <dd data-finance-inspection-labor={c.inspection_labor_iqd == null ? 'unset' : 'set'}>{c.inspection_labor_iqd == null ? <small>{s.notConfigured}</small> : <Money value={n(c.inspection_labor_total_iqd)} />}</dd>
          <dt>{s.warrantyCost}<small>{`${n(c.count)} ${s.claimsCount}${inGeneral}`}</small></dt><dd><Money value={n(c.warranty_cost_iqd)} /></dd>
          <dt>{s.careCost}<small>{s.inGeneral}</small></dt><dd><Money value={n(c.care_cost_iqd)} /></dd>
          <dt>{s.benefit}</dt><dd><Money value={n(c.care_benefit_given_iqd)} /></dd>
        </>}
        <dt>{s.copay}</dt><dd><Money value={n(income)} /></dd>
      </dl>
    </Surface>
  );
}
