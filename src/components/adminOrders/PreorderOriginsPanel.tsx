import { useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Field, Input, Textarea } from '../ui/Field';
import CopyField from './CopyField';
import { SOURCE_FIELDS, changedSources, emptySource, rowKey, saveSourceChunks, sourceFields, type SourceFields, type SourceKey, type SourceView } from './preorderOriginDrafts';

const PAGE_SIZE = 100;

/** Manual supplier evidence for preorder preparation. This panel never turns
 * imported capacity into shelf stock, nor edits the agreed customer price. */
export default function PreorderOriginsPanel({ orderId }: { orderId: string }) {
  const { loc } = useLanguage();
  const [view, setView] = useState<SourceView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, SourceFields>>({});
  const [common, setCommon] = useState<SourceFields>(emptySource);
  const [revision, setRevision] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<'missing' | 'failed' | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [page, setPage] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setDrafts({});
    setLoadFailed(false);
    setSaveError(null);
    setSaved(false);
    setProgress({ completed: 0, total: 0 });
    setPage(0);
    api.get<SourceView>(`/api/admin/orders/${encodeURIComponent(orderId)}/preorder-origins`)
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setDrafts(Object.fromEntries(data.rows.map((row) => [rowKey(row), sourceFields(row)])));
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [orderId, revision]);
  const labels: Record<SourceKey, string> = {
    batch_name: loc('اسم الدفعة', 'Batch name', 'ناوی کۆمەڵە'),
    batch_ref: loc('رقم الدفعة', 'Batch reference', 'ژمارەی کۆمەڵە'),
    purchase_ref: loc('رقم الشراء الداخلي', 'Internal purchase reference', 'ژمارەی ناوخۆی کڕین'),
    supplier_order_no: loc('رقم طلب المورد', 'Supplier order number', 'ژمارەی داواکاری دابینکەر'),
    tracking_no: loc('رقم تتبع المورد', 'Supplier tracking number', 'ژمارەی بەدواداچوونی دابینکەر'),
    note: loc('ملاحظة داخلية', 'Internal note', 'تێبینی ناوخۆیی'),
  };
  const changed = changedSources(view, drafts);
  const pages = Math.max(1, Math.ceil((view?.rows.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visibleRows = view?.rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) ?? [];
  const update = (key: string, field: SourceKey, value: string) => {
    setSaved(false); setSaveError(null);
    setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? emptySource()), [field]: value } }));
  };
  const fillEmpty = () => {
    setSaved(false); setSaveError(null);
    setDrafts((current) => Object.fromEntries(Object.entries(current).map(([key, fields]) => [key,
      Object.fromEntries(SOURCE_FIELDS.map((field) => [field, fields[field].trim() ? fields[field] : common[field]])) as SourceFields,
    ])));
  };
  const save = async () => {
    if (!view?.editable || saving || !changed.length) return;
    if (changed.some((row) => !drafts[rowKey(row)].supplier_order_no.trim())) { setSaveError('missing'); return; }
    setSaving(true); setSaveError(null); setSaved(false);
    setProgress({ completed: 0, total: changed.length });
    try {
      await saveSourceChunks(view, drafts,
        (body) => api.patch<SourceView>(`/api/admin/orders/${encodeURIComponent(orderId)}/preorder-origins`, body),
        (result) => {
          setView(result.view); setDrafts(result.drafts);
          setProgress({ completed: result.completed, total: result.total });
      });
      setSaved(true);
    } catch { setSaveError('failed'); } finally { setSaving(false); }
  };
  return (
    <section className="space-y-3 min-w-0" data-admin="preorder-origins">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-bold text-text-secondary flex items-center gap-2"><ClipboardList className="w-4 h-4" aria-hidden="true" />{loc('مصدر قطع الطلب المسبق', 'Preorder unit sources', 'سەرچاوەی یەکەکانی پێشداواکاری')}</h3>
        <Button variant="ghost" disabled={saving || changed.length > 0} onClick={() => setRevision((n) => n + 1)}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</Button>
      </div>
      <p className="text-xs text-text-muted">{loc('للإدارة فقط. أثناء تجهيز الطلب، سجّل الدفعة وطلب المورد والتتبع لكل قطعة للرجوع إليها عند الضمان.', 'Staff only. During preparation, record each unit’s batch, supplier order and tracking for warranty follow-up.', 'تەنها بۆ بەڕێوەبەران. لە کاتی ئامادەکردن، سەرچاوەی هەر یەکەیەک بۆ گەرەنتی تۆمار بکە.')}</p>
      {loadFailed ? <p role="alert" className="lv-alert lv-alert-warning text-sm">{loc('تعذّر تحميل بيانات المورد. أعد المحاولة.', 'Supplier details could not be loaded. Retry.', 'زانیاری دابینکەر بارنەکرا. دووبارە هەوڵ بدە.')}</p>
        : !view ? <p role="status" className="text-sm text-text-muted">{loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}</p>
          : !view.installed ? <p className="text-sm text-text-muted">{loc('توثيق مصدر الطلب المسبق لم يُفعّل بعد.', 'Preorder source records are not enabled yet.', 'تۆمارکردنی سەرچاوەی پێشداواکاری هێشتا چالاک نەکراوە.')}</p>
            : <>
              {!view.editable && <p className="text-xs text-text-muted">{loc('عرض فقط. تُضاف هذه البيانات خلال مراحل تجهيز الطلب وبصلاحية الاستلام.', 'Read only. These details can be edited during preparation with receiving permission.', 'تەنها بۆ بینین. دەستکاری لە کاتی ئامادەکردن بە دەسەڵاتی وەرگرتنە.')}</p>}
              {view.rows.length === 0 && <p className="text-sm text-text-muted">{loc('لا توجد قطع لتوثيقها في هذا الطلب.', 'There are no units to document for this order.', 'هیچ یەکەیەک نییە بۆ تۆمارکردن.')}</p>}
              {view.editable && view.rows.length > 1 && <details className="rounded-xl border border-border-subtle p-3"><summary className="cursor-pointer text-sm font-semibold">{loc('بيانات مشتركة لعدة قطع', 'Shared details for multiple units', 'زانیاری هاوبەشی چەند یەکە')}</summary><div className="grid sm:grid-cols-2 gap-3 mt-3">{SOURCE_FIELDS.filter((field) => field !== 'note').map((field) => <Field key={field} label={labels[field]}><Input value={common[field]} maxLength={120} ltr={field !== 'batch_name'} onChange={(event) => setCommon((current) => ({ ...current, [field]: event.target.value }))} disabled={saving} /></Field>)}</div><Button className="mt-3" variant="secondary" disabled={saving || !Object.values(common).some((value) => value.trim())} onClick={fillEmpty}>{loc('تعبئة الحقول الفارغة بهذه البيانات', 'Fill empty fields with these details', 'پڕکردنەوەی خانە بەتاڵەکان')}</Button><p className="text-xs text-text-muted mt-2">{loc('يمكن تعديل كل قطعة قبل الحفظ.', 'You can edit each unit before saving.', 'دەتوانیت پێش پاشەکەوتکردن هەر یەکەیەک دەستکاری بکەیت.')}</p></details>}
              {pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><Button variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{loc('السابق', 'Previous', 'پێشوو')}</Button><span>{loc('القطع', 'Units', 'یەکەکان')} {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, view.rows.length)} / {view.rows.length}</span><Button variant="ghost" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{loc('التالي', 'Next', 'دواتر')}</Button></div>}
              <div className="space-y-2">{visibleRows.map((row) => {
                const key = rowKey(row), draft = drafts[key] ?? sourceFields(row);
                return <details key={key} className="rounded-xl border border-border-subtle bg-surface p-3 sm:p-4 min-w-0" data-preorder-unit={key}>
                  <summary className="cursor-pointer text-sm font-semibold break-words">{row.product_name} · {loc('القطعة', 'Unit', 'یەکە')} {row.unit_index}<span className="font-normal text-xs text-text-muted ms-2">{row.supplier_order_no ? loc('المصدر محفوظ', 'Source saved', 'سەرچاوە پاشەکەوتکراوە') : loc('بانتظار بيانات المورد', 'Awaiting supplier details', 'چاوەڕوانی زانیاری دابینکەر')}</span>{row.state && row.state !== 'active' && <span className="font-normal text-xs text-text-muted ms-2">{row.state === 'returned' ? loc('مرتجعة', 'Returned', 'گەڕێندراوە') : row.state === 'cancelled' ? loc('ملغاة', 'Cancelled', 'هەڵوەشاوەتەوە') : loc('تم التسليم', 'Delivered', 'گەیەندراوە')}</span>}</summary>
                  {row.selection && <p className="text-xs text-text-secondary mt-2 break-words">{row.selection}</p>}
                  <div className="grid sm:grid-cols-2 gap-3 mt-3">{SOURCE_FIELDS.map((field) => view.editable
                    ? <Field key={field} label={labels[field]} required={field === 'supplier_order_no'} hint={field === 'tracking_no' ? loc('اختياري حتى يصدر رقم التتبع', 'Optional until tracking is issued', 'بە ئارەزوو تا ژمارەی بەدواداچوون دەرچوو') : undefined}>
                      {field === 'note' ? <Textarea rows={2} maxLength={500} value={draft[field]} disabled={saving} onChange={(event) => update(key, field, event.target.value)} /> : <Input ltr={field !== 'batch_name'} maxLength={120} value={draft[field]} disabled={saving} onChange={(event) => update(key, field, event.target.value)} />}
                    </Field>
                    : <CopyField key={field} label={labels[field]} value={draft[field]} mono={field !== 'batch_name' && field !== 'note'} multiline />)}</div>
                </details>;
              })}</div>
              {view.editable && view.rows.length > 0 && <Button loading={saving} loadingLabel={loc('جارٍ حفظ المصدر…', 'Saving sources…', 'سەرچاوە پاشەکەوتدەکرێت…')} disabled={!changed.length} onClick={save}>{loc('حفظ بيانات المورد للقطع المعدّلة', 'Save changed supplier records', 'پاشەکەوتکردنی زانیاری گۆڕاو')}</Button>}
              {changed.length > 0 && <p className="text-xs text-text-muted">{loc('قطع معدّلة لم تُحفظ:', 'Unsaved units:', 'یەکەی پاشەکەوتنەکراو:')} {changed.length}</p>}
              {progress.total > 0 && (saving || saveError === 'failed') && <p role="status" className="text-xs text-text-muted">{loc('حُفظ من القطع المعدّلة:', 'Changed units saved:', 'یەکە گۆڕاوە پاشەکەوتکراوەکان:')} {progress.completed} / {progress.total}</p>}
              {saveError && <p role="alert" className="lv-alert lv-alert-warning text-xs">{saveError === 'missing' ? loc('أدخل رقم طلب المورد لكل قطعة معدّلة قبل الحفظ.', 'Enter a supplier order number for every changed unit before saving.', 'پێش پاشەکەوتکردن ژمارەی داواکاری دابینکەر بۆ هەر یەکە بنووسە.') : loc('تعذّر الحفظ. ربما تغيّرت البيانات أو مرحلة الطلب أو صلاحيتك. احتفظ بتعديلاتك وحدّث الطلب للتحقق.', 'Save failed. The records, order stage or your permission may have changed. Keep your edits and reload the order to check.', 'پاشەکەوتکردن سەرکەوتوو نەبوو. زانیاری یان قۆناغ یان دەسەڵات گۆڕاوە.')}</p>}
              {saveError === 'failed' && <Button variant="ghost" disabled={saving} onClick={() => setRevision((n) => n + 1)}>{loc('تجاهل التعديلات وأعد تحميل بيانات المورد', 'Discard edits and reload supplier details', 'گۆڕانکارییەکان فڕێبدە و زانیاری دابینکەر نوێ بکەرەوە')}</Button>}
              {saved && <p role="status" className="text-xs text-emerald-400">{loc('حُفظ مصدر القطع للإدارة فقط.', 'Unit sources saved for staff only.', 'سەرچاوەکان تەنها بۆ بەڕێوەبەران پاشەکەوتکران.')}</p>}
            </>}
    </section>
  );
}
