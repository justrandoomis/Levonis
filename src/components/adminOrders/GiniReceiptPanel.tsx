/**
 * «تاكيد مسح باركود الاستلام» — the one thing that lets an admin prepare a
 * Gini order.
 *
 * WHY THIS PANEL HAS TO EXIST AT ALL. Gini's purchase closes inside the bank's
 * app when the customer's receipt barcode is scanned, and that scan is what
 * tells Qi Card the goods were handed over. The server therefore REFUSES to
 * move an unscanned Gini order across the stock boundary — both admin doors
 * answer GINI_RECEIPT_REQUIRED (worker/routes/admin.ts). Without a place to
 * record the scan, every Gini order met that refusal, sat untouchable for
 * twenty-four hours and was then cancelled by `giniSweep` with its stock
 * released: the whole feature ending in an automatic refusal nobody could
 * satisfy.
 *
 * IT SITS ABOVE THE STAGE PANEL, not inside it. The stages panel holds no
 * opinion about payment — it renders whatever moves the server says are legal
 * — and a Gini order's blocker is not a stage fact. Putting the two in one
 * column, in the order they have to happen, is what makes the refusal legible:
 * the admin reads "scan first", scans, and the buttons below start working.
 *
 * THE BARCODE IS TYPED OR SCANNED INTO THE SAME FIELD. A handheld scanner is a
 * keyboard: it types the code and presses Enter, which is why this is a real
 * `<form>` with a submit rather than a button an admin has to reach for with
 * the scanner still in their hand. Nothing here parses the code — the server
 * stores whatever Gini printed, because refusing an unfamiliar shape would
 * block a real handover over a format the bank is free to change.
 */
import { useState } from 'react';
import { Landmark, Loader2, ScanLine, ShieldCheck, TimerOff } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, type ApiOrder } from '../../lib/api';

type GiniBlock = NonNullable<ApiOrder['gini']>;

function when(iso: string | null, ar: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(ar ? 'ar-IQ' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function GiniReceiptPanel({
  orderId,
  gini,
  dir,
  onScanned,
}: {
  orderId: string;
  gini: GiniBlock;
  dir: 'rtl' | 'ltr';
  onScanned: () => void | Promise<void>;
}) {
  const { loc } = useLanguage();
  const ar = dir === 'rtl';
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = barcode.trim();
    if (busy || code === '') return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/admin/orders/${orderId}/gini-receipt`, { barcode: code });
      setBarcode('');
      await onScanned();
    } catch (err) {
      // The server's own refusal — already scanned, hold expired, not a Gini
      // order. Each one tells the admin something different about the parcel
      // in front of them, so none of them becomes a generic "failed".
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '');
    } finally {
      setBusy(false);
    }
  };

  const orderNo = (
    <span dir="ltr" className="font-mono text-zinc-100">
      {gini.order_no || '—'}
    </span>
  );

  if (gini.state === 'received') {
    return (
      <section data-gini-receipt="received" className="rounded-xl border border-emerald-500/40 bg-emerald-500/[0.06] p-3">
        <p className="flex items-center gap-2 text-[13px] font-bold text-emerald-300">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          {loc('تم مسح باركود الاستلام — يمكن تجهيز الطلب', 'Receipt barcode scanned — the order can be prepared', 'باڕکۆدی وەرگرتن سکان کرا — دەتوانرێت ئامادە بکرێت')}
        </p>
        <p className="mt-1 text-[11.5px] text-zinc-400">
          {loc('رقم الطلب في جني', 'Gini order number', 'ژمارەی داواکاری لە جینی')}: {orderNo}
          {gini.received_at ? ` · ${when(gini.received_at, ar)}` : ''}
        </p>
      </section>
    );
  }

  if (gini.state === 'expired') {
    return (
      <section data-gini-receipt="expired" className="rounded-xl border border-zinc-700 bg-zinc-900/40 p-3">
        <p className="flex items-center gap-2 text-[13px] font-bold text-zinc-300">
          <TimerOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {loc('انتهت مهلة هذا الطلب قبل مسح الباركود', 'The hold expired before the barcode was scanned', 'ماوەکە بەسەرچوو پێش سکانی باڕکۆد')}
        </p>
        {/* The stock went back on the shelf and may since have been sold, so
            the honest instruction is a NEW order — never a revived one. */}
        <p className="mt-1 text-[11.5px] text-zinc-400">
          {loc(
            'أُلغي الطلب وأُعيد المخزون. يحتاج الزبون إلى إنشاء طلب جديد في تطبيق جني.',
            'The order was cancelled and its stock released. The customer needs to place a new order in the Gini app.',
            'داواکارییەکە هەڵوەشێندرایەوە و کۆگاکە گەڕایەوە. پێویستە کڕیار داواکارییەکی نوێ لە ئەپی جینی بکات.'
          )}
        </p>
      </section>
    );
  }

  // 'awaiting_receipt' — the only state with anything for staff to do.
  return (
    <section data-gini-receipt="awaiting" className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-3">
      <p className="flex items-center gap-2 text-[13px] font-bold text-amber-200">
        <Landmark className="h-4 w-4 shrink-0" aria-hidden="true" />
        {loc('طلب أقساط عبر تطبيق جني', 'Instalments order via the Gini app', 'داواکاری قیست لە ئەپی جینی')}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-300">
        {loc(
          'لا يمكن تأكيد هذا الطلب أو تجهيزه قبل مسح باركود الاستلام — مسح الباركود هو ما يُعلم منصة جني بأن الزبون استلم المنتج.',
          'This order cannot be confirmed or prepared before the receipt barcode is scanned — the scan is what tells Gini the customer received the goods.',
          'ناتوانرێت ئەم داواکارییە پەسەند یان ئامادە بکرێت پێش سکانی باڕکۆدی وەرگرتن — سکانەکە ئەوەیە کە بە جینی دەڵێت کڕیار بەرهەمەکەی وەرگرتووە.'
        )}
      </p>
      <p className="mt-1.5 text-[11.5px] text-zinc-400">
        {loc('رقم الطلب في جني', 'Gini order number', 'ژمارەی داواکاری لە جینی')}: {orderNo}
        {gini.hold_until
          ? ` · ${loc('تنتهي المهلة', 'Hold expires', 'ماوەکە کۆتایی دێت')} ${when(gini.hold_until, ar)}`
          : ''}
      </p>

      {error && (
        <p role="alert" className="mt-2 rounded-lg border border-[#B03142]/40 bg-[#B03142]/10 p-2 text-[11.5px] text-[#e4899a]">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-2.5 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="gini-barcode">
          {loc('باركود الاستلام', 'Receipt barcode', 'باڕکۆدی وەرگرتن')}
        </label>
        <input
          id="gini-barcode"
          dir="ltr"
          autoComplete="off"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder={loc('امسح الباركود أو اكتبه', 'Scan or type the barcode', 'باڕکۆد سکان بکە یان بینووسە')}
          data-gini-barcode
          className="min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 font-mono text-[13px] text-white focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || barcode.trim() === ''}
          data-gini-scan
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3.5 text-[13px] font-bold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ScanLine className="h-3.5 w-3.5" aria-hidden="true" />}
          {loc('تأكيد الاستلام في جني', 'Confirm receipt in Gini', 'پەسەندکردنی وەرگرتن لە جینی')}
        </button>
      </form>
    </section>
  );
}
