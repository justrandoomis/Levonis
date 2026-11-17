import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { PROCUREMENT, api, operationErrorText, T } from './shared';

/** The statuses the server deletes permanently (worker/routes/adminProcurement.ts `POST /documents/:id/delete`). */
const DELETABLE = new Set(['cancelled', 'draft']);

/**
 * «حذف نهائي» — a cancelled purchase, or an unconfirmed draft, deleted for good
 * (owner request 2026-11-17). Two steps inline (no browser dialog): the button
 * opens a confirm row, the confirm sends `{ version }`. A refusal (something
 * real hangs on the purchase, or it changed meanwhile) is shown in the reader's
 * language by its code; nothing is deleted then.
 */
export default function PurchaseDeleteButton({
  purchase,
  onDeleted,
}: {
  purchase: { id: string; status: string; version: number; invoice_no?: string };
  onDeleted: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sending = useRef(false);
  if (!DELETABLE.has(purchase.status)) return null;
  const name = (purchase.invoice_no ?? '').trim();
  const remove = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await api.post(`${PROCUREMENT}/documents/${encodeURIComponent(purchase.id)}/delete`, { version: purchase.version });
      setConfirming(false);
      onDeleted();
    } catch (e) {
      setError(operationErrorText(e, lang));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-2">
      {!confirming ? (
        <button
          type="button"
          className={`${T.btnDanger} inline-flex items-center gap-1.5 self-start`}
          onClick={() => { setError(''); setConfirming(true); }}
        >
          <Trash2 size={14} aria-hidden="true" />
          {loc('حذف نهائي', 'Delete permanently', 'سڕینەوەی یەکجاری')}
        </button>
      ) : (
        <div role="group" aria-label={loc('تأكيد الحذف النهائي', 'Confirm permanent delete', 'پشتڕاستکردنەوەی سڕینەوەی یەکجاری')} className="lv-alert lv-alert-danger grid min-w-0 gap-2 text-sm text-text-primary">
          <p className="min-w-0 break-words">
            {name
              ? loc(`سيُحذف الشراء «${name}» وبنوده نهائيًا ولا يمكن استرجاعه.`, `The purchase “${name}” and its lines will be deleted permanently; this cannot be undone.`, `کڕینی «${name}» و بەندەکانی بە یەکجاری دەسڕدرێنەوە و ناگەڕێنرێنەوە.`)
              : loc('سيُحذف هذا الشراء وبنوده نهائيًا ولا يمكن استرجاعه.', 'This purchase and its lines will be deleted permanently; this cannot be undone.', 'ئەم کڕینە و بەندەکانی بە یەکجاری دەسڕدرێنەوە و ناگەڕێنرێنەوە.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={T.btnDanger} disabled={busy} aria-busy={busy} onClick={() => void remove()}>
              {busy ? loc('جارٍ الحذف…', 'Deleting…', 'سڕینەوە…') : loc('نعم، احذفه نهائيًا', 'Yes, delete permanently', 'بەڵێ، بە یەکجاری بیسڕەوە')}
            </button>
            <button type="button" className={T.btnSecondary} disabled={busy} onClick={() => { setConfirming(false); setError(''); }}>
              {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="lv-alert lv-alert-danger text-sm text-text-primary">
          {error}
        </p>
      )}
    </div>
  );
}
