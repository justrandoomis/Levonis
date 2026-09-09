/**
 * The one destructive verb on these screens, confirmed in a sheet rather
 * than a window.confirm: it can be dragged away, it arrives and leaves the
 * same way, and it says what the refund will be made of before asking.
 *
 * No success is claimed until the server returns the cancelled order.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { ApiOrder } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { asLang } from './format';
import { apiRefusal } from '../../lib/refusalStrings';

const STRINGS = {
  ar: {
    title: 'إلغاء الطلب؟',
    body: (id: string) => `سيُلغى الطلب ${id}. أي رصيد محفظة أو نقاط دُفعت ستُعاد إليك، وستُعاد الكمية المحجوزة إلى المخزون.`,
    confirm: 'إلغاء الطلب',
    cancelling: 'جارٍ الإلغاء…',
    keep: 'الإبقاء على الطلب',
    failed: 'تعذر إلغاء الطلب.',
  },
  en: {
    title: 'Cancel this order?',
    body: (id: string) => `Order ${id} will be cancelled. Any wallet balance or points you paid are refunded, and the reserved stock is released.`,
    confirm: 'Cancel order',
    cancelling: 'Cancelling…',
    keep: 'Keep order',
    failed: 'The order could not be cancelled.',
  },
  ckb: {
    title: 'داواکارییەکە هەڵبوەشێنرێتەوە؟',
    body: (id: string) => `داواکاری ${id} هەڵدەوەشێنرێتەوە. هەر باڵانسی جزدان یان خاڵێک کە دراوە دەگەڕێتەوە، و بڕی حیجزکراو دەگەڕێتەوە بۆ کۆگا.`,
    confirm: 'هەڵوەشاندنەوەی داواکاری',
    cancelling: 'هەڵوەشاندنەوە…',
    keep: 'هێشتنەوەی داواکاری',
    failed: 'داواکارییەکە هەڵنەوەشایەوە.',
  },
} as const;

export default function CancelOrderSheet({
  open,
  orderId,
  onClose,
  onCancelled,
}: {
  open: boolean;
  orderId: string | null;
  onClose: () => void;
  onCancelled: (order: ApiOrder) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setError('');
      setBusy(false);
    }
  }, [open, orderId]);

  const close = () => {
    if (!busy) onClose();
  };

  const confirm = async () => {
    if (!orderId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ order: ApiOrder }>(`/api/orders/${encodeURIComponent(orderId)}/cancel`);
      onCancelled(res.order);
    } catch (e) {
      // §15.3: the code is decoded into the customer's own language.
      // `MYSTERY_REVEALED_NO_CANCEL` used to arrive here as three languages
      // concatenated onto one line, whichever one the customer had chosen.
      setError(apiRefusal(e, asLang(lang), s.failed));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      label={s.title}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="w-full sm:max-w-md"
      testId="cancel-order"
    >
      <div className="px-5 pb-6 pt-2">
        <h2 className="text-white font-bold text-[16px]">{s.title}</h2>
        {orderId && <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">{s.body(orderId)}</p>}
        <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
          {error}
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="flex-1 min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
          >
            {s.keep}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            data-confirm-cancel
            className="flex-1 min-h-[44px] rounded-xl bg-[#ef233c] text-white text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
          >
            {busy && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
            {busy ? s.cancelling : s.confirm}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
