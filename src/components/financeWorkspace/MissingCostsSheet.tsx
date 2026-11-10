import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, PackagePlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Money, Sheet, Status } from './ui';
import { financeDay, WORKSPACE_API } from './types';

/**
 * «التكاليف الناقصة» — every delivered line of the period whose goods cost is not
 * confirmed, grouped by product and its size or colour (owner 2026-11-10: «الحساب
 * يحتاج مراجعة fix all them»). The owner types the purchase price of one piece
 * once; after he confirms, it is written to each of those lines through the same
 * per-line correction the order sheet uses (audited, versioned, recalculated).
 * Nothing is guessed: a sale-time estimate is shown as a hint only.
 */
type Line = { order_id: string; version: number; delivered_at: string | null; customer_name: string | null; line_id: string; product_id: string | null; name: string; option: string | null; color: string | null; qty: number; confidence: string; estimate_unit_iqd: number | null; cogs_iqd: number | null };
type Answer = { lines: Line[]; stocked: string[]; truncated: boolean };
type Group = { key: string; product_id: string | null; name: string; variant: string; lines: Line[]; qty: number; orders: number; estimates: number[] };

const INVENTORY_PURCHASES = '/admin?tab=inventory&itab=procurement';

export function groupMissing(lines: Line[]): Group[] {
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const variant = [l.option, l.color].filter(Boolean).join(' · ');
    const key = `${l.product_id ?? l.name}|${variant}`;
    const g = groups.get(key) ?? { key, product_id: l.product_id, name: l.name, variant, lines: [], qty: 0, orders: 0, estimates: [] };
    g.lines.push(l); g.qty += l.qty;
    if (l.estimate_unit_iqd != null && !g.estimates.includes(l.estimate_unit_iqd)) g.estimates.push(l.estimate_unit_iqd);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.orders = new Set(g.lines.map((l) => l.order_id)).size;
  // Lines with no cost at all first: they are what blanks the period's totals.
  return [...groups.values()].sort((a, b) => Number(b.lines.some((l) => l.cogs_iqd == null)) - Number(a.lines.some((l) => l.cogs_iqd == null)) || b.qty - a.qty);
}

