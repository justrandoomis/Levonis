import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { money, useLabels } from './shared';

/** One extra cost as it reaches one purchase line. `share_iqd` is the whole
 * dinars it puts on that line; null when an old document never saved it. */
export type ExtraChargeView = {
  title: string;
  scope: 'shipment' | 'unit';
  amount_iqd: number;
  unit_amount_iqd: number | null;
  basis: string;
  /** Labels of the lines it covers; null covers every line. */
  covers: string[] | null;
  covered: boolean;
  share_iqd: number | null;
  status: 'counted' | 'review' | 'incomplete';
};

const shown = (value: number | null | undefined) => (value != null && Number.isFinite(value) ? money(value) : '—');
// Existing utilities and inline geometry only: the private operations
// stylesheets have a fixed gzip budget (tests/bundleBudget.test.ts).
const HIT_AREA = { position: 'absolute', inset: '-10px -4px' } as const;
const TWO_COLUMNS = { gridTemplateColumns: 'max-content minmax(0, 1fr)' } as const;
const VALUE = 'text-[var(--ap-text-2)] tabular-nums [overflow-wrap:anywhere]';
const FLAG = 'rounded-full border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-2 text-[var(--ap-warning)]';

/** Raw purchase, route freight, extra costs and the landed unit cost of one
 * line — and, next to the extra costs, where every dinar of them comes from. */
