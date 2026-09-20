/**
 * «الحركات» — every change to a stock number, and who made it.
 *
 * READ-ONLY, AND THAT IS THE POINT. `inventory_ledger` is the record of what
 * happened; a screen that could edit it would be a screen that could make what
 * happened disagree with what is on the shelf. Corrections are made by
 * RECORDING A NEW MOVEMENT (the adjust dialog on the stock tab), which is why
 * there is no edit control anywhere here.
 *
 * The kinds are shown in the owner's words — «بيع», «إرجاع», «إضافة» — rather
 * than as `deduct` / `restore` / `adjust_in`. An unfamiliar English verb in a
 * financial log is a log nobody reads.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { fetchMovements, type InventoryMovement } from '../../lib/api';
import { Empty, Loading, Notice, TableFrame, errMsg, useCount, useLoc, type NoticeState } from './shared';
import type { InvStrings } from './strings';

/** Does this movement ADD to the shelf or take from it? Drives the arrow and
 *  the colour, so the direction is readable without parsing the verb. */
const ADDS = new Set(['release', 'restore', 'adjust_in']);

export function MovementsTab({ s }: { s: InvStrings }) {
  const count = useCount();
  const { latin } = useLoc();
  const [rows, setRows] = useState<InventoryMovement[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const r = await fetchMovements({ limit: 120 });
      setRows(r.movements);
    } catch (e) {
      setRows([]);
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-w-0">
      <Notice state={notice} onClose={() => setNotice(null)} />
      <div className="mb-4 flex items-center gap-2">
        <button type="button" className={T.btnSecondary} onClick={load}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      {rows === null ? (
        <Loading text={s.common.loading} />
      ) : rows.length === 0 ? (
        <Empty text={s.movements.empty} />
      ) : (
        <TableFrame minWidth={760}>
          <thead className={T.tableHead}>
            <tr>
              <th className="px-3 py-2.5 text-start font-semibold">{s.movements.when}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.stock.product}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.movements.what}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.movements.qty}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.movements.why}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.movements.who}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const adds = ADDS.has(m.kind);
              const label = s.movements.kinds[m.kind as keyof typeof s.movements.kinds] ?? m.kind;
              return (
                <tr key={m.id} className={`${T.tableRow} border-b border-[var(--ap-border)] last:border-0`}>
                  <td className={`px-3 py-2.5 text-[12px] whitespace-nowrap ${T.text2}`}>
                    {(m.created_at ?? '').slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className={`px-3 py-2.5 ${T.text1}`}>
                    <span className="block truncate">{m.product_name ?? m.product_id ?? s.common.none}</span>
                    {m.scope !== 'base' && <span className={`block truncate text-[11px] ${T.text3}`}>{m.scope}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`${T.badgeBase} ${adds ? T.badge.active : T.badge.draft}`}>
                      {adds ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />} {label}
                    </span>
                  </td>
                  <td className={`px-3 py-2.5 font-bold tabular-nums ${adds ? 'text-[var(--ap-success)]' : T.text1}`}>
                    {adds ? '+' : '−'}{count(m.qty)}
                  </td>
                  <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>
                    {m.reason || (m.order_id ? m.order_id : s.common.none)}
                  </td>
                  <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{m.actor_name ?? s.common.none}</td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
    </div>
  );
}
