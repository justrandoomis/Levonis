/**
 * STEP 1 · «المصدر» — how the customer sees the product: the merchant's model
 * (one 3MF / OBJ / GLB / AMF, or up to twelve STL pieces, each up through the
 * shared UploadTile with purpose `product_file` — the builder's source is
 * never a product_files row, P16 — then PUT …/blueprint/model, compiled by
 * the Worker into the draft mesh), or «بالصور فقط»: the product's own
 * photos, each mapped to a colour and/or an option value (§0 row 39). A model
 * the Worker cannot read or cannot show says why in the merchant's words and
 * offers the photos as the way out.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Images } from 'lucide-react';
import { ApiError } from '../../../../../lib/api';
import { UploadTile } from '../../../../upload/UploadTile';
import { Button } from '../../../../ui/Button';
import { Select } from '../../../../ui/Field';
import { PAINT_KEYS, colorWord } from '../../../../../../packages/catalog/src/personalize/vocab';
import type { BlueprintSpec, PaletteKey, SpecPhoto } from '../../../../../../packages/catalog/src/personalize/types';
import { blueprintApi } from '../api';
import { afterNewModel, fill, toPhotoOnly } from '../model';
import type { BuilderStrings } from '../strings';
import type { Kit } from '../kit';

const MODEL = /\.(stl|obj|3mf|amf|glb|gltf)$/i;
const WARN: Record<string, keyof BuilderStrings> = {
  UNIT_GUESSED: 'warn_UNIT_GUESSED', PARTS_MERGED: 'warn_PARTS_MERGED', BBOX_MISMATCH: 'warn_BBOX_MISMATCH', PAINT_IGNORED: 'warn_PAINT_IGNORED',
  MODIFIERS_SKIPPED: 'warn_skipped', NOT_PRINTABLE_SKIPPED: 'warn_skipped',
};

/** A picked file on its way up; `key` once its upload finished. */
interface Up {
  id: number;
  file: File;
  key?: string;
}

/** The axis values a photo can stand for, with the product's own names. */
export function valueChoices(spec: BlueprintSpec, groups: ReadonlyArray<{ id: string; name: string; name_ar: string; values: ReadonlyArray<{ id: string; name: string; name_ar: string }> }>, en: boolean) {
  return [spec.axes.size, spec.axes.look, spec.axes.tier].flatMap((ax) => {
    const g = ax && groups.find((x) => x.id === ax.group);
    return g ? g.values.filter((v) => ax!.values[v.id]).map((v) => ({ id: v.id, name: (en ? v.name : v.name_ar) || v.name })) : [];
  });
}