export default function MissingCostsSheet({ from, to, onClose, onChanged, openOrder }: { from: string; to: string; onClose: () => void; onChanged: () => void; openOrder: (id: string, focus?: 'cost') => void }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    api.get<Answer>(`${WORKSPACE_API}/missing-costs?from=${from}&to=${to}`).then((r) => { if (active) setData(r); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [from, to, revision]);
  const groups = useMemo(() => groupMissing(data?.lines ?? []), [data]);
  const refresh = useCallback(() => { setRevision((v) => v + 1); onChanged(); }, [onChanged]);
  return <Sheet title={loc('التكاليف الناقصة', 'Missing costs', 'تێچووە کەمەکان')} subtitle={loc('كل بند مُسلَّم لم يُثبَّت سعر شرائه في هذه الفترة', 'Every delivered line in this period without a confirmed purchase price', 'هەموو بڕگەیەکی گەیەندراو لەم ماوەیەدا کە نرخی کڕینی جێگیر نەکراوە')} onClose={onClose}>
    {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</Button></div>}
    {!data && !error && <Loading text={loc('تحميل البنود الناقصة…', 'Loading missing lines…', 'بارکردنی بڕگە کەمەکان…')} />}
    {data && !groups.length && <p className="fw-success" role="status"><Check size={16} />{loc('كل تكاليف هذه الفترة مثبتة.', 'Every cost in this period is confirmed.', 'هەموو تێچووەکانی ئەم ماوەیە جێگیرکراون.')}</p>}
    {data && groups.length > 0 && <p className="fw-note">{loc('اكتب سعر شراء القطعة الواحدة مرة واحدة لكل منتج؛ بعد تأكيدك يُثبَّت على كل بنوده هنا ويُعاد حساب كل طلب (الربح وحصة المستثمر والأجور). التقدير المعروض تلميح فقط.', 'Type the purchase price of one piece once per product; after you confirm, it is set on each of its lines here and every order is recalculated (profit, investor share, wages). The estimate shown is only a hint.', 'نرخی کڕینی یەک پارچە یەک جار بۆ هەر بەرهەمێک بنووسە؛ دوای پشتڕاستکردنەوەت لەسەر هەموو بڕگەکانی لێرە جێگیر دەکرێت و هەموو داواکارییەک دووبارە حیساب دەکرێتەوە (قازانج، بەشی وەبەرهێنەر، کرێ). خەمڵاندنەکە تەنها ئاماژەیە.')}</p>}
    {groups.map((g, i) => {
      // The «no stock batch» note once per product, on its first size or colour.
      const first = groups.findIndex((x) => (x.product_id ?? x.name) === (g.product_id ?? g.name)) === i;
      return <MissingGroup key={g.key} g={g} stockNote={first && !(g.product_id && data!.stocked.includes(g.product_id))} onDone={refresh} openOrder={openOrder} />;
    })}
  </Sheet>;
}

function MissingGroup({ g, stockNote, onDone, openOrder }: { g: Group; stockNote: boolean; onDone: () => void; openOrder: (id: string, focus?: 'cost') => void }) {
  const { loc, lang } = useLanguage();
  const [price, setPrice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  const unit = Number(price);
  const valid = price.trim() !== '' && Number.isSafeInteger(unit) && unit >= 0;
  const noCost = g.lines.filter((l) => l.cogs_iqd == null).length;
  const apply = async () => {
    setBusy(true); setError(''); setDone(0);
    // One line at a time through the order's own correction; a second line of the same
    // order uses the version the first one returned.
    const versions = new Map<string, number>();
    try {
      for (const l of g.lines) {
        const result = await api.post<{ version?: number }>(`${WORKSPACE_API}/orders/${encodeURIComponent(l.order_id)}/adjustments`, {
          operation_id: `missingcost:${l.line_id}:${unit}`, field: 'cogs_iqd', value_iqd: unit * l.qty, line_id: l.line_id, version: versions.get(l.order_id) ?? l.version,
        });
        if (typeof result.version === 'number') versions.set(l.order_id, result.version);
        setDone((v) => v + 1);
      }
      setConfirming(false); onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); onDone(); }
    finally { setBusy(false); }
  };
  return <section className="fw-missing-group">
    <div className="fw-missing-head">
      <div className="min-w-0"><h3>{g.name}</h3>{g.variant && <p className="fw-muted">{g.variant}</p>}</div>
      {noCost > 0 ? <Status tone="warning">{loc('بلا سعر', 'No price', 'بێ نرخ')}</Status> : <Status>{loc('تقديري غير مثبت', 'Unconfirmed estimate', 'خەمڵاندنی جێگیرنەکراو')}</Status>}
    </div>
    <p className="fw-note">{loc('مُباع', 'Sold', 'فرۆشراو')} {g.qty} · {loc('في', 'in', 'لە')} {g.orders} {loc('طلبات', 'orders', 'داواکاری')}
      {g.estimates.length > 0 && <> · {loc('تقدير وقت البيع للقطعة', 'Sale-time estimate per piece', 'خەمڵاندنی کاتی فرۆشتن بۆ هەر پارچەیەک')}: {g.estimates.map((e, i) => <span key={e}>{i > 0 && ' – '}<Money value={e} /></span>)}</>}</p>
    {stockNote && <p className="fw-note"><PackagePlus size={14} aria-hidden="true" /> {loc('لا توجد دفعة مخزون مسعّرة لهذا المنتج، فلا يُحسب سعر مبيعاته القادمة أيضًا. سجّل شراءه في المخزون.', 'This product has no priced stock batch, so its next sales cannot cost themselves either. Record its purchase in Inventory.', 'ئەم بەرهەمە هیچ بارێکی کۆگای نرخدار نییە، بۆیە فرۆشتنەکانی داهاتووشی تێچوویان بۆ حیساب ناکرێت. کڕینەکەی لە کۆگا تۆمار بکە.')}{' '}
      <a className="fw-link" href={INVENTORY_PURCHASES}>{loc('سجّل الشراء في المخزون', 'Record the purchase in Inventory', 'کڕینەکە لە کۆگا تۆمار بکە')}</a></p>}
    <div className="fw-missing-price">
      <label className="fw-field"><span>{loc('سعر شراء القطعة الواحدة (د.ع)', 'Purchase price of one piece (IQD)', 'نرخی کڕینی یەک پارچە (د.ع)')}</span>
        <input className="fw-input" type="number" inputMode="numeric" min="0" step="1" value={price} disabled={busy} placeholder={g.estimates[0] != null ? String(g.estimates[0]) : ''}
          onChange={(e) => { setPrice(e.target.value); setConfirming(false); }} /></label>
      {!confirming ? <Button variant="primary" disabled={!valid || busy} onClick={() => setConfirming(true)}>{loc('طبّق على', 'Apply to', 'جێبەجێی بکە لەسەر')} {g.lines.length} {loc('بنود', 'lines', 'بڕگە')}</Button>
        : <div className="fw-confirm" role="alertdialog">
          <p>{loc('سيُثبَّت', 'This sets', 'ئەمە دادەنێت')} <Money value={unit} /> {loc('للقطعة على', 'per piece on', 'بۆ هەر پارچەیەک لەسەر')} {g.lines.length} {loc('بنود في', 'lines in', 'بڕگە لە')} {g.orders} {loc('طلبات، ويُعاد حساب كل طلب.', 'orders, and each order is recalculated.', 'داواکاری، و هەر داواکارییەک دووبارە حیساب دەکرێتەوە.')}</p>
          <div className="fw-list"><Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</Button>
            <Button variant="primary" busy={busy} onClick={() => void apply()}><Check size={16} />{loc('تأكيد السعر', 'Confirm the price', 'نرخەکە پشتڕاست بکەرەوە')}</Button></div>
        </div>}
      {busy && <p className="fw-note" role="status">{done} / {g.lines.length}</p>}
      {error && <p className="fw-error" role="alert">{error}</p>}
    </div>
    <details className="fw-advanced"><summary>{loc('البنود', 'Lines', 'بڕگەکان')} ({g.lines.length})</summary>
      {g.lines.map((l) => <div className="fw-row" key={l.line_id}>
        <button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(l.order_id, 'cost')}>{l.order_id}</button>
        <span className="fw-muted">{l.delivered_at ? financeDay(l.delivered_at) : ''} · {l.qty} {loc('قطعة', 'pcs', 'پارچە')}{l.customer_name ? ` · ${l.customer_name}` : ''}</span>
        <span>{l.cogs_iqd == null ? loc('بلا سعر', 'No price', 'بێ نرخ') : <Money value={l.cogs_iqd} />}</span>
      </div>)}
      <p className="fw-muted">{lang === 'en' ? 'Open an order to set a different price for that line only.' : lang === 'ckb' ? 'داواکارییەک بکەرەوە بۆ دانانی نرخێکی جیاواز تەنها بۆ ئەو بڕگەیە.' : 'افتح الطلب لتضع سعرًا مختلفًا لذلك البند وحده.'}</p>
    </details>
  </section>;
}
