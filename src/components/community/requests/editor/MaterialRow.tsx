/**
 * ONE MATERIAL OF A PART (community UI plan C4, step 2; IMG_8482; P1-06
 * design §6.2, critiques 12 and 13): «المادة» and «اللون» as two select
 * buttons side by side, each opening its own searchable sheet of native
 * radios (the material) or checkboxes (the colours), then the row «لست
 * متأكدًا من المادة» (material `unsure`: the merchant suggests one).
 *
 * The finish, which area of the part the material is (a part with more than
 * one) and anything special it must do wait behind the part «تفاصيل أكثر».
 * A colour is never told by its swatch alone: the button says its name.
 */
import { useRef, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { CountedField, SelectButton } from '../../kit/fields';
import { KitIconButton } from '../../kit/buttons';
import { localColour, localMaterial } from '../mirrors';
import type { CatalogMaterial } from '../api';
import { MaterialPicker } from './MaterialPicker';
import { ColourPicker, type RefChoice } from './ColourPicker';
import { LIMITS, isNamed, type EditorColour, type EditorMaterial, type ProcessPick } from './state';
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

/** «أسود، أبيض +2»: the first two colours by name, then how many more. */
export function coloursSummary(colours: readonly EditorColour[], lang: EditorLang, t: EditorStrings, refName: (key: string) => string): string {
  const list = colours.length ? colours : [{ mode: 'any' as const, hex: '', label: '', ref: '' }];
  const words = list.map((c) => colourWords(c, lang, t, refName));
  const sep = lang === 'en' ? ', ' : '، ';
  return words.length > 2 ? `${words.slice(0, 2).join(sep)} +${words.length - 2}` : words.join(sep);
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
  const materialButton = useRef<HTMLButtonElement | null>(null);
  const colourButton = useRef<HTMLButtonElement | null>(null);
  const unsure = !material.materialId || material.materialId === 'unsure';
  const known = unsure || catalogue.some((m) => m.id === material.materialId);
  const firstNamed = material.colours.find(isNamed);
  const label = count > 1 ? `${t.material} ${index + 1}` : t.material;
  const close = (back: React.RefObject<HTMLButtonElement | null>) => {
    setPicker('');
    requestAnimationFrame(() => back.current?.focus());
  };
  return (
    <div className="space-y-2" data-editor-material={material.key}>
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <p className="mb-1.5 text-[15px] font-bold text-text-primary" id={`mat-label-${material.key}`}>
            {label}
          </p>
          <SelectButton
            ref={materialButton}
            value={unsure ? '' : materialWords(material.materialId, lang, t, catalogue)}
            placeholder={t.materialChoose}
            expanded={picker === 'material'}
            aria-labelledby={`mat-label-${material.key} mat-value-${material.key}`}
            onClick={() => setPicker('material')}
            data-editor-material-button
          />
          <span id={`mat-value-${material.key}`} className="sr-only">
            {materialWords(material.materialId, lang, t, catalogue)}
          </span>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-[15px] font-bold text-text-primary" id={`col-label-${material.key}`}>
            {t.colour}
          </p>
          <SelectButton
            ref={colourButton}
            value={coloursSummary(material.colours, lang, t, refName)}
            swatch={firstNamed?.hex || undefined}
            expanded={picker === 'colours'}
            aria-labelledby={`col-label-${material.key}`}
            aria-describedby={`col-value-${material.key}`}
            onClick={() => setPicker('colours')}
            data-editor-colour-button
          />
          <span id={`col-value-${material.key}`} className="sr-only">
            {coloursSummary(material.colours, lang, t, refName)}
          </span>
        </div>
      </div>
      {!known && <p className="text-[12px] font-semibold text-warning">{t.materialOutOfCatalogue}</p>}

      <button
        type="button"
        role="checkbox"
        aria-checked={unsure}
        onClick={() => (unsure ? setPicker('material') : onChooseMaterial('unsure'))}
        className="cm-raised cm-sel relative flex min-h-12 w-full items-center gap-3 rounded-md px-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-editor-unsure-material={unsure ? 'on' : 'off'}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t.unsureMaterial}</span>
          {unsure && <span className="cm-sub block text-[12px]">{t.unsureMaterialHint}</span>}
        </span>
        {unsure && <Check aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={3} />}
      </button>

      {details && (
        <div className="space-y-3 pt-1">
          <label className="block">
            <span className="mb-1.5 block text-[15px] font-bold text-text-primary">{t.finish}</span>
            <select
              className="lv-input min-h-12"
              value={material.finish === 'standard' ? '' : material.finish}
              onChange={(e) => onPatch({ finish: e.target.value })}
              data-editor-finish
            >
              <option value="">{t.finishStandard}</option>
              <option value="sanded">{t.finishSanded}</option>
              <option value="primed">{t.finishPrimed}</option>
              <option value="painted">{t.finishPainted}</option>
              <option value="polished">{t.finishPolished}</option>
            </select>
          </label>
          {count > 1 && <CountedField label={t.region} max={LIMITS.regionReferenceMax} value={material.region} onValueChange={(v) => onPatch({ region: v })} />}
          <CountedField
            label={t.requirements}
            optional
            max={LIMITS.requirementsMax}
            value={material.requirements}
            placeholder={t.requirementsPlaceholder}
            onValueChange={(v) => onPatch({ requirements: v })}
          />
        </div>
      )}
      {count > 1 && (
        <div className="flex justify-end">
          <KitIconButton shape="square" tone="danger" label={`${t.removeMaterial}: ${label}`} icon={<Trash2 className="h-5 w-5" />} onClick={onRemove} />
        </div>
      )}

      {picker === 'material' && (
        <MaterialPicker
          open
          onClose={() => close(materialButton)}
          value={material.materialId}
          initialProcess={process}
          catalogue={catalogue}
          onChoose={onChooseMaterial}
          lang={lang}
          t={t}
        />
      )}
      {picker === 'colours' && <ColourPicker open onClose={() => close(colourButton)} colours={material.colours} onChange={onColours} refs={refs} lang={lang} t={t} />}
    </div>
  );
}
