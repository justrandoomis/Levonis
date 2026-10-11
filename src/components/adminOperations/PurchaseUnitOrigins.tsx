import { useState } from 'react';
import { Input, T, useLabels } from './shared';
import PurchaseUnitSerial, { type PurchaseSerialRead, type PurchaseSerialResult } from './PurchaseUnitSerial';
import {
  MAX_TRACKED_PURCHASE_UNITS, SUPPLIER_REFERENCE_MAX, applySupplierOrderNumber, pendingPurchaseUnits, purchaseUnitRows,
  purchaseUnitsValid, unitQuantityValid, type PurchaseReceiptDraft, type PurchaseUnitOrigin,
} from './procurementUnitOrigins';

const PAGE_SIZE = 20;

function InternalUnitId({ id }: { id: string }) {
  const { loc } = useLabels();
  return <label className="mt-2 grid min-w-0 gap-1 text-xs">
    <span>{loc('معرّف القطعة الداخلي — اضغط لتحديده ونسخه', 'Internal unit ID — select to copy', 'ناسنامەی ناوخۆی پارچە — بۆ کۆپیکردن هەڵیبژێرە')}</span>
    <input aria-label={loc('معرّف القطعة الداخلي', 'Internal unit ID', 'ناسنامەی ناوخۆی پارچە')} readOnly type="text" value={id} dir="ltr" onFocus={(e) => e.target.select()} className={`${T.input} min-w-0 font-mono text-xs`} />
  </label>;
}

/** Every use is inside an admin view. These are the supplier's references,
 * separate from the customer's shipment or the purchase's internal batch name. */
