/**
 * Step ١ — the edited printer alone (owner, 2026-11-18: «I edit the A1, no need to see the other
 * printers»): its warranty family and delivery class, each a select with a visible label and a
 * one-line hint. Its versions follow the printer («مثل الطابعة») and are folded away until one of
 * them differs. What the customer then sees is CustomerPreview, right under this step.
 */
import {
  DELIVERY_CLASSES,
  WARRANTY_FAMILIES,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';
import { CLASS_LABEL, FAMILY_LABEL, S, say, type Loc } from './adminPrinterStrings';
import { Fold } from './itemToolkit';

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
  if (!printer) {
    return <p className="text-[13px] text-text-secondary leading-relaxed" data-printer-services-empty>{say(loc, S.notMapped)}</p>;
  }
  if (printer.is_used) {
    // A printer graded AFTER it was given a family and class: the save refuses the stale entry until it is removed.
    const stale = Object.hasOwn(draft.products, printer.id);
    return (
      <div className="space-y-2" data-printer-services-used>
        <p className="text-[13px] text-text-secondary leading-relaxed">{say(loc, S.usedNote)}</p>
        {stale ? (
          <button type="button" className="lv-button lv-button-secondary" onClick={() => upd((d) => { delete d.products[printer.id]; })} data-printer-used-remove>
            {loc('أزل اختيارات الضمان والتوصيل القديمة لهذه الطابعة', 'Remove this printer\'s old warranty and delivery choices', 'هەڵبژاردنە کۆنەکانی گەرەنتی و گەیاندنی ئەم پرینتەرە لابە')}
          </button>
        ) : null}
      </div>
    );
  }
  const m = Object.hasOwn(draft.products, printer.id) ? draft.products[printer.id] : null;
  const famOpts = WARRANTY_FAMILIES.map((f) => [f, FAMILY_LABEL[f]] as const);
  const clsOpts = DELIVERY_CLASSES.map((c) => [c, say(loc, CLASS_LABEL[c])] as const);
  const set = (field: Field, value: string, ov?: string) => upd((d) => setMapping(d, printer.id, field, value, ov));
  const versionsDiffer = Object.keys(m?.by_option_value ?? {}).length > 0;

  /** A select with its own visible label; the empty choice is a word, never «—». */
  const select = (id: string, label: string, value: string, options: ReadonlyArray<readonly [string, string]>, on: (v: string) => void, empty: string, hint?: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-semibold text-text-primary">{label}</label>
      <select id={id} className="lv-input h-11 w-full px-2 text-[14px]" value={value} onChange={(e) => on(e.target.value)}>
        <option value="">{empty}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint ? <p className="text-[11px] text-text-muted leading-relaxed">{hint}</p> : null}
    </div>
  );

  return (
    <div className="space-y-3" data-printer-this-tab>
      <div className="grid gap-3 sm:grid-cols-2">
        {select(`ps-fam-${printer.id}`, say(loc, S.famLabel), m?.warranty_family ?? '', famOpts, (v) => set('warranty_family', v), say(loc, S.choose), say(loc, S.famHint))}
        {select(`ps-cls-${printer.id}`, say(loc, S.clsLabel), m?.delivery_class ?? '', clsOpts, (v) => set('delivery_class', v), say(loc, S.choose), say(loc, S.clsHint))}
      </div>

      {m && printer.versions.length > 1 ? (
        <Fold className="border-t border-border-subtle pt-2" open={versionsDiffer} attrs={{ 'data-printer-versions': '' }}
          summaryClassName="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-text-primary [&::-webkit-details-marker]:hidden" summary={say(loc, S.versions)}>
          <p className="text-[11px] text-text-muted leading-relaxed">{say(loc, S.versionsHint)}</p>
          <ul className="mt-2 space-y-2">
            {printer.versions.map((v) => {
              const o = m.by_option_value?.[v.id];
              return (
                <li key={v.id} className="rounded-lg border border-border-subtle p-2">
                  <p className="mb-2 text-[13px] font-semibold text-text-primary">{v.name}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {select(`ps-fam-${v.id}`, say(loc, S.famLabel), o?.warranty_family ?? '', famOpts, (val) => set('warranty_family', val, v.id), say(loc, S.sameAsPrinter))}
                    {select(`ps-cls-${v.id}`, say(loc, S.clsLabel), o?.delivery_class ?? '', clsOpts, (val) => set('delivery_class', val, v.id), say(loc, S.sameAsPrinter))}
                  </div>
                </li>
              );
            })}
          </ul>
        </Fold>
      ) : null}
    </div>
  );
}
