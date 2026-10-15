/**
 * SCREEN 3 — «حالة الجهاز» (trade-in design B.2, spec §10.1.3): ONE scrolling screen per part
 * (a segmented control when a Combo is traded whole), photographs inline.
 *
 *   hours           a number, and the photograph of the hours screen it is bound to (required:
 *                   `proves = 'hours'`, G14);
 *   overall         three chips — Excellent / Good / Needs care — that set cleanliness, exterior
 *                   and scratches to 5 / 4 / 2;
 *   damage          «لا يوجد ضرر» or the family's faults as chips, each ticked one asking for its
 *                   own close-up (`proves = <fault id>`);
 *   replaced parts  when the owner's rule set asks;
 *   accessories     all / some / none;
 *   photos          the family's required angles as a grid, with the progress «4/4».
 *
 * Nothing here is worth anything on the phone: the answers are saved (PATCH) and the server
 * prices them on screen 5. «متابعة» stays off while anything is missing, and the missing items
 * are listed in words.
 */
import React, { useState } from 'react';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { Segmented } from '../ui/Segmented';
import {
  FAMILY_LABELS,
  HOURS_PHOTO,
  MAX_DAMAGE_PHOTOS,
  MAX_HOURS,
  MAX_PHOTOS_PER_ANGLE,
  OPTIONAL_PHOTO,
  REQUIRED_PHOTOS,
  familyCountsHours,
  type PhotoAngle,
} from '../../../packages/pricing/src/tradeIn';
import { useT } from './useT';
import { Choice, ErrorLine, PhotoButton, RadioGroup, Thumb, Uploading, useErrText } from './parts';
import { uploadTradeInPhoto } from './photoUpload';
import { labelOf, type ComponentInputs, type ComponentRole, type ComponentView, type PhotoView, type RequestView } from './model';
import type { CopyKey } from './copy';

export type Inputs = Partial<Record<ComponentRole, ComponentInputs>>;
export type Overall = 'excellent' | 'good' | 'care';

const PRESET: Record<Overall, 5 | 4 | 2> = { excellent: 5, good: 4, care: 2 };

export function overallOf(i: ComponentInputs | undefined): Overall | null {
  if (!i) return null;
  for (const o of ['excellent', 'good', 'care'] as const) if (i.cleanliness === PRESET[o] && i.exterior === PRESET[o] && i.scratches === PRESET[o]) return o;
  return null;
}

/** A v2 request binds the hours to a photograph (and a resin printer or a laser may carry one); a v1 draft is asked only what its door enforces. */
export function hoursPhotoAsked(c: ComponentView, version: number): boolean {
  return familyCountsHours(c.family) && (REQUIRED_PHOTOS[c.family].some((a) => a.id === HOURS_PHOTO.id) || version >= 2);
}
const hasHoursPhoto = (c: ComponentView) => c.photos.some((p) => p.proves === 'hours' || p.angle === HOURS_PHOTO.id);
const damagePhotos = (c: ComponentView, fault: string) => c.photos.filter((p) => p.angle === OPTIONAL_PHOTO.id && p.proves === fault);
/** The angles of the grid: the family's required list, the hours screen shown with the hours instead. */
export const gridAngles = (c: ComponentView): PhotoAngle[] => REQUIRED_PHOTOS[c.family].filter((a) => !(familyCountsHours(c.family) && a.id === HOURS_PHOTO.id));

/**
 * WHAT THE CUSTOMER HAS ANSWERED, per part (review F-23). The stored answers start as the rule
 * set's blanks («good», «no damage», «all», 0 hours), so a value alone cannot say whether it was
 * chosen: the screen keeps its own record, and nothing reads as chosen until it was.
 */
export interface Answered {
  overall?: boolean;
  accessories?: boolean;
  hours?: boolean;
}

