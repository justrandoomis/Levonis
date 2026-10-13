import { useState } from 'react';
import { api, Input, Select, STOCK, T, useLabels, useOperation } from '../adminOperations/shared';
import LotScanner, { type ScannedLot } from './LotScanner';
import LotUnitPicker, { type PieceSelection } from './LotUnitPicker';

type Lot = ScannedLot & { qty_remaining: number; location_name?: string | null };
export default function LotCountForm({ lots, onChanged, initialLot }: { lots: Lot[]; onChanged: () => void | Promise<void>; initialLot?: string }) {
  const { loc } = useLabels();
  const op = useOperation();
  const [lotId, setLotId] = useState(initialLot ?? '');
  const [counted, setCounted] = useState('');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [missing, setMissing] = useState<PieceSelection>({ required: false, valid: true, ids: [] });
  const selected = lots.find((l) => l.id === lotId);
  const choose = (id: string) => { setLotId(id); setCounted(''); setOperationId(crypto.randomUUID()); };
  return <>
    {op.feedback}
    <LotScanner onScanned={(r) => { if (r.lot) { if (!lots.some((l) => l.id === r.lot.id)) { op.setError(loc('الدفعة خارج القائمة الحالية؛ ابحث عنها أولًا', 'The lot is outside this list; find it first')); return; } choose(r.lot.id); } }} />
    <div className="inventory-fields">
      <Select label={loc('الدفعة والموقع', 'Lot and location')} value={lotId} onChange={choose} empty={loc('اختر دفعة', 'Choose lot')} options={lots.map((l) => ({ id: l.id, name: `${l.name_ar || l.name || l.id.slice(-8)} · ${l.location_name || loc('غير محدد', 'Unassigned')} · ${l.qty_remaining}` }))} />
      <Input label={loc('الكمية التي عددتها فعليًا', 'Quantity physically counted')} type="number" min={0} value={counted} onChange={setCounted} hint={selected ? `${loc('المسجل لهذه الدفعة', 'Recorded for this lot')}: ${selected.qty_remaining}` : undefined} />
    </div>
    {selected && counted !== '' && <p className={`mt-3 text-sm ${T.text2}`}>{loc('الفرق', 'Difference')}: {Number(counted) - selected.qty_remaining}</p>}
    {selected && counted !== '' && Number(counted) < selected.qty_remaining && <LotUnitPicker lotId={lotId} qty={selected.qty_remaining - Number(counted)} mode="missing" onChange={setMissing} />}
    <p className={`my-3 text-xs ${T.text3}`}>{loc('أدخل إجمالي هذه الدفعة وحدها. يسجل النظام الفرق والتكلفة تلقائيًا، ويرفض المساس بالكميات المحجوزة.', 'Count this lot only. The system records the difference and cost automatically and protects reserved quantities.')}</p>
    <button type="button" className={T.btnPrimary} disabled={op.busy || !selected || counted === '' || !Number.isInteger(Number(counted)) || Number(counted) < 0 || (Number(counted) < (selected?.qty_remaining ?? 0) && !missing.valid)} onClick={() => op.run(async () => { const short = Number(counted) < (selected?.qty_remaining ?? 0); await api.post(`${STOCK}/lot-counts`, { operation_id: operationId, lot_id: lotId, counted_qty: Number(counted), ...(short && missing.required ? { unit_origin_ids: missing.ids } : {}) }); setOperationId(crypto.randomUUID()); setCounted(''); await onChanged(); }, loc('تم تثبيت جرد الدفعة', 'Lot count posted'))}>{loc('تثبيت الجرد', 'Post count')}</button>
  </>;
}
