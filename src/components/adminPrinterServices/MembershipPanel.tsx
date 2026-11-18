/**
 * «العضوية مع الطابعة» (printer phase 2): on/off, which tiers a customer may buy WITH a printer,
 * and which tier each ready package preselects. The price is never stored here: it is the live
 * membership_plans row, shown read-only with a link to the memberships admin. Part of the shared
 * list — it applies to every enrolled printer.
 */
import { useEffect, useState } from 'react';
import { api, formatIqd } from '../../lib/api';
import { tierLabel } from '../subscription/tierMeta';
import { MEMBERSHIP_TIERS, type MembershipTier, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';
import { pkgName, say, type Loc } from './adminPrinterStrings';
import type { Upd } from './itemToolkit';

interface AdminPlan { id: string; tier: string; duration_months: number; price_iqd: number | null; active: boolean; paused?: boolean }

export function MembershipPanel({ draft, upd, loc }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc }) {
  const m = draft.membership ?? { active: false, tiers: [] };
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [planError, setPlanError] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ plans: AdminPlan[] }>('/api/memberships/admin/plans')
      .then((r) => { if (live) setPlans(r.plans ?? []); })
      .catch(() => { if (live) setPlanError(true); });
    return () => { live = false; };
  }, []);
  const months = (n: number) => loc(`${n} شهر`, `${n} months`, `${n} مانگ`);
  const setTier = (t: MembershipTier, on: boolean) => upd((d) => {
    const cur = d.membership ?? { active: false, tiers: [] };
    const tiers = on ? [...new Set([...cur.tiers, t])] : cur.tiers.filter((x) => x !== t);
    d.membership = { active: cur.active, tiers: MEMBERSHIP_TIERS.filter((x) => tiers.includes(x)) };
    // A package cannot preselect a tier that is no longer offered (the publish refuses it).
    for (const id of ['smart', 'complete'] as const) {
      const pt = d.packages[id].membership_tier;
      if (pt && !d.membership.tiers.includes(pt)) d.packages[id].membership_tier = null;
    }
  });

  return (
    <section className="text-[12px] text-text-secondary" data-printer-services-membership>
      {/* The group that holds this panel already says «العضوية مع الطابعة»: no second heading here. */}
      <p>
        {loc(
          'سطر مستقل في الطلب بسعر الخطة الحالي (ناقص رصيد الترقية). تبدأ فقط عند تسليم الطلب ودفعه، ولا تُسترد بعد أن تبدأ.',
          'Its own order line at the live plan price (less any upgrade credit). It starts only when the order is delivered and paid, and is non-refundable once started.',
          'هێڵێکی جیا لە داواکاریدا بە نرخی ئێستای پلانەکە (کەمکردنەوەی باڵانسی بەرزکردنەوە). تەنها کاتێک داواکارییەکە گەیەندرا و پارەکەی درا دەست پێدەکات، و دوای دەستپێکردن پارەکەی ناگەڕێتەوە.'
        )}
      </p>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
        <input type="checkbox" checked={m.active} onChange={(e) => upd((d) => { d.membership = { active: e.target.checked, tiers: [...(d.membership?.tiers ?? [])] }; })} />
        {loc('عرض صف العضوية للزبائن', 'Show the membership row to customers', 'ڕیزی ئەندامێتی بۆ کڕیاران پیشان بدە')}
      </label>
      <div className="mt-2 flex flex-wrap gap-3" role="group" aria-label={loc('المستويات المعروضة', 'Tiers offered', 'ئاستە پێشکەشکراوەکان')}>
        {MEMBERSHIP_TIERS.map((t) => (
          <label key={t} className="flex min-h-11 items-center gap-2 text-[13px] text-text-primary">
            <input type="checkbox" checked={m.tiers.includes(t)} onChange={(e) => setTier(t, e.target.checked)} />
            {tierLabel(t)}
          </label>
        ))}
      </div>

      <h3 className="mt-3 font-semibold text-text-primary">{loc('أسعار الخطط الحالية (للقراءة فقط)', 'Live plan prices (read only)', 'نرخی ئێستای پلانەکان (تەنها خوێندنەوە)')}</h3>
      {planError ? (
        <p className="mt-1">{loc('تعذّر تحميل الخطط.', 'The plans could not be loaded.', 'پلانەکان بار نەکران.')}</p>
      ) : !plans ? (
        <p className="mt-1">{loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}</p>
      ) : (
        <ul className="mt-1 space-y-1" data-printer-services-plans>
          {plans.filter((p) => (MEMBERSHIP_TIERS as readonly string[]).includes(p.tier)).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{tierLabel(p.tier)} · {months(p.duration_months)}{!p.active ? ` · ${loc('غير مفعّلة', 'inactive', 'ناچالاک')}` : p.paused ? ` · ${loc('متوقفة', 'paused', 'ڕاگیراو')}` : ''}</span>
              <span dir="ltr" className="tabular-nums text-text-primary">{p.price_iqd === null ? loc('بلا سعر', 'unpriced', 'بێ نرخ') : formatIqd(p.price_iqd)}</span>
            </li>
          ))}
        </ul>
      )}
      <a href="/admin?tab=memberships" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center text-[12px] text-text-primary underline">
        {loc('تعديل الأسعار في إدارة العضويات', 'Change the prices in Memberships admin', 'گۆڕینی نرخەکان لە بەڕێوەبردنی ئەندامێتی')}
      </a>

      <h3 className="mt-3 font-semibold text-text-primary">{loc('ما تختاره كل باقة مسبقاً', 'What each package preselects', 'ئەوەی هەر پاکێجێک پێشوەختە هەڵیدەبژێرێت')}</h3>
      <p className="mt-1">{loc('تلميح فقط: الزبون يرى المستوى مقترحاً ويقرر بنفسه، والعضوية لا تدخل في سعر الباقة.', 'A hint only: the customer sees the tier suggested and decides; the membership is never in the package price.', 'تەنها ئاماژەیە: کڕیار ئاستەکە وەک پێشنیار دەبینێت و خۆی بڕیار دەدات؛ ئەندامێتی هەرگیز ناچێتە نێو نرخی پاکێجەوە.')}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(['smart', 'complete'] as const).map((id) => (
          <label key={id} className="flex flex-col gap-1">
            {say(loc, pkgName(id))}
            <select
              className="lv-input h-11 px-2 text-[13px]"
              value={draft.packages[id].membership_tier ?? ''}
              onChange={(e) => upd((d) => { d.packages[id].membership_tier = (e.target.value || null) as MembershipTier | null; })}
            >
              <option value="">{loc('بدون', 'None', 'هیچ')}</option>
              {m.tiers.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}
