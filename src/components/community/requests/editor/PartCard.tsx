/**
 * ONE PART OF THE JOB (community UI plan C4, step 2; IMG_8482; P1-06 design
 * §6.1, critiques 8 and 13).
 *
 * A job of one part has no card around it: its questions are the cards of
 * the step, as the reference draws them, «طريقة الطباعة» (three tiles), the
 * material and the colour, then «الجودة» and the quantity (the job, passed
 * in as `between`), then «الأبعاد (مم)». With several, each part is a card
 * titled with its name or «القطعة n» (the word every refusal and offer
 * screen uses), and a card that is not open folds to one line: the
 * material, the colour, the size, so a twelve-part job is a list to scan.
 *
 * The print method tiles are always there; a material decides the method
 * (the server rule), so choosing the other method sends that material back
 * to «لست متأكدًا» and says so. The size is «مقاسة» (read from the measured
 * model, read-only) or «تقريبية» (typed); «مقاسة» is offered only when a
 * model is measured, and says why not otherwise. The finish, the region of
 * a material, its requirements, the references of the part, its notes and
 * how it is assembled wait behind «تفاصيل أكثر». The estimate of the part,
 * or why it has none, is on it, so a part the publish would refuse is seen
 * before the publish. The technical review is the server one, read here.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Ellipsis, Plus } from 'lucide-react';
import { NumberInput } from '../../../ui/NumberInput';
import { Menu } from '../../../ui/Menu';
import { Checkbox } from '../../../ui/Switch';
import { ChoiceTiles, SegmentedTrack, Stepper } from '../../kit/controls';
import { CountedField } from '../../kit/fields';
import { KitButton, KitIconButton } from '../../kit/buttons';
import { KitCard, SectionCard } from '../../kit/display';
import type { CatalogMaterial, DraftFile } from '../api';
import { requestStrings } from '../strings';
import { MaterialRow, coloursSummary, materialWords } from './MaterialRow';
import type { RefChoice } from './ColourPicker';
import { middleTruncate } from './SourceThumb';
import { LIMITS, statedDims, type EditorColour, type EditorMaterial, type EditorPart, type Key, type ProcessPick } from './state';
import { isolateLtr } from './estimate';
import { fill, type EditorLang, type EditorStrings } from './strings';

/** «82×64×41» from a measured model, in whole millimetres. */
export function dimsText(d: { x: number; y: number; z: number }): string {
  return `${Math.round(d.x)}×${Math.round(d.y)}×${Math.round(d.z)}`;
}

/** The size a part is priced on: its measured model, else what was typed. */
export function partSize(p: EditorPart, files: readonly DraftFile[]): { x: number; y: number; z: number } | null {
  const f = p.measuredFileId ? files.find((x) => x.id === p.measuredFileId) : undefined;
  if (f?.analysis?.measured) return f.analysis.dimensions_mm;
  return statedDims(p);
}

export interface PartEstimate {
  kind: 'priced' | 'unpriced' | 'loading';
  text: string;
}

export interface PartFieldsProps {
  part: EditorPart;
  index: number;
  count: number;
  /** The method the part is printed by (its material decides it). */
  process: ProcessPick;
  files: readonly DraftFile[];
  measurable: readonly DraftFile[];
  measuring: ReadonlySet<string>;
  measureLater: ReadonlySet<string>;
  catalogue: readonly CatalogMaterial[];
  refs: RefChoice[];
  refName: (key: string) => string;
  estimate: PartEstimate | null;
  lang: EditorLang;
  t: EditorStrings;
  /** A job of one part: the job cards (quality, quantity) between the material and the size. */
  between?: ReactNode;
  /** A line under the method tiles after a material had to go. */
  processNote?: string;
  onPatch: (p: Partial<EditorPart>) => void;
  onProcess: (p: ProcessPick) => void;
  onMaterial: (matKey: Key, p: Partial<EditorMaterial>) => void;
  onChooseMaterial: (matKey: Key, id: string) => void;
  onColours: (matKey: Key, next: EditorColour[]) => void;
  onAddMaterial: () => void;
  onRemoveMaterial: (matKey: Key) => void;
}

/** The id of a part name field, so the editor can put the focus there after adding a part. */
export const partNameId = (key: Key) => `part-name-${key}`;

