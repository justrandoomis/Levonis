/**
 * Where the customer's order is, on the path it actually walks.
 *
 * WHY IT FETCHES ITS OWN DATA. The order list already does the slowest query
 * on the account screen; adding fourteen history rows to every order in it,
 * so that one expanded card can show a tracker, would make every OTHER card
 * slower. This asks for one order's path, once, when the customer opens it.
 * A screen that has ALREADY fetched the path (the order detail, which also
 * needs the tracking number for its header) hands it in as `tracking` and no
 * second request is made.
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
import type { OrderTrackingPublic } from '../lib/api';
// Dates take the order screens' shared locale (Latin digits in every
// language), so a card holding this tracker never mixes two digit systems.
import { formatDateTime } from './orders/format';

export type Tracking = OrderTrackingPublic;

const STRINGS = {
  ar: { loading: 'جارٍ تحميل التتبع…', failed: 'تعذّر تحميل حالة الشحن.', tracking: 'رقم التتبع', expected: 'المتوقع', title: 'تتبع الشحنة' },
  en: { loading: 'Loading tracking…', failed: 'Shipping status could not be loaded.', tracking: 'Tracking number', expected: 'Expected', title: 'Shipment tracking' },
  ckb: { loading: 'بارکردنی بەدواداچوون…', failed: 'دۆخی گەیاندن بار نەکرا.', tracking: 'ژمارەی بەدواداچوون', expected: 'چاوەڕوانکراو', title: 'بەدواداچوونی بار' },
} as const;

export default function OrderTracker({
  orderId,
  lang,
  tracking,
  showTrackingNo = true,
}: {
  orderId: string;
  lang: string;
  /** Already-fetched path from GET /api/orders/:id/tracking — skips the fetch. */
  tracking?: Tracking | null;
  /** The detail screen shows the number with a copy control of its own. */
  showTrackingNo?: boolean;
}) {
  const s = STRINGS[(lang as keyof typeof STRINGS) in STRINGS ? (lang as keyof typeof STRINGS) : 'ar'];
  const [data, setData] = useState<Tracking | null>(tracking ?? null);
  const [loading, setLoading] = useState(!tracking);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (tracking) {
      setData(tracking);
      setLoading(false);
      setFailed(false);
      return;
    }
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
  }, [orderId, lang, tracking]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-xs py-4" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> {s.loading}
      </div>
    );
  }
  // A failed fetch says so. It does NOT fall back to rendering the six-value
  // legacy status as if it were the tracker: half a truth about where a
  // parcel is is worse than saying we could not check.
  if (failed || !data) {
    return <p className="text-zinc-500 text-xs py-3" role="status">{s.failed}</p>;
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
                      ? 'bg-gold border-gold text-accent-contrast'
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
                {step.at && <p className="text-zinc-500 text-[10.5px] mt-0.5">{formatDateTime(step.at, lang)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {showTrackingNo && data.tracking_no && (
        <p className="text-zinc-400 text-[11px] mt-2 pt-2 border-t border-zinc-800">
          {s.tracking}: <span dir="ltr" className="text-zinc-200 font-mono">{data.tracking_no}</span>
        </p>
      )}
      {/* Only ever shown when the SERVER scheduled it — a stage waiting on a
          person or on the courier carries no time, and none is invented. */}
      {data.next_stage_at && (
        <p className="text-zinc-500 text-[10.5px] mt-1">
          {s.expected}: {formatDateTime(data.next_stage_at, lang)}
        </p>
      )}
    </div>
  );
}
