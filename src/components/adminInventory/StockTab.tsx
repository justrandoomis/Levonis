/**
 * «المخزون الحالي» — what is on the shelf, and what each layer of it cost.
 *
 * ###########################################################################
 * #  THE COLUMN THIS TAB EXISTS FOR IS «تكلفة الوحدة التالية».              #
 * ###########################################################################
 *
 * A shop that bought ten units at 450,000 and ten at 560,000 holds twenty
 * units and TWO costs. Every other inventory screen this owner has seen would
 * print one number — usually the latest — and a shop pricing against it
 * believes its stock is worth 1.1 million dinars more than it is, and reports
 * a loss on the cheap units as though they had cost the new price.
 *
 * So the table prints BOTH ends of the queue: the oldest remaining cost, which
 * is what the very next unit sold will actually be charged at, and the newest,
 * which is what the next purchase established. When they differ the row says
 * so, and the batch drawer underneath shows every layer in the order they will
 * be consumed.
 *
 * THE VALUE COLUMN IS Σ(remaining × its own batch cost) — never stock × the
 * latest price. That is computed on the server; this screen does not add money
 * up, it prints what it was given.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Boxes, Layers, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { Modal } from '../adminProducts/ui';
import {
  ADJUST_REASONS,
  createAdjustment,
  fetchInventoryLines,
  fetchInventoryLots,
  type AdjustReason,
  type InventoryLine,
  type InventoryLot,
} from '../../lib/api';
import { Empty, IqdField, Loading, Money, Notice, TableFrame, daysSince, errMsg, useCount, useLoc, type NoticeState } from './shared';
import type { InvStrings } from './strings';

const PAGE = 50;

export function StockTab({ s, onChanged }: { s: InvStrings; onChanged: () => void }) {
  const { dir, latin } = useLoc();
  const count = useCount();
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<InventoryLine[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [lotsFor, setLotsFor] = useState<InventoryLine | null>(null);
  const [adjusting, setAdjusting] = useState<InventoryLine | null>(null);

  const load = useCallback(async (search: string, off: number) => {
    setLines(null);
    try {
      const r = await fetchInventoryLines({ q: search || undefined, limit: PAGE, offset: off });
      setLines(r.lines);
    } catch (e) {
      setLines([]);
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => {
    const t = setTimeout(() => load(q, offset), q ? 280 : 0);
    return () => clearTimeout(t);
  }, [q, offset, load]);

  // The costs are stripped server-side for an assistant admin, so the COLUMNS
  // go away with them — not a wall of dashes hinting at numbers they may not
  // have. One probe on the first row answers for the whole table, because the
  // projection is applied to the whole payload at once.
  const showsCosts = lines !== null && lines.length > 0 && 'oldest_unit_cost_iqd' in lines[0];

  return (
    <div className="min-w-0">
      <Notice state={notice} onClose={() => setNotice(null)} />

      <p className={`mb-4 text-[12.5px] leading-[1.7] ${T.text2}`}>{s.stock.manyCosts}</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search size={15} className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${dir === 'rtl' ? 'right-3' : 'left-3'} ${T.text3}`} aria-hidden />
          <input
            className={`${T.input} w-full ${dir === 'rtl' ? 'pr-9' : 'pl-9'}`}
            placeholder={s.stock.search}
            value={q}
            onChange={(e) => { setOffset(0); setQ(e.target.value); }}
          />
        </div>
        <button type="button" className={T.btnSecondary} onClick={() => load(q, offset)}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      {lines === null ? (
        <Loading text={s.common.loading} />
      ) : lines.length === 0 ? (
        <Empty text={s.stock.empty} />
      ) : (
        <TableFrame minWidth={showsCosts ? 980 : 720}>
          <thead className={T.tableHead}>
            <tr className="text-start">
              <th className="px-3 py-2.5 text-start font-semibold">{s.stock.product}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.stock.onHand}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.stock.batches}</th>
              {showsCosts && (
                <th className="px-3 py-2.5 text-start font-semibold" title={s.stock.nextCostHint}>
                  {s.stock.nextCost}
                </th>
              )}
              {showsCosts && <th className="px-3 py-2.5 text-start font-semibold">{s.stock.newestCost}</th>}
              {showsCosts && <th className="px-3 py-2.5 text-start font-semibold">{s.stock.value}</th>}
              <th className="px-3 py-2.5 text-start font-semibold">{s.stock.oldest}</th>
              <th className="px-3 py-2.5 text-end font-semibold" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const age = daysSince(l.oldest_received_at);
              const layered =
                showsCosts &&
                l.oldest_unit_cost_iqd !== null && l.oldest_unit_cost_iqd !== undefined &&
                l.newest_unit_cost_iqd !== null && l.newest_unit_cost_iqd !== undefined &&
                l.oldest_unit_cost_iqd !== l.newest_unit_cost_iqd;
              return (
                <tr key={`${l.scope}:${l.scope_id}:${l.product_id}`} className={`${T.tableRow} border-b border-[var(--ap-border)] last:border-0`}>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {l.product_image ? (
                        <img src={l.product_image} alt="" className={T.thumb} loading="lazy" />
                      ) : (
                        <span className={`flex h-9 w-9 items-center justify-center rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] ${T.text3}`}>
                          <Boxes size={15} />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className={`block truncate font-semibold ${T.text1}`}>{l.product_name ?? l.product_id}</span>
                        {l.scope !== 'base' && (
                          <span className={`block truncate text-[11px] ${T.text3}`}>{l.scope} · {l.scope_id}</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className={`px-3 py-2.5 font-bold tabular-nums ${T.text1}`}>{count(l.on_hand)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`${T.badgeBase} ${layered ? T.badge.draft : T.badge.active}`}>
                      <Layers size={12} /> {count(l.lot_count)}
                    </span>
                  </td>
                  {showsCosts && (
                    <td className="px-3 py-2.5 font-semibold">
                      <Money value={l.oldest_unit_cost_iqd} unknownLabel={s.stock.unknown} />
                    </td>
                  )}
                  {showsCosts && (
                    <td className="px-3 py-2.5">
                      <Money value={l.newest_unit_cost_iqd} unknownLabel={s.stock.unknown} />
                    </td>
                  )}
                  {showsCosts && (
                    <td className="px-3 py-2.5">
                      <Money value={l.inventory_value_iqd} unknownLabel={s.stock.unknown} />
                      {l.unpriced_units > 0 && (
                        <span className={`block text-[11px] ${T.text3}`}>{s.stats.unpriced(count(l.unpriced_units))}</span>
                      )}
                    </td>
                  )}
                  <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>
                    {age === null ? s.common.none : s.stock.days(count(age))}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" className={T.btnGhostSm} onClick={() => setLotsFor(l)}>
                        {s.stock.viewLots}
                      </button>
                      <button type="button" className={T.btnIcon} title={s.stock.adjust} onClick={() => setAdjusting(l)}>
                        <SlidersHorizontal size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}

      {lines !== null && (lines.length === PAGE || offset > 0) && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <button type="button" className={T.pageBtn} disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
            ‹
          </button>
          <span className={`text-[12px] ${T.text3}`}>{count(Math.floor(offset / PAGE) + 1)}</span>
          <button type="button" className={T.pageBtn} disabled={lines.length < PAGE} onClick={() => setOffset((o) => o + PAGE)}>
            ›
          </button>
        </div>
      )}

      {lotsFor && <LotsDialog s={s} line={lotsFor} onClose={() => setLotsFor(null)} />}
      {adjusting && (
        <AdjustDialog
          s={s}
          line={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={(text) => {
            setAdjusting(null);
            setNotice({ tone: 'success', text });
            load(q, offset);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
//  THE QUEUE, IN THE ORDER IT WILL BE EATEN
// ===========================================================================

function LotsDialog({ s, line, onClose }: { s: InvStrings; line: InventoryLine; onClose: () => void }) {
  const { latin } = useLoc();
  const count = useCount();
  const [lots, setLots] = useState<InventoryLot[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchInventoryLots({ scope: line.scope, scope_id: line.scope_id })
      .then((r) => setLots(r.lots))
      .catch((e) => { setLots([]); setErr(errMsg(e, s.common.failed, s.common.failed, latin)); });
  }, [line, s, latin]);

  const showsCosts = lots !== null && lots.length > 0 && 'unit_cost_iqd' in lots[0];

  return (
    <Modal titleAr={s.lots.title} titleEn={s.lots.title} onClose={onClose} wide>
      <div className="min-w-0">
        <p className={`mb-3 text-[12.5px] font-semibold ${T.text1}`}>{line.product_name ?? line.product_id}</p>
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}
        {lots === null ? (
          <Loading text={s.common.loading} />
        ) : lots.length === 0 ? (
          <Empty text={s.stock.empty} />
        ) : (
          <TableFrame minWidth={showsCosts ? 760 : 520}>
            <thead className={T.tableHead}>
              <tr>
                <th className="px-3 py-2.5 text-start font-semibold">{s.lots.date}</th>
                <th className="px-3 py-2.5 text-start font-semibold">{s.lots.received}</th>
                <th className="px-3 py-2.5 text-start font-semibold">{s.lots.sold}</th>
                <th className="px-3 py-2.5 text-start font-semibold">{s.lots.remaining}</th>
                {showsCosts && <th className="px-3 py-2.5 text-start font-semibold">{s.lots.unitCost}</th>}
                <th className="px-3 py-2.5 text-start font-semibold">{s.lots.supplier}</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot, i) => (
                <tr
                  key={lot.id}
                  className={`${T.tableRow} border-b border-[var(--ap-border)] last:border-0 ${
                    // THE HEAD OF THE QUEUE, marked. The first row with units
                    // left is the one the next sale eats, and saying so is the
                    // difference between a list of batches and an explanation.
                    lot.qty_remaining > 0 && lots.findIndex((x) => x.qty_remaining > 0) === i
                      ? 'bg-[var(--ap-accent-soft)]'
                      : ''
                  }`}
                >
                  <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{(lot.received_at ?? '').slice(0, 10)}</td>
                  <td className="px-3 py-2.5 tabular-nums">{count(lot.qty_received)}</td>
                  <td className={`px-3 py-2.5 tabular-nums ${T.text2}`}>{count(lot.consumed)}</td>
                  <td className={`px-3 py-2.5 font-bold tabular-nums ${T.text1}`}>{count(lot.qty_remaining)}</td>
                  {showsCosts && (
                    <td className="px-3 py-2.5">
                      <Money value={lot.unit_cost_iqd} unknownLabel={s.stock.unknown} />
                      {lot.cost_basis !== 'received' && (
                        <span className={`block text-[11px] ${T.text3}`}>{s.lots.basis[lot.cost_basis]}</span>
                      )}
                    </td>
                  )}
                  <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{lot.supplier_name ?? s.common.none}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
        <p className={`mt-3 text-[11.5px] leading-[1.6] ${T.text3}`}>{s.lots.openingHint}</p>
      </div>
    </Modal>
  );
}

// ===========================================================================
//  A CORRECTION IS A MOVEMENT, NOT AN OVERWRITE
// ===========================================================================

/**
 * The admin types WHAT THEY COUNTED, not a difference.
 *
 * «عندي ٩ على الرف» is the thing a person holding a clipboard actually knows;
 * «−١» is arithmetic they should not have to do, and getting its sign wrong
 * silently doubles the error. The difference is shown beside it so the
 * movement about to be recorded is visible before it is recorded.
 */
