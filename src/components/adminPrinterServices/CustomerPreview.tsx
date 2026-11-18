/**
 * «ما يراه الزبون» — everything a customer is offered with THIS printer, from the draft on screen
 * (phase 5, DECISIONS row 358): the warranty (none / 12 / 24 months), Levo Care with the total
 * cover it gives beside each warranty (12 / 24 / 36 months: Care is the 12 months AFTER the
 * warranty), packaging, the inspection, the academy, delivery, the ready packages said in words,
 * the membership row, and this printer's kits, add-ons and store bundles.
 *
 * The services' prices are the list's own (exact). A kit's or an add-on's price is an ESTIMATE from
 * the products' prices now — the cart prices them at the customer's tier — and is marked so.
 */
import { useState, type ReactNode } from 'react';
import { formatIqd } from '../../lib/api';
import { tierLabel } from '../subscription/tierMeta';
import {
  addonsForPrinter,
  careTotalMonths,
  classesFor,
  kitsForPrinter,
  servicesOffer,
  storeBundleIdsFor,
  type PrinterServicesConfig,
  type WarrantyChoice,
} from '../../../packages/pricing/src/printerServices';
import { Fold, perPrinterEstimate, pick3, text3, useDocs, useNames } from './itemToolkit';
import { bundleName, useStoreBundles } from './StoreBundlesPanel';
import { S, discountPreview, packageContents, pkgName, say, type Loc, type Tri } from './adminPrinterStrings';
import { PS_STRINGS } from '../product/printerServicesStrings';
import type { ServicesPrinter } from './PrinterThisTab';

