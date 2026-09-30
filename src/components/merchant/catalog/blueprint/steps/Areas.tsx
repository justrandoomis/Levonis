/**
 * STEP 3 · «الكتابة والشعار» — at most four areas (one decal atlas, the
 * WebGL1 varying budget): a name, a text, a logo, a photo, a QR code or an
 * icon. On a model the merchant picks the kind and taps a face — the tap
 * gives the point and the triangle's normal, and the frame (o / n / u, w × h
 * mm) is sized from the tapped part (../model.ts `frameAt`); «انقلها» takes
 * the next tap. On a photo-only product the area lands on the first photo
 * and its four corners are dragged there. A text's most letters is suggested
 * from its width at the smallest letter height.
 */
import type { Area, ContentKind, LogoMode, PhotoMode, QrKind } from '../../../../../../packages/catalog/src/personalize/types';
import {
  CONTENT_KINDS, KIND_WORDS, LOGO_MODES, LOGO_WORDS, PHOTO_MODES, PHOTO_WORDS, QR_KINDS, REGION_ROLES, ROLE_WORDS, TARGET_KEYS, TARGET_WORDS, word,
} from '../../../../../../packages/catalog/src/personalize/vocab';
import { Button } from '../../../../ui/Button';
import { Field, Input, Select } from '../../../../ui/Field';
import { NumberInput } from '../../../../ui/NumberInput';
import { Segmented } from '../../../../ui/Segmented';
import { Switch } from '../../../../ui/Switch';
import { fill, newArea, photoQuad, suggestMax } from '../model';
import { PaintEditor } from './Parts';
import type { Kit } from '../kit';

