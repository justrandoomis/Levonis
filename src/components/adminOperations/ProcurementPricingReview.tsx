import { useEffect, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { ApiError, isAborted } from '../../lib/api';
import { COST_REFUSALS } from '../../../packages/contracts/src/costRefusals';
import { T, money, Input } from './shared';
import { adoptionRows, applyPurchase, extraOnStep, previewSaved, samePrices, writesPrices, type EngineAdoption, type PricingChoices, type PricingPreview, type PricingPreviewRow, type PricingProduct, type TypedExtra } from './procurementPricing';
import { channelName, issueText, procurementPricingStrings, profileName } from './procurementPricingStrings';
import { engineNotices, engineSaveStrings } from './engineSaveStrings';

/**
 * THE REVIEW STEP'S «معاينة الأسعار الجديدة قبل الحفظ» (USD design §5.4, §6.3;
 * owner decision 8's six figures): per product, per model × channel, the
 * current replacement cost, the minimum profit, the new pre-order price, the
 * Direct Sale Extra, the new direct sale price, and old → new — with the
 * per-product choices and the notices the server raised. Every figure is the
 * server's; the screen formats.
 *
 * A product the purchase leaves complete (or one already engine-priced) shows
 * the prices the confirm WRITES (owner decision 8: the apply adopts the engine
 * in its own batch), with the tick a change above 15% needs.
 *
 * A STOCK PURCHASE IS REVIEWED FOR DIRECT SALE (owner request 2026-10-10:
 * «المفروض هو فقط بيع مباشر»). A product that sells direct leads with
 * «البيع المباشر»: the Direct Sale Extra field — the one input the direct price
 * lacks, asked for in place and never invented (row 184 (4)); 0 is one click —
 * and the direct rows. Purchase costs and minimums apply to direct sale alone;
 * pre-order pricing stays outside this review and its write.
 */

/** The typed Direct Sale Extras of one product, by `scope|scope_id` ('' amount = inherit). */
export type TypedExtras = Record<string, string>;
/** One product's typed entries, or null to clear them all. */
export type ExtraEntries = Array<{ scope: 'product' | 'option'; scope_id: string; amount: string }> | null;

const EMPTY_CHOICES: PricingChoices = { minimums: [], optIn: [], usePurchase: {}, prefer: {} };
const isDirect = (r: Pick<PricingPreviewRow, 'channel'>) => r.channel === 'direct_sale';
/** The product sells direct today (an enabled direct-sale cell on some model). */
export const sellsDirect = (p: Pick<PricingProduct, 'rows'>) => p.rows.some(isDirect);
/** The only thing the product lacks for a price is its Direct Sale Extra. */
export const onlyExtraMissing = (p: Pick<PricingProduct, 'missing_codes'>) => p.missing_codes.length === 1 && p.missing_codes[0] === 'DIRECT_SALE_EXTRA_MISSING';

/** One product's typed extras out of the card's map (`product_id|scope|scope_id` → `scope|scope_id`). */
export function extrasOf(all: Record<string, string>, productId: string): TypedExtras {
  const out: TypedExtras = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(`${productId}|`)) out[k.slice(productId.length + 1)] = v;
  return out;
}

/** One product's typed extras as the request's entries. */
export const typedExtraList = (productId: string, typed: TypedExtras): TypedExtra[] =>
  Object.entries(typed).map(([k, amount_iqd]) => {
    const [scope, scope_id = ''] = k.split('|');
    return { product_id: productId, scope: scope === 'option' ? 'option' : 'product', scope_id, amount_iqd };
  });

/** The card's map with one product's typed extras replaced (null clears them). */
export function withProductExtras(all: Record<string, string>, productId: string, entries: ExtraEntries): Record<string, string> {
  const kept = Object.entries(all).filter(([k]) => !k.startsWith(`${productId}|`));
  return Object.fromEntries([...kept, ...(entries ?? []).map((x) => [`${productId}|${x.scope}|${x.scope === 'product' ? '' : x.scope_id}`, x.amount] as const)]);
}

