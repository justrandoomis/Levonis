/**
 * The shared toolkit of the kit and add-on editors (printer phases 2 and 4; split out of the old
 * one-file wall in phase 5): reading a product for its versions, colours and estimate price, one
 * item row (version, colour — fixed or the customer's pick — and quantity), the discount row with
 * its live before / after, and «يظهر مع هذه الطابعة» — the one switch that edits THIS printer's
 * entry alone. A printer's page never names another printer: what is shared is counted.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, formatIqd } from '../../lib/api';
import { resolveProductNames } from '../adminBenefits/shared';
import {
  MAX_DISCOUNT_FIXED_IQD,
  MAX_DISCOUNT_PERCENT,
  MAX_KIT_ITEM_QTY,
  colorModeOf,
  type KitColorMode,
  type KitPrinterRef,
  type PrinterDiscount,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';
import { S, discountPreview, say, sharedWithOthers, type Loc } from './adminPrinterStrings';

export type Upd = (fn: (d: PrinterServicesConfig) => void) => void;
export interface Printer { id: string; slug: string; name: string; versions: Array<{ id: string; name: string }> }

export const KIT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface ProductDoc {
  id: string; slug: string; name_ar: string; name_en: string; name_ckb?: string;
  /** What the admin read answers today: an ESTIMATE base only (the cart prices at the customer's tier). */
  price_iqd?: number | null;
  /** Owner-only (projectForAdmin strips it for anyone else): the below-cost warning reads it when present. */
  cost_iqd?: number | null;
  composition?: string;
  options: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; group_en?: string; order: number }>;
  colors: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; option_id: string | null; option_ids?: string[]; order: number; hex?: string; stock?: number | null }>;
}
const docCache = new Map<string, Promise<ProductDoc | null>>();
function productDoc(id: string): Promise<ProductDoc | null> {
  let p = docCache.get(id);
  if (!p) {
    p = api.get<{ product: ProductDoc }>(`/api/admin/products-v2/${encodeURIComponent(id)}`).then((r) => r.product ?? null, () => null);
    docCache.set(id, p);
  }
  return p;
}

export function useDocs(ids: string[]): Record<string, ProductDoc | null> {
  const [docs, setDocs] = useState<Record<string, ProductDoc | null>>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      void productDoc(id).then((d) => { if (live) setDocs((prev) => (id in prev ? prev : { ...prev, [id]: d })); });
    }
    return () => { live = false; };
  }, [key]);
  return docs;
}

export function useNames(ids: string[], lang: string): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let live = true;
    if (key) void resolveProductNames(key.split(','), lang).then((m) => { if (live) setNames(m); });
    return () => { live = false; };
  }, [key, lang]);
  return names;
}

export const pick3 = (o: { name_ar: string; name_en: string; name_ckb?: string }, lang: string) =>
  (lang === 'en' ? o.name_en || o.name_ar : lang === 'ckb' ? o.name_ckb || o.name_en || o.name_ar : o.name_ar || o.name_en) || '';
export const text3 = (t: { ar: string; en: string; ckb: string } | null | undefined, lang: string) =>
  (t ? (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb || t.en : t.ar) || t.en || t.ar : '') || '';

