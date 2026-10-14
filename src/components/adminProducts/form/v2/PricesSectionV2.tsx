/**
 * ٣ «الأسعار» — SECTION THREE OF THE PRODUCT FORM, FOR EVERY PRODUCT
 * (implementation spec §5.3 and its addendum of 2026-10-14, A.7;
 * docs/PRICING-V2.md §2.2, §2.3; DECISIONS rows 221, 222).
 *
 * In reading order (the page is right-to-left):
 *   - a product no customer sees yet (the clean start, or add-product) says so;
 *   - the owner's rate line «1 USD = … د.ع (معتمد) [السجل]»;
 *   - «كيف يُحسب السعر؟» — the owner's choice, a label for everyone else;
 *   - from cost: the cost card | the profit and pre-order card; a dollar
 *     price: «سعر البيع المباشر [$]» and the discount, the cost folded and
 *     optional (the owner's);
 *   - the first model's result bar;
 *   - what is missing, grouped («ناقص: تكلفة المورد (المنتج)»);
 *   - «الأسعار النهائية للزبون» with «التفاصيل».
 * A price editor types dollars on a price-first product (Q2) and reads the
 * final dinars of a cost-first one («تسعير هذا المنتج من التكلفة للمالك فقط»).
 *
 * No old dinar price appears anywhere here, and no maths runs here: every
 * figure is the server's answer to the draft (useV2Pricing).
 */
import { useMemo } from 'react';
import type { ProductDimensionsV2 } from '../../../../lib/productTypes';
import { draftOf, firstLineOf, withPackageMeasure, type V2Names } from './v2Model';
import { useV2 } from './useV2Pricing';
import MethodToggle from './MethodToggle';
import CostCard from './CostCard';
import ProfitDiscountCard from './ProfitDiscountCard';
import ResultBar from './ResultBar';
import ReadinessV2 from './ReadinessV2';
import FinalPricesTable from './FinalPricesTable';
import { firstPreorder } from './v2Model';
import { useV2Strings } from './v2Ui';
import PurchaseReviewCard from './PurchaseReviewCard';

