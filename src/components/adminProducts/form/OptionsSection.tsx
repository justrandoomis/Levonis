/**
 * Section 5 — options, colours and their links (mandate §7), reorganized on
 * the owner's review («غير مرتبه ومخربطه وهوسه» — busy and confusing):
 *
 *  - THE INVENTORY SOURCE IS AUTOMATIC. The four-button "مصدر المخزون"
 *    picker is gone: stock inputs are simply always there — on the product
 *    (section 4), on every option value and on every colour — and the most
 *    specific level that carries numbers wins (deriveInventoryMode). The
 *    strip at the top STATES which level is in force instead of asking the
 *    admin to choose it. The server model is untouched: one authoritative
 *    level, levels never summed.
 *  - Every option value and colour can carry ITS OWN IMAGE (a compact
 *    upload slot) — the storefront shows it when the customer taps that
 *    choice.
 *  - The colour row uses a REAL colour picker next to the hex text, not a
 *    bare text field.
 *
 * The link matrix keeps its wording («اربط اللون بخيارات محددة…») — the §12
 * evidence screenshots anchor on it.
 *
 * NO DINAR PRICE IS TYPED HERE ANY MORE (Pricing V2, the clean start: DECISIONS
 * row 222, implementation spec §5.4, §5.5 and addendum A.6). The option and
 * colour price / subscriber / cost cells, the direct cell's extra, the
 * route's surcharge and the colour spread warning are gone:
 * a model's and a colour's price is ONE selector in dollars, mounted by the
 * form through `pricingV2` (form/v2/ModelPriceSelector, ColourPriceSelector),
 * and the price shown beside it is the server's. The structure — models,
 * colours, links, «يُباع» with its routes and lead times, stock — stays here
 * for everyone. The stored price columns of each row travel back unchanged
 * and unseen (the V2 writer owns the published prices).
 */

import React from 'react';
import { Trash2, GripVertical } from 'lucide-react';
import {
  Field,
  ImgSlot,
  Grid,
  Qty,
  Repeater,
  TextInput,
  Toggle,
  btnGhost,
  iconBtn,
  field as fieldCls,
} from './formUi';
import {
  deriveInventoryMode,
  cleanDanglingImageBindings,
  combinationKey,
  directStockCombinations,
  emptyFulfillment,
  emptyPrices,
  localId,
  inheritedDimensionsForSelection,
  type FormColor,
  type FormGroup,
  type FormFulfillment,
  type FormTransport,
  type FormVariant,
  type FormValue,
  type RelationsState,
} from './model';
import { emptyDimensions, type ProductDimensionsV2 } from '../../../lib/productTypes';
import { DimensionsSection } from './DimensionsSection';
import { optionDimsHeading } from './v2/v2Model';

/**
 * The dollar price selectors the form mounts in section ٥ (Pricing V2, spec
 * §5.4): one per model card, one per colour card, the SKU result line in each
 * exact-stock row, and the colours' bulk bar.
 */
export interface OptionsPricingV2 {
  /**
   * `isModel`: the value belongs to the model group (the first group) — a fixed price and a discount name a model only.
   * `onDims`: the «أبعاد الخيار» patcher of the value — «تكلفة مختلفة» edits the same weight and box (row 247).
   */
  model: (value: FormValue, isModel: boolean, onDims: (dimensions: ProductDimensionsV2) => void) => React.ReactNode;
  colour: (color: FormColor) => React.ReactNode;
  combo?: (combo: { option_value_ids: string[]; color_id: string | null }) => React.ReactNode;
  colourBar?: React.ReactNode;
}

