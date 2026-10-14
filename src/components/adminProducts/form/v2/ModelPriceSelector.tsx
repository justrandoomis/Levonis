/**
 * A MODEL'S PRICE, IN ITS OWN CARD OF SECTION ٥ (implementation spec §5.2
 * `ModelPriceSelector.tsx`, §5.4; docs/PRICING-V2.md §1.4, §2.4, §2.5).
 *
 *   «السعر [يتبع المنتج | تكلفة مختلفة | فرق في السعر ± $ | سعر خاص $]»
 *   «خصم المسبق [يتبع المنتج: 50$ | استثناء]»
 * The inherited value is shown in grey; an override carries the chip
 * «استثناء» and «رجوع للموروث»; the result line «مباشر · مسبق» is the
 * server's answer for the model's first SKU. «تكلفة مختلفة» (its own supplier
 * price and weight) is the owner's and exists from cost only. A price editor
 * gets the same selectors in dollars on a price-first product (Q2) and the
 * read-only result on a cost-first one. A value of another option group can
 * only carry a difference (the server's scope rule: a fixed price and a
 * discount exception name a model).
 */
import { Select, TextInput } from '../formUi';
import { FOLLOW_MODEL, SUPPLIER_CURRENCIES, firstPreorder, iqdText, signedUsd, usdText, type ModelDraft, type ModelPriceMode, type SkuLine, type SupplierCurrency } from './v2Model';
import { useV2 } from './useV2Pricing';
import { UnitInput } from './CostCard';
import { channelName, Chip, UsdInput, useV2Lang, useV2Strings, V2Field } from './v2Ui';

export default function ModelPriceSelector({ id, isModel, line }: { id: string; isModel: boolean; line: SkuLine | null }) {
  const v2 = useV2();
  const s = useV2Strings();
  const lang = useV2Lang();
  if (!v2 || !v2.mode) return null;
  const d = v2.draft;
  const m: ModelDraft = d?.models[id] ?? FOLLOW_MODEL;
  const direct = line?.channels.direct_sale ?? null;
  const pre = firstPreorder(line);
  const result = (
    <p className="text-[11px] text-text-secondary" dir="auto" data-v2-model-result={id}>
      {s.direct} <span dir="ltr" className="font-bold tabular-nums text-text-primary">{iqdText(direct?.price_iqd)}</span>
      {pre ? (
        <>
          {' · '}
          {s.preorderVia(channelName(pre.channel, lang))} <span dir="ltr" className="font-bold tabular-nums text-text-primary">{iqdText(pre.price_iqd)}</span>
        </>
      ) : null}
    </p>
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
        <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)_6rem_minmax(0,1fr)]">
          <V2Field label={s.supplier}>
            {(fid) => (
              <TextInput id={fid} inputMode="decimal" value={m.supplier_amount} onChange={(e) => set({ supplier_amount: e.target.value.replace(/[^\d.٠-٩٫]/g, '') })} data-v2-field={`model-supplier:${id}`} />
            )}
          </V2Field>
          <V2Field label={s.supplierCurrency}>
            {(fid) => (
              <Select id={fid} value={m.supplier_currency} onChange={(e) => set({ supplier_currency: e.target.value as SupplierCurrency | '' })}>
                <option value="">—</option>
                {SUPPLIER_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </V2Field>
          <V2Field label={s.weightKg}>
            {(fid) => <UnitInput id={fid} stored={m.weight_g} factor={1000} decimals={3} onChange={(weight_g) => set({ weight_g })} data={`model-weight:${id}`} />}
          </V2Field>
        </div>
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
            <V2Field label={s.discount}>
              {(fid) => <UsdInput id={fid} value={m.discount_usd} placeholder="0" onChange={(discount_usd) => set({ discount_usd })} data={`model-discount-usd:${id}`} />}
            </V2Field>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {result}
        {price !== 'follow' || m.discount === 'exception' ? (
          <span className="flex items-center gap-2">
            <Chip tone="info" data="exception">
              {s.exception}
              {price === 'delta' && m.usd ? ` ${signedUsd(m.usd)}` : ''}
            </Chip>
            <button type="button" className="text-[11px] font-bold underline underline-offset-2 text-text-secondary" onClick={() => set({ ...FOLLOW_MODEL })} data-v2-inherit={id}>
              {s.backToInherited}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
