import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, PackagePlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Money, Sheet, Status } from './ui';
import { financeDay, WORKSPACE_API } from './types';

/**
 * «التكاليف الناقصة» — every delivered line of the period whose goods cost is not
 * confirmed, grouped by product and its size or colour (owner 2026-11-10: «الحساب
 * يحتاج مراجعة fix all them»). The owner types the purchase price of one piece
 * once; after he confirms, POST /missing-costs/lines prices each line: the server
 * multiplies it by the pieces the customer kept (a return put back in stock is not
 * a cost of the sale) and writes it through the order's own correction (audited,
 * versioned, recalculated) as the line's cost itself, never as a change to its
 * estimate. A line with pieces from a stock batch is priced in its order instead. Nothing is
 * guessed: a sale-time estimate is shown as a hint only.
 */
type Line = { order_id: string; version: number; delivered_at: string | null; customer_name: string | null; line_id: string; product_id: string | null; name: string; option: string | null; color: string | null; qty: number;
  /** Absent from a server that predates them. */
  restocked_qty?: number; cost_qty?: number; stock_qty?: number;
  confidence: string; estimate_unit_iqd: number | null; cogs_iqd: number | null };
type Answer = { lines: Line[]; stocked: string[]; truncated: boolean };
type Group = { key: string; product_id: string | null; name: string; variant: string; lines: Line[]; ready: Line[]; stock: Line[]; qty: number; returned: number; orders: number; estimates: number[] };
type OpenOrder = (id: string, focus?: 'cost', lineId?: string) => void;
type Applied = { pending: string[] };

const INVENTORY_PURCHASES = '/admin?tab=inventory&itab=procurement';
/** The pieces a line's goods cost covers: the ones the customer kept. */
export const costQty = (l: Line) => l.cost_qty ?? Math.max(0, l.qty - (l.restocked_qty ?? 0));
/** A product name inside a sentence of the other direction keeps its own. */
const isolate = (text: string) => `⁨${text}⁩`;

export function groupMissing(lines: Line[]): Group[] {
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const variant = [l.option, l.color].filter(Boolean).join(' · ');
    const key = `${l.product_id ?? l.name}|${variant}`;
    const g = groups.get(key) ?? { key, product_id: l.product_id, name: l.name, variant, lines: [], ready: [], stock: [], qty: 0, returned: 0, orders: 0, estimates: [] };
    g.lines.push(l); (l.stock_qty ? g.stock : g.ready).push(l);
    g.qty += costQty(l); g.returned += l.restocked_qty ?? 0;
    if (l.estimate_unit_iqd != null && !g.estimates.includes(l.estimate_unit_iqd)) g.estimates.push(l.estimate_unit_iqd);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.orders = new Set(g.lines.map((l) => l.order_id)).size;
  // Lines with no cost at all first: they are what blanks the period's totals.
  return [...groups.values()].sort((a, b) => Number(b.lines.some((l) => l.cogs_iqd == null)) - Number(a.lines.some((l) => l.cogs_iqd == null)) || b.qty - a.qty);
}

