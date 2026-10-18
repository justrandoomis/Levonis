/**
 * A MODEL'S PRICE, IN ITS OWN CARD OF SECTION ٥ (implementation spec §5.2
 * `ModelPriceSelector.tsx`, §5.4; docs/PRICING-V2.md §1.4, §2.4, §2.5).
 *
 *   «السعر [يتبع المنتج | تكلفة مختلفة | فرق في السعر ± $ | سعر خاص $]»
 *   «خصم المسبق [يتبع المنتج: 50$ | استثناء]»
 * The inherited value is shown in grey; an override carries the chip
 * «استثناء» and «رجوع للموروث»; the result line «مباشر · مسبق» is the
 * server's answer for the model's SKU (`lineWithOption`). «تكلفة مختلفة» is
 * the owner's and exists from cost only: its own supplier price (the
 * product's shown in grey), its weight and box — the option's packaged
 * «أبعاد الخيار» themselves, one source, edited here or there — and its own
 * minimum profit «يتبع المنتج: $X | استثناء» (DECISIONS row 247). Under the
 * result line the owner reads why: the discount taken («بعد خصم $35.00»),
 * the shelf, a discount withdrawn or a route stopped (`lineNotes`), and the
 * card's own «يجري الحساب» or failure. A price editor
 * gets the same selectors in dollars on a price-first product (Q2) and the
 * read-only result on a cost-first one. A value of another option group can
 * only carry a difference (the server's scope rule: a fixed price and a
 * discount exception name a model).
 */
import { Select, TextInput } from '../formUi';
import { emptyDimensions, type ProductDimensionsV2 } from '../../../../lib/productTypes';
import {
  FOLLOW_MODEL,
  SUPPLIER_CURRENCIES,
  firstPreorder,
  iqdText,
  modelFinalLine,
  nameIn,
  optionPackageBox,
  optionPackageWeight,
  preorderOffOf,
  shelfOf,
  signedUsd,
  usdText,
  type ModelDraft,
  type ModelPriceMode,
  type SkuLine,
  type SupplierCurrency,
} from './v2Model';
import { useV2 } from './useV2Pricing';
import { boxOf, UnitInput } from './CostCard';
import { lineNotes } from './ResultBar';
import FinalPriceField from './FinalPriceField';
import { useEffect, useState } from 'react';
import { channelName, Chip, UsdInput, useV2Lang, useV2Strings, V2Field } from './v2Ui';

/** A reset is a real button (44px), not a text link. */
const RESET = 'inline-flex min-h-11 items-center px-2 text-[11px] font-bold underline underline-offset-2 text-text-secondary';

/**
 * The model's price back to «يتبع المنتج» — its discount exception untouched. Its own cost and its own minimum
 * profit go (the save clears them: INHERIT); the weight and box are the option's dimensions, which stay.
 */
export const followPrice = (): Partial<ModelDraft> => ({
  price: 'follow',
  usd: '',
  supplier_amount: '',
  supplier_currency: '',
  weight_g: null,
  box: null,
  profit: 'follow',
  profit_usd: '',
});
/** The model's discount back to the product's — its price untouched. */
export const followDiscount = (): Partial<ModelDraft> => ({ discount: 'follow', discount_usd: '' });

/**
 * A model's box as TYPED: a partly typed box stays on screen; the draft carries it only once all three axes are
 * set (the box is one unit), so no keystroke starts from an empty box.
 */
