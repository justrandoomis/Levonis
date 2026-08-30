/**
 * Where the customer's order is, on the path it actually walks.
 *
 * WHY IT FETCHES ITS OWN DATA. The order list already does the slowest query
 * on the account screen; adding fourteen history rows to every order in it,
 * so that one expanded card can show a tracker, would make every OTHER card
 * slower. This asks for one order's path, once, when the customer opens it.
 *
 * WHY THE LABELS COME FROM THE SERVER. Stage five of a pre-order names the
 * freight mode — "جارٍ التجهيز للشحن البحري" — so building it in the browser
 * would mean the browser holding its own copy of the path and the wording.
 * Two copies of that drift, and the drift shows up as a customer being told
 * one thing on the page and another in a notification.
 *
 * WHAT IT WILL NOT DO: invent a date. `next_stage_at` is non-null only when
 * the clock owns the next move; a stage waiting on an admin or on the
 * courier carries none, and the tracker shows no estimate rather than a
 * comforting guess.
 */
import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, Truck } from 'lucide-react';
import { api } from '../lib/api';

interface Step {
  stage: string;
  label: string;
  reached: boolean;
  current: boolean;
  at: string | null;
}

interface Tracking {
  order_id: string;
  shipping_type: string;
  shipping_type_label: string;
  stage: string;
  stage_changed_at: string;
  next_stage_at: string | null;
  tracking_no: string | null;
  steps: Step[];
}

const STRINGS = {
  ar: { loading: 'جارٍ تحميل التتبع…', failed: 'تعذّر تحميل حالة الشحن.', tracking: 'رقم التتبع', expected: 'المتوقع', title: 'تتبع الشحنة' },
  en: { loading: 'Loading tracking…', failed: 'Shipping status could not be loaded.', tracking: 'Tracking number', expected: 'Expected', title: 'Shipment tracking' },
  ckb: { loading: 'بارکردنی بەدواداچوون…', failed: 'دۆخی گەیاندن بار نەکرا.', tracking: 'ژمارەی بەدواداچوون', expected: 'چاوەڕوانکراو', title: 'بەدواداچوونی بار' },
} as const;

function when(iso: string | null, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'ar' ? 'ar-IQ' : lang === 'ckb' ? 'ar-IQ' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function OrderTracker({ orderId, lang }: { orderId: string; lang: string }) {
  const s = STRINGS[(lang as keyof typeof STRINGS) in STRINGS ? (lang as keyof typeof STRINGS) : 'ar'];
  const [data, setData] = useState<Tracking | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    api
      .get<Tracking>(`/api/orders/${orderId}/tracking?lang=${encodeURIComponent(lang)}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [orderId, lang]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-xs py-4">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> {s.loading}
      </div>
    );
  }
  // A failed fetch says so. It does NOT fall back to rendering the six-value
  // legacy status as if it were the tracker: half a truth about where a
  // parcel is is worse than saying we could not check.
  if (failed || !data) {
    return <p className="text-zinc-500 text-xs py-3">{s.failed}</p>;
  }

  return (
    <div data-order-tracker className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h4 className="text-white text-[13px] font-bold flex items-center gap-1.5">
          <Truck className="w-4 h-4 text-zinc-400" aria-hidden />
          {s.title}
        </h4>
        <span className="text-zinc-400 text-[11px]">{data.shipping_type_label}</span>
      </div>

      <ol className="space-y-0">
        {data.steps.map((step, i) => {
          const last = i === data.steps.length - 1;
          return (
            <li key={step.stage} className="flex gap-3" data-stage={step.stage} data-reached={step.reached ? '1' : '0'}>
              <div className="flex flex-col items-center shrink-0">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center border ${
                    step.current
                      ? 'bg-[#BAA369] border-[#BAA369] text-black'
                      : step.reached
                        ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-400'
                        : 'bg-transparent border-zinc-700 text-zinc-700'
                  }`}
                >
                  {step.reached ? <Check className="w-3 h-3" aria-hidden /> : <Circle className="w-2 h-2" aria-hidden />}
                </span>
                {/* The rail stops at the last dot instead of hanging below it. */}
                {!last && <span className={`w-px flex-1 min-h-[18px] ${step.reached ? 'bg-emerald-500/40' : 'bg-zinc-800'}`} />}
              </div>
              <div className={`pb-3 min-w-0 ${last ? 'pb-0' : ''}`}>
                <p className={`text-[13px] leading-tight ${step.current ? 'text-white font-bold' : step.reached ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {step.label}
                </p>
                {step.at && <p className="text-zinc-500 text-[10.5px] mt-0.5">{when(step.at, lang)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {data.tracking_no && (
        <p className="text-zinc-400 text-[11px] mt-2 pt-2 border-t border-zinc-800">
          {s.tracking}: <span dir="ltr" className="text-zinc-200 font-mono">{data.tracking_no}</span>
        </p>
      )}
      {/* Only ever shown when the SERVER scheduled it — a stage waiting on a
          person or on the courier carries no time, and none is invented. */}
      {data.next_stage_at && (
        <p className="text-zinc-500 text-[10.5px] mt-1">
          {s.expected}: {when(data.next_stage_at, lang)}
        </p>
      )}
    </div>
  );
}
