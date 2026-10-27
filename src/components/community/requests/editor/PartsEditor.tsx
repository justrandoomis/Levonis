/**
 * STEP 2, «إعدادات الطباعة» — THE JOB AND ITS PARTS (community UI plan C4,
 * §4; IMG_8482; P1-06 design §6.1, critiques 8 and 13).
 *
 * One part is the default and every version-1 request: the step reads as the
 * reference draws it, card after card: «طريقة الطباعة», the material and the
 * colour, «الجودة» with the layer height of the catalogue, the quantity, the
 * size, and «ملاحظات للتجار (اختياري)» with its phone warning. «أضف قطعة
 * أخرى» makes it a list of part cards (twelve at most, four materials a part;
 * the publish refusals of a part are on its card through its estimate line).
 * The quantity then reads «عدد الأطقم» and each part says how many of it go
 * in a set. The line above the list counts in the cards' own word,
 * «قطعتان · 3 نسخ في الطقم», never «الأجزاء» beside «القطعة».
 *
 * Moving, copying, adding and removing a part say what happened to a screen
 * reader (politely) and put the focus where the eye goes next: a new part
 * name, the copy title, the moved part title, or, after a removal, the part
 * that took its place.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { SegmentedTrack, Stepper } from '../../kit/controls';
import { CountedField } from '../../kit/fields';
import { KitButton } from '../../kit/buttons';
import { SectionCard } from '../../kit/display';
import type { Catalog, CatalogMaterial, DraftFile, Quality } from '../api';
import { requestStrings } from '../strings';
import { PartCard, PartFields, partNameId, type PartEstimate } from './PartCard';
import type { RefChoice } from './ColourPicker';
import { LIMITS, partProcess, type EditorColour, type EditorMaterial, type EditorPart, type Key, type ProcessPick } from './state';
import { fill, partsCountWords, piecesPerSetWords, type EditorLang, type EditorStrings } from './strings';

/** «0.20 mm»: the layer height the catalogue gives a quality, or '' when it has none. */
export function layerText(quality: Quality, qualities: Catalog['qualities'] | undefined): string {
  const q = qualities?.find((x) => x.id === quality);
  return q && q.layer_mm > 0 ? `${q.layer_mm.toFixed(2)} mm` : '';
}

