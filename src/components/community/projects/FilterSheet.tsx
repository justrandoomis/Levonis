/**
 * «تصفية» — the projects list's filter sheet (community UI plan C2.1). A lazy
 * chunk, fetched the first time the button is pressed. It narrows the list
 * by the closed lists the server knows (packages/contracts/src/
 * communityFilters.ts): the order, a material family, a printer brand, and
 * only projects with a file to download.
 *
 * The choices are a draft until «عرض النتائج» writes them into the address;
 * «مسح الفلاتر» empties the draft. Escape, the backdrop and the grabber close
 * it without applying, and the Sheet hands focus back to «تصفية».
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../../ui/Sheet';
import FilterChip from '../FilterChip';
import { KitButton, GoldButton } from '../kit/buttons';
import { SegmentedTrack, Toggle } from '../kit/controls';
import { POST_MATERIAL_IDS, POST_PRINTER_IDS, type PostPrinterBrand, type PostSort } from '../../../../packages/contracts/src/communityFilters';
import { NO_PROJECT_FILTERS, type ProjectFilterValue } from './filters';
import { useProjectStrings } from './strings';

/** A printer brand as people write it. */
const BRAND: Record<PostPrinterBrand, string> = {
  bambu: 'Bambu Lab',
  prusa: 'Prusa',
  creality: 'Creality',
  elegoo: 'Elegoo',
  anycubic: 'Anycubic',
  flashforge: 'Flashforge',
  qidi: 'Qidi',
  sovol: 'Sovol',
  voron: 'Voron',
  snapmaker: 'Snapmaker',
};

export default function FilterSheet({
  open,
  value,
  onApply,
  onClose,
}: {
  open: boolean;
  value: ProjectFilterValue;
  onApply: (next: ProjectFilterValue) => void;
  onClose: () => void;
}) {
  const s = useProjectStrings();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);
  const set = <K extends keyof ProjectFilterValue>(k: K, v: ProjectFilterValue[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const chips = <T extends string>(ids: readonly T[], current: T | '', pick: (v: T | '') => void, name: (v: T) => string, label: string) => (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      <FilterChip shape="rect" on={current === ''} check={false} aria-pressed={current === ''} onClick={() => pick('')}>
        {s.anyOption}
      </FilterChip>
      {ids.map((id) => (
        <FilterChip key={id} shape="rect" on={current === id} check={false} aria-pressed={current === id} onClick={() => pick(current === id ? '' : id)}>
          <bdi>{name(id)}</bdi>
        </FilterChip>
      ))}
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={s.filter}
      detents={['large']}
      dragHandle
      testId="projects-filter-sheet"
      header={<h2 className="px-4 pb-2 pt-1 text-[17px] font-bold text-text-primary">{s.filter}</h2>}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <KitButton variant="secondary" block onClick={() => setDraft(NO_PROJECT_FILTERS)} data-projects-filter-clear>
            {s.clearFilters}
          </KitButton>
          <GoldButton
            block
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            data-projects-filter-apply
          >
            {s.showResults}
          </GoldButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5 px-4 pb-4">
        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-bold text-text-secondary">{s.sort}</h3>
          <SegmentedTrack
            group="projects-sort"
            label={s.sort}
            value={draft.sort || 'newest'}
            onChange={(id) => set('sort', id === 'newest' ? '' : (id as PostSort))}
            items={[
              { id: 'newest', label: s.sorts.newest },
              { id: 'popular', label: s.sorts.popular },
            ]}
          />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-bold text-text-secondary">{s.material}</h3>
          {chips(POST_MATERIAL_IDS, draft.material, (v) => set('material', v), (id) => s.materialNames[id] ?? id.toUpperCase(), s.material)}
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-bold text-text-secondary">{s.printer}</h3>
          {chips(POST_PRINTER_IDS, draft.printer, (v) => set('printer', v), (id) => BRAND[id], s.printer)}
        </section>
        <Toggle checked={draft.has_files === '1'} onChange={(on) => set('has_files', on ? '1' : '')} label={s.withFiles} />
      </div>
    </Sheet>
  );
}
