import { useEffect, useState } from 'react';
import { PackageSearch, RefreshCw, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import CopyField from './CopyField';

type Origin = {
  assignment_id: string;
  inventory_unit_id: string;
  order_item_id: string;
  unit_index: number;
  product_name: string | null;
  selection: string | null;
  lot_id: string;
  batch_name: string;
  purchase_id: string | null;
  incoming_id: string;
  purchase_unit_index: number;
  supplier_order_no: string;
  tracking_no: string;
  current_supplier_order_no: string;
  current_tracking_no: string;
  released_at: string | null;
  release_reason: string | null;
  state: 'allocated' | 'released' | 'unavailable';
  physical_verified_at: string | null;
  verified_serial_norm: string | null;
  inventory_serial_norm: string | null;
  serial_assignment_id: string | null;
  slot_serial_norm: string | null;
  physical_match: boolean;
  can_confirm: boolean;
};
type OriginsView = {
  installed: boolean;
  units: Origin[];
  untracked: Array<{ order_item_id: string; product_name: string; lot_id: string; qty: number }>;
};

/** Supplier references are loaded only inside the admin modal, from a separate
 * admin-only response. No shared customer order model gains private fields. */
export default function InventoryOriginsPanel({ orderId, revision }: { orderId: string; revision?: unknown }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<OriginsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api.get<OriginsView>(`/api/admin/orders/${encodeURIComponent(orderId)}/inventory-origins`)
      .then((value) => { if (!cancelled) setData(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [orderId, revision, refresh]);
  const active = data?.units.filter((unit) => unit.state !== 'released') ?? [];
  const history = data?.units.filter((unit) => unit.state === 'released') ?? [];
  return (
    <section data-admin="inventory-origins" className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-bold text-text-secondary flex items-center gap-2">
          <PackageSearch className="w-4 h-4" aria-hidden="true" />
          {loc('مصدر كل قطعة', 'Each unit’s source', 'سەرچاوەی هەر یەکە')}
        </h3>
        <Button variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          {loc('تحديث', 'Refresh', 'نوێکردنەوە')}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {loc('معلومات داخلية للإدارة فقط. جهّز القطعة المطابقة لرقم المخزون المكتوب على كرتونها.', 'Internal staff information. Pick the unit with the matching inventory ID on its box.', 'زانیاری ناوخۆی بەڕێوەبەران. ئەو یەکەیە هەڵبژێرە کە ژمارەی کۆگاکەی لەسەر کارتۆنەکەی یەکسانە.')}
      </p>
      {failed ? (
        <p role="alert" className="lv-alert lv-alert-warning text-sm">{loc('تعذّر تحميل مصدر القطع. أعد المحاولة.', 'Unit sources could not be loaded. Retry.', 'سەرچاوەی یەکەکان بارنەکرا. دووبارە هەوڵ بدە.')}</p>
      ) : !data ? (
        <p role="status" className="text-sm text-text-muted">{loc('جارٍ تحميل مصدر القطع…', 'Loading unit sources…', 'سەرچاوەی یەکەکان باردەکرێت…')}</p>
      ) : !data.installed ? (
        <p className="text-sm text-text-muted">{loc('تتبع القطع لم يُفعّل بعد.', 'Unit provenance is not enabled yet.', 'بەدواداچوونی یەکەکان هێشتا چالاک نەکراوە.')}</p>
      ) : (
        <>
          {active.length === 0 && <p className="text-sm text-text-muted">{loc('لا توجد قطع مرتبطة بهذا الطلب حاليًا. تظهر بعد خصم مخزون يدعم تتبع القطع.', 'No units are linked currently. They appear after stock with unit provenance is deducted.', 'ئێستا هیچ یەکەیەک بە داواکارییەکە نەبەستراوە.')}</p>}
          <div className="space-y-3">{active.map((unit) => <OriginCard key={unit.assignment_id} unit={unit} orderId={orderId} onChanged={() => setRefresh((value) => value + 1)} />)}</div>
          {data.untracked.length > 0 && (
            <div className="lv-alert lv-alert-warning text-xs space-y-1" data-origin-untracked>
              <p className="font-semibold">{loc('قطع مسحوبة من دفعات بلا توثيق لكل قطعة', 'Allocated units without individual provenance', 'یەکەی دیاریکراو بەبێ بەڵگەی تاکەکەسی')}</p>
              {data.untracked.map((row) => <p key={`${row.order_item_id}:${row.lot_id}`} className="break-words">{row.product_name} × {row.qty} · <bdi>{row.lot_id}</bdi></p>)}
              <p>{loc('رقم الدفعة معروف، لكن رقم طلب المورد والتتبع لكل قطعة غير موثّقين.', 'The lot is known; individual supplier order and tracking numbers are not documented.', 'ژمارەی کۆمەڵەکە دیارە، بەڵام داواکاری و بەدواداچوونی هەر یەکەیەک تۆمار نەکراوە.')}</p>
            </div>
          )}
          {history.length > 0 && <details className="rounded-xl border border-border-subtle p-3"><summary className="cursor-pointer text-sm font-semibold">{loc('سجل القطع المعادة أو الملغاة', 'Returned or cancelled unit history', 'مێژووی یەکە گەڕاوەکان')} ({history.length})</summary><div className="space-y-3 mt-3">{history.map((unit) => <OriginCard key={unit.assignment_id} unit={unit} orderId={orderId} onChanged={() => setRefresh((value) => value + 1)} />)}</div></details>}
        </>
      )}
    </section>
  );
}

function OriginCard({ unit, orderId, onChanged }: { unit: Origin; orderId: string; onChanged: () => void }) {
  const { loc } = useLanguage();
  const [opened, setOpened] = useState(false);
  const [scannedId, setScannedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = async () => {
    if (scannedId.trim() !== unit.inventory_unit_id || !unit.serial_assignment_id || saving) return;
    setSaving(true); setFailed(false);
    try {
      await api.post(`/api/admin/orders/${encodeURIComponent(orderId)}/inventory-origins/${encodeURIComponent(unit.assignment_id)}/confirm`, {
        inventory_unit_id: scannedId.trim(), serial_assignment_id: unit.serial_assignment_id,
      });
      setOpened(false); setScannedId(''); onChanged();
    } catch { setFailed(true); } finally { setSaving(false); }
  };
  const verified = unit.physical_match;
  return (
    <article className="rounded-xl border border-border-subtle bg-surface p-3 sm:p-4 min-w-0 space-y-3" data-origin-unit={unit.inventory_unit_id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><p className="font-semibold text-sm break-words">{unit.product_name || unit.order_item_id} · {loc('القطعة', 'Unit', 'یەکە')} {unit.unit_index}</p>{unit.selection && <p className="text-xs text-text-secondary mt-1 break-words">{unit.selection}</p>}</div>
        <span className="text-xs text-text-secondary">{unit.state === 'released' ? loc('أُعيدت / أُلغي تخصيصها', 'Released', 'گەڕێنراوەتەوە') : unit.state === 'unavailable' ? loc('غير متاحة', 'Unavailable', 'بەردەست نییە') : verified ? loc('تمت مطابقة القطعة', 'Unit verified', 'یەکەکە پشکنراوە') : loc('مخصّصة تلقائيًا · تحتاج مطابقة الكرتون', 'FIFO allocated · check the box', 'بە ئۆتۆماتیکی دیاریکراوە · کارتۆنەکە بپشکنە')}</span>
      </div>
      <CopyField label={loc('رقم القطعة الداخلي — طابقه مع ملصق الكرتون', 'Internal unit ID — match the box label', 'ژمارەی ناوخۆی یەکە — لەگەڵ ناونیشانی کارتۆن بیگونجێنە')} value={unit.inventory_unit_id} mono multiline emphasis />
      {unit.inventory_serial_norm && <CopyField label={loc('الرقم التسلسلي المسجل لهذه القطعة في المخزون', 'Serial recorded for this inventory unit', 'ژمارەی زنجیرەیی ئەم یەکەیە لە کۆگا')} value={unit.inventory_serial_norm} mono multiline emphasis />}
      <div className="grid gap-2 sm:grid-cols-2">
        <CopyField label={loc('اسم الدفعة عند السحب', 'Batch name at allocation', 'ناوی کۆمەڵە لە کاتی دیاریکردن')} value={unit.batch_name} multiline />
        <CopyField label={loc('رقم دفعة المخزون', 'Inventory lot ID', 'ژمارەی کۆمەڵەی کۆگا')} value={unit.lot_id} mono multiline />
        <CopyField label={loc('رقم الشراء الداخلي', 'Internal purchase ID', 'ژمارەی ناوخۆی کڕین')} value={unit.purchase_id || unit.incoming_id} mono multiline />
        <CopyField label={loc('رقم طلب المورد الحالي', 'Current supplier order number', 'ژمارەی ئێستای داواکاری دابینکەر')} value={unit.current_supplier_order_no} mono multiline />
        <CopyField label={loc('رقم تتبع المورد الحالي', 'Current supplier tracking number', 'ژمارەی ئێستای بەدواداچوونی دابینکەر')} value={unit.current_tracking_no} mono multiline />
        {(unit.verified_serial_norm || unit.slot_serial_norm) && <CopyField label={unit.physical_verified_at ? loc('الرقم التسلسلي عند المطابقة', 'Serial at physical verification', 'ژمارەی زنجیرەیی لە کاتی پشکنین') : loc('الرقم التسلسلي المسجل للطلب', 'Serial recorded for the order', 'ژمارەی زنجیرەیی داواکاری')} value={unit.verified_serial_norm || unit.slot_serial_norm || ''} mono multiline />}
      </div>
      {(unit.supplier_order_no !== unit.current_supplier_order_no || unit.tracking_no !== unit.current_tracking_no) && <details className="text-xs text-text-secondary"><summary className="cursor-pointer">{loc('بيانات المورد المسجلة وقت السحب', 'Supplier references recorded at allocation', 'زانیاری دابینکەر لە کاتی دیاریکردن')}</summary><div className="grid gap-2 sm:grid-cols-2 mt-2"><CopyField label={loc('رقم الطلب وقت السحب', 'Order number at allocation', 'ژمارەی داواکاری لە کاتی دیاریکردن')} value={unit.supplier_order_no} mono multiline /><CopyField label={loc('التتبع وقت السحب', 'Tracking at allocation', 'بەدواداچوون لە کاتی دیاریکردن')} value={unit.tracking_no} mono multiline /></div></details>}
      {unit.physical_verified_at && !verified && unit.state !== 'released' && <p role="alert" className="lv-alert lv-alert-warning text-xs">{loc('تغيّر ربط الرقم التسلسلي بعد المطابقة. راجع القطعة والضمان قبل التسليم.', 'The serial binding changed after verification. Review the unit and warranty before dispatch.', 'ژمارەی زنجیرەیی دوای پشکنین گۆڕاوە؛ پێش ناردن پشکنین بکە.')}</p>}
      {unit.can_confirm && (
        opened ? <form className="space-y-2 border-t border-border-subtle pt-3" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
          <p className="text-xs text-text-secondary">{loc('امسح أو اكتب رقم القطعة من ملصق الكرتون، وتأكد أن الرقم التسلسلي أعلاه يخص الكرتون نفسه.', 'Scan or type the inventory ID from the box label and verify that the serial above belongs to that same box.', 'ژمارەی یەکەکە لەسەر کارتۆنەکە بنووسە و ژمارەی زنجیرەیی بپشکنە.')}</p>
          <Field label={loc('رقم القطعة على الكرتون', 'Inventory ID on the box', 'ژمارەی یەکە لەسەر کارتۆن')}><Input dir="ltr" autoComplete="off" value={scannedId} onChange={(event) => setScannedId(event.target.value)} /></Field>
          {failed && <p role="alert" className="text-xs text-red-400">{loc('تعذّرت المطابقة. حدّث المصدر وتحقق من القطعة والدفعة والرقم التسلسلي والصلاحية.', 'Verification failed. Refresh and check the unit, lot, serial and your receiving permission.', 'پشکنین سەرکەوتوو نەبوو. یەکە و ژمارەکە و دەسەڵاتەکەت بپشکنە.')}</p>}
          <div className="flex gap-2"><Button type="submit" disabled={saving || scannedId.trim() !== unit.inventory_unit_id}>{loc('تأكيد مطابقة القطعة', 'Confirm physical unit', 'پشتڕاستکردنەوەی یەکە')}</Button><Button variant="ghost" onClick={() => setOpened(false)} disabled={saving}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</Button></div>
        </form> : <Button variant="secondary" onClick={() => setOpened(true)}><ShieldCheck className="w-4 h-4" aria-hidden="true" />{loc('مطابقة الكرتون والرقم التسلسلي', 'Verify box and serial', 'پشکنینی کارتۆن و ژمارەی زنجیرەیی')}</Button>
      )}
      {unit.state === 'allocated' && !unit.slot_serial_norm && <p className="text-xs text-text-muted">{loc('للأجهزة ذات الرقم التسلسلي: امسحه في قسم الضمان، ثم طابقه مع هذه القطعة.', 'For serialized devices: scan the serial in the warranty section, then verify this unit.', 'بۆ ئامێری ژمارەدار: ژمارەکە لە بەشی گەرەنتی تۆمار بکە، پاشان یەکەکە بپشکنە.')}</p>}
    </article>
  );
}
