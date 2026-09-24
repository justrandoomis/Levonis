/**
 * OPTIONS AND VARIANTS — up to three option groups (Size, Colour, Material…),
 * their values, and the table of combinations, each with its own price
 * override, stock, SKU and on/off switch.
 *
 * THE MODEL IS THE SERVER'S. This editor builds the `variant_model` body the
 * one gate (packages/catalog `normalizeVariantModel`) reads; refs are the
 * rows' own ids for what already exists, so an edit keeps a variant's id —
 * and with it the cart lines, order lines and insights that name it
 * (worker/lib/catalog/product.ts `variantModelStatements`). A new group or
 * value gets a local ref the server replaces.
 *
 * A combination is never lost by switching it off: switched-off rows are sent
 * with `active: false` and keep their stock and price for the day they come
 * back. A combination whose value was deleted is gone with the value.
 */
import { useId, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  allCombinations, comboKey, MAX_GROUPS, MAX_VALUES_PER_GROUP, MAX_VARIANTS, type GroupKind,
} from '../../../../packages/catalog/src/variants';
import { SWATCHES, SWATCH_NAMES, type Swatch } from '../../../../packages/catalog/src/palette';
import { swatchForName } from '../../../../packages/catalog/src/legacy';
import { useLanguage } from '../../../LanguageContext';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Checkbox, Switch } from '../../ui/Switch';
import type { CatalogMedia, CatalogProductDetail, ProductBody } from './catalogApi';
import type { CatalogStrings } from './strings';
import '../../catalog/swatches.css';

export interface DraftValue { ref: string; name: string; name_ar: string; swatch: string }
export interface DraftGroup { ref: string; name: string; name_ar: string; kind: GroupKind; values: DraftValue[] }
export interface DraftVariant {
  price_iqd: number | null;
  compare_at_iqd: number | null;
  stock: number;
  sku: string;
  active: boolean;
  image_key: string | null;
  low_stock_threshold: number | null;
}
export interface VariantDraft { groups: DraftGroup[]; variants: Record<string, DraftVariant> }

export const EMPTY_VARIANT_DRAFT: VariantDraft = { groups: [], variants: {} };

let seq = 0;
export const localRef = (p: string) => `${p}_n${Date.now().toString(36)}${(seq += 1)}`;

const blankVariant = (): DraftVariant => ({
  price_iqd: null, compare_at_iqd: null, stock: 0, sku: '', active: true, image_key: null, low_stock_threshold: null,
});

/** The saved product, as the editor's draft. */
export function draftFromDetail(p: CatalogProductDetail): VariantDraft {
  if (p.variant_mode !== 'variants' || !p.option_groups.length) return EMPTY_VARIANT_DRAFT;
  const groups: DraftGroup[] = p.option_groups.map((g) => ({
    ref: g.id, name: g.name, name_ar: g.name_ar, kind: g.kind,
    values: g.values.map((v) => ({ ref: v.id, name: v.name, name_ar: v.name_ar, swatch: v.swatch })),
  }));
  const variants: Record<string, DraftVariant> = {};
  for (const v of p.variants) {
    variants[comboKey(v.value_ids)] = {
      price_iqd: v.price_iqd, compare_at_iqd: v.compare_at_iqd, stock: v.stock, sku: v.sku, active: v.active,
      image_key: v.image_key, low_stock_threshold: v.low_stock_threshold,
    };
  }
  return { groups, variants };
}

/** The combinations currently described, in table order. */
export function draftCombos(d: VariantDraft): string[][] {
  if (!d.groups.length || d.groups.some((g) => !g.values.length)) return [];
  return allCombinations(d.groups);
}

/** The body the server reads; null = no variants (a simple product). */
export function draftToModel(d: VariantDraft): ProductBody['variant_model'] {
  const combos = draftCombos(d);
  if (!d.groups.length) return null;
  return {
    groups: d.groups.map((g) => ({
      ref: g.ref, name: g.name.trim(), name_ar: g.name_ar.trim(), kind: g.kind,
      values: g.values.map((v) => ({ ref: v.ref, name: v.name.trim(), name_ar: v.name_ar.trim(), swatch: g.kind === 'color' ? v.swatch : '' })),
    })),
    variants: combos.map((values) => ({ values, ...(d.variants[comboKey(values)] ?? blankVariant()) })),
  };
}