/** The questions of one part, as the cards of the step. */
export function PartFields({
  part,
  count,
  process,
  files,
  measurable,
  measuring,
  measureLater,
  catalogue,
  refs,
  refName,
  estimate,
  lang,
  t,
  between,
  processNote,
  onPatch,
  onProcess,
  onMaterial,
  onChooseMaterial,
  onColours,
  onAddMaterial,
  onRemoveMaterial,
}: PartFieldsProps) {
  const [details, setDetails] = useState(false);
  const rs = requestStrings(lang);
  const single = count === 1;
  const measuredFile = part.measuredFileId ? files.find((f) => f.id === part.measuredFileId) : undefined;
  const mode = measuredFile ? 'measured' : 'approx';
  const canMeasure = measurable.length > 0;
  const g = `part-${part.key}`;

  const estimateLine = estimate && estimate.kind !== 'loading' && (
    <p className={`text-[13px] ${estimate.kind === 'unpriced' ? 'font-semibold text-warning' : 'text-text-secondary'}`} data-editor-part-estimate={estimate.kind}>
      {isolateLtr(estimate.text)}
    </p>
  );
  const review = part.reviewState === 'needs_technical_review' && (
    <p className="lv-alert lv-alert-warning text-[13px]" role="note" data-editor-part-review>
      <span className="font-semibold">{rs.reviewChip}</span>
      {part.reviewReasons.length > 0 && <span> — {part.reviewReasons.map((r) => rs.reviewReasons[r] ?? r).join('، ')}</span>}
    </p>
  );

  const cell = (k: 'x' | 'y' | 'z') => (k === 'x' ? t.length : k === 'y' ? t.width : t.height);

  return (
    <div className="space-y-3" data-editor-part-body>
      <SectionCard title={t.process} level={single ? 2 : 3} data-editor-card="process">
        <ChoiceTiles
          label={t.process}
          columns={3}
          value={process}
          onChange={(id) => onProcess(id as ProcessPick)}
          items={[
            { id: 'fdm', title: t.processFdm },
            { id: 'resin', title: t.processResin },
            { id: 'unsure', title: t.unsure },
          ]}
        />
        {processNote && (
          <p className="mt-2 text-[13px] font-semibold text-warning" role="status" data-editor-process-note>
            {processNote}
          </p>
        )}
      </SectionCard>

      <KitCard className="space-y-3" data-editor-card="material">
        {part.materials.map((m, i) => (
          <MaterialRow
            key={m.key}
            material={m}
            index={i}
            count={part.materials.length}
            process={process}
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
        {details && part.materials.length < LIMITS.maxMaterialsPerPart && (
          <div>
            <KitButton size="sm" variant="ghost" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={onAddMaterial} data-editor-add-material>
              {t.addMaterial}
            </KitButton>
            <p className="mt-1 text-ui-xs text-text-muted">{t.addMaterialHint}</p>
          </div>
        )}
      </KitCard>

      {between}

      <SectionCard
        title={t.sizeTitle}
        level={single ? 2 : 3}
        data-editor-card="size"
        trailing={
          <div className="w-40 shrink-0">
          <SegmentedTrack
            group={`${g}-size`}
            size="sm"
            label={t.sizeTitle}
            value={mode}
            onChange={(id) => onPatch({ measuredFileId: id === 'measured' ? (measurable[0]?.id ?? null) : null })}
            items={[
              { id: 'measured', label: t.sizeMeasured, disabled: !canMeasure },
              { id: 'approx', label: t.sizeApproxShort },
            ]}
          />
          </div>
        }
      >
        {measuredFile ? (
          <div className="space-y-2" data-editor-part-size>
            {measurable.length > 1 && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-text-secondary">{t.measuredFrom}</span>
                <select className="lv-input min-h-12" dir="auto" value={part.measuredFileId ?? ''} onChange={(e) => onPatch({ measuredFileId: e.target.value || null })}>
                  {measurable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {middleTruncate(f.file_name, 40)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {measuredFile.analysis?.measured ? (
              <div className="grid grid-cols-3 gap-2">
                {(['x', 'y', 'z'] as const).map((k) => (
                  <div key={k} className="min-w-0">
                    <p className="mb-1 text-[13px] text-text-muted">{cell(k)}</p>
                    <output className="lv-input flex min-h-12 items-center tabular-nums" dir="ltr">
                      {Math.round(measuredFile.analysis!.dimensions_mm[k])}
                    </output>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-text-secondary">
                {measureLater.has(measuredFile.id) ? t.stMeasureLater : measuring.has(measuredFile.id) ? t.stMeasuring : t.stMeasuring}
              </p>
            )}
            {!measuredFile.analysis?.measured && measureLater.has(measuredFile.id) && <p className="text-ui-xs text-text-muted">{t.stMeasureLaterHint}</p>}
          </div>
        ) : (
          <fieldset>
            <legend className="sr-only">{t.sizeApprox}</legend>
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map((k) => (
                <label key={k} className="block min-w-0">
                  <span className="mb-1 block text-[13px] text-text-muted">{cell(k)}</span>
                  <NumberInput min={1} max={5000} decimals={1} value={part.dims[k]} onValueChange={(v) => onPatch({ dims: { ...part.dims, [k]: v } })} aria-label={`${cell(k)} (mm)`} />
                </label>
              ))}
            </div>
            {!canMeasure && <p className="mt-2 text-ui-xs text-text-muted">{t.sizeNotMeasured}</p>}
          </fieldset>
        )}
      </SectionCard>

      <div>
        <KitButton
          size="sm"
          variant="ghost"
          aria-expanded={details}
          iconEnd={details ? <ChevronUp aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
          onClick={() => setDetails((v) => !v)}
          data-editor-part-details
        >
          {details ? t.fewerDetails : t.moreDetails}
        </KitButton>
        {details && (
          <KitCard className="mt-2 space-y-3">
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
            <CountedField label={t.partNotes} optional multiline rows={2} max={LIMITS.partNotesMax} value={part.notes} onValueChange={(v) => onPatch({ notes: v })} />
            <CountedField label={t.assembly} optional multiline rows={2} max={LIMITS.partNotesMax} value={part.assembly} onValueChange={(v) => onPatch({ assembly: v })} />
          </KitCard>
        )}
      </div>

      {estimateLine}
      {review}
    </div>
  );
}

/** A part of a job of several: a card that folds to one line, with its name, its count in a set, and its row actions. */
export function PartCard({
  expanded,
  onToggle,
  onMove,
  onDuplicate,
  onRemove,
  headingRef,
  ...fields
}: PartFieldsProps & {
  expanded: boolean;
  onToggle: () => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  headingRef?: (el: HTMLElement | null) => void;
}) {
  const { part, index, count, files, catalogue, refName, estimate, lang, t, onPatch } = fields;
  const rs = requestStrings(lang);
  const title = part.name.trim() || fill(rs.partN, { n: index + 1 });
  const size = partSize(part, files);
  const summary = [
    part.materials.map((m) => materialWords(m.materialId, lang, t, catalogue)).join(' + '),
    coloursSummary(part.materials.flatMap((m) => m.colours), lang, t, refName),
    size ? fill(t.measured, { dims: dimsText(size) }) : '',
    part.perSet > 1 ? `×${part.perSet}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <KitCard as="article" flush data-editor-part={part.key} aria-labelledby={`part-title-${part.key}`}>
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
          <span id={`part-title-${part.key}`} className="block max-w-full truncate text-[15px] font-bold text-text-primary">
            <bdi>{title}</bdi>
          </span>
          {!expanded && summary && <span className="mt-0.5 block max-w-full truncate text-[13px] text-text-muted">{isolateLtr(summary)}</span>}
          {!expanded && estimate && estimate.kind !== 'loading' && (
            <span className={`mt-0.5 block max-w-full truncate text-[13px] ${estimate.kind === 'unpriced' ? 'text-warning' : 'text-text-secondary'}`}>{isolateLtr(estimate.text)}</span>
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
          trigger={(props) => <KitIconButton {...props} tone="ghost" label={fill(t.partOptions, { name: title })} icon={<Ellipsis className="h-5 w-5" />} data-editor-part-menu />}
        />
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-border-subtle p-3">
          <div className="grid gap-3 min-[480px]:grid-cols-2">
            <CountedField id={partNameId(part.key)} label={t.partName} hint={t.partNameHint} max={LIMITS.partNameMax} value={part.name} placeholder={fill(rs.partN, { n: index + 1 })} onValueChange={(v) => onPatch({ name: v })} />
            <div>
              <p className="mb-2 text-[15px] font-bold text-text-primary">{t.perSet}</p>
              <Stepper min={1} max={LIMITS.partQuantityMax} value={part.perSet} onValueChange={(v) => onPatch({ perSet: Math.max(1, Math.min(LIMITS.partQuantityMax, v ?? 1)) })} aria-label={`${t.perSet}: ${title}`} />
            </div>
          </div>
          <PartFields {...fields} />
        </div>
      )}
    </KitCard>
  );
}
