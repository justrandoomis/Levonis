/**
 * «باقات الفيلامنت» (printer phase 2, discounts and customer colours phase 4): owner-made kits of
 * real products with a per-printer quantity. A kit costs the sum of its items' live prices, less
 * the owner's kit discount when one is set. On ONE printer's page: only the kits that printer
 * offers are edited here; whether a kit shows with this printer is one switch on this printer's
 * entry alone, and kits of other printers are counted in the fold below, never listed by printer.
 */
import { useEffect, useState } from 'react';
import { api, formatIqd } from '../../lib/api';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { refusalText } from '../../lib/refusalStrings';
import {
  MAX_KITS,
  MAX_KIT_ITEMS,
  colorModeOf,
  kitItemKey,
  type FilamentKit,
  type KitItem,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';
import { AdvancedFold, DiscountRow, Fold, ItemRow, KIT_ID, PrinterScope, SharedBadge, onThisPrinter, perPrinterEstimate, text3, useDocs, useNames, type Printer, type ProductDoc, type Upd } from './itemToolkit';
import { S, discountPreview, say, type Loc } from './adminPrinterStrings';

/**
 * What the save and publish would refuse in the kits, found before asking (phase 2 review U9): an
 * invalid id, an id used by an earlier kit, the same product and selection twice in one kit, and a
 * printer (any product in a printer section, mapped or not) as a kit item. One entry per kit; the
 * item problems name the item's index.
 */
export interface KitProblems { badId: boolean; dupId: boolean; dupItems: number[]; printerItems: number[] }
export function kitProblems(kits: readonly FilamentKit[], printerIds: ReadonlySet<string>): KitProblems[] {
  const seen = new Set<string>();
  return kits.map((k) => {
    const badId = !KIT_ID.test(k.id);
    const dupId = !badId && seen.has(k.id);
    seen.add(k.id);
    const keys = new Set<string>();
    // Phase 4: a product whose colour the customer picks appears once (with its selection) in the kit.
    const selections = new Set<string>();
    const customerSelections = new Set<string>();
    const dupItems: number[] = [];
    const printerItems: number[] = [];
    k.items.forEach((it, j) => {
      const key = kitItemKey(it);
      const sel = `${it.product_id}|${[...it.option_value_ids].sort().join(',')}`;
      const customer = colorModeOf(it) === 'customer';
      if (keys.has(key) || customerSelections.has(sel) || (customer && selections.has(sel))) dupItems.push(j);
      keys.add(key);
      selections.add(sel);
      if (customer) customerSelections.add(sel);
      if (printerIds.has(it.product_id)) printerItems.push(j);
    });
    return { badId, dupId, dupItems, printerItems };
  });
}
export const kitsBlocked = (kits: readonly FilamentKit[], printerIds: ReadonlySet<string>) =>
  kitProblems(kits, printerIds).some((p) => p.badId || p.dupId || p.dupItems.length > 0 || p.printerItems.length > 0);

interface PreviewKit {
  id: string; title: { ar: string; en: string; ckb: string } | null; available: boolean; price_per_printer_iqd: number | null; total_iqd: number | null;
  /** Phase 4 (WP-B): the price before the owner's kit discount; absent from an older server. */
  before_per_printer_iqd?: number | null;
  items: Array<{ product_id: string; name: string; name_ar: string; variant: string; qty: number; unit_price_iqd: number | null; available: boolean; reason: string | null }>;
}

export function KitsPanel({ draft, upd, loc, lang, printers, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; printers: Printer[]; productId: string }) {
  const kits = draft.kits ?? [];
  const itemIds = kits.flatMap((k) => k.items.map((i) => i.product_id));
  const docs = useDocs(itemIds);
  const names = useNames(itemIds, lang);
  const [adding, setAdding] = useState<number | null>(null);
  const printer = printers.find((p) => p.id === productId) ?? null;
  const enrolledIds = Object.keys(draft.products);
  // Every product in a printer section (mapped or not): none of them can be a kit item.
  const printerIds = new Set([...printers.map((p) => p.id), ...enrolledIds]);
  const problems = kitProblems(kits, printerIds);
  // Only the kits this printer offers; their index in the shared list is what `upd` edits.
  const here = kits.map((k, n) => ({ k, n })).filter(({ k }) => onThisPrinter(k.printers, productId));

  const kitAt = (d: PrinterServicesConfig, n: number) => (d.kits ?? [])[n];
  const addKit = () => upd((d) => {
    const list = d.kits ?? [];
    let n = list.length + 1;
    while (list.some((k) => k.id === `kit-${n}`)) n += 1;
    // A kit made on a printer's page starts on that printer alone.
    d.kits = [...list, { id: `kit-${n}`, active: false, sort: list.length, title: { ar: '', en: '', ckb: '' }, items: [], printers: [{ product_id: productId, option_value_id: null }], discount: null }];
    setAdding(list.length);
  });
  const removeKit = (n: number) => upd((d) => { d.kits = (d.kits ?? []).filter((_, j) => j !== n); });
  const setItem = (n: number, j: number, patch: Partial<KitItem>) => upd((d) => {
    const it = kitAt(d, n).items[j];
    Object.assign(it, patch);
    it.option_value_ids = [...it.option_value_ids].sort();
  });

  return (
    <section className="text-[12px] text-text-secondary space-y-2" data-printer-services-kits>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.kits)}</h3>
        <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={kits.length >= MAX_KITS} onClick={addKit}>
          + {loc('باقة جديدة', 'New kit', 'پاکێجی نوێ')}
        </button>
      </div>
      <p className="leading-relaxed">{say(loc, S.kitsHint)}</p>
      {here.length === 0 ? <p>{say(loc, S.noKitsHere)}</p> : null}
      <div className="space-y-3">
        {here.map(({ k, n }) => (
          <KitEditor
            key={n}
            kit={k}
            loc={loc}
            lang={lang}
            docs={docs}
            names={names}
            printer={printer}
            productId={productId}
            enrolledIds={enrolledIds}
            adding={adding === n}
            problems={problems[n]}
            isPrinter={(id) => printerIds.has(id)}
            onAdding={(on) => setAdding(on ? n : null)}
            onKit={(fn) => upd((d) => fn(kitAt(d, n)))}
            onItem={(j, patch) => setItem(n, j, patch)}
            onRemove={() => removeKit(n)}
          />
        ))}
      </div>
      <KitPreview printer={printer && draft.products[printer.id] ? printer : null} loc={loc} lang={lang} />
    </section>
  );
}

