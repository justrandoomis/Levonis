/**
 * Step ٣ — «الأسعار المشتركة لكل الطابعات»: the one price list every enrolled printer reads
 * (warranty by family, delivery by class, Care, packaging, inspection, academy, the two ready
 * packages, the Care terms and the membership row).
 *
 * A price changed here changes for every printer with that family or class, and this list is opened
 * from ONE printer's page. So it is LOCKED until the owner opens it on purpose (phase 5, DECISIONS
 * row 358): every figure can be read, none can be changed, and the button that unlocks it says how
 * many printers it reaches. Each group is folded with a one-line summary; this printer's own family
 * and class come first, the others are folded once more.
 */
import { useState, type ReactNode } from 'react';
import { formatIqd } from '../../lib/api';
import {
  DELIVERY_CLASSES,
  WARRANTY_FAMILIES,
  type DeliveryClass,
  type PrinterServicesConfig,
  type WarrantyFamily,
} from '../../../packages/pricing/src/printerServices';
import { CareTermsPanel, InspectionLaborField } from './CareTermsPanel';
import { MembershipPanel } from './MembershipPanel';
import { CLASS_LABEL, FAMILY_LABEL, S, packageContents, pkgName, say, type Loc } from './adminPrinterStrings';
import { Fold } from './itemToolkit';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;

