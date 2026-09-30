/**
 * STEP 5 · «الإضافات» — slots filled from THIS store's own parts (products
 * with «يُستخدم داخل منتجات مطبوعة», lane L6; §B.3 «Slots»): picking a part
 * makes a slot of its kind with each of its variants as an option; then how
 * many go in each product, whether one is required, who chooses (the
 * customer, or the merchant once), how it is priced (its own price, or
 * included — the positive difference only), the default, and how it shows
 * on the model (a glow, a ring or a badge at a tapped spot, or a part of the
 * merchant's own file). The server re-checks every option against its parts
 * (PART_BUYABLE, the slot's kind).
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Package, Star, X } from 'lucide-react';
import type { Slot, SlotEffect } from '../../../../../../packages/catalog/src/personalize/types';
import { partKindWord, readPartSpec } from '../../../../../../packages/catalog/src/personalize/parts';
import { Button, IconButton } from '../../../../ui/Button';
import { Select } from '../../../../ui/Field';
import { Money } from '../../../../ui/Money';
import { NumberInput } from '../../../../ui/NumberInput';
import { Segmented } from '../../../../ui/Segmented';
import { Switch } from '../../../../ui/Switch';
import { catalogApi, type CatalogProduct, type CatalogProductDetail } from '../../catalogApi';
import { partListStrings } from '../../parts/strings';
import { fill, freeId, markerEffects, takenIds } from '../model';
import type { Kit } from '../kit';

const FromLevonisSheet = lazy(() => import('../../parts/FromLevonisSheet'));

/** The first free option key of a slot: o1, o2 … */
const keyFor = (slot: Pick<Slot, 'options'>, taken: string[] = []): string => {
  let n = 1;
  while (slot.options.some((o) => o.key === `o${n}`) || taken.includes(`o${n}`)) n++;
  return `o${n}`;
};

