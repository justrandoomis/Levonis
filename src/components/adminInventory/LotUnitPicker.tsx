import { useEffect, useState } from 'react';
import { api, STOCK, T, useLabels } from '../adminOperations/shared';

type Unit = { id: string; unit_index: number; supplier_order_no: string; tracking_no: string; serial_norm: string | null };
type Choices = { lot_id: string; qty_remaining: number; units: Unit[]; unidentified: number };
/** What the parent sends: `ids` only when the server needs names. */
export type PieceSelection = { required: boolean; valid: boolean; ids: string[] };

/**
 * PART OF A TRACKED LOT NAMES ITS PIECES (review 2026-10-13, PROV-3). Moving or
 * losing a whole lot takes every piece in it; a part of a lot that holds
 * identified pieces must say which cartons moved or are missing, so each
 * label, supplier order and tracking number stays where its carton is.
 */
export default function LotUnitPicker({ lotId, qty, mode, onChange }: {
  lotId: string; qty: number; mode: 'move' | 'missing'; onChange: (value: PieceSelection) => void;
}) {
  const { loc } = useLabels();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setChoices(null); setPicked([]); setFailed(false);
    if (!lotId) return;
    api.get<Choices>(`${STOCK}/lots/${encodeURIComponent(lotId)}/units`)
      .then((r) => { if (live) setChoices(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [lotId]);
  const units = choices?.units ?? [];
  const required = !!choices && units.length > 0 && qty > 0 && qty < choices.qty_remaining;
  const min = choices ? Math.max(0, qty - choices.unidentified) : 0;
  const max = Math.min(qty, units.length);
  const valid = !lotId || (!!choices && (!required || (picked.length >= min && picked.length <= max)));
  useEffect(() => { onChange({ required, valid, ids: picked }); }, [required, valid, picked, onChange]);
  if (!lotId) return null;
  if (failed) return <p className={`my-2 text-sm ${T.text2}`}>{loc('تعذّر تحميل قطع الدفعة. أعد المحاولة.', 'The lot’s pieces could not be loaded. Retry.', 'پارچەکانی وەجبەکە بارنەکران. دووبارە هەوڵ بدە.')}</p>;
  if (!choices || !units.length) return null;
  if (!required) return <p className={`my-2 text-xs ${T.text3}`}>{loc('تشمل العملية الدفعة كاملة مع كل قطعها المعرّفة.', 'This covers the whole lot with every identified piece in it.', 'ئەم کردارە هەموو وەجبەکە لەگەڵ هەموو پارچە ناسراوەکانی دەگرێتەوە.')}</p>;
  return <div className="inventory-line my-3">
    <h4 className={`mb-1 font-semibold ${T.text1}`}>{mode === 'move'
      ? loc('القطع التي نُقلت فعليًا', 'Pieces that actually moved', 'ئەو پارچانەی بەڕاستی گوازرانەوە')
      : loc('القطع المفقودة فعليًا', 'Pieces actually missing', 'ئەو پارچانەی بەڕاستی ون بوون')}</h4>
    <p className={`mb-2 text-xs ${T.text3}`}>{loc('طابق الرقم الداخلي المكتوب على كل كرتون. الوحدات القديمة غير المعرّفة تكمل الباقي.', 'Match the internal ID written on each box. Older unidentified units make up the rest.', 'ژمارەی ناوخۆیی سەر هەر کارتۆنێک بگونجێنە. یەکە کۆنە نەناسراوەکان ماوەکە پڕ دەکەنەوە.')}</p>
    <div className="grid gap-2">
      {units.map((u) => {
        const checked = picked.includes(u.id);
        return <label key={u.id} className="flex items-start gap-3 rounded-xl border border-current/10 p-3">
          <input type="checkbox" className="mt-1" checked={checked} disabled={!checked && picked.length >= max}
            onChange={(event) => setPicked((old) => event.target.checked ? [...old, u.id] : old.filter((id) => id !== u.id))}
            aria-label={`${loc('قطعة', 'Piece', 'پارچە')} ${u.unit_index} · ${u.id}`} />
          <span className="min-w-0 flex-1 space-y-1 text-sm">
            <strong className={`block ${T.text1}`}>{loc('قطعة', 'Piece', 'پارچە')} {u.unit_index}{u.serial_norm ? ` · ${u.serial_norm}` : ''}</strong>
            <span className={`block break-all ${T.text2}`}>{loc('الرقم الداخلي', 'Internal ID', 'ژمارەی ناوخۆیی')}: {u.id}</span>
            <span className={`block break-all ${T.text3}`}>{loc('طلب المورد', 'Supplier order', 'داواکاریی دابینکەر')}: {u.supplier_order_no || '—'} · {loc('التتبع', 'Tracking', 'بەدواداچوون')}: {u.tracking_no || '—'}</span>
          </span>
        </label>;
      })}
    </div>
    <p className={`mt-2 text-sm ${T.text2}`}>{loc('المحدد', 'Selected', 'هەڵبژێردراو')}: {picked.length} · {min === max
      ? `${loc('المطلوب', 'Required', 'پێویست')}: ${max}`
      : `${loc('المطلوب بين', 'Required between', 'پێویست لە نێوان')} ${min}–${max}`}</p>
  </div>;
}
