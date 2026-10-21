/**
 * ONE PART OF THE JOB (plan P1-06; design §6.1, critiques 8 and 13).
 *
 * A job of one part has no card around it: its materials, its size and its
 * notes read as «ماذا نطبع». With several, each part is a card titled with
 * its name or «القطعة n» (the word every refusal and offer screen uses), and
 * a card that is not open folds to one line — the material, the colour, the
 * size — so a twelve-part job is a list to scan, not a wall of fields.
 *
 * The fields a part needs come first; the region of a material, its special
 * requirements, the part’s references, its notes and how it is assembled
 * wait behind «تفاصيل أكثر». The printing process is asked only while every
 * material is «لست متأكدًا» — a chosen material decides it. The estimate of
 * the part, or why it has none, is on the card, so a part the publish would
 * refuse is visible before the publish. The technical review is the
 * server’s, read here, never computed.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, MoreVertical, Plus, Ruler } from 'lucide-react';
import { Button, IconButton } from '../../../ui/Button';
import { Field, Input, Select, Textarea } from '../../../ui/Field';
import { NumberInput } from '../../../ui/NumberInput';
import { Segmented } from '../../../ui/Segmented';
import { Menu } from '../../../ui/Menu';
import { Checkbox } from '../../../ui/Switch';
import { bidiContent } from '../../../ui/BidiText';
import type { CatalogMaterial, DraftFile } from '../api';
import { requestStrings } from '../strings';
import { MaterialRow, colourWords, materialWords } from './MaterialRow';
import type { RefChoice } from './ColourPicker';
import { middleTruncate } from './SourceThumb';
import { LIMITS, processIsOpen, statedDims, type EditorColour, type EditorMaterial, type EditorPart, type Key } from './state';
import { fill, type EditorLang, type EditorStrings } from './strings';

/** «82×64×41» from a measured model, in whole millimetres. */
export function dimsText(d: { x: number; y: number; z: number }): string {
  return `${Math.round(d.x)}×${Math.round(d.y)}×${Math.round(d.z)}`;
}

/** The size a part is priced on: its measured model’s, else what was typed. */
export function partSize(p: EditorPart, files: readonly DraftFile[]): { x: number; y: number; z: number } | null {
  const f = p.measuredFileId ? files.find((x) => x.id === p.measuredFileId) : undefined;
  if (f?.analysis?.measured) return f.analysis.dimensions_mm;
  return statedDims(p);
}

export interface PartEstimate {
  kind: 'priced' | 'unpriced' | 'loading';
  text: string;
}

