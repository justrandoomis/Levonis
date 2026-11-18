/**
 * «إضافات بسعر خاص» (printer phase 4, DECISIONS row 355): a store product — a nozzle, a plate … —
 * sold WITH this printer at the owner's discount, `qty` units per printer (it follows the printer's
 * quantity), as its own order line the customer may remove. Never a printer, never a bundle or a
 * mystery offer (the picker leaves them out and the publish refuses them).
 *
 * Only the add-ons this printer offers are edited here; whether one shows with this printer is one
 * switch on this printer's entry. Add-ons of other printers are counted in the offers tab's fold.
 */
import { useState } from 'react';
import ProductPicker from '../adminProducts/form/ProductPicker';
import {
  MAX_ADDONS,
  MAX_ADDON_QTY,
  type PrinterAddon,
  type PrinterServicesConfig,
  type Text3,
} from '../../../packages/pricing/src/printerServices';
import { DiscountRow, ItemRow, KIT_ID, PrinterScope, SharedBadge, onThisPrinter, perPrinterEstimate, pick3, text3, useDocs, useNames, type Printer } from './PrinterExtrasPanels';
import { S, discountPreview, say, type Loc } from './adminPrinterStrings';
import { formatIqd } from '../../lib/api';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;

/** Invalid and repeated add-on ids, found before the save would refuse them. */
export function addonIdProblems(addons: readonly PrinterAddon[]): Array<'bad' | 'dup' | null> {
  const seen = new Set<string>();
  return addons.map((a) => {
    if (!KIT_ID.test(a.id)) return 'bad';
    if (seen.has(a.id)) return 'dup';
    seen.add(a.id);
    return null;
  });
}

/** What the save would refuse in the add-ons: a bad or repeated id, or one with no product picked yet. */
export const addonsBlocked = (addons: readonly PrinterAddon[]) =>
  addonIdProblems(addons).some(Boolean) || addons.some((a) => !a.product_id);