/** A few words, several chosen — never none (the engine needs at least one). */
export function Chips<K extends string>({ keys, label, words, values, onChange }: { keys: readonly K[]; label: string; words: (k: K) => string; values: readonly K[]; onChange: (v: K[]) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12.5px] font-semibold text-text-secondary">{label}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {keys.map((x) => (
          <button
            key={x}
            type="button"
            className="lv-choice px-3 text-[12.5px]"
            aria-pressed={values.includes(x)}
            onClick={() => {
              const next = values.includes(x) ? values.filter((y) => y !== x) : keys.filter((y) => y === x || values.includes(y));
              if (next.length) onChange(next);
            }}
          >
            {words(x)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Areas({ k }: { k: Kit }) {
  const { t, spec, lang } = k;
  const photo = k.kind === 'photos';
  const full = spec.areas.length >= 4;
  const kindWord = (x: ContentKind) => word(KIND_WORDS, CONTENT_KINDS, x, lang);
  const roleWord = (r: string) => word(ROLE_WORDS, REGION_ROLES, r, lang);
  const adds: Array<[ContentKind, 'name' | 'text', string]> = [
    ['text', 'name', t.addName],
    ['text', 'text', kindWord('text')],
    ['logo', 'text', kindWord('logo')],
    ['photo', 'text', kindWord('photo')],
    ['qr', 'text', kindWord('qr')],
    ['icon', 'text', kindWord('icon')],
  ];
  const place = k.pick && 'place' in k.pick ? k.pick : null;
  const placing = place ? adds.find(([x, r]) => x === place.place && (x !== 'text' || r === place.role)) : undefined;
  const set = (id: string, fn: (a: Area) => Area) => k.edit((s) => ({ ...s, areas: s.areas.map((a) => (a.id === id ? fn(a) : a)) }));

  function add(kind: ContentKind, role: 'name' | 'text') {
    if (!photo) return k.setPick({ place: kind, role });
    const media = spec.photos[0]?.media_id;
    const region = spec.regions[0]?.id;
    if (!media || !region) return;
    const a = newArea(spec, kind, role, region, { photo_frame: { media_id: media, quad: photoQuad(kind) } });
    k.edit((s) => ({ ...s, areas: [...s.areas, a] }));
    k.setSel({ area: a.id });
  }

  return (
    <div className="space-y-4" data-step-areas>
      <p className="text-[13.5px] font-semibold text-text-primary">{photo ? t.areasLeadPhoto : t.areasLead}</p>
      <div className="flex flex-wrap gap-2">
        {adds.map(([x, r, label]) => (
          <button key={`${x}-${r}`} type="button" className="lv-choice px-3 text-[13px]" disabled={full} aria-pressed={placing?.[0] === x && placing[1] === r} onClick={() => add(x, r)} data-add-area={x === 'text' ? r : x}>
            + {label}
          </button>
        ))}
      </div>
      {full && <p className="text-[12px] text-text-muted">{t.areasFull}</p>}
      {k.pick && ('place' in k.pick || 'move' in k.pick) && (
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised p-3" role="status" data-placing>
          <p className="min-w-0 flex-1 text-[13px] text-text-primary">{fill(t.placing, { kind: placing?.[2] ?? kindWord(spec.areas.find((a) => 'move' in k.pick! && a.id === k.pick.move)?.kind ?? 'text') })}</p>
          <Button size="sm" variant="ghost" onClick={() => k.setPick(null)}>{t.cancel}</Button>
        </div>
      )}

      <ul className="space-y-2">
        {spec.areas.map((a, i) => {
          const on = k.sel.area === a.id;
          const region = spec.regions.find((r) => r.id === a.region);
          return (
            <li key={a.id} className="space-y-3">
              <button type="button" className="lv-choice flex w-full items-center gap-3 px-3 py-2 text-start" aria-pressed={on} onClick={() => k.setSel(on ? {} : { area: a.id })} data-area={a.id}>
                <span className="tabular-nums text-[12px] text-text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-text-primary">{a.role === 'name' ? t.addName : kindWord(a.kind)}</span>
                  <span className="block truncate text-[12px] text-text-muted">
                    {region ? fill(t.onRegion, { region: roleWord(region.role) }) : ''}
                    {a.frame ? ` · ${a.frame.w} × ${a.frame.h} ${t.mm}` : ''}
                  </span>
                </span>
              </button>
              {on && <AreaEditor k={k} a={a} set={(fn) => set(a.id, fn)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AreaEditor({ k, a, set }: { k: Kit; a: Area; set: (fn: (a: Area) => Area) => void }) {
  const { t, spec, lang } = k;
  const text = a.text;
  const suggested = a.frame && text ? suggestMax(a.frame.w, text.min_cap_mm) : null;
  return (
    <div className="space-y-4 rounded-2xl border border-border-subtle p-3" data-area-editor={a.id}>
      {a.frame && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.width}>
            <NumberInput kind="number" decimals={1} min={1} max={1000} unit={t.mm} value={a.frame.w} onValueChange={(v) => v && v > 0 && set((x) => ({ ...x, frame: { ...x.frame!, w: v } }))} />
          </Field>
          <Field label={t.height}>
            <NumberInput kind="number" decimals={1} min={1} max={1000} unit={t.mm} value={a.frame.h} onValueChange={(v) => v && v > 0 && set((x) => ({ ...x, frame: { ...x.frame!, h: v } }))} />
          </Field>
        </div>
      )}
      {spec.regions.length > 1 && (
        <Field label={t.drawnOn}>
          <Select value={a.region} onChange={(e) => set((x) => ({ ...x, region: e.target.value }))}>
            {spec.regions.map((r) => (
              <option key={r.id} value={r.id}>{word(ROLE_WORDS, REGION_ROLES, r.role, lang)}</option>
            ))}
          </Select>
        </Field>
      )}
      {text && (
        <>
          <Segmented
            items={[{ id: 'name', label: t.addName }, { id: 'text', label: word(KIND_WORDS, CONTENT_KINDS, 'text', lang) }]}
            value={a.role}
            onChange={(id) => set((x) => ({ ...x, role: id as 'name' | 'text', text: { ...x.text!, count: id === 'name' ? x.text!.count : 1 } }))}
            label={t.nameOrText}
            group={`area-role-${a.id}`}
            size="sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.lines}>
              <NumberInput kind="quantity" min={1} max={4} value={text.lines} onValueChange={(v) => v && set((x) => ({ ...x, text: { ...x.text!, lines: Math.min(4, Math.max(1, v)) } }))} />
            </Field>
            {a.role === 'name' && (
              <Field label={t.names}>
                <NumberInput kind="quantity" min={1} max={4} value={text.count} onValueChange={(v) => v && set((x) => ({ ...x, text: { ...x.text!, count: Math.min(4, Math.max(1, v)) } }))} />
              </Field>
            )}
            <Field label={t.maxChars} hint={suggested ? fill(t.maxHint, { n: suggested, mm: text.min_cap_mm }) : undefined}>
              <NumberInput kind="quantity" min={1} max={40} value={text.max} onValueChange={(v) => v && set((x) => ({ ...x, text: { ...x.text!, max: Math.min(40, Math.max(1, v)) } }))} />
            </Field>
            <Field label={t.minCap}>
              <NumberInput kind="number" decimals={1} min={0.5} max={100} unit={t.mm} value={text.min_cap_mm} onValueChange={(v) => v && v >= 0.5 && set((x) => ({ ...x, text: { ...x.text!, min_cap_mm: v } }))} />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-[12.5px] font-semibold text-text-secondary">{t.textColours}</p>
            <PaintEditor k={k} paint={text.paint} onPaint={(p) => set((x) => ({ ...x, text: { ...x.text!, paint: p } }))} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[12.5px] font-semibold text-text-secondary">{t.sample}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['ar', 'en', 'ckb'] as const).map((l) => (
                <Input
                  key={l}
                  aria-label={l === 'ar' ? t.inAr : l === 'en' ? t.inEn : t.inCkb}
                  placeholder={l === 'ar' ? t.inAr : l === 'en' ? t.inEn : t.inCkb}
                  dir={l === 'en' ? 'ltr' : 'rtl'}
                  maxLength={40}
                  value={text.sample[l]}
                  onChange={(e) => set((x) => ({ ...x, text: { ...x.text!, sample: { ...x.text!.sample, [l]: e.target.value } } }))}
                />
              ))}
            </div>
          </fieldset>
        </>
      )}
      {a.logo && (
        <>
          <Field label={t.logoColours}>
            <NumberInput kind="quantity" min={1} max={4} value={a.logo.max_colors} onValueChange={(v) => v && set((x) => ({ ...x, logo: { ...x.logo!, max_colors: Math.min(4, Math.max(1, v)) } }))} />
          </Field>
          <Chips<LogoMode> keys={LOGO_MODES} label={t.modes} words={(x) => word(LOGO_WORDS, LOGO_MODES, x, lang)} values={a.logo.modes} onChange={(v) => set((x) => ({ ...x, logo: { ...x.logo!, modes: v } }))} />
        </>
      )}
      {a.photo && <Chips<PhotoMode> keys={PHOTO_MODES} label={t.modes} words={(x) => word(PHOTO_WORDS, PHOTO_MODES, x, lang)} values={a.photo.modes} onChange={(v) => set((x) => ({ ...x, photo: { ...x.photo!, modes: v } }))} />}
      {a.qr && <Chips<QrKind> keys={QR_KINDS} label={t.qrKinds} words={(x) => word(TARGET_WORDS, TARGET_KEYS, x, lang)} values={a.qr.kinds} onChange={(v) => set((x) => ({ ...x, qr: { ...x.qr!, kinds: v } }))} />}
      <Switch checked={a.required} onChange={(v) => set((x) => ({ ...x, required: v }))} label={t.required} />
      <Field label={t.fee}>
        <NumberInput kind="money" value={a.fee_iqd} onValueChange={(v) => set((x) => ({ ...x, fee_iqd: Math.max(0, Math.trunc(v ?? 0)) }))} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {a.frame && (
          <Button size="sm" variant="secondary" onClick={() => k.setPick({ move: a.id })}>{t.move}</Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            k.setSel({});
            k.edit((s) => ({
              ...s,
              areas: s.areas.filter((x) => x.id !== a.id),
              rules: s.rules.filter((r) => !('text' in r.if && r.if.text === a.id) && !('qr' in r.if && r.if.qr === a.id) && !('only_colors' in r.then && r.then.only_colors.target === a.id)),
              extras: s.extras.roster ? { ...s.extras, roster: { ...s.extras.roster, vary: s.extras.roster.vary.filter((v) => v !== a.id) } } : s.extras,
            }));
          }}
          data-remove-area={a.id}
        >
          {t.remove}
        </Button>
      </div>
    </div>
  );
}