export function PartCard({
  part,
  index,
  count,
  files,
  measurable,
  measuring,
  measureLater,
  catalogue,
  refs,
  refName,
  estimate,
  expanded,
  lang,
  t,
  onToggle,
  onPatch,
  onMaterial,
  onChooseMaterial,
  onColours,
  onAddMaterial,
  onRemoveMaterial,
  onMove,
  onDuplicate,
  onRemove,
  headingRef,
  nameRef,
}: {
  part: EditorPart;
  index: number;
  count: number;
  files: readonly DraftFile[];
  measurable: readonly DraftFile[];
  measuring: ReadonlySet<string>;
  measureLater: ReadonlySet<string>;
  catalogue: readonly CatalogMaterial[];
  refs: RefChoice[];
  refName: (key: string) => string;
  estimate: PartEstimate | null;
  expanded: boolean;
  lang: EditorLang;
  t: EditorStrings;
  onToggle: () => void;
  onPatch: (p: Partial<EditorPart>) => void;
  onMaterial: (matKey: Key, p: Partial<EditorMaterial>) => void;
  onChooseMaterial: (matKey: Key, id: string) => void;
  onColours: (matKey: Key, next: EditorColour[]) => void;
  onAddMaterial: () => void;
  onRemoveMaterial: (matKey: Key) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  headingRef?: (el: HTMLElement | null) => void;
  nameRef?: (el: HTMLInputElement | null) => void;
}) {
  const [details, setDetails] = useState(false);
  const single = count === 1;
  const rs = requestStrings(lang);
  const title = part.name.trim() || fill(rs.partN, { n: index + 1 });
  const size = partSize(part, files);
  const measuredFile = part.measuredFileId ? files.find((f) => f.id === part.measuredFileId) : undefined;
  const summary = [
    part.materials.map((m) => materialWords(m.materialId, lang, t, catalogue)).join(' + '),
    part.materials.flatMap((m) => m.colours).map((c) => colourWords(c, lang, t, refName)).filter(Boolean).slice(0, 3).join('، '),
    size ? fill(t.measured, { dims: dimsText(size) }) : '',
    part.perSet > 1 ? `×${part.perSet}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const review = part.reviewState === 'needs_technical_review' && (
    <p className="lv-alert lv-alert-warning text-[12.5px]" role="note" data-editor-part-review>
      <span className="font-semibold">{rs.reviewChip}</span>
      {part.reviewReasons.length > 0 && <span> — {part.reviewReasons.map((r) => rs.reviewReasons[r] ?? r).join('، ')}</span>}
    </p>
  );

  const estimateLine = estimate && (
    <p
      className={`text-[12.5px] ${estimate.kind === 'unpriced' ? 'font-semibold text-warning' : 'text-text-secondary'}`}
      data-editor-part-estimate={estimate.kind}
    >
      {bidiContent(estimate.text)}
    </p>
  );

  const body: ReactNode = (
    <div className="space-y-4" data-editor-part-body>
      {!single && (
        <div className="grid gap-3 min-[480px]:grid-cols-2">
          <Field label={t.partName} hint={t.partNameHint}>
            <Input ref={nameRef} dir="auto" maxLength={LIMITS.partNameMax} value={part.name} placeholder={fill(rs.partN, { n: index + 1 })} onChange={(e) => onPatch({ name: e.target.value })} />
          </Field>
          <Field label={t.perSet}>
            <NumberInput kind="quantity" min={1} max={LIMITS.partQuantityMax} value={part.perSet} onValueChange={(v) => onPatch({ perSet: Math.max(1, Math.min(LIMITS.partQuantityMax, v ?? 1)) })} />
          </Field>
        </div>
      )}

      <div className="space-y-3">
        {part.materials.map((m, i) => (
          <MaterialRow
            key={m.key}
            material={m}
            index={i}
            count={part.materials.length}
            process={part.process}
            catalogue={catalogue}
            refs={refs}
            refName={refName}
            details={details}
            lang={lang}
            t={t}
            onChooseMaterial={(id) => onChooseMaterial(m.key, id)}
            onColours={(next) => onColours(m.key, next)}
            onPatch={(p) => onMaterial(m.key, p)}
            onRemove={() => onRemoveMaterial(m.key)}
          />
        ))}
        {part.materials.length < LIMITS.maxMaterialsPerPart && (
          <div>
            <Button size="sm" variant="ghost" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={onAddMaterial}>
              {t.addMaterial}
            </Button>
            <p className="mt-1 text-[11.5px] text-text-muted">{t.addMaterialHint}</p>
          </div>
        )}
      </div>

      {processIsOpen(part) && (
        <div>
          <p className="mb-2 text-[13px] font-semibold text-text-secondary">{t.process}</p>
          <Segmented
            group={`part-process-${part.key}`}
            size="sm"
            label={t.process}
            value={part.process}
            onChange={(id) => onPatch({ process: id as EditorPart['process'] })}
            items={[
              { id: 'fdm', label: t.processFdm },
              { id: 'resin', label: t.processResin },
              { id: 'unsure', label: t.unsure },
            ]}
          />
        </div>
      )}

      <div className="space-y-2">
        {measurable.length > 0 && (
          <Field label={t.measuredFrom}>
            <Select value={part.measuredFileId ?? ''} onChange={(e) => onPatch({ measuredFileId: e.target.value || null })} dir="auto">
              <option value="">{t.noModel}</option>
              {measurable.map((f) => (
                <option key={f.id} value={f.id}>
                  {middleTruncate(f.file_name, 40)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {measuredFile ? (
          <p className="lv-well flex items-center gap-2 rounded-md px-3.5 py-2.5 text-[12.5px] text-text-secondary" data-editor-part-size>
            <Ruler aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            {measuredFile.analysis?.measured
              ? bidiContent(fill(t.measured, { dims: dimsText(measuredFile.analysis.dimensions_mm) }))
              : measuring.has(measuredFile.id)
                ? t.stMeasuring
                : measureLater.has(measuredFile.id)
                  ? t.stMeasureLater
                  : t.stMeasuring}
          </p>
        ) : (
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-text-secondary">{t.sizeApprox}</legend>
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map((k) => (
                <Field key={k} label={k === 'x' ? t.length : k === 'y' ? t.width : t.height}>
                  <NumberInput min={1} max={5000} decimals={1} unit="mm" value={part.dims[k]} onValueChange={(v) => onPatch({ dims: { ...part.dims, [k]: v } })} />
                </Field>
              ))}
            </div>
          </fieldset>
        )}
        {measuredFile && !measuredFile.analysis?.measured && measureLater.has(measuredFile.id) && (
          <p className="text-[11.5px] text-text-muted">{t.stMeasureLaterHint}</p>
        )}
      </div>

      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={details}
          iconEnd={details ? <ChevronUp aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
          onClick={() => setDetails((v) => !v)}
          data-editor-part-details
        >
          {details ? t.fewerDetails : t.moreDetails}
        </Button>
        {details && (
          <div className="mt-3 space-y-3">
            {!single && refs.length > 0 && (
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-semibold text-text-secondary">{t.partSources}</legend>
                <div className="flex flex-col">
                  {refs.map((r) => (
                    <Checkbox
                      key={r.key}
                      checked={part.sourceKeys.includes(r.key)}
                      onChange={(on) => onPatch({ sourceKeys: on ? [...part.sourceKeys, r.key] : part.sourceKeys.filter((k) => k !== r.key) })}
                      label={<bdi>{r.label}</bdi>}
                    />
                  ))}
                </div>
              </fieldset>
            )}
            <Field label={t.partNotes}>
              <Textarea dir="auto" rows={2} maxLength={LIMITS.partNotesMax} value={part.notes} onChange={(e) => onPatch({ notes: e.target.value })} />
            </Field>
            <Field label={t.assembly}>
              <Textarea dir="auto" rows={2} maxLength={LIMITS.partNotesMax} value={part.assembly} onChange={(e) => onPatch({ assembly: e.target.value })} />
            </Field>
          </div>
        )}
      </div>

      {estimateLine}
      {review}
    </div>
  );

  if (single) return <div data-editor-part={part.key}>{body}</div>;

  return (
    <article className="lv-surface p-0" data-editor-part={part.key} aria-labelledby={`part-title-${part.key}`}>
      <div className="flex items-start gap-1 p-2">
        <button
          type="button"
          ref={headingRef}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={fill(expanded ? t.foldPart : t.openPart, { name: title })}
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-md px-2 py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-editor-part-toggle
        >
          <span id={`part-title-${part.key}`} className="block max-w-full truncate text-[14.5px] font-bold text-text-primary">
            <bdi>{title}</bdi>
          </span>
          {!expanded && summary && <span className="mt-0.5 block max-w-full truncate text-[12px] text-text-muted">{bidiContent(summary)}</span>}
          {!expanded && estimate && estimate.kind !== 'loading' && (
            <span className={`mt-0.5 block max-w-full truncate text-[12px] ${estimate.kind === 'unpriced' ? 'text-warning' : 'text-text-secondary'}`}>{bidiContent(estimate.text)}</span>
          )}
        </button>
        <Menu
          label={fill(t.partOptions, { name: title })}
          items={[
            { id: 'up', label: t.moveUp, disabled: index === 0, onSelect: () => onMove(-1) },
            { id: 'down', label: t.moveDown, disabled: index === count - 1, onSelect: () => onMove(1) },
            { id: 'dup', label: t.duplicatePart, disabled: count >= LIMITS.maxParts, onSelect: onDuplicate },
            { id: 'sep', separator: true },
            { id: 'remove', label: t.removePart, destructive: true, onSelect: onRemove },
          ]}
          trigger={(props) => <IconButton {...props} label={fill(t.partOptions, { name: title })} icon={<MoreVertical className="h-5 w-5" />} data-editor-part-menu />}
        />
      </div>
      {expanded && <div className="border-t border-border-subtle p-3">{body}</div>}
    </article>
  );
}
