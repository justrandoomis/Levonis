import { Fragment } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Money, Surface } from './ui';
import type { FinanceSummary } from './types';

/**
 * «الطابعات وخدماتها» and «الضمان وليفو كير: المبيع مقابل التكلفة» (printer phase 3, DECISIONS row 347; reworked in
 * phase 8, row 364).
 *
 * The first card: the period's serviced printers — their own sales, goods cost and REAL margin (it used to show the
 * sales under the word «margin»), then «ربح الخدمات»: what the services sold with them kept, the shop's alone since
 * the owner's ruling R1 (investors and staff are paid on the printer's own part), by service; what the price anchor and
 * the PRO discount took off, the kits, add-ons and memberships sold with them, and their delivery income beside what
 * the courier cost. Everything on RETAINED figures (a returned printer shows no services) and on the orders that hold
 * a serviced printer only.
 *
 * The second card: what the promises cost — warranties and Levo Care sold and in force, the income they brought, the
 * claim costs, the Care discounts given, the co-pays collected, the draw prizes.
 *
 * Information only: every figure is already inside the statement above (the claim costs in «المصاريف العامة», the
 * co-pays in the period net) and nothing here is subtracted again. A field an older server leaves out is not drawn.
 */
type Lang = 'ar' | 'en' | 'ckb';
const S: Record<Lang, Record<string, string>> = {
  ar: {
    title: 'الطابعات وخدماتها', note: 'للاطلاع: داخل الأرقام أعلاه، لا تُطرح مرة أخرى. بعد المرتجعات.',
    printerSales: 'مبيعات الطابعات (دون خدماتها)', lines: 'سطر طابعة', printerCost: 'تكلفة بضاعتها', printerMargin: 'هامش الطابعات',
    marginHint: 'مبيعات الطابعات − تكلفة بضاعتها', waitsCost: 'ينتظر تكلفة شراء',
    services: 'ربح الخدمات — للمتجر وحده', servicesHint: 'حصص المستثمرين وعمولة الموظفين تُحسب على الطابعة وحدها',
    since: 'للطلبات الجديدة من', warranty: 'ضمان إضافي', care: 'ليفو كير', packaging: 'تغليف إضافي', inspection: 'فحص قبل الشحن', academy: 'الأكاديمية',
    anchor: 'خُصم لمن اختار أقل من «الاختيار الذكي»', pro: 'خصم PRO على الخدمات', insidePrices: 'داخل الأسعار، لا تُطرح مرة أخرى',
    kits: 'باقات الفلامنت', addons: 'إضافات الطابعة', discounts: 'خصومات الطابعة الممنوحة', membership: 'عضويات بيعت مع الطابعات',
    delivery: 'التوصيل على الزبائن', courier: 'أجور شركة التوصيل', deliveryNet: 'فرق التوصيل', printerOrders: 'طلبات فيها طابعة',
    promises: 'الضمان وليفو كير: المبيع مقابل التكلفة', promisesNote: 'ما بعته من وعود وما كلّفتك مطالباتها في هذه الفترة.',
    soldUnits: 'طابعات مبيعة في الفترة', w24: 'ضمان 24 شهراً', w12: 'ضمان 12 شهراً', w0: 'بلا ضمان', careSold: 'مع ليفو كير',
    inForce: 'طابعات، اليوم', inForceW: 'ضمان ساري', inForceC: 'ليفو كير ساري',
    promiseIncome: 'دخل الضمان وليفو كير', warrantyCost: 'تكاليف مطالبات الضمان', careCost: 'تكاليف مطالبات ليفو كير',
    claimsCount: 'مطالبة عليها تكلفة', inGeneral: 'ضمن المصاريف العامة', promiseNet: 'الدخل − تكاليف المطالبات',
    benefit: 'خصم ليفو كير الممنوح على الإصلاح', partDiscount: 'خصم ليفو كير على القطع (عروض القطع)', insideOrders: 'داخل أرقام الطلبات',
    copay: 'ما دفعه الزبائن عن الإصلاح (إيراد خدمات)', inNet: 'ضمن صافي الفترة',
    prizes: 'جوائز سحب ليفو كير', prizeCount: 'جائزة سُلّمت', prizeHint: 'تكلفة بضاعتها، ضمن تكلفة طلبات الهدايا',
    inspectionLabor: 'كلفة عمل الفحوص', notConfigured: 'غير محددة في قائمة الأسعار', inspectionsDone: 'فحص منجز',
  },
  en: {
    title: 'Printers and their services', note: 'For information: already inside the figures above, never subtracted again. After returns.',
    printerSales: 'Printer sales (without their services)', lines: 'printer line(s)', printerCost: 'Their goods cost', printerMargin: 'Printer margin',
    marginHint: 'printer sales − their goods cost', waitsCost: 'waiting for a purchase cost',
    services: 'Services profit — the shop’s alone', servicesHint: 'Investor shares and staff commission are counted on the printer alone',
    since: 'for orders placed from', warranty: 'Extended warranty', care: 'Levo Care', packaging: 'Extra packaging', inspection: 'Pre-dispatch inspection', academy: 'Academy',
    anchor: 'Taken off for buyers below the Smart package', pro: 'PRO discount on services', insidePrices: 'inside the prices, never subtracted again',
    kits: 'Filament kits', addons: 'Printer add-ons', discounts: 'Printer discounts given', membership: 'Memberships sold with printers',
    delivery: 'Delivery charged to customers', courier: 'Courier fees', deliveryNet: 'Delivery difference', printerOrders: 'order(s) with a printer',
    promises: 'Warranty and Levo Care: sold against cost', promisesNote: 'The promises you sold and what their claims cost you in this period.',
    soldUnits: 'Printers sold in the period', w24: '24-month warranty', w12: '12-month warranty', w0: 'No warranty', careSold: 'With Levo Care',
    inForce: 'printers, today', inForceW: 'Warranty in force', inForceC: 'Levo Care in force',
    promiseIncome: 'Warranty and Levo Care income', warrantyCost: 'Warranty claim costs', careCost: 'Levo Care claim costs',
    claimsCount: 'claim(s) with a cost', inGeneral: 'in general expenses', promiseNet: 'Income − claim costs',
    benefit: 'Levo Care discount given on repairs', partDiscount: 'Levo Care discount on parts (part offers)', insideOrders: 'inside the orders’ figures',
    copay: 'Paid by customers for repairs (service income)', inNet: 'in the period net',
    prizes: 'Levo Care draw prizes', prizeCount: 'prize(s) delivered', prizeHint: 'their goods cost, inside the gift orders’ cost',
    inspectionLabor: 'Inspection labour', notConfigured: 'not configured in the price list', inspectionsDone: 'inspection(s) done',
  },
  ckb: {
    title: 'پرینتەرەکان و خزمەتگوزارییەکانیان', note: 'بۆ زانیاری: لەناو ژمارەکانی سەرەوەدایە، دووبارە دەرناکرێت. دوای گەڕاندنەوەکان.',
    printerSales: 'فرۆشی پرینتەرەکان (بەبێ خزمەتگوزارییەکانیان)', lines: 'دێڕی پرینتەر', printerCost: 'تێچووی کاڵاکەیان', printerMargin: 'قازانجی پرینتەرەکان',
    marginHint: 'فرۆشی پرینتەرەکان − تێچووی کاڵاکەیان', waitsCost: 'چاوەڕێی نرخی کڕینە',
    services: 'قازانجی خزمەتگوزارییەکان — تەنها بۆ فرۆشگا', servicesHint: 'بەشی وەبەرهێنەران و کۆمیشنی کارمەندان تەنها لەسەر پرینتەرەکە دەژمێردرێت',
    since: 'بۆ داواکارییە نوێیەکان لە', warranty: 'گەرەنتی زیادە', care: 'لیڤۆ کێر', packaging: 'پێچانەوەی زیادە', inspection: 'پشکنین پێش ناردن', academy: 'ئەکادیمیا',
    anchor: 'کەمکراوە بۆ ئەوانەی کەمتر لە «هەڵبژاردنی زیرەک»یان هەڵبژارد', pro: 'داشکاندنی PRO لەسەر خزمەتگوزارییەکان', insidePrices: 'لەناو نرخەکاندایە، دووبارە دەرناکرێت',
    kits: 'پاکێجەکانی فیلامێنت', addons: 'زیادکراوەکانی پرینتەر', discounts: 'داشکاندنە دراوەکانی پرینتەر', membership: 'ئەندامێتی فرۆشراو لەگەڵ پرینتەر',
    delivery: 'گەیاندن لەسەر کڕیاران', courier: 'کرێی کۆمپانیای گەیاندن', deliveryNet: 'جیاوازیی گەیاندن', printerOrders: 'داواکاری کە پرینتەری تێدایە',
    promises: 'گەرەنتی و لیڤۆ کێر: فرۆشراو بەرامبەر تێچوو', promisesNote: 'ئەو بەڵێنانەی فرۆشتووتن و ئەوەی داواکارییەکانیان لەم ماوەیەدا تێچوویان بوو.',
    soldUnits: 'پرینتەری فرۆشراو لەم ماوەیەدا', w24: 'گەرەنتی ٢٤ مانگ', w12: 'گەرەنتی ١٢ مانگ', w0: 'بەبێ گەرەنتی', careSold: 'لەگەڵ لیڤۆ کێر',
    inForce: 'پرینتەر، ئەمڕۆ', inForceW: 'گەرەنتی کارا', inForceC: 'لیڤۆ کێری کارا',
    promiseIncome: 'داهاتی گەرەنتی و لیڤۆ کێر', warrantyCost: 'تێچووی داواکارییەکانی گەرەنتی', careCost: 'تێچووی داواکارییەکانی لیڤۆ کێر',
    claimsCount: 'داواکاری کە تێچووی هەیە', inGeneral: 'لەناو خەرجییە گشتییەکاندا', promiseNet: 'داهات − تێچووی داواکارییەکان',
    benefit: 'داشکاندنی لیڤۆ کێری دراو لەسەر چاککردنەوە', partDiscount: 'داشکاندنی لیڤۆ کێر لەسەر پارچەکان', insideOrders: 'لەناو ژمارەکانی داواکارییەکاندایە',
    copay: 'ئەوەی کڕیاران بۆ چاککردنەوە دایان (داهاتی خزمەتگوزاری)', inNet: 'لەناو پوختەی ماوەکەدایە',
    prizes: 'خەڵاتەکانی تیروپشکی لیڤۆ کێر', prizeCount: 'خەڵاتی گەیەنراو', prizeHint: 'تێچووی کاڵاکەیان، لەناو تێچووی داواکارییەکانی دیاری',
    inspectionLabor: 'تێچووی کاری پشکنینەکان', notConfigured: 'لە لیستی نرخدا دیاری نەکراوە', inspectionsDone: 'پشکنینی تەواوکراو',
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
  const printers = !!b && (n(b.printer_lines) > 0 || n(b.kits_net_iqd) > 0 || n(b.addons_net_iqd) > 0 || n(b.printer_discounts_iqd) > 0 || n(b.membership_iqd) > 0);
  const promiseIncome = n(b?.services?.warranty) + n(b?.services?.care);
  const claimCosts = n(c?.warranty_cost_iqd) + n(c?.care_cost_iqd);
  const sold = b?.sold, force = c?.in_force ?? null, prizes = c?.draw_prizes ?? null;
  const promises = promiseIncome > 0 || n(sold?.units) > 0 || n(force?.warranty_units) > 0 || n(force?.care_units) > 0
    || (!!c && (n(c.count) > 0 || n(c.inspections_done) > 0 || n(c.care_benefit_given_iqd) > 0 || n(c.care_part_discount_iqd) > 0 || n(c.copay_iqd) > 0 || claimCosts > 0 || n(prizes?.count) > 0))
    || n(income) > 0;
  if (!printers && !promises) return null;
  const inGeneral = c?.included_in_general_expenses !== false ? ` · ${s.inGeneral}` : '';
  const delivery = n(b?.delivery_income_iqd), courier = n(b?.courier_fee_iqd);
  // An older server sends neither the cost nor the margin: the sales stand alone, under their own name.
  const hasMargin = !!b && 'printer_margin_iqd' in b;
  return (
    <>
      {printers && b && <Surface title={s.title} subtitle={s.note}>
        <dl className="fw-kv" data-finance-printer-services>
          {n(b.printer_lines) > 0 && <>
            <dt>{s.printerSales}<small>{`${n(b.printer_lines)} ${s.lines}`}</small></dt><dd data-finance-printer-sales><Money value={n(b.printer_net_iqd)} /></dd>
            {hasMargin && <>
              <dt>{s.printerCost}</dt><dd>{b.printer_cogs_iqd == null ? <small>{s.waitsCost}</small> : <Money value={b.printer_cogs_iqd} />}</dd>
              <dt>{s.printerMargin}<small>{s.marginHint}</small></dt><dd data-finance-printer-margin>{b.printer_margin_iqd == null ? <small>{s.waitsCost}</small> : <Money value={b.printer_margin_iqd} />}</dd>
            </>}
            <dt>{s.services}<small>{`${s.servicesHint}${data.printer_part_from_day ? ` · ${s.since} ${data.printer_part_from_day}` : ''}`}</small></dt>
            <dd data-finance-services-profit><Money value={n(b.services_net_iqd)} /></dd>
            {SERVICES.filter((k) => n(b.services?.[k]) > 0).map((k) => (
              <Fragment key={k}><dt><small>{s[k]}</small></dt><dd><Money value={n(b.services?.[k])} compact /></dd></Fragment>
            ))}
            {n(b.anchor_reduction_iqd) > 0 && <><dt>{s.anchor}<small>{s.insidePrices}</small></dt><dd><Money value={n(b.anchor_reduction_iqd)} compact /></dd></>}
            {n(b.pro_services_discount_iqd) > 0 && <><dt>{s.pro}<small>{s.insidePrices}</small></dt><dd><Money value={n(b.pro_services_discount_iqd)} compact /></dd></>}
          </>}
          {n(b.kits_net_iqd) > 0 && <><dt>{s.kits}</dt><dd><Money value={n(b.kits_net_iqd)} /></dd></>}
          {n(b.addons_net_iqd) > 0 && <><dt>{s.addons}</dt><dd><Money value={n(b.addons_net_iqd)} /></dd></>}
          {n(b.printer_discounts_iqd) > 0 && <><dt>{s.discounts}<small>{s.insidePrices}</small></dt><dd data-finance-printer-discounts><Money value={n(b.printer_discounts_iqd)} /></dd></>}
          {n(b.membership_iqd) > 0 && <><dt>{s.membership}</dt><dd><Money value={n(b.membership_iqd)} /></dd></>}
          {(delivery > 0 || courier > 0) && <>
            <dt>{s.delivery}<small>{`${n(b.printer_orders)} ${s.printerOrders}`}</small></dt><dd><Money value={delivery} /></dd>
            <dt>{s.courier}</dt><dd><Money value={courier} /></dd>
            <dt>{s.deliveryNet}</dt><dd data-finance-delivery-net><Money value={delivery - courier} /></dd>
          </>}
        </dl>
      </Surface>}
      {promises && <Surface title={s.promises} subtitle={s.promisesNote}>
        <dl className="fw-kv" data-finance-promises>
          {sold && n(sold.units) > 0 && <>
            <dt>{s.soldUnits}</dt><dd>{n(sold.units)}</dd>
            {([['w24', sold.warranty_24], ['w12', sold.warranty_12], ['w0', sold.warranty_0], ['careSold', sold.care]] as const).filter(([, v]) => n(v) > 0).map(([k, v]) => (
              <Fragment key={k}><dt><small>{s[k]}</small></dt><dd>{n(v)}</dd></Fragment>
            ))}
          </>}
          {force && <>
            <dt>{s.inForceW}<small>{s.inForce}</small></dt><dd>{n(force.warranty_units)}</dd>
            <dt>{s.inForceC}<small>{s.inForce}</small></dt><dd>{n(force.care_units)}</dd>
          </>}
          <dt>{s.promiseIncome}</dt><dd><Money value={promiseIncome} /></dd>
          {c && <>
            <dt>{s.warrantyCost}<small>{`${n(c.count)} ${s.claimsCount}${inGeneral}`}</small></dt><dd><Money value={n(c.warranty_cost_iqd)} /></dd>
            <dt>{s.careCost}<small>{s.inGeneral}</small></dt><dd><Money value={n(c.care_cost_iqd)} /></dd>
            <dt>{s.promiseNet}</dt><dd data-finance-promise-net><Money value={promiseIncome - claimCosts} /></dd>
            <dt>{s.benefit}</dt><dd><Money value={n(c.care_benefit_given_iqd)} /></dd>
            {n(c.care_part_discount_iqd) > 0 && <><dt>{s.partDiscount}<small>{s.insideOrders}</small></dt><dd data-finance-care-part-discount><Money value={n(c.care_part_discount_iqd)} /></dd></>}
          </>}
          <dt>{s.copay}<small>{s.inNet}</small></dt><dd><Money value={n(income)} /></dd>
          {prizes && n(prizes.count) > 0 && <><dt>{s.prizes}<small>{`${n(prizes.count)} ${s.prizeCount} · ${s.prizeHint}`}</small></dt>
            <dd data-finance-draw-prizes>{prizes.cost_iqd == null ? <small>{s.waitsCost}</small> : <Money value={prizes.cost_iqd} />}</dd></>}
          {c && <>
            <dt>{s.inspectionLabor}<small>{`${n(c.inspections_done)} ${s.inspectionsDone}`}</small></dt>
            <dd data-finance-inspection-labor={c.inspection_labor_iqd == null ? 'unset' : 'set'}>{c.inspection_labor_iqd == null ? <small>{s.notConfigured}</small> : <Money value={n(c.inspection_labor_total_iqd)} />}</dd>
          </>}
        </dl>
      </Surface>}
    </>
  );
}
