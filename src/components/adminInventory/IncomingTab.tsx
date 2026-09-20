/**
 * «المشتريات القادمة» — a purchase, and the moment it becomes stock.
 *
 * ###########################################################################
 * #  RECEIVING IS THE ONE BUTTON ON THIS SCREEN A DOUBLE TAP COULD MAKE     #
 * #  EXPENSIVE, AND THE BROWSER IS NOT WHAT STOPS IT.                       #
 * ###########################################################################
 *
 * `receiptId` is minted HERE, once, when the confirm dialog opens — not on the
 * server and not per request. Every attempt for that one press carries the
 * same id, so a retry of a request whose response was lost is recognisable as
 * the same operation and the database's UNIQUE index refuses it. A
 * server-minted id would be different every time, which is precisely how one
 * press becomes two receipts and ten units become twenty.
 *
 * The disabled button is a courtesy on top of that, never the guard.
 *
 * ---------------------------------------------------------------------------
 * THE CONFIRMATION SHEET IS THE SERVER'S ARITHMETIC, NOT OURS.
 *
 * `fetchReceivePreview` returns the exact figures the commit will use. This
 * component renders them and does not compute a single one — a dialog that
 * does its own sums is a dialog that can disagree with the thing it is
 * confirming, and the number the admin approved would not be the number that
 * was written.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, PackagePlus, Plus, RefreshCw, TrendingUp, Truck } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { Modal } from '../adminProducts/ui';
import {
  createIncoming,
  fetchIncoming,
  fetchProfitPreview,
  fetchReceivePreview,
  fetchSuppliers,
  receiveIncoming,
  type IncomingPurchase,
  type IncomingStatus,
  type InventoryScope,
  type InventorySupplier,
  type ProfitPreview,
  type ReceivePreview,
} from '../../lib/api';
import { Empty, IqdField, Loading, Money, Notice, TableFrame, errMsg, useCount, useLoc, type NoticeState } from './shared';
import type { InvStrings } from './strings';

const STATUS_SKIN: Record<IncomingStatus, string> = {
  draft: T.badge.hidden,
  incoming: T.badge.draft,
  partial: T.badge.draft,
  received: T.badge.active,
  cancelled: T.badge.hidden,
};

export function IncomingTab({ s, onChanged }: { s: InvStrings; onChanged: () => void }) {
  const { latin } = useLoc();
  const count = useCount();
  const [rows, setRows] = useState<IncomingPurchase[] | null>(null);
  const [filter, setFilter] = useState<IncomingStatus | ''>('');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<IncomingPurchase | null>(null);
  const [profitFor, setProfitFor] = useState<IncomingPurchase | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const r = await fetchIncoming(filter ? { status: filter } : {});
      setRows(r.incoming);
    } catch (e) {
      setRows([]);
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [filter, s, latin]);

  useEffect(() => { load(); }, [load]);

  const showsCosts = rows !== null && rows.length > 0 && 'purchase_unit_iqd' in rows[0];

  return (
    <div className="min-w-0">
      <Notice state={notice} onClose={() => setNotice(null)} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => setCreating(true)}>
          <Plus size={15} /> {s.incoming.newPurchase}
        </button>
        <select
          className={`${T.selectSm} px-3`}
          value={filter}
          onChange={(e) => setFilter(e.target.value as IncomingStatus | '')}
          aria-label={s.incoming.status}
        >
          <option value="">{s.common.all}</option>
          {(['draft', 'incoming', 'partial', 'received', 'cancelled'] as const).map((k) => (
            <option key={k} value={k}>{s.incoming.statuses[k]}</option>
          ))}
        </select>
        <button type="button" className={T.btnSecondary} onClick={load}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      {rows === null ? (
        <Loading text={s.common.loading} />
      ) : rows.length === 0 ? (
        <Empty text={s.incoming.empty} />
      ) : (
        <TableFrame minWidth={showsCosts ? 1000 : 760}>
          <thead className={T.tableHead}>
            <tr>
              <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.product}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.status}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.qty}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.outstanding}</th>
              {showsCosts && <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.unitPrice}</th>}
              {showsCosts && <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.total}</th>}
              <th className="px-3 py-2.5 text-start font-semibold">{s.incoming.expected}</th>
              <th className="px-3 py-2.5 text-end font-semibold" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`${T.tableRow} border-b border-[var(--ap-border)] last:border-0`}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {r.product_image ? (
                      <img src={r.product_image} alt="" className={T.thumb} loading="lazy" />
                    ) : (
                      <span className={`flex h-9 w-9 items-center justify-center rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] ${T.text3}`}>
                        <Truck size={15} />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className={`block truncate font-semibold ${T.text1}`}>{r.product_name ?? r.product_id}</span>
                      {r.supplier_name && <span className={`block truncate text-[11px] ${T.text3}`}>{r.supplier_name}</span>}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`${T.badgeBase} ${STATUS_SKIN[r.status]}`}>{s.incoming.statuses[r.status]}</span>
                </td>
                <td className={`px-3 py-2.5 tabular-nums ${T.text1}`}>{count(r.qty_ordered)}</td>
                <td className={`px-3 py-2.5 font-bold tabular-nums ${r.qty_outstanding > 0 ? T.text1 : T.text3}`}>
                  {count(r.qty_outstanding)}
                </td>
                {showsCosts && (
                  <td className="px-3 py-2.5"><Money value={r.purchase_unit_iqd} unknownLabel={s.stock.unknown} /></td>
                )}
                {showsCosts && (
                  <td className="px-3 py-2.5"><Money value={r.purchase_total_iqd} unknownLabel={s.stock.unknown} /></td>
                )}
                <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{r.expected_at ?? s.common.none}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {showsCosts && (
                      <button type="button" className={T.btnIcon} title={s.incoming.profitPreview} onClick={() => setProfitFor(r)}>
                        <TrendingUp size={14} />
                      </button>
                    )}
                    {r.qty_outstanding > 0 && r.status !== 'cancelled' && (
                      <button type="button" className={T.btnPrimary} onClick={() => setReceiving(r)}>
                        <PackagePlus size={14} /> {s.incoming.receive}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}

      {creating && (
        <PurchaseDialog
          s={s}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); setNotice({ tone: 'success', text: s.common.saved }); load(); }}
        />
      )}
      {receiving && (
        <ReceiveDialog
          s={s}
          row={receiving}
          onClose={() => setReceiving(null)}
          onDone={(text) => { setReceiving(null); setNotice({ tone: 'success', text }); load(); onChanged(); }}
        />
      )}
      {profitFor && <ProfitDialog s={s} row={profitFor} onClose={() => setProfitFor(null)} />}
    </div>
  );
}

// ===========================================================================
//  RECORDING A PURCHASE
// ===========================================================================

function PurchaseDialog({ s, onClose, onDone }: { s: InvStrings; onClose: () => void; onDone: () => void }) {
  const { latin } = useLoc();
  const [productId, setProductId] = useState('');
  const [scope, setScope] = useState<InventoryScope>('base');
  const [scopeId, setScopeId] = useState('');
  const [qty, setQty] = useState<number | null>(null);
  const [unit, setUnit] = useState<number | null>(null);
  const [shipping, setShipping] = useState<number | null>(null);
  const [internal, setInternal] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [expected, setExpected] = useState('');
  const [tracking, setTracking] = useState('');
  const [notes, setNotes] = useState('');
  const [suppliers, setSuppliers] = useState<InventorySupplier[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchSuppliers().then((r) => setSuppliers(r.suppliers)).catch(() => setSuppliers([]));
  }, []);

  const ready = productId.trim() !== '' && qty !== null && qty > 0 && unit !== null;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createIncoming({
        product_id: productId.trim(),
        scope,
        scope_id: scope === 'base' ? '' : scopeId.trim(),
        qty_ordered: qty,
        purchase_unit_iqd: unit,
        // `null` is sent through as null, NOT dropped: the server distinguishes
        // "left blank" from "stated as zero" and receiving is refused on the
        // first and allowed on the second.
        shipping_total_iqd: shipping,
        internal_delivery_total_iqd: internal,
        supplier_id: supplierId || null,
        supplier_ref: supplierRef.trim(),
        purchase_date: purchaseDate || null,
        expected_at: expected || null,
        tracking: tracking.trim(),
        notes: notes.trim(),
        status: 'incoming',
      });
      onDone();
    } catch (e) {
      setErr(errMsg(e, s.common.failed, s.common.failed, latin));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      titleAr={s.incoming.newPurchase}
      titleEn={s.incoming.newPurchase}
      onClose={onClose}
      wide
      dirty={productId !== '' || qty !== null}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={T.btnGhost} onClick={onClose}>{s.common.cancel}</button>
          <button type="button" className={T.btnPrimary} disabled={!ready || busy} onClick={submit}>{s.common.save}</button>
        </div>
      }
    >
      <div className="grid gap-4 min-w-0">
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.product}<span className="text-[var(--ap-danger)]"> *</span></span>
            <input className={T.input} value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="product id" />
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>scope</span>
            <select className={T.select} value={scope} onChange={(e) => setScope(e.target.value as InventoryScope)}>
              {(['base', 'option', 'color', 'variant'] as const).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>

        {scope !== 'base' && (
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>scope id<span className="text-[var(--ap-danger)]"> *</span></span>
            <input className={T.input} value={scopeId} onChange={(e) => setScopeId(e.target.value)} />
          </label>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <IqdField label={s.incoming.qty} value={qty} onChange={setQty} required />
          <IqdField label={s.incoming.unitPrice} value={unit} onChange={setUnit} required />
        </div>

        <div className={`${T.surface} p-3`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <IqdField label={s.incoming.shipping} value={shipping} onChange={setShipping} />
            <IqdField label={s.incoming.internal} value={internal} onChange={setInternal} />
          </div>
          <p className={`mt-2.5 text-[11.5px] leading-[1.6] ${T.text3}`}>{s.incoming.zeroIsValid}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.supplier}</span>
            <select className={T.select} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{s.common.none}</option>
              {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.supplierRef}</span>
            <input className={T.input} value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.purchaseDate}</span>
            <input type="date" className={T.input} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.expected}</span>
            <input type="date" className={T.input} value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.tracking}</span>
            <input className={T.input} value={tracking} onChange={(e) => setTracking(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className={`text-[12px] font-semibold ${T.text2}`}>{s.incoming.notes}</span>
            <input className={T.input} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
    </Modal>
  );
}

// ===========================================================================
//  RECEIVING — the confirmation sheet, and the id that makes it safe to retry
// ===========================================================================

function ReceiveDialog({
  s, row, onClose, onDone,
}: {
  s: InvStrings;
  row: IncomingPurchase;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { latin } = useLoc();
  const count = useCount();
  const [qty, setQty] = useState<number | null>(row.qty_outstanding);
  const [preview, setPreview] = useState<ReceivePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * ONE ID FOR THIS PRESS OF THE BUTTON, minted when the dialog opens and kept
   * across every retry inside it. See the module header.
   */
  const [receiptId] = useState(
    () => `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  );

  useEffect(() => {
    if (qty === null || qty <= 0) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetchReceivePreview(row.id, qty)
        .then((p) => { if (live) setPreview(p); })
        .catch(() => { if (live) setPreview(null); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [row.id, qty]);

  const submit = async () => {
    if (qty === null || qty <= 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await receiveIncoming(row.id, receiptId, qty);
      onDone(r.already ? (r.message ?? s.common.saved) : s.common.saved);
    } catch (e) {
      setErr(errMsg(e, s.common.failed, s.common.failed, latin));
    } finally {
      setBusy(false);
    }
  };

  const cost = preview?.ok ? preview.cost : undefined;
  const blocked = preview !== null && !preview.ok;

  return (
    <Modal
      titleAr={s.incoming.receiveTitle}
      titleEn={s.incoming.receiveTitle}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={T.btnGhost} onClick={onClose}>{s.common.cancel}</button>
          <button type="button" className={T.btnPrimary} disabled={busy || blocked || qty === null || qty <= 0} onClick={submit}>
            <CheckCircle2 size={15} /> {s.incoming.confirmReceive}
          </button>
        </div>
      }
    >
      <div className="grid gap-4 min-w-0">
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}
        <p className={`text-[12.5px] font-semibold ${T.text1}`}>{row.product_name ?? row.product_id}</p>

        <IqdField
          label={s.incoming.receiveQty}
          hint={`${s.incoming.outstanding}: ${count(row.qty_outstanding)}`}
          value={qty}
          onChange={setQty}
          required
        />

        {/* THE SERVER'S REFUSAL, IN ITS OWN WORDS. It says what to enter next;
            a generic failure would say nothing. */}
        {blocked && preview?.message && (
          <Notice state={{ tone: 'error', text: preview.message }} onClose={() => undefined} />
        )}

        {cost && (
          <div className={`${T.surface} p-3.5`}>
            <dl className="grid gap-2 text-[12.5px]">
              <Row label={s.receipt.purchaseShare} value={<Money value={cost.purchaseUnitIqd} unknownLabel={s.stock.unknown} />} />
              <Row label={s.receipt.freightShare} value={<Money value={cost.shippingShareIqd} unknownLabel={s.stock.unknown} />} />
              <Row label={s.receipt.deliveryShare} value={<Money value={cost.internalShareIqd} unknownLabel={s.stock.unknown} />} />
              <div className="my-1 h-px bg-[var(--ap-border)]" />
              <Row
                label={s.receipt.unitCost}
                strong
                value={<Money value={cost.unitCostIqd} unknownLabel={s.stock.unknown} />}
              />
              <Row label={s.receipt.totalCost} value={<Money value={cost.totalCostIqd} unknownLabel={s.stock.unknown} />} />
            </dl>
            <p className={`mt-3 text-[11.5px] leading-[1.6] ${T.text3}`}>{s.receipt.spreadNote}</p>
          </div>
        )}

        {row.qty_received > 0 && (
          <p className={`text-[11.5px] leading-[1.6] ${T.text3}`}>{s.incoming.costsFrozen}</p>
        )}
        <p className={`text-[11.5px] leading-[1.6] ${T.text3}`}>{s.receipt.irreversible}</p>
      </div>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={`${strong ? `font-semibold ${T.text1}` : T.text2}`}>{label}</dt>
      <dd className={`tabular-nums ${strong ? `text-[15px] font-bold ${T.text1}` : T.text1}`}>{value}</dd>
    </div>
  );
}

// ===========================================================================
//  WHAT THIS BATCH WOULD EARN — a preview, and it changes no price (§49)
// ===========================================================================

function ProfitDialog({ s, row, onClose }: { s: InvStrings; row: IncomingPurchase; onClose: () => void }) {
  const { latin } = useLoc();
  const [p, setP] = useState<ProfitPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchProfitPreview(row.id)
      .then(setP)
      .catch((e) => setErr(errMsg(e, s.common.failed, s.common.failed, latin)));
  }, [row.id, s, latin]);

  return (
    <Modal titleAr={s.incoming.profitPreview} titleEn={s.incoming.profitPreview} onClose={onClose}>
      <div className="grid gap-4 min-w-0">
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}
        <p className={`text-[12.5px] font-semibold ${T.text1}`}>{row.product_name ?? row.product_id}</p>
        {p === null ? (
          <Loading text={s.common.loading} />
        ) : !p.ready ? (
          // Not an error: a cost component or a selling price is simply not
          // stated yet, and saying "we cannot compute this" is the honest
          // answer rather than a zero margin.
          <Notice state={{ tone: 'info', text: s.incoming.zeroIsValid }} onClose={() => undefined} />
        ) : (
          <div className={`${T.surface} p-3.5`}>
            <dl className="grid gap-2 text-[12.5px]">
              <Row label={s.receipt.unitCost} value={<Money value={p.cost.unitCostIqd} unknownLabel={s.stock.unknown} />} />
              <Row label={s.incoming.sellingPrice} value={<Money value={p.selling_price_iqd} unknownLabel={s.stock.unknown} />} />
              <div className="my-1 h-px bg-[var(--ap-border)]" />
              <Row label={s.incoming.perUnitProfit} strong value={<Money value={p.gross_profit_iqd} unknownLabel={s.stock.unknown} />} />
              <Row label={s.incoming.margin} value={<span className="tabular-nums">{p.margin_percent}%</span>} />
              <Row label={s.incoming.wholeBatch} value={<Money value={p.total_gross_profit_iqd} unknownLabel={s.stock.unknown} />} />
            </dl>
          </div>
        )}
        <p className={`text-[11.5px] leading-[1.6] ${T.text3}`}>{s.incoming.previewOnly}</p>
      </div>
    </Modal>
  );
}
