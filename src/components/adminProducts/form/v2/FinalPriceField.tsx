/**
 * «السعر النهائي ($)» — the owner's two-way editor of the minimum profit (the owner's request, 2026-10-18).
 *
 * T stays the one stored figure (no column of its own). A typed final price X sets T = X − the reference SKU's
 * dollars without profit, read from the CURRENT preview (`finalUsdOf`); a T typed in its own field moves this
 * one on the next preview. At or below the cost it is refused, and T is left as it was. The dinars follow the
 * preview, where the rounding rule (row 245) may lift them — the hint says so. Any other edit (the cost, the
 * shipping, a difference, the route…) moves the cost: the field waits for that edit's preview (`priced.cost`),
 * shown «…» and closed, so a typed price never meets an old cost.
 */
import { useState } from 'react';
import { cleanUsd, finalUsdOf, profitForFinal, usdText, type SkuLine } from './v2Model';
import { useV2 } from './useV2Pricing';
import { UsdInput, useV2Strings, V2Field } from './v2Ui';

export default function FinalPriceField({ line, profit, onProfit, data }: { line: SkuLine | null; profit: string; onProfit: (usd: string) => void; data: string }) {
  const s = useV2Strings();
  const v2 = useV2();
  // The cost is the preview's only once the preview answers the draft's other inputs as they stand.
  const waiting = !v2?.priced.cost;
  const ref = waiting ? null : finalUsdOf(line);
  // What the owner typed: shown while T is the one it set and the preview's cost has not moved.
  const [typed, setTyped] = useState<{ text: string; profit: string; base: string | null; error: string | null } | null>(null);
  const mine = ref && typed && typed.profit === profit && typed.base === ref.base ? typed : null;
  // A T typed since the preview (or emptied, or not a price): its final price is the next preview's — the shown
  // one stands only for the draft it answered, or for the same T.
  const t = cleanUsd(profit);
  const stale = !ref || (!v2?.priced.draft && (t === null || t !== cleanUsd(ref.profit)));
  const onChange = (text: string) => {
    const r = ref ? profitForFinal(text, ref.base) : null;
    if (r?.ok) onProfit(r.usd);
    const error = r?.ok === false ? (r.reason === 'below_cost' ? s.finalBelowCost(usdText(ref!.cost)) : s.finalTooLarge) : null;
    setTyped({ text, profit: r?.ok ? r.usd : profit, base: ref?.base ?? null, error });
  };
  const hint = mine?.error ? (
    <span className="text-red-400" role="alert">
      {mine.error}
    </span>
  ) : waiting && !v2?.error ? (
    s.computing
  ) : ref ? (
    s.finalPriceHint
  ) : (
    s.finalPriceWaiting
  );
  return (
    <V2Field label={s.finalPrice} hint={hint}>
      {(id) => <UsdInput id={id} value={mine ? mine.text : stale ? '' : ref.final} placeholder={stale ? '…' : undefined} disabled={!ref} onChange={onChange} data={data} />}
    </V2Field>
  );
}