export default function MissingCostsSheet({ from, to, onClose, onChanged, openOrder }: { from: string; to: string; onClose: () => void; onChanged: () => void; openOrder: OpenOrder }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  // While one group is written, and until the list read after it arrives, the others wait:
  // two groups can share an order, and the list they were typed against is about to change.
  const [running, setRunning] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    setError('');
    api.get<Answer>(`${WORKSPACE_API}/missing-costs?from=${from}&to=${to}`).then((r) => { if (active) { setData(r); setStale(false); } }).catch((e) => { if (active) { setError(e instanceof Error ? e.message : String(e)); setStale(false); } });
    return () => { active = false; };
  }, [from, to, revision]);
  const groups = useMemo(() => groupMissing(data?.lines ?? []), [data]);
  const finished = useCallback((applied: Applied) => {
    setRunning(null); setStale(true); setPending(applied.pending);
    setRevision((v) => v + 1); onChanged();
  }, [onChanged]);
  return <Sheet title={loc('التكاليف الناقصة', 'Missing costs', 'تێچووە کەمەکان')} subtitle={loc('كل بند مُسلَّم لم تُثبَّت تكلفة بضاعته في هذه الفترة', 'Every delivered line in this period without a confirmed goods cost', 'هەموو بڕگەیەکی گەیەندراو لەم ماوەیەدا کە تێچووی کاڵاکەی جێگیر نەکراوە')} onClose={onClose}>
    {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</Button></div>}
    {!data && !error && <Loading text={loc('تحميل البنود الناقصة…', 'Loading missing lines…', 'بارکردنی بڕگە کەمەکان…')} />}
    {pending.length > 0 && <p className="fw-note" role="status">{loc('حُفظ السعر. لم يكتمل حساب هذه الطلبات بعد — في بعضها منتج آخر ما زالت تكلفته ناقصة:', 'Price saved. These orders are not complete yet — some still have another product without a confirmed cost:', 'نرخەکە پاشەکەوت کرا. حیسابی ئەم داواکاریانە هێشتا تەواو نەبووە — لە هەندێکیاندا بەرهەمێکی تر هێشتا تێچووەکەی کەمە:')}{' '}
      {pending.map((id, i) => <span key={id}>{i > 0 && ' · '}<button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(id, 'cost')}>{id}</button></span>)}</p>}
    {data && !groups.length && <p className="fw-success" role="status"><Check size={16} />{loc('كل تكاليف البضاعة في هذه الفترة مثبتة.', 'Every goods cost in this period is confirmed.', 'هەموو تێچووی کاڵاکانی ئەم ماوەیە جێگیرکراون.')}</p>}
    {data && groups.length > 0 && <p className="fw-note">{loc('اكتب سعر شراء القطعة الواحدة مرة واحدة لكل منتج؛ بعد تأكيدك يُثبَّت على بنوده هنا لكل قطعة احتفظ بها الزبون (المُرجَع إلى المخزون لا يُحسب) ويُعاد حساب كل طلب: الربح وحصة المستثمر والأجور. التقدير المعروض تلميح فقط، والسعر المثبت يبقى حتى تغيّره من الطلب.', 'Type the purchase price of one piece once per product; after you confirm, it is set on its lines here for every piece the customer kept (a return put back in stock does not count) and every order is recalculated: profit, investor share, wages. The estimate shown is only a hint; the confirmed price stays until you change it in the order.', 'نرخی کڕینی یەک پارچە یەک جار بۆ هەر بەرهەمێک بنووسە؛ دوای پشتڕاستکردنەوەت لەسەر بڕگەکانی لێرە بۆ هەر پارچەیەک کە کڕیار هێشتوویەتەوە جێگیر دەکرێت (ئەوەی گەڕێندراوەتەوە کۆگا حیساب ناکرێت) و هەموو داواکارییەک دووبارە حیساب دەکرێتەوە: قازانج، بەشی وەبەرهێنەر، کرێ. خەمڵاندنەکە تەنها ئاماژەیە، و نرخی جێگیرکراو دەمێنێتەوە تا لە داواکارییەکەدا دەیگۆڕیت.')}</p>}
    {groups.map((g, i) => {
      // The «no priced stock batch» note once per product, on its first size or colour.
      const first = groups.findIndex((x) => (x.product_id ?? x.name) === (g.product_id ?? g.name)) === i;
      return <MissingGroup key={g.key} g={g} stockNote={first && !(g.product_id && data!.stocked.includes(g.product_id))} locked={stale || (running !== null && running !== g.key)}
        onStart={() => setRunning(g.key)} onDone={finished} openOrder={openOrder} />;
    })}
  </Sheet>;
}

