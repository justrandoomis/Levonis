/**
 * «الباقات والإضافات» — what is offered WITH this printer (phase 4, DECISIONS row 355): its filament
 * kits, its add-ons at a special price and the store bundles linked to it. Kits and add-ons made for
 * other printers are folded into one counted row, each with «أضِفها لهذه الطابعة» — by their own
 * title, never by the printers they belong to.
 */
import { addonsOf, kitsOf, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';
import { KitsPanel, onThisPrinter, text3, useNames, withThisPrinter, type Printer } from './PrinterExtrasPanels';
import AddonsPanel from './AddonsPanel';
import StoreBundlesPanel from './StoreBundlesPanel';
import { S, say, type Loc } from './adminPrinterStrings';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;

export default function PrinterOffersTab({ draft, upd, loc, lang, printers, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; printers: Printer[]; productId: string }) {
  return (
    <div className="space-y-4" data-printer-offers-tab>
      <p className="text-[12px] text-text-secondary leading-relaxed">{say(loc, S.offersIntro)}</p>
      <KitsPanel draft={draft} upd={upd} loc={loc} lang={lang} printers={printers} productId={productId} />
      <AddonsPanel draft={draft} upd={upd} loc={loc} lang={lang} printers={printers} productId={productId} />
      <StoreBundlesPanel draft={draft} upd={upd} loc={loc} lang={lang} productId={productId} />
      <OthersFold draft={draft} upd={upd} loc={loc} lang={lang} productId={productId} />
    </div>
  );
}

/** «باقات وإضافات طابعات أخرى (N)»: counted, folded, each by its own title — no printer named. */
function OthersFold({ draft, upd, loc, lang, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; productId: string }) {
  const kits = kitsOf(draft).map((k, n) => ({ k, n })).filter(({ k }) => !onThisPrinter(k.printers, productId));
  const addons = addonsOf(draft).map((a, n) => ({ a, n })).filter(({ a }) => !onThisPrinter(a.printers, productId));
  const names = useNames(addons.filter(({ a }) => !a.title && a.product_id).map(({ a }) => a.product_id), lang);
  const count = kits.length + addons.length;
  if (!count) return null;
  const enrolledIds = Object.keys(draft.products);
  const row = (key: string, kind: string, title: string, onAdd: () => void) => (
    <li key={key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-2">
      <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{kind}</span>
      <span className="min-w-0 flex-1 text-[13px] text-text-primary">{title}</span>
      <button type="button" className="lv-button lv-button-secondary lv-button-sm" onClick={onAdd}>{say(loc, S.addHere)}</button>
    </li>
  );
  return (
    <details className="rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary" data-printer-offers-others>
      <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-semibold text-text-primary">
        {say(loc, S.others)} ({count})
      </summary>
      <p className="mt-1">{say(loc, S.othersHint)}</p>
      <ul className="mt-2 space-y-2">
        {kits.map(({ k, n }) => row(`k${n}`, say(loc, S.kitKind), text3(k.title, lang) || k.id, () => upd((d) => {
          const kit = (d.kits ?? [])[n];
          if (kit) kit.printers = withThisPrinter(kit.printers, productId, true, enrolledIds);
        })))}
        {addons.map(({ a, n }) => row(`a${n}`, say(loc, S.addonKind), text3(a.title, lang) || names.get(a.product_id) || a.id, () => upd((d) => {
          const addon = (d.addons ?? [])[n];
          if (addon) addon.printers = withThisPrinter(addon.printers, productId, true, enrolledIds);
        })))}
      </ul>
    </details>
  );
}
