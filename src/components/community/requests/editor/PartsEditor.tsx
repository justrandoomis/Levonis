/**
 * «ماذا نطبع» — THE JOB AND ITS PARTS (plan P1-06; design §6.1, critiques 8
 * and 13).
 *
 * One part is the default and every version-1 request: the quantity and the
 * detail, then the part itself. «أضف قطعة أخرى» makes it a list (twelve at
 * most); the quantity then reads «عدد الأطقم» and each part says how many of
 * it go in a set. The line above the list counts in the cards' own word —
 * «قطعتان · 3 نسخ في الطقم» — never «الأجزاء» beside «القطعة».
 *
 * Moving, copying, adding and removing a part say what happened to a screen
 * reader (politely) and put the focus where the eye goes next: a new part’s
 * name, the copy’s title, the moved part’s title, or — after a removal — the
 * part that took its place.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { NumberInput } from '../../../ui/NumberInput';
import { Segmented } from '../../../ui/Segmented';
import type { CatalogMaterial, DraftFile, Quality } from '../api';
import { requestStrings } from '../strings';
import { PartCard, type PartEstimate } from './PartCard';
import type { RefChoice } from './ColourPicker';
import { LIMITS, type EditorColour, type EditorMaterial, type EditorPart, type Key } from './state';
import { fill, partsCountWords, piecesPerSetWords, type EditorLang, type EditorStrings } from './strings';

export function PartsEditor({
  parts,
  sets,
  quality,
  files,
  measurable,
  measuring,
  measureLater,
  catalogue,
  refs,
  refName,
  estimates,
  lang,
  t,
  onSets,
  onQuality,
  onPart,
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
  files: readonly DraftFile[];
  measurable: readonly DraftFile[];
  measuring: ReadonlySet<string>;
  measureLater: ReadonlySet<string>;
  catalogue: readonly CatalogMaterial[];
  refs: RefChoice[];
  refName: (key: string) => string;
  estimates: ReadonlyMap<number, PartEstimate>;
  lang: EditorLang;
  t: EditorStrings;
  onSets: (n: number) => void;
  onQuality: (q: Quality) => void;
  onPart: (key: Key, p: Partial<EditorPart>) => void;
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
  const names = useRef(new Map<Key, HTMLInputElement | null>());
  const focusNext = useRef<{ key: Key; on: 'name' | 'heading' } | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const several = parts.length > 1;
  const pieces = parts.reduce((n, p) => n + Math.max(1, p.perSet), 0);
  const titleOf = (p: EditorPart, i: number) => p.name.trim() || fill(rs.partN, { n: i + 1 });

  // After the list re-renders, focus lands where the last action said.
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want.on === 'name' ? names.current.get(want.key) : headings.current.get(want.key);
    (el ?? addButton.current)?.focus();
  });

  const announce = (text: string) => {
    // A changed string is announced again even when it repeats.
    setSaid('');
    requestAnimationFrame(() => setSaid(text));
  };

  return (
    <div className="space-y-4">
      {several && (
        <p className="text-[13px] font-semibold text-text-secondary" data-editor-parts-count>
          {[partsCountWords(parts.length, lang), pieces > parts.length ? piecesPerSetWords(pieces, lang) : ''].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="grid gap-4 min-[480px]:grid-cols-2">
        <Field label={several ? t.sets : t.quantity}>
          <NumberInput kind="quantity" min={1} max={10000} value={sets} onValueChange={(v) => onSets(Math.max(1, Math.min(10000, v ?? 1)))} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-text-secondary">{t.quality}</p>
          <Segmented
            group="editor-quality"
            size="sm"
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
        </div>
      </div>

      <div className="space-y-3" data-editor-parts={parts.length}>
        {parts.map((p, i) => (
          <PartCard
            key={p.key}
            part={p}
            index={i}
            count={parts.length}
            files={files}
            measurable={measurable}
            measuring={measuring}
            measureLater={measureLater}
            catalogue={catalogue}
            refs={refs}
            refName={refName}
            estimate={estimates.get(i) ?? null}
            expanded={!several || open === p.key}
            lang={lang}
            t={t}
            onToggle={() => setOpen((k) => (k === p.key ? '' : p.key))}
            onPatch={(patch) => onPart(p.key, patch)}
            onMaterial={(mk, patch) => onMaterial(p.key, mk, patch)}
            onChooseMaterial={(mk, id) => onChooseMaterial(p.key, mk, id)}
            onColours={(mk, next) => onColours(p.key, mk, next)}
            onAddMaterial={() => onAddMaterial(p.key)}
            onRemoveMaterial={(mk) => onRemoveMaterial(p.key, mk)}
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
            nameRef={(el) => names.current.set(p.key, el)}
          />
        ))}
      </div>

      <div>
        <Button
          ref={addButton}
          variant="secondary"
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
        </Button>
        <p className="mt-1.5 text-[12px] text-text-muted">
          {parts.length >= LIMITS.maxParts ? fill(t.partsMax, { n: LIMITS.maxParts }) : t.addPartHint}
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
