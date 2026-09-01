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

import React, { useRef, useState } from 'react';
import { Trash2, GripVertical, ImagePlus, RefreshCw, X } from 'lucide-react';
import { uploadFile } from '../../../lib/api';
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
  deriveInventoryMode,
  emptyPrices,
  localId,
  type FormColor,
  type FormGroup,
  type FormValue,
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
                  <div className="mt-2">
                    <Grid cols={3}>
                      <Field ar="المخزون" en="Stock" hint="فارغ = لا يُحسب من هذا الخيار">
                        <Qty value={v.stock} onChange={(n) => patchValue(g.id, v.id, { stock: n })} />
                      </Field>
                      <Field ar="حد التنبيه" en="Low-stock">
                        <Qty
                          value={v.low_stock_threshold}
                          onChange={(n) => patchValue(g.id, v.id, { low_stock_threshold: n })}
                          placeholder="بدون / none"
                        />
                      </Field>
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

/** Compact per-value / per-colour image slot: thumbnail when set, an upload
 *  button when not. The storefront shows this image the moment the customer
 *  taps the choice it belongs to. */
function ImgSlot({
  url,
  label,
  onChange,
}: {
  url: string;
  label: string;
  onChange: (url: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(false);
    setBusy(true);
    try {
      const res = await uploadFile(file, 'product');
      onChange(res.url);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <span className="relative shrink-0">
      <input
        ref={fileRef}
        type="file"
        dir="ltr"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {url ? (
        <span className="relative block w-10 h-10">
          <img src={url} alt={label} className="w-10 h-10 rounded-lg object-cover border border-zinc-700" />
          <button
            type="button"
            aria-label={`إزالة ${label}`}
            onClick={() => onChange(null)}
            className="absolute -top-1.5 -end-1.5 w-4 h-4 rounded-full bg-zinc-900 border border-zinc-600 text-zinc-300 hover:text-red-400 grid place-items-center"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className={`w-10 h-10 rounded-lg border grid place-items-center transition-colors disabled:opacity-60 ${
            err
              ? 'border-red-500/50 text-red-400'
              : 'border-dashed border-zinc-600 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500'
          }`}
        >
          {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
        </button>
      )}
    </span>
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