export default function SharedPriceListTab({ draft, upd, loc, published, productId }: {
  draft: PrinterServicesConfig; upd: Upd; loc: Loc; published: PrinterServicesConfig | null; productId: string;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const enrolled = Object.keys(draft.products).length;
  const mine = Object.hasOwn(draft.products, productId) ? draft.products[productId] : null;
  const myFamily = mine?.warranty_family ?? null;
  const myClass = mine?.delivery_class ?? null;
  const money = (v: number | null) => (v === null ? loc('غير متوفر', 'not offered', 'بەردەست نییە') : formatIqd(v));

  const num = (v: number | null, on: (n: number | null) => void, label: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input
        className="lv-input h-11 px-2 tabular-nums"
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
  const group = (key: string, title: string, summary: ReactNode, body: ReactNode) => (
    <Fold className="lv-surface p-3" attrs={{ 'data-shared-group': key }}
      summaryClassName="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 [&::-webkit-details-marker]:hidden"
      summary={<span className="min-w-0 flex-1 text-[14px] font-bold text-text-primary">{title}</span>}
      tail={summary ? <span className="w-full text-[12px] text-text-muted">{summary}</span> : null}>
      <div className="mt-3">{body}</div>
    </Fold>
  );
  /** A figure inside a sentence: isolated, so the number and «د.ع» keep their order in Arabic and Kurdish. */
  const fig = (v: number | null) => <bdi>{money(v)}</bdi>;
  const w12Word = loc('ضمان 12 شهراً', 'Warranty 12 months', 'گەرەنتی 12 مانگ');
  const w24Word = loc('ضمان 24 شهراً', 'Warranty 24 months', 'گەرەنتی 24 مانگ');
  const ecoWord = loc('اقتصادي', 'Economy', 'ئابووری');
  const perWord = loc('شخصي (الوسيط)', 'Personal (Al-Waseet)', 'تایبەت (ئەلوەسیت)');

  const familyRow = (f: WarrantyFamily) => (
    <div key={f} className="space-y-1" role="group" aria-label={FAMILY_LABEL[f]}>
      <p className="text-[13px] font-bold text-text-primary" dir="ltr" style={{ textAlign: 'start' }}>{FAMILY_LABEL[f]}</p>
      <div className="grid grid-cols-2 gap-2">
        {num(draft.warranty.w12[f], (n) => upd((d) => { d.warranty.w12[f] = n; }), w12Word)}
        {num(draft.warranty.w24[f], (n) => upd((d) => { d.warranty.w24[f] = n; }), w24Word)}
      </div>
    </div>
  );
  const classRow = (c: DeliveryClass) => (
    <div key={c} className="space-y-1" role="group" aria-label={say(loc, CLASS_LABEL[c])}>
      <p className="text-[13px] font-bold text-text-primary">{say(loc, CLASS_LABEL[c])}</p>
      <div className="grid grid-cols-2 gap-2">
        {num(draft.delivery.classes[c].economy_iqd, (n) => upd((d) => { d.delivery.classes[c].economy_iqd = n; }), ecoWord)}
        {num(draft.delivery.classes[c].personal_iqd, (n) => upd((d) => { d.delivery.classes[c].personal_iqd = n; }), perWord)}
      </div>
    </div>
  );
  /** This printer's own row first, under its own heading; the rest folded once more. */
  const mineFirst = <K extends string>(all: readonly K[], own: K | null, row: (k: K) => ReactNode, ownTitle: string, othersTitle: string) => (
    <div className="space-y-3">
      {own ? (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-text-secondary">{ownTitle}</h4>
          {row(own)}
        </div>
      ) : null}
      {own ? (
        <Fold className="border-t border-border-subtle" summaryClassName="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-text-primary [&::-webkit-details-marker]:hidden" summary={`${othersTitle} (${all.length - 1})`}>
          <div className="mt-2 space-y-3">{all.filter((k) => k !== own).map(row)}</div>
        </Fold>
      ) : <div className="space-y-3">{all.map(row)}</div>}
    </div>
  );

  const wSummary = myFamily
    ? <><bdi>{FAMILY_LABEL[myFamily]}</bdi> · {loc('12 شهراً', '12 months', '12 مانگ')} {fig(draft.warranty.w12[myFamily])} · {loc('24 شهراً', '24 months', '24 مانگ')} {fig(draft.warranty.w24[myFamily])}</>
    : null;
  const dSummary = myClass
    ? <>{say(loc, CLASS_LABEL[myClass])} · {ecoWord} {fig(draft.delivery.classes[myClass].economy_iqd)} · {loc('شخصي', 'Personal', 'تایبەت')} {fig(draft.delivery.classes[myClass].personal_iqd)}</>
    : null;

  return (
    <div className="space-y-3" data-shared-price-list data-shared-locked={unlocked ? 'no' : 'yes'}>
      <div className="lv-alert lv-alert-warning p-3 text-[12px]" role="note" data-shared-warning>
        <p className="font-bold">{say(loc, S.sharedBanner)} ({enrolled})</p>
        <p className="mt-1 leading-relaxed">{say(loc, S.sharedBannerHint)}</p>
        <p className="mt-2 font-semibold" data-shared-lock-state>{say(loc, unlocked ? S.sharedUnlocked : S.sharedLocked)}</p>
        <button type="button" className={`mt-2 lv-button ${unlocked ? 'lv-button-secondary' : 'lv-button-primary'}`} aria-pressed={unlocked} onClick={() => setUnlocked((v) => !v)} data-shared-unlock>
          {unlocked ? say(loc, S.sharedRelock) : `${say(loc, S.sharedUnlock)} (${enrolled})`}
        </button>
      </div>

      {/* Locked: every figure readable, none editable. The parent's fieldset still disables all of it for a non-owner. */}
      <fieldset disabled={!unlocked} className="m-0 min-w-0 border-none p-0 space-y-3" data-shared-fields>
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

        {group('services', say(loc, S.grpServices), <>{loc('ليفو كير', 'Levo Care', 'لیڤۆ کێر')} {fig(draft.care.price_iqd)}</>,
          <div className="grid gap-3 sm:grid-cols-2">
            {num(draft.care.price_iqd, (n) => upd((d) => { d.care.price_iqd = n; }), loc('ليفو كير · 12 شهراً بعد الضمان', 'Levo Care · 12 months after the warranty', 'لیڤۆ کێر · 12 مانگ دوای گەرەنتی'))}
            {num(draft.care.max_discount_pct, (n) => upd((d) => { d.care.max_discount_pct = Math.min(90, n ?? 0); }), loc('أقصى خصم يمنحه ليفو كير %', 'Most discount Levo Care may give %', 'زۆرترین داشکاندنی لیڤۆ کێر %'))}
            {num(draft.packaging.extra_iqd, (n) => upd((d) => { d.packaging.extra_iqd = n; }), loc('تغليف حماية إضافية', 'Extra packaging', 'پێچانەوەی زیادە'))}
            {num(draft.inspection.price_iqd, (n) => upd((d) => { d.inspection.price_iqd = n; }), loc('الفحص قبل الشحن', 'Pre-dispatch inspection', 'پشکنین پێش ناردن'))}
            <InspectionLaborField draft={draft} upd={upd} loc={loc} />
            {num(draft.academy.recorded_iqd, (n) => upd((d) => { d.academy.recorded_iqd = n; }), loc('فيديوهات مسجلة', 'Recorded videos', 'ڤیدیۆی تۆمارکراو'))}
            {num(draft.academy.live_iqd, (n) => upd((d) => { d.academy.live_iqd = n; }), loc('دورة مباشرة', 'Live course', 'خولی ڕاستەوخۆ'))}
          </div>)}

        {group('packages', say(loc, S.grpPackages), (['smart', 'complete'] as const).filter((id) => draft.packages[id].active).map((id) => say(loc, pkgName(id))).join(' · '),
          <div className="grid gap-3 sm:grid-cols-2">
            {(['smart', 'complete'] as const).map((id) => (
              <div key={id} className="rounded-lg border border-border-subtle p-2 text-[12px] text-text-secondary" data-shared-package={id}>
                <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
                  <input type="checkbox" checked={draft.packages[id].active} onChange={(e) => upd((d) => { d.packages[id].active = e.target.checked; })} />
                  {say(loc, pkgName(id))}
                </label>
                <p className="font-semibold text-text-primary">{say(loc, S.pkgContains)}:</p>
                <ul className="list-disc ps-5 leading-relaxed">
                  {packageContents(draft.packages[id], loc).map((line) => <li key={line}>{line}</li>)}
                </ul>
                {/* No package discount (owner, 2026-11-17): a package is the sum of its parts; the server refuses one. */}
              </div>
            ))}
          </div>)}

        {group('care-terms', say(loc, S.grpCare), draft.care.terms ? loc(`الإصدار ${draft.care.policy_version}`, `version ${draft.care.policy_version}`, `وەشانی ${draft.care.policy_version}`) : loc('لم تُكتب بعد', 'not written yet', 'هێشتا نەنووسراون'),
          <CareTermsPanel draft={draft} upd={upd} loc={loc} published={published} />)}

        {group('membership', say(loc, S.grpMembership), draft.membership?.active ? loc('معروضة', 'offered', 'پێشکەشکراوە') : loc('غير معروضة', 'not offered', 'پێشکەش ناکرێت'),
          <MembershipPanel draft={draft} upd={upd} loc={loc} />)}
      </fieldset>
    </div>
  );
}