export function Source({ k }: { k: Kit }) {
  const { t, st, spec, lang } = k;
  const [ups, setUps] = useState<Up[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const cur = st.draft ?? st.live;
  const hasModel = st.mesh_state === 'ready' && st.parts.length > 0;

  // Every picked file is up: the Worker reads them into one model.
  useEffect(() => {
    if (!ups.length || ups.some((u) => !u.key) || busy) return;
    setBusy(true);
    setRefusal(null);
    blueprintApi
      .model(k.product.id, ups.map((u) => u.key!))
      .then((out) => {
        k.adopt(out);
        k.setKind('model');
        k.edit((s) => ({ ...afterNewModel(s, out.parts, out.suggestions.roles), photos: s.photos }));
        k.go('parts');
      })
      .catch((e: unknown) => (e instanceof ApiError && /^BLUEPRINT_(MODEL_UNREADABLE|TOO_HEAVY)$/.test(e.code ?? '') ? setRefusal(e) : k.refuse(e)))
      .finally(() => {
        setUps([]);
        setBusy(false);
      });
  }, [ups]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    setNote('');
    setRefusal(null);
    if (!files.length) return;
    if (files.length > 12) return setNote(t.tooManyFiles);
    if (files.some((f) => !MODEL.test(f.name))) return setNote(t.notModel);
    if (files.length > 1 && files.some((f) => !/\.stl$/i.test(f.name))) return setNote(t.hint_mixed_files);
    setUps(files.map((file, i) => ({ id: Date.now() + i, file })));
  }

  function photosOnly() {
    k.setKind('photos');
    // Every product photo to begin with (at most 12): a photo-only blueprint needs one, and the merchant
    // then drops the ones customers should not see — never a «to fix» before the first choice.
    const all = k.product.media.flatMap((m) => (m.kind === 'image' && m.id ? [{ media_id: m.id }] : [])).slice(0, 12);
    k.edit((s) => toPhotoOnly(s, s.photos.length ? s.photos : all));
  }
  function modelAgain() {
    k.setKind('model');
    if (hasModel) k.edit((s) => ({ ...afterNewModel(s, st.parts, st.suggestions.roles), photos: s.photos }));
  }
  const setPhotos = (fn: (p: SpecPhoto[]) => SpecPhoto[]) => k.edit((s) => toPhotoOnly(s, fn(s.photos)));

  const hint = refusal?.code === 'BLUEPRINT_MODEL_UNREADABLE' ? t[`hint_${String(refusal.details?.hint ?? '')}` as keyof BuilderStrings] : '';
  const warnings = [...new Set((cur?.analysis.warnings ?? []).flatMap((w) => (WARN[w] ? [t[WARN[w]]] : [])))];
  const d = cur?.mesh?.dims_mm ?? cur?.analysis.dims_mm;
  const images = k.product.media.filter((m) => m.kind === 'image' && m.id);
  const values = valueChoices(spec, k.product.option_groups, lang === 'en');

  return (
    <div className="space-y-4" data-step-source>
      <p className="text-[13.5px] font-semibold text-text-primary">{t.srcLead}</p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t.srcLead}>
        {(
          [
            ['model', Box, t.srcModel, t.srcModelHint, modelAgain],
            ['photos', Images, t.srcPhotos, t.srcPhotosHint, photosOnly],
          ] as const
        ).map(([id, Icon, title, text, on]) => (
          <button key={id} type="button" role="radio" aria-checked={k.kind === id} className="lv-choice flex flex-col items-start gap-1 p-3 text-start" onClick={on} data-source={id}>
            <Icon className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <span className="text-[13.5px] font-semibold text-text-primary">{title}</span>
            <span className="text-[12px] leading-relaxed text-text-muted">{text}</span>
          </button>
        ))}
      </div>

      {k.kind === 'model' && (
        <section className="space-y-3">
          {busy ? (
            <p className="text-[13px] text-text-secondary" role="status">{t.reading}</p>
          ) : hasModel ? (
            <div className="space-y-1">
              <p className="text-[13px] text-text-secondary" data-model-parts={st.parts.length}>
                {fill(t.fileParts, { n: st.parts.length, dims: d ? `${d.map((x) => Math.round(x)).join(' × ')} ${t.mm}` : '' })}
              </p>
              {warnings.map((w) => (
                <p key={w} className="text-[12px] leading-relaxed text-warning">{w}</p>
              ))}
            </div>
          ) : null}
          {ups.map((u) => (
            <UploadTile
              key={u.id}
              file={u.file}
              purpose="product_file"
              entityId={k.product.id}
              onDone={(r) => r.key && setUps((all) => all.map((x) => (x.id === u.id ? { ...x, key: r.key } : x)))}
              onCancel={() => setUps((all) => all.filter((x) => x.id !== u.id))}
            />
          ))}
          {!busy && !ups.length && (
            <div className="space-y-1.5">
              <Button variant={hasModel ? 'secondary' : 'primary'} onClick={() => input.current?.click()} data-pick-model>
                {hasModel ? t.replaceFiles : t.pickFiles}
              </Button>
              <p className="text-[12px] leading-relaxed text-text-muted">{t.filesHint}</p>
            </div>
          )}
          <input ref={input} type="file" accept=".stl,.obj,.3mf,.amf,.glb,.gltf" multiple className="sr-only" tabIndex={-1} onChange={(e) => pickFiles(e.target.files)} data-model-input />
          {note && <p className="lv-field-error">{note}</p>}
          {refusal && (
            <div role="alert" className="space-y-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-[12.5px] leading-relaxed text-text-primary" data-model-refusal={refusal.code}>
              <p>
                {refusal.code === 'BLUEPRINT_TOO_HEAVY'
                  ? fill(t.tooHeavy, { triangles: Number(refusal.details?.triangles ?? 0).toLocaleString(), max: Number(refusal.details?.max ?? 0).toLocaleString() })
                  : `${t.unreadable} ${hint ?? ''}`}
              </p>
              <Button size="sm" variant="secondary" onClick={photosOnly} data-way-out>{t.wayOut}</Button>
            </div>
          )}
        </section>
      )}

      {k.kind === 'photos' && (
        <section className="space-y-3" data-photo-map>
          <p className="text-[12.5px] leading-relaxed text-text-muted">{t.photosLead}</p>
          {!images.length ? (
            <p className="rounded-xl border border-border-subtle p-3 text-[13px] text-text-muted">{t.noPhotos}</p>
          ) : (
            <ul className="space-y-2">
              {images.map((m) => {
                const ph = spec.photos.find((p) => p.media_id === m.id);
                const set = (patch: Partial<SpecPhoto>) => setPhotos((all) => all.map((p) => (p.media_id === m.id ? { media_id: p.media_id, ...(p.value_id ? { value_id: p.value_id } : {}), ...(p.colour ? { colour: p.colour } : {}), ...patch } : p)));
                return (
                  <li key={m.id} className="flex items-center gap-3">
                    <button
                      type="button"
                      className="lv-choice h-16 w-16 shrink-0 overflow-hidden p-0"
                      aria-pressed={!!ph}
                      aria-label={m.alt || m.alt_ar || t.wherePhotos}
                      onClick={() => setPhotos((all) => (ph ? all.filter((p) => p.media_id !== m.id) : [...all, { media_id: m.id! }]))}
                      data-photo={m.id}
                    >
                      <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </button>
                    <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                      <Select value={ph?.colour ?? ''} disabled={!ph} aria-label={t.photoColour} onChange={(e) => set({ colour: (e.target.value || undefined) as PaletteKey | undefined })}>
                        <option value="">{t.photoColour}</option>
                        {PAINT_KEYS.map((c) => (
                          <option key={c} value={c}>{colorWord(c, lang)}</option>
                        ))}
                      </Select>
                      <Select value={ph?.value_id ?? ''} disabled={!ph || !values.length} aria-label={t.photoValue} onChange={(e) => set({ value_id: e.target.value || undefined })}>
                        <option value="">{values.length ? t.photoValue : t.anyValue}</option>
                        {values.map((v) => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </Select>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {hasModel && (
            <Button size="sm" variant="ghost" onClick={modelAgain}>{t.useModelInstead}</Button>
          )}
        </section>
      )}
    </div>
  );
}
