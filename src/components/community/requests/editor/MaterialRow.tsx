/**
 * ONE MATERIAL OF A PART (plan P1-06; design §6.2, critique 13): the material,
 * its colours, its finish — and, behind «تفاصيل أكثر», which area of the part
 * it is (when the part has more than one) and anything special it must do.
 * The material and the colours are chosen in their own searchable sheets.
 */
import { useState } from 'react';
import { ChevronDown, Palette } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Field, Input, Select } from '../../../ui/Field';
import { localColour, localMaterial } from '../mirrors';
import type { CatalogMaterial } from '../api';
import { MaterialPicker } from './MaterialPicker';
import { ColourPicker, type RefChoice } from './ColourPicker';
import { LIMITS, type EditorColour, type EditorMaterial, type ProcessPick } from './state';
import { fill, type EditorLang, type EditorStrings } from './strings';

/** A colour as words: «أي لون مناسب», «كما في: side.png», «أسود», a written one as written. */
export function colourWords(c: EditorColour, lang: EditorLang, t: EditorStrings, refName: (key: string) => string): string {
  if (c.mode === 'any') return t.colourAny;
  if (c.mode === 'as_reference') return c.ref ? fill(t.asRefNamed, { name: refName(c.ref) }) : t.colourAsRef;
  return localColour(c.label || c.hex, lang);
}

/** A material as words: the catalogue name in the reader’s language, or «لست متأكدًا». */
export function materialWords(id: string, lang: EditorLang, t: EditorStrings, catalogue: readonly CatalogMaterial[]): string {
  return !id || id === 'unsure' ? t.unsure : localMaterial(id, lang, catalogue);
}

export function MaterialRow({
  material,
  index,
  count,
  process,
  catalogue,
  refs,
  refName,
  details,
  lang,
  t,
  onChooseMaterial,
  onColours,
  onPatch,
  onRemove,
}: {
  material: EditorMaterial;
  index: number;
  count: number;
  process: ProcessPick;
  catalogue: readonly CatalogMaterial[];
  refs: RefChoice[];
  refName: (key: string) => string;
  details: boolean;
  lang: EditorLang;
  t: EditorStrings;
  onChooseMaterial: (id: string) => void;
  onColours: (next: EditorColour[]) => void;
  onPatch: (p: Partial<EditorMaterial>) => void;
  onRemove: () => void;
}) {
  const [picker, setPicker] = useState<'' | 'material' | 'colours'>('');
  const known = !material.materialId || material.materialId === 'unsure' || catalogue.some((m) => m.id === material.materialId);
  const proc = catalogue.find((m) => m.id === material.materialId)?.process;
  const colourList = material.colours.length ? material.colours : [{ mode: 'any' as const, hex: '', label: '', ref: '' }];
  return (
    <div className="space-y-3 rounded-md border border-border-subtle p-3" data-editor-material={material.key}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-[13px] font-semibold text-text-secondary" id={`mat-label-${material.key}`}>
            {count > 1 ? `${t.material} ${index + 1}` : t.material}
          </p>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-labelledby={`mat-label-${material.key} mat-value-${material.key}`}
            onClick={() => setPicker('material')}
            className="lv-choice flex w-full items-center gap-2 px-3 text-start text-[14px] font-semibold"
            data-editor-material-button
          >
            <span id={`mat-value-${material.key}`} className="min-w-0 flex-1 truncate text-text-primary">
              {materialWords(material.materialId, lang, t, catalogue)}
              {proc && <span className="ms-2 text-[12px] font-normal text-text-muted">{proc === 'resin' ? t.processResin : t.processFdm}</span>}
            </span>
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          </button>
          {!known && <p className="mt-1 text-[12px] font-semibold text-warning">{t.materialOutOfCatalogue}</p>}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-text-secondary">{t.colours}</p>
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t.colours} data-editor-colours>
          {colourList.map((c, i) => (
            <li key={`${c.mode}-${c.hex}-${c.label}-${c.ref}-${i}`} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-surface-raised px-2.5 text-[12.5px] text-text-primary">
              {(c.mode === 'catalogue' || c.mode === 'custom') && c.hex && (
                <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border border-border-subtle" style={{ backgroundColor: c.hex }} />
              )}
              <bdi>{colourWords(c, lang, t, refName)}</bdi>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="secondary" icon={<Palette aria-hidden="true" className="h-4 w-4" />} onClick={() => setPicker('colours')} aria-haspopup="dialog">
          {colourList.some((c) => c.mode !== 'any') ? t.editColours : t.addColour}
        </Button>
      </div>

      <Field label={t.finish}>
        <Select value={material.finish === 'standard' ? '' : material.finish} onChange={(e) => onPatch({ finish: e.target.value })}>
          <option value="">{t.finishStandard}</option>
          <option value="sanded">{t.finishSanded}</option>
          <option value="primed">{t.finishPrimed}</option>
          <option value="painted">{t.finishPainted}</option>
          <option value="polished">{t.finishPolished}</option>
        </Select>
      </Field>

      {details && count > 1 && (
        <Field label={t.region}>
          <Input dir="auto" maxLength={LIMITS.regionReferenceMax} value={material.region} onChange={(e) => onPatch({ region: e.target.value })} />
        </Field>
      )}
      {details && (
        <Field label={t.requirements}>
          <Input
            dir="auto"
            maxLength={LIMITS.requirementsMax}
            value={material.requirements}
            placeholder={t.requirementsPlaceholder}
            onChange={(e) => onPatch({ requirements: e.target.value })}
          />
        </Field>
      )}
      {count > 1 && (
        <Button size="sm" variant="ghost" className="text-danger" onClick={onRemove}>
          {t.removeMaterial}
        </Button>
      )}

      {picker === 'material' && (
        <MaterialPicker
          open={picker === 'material'}
          onClose={() => setPicker('')}
          value={material.materialId}
          initialProcess={process}
          catalogue={catalogue}
          onChoose={onChooseMaterial}
          lang={lang}
          t={t}
        />
      )}
      {picker === 'colours' && (
        <ColourPicker open onClose={() => setPicker('')} colours={material.colours} onChange={onColours} refs={refs} lang={lang} t={t} />
      )}
    </div>
  );
}
