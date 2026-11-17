import { useLanguage } from '../../LanguageContext';
import VariantImg from '../ui/VariantImg';
import { Input, money, T } from './shared';

/**
 * EVERY ITEM OF A PURCHASE ON ONE SCREEN (owner request 2026-11-17: «تحسين الشراء القادم، خاصة مع منتجات
 * متعددة وأسعار»). Before, each item was its own long card and the owner scrolled through all of them to type
 * a price, then pressed «حفظ التكلفة والربح والسعر» once per product. Here every item is one row — its
 * quantity, its raw supplier price, its packed weight or volume when a route prices freight, what one unit
 * lands at, the line total and the customer price the store will show — and one button saves the new price
 * of every product at once. The detailed card of an item stays below for charges, sale discount and the
 * profit fields; «التفاصيل» jumps to it.
 *
 * The grid writes through the same setters as the cards (the panel owns them), so a figure typed in either
 * place is the same figure.
 */
export type PriceGridRow = {
  key: string;
  label: string;
  sku?: string;
  image?: string | null;
  qty: number;
  raw: number | string;
  rawMode: 'unit' | 'total';
  packed: { basis: 'weight' | 'volume'; value: number | '' } | null;
  landedUnit: number;
  lineTotal: number;
  customerIqd: number | null;
  /** The product card holds a price not saved yet (typed, or the shipment's new cost). */
  priceToSave: boolean;
  qtyError?: string;
  rawError?: string;
  packedError?: string;
};

const fig = (n: number) => (Number.isFinite(n) ? money(n) : '—');

