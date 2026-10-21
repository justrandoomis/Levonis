/**
 * WHICH PARTS AN OFFER MAKES, AND WHAT IT PROPOSES INSTEAD (plan P1-05,
 * docs/DECISIONS.md row 267) — the part checklist of the composer.
 *
 * The parts this workshop can make (its eligibility answer, per part) are
 * ticked; one it cannot make as asked is greyed with the reason — and becomes
 * selectable as soon as a substitute is proposed on it, because a substitute
 * can make it makeable (the server decides, critique High 5). Each material
 * row the customer chose a material or a colour for can carry «اقترح بديلًا»:
 * a catalogue material of the part own technology, a colour by name, and a
 * note. Nothing is sent for a one-part request unless a substitute is
 * proposed, and nothing at all when every part is covered and nothing is
 * substituted.
 */
import { useId } from 'react';
import { Checkbox } from '../../ui/Switch';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import type { CatalogMaterial } from './api';
import type { RequestPartV3 } from '../../../lib/printApi';
import { fill, type RequestLang, type RequestStrings } from './strings';
import { localColour, localMaterial } from './mirrors';

/** One substitution as the composer holds it. */
export interface ComposerSub {
  part_id: string;
  material_row_id: string;
  material_id: string;
  colour: string;
  note: string;
}

export interface PartsValue {
  /** null = every part. */
  coverage: string[] | null;
  subs: ComposerSub[];
}

/** The verdict per part, as /eligibility answers it; absent for a one-job request. */
export type PartVerdicts = Array<{ part_id: string; eligible: boolean; reasons: string[] }> | null;

/** The default ticks: the parts this workshop can make, else every part. */
export function defaultCoverage(parts: Pick<RequestPartV3, 'id'>[], verdicts: PartVerdicts): string[] | null {
  if (!verdicts) return null;
  const ok = parts.filter((p) => verdicts.find((v) => v.part_id === p.id)?.eligible !== false).map((p) => p.id);
  return ok.length === parts.length || !ok.length ? null : ok;
}

