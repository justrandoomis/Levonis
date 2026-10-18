/**
 * «الربح والطلب المسبق» (implementation spec §5.2 `ProfitDiscountCard.tsx`;
 * docs/PRICING-V2.md §1.2, §1.3, §2.2; owner decisions A1, B1; the owner's
 * answer Q2 of DECISIONS row 222).
 *
 *   - From cost (the owner): the minimum profit in dollars (T: D = R + T), its
 *     two-way editor «السعر النهائي ($)» (FinalPriceField, 2026-10-18) and the
 *     pre-order discount;
 *   - a dollar price (the owner and every price editor): «سعر البيع المباشر
 *     [$] → د.ع» and the pre-order discount;
 *   - the exceptions in one line — «استثناءات: Combo −25$ [اعرض ↘]» — each
 *     edited in its model's card in section ٥.
 * The dinars beside a field are the server's answer for the product's first
 * SKU; nothing is multiplied here.
 */
import { inheritPlaceholder, iqdText, nameIn, signedUsd, type PriceDraft, type SkuLine, type V2Names } from './v2Model';
import FinalPriceField from './FinalPriceField';
import { useV2Lang, useV2Strings, UsdInput, V2Field } from './v2Ui';

export default function ProfitDiscountCard({
  draft,
  setDraft,
  owner,
  direct,
  preorder,
  modelNames,
  onJump,
  inheritedMinProfit = null,
  finalLine = null,
}: {
  draft: PriceDraft;
  setDraft: (fn: (d: PriceDraft) => PriceDraft) => void;
  owner: boolean;
  /** The first SKU's direct price (the server's), beside the dollar price. */
  direct: number | null;
  /** The first SKU's first pre-order price (the server's), beside the discount. */
  preorder: number | null;
  modelNames: (id: string) => V2Names | null;
  onJump: (section: 3 | 5) => void;
  /** The owner's answer: what the minimum profit inherits when the field is empty (§2.1 rule 2). */
  inheritedMinProfit?: { amount_usd: string | null; amount_iqd: number | null } | null;
  /** From cost: the SKU whose final dollars the final-price field reads and sets (`productFinalLine`). */
  finalLine?: SkuLine | null;
}) {
  const s = useV2Strings();
  const lang = useV2Lang();
  const priceFirst = draft.method === 'usd';
  const exceptions = Object.entries(draft.models).filter(([, m]) => m.discount === 'exception');
  return (
    <section className="lv-well min-w-0 rounded-lg p-3" data-v2-card="profit">
      <p className="mb-3 text-[12px] font-bold text-text-primary">{priceFirst ? s.directPrice : s.profitAndPreorder}</p>
      <div className="grid min-w-0 gap-3">
        {priceFirst ? (
          <V2Field label={s.directPrice} hint={direct !== null ? `→ ${iqdText(direct)}` : undefined}>
            {(id) => <UsdInput id={id} value={draft.product_usd} onChange={(product_usd) => setDraft((d) => ({ ...d, product_usd }))} data="product-usd" />}
          </V2Field>
        ) : owner ? (
          <div className="grid min-w-0 gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
            <V2Field label={s.minProfit}>
              {(id) => (
                <UsdInput id={id} value={draft.min_profit_usd} placeholder={inheritPlaceholder(s.inherit, inheritedMinProfit)} onChange={(min_profit_usd) => setDraft((d) => ({ ...d, min_profit_usd }))} data="min-profit" />
              )}
            </V2Field>
            <FinalPriceField line={finalLine} profit={draft.min_profit_usd} onProfit={(min_profit_usd) => setDraft((d) => ({ ...d, min_profit_usd }))} data="final-usd" />
          </div>
        ) : null}
        <V2Field label={s.discount} hint={<>{s.discountHint}{preorder !== null ? ` · → ${iqdText(preorder)}` : ''}</>}>
          {(id) => <UsdInput id={id} value={draft.discount_usd} placeholder="0" onChange={(discount_usd) => setDraft((d) => ({ ...d, discount_usd }))} data="discount" />}
        </V2Field>
        {exceptions.length ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary" data-v2-exceptions>
            <span className="font-bold">{s.exceptions}</span>
            {exceptions.map(([id, m]) => (
              <span key={id} className="min-w-0 truncate" dir="auto">
                {nameIn(modelNames(id), lang) || id} {m.discount_usd ? signedUsd(`-${m.discount_usd}`) : '—'}
              </span>
            ))}
            <button type="button" className="inline-flex min-h-11 items-center px-1 font-bold underline underline-offset-2 text-text-primary" onClick={() => onJump(5)} data-v2-jump={5}>
              {s.show} ↘
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