/** The merchant's own names for the parts a blueprint already names (read once per part product). */
export function usePartNames(k: Kit): void {
  const asked = useRef(new Set<string>());
  const { spec, names, setNames, lang } = k;
  useEffect(() => {
    const ids = [...new Set(spec.slots.flatMap((s) => s.options.filter((o) => !names[`${o.part.p}|${o.part.v ?? ''}`]).map((o) => o.part.p)))].filter((id) => !asked.current.has(id)).slice(0, 8);
    for (const id of ids) {
      asked.current.add(id);
      catalogApi
        .get(id)
        .then(({ product: d }) => {
          const base = (lang === 'en' ? d.name : d.name_ar || d.name) || d.name;
          setNames(Object.fromEntries([[`${d.id}|`, base], ...d.variants.map((v) => [`${d.id}|${v.id}`, `${base} · ${v.label}`])]));
        })
        .catch(() => undefined);
    }
  }, [spec.slots]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Addons({ k }: { k: Kit }) {
  usePartNames(k);
  const { t, spec, lang, product } = k;
  const [parts, setParts] = useState<CatalogProduct[] | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [levonis, setLevonis] = useState(false);
  const [note, setNote] = useState('');
  const [n, setN] = useState(0);
  const details = useRef<Record<string, CatalogProductDetail>>({});
  useEffect(() => {
    catalogApi
      .list({ kind: 'parts', limit: 100 })
      .then((d) => setParts(d.products.filter((p) => p.id !== product.id)))
      .catch(() => setParts([]));
  }, [product.id, n]);
  const en = lang === 'en';
  const nameOf = (p: { name: string; name_ar: string }) => (en ? p.name : p.name_ar || p.name);
  const setSlot = (id: string, fn: (s: Slot) => Slot) => k.edit((s) => ({ ...s, slots: s.slots.map((x) => (x.id === id ? fn(x) : x)) }));

  async function take(p: CatalogProduct) {
    setNote('');
    try {
      const d = (details.current[p.id] ??= (await catalogApi.get(p.id)).product);
      const kind = readPartSpec(d.part_spec, d.option_groups.flatMap((g) => g.values.map((v) => v.id)))?.kind ?? 'other';
      const live = d.variant_mode === 'variants' ? d.variants.filter((v) => v.active) : [];
      const refs = live.length ? live.map((v) => ({ p: d.id, v: v.id as string | null, label: v.label })) : [{ p: d.id, v: null, label: '' }];
      k.setNames(Object.fromEntries(refs.map((r) => [`${r.p}|${r.v ?? ''}`, r.label ? `${nameOf(d)} · ${r.label}` : nameOf(d)])));
      const into = spec.slots.find((x) => x.id === picking);
      if (into && into.kind !== kind) return setNote(fill(t.otherKind, { kind: partKindWord(kind, lang), slot: partKindWord(into.kind, lang) }));
      if (into) {
        setSlot(into.id, (x) => {
          const keys: string[] = [];
          const more = refs.filter((r) => !x.options.some((o) => o.part.p === r.p && o.part.v === r.v)).map((r) => {
            const key = keyFor(x, keys);
            keys.push(key);
            return { key, part: { p: r.p, v: r.v } };
          });
          return { ...x, options: [...x.options, ...more].slice(0, 12) };
        });
      } else {
        const id = freeId(`s${spec.slots.length + 1}`, takenIds(spec));
        const slot: Slot = { id, kind, qty: 1, required: false, choice: 'customer', pricing: 'add', options: refs.slice(0, 12).map((r, i) => ({ key: `o${i + 1}`, part: { p: r.p, v: r.v } })), default: 'o1' };
        k.edit((s) => ({ ...s, slots: [...s.slots, slot] }));
        k.setSel({ slot: id });
      }
      setPicking(null);
    } catch (e) {
      k.refuse(e);
    }
  }

  function removeSlot(id: string) {
    k.setSel({});
    k.edit((s) => ({
      ...s,
      slots: s.slots.filter((x) => x.id !== id),
      rules: s.rules.filter((r) => !('slot' in r.if && r.if.slot === id) && !('requires' in r.then && r.then.requires.slot === id) && !('excludes' in r.then && r.then.excludes.slot === id)),
      regions: s.regions.map((r) => (r.shown_by?.split(':')[0] === id ? { ...r, shown_by: null } : r)),
    }));
  }

  const picker = (
    <div className="space-y-2" data-part-picker>
      <p className="text-[12.5px] font-semibold text-text-secondary">{t.pickPart}</p>
      {parts === null ? (
        <p className="text-[12.5px] text-text-muted" role="status">…</p>
      ) : (
        <ul className="space-y-2">
          {parts.map((p) => (
            <li key={p.id}>
              <button type="button" className="lv-choice flex w-full items-center gap-3 p-2 text-start" onClick={() => void take(p)} data-take-part={p.id}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-raised">
                  {p.images[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package className="h-5 w-5 text-text-muted" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">{nameOf(p)}</span>
                <span className="shrink-0 text-[12.5px] text-text-secondary"><Money iqd={p.price_iqd} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="lv-field-error">{note}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setLevonis(true)}>{partListStrings(lang).fromLevonis}</Button>
        <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>{t.cancel}</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4" data-step-addons>
      <p className="text-[13.5px] font-semibold text-text-primary">{t.addonsLead}</p>
      {parts !== null && !parts.length && !spec.slots.length && <p className="rounded-xl border border-border-subtle p-3 text-[13px] leading-relaxed text-text-muted">{t.noStoreParts}</p>}

      {spec.slots.map((s) => {
        const on = k.sel.slot === s.id;
        return (
          <section key={s.id} className="space-y-3" data-slot={s.id}>
            <button type="button" className="lv-choice flex w-full items-center gap-3 px-3 py-2 text-start" aria-pressed={on} onClick={() => k.setSel(on ? {} : { slot: s.id })}>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-text-primary">{partKindWord(s.kind, lang)}{s.qty > 1 ? ` ×${s.qty}` : ''}</span>
                <span className="block truncate text-[12px] text-text-muted">{s.options.map((o) => k.names[`${o.part.p}|${o.part.v ?? ''}`] ?? o.key).join(' · ')}</span>
              </span>
            </button>
            {on && (
              <div className="space-y-4 rounded-2xl border border-border-subtle p-3">
                <div className="grid grid-cols-2 items-end gap-3">
                  <label className="space-y-1.5">
                    <span className="block text-[12.5px] font-semibold text-text-secondary">{t.qty}</span>
                    <NumberInput kind="quantity" min={1} max={20} value={s.qty} onValueChange={(v) => v && setSlot(s.id, (x) => ({ ...x, qty: Math.min(20, Math.max(1, v)) }))} />
                  </label>
                  <Switch checked={s.required} onChange={(v) => setSlot(s.id, (x) => ({ ...x, required: v, default: x.default ?? x.options[0]?.key }))} label={t.mustHave} />
                </div>
                <Segmented
                  items={[{ id: 'customer', label: t.choiceCustomer }, { id: 'fixed', label: t.choiceFixed }]}
                  value={s.choice}
                  onChange={(id) => setSlot(s.id, (x) => ({ ...x, choice: id as Slot['choice'], default: x.default ?? x.options[0]?.key }))}
                  label={t.choiceCustomer}
                  group={`choice-${s.id}`}
                  size="sm"
                />
                <div className="space-y-1.5">
                  <Segmented
                    items={[{ id: 'add', label: t.pricingAdd }, { id: 'included', label: t.pricingIncluded }]}
                    value={s.pricing}
                    onChange={(id) => setSlot(s.id, (x) => ({ ...x, pricing: id as Slot['pricing'] }))}
                    label={t.pricingAdd}
                    group={`pricing-${s.id}`}
                    size="sm"
                  />
                  {s.pricing === 'included' && <p className="text-[12px] leading-relaxed text-text-muted">{t.includedHint}</p>}
                </div>
                <ul className="divide-y divide-border-subtle" aria-label={partKindWord(s.kind, lang)}>
                  {s.options.map((o) => (
                    <li key={o.key} className="flex items-center gap-2 py-1.5">
                      <IconButton
                        label={t.isDefault}
                        variant="ghost"
                        aria-pressed={s.default === o.key}
                        className={s.default === o.key ? 'text-gold' : 'text-text-muted'}
                        icon={<Star className="h-4 w-4" fill={s.default === o.key ? 'currentColor' : 'none'} />}
                        onClick={() => setSlot(s.id, (x) => ({ ...x, default: o.key }))}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{k.names[`${o.part.p}|${o.part.v ?? ''}`] ?? o.key}</span>
                      <IconButton
                        label={t.remove}
                        variant="ghost"
                        disabled={s.options.length < 2}
                        icon={<X className="h-4 w-4" />}
                        onClick={() => setSlot(s.id, (x) => { const options = x.options.filter((y) => y.key !== o.key); return { ...x, options, default: x.default === o.key ? options[0]?.key : x.default }; })}
                      />
                    </li>
                  ))}
                </ul>
                {picking === s.id ? picker : s.options.length < 12 && <Button size="sm" variant="secondary" onClick={() => setPicking(s.id)}>{t.addOption}</Button>}
                {k.kind === 'model' && (
                  <div className="space-y-2">
                    <p className="text-[12.5px] font-semibold text-text-secondary">{t.showOn}</p>
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t.showOn}>
                      {markerEffects(false).map((effect: SlotEffect | '') => (
                        <button
                          key={effect || 'none'}
                          type="button"
                          role="radio"
                          aria-checked={(s.show?.effect ?? '') === effect}
                          className="lv-choice px-3 text-[12.5px]"
                          onClick={() => {
                            setSlot(s.id, (x) => {
                              const { show: _drop, ...rest } = x;
                              if (!effect) return rest;
                              return effect === 'visible' ? { ...rest, show: { effect, part: x.show?.part ?? 0 } } : { ...rest, show: { effect, ...(x.show?.anchor ? { anchor: x.show.anchor } : {}) } };
                            });
                            if (effect && effect !== 'visible') k.setPick({ anchor: s.id });
                          }}
                          data-effect={effect || 'none'}
                        >
                          {t[`effect_${effect}`]}
                        </button>
                      ))}
                    </div>
                    {s.show && s.show.effect !== 'visible' && (
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-text-muted" role="status">{s.show.anchor ? t.anchorSet : t.tapAnchor}</p>
                        {s.show.anchor && <Button size="sm" variant="ghost" onClick={() => k.setPick({ anchor: s.id })}>{t.move}</Button>}
                      </div>
                    )}
                    {s.show?.effect === 'visible' && (
                      <Select value={String(s.show.part ?? 0)} aria-label={t.whichPart} onChange={(e) => setSlot(s.id, (x) => ({ ...x, show: { effect: 'visible', part: Number(e.target.value) } }))}>
                        {k.st.parts.map((p) => (
                          <option key={p.n} value={p.n}>{p.name}</option>
                        ))}
                      </Select>
                    )}
                  </div>
                )}
                <Button size="sm" variant="ghost" onClick={() => removeSlot(s.id)}>{t.removeAddon}</Button>
              </div>
            )}
          </section>
        );
      })}

      {picking === 'new' ? picker : spec.slots.length < 8 && !!parts?.length && <Button variant="secondary" onClick={() => setPicking('new')} data-add-addon>{t.addAddon}</Button>}
      {parts !== null && !parts.length && picking !== 'new' && (
        <Button size="sm" variant="ghost" onClick={() => setLevonis(true)}>{partListStrings(lang).fromLevonis}</Button>
      )}
      {levonis && (
        <Suspense fallback={null}>
          <FromLevonisSheet open={levonis} onClose={() => setLevonis(false)} onOpen={() => { setLevonis(false); setN((x) => x + 1); }} onImported={() => setN((x) => x + 1)} />
        </Suspense>
      )}
    </div>
  );
}