function KitEditor({ kit, loc, lang, docs, names, printer, productId, enrolledIds, adding, onAdding, onKit, onItem, onRemove, problems, isPrinter }: {
  kit: FilamentKit; loc: Loc; lang: string; docs: Record<string, ProductDoc | null>; names: Map<string, string>;
  printer: Printer | null; productId: string; enrolledIds: readonly string[];
  adding: boolean; onAdding: (on: boolean) => void; onKit: (fn: (k: FilamentKit) => void) => void;
  onItem: (j: number, patch: Partial<KitItem>) => void; onRemove: () => void;
  problems: KitProblems; isPrinter: (productId: string) => boolean;
}) {
  const idBad = problems.badId;
  const [pickRefused, setPickRefused] = useState('');
  const text = (field: 'ar' | 'en' | 'ckb', label: string) => (
    <label className="flex flex-col gap-1">
      {label}
      <input
        className="lv-input h-9 px-2 text-[13px]"
        dir={field === 'en' ? 'ltr' : 'rtl'}
        maxLength={80}
        value={kit.title[field]}
        onChange={(e) => onKit((k) => { k.title[field] = e.target.value; })}
      />
    </label>
  );
  const before = perPrinterEstimate(kit.items, docs, 'price_iqd');
  const cost = perPrinterEstimate(kit.items, docs, 'cost_iqd');
  const view = discountPreview(kit.discount ?? null, before);
  const hasProblem = idBad || problems.dupId || problems.dupItems.length > 0 || problems.printerItems.length > 0;

  return (
    <Fold className="rounded-lg border border-border-subtle p-2" open={adding || hasProblem || kit.items.length === 0} attrs={{ 'data-printer-services-kit': kit.id }}
      summaryClassName="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[13px] text-text-primary [&::-webkit-details-marker]:hidden"
      summary={<>
        <span className="min-w-0 font-semibold" style={{ flexBasis: '100%' }}>{text3(kit.title, lang) || loc('باقة جديدة — اكتب اسمها', 'New kit — give it a name', 'پاکێجی نوێ — ناوی بۆ بنووسە')}</span>
        {kit.printers === null ? <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{say(loc, S.everyPrinter)}</span> : null}
        <SharedBadge refs={kit.printers} productId={productId} loc={loc} />
        {!kit.active ? <span className="lv-chip [--chip:var(--color-warning)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{loc('موقوفة', 'Off', 'ڕاگیراو')}</span> : null}
        {view ? (
          <span className="inline-flex items-baseline gap-1.5 text-[12px]">
            <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(view.before)}</span>
            <span dir="ltr" className="tabular-nums font-bold">{formatIqd(view.after)}</span>
          </span>
        ) : before !== null ? <span dir="ltr" className="tabular-nums text-[12px]">{formatIqd(before)}</span> : null}
      </>}>

      <div className="mt-2 space-y-3">
        <PrinterScope refs={kit.printers} printer={printer} productId={productId} enrolledIds={enrolledIds} loc={loc} onChange={(refs) => onKit((k) => { k.printers = refs; })} />

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
            <input type="checkbox" role="switch" checked={kit.active} onChange={(e) => onKit((k) => { k.active = e.target.checked; })} />
            {say(loc, S.active)}
          </label>
          <button type="button" className="lv-button lv-button-ghost lv-button-sm ms-auto" onClick={onRemove}>
            {loc('حذف الباقة', 'Remove the kit', 'سڕینەوەی پاکێج')}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {text('ar', say(loc, S.nameAr))}
          {text('en', say(loc, S.nameEn))}
          {text('ckb', say(loc, S.nameCkb))}
        </div>

        <div>
          <h4 className="font-semibold text-text-primary">{loc('المنتجات (الكمية لكل طابعة)', 'Items (quantity per printer)', 'بەرهەمەکان (بڕ بۆ هەر پرینتەرێک)')}</h4>
          <ul className="mt-1 space-y-2">
            {kit.items.map((it, j) => (
              <ItemRow key={`${it.product_id}-${j}`} item={it} doc={docs[it.product_id]} name={names.get(it.product_id) ?? it.product_id} loc={loc} lang={lang}
                problem={problems.printerItems.includes(j) ? 'printer' : problems.dupItems.includes(j) ? 'duplicate' : null}
                onChange={(patch) => onItem(j, patch)}
                onRemove={() => onKit((k) => { k.items = k.items.filter((_, x) => x !== j); })}
              />
            ))}
          </ul>
          {kit.items.length < MAX_KIT_ITEMS ? (
            adding ? (
              <div className="mt-2">
                <ProductPicker
                  value=""
                  ariaLabel={loc('ابحث عن منتج للباقة', 'Find a product for the kit', 'بەرهەمێک بۆ پاکێجەکە بدۆزەوە')}
                  onChange={(id) => {
                    if (!id) return;
                    // A printer is never a kit item; the same product with no selection yet is already in the kit.
                    if (isPrinter(id)) { setPickRefused(loc('الطابعة لا تكون منتجاً داخل باقة.', 'A printer cannot be a kit item.', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج.')); return; }
                    if (kit.items.some((i) => i.product_id === id && !i.option_value_ids.length && !i.color_id)) {
                      setPickRefused(loc('هذا المنتج في الباقة بلا اختيار — اختر نسخته أو لونه هناك، أو ارفع كميته.', 'This product is already in the kit with no selection — choose its version or colour there, or raise its quantity.', 'ئەم بەرهەمە بێ هەڵبژاردە لە پاکێجەکەدایە — لەوێ وەشان یان ڕەنگەکەی هەڵبژێرە، یان بڕەکەی زیاد بکە.'));
                      return;
                    }
                    setPickRefused('');
                    onKit((k) => { k.items = [...k.items, { product_id: id, option_value_ids: [], color_id: null, qty: 1, color_mode: 'fixed' }]; });
                    onAdding(false);
                  }}
                />
                {pickRefused ? <p className="mt-1 text-text-primary" role="alert" data-kit-pick-refused>{pickRefused}</p> : null}
              </div>
            ) : (
              <button type="button" className="lv-button lv-button-secondary lv-button-sm mt-2" onClick={() => onAdding(true)}>
                + {loc('أضف منتجاً', 'Add an item', 'بەرهەمێک زیاد بکە')}
              </button>
            )
          ) : null}
        </div>

        <DiscountRow
          value={kit.discount}
          onChange={(d) => onKit((k) => { k.discount = d; })}
          beforeIqd={before}
          costIqd={cost}
          loc={loc}
          label={loc('خصم الباقة', 'Kit discount', 'داشکاندنی پاکێج')}
        />

        <AdvancedFold loc={loc} open={idBad || problems.dupId}>
          <label className="flex flex-col gap-1">
            {say(loc, S.id)}
            <input className="lv-input h-10 px-2 text-[12px]" dir="ltr" maxLength={32} aria-invalid={idBad || problems.dupId || undefined} value={kit.id} onChange={(e) => onKit((k) => { k.id = e.target.value.toLowerCase(); })} />
          </label>
          <label className="flex flex-col gap-1">
            {say(loc, S.sort)}
            <input
              className="lv-input h-10 px-2 text-[12px] tabular-nums"
              inputMode="numeric"
              dir="ltr"
              value={String(kit.sort)}
              onChange={(e) => onKit((k) => { k.sort = Math.min(999, Number(e.target.value.replace(/[^\d]/g, '') || 0)); })}
            />
          </label>
          {idBad ? <p className="col-span-full text-text-primary" role="alert">{say(loc, S.idRule)}</p> : null}
          {problems.dupId ? <p className="col-span-full text-text-primary" role="alert" data-kit-problem="dup-id">{say(loc, S.kitIdDup)}</p> : null}
        </AdvancedFold>
      </div>
    </Fold>
  );
}

/**
 * The customer's view of the kits for THIS printer, from the PUBLISHED list (GET
 * /api/products/:slug/kits — the live prices and availability the shop would answer now, priced as
 * for a guest). A saved draft shows here only after it is published.
 */
function KitPreview({ printer, loc, lang }: { printer: Printer | null; loc: Loc; lang: string }) {
  const [at, setAt] = useState(printer ? `${printer.slug}|` : '');
  const [kits, setKits] = useState<PreviewKit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const [slug, ov] = at.split('|');
    let live = true;
    setFailed(false);
    setKits(null);
    const q = new URLSearchParams({ qty: '1', fulfillmentType: 'direct_sale' });
    if (ov) q.set('optionValueIds', ov);
    api.get<{ kits: PreviewKit[] }>(`/api/products/${encodeURIComponent(slug)}/kits?${q}`)
      .then((r) => { if (live) setKits(r.kits ?? []); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [at, tick]);
  if (!printer) return null;
  const title = (k: PreviewKit) => text3(k.title, lang) || loc('باقة', 'Kit', 'پاکێج');
  return (
    <Fold className="border-t border-border-subtle pt-3" attrs={{ 'data-printer-services-kit-preview': '' }}
      summaryClassName="flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold text-text-primary [&::-webkit-details-marker]:hidden"
      summary={loc('أسعار الباقات وتوفرها عند الزبون الآن (من النسخة المنشورة)', 'Kit prices and availability for customers now (from the published copy)', 'نرخ و بەردەستبوونی پاکێجەکان لای کڕیار ئێستا (لە وەشانی بڵاوکراوە)')}>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        {printer.versions.length > 1 ? (
          <label className="flex flex-col gap-1">
            {say(loc, S.version)}
            <select className="lv-input h-9 px-2 text-[12px]" value={at} onChange={(e) => setAt(e.target.value)}>
              <option value={`${printer.slug}|`}>{say(loc, S.wholePrinter)}</option>
              {printer.versions.map((v) => <option key={v.id} value={`${printer.slug}|${v.id}`}>{v.name}</option>)}
            </select>
          </label>
        ) : null}
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => setTick((n) => n + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</button>
      </div>
      {failed ? <p className="mt-1">{loc('تعذّر تحميل المعاينة.', 'The preview could not be loaded.', 'پێشبینینەکە بار نەکرا.')}</p>
        : !kits ? <p className="mt-1">{say(loc, S.loading)}</p>
        : kits.length === 0 ? <p className="mt-1">{loc('لا باقات منشورة لهذه الطابعة.', 'No published kits for this printer.', 'هیچ پاکێجێکی بڵاوکراوە بۆ ئەم پرینتەرە نییە.')}</p>
        : (
          <ul className="mt-1 space-y-2">
            {kits.map((k) => (
              <li key={k.id} className="rounded-lg border border-border-subtle p-2">
                <p className="flex flex-wrap items-center justify-between gap-2 text-text-primary">
                  <span className="font-semibold">{title(k)}</span>
                  <span className="inline-flex items-baseline gap-1.5">
                    {k.available && k.price_per_printer_iqd !== null && (k.before_per_printer_iqd ?? 0) > k.price_per_printer_iqd
                      ? <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(k.before_per_printer_iqd as number)}</span>
                      : null}
                    <span dir="ltr" className="tabular-nums">
                      {k.available && k.price_per_printer_iqd !== null ? formatIqd(k.price_per_printer_iqd) : loc('غير متوفرة', 'Unavailable', 'بەردەست نییە')}
                    </span>
                  </span>
                </p>
                <ul className="mt-1 space-y-0.5">
                  {k.items.map((i, j) => (
                    <li key={j} className="flex flex-wrap justify-between gap-2">
                      <span>{(lang === 'en' ? i.name : i.name_ar || i.name)}{i.variant ? ` · ${i.variant}` : ''} ×{i.qty}</span>
                      <span dir="ltr" className="tabular-nums">{i.available && i.unit_price_iqd !== null ? formatIqd(i.unit_price_iqd) : (i.reason ? refusalText(i.reason, lang === 'en' || lang === 'ckb' ? lang : 'ar', i.reason) : loc('غير متوفر', 'Unavailable', 'بەردەست نییە'))}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
    </Fold>
  );
}