/** One printer's worth of the items at today's admin prices (null when any price is unknown). */
export function perPrinterEstimate(items: ReadonlyArray<{ product_id: string; qty: number }>, docs: Record<string, ProductDoc | null>, field: 'price_iqd' | 'cost_iqd'): number | null {
  if (!items.length) return null;
  let sum = 0;
  for (const it of items) {
    const v = docs[it.product_id]?.[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    sum += v * it.qty;
  }
  return sum;
}

// ------------------------------------------------------------- this printer's entry

/** Whether a kit or an add-on shows with this printer (null = every enrolled printer). */
export const onThisPrinter = (refs: KitPrinterRef[] | null | undefined, productId: string) =>
  refs === null || refs === undefined || refs.some((r) => r.product_id === productId);

/**
 * The printers list after the switch on THIS printer — no other printer's entry moves. Off on a kit
 * for every printer keeps it on every OTHER enrolled printer (their ids, never shown).
 */
export function withThisPrinter(refs: KitPrinterRef[] | null, productId: string, on: boolean, enrolledIds: readonly string[]): KitPrinterRef[] | null {
  if (on) {
    if (refs === null) return null;
    return refs.some((r) => r.product_id === productId) ? refs : [...refs, { product_id: productId, option_value_id: null }];
  }
  if (refs === null) return enrolledIds.filter((id) => id !== productId).map((id) => ({ product_id: id, option_value_id: null }));
  return refs.filter((r) => r.product_id !== productId);
}

/** How many OTHER printers a list of printers names besides this one (0 for «every printer»: that has its own badge). */
export function otherPrintersCount(refs: KitPrinterRef[] | null, productId: string): number {
  return refs === null ? 0 : new Set(refs.filter((r) => r.product_id !== productId).map((r) => r.product_id)).size;
}

/** «مشتركة مع N طابعات أخرى» — only for a list that shows with this printer AND others; a count, never names. */
export function SharedBadge({ refs, productId, loc }: { refs: KitPrinterRef[] | null; productId: string; loc: Loc }) {
  const n = otherPrintersCount(refs, productId);
  if (!n || !onThisPrinter(refs, productId)) return null;
  return <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-shared-printers={n}>{say(loc, sharedWithOthers(n))}</span>;
}

/** «يظهر مع هذه الطابعة» and, for a printer with versions, which of ITS versions. */
export function PrinterScope({ refs, printer, productId, enrolledIds, loc, onChange }: {
  refs: KitPrinterRef[] | null; printer: Printer | null; productId: string; enrolledIds: readonly string[]; loc: Loc;
  onChange: (refs: KitPrinterRef[] | null) => void;
}) {
  const on = onThisPrinter(refs, productId);
  const mine = refs?.filter((r) => r.product_id === productId) ?? [];
  const whole = refs === null || mine.some((r) => r.option_value_id === null);
  const versions = printer?.versions ?? [];
  const rest = () => (refs ?? []).filter((r) => r.product_id !== productId);
  return (
    <div className="space-y-1" data-printer-scope>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
          <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(withThisPrinter(refs, productId, e.target.checked, enrolledIds))} />
          {say(loc, S.showsHere)}
        </label>
        {refs === null ? <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-every-printer>{say(loc, S.everyPrinter)}</span> : null}
        <SharedBadge refs={refs} productId={productId} loc={loc} />
      </div>
      {refs === null ? <p className="text-[11px] text-text-muted">{say(loc, S.everyPrinterOffNote)}</p> : null}
      {on && refs !== null && versions.length > 1 ? (
        <div className="flex flex-wrap gap-3 ps-6">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={whole} onChange={(e) => onChange(e.target.checked
              ? [...rest(), { product_id: productId, option_value_id: null }]
              : [...rest(), { product_id: productId, option_value_id: versions[0].id }])} />
            {say(loc, S.everyVersion)}
          </label>
          {whole ? null : versions.map((v) => (
            <label key={v.id} className="flex items-center gap-2">
              <input type="checkbox" checked={mine.some((r) => r.option_value_id === v.id)} onChange={(e) => onChange(e.target.checked
                ? [...(refs ?? []), { product_id: productId, option_value_id: v.id }]
                : (refs ?? []).filter((r) => !(r.product_id === productId && r.option_value_id === v.id)))} />
              {v.name}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- discount

/** «بدون | نسبة % | مبلغ ثابت لكل طابعة», the value, and the live «قبل — بعد (وفّر %)». */
export function DiscountRow({ value, onChange, beforeIqd, costIqd, loc, label }: {
  value: PrinterDiscount | null | undefined; onChange: (d: PrinterDiscount | null) => void;
  beforeIqd: number | null; costIqd: number | null; loc: Loc; label: string;
}) {
  const d = value ?? null;
  const mode = d?.mode ?? 'none';
  const seg = (m: 'none' | PrinterDiscount['mode'], text: string) => (
    <button
      type="button"
      className={`lv-button lv-button-sm ${mode === m ? 'lv-button-primary' : 'lv-button-secondary'}`}
      aria-pressed={mode === m}
      onClick={() => onChange(m === 'none' ? null : m === 'percent' ? { mode: 'percent', value: d?.mode === 'percent' ? d.value : 10 } : { mode: 'fixed_iqd', value: d?.mode === 'fixed_iqd' ? d.value : 5_000 })}
    >
      {text}
    </button>
  );
  const view = discountPreview(d, beforeIqd);
  const below = !!view && costIqd !== null && view.after < costIqd;
  return (
    <div className="space-y-2" data-printer-discount>
      <h4 className="text-[12px] font-semibold text-text-primary">{label}</h4>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {seg('none', say(loc, S.discNone))}
        {seg('percent', say(loc, S.discPercent))}
        {seg('fixed_iqd', say(loc, S.discFixed))}
      </div>
      {d ? (
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          {say(loc, d.mode === 'percent' ? S.discValuePercent : S.discValueFixed)}
          <input
            className="lv-input h-10 w-40 px-2 tabular-nums"
            inputMode="numeric"
            dir="ltr"
            // A fixed amount is shown with its thousands separators (5,000); typing strips them again.
            value={d.mode === 'fixed_iqd' ? d.value.toLocaleString('en-US') : String(d.value)}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d]/g, '') || 0);
              onChange(d.mode === 'percent'
                ? { mode: 'percent', value: Math.max(1, Math.min(MAX_DISCOUNT_PERCENT, n)) }
                : { mode: 'fixed_iqd', value: Math.max(1, Math.min(MAX_DISCOUNT_FIXED_IQD, n)) });
            }}
          />
        </label>
      ) : null}
      {d ? (
        view ? (
          <p className="flex flex-wrap items-baseline gap-2 text-[12px]" data-discount-preview>
            <span className="text-text-muted">{say(loc, S.before)}</span>
            <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(view.before)}</span>
            <span className="text-text-muted">{say(loc, S.after)}</span>
            <span dir="ltr" className="tabular-nums font-bold text-text-primary">{formatIqd(view.after)}</span>
            <span className="text-success">({say(loc, S.save)} {view.pct}%)</span>
            <span className="text-text-muted">{say(loc, S.perPrinter)}</span>
          </p>
        ) : <p className="text-[12px] text-text-muted">{say(loc, S.priceUnknown)}</p>
      ) : null}
      {below ? <p className="text-[12px] font-semibold text-warning" role="alert" data-discount-below-cost>{say(loc, S.belowCost)} ({formatIqd(costIqd as number)})</p> : null}
      {d ? <p className="text-[11px] text-text-muted">{say(loc, S.estimateNote)}</p> : null}
    </div>
  );
}

/** One product of a kit or an add-on: its version, its colour (fixed, or the customer's pick) and its quantity. */
export interface ItemLike { product_id: string; option_value_ids: string[]; color_id: string | null; qty: number; color_mode?: KitColorMode }

export function ItemRow({ item, doc, name, loc, lang, onChange, onRemove, problem = null, maxQty = MAX_KIT_ITEM_QTY, qtyLabel }: {
  item: ItemLike; doc: ProductDoc | null | undefined; name: string; loc: Loc; lang: string;
  onChange: (patch: Partial<ItemLike>) => void; onRemove?: () => void;
  /** What the save would refuse about this item: a printer, or the same product and selection twice. */
  problem?: 'printer' | 'duplicate' | null;
  maxQty?: number;
  qtyLabel?: string;
}) {
  // The product's option groups (by their English group name), one value chosen in each.
  const options = (doc?.options ?? []).filter((o) => o.active || item.option_value_ids.includes(o.id)).sort((a, b) => a.order - b.order);
  const groups = [...new Set(options.map((o) => o.group_en ?? ''))];
  const colours = (doc?.colors ?? [])
    .filter((c) => c.active || c.id === item.color_id)
    .filter((c) => {
      const tied = c.option_ids?.length ? c.option_ids : c.option_id ? [c.option_id] : [];
      return !tied.length || !item.option_value_ids.length || tied.some((t) => item.option_value_ids.includes(t)) || c.id === item.color_id;
    })
    .sort((a, b) => a.order - b.order);
  const display = doc ? pick3(doc, lang) || name : name;
  const mode = colorModeOf(item);
  const modeSeg = (m: KitColorMode, text: string) => (
    <button
      type="button"
      className={`lv-button lv-button-sm ${mode === m ? 'lv-button-primary' : 'lv-button-secondary'}`}
      aria-pressed={mode === m}
      onClick={() => onChange(m === 'customer' ? { color_mode: 'customer', color_id: null } : { color_mode: 'fixed' })}
    >
      {text}
    </button>
  );
  return (
    <li className="rounded-lg border border-border-subtle p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-text-primary">{display}</span>
        {/* A long label («الكمية لكل طابعة») sits above its input on one line, never wrapped beside it. */}
        <label className={qtyLabel ? 'flex flex-col gap-1 whitespace-nowrap' : 'flex items-center gap-1'}>
          {qtyLabel ?? loc('الكمية', 'Qty', 'بڕ')}
          <input
            className="lv-input h-9 px-2 text-[12px] tabular-nums"
            inputMode="numeric"
            dir="ltr"
            size={3}
            value={String(item.qty)}
            onChange={(e) => onChange({ qty: Math.max(1, Math.min(maxQty, Number(e.target.value.replace(/[^\d]/g, '') || 1))) })}
          />
        </label>
        {onRemove ? (
          <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={onRemove}>
            {loc('حذف المنتج', 'Remove the item', 'سڕینەوەی بەرهەم')}
          </button>
        ) : null}
      </div>
      {doc === null ? <p>{loc('تعذّرت قراءة المنتج.', 'The product could not be read.', 'بەرهەمەکە نەخوێندرایەوە.')}</p> : null}
      {problem === 'printer' ? <p className="text-text-primary" role="alert" data-kit-problem="printer">{loc('الطابعة لا تكون منتجاً داخل باقة — احذفه.', 'A printer cannot be a kit item — remove it.', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج — بیسڕەوە.')}</p> : null}
      {problem === 'duplicate' ? <p className="text-text-primary" role="alert" data-kit-problem="dup-item">{loc('نفس المنتج والاختيار مرتين — احذف هذا وارفع كمية الأول.', "The same product and selection twice — remove this one and raise the first one's quantity.", 'هەمان بەرهەم و هەڵبژاردە دوو جار — ئەمە بسڕەوە و بڕی یەکەم زیاد بکە.')}</p> : null}
      {doc && groups.length > 0 && options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => {
            const inGroup = options.filter((o) => (o.group_en ?? '') === g);
            const chosen = inGroup.find((o) => item.option_value_ids.includes(o.id))?.id ?? '';
            return (
              <label key={g || 'options'} className="flex flex-col gap-1">
                {g || loc('النسخة', 'Version', 'وەشان')}
                <select
                  className="lv-input h-9 px-2 text-[12px]"
                  value={chosen}
                  onChange={(e) => {
                    const rest = item.option_value_ids.filter((id) => !inGroup.some((o) => o.id === id));
                    onChange({ option_value_ids: e.target.value ? [...rest, e.target.value] : rest });
                  }}
                >
                  <option value="">{say(loc, S.choose)}</option>
                  {inGroup.map((o) => <option key={o.id} value={o.id}>{pick3(o, lang)}</option>)}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}
      {doc && (colours.length > 0 || mode === 'customer') ? (
        <div className="space-y-1" data-item-colour-mode={mode}>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={say(loc, S.colourMode)}>
            <span className="text-text-secondary">{say(loc, S.colourMode)}</span>
            {modeSeg('fixed', say(loc, S.colourFixed))}
            {modeSeg('customer', say(loc, S.colourCustomer))}
          </div>
          {mode === 'fixed' && colours.length > 0 ? (
            <label className="flex flex-col gap-1">
              {loc('اللون', 'Colour', 'ڕەنگ')}
              <select className="lv-input h-9 px-2 text-[12px]" value={item.color_id ?? ''} onChange={(e) => onChange({ color_id: e.target.value || null })}>
                <option value="">{say(loc, S.choose)}</option>
                {colours.map((c) => <option key={c.id} value={c.id}>{pick3(c, lang)}</option>)}
              </select>
            </label>
          ) : null}
          {mode === 'customer' ? (
            colours.filter((c) => c.active).length ? (
              <>
                <p className="text-[11px] text-text-muted">{say(loc, S.colourCustomerHint)}</p>
                <ul className="flex flex-wrap gap-1.5" data-item-colour-swatches>
                  {colours.filter((c) => c.active).map((c) => {
                    const out = typeof c.stock === 'number' && c.stock <= 0;
                    return (
                      <li key={c.id} className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px]">
                        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-border-subtle" style={{ background: c.hex || 'transparent' }} />
                        {pick3(c, lang)}
                        {out ? <span className="text-text-muted">· {say(loc, S.outOfStock)}</span> : null}
                      </li>
                    );
                  })}
                  <li className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-subtle px-2 py-0.5 text-[11px]">
                    {loc('لون عشوائي', 'Random colour', 'ڕەنگی هەڕەمەکی')}
                  </li>
                </ul>
              </>
            ) : <p className="text-warning" role="alert">{say(loc, S.colourNone)}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A fold that SHOWS it is one (visual QA, 2026-11-18): a flex summary loses the browser's own
 * triangle, so every fold of the panel draws a chevron, turned by the fold's own state. (A CSS
 * `group-open` turn would follow the nearest open ancestor fold instead, and point the wrong way.)
 */
export function Fold({ className, summaryClassName, summary, tail, open, attrs, children }: {
  className?: string; summaryClassName?: string; summary: ReactNode;
  /** A full-width line under the title, still inside the summary (seen while folded). */
  tail?: ReactNode;
  /** Opened by the caller (a problem inside, a new row); the admin can still fold it. */
  open?: boolean; attrs?: Record<string, string | undefined>; children: ReactNode;
}) {
  const [shown, setShown] = useState(!!open);
  useEffect(() => { if (open) setShown(true); }, [open]);
  return (
    <details className={className} open={open || undefined} onToggle={(e) => { if (e.target === e.currentTarget) setShown(e.currentTarget.open); }} {...attrs}>
      <summary className={summaryClassName}>
        {summary}
        <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-text-muted" style={{ marginInlineStart: 'auto', transform: shown ? 'rotate(180deg)' : undefined }} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
        {tail}
      </summary>
      {children}
    </details>
  );
}

/** «خيارات متقدمة»: the internal code and the order — nothing a customer reads, folded until a problem opens it. */
export function AdvancedFold({ loc, open, children }: { loc: Loc; open: boolean; children: ReactNode }) {
  return (
    <Fold className="border-t border-border-subtle pt-2" open={open} attrs={{ 'data-printer-advanced': '' }}
      summaryClassName="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-text-secondary [&::-webkit-details-marker]:hidden" summary={say(loc, S.advanced)}>
      <p className="text-[11px] text-text-muted leading-relaxed">{say(loc, S.advancedHint)}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">{children}</div>
    </Fold>
  );
}
