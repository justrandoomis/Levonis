/**
 * «تُحفظ تحت» — the product, option, model code and model name a batch of
 * serials is filed under. Chosen ONCE and kept for every following serial,
 * which is what makes scanning box after box fast: the owner picks «A1 Combo»
 * and then only points the camera.
 *
 * The product decides whether a buyer can ever link the serial (a serial
 * links only to the buyer's delivered unit of the SAME product), so the two
 * ways that can fail are said here, before anything is saved: no product at
 * all, or a product whose delivery creates no units.
 */
import { useEffect, useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import ProductPicker from '../../adminProducts/form/ProductPicker';
import { inventoryApi, type Filing, type InventoryStrings } from './model';

export interface FilingState extends Filing {
  product_name: string;
  /** From the server: delivery creates units for this product. Null = not known yet. */
  serialized: boolean | null;
}

export const EMPTY_FILING: FilingState = { product_id: '', variant_id: '', model_code: '', model_name: '', product_name: '', serialized: null };

export default function FilingFields({
  t,
  value,
  onChange,
  disabled = false,
}: {
  t: InventoryStrings;
  value: FilingState;
  onChange: (next: FilingState) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [variants, setVariants] = useState<Array<{ id: string; combo_key: string; sku: string | null }>>([]);

  // The product's options, and whether delivery serializes it — one read each
  // time the product changes.
  useEffect(() => {
    let live = true;
    setVariants([]);
    if (!value.product_id) return;
    inventoryApi
      .variants(value.product_id)
      .then((r) => live && setVariants(r.variants))
      .catch(() => undefined);
    inventoryApi
      .previewRows([], value)
      .then((r) => {
        if (live && r.product) onChange({ ...value, serialized: r.product.serialized });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Only the product id drives these reads; `value` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.product_id]);

  return (
    <fieldset className={`${T.surface} p-3 sm:p-4 space-y-3`} disabled={disabled} data-serial-filing>
      <legend className="sr-only">{t.filing}</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-[var(--ap-text-1)]">{t.filing}</span>
        <span className="text-[11.5px] text-[var(--ap-text-3)]">{t.filingHint}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]" id={`${id}-p`}>
            {t.product}
          </span>
          <ProductPicker
            value={value.product_id}
            ariaLabel={t.product}
            placeholder={t.pickProduct}
            onChange={(pid, p) =>
              onChange({
                ...value,
                product_id: pid,
                variant_id: '',
                product_name: p ? p.name_en || p.name_ar : '',
                serialized: null,
                // A blank model name takes the product's name; a typed one is kept.
                model_name: value.model_name || (p ? p.name_en || p.name_ar : ''),
              })
            }
          />
        </div>
        {variants.length > 0 && (
          <label className="min-w-0 block">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.variant}</span>
            <select
              className={`${T.select} w-full`}
              value={value.variant_id}
              onChange={(e) => onChange({ ...value, variant_id: e.target.value })}
            >
              <option value="">{t.anyVariant}</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.combo_key}
                  {v.sku ? ` · ${v.sku}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <label className="min-w-0 block">
          <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.modelCode}</span>
          <input
            className={`${T.input} w-full font-mono`}
            dir="ltr"
            value={value.model_code}
            maxLength={60}
            placeholder={t.modelCodePh}
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => onChange({ ...value, model_code: e.target.value })}
          />
        </label>
        <label className="min-w-0 block">
          <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.modelName}</span>
          <input
            className={`${T.input} w-full`}
            dir="auto"
            value={value.model_name}
            maxLength={120}
            placeholder={t.modelNamePh}
            onChange={(e) => onChange({ ...value, model_name: e.target.value })}
          />
        </label>
      </div>
      {!value.product_id && (
        <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--ap-warning)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          {t.noProductWarn}
        </p>
      )}
      {value.product_id && value.serialized === false && (
        <p role="alert" className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--ap-danger)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          {t.notSerialized}
        </p>
      )}
    </fieldset>
  );
}