export default function PricesSectionV2({
  modelNames,
  firstModelId,
  packageDims,
  onJump,
  productId = null,
}: {
  modelNames: (id: string) => V2Names | null;
  /** The first active model of section ٥ (its result is the bar's), or null for an option-less product. */
  firstModelId: string | null;
  packageDims: ProductDimensionsV2 | null;
  onJump: (section: 3 | 5) => void;
  /** The stored product (null: add-product) — the owner's purchase review is read for it (D1, A.10). */
  productId?: string | null;
}) {
  const v2 = useV2();
  const s = useV2Strings();
  const storedCost = useMemo(() => draftOf(v2?.stored ?? null).cost, [v2?.stored]);
  if (!v2 || !v2.mode) return null;
  const a = v2.answer;
  const d = v2.draft;
  if (!a && v2.loading) {
    return (
      <p className="py-2 text-[12px] text-text-muted" data-form="pricing-v2" data-v2-loading>
        {s.computing}
      </p>
    );
  }
  const codes = a?.codes ?? [];
  const table = a?.table ?? [];
  const lead = firstLineOf(table, firstModelId) ?? firstLineOf(table, table[0]?.option_value_ids[0] ?? null);
  const pre = firstPreorder(lead);
  const priceFirst = d?.method === 'usd';
  const filled = d ? withPackageMeasure(storedCost, packageDims) : storedCost;
  const fromPackage = {
    weight: storedCost.weight_g === null && filled.weight_g !== null && d?.cost.weight_g === filled.weight_g,
    box: storedCost.box === null && filled.box !== null && JSON.stringify(d?.cost.box) === JSON.stringify(filled.box),
  };
  const setCost = (patch: Partial<NonNullable<typeof d>['cost']>) => v2.setDraft((x) => ({ ...x, cost: { ...x.cost, ...patch } }));

  return (
    <div className="min-w-0" data-form="pricing-v2" data-v2-mode={v2.mode} data-v2-owner={v2.owner ? '1' : '0'} aria-busy={v2.previewing || undefined}>
      {v2.hidden ? (
        <div className="lv-alert lv-alert-info mb-3 px-3 py-2 text-[12px] leading-snug text-text-primary" data-v2-hidden>
          {a?.publishable ? s.hiddenNoteReady : s.hiddenNote}
        </div>
      ) : null}
      {v2.owner && a?.v2_rate ? (
        <p className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-text-secondary" data-v2-rate>
          <span dir="ltr">{s.chipRate(new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(a.v2_rate.usd_iqd)))}</span>
          <a href="/admin?tab=pricing" className="font-bold underline underline-offset-2 text-text-primary">
            {s.rateHistory}
          </a>
        </p>
      ) : null}
      {/* D1: a priced product reviews a purchase here; a needs-pricing product's first publish applies it (its prefill). */}
      {v2.owner && productId && v2.mode === 'stored' && !v2.needsMethod ? <PurchaseReviewCard productId={productId} onApplied={v2.reload} /> : null}
      {v2.owner && v2.needsMethod && a?.v2_cost_inputs?.purchase_review_id ? (
        <p className="lv-alert lv-alert-info mb-3 px-3 py-2 text-[12px] leading-snug text-text-primary" data-v2-purchase-prefill>
          {s.purchasePrefill}
        </p>
      ) : null}
      {codes.includes('FX_RATE_MISSING') ? <p className="lv-alert lv-alert-warning mb-3 px-3 py-2 text-[12px] text-text-primary">{s.rateMissing}</p> : null}
      {codes.includes('PRICING_NOT_INSTALLED') ? <p className="lv-alert lv-alert-warning mb-3 px-3 py-2 text-[12px] text-text-primary">{s.notInstalled}</p> : null}

      {d ? <MethodToggle method={d.method} editable={v2.owner && (a?.can_edit.method ?? true)} onChange={(method) => v2.setDraft((x) => ({ ...x, method }))} /> : null}
      {!v2.owner && v2.money ? <p className="mb-3 text-[11px] text-text-muted">{s.staffUsd}</p> : null}
      {!v2.money ? (
        <p className="lv-alert lv-alert-info mb-3 px-3 py-2 text-[12px] text-text-primary" data-v2-owner-only>
          {s.costFirstNoMoney}
        </p>
      ) : null}

      {v2.money && d ? (
        priceFirst ? (
          <div className="mb-3 grid min-w-0 gap-3">
            <ProfitDiscountCard draft={d} setDraft={v2.setDraft} owner={v2.owner} direct={lead?.channels.direct_sale?.price_iqd ?? null} preorder={pre?.price_iqd ?? null} modelNames={modelNames} onJump={onJump} />
            {v2.owner ? <CostCard cost={d.cost} onChange={setCost} optional fromPackage={fromPackage} /> : null}
          </div>
        ) : (
          <div className="mb-3 grid min-w-0 gap-3 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:repeat(2,minmax(0,1fr))]">
            {v2.owner ? <CostCard cost={d.cost} onChange={setCost} optional={false} fromPackage={fromPackage} /> : null}
            <ProfitDiscountCard draft={d} setDraft={v2.setDraft} owner={v2.owner} direct={lead?.channels.direct_sale?.price_iqd ?? null} preorder={pre?.price_iqd ?? null} modelNames={modelNames} onJump={onJump} />
          </div>
        )
      ) : null}

      <ResultBar line={lead} owner={v2.owner} title={lead?.model_id ? modelNames(lead.model_id) : null} />
      <ReadinessV2 missing={a?.missing ?? []} onJump={onJump} />
      <FinalPricesTable table={table} owner={v2.owner} money={v2.money} draft={d} setDraft={v2.setDraft} modelNames={modelNames} onJump={onJump} />

      <div className="mt-2 min-h-4 text-[11px]" aria-live="polite">
        {v2.previewing ? <span className="text-text-muted">{s.computing}</span> : v2.error ? <span className="text-red-400">{s.previewFailed(v2.error)}</span> : v2.drafting ? <span className="text-amber-300">{s.includesDrafts}</span> : null}
      </div>
    </div>
  );
}
