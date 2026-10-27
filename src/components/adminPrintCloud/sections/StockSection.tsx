/**
 * WORKSHOP STOCK — the warehouse, not what customers own (docs §5.3).
 *
 *   on hand     physically on the shelf
 *   held        held for unpaid orders (released when they expire)
 *   allocated   bought by customers, still on the shelf for them
 *   sellable    on hand − held − allocated (never below zero: fenced)
 *
 * Receiving, a count correction and waste/damage are the operator's acts
 * (`POST /stock/receive | adjust | waste`). What a lot COST is the owner's:
 * an operator receives with the cost pending — never a free zero — and the
 * owner states it once (`POST /stock/lots/{id}/cost`). The lots list and its
 * costs exist only for the owner (`GET /stock/lots`, cost read).
 */
import { useMemo, useRef, useState } from 'react';
import { Boxes, PackagePlus, Scale, Trash2 } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { StatusChip } from '../../ui/Badge';
import { toast } from '../../../lib/toastStore';
import { usePcAccess } from '../access';
import { newIdempotencyKey, pc, type Row, type StockLot, type StockRow } from '../api';
import { tri, type Tri } from '../i18n';
import { formatDateTime, num, qty } from '../format';
import { pcRefusal } from '../refusal';
import { iqdUnit } from '../../../lib/money';
import { Act, Chips, IntField, LoadState, Note, type PcColumn, PcList, RefreshButton, SectionHead, SelectField, T, TextArea, TextField, useLoad, usePcLang, W } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('مخزون الورشة', 'Workshop stock', 'کۆگای کارگە'),
  desc: tri(
    'ما على رفوف الورشة لكل صنف: الموجود، والمحجوز لطلبات غير مدفوعة، وما اشتراه العملاء وما زال على الرف، والقابل للبيع.',
    'What is on the workshop’s shelves for each variant: on hand, held for unpaid orders, bought by customers and still on the shelf, and sellable.',
    'ئەوەی لەسەر ڕەفەکانی کارگەیە بۆ هەر جۆرێک: بەردەست، گیراو بۆ داواکاریی پارە نەدراو، کڕدراو لەلایەن کڕیاران و هێشتا لەسەر ڕەفە، و فرۆشراو.'
  ),
  all: tri('كل الأصناف', 'All variants', 'هەموو جۆرەکان'),
  low: tri('المنخفضة فقط', 'Low only', 'تەنها کەمەکان'),
  filter: tri('بحث بالرمز أو الاسم', 'Search by SKU or name', 'گەڕان بە SKU یان ناو'),
  variant: tri('الصنف', 'Variant', 'جۆر'),
  onHand: tri('الموجود', 'On hand', 'بەردەست'),
  held: tri('محجوز لطلبات غير مدفوعة', 'Held for unpaid orders', 'گیراو بۆ داواکاریی پارە نەدراو'),
  allocated: tri('ملك العملاء على الرف', 'Customer-owned on the shelf', 'موڵکی کڕیار لەسەر ڕەف'),
  sellable: tri('قابل للبيع', 'Sellable', 'فرۆشراو'),
  threshold: tri('حد الانخفاض', 'Low threshold', 'سنووری کەمی'),
  lowBadge: tri('منخفض', 'Low', 'کەمە'),
  ok: tri('كافٍ', 'OK', 'باشە'),
  empty: tri('لا أصناف بعد — أضف منتجاً وصنفاً من الكتالوج.', 'No variants yet — add a product and a variant in the catalogue.', 'هێشتا هیچ جۆرێک نییە — لە کاتالۆگەوە بەرهەم و جۆرێک زیاد بکە.'),
  noLow: tri('لا صنف منخفض المخزون.', 'No variant is low on stock.', 'هیچ جۆرێک لە کۆگادا کەم نییە.'),
  receive: tri('استلام دفعة', 'Receive a lot', 'وەرگرتنی کۆمەڵە'),
  adjust: tri('تصحيح جرد', 'Count correction', 'ڕاستکردنەوەی ژماردن'),
  waste: tri('هدر أو تلف', 'Waste or damage', 'بەفیڕۆچوون یان زیان'),
  lots: tri('الدفعات وتكاليفها', 'Lots and their costs', 'کۆمەڵەکان و تێچووەکانیان'),
  qty: tri('الكمية', 'Quantity', 'بڕ'),
  location: tri('الموقع', 'Location', 'شوێن'),
  lotCode: tri('رمز الدفعة', 'Lot code', 'کۆدی کۆمەڵە'),
  supplier: tri('المورّد', 'Supplier', 'دابینکەر'),
  notes: tri('ملاحظات', 'Notes', 'تێبینی'),
  totalCost: tri('التكلفة الإجمالية للدفعة', 'The lot’s total cost', 'کۆی تێچووی کۆمەڵەکە'),
  costPendingNote: tri(
    'تُستلم الدفعة وتكلفتها معلّقة؛ يذكرها المالك لاحقاً مرة واحدة. لا تُحسب أبداً صفراً.',
    'The lot is received with its cost pending; the owner states it later, once. It is never counted as zero.',
    'کۆمەڵەکە بە تێچووی هەڵپەسێردراو وەردەگیرێت؛ خاوەن دواتر یەکجار دەیڵێت. هەرگیز وەک سفر حیساب ناکرێت.'
  ),
  costOptional: tri('فارغ = تكلفة معلّقة تُذكر لاحقاً', 'Empty = cost pending, stated later', 'بەتاڵ = تێچووی هەڵپەسێردراو، دواتر دەوترێت'),
  delta: tri('التغيير (موجب يضيف، سالب ينقص)', 'Change (positive adds, negative removes)', 'گۆڕانکاری (پۆزەتیڤ زیاد دەکات، نێگەتیڤ کەم دەکات)'),
  deltaHelp: tri(
    'الزيادة تنشئ دفعة تسوية تكلفتها معلّقة؛ النقص يسحب من الدفعات الأقدم أولاً.',
    'An increase creates an adjustment lot with its cost pending; a decrease draws from the oldest lots first.',
    'زیادکردن کۆمەڵەیەکی ڕێکخستن بە تێچووی هەڵپەسێردراو دروست دەکات؛ کەمکردن لە کۆنترین کۆمەڵەکانەوە دەست پێدەکات.'
  ),
  kind: tri('النوع', 'Kind', 'جۆر'),
  wasteKind: tri('هدر', 'Waste', 'بەفیڕۆچوون'),
  damageKind: tri('تلف', 'Damage', 'زیان'),
  reasonRequired: tri('اكتب السبب.', 'Write the reason.', 'هۆکارەکە بنووسە.'),
  qtyRequired: tri('أدخل كمية صحيحة أكبر من صفر.', 'Enter a whole quantity above zero.', 'بڕێکی تەواو لە سەرووی سفرەوە بنووسە.'),
  deltaRequired: tri('أدخل تغييراً لا يساوي صفراً.', 'Enter a change other than zero.', 'گۆڕانکارییەک جگە لە سفر بنووسە.'),
  done: tri('سُجّل. الموقف الآن', 'Recorded. The position now', 'تۆمارکرا. بارودۆخی ئێستا'),
  lotsFor: tri('دفعات', 'Lots of', 'کۆمەڵەکانی'),
  received: tri('استُلم', 'Received', 'وەرگیرا'),
  remaining: tri('المتبقي', 'Remaining', 'ماوە'),
  unitCost: tri('تكلفة الوحدة', 'Unit cost', 'تێچووی یەکە'),
  pending: tri('التكلفة معلّقة', 'Cost pending', 'تێچوو هەڵپەسێردراوە'),
  stateCost: tri('ذكر التكلفة', 'State the cost', 'گوتنی تێچوو'),
  stateCostHelp: tri(
    'تُذكر مرة واحدة؛ ما خرج من الدفعة قبلها يُقيَّم بها في تقرير الربح.',
    'Stated once; units that already left the lot are valued from it in the profit report.',
    'یەکجار دەوترێت؛ ئەو یەکانەی پێشتر لە کۆمەڵەکە دەرچوون بەم تێچووە لە ڕاپۆرتی قازانجدا هەڵدەسەنگێنرێن.'
  ),
  costStated: tri('سُجّلت التكلفة.', 'Cost recorded.', 'تێچوو تۆمارکرا.'),
  noLots: tri('لا دفعات لهذا الصنف.', 'No lots for this variant.', 'هیچ کۆمەڵەیەک بۆ ئەم جۆرە نییە.'),
  milli: tri('بالملّي دينار', 'in milli-dinars', 'بە میلی دینار'),
} satisfies Record<string, Tri>;

