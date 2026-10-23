/**
 * «النتيجة (Standard)» — THE FIRST MODEL'S RESULT IN ONE BAR (implementation
 * spec §5.2 `ResultBar.tsx`; docs/PRICING-V2.md §2.2, §2.3).
 *
 *   - the owner: cost · minimum profit · final $ · final dinars, and «طلب
 *     مسبق: $ → د.ع» — from the owner's private row of the server's answer;
 *   - a price editor: the direct and the pre-order dinars (and, price-first,
 *     the dollars they typed behind them) — never a cost or a profit.
 * A model priced from the shelf (DECISIONS row 244) says so to the owner under
 * the bar: «من المخزون: أعلى تكلفة على الرف 690,062 د.ع (6 قطع)», its cost cell
 * being that batch.
 * Desktop: four cells in a row; a phone: the 2×2 grid. The owner's warnings
 * (the discount withdrawn on a route, below cost, below cost + the minimum
 * profit) sit under it, codes turned into words — never a figure to anyone else.
 */
import { firstPreorder, iqdText, nameIn, shelfOf, usdText, type SkuLine, type V2Names } from './v2Model';
import { channelName, Readout, useV2Lang, useV2Strings } from './v2Ui';
import type { V2Strings } from './v2Strings';

/**
 * The owner's reasons under one SKU line, codes turned into words (never a figure): the discount withdrawn
 * on a route, a route blocked (below its cost, no supplier price, the shelf cheaper), sold out, below cost
 * + the minimum profit, below cost, lifted to the minimum profit. Shared by the result bar and the model
 * and colour cards of section ٥ (row 247): a pre-order equal to the direct price always says why.
 */
export function lineNotes(
  line: SkuLine | null | undefined,
  s: Pick<V2Strings, 'discountTooBig' | 'routeBlocked' | 'routeNoSupplierNote' | 'routeShelfCheaperNote' | 'stockSoldOutNote' | 'belowMinProfit' | 'belowCost' | 'floorMinProfit'>
): string[] {
  if (!line) return [];
  const rows = Object.values(line.channels);
  const blockedBy = (code: string) => rows.some((r) => r?.blocked && (r.v2_blocked ?? 'V2_ROUTE_BELOW_COST') === code);
  return [
    ...(rows.some((r) => r?.owner?.v2_floor === 'discount_withdrawn') ? [s.discountTooBig] : []),
    ...(blockedBy('V2_ROUTE_BELOW_COST') ? [s.routeBlocked] : []),
    ...(blockedBy('V2_ROUTE_NO_SUPPLIER') ? [s.routeNoSupplierNote] : []),
    ...(blockedBy('V2_ROUTE_SHELF_CHEAPER') ? [s.routeShelfCheaperNote] : []),
    ...(blockedBy('V2_STOCK_SOLD_OUT') ? [s.stockSoldOutNote] : []),
    ...(rows.some((r) => r?.owner?.v2_below_min_profit) ? [s.belowMinProfit] : []),
    ...(rows.some((r) => r?.owner?.v2_below_cost) ? [s.belowCost] : []),
    ...(rows.some((r) => r?.owner?.v2_floor === 'direct_min_profit') ? [s.floorMinProfit] : []),
  ];
}

/** «النتيجة (Pro)» for a model; «النتيجة» alone for a product without options (never «النتيجة (—)»). */
export function resultTitle(name: string, s: Pick<V2Strings, 'result'>): string {
  const n = name.trim();
  return n && n !== '—' ? s.result(n) : s.result('').replace(/\s*\(\s*\)\s*$/, '');
}

export default function ResultBar({ line, owner, title }: { line: SkuLine | null; owner: boolean; title: V2Names | null }) {
  const s = useV2Strings();
  const lang = useV2Lang();
  if (!line) return null;
  const direct = line.channels.direct_sale ?? null;
  const pre = firstPreorder(line);
  const o = direct?.owner ?? null;
  const priceFirst = direct?.editor_usd_price !== undefined;
  const shelf = owner ? shelfOf(line) : null;
  const warnings = owner ? lineNotes(line, s) : [];
  return (
    <section className="min-w-0 mb-3" data-v2-result>
      <p className="mb-1.5 truncate text-[12px] font-bold text-text-secondary" dir="auto">
        {/* A product without options has no model name: the title is «النتيجة» alone, never «النتيجة (—)». */}
        {resultTitle(nameIn(title ?? line.names, lang), s)}
      </p>
      <div className="grid min-w-0 gap-2 [grid-template-columns:repeat(2,minmax(0,1fr))] md:[grid-template-columns:repeat(4,minmax(0,1fr))]">
        {owner ? (
          <>
            <Readout label={s.cost} value={o?.v2_replacement_iqd !== null && o?.v2_replacement_iqd !== undefined ? iqdText(o.v2_replacement_iqd) : '—'} tone="muted" data="cost" />
            <Readout label={s.minProfit} value={o?.v2_profit_usd ? `+${usdText(o.v2_profit_usd)}` : '—'} tone="muted" data="profit" />
            <Readout label={s.finalUsd} value={priceFirst ? usdText(direct?.editor_usd_price) : usdText(o?.v2_usd_ceil6)} data="usd" />
            <Readout label={s.direct} value={iqdText(direct?.price_iqd)} data="direct" />
          </>
        ) : (
          <>
            <Readout label={s.direct} value={iqdText(direct?.price_iqd)} sub={priceFirst ? usdText(direct?.editor_usd_price) : undefined} data="direct" />
            <Readout
              label={pre ? channelName(pre.channel, lang) : s.preorder}
              value={pre?.blocked ? s.noPriceYet : iqdText(pre?.price_iqd)}
              sub={priceFirst && pre?.editor_usd_price ? usdText(pre.editor_usd_price) : undefined}
              data="preorder"
            />
          </>
        )}
      </div>
      {shelf ? (
        <p className="mt-1.5 text-[11px] font-bold text-text-secondary" dir="auto" data-v2-stock-line>
          {s.sourceStock(iqdText(shelf.cost_iqd), shelf.units)}
        </p>
      ) : null}
      {owner && pre ? (
        <p className="mt-1.5 text-[11px] text-text-secondary" dir="auto" data-v2-preorder-line>
          {s.preorderLine(priceFirst ? usdText(pre.editor_usd_price) : usdText(pre.owner?.v2_usd_ceil6), iqdText(pre.price_iqd))}
        </p>
      ) : null}
      {warnings.length ? (
        <ul className="mt-1.5 grid gap-0.5 text-[11px] text-amber-300" data-v2-warnings>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