/** What one part still lacks before «متابعة», in the customer's words. `damage` undefined: not answered yet. */
export function missingFor(
  c: ComponentView,
  inputs: ComponentInputs | undefined,
  damage: boolean | undefined,
  version: number,
  t: (k: CopyKey, v?: Record<string, string | number>) => string,
  loc: (ar: string, en: string, ckb?: string) => string,
  faultLabel: (id: string) => string,
  answered: Answered = { overall: true, accessories: true, hours: true },
  faultsAsked = false
): string[] {
  const out: string[] = [];
  const v2 = version >= 2;
  const damageYes = damage === true;
  if (familyCountsHours(c.family) && inputs?.hours !== null && inputs?.hours !== undefined && !answered.hours) out.push(t('missing.hours'));
  if (hoursPhotoAsked(c, version) && inputs?.hours !== null && !hasHoursPhoto(c)) out.push(t('photo.hoursBound'));
  if (!answered.overall) out.push(t('missing.condition'));
  if (faultsAsked && damage === undefined) out.push(t('missing.damagePick'));
  if (damageYes && (inputs?.faults ?? []).length === 0) out.push(t('missing.damagePick'));
  if (!answered.accessories) out.push(t('missing.accessories'));
  if (v2) for (const f of inputs?.faults ?? []) if (damagePhotos(c, f).length === 0) out.push(t('missing.damagePhoto', { x: faultLabel(f) }));
  for (const a of gridAngles(c)) if (!c.photos.some((p) => p.angle === a.id)) out.push(t('missing.angle', { x: loc(a.label_ar, a.label_en, a.label_ckb) }));
  return out;
}

/**
 * THE SERVER'S BLOCKERS IN WORDS (review F-32): when the saved answers still lack something the
 * screen did not see (a photo removed in another tab, a rule changed), «قبل المتابعة:» names it —
 * a field, a photograph by its angle, the hours photo, a damage close-up by its fault.
 */
export function blockerLines(
  req: Pick<RequestView, 'components'>,
  blockers: { inputs: Record<string, string[]>; photos: Record<string, string[]> },
  t: (k: CopyKey, v?: Record<string, string | number>) => string,
  loc: (ar: string, en: string, ckb?: string) => string,
  faultLabel: (family: string) => (id: string) => string
): string[] {
  const out: string[] = [];
  const SCORE = new Set(['cleanliness', 'exterior', 'scratches', 'accessory_condition']);
  for (const c of req.components) {
    const prefix = req.components.length > 1 ? `${t(c.role === 'ams' ? 'part.ams' : 'part.device')}: ` : '';
    for (const f of blockers.inputs[c.role] ?? []) {
      const field = f.split(':')[0];
      out.push(
        prefix +
          (field === 'hours'
            ? t('missing.hours')
            : field === 'original_accessories'
              ? t('missing.accessories')
              : field === 'faults'
                ? t('missing.damagePick')
                : SCORE.has(field)
                  ? t('missing.condition')
                  : t('missing.answer', { x: t('cond.title') }))
      );
    }
    for (const p of blockers.photos[c.role] ?? []) {
      if (p === 'hours') out.push(prefix + t('photo.hoursBound'));
      else if (p.startsWith('damage:')) out.push(prefix + t('missing.damagePhoto', { x: faultLabel(c.family)(p.slice('damage:'.length)) }));
      else {
        const a = [...REQUIRED_PHOTOS[c.family], HOURS_PHOTO, OPTIONAL_PHOTO].find((x) => x.id === p);
        out.push(prefix + t('missing.angle', { x: a ? loc(a.label_ar, a.label_en, a.label_ckb) : p }));
      }
    }
  }
  return [...new Set(out)];
}

