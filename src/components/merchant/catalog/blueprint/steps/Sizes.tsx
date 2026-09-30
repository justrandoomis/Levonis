/**
 * STEP 4 · «المقاسات والمظهر» — size, look and quality are the product's OWN
 * option groups (0126: price, stock, SKU and pictures stay there; §0 row 5);
 * the blueprint only annotates them: a size's dimensions and its star, a
 * look's finish and catalogue material, a quality's tier and a note only the
 * merchant reads. «أضف مقاسات» writes Small / Medium / Large into the
 * product's own variant model through its own write gate (PATCH
 * variant_model) and annotates the new group at once. Nothing here is shown
 * for an axis the product does not have.
 */
import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import type { BlueprintSpec, LookKey, Tier, Vec3 } from '../../../../../../packages/catalog/src/personalize/types';
import { LOOKS, LOOK_WORDS, TIERS, TIER_WORDS, word } from '../../../../../../packages/catalog/src/personalize/vocab';
import { Button, IconButton } from '../../../../ui/Button';
import { Input, Select } from '../../../../ui/Field';
import { NumberInput } from '../../../../ui/NumberInput';
import { Segmented } from '../../../../ui/Segmented';
import { useToast } from '../../../../ui/Toast';
import { catalogApi, type CatalogGroup } from '../../catalogApi';
import { SIZE_WORDS, fitsBed, pruneValues, sizeAxis, sizeRows, withSizeGroup } from '../model';
import type { Kit } from '../kit';

type AxisKey = 'size' | 'look' | 'tier';

