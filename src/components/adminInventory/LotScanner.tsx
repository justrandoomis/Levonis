import { useState } from 'react';
import { ScanLine } from 'lucide-react';
import { api, Input, STOCK, T, useLabels, useOperation, type Selection } from '../adminOperations/shared';

export type ScannedLot = { id: string; product_id?: string; scope?: string; scope_id?: string; name?: string; name_ar?: string; qty_remaining?: number };
export type ScanResult = { lot: ScannedLot | null; serial: unknown; match: boolean };

/** A USB/Bluetooth reader types into this field and submits with Enter. The
 * server resolves the label and validates the exact selected variant. */
export default function LotScanner({ onScanned, selection, orderItemId }: { onScanned: (result: ScanResult) => void; selection?: Pick<Selection, 'product_id' | 'scope' | 'scope_id'> | null; orderItemId?: string }) {
  const { loc } = useLabels();
  const [code, setCode] = useState('');
  const op = useOperation();
  return <div className="mb-4">
    {op.feedback}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!code.trim() || op.busy) return; op.run(async () => {
      const result = await api.post<ScanResult>(`${STOCK}/scan`, { code: code.trim(), ...(selection ? { product_id: selection.product_id, scope: selection.scope, scope_id: selection.scope_id } : {}), ...(orderItemId ? { order_item_id: orderItemId } : {}) });
      if (result.match === false) throw new Error(loc('الرمز لا يطابق المنتج أو بند الطلب المحدد', 'The label does not match the selected item or order line', 'کۆدەکە لەگەڵ بەرهەمەکە یان بەندی داواکارییە دیاریکراوەکە ناگونجێت'));
      onScanned(result); setCode('');
    }, loc('تم التحقق من الرمز', 'Label verified', 'کۆدەکە پشکنرا')); }}>
      <div className="min-w-0 flex-1"><Input label={loc('مسح باركود الدفعة أو رقم الجهاز', 'Scan lot barcode or device serial', 'بارکۆدی وەجبە یان ژمارەی ئامێر سکان بکە')} value={code} onChange={setCode} hint={loc('امسح بالقارئ أو الصق الرمز، ثم اضغط تحقق', 'Use a scanner or paste the code, then verify', 'بە خوێنەرەوە سکان بکە یان کۆدەکە بلکێنە، پاشان پشکنین دابگرە')} /></div>
      <button type="submit" className={T.btnSecondary} disabled={op.busy || !code.trim()}><ScanLine size={15} aria-hidden />{loc('تحقق', 'Verify', 'پشکنین')}</button>
    </form>
  </div>;
}
