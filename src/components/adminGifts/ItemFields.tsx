/**
 * PIN ONE REAL STORE PRODUCT (docs/GIFTS_QUICK_BUY.md D3): the product, its
 * model (one value per option group), its colour, the quantity, the sale type
 * and — for a pre-order — the freight route. Everything offered here comes
 * from the store's own options projection
 * (`GET /api/gifts/admin/products/:id/options`); the server validates the
 * whole selection again with the cart's own resolver, so a combination this
 * form lets through but the store cannot sell is refused there with its code.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { Banner, Field, Grid, Select } from '../adminProducts/form/formUi';
import * as T from '../adminProducts/theme';
import { adminText, type AdminLang } from './strings';
import type { ItemInput, OptionsProjection } from './types';

export const blankItem = (): ItemInput => ({ productId: '', optionValueIds: [], colorId: '', qty: 1, saleType: 'direct_sale', transportMethod: '' });

const nameOf = (lang: AdminLang, v: { name_en: string; name_ar: string; name_ckb?: string }) =>
  (lang === 'en' ? v.name_en || v.name_ar : lang === 'ckb' ? v.name_ckb || v.name_ar || v.name_en : v.name_ar || v.name_en) || '';

export default function ItemFields({
  lang,
  value,
  onChange,
  disabled = false,
}: {
  lang: AdminLang;
  value: ItemInput;
  onChange: (next: ItemInput) => void;
  disabled?: boolean;
}) {
  const t = (k: Parameters<typeof adminText>[1]) => adminText(lang, k);
  const [options, setOptions] = useState<OptionsProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // The store's own answer for the chosen product.
  useEffect(() => {
    if (!value.productId) {
      setOptions(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    api
      .get<{ options: OptionsProjection }>(`/api/gifts/admin/products/${encodeURIComponent(value.productId)}/options`)
      .then((r) => alive && setOptions(r.options))
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('loadFailed')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on product only
  }, [value.productId]);

  const picked = useMemo(() => new Set(value.optionValueIds), [value.optionValueIds]);
  const groups = useMemo(() => options?.groups ?? [], [options]);
  const pickedByGroup = useMemo(() => {
    const out: Record<string, string> = {};
    for (const g of groups) {
      const hit = g.values.find((v) => picked.has(v.id));
      if (hit) out[g.id] = hit.id;
    }
    return out;
  }, [groups, picked]);
  const colors = (options?.colors ?? []).filter((c) => {
    const byGroup = new Map<string, Set<string>>();
    for (const l of c.links ?? []) {
      const set = byGroup.get(l.group_id) ?? new Set<string>();
      set.add(l.option_value_id);
      byGroup.set(l.group_id, set);
    }
    for (const [group, values] of byGroup) {
      if (!pickedByGroup[group] || !values.has(pickedByGroup[group])) return false;
    }
    return true;
  });
  const selectedValue = groups.flatMap((g) => g.values).find((v) => picked.has(v.id));
  const routes = (selectedValue?.routes.length ? selectedValue.routes : options?.transports ?? []).filter((m) => m === 'air' || m === 'sea' || m === 'land');
  const saleTypes: ReadonlyArray<'direct_sale' | 'pre_order'> = options?.sale_types?.length
    ? options.sale_types.filter((s) => s === 'direct_sale' || s === 'pre_order')
    : ['direct_sale', 'pre_order'];

  const set = (patch: Partial<ItemInput>) => onChange({ ...value, ...patch });
  const pickValue = (groupId: string, valueId: string) => {
    const others = value.optionValueIds.filter((id) => !(groups.find((g) => g.id === groupId)?.values ?? []).some((v) => v.id === id));
    set({ optionValueIds: valueId ? [...others, valueId] : others });
  };

  return (
    <div className="space-y-3">
      <Field ar={t('product')} en="Product" htmlFor="gift-item-product">
        <div id="gift-item-product">
          <ProductPicker
            value={value.productId}
            excludeComposition
            disabled={disabled}
            placeholder={t('pickProduct')}
            ariaLabel={t('pickProduct')}
            onChange={(id) => onChange({ ...blankItem(), productId: id, qty: value.qty })}
          />
        </div>
      </Field>

      {loading && (
        <p className="flex items-center gap-2 text-[12px] text-[var(--ap-text-3)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> {t('optionsLoading')}
        </p>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {options && !options.giftable && <Banner kind="warn">{t('notGiftable')}</Banner>}

      {options && (
        <Grid cols={2}>
          <Field ar={t('saleType')} en="Sale type">
            <Select
              value={value.saleType}
              disabled={disabled}
              onChange={(e) => {
                const saleType = e.target.value === 'pre_order' ? 'pre_order' : 'direct_sale';
                set({ saleType, transportMethod: saleType === 'pre_order' ? ((routes[0] as ItemInput['transportMethod']) ?? '') : '' });
              }}
            >
              {saleTypes.map((s) => (
                <option key={s} value={s}>
                  {s === 'pre_order' ? t('salePreorder') : t('saleDirect')}
                </option>
              ))}
            </Select>
          </Field>
          {value.saleType === 'pre_order' && (
            <Field ar={t('route')} en="Route">
              <Select value={value.transportMethod} disabled={disabled} onChange={(e) => set({ transportMethod: e.target.value as ItemInput['transportMethod'] })}>
                <option value="">{t('chooseValue')}</option>
                {routes.map((m) => (
                  <option key={m} value={m}>
                    {m === 'air' ? t('routeAir') : m === 'sea' ? t('routeSea') : t('routeLand')}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {groups.map((g) => (
            <Field key={g.id || 'legacy'} ar={g.name_en ? `${t('model')} · ${g.name_en}` : t('model')} en="Model">
              <Select value={pickedByGroup[g.id] ?? ''} disabled={disabled} onChange={(e) => pickValue(g.id, e.target.value)}>
                <option value="">{t('chooseValue')}</option>
                {g.values
                  .filter((v) => v.sale_types.length === 0 || v.sale_types.includes(value.saleType))
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {nameOf(lang, v)}
                      {v.stock !== null && value.saleType === 'direct_sale' ? ` — ${t('stock')} ${v.stock}` : ''}
                    </option>
                  ))}
              </Select>
            </Field>
          ))}
          {(options.colors ?? []).length > 0 && (
            <Field ar={t('color')} en="Colour">
              <Select value={value.colorId} disabled={disabled} onChange={(e) => set({ colorId: e.target.value })}>
                <option value="">{t('noColor')}</option>
                {colors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {nameOf(lang, c)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field ar={t('qty')} en="Quantity">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              dir="ltr"
              disabled={disabled}
              className={`${T.input} w-full`}
              value={value.qty}
              onChange={(e) => set({ qty: Math.max(1, Math.min(99, Math.trunc(Number(e.target.value) || 1))) })}
            />
          </Field>
        </Grid>
      )}
    </div>
  );
}
