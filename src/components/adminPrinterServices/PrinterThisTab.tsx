/**
 * «هذه الطابعة» — the edited printer alone (owner, 2026-11-18: «I edit the A1, no need to see the
 * other printers»): its warranty family and delivery class, each a select with a visible label and
 * a hint, then its versions (each «مثل الطابعة» by default), then what the customer sees for it.
 */
import { useMemo, useState } from 'react';
import { formatIqd } from '../../lib/api';
import {
  DELIVERY_CLASSES,
  WARRANTY_FAMILIES,
  classesFor,
  servicesOffer,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';
import { CLASS_LABEL, FAMILY_LABEL, S, say, type Loc } from './adminPrinterStrings';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;
export interface ServicesPrinter { id: string; slug: string; name: string; status: string; is_used: boolean; versions: Array<{ id: string; name: string }> }
type Field = 'warranty_family' | 'delivery_class';

/** Sets (or clears, on '') one field of this printer's mapping, or of one of its versions. */
export function setMapping(d: PrinterServicesConfig, pid: string, field: Field, value: string, ov?: string) {
  const m = d.products[pid] ?? {};
  if (ov) {
    const by = { ...(m.by_option_value ?? {}) };
    const row = { ...(by[ov] ?? {}) };
    if (value) (row as Record<string, string>)[field] = value; else delete (row as Record<string, string>)[field];
    if (Object.keys(row).length) by[ov] = row; else delete by[ov];
    m.by_option_value = by;
    if (!Object.keys(by).length) delete m.by_option_value;
  } else if (value) (m as Record<string, unknown>)[field] = value;
  else delete (m as Record<string, unknown>)[field];
  // An empty list of store bundles alone does not keep a printer enrolled.
  if (Array.isArray(m.store_bundle_ids) && m.store_bundle_ids.length === 0 && !m.warranty_family && !m.delivery_class && !m.by_option_value) delete m.store_bundle_ids;
  if (Object.keys(m).length) d.products[pid] = m; else delete d.products[pid];
}

export default function PrinterThisTab({ draft, upd, loc, printer }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; printer: ServicesPrinter | null }) {
  const [preview, setPreview] = useState('');
  const offer = useMemo(() => {
    if (!printer) return null;
    const cls = classesFor(draft, printer.id, preview ? [preview] : []);
    return cls ? servicesOffer(draft, cls) : null;
  }, [draft, printer, preview]);

  if (!printer) {
    return <p className="lv-surface p-3 text-[12px] text-text-secondary" data-printer-services-empty>{say(loc, S.notMapped)}</p>;
  }
  const m = Object.hasOwn(draft.products, printer.id) ? draft.products[printer.id] : null;
  const famOpts = WARRANTY_FAMILIES.map((f) => [f, FAMILY_LABEL[f]] as const);
  const clsOpts = DELIVERY_CLASSES.map((c) => [c, say(loc, CLASS_LABEL[c])] as const);
  const set = (field: Field, value: string, ov?: string) => upd((d) => setMapping(d, printer.id, field, value, ov));
  const money = (v: number | null | undefined) => (v === null || v === undefined ? say(loc, S.priceUnknown) : formatIqd(v));

  /** A select with its own visible label; the empty choice is a word, never «—». */
  const select = (id: string, label: string, value: string, options: ReadonlyArray<readonly [string, string]>, on: (v: string) => void, empty: string, hint?: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-semibold text-text-primary">{label}</label>
      <select id={id} className="lv-input h-10 w-full px-2 text-[13px]" value={value} disabled={printer.is_used} onChange={(e) => on(e.target.value)}>
        <option value="">{empty}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint ? <p className="text-[11px] text-text-muted leading-relaxed">{hint}</p> : null}
    </div>
  );

  return (
    <div className="space-y-4" data-printer-this-tab>
      <section className="lv-surface p-3 space-y-3">
        <h3 className="text-[14px] font-bold text-text-primary">
          {printer.name}
        </h3>
        {printer.is_used ? <p className="text-[12px] text-text-secondary">{say(loc, S.usedNote)}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {select(`ps-fam-${printer.id}`, say(loc, S.famLabel), m?.warranty_family ?? '', famOpts, (v) => set('warranty_family', v), say(loc, S.choose), say(loc, S.famHint))}
          {select(`ps-cls-${printer.id}`, say(loc, S.clsLabel), m?.delivery_class ?? '', clsOpts, (v) => set('delivery_class', v), say(loc, S.choose), say(loc, S.clsHint))}
        </div>

        {m && printer.versions.length > 1 ? (
          <div className="space-y-2 border-t border-border-subtle pt-3" data-printer-versions>
            <h4 className="text-[13px] font-semibold text-text-primary">{say(loc, S.versions)}</h4>
            <p className="text-[11px] text-text-muted">{say(loc, S.versionsHint)}</p>
            <ul className="space-y-2">
              {printer.versions.map((v) => {
                const o = m.by_option_value?.[v.id];
                return (
                  <li key={v.id} className="rounded-lg border border-border-subtle p-2">
                    <p className="mb-2 text-[13px] text-text-primary">{v.name}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {select(`ps-fam-${v.id}`, say(loc, S.famLabel), o?.warranty_family ?? '', famOpts, (val) => set('warranty_family', val, v.id), say(loc, S.sameAsPrinter))}
                      {select(`ps-cls-${v.id}`, say(loc, S.clsLabel), o?.delivery_class ?? '', clsOpts, (val) => set('delivery_class', val, v.id), say(loc, S.sameAsPrinter))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="lv-surface p-3 space-y-2" data-printer-services-preview>
        <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.preview)}</h3>
        {printer.versions.length > 1 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={`ps-preview-${printer.id}`} className="text-[12px] text-text-secondary">{say(loc, S.previewOf)}</label>
            <select id={`ps-preview-${printer.id}`} className="lv-input h-10 w-full px-2 text-[13px]" value={preview} onChange={(e) => setPreview(e.target.value)}>
              <option value="">{say(loc, S.wholePrinter)}</option>
              {printer.versions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        ) : null}
        {offer ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-text-secondary">
            <dt>{loc('ضمان 12 / 24 شهراً', 'Warranty 12 / 24 months', 'گەرەنتی 12 / 24 مانگ')}</dt><dd className="tabular-nums"><span dir="ltr">{money(offer.warranty?.w12)}</span> / <span dir="ltr">{money(offer.warranty?.w24)}</span></dd>
            <dt>{loc('التوصيل اقتصادي / شخصي', 'Delivery economy / personal', 'گەیاندنی ئابووری / تایبەت')}</dt><dd className="tabular-nums"><span dir="ltr">{money(offer.delivery?.economy)}</span> / <span dir="ltr">{money(offer.delivery?.personal)}</span></dd>
            <dt>{loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.packages.smart?.price_iqd)}</dd>
            <dt>{loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.packages.complete?.price_iqd)}</dd>
          </dl>
        ) : <p className="text-[12px] text-text-secondary">{say(loc, S.noOffer)}</p>}
      </section>
    </div>
  );
}