export default function ConditionScreen({
  req,
  role,
  onRole,
  inputs,
  setInputs,
  damage,
  setDamage,
  answered: answeredAll,
  setAnswered,
  onPhoto,
  onPhotoRemoved,
}: {
  req: RequestView;
  role: ComponentRole;
  onRole: (r: ComponentRole) => void;
  inputs: Inputs;
  setInputs: React.Dispatch<React.SetStateAction<Inputs>>;
  damage: Partial<Record<ComponentRole, boolean>>;
  setDamage: React.Dispatch<React.SetStateAction<Partial<Record<ComponentRole, boolean>>>>;
  answered: Partial<Record<ComponentRole, Answered>>;
  setAnswered: React.Dispatch<React.SetStateAction<Partial<Record<ComponentRole, Answered>>>>;
  onPhoto: (p: PhotoView) => void;
  onPhotoRemoved: (id: string) => void;
}) {
  const { t } = useT();
  const { loc } = useLanguage();
  const errText = useErrText();
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  const comp = req.components.find((c) => c.role === role) ?? req.components[0];
  const value = comp ? inputs[comp.role] : undefined;
  const questions = comp ? req.questions?.[comp.family] : undefined;
  if (!comp || !value) return null;
  const version = req.valuation_version ?? 1;
  const set = (patch: Partial<ComponentInputs>) =>
    setInputs((cur) => ({
      ...cur,
      [comp.role]: { ...(cur[comp.role] as ComponentInputs), ...patch },
    }));
  const faults = (questions?.faults ?? []).map((f) => ({
    id: f.id,
    label: labelOf(f, loc),
  }));
  const faultLabel = (id: string) => faults.find((f) => f.id === id)?.label ?? id;
  const replaced = questions?.asked.includes('replaced_parts')
    ? (questions.replaced_parts ?? []).map((p) => ({
        id: p.id,
        label: labelOf(p, loc),
      }))
    : [];
  const answered = answeredAll[comp.role] ?? {};
  const answer = (k: keyof Answered) => setAnswered((cur) => ({ ...cur, [comp.role]: { ...(cur[comp.role] ?? {}), [k]: true } }));
  const overall = answered.overall ? overallOf(value) : null;
  const damageAnswer = damage[comp.role] ?? (value.faults.length > 0 ? true : undefined);
  const damageYes = damageAnswer === true;
  const hoursAsked = familyCountsHours(comp.family) && value.hours !== null;

  const upload = async (slot: string, file: File, angle: string, proves?: string) => {
    const key = `${comp.role}:${slot}:${file.name}:${file.size}`;
    setError('');
    setUploads((u) => ({ ...u, [key]: 0 }));
    try {
      const photo = await uploadTradeInPhoto(`/api/trade-in/requests/${encodeURIComponent(req.id)}/photos`, file, { component: comp.role, angle, proves }, (f) =>
        setUploads((u) => ({ ...u, [key]: f }))
      );
      onPhoto(photo);
    } catch (e) {
      setError(errText(e, t('photo.failed')));
    } finally {
      setUploads((u) => {
        const next = { ...u };
        delete next[key];
        return next;
      });
    }
  };
  const remove = async (p: PhotoView) => {
    setError('');
    try {
      await api.delete(`/api/trade-in/requests/${encodeURIComponent(req.id)}/photos/${encodeURIComponent(p.id)}`);
      onPhotoRemoved(p.id);
    } catch (e) {
      setError(errText(e));
    }
  };
  const busyFor = (slot: string) => Object.entries(uploads).filter(([k]) => k.startsWith(`${comp.role}:${slot}:`));

  /** One proof row: what it is, its photographs, and the camera. */
  const proofRow = (slot: string, title: string, photos: PhotoView[], max: number, angle: string, proves: string | undefined, required: boolean) => {
    const busy = busyFor(slot);
    const ok = photos.length > 0;
    return (
      <div className="lv-well rounded-md p-3" data-proof={slot}>
        <div className="flex items-center gap-2">
          {ok ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden />
          ) : (
            <CircleDashed className={`h-5 w-5 shrink-0 ${required ? 'text-warning' : 'text-text-muted'}`} aria-hidden />
          )}
          <span className="min-w-0 flex-1 text-[13px] font-semibold leading-5 text-text-primary">{title}</span>
          {photos.length < max ? (
            <PhotoButton onFile={(f) => void upload(slot, f, angle, proves)} label={ok ? t('photo.retake') : t('photo.take')} busy={busy.length > 0} testId={slot} />
          ) : null}
        </div>
        {photos.length > 0 || busy.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {photos.map((p) => (
              <Thumb key={p.id} photo={p} label={title} onRemove={() => void remove(p)} />
            ))}
            {busy.map(([k, f]) => (
              <Uploading key={k} fraction={f} />
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const angles = gridAngles(comp);
  const done = angles.filter((a) => comp.photos.some((p) => p.angle === a.id)).length;
  const fam = FAMILY_LABELS[comp.family];

  return (
    <div className="space-y-4" data-condition={comp.role}>
      {req.components.length > 1 ? (
        <Segmented
          group="trade-in-part"
          label={t('parts')}
          value={comp.role}
          onChange={(id) => onRole(id as ComponentRole)}
          items={req.components.map((c) => ({
            id: c.role,
            label: t(c.role === 'ams' ? 'part.ams' : 'part.device'),
          }))}
          dataAttr="data-part"
        />
      ) : null}
      <p className="text-[12.5px] text-text-muted">{loc(fam.ar, fam.en, fam.ckb)}</p>

      {hoursAsked ? (
        <section className="lv-surface space-y-3 p-4" aria-labelledby={`hours-${comp.role}`}>
          <label id={`hours-${comp.role}`} htmlFor={`hours-input-${comp.role}`} className="block text-[15px] font-bold text-text-primary">
            {t(comp.family === 'laser' ? 'hours.qLaser' : 'hours.q')}
          </label>
          {/* One direction for the figure and its unit: the digits never run under «ساعة». */}
          <div className="relative" dir="ltr">
            <input
              id={`hours-input-${comp.role}`}
              className="lv-input pe-16 text-lg font-bold tabular-nums"
              inputMode="numeric"
              pattern="[0-9]*"
              dir="ltr"
              value={answered.hours ? String(value.hours ?? 0) : ''}
              placeholder="0"
              onChange={(e) => {
                const digits = e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9]/g, '');
                set({
                  hours: Math.min(MAX_HOURS, digits ? Number(digits) : 0),
                });
                setAnswered((cur) => ({ ...cur, [comp.role]: { ...(cur[comp.role] ?? {}), hours: digits !== '' } }));
              }}
              aria-describedby={`hours-hint-${comp.role}`}
              data-hours
            />
            <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-[12.5px] text-text-muted">{t('hours.unit')}</span>
          </div>
          <p id={`hours-hint-${comp.role}`} className="text-[12px] leading-5 text-text-muted">
            {t('hours.hint')}
          </p>
          {hoursPhotoAsked(comp, version)
            ? proofRow(
                'hours',
                t('hours.photo'),
                comp.photos.filter((p) => p.proves === 'hours' || p.angle === HOURS_PHOTO.id),
                MAX_PHOTOS_PER_ANGLE,
                HOURS_PHOTO.id,
                'hours',
                true
              )
            : null}
        </section>
      ) : null}

      <section className="lv-surface space-y-3 p-4">
        <h3 className="text-[15px] font-bold text-text-primary">{t('cond.q')}</h3>
        <RadioGroup aria-label={t('cond.q')} className="grid grid-cols-3 gap-2">
          {(['excellent', 'good', 'care'] as const).map((o) => (
            <Choice
              key={o}
              radio
              on={overall === o}
              onClick={() => {
                set({
                  cleanliness: PRESET[o],
                  exterior: PRESET[o],
                  scratches: PRESET[o],
                });
                answer('overall');
              }}
              className="min-h-[52px] flex-col px-2 text-center leading-4"
              data-overall={o}
            >
              {t(`cond.${o}` as CopyKey)}
            </Choice>
          ))}
        </RadioGroup>
        {overall ? <p className="text-[12.5px] text-text-secondary">{t(`cond.${overall}Hint` as CopyKey)}</p> : null}
      </section>

      {faults.length > 0 ? (
        <section className="lv-surface space-y-3 p-4">
          <h3 className="text-[15px] font-bold text-text-primary">{t('damage.q')}</h3>
          <RadioGroup aria-label={t('damage.q')} className="grid grid-cols-2 gap-2">
            <Choice
              radio
              on={damageAnswer === false}
              onClick={() => {
                setDamage((d) => ({ ...d, [comp.role]: false }));
                set({ faults: [] });
              }}
              data-damage="none"
            >
              {t('damage.none')}
            </Choice>
            <Choice radio on={damageYes} onClick={() => setDamage((d) => ({ ...d, [comp.role]: true }))} data-damage="yes">
              {t('damage.yes')}
            </Choice>
          </RadioGroup>
          {damageYes ? (
            <div className="space-y-3">
              <p className="text-[12.5px] text-text-secondary">{t('damage.pick')}</p>
              <div className="flex flex-wrap gap-2">
                {faults.map((f) => {
                  const on = value.faults.includes(f.id);
                  return (
                    <Choice
                      key={f.id}
                      on={on}
                      onClick={() =>
                        set({
                          faults: on ? value.faults.filter((x) => x !== f.id) : [...value.faults, f.id],
                        })
                      }
                      className="rounded-full"
                      data-fault={f.id}
                    >
                      {f.label}
                    </Choice>
                  );
                })}
              </div>
              {version >= 2 && value.faults.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[12.5px] font-semibold text-text-primary">{t('photo.perDamage')}</p>
                  {value.faults.map((id) => (
                    <React.Fragment key={id}>{proofRow(`damage:${id}`, faultLabel(id), damagePhotos(comp, id), MAX_DAMAGE_PHOTOS, OPTIONAL_PHOTO.id, id, true)}</React.Fragment>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {replaced.length > 0 ? (
        <section className="lv-surface space-y-3 p-4">
          <h3 className="text-[15px] font-bold text-text-primary">{t('replaced.q')}</h3>
          <div className="flex flex-wrap gap-2">
            <Choice on={value.replaced_parts.length === 0} onClick={() => set({ replaced_parts: [] })} className="rounded-full">
              {t('replaced.none')}
            </Choice>
            {replaced.map((p) => {
              const on = value.replaced_parts.includes(p.id);
              return (
                <Choice
                  key={p.id}
                  on={on}
                  onClick={() =>
                    set({
                      replaced_parts: on ? value.replaced_parts.filter((x) => x !== p.id) : [...value.replaced_parts, p.id],
                    })
                  }
                  className="rounded-full"
                  data-part-replaced={p.id}
                >
                  {p.label}
                </Choice>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="lv-surface space-y-3 p-4">
        <h3 className="text-[15px] font-bold text-text-primary">{t('acc.q')}</h3>
        <RadioGroup aria-label={t('acc.q')} className="grid grid-cols-3 gap-2">
          {(
            [
              ['all', 'acc.all'],
              ['partial', 'acc.some'],
              ['none', 'acc.none'],
            ] as const
          ).map(([id, key]) => (
            <Choice
              key={id}
              radio
              on={!!answered.accessories && value.original_accessories === id}
              onClick={() => {
                set({ original_accessories: id });
                answer('accessories');
              }}
              data-accessories={id}
            >
              {t(key)}
            </Choice>
          ))}
        </RadioGroup>
      </section>

      <section className="lv-surface space-y-3 p-4" aria-labelledby={`photos-${comp.role}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 id={`photos-${comp.role}`} className="text-[15px] font-bold text-text-primary">
            {t('photos.title')}
          </h3>
          <span className={`text-[13px] font-bold tabular-nums ${done === angles.length ? 'text-success' : 'text-text-secondary'}`} data-photo-progress>
            <bdi dir="ltr">
              {done}/{angles.length}
            </bdi>
            {done === angles.length ? ' ✓' : ''}
          </span>
        </div>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {angles.map((a) => (
            <li key={a.id} data-angle={a.id}>
              {proofRow(
                `angle:${a.id}`,
                loc(a.label_ar, a.label_en, a.label_ckb),
                comp.photos.filter((p) => p.angle === a.id),
                MAX_PHOTOS_PER_ANGLE,
                a.id,
                undefined,
                true
              )}
              <p className="mt-1 px-1 text-[11.5px] leading-4 text-text-muted">{loc(a.hint_ar, a.hint_en, a.hint_ckb)}</p>
            </li>
          ))}
        </ul>
        <p className="text-[12px] leading-5 text-text-muted">{t('photos.private')}</p>
      </section>

      <section className="lv-surface p-4">
        <label htmlFor={`notes-${comp.role}`} className="mb-2 block text-[13.5px] font-semibold text-text-primary">
          {t('notes.label')}
        </label>
        <textarea
          id={`notes-${comp.role}`}
          className="lv-input resize-y px-3 py-2.5 text-[14px] leading-6"
          rows={3}
          maxLength={1000}
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </section>

      <ErrorLine>{error}</ErrorLine>

      {req.components.length > 1 && comp.role === req.components[0].role ? (
        <button
          type="button"
          onClick={() => onRole(req.components[1].role)}
          className="lv-button lv-button-ghost w-full border border-dashed border-border-subtle text-[13px]"
          data-next-part
        >
          {t('next.ams')}
        </button>
      ) : null}
    </div>
  );
}