type Dialog = { kind: 'receive' | 'adjust' | 'waste' | 'lots'; row: StockRow } | null;

const nameOf = (r: StockRow, lang: 'ar' | 'en' | 'ckb') => String(r[`name_${lang}` as keyof StockRow] || r.name_en || r.sku);

export default function StockSection({ params }: SectionProps) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const stock = useLoad(() => pc.get<StockRow[]>('/stock'), []);
  const [only, setOnly] = useState<'all' | 'low'>(params.low === '1' ? 'low' : 'all');
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  const rows = useMemo(() => {
    if (!stock.data) return null;
    const q = filter.trim().toLowerCase();
    return stock.data.filter((r) => (only === 'all' || r.low === 1) && (!q || r.sku.toLowerCase().includes(q) || nameOf(r, lang).toLowerCase().includes(q)));
  }, [stock.data, only, filter, lang]);

  const columns: PcColumn<StockRow>[] = [
    {
      id: 'variant',
      header: t(S.variant),
      card: 'title',
      cell: (r) => (
        <span>
          {nameOf(r, lang)} <bdi dir="ltr" className={`font-mono text-[11.5px] ${T.text3}`}>{r.sku}</bdi>
        </span>
      ),
    },
    { id: 'low', header: t(S.threshold), card: 'badge', cell: (r) => <StatusChip tone={r.low === 1 ? 'warning' : 'success'}>{t(r.low === 1 ? S.lowBadge : S.ok)}</StatusChip> },
    { id: 'on_hand', header: t(S.onHand), numeric: true, cell: (r) => qty(r.on_hand_qty, r.unit_code, lang) },
    { id: 'held', header: t(S.held), numeric: true, cell: (r) => qty(r.reserved_qty, r.unit_code, lang) },
    { id: 'allocated', header: t(S.allocated), numeric: true, cell: (r) => qty(r.allocated_qty, r.unit_code, lang) },
    { id: 'sellable', header: t(S.sellable), numeric: true, cell: (r) => <strong>{qty(r.sellable_qty, r.unit_code, lang)}</strong> },
    { id: 'threshold', header: t(S.threshold), numeric: true, cell: (r) => qty(r.low_stock_threshold_qty, r.unit_code, lang) },
  ];

  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} actions={<RefreshButton onClick={() => stock.reload()} loading={stock.loading} />} />
      <div className="flex flex-wrap items-end gap-3">
        <Chips<'all' | 'low'>
          label={t(S.title)}
          value={only}
          onChange={setOnly}
          items={[
            { id: 'all', label: t(S.all), count: stock.data?.length },
            { id: 'low', label: t(S.low), count: stock.data?.filter((r) => r.low === 1).length },
          ]}
        />
        <TextField className="w-full max-w-sm" label={t(S.filter)} value={filter} onChange={setFilter} />
      </div>
      <PcList<StockRow>
        label={t(S.title)}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.variant_id}
        loading={stock.loading}
        error={stock.error}
        onRetry={() => void stock.reload()}
        empty={{ title: t(only === 'low' && stock.data?.length ? S.noLow : S.empty), icon: <Boxes size={22} aria-hidden /> }}
        rowLabel={(r) => nameOf(r, lang)}
        rowActions={(r) => [
          { id: 'receive', label: t(S.receive), icon: <PackagePlus size={14} aria-hidden />, onSelect: () => setDialog({ kind: 'receive', row: r }) },
          { id: 'adjust', label: t(S.adjust), icon: <Scale size={14} aria-hidden />, onSelect: () => setDialog({ kind: 'adjust', row: r }) },
          { id: 'waste', label: t(S.waste), icon: <Trash2 size={14} aria-hidden />, onSelect: () => setDialog({ kind: 'waste', row: r }) },
          ...(access.costRead ? [{ id: 'lots', label: t(S.lots), onSelect: () => setDialog({ kind: 'lots', row: r }) }] : []),
        ]}
      />
      {dialog && dialog.kind !== 'lots' && (
        <MoveSheet
          key={`${dialog.kind}-${dialog.row.variant_id}`}
          kind={dialog.kind}
          row={dialog.row}
          costWrite={access.costWrite}
          onClose={() => setDialog(null)}
          onDone={() => void stock.reload()}
        />
      )}
      {dialog?.kind === 'lots' && access.costRead && <LotsSheet key={dialog.row.variant_id} row={dialog.row} costWrite={access.costWrite} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Receive, correct or write off — one sheet, three bodies. */
function MoveSheet({ kind, row, costWrite, onClose, onDone }: { kind: 'receive' | 'adjust' | 'waste'; row: StockRow; costWrite: boolean; onClose: () => void; onDone: () => void }) {
  const { t, lang } = usePcLang();
  const locations = useLoad(() => pc.get<Row[]>('/catalog/locations'), [], kind === 'receive');
  const [amount, setAmount] = useState<number | null>(null);
  const [location, setLocation] = useState('');
  const [lotCode, setLotCode] = useState('');
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [wasteKind, setWasteKind] = useState<'waste' | 'damage'>('waste');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // One Idempotency-Key per movement: the same body re-sent after a lost
  // answer carries the same key (moved once); a changed body gets a new one.
  const sent = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: Record<string, unknown>) => {
    const json = JSON.stringify(body);
    if (sent.current?.body !== json) sent.current = { body: json, key: newIdempotencyKey() };
    return sent.current.key;
  };

  const amountError = kind === 'adjust' ? (amount === null || amount === 0 ? t(S.deltaRequired) : null) : amount === null || amount <= 0 ? t(S.qtyRequired) : null;
  const reasonError = kind !== 'receive' && !reason.trim() ? t(S.reasonRequired) : null;

  const submit = async () => {
    setTried(true);
    setFailure(null);
    if (amountError || reasonError) return;
    try {
      const body: Record<string, unknown> =
        kind === 'receive'
          ? {
              variant_id: row.variant_id,
              qty: amount,
              ...(location ? { location_id: location } : {}),
              ...(lotCode.trim() ? { lot_code: lotCode.trim() } : {}),
              ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              // The cost is the owner's: never sent by anyone else, never sent empty.
              ...(costWrite && cost !== null ? { total_cost_iqd: cost } : {}),
            }
          : kind === 'adjust'
            ? { variant_id: row.variant_id, qty_delta: amount, reason: reason.trim() }
            : { variant_id: row.variant_id, qty: amount, type: wasteKind, reason: reason.trim() };
      const out = await pc.post<{ position: { on_hand_qty: number; reserved_qty: number; allocated_qty: number } }>(`/stock/${kind}`, body, keyFor(body));
      const p = out.position;
      toast.success(`${t(S.done)}: ${qty(p.on_hand_qty, row.unit_code, lang)} · ${qty(p.on_hand_qty - p.reserved_qty - p.allocated_qty, row.unit_code, lang)}`);
      onDone();
      onClose();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  const title = t(kind === 'receive' ? S.receive : kind === 'adjust' ? S.adjust : S.waste);
  const titleId = `pc-stock-${kind}`;
  return (
    <Sheet open onClose={onClose} labelledBy={titleId} panelClassName="ap w-full sm:max-w-lg">
      <div className="space-y-3 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {title} — {nameOf(row, lang)}
        </h2>
        <p className={`text-[12px] ${T.text3}`}>
          {t(S.onHand)}: {qty(row.on_hand_qty, row.unit_code, lang)} · {t(S.sellable)}: {qty(row.sellable_qty, row.unit_code, lang)}
        </p>
        {kind === 'adjust' && <Note tone="info">{t(S.deltaHelp)}</Note>}
        <IntField label={t(kind === 'adjust' ? S.delta : S.qty)} unit={row.unit_code} allowNegative={kind === 'adjust'} value={amount} onChange={setAmount} error={tried ? amountError : null} />
        {kind === 'receive' && (
          <>
            <SelectField
              label={t(S.location)}
              value={location}
              placeholder="—"
              options={(locations.data ?? []).filter((l) => l.active !== 0).map((l) => ({ value: String(l.id), label: `${String(l.name)} · ${String(l.code)}` }))}
              onChange={setLocation}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label={t(S.lotCode)} value={lotCode} onChange={setLotCode} ltr maxLength={80} />
              <TextField label={t(S.supplier)} value={supplier} onChange={setSupplier} maxLength={120} />
            </div>
            <TextArea label={t(S.notes)} value={notes} onChange={setNotes} maxLength={500} rows={2} />
            {costWrite ? (
              <IntField label={t(S.totalCost)} unit={iqdUnit(lang)} value={cost} onChange={setCost} hint={t(S.costOptional)} />
            ) : (
              <Note tone="info">{t(S.costPendingNote)}</Note>
            )}
          </>
        )}
        {kind === 'waste' && (
          <SelectField
            label={t(S.kind)}
            value={wasteKind}
            options={[
              { value: 'waste', label: t(S.wasteKind) },
              { value: 'damage', label: t(S.damageKind) },
            ]}
            onChange={(v) => setWasteKind(v === 'damage' ? 'damage' : 'waste')}
          />
        )}
        {kind !== 'receive' && <TextArea label={t(W.reason)} value={reason} onChange={setReason} maxLength={500} rows={2} error={tried ? reasonError : null} />}
        {failure && <p className="lv-field-error">{failure}</p>}
        <div className="flex gap-2">
          <Act kind={kind === 'waste' ? 'danger' : 'primary'} onClick={submit}>
            {title}
          </Act>
          <Act kind="ghost" onClick={onClose}>
            {t(W.cancel)}
          </Act>
        </div>
      </div>
    </Sheet>
  );
}

/** The owner's view of a variant's lots: what each cost, and the ones still waiting for their cost. */
function LotsSheet({ row, costWrite, onClose }: { row: StockRow; costWrite: boolean; onClose: () => void }) {
  const { t, lang } = usePcLang();
  const lots = useLoad(() => pc.get<StockLot[]>(`/stock/lots?variant_id=${encodeURIComponent(row.variant_id)}`), [row.variant_id]);
  const [stating, setStating] = useState<StockLot | null>(null);
  const titleId = `pc-lots-${row.variant_id}`;
  return (
    <Sheet open onClose={onClose} labelledBy={titleId} detents={['large']} panelClassName="ap w-full sm:max-w-2xl" header={
      <div className="px-5 pb-2 pt-1">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(S.lotsFor)} {nameOf(row, lang)}
        </h2>
      </div>
    }>
      <div className="space-y-3 px-5 pb-5">
        <LoadState state={lots}>
          {(list) =>
            list.length === 0 ? (
              <Note tone="info">{t(S.noLots)}</Note>
            ) : (
              <ul className="space-y-2">
                {list.map((l) => (
                  <li key={l.id} className={`${T.surface} space-y-1 p-3 text-[12.5px]`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`font-semibold ${T.text1}`}>
                        <bdi dir="ltr" className="font-mono">{l.lot_code || l.id}</bdi> {l.supplier && `· ${l.supplier}`}
                      </span>
                      {l.cost_known === 1 ? <Money iqd={l.total_cost_iqd} className="font-bold" /> : <StatusChip tone="warning">{t(S.pending)}</StatusChip>}
                    </div>
                    <p className={T.text3}>
                      {t(S.received)}: {qty(l.received_qty, row.unit_code, lang)} · {t(S.remaining)}: {qty(l.on_hand_qty, row.unit_code, lang)} · {formatDateTime(l.received_at, lang)}
                    </p>
                    {l.cost_known === 1 && (
                      <p className={T.text3}>
                        {t(S.unitCost)}: <bdi dir="ltr">{num(l.unit_cost_milli_iqd)}</bdi> {t(S.milli)}
                      </p>
                    )}
                    {l.cost_known !== 1 && costWrite && (
                      <Act kind="secondary" onClick={() => setStating(l)}>
                        {t(S.stateCost)}
                      </Act>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
        {stating && <StateCost key={stating.id} lot={stating} onClose={() => setStating(null)} onDone={() => void lots.reload()} />}
      </div>
    </Sheet>
  );
}

function StateCost({ lot, onClose, onDone }: { lot: StockLot; onClose: () => void; onDone: () => void }) {
  const { t, lang } = usePcLang();
  const [cost, setCost] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    setFailure(null);
    if (cost === null || cost < 0) return;
    try {
      await pc.post(`/stock/lots/${encodeURIComponent(lot.id)}/cost`, { total_cost_iqd: cost });
      toast.success(t(S.costStated));
      onDone();
      onClose();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  return (
    <div className={`${T.surface} space-y-2 p-3`}>
      <p className={`text-[12.5px] ${T.text2}`}>{t(S.stateCostHelp)}</p>
      <IntField label={t(S.totalCost)} unit={iqdUnit(lang)} value={cost} onChange={setCost} hint={cost !== null ? <Money iqd={cost} /> : undefined} />
      {failure && <p className="lv-field-error">{failure}</p>}
      <div className="flex gap-2">
        <Act kind="primary" onClick={submit} disabled={cost === null}>
          {t(S.stateCost)}
        </Act>
        <Act kind="ghost" onClick={onClose}>
          {t(W.cancel)}
        </Act>
      </div>
    </div>
  );
}