export default function PurchaseUnitOrigins({ qty, value, onChange, allowDisable = true, disabled = false, serialEntry = true }: {
  qty: number;
  value?: PurchaseUnitOrigin[];
  onChange: (value: PurchaseUnitOrigin[] | undefined) => void;
  allowDisable?: boolean;
  disabled?: boolean;
  serialEntry?: boolean;
}) {
  const { loc } = useLabels();
  const [page, setPage] = useState(0);
  const [sharedOrderNo, setSharedOrderNo] = useState('');
  const enabled = value !== undefined;
  const rows = enabled ? purchaseUnitRows(value, qty) : [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const change = (row: PurchaseUnitOrigin, key: 'supplier_order_no' | 'tracking_no' | 'serial_no', text: string) => {
    const next = { ...row, [key]: text };
    onChange(value?.some((r) => r.unit_index === row.unit_index)
      ? value.map((r) => r.unit_index === row.unit_index ? next : r)
      : [...(value ?? []), next]);
  };
  return <section className="mt-4 min-w-0 rounded-xl border border-[var(--ap-border)] p-3">
    <label className={`flex items-start gap-2 text-sm font-medium ${T.text1}`}>
      <input type="checkbox" checked={enabled} disabled={disabled || !allowDisable} onChange={(e) => onChange(e.target.checked ? [] : undefined)} className="mt-1" />
      {loc('تسجيل طلب المورد والتتبع لكل قطعة', 'Record supplier order and tracking for each unit', 'تۆمارکردنی داواکاری دابینکەر و شوێنکەوتن بۆ هەر پارچەیەک')}
    </label>
    <p className={`mt-2 text-xs ${T.text3}`}>{loc(
      'للأدمن والأدمن المساعد فقط. تُربط هذه البيانات بالقطعة المسحوبة للطلب لتسهيل مراجعة المورد والضمان.',
      'For admins and assistant admins only. Each allocated unit keeps its supplier references for warranty follow-up.',
      'تەنها بۆ بەڕێوەبەر و یاریدەدەری بەڕێوەبەر. زانیارییەکان بە پارچەی تەرخانکراوەوە دەبەسترێن بۆ بەدواداچوونی گەرەنتی.'
    )}</p>
    {enabled && !unitQuantityValid(qty) && <p role="alert" className="mt-2 text-sm text-[var(--ap-danger)]">{loc('أدخل كمية صحيحة بين 1 و', 'Enter a whole quantity from 1 to', 'بڕێکی تەواو بنووسە لە 1 بۆ')} {MAX_TRACKED_PURCHASE_UNITS}.</p>}
    {enabled && rows.length > 0 && <>
      <p className={`my-3 text-xs ${T.text3}`}>{loc('رقم طلب المورد مطلوب لكل قطعة. يمكن ترك التتبع فارغًا حتى يصدر؛ ويمكن تكرار نفس الرقم لقطع الطلب الواحد.', 'Each unit needs a supplier order number. Tracking may stay blank until issued; units in the same supplier order can share references.', 'ژمارەی داواکاری دابینکەر بۆ هەر پارچەیەک پێویستە. شوێنکەوتن دەتوانێت بەتاڵ بێت تا دەردەچێت؛ پارچەکانی هەمان داواکاری دەتوانن هەمان ژمارەیان هەبێت.')}</p>
      {qty > 1 && <div className="mb-4 grid min-w-0 gap-2 rounded-lg border border-[var(--ap-border)] p-3">
        <label className="grid min-w-0 gap-1 text-sm">
          <span className={T.text2}>{loc('رقم طلب المورد المشترك', 'Shared supplier order number', 'ژمارەی هاوبەشی داواکاری دابینکەر')}</span>
          <input type="text" dir="ltr" className={`${T.input} min-w-0`} maxLength={SUPPLIER_REFERENCE_MAX} value={sharedOrderNo} onChange={(e) => setSharedOrderNo(e.target.value)} autoComplete="off" spellCheck={false} disabled={disabled} />
        </label>
        <p className={`text-xs ${T.text3}`}>{loc('إذا اشتريت عدة قطع بطلب واحد، اكتب رقمه هنا مرة واحدة. يبقى رقم التتبع مستقلًا لكل قطعة، ويمكنك تعديل رقم طلب أي قطعة أدناه.', 'For several units in one supplier order, enter its number once here. Tracking stays separate for each unit, and you can still edit any unit’s order number below.', 'ئەگەر چەند پارچەیەکت بە یەک داواکاری کڕیوە، ژمارەکە لێرە یەک جار بنووسە. شوێنکەوتنی هەر پارچەیەک جیاواز دەمێنێتەوە و دەتوانیت ژمارەی داواکاری هەر پارچەیەک لە خوارەوە بگۆڕیت.')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={T.btnSecondary} disabled={disabled || !sharedOrderNo.trim() || !rows.some((row) => !row.supplier_order_no.trim())} onClick={() => onChange(applySupplierOrderNumber(value ?? [], qty, sharedOrderNo))}>{loc('تعبئة الخانات الفارغة', 'Fill empty order numbers', 'پڕکردنەوەی ژمارە بەتاڵەکان')}</button>
          <button type="button" className={T.btnGhost} disabled={disabled || !sharedOrderNo.trim()} onClick={() => onChange(applySupplierOrderNumber(value ?? [], qty, sharedOrderNo, true))}>{loc('استبدال رقم الطلب لكل القطع', 'Replace order number for all units', 'گۆڕینی ژمارەی داواکاری بۆ هەموو پارچەکان')}</button>
        </div>
      </div>}
      <div className="grid gap-3">
        {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((row) => <fieldset key={row.unit_index} className="min-w-0 rounded-lg border border-[var(--ap-border)] p-3">
          <legend className={`px-1 text-sm font-medium ${T.text2}`}>{loc('القطعة', 'Unit', 'پارچە')} {row.unit_index}</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {(['supplier_order_no', 'tracking_no'] as const).map((key) => <label key={key} className="grid min-w-0 gap-1 text-sm">
              <span className={T.text2}>{key === 'supplier_order_no' ? loc('رقم طلب المورد', 'Supplier order number', 'ژمارەی داواکاری دابینکەر') : loc('رقم تتبع المورد (اختياري)', 'Supplier tracking number (optional)', 'ژمارەی شوێنکەوتنی دابینکەر (ئارەزوومەندانە)')}</span>
              <input type="text" dir="ltr" className={`${T.input} min-w-0`} maxLength={SUPPLIER_REFERENCE_MAX} value={row[key]} onChange={(e) => change(row, key, e.target.value)} required={key === 'supplier_order_no'} autoComplete="off" spellCheck={false} disabled={disabled} />
            </label>)}
          </div>
          {serialEntry && <PurchaseUnitSerial mode="draft" value={row.serial_no ?? ''} disabled={disabled} onChange={(serial) => change(row, 'serial_no', serial)} />}
        </fieldset>)}
      </div>
      {pages > 1 && <div className="mt-3 flex items-center gap-3 text-sm">
        <button type="button" className={T.btnGhost} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{loc('السابق', 'Previous', 'پێشوو')}</button>
        <span>{currentPage + 1} / {pages}</span>
        <button type="button" className={T.btnGhost} disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>{loc('التالي', 'Next', 'دواتر')}</button>
      </div>}
      {!purchaseUnitsValid(value, qty) && <p role="status" className="mt-2 text-xs text-[var(--ap-danger)]">{loc('أكمل رقم طلب المورد لكل قطعة قبل التأكيد.', 'Complete every unit’s supplier order number before confirming.', 'پێش پشتڕاستکردنەوە ژمارەی داواکاری دابینکەر بۆ هەر پارچەیەک تەواو بکە.')}</p>}
    </>}
  </section>;
}

export function SavedPurchaseUnitOrigins({ value, onSave, onSerialSave, serialBlockedHint }: {
  value?: PurchaseUnitOrigin[];
  onSave?: (units: PurchaseUnitOrigin[]) => Promise<boolean>;
  onSerialSave?: (unit: PurchaseUnitOrigin, read: PurchaseSerialRead) => Promise<PurchaseSerialResult>;
  serialBlockedHint?: string;
}) {
  const { loc } = useLabels();
  const [editing, setEditing] = useState<PurchaseUnitOrigin[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(0);
  if (!value?.length) return null;
  const pages = Math.max(1, Math.ceil(value.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  return <details className="my-3 min-w-0 rounded-lg border border-[var(--ap-border)] p-3">
    <summary className="cursor-pointer text-sm font-medium">{loc('طلبات المورد والتتبع لكل قطعة — للإدارة فقط', 'Per-unit supplier references — admins only', 'زانیاری دابینکەری هەر پارچەیەک — تەنها بۆ بەڕێوەبەران')} ({value.length})</summary>
    {serialBlockedHint && <p className={`mt-2 text-xs ${T.text3}`}>{serialBlockedHint}</p>}
    {onSave && (editing ? <>
      <PurchaseUnitOrigins qty={value.length} value={editing} onChange={(next) => setEditing(next ?? [])} allowDisable={false} disabled={saving} serialEntry={false} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={T.btnSecondary} disabled={saving || !purchaseUnitsValid(editing, value.length)} onClick={async () => {
          setSaving(true);
          try { if (await onSave(editing)) setEditing(null); } finally { setSaving(false); }
        }}>{loc('حفظ مراجع المورد', 'Save supplier references', 'پاشەکەوتکردنی زانیاری دابینکەر')}</button>
        <button type="button" className={T.btnGhost} disabled={saving} onClick={() => setEditing(null)}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</button>
      </div>
    </> : <button type="button" className={`${T.btnGhost} mt-3`} onClick={() => setEditing(value.map((row) => ({ ...row })))}>{loc('تعديل طلب المورد أو التتبع', 'Edit supplier order or tracking', 'دەستکاری داواکاری دابینکەر یان شوێنکەوتن')}</button>)}
    <div className="mt-3 grid max-h-96 gap-3 overflow-y-auto">
      {value.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((row) => <dl key={row.unit_index} className={`grid min-w-0 gap-1 rounded-lg border border-[var(--ap-border)] p-3 text-sm ${T.text2}`}>
        <dt className={`font-medium ${T.text1}`}>{loc('القطعة', 'Unit', 'پارچە')} {row.unit_index}</dt>
        {row.id && <div><dt className="sr-only">{loc('معرّف القطعة الداخلي', 'Internal unit ID', 'ناسنامەی ناوخۆی پارچە')}</dt><dd><InternalUnitId id={row.id} /></dd></div>}
        <div className="flex flex-wrap gap-2"><dt>{loc('طلب المورد', 'Supplier order', 'داواکاری دابینکەر')}</dt><dd className="break-all" dir="ltr">{row.supplier_order_no || '—'}</dd></div>
        <div className="flex flex-wrap gap-2"><dt>{loc('تتبع المورد', 'Supplier tracking', 'شوێنکەوتنی دابینکەر')}</dt><dd className="break-all" dir="ltr">{row.tracking_no || loc('بانتظار التتبع', 'Tracking pending', 'چاوەڕێی شوێنکەوتن')}</dd></div>
        {row.received_lot_id && <div className="flex flex-wrap gap-2"><dt>{loc('دفعة الاستلام', 'Receipt batch', 'دەستەی وەرگرتن')}</dt><dd className="break-all" dir="ltr">{row.received_lot_id}</dd></div>}
        {(row.serial_norm || onSerialSave) && <div><dt className="sr-only">{loc('الرقم التسلسلي', 'Serial number', 'ژمارەی زنجیرەیی')}</dt><dd><PurchaseUnitSerial mode="saved" value={row.serial_norm ?? ''} disabled={saving || !!editing} onSave={onSerialSave ? (read) => onSerialSave(row, read) : undefined} /></dd></div>}
        {!row.serial_norm && row.serial_no && <div><dt>{loc('رقم تسلسلي سيُسجّل عند التأكيد', 'Serial to register on confirmation', 'ژمارەیەک کە لە کاتی پشتڕاستکردنەوە تۆمار دەکرێت')}</dt><dd className="break-all" dir="ltr">{row.serial_no}</dd></div>}
      </dl>)}
    </div>
    {pages > 1 && <div className="mt-3 flex items-center gap-3 text-sm">
      <button type="button" className={T.btnGhost} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{loc('السابق', 'Previous', 'پێشوو')}</button>
      <span>{currentPage + 1} / {pages}</span>
      <button type="button" className={T.btnGhost} disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>{loc('التالي', 'Next', 'دواتر')}</button>
    </div>}
  </details>;
}

export function PurchaseUnitReceiveFields({ origins, value, onChange }: {
  origins: PurchaseUnitOrigin[];
  value: PurchaseReceiptDraft;
  onChange: (value: PurchaseReceiptDraft) => void;
}) {
  const { loc } = useLabels();
  const [filter, setFilter] = useState('');
  const pending = pendingPurchaseUnits(origins), picked = new Set(value.unit_origin_ids ?? []);
  const visible = pending.filter((row) => `${row.unit_index} ${row.supplier_order_no} ${row.tracking_no} ${row.serial_norm ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const select = (ids: string[]) => onChange({ qty: ids.length, rejected_qty: 0, unit_origin_ids: ids });
  if (!pending.length) return <p className={`mt-3 text-sm ${T.text3}`}>{loc('لا توجد قطع متتبعة بانتظار الاستلام.', 'No tracked units await receipt.', 'هیچ پارچەیەکی شوێنکەوتنکراو چاوەڕێی وەرگرتن نییە.')}</p>;
  return <fieldset className="mt-3 min-w-0 rounded-lg border border-[var(--ap-border)] p-3">
    <legend className="px-1 text-sm font-medium">{loc('حدد القطع التي وصلت فعليًا', 'Select the units that actually arrived', 'ئەو پارچانە دیاری بکە کە بەڕاستی گەیشتوون')}</legend>
    <p className={`mb-3 text-xs ${T.text3}`}>{loc('الاختيار حسب طلب المورد والتتبع؛ تبقى القطع غير المحددة بانتظار الاستلام.', 'Select by supplier order and tracking; unselected units remain pending.', 'بەپێی داواکاری دابینکەر و شوێنکەوتن هەڵبژێرە؛ پارچە هەڵنەبژێردراوەکان چاوەڕوان دەمێننەوە.')}</p>
    <p className={`mb-3 text-sm ${T.text2}`}>{loc('ضع معرّف القطعة الداخلي على كرتونها عند الاستلام، حتى تطابق القطعة الفعلية مع بياناتها عند تجهيز طلب الزبون.', 'Label each carton with its internal unit ID when receiving it, so the physical unit can be matched while preparing the customer order.', 'لە کاتی وەرگرتندا ناسنامەی ناوخۆی پارچە لەسەر کارتۆنەکەی دابنێ، بۆ ئەوەی پارچەکە لە کاتی ئامادەکردنی داواکاری کڕیاردا بناسرێتەوە.')}</p>
    <Input label={loc('بحث بطلب المورد أو التتبع أو الرقم التسلسلي', 'Find supplier order, tracking or serial', 'گەڕان بە داواکاری دابینکەر، شوێنکەوتن یان ژمارەی زنجیرەیی')} value={filter} onChange={setFilter} />
    <div className="my-2 flex flex-wrap items-center gap-2 text-sm">
      <button type="button" className={T.btnGhost} onClick={() => select([...new Set([...picked, ...visible.map((row) => row.id!)])])}>{loc('تحديد النتائج', 'Select results', 'هەڵبژاردنی ئەنجامەکان')}</button>
      <button type="button" className={T.btnGhost} onClick={() => select([])}>{loc('إلغاء التحديد', 'Clear selection', 'پاککردنەوەی هەڵبژاردن')}</button>
      <span>{loc('المحدد', 'Selected', 'هەڵبژێردراو')}: {value.qty} / {pending.length}</span>
    </div>
    <div className="grid max-h-80 gap-2 overflow-y-auto">
      {visible.map((row) => <div key={row.id} className={`min-w-0 rounded-lg border border-[var(--ap-border)] p-3 text-sm ${T.text2}`}>
        <label className="flex min-w-0 items-start gap-2">
          <input type="checkbox" checked={picked.has(row.id!)} onChange={(e) => select(e.target.checked ? [...picked, row.id!] : [...picked].filter((id) => id !== row.id))} className="mt-1" />
          <span className="min-w-0"><strong>{loc('القطعة', 'Unit', 'پارچە')} {row.unit_index}</strong><span className="block break-all">{loc('طلب المورد', 'Supplier order', 'داواکاری دابینکەر')}: <bdi>{row.supplier_order_no}</bdi></span><span className="block break-all">{loc('تتبع المورد', 'Supplier tracking', 'شوێنکەوتنی دابینکەر')}: <bdi>{row.tracking_no || '—'}</bdi></span></span>
        </label>
        {row.serial_norm && <p className="mt-2 break-all">{loc('الرقم التسلسلي', 'Serial number', 'ژمارەی زنجیرەیی')}: <bdi className="font-mono font-medium">{row.serial_norm}</bdi></p>}
        <InternalUnitId id={row.id!} />
      </div>)}
    </div>
  </fieldset>;
}
