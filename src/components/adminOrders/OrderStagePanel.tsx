/**
 * Where the order is, and where an admin may send it next.
 *
 * THE PANEL HOLDS NO COPY OF THE PATH. The stages, their order, their
 * labels, which ones a person owns and which moves are legal from here all
 * come from `tracking` on the order detail response. The owner already
 * reported the cost of the alternative — "عند تحديث الطلب يظهر خيارين فقط" —
 * which was exactly a panel deciding for itself what the server would accept.
 *
 * THE MOVES ARE FILTERED, NOT GREYED OUT. A pre-order has fourteen stages;
 * offering all fourteen with eleven disabled is a worse screen than offering
 * the four that are real. The clock-owned and courier-owned stages are
 * MARKED, so an admin can see that "في الطريق إليك" is normally Al-Waseet's
 * to say and that choosing it by hand is the documented fallback rather than
 * the usual route.
 */
import { useState } from 'react';
import { Check, Circle, Clock, Loader2, Truck, User } from 'lucide-react';
import { api, ApiError } from '../../lib/api';

export interface StageStep {
  stage: string;
  source: 'manual' | 'automatic' | 'delivery_api';
  reached: boolean;
  current: boolean;
  at: string | null;
  label_ar: string;
  label_en: string;
}

export interface StageMove {
  stage: string;
  source: 'manual' | 'automatic' | 'delivery_api';
  label_ar: string;
  label_en: string;
}

export interface HistoryRow {
  stage: string;
  status: string;
  source: string;
  changed_at: string;
  changed_by: string;
  note: string;
}

export interface TrackingBlock {
  shipping_type: string;
  stage: string;
  stage_source: string;
  stage_changed_at: string;
  next_stage: string | null;
  next_stage_at: string | null;
  delivery: {
    provider: string;
    remote_id: string;
    tracking_no: string;
    status_text: string;
    synced_at: string | null;
    error: string;
  };
  steps: StageStep[];
  available: StageMove[];
  history: HistoryRow[];
}

const SOURCE_ICON = { manual: User, automatic: Clock, delivery_api: Truck } as const;

