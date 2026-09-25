/**
 * THE PRODUCT EDITOR — one sheet, basics first, the rest on demand.
 *
 * Always visible: photos and video, name, price, stock, and where the product
 * is (draft / published / hidden). One tap away, each with a one-line summary
 * of what it holds: options & variants, pricing & inventory details,
 * description & category, 3D-printing details, collections. A section with a
 * server error opens itself.
 *
 * WHAT IS SENT IS THE MERCHANT'S INPUT, NOT A DECISION. The server validates
 * every field (PRODUCT_INVALID lists each wrong one by path, shown beside the
 * field), refuses to publish what Levonis hid (PRODUCT_HIDDEN_BY_ADMIN), and
 * prices every sale itself. A legacy product (pre-0126 options/colours JSON)
 * is shown read-only with «convert to variants»: the conversion is a draft the
 * merchant completes with real stock — nothing is split on their behalf.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea, focusFirstInvalid } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Checkbox, Switch } from '../../ui/Switch';
import { ErrorState } from '../../ui/AsyncStates';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import {
  EMPTY_ATTRIBUTES, FINISHES, FINISH_NAMES, TECHNOLOGIES, TECHNOLOGY_NAMES, type Attributes,
} from '../../../../packages/catalog/src/attributes';
import { SWATCHES, SWATCH_NAMES } from '../../../../packages/catalog/src/palette';
import { readLegacyList } from '../../../../packages/catalog/src/legacy';
import { allCombinations, comboKey } from '../../../../packages/catalog/src/variants';
import {
  catalogApi, type CatalogMedia, type CatalogProductDetail, type Collection, type ProductBody, type PublishState,
} from './catalogApi';
import { catalogStrings } from './strings';
import { Disclosure, readRefusal } from './parts';
import { MediaEditor } from './MediaEditor';
import {
  EMPTY_VARIANT_DRAFT, VariantEditor, draftFromDetail, draftToModel, localRef, type VariantDraft,
} from './VariantEditor';
import '../../catalog/swatches.css';

interface Form {
  name: string;
  description: string;
  price: number | null;
  compareAt: number | null;
  sku: string;
  trackStock: boolean;
  stock: number | null;
  lowStockAt: number | null;
  category: string;
  condition: string;
  prepDays: number | null;
  state: PublishState;
  featured: boolean;
  attributes: Attributes;
  media: CatalogMedia[];
  collectionIds: string[];
  variants: VariantDraft;
}

function formFrom(p: CatalogProductDetail | null, canSell: boolean): Form {
  if (!p) {
    return {
      name: '', description: '', price: null, compareAt: null, sku: '', trackStock: true, stock: 1, lowStockAt: null,
      category: '', condition: 'new', prepDays: 0, state: canSell ? 'published' : 'draft', featured: false,
      attributes: EMPTY_ATTRIBUTES, media: [], collectionIds: [], variants: EMPTY_VARIANT_DRAFT,
    };
  }
  return {
    name: p.name ?? '',
    description: p.description ?? '',
    price: p.price_iqd,
    compareAt: p.compare_at_iqd ?? p.original_price_iqd ?? null,
    sku: p.sku ?? '',
    trackStock: p.track_stock,
    stock: p.stock,
    lowStockAt: p.low_stock_threshold,
    category: p.category ?? '',
    condition: p.condition || 'new',
    prepDays: p.prep_days ?? 0,
    state: p.state,
    featured: p.featured,
    attributes: { ...EMPTY_ATTRIBUTES, ...p.attributes },
    media: p.media.length
      ? p.media
      : (p.images ?? []).map((url) => ({ kind: 'image' as const, key: url.replace(/^\/files\//, ''), url, alt: '', alt_ar: '' })),
    collectionIds: p.collection_ids ?? [],
    variants: draftFromDetail(p),
  };
}

function bodyFrom(f: Form, original: CatalogProductDetail | null): ProductBody {
  const hasVariants = f.variants.groups.length > 0;
  const body: ProductBody = {
    name: f.name.trim(),
    description: f.description.trim(),
    price_iqd: f.price ?? undefined,
    compare_at_iqd: f.compareAt,
    sku: f.sku.trim(),
    track_stock: f.trackStock,
    low_stock_threshold: f.lowStockAt,
    category: f.category.trim(),
    condition: f.condition,
    prep_days: f.prepDays ?? 0,
    state: f.state,
    featured: f.featured,
    attributes: f.attributes,
    media: f.media.map((m) => ({ key: m.key, alt: m.alt, alt_ar: m.alt_ar })),
    collection_ids: f.collectionIds,
  };
  if (!hasVariants) body.stock = f.stock ?? 0;
  // Variants: sent when the merchant has them, or to leave them (null). A
  // legacy product untouched keeps selling by its old lists: nothing is sent.
  if (hasVariants) body.variant_model = draftToModel(f.variants);
  else if (original?.variant_mode === 'variants') body.variant_model = null;
  return body;
}

export default function ProductEditorSheet({
  open,
  productId,
  canSell,
  collections,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = a new product. */
  productId: string | null;
  canSell: boolean;
  collections: Collection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { loc, lang } = useLanguage();
  const s = catalogStrings(loc);
  const toast = useToast();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [original, setOriginal] = useState<CatalogProductDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<Form>(() => formFrom(null, canSell));
  const [initial, setInitial] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState<Array<{ id: string; name_en: string; name_ar: string }> | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError('');
    setBusy(false);
    setLoadError(null);
    if (!productId) {
      const f = formFrom(null, canSell);
      setOriginal(null);
      setForm(f);
      setInitial(JSON.stringify(f));
      return;
    }
    let alive = true;
    setLoading(true);
    catalogApi
      .get(productId)
      .then((d) => {
        if (!alive) return;
        const f = formFrom(d.product, canSell);
        setOriginal(d.product);
        setForm(f);
        setInitial(JSON.stringify(f));
      })
      .catch((e) => alive && setLoadError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, productId, canSell, reload]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k as string]) setErrors((e) => ({ ...e, [k as string]: '' }));
  };
  const setAttr = <K extends keyof Attributes>(k: K, v: Attributes[K]) => setForm((f) => ({ ...f, attributes: { ...f.attributes, [k]: v } }));

  const dirty = open && !loading && initial !== '' && JSON.stringify(form) !== initial;
  const hiddenByAdmin = !!original?.moderation?.hidden_by_admin;
  const hasVariants = form.variants.groups.length > 0;
  const pictures = form.media.filter((m) => m.kind === 'image');
  const manual = collections.filter((c) => c.kind === 'manual');
  const variantErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(errors)) if (v && (k === 'variant_model' || k.startsWith('variant_model.'))) out[k.replace(/^variant_model\.?/, '')] = v;
    return out;
  }, [errors]);
  const has = (prefix: string) => Object.entries(errors).some(([k, v]) => v && (k === prefix || k.startsWith(`${prefix}.`)));

  function loadMaterials() {
    if (materials) return;
    catalogApi.materials().then(setMaterials).catch(() => setMaterials([]));
  }
  useEffect(() => {
    if (open && form.attributes.material && !materials) loadMaterials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.attributes.material]);

  function convertLegacy() {
    if (!original) return;
    const opts = readLegacyList(original.options);
    const cols = readLegacyList(original.colors);
    if (opts.ok === false || cols.ok === false) {
      setFormError(s.legacyUnreadable);
      return;
    }
    const groups = [
      opts.entries.length ? { ref: localRef('g'), name: loc('الخيار', 'Option'), name_ar: '', kind: 'choice' as const, values: opts.entries.map((e) => ({ ref: localRef('v'), name: e.label, name_ar: '', swatch: '' })) } : null,
      cols.entries.length ? { ref: localRef('g'), name: loc('اللون', 'Colour'), name_ar: '', kind: 'color' as const, values: cols.entries.map((e) => ({ ref: localRef('v'), name: e.label, name_ar: '', swatch: '' })) } : null,
    ].filter((g): g is NonNullable<typeof g> => !!g);
    if (!groups.length) return;
    const variants: VariantDraft['variants'] = {};
    // Every combination starts at ZERO stock: the merchant says how many of
    // each they have; nothing is guessed from the old shared count.
    for (const values of allCombinations(groups)) {
      variants[comboKey(values)] = { price_iqd: null, compare_at_iqd: null, stock: 0, sku: '', active: true, image_key: null, low_stock_threshold: null };
    }
    set('variants', { groups, variants });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (form.name.trim().length < 2) local.name = loc('اكتب اسمًا من حرفين على الأقل.', 'Write a name of at least 2 characters.'); // OWNER: Sorani to be written by hand.
    if (form.price === null || !Number.isInteger(form.price) || form.price < 0) local.price_iqd = loc('اكتب السعر بالدينار.', 'Enter the price in dinars.'); // OWNER: Sorani to be written by hand.
    setErrors(local);
    setFormError('');
    if (Object.keys(local).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    try {
      const body = bodyFrom(form, original);
      if (original) await catalogApi.update(original.id, body);
      else await catalogApi.create(body);
      toast.success(s.saved);
      onSaved();
      onClose();
    } catch (err) {
      const r = readRefusal(err, loc, s.saveFailed);
      setErrors(r.fields);
      setFormError(r.message || (Object.keys(r.fields).length ? s.fixErrors(Object.keys(r.fields).length) : ''));
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
    } finally {
      setBusy(false);
    }
  }

  const stateItems = (['draft', 'published', 'hidden'] as PublishState[])
    .concat(form.state === 'archived' ? ['archived'] : [])
    .map((id) => ({ id, label: s.state(id), disabled: id === 'published' && (hiddenByAdmin || (!canSell && original?.state !== 'published')) }));

  const summaryVariants = hasVariants
    ? s.variantsCount(Object.values(form.variants.variants).filter((v) => v.active).length)
    : original?.variant_mode === 'legacy' ? s.legacyChoices : s.sectionVariantsHint;
  const attrCount = Object.values(form.attributes).filter((v) => v !== null && v !== '').length;
  const materialName = (id: string) => {
    const m = materials?.find((x) => x.id === id);
    return m ? (lang === 'en' ? m.name_en : m.name_ar || m.name_en) : id.toUpperCase();
  };

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      detents={['large']}
      dirty={dirty && !busy}
      panelClassName="w-full sm:max-w-2xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{productId ? s.editProduct : s.newProduct}</h2>
        </div>
      }
      footer={
        <div className="flex gap-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">{s.cancel}</Button>
          <Button variant="primary" type="submit" form={`${titleId}-form`} loading={busy} disabled={loading || !!loadError} className="flex-[2]" data-save-product>
            {form.state === 'draft' ? s.saveDraft : s.save}
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3 px-5 py-4" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-2/3" />
        </div>
      ) : loadError ? (
        <ErrorState error={loadError} onRetry={() => setReload((n) => n + 1)} compact />
      ) : (
        <form id={`${titleId}-form`} ref={formRef} onSubmit={save} noValidate className="space-y-4 px-5 pb-6 pt-1" data-product-form>
          {hiddenByAdmin && (
            <div role="note" className="flex gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12.5px] leading-relaxed text-text-primary">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span>{s.hiddenByAdminHint(original?.moderation?.reason ?? '')}</span>
            </div>
          )}

          {original?.price_required && !hiddenByAdmin && (
            <div role="note" className="flex gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12.5px] leading-relaxed text-text-primary" data-price-required>
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span>{s.priceRequiredHint}</span>
            </div>
          )}

          <MediaEditor value={form.media} onChange={(m) => set('media', m)} s={s} disabled={busy} />
          {errors.media && <p className="lv-field-error">{errors.media}</p>}

          <Field label={s.name} error={errors.name} required>
            <Input value={form.name} maxLength={120} autoComplete="off" onChange={(e) => set('name', e.target.value)} name="name" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={s.priceIqd} error={errors.price_iqd} required>
              <NumberInput kind="money" value={form.price} onValueChange={(v) => set('price', v)} name="price" />
            </Field>
            {!hasVariants && form.trackStock && (
              <Field label={s.quantity} error={errors.stock}>
                <NumberInput kind="quantity" value={form.stock} min={0} onValueChange={(v) => set('stock', v)} name="stock" />
              </Field>
            )}
          </div>

          <Switch checked={form.trackStock} onChange={(v) => set('trackStock', v)} label={s.trackStock} description={s.trackStockHint} />

          <Field label={s.visibility} hint={s.stateHint(form.state)} error={errors.state}>
            <Segmented items={stateItems} value={form.state} onChange={(id) => set('state', id as PublishState)} label={s.visibility} group="product-state" size="sm" />
          </Field>

          <Disclosure
            title={s.sectionVariants}
            summary={summaryVariants}
            defaultOpen={hasVariants || original?.variant_mode === 'legacy'}
            forceOpen={has('variant_model')}
            testId="variants"
          >
            {original?.variant_mode === 'legacy' && !hasVariants && (
              <div className="space-y-2 rounded-xl border border-warning/30 bg-warning/10 p-3" data-legacy-panel>
                <p className="text-[13px] font-semibold text-text-primary">{s.legacyTitle}</p>
                <p className="text-[12.5px] leading-relaxed text-text-secondary">{s.legacyBody}</p>
                <LegacyList options={original.options} colors={original.colors} />
                <Button size="sm" variant="secondary" onClick={convertLegacy}>{s.legacyConvert}</Button>
                <p className="text-[12px] text-text-muted">{s.legacyConvertHint}</p>
              </div>
            )}
            <VariantEditor
              draft={form.variants}
              onChange={(d) => set('variants', d)}
              trackStock={form.trackStock}
              productPrice={form.price}
              pictures={pictures}
              s={s}
              errors={variantErrors}
            />
          </Disclosure>

          <Disclosure title={s.sectionPricing} summary={[form.compareAt ? s.compareAt : '', form.sku, form.lowStockAt !== null ? `${s.lowStock} ≤ ${form.lowStockAt}` : ''].filter(Boolean).join(' · ') || undefined} forceOpen={has('compare_at_iqd') || has('sku') || has('low_stock_threshold')}>
            <Field label={s.compareAt} hint={s.compareAtHint} error={errors.compare_at_iqd} optional>
              <NumberInput kind="money" value={form.compareAt} onValueChange={(v) => set('compareAt', v)} />
            </Field>
            {!hasVariants && (
              <Field label={s.sku} error={errors.sku} optional>
                <Input ltr value={form.sku} maxLength={64} spellCheck={false} onChange={(e) => set('sku', e.target.value)} />
              </Field>
            )}
            {form.trackStock && (
              <Field label={s.lowStockAt} hint={s.lowStockAtHint} error={errors.low_stock_threshold} optional>
                <NumberInput kind="number" decimals={0} min={0} value={form.lowStockAt} onValueChange={(v) => set('lowStockAt', v)} />
              </Field>
            )}
          </Disclosure>

          <Disclosure title={s.sectionDetails} summary={[form.category, form.description ? s.description : ''].filter(Boolean).join(' · ') || undefined} forceOpen={has('description') || has('category') || has('condition') || has('prep_days')}>
            <Field label={s.description} error={errors.description} optional>
              <Textarea value={form.description} rows={5} maxLength={6000} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={s.category} error={errors.category} optional>
                <Input value={form.category} maxLength={60} onChange={(e) => set('category', e.target.value)} />
              </Field>
              <Field label={s.condition} error={errors.condition}>
                <Select value={form.condition} onChange={(e) => set('condition', e.target.value)}>
                  <option value="new">{s.condNew}</option>
                  <option value="used">{s.condUsed}</option>
                  <option value="refurbished">{s.condRefurb}</option>
                </Select>
              </Field>
            </div>
            <Field label={s.prepDays} error={errors.prep_days} optional>
              <NumberInput kind="quantity" value={form.prepDays} min={0} max={365} onValueChange={(v) => set('prepDays', v)} />
            </Field>
            <Switch checked={form.featured} onChange={(v) => set('featured', v)} label={s.featured} />
          </Disclosure>

          <Disclosure
            title={s.sectionPrint}
            summary={attrCount ? [form.attributes.material ? materialName(form.attributes.material) : '', form.attributes.technology ? (lang === 'en' ? TECHNOLOGY_NAMES[form.attributes.technology].en : TECHNOLOGY_NAMES[form.attributes.technology].ar) : ''].filter(Boolean).join(' · ') || s.sectionPrintHint : s.sectionPrintHint}
            forceOpen={has('attributes')}
            testId="print"
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label={s.material} error={errors['attributes.material']} optional>
                <Select value={form.attributes.material ?? ''} onFocus={loadMaterials} onPointerDown={loadMaterials} onChange={(e) => setAttr('material', e.target.value || null)}>
                  <option value="">{s.notStated}</option>
                  {form.attributes.material && !materials?.some((m) => m.id === form.attributes.material) && (
                    <option value={form.attributes.material}>{form.attributes.material.toUpperCase()}</option>
                  )}
                  {(materials ?? []).map((m) => (
                    <option key={m.id} value={m.id}>{lang === 'en' ? m.name_en : m.name_ar || m.name_en}</option>
                  ))}
                </Select>
              </Field>
              <Field label={s.technology} error={errors['attributes.technology']} optional>
                <Select value={form.attributes.technology ?? ''} onChange={(e) => setAttr('technology', (e.target.value || null) as Attributes['technology'])}>
                  <option value="">{s.notStated}</option>
                  {TECHNOLOGIES.map((t) => (
                    <option key={t} value={t}>{lang === 'en' ? TECHNOLOGY_NAMES[t].en : TECHNOLOGY_NAMES[t].ar}</option>
                  ))}
                </Select>
              </Field>
              <Field label={s.printColor} error={errors['attributes.color']} optional>
                <div className="flex items-center gap-2">
                  <span className="lv-swatch text-[22px]" data-swatch={form.attributes.color ?? undefined} aria-hidden="true" />
                  <Select value={form.attributes.color ?? ''} onChange={(e) => setAttr('color', (e.target.value || null) as Attributes['color'])}>
                    <option value="">{s.notStated}</option>
                    {SWATCHES.map((k) => (
                      <option key={k} value={k}>{lang === 'en' ? SWATCH_NAMES[k].en : SWATCH_NAMES[k].ar}</option>
                    ))}
                  </Select>
                </div>
              </Field>
              <Field label={s.finish} error={errors['attributes.finish']} optional>
                <Select value={form.attributes.finish ?? ''} onChange={(e) => setAttr('finish', (e.target.value || null) as Attributes['finish'])}>
                  <option value="">{s.notStated}</option>
                  {FINISHES.map((k) => (
                    <option key={k} value={k}>{lang === 'en' ? FINISH_NAMES[k].en : FINISH_NAMES[k].ar}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[12.5px] font-semibold text-text-secondary">{s.dimensions}</legend>
              <div className="grid grid-cols-3 gap-2">
                {([['dim_x_mm', s.width], ['dim_y_mm', s.depth], ['dim_z_mm', s.height]] as const).map(([k, label]) => (
                  <Field key={k} label={label} error={errors[`attributes.${k}`]}>
                    <NumberInput kind="number" decimals={1} min={0} max={5000} value={form.attributes[k]} onValueChange={(v) => setAttr(k, v)} />
                  </Field>
                ))}
              </div>
            </fieldset>
            <Field label={s.weight} error={errors['attributes.weight_g']} optional>
              <NumberInput kind="number" decimals={1} min={0} value={form.attributes.weight_g} onValueChange={(v) => setAttr('weight_g', v)} />
            </Field>
          </Disclosure>

          <Disclosure
            title={s.sectionCollections}
            summary={form.collectionIds.length ? manual.filter((c) => form.collectionIds.includes(c.id)).map((c) => (lang === 'en' ? c.name : c.name_ar || c.name)).join(' · ') : undefined}
            forceOpen={has('collection_ids')}
          >
            {manual.length === 0 ? (
              <p className="text-[12.5px] text-text-muted">{s.noCollections}</p>
            ) : (
              <div className="space-y-1">
                {manual.map((c) => (
                  <Checkbox
                    key={c.id}
                    checked={form.collectionIds.includes(c.id)}
                    onChange={(on) => set('collectionIds', on ? [...form.collectionIds, c.id] : form.collectionIds.filter((x) => x !== c.id))}
                    label={lang === 'en' ? c.name : c.name_ar || c.name}
                  />
                ))}
              </div>
            )}
            {errors.collection_ids && <p className="lv-field-error">{errors.collection_ids}</p>}
          </Disclosure>

          {formError && (
            <p role="alert" className="lv-field-error" data-form-error>
              {formError}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}

function LegacyList({ options, colors }: { options: unknown[]; colors: unknown[] }) {
  const o = readLegacyList(options);
  const c = readLegacyList(colors);
  const labels = [...(o.ok === true ? o.entries : []), ...(c.ok === true ? c.entries : [])].map((e) => e.label);
  if (!labels.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {labels.map((l, i) => (
        <li key={`${l}-${i}`} className="rounded-md border border-border-subtle px-2 py-0.5 text-[12px] text-text-secondary">{l}</li>
      ))}
    </ul>
  );
}
