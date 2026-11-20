/**
 * «مهام الخدمات» on the admin order window (migration 0234; DECISIONS rows 339, 364):
 * the packing instruction every enrolled printer carries, the pre-dispatch
 * inspection (the order cannot be handed to the courier until it is done) and
 * the live Academy request. A task is closed once, by a staff member, with a
 * note for the inspection (what was checked) and Academy (the agreed time).
 *
 * Row 364: the task reads in the admin's own language (`text`, built by the
 * server from the line's frozen snapshot — the stored Arabic note is the
 * fallback), says WHICH printer it is for, WHO closed it and when, and offers
 * no «تم» on an order that is cancelled or returned (the server refuses it:
 * ORDER_SERVICE_TASK_ORDER_ENDED).
 */
import { useState } from 'react';
import { CirclePlay, Check, Package, ClipboardCheck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, type AdminServiceTask } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { formatDateTime } from '../orders/format';

export type ServiceTask = AdminServiceTask;

export default function ServiceTasksSection({
  tasks,
  onChanged,
  open = true,
  printerNames = {},
}: {
  tasks: ServiceTask[];
  onChanged: (t: ServiceTask[]) => void;
  /** False once the order is cancelled / returned: nothing can be completed any more. */
  open?: boolean;
  /** order_item_id → the printer's name, so a task says which box it is for when the order holds several. */
  printerNames?: Record<string, string>;
}) {
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
      // A known code reads in the admin's own language (src/lib/refusalStrings.ts) — never the raw code or the
      // server's three-language sentence.
      setError(
        e instanceof ApiError
          ? apiRefusal(e, lang === 'en' || lang === 'ckb' ? lang : 'ar', loc('تعذّر إغلاق المهمة — أعد المحاولة.', 'The task could not be closed — try again.', 'ئەرکەکە دانەخرا — دووبارە هەوڵ بدەرەوە.'))
          : loc('تعذّر إغلاق المهمة — أعد المحاولة.', 'The task could not be closed — try again.', 'ئەرکەکە دانەخرا — دووبارە هەوڵ بدەرەوە.')
      );
    } finally {
      setBusy(null);
    }
  };
  const icon = (k: string) => (k === 'inspection' ? <ClipboardCheck className="w-4 h-4" aria-hidden="true" /> : k === 'academy' ? <CirclePlay className="w-4 h-4" aria-hidden="true" /> : <Package className="w-4 h-4" aria-hidden="true" />);
  const needsNote = (k: string) => k === 'inspection' || k === 'academy';
  const kindName = (k: string) =>
    k === 'inspection' ? loc('الفحص قبل الإرسال', 'Pre-dispatch inspection', 'پشکنین پێش ناردن')
      : k === 'academy' ? loc('الدورة التعليمية', 'Training session', 'خولی فێرکاری')
        : loc('التغليف', 'Packaging', 'پێچانەوە');
  const several = new Set(tasks.map((t) => t.order_item_id)).size > 1;
  const words = (t: ServiceTask) => (t.text ? loc(t.text.ar, t.text.en, t.text.ckb) : t.note);

  return (
    <section data-order-service-tasks id="order-service-tasks">
      <h3 className="text-[13px] font-bold text-text-secondary mb-2">{loc('مهام الخدمات', 'Service tasks', 'ئەرکەکانی خزمەتگوزاری')}</h3>
      {!open ? (
        <p data-service-tasks-ended role="status" className="mb-2 rounded-xl border border-border-subtle bg-surface-selected px-3 py-2 text-[12.5px] font-bold text-text-secondary">
          {loc(
            'الطلب أُلغي أو أُرجع — لم تعد هذه المهام تُنفَّذ.',
            'This order was cancelled or returned — these tasks are no longer carried out.',
            'ئەم داواکارییە هەڵوەشێنراوەتەوە یان گەڕێنراوەتەوە — ئەم ئەرکانە چیتر جێبەجێ ناکرێن.'
          )}
        </p>
      ) : null}
      <ul className="space-y-2">
        {tasks.map((t) => {
          const isDone = t.status === 'done';
          const who = [t.done_by_name, t.done_at ? formatDateTime(t.done_at, lang) : ''].filter(Boolean).join(' · ');
          return (
            <li key={t.id} className="lv-well rounded-md p-3 text-sm" data-service-task={t.kind} data-service-task-status={t.status}>
              <p className="flex items-start gap-2 text-text-primary">
                <span className="mt-0.5 text-text-secondary">{icon(t.kind)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-bold text-text-secondary">
                    {kindName(t.kind)}
                    {several && printerNames[t.order_item_id] ? ` — ${printerNames[t.order_item_id]}` : ''}
                  </span>
                  <span className="block break-words">{words(t)}</span>
                </span>
                {isDone ? <Check className="w-4 h-4 shrink-0 text-success" aria-hidden="true" /> : null}
              </p>
              {isDone ? (
                <div className="mt-1 ps-6">
                  <p className="text-[12px] font-bold text-success" data-service-task-done>
                    {loc('أُنجز', 'Done', 'کراوە')}
                    {who ? ` — ${who}` : ''}
                  </p>
                  {t.result_note ? <p className="mt-0.5 text-[12px] text-text-secondary whitespace-pre-wrap break-words">{t.result_note}</p> : null}
                </div>
              ) : open && t.status === 'open' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 ps-6">
                  {needsNote(t.kind) ? (
                    <input
                      className="lv-input h-11 min-w-0 flex-1 px-2 text-[13px]"
                      aria-label={t.kind === 'inspection'
                        ? loc('ملاحظة الفحص: ماذا فُحص وماذا وُجد', 'Inspection note: what was checked and found', 'تێبینی پشکنین: چی پشکنرا و چی دۆزرایەوە')
                        : loc('ملاحظة الدورة: الموعد المتفق عليه', 'Session note: the agreed time', 'تێبینی خول: کاتی ڕێککەوتوو')}
                      placeholder={t.kind === 'inspection' ? loc('ماذا فُحص وماذا وُجد', 'What was checked and found', 'چی پشکنرا و چی دۆزرایەوە') : loc('الموعد المتفق عليه', 'Agreed time', 'کاتی ڕێککەوتوو')}
                      value={notes[t.id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))}
                    />
                  ) : null}
                  <button type="button" className="lv-button lv-button-secondary" disabled={busy === t.id} onClick={() => void done(t)} data-service-task-done-button>
                    {t.kind === 'inspection' ? loc('تم الفحص', 'Inspection done', 'پشکنین کرا') : t.kind === 'academy' ? loc('تم تحديد الموعد', 'Session arranged', 'کات دیاری کرا') : loc('تم التغليف', 'Packed', 'پێچرایەوە')}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert" className="mt-2 text-[12px] font-bold text-danger">{error}</p> : null}
    </section>
  );
}
