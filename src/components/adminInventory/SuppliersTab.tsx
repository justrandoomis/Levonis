/**
 * «الموردون» — a name, so the owner remembers who they bought from.
 *
 * DELIBERATELY THIN. This is not a procurement module and it is not a CRM:
 * §42 asks for a supplier to attach to a purchase, and anything more would be
 * a second address book for the shop to keep in step with the first. A name, a
 * way to reach them, a note.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Store } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { Modal } from '../adminProducts/ui';
import { createSupplier, fetchSuppliers, type InventorySupplier } from '../../lib/api';
import { Empty, Loading, Notice, TableFrame, errMsg, useLoc, type NoticeState } from './shared';
import type { InvStrings } from './strings';

export function SuppliersTab({ s }: { s: InvStrings }) {
  const { latin } = useLoc();
  const [rows, setRows] = useState<InventorySupplier[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const r = await fetchSuppliers();
      setRows(r.suppliers);
    } catch (e) {
      setRows([]);
      setNotice({ tone: 'error', text: errMsg(e, s.common.failed, s.common.failed, latin) });
    }
  }, [s, latin]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-w-0">
      <Notice state={notice} onClose={() => setNotice(null)} />
      <p className={`mb-4 text-[12.5px] leading-[1.7] ${T.text2}`}>{s.suppliers.optional}</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => setAdding(true)}>
          <Plus size={15} /> {s.suppliers.add}
        </button>
        <button type="button" className={T.btnSecondary} onClick={load}>
          <RefreshCw size={14} /> {s.common.refresh}
        </button>
      </div>

      {rows === null ? (
        <Loading text={s.common.loading} />
      ) : rows.length === 0 ? (
        <Empty text={s.suppliers.empty} />
      ) : (
        <TableFrame minWidth={520}>
          <thead className={T.tableHead}>
            <tr>
              <th className="px-3 py-2.5 text-start font-semibold">{s.suppliers.name}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.suppliers.contact}</th>
              <th className="px-3 py-2.5 text-start font-semibold">{s.suppliers.notes}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id} className={`${T.tableRow} border-b border-[var(--ap-border)] last:border-0`}>
                <td className={`px-3 py-2.5 font-semibold ${T.text1}`}>
                  <span className="flex items-center gap-2 min-w-0">
                    <Store size={14} className={T.text3} aria-hidden />
                    <span className="truncate">{x.name}</span>
                  </span>
                </td>
                <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{x.contact || s.common.none}</td>
                <td className={`px-3 py-2.5 text-[12px] ${T.text2}`}>{x.notes || s.common.none}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}

      {adding && (
        <SupplierDialog
          s={s}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); setNotice({ tone: 'success', text: s.common.saved }); load(); }}
        />
      )}
    </div>
  );
}

function SupplierDialog({ s, onClose, onDone }: { s: InvStrings; onClose: () => void; onDone: () => void }) {
  const { latin } = useLoc();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createSupplier({ name: name.trim(), contact: contact.trim(), notes: notes.trim() });
      onDone();
    } catch (e) {
      setErr(errMsg(e, s.common.failed, s.common.failed, latin));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      titleAr={s.suppliers.add}
      titleEn={s.suppliers.add}
      onClose={onClose}
      dirty={name !== ''}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={T.btnGhost} onClick={onClose}>{s.common.cancel}</button>
          <button type="button" className={T.btnPrimary} disabled={!name.trim() || busy} onClick={submit}>{s.common.save}</button>
        </div>
      }
    >
      <div className="grid gap-4 min-w-0">
        {err && <Notice state={{ tone: 'error', text: err }} onClose={() => setErr(null)} />}
        <label className="flex flex-col gap-1.5 min-w-0">
          <span className={`text-[12px] font-semibold ${T.text2}`}>{s.suppliers.name}<span className="text-[var(--ap-danger)]"> *</span></span>
          <input className={T.input} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 min-w-0">
          <span className={`text-[12px] font-semibold ${T.text2}`}>{s.suppliers.contact}</span>
          <input className={T.input} maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 min-w-0">
          <span className={`text-[12px] font-semibold ${T.text2}`}>{s.suppliers.notes}</span>
          <input className={T.input} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
