import React, { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { fetchInventoryLots, formatIqd, type InventoryLot } from '../../../lib/api';

/**
 * «دفعات هذا المنتج» — the cost layers behind the stock number in this form.
 *
 * ###########################################################################
 * #  THE PRODUCT FORM HAS ONE «سعر الكلفة» FIELD, AND THE SHELF MAY HOLD    #
 * #  THREE DIFFERENT COSTS. THIS IS WHERE THAT IS ADMITTED.                 #
 * ###########################################################################
 *
 * `product_cost_iqd` is what the resolver uses at the till for a product with
 * no batch history. It is NOT what the stock on the shelf cost, and an owner
 * editing that one field while holding ten units at 450,000 and ten at
 * 560,000 is editing a number that describes neither of them.
 *
 * So the form shows the real layers, in the order they will be consumed, right
 * beside the field — read-only, because a cost layer is a record of a purchase
 * and not a thing to retype. Changing it happens where it happened: a receipt,
 * or an adjustment, on إدارة المخزون.
 *
 * ---------------------------------------------------------------------------
 * SILENT WHEN THERE IS NOTHING TO SAY, AND SILENT FOR AN ASSISTANT.
 *
 * A product with no batches renders nothing at all — most products, most of
 * the time, and a permanently empty panel is furniture. An assistant admin
 * gets the same nothing: the server strips `unit_cost_iqd` out of the payload
 * for them (§52), and a panel whose only content is costs has no content left.
 */
export function InventorySummary({ productId }: { productId: string }) {
  const [lots, setLots] = useState<InventoryLot[] | null>(null);

  useEffect(() => {
    if (!productId) { setLots(null); return; }
    let live = true;
    fetchInventoryLots({ product_id: productId })
      .then((r) => { if (live) setLots(r.lots.filter((l) => l.qty_remaining > 0)); })
      // A database that has not run migration 0098, or an assistant admin:
      // either way there is nothing to show and nothing to apologise for.
      .catch(() => { if (live) setLots([]); });
    return () => { live = false; };
  }, [productId]);

  if (!lots || lots.length === 0) return null;
  const showsCosts = 'unit_cost_iqd' in lots[0];
  if (!showsCosts) return null;

  const units = lots.reduce((n, l) => n + l.qty_remaining, 0);
  const priced = lots.filter((l) => l.unit_cost_iqd !== null && l.unit_cost_iqd !== undefined);
  const value = priced.reduce((n, l) => n + l.qty_remaining * (l.unit_cost_iqd as number), 0);
  const unpriced = units - priced.reduce((n, l) => n + l.qty_remaining, 0);
  const next = lots[0]?.unit_cost_iqd;

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5" data-form="inventory-summary">
      <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-white">
        <Layers size={14} className="text-zinc-400" aria-hidden />
        دفعات هذا المنتج <span className="font-medium text-zinc-500">/ This product&apos;s batches</span>
      </h4>
      <p className="mb-3 text-[11.5px] leading-[1.6] text-zinc-400">
        المخزون على الرف يحمل التكاليف التالية. البيعة القادمة تستهلك أقدمها.
      </p>

      <ul className="grid gap-1.5">
        {lots.slice(0, 6).map((l, i) => (
          <li
            key={l.id}
            className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] ${
              i === 0 ? 'bg-iris/12 text-white' : 'text-zinc-300'
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="tabular-nums font-semibold">{l.qty_remaining}</span>
              <span className="text-zinc-500">×</span>
              <span className="tabular-nums">
                {l.unit_cost_iqd === null || l.unit_cost_iqd === undefined
                  ? <span className="italic text-zinc-500">تكلفة غير معروفة</span>
                  : formatIqd(l.unit_cost_iqd)}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums" dir="ltr">
              {(l.received_at ?? '').slice(0, 10)}
              {i === 0 ? ' ← التالية' : ''}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-3 grid gap-1 border-t border-zinc-800 pt-3 text-[12px]">
        <Line label="الوحدات على الرف" value={<span className="tabular-nums">{units}</span>} />
        {next !== null && next !== undefined && (
          <Line label="تكلفة الوحدة التالية" value={<span className="tabular-nums">{formatIqd(next)}</span>} strong />
        )}
        <Line label="قيمة المخزون" value={<span className="tabular-nums">{formatIqd(value)}</span>} />
        {unpriced > 0 && (
          <Line
            label="وحدات بلا تكلفة معروفة"
            value={<span className="tabular-nums text-amber-400">{unpriced}</span>}
          />
        )}
      </dl>

      {/* Said out loud, because the field above it invites the opposite
          conclusion: editing «سعر الكلفة» does not change any of these. */}
      <p className="mt-3 text-[11px] leading-[1.6] text-zinc-500">
        هذه سجلات شراء ولا تُعدَّل من هنا. تغييرها يكون باستلام دفعة جديدة أو بتعديل كمية من «إدارة المخزون».
        سعر الكلفة أعلاه يُستخدم للمنتجات التي لا دفعات لها.
      </p>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-semibold text-white' : 'text-zinc-400'}>{label}</dt>
      <dd className={strong ? 'font-bold text-white' : 'text-zinc-200'}>{value}</dd>
    </div>
  );
}
