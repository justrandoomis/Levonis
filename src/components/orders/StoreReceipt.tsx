/**
 * «استلمت طلبي» — THE CUSTOMER'S HALF OF A COMMUNITY-STORE ORDER'S COMPLETION.
 *
 * The owner's rule (docs/MERCHANT_PLATFORM.md §2, 2026-09-24): a store's own
 * «تم التسليم» never releases its money. The customer confirming receipt does
 * — or, if they do nothing and no complaint is open, three days after
 * delivery. So a delivered store order shows the customer both facts: the
 * button, and the date it happens on its own.
 *
 * The confirmation is irreversible — it pays the store — so it is asked in a
 * sheet that says so, and that points a customer with a problem at support
 * instead. No success is claimed until the server answers.
 *
 * Rendered only when the server sent a `receipt` (a community-store order);
 * a platform order has no such step.
 */
import { useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { api } from '../../lib/api';
import type { ApiOrder } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { apiRefusal } from '../../lib/refusalStrings';
import { formatDate } from './format';

// OWNER: Sorani to be written by hand — every string in this file is ar/en
// only; `loc` falls back to the Arabic for ckb.
export default function StoreReceipt({
  order,
  onConfirmed,
}: {
  order: ApiOrder;
  /** Called with the sentence the page announces once the server confirmed it. */
  onConfirmed: (notice: string) => void;
}) {
  const { lang, loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const receipt = order.receipt;
  if (!receipt || order.status !== 'delivered') return null;

  if (receipt.confirmed_at) {
    return (
      <p data-receipt-confirmed className="mt-3 flex items-center gap-2 text-[12px] text-zinc-400">
        <PackageCheck className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
        <span>
          {loc('أكّدتَ استلام هذا الطلب في', 'You confirmed receiving this order on')}{' '}
          <time dateTime={receipt.confirmed_at}>{formatDate(receipt.confirmed_at, lang)}</time>
        </span>
      </p>
    );
  }
  if (!receipt.can_confirm) return null;

  const close = () => {
    if (!busy) setOpen(false);
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/orders/${encodeURIComponent(order.id)}/confirm-receipt`);
      setOpen(false);
      onConfirmed(
        loc(
          'شكرًا — أكّدتَ استلام طلبك، وسيصل المبلغ إلى المتجر.',
          'Thank you — you confirmed receiving your order, and the store will be paid.'
        )
      );
    } catch (e) {
      setError(apiRefusal(e, lang, loc('تعذّر تأكيد الاستلام. حاول مرة أخرى.', 'Receipt could not be confirmed. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  const title = loc('تأكيد استلام الطلب', 'Confirm you received this order');

  return (
    <div data-receipt-confirm className="mt-3 rounded-xl border border-zinc-700/70 bg-zinc-800/40 px-3 py-3">
      <p className="text-[13px] font-bold text-white">{loc('هل وصلك طلبك؟', 'Did your order arrive?')}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-zinc-400">
        {loc('أكّد الاستلام ليصل المبلغ إلى المتجر.', 'Confirm receipt so the store gets paid.')}
        {receipt.auto_confirms_at && (
          <>
            {' '}
            {loc('إن لم تؤكّد ولم تفتح شكوى، يُعتبر مستلمًا تلقائيًا في', 'If you don’t and no complaint is open, it counts as received on')}{' '}
            <time dateTime={receipt.auto_confirms_at} className="text-zinc-300">
              {formatDate(receipt.auto_confirms_at, lang)}
            </time>
            .
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
        className="lv-button lv-button-primary mt-2.5 min-h-11 w-full text-[13px]"
      >
        <PackageCheck className="h-4 w-4" aria-hidden="true" />
        {loc('استلمت طلبي', 'I received my order')}
      </button>

      <Sheet
        open={open}
        onClose={close}
        label={title}
        dismissOnEscape={!busy}
        dismissOnScrim={!busy}
        panelClassName="w-full sm:max-w-md"
        testId="confirm-receipt"
      >
        <div className="px-5 pb-6 pt-2">
          <h2 className="text-white font-bold text-[16px]">{title}</h2>
          <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">
            {loc(
              'بعد التأكيد يُحوَّل المبلغ إلى المتجر ولا يمكن التراجع. إن كانت في الطلب مشكلة فتواصل مع الدعم بدل التأكيد.',
              'Once you confirm, the payment goes to the store and cannot be undone. If something is wrong with the order, contact support instead.'
            )}
          </p>
          <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
            {error}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="flex-1 min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50"
            >
              {loc('ليس الآن', 'Not now', 'ئێستا نا')}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              data-confirm-receipt
              className="flex-1 min-h-[44px] rounded-xl bg-olive text-snow text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {busy && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
              {busy ? loc('جارٍ التأكيد…', 'Confirming…') : loc('نعم، استلمته', 'Yes, I received it')}
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