function ModelBoxInputs({ fid, model, stored, onBox }: { fid: string; model: string; stored: [number, number, number] | null; onBox: (box: [number, number, number] | null, cleared: boolean) => void }) {
  const s = useV2Strings();
  const [axes, setAxes] = useState<Array<number | null>>(() => [...(stored ?? [null, null, null])]);
  const key = stored ? stored.join(',') : '';
  // The box changed from outside (the option's dimensions, or emptied): the three axes follow it — an emptied box
  // empties them, so a stale axis is never written back. A partly typed box never changes `stored` (onBox waits).
  useEffect(() => {
    setAxes(stored ? [...stored] : [null, null, null]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const setAxis = (i: 0 | 1 | 2, v: number | null) => {
    const next = [...axes];
    next[i] = v;
    setAxes(next);
    onBox(boxOf(next), next.every((x) => x === null));
  };
  return (
    <div className="grid min-w-0 gap-1.5 [grid-template-columns:repeat(3,minmax(0,1fr))]" dir="ltr">
      <UnitInput id={fid} stored={axes[0] ?? null} factor={10} decimals={1} onChange={(v) => setAxis(0, v)} label={s.boxLength} data={`model-box-l:${model}`} />
      <UnitInput id={`${fid}-w`} stored={axes[1] ?? null} factor={10} decimals={1} onChange={(v) => setAxis(1, v)} label={s.boxWidth} data={`model-box-w:${model}`} />
      <UnitInput id={`${fid}-h`} stored={axes[2] ?? null} factor={10} decimals={1} onChange={(v) => setAxis(2, v)} label={s.boxHeight} data={`model-box-h:${model}`} />
    </div>
  );
}

/** A measure as the placeholder shows it: «6.24» kg, «56 × 54 × 43» cm. */
const kgText = (g: number | null) => (g === null ? null : String(Number((g / 1000).toFixed(3))));
const cmBoxText = (box: [number, number, number] | null) => (box ? box.map((mm) => String(Number((mm / 10).toFixed(1)))).join(' × ') : null);

/** The option's «أبعاد الخيار» and its patcher: «تكلفة مختلفة» shows and edits the same packaged weight and box. */
export interface ModelMeasure {
  dims: ProductDimensionsV2 | null;
  onDims: (dimensions: ProductDimensionsV2) => void;
  /** The heading of that dimensions block as the form shows it (`optionDimsHeading`): the hints quote it. */
  heading: string;
}

export default function ModelPriceSelector({ id, isModel, line, measure }: { id: string; isModel: boolean; line: SkuLine | null; measure: ModelMeasure }) {
  const v2 = useV2();
  const s = useV2Strings();
  const lang = useV2Lang();
  if (!v2 || !v2.mode) return null;
  const d = v2.draft;
  const m: ModelDraft = d?.models[id] ?? FOLLOW_MODEL;
  const owner = v2.owner;
  const direct = line?.channels.direct_sale ?? null;
  const pre = firstPreorder(line);
  // Row 247: the discount the server took, beside the pre-order price — the owner's alone.
  const off = owner ? preorderOffOf(pre, direct) : null;
  const shelf = owner ? shelfOf(line) : null;
  const notes = owner ? lineNotes(line, s) : [];
  const result = (
    <div className="grid min-w-0 gap-0.5" data-v2-model-result-block={id}>
      <p className="text-[11px] text-text-secondary" dir="auto" data-v2-model-result={id}>
        {/* A model without a colour-less SKU shows one of its colours: the card names it. */}
        {line?.color_id ? <span className="font-bold">{nameIn(line.names, lang)}: </span> : null}
        {s.direct} <span dir="ltr" className="font-bold tabular-nums text-text-primary">{iqdText(direct?.price_iqd)}</span>
        {pre ? (
          <>
            {' · '}
            {channelName(pre.channel, lang)}{' '}
            {pre.blocked ? (
              <span className="font-bold text-text-primary">{s.noPriceYet}</span>
            ) : (
              <span dir="ltr" className="font-bold tabular-nums text-text-primary">{iqdText(pre.price_iqd)}</span>
            )}
            {off ? <span data-v2-model-off={id}>{` (${s.preorderAfterOff(usdText(off))})`}</span> : null}
          </>
        ) : null}
      </p>
      {shelf ? (
        <p className="text-[11px] font-bold text-text-secondary" dir="auto" data-v2-model-stock={id}>
          {s.sourceStock(iqdText(shelf.cost_iqd), shelf.units)}
        </p>
      ) : null}
      {shelf && m.price === 'own_cost' ? (
        <p className="text-[11px] text-text-muted" dir="auto" data-v2-model-shelf-note={id}>
          {s.shelfOwnCostNote}
        </p>
      ) : null}
      {notes.length ? (
        <ul className="grid gap-0.5 text-[11px] text-amber-300" data-v2-model-notes={id}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {owner && v2.measurePending.has(id) && m.price === 'own_cost' ? (
        <p className="text-[11px] text-amber-300" dir="auto" data-v2-model-measure-pending={id}>
          {s.measurePending(measure.heading)}
        </p>
      ) : null}
      {/* The card's own state: its figures may be the last answer while the next one is computed, or failed. Not a
          live region: section ٣'s status line announces the preview once, not once per card. */}
      <p className="text-[10px] text-text-muted" data-v2-model-status={id}>
        {v2.previewing ? s.computing : v2.error ? s.previewFailed(v2.error) : ''}
      </p>
    </div>
  );
  // A cost-first product's prices are the owner's: an editor reads the result only.
  if (!d || !v2.money) {
    return (
      <div className="mt-2 border-t border-border-subtle pt-2 min-w-0" data-v2-model={id}>
        <p className="mb-0.5 text-[12px] font-bold text-text-secondary">{s.price}</p>
        {result}
      </div>
    );
  }
  const set = (patch: Partial<ModelDraft>) => v2.setDraft((x) => ({ ...x, models: { ...x.models, [id]: { ...(x.models[id] ?? FOLLOW_MODEL), ...patch } } }));
  const costFirst = d.method === 'cost';
  const modes: Array<{ value: ModelPriceMode; label: string }> = [
    { value: 'follow', label: s.followsProduct },
    ...(isModel && costFirst && v2.owner ? [{ value: 'own_cost' as const, label: s.ownCost }] : []),
    { value: 'delta', label: s.priceDelta },
    ...(isModel ? [{ value: 'fixed' as const, label: s.fixedPrice }] : []),
  ];
  const price = modes.some((x) => x.value === m.price) ? m.price : 'follow';

  const productDiscount = d.discount_usd ? usdText(d.discount_usd) : s.discountNone;
  // The stored rule as it is (the stored draft's, so switching away and back finds it again).
  const storedModel = v2.storedDraft?.models[id];
  const keptProfit = storedModel?.profit === 'kept' ? (storedModel.profit_iqd !== null ? s.profitKeptIqd(iqdText(storedModel.profit_iqd)) : s.profitBlocked) : null;
  // A follow / difference / special-price model whose option has its own package: it ships on it, as in every mode
  // (the server's measure chain, row 247 — the owner 2026-10-18); the card says so (no field: the dimensions edit it).
  const dimsPricing = owner && d.method === 'cost' && m.price !== 'own_cost' && (optionPackageWeight(measure.dims) !== null || optionPackageBox(measure.dims) !== null);
  // «تكلفة مختلفة»: the product's values every empty field inherits, shown in grey (§2.1 rule 2).
  const productCost = d.cost.supplier_amount ? `${d.cost.supplier_amount} ${d.cost.supplier_currency || ''}`.trim() : null;
  const inheritedT = v2.inheritedMinimumProfit;
  const productT = d.min_profit_usd
    ? usdText(d.min_profit_usd)
    : inheritedT?.amount_usd
      ? usdText(inheritedT.amount_usd)
      : inheritedT && inheritedT.amount_iqd !== null
        ? iqdText(inheritedT.amount_iqd)
        : '—';
  // The weight and box ARE the option's packaged dimensions (row 247): one value on screen, here and there.
  const dims = measure.dims ?? emptyDimensions();
  const ownWeight = optionPackageWeight(measure.dims);
  const ownBox = optionPackageBox(measure.dims);
  const weightHint = ownWeight !== null ? s.optionMeasureFrom(measure.heading) : m.weight_g !== null ? s.savedPricingOnly(measure.heading) : s.inheritsProductMeasure(kgText(d.cost.weight_g) ?? '—');
  const boxHint = ownBox !== null ? s.optionMeasureFrom(measure.heading) : m.box !== null ? s.savedPricingOnly(measure.heading) : s.inheritsProductMeasure(cmBoxText(d.cost.box) ?? '—');
  // An amount typed with no currency to price it in (the product has none to follow): said at the field.
  const currencyMissing = !m.supplier_currency && !d.cost.supplier_currency && m.supplier_amount.trim() !== '';
  // Emptied here, the field inherits: the option's own value goes, and so does a value saved in pricing only.
  const onWeight = (package_weight_g: number | null) => {
    measure.onDims({ ...dims, package_weight_g });
    if (package_weight_g === null && m.weight_g !== null) set({ weight_g: null });
  };
  const onBox = (box: [number, number, number] | null, cleared: boolean) => {
    // The box is one unit: a partly typed box stays on screen until its three axes are set; all three cleared, it inherits.
    if (!box && !cleared) return;
    measure.onDims({ ...dims, package_depth_mm: box?.[0] ?? null, package_width_mm: box?.[1] ?? null, package_height_mm: box?.[2] ?? null });
    if (!box && m.box !== null) set({ box: null });
  };
  return (
    <div className="mt-2 border-t border-border-subtle pt-2 min-w-0 grid gap-2" data-v2-model={id}>
      <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
        <V2Field label={s.price}>
          {(fid) => (
            <Select id={fid} value={price} onChange={(e) => set({ price: e.target.value as ModelPriceMode })} data-v2-field={`model-price:${id}`}>
              {modes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </V2Field>
        {price === 'delta' || price === 'fixed' ? (
          <V2Field label={price === 'delta' ? s.priceDelta : s.fixedPrice}>
            {(fid) => <UsdInput id={fid} signed={price === 'delta'} value={m.usd} onChange={(usd) => set({ usd })} data={`model-usd:${id}`} />}
          </V2Field>
        ) : null}
      </div>
      {price === 'own_cost' ? (
        <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
          <V2Field label={s.supplier} hint={productCost ? s.inheritedProduct(productCost) : undefined}>
            {(fid) => (
              <TextInput
                id={fid}
                inputMode="decimal"
                value={m.supplier_amount}
                placeholder={productCost ?? undefined}
                onChange={(e) => set({ supplier_amount: e.target.value.replace(/[^\d.٠-٩٫]/g, '') })}
                data-v2-field={`model-supplier:${id}`}
              />
            )}
          </V2Field>
          <V2Field label={s.supplierCurrency} hint={currencyMissing ? s.currencyRequired : undefined}>
            {(fid) => (
              <Select id={fid} value={m.supplier_currency} onChange={(e) => set({ supplier_currency: e.target.value as SupplierCurrency | '' })} data-v2-field={`model-currency:${id}`}>
                {/* Empty: the product's currency, which the request then names (an amount never travels without one);
                    a product with none offers no «يتبع المنتج» — the owner chooses. */}
                <option value="">{d.cost.supplier_currency ? `${s.followsProduct}: ${d.cost.supplier_currency}` : s.currencyChoose}</option>
                {SUPPLIER_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </V2Field>
          <V2Field label={s.weightKg} hint={weightHint}>
            {(fid) => (
              <UnitInput id={fid} stored={ownWeight ?? m.weight_g} factor={1000} decimals={3} placeholder={kgText(d.cost.weight_g) ?? undefined} onChange={onWeight} data={`model-weight:${id}`} />
            )}
          </V2Field>
          {/* §1.4: weight OR box — a model shipped by sea is priced per CBM. */}
          <div className="[grid-column:1/-1]">
            <V2Field label={s.boxCm} hint={boxHint}>
              {(fid) => <ModelBoxInputs fid={fid} model={id} stored={ownBox ?? m.box} onBox={onBox} />}
            </V2Field>
          </div>
          {/* Row 247: the model's own minimum profit — the product's by default, shown beside it. */}
          <div className="[grid-column:1/-1] grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
            <V2Field label={s.minProfitFrom}>
              {(fid) => (
                <Select
                  id={fid}
                  value={m.profit}
                  onChange={(e) => set({ profit: e.target.value === 'exception' ? 'exception' : e.target.value === 'kept' ? 'kept' : 'follow' })}
                  data-v2-field={`model-profit:${id}`}
                >
                  <option value="follow">{`${s.followsProduct}: ${productT}`}</option>
                  <option value="exception">{s.exception}</option>
                  {/* A stored rule this dollar field cannot draw (dinars, or blocked) — shown, never «يتبع المنتج». */}
                  {keptProfit ? <option value="kept">{keptProfit}</option> : null}
                </Select>
              )}
            </V2Field>
            {m.profit === 'exception' ? (
              <V2Field label={s.minProfit} hint={s.inheritedProduct(productT)}>
                {(fid) => (
                  <UsdInput id={fid} value={m.profit_usd} placeholder={d.min_profit_usd || inheritedT?.amount_usd || undefined} onChange={(profit_usd) => set({ profit_usd })} data={`model-profit-usd:${id}`} />
                )}
              </V2Field>
            ) : null}
            {/* The model's final price: a two-way editor of its own minimum profit (2026-10-18). */}
            {m.profit === 'exception' ? <FinalPriceField line={modelFinalLine(v2.answer?.table ?? [], line, id, d)} profit={m.profit_usd} onProfit={(profit_usd) => set({ profit_usd })} data={`model-final-usd:${id}`} /> : null}
          </div>
        </div>
      ) : null}
      {dimsPricing && isModel ? (
        <p className="text-[11px] text-text-muted" dir="auto" data-v2-model-dims-pricing={id}>
          {s.optionDimsPricing(measure.heading)}
        </p>
      ) : null}
      {isModel ? (
        <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
          <V2Field label={s.preorderDiscount}>
            {(fid) => (
              <Select id={fid} value={m.discount} onChange={(e) => set({ discount: e.target.value === 'exception' ? 'exception' : 'follow' })} data-v2-field={`model-discount:${id}`}>
                <option value="follow">{`${s.followsProduct}: ${productDiscount}`}</option>
                <option value="exception">{s.exception}</option>
              </Select>
            )}
          </V2Field>
          {m.discount === 'exception' ? (
            // §2.1 rule 2: the inherited value stays visible beside the exception («المنتج: $40.00»).
            <V2Field label={s.discount} hint={s.inheritedProduct(productDiscount)}>
              {(fid) => <UsdInput id={fid} value={m.discount_usd} placeholder={d.discount_usd ? d.discount_usd : '0'} onChange={(discount_usd) => set({ discount_usd })} data={`model-discount-usd:${id}`} />}
            </V2Field>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {result}
        {price !== 'follow' || m.discount === 'exception' ? (
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone="info" data="exception">
              {s.exception}
              {price === 'delta' && m.usd ? ` ${signedUsd(m.usd)}` : ''}
            </Chip>
            {/* One reset per selector: the price and the discount exception are two decisions. */}
            {price !== 'follow' ? (
              <button type="button" className={RESET} onClick={() => set(followPrice())} data-v2-inherit={id} data-v2-inherit-price={id}>
                {s.resetPrice}
              </button>
            ) : null}
            {m.discount === 'exception' ? (
              <button type="button" className={RESET} onClick={() => set(followDiscount())} data-v2-inherit-discount={id}>
                {s.resetDiscount}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