function AdjustDialog({
  s, line, onClose, onDone,
}: {
  s: InvStrings;
  line: InventoryLine;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { latin } = useLoc();
  const count = useCount();
  const [counted, setCounted] = useState<number | null>(null);
  const [reason, setReason] = useState<AdjustReason>('count');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const delta = counted === null ? 0 : counted - line.on_hand;

  const submit = async () => {
    if (delta === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createAdjustment({
        product_id: line.product_id ?? '',
        scope: line.scope,
        scope_id: line.scope_id,
        delta,
        reason,
        note: note.trim(),
      });
      onDone(s.common.saved);
    } catch (e) {
      setErr(errMsg(e, s.common.failed, s.common.failed, latin));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      titleAr={s.adjust.title}
      titleEn={s.adjust.title}
      onClose={onClose}
      dirty={counted !== null}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={T.btnGhost} onClick={onClose}>{s.common.cancel}</button>
          <button type="button" className={T.btnPrimary} disabled={delta === 0 || busy} onClick={submit}>
            {s.adjust.apply}
          </button>
        </div>
      }
    >
      <div className="grid gap-4 min-w-0">
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}
        <p className={`text-[12.5px] font-semibold ${T.text1}`}>{line.product_name ?? line.product_id}</p>

        <div className="grid grid-cols-2 gap-3">
          <div className={`${T.surface} p-3`}>
            <span className={`block text-[11.5px] font-semibold ${T.text3}`}>{s.adjust.current}</span>
            <span className={`mt-1 block text-[20px] font-bold tabular-nums ${T.text1}`}>{count(line.on_hand)}</span>
          </div>
          <div className={`${T.surface} p-3`}>
            <span className={`block text-[11.5px] font-semibold ${T.text3}`}>{s.adjust.delta}</span>
            <span
              className={`mt-1 block text-[20px] font-bold tabular-nums ${
                delta === 0 ? T.text3 : delta > 0 ? 'text-[var(--ap-success)]' : 'text-[var(--ap-danger)]'
              }`}
            >
              {delta === 0 ? s.common.none : `${delta > 0 ? '+' : '−'}${count(Math.abs(delta))}`}
            </span>
          </div>
        </div>

        <IqdField label={s.adjust.counted} value={counted} onChange={setCounted} required />

        <label className="flex flex-col gap-1.5 min-w-0">
          <span className={`text-[12px] font-semibold ${T.text2}`}>{s.adjust.reason}<span className="text-[var(--ap-danger)]"> *</span></span>
          <select className={T.select} value={reason} onChange={(e) => setReason(e.target.value as AdjustReason)}>
            {ADJUST_REASONS.map((r) => (
              <option key={r} value={r}>{s.adjust.reasons[r]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 min-w-0">
          <span className={`text-[12px] font-semibold ${T.text2}`}>{s.adjust.note}</span>
          <input className={T.input} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <p className={`text-[11.5px] leading-[1.6] ${T.text3}`}>{s.adjust.fifoNote}</p>
        <p className={`text-[11.5px] leading-[1.6] ${T.text3}`}>{s.adjust.neverNegative}</p>
      </div>
    </Modal>
  );
}