export default function PurchasePriceGrid({ rows, currency, decimals, onQty, onRaw, onPacked, onDetails, total, units, saveAll }: {
  rows: PriceGridRow[];
  currency: string;
  decimals: number;
  onQty: (i: number, v: string) => void;
  onRaw: (i: number, v: string) => void;
  onPacked: (i: number, v: string) => void;
  onDetails: (i: number) => void;
  total: number;
  units: number;
  saveAll: { count: number; needConfirm: number; busy: boolean; note: { tone: 'ok' | 'error'; text: string } | null; onSave: () => void };
}) {
  const { loc } = useLanguage();
  if (!rows.length) return null;
  return (
    <section className="mb-4 rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] p-3 sm:p-4" aria-labelledby="purchase-grid-title" data-purchase-price-grid>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 id="purchase-grid-title" className={`font-semibold ${T.text1}`}>
          {loc('كل المنتجات والأسعار', 'All items and prices', 'هەموو بەرهەم و نرخەکان')}
        </h4>
        <p className={`text-[13px] ${T.text3}`}>
          {loc(`${rows.length} منتج · ${units} قطعة`, `${rows.length} items · ${units} units`, `${rows.length} بەرهەم · ${units} پارچە`)}
        </p>
      </div>
      <p className={`mb-3 text-[13px] ${T.text3}`}>
        {loc(
          'اكتب سعر المورد لكل منتج هنا. التكلفة الواصلة للقطعة وسعر الزبون يُحسبان مباشرة. التفاصيل (المصاريف، الربح، الخصم) في بطاقة كل منتج أدناه.',
          'Type each item’s supplier price here. The landed unit cost and the customer price update as you type. Charges, profit and discounts are in each item’s card below.',
          'نرخی دابینکەری هەر بەرهەمێک لێرە بنووسە. تێچووی گەیشتووی پارچە و نرخی کڕیار یەکسەر دەژمێردرێن. وردەکارییەکان (خەرجی، قازانج، داشکاندن) لە کارتی هەر بەرهەمێکدان لە خوارەوە.',
        )}
      </p>
      <ol className="grid gap-2">
        {rows.map((r, i) => (
          <li key={`${r.key}:${i}`} className="grid gap-3 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] lg:items-start" data-purchase-grid-row={i}>
            <div className="flex min-w-0 items-start gap-2.5">
              {r.image ? <VariantImg sizes="44px" src={r.image} alt="" className="h-11 w-11 shrink-0 rounded-[var(--ap-radius-sm)] object-cover" loading="lazy" /> : <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] text-[13px] font-semibold text-[var(--ap-text-3)]">{i + 1}</span>}
              <div className="min-w-0">
                <strong className={`block text-[14px] leading-snug [overflow-wrap:anywhere] ${T.text1}`}>{r.label}</strong>
                {r.sku && <small className={`block text-[12px] ${T.text3}`}><bdi dir="ltr">{r.sku}</bdi></small>}
                <button type="button" className="mt-1 text-[12px] font-semibold text-[var(--ap-accent-text)] underline-offset-2 hover:underline" onClick={() => onDetails(i)}>
                  {loc('التفاصيل والربح', 'Details and profit', 'وردەکاری و قازانج')}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 lg:contents">
              <Input id={`purchase-grid-${i}-qty`} label={loc('الكمية', 'Quantity', 'بڕ')} type="number" min={1} value={Number.isFinite(r.qty) ? r.qty : ''} onChange={(v) => onQty(i, v)} error={r.qtyError} />
              <Input id={`purchase-grid-${i}-raw`} label={`${r.rawMode === 'total' ? loc('إجمالي سعر المورد', 'Supplier total', 'کۆی نرخی دابینکەر') : loc('سعر المورد للقطعة', 'Supplier unit price', 'نرخی دابینکەر بۆ پارچە')} (${currency})`} type="number" min={0} decimals={decimals} value={r.raw} onChange={(v) => onRaw(i, v)} error={r.rawError} />
            </div>
            {r.packed ? (
              <Input id={`purchase-grid-${i}-packed`} label={r.packed.basis === 'volume' ? loc('حجم الكرتون للقطعة CBM', 'Packed CBM per unit', 'قەبارەی کارتۆن بۆ پارچە CBM') : loc('وزن الكرتون للقطعة كغ', 'Packed kg per unit', 'کێشی کارتۆن بۆ پارچە کگ')} type="number" min={0} decimals={r.packed.basis === 'volume' ? 9 : 3} value={r.packed.value} onChange={(v) => onPacked(i, v)} error={r.packedError} />
            ) : <span className="hidden lg:block" />}
            <dl className="grid grid-cols-3 gap-2 text-[12px] lg:grid-cols-1 lg:gap-1">
              <div><dt className={T.text3}>{loc('تكلفة القطعة الواصلة', 'Landed per unit', 'تێچووی گەیشتووی پارچە')}</dt><dd className={`text-[14px] font-semibold tabular-nums ${T.text1}`}><bdi dir="ltr">{fig(r.landedUnit)}</bdi></dd></div>
              <div><dt className={T.text3}>{loc('إجمالي البند', 'Line total', 'کۆی بەند')}</dt><dd className={`tabular-nums ${T.text2}`}><bdi dir="ltr">{fig(r.lineTotal)}</bdi></dd></div>
              <div className="lg:mt-1 lg:rounded-[var(--ap-radius-sm)] lg:bg-[var(--ap-accent-soft)] lg:px-2 lg:py-1">
                <dt className={T.text3}>{loc('سعر الزبون', 'Customer price', 'نرخی کڕیار')}</dt>
                <dd className="text-[14px] font-semibold tabular-nums text-[var(--ap-accent-text)]"><bdi dir="ltr">{r.customerIqd == null ? '—' : money(r.customerIqd)}</bdi></dd>
                {r.priceToSave && <dd className="text-[11px] font-semibold text-[var(--ap-warning)]">{loc('سعر جديد لم يُحفظ', 'New price not saved', 'نرخی نوێ پاشەکەوت نەکراوە')}</dd>}
              </div>
            </dl>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ap-border)] pt-3">
        <p className={`text-[14px] ${T.text2}`}>
          {loc('إجمالي الشحنة مع الشحن والمصاريف', 'Shipment total with freight and charges', 'کۆی بار لەگەڵ ناردن و خەرجییەکان')}: <strong className={`tabular-nums ${T.text1}`}><bdi dir="ltr">{fig(total)}</bdi></strong>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={T.btnPrimary} disabled={saveAll.busy || saveAll.count === 0} onClick={saveAll.onSave} data-purchase-save-all-prices>
            {saveAll.busy
              ? loc('جارٍ حفظ الأسعار…', 'Saving prices…', 'نرخەکان پاشەکەوت دەکرێن…')
              : saveAll.count === 0
                ? loc('كل الأسعار محفوظة', 'All prices saved', 'هەموو نرخەکان پاشەکەوت کراون')
                : loc(`حفظ أسعار كل المنتجات (${saveAll.count})`, `Save all product prices (${saveAll.count})`, `پاشەکەوتکردنی نرخی هەموو بەرهەمەکان (${saveAll.count})`)}
          </button>
        </div>
      </div>
      {saveAll.needConfirm > 0 && <p role="status" className="mt-2 text-[13px] text-[var(--ap-warning)]">{loc(
        `${saveAll.needConfirm} منتج يتغير سعره أكثر من 15%: ضع علامة التأكيد في بطاقته أولًا.`,
        `${saveAll.needConfirm} item(s) change price by more than 15%: tick the confirmation in its card first.`,
        `${saveAll.needConfirm} بەرهەم نرخی زیاتر لە 15% دەگۆڕێت: سەرەتا نیشانەی پشتڕاستکردنەوە لە کارتەکەیدا دابنێ.`,
      )}</p>}
      {saveAll.note && <p role={saveAll.note.tone === 'error' ? 'alert' : 'status'} className={`mt-2 text-[13px] ${saveAll.note.tone === 'error' ? 'text-[var(--ap-danger)]' : T.text2}`}>{saveAll.note.text}</p>}
    </section>
  );
}
