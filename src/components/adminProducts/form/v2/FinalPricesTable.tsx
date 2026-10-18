/**
 * «الأسعار النهائية للزبون» (implementation spec §5.2 `FinalPricesTable.tsx`;
 * docs/PRICING-V2.md §2.2, §2.3).
 *
 * Model · colour / direct / pre-order per route / «من أين جاء السعر» /
 * [عدّل ↘]: one block per model, its first SKU leading, the SKUs that differ
 * from their model shown, the rest folded («▸ 4 صفوف أخرى تتبع موديلها»).
 * Desktop: a table; a phone: one card per model. Every dinar is the server's.
 *
 * «التفاصيل ▾» opens the SKU × channel rows: for the owner R, T and the final
 * dollars (the private row of the answer); for whoever may type dollars here
 * the per-SKU «سعر خاص $» and «خصم $» — an SKU's own price and discount.
 */
import { useState, type ReactNode } from 'react';
import { channelsOf, inheritedSkuDiscount, iqdText, modelBlocks, nameIn, shelfOf, usdCentsUp, usdText, type PriceDraft, type SkuLine, type V2Channel, type V2Names, type V2TableRow } from './v2Model';
import { channelName, UsdInput, useV2Lang, useV2Strings, V2Field } from './v2Ui';
import type { V2Strings } from './v2Strings';

function sourceText(line: SkuLine, s: V2Strings, modelName: string): string {
  // DECISIONS row 244 (the owner's answer only): the direct price is read from the costliest batch on the shelf.
  const shelf = shelfOf(line);
  if (shelf) return s.sourceStock(iqdText(shelf.cost_iqd), shelf.units);
  switch (line.source) {
    case 'model_fixed':
      return s.sourceModelFixed;
    case 'model_delta':
      return s.sourceModelDelta;
    case 'model_cost':
      return s.sourceModelCost(modelName);
    case 'colour_delta':
      return s.sourceColourDelta;
    case 'colour_cost':
      return s.sourceColourCost;
    case 'sku_fixed':
      return s.sourceSkuFixed;
    default:
      return s.sourceProduct;
  }
}

/**
 * The dollar price an SKU follows (its model's, else the product's) — the server's direct price while the SKU
 * has no special price of its own; null once it has one (the field then shows its own value).
 */
export function inheritedUsd(line: SkuLine, ownFixed: string): string | null {
  if (ownFixed) return null;
  const r = line.channels.direct_sale;
  return r?.editor_usd_price ?? r?.owner?.v2_usd_ceil6 ?? null;
}

function cell(row: V2TableRow | undefined, s: V2Strings, owner: boolean): string {
  if (!row) return '—';
  if (row.blocked) return owner ? blockedText(row, s) : '—';
  return iqdText(row.price_iqd);
}

/** Why the owner's channel is not sold: the floor, a route waiting for its supplier price, a sold-out model (row 244). */
export function blockedText(row: Pick<V2TableRow, 'v2_blocked'>, s: Pick<V2Strings, 'routeBlocked' | 'routeNoSupplier' | 'routeShelfCheaper' | 'stockSoldOut'>): string {
  if (row.v2_blocked === 'V2_ROUTE_NO_SUPPLIER') return s.routeNoSupplier;
  if (row.v2_blocked === 'V2_ROUTE_SHELF_CHEAPER') return s.routeShelfCheaper;
  if (row.v2_blocked === 'V2_STOCK_SOLD_OUT') return s.stockSoldOut;
  return s.routeBlocked;
}