export function VariantEditor({
  draft,
  onChange,
  trackStock,
  productPrice,
  pictures,
  s,
  errors,
}: {
  draft: VariantDraft;
  onChange: (next: VariantDraft) => void;
  trackStock: boolean;
  productPrice: number | null;
  /** The product's photos, for a variant's own picture. */
  pictures: CatalogMedia[];
  s: CatalogStrings;
  /** Field errors from the server, by path under `variant_model.`. */
  errors: Record<string, string>;
}) {
  const { lang } = useLanguage();
  const combos = draftCombos(draft);
  const tooMany = combos.length > MAX_VARIANTS;
  const [allPrice, setAllPrice] = useState<number | null>(null);
  const [allStock, setAllStock] = useState<number | null>(null);

  const setGroup = (i: number, patch: Partial<DraftGroup>) =>
    onChange({ ...draft, groups: draft.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  const valueName = (ref: string) => {
    for (const g of draft.groups) {
      const v = g.values.find((x) => x.ref === ref);
      if (v) return lang === 'en' ? v.name || v.name_ar : v.name_ar || v.name;
    }
    return '';
  };
  const setVariant = (key: string, patch: Partial<DraftVariant>) =>
    onChange({ ...draft, variants: { ...draft.variants, [key]: { ...(draft.variants[key] ?? blankVariant()), ...patch } } });

  function applyAll(patch: Partial<DraftVariant>) {
    const next = { ...draft.variants };
    for (const values of combos) {
      const k = comboKey(values);
      next[k] = { ...(next[k] ?? blankVariant()), ...patch };
    }
    onChange({ ...draft, variants: next });
  }

  return (
    <div className="space-y-4" data-variant-editor>
      {draft.groups.map((g, gi) => (
        <GroupEditor
          key={g.ref}
          group={g}
          s={s}
          error={errors[`groups.${gi}`] || errors[`groups.${gi}.values`]}
          onChange={(patch) => setGroup(gi, patch)}
          onRemove={() => onChange({ ...draft, groups: draft.groups.filter((_, j) => j !== gi) })}
        />
      ))}

      {draft.groups.length < MAX_GROUPS ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() => onChange({ ...draft, groups: [...draft.groups, { ref: localRef('g'), name: '', name_ar: '', kind: 'choice', values: [] }] })}
        >
          {s.addOptionGroup}
        </Button>
      ) : (
        <p className="text-[12px] text-text-muted">{s.maxGroups}</p>
      )}

      {combos.length > 0 && (
        <section aria-labelledby="variants-table-title" className="space-y-3 border-t border-border-subtle pt-4">
          <div>
            <h4 id="variants-table-title" className="text-[14px] font-semibold text-text-primary">
              {s.variantsTable} <span className="tabular-nums text-text-muted">({combos.length})</span>
            </h4>
            <p className="mt-0.5 text-[12px] text-text-muted">{s.variantsHint}</p>
          </div>
          {tooMany && <p role="alert" className="lv-field-error">{s.tooManyCombos(combos.length, MAX_VARIANTS)}</p>}
          {(errors.variants || errors['']) && <p role="alert" className="lv-field-error">{errors.variants || errors['']}</p>}

          {combos.length > 1 && !tooMany && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-end gap-1.5">
                <Field label={s.setAllPrice} className="min-w-0 flex-1">
                  <NumberInput kind="money" value={allPrice} onValueChange={(v) => setAllPrice(v)} />
                </Field>
                <Button size="sm" variant="ghost" disabled={allPrice === null} onClick={() => applyAll({ price_iqd: allPrice })}>{s.apply}</Button>
              </div>
              {trackStock && (
                <div className="flex items-end gap-1.5">
                  <Field label={s.setAllStock} className="min-w-0 flex-1">
                    <NumberInput kind="number" decimals={0} min={0} value={allStock} onValueChange={(v) => setAllStock(v)} />
                  </Field>
                  <Button size="sm" variant="ghost" disabled={allStock === null} onClick={() => applyAll({ stock: allStock ?? 0 })}>{s.apply}</Button>
                </div>
              )}
            </div>
          )}

          {!tooMany && (
            <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
              {combos.map((values, i) => {
                const key = comboKey(values);
                const v = draft.variants[key] ?? blankVariant();
                const label = values.map(valueName).join(' / ');
                const rowError = Object.entries(errors).find(([p]) => p === `variants.${i}` || p.startsWith(`variants.${i}.`))?.[1];
                return (
                  <li key={key} className={`space-y-2 p-3 ${v.active ? '' : 'opacity-60'}`} data-variant-row>
                    <Checkbox checked={v.active} onChange={(on) => setVariant(key, { active: on })} label={<span className="font-semibold text-text-primary">{label}</span>} aria-label={s.sellThis(label)} />
                    <div className={`grid gap-2 ${trackStock ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
                      <Field label={s.price}>
                        <NumberInput
                          kind="money"
                          value={v.price_iqd}
                          aria-description={productPrice !== null ? `${s.productPrice}: ${productPrice}` : undefined}
                          onValueChange={(n) => setVariant(key, { price_iqd: n })}
                        />
                      </Field>
                      {trackStock && (
                        <Field label={s.stock}>
                          <NumberInput kind="number" decimals={0} min={0} value={v.stock} onValueChange={(n) => setVariant(key, { stock: n ?? 0 })} />
                        </Field>
                      )}
                      <Field label={s.sku}>
                        <Input ltr value={v.sku} maxLength={64} spellCheck={false} onChange={(e) => setVariant(key, { sku: e.target.value })} />
                      </Field>
                      {pictures.length > 0 && (
                        <Field label={s.variantImage}>
                          <Select value={v.image_key ?? ''} onChange={(e) => setVariant(key, { image_key: e.target.value || null })}>
                            <option value="">—</option>
                            {pictures.map((m, pi) => (
                              <option key={m.key} value={m.key}>{`${pi + 1}`}</option>
                            ))}
                          </Select>
                        </Field>
                      )}
                    </div>
                    {rowError && <p className="lv-field-error">{rowError}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {trackStock && <p className="text-[12px] text-text-muted">{s.stockFromVariants}</p>}
        </section>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  s,
  error,
}: {
  group: DraftGroup;
  onChange: (patch: Partial<DraftGroup>) => void;
  onRemove: () => void;
  s: CatalogStrings;
  error?: string;
}) {
  const { lang } = useLanguage();
  const [text, setText] = useState('');
  const listId = useId();
  // The name the merchant sees is the one edited: an Arabic name the group
  // already has, in an Arabic or Sorani dashboard; otherwise the main name.
  const nameKey: 'name' | 'name_ar' = lang !== 'en' && group.name_ar ? 'name_ar' : 'name';

  function addValues(raw: string) {
    const names = raw.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
    if (!names.length) return;
    const have = new Set(group.values.map((v) => (v.name || v.name_ar).toLowerCase()));
    const fresh = names
      .filter((n) => !have.has(n.toLowerCase()))
      .slice(0, MAX_VALUES_PER_GROUP - group.values.length)
      .map((n) => ({ ref: localRef('v'), name: n, name_ar: '', swatch: group.kind === 'color' ? swatchForName(n) : '' }));
    onChange({ values: [...group.values, ...fresh] });
    setText('');
  }

  const shown = (v: DraftValue) => (lang === 'en' ? v.name || v.name_ar : v.name_ar || v.name);

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle p-3" data-option-group>
      <div className="flex items-end gap-2">
        <Field label={s.optionName} className="min-w-0 flex-1" error={error}>
          <Input
            value={group[nameKey]}
            placeholder={s.optionNamePlaceholder}
            maxLength={60}
            onChange={(e) => onChange({ [nameKey]: e.target.value })}
          />
        </Field>
        <IconButton label={s.removeOption} variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={onRemove} />
      </div>
      <Switch
        checked={group.kind === 'color'}
        onChange={(on) =>
          onChange({
            kind: on ? 'color' : 'choice',
            values: group.values.map((v) => ({ ...v, swatch: on ? v.swatch || swatchForName(v.name, v.name_ar) : '' })),
          })
        }
        label={s.optionIsColour}
      />
      <div>
        <p id={listId} className="mb-1.5 text-[12.5px] font-semibold text-text-secondary">{s.values}</p>
        <ul aria-labelledby={listId} className="flex flex-wrap gap-1.5">
          {group.values.map((v) => (
            <li key={v.ref} className="flex items-center gap-1 rounded-lg border border-border-subtle bg-white/[0.03] ps-2">
              {group.kind === 'color' && <span className="lv-swatch text-[14px]" data-swatch={v.swatch || undefined} aria-hidden="true" />}
              <span className="text-[13px] text-text-primary">{shown(v)}</span>
              {group.kind === 'color' && (
                <label className="sr-only" htmlFor={`${listId}-${v.ref}`}>{`${s.swatch} — ${shown(v)}`}</label>
              )}
              {group.kind === 'color' && (
                <select
                  id={`${listId}-${v.ref}`}
                  value={v.swatch}
                  onChange={(e) => onChange({ values: group.values.map((x) => (x.ref === v.ref ? { ...x, swatch: e.target.value } : x)) })}
                  className="h-8 max-w-[7.5rem] rounded-md border-0 bg-transparent text-[12px] text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
                >
                  <option value="">{s.noSwatch}</option>
                  {SWATCHES.map((k: Swatch) => (
                    <option key={k} value={k}>{lang === 'en' ? SWATCH_NAMES[k].en : SWATCH_NAMES[k].ar}</option>
                  ))}
                </select>
              )}
              <IconButton
                label={s.removeValue(shown(v))}
                icon={<X className="h-3.5 w-3.5" />}
                onClick={() => onChange({ values: group.values.filter((x) => x.ref !== v.ref) })}
              />
            </li>
          ))}
        </ul>
        {group.values.length < MAX_VALUES_PER_GROUP && (
          <Input
            className="mt-2"
            value={text}
            placeholder={s.addValue}
            aria-label={`${s.values} — ${s.addValue}`}
            maxLength={200}
            enterKeyHint="done"
            onChange={(e) => {
              const t = e.target.value;
              if (/[,،\n]/.test(t)) addValues(t);
              else setText(t);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addValues(text);
              }
            }}
            onBlur={() => addValues(text)}
          />
        )}
      </div>
    </div>
  );
}
