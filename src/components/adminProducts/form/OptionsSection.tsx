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
 * evidence screenshots anchor on it. Cost is only rendered for a financial
 * admin — and the server refuses to write it either way (§11).
 */

import React, { useId } from 'react';
import { Trash2, GripVertical } from 'lucide-react';
import {
  Field,
  ImgSlot,
  Grid,
  Money,
  Qty,
  Repeater,
  TextInput,
  Toggle,
  TierPriceDisclosure,
  type TierPriceMark,
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
  type FormPrices,
  type FormFulfillment,
  type FormTransport,
  type FormVariant,
  type FormValue,
  type RelationsState,
} from './model';
// The SAME resolver the storefront and Quick Edit use — never a second copy of
// the ladder. `Field` is already a form component here, so the pricing type
// comes in as `GridField`.
import {
  rowCells,
  rowLadder,
  rowCharges,
  COLUMN_OF,
  type Cell,
  type Field as GridField,
} from '../../../../worker/lib/priceGrid';
import { ADJUST_OF, type PriceFields } from '../../../../worker/lib/pricing';
import { emptyDimensions, type ProductDimensionsV2 } from '../../../lib/productTypes';
import { DimensionsSection } from './DimensionsSection';

export function OptionsSection({
  rel,
  setRel,
  base,
  baseDimensions,
  canSeeCost,
  errors,
}: {
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  /** The product's own four prices — what an option inherits when it carries
   *  none of its own. Without it every option row would read «inherit» with no
   *  number beside it, which is the defect this section's price cells fix. */
  base: Record<GridField, number | null>;
  /** Product measurements inherited by every selection rung. */
  baseDimensions: ProductDimensionsV2;
  canSeeCost: boolean;
  errors: Record<string, string>;
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

  /**
   * WHAT A COLOUR INHERITS, AND WHEN THERE IS NO SINGLE ANSWER.
   *
   * The resolver's ladder is base → option → colour (pricing.ts `pick`), so a
   * colour's own price is measured over the OPTION the customer picked — not
   * over the base. A colour linked to exactly one option therefore resolves
   * under that option.
   *
   * A colour linked to SEVERAL has no single price, and that is the honest
   * answer rather than a defect to paper over: the same «+5,000» colour costs
   * 730,000 under the base model and 904,000 under the Combo. Falling back to
   * the base — which is what this did, matching `adminPriceGrid.ts` — showed a
   * number the customer can never be charged. It now resolves under the FIRST
   * linked option (a price that is really charged for a real combination) and
   * the row SAYS the number moves with the option, naming the range.
   */
  const optionById = new Map(rel.groups.flatMap((g) => g.values.map((v) => [v.id, v] as const)));

  const beneathColor = (c: FormColor): Record<GridField, number | null> => {
    const parent = c.option_value_ids.map((id) => optionById.get(id)).find(Boolean);
    if (!parent) return base;
    // `rowLadder`, not `rowCells`: the UNCLAMPED values, exactly as `buildGrid`
    // carries them down. `clampMemberLadder` is the resolver's last word on the
    // line the customer picked, not on what the next rung inherits.
    return rowLadder(parent as PriceFields, base);
  };

  /** The distinct regular prices this colour takes across its linked options. */
  const colorSpread = (c: FormColor): number[] => {
    if (c.option_value_ids.length < 2) return [];
    const seen = new Set<number>();
    for (const id of c.option_value_ids) {
      const parent = optionById.get(id);
      if (!parent) continue;
      const under = rowCharges(c as PriceFields, rowLadder(parent as PriceFields, base), 'color').regular.charged;
      if (under !== null) seen.add(under);
    }
    return [...seen].sort((a, b) => a - b);
  };

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
        {rel.groups.map((g) => (
          <div key={g.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
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
            {errors[`group:${g.id}`] && <p className="mt-1 text-[11px] text-red-400">{errors[`group:${g.id}`]}</p>}

            <div className="mt-2.5 space-y-2">
              {g.values.map((v) => (
                <div key={v.id} className="min-w-0 rounded-lg bg-zinc-800/30 border border-zinc-800 p-2.5">
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
                        <p className="text-[10px] text-zinc-500 mt-0.5 truncate" dir="auto" data-form="value-imported-name" title="اسم محفوظ من القالب النصي">
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
                  {(errors[`value:${v.id}`] || errors[`value_price:${v.id}`]) && (
                    <p className="mt-1 text-[11px] text-red-400">
                      {errors[`value:${v.id}`] ?? errors[`value_price:${v.id}`]}
                    </p>
                  )}
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
                              <div className={`${fieldCls} flex items-center justify-between bg-zinc-900/70 text-zinc-300`} data-option-stock-total={v.id}>
                                <span>{optionStockTotal(v.id).toLocaleString('en-US')}</span>
                                <span className="text-[10px] text-zinc-500">مجموع الألوان</span>
                              </div>
                            ) : (
                              <Qty value={v.stock} onChange={(n) => patchValue(g.id, v.id, { stock: n })} placeholder="مطلوب: 0 = نفد" />
                            )}
                          </Field>
                          {errors[`option_stock:${v.id}`] && (
                            <p className="text-[11px] text-red-400 sm:col-span-2">
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
                      <PriceCells
                        prices={v}
                        beneath={base}
                        level="option"
                        canSeeCost={canSeeCost}
                        onChange={(patch) => patchValue(g.id, v.id, patch)}
                      />
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
                    label={`أبعاد ${v.name_en || 'الخيار'} / Option dimensions`}
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
      <Repeater title="الألوان / Colours" addLabel="لون" onAdd={addColor} empty="لا توجد ألوان.">
        {rel.colors.map((c) => (
          <div key={c.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
            <div className="flex items-center gap-2 min-w-0">
              {/* A real colour picker: the swatch IS the input. The hex text
                  beside it stays for paste-in exact values. */}
              <input
                type="color"
                dir="ltr"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : '#000000'}
                onChange={(e) => patchColor(c.id, { hex: e.target.value })}
                aria-label="اختيار اللون"
                className="w-10 h-10 rounded-lg border border-zinc-700 bg-zinc-800/40 p-1 shrink-0 cursor-pointer"
              />
              <div className="min-w-0 flex-1">
                <TextInput
                  value={c.name_en}
                  onChange={(e) => patchColor(c.id, { name_en: e.target.value })}
                  placeholder="Colour name (English)"
                  aria-label="Colour name"
                />
                {(c.name_ar || c.name_ckb) && (
                  <p className="text-[10px] text-zinc-500 mt-0.5 truncate" dir="auto" data-form="color-imported-name" title="اسم محفوظ من القالب النصي">
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
            {(errors[`color:${c.id}`] || errors[`color_hex:${c.id}`] || errors[`color_price:${c.id}`]) && (
              <p className="mt-1 text-[11px] text-red-400">
                {errors[`color:${c.id}`] ?? errors[`color_hex:${c.id}`] ?? errors[`color_price:${c.id}`]}
              </p>
            )}

            <div className="mt-2">
              <Grid cols={3}>
                <PriceCells
                  prices={c}
                  beneath={beneathColor(c)}
                  level="color"
                  canSeeCost={canSeeCost}
                  onChange={(patch) => patchColor(c.id, patch)}
                  spread={colorSpread(c)}
                />
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
              <div className="mt-2.5 rounded-lg bg-zinc-800/20 border border-zinc-800 p-2.5 min-w-0">
                <p className="text-[11px] text-zinc-400 mb-2">
                  اربط اللون بخيارات محددة — داخل المجموعة «أو»، وبين المجموعات «و». بلا تحديد يظهر مع الجميع.
                  <span className="text-zinc-600"> OR within a group, AND across groups.</span>
                </p>
                <div className="space-y-2">
                  {rel.groups
                    .filter((g) => g.values.length > 0)
                    .map((g) => (
                      <div key={g.id} className="min-w-0">
                        <div className="text-[11px] font-bold text-zinc-500 mb-1 truncate">
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
                                className={`h-8 px-2.5 rounded-md border text-[12px] font-medium transition-colors max-w-full truncate ${
                                  on
                                    ? 'bg-[#6B46FF]/20 border-[#6B46FF]/60 text-white'
                                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-600'
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
                <p className="mt-2 text-[11px] text-zinc-500">
                  {c.option_value_ids.length === 0
                    ? 'يظهر مع كل الخيارات / shown with every option'
                    : `مرتبط بـ ${c.option_value_ids.length} قيمة`}
                </p>
              </div>
            )}

            {directCombos.some((combo) => combo.color_id === c.id) && (
              <div className="mt-2.5 rounded-lg border border-emerald-900/60 bg-emerald-950/15 p-2.5" data-color-direct-stock={c.id}>
                <div className="mb-2">
                  <p className="text-[12px] font-bold text-zinc-200">مخزون البيع المباشر حسب الخيار</p>
                  <p className="text-[10px] text-zinc-500">
                    لكل خيار مرتبط عدّاد مستقل. مخزون الخيار في الأعلى هو مجموع هذه الصفوف تلقائيًا.
                  </p>
                </div>
                {errors[`color_stock:${c.id}`] && (
                  <p className="mb-2 text-[11px] text-red-400">{errors[`color_stock:${c.id}`]}</p>
                )}
                {c.stock !== null && (
                  <p className="mb-2 text-[10px] text-amber-300">
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
                        <div key={combinationKey(combo)} className="min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-950/20 p-2">
                          <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-2 items-end">
                            <div className="min-w-0 pb-2 text-[12px] text-zinc-300 truncate" title={label}>{label}</div>
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
    <div className="min-w-0 rounded-lg border border-zinc-700 bg-zinc-800/30 px-2.5 py-2">
      <p className="text-[12px] text-zinc-300 font-bold mb-0.5">
        المخزون تلقائي <span className="text-[10px] font-medium text-zinc-500">Automatic inventory source</span>
      </p>
      <p className="text-[11px] text-zinc-400 leading-snug">{text}</p>
      <p className="text-[10px] text-zinc-600 mt-0.5">
        الطلب المسبق لا يستهلك هذا المخزون. Pre-order has no stock counter.
      </p>
    </div>
  );
}

/**
 * THE FOUR PRICES, SHOWING WHAT THIS ROW ACTUALLY CHARGES.
 *
 * WHY THIS IS NOT FOUR `Money` INPUTS ANY MORE. A price may be stored as a
 * FIXED number or as an ADJUSTMENT over the value beneath — the base+adjustment
 * shape `normalizeCheapestBase` deliberately writes so the product's own price
 * is the cheapest sellable one. In that shape `regular_price_iqd` is NULL and
 * `regular_adjust_iqd` holds the delta, so reading the four `*_price_iqd`
 * scalars raw showed «inherit» on a row the storefront was charging 899,000
 * for. The price was never missing; the form was reading the wrong half.
 *
 * The effective number now comes from `rowCells`, which is the SAME `priceMode`
 * / `step` / `memberAtRung` / `clampMemberLadder` chain the checkout resolver
 * and the Quick Edit grid use — not a second implementation that could drift.
 *
 * EDITING. What is shown is what is edited: typing a number pins it as a fixed
 * price for this row AND clears the adjustment beside it, so a fixed price and
 * an adjustment can never both be set (`pick` would silently ignore the
 * adjustment, and clearing the cell later would resurrect an ancient delta).
 * Clearing the input returns the row to inherit — both halves null.
 *
 * THE BOX ALWAYS HOLDS THE RESOLVED NUMBER, in every one of the three modes,
 * because "what will this row charge?" is the question the admin is asking and
 * an empty box was the whole defect. What distinguishes the modes is the line
 * BENEATH the box, which names the provenance of the number above it — and the
 * «يرث» button, which is how a pinned row goes back to following its parent
 * without the admin having to guess that blanking the field means that.
 */
function PriceCell({
  label_ar,
  label_en,
  tip,
  cell,
  charged,
  viaRegular,
  onCommit,
}: {
  label_ar: string;
  label_en: string;
  tip?: string;
  cell: Cell;
  /** What this tier is ACTUALLY charged — `chargedAt`, which includes the
   *  resolver's own fallback for a member tier that has no price anywhere. */
  charged: number | null;
  /** True when that number is the regular price standing in for a tier with
   *  no price of its own. Shown, never implied. */
  viaRegular: boolean;
  onCommit: (v: number | null) => void;
}) {
  const fmt = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat('en-US').format(n));
  const landing = cell.inherited ?? (viaRegular ? charged : null);
  /**
   * WIRED BY HAND, because `Field` cannot do it here. `Field` clones its
   * generated id onto its child only when that child is a SINGLE element
   * (`React.isValidElement(children)`); this cell has two — the input and the
   * provenance line — so `children` is an array, no clone happens, and the
   * `<label htmlFor>` would point at an element that does not exist. That is
   * three or four inputs per option value and per colour with no accessible
   * name and a label that does not focus them.
   */
  const inputId = useId();
  return (
    <Field ar={label_ar} en={label_en} tip={tip} htmlFor={inputId}>
      <Money
        id={inputId}
        value={charged}
        onChange={onCommit}
        placeholder={landing === null ? 'يرث / inherit' : `يرث ${fmt(landing)}`}
      />
      {/* THE PROVENANCE LINE. Never hidden, and never guessed: `cell.mode` is
          `priceMode`'s answer for this exact row, so the sentence under the box
          is the same fact the resolver acts on. */}
      <div className="mt-1 flex items-center justify-between gap-2 min-w-0">
        {cell.mode === 'adjust' && cell.adjust !== null ? (
          <p className="text-[10px] text-amber-500/80 truncate" data-price-mode="adjust">
            {cell.adjust >= 0 ? '+' : '−'}
            {fmt(Math.abs(cell.adjust))} فوق {fmt(cell.inherited)}
          </p>
        ) : cell.mode === 'fixed' ? (
          <p className="text-[10px] text-zinc-400 truncate" data-price-mode="fixed">
            سعر ثابت لهذا الصف
          </p>
        ) : (
          // Inherit, and the number in the box came from somewhere: say where,
          // so an untouched cell showing 885,000 is not mistaken for a pinned
          // one. A member cell inherits the value beneath PLUS this row's
          // regular surcharge — which is why an option with no PRIME price of
          // its own still shows a PRIME number, and why that number is right.
          //
          // `viaRegular` is the OTHER case, and it is the common one: the
          // product states no PRIME/PRO price at all, so the resolver charges
          // that member the regular price. The box shows what they pay and this
          // line says why, because an unexplained equal number reads as a bug
          // and an empty box reads as "free".
          <p className="text-[10px] text-zinc-500 truncate" data-price-mode={viaRegular ? 'regular-fallback' : 'inherit'}>
            {viaRegular
              ? `بلا سعر لهذه الفئة — تُحاسب بسعر البيع ${fmt(charged)}`
              : charged === null
                ? 'لا سعر — يرث ولا شيء فوقه'
                : `موروث: ${fmt(charged)}`}
          </p>
        )}
        {/* Returning to inheritance is a BUTTON, not a blanked field. Blanking
            works too (both halves go null), but an admin should not have to
            discover that. */}
        {cell.mode !== 'inherit' && (
          <button
            type="button"
            onClick={() => onCommit(null)}
            className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-200 underline underline-offset-2"
            data-price-inherit
            title="امسح سعر هذا الصف ليتبع ما فوقه"
          >
            يرث
          </button>
        )}
      </div>
    </Field>
  );
}

/**
 * WHICH TIERS THIS ROW HAS ACTUALLY TYPED — the answer the folded line prints
 * and the reason the panel opens by itself.
 *
 * Two things here are deliberate and both were wrong in the obvious version:
 *
 *   THE GATE IS `cell.mode`, not the scalar. `priceMode` is the resolver's own
 *   three-way answer (fixed / adjust / inherit) and it is already what decides
 *   whether this cell shows its «يرث» button. A check on
 *   `prices.pro_price_iqd !== null` reads one half of a pair: a row whose PRO
 *   is stored as `pro_adjust_iqd` — the shape `normalizeCheapestBase` and
 *   Quick Edit write — would read as untyped, fold shut, and hide a live
 *   override on one of a hundred colours. Truthiness would be worse still,
 *   because a typed 0 IS a price here (a colour's PRIME of 0 is charged as 0).
 *
 *   THE NUMBER COMES FROM `charges`, BUT ONLY AFTER THAT GATE HAS PASSED —
 *   and the order is the whole point. `rowCharges` returns
 *   `charged: v ?? regular`, the regular price standing in for a tier that has
 *   none, so `charges.pro.charged` is non-null on essentially every row:
 *   gating on it would stamp «سعر خاص · PRO …» on all hundred colours and the
 *   plain invitation would never appear once. That is why the gate is the
 *   mode. But `cell.effective` is the wrong number to PRINT, because it is
 *   this row's stored value before the rung carry, and the carry is not
 *   cosmetic: `memberAtRung` drops a member price that lands at zero or below,
 *   so an OPTION with a PRIME of 0 is charged the regular price (see `level`
 *   above). Printing `effective` there put «· PRIME 0 د.ع» on the folded line
 *   while the till took 885,000 and the cell inside the panel said so in
 *   words — the one line that exists so a row cannot hide its override was
 *   contradicting the box beneath it and telling the owner a customer pays
 *   nothing. `viaRegular` is precisely "this row states a price and the
 *   resolver charges the regular one instead", so it becomes `null` and
 *   `tierPriceSummary` prints «(لا يُحتسب)»: the mark survives — the row is
 *   still flagged as having something typed, which is rule 1 — while the
 *   amount stops lying.
 */
export function tierPriceMarks(
  cells: ReturnType<typeof rowCells>,
  charges: ReturnType<typeof rowCharges>,
): TierPriceMark[] {
  return ([['PRIME', 'prime'], ['PRO', 'pro']] as const)
    .filter(([, f]) => cells[f].mode !== 'inherit')
    .map(([label, f]) => ({ label, iqd: charges[f].viaRegular ? null : charges[f].charged }));
}

function PriceCells({
  prices,
  beneath,
  level,
  spread,
  canSeeCost,
  onChange,
}: {
  prices: FormPrices;
  /** What this row inherits: the product base for an option, the option's own
   *  resolved prices for a colour that hangs under one. */
  beneath: Record<GridField, number | null>;
  /**
   * WHICH RUNG THIS ROW IS. Not decoration: the resolver carries a member price
   * through the colour rung even when no colour is picked, and that carry
   * erases a value of zero or less. An option's PRIME of 0 is therefore charged
   * as the regular price, while a COLOUR's PRIME of 0 is charged as 0 — the
   * colour is the last rung and nothing carries it further.
   */
  level: 'option' | 'color';
  /** Colours only: the distinct prices this row takes across the options it is
   *  linked to. More than one means the number shown is one of several. */
  spread?: number[];
  canSeeCost: boolean;
  onChange: (patch: Partial<FormPrices>) => void;
}) {
  const cells = rowCells(prices as PriceFields, beneath);
  // The MODE, the adjustment and the inherited value come from the cells; the
  // NUMBER a customer is charged comes from `rowCharges`, which walks the same
  // rungs the resolver walks and in the same order.
  const charges = rowCharges(prices as PriceFields, beneath, level);
  /** One typed number pins the pair: fixed set, adjustment cleared. */
  const commit = (field: GridField) => (v: number | null) => {
    const col = COLUMN_OF[field];
    onChange({ [col]: v, [ADJUST_OF[col]]: null } as Partial<FormPrices>);
  };
  const cellProps = (field: GridField) => ({
    cell: cells[field],
    charged: charges[field].charged,
    viaRegular: charges[field].viaRegular,
    onCommit: commit(field),
  });
  const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);
  const memberMarks = tierPriceMarks(cells, charges);
  return (
    <>
      {/*
        A COLOUR LINKED TO SEVERAL OPTIONS HAS NO SINGLE PRICE. The same
        «+5,000» costs 730,000 under the base model and 904,000 under the
        Combo, because the resolver measures a colour over the OPTION the
        customer picked. The cells below show it under the first linked option
        — a price that is really charged for a real combination — and this says
        the number moves, with the range, instead of letting one of several
        read as the answer.
      */}
      {spread && spread.length > 1 && (
        <p
          className="col-span-full text-[10px] text-amber-400/90 leading-snug -mb-1"
          data-color-price-spread
        >
          هذا اللون مرتبط بعدة خيارات، وسعره يتغيّر معها: من {fmt(spread[0])} إلى {fmt(spread[spread.length - 1])}.
          الأرقام أدناه محسوبة على أول خيار مرتبط.
        </p>
      )}
      <PriceCell label_ar="السعر" label_en="Regular" {...cellProps('regular')} />
      {/*
        PRIME AND PRO FOLD; «السعر» AND «التكلفة» NEVER DO. The two member
        boxes are the ones an option or a colour usually says nothing about,
        and they are also the two that can quietly take this row out of the
        product's membership discount — so they get the line that names them
        when they are folded, and the panel that opens by itself when they are
        set. The nested `Grid cols={3}` matches the parent's track count so the
        two boxes stay under «السعر» instead of re-dividing the band into
        halves.
      */}
      <TierPriceDisclosure scope={level} marks={memberMarks}>
        <Grid cols={3}>
          <PriceCell label_ar="PRIME" label_en="PRIME" {...cellProps('prime')} />
          <PriceCell label_ar="PRO" label_en="PRO" {...cellProps('pro')} />
        </Grid>
      </TierPriceDisclosure>
      {canSeeCost && (
        <PriceCell
          label_ar="التكلفة"
          label_en="Cost"
          tip="إداري فقط — لا تظهر للعميل ولا لمساعد الأدمن."
          {...cellProps('cost')}
        />
      )}
    </>
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
    <div className="mt-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-2.5" data-option-availability={value.id}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className={`rounded-lg border p-2.5 ${direct.enabled ? 'border-emerald-700/60 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-900/30'}`}>
          <Toggle
            checked={direct.enabled}
            onChange={(enabled) => replaceCell({ ...direct, enabled })}
            label="بيع مباشر"
            sub="Direct sale"
          />
          {direct.enabled && (
            <div className="mt-2">
              <Field ar="زيادة البيع المباشر" en="Direct increase" hint="تخص هذا الخيار فقط وتُضاف إلى سعره الأساسي">
                <Money
                  value={direct.regular_adjust_iqd ?? null}
                  onChange={(regular_adjust_iqd) =>
                    replaceCell({ ...direct, regular_price_iqd: null, regular_adjust_iqd })
                  }
                  placeholder="بلا زيادة"
                />
              </Field>
            </div>
          )}
        </div>

        <div className={`rounded-lg border p-2.5 ${preorder.enabled ? 'border-violet-700/60 bg-violet-950/20' : 'border-zinc-800 bg-zinc-900/30'}`}>
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
                    <div key={meta.method} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2" data-preorder-route={meta.method}>
                      <Toggle
                        checked={current.enabled}
                        onChange={(enabled) => replaceRoute({ ...current, enabled })}
                        label={meta.ar}
                        sub={meta.en}
                      />
                      {current.enabled && (
                        <div className="mt-1.5">
                          <Money
                            value={current.surcharge_iqd}
                            onChange={(surcharge_iqd) => replaceRoute({ ...current, surcharge_iqd })}
                            placeholder="بلا زيادة"
                          />
                          <p className="mt-1 text-[10px] text-zinc-600">زيادة هذا المسار فقط؛ لا يوجد مخزون للطلب المسبق.</p>
                        </div>
                      )}
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
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
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
