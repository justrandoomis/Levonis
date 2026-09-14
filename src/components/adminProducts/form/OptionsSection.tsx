import type { FulfillmentDefaults } from './ModelPricePreview';
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
import { ModelAvailabilityEditor as AvailabilityRow } from './ModelAvailabilityEditor';
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
  btnGhost,
  iconBtn,
  field as fieldCls,
} from './formUi';
import {
  deriveInventoryMode,
  emptyPrices,
  localId,
  type FormColor,
  type FormGroup,
  type FormPrices,
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
import { ADJUST_OF, type PriceFields, type PriceKey } from '../../../../worker/lib/pricing';

export function OptionsSection({
  rel,
  setRel,
  base,
  canSeeCost,
  errors,
  fulfillmentDefaults,
}: {
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  /** The product's own four prices — what an option inherits when it carries
   *  none of its own. Without it every option row would read «inherit» with no
   *  number beside it, which is the defect this section's price cells fix. */
  base: Record<GridField, number | null>;
  fulfillmentDefaults: FulfillmentDefaults;
  canSeeCost: boolean;
  errors: Record<string, string>;
}) {
  // Every mutation re-derives the inventory source, so the explainer strip,
  // the section summary and the saved wire all tell the same story.
  const setRelAuto = (fn: (r: RelationsState) => RelationsState) =>
    setRel((r) => {
      const next = fn(r);
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
    setRelAuto((r) => ({
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
                  low_stock_threshold: null,
                  ...emptyPrices(),
                  // '' = inherit the product's sale types. A new option is not
                  // assumed to be direct sale: that would silently make a
                  // pre-order product's new option sellable from stock.
                  availability_type: '',
                  lead_time_text: '',
                  lead_time_min_days: null,
                  lead_time_max_days: null,
                  variant_key: '',
                  variant_label: '',
                },
              ],
            }
          : g
      ),
    }));

  const patchValue = (groupId: string, id: string, patch: Partial<FormValue>) =>
    setRelAuto((r) => ({
      ...r,
      groups: r.groups.map((g) =>
        g.id === groupId ? { ...g, values: g.values.map((v) => (v.id === id ? { ...v, ...patch } : v)) } : g
      ),
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
          low_stock_threshold: null,
          option_value_ids: [],
          ...emptyPrices(),
        },
      ],
    }));

  const patchColor = (id: string, patch: Partial<FormColor>) =>
    setRelAuto((r) => ({ ...r, colors: r.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

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
    setRelAuto((r) => ({
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
    }));

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
                      url={v.image}
                      label={`صورة الخيار ${v.name_en || ''}`}
                      onChange={(url) => patchValue(g.id, v.id, { image: url ?? '' })}
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
                  <div className="mt-3"><p className="mb-2 text-xs text-zinc-400">أسعار الموديل / Model base pricing</p><Grid cols={3}>
                      <PriceCells
                        prices={v}
                        beneath={base}
                        level="option"
                        canSeeCost={canSeeCost}
                        onChange={(patch) => patchValue(g.id, v.id, patch)}
                      />

                  </Grid></div>
                  <AvailabilityRow
                    base={base}
                    defaults={fulfillmentDefaults}
                    canSeeCost={canSeeCost}
                    value={v}
                    onChange={(patch) => patchValue(g.id, v.id, patch)}
                    error={errors[`value_availability:${v.id}`]}
                  />
                  <div className="mt-2">
                    <Grid cols={3}>
                      {v.direct === undefined && v.preorder === undefined && <Field ar="المخزون الافتراضي للموديل" en="Model stock fallback" hint="يمكن تخصيص مخزون البيع المباشر أعلاه">
                        <Qty value={v.stock} onChange={(n) => patchValue(g.id, v.id, { stock: n })} />
                      </Field>}
                      <Field ar="حد التنبيه" en="Low-stock">
                        <Qty
                          value={v.low_stock_threshold}
                          onChange={(n) => patchValue(g.id, v.id, { low_stock_threshold: n })}
                          placeholder="بدون / none"
                        />
                      </Field>
                      <Field ar="مفعّل" en="Active">
                        <Toggle
                          checked={v.active}
                          onChange={(b) => patchValue(g.id, v.id, { active: b })}
                          label={v.active ? 'معروض' : 'مخفي'}
                        />
                      </Field>
                    </Grid>
                  </div>
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
                url={c.image}
                label={`صورة اللون ${c.name_en || ''}`}
                onChange={(url) => patchColor(c.id, { image: url ?? '' })}
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
                <Field ar="المخزون" en="Stock" hint="فارغ = لا يُحسب من هذا اللون">
                  <Qty value={c.stock} onChange={(n) => patchColor(c.id, { stock: n })} />
                </Field>
                <Field ar="حد التنبيه" en="Low-stock">
                  <Qty
                    value={c.low_stock_threshold}
                    onChange={(n) => patchColor(c.id, { low_stock_threshold: n })}
                    placeholder="بدون / none"
                  />
                </Field>
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
          </div>
        ))}
      </Repeater>

      {rel.inventory_mode === 'VARIANT_COMBINATION' && (
        <VariantsEditor rel={rel} setRel={setRel} canSeeCost={canSeeCost} errors={errors} />
      )}
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
      ? 'هذا المنتج يعتمد مخزون التركيبات (إعداد سابق) — عدّل الأرقام في جدول التركيبات أدناه.'
      : mode === 'COLOR'
        ? 'التوفر يُحسب الآن من مخزون الألوان — لأنك أدخلت أرقامًا على مستوى اللون، وهو الأدق.'
        : mode === 'OPTION'
          ? 'التوفر يُحسب الآن من مخزون الخيارات — أدخل رقمًا على لونٍ ما لينتقل الحساب إلى الألوان.'
          : 'التوفر يُحسب الآن من مخزون المنتج (قسم «البيع والتوفر») — أدخل أرقامًا على الخيارات أو الألوان لينتقل الحساب إليها تلقائيًا.';
  return (
    <div className="min-w-0 rounded-lg border border-zinc-700 bg-zinc-800/30 px-2.5 py-2">
      <p className="text-[12px] text-zinc-300 font-bold mb-0.5">
        المخزون تلقائي <span className="text-[10px] font-medium text-zinc-500">Automatic inventory source</span>
      </p>
      <p className="text-[11px] text-zinc-400 leading-snug">{text}</p>
      <p className="text-[10px] text-zinc-600 mt-0.5">
        مصدر واحد فقط هو الحقيقة — لا تُجمع الأرقام بين المستويات. One authoritative source; levels are never summed.
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
      <PriceCell label_ar="PRIME" label_en="PRIME" {...cellProps('prime')} />
      <PriceCell label_ar="PRO" label_en="PRO" {...cellProps('pro')} />
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

/** Combination stock (§7). Only rendered in VARIANT_COMBINATION mode, because
 *  in every other mode these rows would never be read. */
function VariantsEditor({
  rel,
  setRel,
  canSeeCost,
  errors,
}: {
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  canSeeCost: boolean;
  errors: Record<string, string>;
}) {
  const valueName = new Map(rel.groups.flatMap((g) => g.values.map((v) => [v.id, v.name_en || v.id] as const)));
  const colorName = new Map(rel.colors.map((c) => [c.id, c.name_en || c.id] as const));

  /** Every combination the current options and colours allow, honouring the
   *  colour links so an impossible pairing is never offered. */
  const generate = () => {
    const groups = rel.groups.filter((g) => g.values.filter((v) => v.active).length > 0);
    let combos: string[][] = [[]];
    for (const g of groups) {
      const next: string[][] = [];
      for (const c of combos) for (const v of g.values.filter((x) => x.active)) next.push([...c, v.id]);
      combos = next;
    }
    const colors = rel.colors.filter((c) => c.active);
    const rows: Array<{ option_value_ids: string[]; color_id: string | null }> = [];
    for (const combo of combos) {
      if (colors.length === 0) {
        rows.push({ option_value_ids: combo, color_id: null });
        continue;
      }
      for (const col of colors) {
        // Respect the link algebra: a linked colour only pairs with the values
        // it allows, so generation cannot create a row the server rejects.
        const linkedGroups = new Set(
          col.option_value_ids
            .map((vid) => rel.groups.find((g) => g.values.some((v) => v.id === vid))?.id)
            .filter(Boolean) as string[]
        );
        const ok = [...linkedGroups].every((gid) => {
          const chosen = combo.find((vid) => rel.groups.find((g) => g.id === gid)?.values.some((v) => v.id === vid));
          return chosen ? col.option_value_ids.includes(chosen) : false;
        });
        if (ok) rows.push({ option_value_ids: combo, color_id: col.id });
      }
    }
    setRel((r) => {
      const key = (x: { option_value_ids: string[]; color_id: string | null }) =>
        [...x.option_value_ids].sort().join('|') + '#' + (x.color_id ?? '');
      const existing = new Map(r.variants.map((v) => [key(v), v]));
      return {
        ...r,
        variants: rows.map(
          (row) =>
            existing.get(key(row)) ?? {
              id: localId('pv'),
              option_value_ids: row.option_value_ids,
              color_id: row.color_id,
              sku: '',
              active: true,
              stock: null,
              low_stock_threshold: null,
              ...emptyPrices(),
            }
        ),
      };
    });
  };

  /**
   * A combination price, written as the ONE canonical half.
   *
   * `priceMode` answers 'fixed' the moment `*_price_iqd` is set, so an
   * adjustment stored beside it is dead data the resolver ignores — right up
   * until someone clears the fixed price and a delta nobody typed wakes up.
   * The server collapses the pair on write (productPersistence `readPrices`);
   * clearing it here means the admin sees what was actually stored instead of
   * having their adjustment dropped behind a 200.
   */
  const setVariantPrice = (id: string, key: PriceKey, value: number | null) =>
    setRel((r) => ({
      ...r,
      variants: r.variants.map((x) => (x.id === id ? { ...x, [key]: value, [ADJUST_OF[key]]: null } : x)),
    }));

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-[13px] font-bold text-zinc-300 truncate">التركيبات / Combinations</h4>
        <button type="button" onClick={generate} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
          توليد التركيبات
        </button>
      </div>
      {rel.variants.length === 0 ? (
        <p className="text-[12px] text-amber-300">
          لا توجد تركيبات — لن يُباع أي شيء في هذا الوضع حتى تُنشئ واحدة على الأقل.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead>
              <tr className="text-zinc-500 text-[11px]">
                <th className="text-start font-bold py-1.5">التركيبة</th>
                <th className="text-start font-bold py-1.5 w-24">المخزون</th>
                <th className="text-start font-bold py-1.5 w-28">السعر</th>
                <th className="text-start font-bold py-1.5 w-28">PRIME</th>
                <th className="text-start font-bold py-1.5 w-28">PRO</th>
                {canSeeCost && <th className="text-start font-bold py-1.5 w-28">التكلفة</th>}
              </tr>
            </thead>
            <tbody>
              {rel.variants.map((v) => (
                <tr key={v.id} className="border-t border-zinc-800">
                  <td className="py-1.5 pe-2 text-zinc-200">
                    <span className="block max-w-[220px] truncate">
                      {[...v.option_value_ids.map((i) => valueName.get(i) ?? i), v.color_id ? colorName.get(v.color_id) : null]
                        .filter(Boolean)
                        .join(' / ')}
                    </span>
                    {errors[`variant_price:${v.id}`] && (
                      <span className="block text-[11px] text-red-400">{errors[`variant_price:${v.id}`]}</span>
                    )}
                  </td>
                  <td className="py-1.5 pe-2">
                    <Qty
                      value={v.stock}
                      onChange={(n) =>
                        setRel((r) => ({
                          ...r,
                          variants: r.variants.map((x) => (x.id === v.id ? { ...x, stock: n } : x)),
                        }))
                      }
                    />
                  </td>
                  {/*
                    ONE TYPED NUMBER PINS THE PAIR here too. A combination row
                    can carry a 0044 adjustment (a TXT import or a Quick Edit
                    can write one), and writing only the fixed half left a
                    contradiction behind — silently resolved at the server by
                    dropping the admin's stored adjustment. `setVariantPrice`
                    clears the twin in the same patch, exactly as `PriceCells`
                    does for options and colours.
                  */}
                  {(['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'cost_iqd'] as const)
                    .filter((k) => k !== 'cost_iqd' || canSeeCost)
                    .map((k) => (
                      <td key={k} className="py-1.5 pe-2">
                        <Money value={v[k]} onChange={(n) => setVariantPrice(v.id, k, n)} />
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export { GripVertical };