export default function FinalPricesTable({
  table,
  owner,
  money,
  draft,
  setDraft,
  modelNames,
  onJump,
}: {
  table: readonly V2TableRow[];
  owner: boolean;
  /** The reader may type dollars here (the SKU editor of «التفاصيل»). */
  money: boolean;
  draft: PriceDraft | null;
  setDraft: (fn: (d: PriceDraft) => PriceDraft) => void;
  modelNames: (id: string) => V2Names | null;
  onJump: (section: 3 | 5) => void;
}) {
  const s = useV2Strings();
  const lang = useV2Lang();
  const [details, setDetails] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const channels = channelsOf(table);
  const blocks = modelBlocks(table, modelNames);
  if (!table.length) return <p className="text-[12px] text-text-muted" data-v2-table-empty>{s.noTable}</p>;
  const toggleFold = (key: string) =>
    setUnfolded((u) => {
      const next = new Set(u);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const head = (ch: V2Channel) => (ch === 'direct_sale' ? s.direct : channelName(ch, lang));
  const lineName = (l: SkuLine, block: { names: V2Names }) => nameIn(l.names, lang) || nameIn(block.names, lang) || '—';
  const rowsOf = (b: (typeof blocks)[number]) => [b.lead, ...b.shown, ...(unfolded.has(b.model_id ?? '') ? b.folded : [])];
  const skuSet = (combo: string, patch: Partial<{ fixed_usd: string; discount_usd: string }>) =>
    setDraft((d) => ({ ...d, skus: { ...d.skus, [combo]: { ...(d.skus[combo] ?? { fixed_usd: '', discount_usd: '' }), ...patch } } }));

  return (
    <section className="min-w-0" data-v2-final-table>
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-[13px] font-bold text-text-primary">{s.finalTable}</h4>
        {owner || money ? (
          <button type="button" className="inline-flex min-h-11 shrink-0 items-center px-2 text-[12px] font-bold underline underline-offset-2 text-text-secondary" aria-expanded={details} onClick={() => setDetails((v) => !v)} data-v2-details>
            {details ? s.detailsHide : s.details} {details ? '▴' : '▾'}
          </button>
        ) : null}
      </div>

      {/* Desktop: the table. */}
      <div className="hidden min-w-0 overflow-x-auto md:block">
        <table className="w-full min-w-0 text-[12px]">
          <thead>
            <tr className="text-text-muted">
              <th className="py-1.5 pe-2 text-start font-bold">{s.modelColour}</th>
              {channels.map((ch) => (
                <th key={ch} className="py-1.5 px-2 text-end font-bold">
                  {head(ch)}
                </th>
              ))}
              <th className="py-1.5 ps-2 text-start font-bold">{s.source}</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <FragmentRows key={b.model_id ?? ''}>
                {rowsOf(b).map((l) => (
                  <tr key={l.combo_key} className="border-t border-border-subtle" data-v2-row={l.combo_key}>
                    <td className="max-w-[14rem] truncate py-1.5 pe-2 text-text-primary" dir="auto">
                      {lineName(l, b)}
                    </td>
                    {channels.map((ch) => (
                      <td key={ch} className="py-1.5 px-2 text-end tabular-nums text-text-primary" dir="ltr">
                        {cell(l.channels[ch], s, owner)}
                      </td>
                    ))}
                    <td className="max-w-[12rem] truncate py-1.5 ps-2 text-text-secondary">{sourceText(l, s, nameIn(b.names, lang))}</td>
                    <td className="py-1.5 text-end">
                      {l.source !== 'product' ? (
                        <button type="button" className="inline-flex min-h-11 items-center px-2 text-[11px] font-bold underline underline-offset-2 text-text-secondary" onClick={() => onJump(5)} data-v2-jump={5}>
                          {s.edit} ↘
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {b.folded.length && !unfolded.has(b.model_id ?? '') ? (
                  <tr className="border-t border-border-subtle">
                    <td colSpan={channels.length + 3} className="py-1.5">
                      <button type="button" className="inline-flex min-h-11 items-center px-1 text-[11px] font-bold text-text-muted" onClick={() => toggleFold(b.model_id ?? '')} data-v2-fold>
                        ▸ {s.foldRows(String(b.folded.length))}
                      </button>
                    </td>
                  </tr>
                ) : null}
              </FragmentRows>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: one card per model. */}
      <div className="grid min-w-0 gap-2 md:hidden">
        {blocks.map((b) => (
          <article key={b.model_id ?? ''} className="lv-well min-w-0 rounded-lg p-2.5" data-v2-model-card={b.model_id ?? ''}>
            {rowsOf(b).map((l, i) => (
              <div key={l.combo_key} className={`min-w-0 ${i ? 'mt-2 border-t border-border-subtle pt-2' : ''}`}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[12px] font-bold text-text-primary" dir="auto">
                    {lineName(l, b)}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-muted">{sourceText(l, s, nameIn(b.names, lang))}</span>
                </div>
                <dl className="mt-1 grid min-w-0 gap-x-3 gap-y-0.5 [grid-template-columns:minmax(0,1fr)_auto] text-[12px]">
                  {channels
                    .filter((ch) => l.channels[ch])
                    .map((ch) => (
                      <div key={ch} className="contents">
                        <dt className="min-w-0 truncate text-text-secondary">{head(ch)}</dt>
                        <dd className="text-end tabular-nums text-text-primary" dir="ltr">
                          {cell(l.channels[ch], s, owner)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}
            {b.folded.length && !unfolded.has(b.model_id ?? '') ? (
              <button type="button" className="mt-2 inline-flex min-h-11 items-center px-1 text-[11px] font-bold text-text-muted" onClick={() => toggleFold(b.model_id ?? '')}>
                ▸ {s.foldRows(String(b.folded.length))}
              </button>
            ) : null}
          </article>
        ))}
      </div>

      {details ? (
        <div className="mt-3 grid min-w-0 gap-2" data-v2-details-panel>
          {blocks
            .flatMap((b) => [b.lead, ...b.shown, ...b.folded].map((l) => ({ l, b })))
            .map(({ l, b }) => {
              const sku = draft?.skus[l.combo_key] ?? { fixed_usd: '', discount_usd: '' };
              const editable = money && !!draft && l.combo_key !== '';
              return (
                <article key={l.combo_key} className="lv-well min-w-0 rounded-lg p-2.5" data-v2-sku={l.combo_key}>
                  <p className="mb-1.5 truncate text-[12px] font-bold text-text-primary" dir="auto">
                    {lineName(l, b)}
                  </p>
                  <ul className="grid gap-1 text-[11px] text-text-secondary">
                    {channels
                      .filter((ch) => l.channels[ch])
                      .map((ch) => {
                        const r = l.channels[ch]!;
                        const o = r.owner ?? null;
                        return (
                          <li key={ch} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span className="font-bold text-text-primary">{head(ch)}</span>
                            <span dir="ltr" className="tabular-nums">{cell(r, s, owner)}</span>
                            {r.editor_usd_price ? <span dir="ltr">{usdText(r.editor_usd_price)}</span> : null}
                            {owner && o ? (
                              <>
                                {o.v2_replacement_iqd !== null ? <span>{s.replacement}: <span dir="ltr">{iqdText(o.v2_replacement_iqd)}</span></span> : null}
                                {o.v2_profit_usd ? <span>{s.minProfit}: <span dir="ltr">{usdText(o.v2_profit_usd)}</span></span> : null}
                                {!r.editor_usd_price ? <span dir="ltr">{usdText(usdCentsUp(o.v2_usd_ceil6))}</span> : null}
                                {o.v2_floor === 'discount_withdrawn' ? <span className="text-amber-300">{s.floorWithdrawn}</span> : null}
                                {o.v2_floor === 'direct_min_profit' ? <span className="text-amber-300">{s.floorMinProfit}</span> : null}
                                {o.v2_below_cost ? <span className="text-amber-300">{s.belowCost}</span> : null}
                              </>
                            ) : null}
                            {r.discount_from === 'preorder_only' ? <span>{s.preorderOnly}</span> : null}
                          </li>
                        );
                      })}
                  </ul>
                  {editable ? (
                    // Visible labels (two dollar fields must never look alike once typed) and the inherited value
                    // beside each (§2.1 rule 2): the SKU's price now, the discount of its model or product.
                    <div className="mt-2 grid min-w-0 gap-2 [grid-template-columns:repeat(2,minmax(0,1fr))]">
                      {draft!.method === 'usd' || owner ? (
                        <V2Field label={s.skuSpecial} hint={inheritedUsd(l, sku.fixed_usd) ? (l.model_id ? s.inheritedModel : s.inheritedProduct)(usdText(inheritedUsd(l, sku.fixed_usd))) : undefined}>
                          {(fid) => <UsdInput id={fid} value={sku.fixed_usd} onChange={(fixed_usd) => skuSet(l.combo_key, { fixed_usd })} placeholder={inheritedUsd(l, sku.fixed_usd) ?? ''} data={`sku-fixed:${l.combo_key}`} />}
                        </V2Field>
                      ) : null}
                      {(() => {
                        const inh = inheritedSkuDiscount(draft!, l.model_id);
                        return (
                          <V2Field label={s.skuDiscount} hint={(inh.from === 'model' ? s.inheritedModel : s.inheritedProduct)(usdText(inh.usd))}>
                            {(fid) => <UsdInput id={fid} value={sku.discount_usd} onChange={(discount_usd) => skuSet(l.combo_key, { discount_usd })} placeholder={inh.usd} data={`sku-discount:${l.combo_key}`} />}
                          </V2Field>
                        );
                      })()}
                    </div>
                  ) : null}
                </article>
              );
            })}
        </div>
      ) : null}
    </section>
  );
}

/** Rows of one model inside the table body (a fragment that takes a key). */
function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