export function PartsEditor({
  parts,
  sets,
  quality,
  qualities,
  notes,
  files,
  measurable,
  measuring,
  measureLater,
  catalogue,
  refs,
  refName,
  estimates,
  processNotes,
  lang,
  t,
  onSets,
  onQuality,
  onNotes,
  onPart,
  onProcess,
  onMaterial,
  onChooseMaterial,
  onColours,
  onAddMaterial,
  onRemoveMaterial,
  onAddPart,
  onDuplicate,
  onMove,
  onRemove,
}: {
  parts: EditorPart[];
  sets: number;
  quality: Quality;
  qualities?: Catalog['qualities'];
  /** The notes for the merchants (`customer_notes`). */
  notes: string;
  files: readonly DraftFile[];
  measurable: readonly DraftFile[];
  measuring: ReadonlySet<string>;
  measureLater: ReadonlySet<string>;
  catalogue: readonly CatalogMaterial[];
  refs: RefChoice[];
  refName: (key: string) => string;
  estimates: ReadonlyMap<number, PartEstimate>;
  /** The parts whose material had to go when their method changed. */
  processNotes: ReadonlySet<Key>;
  lang: EditorLang;
  t: EditorStrings;
  onSets: (n: number) => void;
  onQuality: (q: Quality) => void;
  onNotes: (v: string) => void;
  onPart: (key: Key, p: Partial<EditorPart>) => void;
  onProcess: (key: Key, p: ProcessPick) => void;
  onMaterial: (key: Key, matKey: Key, p: Partial<EditorMaterial>) => void;
  onChooseMaterial: (key: Key, matKey: Key, id: string) => void;
  onColours: (key: Key, matKey: Key, next: EditorColour[]) => void;
  onAddMaterial: (key: Key) => void;
  onRemoveMaterial: (key: Key, matKey: Key) => void;
  onAddPart: () => Key;
  onDuplicate: (key: Key) => Key;
  onMove: (key: Key, by: -1 | 1) => void;
  onRemove: (key: Key) => Promise<boolean>;
}) {
  const rs = requestStrings(lang);
  const [open, setOpen] = useState<Key>(() => parts[0]?.key ?? '');
  const [said, setSaid] = useState('');
  const headings = useRef(new Map<Key, HTMLElement | null>());
  const focusNext = useRef<{ key: Key; on: 'name' | 'heading' } | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const several = parts.length > 1;
  const pieces = parts.reduce((n, p) => n + Math.max(1, p.perSet), 0);
  const titleOf = (p: EditorPart, i: number) => p.name.trim() || fill(rs.partN, { n: i + 1 });
  const processOf = (id: string): 'fdm' | 'resin' | '' => catalogue.find((m) => m.id === id)?.process ?? '';
  const allResin = parts.every((p) => partProcess(p, processOf) === 'resin');
  const layer = allResin ? '' : layerText(quality, qualities);

  // After the list re-renders, focus lands where the last action said.
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want.on === 'name' ? document.getElementById(partNameId(want.key)) : headings.current.get(want.key);
    (el ?? addButton.current)?.focus();
  });

  const announce = (text: string) => {
    // A changed string is announced again even when it repeats.
    setSaid('');
    requestAnimationFrame(() => setSaid(text));
  };

  const qualityCard = (
    <SectionCard title={t.quality} data-editor-card="quality">
      <SegmentedTrack
        group="editor-quality"
        label={t.quality}
        value={quality}
        onChange={(id) => onQuality(id as Quality)}
        items={[
          { id: 'draft', label: t.qDraft },
          { id: 'standard', label: t.qStandard },
          { id: 'fine', label: t.qFine },
          { id: 'ultra', label: t.qUltra },
        ]}
      />
      {layer && (
        <p className="lv-input mt-2 flex min-h-11 items-center justify-between gap-3 text-[13px]" data-editor-layer>
          <span className="text-text-muted">{t.layerHeight}</span>
          <bdi dir="ltr" className="text-[15px] text-text-primary">
            {layer}
          </bdi>
        </p>
      )}
    </SectionCard>
  );
  const quantityCard = (
    <SectionCard title={several ? t.sets : t.quantity} data-editor-card="quantity">
      <Stepper min={1} max={10000} value={sets} onValueChange={(v) => onSets(Math.max(1, Math.min(10000, v ?? 1)))} aria-label={several ? t.sets : t.quantity} />
    </SectionCard>
  );

  const fieldsOf = (p: EditorPart, i: number) => ({
    part: p,
    index: i,
    count: parts.length,
    process: partProcess(p, processOf),
    files,
    measurable,
    measuring,
    measureLater,
    catalogue,
    refs,
    refName,
    estimate: estimates.get(i) ?? null,
    lang,
    t,
    processNote: processNotes.has(p.key) ? t.processChanged : undefined,
    onPatch: (patch: Partial<EditorPart>) => onPart(p.key, patch),
    onProcess: (proc: ProcessPick) => onProcess(p.key, proc),
    onMaterial: (mk: Key, patch: Partial<EditorMaterial>) => onMaterial(p.key, mk, patch),
    onChooseMaterial: (mk: Key, id: string) => onChooseMaterial(p.key, mk, id),
    onColours: (mk: Key, next: EditorColour[]) => onColours(p.key, mk, next),
    onAddMaterial: () => onAddMaterial(p.key),
    onRemoveMaterial: (mk: Key) => onRemoveMaterial(p.key, mk),
  });

  return (
    <div className="space-y-3" data-editor-section="parts">
      {several ? (
        <>
          <p className="text-[15px] font-semibold text-text-secondary" data-editor-parts-count>
            {[partsCountWords(parts.length, lang), pieces > parts.length ? piecesPerSetWords(pieces, lang) : ''].filter(Boolean).join(' · ')}
          </p>
          {qualityCard}
          {quantityCard}
          <div className="space-y-3" data-editor-parts={parts.length}>
            {parts.map((p, i) => (
              <PartCard
                key={p.key}
                {...fieldsOf(p, i)}
                expanded={open === p.key}
                onToggle={() => setOpen((k) => (k === p.key ? '' : p.key))}
                onMove={(by) => {
                  onMove(p.key, by);
                  focusNext.current = { key: p.key, on: 'heading' };
                  announce(fill(t.partMoved, { name: titleOf(p, i), n: i + 1 + by }));
                }}
                onDuplicate={() => {
                  const k = onDuplicate(p.key);
                  if (!k) return;
                  setOpen(k);
                  focusNext.current = { key: k, on: 'heading' };
                  announce(fill(t.partDuplicated, { name: titleOf(p, i) }));
                }}
                onRemove={async () => {
                  const title = titleOf(p, i);
                  if (!(await onRemove(p.key))) return;
                  const after = parts[i + 1] ?? parts[i - 1];
                  focusNext.current = after && after.key !== p.key ? { key: after.key, on: 'heading' } : null;
                  announce(fill(t.partRemoved, { name: title }));
                }}
                headingRef={(el) => headings.current.set(p.key, el)}
              />
            ))}
          </div>
        </>
      ) : (
        parts[0] && (
          <div data-editor-part={parts[0].key} data-editor-parts={1}>
            <PartFields
              {...fieldsOf(parts[0], 0)}
              between={
                <>
                  {qualityCard}
                  {quantityCard}
                </>
              }
            />
          </div>
        )
      )}

      <SectionCard title={t.notesForMerchants} optional data-editor-card="notes">
        <CountedField label={<span className="sr-only">{t.notesForMerchants}</span>} multiline rows={3} max={1000} value={notes} placeholder={t.notesPlaceholder} hint={t.notesHint} onValueChange={onNotes} id="editor-notes" />
      </SectionCard>

      <div>
        <KitButton
          ref={addButton}
          variant="secondary"
          block
          icon={<Plus aria-hidden="true" className="h-4 w-4" />}
          disabled={parts.length >= LIMITS.maxParts}
          onClick={() => {
            const k = onAddPart();
            if (!k) return;
            setOpen(k);
            focusNext.current = { key: k, on: 'name' };
            announce(fill(t.partAdded, { name: fill(rs.partN, { n: parts.length + 1 }) }));
          }}
          data-editor-add-part
        >
          {t.addPart}
        </KitButton>
        <p className="mt-1.5 text-ui-xs text-text-muted">{parts.length >= LIMITS.maxParts ? fill(t.partsMax, { n: LIMITS.maxParts }) : t.addPartHint}</p>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