export function Sizes({ k }: { k: Kit }) {
  const { t, spec, lang, product } = k;
  const toast = useToast();
  const [materials, setMaterials] = useState<Array<{ id: string; name_en: string; name_ar: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    catalogApi.materials().then(setMaterials).catch(() => setMaterials([]));
  }, []);
  const en = lang === 'en';
  const name = (v: { name: string; name_ar: string }) => (en ? v.name : v.name_ar) || v.name;
  const axisOf = (g: string): AxisKey | '' => (['size', 'look', 'tier'] as const).find((a) => spec.axes[a]?.group === g) ?? '';
  const bed = k.st.preview?.printer?.max_mm ?? null;
  const canAdd = !spec.axes.size && product.option_groups.length < 3 && !!withSizeGroup(product, SIZE_WORDS);

  function setAxis(g: CatalogGroup, axis: AxisKey | '') {
    k.edit((s) => {
      const axes: BlueprintSpec['axes'] = { ...s.axes };
      for (const a of ['size', 'look', 'tier'] as const) if (axes[a]?.group === g.id || a === axis) delete axes[a];
      if (axis === 'size') axes.size = sizeAxis(g, k.dims);
      if (axis === 'look') axes.look = { group: g.id, values: Object.fromEntries(g.values.map((v) => [v.id, { look: 'classic' as LookKey, material_id: materials?.[0]?.id ?? 'pla' }])) };
      if (axis === 'tier') axes.tier = { group: g.id, values: Object.fromEntries(g.values.map((v, i) => [v.id, { tier: (i ? 'best' : 'value') as Tier }])) };
      return pruneValues({ ...s, axes });
    });
  }

  async function addSizes() {
    const model = withSizeGroup(product, SIZE_WORDS);
    if (!model || busy) return;
    setBusy(true);
    try {
      await catalogApi.update(product.id, { variant_model: model });
      const d = await k.reloadProduct();
      const g = d?.option_groups.find((x) => !product.option_groups.some((y) => y.id === x.id));
      if (g) k.edit((s) => ({ ...s, axes: { ...s.axes, size: sizeAxis(g, k.dims) } }));
      toast.success(t.sizesAdded);
    } catch (e) {
      k.refuse(e);
    } finally {
      setBusy(false);
    }
  }

  const size = spec.axes.size;
  const setSize = (id: string, dims: Vec3, scale: number) =>
    k.edit((s) => (s.axes.size ? { ...s, axes: { ...s.axes, size: { ...s.axes.size, values: { ...s.axes.size.values, [id]: { ...s.axes.size.values[id], dims_mm: dims, scale } } } } } : s));
  const longest = k.dims ? Math.max(...k.dims) : null;

  return (
    <div className="space-y-4" data-step-sizes>
      <p className="text-[13.5px] font-semibold text-text-primary">{t.sizesLead}</p>
      {!product.option_groups.length && <p className="text-[13px] text-text-muted">{t.noGroups}</p>}

      {product.option_groups.map((g) => {
        const axis = axisOf(g.id);
        const rows = axis === 'size' ? sizeRows(spec, product) : null;
        return (
          <section key={g.id} className="space-y-3 rounded-2xl border border-border-subtle p-3" data-group={g.id} data-axis={axis || 'none'}>
            <p className="text-[14px] font-semibold text-text-primary">{name(g)}</p>
            <div className="-mx-1 overflow-x-auto px-1 hide-scrollbar">
              <Segmented
                items={[
                  { id: '', label: t.axisNone },
                  { id: 'size', label: t.axisSize, disabled: !!spec.axes.size && axis !== 'size' },
                  { id: 'look', label: t.axisLook, disabled: !!spec.axes.look && axis !== 'look' },
                  { id: 'tier', label: t.axisTier, disabled: !!spec.axes.tier && axis !== 'tier' },
                ]}
                value={axis}
                onChange={(id) => setAxis(g, id as AxisKey | '')}
                label={t.groupIs}
                group={`axis-${g.id}`}
                size="sm"
                className="min-w-max sm:min-w-0"
              />
            </div>

            {rows && size && (
              <ul className="divide-y divide-border-subtle" data-size-rows>
                {rows.map((v) => {
                  const x = size.values[v.id];
                  if (!x) return null;
                  const fits = fitsBed(x.dims_mm, bed);
                  return (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 py-2" data-size={v.id}>
                      <IconButton
                        label={t.recommended}
                        icon={<Star className="h-4 w-4" fill={x.recommended ? 'currentColor' : 'none'} />}
                        variant="ghost"
                        aria-pressed={!!x.recommended}
                        className={x.recommended ? 'text-gold' : 'text-text-muted'}
                        onClick={() =>
                          k.edit((s) => ({
                            ...s,
                            axes: { ...s.axes, size: { ...s.axes.size!, values: Object.fromEntries(Object.entries(s.axes.size!.values).map(([id, y]) => { const { recommended: _r, ...rest } = y; return [id, id === v.id ? { ...rest, recommended: true as const } : rest]; })) } },
                          }))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium text-text-primary">{name(v)}</span>
                        <span className={`block text-[12px] ${fits ? 'text-text-muted' : 'text-warning'}`} data-fits={fits ? 'yes' : 'no'}>{fits ? t.fits : t.tooBig}</span>
                      </span>
                      {longest && k.dims ? (
                        <div className="w-32">
                          <NumberInput
                            kind="number"
                            decimals={0}
                            min={1}
                            max={5000}
                            unit={t.mm}
                            aria-label={t.longest}
                            value={Math.round(Math.max(...x.dims_mm))}
                            onValueChange={(n) => {
                              if (!n || n <= 0) return;
                              const scale = Math.round((n / longest) * 1000) / 1000;
                              setSize(v.id, k.dims!.map((d) => Math.max(1, Math.round(d * scale))) as Vec3, Math.min(20, Math.max(0.05, scale)));
                            }}
                          />
                        </div>
                      ) : (
                        // No model to scale from: width × depth × height, the unit said once (three units would not fit a phone).
                        <div className="flex w-full items-center gap-2" data-size-dims>
                          {([t.width, t.depth, t.height] as const).map((axis, i) => (
                            <NumberInput
                              key={i}
                              kind="number"
                              decimals={0}
                              min={1}
                              max={5000}
                              aria-label={`${name(v)} · ${axis} (${t.mm})`}
                              value={x.dims_mm[i]}
                              onValueChange={(n) => n && n > 0 && setSize(v.id, x.dims_mm.map((d, j) => (j === i ? n : d)) as Vec3, x.scale)}
                            />
                          ))}
                          <span className="shrink-0 text-[12px] text-text-muted">{t.mm}</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {axis === 'look' && spec.axes.look && (
              <ul className="space-y-2" data-look-rows>
                {g.values.map((v) => {
                  const x = spec.axes.look!.values[v.id];
                  if (!x) return null;
                  const setLook = (patch: Partial<typeof x>) => k.edit((s) => ({ ...s, axes: { ...s.axes, look: { ...s.axes.look!, values: { ...s.axes.look!.values, [v.id]: { ...s.axes.look!.values[v.id], ...patch } } } } }));
                  return (
                    <li key={v.id} className="grid grid-cols-2 items-center gap-2">
                      <span className="col-span-2 text-[13.5px] font-medium text-text-primary">{name(v)}</span>
                      <Select value={x.look} aria-label={t.axisLook} onChange={(e) => setLook({ look: e.target.value as LookKey })}>
                        {LOOKS.map((l) => (
                          <option key={l} value={l}>{word(LOOK_WORDS, LOOKS, l, lang)}</option>
                        ))}
                      </Select>
                      <Select value={x.material_id} aria-label={t.material} onChange={(e) => setLook({ material_id: e.target.value })}>
                        {!materials?.some((mt) => mt.id === x.material_id) && <option value={x.material_id}>{x.material_id.toUpperCase()}</option>}
                        {(materials ?? []).map((mt) => (
                          <option key={mt.id} value={mt.id}>{en ? mt.name_en : mt.name_ar || mt.name_en}</option>
                        ))}
                      </Select>
                    </li>
                  );
                })}
              </ul>
            )}

            {axis === 'tier' && spec.axes.tier && (
              <div className="space-y-3" data-tier-rows>
                {g.values.map((v) => {
                  const x = spec.axes.tier!.values[v.id];
                  return x ? (
                    <div key={v.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">{name(v)}</span>
                      <Segmented
                        items={TIERS.map((id) => ({ id, label: word(TIER_WORDS, TIERS, id, lang) }))}
                        value={x.tier}
                        onChange={(id) => k.edit((s) => ({ ...s, axes: { ...s.axes, tier: { ...s.axes.tier!, values: { ...s.axes.tier!.values, [v.id]: { tier: id as Tier } } } } }))}
                        label={t.axisTier}
                        group={`tier-${v.id}`}
                        size="sm"
                      />
                    </div>
                  ) : null;
                })}
                {TIERS.map((tier) => (
                  <Input
                    key={tier}
                    aria-label={`${t.privateNote} · ${word(TIER_WORDS, TIERS, tier, lang)}`}
                    placeholder={`${t.privateNote} · ${word(TIER_WORDS, TIERS, tier, lang)}`}
                    maxLength={120}
                    value={spec.private.quality_notes?.[tier] ?? ''}
                    onChange={(e) =>
                      k.edit((s) => {
                        const notes = { ...s.private.quality_notes, [tier]: e.target.value };
                        if (!e.target.value.trim()) delete notes[tier];
                        return { ...s, private: { ...s.private, quality_notes: notes } };
                      })
                    }
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {canAdd && (
        <div className="space-y-1.5" data-add-sizes>
          <Button variant="secondary" onClick={addSizes} loading={busy} disabled={k.dirty}>{t.addSizes}</Button>
          <p className="text-[12px] leading-relaxed text-text-muted">{k.dirty ? t.saveProductFirst : t.addSizesHint}</p>
        </div>
      )}
    </div>
  );
}
