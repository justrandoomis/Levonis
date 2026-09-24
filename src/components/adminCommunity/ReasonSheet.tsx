/**
 * «السبب» — the one question every sanction asks before it acts.
 *
 * The admin community panel asked for a suspension's reason with
 * `window.prompt`: unstyled, untranslated chrome, no validation until the
 * server refused, and on a phone a system dialog over the whole page. A
 * sanction nobody can explain later is one that gets reversed by whoever asks
 * loudest, so the reason stays REQUIRED — asked here, in the panel's own
 * sheet, with the consequence stated above the field and the error beside it.
 *
 * The sheet does not act on its own: `onConfirm` is the caller's request, and
 * a refusal it throws is shown here (the sheet stays open with the text kept),
 * so a typed reason is never lost to a failed request.
 */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Sheet } from '../ui/Overlay';

type T = (ar: string, en: string) => string;

export interface ReasonRequest {
  title: string;
  /** What will happen, in one sentence — the consequence, not the mechanism. */
  consequence: string;
  confirmLabel: string;
  /** A sanction is destructive; lifting one is not. */
  danger?: boolean;
  /** Minimum characters for the reason. 0 makes it optional (lifting). */
  minLength?: number;
  onConfirm: (reason: string) => Promise<void>;
}

export default function ReasonSheet({
  request,
  onClose,
  t,
}: {
  request: ReasonRequest | null;
  onClose: () => void;
  t: T;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldId = useId();
  const titleId = useId();
  const min = request?.minLength ?? 3;

  // A new question starts empty.
  useEffect(() => {
    setReason('');
    setError('');
    setBusy(false);
  }, [request]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!request || busy) return;
    if (reason.trim().length < min) {
      setError(t(`اكتب السبب (${min} أحرف على الأقل).`, `Write the reason (at least ${min} characters).`));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request.onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('تعذّر الحفظ — حاول مجددًا.', 'Could not save — try again.'));
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!request} onClose={() => !busy && onClose()} labelledBy={titleId} panelClassName="w-full sm:max-w-md">
      {request && (
        <form onSubmit={submit} className="px-5 pb-5 pt-2 space-y-3" data-reason-sheet>
          <h2 id={titleId} className="text-white font-bold text-[15px] leading-snug">
            {request.title}
          </h2>
          <p className="text-zinc-400 text-[12.5px] leading-relaxed">{request.consequence}</p>
          <div>
            <label htmlFor={fieldId} className="block text-zinc-300 text-[12px] font-semibold mb-1.5">
              {min > 0 ? t('السبب (مطلوب)', 'Reason (required)') : t('ملاحظة (اختياري)', 'Note (optional)')}
            </label>
            <textarea
              id={fieldId}
              name="reason"
              autoComplete="off"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError('');
              }}
              rows={3}
              maxLength={500}
              aria-invalid={!!error}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              className="lv-input min-h-[88px] py-2.5 resize-y text-[13px]"
            />
            {error && (
              <p id={`${fieldId}-error`} role="alert" className="lv-field-error">
                {error}
              </p>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className="lv-button lv-button-ghost flex-1">
              {t('إلغاء', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              aria-busy={busy}
              className={`lv-button flex-1 ${request.danger ? 'lv-button-danger' : 'lv-button-primary'}`}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {request.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