export default function CustomerPreview({ draft, loc, lang, printer }: { draft: PrinterServicesConfig; loc: Loc; lang: string; printer: ServicesPrinter }) {
  const [version, setVersion] = useState('');
  const picked = version && printer.versions.some((v) => v.id === version) ? [version] : [];
  const cls = classesFor(draft, printer.id, picked);
  const offer = cls ? servicesOffer(draft, cls) : null;
  const kits = cls ? kitsForPrinter(draft, printer.id, picked) : [];
  const addons = cls ? addonsForPrinter(draft, printer.id, picked) : [];
  const bundleIds = cls ? storeBundleIdsFor(draft, printer.id) : [];
  const productIds = [...kits.flatMap((k) => k.items.map((i) => i.product_id)), ...addons.map((a) => a.product_id)];
  const docs = useDocs(productIds);
  const names = useNames(addons.filter((a) => !a.title).map((a) => a.product_id), lang);
  const bundles = useStoreBundles();
  const bundleRows = Array.isArray(bundles) ? bundles : [];

  const money = (v: number | null | undefined): ReactNode => (v === null || v === undefined
    ? <span className="text-text-muted">{say(loc, S.pvNotOffered)}</span>
    : v === 0 ? say(loc, S.pvFree) : <span dir="ltr">{formatIqd(v)}</span>);
  const row = (key: string, label: ReactNode, value: ReactNode, sub?: ReactNode) => (
    <li key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
      <span className="min-w-0 text-text-primary">{label}{sub ? <span className="block text-[11px] text-text-muted leading-relaxed">{sub}</span> : null}</span>
      <span className="ms-auto shrink-0 tabular-nums font-semibold text-text-primary">{value}</span>
    </li>
  );
  const group = (key: string, title: Tri, rows: ReactNode, hint?: Tri) => (
    <section key={key} className="border-t border-border-subtle pt-2" data-preview-group={key}>
      <h4 className="text-[12px] font-bold text-text-secondary">{say(loc, title)}</h4>
      {hint ? <p className="text-[11px] text-text-muted leading-relaxed">{say(loc, hint)}</p> : null}
      <ul className="text-[13px]">{rows}</ul>
    </section>
  );
  const off = (key: string, title: Tri) => group(key, title, row('off', <span className="text-text-muted">{say(loc, S.pvOff)}</span>, ''));
  /** An estimated price with the owner's discount: before struck through, after, «تقديري». */
  const estimate = (before: number | null, discount: Parameters<typeof discountPreview>[0]): ReactNode => {
    if (before === null) return <span className="text-text-muted">{say(loc, S.priceUnknown)}</span>;
    const view = discountPreview(discount, before);
    return (
      <span className="inline-flex flex-wrap items-baseline justify-end gap-1.5">
        {view ? <span dir="ltr" className="line-through text-text-muted font-normal">{formatIqd(view.before)}</span> : null}
        <span dir="ltr">{formatIqd(view ? view.after : before)}</span>
        <span className="text-[11px] font-normal text-text-muted">({say(loc, S.pvEstimate)})</span>
      </span>
    );
  };
  const months = (n: number) => loc(`${n} شهراً`, `${n} months`, `${n} مانگ`);
  const warrantyWord = (w: WarrantyChoice) => say(loc, w === 'none' ? S.pvNoWarranty : w === 'w12' ? S.pvWith12 : S.pvWith24);

  return (
    <section className="lv-surface p-3 space-y-2" data-printer-services-preview>
      <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.preview)}</h3>
      <p className="text-[11px] text-text-muted leading-relaxed">{say(loc, S.previewNote)}</p>
      {printer.versions.length > 1 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`ps-preview-${printer.id}`} className="text-[12px] text-text-secondary">{say(loc, S.previewOf)}</label>
          <select id={`ps-preview-${printer.id}`} className="lv-input h-11 w-full px-2 text-[13px]" value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">{say(loc, S.wholePrinter)}</option>
            {printer.versions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      ) : null}

      {!offer ? <p className="text-[13px] text-text-secondary leading-relaxed" data-preview-empty>{say(loc, S.noOffer)}</p> : (
        <div className="space-y-2">
          {offer.warranty ? group('warranty', S.pvWarranty, <>
            {row('none', say(loc, S.pvNoWarranty), say(loc, S.pvFree))}
            {row('w12', say(loc, S.pvMonths12), money(offer.warranty.w12))}
            {row('w24', say(loc, S.pvMonths24), money(offer.warranty.w24))}
          </>) : off('warranty', S.pvWarranty)}

          {offer.care ? group('care', S.pvCare, <>
            {row('c12', say(loc, S.pvCarePrice), money(offer.care.c12))}
            {/* The customer's own line of what Care includes (DECISIONS row 359): the same words the product page says. */}
            <li className="py-1" data-preview-care-includes>
              <span className="text-[12px] text-text-secondary">{PS_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'].careIncludes(offer.care.max_discount_pct ?? 90)}</span>
            </li>
            {offer.care.c12 !== null ? (
              <li className="py-1" data-preview-care-totals>
                <span className="text-[12px] text-text-secondary">{say(loc, S.pvCareTotal)}</span>
                <ul className="mt-1 grid grid-cols-3 gap-1.5 text-center">
                  {(['none', 'w12', 'w24'] as const).map((w) => (
                    <li key={w} className="rounded-lg border border-border-subtle p-1.5" data-care-total={careTotalMonths(w, 'c12')}>
                      <span className="block text-[11px] text-text-muted leading-snug">{warrantyWord(w)}</span>
                      <span className="block text-[13px] font-bold tabular-nums text-text-primary">{months(careTotalMonths(w, 'c12'))}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}
          </>, S.pvCareHint) : off('care', S.pvCare)}

          {offer.delivery ? group('delivery', S.pvDelivery, <>
            {row('economy', say(loc, S.pvEconomy), money(offer.delivery.economy))}
            {row('personal', say(loc, S.pvPersonal), money(offer.delivery.personal))}
          </>) : off('delivery', S.pvDelivery)}

          {/* The three a customer weighs first stay open; the rest is one tap away. */}
          <Fold className="border-t border-border-subtle" attrs={{ 'data-preview-more': '' }}
            summaryClassName="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-text-primary [&::-webkit-details-marker]:hidden" summary={say(loc, S.pvMore)}>
          <div className="space-y-2 pb-2">
          {offer.packaging ? group('packaging', S.pvPackaging, <>
            {row('standard', say(loc, S.pvStandard), say(loc, S.pvFree))}
            {row('extra', say(loc, S.pvExtra), money(offer.packaging.extra))}
          </>) : off('packaging', S.pvPackaging)}

          {offer.inspection ? group('inspection', S.pvInspection,
            row('full', say(loc, S.pvInspection), money(offer.inspection.full),
              loc(`يضيف ${offer.inspection.lead_business_days[0]}–${offer.inspection.lead_business_days[1]} أيام عمل قبل الشحن`, `adds ${offer.inspection.lead_business_days[0]}–${offer.inspection.lead_business_days[1]} business days before dispatch`, `${offer.inspection.lead_business_days[0]}–${offer.inspection.lead_business_days[1]} ڕۆژی کار پێش ناردن زیاد دەکات`))
          ) : off('inspection', S.pvInspection)}

          {offer.academy ? group('academy', S.pvAcademy, <>
            {row('recorded', say(loc, S.pvRecorded), money(offer.academy.recorded))}
            {row('live', say(loc, S.pvLive), money(offer.academy.live))}
          </>) : null}

          {group('packages', S.pvPackages, <>
            {row('just', say(loc, S.pvJust), say(loc, S.pvFree))}
            {(['smart', 'complete'] as const).map((id) => {
              const p = offer.packages[id];
              return row(id, say(loc, pkgName(id)), p ? money(p.price_iqd) : <span className="text-text-muted">{say(loc, S.pvNotOffered)}</span>,
                p ? packageContents(p.includes, loc).join(loc(' + ', ' + ', ' + ')) : undefined);
            })}
          </>)}

          {group('membership', S.pvMembership,
            row('tiers', offer.membership ? offer.membership.tiers.map((t) => tierLabel(t)).join(loc('، ', ', ', '، ')) : <span className="text-text-muted">{say(loc, S.pvNotOffered)}</span>,
              offer.membership ? loc('بسعر الخطة الحالي', 'at the live plan price', 'بە نرخی ئێستای پلانەکە') : ''))}
          </div>
          </Fold>

          {group('kits', S.pvKits, kits.length
            ? kits.map((k) => row(k.id, text3(k.title, lang) || loc('باقة بلا اسم', 'Unnamed kit', 'پاکێجی بێ ناو'), estimate(perPrinterEstimate(k.items, docs, 'price_iqd'), k.discount ?? null)))
            : row('none', <span className="text-text-muted">{say(loc, S.pvNone)}</span>, ''))}

          {group('addons', S.pvAddons, addons.length
            ? addons.map((a) => {
              const doc = docs[a.product_id];
              const name = text3(a.title, lang) || (doc ? pick3(doc, lang) : names.get(a.product_id)) || loc('منتج', 'Product', 'بەرهەم');
              return row(a.id, `${name}${a.qty > 1 ? ` ×${a.qty}` : ''}`, estimate(perPrinterEstimate([{ product_id: a.product_id, qty: a.qty }], docs, 'price_iqd'), a.discount ?? null));
            })
            : row('none', <span className="text-text-muted">{say(loc, S.pvNone)}</span>, ''))}

          {group('bundles', S.pvBundles, bundleIds.length
            ? bundleIds.map((id) => {
              const b = bundleRows.find((x) => x.id === id);
              return row(id, b ? bundleName(b, lang) : loc('عرض مجمّع', 'Store bundle', 'پاکێجی کۆکراوە'), b && b.bundle_price_iqd !== null ? <span dir="ltr">{formatIqd(b.bundle_price_iqd)}</span> : '',
                b && b.status !== 'active' ? say(loc, S.bundleHidden) : undefined);
            })
            : row('none', <span className="text-text-muted">{say(loc, S.pvNone)}</span>, ''))}
        </div>
      )}
    </section>
  );
}
