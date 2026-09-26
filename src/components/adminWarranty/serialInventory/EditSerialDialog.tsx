/**
 * Edit one inventory serial: its model, product/option, box SN, EAN and note.
 * The serial itself is the row's identity and is not editable — a wrong
 * serial is voided and the right one added, so the audit log keeps both.
 */
import { useId, useState } from 'react';
import * as T from '../../adminProducts/theme';
import { Overlay } from '../../ui/Overlay';
import FilingFields, { type FilingState } from './FilingFields';
import { inventoryApi, refusalText, type InventoryRow, type InventoryStrings } from './model';

export default function EditSerialDialog({
  t,
  row,
  onClose,
  onSaved,
}: {
  t: InventoryStrings;
  row: InventoryRow;
  onClose: () => void;
  onSaved: (row: InventoryRow | null) => void;
}) {
  const titleId = useId();
  const [filing, setFiling] = useState<FilingState>({
    product_id: row.product?.id ?? '',
    variant_id: row.variant_id ?? '',
    model_code: row.model_code,
    model_name: row.model_name,
    product_name: row.product?.name ?? '',
    serialized: null,
  });
  const [box, setBox] = useState(row.box_sn);
  const [ean, setEan] = useState(row.ean);
  const [note, setNote] = useState(row.note);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    filing.product_id !== (row.product?.id ?? '') ||
    filing.variant_id !== (row.variant_id ?? '') ||
    filing.model_code !== row.model_code ||
    filing.model_name !== row.model_name ||
    box !== row.box_sn ||
    ean !== row.ean ||
    note !== row.note;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await inventoryApi.patch(row.serial_norm, {
        model_code: filing.model_code,
        model_name: filing.model_name,
        box_sn: box,
        ean,
        note,
        product_id: filing.product_id || null,
        variant_id: filing.variant_id || null,
      });
      onSaved(res.row);
    } catch (e2) {
      setErr(refusalText(e2, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay open onClose={onClose} labelledBy={titleId} placement="bottom" panelClassName="w-full sm:max-w-2xl" dirty={dirty} testId="serial-edit">
      <form onSubmit={save} className={`${T.AP} p-4 sm:p-5 space-y-4 max-h-[85vh] overflow-y-auto`}>
        <div>
          <h2 id={titleId} className="text-[16px] font-bold text-[var(--ap-text-1)]">
            {t.editTitle}
          </h2>
          <p className="mt-0.5 font-mono text-[13px] text-[var(--ap-text-2)]" dir="ltr">
            {row.serial}
          </p>
        </div>
        <FilingFields t={t} value={filing} onChange={setFiling} disabled={busy} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.boxSn}</span>
            <input className={`${T.input} w-full font-mono`} dir="ltr" value={box} onChange={(e) => setBox(e.target.value)} placeholder={t.boxPh} maxLength={60} />
          </label>
          <label className="block min-w-0">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.ean}</span>
            <input className={`${T.input} w-full font-mono`} dir="ltr" inputMode="numeric" value={ean} onChange={(e) => setEan(e.target.value)} placeholder={t.eanPh} maxLength={14} />
          </label>
        </div>
        <label className="block">
          <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.note}</span>
          <input className={`${T.input} w-full`} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
        {err && (
          <p role="alert" className="text-[12.5px] text-[var(--ap-danger)]">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${T.btnSecondary} min-h-[44px]`} onClick={onClose}>
            {t.cancel}
          </button>
          <button type="submit" className={`${T.btnPrimary} min-h-[44px]`} disabled={busy || !dirty}>
            {busy ? t.committing : t.save}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