export default function OfferPartsField({
  parts,
  verdicts,
  materials,
  value,
  onChange,
  s,
  lang,
}: {
  parts: RequestPartV3[];
  verdicts: PartVerdicts;
  materials: CatalogMaterial[];
  value: PartsValue;
  onChange: (v: PartsValue) => void;
  s: RequestStrings;
  lang: RequestLang;
}) {
  const id = useId();
  const ordered = [...parts].sort((a, b) => a.position - b.position);
  const covered = (pid: string) => value.coverage === null || value.coverage.includes(pid);
  const setCovered = (pid: string, on: boolean) => {
    const now = value.coverage === null ? ordered.map((p) => p.id) : [...value.coverage];
    const next = on ? [...new Set([...now, pid])] : now.filter((x) => x !== pid);
    const all = ordered.every((p) => next.includes(p.id));
    // Untick a part: its substitutions go with it.
    onChange({ coverage: all ? null : ordered.map((p) => p.id).filter((x) => next.includes(x)), subs: on ? value.subs : value.subs.filter((x) => x.part_id !== pid) });
  };
  const subOf = (pid: string, rid: string) => value.subs.find((x) => x.part_id === pid && x.material_row_id === rid);
  // A substitute on a part covers it: that is how a part this workshop cannot
  // make as asked joins the offer (the server judges it with the substitute).
  const putSub = (next: ComposerSub) => {
    const subs = [...value.subs.filter((x) => !(x.part_id === next.part_id && x.material_row_id === next.material_row_id)), next];
    const now = value.coverage === null ? null : [...new Set([...value.coverage, next.part_id])];
    const all = now === null || ordered.every((p) => now.includes(p.id));
    onChange({ coverage: all ? null : ordered.map((p) => p.id).filter((x) => now!.includes(x)), subs });
  };
  const dropSub = (pid: string, rid: string) => onChange({ ...value, subs: value.subs.filter((x) => !(x.part_id === pid && x.material_row_id === rid)) });
  const sep = lang === 'en' ? ', ' : '، ';
  const showChecks = ordered.length > 1;

  return (
    <fieldset data-offer-parts-field>
      <legend className="mb-1 text-[13px] font-semibold text-text-secondary">{s.partsLabel}</legend>
      {showChecks && <p className="mb-2 text-[12px] text-text-muted">{s.coverPartsHint}</p>}
      <ul className="space-y-2">
        {ordered.map((p) => {
          const verdict = verdicts?.find((v) => v.part_id === p.id);
          const cannot = verdict?.eligible === false;
          const hasSub = value.subs.some((x) => x.part_id === p.id);
          const name = p.name.trim() || fill(s.partN, { n: p.position + 1 });
          return (
            <li key={p.id} className="lv-well rounded-md px-3 py-2" data-offer-part={p.id}>
              {showChecks ? (
                <Checkbox
                  checked={covered(p.id)}
                  disabled={cannot && !hasSub && !covered(p.id)}
                  onChange={(on) => setCovered(p.id, on)}
                  label={p.quantity > 1 ? `${name} ×${p.quantity}` : name}
                  data-offer-part-check={p.id}
                />
              ) : (
                <p className="text-[12.5px] font-semibold text-text-primary">{name}</p>
              )}
              {cannot && <p className="text-[11.5px] text-warning" data-offer-part-cannot>{s.cannotMakePart}</p>}
              {(covered(p.id) || cannot) &&
                p.materials.map((row) => {
                  const named = row.colors.filter((c) => c.mode === 'catalogue' || c.mode === 'custom');
                  const substitutable = !row.material_unsure && !!row.material_id;
                  if (!substitutable) return null;
                  const sub = subOf(p.id, row.id);
                  const asked = [localMaterial(row.material_id, lang), named.map((c) => localColour(c.label || c.hex, lang) || c.hex).join(sep)].filter(Boolean).join(' · ');
                  const sameProcess = materials.filter((m) => {
                    const from = materials.find((x) => x.id === row.material_id);
                    return !from || m.process === from.process;
                  });
                  return (
                    <div key={row.id} className="mt-1.5" data-offer-row={row.id}>
                      <p className="text-[11.5px] text-text-secondary" dir="auto">
                        {s.asAsked}: {asked}
                      </p>
                      {sub ? (
                        <div className="mt-1.5 space-y-2" data-offer-sub={row.id}>
                          <label className="block text-[12px] text-text-muted" htmlFor={`${id}-${row.id}-m`}>
                            {s.substituteMaterial}
                          </label>
                          <select
                            id={`${id}-${row.id}-m`}
                            className="lv-input w-full"
                            value={sub.material_id}
                            onChange={(e) => putSub({ ...sub, material_id: e.target.value })}
                            data-offer-sub-material
                          >
                            {sameProcess.map((m) => (
                              <option key={m.id} value={m.id}>
                                {lang === 'en' ? m.name_en : m.name_ar || m.name_en}
                              </option>
                            ))}
                          </select>
                          {named.length > 0 && (
                            <Input
                              value={sub.colour}
                              maxLength={60}
                              placeholder={s.substituteColour}
                              aria-label={s.substituteColour}
                              onChange={(e) => putSub({ ...sub, colour: e.target.value })}
                              dir="auto"
                              data-offer-sub-colour
                            />
                          )}
                          <Input
                            value={sub.note}
                            maxLength={200}
                            placeholder={s.substituteNote}
                            aria-label={s.substituteNote}
                            onChange={(e) => putSub({ ...sub, note: e.target.value })}
                            dir="auto"
                            data-offer-sub-note
                          />
                          <Button type="button" size="sm" variant="ghost" onClick={() => dropSub(p.id, row.id)} data-offer-sub-remove>
                            {s.removeSubstitute}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="mt-1"
                          onClick={() => putSub({ part_id: p.id, material_row_id: row.id, material_id: row.material_id, colour: '', note: '' })}
                          data-offer-sub-add={row.id}
                        >
                          {s.proposeSubstitute}
                        </Button>
                      )}
                    </div>
                  );
                })}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * THE BODY HALF (`offerBody`): coverage and substitutions only when they are
 * not the default — or, on an edit of an offer that had some, the default
 * written out, so it is cleared. A one-part, nothing-substituted offer sends
 * exactly what it always did.
 */
export function partsBody(v: PartsValue, opts: { clear: boolean }): { coverage?: { parts: string[] } | null; substitutions?: Array<{ part_id: string; material_row_id: string; to: { material_id?: string; colors?: Array<{ hex: string; label: string }> }; note?: string }> } {
  const subs = v.subs.map((x) => ({
    part_id: x.part_id,
    material_row_id: x.material_row_id,
    to: { material_id: x.material_id, ...(x.colour.trim() ? { colors: [{ hex: '', label: x.colour.trim() }] } : {}) },
    ...(x.note.trim() ? { note: x.note.trim() } : {}),
  }));
  const out: ReturnType<typeof partsBody> = {};
  if (v.coverage !== null) out.coverage = { parts: v.coverage };
  else if (opts.clear) out.coverage = null;
  if (subs.length) out.substitutions = subs;
  else if (opts.clear) out.substitutions = [];
  return out;
}