export default function ProcurementPricingReview({ preview, busy, usePurchase, prefer, onUsePurchase, onPrefer, confirmLarge = {}, onConfirmLarge, extras = {}, onExtras }: {
  preview: PricingPreview | null;
  busy: boolean;
  usePurchase: Record<string, boolean>;
  prefer: Record<string, boolean>;
  onUsePurchase: (productId: string, value: boolean) => void;
  onPrefer: (productId: string, value: boolean) => void;
  confirmLarge?: Record<string, boolean>;
  onConfirmLarge?: (productId: string, value: boolean) => void;
  /** Typed Direct Sale Extras of every product, keyed `product_id|scope|scope_id`. */
  extras?: Record<string, string>;
  onExtras?: (productId: string, entries: ExtraEntries) => void;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  if (!preview) return busy ? <p role="status" className={`mt-4 text-sm ${T.text3}`}>{s.computing}</p> : null;
  return (
    <section aria-labelledby="pricing-preview-title" className="mt-4 grid gap-3" data-pricing-review>
      <h4 id="pricing-preview-title" className={`font-semibold ${T.text1}`}>{s.previewTitle}</h4>
      {preview.rates.review_pending && preview.rates.usd_iqd_rate && <p role="status" className="rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-text-1)]">{s.reviewBanner(preview.rates.usd_iqd_rate)}</p>}
      {preview.rates.derived_stale && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{COST_REFUSALS.FX_DERIVED_STALE[lang]}</p>}
      {preview.products.map((p) => (
        <ProductPreview
          key={p.product_id}
          p={p}
          use={usePurchase[p.product_id] !== false}
          prefer={prefer[p.product_id] === true}
          onUse={(v) => onUsePurchase(p.product_id, v)}
          onPrefer={(v) => onPrefer(p.product_id, v)}
          large={confirmLarge[p.product_id] === true}
          onLarge={onConfirmLarge ? (v) => onConfirmLarge(p.product_id, v) : undefined}
          extras={extrasOf(extras, p.product_id)}
          onExtras={onExtras ? (entries) => onExtras(p.product_id, entries) : undefined}
        />
      ))}
      <p className={`text-[12px] ${T.text3}`}>{s.savePc}</p>
    </section>
  );
}

export function ProductPreview({ p, use, prefer, onUse, onPrefer, large, onLarge, extras = {}, onExtras }: {
  p: PricingProduct;
  use: boolean;
  prefer: boolean;
  onUse: (v: boolean) => void;
  onPrefer: (v: boolean) => void;
  large: boolean;
  onLarge?: (v: boolean) => void;
  extras?: TypedExtras;
  onExtras?: (entries: ExtraEntries) => void;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const es = engineSaveStrings(lang);
  const writes = writesPrices(p.adoption) && use ? p.adoption : null;
  const direct = sellsDirect(p);
  const notices: string[] = [];
  if (p.reason === 'estimated') notices.push(s.estimated);
  if (p.shadowed.length) notices.push(s.shadowed);
  for (const x of p.proposals) if (direct) notices.push(s.directRoute(profileName(x.shipping_profile, lang)));

  if (p.missing_codes.length) notices.push(direct && onlyExtraMissing(p) ? s.extraNeeded : s.incomplete(p.missing_codes.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ')));
  if (!direct) notices.push(s.preorderOnly);
  const intro = writes && (
    <>
      <p className={`text-[13px] ${T.text1}`}>{writes.kind === 'adopt' ? es.adoptIntro : es.repriceIntro}</p>
      {engineNotices(writes, lang).length > 0 && <ul className={`grid gap-1 text-[13px] ${T.text2}`}>{engineNotices(writes, lang).map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </>
  );
  const tick = writes?.large_change && onLarge && (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={large} onChange={(e) => onLarge(e.target.checked)} data-pricing-large={p.product_id} />
      {es.largeTick}
      <span className={`text-[12px] ${T.text3}`}>{es.largeNote}</span>
    </label>
  );
  const rows = (writes ? adoptionRows(writes) : p.rows).filter(isDirect);
  return (
    <article className="inventory-line" data-pricing-product={p.product_id}>
      <strong className={T.text1}>{p.label}</strong>
      {p.feeds && <label className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={use} onChange={(e) => onUse(e.target.checked)} />{s.usePurchase}</label>}
      {p.entries.some((e) => e.narrow) && <label className="mt-1 flex gap-2 text-sm"><input type="checkbox" checked={prefer} onChange={(e) => onPrefer(e.target.checked)} />{s.preferPurchase}</label>}
      {notices.length > 0 && <ul className={`mt-2 grid gap-1 text-[13px] ${T.text2}`}>{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {direct ? (
        <div className="mt-2 grid min-w-0 gap-2" data-pricing-direct-first={writes?.kind ?? 'data'}>
          {intro}
          <section className="grid min-w-0 gap-2" data-direct-block aria-label={s.sectionDirect}>
            <h5 className={`text-[14px] font-semibold ${T.text1}`}>{s.sectionDirect}</h5>
            {onExtras && <DirectSaleExtraField p={p} typed={extras} onChange={onExtras} />}
            <PricingRowsTable rows={rows.filter(isDirect)} variant="direct" />
          </section>
          {tick}
        </div>
      ) : null}
    </article>
  );
}

/**
 * «زيادة البيع المباشر (د.ع)» on the review (owner request 2026-10-10). One
 * product-level value — every model without its own inherits it; a model whose
 * own row is BLOCKED (a legacy answer-B review) gets the same value, or the walk
 * would stop there. Two explicit answers: «بدون زيادة البيع المباشر (0)», and
 * today's value per model when the old prices give every direct model one
 * (answer B). Nothing is typed for the owner; the server validates and decides.
 */
export function DirectSaleExtraField({ p, typed, onChange }: { p: PricingProduct; typed: TypedExtras; onChange: (entries: ExtraEntries) => void }) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const stored = p.direct_sale_extras?.find((x) => x.scope === 'product' && x.state === 'ACTIVE' && x.direct_sale_extra_iqd != null)?.direct_sale_extra_iqd ?? null;
  const blocked = (p.direct_sale_extras ?? []).filter((x) => x.scope === 'option' && x.state === 'BLOCKED').map((x) => x.scope_id);
  const models = [...new Set(p.rows.filter(isDirect).map((r) => r.option_id))];
  const suggestions = (p.extra_suggestions ?? []).filter((x) => models.includes(x.option_id));
  const everyModel = models.length > 0 && models.every((id) => suggestions.some((x) => x.option_id === id));
  const values = [...new Set(suggestions.map((x) => x.direct_sale_extra_iqd))].sort((a, b) => a - b);
  const today = values.length === 1 ? money(values[0]!) : values.length ? `${money(values[0]!)} – ${money(values[values.length - 1]!)}` : '';
  const value = typed['product|'] ?? '';
  const set = (v: string) => onChange(v.trim() === '' ? null : [{ scope: 'product', scope_id: '', amount: v }, ...blocked.map((id) => ({ scope: 'option' as const, scope_id: id, amount: v }))]);
  const bad = Object.values(typed).some((v) => !extraOnStep(v));
  return (
    <div className="grid min-w-0 gap-2" data-extra-field={p.product_id}>
      <Input label={s.extraLabel} value={value} onChange={set} inputMode="numeric" placeholder={stored != null ? money(stored) : undefined} hint={s.extraHint} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={T.btnSecondary} onClick={() => set('0')} data-extra-none>{s.noExtra}</button>
        {everyModel && (
          <button
            type="button"
            className={T.btnGhost}
            data-extra-today
            onClick={() => onChange(suggestions.map((x) => (x.option_id ? { scope: 'option' as const, scope_id: x.option_id, amount: String(x.direct_sale_extra_iqd) } : { scope: 'product' as const, scope_id: '', amount: String(x.direct_sale_extra_iqd) })))}
          >
            {s.todayExtra(today)}
          </button>
        )}
      </div>
      {bad && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{s.extraInvalid}</p>}
    </div>
  );
}

/**
 * Owner decision 8's six figures per model × channel — the current
 * replacement cost, the minimum profit, the new pre-order price, the Direct
 * Sale Extra, the new direct sale price, and old → new — as the server
 * answered them (the procurement review and the product form's «المعاينة
 * والحفظ» alike). It formats; it never computes.
 *
 * `variant` (owner request 2026-10-10): 'direct' is the review's direct block —
 * no channel column, and the base price reads «السعر قبل زيادة البيع المباشر»;
 * 'preorder' its pre-order disclosure — no extra and no direct column. The
 * default 'all' is the eight columns every other screen reads, unchanged.
 */
export function PricingRowsTable({ rows, variant = 'all' }: { rows: readonly PricingPreviewRow[]; variant?: 'all' | 'direct' | 'preorder' }) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const arrow = lang === 'en' ? '→' : '←';
  const modelName = (r: PricingPreviewRow) => (lang === 'en' ? r.name_en || r.name_ar : lang === 'ckb' ? r.name_ckb || r.name_ar : r.name_ar || r.name_en) || '—';
  const fig = (v: React.ReactNode) => <bdi dir="ltr" className="whitespace-nowrap">{v}</bdi>;
  type Column = { head: string; cell: (r: PricingPreviewRow, direct: boolean) => React.ReactNode };
  const columns: Column[] = [
    { head: s.colModel, cell: (r) => modelName(r) },
    ...(variant === 'direct' ? [] : [{ head: s.colChannel, cell: (r: PricingPreviewRow) => channelName(r.channel, lang) }]),
    { head: s.colReplacement, cell: (r) => fig(money(r.replacement_cost_iqd)) },
    { head: s.colMinProfit, cell: (r) => fig(r.target_profit_usd ? `$${r.target_profit_usd}` : money(r.target_profit_iqd)) },
    { head: variant === 'direct' ? s.colBeforeExtra : s.colNewPreorder, cell: (r, direct) => fig(direct ? money(r.preorder_base_iqd) : money(r.computed_price_iqd)) },
    ...(variant === 'preorder'
      ? []
      : [
          { head: s.colExtra, cell: (r: PricingPreviewRow, direct: boolean) => fig(direct ? money(r.direct_sale_extra_iqd) : '—') },
          { head: s.colNewDirect, cell: (r: PricingPreviewRow, direct: boolean) => fig(direct ? money(r.computed_price_iqd) : '—') },
        ]),
    {
      head: s.colOldNew,
      cell: (r) =>
        r.computed_price_iqd == null
          ? <span className={T.text3}>{r.issue_codes.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ') || '—'}</span>
          : fig(`${money(r.today_prepaid_iqd)} ${arrow} ${money(r.computed_price_iqd)}`),
    },
  ];
  return (
    <div className="mt-3 overflow-x-auto" data-pricing-rows data-rows-variant={variant === 'all' ? undefined : variant}>
      <table className={`w-full ${variant === 'all' ? 'min-w-[640px]' : 'min-w-[520px]'} text-start text-[13px] tabular-nums`}>
        <thead>
          <tr className={T.text3}>
            {columns.map((c) => (
              <th key={c.head} scope="col" className="border-b border-[var(--ap-border)] px-2 py-1.5 text-start font-medium">{c.head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const direct = isDirect(r);
            return (
              <tr key={`${r.combo_key ?? r.option_id}:${r.channel}`} className="border-b border-[var(--ap-border)] align-top">
                {columns.map((c) => <td key={c.head} className="px-2 py-1.5">{c.cell(r, direct)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A SAVED purchase's pricing state (USD design §5.4 "Saved-document view",
 * §6.3 step 3): a product whose cost was not applied yet offers «اعتمدها
 * الآن»; a failed apply after the confirm offers «إعادة المحاولة» with the
 * values just typed; a cost from a cancelled purchase says so.
 *
 * A product confirmed «data only» because its Direct Sale Extra alone was
 * missing (owner request 2026-10-10) shows the review's field here too: the
 * typed value is previewed against the committed purchase first — the prices
 * an apply would write are on screen before «اعتمدها الآن» (decision 8) — and
 * applied with that preview's hash.
 */
export function SavedPurchasePricing({ preview, purchaseId, failures, choices, onDone, confirmLarge = {} }: {
  preview: PricingPreview | null;
  purchaseId: string;
  failures: Array<{ product_id: string; label: string; message: string; purchase_id: string }>;
  choices: PricingChoices;
  onDone: () => Promise<void> | void;
  /** The ticks given in the review before the confirm (a retry carries them). */
  confirmLarge?: Record<string, boolean>;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const es = engineSaveStrings(lang);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [typedPreview, setTypedPreview] = useState<PricingPreview | null>(null);
  const allTyped = [...new Set(Object.keys(extras).map((k) => k.split('|')[0]!))].flatMap((pid) => typedExtraList(pid, extrasOf(extras, pid)));
  const typedKey = allTyped.length && allTyped.every((x) => extraOnStep(x.amount_iqd)) ? JSON.stringify(allTyped) : '';
  // The typed extras, previewed against the committed purchase (latest wins): the prices an apply would write.
  useEffect(() => {
    setTypedPreview(null);
    if (!typedKey) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      previewSaved(purchaseId, { ...EMPTY_CHOICES, extras: JSON.parse(typedKey) as TypedExtra[] }, ctrl.signal)
        .then((r) => { setTypedPreview(r); setError(''); })
        .catch((e) => { if (!isAborted(e)) setError(e instanceof Error ? e.message : String(e)); });
    }, 450);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [typedKey, purchaseId]);
  const run = async (productId: string, withChoices: PricingChoices, shownProduct?: PricingProduct) => {
    const product = shownProduct ?? preview?.products.find((p) => p.product_id === productId);
    if (!product) return;
    setBusy(productId);
    setError('');
    try {
      const large = ticks[productId] === true || confirmLarge[productId] === true;
      try {
        await applyPurchase(productId, purchaseId, product.preview_hash, withChoices, large);
      } catch (e) {
        // The choices typed before the save differ from this view's: the refusal carries the fresh hash —
        // taken only when the prices it would write are the ones shown (never new prices unseen).
        const shown = e instanceof ApiError && e.code === 'PRICING_PREVIEW_STALE' ? (e.details?.preview as PricingProduct | null) : null;
        if (!shown?.preview_hash || !samePrices(shown.adoption, product.adoption)) throw e;
        await applyPurchase(productId, purchaseId, shown.preview_hash, withChoices, large);
      }
      setExtras((m) => withProductExtras(m, productId, null));
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const ownFailures = failures.filter((f) => f.purchase_id === purchaseId);
  const products = preview?.products ?? [];
  const pending = products.filter((p) => p.feeds && p.eligible && !p.applied && p.entries.some((e) => Object.keys(e.changes).length > 0));
  // Confirmed «data only» for want of the Direct Sale Extra alone: the field, applied or not.
  const needsExtra = products.filter((p) => p.feeds && p.eligible && sellsDirect(p) && onlyExtraMissing(p));
  const cancelled = products.filter((p) => p.cancelled_source);
  if (!pending.length && !needsExtra.length && !cancelled.length && !ownFailures.length) return null;
  const card = (p: PricingProduct) => {
    const typed = extrasOf(extras, p.product_id);
    const hasTyped = Object.keys(typed).length > 0;
    const shown = hasTyped ? (typedPreview?.products.find((x) => x.product_id === p.product_id) ?? null) : p;
    // An apply that writes prices shows them first (owner decision 8), with the tick above 15%.
    const writes: EngineAdoption | null = shown && writesPrices(shown.adoption) ? shown.adoption : null;
    const needsTick = !!writes?.large_change && ticks[p.product_id] !== true;
    const canApply = !p.applied || hasTyped;
    const ready = !hasTyped || !!shown;
    return (
      <div key={p.product_id} className="grid gap-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] px-3 py-2 text-sm" data-saved-product={p.product_id}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={T.text1}>{p.label}</span>
          <span className={T.text2}>{p.applied ? s.incomplete(issueText('DIRECT_SALE_EXTRA_MISSING', lang)) : s.notApplied}</span>
          {canApply && (
            <button type="button" className={T.btnSecondary} disabled={!!busy || needsTick || !ready} onClick={() => run(p.product_id, hasTyped ? { ...EMPTY_CHOICES, extras: typedExtraList(p.product_id, typed) } : EMPTY_CHOICES, shown ?? undefined)}>
              {s.applyNow}
            </button>
          )}
        </div>
        {needsExtra.includes(p) && <DirectSaleExtraField p={p} typed={typed} onChange={(entries) => setExtras((m) => withProductExtras(m, p.product_id, entries))} />}
        {writes && (
          <>
            <p className={`text-[13px] ${T.text2}`}>{writes.kind === 'adopt' ? es.adoptIntro : es.repriceIntro}</p>
            <PricingRowsTable rows={adoptionRows(writes).filter(isDirect)} variant="direct" />
            {writes.large_change && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ticks[p.product_id] === true} onChange={(e) => setTicks((m) => ({ ...m, [p.product_id]: e.target.checked }))} />
                {es.largeTick}
              </label>
            )}
          </>
        )}
      </div>
    );
  };
  return (
    <section className="mb-4 grid gap-2" data-saved-pricing>
      {ownFailures.length > 0 && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{s.partial(String(ownFailures.length))}</p>}
      {ownFailures.map((f) => (
        <div key={f.product_id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className={T.text1}>{f.label}</span>
          <button type="button" className={T.btnSecondary} disabled={!!busy} onClick={() => run(f.product_id, choices)}>{s.retry}</button>
        </div>
      ))}
      {[...new Set([...pending, ...needsExtra])].filter((p) => !ownFailures.some((f) => f.product_id === p.product_id)).map(card)}
      {cancelled.map((p) => <p key={p.product_id} role="status" className={`text-sm ${T.text2}`}>{p.label} — {s.cancelledSource}</p>)}
      {error && <p role="alert" className="text-[13px] text-[var(--ap-danger)]">{error}</p>}
    </section>
  );
}
