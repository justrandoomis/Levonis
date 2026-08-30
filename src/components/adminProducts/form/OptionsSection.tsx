/**
 * Section 5 — options, colours and their links (mandate §7).
 *
 * The link UI is the heart of it: a colour lists SMALL CHECKBOXES for every
 * option value in the product, grouped by option group, and the helper line
 * states the rule the server enforces — OR inside a group, AND across groups.
 * A colour with no boxes ticked shows with every option, which is the
 * behaviour §7 asks for and is stated on screen rather than left to be
 * discovered.
 *
 * Stock and prices appear at the level the product's inventory mode makes
 * authoritative, so an admin is not asked to fill a number that will never be
 * read. Cost is only rendered for a financial admin — and the server refuses
 * to write it either way (§11).
 */

import React from 'react';
import { Trash2, GripVertical } from 'lucide-react';
import {
  Field,
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
  emptyPrices,
  localId,
  type FormColor,
  type FormGroup,
  type FormValue,
  type InventoryMode,
  type RelationsState,
} from './model';

export function OptionsSection({
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
  const mode = rel.inventory_mode;
  const optionStock = mode === 'OPTION';
  const colorStock = mode === 'COLOR';

  const addGroup = () =>
    setRel((r) => ({
      ...r,
      groups: [...r.groups, { id: localId('og'), name_en: '', sort: r.groups.length, active: true, values: [] }],
    }));

  const patchGroup = (id: string, patch: Partial<FormGroup>) =>
    setRel((r) => ({ ...r, groups: r.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));

  const removeGroup = (id: string) =>
    setRel((r) => {
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
    setRel((r) => ({
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
                },
              ],
            }
          : g
      ),
    }));

  const patchValue = (groupId: string, id: string, patch: Partial<FormValue>) =>
    setRel((r) => ({
      ...r,
      groups: r.groups.map((g) =>
        g.id === groupId ? { ...g, values: g.values.map((v) => (v.id === id ? { ...v, ...patch } : v)) } : g
      ),
    }));

  const removeValue = (groupId: string, id: string) =>
    setRel((r) => ({
      ...r,
      groups: r.groups.map((g) => (g.id === groupId ? { ...g, values: g.values.filter((v) => v.id !== id) } : g)),
      colors: r.colors.map((c) => ({ ...c, option_value_ids: c.option_value_ids.filter((x) => x !== id) })),
      variants: r.variants.filter((v) => !v.option_value_ids.includes(id)),
    }));

  const addColor = () =>
    setRel((r) => ({
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
    setRel((r) => ({ ...r, colors: r.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const removeColor = (id: string) =>
    setRel((r) => ({
      ...r,
      colors: r.colors.filter((c) => c.id !== id),
      variants: r.variants.filter((v) => v.color_id !== id),
      images: r.images.map((i) => (i.color_id === id ? { ...i, color_id: null } : i)),
    }));

  const toggleLink = (colorId: string, valueId: string) =>
    setRel((r) => ({
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
      <InventoryModePicker
        mode={mode}
        onChange={(m) => setRel((r) => ({ ...r, inventory_mode: m }))}
        hasGroups={rel.groups.length > 0}
        hasColors={rel.colors.length > 0}
        error={errors.inventory_mode}
      />

      {/* ---------------------------------------------------- option groups */}
      <Repeater
        title="مجموعات الخيارات / Option groups"
        addLabel="مجموعة"
        onAdd={addGroup}
        empty="لا توجد مجموعات. أضف مجموعة مثل «المقاس» أو «الباقة»."
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
                    <TextInput
                      value={v.name_en}
                      onChange={(e) => patchValue(g.id, v.id, { name_en: e.target.value })}
                      placeholder="Value (English)"
                      aria-label="Option value"
                    />
                    <TextInput
                      value={v.sku_part}
                      onChange={(e) => patchValue(g.id, v.id, { sku_part: e.target.value })}
                      placeholder="SKU part"
                      className="max-w-[110px]"
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
                  <div className="mt-2">
                    <Grid cols={3}>
                      {optionStock && (
                        <>
                          <Field ar="المخزون" en="Stock">
                            <Qty value={v.stock} onChange={(n) => patchValue(g.id, v.id, { stock: n })} />
                          </Field>
                          <Field ar="حد التنبيه" en="Low-stock">
                            <Qty
                              value={v.low_stock_threshold}
                              onChange={(n) => patchValue(g.id, v.id, { low_stock_threshold: n })}
                              placeholder="بدون / none"
                            />
                          </Field>
                        </>
                      )}
                      <PriceCells
                        prices={v}
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
                </div>
              ))}
              <button type="button" onClick={() => addValue(g.id)} className={`${btnGhost} h-9 px-2.5 text-[12px]`}>
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
              <span
                className="w-9 h-9 rounded-lg border border-zinc-700 shrink-0"
                style={{ background: /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c.hex) ? c.hex : '#000' }}
                aria-hidden="true"
              />
              <TextInput
                value={c.name_en}
                onChange={(e) => patchColor(c.id, { name_en: e.target.value })}
                placeholder="Colour name (English)"
                aria-label="Colour name"
              />
              <input
                type="text"
                dir="ltr"
                value={c.hex}
                onChange={(e) => patchColor(c.id, { hex: e.target.value })}
                placeholder="#000000"
                aria-label="HEX"
                className={`${fieldCls} max-w-[110px]`}
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
                {colorStock && (
                  <>
                    <Field ar="المخزون" en="Stock">
                      <Qty value={c.stock} onChange={(n) => patchColor(c.id, { stock: n })} />
                    </Field>
                    <Field ar="حد التنبيه" en="Low-stock">
                      <Qty
                        value={c.low_stock_threshold}
                        onChange={(n) => patchColor(c.id, { low_stock_threshold: n })}
                        placeholder="بدون / none"
                      />
                    </Field>
                  </>
                )}
                <PriceCells prices={c} canSeeCost={canSeeCost} onChange={(patch) => patchColor(c.id, patch)} />
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

      {mode === 'VARIANT_COMBINATION' && (
        <VariantsEditor rel={rel} setRel={setRel} canSeeCost={canSeeCost} errors={errors} />
      )}
    </div>
  );
}

/** The four prices, at any level. Cost is admin-financial only (§5, §11). */
function PriceCells({
  prices,
  canSeeCost,
  onChange,
}: {
  prices: { regular_price_iqd: number | null; prime_price_iqd: number | null; pro_price_iqd: number | null; cost_iqd: number | null };
  canSeeCost: boolean;
  onChange: (patch: Partial<{ regular_price_iqd: number | null; prime_price_iqd: number | null; pro_price_iqd: number | null; cost_iqd: number | null }>) => void;
}) {
  return (
    <>
      <Field ar="السعر" en="Regular" hint="فارغ = سعر المنتج">
        <Money value={prices.regular_price_iqd} onChange={(v) => onChange({ regular_price_iqd: v })} />
      </Field>
      <Field ar="PRIME" en="PRIME">
        <Money value={prices.prime_price_iqd} onChange={(v) => onChange({ prime_price_iqd: v })} />
      </Field>
      <Field ar="PRO" en="PRO">
        <Money value={prices.pro_price_iqd} onChange={(v) => onChange({ pro_price_iqd: v })} />
      </Field>
      {canSeeCost && (
        <Field ar="التكلفة" en="Cost" tip="إداري فقط — لا تظهر للعميل ولا لمساعد الأدمن.">
          <Money value={prices.cost_iqd} onChange={(v) => onChange({ cost_iqd: v })} />
        </Field>
      )}
    </>
  );
}

const MODES: Array<{ id: InventoryMode; ar: string; en: string; why: string }> = [
  { id: 'BASE', ar: 'المنتج', en: 'BASE', why: 'رقم واحد للمنتج كله' },
  { id: 'OPTION', ar: 'الخيارات', en: 'OPTION', why: 'لكل قيمة خيار مخزونها' },
  { id: 'COLOR', ar: 'الألوان', en: 'COLOR', why: 'لكل لون مخزونه' },
  { id: 'VARIANT_COMBINATION', ar: 'التركيبات', en: 'VARIANT', why: 'لكل تركيبة خيار+لون' },
];

function InventoryModePicker({
  mode,
  onChange,
  hasGroups,
  hasColors,
  error,
}: {
  mode: InventoryMode;
  onChange: (m: InventoryMode) => void;
  hasGroups: boolean;
  hasColors: boolean;
  error?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-bold text-zinc-300 mb-1.5">
        مصدر المخزون <span className="text-[11px] font-medium text-zinc-500">Inventory source</span>
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(2,minmax(0,1fr))] md:[grid-template-columns:repeat(4,minmax(0,1fr))]">
        {MODES.map((m) => {
          const impossible = (m.id === 'OPTION' && !hasGroups) || (m.id === 'COLOR' && !hasColors);
          return (
            <button
              key={m.id}
              type="button"
              disabled={impossible}
              onClick={() => onChange(m.id)}
              className={`min-w-0 text-start rounded-lg border p-2.5 transition-colors disabled:opacity-40 ${
                mode === m.id ? 'bg-[#6B46FF]/10 border-[#6B46FF]/60' : 'bg-zinc-800/30 border-zinc-700'
              }`}
            >
              <span className="block text-[13px] font-bold text-white truncate">{m.ar}</span>
              <span className="block text-[11px] text-zinc-500 truncate">{m.why}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-500">
        مصدر واحد فقط هو الحقيقة — لا تُجمع الأرقام بين المستويات.
        <span className="text-zinc-600"> One authoritative source; levels are never summed.</span>
      </p>
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
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

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-[13px] font-bold text-zinc-300 truncate">التركيبات / Combinations</h4>
        <button type="button" onClick={generate} className={`${btnGhost} h-9 px-2.5 text-[12px]`}>
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
                  {(['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd'] as const).map((k) => (
                    <td key={k} className="py-1.5 pe-2">
                      <Money
                        value={v[k]}
                        onChange={(n) =>
                          setRel((r) => ({
                            ...r,
                            variants: r.variants.map((x) => (x.id === v.id ? { ...x, [k]: n } : x)),
                          }))
                        }
                      />
                    </td>
                  ))}
                  {canSeeCost && (
                    <td className="py-1.5 pe-2">
                      <Money
                        value={v.cost_iqd}
                        onChange={(n) =>
                          setRel((r) => ({
                            ...r,
                            variants: r.variants.map((x) => (x.id === v.id ? { ...x, cost_iqd: n } : x)),
                          }))
                        }
                      />
                    </td>
                  )}
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
