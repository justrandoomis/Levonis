import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, PackagePlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Money, Sheet, Surface } from './ui';
import { financeDay, WORKSPACE_API } from './types';
import { counted, cs } from './costsStrings';
import { estimateRange, rangeFigures } from './costFigures';

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
  restocked_qty?: number; cost_qty?: number; stock_qty?: number; preorder?: boolean;
  confidence: string; estimate_unit_iqd: number | null; cogs_iqd: number | null };
type Answer = { lines: Line[]; stocked: string[]; truncated: boolean };
/** `ready`: priced from here. `stock` (pieces from a stock batch) and `preorder` (a batch to link): priced in their order. */
type Group = { key: string; product_id: string | null; name: string; variant: string; lines: Line[]; ready: Line[]; stock: Line[]; preorder: Line[]; qty: number; returned: number; orders: number; estimates: number[] };
type OpenOrder = (id: string, focus?: 'cost', lineId?: string) => void;
/** After one group: the orders still waiting, and those of the group that are now complete. */
type Applied = { pending: string[]; cleared: string[] };

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
    const g = groups.get(key) ?? { key, product_id: l.product_id, name: l.name, variant, lines: [], ready: [], stock: [], preorder: [], qty: 0, returned: 0, orders: 0, estimates: [] };
    g.lines.push(l); (l.stock_qty ? g.stock : l.preorder ? g.preorder : g.ready).push(l);
    g.qty += costQty(l); g.returned += l.restocked_qty ?? 0;
    if (l.estimate_unit_iqd != null && !g.estimates.includes(l.estimate_unit_iqd)) g.estimates.push(l.estimate_unit_iqd);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.orders = new Set(g.lines.map((l) => l.order_id)).size;
  // Lines with no cost at all first: they are what blanks the period's totals.
  return [...groups.values()].sort((a, b) => Number(b.lines.some((l) => l.cogs_iqd == null)) - Number(a.lines.some((l) => l.cogs_iqd == null)) || b.qty - a.qty);
}

/**
 * `inline`: the same list as a page of «التكاليف» (redesign step 2) instead of a sheet over the overview.
 * `reload`: read the list again when it changes — the page stays open (and is kept while hidden) when the
 * owner prices a line in its order's sheet, so the workspace bumps it when such a sheet closes after a save.
 */
export default function MissingCostsSheet({ from, to, onClose, onChanged, openOrder, inline = false, reload = 0 }: { from: string; to: string; onClose: () => void; onChanged: () => void; openOrder: OpenOrder; inline?: boolean; reload?: number }) {
  const { loc, lang } = useLanguage();
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
  }, [from, to, revision, reload]);
  const groups = useMemo(() => groupMissing(data?.lines ?? []), [data]);
  const finished = useCallback((applied: Applied) => {
    // Orders still waiting from earlier groups stay named until a later group completes them.
    setRunning(null); setStale(true);
    setPending((before) => [...new Set([...before.filter((id) => !applied.cleared.includes(id)), ...applied.pending])]);
    setRevision((v) => v + 1); onChanged();
  }, [onChanged]);
  // Redesign step 5 (DECISIONS row 317), the mockup's page: «n بندًا بلا تكلفة مؤكدة» (each count agreeing with its noun), one
  // line saying nothing is saved before the owner confirms, a card per product and size or colour, and the way to stop it
  // happening again at the foot.
  const listed = !!data && groups.length > 0;
  const title = listed ? counted(lang, 'missingHead', data!.lines.length) : loc('التكاليف الناقصة', 'Missing costs', 'تێچووە کەمەکان');
  const subtitle = listed ? cs(loc, 'missSub') : loc('كل بند مُسلَّم لم تُثبَّت تكلفة بضاعته في هذه الفترة', 'Every delivered line in this period without a confirmed goods cost', 'هەموو بڕگەیەکی گەیەندراو لەم ماوەیەدا کە تێچووی کاڵاکەی جێگیر نەکراوە');
  const body = <>
    {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</Button></div>}
    {!data && !error && <Loading text={loc('تحميل البنود الناقصة…', 'Loading missing lines…', 'بارکردنی بڕگە کەمەکان…')} />}
    {pending.length > 0 && <p className="fw-note" role="status">{loc('حُفظ السعر، لكن حساب هذه الطلبات لم يكتمل بعد؛ افتح كل طلب لترى ما ينتظره (منتج آخر بلا تكلفة مثبتة، أو تسوية لم تكتمل):', 'Price saved, but these orders are not complete yet; open each to see what it is waiting for (another product without a confirmed cost, or a settlement not finished):', 'نرخەکە پاشەکەوت کرا، بەڵام حیسابی ئەم داواکاریانە هێشتا تەواو نەبووە؛ هەر داواکارییەک بکەرەوە بۆ ئەوەی ببینیت چاوەڕێی چییە (بەرهەمێکی تر بێ تێچووی جێگیر، یان ڕێکخستنێکی تەواونەبوو):')}{' '}
      {pending.map((id, i) => <span key={id}>{i > 0 && ' · '}<button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(id, 'cost')}>{id}</button></span>)}</p>}
    {data && !groups.length && <p className="fw-success" role="status"><Check size={16} />{loc('كل تكاليف البضاعة في هذه الفترة مثبتة.', 'Every goods cost in this period is confirmed.', 'هەموو تێچووی کاڵاکانی ئەم ماوەیە جێگیرکراون.')}</p>}
    {groups.map((g, i) => {
      // The «no priced stock batch» note once per product, on its first size or colour.
      const first = groups.findIndex((x) => (x.product_id ?? x.name) === (g.product_id ?? g.name)) === i;
      return <MissingGroup key={g.key} g={g} stockNote={first && !(g.product_id && data!.stocked.includes(g.product_id))} locked={stale || (running !== null && running !== g.key)}
        onStart={() => setRunning(g.key)} onDone={finished} openOrder={openOrder} />;
    })}
    {listed && <p className="fw-note" data-finance-missing-footer><PackagePlus size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px' }} /> <a className="fw-link" href={INVENTORY_PURCHASES}>{cs(loc, 'missRecordStock')}</a></p>}
  </>;
  return inline ? <Surface title={title} subtitle={subtitle}><div className="fw-missing-page" data-finance-missing-page>{body}</div></Surface> : <Sheet title={title} subtitle={subtitle} onClose={onClose}>{body}</Sheet>;
}

