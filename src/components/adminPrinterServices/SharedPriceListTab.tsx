/**
 * «قائمة الأسعار المشتركة» — the one price list every enrolled printer reads (warranty by family,
 * delivery by class, Care, packaging, inspection, academy, the two packages, the Care terms and the
 * membership row). Behind its own tab and a banner, because a price changed here changes for every
 * printer with that family or class (owner, 2026-11-18). Each group is folded with a one-line
 * summary; this printer's own family and class come first, the others are folded once more.
 */
import type { ReactNode } from 'react';
import { formatIqd } from '../../lib/api';
import {
  DELIVERY_CLASSES,
  WARRANTY_FAMILIES,
  type DeliveryClass,
  type PrinterServicesConfig,
  type WarrantyFamily,
} from '../../../packages/pricing/src/printerServices';
import { CareTermsPanel, InspectionLaborField } from './CareTermsPanel';
import { MembershipPanel } from './PrinterExtrasPanels';
import { CLASS_LABEL, FAMILY_LABEL, S, say, type Loc } from './adminPrinterStrings';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;

export default function SharedPriceListTab({ draft, upd, loc, published, productId }: {
  draft: PrinterServicesConfig; upd: Upd; loc: Loc; published: PrinterServicesConfig | null; productId: string;
}) {
  const enrolled = Object.keys(draft.products).length;
  const mine = Object.hasOwn(draft.products, productId) ? draft.products[productId] : null;
  const myFamily = mine?.warranty_family ?? null;
  const myClass = mine?.delivery_class ?? null;
  const money = (v: number | null) => (v === null ? loc('غير متوفر', 'not offered', 'بەردەست نییە') : formatIqd(v));

  const num = (v: number | null, on: (n: number | null) => void, label: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input
        className="lv-input h-10 px-2 tabular-nums"
        inputMode="numeric"
        dir="ltr"
        value={v === null ? '' : String(v)}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, '');
          on(t === '' ? null : Number(t));
        }}
      />
    </label>
  );
  const group = (key: string, title: string, summary: string, body: ReactNode) => (
    <details className="lv-surface p-3" data-shared-group={key}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[14px] font-bold text-text-primary">{title}</span>
        {summary ? <span className="text-[12px] text-text-muted">{summary}</span> : null}
      </summary>
      <div className="mt-3">{body}</div>
    </details>
  );

  const familyRow = (f: WarrantyFamily) => (
    <div key={f} className="grid grid-cols-2 gap-2">
      {num(draft.warranty.w12[f], (n) => upd((d) => { d.warranty.w12[f] = n; }), `${loc('ضمان 12 شهراً', 'Warranty 12 months', 'گەرەنتی 12 مانگ')} · ${FAMILY_LABEL[f]}`)}
      {num(draft.warranty.w24[f], (n) => upd((d) => { d.warranty.w24[f] = n; }), `${loc('ضمان 24 شهراً', 'Warranty 24 months', 'گەرەنتی 24 مانگ')} · ${FAMILY_LABEL[f]}`)}
    </div>
  );
  const classRow = (c: DeliveryClass) => (
    <div key={c} className="grid grid-cols-2 gap-2">
      {num(draft.delivery.classes[c].economy_iqd, (n) => upd((d) => { d.delivery.classes[c].economy_iqd = n; }), `${loc('اقتصادي', 'Economy', 'ئابووری')} · ${say(loc, CLASS_LABEL[c])}`)}
      {num(draft.delivery.classes[c].personal_iqd, (n) => upd((d) => { d.delivery.classes[c].personal_iqd = n; }), `${loc('شخصي (الوسيط)', 'Personal (Al-Waseet)', 'تایبەت (ئەلوەسیت)')} · ${say(loc, CLASS_LABEL[c])}`)}
    </div>
  );
  /** This printer's own row first, under its own heading; the rest folded once more. */
  const mineFirst = <K extends string>(all: readonly K[], own: K | null, row: (k: K) => ReactNode, ownTitle: string, othersTitle: string) => (
    <div className="space-y-3">
      {own ? (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-text-primary">{ownTitle}</h4>
          {row(own)}
        </div>
      ) : null}
      {own ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-[12px] font-semibold text-text-primary">{othersTitle} ({all.length - 1})</summary>
          <div className="mt-2 space-y-2">{all.filter((k) => k !== own).map(row)}</div>
        </details>
      ) : <div className="space-y-2">{all.map(row)}</div>}
    </div>
  );

  const wSummary = myFamily
    ? `${FAMILY_LABEL[myFamily]}: ${money(draft.warranty.w12[myFamily])} / ${money(draft.warranty.w24[myFamily])}`
    : '';
  const dSummary = myClass
    ? `${say(loc, CLASS_LABEL[myClass])}: ${money(draft.delivery.classes[myClass].economy_iqd)} / ${money(draft.delivery.classes[myClass].personal_iqd)}`
    : '';
  const pkgName = (id: 'smart' | 'complete') => (id === 'smart' ? loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک') : loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو'));

  return (
    <div className="space-y-3" data-shared-price-list>
      <div className="lv-alert lv-alert-warning p-3 text-[12px]" role="note" data-shared-warning>
        <p className="font-bold">{say(loc, S.sharedBanner)} ({enrolled})</p>
        <p className="mt-1 leading-relaxed">{say(loc, S.sharedBannerHint)}</p>
      </div>

      {group('warranty', say(loc, S.grpWarranty), wSummary,
        <>
          <p className="mb-2 text-[11px] text-text-muted">{say(loc, S.emptyNotOffered)}</p>
          {mineFirst(WARRANTY_FAMILIES, myFamily, familyRow, say(loc, S.thisFamily), say(loc, S.otherFamilies))}
        </>)}

      {group('delivery', say(loc, S.grpDelivery), dSummary,
        <>
          <p className="mb-2 text-[11px] text-text-muted">{say(loc, S.emptyNotOffered)}</p>
          {mineFirst(DELIVERY_CLASSES, myClass, classRow, say(loc, S.thisClass), say(loc, S.otherClasses))}
        </>)}

      {group('services', say(loc, S.grpServices), `${loc('ليفو كير', 'Levo Care', 'لیڤۆ کێر')} ${money(draft.care.price_iqd)}`,
        <div className="grid gap-3 sm:grid-cols-2">
          {num(draft.care.price_iqd, (n) => upd((d) => { d.care.price_iqd = n; }), loc('ليفو كير · 12 شهراً', 'Levo Care · 12 months', 'لیڤۆ کێر · 12 مانگ'))}
          {num(draft.care.max_discount_pct, (n) => upd((d) => { d.care.max_discount_pct = Math.min(90, n ?? 0); }), loc('أقصى خصم Care %', 'Care max discount %', 'زۆرترین داشکاندنی Care %'))}
          {num(draft.packaging.extra_iqd, (n) => upd((d) => { d.packaging.extra_iqd = n; }), loc('تغليف حماية إضافية', 'Extra packaging', 'پێچانەوەی زیادە'))}
          {num(draft.inspection.price_iqd, (n) => upd((d) => { d.inspection.price_iqd = n; }), loc('الفحص قبل الشحن', 'Pre-dispatch inspection', 'پشکنین پێش ناردن'))}
          <InspectionLaborField draft={draft} upd={upd} loc={loc} />
          {num(draft.academy.recorded_iqd, (n) => upd((d) => { d.academy.recorded_iqd = n; }), loc('فيديوهات مسجلة', 'Recorded videos', 'ڤیدیۆی تۆمارکراو'))}
          {num(draft.academy.live_iqd, (n) => upd((d) => { d.academy.live_iqd = n; }), loc('دورة مباشرة', 'Live course', 'خولی ڕاستەوخۆ'))}
        </div>)}

      {group('packages', say(loc, S.grpPackages), (['smart', 'complete'] as const).filter((id) => draft.packages[id].active).map(pkgName).join(' · '),
        <div className="grid gap-3 sm:grid-cols-2">
          {(['smart', 'complete'] as const).map((id) => (
            <div key={id} className="rounded-lg border border-border-subtle p-2 text-[12px] text-text-secondary">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                <input type="checkbox" checked={draft.packages[id].active} onChange={(e) => upd((d) => { d.packages[id].active = e.target.checked; })} />
                {pkgName(id)}
              </label>
              <p className="mt-1">
                {[draft.packages[id].warranty, draft.packages[id].care, draft.packages[id].packaging, draft.packages[id].inspection].join(' · ')}
              </p>
              {/* No package discount (owner, 2026-11-17): a package is the sum of its parts; the server refuses one. */}
            </div>
          ))}
        </div>)}

      {group('care-terms', say(loc, S.grpCare), draft.care.terms ? loc(`الإصدار ${draft.care.policy_version}`, `version ${draft.care.policy_version}`, `وەشانی ${draft.care.policy_version}`) : '',
        <CareTermsPanel draft={draft} upd={upd} loc={loc} published={published} />)}

      {group('membership', say(loc, S.grpMembership), draft.membership?.active ? loc('معروضة', 'offered', 'پێشکەشکراوە') : loc('غير معروضة', 'not offered', 'پێشکەش ناکرێت'),
        <MembershipPanel draft={draft} upd={upd} loc={loc} />)}
    </div>
  );
}
