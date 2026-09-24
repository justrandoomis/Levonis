/**
 * «تسجيل تحويل للتاجر» — a payout, asked in the panel's own sheet.
 *
 * It was two `window.prompt`s and an `alert`: no validation until the server
 * refused, the available balance only inside the prompt's text, and a refusal
 * shown as the server's raw English. The route (worker/routes/adminCommunity.ts,
 * behind the FINANCIAL admin scope) answers:
 *
 *   400 INSUFFICIENT_BALANCE    more than is available (`details.available_iqd`)
 *   409 IDEMPOTENCY_KEY_REUSED  the key belonged to a different payout
 *   404                         the merchant is gone
 *   replayed: true              this very payout was already recorded
 *
 * Each is said here in words, beside the field, and what was typed is kept.
 *
 * ONE KEY PER PAYOUT THE ADMIN MEANT. The idempotency key is minted when the
 * sheet opens and reused by every retry of that submission, so a double tap or
 * a retry after a timeout records one payout. A key the server says belonged to
 * another payout is replaced, and the admin confirms again.
 *
 * Recording a payout moves no money: it writes down a transfer the admin has
 * already made, so the sheet says so before the button.
 */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Sheet } from '../ui/Overlay';
import { ApiError, newIdempotencyKey } from '../../lib/api';
import { adminCommunityApi, iqd } from '../../lib/merchant';
import { apiRefusal } from '../../lib/refusalStrings';

type T = (ar: string, en: string) => string;

/**
 * «١٢٬٥٠٠» and «12,500» both mean 12500: digits of either script, thousands
 * separators dropped. A decimal point is NOT a separator — «12.5» is refused,
 * never read as 125 — because IQD is whole and a misread amount is money.
 */
export function parsePayoutAmount(raw: string): number | null {
  const ascii = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s,٬]/g, '');
  if (!/^\d{1,10}$/.test(ascii)) return null;
  const n = Number(ascii);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The route's refusals as the panel's own sentences — never its English text. */
export function payoutRefusal(e: unknown, t: T, lang: 'ar' | 'en'): string {
  if (!(e instanceof ApiError)) {
    return t('تعذّر تسجيل التحويل — تحقّق من الاتصال وحاول مجددًا.', 'Could not record the payout — check the connection and try again.');
  }
  switch (e.code) {
    case 'INSUFFICIENT_BALANCE': {
      const available = Number(e.details?.available_iqd);
      return Number.isFinite(available)
        ? t(`المبلغ أكبر من المتاح للتاجر الآن (${iqd(available)}).`, `That is more than the merchant has available now (${iqd(available)}).`)
        : t('المبلغ أكبر من المتاح للتاجر.', 'That is more than the merchant has available.');
    }
    case 'IDEMPOTENCY_KEY_REUSED':
      return t('هذا الطلب استُخدم لتحويل آخر — راجع المبلغ وأكّد من جديد.', 'That request belonged to a different payout — check the amount and confirm again.');
    case 'NOT_FOUND':
      return t('لم يعد هذا التاجر موجودًا.', 'This merchant no longer exists.');
    case 'FINANCIAL_SCOPE_REQUIRED':
      return t('تسجيل التحويلات للمالك أو الدور المالي فقط.', 'Only the owner or a financial admin can record payouts.');
    default:
      return apiRefusal(e, lang, t('تعذّر تسجيل التحويل — حاول مجددًا.', 'Could not record the payout — try again.'));
  }
}

export default function PayoutSheet({
  open,
  merchant,
  available,
  onClose,
  onRecorded,
  t,
}: {
  open: boolean;
  merchant: { id: string; name: string };
  available: number;
  onClose: () => void;
  /** After the route answered: `replayed` when this payout was already on the record. */
  onRecorded: (replayed: boolean) => void;
  t: T;
}) {
  // The panel's `t` answers its first argument in Arabic: that IS the language.
  const lang = t('ar', 'en') === 'ar' ? 'ar' : 'en';
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amountId = useId();
  const noteId = useId();
  const titleId = useId();

  // A new sheet is a new payout: empty fields, a fresh key.
  useEffect(() => {
    if (!open) return;
    setAmount('');
    setNote('');
    setError('');
    setBusy(false);
    setKey(newIdempotencyKey());
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = parsePayoutAmount(amount);
    if (value === null) {
      setError(t('اكتب المبلغ بالدينار — رقمًا صحيحًا أكبر من صفر.', 'Enter the amount in IQD — a whole number above zero.'));
      return;
    }
    if (value > available) {
      setError(t(`المبلغ أكبر من المتاح (${iqd(available)}).`, `That is more than is available (${iqd(available)}).`));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await adminCommunityApi.payout(merchant.id, value, note.trim(), key);
      onRecorded(r.replayed);
      onClose();
    } catch (err) {
      // A key the server tied to another payout is spent: the next confirm is a new one.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_REUSED') setKey(newIdempotencyKey());
      setError(payoutRefusal(err, t, lang));
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={() => !busy && onClose()} labelledBy={titleId} panelClassName="w-full sm:max-w-md">
      {open && (
        <form onSubmit={submit} className="px-5 pb-5 pt-2 space-y-3" data-payout-sheet noValidate>
          <h2 id={titleId} className="text-white font-bold text-[15px] leading-snug">
            {t(`تسجيل تحويل إلى ${merchant.name}`, `Record a payout to ${merchant.name}`)}
          </h2>
          <p className="text-zinc-400 text-[12.5px] leading-relaxed">
            {t(
              'سجّل التحويل بعد أن ترسل المال فعلًا. يُكتب حركةً سالبة في سجل التاجر وينقص المتاح بقدره.',
              'Record it after you have actually sent the money. It is written as a negative entry in the merchant’s ledger and lowers what is available by the same amount.'
            )}
          </p>
          <div>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <label htmlFor={amountId} className="text-zinc-300 text-[12px] font-semibold">
                {t('المبلغ (د.ع)', 'Amount (IQD)')}
              </label>
              <button
                type="button"
                onClick={() => {
                  setAmount(String(available));
                  if (error) setError('');
                }}
                disabled={busy || available <= 0}
                className="text-[11.5px] text-gold font-semibold disabled:opacity-40"
              >
                {t(`المتاح كاملًا: ${iqd(available)}`, `All available: ${iqd(available)}`)}
              </button>
            </div>
            <input
              id={amountId}
              name="amount"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                if (error) setError('');
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${amountId}-error` : undefined}
              className="lv-input text-[14px] tabular-nums"
            />
            {error && (
              <p id={`${amountId}-error`} role="alert" className="lv-field-error">
                {error}
              </p>
            )}
          </div>
          <div>
            <label htmlFor={noteId} className="block text-zinc-300 text-[12px] font-semibold mb-1.5">
              {t('ملاحظة — طريقة التحويل والمرجع (اختياري)', 'Note — method and reference (optional)')}
            </label>
            <input
              id={noteId}
              name="note"
              type="text"
              autoComplete="off"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="lv-input text-[13px]"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className="lv-button lv-button-ghost flex-1">
              {t('إلغاء', 'Cancel')}
            </button>
            <button type="submit" disabled={busy} aria-busy={busy} className="lv-button lv-button-primary flex-1">
              {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {t('سجّل التحويل', 'Record payout')}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