export function MissingGroup({ g, stockNote, locked, onStart, onDone, openOrder }: { g: Group; stockNote: boolean; locked: boolean; onStart: () => void; onDone: (applied: Applied) => void; openOrder: OpenOrder }) {
  const { loc, lang } = useLanguage();
  const [price, setPrice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  const confirmId = useId();
  const confirmButton = useRef<HTMLDivElement>(null);
  const reviewBox = useRef<HTMLDivElement>(null);
  const reviewed = useRef(false);
  // The confirmation opens on its sentence, never on «تأكيد السعر»: a second Enter on «راجِع وثبّت» confirms nothing unread.
  // Closed, focus goes back to «راجِع وثبّت» (the independent review of step 5).
  useEffect(() => {
    if (confirming) { reviewed.current = true; confirmButton.current?.querySelector<HTMLElement>('p')?.focus(); }
    else if (reviewed.current) { reviewed.current = false; reviewBox.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
  }, [confirming]);
  const unit = Number(price);
  const valid = price.trim() !== '' && Number.isSafeInteger(unit) && unit >= 0;
  const noCost = g.lines.filter((l) => l.cogs_iqd == null).length;
  const pieces = g.ready.reduce((v, l) => v + costQty(l), 0);
  const orders = new Set(g.ready.map((l) => l.order_id)).size;
  const refusal = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === 'MISSING_COST_LINE_CHANGED') return loc('تغيّرت قطع أحد البنود منذ فُتحت القائمة (مرتجع جديد مثلًا). حُدِّثت القائمة: راجعها ثم أكّد من جديد.', 'A line\'s pieces changed since the list was opened (a new return, say). The list has been refreshed: review it and confirm again.', 'پارچەکانی بڕگەیەک گۆڕان لەو کاتەوەی لیستەکە کرایەوە (بۆ نموونە گەڕاندنەوەیەکی نوێ). لیستەکە نوێ کرایەوە: پێداچوونەوەی بۆ بکە و دووبارە پشتڕاستی بکەرەوە.');
    if (code === 'MISSING_COST_HAS_STOCK') return loc('في أحد البنود قطع من دفعة مخزون؛ ثبّت تكلفته من الطلب نفسه.', 'One line has pieces from a stock batch; set its cost in the order itself.', 'بڕگەیەک پارچەی لە بارێکی کۆگا تێدایە؛ تێچووەکەی لە خودی داواکارییەکەدا جێگیر بکە.');
    if (code === 'MISSING_COST_PREORDER') return loc('أحد البنود من طلب مسبق؛ اربط دفعته الواصلة من الطلب نفسه لتُحسب تكلفته الفعلية.', 'One line is from a pre-order; link its arrived batch in the order itself to get its actual cost.', 'بڕگەیەک لە داواکارییەکی پێشوەختەیە؛ بارە گەیشتووەکەی لە خودی داواکارییەکەدا ببەستەرەوە بۆ ئەوەی تێچووی ڕاستەقینەی حیساب بکرێت.');
    if (code === 'RATE_LIMITED') return loc('طلبات كثيرة خلال ساعة؛ أكمل لاحقًا — ما حُفظ يبقى محفوظًا.', 'Too many requests this hour; finish later — what was saved stays saved.', 'داواکاری زۆر لەم کاتژمێرەدا؛ دواتر تەواوی بکە — ئەوەی پاشەکەوت کراوە دەمێنێتەوە.');
    return e instanceof Error ? e.message : String(e);
  };
  const apply = async () => {
    setBusy(true); setError(''); setDone(0); onStart();
    // An order is named as waiting if any of its lines answered so; it is complete only if none did.
    const pending = new Set<string>(), answered = new Set<string>();
    try {
      // One line per request: the server prices the pieces the customer kept and reads
      // each order's version itself, so lines of one order follow each other safely.
      for (const l of g.ready) {
        const result = await api.post<{ reconciliation_pending?: boolean; skipped?: boolean }>(`${WORKSPACE_API}/missing-costs/lines`, {
          operation_id: `missingcost:${l.line_id}:${unit}:${costQty(l)}`, order_id: l.order_id, line_id: l.line_id, unit_iqd: unit, cost_qty: costQty(l),
        });
        if (!result.skipped) answered.add(l.order_id);
        if (result.reconciliation_pending) pending.add(l.order_id);
        setDone((v) => v + 1);
      }
      setConfirming(false);
    } catch (e) { setError(refusal(e)); }
    finally { setBusy(false); onDone({ pending: [...pending], cleared: [...answered].filter((id) => !pending.has(id)) }); }
  };
  const count = (label: string, n: number) => <>{label}: {n}</>;
  // The mockup's card (redesign step 5): name · size or colour; lines, pieces kept and orders; the sale-time estimate per piece
  // as a range, or «لا تقدير ولا سعر» in red; the price field and «راجِع وثبّت» beside it — under it on a phone. A card whose
  // lines are partly estimated still names the ones with neither, in red (the independent review of step 5): they blank
  // their orders' net whatever the others' estimate says.
  const range = estimateRange(g.estimates);
  return <section className="fw-missing-group" data-finance-missing-group={g.key}>
    <div className="fw-missing-head">
      <h3>{g.name}{g.variant && <span className="fw-muted"> · {g.variant}</span>}</h3>
      <p className="fw-missing-meta"><span>{counted(lang, 'lines', g.lines.length)}</span><span>{counted(lang, 'pieces', g.qty)}</span><span>{counted(lang, 'orders', g.orders)}</span>
        {g.returned > 0 && <span>{count(loc('أُرجعت إلى المخزون (لا تُحسب)', 'Returned to stock (not counted)', 'گەڕێندرایەوە کۆگا (حیساب ناکرێت)'), g.returned)}</span>}
        {range ? <span data-finance-missing-estimate>{cs(loc, 'missEstimate', { range: '' })}<bdi dir="ltr" className="fw-num">{rangeFigures(range)} د.ع</bdi></span>
          : noCost > 0 ? <b className="fw-neg" data-finance-missing-estimate="none">{cs(loc, 'missNoEstimate')}</b> : <span>{cs(loc, 'missSnapshot')}</span>}
        {range && noCost > 0 && <b className="fw-neg" data-finance-missing-estimate="some-none">{counted(lang, 'linesNoPrice', noCost)}</b>}</p>
    </div>
    {g.ready.length > 0 && <div className="fw-fields" ref={reviewBox}>
      <label className="fw-field"><span>{cs(loc, 'missPerPiece')}</span>
        <input className="fw-input" type="number" inputMode="numeric" min="0" step="1" value={price} disabled={busy || locked} placeholder={range ? String(range.min) : ''}
          onChange={(e) => { setPrice(e.target.value); setConfirming(false); }} /></label>
      {!confirming && <Button variant="primary" disabled={!valid || busy || locked} onClick={() => setConfirming(true)}>{cs(loc, 'missReview')}</Button>}
    </div>}
    {g.ready.length > 0 && confirming && <div className="fw-confirm" role="alertdialog" aria-labelledby={confirmId} ref={confirmButton}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setConfirming(false); } }}>
      <p id={confirmId} tabIndex={-1}>{loc('سعر القطعة', 'Price per piece', 'نرخی هەر پارچەیەک')} <Money value={unit} />. {count(loc('البنود', 'Lines', 'بڕگەکان'), g.ready.length)} · {count(loc('القطع المحسوبة', 'Pieces costed', 'پارچە حیسابکراوەکان'), pieces)} · {count(loc('الطلبات', 'Orders', 'داواکارییەکان'), orders)} · {loc('مجموع تكلفة البضاعة', 'Total goods cost', 'کۆی تێچووی کاڵا')} <Money value={unit * pieces} />. {loc('يُعاد حساب كل طلب.', 'Each order is recalculated.', 'هەر داواکارییەک دووبارە حیساب دەکرێتەوە.')}</p>
      <div className="fw-fields"><Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</Button>
        <Button variant="primary" busy={busy} disabled={locked} onClick={() => void apply()}><Check size={16} />{loc('تأكيد السعر', 'Confirm the price', 'نرخەکە پشتڕاست بکەرەوە')}</Button></div>
    </div>}
    {busy && <p className="fw-note" role="status">{done} / {g.ready.length}</p>}
    {error && <p className="fw-error" role="alert">{error}</p>}
    {stockNote && <p className="fw-note"><PackagePlus size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px' }} /> {loc('لا توجد دفعة مخزون مسعّرة لهذا المنتج، فلا تُحسب تكلفة مبيعاته القادمة أيضًا. سجّل شراءه في المخزون.', 'This product has no priced stock batch, so its next sales cannot cost themselves either. Record its purchase in Inventory.', 'ئەم بەرهەمە هیچ بارێکی کۆگای نرخدار نییە، بۆیە تێچووی فرۆشتنەکانی داهاتووشی حیساب ناکرێت. کڕینەکەی لە کۆگا تۆمار بکە.')}{' '}
      <a className="fw-link" href={INVENTORY_PURCHASES}>{loc('سجّل الشراء في المخزون', 'Record the purchase in Inventory', 'کڕینەکە لە کۆگا تۆمار بکە')}</a></p>}
    {g.stock.length > 0 && <p className="fw-note">{loc('بنود فيها قطع من دفعة مخزون تُثبَّت من طلبها، لأن تكلفة تلك القطع معروفة', 'Lines with pieces from a stock batch are set in their order, because those pieces\' cost is known', 'ئەو بڕگانەی پارچەیان لە بارێکی کۆگا تێدایە لە داواکارییەکەیانەوە جێگیر دەکرێن، چونکە تێچووی ئەو پارچانە زانراوە')}: {g.stock.length}</p>}
    {g.preorder.length > 0 && <p className="fw-note">{loc('بنود من طلبات مسبقة: اربط دفعتها الواصلة من الطلب، فتأتي تكلفتها الفعلية', 'Pre-order lines: link their arrived batch in the order, which brings their actual cost', 'بڕگەی داواکاریی پێشوەختە: بارە گەیشتووەکەیان لە داواکارییەکەدا ببەستەرەوە، تێچووی ڕاستەقینەیان دێنێت')}: {g.preorder.length}</p>}
    <details className="fw-advanced"><summary>{loc('البنود', 'Lines', 'بڕگەکان')} ({g.lines.length})</summary>
      {g.lines.map((l) => <div className="fw-row" key={l.line_id}>
        <button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(l.order_id, 'cost', l.line_id)}>{l.order_id}</button>
        <span className="fw-muted">{l.delivered_at ? financeDay(l.delivered_at) : ''} · {count(loc('القطع', 'Pieces', 'پارچەکان'), costQty(l))}{l.restocked_qty ? <> ({count(loc('أُرجع', 'returned', 'گەڕێندرایەوە'), l.restocked_qty)})</> : null}{l.customer_name ? <> · {isolate(l.customer_name)}</> : null}{l.stock_qty ? <> · {loc('من دفعة مخزون: ثبّته من الطلب', 'From a stock batch: set it in the order', 'لە بارێکی کۆگاوە: لە داواکارییەکەدا جێگیری بکە')}</> : l.preorder ? <> · {loc('طلب مسبق: اربط دفعته من الطلب', 'Pre-order: link its batch in the order', 'پێشوەختە: بارەکەی لە داواکارییەکەدا ببەستەرەوە')}</> : null}</span>
        <span>{l.cogs_iqd == null ? loc('بلا سعر', 'No price', 'بێ نرخ') : <Money value={l.cogs_iqd} />}</span>
      </div>)}
      <p className="fw-muted">{lang === 'en' ? 'Open an order to set a different cost for that line only.' : lang === 'ckb' ? 'داواکارییەک بکەرەوە بۆ دانانی تێچوویەکی جیاواز تەنها بۆ ئەو بڕگەیە.' : 'افتح الطلب لتضع تكلفة مختلفة لذلك البند وحده.'}</p>
    </details>
  </section>;
}