function when(iso: string | null, ar: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(ar ? 'ar-IQ' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function OrderStagePanel({
  orderId,
  tracking,
  dir,
  onMoved,
}: {
  orderId: string;
  tracking: TrackingBlock;
  dir: 'rtl' | 'ltr';
  onMoved: () => void | Promise<void>;
}) {
  const ar = dir === 'rtl';
  const label = (x: { label_ar: string; label_en: string }) => (ar ? x.label_ar : x.label_en);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const move = async (stage: string) => {
    if (busy) return;
    setBusy(stage);
    setError('');
    try {
      await api.patch(`/api/admin/orders/${orderId}/stage`, { stage, note: note.trim() || undefined });
      setNote('');
      await onMoved();
    } catch (e) {
      // The server's own refusal — an illegal move names both ends, a race
      // says to reload. Never a generic "failed".
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '');
    } finally {
      setBusy('');
    }
  };

  const d = tracking.delivery;

  return (
    <section data-order-stages className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-white font-bold text-sm">{ar ? 'مراحل الطلب' : 'Order stages'}</h3>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="text-zinc-400 hover:text-white text-[11px] font-bold"
        >
          {showHistory ? (ar ? 'إخفاء السجل' : 'Hide history') : (ar ? 'عرض السجل' : 'Show history')}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-blush text-xs bg-crimson/10 border border-crimson/40 rounded-xl p-2.5">
          {error}
        </p>
      )}

      <ol className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 space-y-0">
        {tracking.steps.map((step, i) => {
          const Icon = SOURCE_ICON[step.source];
          const last = i === tracking.steps.length - 1;
          return (
            <li key={step.stage} className="flex gap-3" data-admin-stage={step.stage}>
              <div className="flex flex-col items-center shrink-0">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center border ${
                    step.current
                      ? 'bg-olive border-olive text-snow'
                      : step.reached
                        ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-400'
                        : 'bg-transparent border-zinc-700 text-zinc-700'
                  }`}
                >
                  {step.reached ? <Check className="w-3 h-3" aria-hidden /> : <Circle className="w-2 h-2" aria-hidden />}
                </span>
                {!last && <span className={`w-px flex-1 min-h-[16px] ${step.reached ? 'bg-emerald-500/40' : 'bg-zinc-800'}`} />}
              </div>
              <div className={`min-w-0 ${last ? '' : 'pb-2.5'}`}>
                <p className={`text-[13px] leading-tight flex items-center gap-1.5 ${step.current ? 'text-white font-bold' : step.reached ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {label(step)}
                  {/* Who normally moves this one. An admin seeing the truck
                      icon knows the courier owns it and that setting it by
                      hand is the fallback, not the route. */}
                  <Icon className="w-3 h-3 text-zinc-500 shrink-0" aria-hidden />
                </p>
                {step.at && <p className="text-zinc-500 text-[10.5px] mt-0.5">{when(step.at, ar)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Only ever shown when the SERVER scheduled it. */}
      {tracking.next_stage_at && (
        <p className="text-zinc-400 text-[11px]">
          {ar ? 'الانتقال التلقائي التالي' : 'Next automatic move'}: {when(tracking.next_stage_at, ar)}
        </p>
      )}

      {(d.remote_id || d.status_text || d.error) && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] space-y-1">
          <p className="text-white font-bold text-[12px]">{ar ? 'شركة التوصيل' : 'Courier'}</p>
          {d.remote_id && <p className="text-zinc-400">ID: <span dir="ltr" className="text-zinc-200 font-mono">{d.remote_id}</span></p>}
          {d.tracking_no && <p className="text-zinc-400">{ar ? 'التتبع' : 'Tracking'}: <span dir="ltr" className="text-zinc-200 font-mono">{d.tracking_no}</span></p>}
          {d.status_text && <p className="text-zinc-400">{ar ? 'حالتهم' : 'Their status'}: <span className="text-zinc-200">{d.status_text}</span></p>}
          {d.synced_at && <p className="text-zinc-500">{ar ? 'آخر مزامنة' : 'Last sync'}: {when(d.synced_at, ar)}</p>}
          {/* A sync failure is SHOWN, not swallowed: the order did not move
              because we could not reach them, and an admin needs to know
              that rather than assume nothing happened. */}
          {d.error && <p className="text-blush">{ar ? 'خطأ المزامنة' : 'Sync error'}: {d.error}</p>}
        </div>
      )}

      <div>
        <label className="block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="stage-note">
          {ar ? 'ملاحظة (اختياري)' : 'Note (optional)'}
        </label>
        <input
          id="stage-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={ar ? 'تُحفظ في سجل الطلب' : 'Saved to the order history'}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-zinc-600"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tracking.available.length === 0 ? (
          <p className="text-zinc-500 text-xs">{ar ? 'لا توجد نقلات متاحة من هنا.' : 'No moves available from here.'}</p>
        ) : (
          tracking.available.map((m) => {
            const Icon = SOURCE_ICON[m.source];
            const isCourier = m.source === 'delivery_api';
            return (
              <button
                key={m.stage}
                type="button"
                data-stage-move={m.stage}
                onClick={() => void move(m.stage)}
                disabled={!!busy}
                title={
                  isCourier
                    ? ar
                      ? 'عادةً تحدّدها شركة التوصيل — التحديد اليدوي حل احتياطي'
                      : 'Normally set by the courier — setting it by hand is the fallback'
                    : undefined
                }
                className={`inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border text-[13px] font-bold transition-colors disabled:opacity-60 ${
                  m.stage === 'cancelled'
                    ? 'border-crimson/50 text-blush hover:bg-crimson/10'
                    : isCourier
                      ? 'border-zinc-700 border-dashed text-zinc-300 hover:bg-zinc-800'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
                }`}
              >
                {busy === m.stage ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Icon className="w-3.5 h-3.5" aria-hidden />}
                {label(m)}
              </button>
            );
          })
        )}
      </div>

      {showHistory && (
        <ul data-stage-history className="rounded-xl border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800 text-[11px]">
          {tracking.history.length === 0 ? (
            <li className="p-3 text-zinc-500">{ar ? 'لا سجل بعد.' : 'No history yet.'}</li>
          ) : (
            tracking.history.map((h, i) => (
              <li key={`${h.changed_at}-${i}`} className="p-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-zinc-200">{h.stage}</p>
                  {h.note && <p className="text-zinc-500 mt-0.5">{h.note}</p>}
                </div>
                <div className="text-end shrink-0 text-zinc-500">
                  <p>{when(h.changed_at, ar)}</p>
                  {/* manual / automatic / delivery_api — the record has to be
                      able to prove later who decided a move. */}
                  <p className="text-[10px]">{h.source}{h.changed_by ? ` · ${h.changed_by.slice(-6)}` : ''}</p>
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  );
}