export function OptionsSection({
  rel,
  setRel,
  baseDimensions,
  errors,
  pricingV2,
}: {
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  /** Product measurements inherited by every selection rung. */
  baseDimensions: ProductDimensionsV2;
  errors: Record<string, string>;
  /** The dollar price selectors (Pricing V2); absent, the section edits structure only. */
  pricingV2?: OptionsPricingV2;
}) {
  // Every mutation re-derives the inventory source, so the explainer strip,
  // the section summary and the saved wire all tell the same story.
  const setRelAuto = (fn: (r: RelationsState) => RelationsState) =>
    setRel((r) => {
      const next = cleanDanglingImageBindings(fn(r));
      return { ...next, inventory_mode: deriveInventoryMode(next) };
    });

  const addGroup = () =>
    setRelAuto((r) => ({
      ...r,
      groups: [...r.groups, { id: localId('og'), name_en: '', sort: r.groups.length, active: true, values: [] }],
    }));

  const patchGroup = (id: string, patch: Partial<FormGroup>) =>
    setRelAuto((r) => ({ ...r, groups: r.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));

  const removeGroup = (id: string) =>
    setRelAuto((r) => {
      const gone = new Set((r.groups.find((g) => g.id === id)?.values ?? []).map((v) => v.id));
      return {
        ...r,
        groups: r.groups.filter((g) => g.id !== id),
        // A link or a variant pointing at a removed value would be a dangling
        // reference the server would reject, so they are cleaned here too.
        colors: r.colors.map((c) => ({
          ...c,
          option_value_ids: c.option_value_ids.filter((v) => !gone.has(v)),
        })),
        variants: r.variants.filter((v) => !v.option_value_ids.some((x) => gone.has(x))),
      };
    });

  const addValue = (groupId: string) =>
    setRelAuto((r) => {
      const current = r.groups.flatMap((g) => g.values).flatMap((v) => v.fulfillments).filter((f) => f.enabled);
      const direct = current.length === 0 || current.some((f) => f.fulfillment_type === 'direct_sale');
      const preorder = current.some((f) => f.fulfillment_type === 'pre_order');
      return {
        ...r,
        groups: r.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                values: [
                  ...g.values,
                  {
                    id: localId('ov'),
                    name_en: '',
                    sku_part: '',
                    image: '',
                    sort: g.values.length,
                    active: true,
                    stock: null,
                    reserved: 0,
                    low_stock_threshold: null,
                    ...emptyPrices(),
                    availability_type: '',
                    lead_time_text: '',
                    lead_time_min_days: null,
                    lead_time_max_days: null,
                    variant_key: '',
                    variant_label: '',
                    fulfillments: [
                      emptyFulfillment('direct_sale', direct),
                      emptyFulfillment('pre_order', preorder),
                    ],
                    dimensions: emptyDimensions(),
                  },
                ],
              }
            : g
        ),
      };
    });

  const patchValue = (groupId: string, id: string, patch: Partial<FormValue>) =>
    setRelAuto((r) => ({
      ...r,
      groups: r.groups.map((g) =>
        g.id === groupId ? { ...g, values: g.values.map((v) => (v.id === id ? { ...v, ...patch } : v)) } : g
      ),
      // Once another model uses colour stock the product switches to exact
      // combination inventory. Keep this option's colour-less shelf in sync
      // with the option input so a mixed product never saves a stale number.
      variants: 'stock' in patch || 'low_stock_threshold' in patch
        ? r.variants.map((variant) =>
            variant.color_id === null && variant.option_value_ids.length === 1 && variant.option_value_ids[0] === id
              ? {
                  ...variant,
                  ...('stock' in patch ? { stock: patch.stock ?? null } : {}),
                  ...('low_stock_threshold' in patch
                    ? { low_stock_threshold: patch.low_stock_threshold ?? null }
                    : {}),
                }
              : variant
          )
        : r.variants,
    }));

  const removeValue = (groupId: string, id: string) =>
    setRelAuto((r) => ({
      ...r,
      groups: r.groups.map((g) => (g.id === groupId ? { ...g, values: g.values.filter((v) => v.id !== id) } : g)),
      colors: r.colors.map((c) => ({ ...c, option_value_ids: c.option_value_ids.filter((x) => x !== id) })),
      variants: r.variants.filter((v) => !v.option_value_ids.includes(id)),
    }));

  const addColor = () =>
    setRelAuto((r) => ({
      ...r,
      colors: [
        ...r.colors,
        {
          id: localId('pc'),
          name_en: '',
          hex: '#000000',
          image: '',
          sku_part: '',
          sort: r.colors.length,
          active: true,
          stock: null,
          reserved: 0,
          low_stock_threshold: null,
          option_value_ids: [],
          dimensions: emptyDimensions(),
          ...emptyPrices(),
        },
      ],
    }));

  const patchColor = (id: string, patch: Partial<FormColor>) =>
    setRelAuto((r) => ({ ...r, colors: r.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  /**
   * HIDDEN IS A STATE THE ADMIN CAN SEE, AND UNDO IN ONE TAP.
   *
   * A colour with `active = 0` is invisible on the product page and, until the
   * hydration was corrected, invisible HERE too — the toggle read «معروض» for
   * every one of them. A live product reached twenty-five hidden colours that
   * way, and the only cure the form offered was twenty-five taps.
   *
   * The banner states the count and the consequence in the same sentence, and
   * «إظهار الكل» is the whole repair. Shown only when something IS hidden, so
   * an ordinary product carries no extra furniture.
   */
  const hiddenColors = rel.colors.filter((c) => !c.active).length;
  const showAllColors = () =>
    setRelAuto((r) => ({ ...r, colors: r.colors.map((c) => ({ ...c, active: true })) }));

  /**
   * The compact option/colour slots are views onto product_images. They do
   * not own a second URL field: upload replaces/adds the bound media row and
   * clearing the slot merely returns that row to the general gallery.
   */
  const boundImage = (kind: 'option' | 'color', id: string) =>
    rel.images.find((image) =>
      kind === 'option' ? image.option_value_id === id : image.color_id === id
    );
  const setBoundImage = (
    kind: 'option' | 'color',
    id: string,
    asset: {
      url: string;
      key: string;
      width: number | null;
      height: number | null;
      bytes: number | null;
      content_type: string;
    } | null
  ) =>
    setRelAuto((r) => {
      const found = r.images.find((image) =>
        kind === 'option' ? image.option_value_id === id : image.color_id === id
      );
      if (asset === null) {
        if (!found) return r;
        return {
          ...r,
          images: r.images.map((image) =>
            image.id === found.id
              ? {
                  ...image,
                  option_value_id: kind === 'option' ? null : image.option_value_id,
                  color_id: kind === 'color' ? null : image.color_id,
                }
              : image
          ),
        };
      }
      const patch = {
        url: asset.url,
        r2_key: asset.key,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        content_type: asset.content_type,
        source_url: '',
        option_value_id: kind === 'option' ? id : null,
        color_id: kind === 'color' ? id : null,
        variant_id: null,
      };
      if (found) {
        return {
          ...r,
          images: r.images.map((image) => (image.id === found.id ? { ...image, ...patch } : image)),
        };
      }
      return {
        ...r,
        images: [
          ...r.images,
          {
            id: localId('pi'),
            alt_en: '',
            sort_order: r.images.length,
            is_primary: r.images.length === 0,
            alt_ar: '',
            alt_ckb: '',
            ...patch,
          },
        ],
      };
    });

  const removeColor = (id: string) =>
    setRelAuto((r) => ({
      ...r,
      colors: r.colors.filter((c) => c.id !== id),
      variants: r.variants.filter((v) => v.color_id !== id),
      images: r.images.map((i) => (i.color_id === id ? { ...i, color_id: null } : i)),
    }));

  const optionById = new Map(rel.groups.flatMap((g) => g.values.map((v) => [v.id, v] as const)));

  const toggleLink = (colorId: string, valueId: string) =>
    setRelAuto((r) => {
      const next: RelationsState = {
        ...r,
        colors: r.colors.map((c) =>
          c.id === colorId
            ? {
                ...c,
                option_value_ids: c.option_value_ids.includes(valueId)
                  ? c.option_value_ids.filter((x) => x !== valueId)
                  : [...c.option_value_ids, valueId],
              }
            : c
        ),
      };
      const wanted = directStockCombinations(next);
      const existing = new Map(r.variants.map((v) => [combinationKey(v), v] as const));
      const retained = r.variants.filter((v) => v.color_id !== colorId);
      const retainedKeys = new Set(retained.map(combinationKey));
      return {
        ...next,
        variants: [
          ...retained,
          ...wanted.filter((combo) => !retainedKeys.has(combinationKey(combo))).map((combo) => {
            const optionStock = combo.color_id === null && combo.option_value_ids.length === 1
              ? r.groups.flatMap((g) => g.values).find((v) => v.id === combo.option_value_ids[0])?.stock ?? null
              : null;
            return existing.get(combinationKey(combo)) ?? {
              id: localId('pv'),
              option_value_ids: combo.option_value_ids,
              color_id: combo.color_id,
              sku: '',
              active: true,
              stock: optionStock,
              reserved: 0,
              low_stock_threshold: null,
              dimensions: emptyDimensions(),
              ...emptyPrices(),
            };
          }),
        ],
      };
    });

  const patchCombination = (
    combo: { option_value_ids: string[]; color_id: string | null },
    patch: Partial<FormVariant>
  ) =>
    setRelAuto((r) => {
      const key = combinationKey(combo);
      const found = r.variants.find((v) => combinationKey(v) === key);
      if (found) {
        return { ...r, variants: r.variants.map((v) => (v.id === found.id ? { ...v, ...patch } : v)) };
      }
      const made: FormVariant = {
        id: localId('pv'),
        option_value_ids: combo.option_value_ids,
        color_id: combo.color_id,
        sku: '',
        active: true,
        stock: null,
        reserved: 0,
        low_stock_threshold: null,
        dimensions: emptyDimensions(),
        ...emptyPrices(),
        ...patch,
      };
      return { ...r, variants: [...r.variants, made] };
    });

  const setCombinationStock = (
    combo: { option_value_ids: string[]; color_id: string | null },
    stock: number | null,
    low_stock_threshold?: number | null
  ) =>
    patchCombination(
      combo,
      low_stock_threshold === undefined ? { stock } : { stock, low_stock_threshold }
    );

  const directCombos = directStockCombinations(rel);
  const variantByKey = new Map(rel.variants.map((v) => [combinationKey(v), v] as const));
  const combosForOption = (optionId: string) => directCombos.filter((x) => x.option_value_ids.includes(optionId));
  const directEnabled = (value: FormValue) =>
    value.fulfillments.some((f) => f.fulfillment_type === 'direct_sale' && f.enabled);
  const optionStockTotal = (optionId: string) =>
    combosForOption(optionId).reduce((sum, combo) => {
      const row = variantByKey.get(combinationKey(combo));
      return sum + (row?.stock ?? 0);
    }, 0);

  return (
    <div className="min-w-0 space-y-4">
      <AutoStockNote rel={rel} />

      {/* ---------------------------------------------------- option groups */}
      <Repeater
        title="مجموعات الخيارات / Option groups"
        addLabel="مجموعة"
        onAdd={addGroup}
        empty="لا توجد مجموعات. أضف مجموعة مثل «المقاس» أو «السعة»."
      >
        {rel.groups.map((g, groupIndex) => (
          <div key={g.id} className="min-w-0 rounded-lg bg-surface-raised p-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <TextInput
                value={g.name_en}
                onChange={(e) => patchGroup(g.id, { name_en: e.target.value })}
                placeholder="Group name (English)"
                aria-label="Option group name"
              />
              <button type="button" onClick={() => removeGroup(g.id)} className={iconBtn} aria-label="حذف المجموعة">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {errors[`group:${g.id}`] && <p className="mt-1 text-[11px] text-danger">{errors[`group:${g.id}`]}</p>}

            <div className="mt-2.5 space-y-2">
              {g.values.map((v) => (
                <div key={v.id} className="min-w-0 rounded-lg border border-border-subtle p-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <ImgSlot
                      url={boundImage('option', v.id)?.url ?? ''}
                      label={`صورة الخيار ${v.name_en || ''}`}
                      onChange={(url) => {
                        if (url === null) setBoundImage('option', v.id, null);
                      }}
                      onUploaded={(asset) => setBoundImage('option', v.id, asset)}
                    />
                    <div className="min-w-0 flex-1">
                      <TextInput
                        value={v.name_en}
                        onChange={(e) => patchValue(g.id, v.id, { name_en: e.target.value })}
                        placeholder="Value (English)"
                        aria-label="Option value"
                      />
                      {(v.name_ar || v.name_ckb) && (
                        <p className="text-[10px] text-text-muted mt-0.5 truncate" dir="auto" data-form="value-imported-name" title="اسم محفوظ من القالب النصي">
                          {[v.name_ar, v.name_ckb].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    <TextInput
                      value={v.sku_part}
                      onChange={(e) => patchValue(g.id, v.id, { sku_part: e.target.value })}
                      placeholder="SKU part"
                      className="max-w-[100px]"
                      aria-label="SKU part"
                    />
                    <button
                      type="button"
                      onClick={() => removeValue(g.id, v.id)}
                      className={iconBtn}
                      aria-label="حذف الخيار"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {errors[`value:${v.id}`] && <p className="mt-1 text-[11px] text-danger">{errors[`value:${v.id}`]}</p>}
                  {/* The model's price — one dollar selector (Pricing V2, spec §5.4). */}
                  {pricingV2?.model(v, groupIndex === 0, (dimensions) => patchValue(g.id, v.id, { dimensions }))}
                  <FulfillmentEditor
                    value={v}
                    onChange={(fulfillments) => patchValue(g.id, v.id, { fulfillments })}
                    onValueChange={(patch) => patchValue(g.id, v.id, patch)}
                    error={errors[`value_availability:${v.id}`]}
                  />
                  <div className="mt-2">
                    <Grid cols={3}>
                      {directEnabled(v) && (
                        <>
                          <Field
                            ar="مخزون البيع المباشر"
                            en="Direct stock"
                            hint={
                              combosForOption(v.id).length > 0
                                ? 'محسوب تلقائيًا من مخزون الألوان المرتبطة بهذا الخيار'
                                : 'أدخل كمية البيع المباشر لهذا الخيار. الطلب المسبق لا يستخدم هذا الرقم.'
                            }
                          >
                            {combosForOption(v.id).length > 0 ? (
                              <div className="flex h-10 w-full min-w-0 items-center justify-between rounded-lg lv-well px-2.5 text-[13px] text-text-secondary" data-option-stock-total={v.id}>
                                <span>{optionStockTotal(v.id).toLocaleString('en-US')}</span>
                                <span className="text-[10px] text-text-muted">مجموع الألوان</span>
                              </div>
                            ) : (
                              <Qty value={v.stock} onChange={(n) => patchValue(g.id, v.id, { stock: n })} placeholder="مطلوب: 0 = نفد" />
                            )}
                          </Field>
                          {errors[`option_stock:${v.id}`] && (
                            <p className="text-[11px] text-danger sm:col-span-2">
                              {errors[`option_stock:${v.id}`]}
                            </p>
                          )}
                          {combosForOption(v.id).length === 0 && (
                            <Field ar="حد تنبيه الخيار" en="Option low-stock">
                              <Qty
                                value={v.low_stock_threshold}
                                onChange={(n) => patchValue(g.id, v.id, { low_stock_threshold: n })}
                                placeholder="بدون / none"
                              />
                            </Field>
                          )}
                        </>
                      )}
                      <Field ar="مفعّل" en="Active">
                        <Toggle
                          checked={v.active}
                          onChange={(b) => patchValue(g.id, v.id, { active: b })}
                          label={v.active ? 'معروض' : 'مخفي'}
                        />
                      </Field>
                    </Grid>
                  </div>
                  <DimensionsSection
                    dimensions={v.dimensions ?? emptyDimensions()}
                    inherited={baseDimensions}
                    collapsible
                    label={optionDimsHeading(v.name_en)}
                    onChange={(dimensions) => patchValue(g.id, v.id, { dimensions })}
                  />
                </div>
              ))}
              <button type="button" onClick={() => addValue(g.id)} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
                + قيمة / value
              </button>
            </div>
          </div>
        ))}
      </Repeater>

      {/* ---------------------------------------------------------- colours */}
      {hiddenColors > 0 ? (
        <div
          data-colors-hidden-notice
          className="lv-alert lv-alert-warning mb-2 flex flex-wrap items-center justify-between gap-2"
        >
          <span className="text-[13px] leading-snug text-text-primary">
            {hiddenColors === rel.colors.length
              ? `كل الألوان (${hiddenColors}) مخفية — لا يظهر أي لون في صفحة المنتج.`
              : `${hiddenColors} من ${rel.colors.length} ألوان مخفية — لا تظهر في صفحة المنتج.`}
          </span>
          <button
            type="button"
            onClick={showAllColors}
            className="lv-button lv-button-secondary lv-button-sm shrink-0"
          >
            إظهار الكل
          </button>
        </div>
      ) : null}
      {pricingV2?.colourBar}
      <Repeater title="الألوان / Colours" addLabel="لون" onAdd={addColor} empty="لا توجد ألوان.">
        {rel.colors.map((c) => (
          <div key={c.id} className="min-w-0 rounded-lg bg-surface-raised p-2.5">
            <div className="flex items-center gap-2 min-w-0">
              {/* A real colour picker: the swatch IS the input. The hex text
                  beside it stays for paste-in exact values. */}
              <input
                type="color"
                dir="ltr"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : '#000000'}
                onChange={(e) => patchColor(c.id, { hex: e.target.value })}
                aria-label="اختيار اللون"
                className="w-10 h-10 rounded-lg border border-border-subtle bg-surface p-1 shrink-0 cursor-pointer"
              />
              <div className="min-w-0 flex-1">
                <TextInput
                  value={c.name_en}
                  onChange={(e) => patchColor(c.id, { name_en: e.target.value })}
                  placeholder="Colour name (English)"
                  aria-label="Colour name"
                />
                {(c.name_ar || c.name_ckb) && (
                  <p className="text-[10px] text-text-muted mt-0.5 truncate" dir="auto" data-form="color-imported-name" title="اسم محفوظ من القالب النصي">
                    {[c.name_ar, c.name_ckb].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <input
                type="text"
                dir="ltr"
                value={c.hex}
                onChange={(e) => patchColor(c.id, { hex: e.target.value })}
                placeholder="#000000"
                aria-label="HEX"
                className={`${fieldCls} max-w-[100px]`}
              />
              <ImgSlot
                url={boundImage('color', c.id)?.url ?? ''}
                label={`صورة اللون ${c.name_en || ''}`}
                onChange={(url) => {
                  if (url === null) setBoundImage('color', c.id, null);
                }}
                onUploaded={(asset) => setBoundImage('color', c.id, asset)}
              />
              <button type="button" onClick={() => removeColor(c.id)} className={iconBtn} aria-label="حذف اللون">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {(errors[`color:${c.id}`] || errors[`color_hex:${c.id}`]) && (
              <p className="mt-1 text-[11px] text-danger">{errors[`color:${c.id}`] ?? errors[`color_hex:${c.id}`]}</p>
            )}
            {/* The colour's price — «يتبع الموديل | ± $ فوق الموديل» (Pricing V2, decision C1). */}
            {pricingV2?.colour(c)}

            <div className="mt-2">
              <Grid cols={3}>
                <Field ar="مفعّل" en="Active">
                  <Toggle
                    checked={c.active}
                    onChange={(b) => patchColor(c.id, { active: b })}
                    label={c.active ? 'معروض' : 'مخفي'}
                  />
                </Field>
              </Grid>
            </div>
            <DimensionsSection
              dimensions={c.dimensions ?? emptyDimensions()}
              inherited={inheritedDimensionsForSelection(rel, baseDimensions, {
                option_value_ids: c.option_value_ids,
              })}
              collapsible
              label={`أبعاد ${c.name_en || 'اللون'} / Colour dimensions`}
              onChange={(dimensions) => patchColor(c.id, { dimensions })}
            />

            {/* ----------------------------------------------- link matrix */}
            {rel.groups.some((g) => g.values.length > 0) && (
              <div className="mt-2.5 rounded-lg border border-border-subtle p-2.5 min-w-0">
                <p className="text-[11px] text-text-secondary mb-2">
                  اربط اللون بخيارات محددة — داخل المجموعة «أو»، وبين المجموعات «و». بلا تحديد يظهر مع الجميع.
                  <span className="text-text-muted"> OR within a group, AND across groups.</span>
                </p>
                <div className="space-y-2">
                  {rel.groups
                    .filter((g) => g.values.length > 0)
                    .map((g) => (
                      <div key={g.id} className="min-w-0">
                        <div className="text-[11px] font-bold text-text-muted mb-1 truncate">
                          {g.name_en || 'Group'}
                        </div>
                        <div className="flex flex-wrap gap-1.5 min-w-0">
                          {g.values.map((v) => {
                            const on = c.option_value_ids.includes(v.id);
                            return (
                              <button
                                key={v.id}
                                type="button"
                                role="checkbox"
                                aria-checked={on}
                                onClick={() => toggleLink(c.id, v.id)}
                                className={`h-8 px-3 rounded-full border text-[12px] font-medium transition-colors max-w-full truncate ${
                                  on
                                    ? 'border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
                                    : 'border-border-subtle text-text-secondary hover:text-text-primary'
                                }`}
                              >
                                {v.name_en || v.id}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                </div>
                <p className="mt-2 text-[11px] text-text-muted">
                  {c.option_value_ids.length === 0
                    ? 'يظهر مع كل الخيارات / shown with every option'
                    : `مرتبط بـ ${c.option_value_ids.length} قيمة`}
                </p>
              </div>
            )}

            {directCombos.some((combo) => combo.color_id === c.id) && (
              <div className="mt-2.5 rounded-lg border border-success/30 p-2.5" data-color-direct-stock={c.id}>
                <div className="mb-2">
                  <p className="text-[12px] font-bold text-text-primary">مخزون البيع المباشر حسب الخيار</p>
                  <p className="text-[10px] text-text-muted">
                    لكل خيار مرتبط عدّاد مستقل. مخزون الخيار في الأعلى هو مجموع هذه الصفوف تلقائيًا.
                  </p>
                </div>
                {errors[`color_stock:${c.id}`] && (
                  <p className="mb-2 text-[11px] text-danger">{errors[`color_stock:${c.id}`]}</p>
                )}
                {c.stock !== null && (
                  <p className="mb-2 text-[10px] text-warning">
                    يوجد مخزون لون قديم ({c.stock.toLocaleString('en-US')}) محفوظ للتوافق؛ لا يُنسخ على الخيارات كي لا يتضاعف.
                  </p>
                )}
                <div className="space-y-2">
                  {directCombos
                    .filter((combo) => combo.color_id === c.id)
                    .map((combo) => {
                      const row = variantByKey.get(combinationKey(combo));
                      const label = combo.option_value_ids.map((id) => optionById.get(id)?.name_en || id).join(' / ');
                      return (
                        <div key={combinationKey(combo)} className="min-w-0 rounded-lg border border-border-subtle p-2">
                          <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-2 items-end">
                            <div className="min-w-0 pb-2 text-[12px] text-text-secondary truncate" title={label}>{label}</div>
                            <Field ar="المخزون" en="Stock">
                              <Qty
                                value={row?.stock ?? null}
                                onChange={(stock) => setCombinationStock(combo, stock)}
                                placeholder="0 = نفد"
                              />
                            </Field>
                            <Field ar="حد التنبيه" en="Low-stock">
                              <Qty
                                value={row?.low_stock_threshold ?? null}
                                onChange={(low) => setCombinationStock(combo, row?.stock ?? null, low)}
                                placeholder="بدون"
                              />
                            </Field>
                          </div>
                          <DimensionsSection
                            dimensions={row?.dimensions ?? emptyDimensions()}
                            inherited={inheritedDimensionsForSelection(rel, baseDimensions, combo)}
                            collapsible
                            label={`أبعاد ${label || 'التركيبة'} / Variant dimensions`}
                            onChange={(dimensions) => patchCombination(combo, { dimensions })}
                          />
                          {pricingV2?.combo?.(combo)}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        ))}
      </Repeater>

    </div>
  );
}

/**
 * States which stock level is in force — the admin no longer picks one.
 * Wording mirrors what the customer experiences: three stocks (product,
 * option, colour) and the most specific one that has numbers answers.
 */
function AutoStockNote({ rel }: { rel: RelationsState }) {
  const mode = rel.inventory_mode;
  const text =
    mode === 'VARIANT_COMBINATION'
      ? 'البيع المباشر يعتمد مخزون كل خيار × لون، ومخزون الخيار هو مجموع ألوانه المرتبطة.'
      : mode === 'COLOR'
        ? 'هذا المنتج ما زال يحمل مخزون ألوان قديمًا. اربط الألوان بالخيارات وأدخل مخزون كل صف للانتقال الآمن.'
        : mode === 'OPTION'
          ? 'البيع المباشر يعتمد مخزون كل خيار. عند ربط ألوان به يُعطّل حقله ويصبح المجموع من الألوان.'
          : 'لا يوجد مخزون بيع مباشر على الخيارات بعد. الطلب المسبق يبقى متاحًا/غير متاح فقط ولا يملك مخزونًا.';
  return (
    <div className="min-w-0 rounded-lg lv-well px-2.5 py-2">
      <p className="text-[12px] text-text-secondary font-bold mb-0.5">
        المخزون تلقائي <span className="text-[10px] font-medium text-text-muted">Automatic inventory source</span>
      </p>
      <p className="text-[11px] text-text-secondary leading-snug">{text}</p>
      <p className="text-[10px] text-text-muted mt-0.5">
        الطلب المسبق لا يستهلك هذا المخزون. Pre-order has no stock counter.
      </p>
    </div>
  );
}

/** Independent order-type switches for one real model. */
function FulfillmentEditor({
  value,
  onChange,
  onValueChange,
  error,
}: {
  value: FormValue;
  onChange: (next: FormFulfillment[]) => void;
  onValueChange: (patch: Partial<FormValue>) => void;
  error?: string;
}) {
  const cell = (type: 'direct_sale' | 'pre_order') =>
    value.fulfillments.find((f) => f.fulfillment_type === type) ?? emptyFulfillment(type);
  const direct = cell('direct_sale');
  const preorder = cell('pre_order');

  const replaceCell = (next: FormFulfillment) => {
    const rest = value.fulfillments.filter((f) => f.fulfillment_type !== next.fulfillment_type);
    onChange([...rest, next].sort((a, b) => a.sort - b.sort));
  };
  const route = (method: 'air' | 'sea' | 'land') =>
    preorder.transports.find((t) => t.method === method) ?? {
      ...emptyFulfillment('pre_order').transports.find((t) => t.method === method)!,
    };
  const replaceRoute = (next: FormTransport) =>
    replaceCell({
      ...preorder,
      transports: [
        ...preorder.transports.filter((t) => t.method !== next.method),
        next,
      ].sort((a, b) => a.sort - b.sort),
    });

  const ROUTES = [
    { method: 'land' as const, ar: 'بري', en: 'Land' },
    { method: 'sea' as const, ar: 'بحري', en: 'Sea' },
    { method: 'air' as const, ar: 'جوي', en: 'Air' },
  ];

  return (
    <div className="mt-2.5 border-t border-border-subtle pt-2.5" data-option-availability={value.id}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className={`rounded-lg border p-2.5 ${direct.enabled ? 'border-success/30 bg-success/10' : 'border-border-subtle'}`}>
          <Toggle
            checked={direct.enabled}
            onChange={(enabled) => replaceCell({ ...direct, enabled })}
            label="بيع مباشر"
            sub="Direct sale"
          />
        </div>

        <div className={`rounded-lg border p-2.5 ${preorder.enabled ? 'border-info/30 bg-info/10' : 'border-border-subtle'}`}>
          <Toggle
            checked={preorder.enabled}
            onChange={(enabled) => replaceCell({ ...preorder, enabled })}
            label="طلب مسبق"
            sub="Pre-order — بلا مخزون"
          />
          {preorder.enabled && (
            <div className="mt-2 space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                {ROUTES.map((meta) => {
                  const current = route(meta.method);
                  return (
                    <div key={meta.method} className="rounded-md border border-border-subtle bg-surface p-2" data-preorder-route={meta.method}>
                      <Toggle
                        checked={current.enabled}
                        onChange={(enabled) => replaceRoute({ ...current, enabled })}
                        label={meta.ar}
                        sub={meta.en}
                      />
                    </div>
                  );
                })}
              </div>
              <Grid cols={3}>
                <Field ar="مدة التجهيز" en="Lead time" hint="مثال: 3-4 أسابيع">
                  <TextInput
                    value={preorder.lead_time_text}
                    onChange={(e) => replaceCell({ ...preorder, lead_time_text: e.target.value })}
                    placeholder="3-4 weeks"
                  />
                </Field>
                <Field ar="أقل عدد أيام" en="Min days">
                  <Qty
                    value={preorder.lead_time_min_days}
                    onChange={(lead_time_min_days) => replaceCell({ ...preorder, lead_time_min_days })}
                    placeholder="21"
                  />
                </Field>
                <Field ar="أكثر عدد أيام" en="Max days">
                  <Qty
                    value={preorder.lead_time_max_days}
                    onChange={(lead_time_max_days) => replaceCell({ ...preorder, lead_time_max_days })}
                    placeholder="28"
                  />
                </Field>
              </Grid>
            </div>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
      <div className="mt-2">
        <Grid cols={2}>
          <Field ar="اسم النسخة" en="Model" hint="مثل التعبئة أو البكرة الكاملة">
            <TextInput
              value={value.variant_label}
              onChange={(e) => onValueChange({ variant_label: e.target.value })}
              placeholder="Full spool"
            />
          </Field>
          <Field ar="مفتاح النسخة" en="Model key" hint="فارغ = يُشتق من الاسم">
            <TextInput
              value={value.variant_key}
              onChange={(e) => onValueChange({ variant_key: e.target.value })}
              placeholder="full-spool"
            />
          </Field>
        </Grid>
      </div>
    </div>
  );
}

export { GripVertical };
