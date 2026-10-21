/**
 * «اختر المادة» (plan P1-06; design §6.3, critique 12).
 *
 * A sheet that opens tall (a search field and the keyboard leave no room in
 * a half sheet), docked on a phone held sideways too (`useSheetPlacement`). The search
 * field filters as the customer types, in Arabic, Sorani or English
 * (search.ts); the process chips narrow it to FDM or resin. The choices are
 * NATIVE RADIOS: the arrow keys move between them and a screen reader reads
 * «2 of 18, selected», with no listbox wiring to get wrong. «لست متأكدًا —
 * يقترح التاجر» is always the first. A material that left the catalogue is
 * still shown on a part that has it, with a warning; the publish refuses it
 * (PART_MATERIAL_UNKNOWN).
 */
import { useId, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Sheet } from '../../../ui/Sheet';
import { useSheetPlacement } from './useKeyboardOpen';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Segmented } from '../../../ui/Segmented';
import { localMaterial } from '../mirrors';
import type { CatalogMaterial } from '../api';
import { matchesSearch } from './search';
import type { EditorLang, EditorStrings } from './strings';

/** Every name a material is known by: its id, the catalogue’s names and the seed’s in three languages. */
export function materialNames(m: Pick<CatalogMaterial, 'id' | 'name_en' | 'name_ar' | 'process'>): string[] {
  const words = m.process === 'resin' ? ['resin', 'ريزن', 'ڕێزن'] : ['fdm', 'filament', 'خيوط', 'دەزوو'];
  return [m.id, m.name_en, m.name_ar, localMaterial(m.id, 'ar'), localMaterial(m.id, 'en'), localMaterial(m.id, 'ckb'), ...words];
}

/** The catalogue a picker lists for a query and a process filter. */
export function filterMaterials<T extends Pick<CatalogMaterial, 'id' | 'name_en' | 'name_ar' | 'process'>>(list: readonly T[], query: string, process: 'all' | 'fdm' | 'resin'): T[] {
  return list.filter((m) => (process === 'all' || m.process === process) && matchesSearch(query, materialNames(m)));
}

export function MaterialPicker({
  open,
  onClose,
  value,
  initialProcess,
  catalogue,
  onChoose,
  lang,
  t,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  initialProcess: 'fdm' | 'resin' | 'unsure';
  catalogue: readonly CatalogMaterial[];
  onChoose: (materialId: string) => void;
  lang: EditorLang;
  t: EditorStrings;
}) {
  const sheetPlacement = useSheetPlacement();
  const [query, setQuery] = useState('');
  const [process, setProcess] = useState<'all' | 'fdm' | 'resin'>(initialProcess === 'unsure' ? 'all' : initialProcess);
  const name = useId();
  const shown = useMemo(() => filterMaterials(catalogue, query, process), [catalogue, query, process]);
  const known = !value || value === 'unsure' || catalogue.some((m) => m.id === value);
  const unsureShown = matchesSearch(query, [t.unsureOption, 'unsure']);

  const option = (id: string, label: string, extra: React.ReactNode) => {
    const checked = value === id || (id === 'unsure' && (!value || value === 'unsure'));
    return (
    <label
      key={id}
      className="lv-choice flex min-h-12 w-full cursor-pointer items-center gap-3 px-3 py-2 text-start"
      data-material-option={id}
      data-selected={checked ? 'true' : undefined}
    >
      <input
        type="radio"
        name={name}
        value={id}
        checked={checked}
        onChange={() => onChoose(id)}
        className="h-[18px] w-[18px] shrink-0 accent-gold"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-text-primary">{label}</span>
        {extra}
      </span>
    </label>
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={t.materialPickerTitle}
      {...sheetPlacement}
      detents={['large']}
      testId="material-picker"
      header={<h2 className="px-4 pb-2 pt-1 text-[15px] font-bold text-text-primary">{t.materialPickerTitle}</h2>}
      footer={
        <div className="px-4 pb-3 pt-2">
          <Button variant="primary" block onClick={onClose}>
            {t.done}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        <Input
          type="search"
          enterKeyHint="search"
          dir="auto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.materialSearch}
          aria-label={t.materialSearch}
          autoComplete="off"
          data-material-search
        />
        <Segmented
          group="material-picker-process"
          size="sm"
          label={t.process}
          value={process}
          onChange={(id) => setProcess(id as 'all' | 'fdm' | 'resin')}
          items={[
            { id: 'all', label: t.filterAll },
            { id: 'fdm', label: t.processFdm },
            { id: 'resin', label: t.processResin },
          ]}
        />
        <fieldset className="space-y-2">
          <legend className="sr-only">{t.materialPickerTitle}</legend>
          {!known &&
            option(
              value,
              localMaterial(value, lang, catalogue),
              <span className="mt-0.5 flex items-center gap-1 text-[12px] font-semibold text-warning">
                <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                {t.materialOutOfCatalogue}
              </span>
            )}
          {unsureShown && option('unsure', t.unsureOption, null)}
          {shown.map((m) =>
            option(
              m.id,
              localMaterial(m.id, lang, catalogue),
              <span className="mt-0.5 block text-[12px] text-text-muted">
                {[m.process === 'resin' ? t.processResin : t.processFdm, m.needs_enclosure ? t.traitEnclosure : '', m.abrasive ? t.traitAbrasive : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )
          )}
        </fieldset>
        {!shown.length && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary" role="status">
            <span>{t.materialNoMatch}</span>
            <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
              {t.clearSearch}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
