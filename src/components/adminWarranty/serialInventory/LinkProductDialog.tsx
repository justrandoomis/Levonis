/**
 * «ربط بمنتج» — file serials that carry no product, in one step.
 *
 * With an EAN, every unlinked serial carrying it is filed at once
 * (POST /link-ean) and the inventory learns the EAN: the next box with it
 * files itself when scanned. Without one, only this serial is filed (the
 * ordinary PATCH). The owner's «بلا منتج» on seven A1 boxes is therefore one
 * choice, not seven edits.
 */
import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Link2 } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { Overlay } from '../../ui/Overlay';
import ProductPicker from '../../adminProducts/form/ProductPicker';
import { useLanguage } from '../../../LanguageContext';
import { inventoryApi, refusalText, type InventoryStrings } from './model';

export interface LinkTarget {
  /** The EAN whose unlinked serials are filed together, or '' for one serial. */
  ean: string;
  /** The serial the dialog was opened from (always filed). */
  serialNorm: string;
  serial: string;
  /** What the label says, shown to help the choice. */
  hint?: string | null;
}

export default function LinkProductDialog({
  t,
  target,
  onClose,
  onLinked,
}: {
  t: InventoryStrings;
  target: LinkTarget | null;
  onClose: () => void;
  onLinked: (result: { linked: number; productId: string; productName: string; ean: string }) => void;
}) {
  const titleId = useId();
  const { lang } = useLanguage();
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [variantId, setVariantId] = useState('');
  const [variants, setVariants] = useState<Array<{ id: string; combo_key: string; sku: string | null }>>([]);
  const [serialized, setSerialized] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Every opening starts clean.
  useEffect(() => {
    if (!target) return;
    setProductId('');
    setProductName('');
    setVariantId('');
    setVariants([]);
    setSerialized(null);
    setErr(null);
  }, [target]);

  useEffect(() => {
    let live = true;
    setVariants([]);
    setSerialized(null);
    if (!productId) return;
    inventoryApi
      .variants(productId)
      .then((r) => live && setVariants(r.variants))
      .catch(() => undefined);
    inventoryApi
      .previewRows([], { product_id: productId, variant_id: '', model_code: '', model_name: '' })
      .then((r) => live && setSerialized(r.product?.serialized ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [productId]);

  const submit = async () => {
    if (!target || !productId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (target.ean) {
        const res = await inventoryApi.linkEan(target.ean, productId, variantId);
        onLinked({ linked: res.linked, productId, productName: res.product.name || productName, ean: target.ean });
      } else {
        await inventoryApi.patch(target.serialNorm, { product_id: productId, variant_id: variantId || null });
        onLinked({ linked: 1, productId, productName, ean: '' });
      }
    } catch (e) {
      setErr(refusalText(e, t, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay
      open={!!target}
      onClose={onClose}
      labelledBy={titleId}
      placement="bottom"
      z={240}
      panelClassName="w-full sm:max-w-lg"
      testId="serial-link"
    >
      {target && (
        <div className={`${T.AP} p-4 sm:p-5 space-y-4`}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ap-accent-soft)] text-[var(--ap-accent-text)]">
              <Link2 className="h-4.5 w-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-[16px] font-bold text-[var(--ap-text-1)]">
                {t.linkTitle}
              </h2>
              <p className="mt-0.5 font-mono text-[12.5px] text-[var(--ap-text-2)]" dir="ltr">
                {target.serial}
                {target.ean ? ` · EAN ${target.ean}` : ''}
              </p>
              {target.hint && (
                <p className="mt-0.5 text-[12px] text-[var(--ap-text-3)]" dir="auto">
                  {target.hint} · {t.hintFromLabel}
                </p>
              )}
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--ap-text-2)]">{target.ean ? t.linkEanBody(target.ean) : t.linkOneBody}</p>
          <div className="space-y-3">
            <div>
              <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.product}</span>
              <ProductPicker
                value={productId}
                ariaLabel={t.product}
                placeholder={t.pickProduct}
                onChange={(pid, p) => {
                  setProductId(pid);
                  setProductName(p ? p.name_en || p.name_ar : '');
                  setVariantId('');
                }}
              />
            </div>
            {variants.length > 0 && (
              <label className="block">
                <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.variant}</span>
                <select className={`${T.select} w-full`} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
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
            {productId && serialized === false && (
              <p role="alert" className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--ap-danger)]">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
                {t.notSerialized}
              </p>
            )}
          </div>
          {err && (
            <p role="alert" className="text-[12.5px] text-[var(--ap-danger)]">
              {err}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={`${T.btnSecondary} min-h-[44px]`} onClick={onClose}>
              {t.cancel}
            </button>
            <button type="button" className={`${T.btnPrimary} min-h-[44px]`} disabled={!productId || busy} onClick={() => void submit()} data-serial-link-confirm>
              {busy ? t.committing : t.linkConfirm}
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}
