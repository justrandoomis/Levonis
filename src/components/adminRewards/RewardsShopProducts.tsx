/**
 * ADMIN → المكافآت → الإعدادات → متجر النقاط → «منتجات مقابل نقاط» (owner, 2026-11-05:
 * «23000 points to redeem filament of esun pla plus beige …»; DECISIONS row 299).
 *
 * Rows of the settings form, saved with it: each pins one real store product through the
 * admin gift editor's own fields (../adminGifts/ItemFields), a price in points and a switch.
 * Nothing here decides anything: on the save the server judges every row on sale with the
 * gift code's own rule, and a refusal comes back as a code this file words, naming the row.
 * What each row is and what it has done are the server's too (`shop_products`). A lazy
 * chunk: the editor and its stylesheet load when the settings tab opens.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import ItemFields, { blankItem } from '../adminGifts/ItemFields';
import { adminLang } from '../adminGifts/strings';
import type { ItemInput } from '../adminGifts/types';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { countText } from '../rewards/copy';
import SafeImage from '../ui/SafeImage';
import { MAX_SHOP_ROWS, shopRowWarning, type ShopProductRow, type ShopProductView } from './shopProductWords';

const inputOf = (r: ShopProductRow): ItemInput => ({
  productId: r.product_id,
  optionValueIds: r.option_value_ids,
  colorId: r.color_id,
  qty: r.qty,
  saleType: r.sale_type,
  transportMethod: r.transport_method,
});

export default function RewardsShopProducts({
  items,
  views: viewsIn,
  badIndex,
  onChange,
}: {
  items: ShopProductRow[];
  views: ShopProductView[];
  /** The row the last refusal named. */
  badIndex: number | null;
  onChange: (items: ShopProductRow[]) => void;
}) {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const l = adminLang(lang);
  // What the server said of each row; a row whose product changed has no description until it is saved.
  const [views, setViews] = useState(viewsIn);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setViews(viewsIn), [viewsIn]);
  useEffect(() => {
    if (badIndex !== null && items[badIndex]) setOpen(items[badIndex].id);
    // Only when a refusal lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badIndex]);

  const patch = (id: string, change: Partial<ShopProductRow>) => onChange(items.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const setSelection = (id: string, v: ItemInput) => {
    setViews((list) => list.filter((x) => x.id !== id));
    patch(id, {
      product_id: v.productId,
      option_value_ids: v.optionValueIds,
      color_id: v.colorId,
      qty: v.qty,
      sale_type: v.saleType,
      transport_method: v.transportMethod,
    });
  };
  const add = () => {
    const id = `rsi_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const blank = blankItem();
    onChange([...items, { id, product_id: '', option_value_ids: [], color_id: '', qty: blank.qty, sale_type: blank.saleType, transport_method: blank.transportMethod, points: null, enabled: true }]);
    setOpen(id);
  };

  return (
    <div className="space-y-2" data-admin-shop-products>
      <div>
        <p className="text-text-primary text-sm font-bold">{loc('منتجات مقابل نقاط', 'Products for points', 'بەرهەم بە خاڵ')}</p>
        <p className="text-text-secondary text-xs mt-0.5">
          {loc(
            'يصل المنتج إلى الزبون هديةً بسعر 0 د.ع ويدفع التوصيل فقط. إيقافه أو حذفه لا يمسّ ما استبدله الزبائن.',
            'The product reaches the customer as a gift at 0 IQD, and they pay for delivery only. Switching it off or removing it does not touch what customers already swapped.',
            'بەرهەمەکە وەک دیاری بە نرخی 0 د.ع دەگاتە کڕیار و تەنها کرێی گەیاندن دەدات. ڕاگرتن یان لابردنی دەستکاری ئەوە ناکات کە کڕیاران پێشتر گۆڕیویانەتەوە.'
          )}
        </p>
      </div>

      {items.length === 0 && (
        <p className="lv-well rounded-lg p-3 text-text-secondary text-xs">
          {loc('لا منتجات في المتجر بعد.', 'No products in the shop yet.', 'هێشتا هیچ بەرهەمێک لە فرۆشگادا نییە.')}
        </p>
      )}

      <ul className="space-y-2">
        {items.map((row, index) => {
          const view = views.find((x) => x.id === row.id);
          const p = view?.product ?? null;
          const name = p ? p.name[l] || p.name.en || p.name.ar : '';
          const color = p?.color ? p.color[l] || p.color.en || p.color.ar : '';
          const option = p?.option ? p.option[l] || p.option.en || p.option.ar : '';
          const editing = open === row.id || !row.product_id;
          const bad = badIndex === index;
          return (
            <li key={row.id} className={`lv-well rounded-lg p-3 space-y-3 ${bad ? 'border border-danger/50' : ''}`} data-admin-shop-product={row.id}>
              {p ? (
                <div className="flex items-start gap-3">
                  <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-surface-raised">
                    <SafeImage sizes="56px" src={p.image} alt={name} aspect="auto" className="w-full h-full" bgClassName="bg-surface-raised" fallbackClassName="text-text-muted" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-bold leading-5 text-text-primary"><bdi>{name}</bdi></p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-5 text-text-secondary">
                      {color && (
                        <span className="inline-flex items-center gap-1.5">
                          {p.color_hex && <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-full border border-text-muted/70" style={{ backgroundColor: p.color_hex }} />}
                          <bdi>{color}</bdi>
                        </span>
                      )}
                      {color && option && <span aria-hidden="true">·</span>}
                      {option && <bdi>{option}</bdi>}
                      {p.qty > 1 && <span>· {countText('pieces', p.qty, l)}</span>}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-5 text-text-muted tabular-nums">
                      {view?.value_iqd ? loc(`قيمته ${money(view.value_iqd)}`, `Worth ${money(view.value_iqd)}`, `بەهاکەی ${money(view.value_iqd)}`) : ''}
                      {view && view.swapped > 0
                        ? ` · ${countText('swappedTimes', view.swapped, l)}`
                        : ''}
                    </p>
                  </div>
                </div>
              ) : (
                row.product_id && !editing && (
                  <p className="text-[12px] leading-5 text-text-secondary">
                    {view ? shopRowWarning(view.reason, loc) : loc('يظهر وصفه بعد الحفظ.', 'Its description shows after saving.', 'دوای پاشەکەوتکردن وەسفەکەی دەردەکەوێت.')}
                  </p>
                )
              )}
              {view && p && !view.available && row.enabled && <p className="text-[12px] leading-5 text-warning" data-admin-shop-warning>{shopRowWarning(view.reason, loc)}</p>}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-text-secondary text-[11px] font-bold mb-1" htmlFor={`rw-item-points-${row.id}`}>{loc('السعر بالنقاط', 'Price in points', 'نرخ بە خاڵ')}</label>
                  <input
                    id={`rw-item-points-${row.id}`}
                    className="lv-input text-sm"
                    dir="ltr"
                    type="number"
                    min={1}
                    value={row.points ?? ''}
                    onChange={(e) => patch(row.id, { points: e.target.value.trim() === '' ? null : Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                  />
                </div>
                <label className="flex min-h-10 items-center gap-2 self-end text-sm text-text-primary">
                  <input type="checkbox" checked={row.enabled} onChange={(e) => patch(row.id, { enabled: e.target.checked })} data-admin-shop-on-sale />
                  {row.enabled ? loc('معروض للبيع', 'On sale', 'لە فرۆشتندایە') : loc('موقوف', 'Off', 'ڕاگیراوە')}
                </label>
              </div>

              {editing && (
                <div className={`${T.AP} rounded-lg border border-border-subtle p-3`} data-admin-shop-fields>
                  <ItemFields lang={l} value={inputOf(row)} onChange={(v) => setSelection(row.id, v)} />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                {row.product_id ? (
                  <button type="button" className="lv-button lv-button-ghost lv-button-sm" aria-expanded={editing} onClick={() => setOpen(editing ? null : row.id)}>
                    {editing ? <ChevronUp className="w-4 h-4" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
                    {loc('تعديل المنتج', 'Edit the product', 'دەستکاری بەرهەم')}
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" className="lv-button lv-button-ghost lv-button-sm text-danger" onClick={() => onChange(items.filter((r) => r.id !== row.id))} data-admin-shop-remove>
                  <Trash2 className="w-4 h-4" aria-hidden />
                  {loc('حذف', 'Remove', 'لابردن')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <button type="button" className="lv-button lv-button-secondary lv-button-sm" onClick={add} disabled={items.length >= MAX_SHOP_ROWS} data-admin-shop-add>
        <Plus className="w-4 h-4" aria-hidden />
        {loc('إضافة منتج', 'Add a product', 'بەرهەمێک زیاد بکە')}
      </button>
    </div>
  );
}
