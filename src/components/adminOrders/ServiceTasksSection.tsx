/**
 * «مهام الخدمات» on the admin order window (migration 0234; DECISIONS row 339):
 * the packing instruction every enrolled printer carries, the pre-dispatch
 * inspection (the order cannot be handed to the courier until it is done) and
 * the live Academy request. A task is closed once, by a staff member, with a
 * note for the inspection (what was checked) and Academy (the agreed time).
 */
import { useState } from 'react';
import { CirclePlay, Check, Package, ClipboardCheck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';

export interface ServiceTask {
  id: string; order_item_id: string; kind: 'packaging' | 'inspection' | 'academy' | string; choice: string; note: string;
  status: 'open' | 'done' | 'cancelled' | string; result_note: string | null; done_by: string | null; done_at: string | null;
}

export default function ServiceTasksSection({ tasks, onChanged }: { tasks: ServiceTask[]; onChanged: (t: ServiceTask[]) => void }) {
  const { loc, lang } = useLanguage();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!tasks.length) return null;

  const done = async (t: ServiceTask) => {
    setBusy(t.id);
    setError(null);
    try {
      const data = await api.post<{ tasks: ServiceTask[] }>(`/api/admin/order-service-tasks/${t.id}/done`, { result_note: notes[t.id] ?? '' });
      onChanged(data.tasks);
    } catch (e) {
      // A known code reads in the admin's own language (src/lib/refusalStrings.ts); else the server's sentence.
      setError(e instanceof ApiError ? apiRefusal(e, lang === 'en' || lang === 'ckb' ? lang : 'ar', e.message) : String(e));
    } finally {
      setBusy(null);
    }
  };
  const icon = (k: string) => (k === 'inspection' ? <ClipboardCheck className="w-4 h-4" aria-hidden="true" /> : k === 'academy' ? <CirclePlay className="w-4 h-4" aria-hidden="true" /> : <Package className="w-4 h-4" aria-hidden="true" />);
  const needsNote = (k: string) => k === 'inspection' || k === 'academy';

  return (
    <section data-order-service-tasks>
      <h3 className="text-[13px] font-bold text-text-secondary mb-2">{loc('مهام الخدمات', 'Service tasks', 'ئەرکەکانی خزمەتگوزاری')}</h3>
      <ul className="space-y-2">
        {tasks.map((t) => (
          <li key={t.id} className="lv-well rounded-md p-3 text-sm">
            <p className="flex items-start gap-2 text-text-primary">
              <span className="mt-0.5 text-text-secondary">{icon(t.kind)}</span>
              <span className="min-w-0 flex-1">{t.note}</span>
              {t.status === 'done' ? <Check className="w-4 h-4 text-text-secondary" aria-label={loc('مكتمل', 'Done', 'تەواو')} /> : null}
            </p>
            {t.status === 'done' ? (
              t.result_note ? <p className="mt-1 ps-6 text-[12px] text-text-secondary whitespace-pre-wrap">{t.result_note}</p> : null
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2 ps-6">
                {needsNote(t.kind) ? (
                  <input
                    className="lv-input h-9 min-w-0 flex-1 px-2 text-[13px]"
                    aria-label={t.kind === 'inspection'
                      ? loc('ملاحظة الفحص: ماذا فُحص وماذا وُجد', 'Inspection note: what was checked and found', 'تێبینی پشکنین: چی پشکنرا و چی دۆزرایەوە')
                      : loc('ملاحظة الأكاديمية: الموعد المتفق عليه', 'Academy note: the agreed time', 'تێبینی فێرکردن: کاتی ڕێککەوتوو')}
                    placeholder={t.kind === 'inspection' ? loc('ماذا فُحص وماذا وُجد', 'What was checked and found', 'چی پشکنرا و چی دۆزرایەوە') : loc('الموعد المتفق عليه', 'Agreed time', 'کاتی ڕێککەوتوو')}
                    value={notes[t.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))}
                  />
                ) : null}
                <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={busy === t.id} onClick={() => void done(t)}>
                  {loc('تم', 'Done', 'تەواو')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="mt-2 text-[12px] text-text-primary">{error}</p> : null}
    </section>
  );
}