export default function AddonsPanel({ draft, upd, loc, lang, printers, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; printers: Printer[]; productId: string }) {
  const addons = draft.addons ?? [];
  const ids = addons.map((a) => a.product_id).filter(Boolean);
  const docs = useDocs(ids);
  const names = useNames(ids, lang);
  const [picking, setPicking] = useState<number | null>(null);
  const [refused, setRefused] = useState('');
  const printer = printers.find((p) => p.id === productId) ?? null;
  const enrolledIds = Object.keys(draft.products);
  const printerIds = new Set([...printers.map((p) => p.id), ...enrolledIds]);
  const idProblems = addonIdProblems(addons);
  const here = addons.map((a, n) => ({ a, n })).filter(({ a }) => onThisPrinter(a.printers, productId));

  const at = (d: PrinterServicesConfig, n: number) => (d.addons ?? [])[n];
  const onAddon = (n: number, fn: (a: PrinterAddon) => void) => upd((d) => fn(at(d, n)));
  const add = () => upd((d) => {
    const list = d.addons ?? [];
    let k = list.length + 1;
    while (list.some((a) => a.id === `addon-${k}`)) k += 1;
    // An add-on made on a printer's page starts on that printer alone, switched off until it has a product.
    d.addons = [...list, {
      id: `addon-${k}`, active: false, sort: list.length, title: null, product_id: '', option_value_ids: [], color_id: null,
      color_mode: 'fixed', qty: 1, discount: null, printers: [{ product_id: productId, option_value_id: null }],
    }];
    setPicking(list.length);
  });

  return (
    <section className="rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary space-y-2" data-printer-services-addons>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.addons)}</h3>
        <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={addons.length >= MAX_ADDONS} onClick={add}>
          + {say(loc, S.newAddon)}
        </button>
      </div>
      <p className="leading-relaxed">{say(loc, S.addonsHint)}</p>
      {here.length === 0 ? <p>{say(loc, S.noAddonsHere)}</p> : null}
      <div className="space-y-3">
        {here.map(({ a, n }) => {
          const doc = a.product_id ? docs[a.product_id] : undefined;
          const productName = doc ? pick3(doc, lang) : names.get(a.product_id) ?? a.product_id;
          const shown = text3(a.title, lang) || productName || a.id;
          const before = a.product_id ? perPrinterEstimate([{ product_id: a.product_id, qty: a.qty }], docs, 'price_iqd') : null;
          const cost = a.product_id ? perPrinterEstimate([{ product_id: a.product_id, qty: a.qty }], docs, 'cost_iqd') : null;
          const view = discountPreview(a.discount, before);
          const problem = idProblems[n];
          return (
            <details key={n} className="rounded-lg border border-border-subtle p-2" open={picking === n || !a.product_id || !!problem || undefined} data-printer-services-addon={a.id}>
              <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-[13px] text-text-primary">
                <span className="min-w-0 flex-1 font-semibold">{shown}{a.qty > 1 ? ` ×${a.qty}` : ''}</span>
                {a.printers === null ? <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{say(loc, S.everyPrinter)}</span> : null}
                <SharedBadge refs={a.printers} productId={productId} loc={loc} />
                {!a.active ? <span className="lv-chip [--chip:var(--color-warning)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{loc('موقوفة', 'Off', 'ڕاگیراو')}</span> : null}
                {view ? (
                  <span className="inline-flex items-baseline gap-1.5 text-[12px]">
                    <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(view.before)}</span>
                    <span dir="ltr" className="tabular-nums font-bold">{formatIqd(view.after)}</span>
                  </span>
                ) : before !== null ? <span dir="ltr" className="tabular-nums text-[12px]">{formatIqd(before)}</span> : null}
              </summary>

              <div className="mt-2 space-y-3">
                <PrinterScope refs={a.printers} printer={printer} productId={productId} enrolledIds={enrolledIds} loc={loc} onChange={(refs) => onAddon(n, (x) => { x.printers = refs; })} />

                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1">
                    {say(loc, S.id)}
                    <input className="lv-input h-9 px-2 text-[12px]" dir="ltr" maxLength={32} aria-invalid={!!problem || undefined} value={a.id} onChange={(e) => onAddon(n, (x) => { x.id = e.target.value.toLowerCase(); })} />
                  </label>
                  <label className="flex flex-col gap-1">
                    {say(loc, S.sort)}
                    <input className="lv-input h-9 px-2 text-[12px] tabular-nums" inputMode="numeric" dir="ltr" value={String(a.sort)}
                      onChange={(e) => onAddon(n, (x) => { x.sort = Math.min(999, Number(e.target.value.replace(/[^\d]/g, '') || 0)); })} />
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
                    <input type="checkbox" checked={a.active} disabled={!a.product_id} onChange={(e) => onAddon(n, (x) => { x.active = e.target.checked; })} />
                    {say(loc, S.active)}
                  </label>
                  <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => upd((d) => { d.addons = (d.addons ?? []).filter((_, j) => j !== n); })}>
                    {say(loc, S.addonRemove)}
                  </button>
                </div>
                {problem ? <p className="text-text-primary" role="alert" data-addon-problem={problem}>{say(loc, problem === 'dup' ? S.idDup : S.idRule)}</p> : null}

                <div className="space-y-1">
                  <h4 className="font-semibold text-text-primary">{say(loc, S.addonProduct)}</h4>
                  {a.product_id && picking !== n ? (
                    <ul className="space-y-2">
                      <ItemRow
                        item={a}
                        doc={doc}
                        name={productName}
                        loc={loc}
                        lang={lang}
                        maxQty={MAX_ADDON_QTY}
                        qtyLabel={say(loc, S.addonQty)}
                        onChange={(patch) => onAddon(n, (x) => { Object.assign(x, patch); x.option_value_ids = [...x.option_value_ids].sort(); })}
                      />
                    </ul>
                  ) : null}
                  {picking === n || !a.product_id ? (
                    <div>
                      <ProductPicker
                        value=""
                        excludeIds={printerIds}
                        ariaLabel={say(loc, S.addonPick)}
                        onChange={(id) => {
                          if (!id) return;
                          // The picker already leaves bundles and mystery offers out (excludeComposition).
                          if (printerIds.has(id)) { setRefused(say(loc, S.addonNoPrinter)); return; }
                          setRefused('');
                          onAddon(n, (x) => { x.product_id = id; x.option_value_ids = []; x.color_id = null; x.color_mode = 'fixed'; });
                          setPicking(null);
                        }}
                      />
                      {refused ? <p className="mt-1 text-text-primary" role="alert">{refused}</p> : null}
                    </div>
                  ) : (
                    <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => setPicking(n)}>
                      {loc('غيّر المنتج', 'Change the product', 'بەرهەمەکە بگۆڕە')}
                    </button>
                  )}
                </div>

                <TitleOverride title={a.title} productName={productName} loc={loc} onChange={(t) => onAddon(n, (x) => { x.title = t; })} />

                <DiscountRow
                  value={a.discount}
                  onChange={(d) => onAddon(n, (x) => { x.discount = d; })}
                  beforeIqd={before}
                  costIqd={cost}
                  loc={loc}
                  label={loc('خصم الإضافة', 'Add-on discount', 'داشکاندنی زیادکراو')}
                />
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** The add-on's own name in three languages, or none (null) to show the product's name. */
function TitleOverride({ title, productName, loc, onChange }: { title: Text3 | null; productName: string; loc: Loc; onChange: (t: Text3 | null) => void }) {
  const field = (k: keyof Text3, label: string) => (
    <label className="flex flex-col gap-1">
      {label}
      <input className="lv-input h-9 px-2 text-[13px]" dir={k === 'en' ? 'ltr' : 'rtl'} maxLength={80} value={title?.[k] ?? ''}
        onChange={(e) => onChange({ ...(title ?? { ar: '', en: '', ckb: '' }), [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="space-y-1">
      <label className="flex min-h-11 items-center gap-2 text-[13px] text-text-primary">
        <input type="checkbox" checked={title !== null} onChange={(e) => onChange(e.target.checked ? { ar: '', en: '', ckb: '' } : null)} />
        {say(loc, S.addonOwnName)}
      </label>
      {title === null ? (
        <p className="text-[11px] text-text-muted">{say(loc, S.addonUsesProductName)}{productName ? `: ${productName}` : ''}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {field('ar', say(loc, S.nameAr))}
          {field('en', say(loc, S.nameEn))}
          {field('ckb', say(loc, S.nameCkb))}
        </div>
      )}
    </div>
  );
}