export default function PurchaseLineCosts({ label, qty, rawLabel, raw, freight, extrasLabel, extras, lineExtras, final, charges, emptyHint }: {
  label: string;
  qty: number;
  rawLabel: string;
  raw: number;
  /** Route freight per unit; null without a route, where freight is a manual charge. */
  freight: number | null;
  extrasLabel: string;
  extras: number;
  lineExtras: number;
  final: number;
  charges: ExtraChargeView[];
  emptyHint?: string;
}) {
  const { loc } = useLabels();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const method = (c: ExtraChargeView) => {
    const how = c.scope === 'unit'
      ? loc('مبلغ ثابت لكل قطعة', 'A fixed amount per piece', 'بڕێکی جێگیر بۆ هەر پارچەیەک')
      : c.basis === 'value' ? loc('حسب قيمة الشراء الخام', 'By raw purchase value', 'بەپێی نرخی کڕینی خاو')
        : c.basis === 'weight' ? loc('حسب وزن الكرتون', 'By packed weight', 'بەپێی کێشی کارتۆنەکە')
          : c.basis === 'volume' ? loc('حسب حجم الكرتون', 'By packed volume', 'بەپێی قەبارەی کارتۆنەکە')
            : loc('حسب عدد القطع', 'By number of pieces', 'بەپێی ژمارەی پارچەکان');
    const comma = loc('، ', ', ', '، ');
    const where = c.covers ? `${loc('على', 'on', 'بۆ')}: ${c.covers.join(comma)}` : loc('على كل البنود', 'across every item', 'بۆ هەموو بەندەکان');
    return `${how}${comma}${where}`;
  };
  return (
    <>
      <dl className="inventory-review mt-3.5 pt-3.5 border-t border-[var(--ap-border)] tabular-nums" aria-live="polite">
        <div><dt>{rawLabel}</dt><dd>{shown(raw)}</dd></div>
        {freight !== null && <div><dt>{loc('شحن القطعة', 'Freight per unit', 'کرێی گواستنەوەی هەر پارچەیەک')}</dt><dd>{shown(freight)}</dd></div>}
        <div>
          <dt className="flex flex-wrap items-center gap-1.5">
            <span>{extrasLabel}</span>
            <button type="button" className="relative inline-flex items-center gap-1 rounded-full border border-[var(--ap-border)] bg-[var(--ap-surface-1)] px-2.5 py-0.5 text-[12px] text-[var(--ap-text-2)] hover:text-[var(--ap-text-1)] hover:border-[var(--ap-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]" aria-expanded={open} aria-controls={panel} aria-label={`${loc('تفاصيل', 'Details', 'وردەکاری')}: ${extrasLabel} — ${label}`} onClick={() => setOpen((v) => !v)}>
              {/* A 44px-tall touch target around a compact pill. */}
              <span aria-hidden="true" style={HIT_AREA} />
              {loc('تفاصيل', 'Details', 'وردەکاری')}<ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
            </button>
          </dt>
          <dd>{shown(extras)}</dd>
        </div>
        <div className="inventory-line"><dt>{loc('تكلفة القطعة الفعلية لهذه الشحنة', 'This shipment’s landed unit cost', 'تێچووی ڕاستەقینەی هەر پارچەیەک لەم بارەدا')}</dt><dd><strong><output aria-label={`${loc('تكلفة القطعة الفعلية لهذه الشحنة', 'This shipment’s landed unit cost', 'تێچووی ڕاستەقینەی هەر پارچەیەک لەم بارەدا')}: ${label}`}>{shown(final)}</output></strong></dd></div>
      </dl>
      <div id={panel} hidden={!open} className={open ? 'mt-3 grid gap-2.5 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-3 text-[12px] text-[var(--ap-text-3)]' : undefined} role="region" aria-label={`${extrasLabel} — ${label}`}>
        {charges.length === 0 ? (
          <p>{loc('لا توجد مصاريف إضافية مدخلة لهذه الشحنة، لذلك قيمتها 0 د.ع.', 'No extra expenses were entered for this shipment, so they are 0 IQD.', 'هیچ خەرجییەکی زیادە بۆ ئەم بارە تۆمار نەکراوە، بۆیە بڕەکەی 0 د.ع یە.')}{emptyHint ? ` ${emptyHint}` : ''}</p>
        ) : (
          <>
            <ul className="grid gap-2.5">
              {charges.map((c, i) => (
                <li key={i} className="grid gap-1.5 border-b border-[var(--ap-border)] pb-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[13px] text-[var(--ap-text-1)] [overflow-wrap:anywhere]">{c.title}</strong>
                    {c.status === 'review' && <span className={FLAG}>{loc('لم تُحتسب', 'Not counted', 'حیساب نەکراوە')}</span>}
                    {c.status === 'incomplete' && <span className={FLAG}>{loc('غير مكتملة', 'Incomplete', 'تەواو نییە')}</span>}
                  </div>
                  <dl className="grid gap-x-3 gap-y-1" style={TWO_COLUMNS}>
                    <dt>{loc('القيمة', 'Amount', 'بڕ')}</dt>
                    <dd className={VALUE}>{c.scope === 'unit' ? shown(c.unit_amount_iqd) : shown(c.amount_iqd)}</dd>
                    <dt>{loc('تخص', 'Charged to', 'تایبەتە بە')}</dt>
                    <dd className={VALUE}>{c.scope === 'unit' ? loc('كل قطعة', 'Each piece', 'هەر پارچەیەک') : loc('الشحنة كاملة', 'The whole shipment', 'هەموو بارەکە')}</dd>
                    <dt>{loc('طريقة التوزيع', 'Allocation', 'شێوازی دابەشکردن')}</dt>
                    <dd className={VALUE}>{method(c)}</dd>
                    <dt>{loc('على هذه القطعة', 'On this piece', 'لەسەر ئەم پارچەیە')}</dt>
                    <dd className={VALUE}>
                      <strong className="font-semibold text-[var(--ap-text-1)]">{c.status === 'review' || !c.covered ? shown(0) : c.share_iqd === null ? '—' : shown(c.share_iqd / qty)}</strong>
                      <span className="block">
                        {c.status === 'review' ? loc('لم تُحتسب: أُدخلت قبل اختيار مسار الشحن؛ أكد أنها ليست شحنًا أو احذفها', 'Not counted: entered before the freight route was chosen; confirm it is not freight or remove it', 'حیساب نەکراوە: پێش هەڵبژاردنی ڕێگای گواستنەوە تۆمار کراوە؛ دڵنیابەرەوە کە کرێی گواستنەوە نییە یان بیسڕەوە')
                          : !c.covered ? loc('لا تشمل هذا البند', 'Does not cover this item', 'ئەم بەندە ناگرێتەوە')
                            : c.share_iqd === null ? loc('غير محفوظ لهذا المستند القديم', 'Not saved for this older document', 'بۆ ئەم بەڵگەنامە کۆنە پاشەکەوت نەکراوە')
                              : `${shown(c.share_iqd)} ${loc('على البند', 'on the item', 'لەسەر بەندەکە')} ÷ ${qty}`}
                      </span>
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>
            <p className="flex justify-between gap-3 text-[13px] text-[var(--ap-text-1)] tabular-nums"><span>{loc('المجموع على هذه القطعة', 'Total on this piece', 'کۆی گشتی لەسەر ئەم پارچەیە')}</span><strong>{shown(extras)}</strong></p>
            <p>{freight === null
              ? loc(`على البند كاملًا: ${shown(lineExtras)}. بدون مسار شحن، الشحن اليدوي جزء من هذه التكاليف، ولا يُحتسب هنا سعر الشراء الخام.`, `Whole item: ${shown(lineExtras)}. Without a freight route, manual freight is part of these charges; the raw purchase price is never counted here.`, `بۆ هەموو بەندەکە: ${shown(lineExtras)}. بەبێ ڕێگای گواستنەوە، کرێی گواستنەوەی دەستی بەشێکە لەم تێچووانە؛ نرخی کڕینی خاو لێرە حیساب ناکرێت.`)
              : loc(`على البند كاملًا: ${shown(lineExtras)}. لا يُحتسب هنا سعر الشراء الخام ولا الشحن المحسوب من الوزن.`, `Whole item: ${shown(lineExtras)}. The raw purchase price and weight-based freight are never counted here.`, `بۆ هەموو بەندەکە: ${shown(lineExtras)}. نرخی کڕینی خاو و کرێی گواستنەوە بەپێی کێش لێرە حیساب ناکرێن.`)}</p>
          </>
        )}
      </div>
    </>
  );
}