function MissingGroup({ g, stockNote, locked, onStart, onDone, openOrder }: { g: Group; stockNote: boolean; locked: boolean; onStart: () => void; onDone: (applied: Applied) => void; openOrder: OpenOrder }) {
  const { loc, lang } = useLanguage();
  const [price, setPrice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  const confirmId = useId();
  const confirmButton = useRef<HTMLDivElement>(null);
  useEffect(() => { if (confirming) confirmButton.current?.querySelector<HTMLButtonElement>('button:last-child')?.focus(); }, [confirming]);
  const unit = Number(price);
  const valid = price.trim() !== '' && Number.isSafeInteger(unit) && unit >= 0;
  const noCost = g.lines.filter((l) => l.cogs_iqd == null).length;
  const pieces = g.ready.reduce((v, l) => v + costQty(l), 0);
  const orders = new Set(g.ready.map((l) => l.order_id)).size;
  const refusal = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === 'MISSING_COST_LINE_CHANGED') return loc('تغيّرت قطع أحد البنود منذ فُتحت القائمة (مرتجع جديد مثلًا). حُدِّثت القائمة: راجعها ثم أكّد من جديد.', 'A line\'s pieces changed since the list was opened (a new return, say). The list has been refreshed: review it and confirm again.', 'پارچەکانی بڕگەیەک گۆڕان لەو کاتەوەی لیستەکە کرایەوە (بۆ نموونە گەڕاندنەوەیەکی نوێ). لیستەکە نوێ کرایەوە: پێداچوونەوەی بۆ بکە و دووبارە پشتڕاستی بکەرەوە.');
    if (code === 'MISSING_COST_HAS_STOCK') return loc('في أحد البنود قطع من دفعة مخزون؛ ثبّت تكلفته من الطلب نفسه.', 'One line has pieces from a stock batch; set its cost in the order itself.', 'بڕگەیەک پارچەی لە بارێکی کۆگا تێدایە؛ تێچووەکەی لە خودی داواکارییەکەدا جێگیر بکە.');
    if (code === 'RATE_LIMITED') return loc('طلبات كثيرة خلال ساعة؛ أكمل لاحقًا — ما حُفظ يبقى محفوظًا.', 'Too many requests this hour; finish later — what was saved stays saved.', 'داواکاری زۆر لەم کاتژمێرەدا؛ دواتر تەواوی بکە — ئەوەی پاشەکەوت کراوە دەمێنێتەوە.');
    return e instanceof Error ? e.message : String(e);
  };
  const apply = async () => {
    setBusy(true); setError(''); setDone(0); onStart();
    const pending = new Set<string>();
    try {
      // One line per request: the server prices the pieces the customer kept and reads
      // each order's version itself, so lines of one order follow each other safely.
      for (const l of g.ready) {
        const result = await api.post<{ reconciliation_pending?: boolean }>(`${WORKSPACE_API}/missing-costs/lines`, {
          operation_id: `missingcost:${l.line_id}:${unit}:${costQty(l)}`, order_id: l.order_id, line_id: l.line_id, unit_iqd: unit, cost_qty: costQty(l),
        });
        if (result.reconciliation_pending) pending.add(l.order_id);
        setDone((v) => v + 1);
      }
      setConfirming(false);
    } catch (e) { setError(refusal(e)); }
    finally { setBusy(false); onDone({ pending: [...pending] }); }
  };
  const count = (label: string, n: number) => <>{label}: {n}</>;
  return <section className="fw-missing-group">
    <div className="fw-missing-head">
      <div className="min-w-0"><h3>{g.name}</h3>{g.variant && <p className="fw-muted">{g.variant}</p>}</div>
      {noCost > 0 ? <Status tone="warning">{loc('بلا سعر', 'No price', 'بێ نرخ')}</Status> : <Status>{loc('تقديري غير مثبت', 'Unconfirmed estimate', 'خەمڵاندنی جێگیرنەکراو')}</Status>}
    </div>
    <p className="fw-note">{count(loc('القطع المُباعة', 'Pieces sold', 'پارچەی فرۆشراو'), g.qty)} · {count(loc('الطلبات', 'Orders', 'داواکارییەکان'), g.orders)}
      {g.returned > 0 && <> · {count(loc('أُرجعت إلى المخزون (لا تُحسب)', 'Returned to stock (not counted)', 'گەڕێندرایەوە کۆگا (حیساب ناکرێت)'), g.returned)}</>}
      {g.estimates.length > 0 && <> · {loc('تقدير وقت البيع للقطعة', 'Sale-time estimate per piece', 'خەمڵاندنی کاتی فرۆشتن بۆ هەر پارچەیەک')}: {g.estimates.map((e, i) => <span key={e}>{i > 0 && ' – '}<Money value={e} /></span>)}</>}</p>
    {stockNote && <p className="fw-note"><PackagePlus size={14} aria-hidden="true" /> {loc('لا توجد دفعة مخزون مسعّرة لهذا المنتج، فلا تُحسب تكلفة مبيعاته القادمة أيضًا. سجّل شراءه في المخزون.', 'This product has no priced stock batch, so its next sales cannot cost themselves either. Record its purchase in Inventory.', 'ئەم بەرهەمە هیچ بارێکی کۆگای نرخدار نییە، بۆیە تێچووی فرۆشتنەکانی داهاتووشی حیساب ناکرێت. کڕینەکەی لە کۆگا تۆمار بکە.')}{' '}
      <a className="fw-link" href={INVENTORY_PURCHASES}>{loc('سجّل الشراء في المخزون', 'Record the purchase in Inventory', 'کڕینەکە لە کۆگا تۆمار بکە')}</a></p>}
    {g.stock.length > 0 && <p className="fw-note">{loc('بنود فيها قطع من دفعة مخزون تُثبَّت من طلبها، لأن تكلفة تلك القطع معروفة', 'Lines with pieces from a stock batch are set in their order, because those pieces\' cost is known', 'ئەو بڕگانەی پارچەیان لە بارێکی کۆگا تێدایە لە داواکارییەکەیانەوە جێگیر دەکرێن، چونکە تێچووی ئەو پارچانە زانراوە')}: {g.stock.length}</p>}
    {g.ready.length > 0 && <div className="fw-missing-price">
      <label className="fw-field"><span>{loc('سعر شراء القطعة الواحدة (د.ع)', 'Purchase price of one piece (IQD)', 'نرخی کڕینی یەک پارچە (د.ع)')}</span>
        <input className="fw-input" type="number" inputMode="numeric" min="0" step="1" value={price} disabled={busy || locked} placeholder={g.estimates[0] != null ? String(g.estimates[0]) : ''}
          onChange={(e) => { setPrice(e.target.value); setConfirming(false); }} /></label>
      {!confirming ? <Button variant="primary" disabled={!valid || busy || locked} onClick={() => setConfirming(true)}>{loc('طبّق على البنود', 'Apply to the lines', 'جێبەجێی بکە لەسەر بڕگەکان')} ({g.ready.length})</Button>
        : <div className="fw-confirm" role="alertdialog" aria-labelledby={confirmId} ref={confirmButton}>
          <p id={confirmId}>{loc('سعر القطعة', 'Price per piece', 'نرخی هەر پارچەیەک')} <Money value={unit} />. {count(loc('البنود', 'Lines', 'بڕگەکان'), g.ready.length)} · {count(loc('القطع المحسوبة', 'Pieces costed', 'پارچە حیسابکراوەکان'), pieces)} · {count(loc('الطلبات', 'Orders', 'داواکارییەکان'), orders)} · {loc('مجموع تكلفة البضاعة', 'Total goods cost', 'کۆی تێچووی کاڵا')} <Money value={unit * pieces} />. {loc('يُعاد حساب كل طلب.', 'Each order is recalculated.', 'هەر داواکارییەک دووبارە حیساب دەکرێتەوە.')}</p>
          <div className="fw-list"><Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</Button>
            <Button variant="primary" busy={busy} disabled={locked} onClick={() => void apply()}><Check size={16} />{loc('تأكيد السعر', 'Confirm the price', 'نرخەکە پشتڕاست بکەرەوە')}</Button></div>
        </div>}
      {busy && <p className="fw-note" role="status">{done} / {g.ready.length}</p>}
      {error && <p className="fw-error" role="alert">{error}</p>}
    </div>}
    <details className="fw-advanced"><summary>{loc('البنود', 'Lines', 'بڕگەکان')} ({g.lines.length})</summary>
      {g.lines.map((l) => <div className="fw-row" key={l.line_id}>
        <button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(l.order_id, 'cost', l.line_id)}>{l.order_id}</button>
        <span className="fw-muted">{l.delivered_at ? financeDay(l.delivered_at) : ''} · {count(loc('القطع', 'Pieces', 'پارچەکان'), costQty(l))}{l.restocked_qty ? <> ({count(loc('أُرجع', 'returned', 'گەڕێندرایەوە'), l.restocked_qty)})</> : null}{l.customer_name ? <> · {isolate(l.customer_name)}</> : null}{l.stock_qty ? <> · {loc('من دفعة مخزون: ثبّته من الطلب', 'From a stock batch: set it in the order', 'لە بارێکی کۆگاوە: لە داواکارییەکەدا جێگیری بکە')}</> : null}</span>
        <span>{l.cogs_iqd == null ? loc('بلا سعر', 'No price', 'بێ نرخ') : <Money value={l.cogs_iqd} />}</span>
      </div>)}
      <p className="fw-muted">{lang === 'en' ? 'Open an order to set a different cost for that line only.' : lang === 'ckb' ? 'داواکارییەک بکەرەوە بۆ دانانی تێچوویەکی جیاواز تەنها بۆ ئەو بڕگەیە.' : 'افتح الطلب لتضع تكلفة مختلفة لذلك البند وحده.'}</p>
    </details>
  </section>;
}
