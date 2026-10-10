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
import { useLanguage } from '../../LanguageContext';
import { apiRefusal } from '../../lib/refusalStrings';
import SerialGateRefusal, { gateRefusalOf, type GateRefusal } from './serials/SerialGateRefusal';
import type { GateMissing } from './serials/types';

export interface StageStep {
  stage: string;
  source: 'manual' | 'automatic' | 'delivery_api';
  reached: boolean;
  current: boolean;
  at: string | null;
  label_ar: string;
  label_en: string;
  /** Absent from a server older than the Sorani stage labels — the Arabic stands in. */
  label_ckb?: string;
}

export interface StageMove {
  stage: string;
  source: 'manual' | 'automatic' | 'delivery_api';
  label_ar: string;
  label_en: string;
  label_ckb?: string;
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

function when(iso: string | null, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Sorani reads the Iraqi calendar, as it did before (no browser has ckb dates).
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'ar-IQ', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function OrderStagePanel({
  orderId,
  tracking,
  dir,
  onMoved,
  viewerOwner = false,
  onGoToSerial,
  serialsListedAbove = false,
  onSerialGateRefused,
}: {
  orderId: string;
  tracking: TrackingBlock;
  dir: 'rtl' | 'ltr';
  onMoved: () => void | Promise<void>;
  /** The Main Admin may move an order past the §19 serial gate, with a reason. */
  viewerOwner?: boolean;
  /** «اذهب إلى الوحدة» — open the unit's serial slot on the order tab. */
  onGoToSerial?: (m: GateMissing) => void;
  /** The order's serial blocker card already names the missing units on this tab. */
  serialsListedAbove?: boolean;
  /** The gate refused a move: the screen re-reads its serial view so the blocker is current. */
  onSerialGateRefused?: () => void;
}) {
  const { lang, loc } = useLanguage();
  const label = (x: { label_ar: string; label_en: string; label_ckb?: string }) =>
    lang === 'en' ? x.label_en : lang === 'ckb' ? x.label_ckb || x.label_ar : x.label_ar;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  // §19: the move the serial gate refused, what it is missing, and — for the
  // owner — the reason to move it anyway.
  const [gate, setGate] = useState<(GateRefusal & { stage: string }) | null>(null);

  const move = async (stage: string, serialsOverrideReason?: string) => {
    if (busy) return;
    setBusy(stage);
    setError('');
    // A different move starts clean; the owner's retry keeps the card it answers.
    if (!serialsOverrideReason) setGate(null);
    try {
      await api.patch(`/api/admin/orders/${orderId}/stage`, {
        stage,
        note: note.trim() || undefined,
        ...(serialsOverrideReason ? { serials_override_reason: serialsOverrideReason } : {}),
      });
      setNote('');
      setGate(null);
      await onMoved();
    } catch (e) {
      const refused = gateRefusalOf(e);
      if (refused) {
        onSerialGateRefused?.();
        setGate({ ...refused, stage });
        return;
      }
      // The server's own refusal — an illegal move names both ends, a race
      // says to reload. Never a generic "failed"; a known code reads in the
      // admin's own language.
      setError(e instanceof ApiError ? apiRefusal(e, lang === 'en' || lang === 'ckb' ? lang : 'ar', e.message) : e instanceof Error ? e.message : '');
    } finally {
      setBusy('');
    }
  };
  const gateMove = gate ? tracking.available.find((x) => x.stage === gate.stage) : undefined;

  const d = tracking.delivery;

  return (
    <section data-order-stages dir={dir} className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-text-primary font-bold text-sm">{loc('مراحل الطلب', 'Order stages', 'قۆناغەکانی داواکاری')}</h3>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="text-text-secondary hover:text-text-primary text-[11px] font-bold"
        >
          {showHistory ? loc('إخفاء السجل', 'Hide history', 'شاردنەوەی مێژوو') : loc('عرض السجل', 'Show history', 'پیشاندانی مێژوو')}
        </button>
      </div>

      {error && (
        <p role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">
          {error}
        </p>
      )}

      {gate && (
        <SerialGateRefusal
          refusal={gate}
          listedAbove={serialsListedAbove}
          viewerOwner={viewerOwner}
          busy={busy === gate.stage}
          proceedLabel={gateMove ? label(gateMove) : undefined}
          onGoTo={onGoToSerial}
          onOverride={(reason) => void move(gate.stage, reason)}
          testId={gate.stage}
        />
      )}

      <ol className="rounded-lg border border-border-subtle p-3 space-y-0">
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
                        : 'bg-transparent border-border-subtle text-text-muted'
                  }`}
                >
                  {step.reached ? <Check className="w-3 h-3" aria-hidden /> : <Circle className="w-2 h-2" aria-hidden />}
                </span>
                {!last && <span className={`w-px flex-1 min-h-[16px] ${step.reached ? 'bg-emerald-500/40' : 'bg-border-subtle'}`} />}
              </div>
              <div className={`min-w-0 ${last ? '' : 'pb-2.5'}`}>
                <p className={`text-[13px] leading-tight flex items-center gap-1.5 ${step.current ? 'text-text-primary font-bold' : step.reached ? 'text-text-primary' : 'text-text-muted'}`}>
                  {label(step)}
                  {/* Who normally moves this one. An admin seeing the truck
                      icon knows the courier owns it and that setting it by
                      hand is the fallback, not the route. */}
                  <Icon className="w-3 h-3 text-text-muted shrink-0" aria-hidden />
                </p>
                {step.at && <p className="text-text-muted text-[10.5px] mt-0.5">{when(step.at, lang)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Only ever shown when the SERVER scheduled it. */}
      {tracking.next_stage_at && (
        <p className="text-text-secondary text-[11px]">
          {loc('الانتقال التلقائي التالي', 'Next automatic move', 'گواستنەوەی خۆکاری داهاتوو')}: {when(tracking.next_stage_at, lang)}
        </p>
      )}

      {(d.remote_id || d.status_text || d.error) && (
        <div className="rounded-lg border border-border-subtle p-3 text-[11px] space-y-1">
          <p className="text-text-primary font-bold text-[12px]">{loc('شركة التوصيل', 'Courier', 'کۆمپانیای گەیاندن')}</p>
          {d.remote_id && <p className="text-text-secondary">ID: <span dir="ltr" className="text-text-primary font-mono">{d.remote_id}</span></p>}
          {d.tracking_no && <p className="text-text-secondary">{loc('التتبع', 'Tracking', 'بەدواداچوون')}: <span dir="ltr" className="text-text-primary font-mono">{d.tracking_no}</span></p>}
          {d.status_text && <p className="text-text-secondary">{loc('حالتهم', 'Their status', 'دۆخی ئەوان')}: <span className="text-text-primary">{d.status_text}</span></p>}
          {d.synced_at && <p className="text-text-muted">{loc('آخر مزامنة', 'Last sync', 'دوایین هاوکاتکردن')}: {when(d.synced_at, lang)}</p>}
          {/* A sync failure is SHOWN, not swallowed: the order did not move
              because we could not reach them, and an admin needs to know
              that rather than assume nothing happened. */}
          {d.error && <p className="text-danger">{loc('خطأ المزامنة', 'Sync error', 'هەڵەی هاوکاتکردن')}: {d.error}</p>}
        </div>
      )}

      <div>
        <label className="block text-text-secondary text-[10px] font-bold mb-1.5 uppercase tracking-wider" htmlFor="stage-note">
          {loc('ملاحظة (اختياري)', 'Note (optional)', 'تێبینی (ئارەزوومەندانە)')}
        </label>
        <input
          className="lv-input py-2.5 text-sm"
          id="stage-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={loc('تُحفظ في سجل الطلب', 'Saved to the order history', 'لە مێژووی داواکارییەکەدا پاشەکەوت دەکرێت')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tracking.available.length === 0 ? (
          <p className="text-text-muted text-xs">{loc('لا توجد نقلات متاحة من هنا.', 'No moves available from here.', 'لێرەوە هیچ گواستنەوەیەک بەردەست نییە.')}</p>
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
                    ? loc(
                        'عادةً تحدّدها شركة التوصيل — التحديد اليدوي حل احتياطي',
                        'Normally set by the courier — setting it by hand is the fallback',
                        'بەزۆری کۆمپانیای گەیاندن دیاری دەکات — دیاریکردنی دەستی ڕێگەی یەدەگە'
                      )
                    : undefined
                }
                className={`lv-button lv-button-sm ${
                  m.stage === 'cancelled'
                    ? 'lv-button-danger'
                    : isCourier
                      ? 'lv-button-ghost border-border-subtle border-dashed hover:bg-surface-raised'
                      : 'lv-button-secondary'
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
        <ul data-stage-history className="rounded-lg border border-border-subtle divide-y divide-border-subtle text-[11px]">
          {tracking.history.length === 0 ? (
            <li className="p-3 text-text-muted">{loc('لا سجل بعد.', 'No history yet.', 'هێشتا هیچ مێژوویەک نییە.')}</li>
          ) : (
            tracking.history.map((h, i) => (
              <li key={`${h.changed_at}-${i}`} className="p-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-text-primary">{h.stage}</p>
                  {h.note && <p className="text-text-muted mt-0.5">{h.note}</p>}
                </div>
                <div className="text-end shrink-0 text-text-muted">
                  <p>{when(h.changed_at, lang)}</p>
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
