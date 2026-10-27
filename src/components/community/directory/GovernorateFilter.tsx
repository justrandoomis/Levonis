/**
 * «المحافظة ⌄» (community UI plan C5; IMG_8469): the chip that opens the
 * governorate sheet, and the sheet itself.
 *
 * THE SHEET IS A REAL RADIO GROUP (DECISIONS row 270 (8): the FilterSelect
 * radio state returns with the first page that uses it). Nineteen options,
 * «كل المحافظات» and the eighteen governorates, each a `radio` with
 * `aria-checked`, one Tab stop (the checked one). The arrows move the check
 * up and down the list (and with the writing direction), Home and End jump,
 * Enter or Space or a tap applies it and closes the sheet, and Escape (or the
 * scrim) closes it without applying, focus back on the chip. Until it is
 * applied the check is only the choice in the sheet, so a keyboard walk down
 * the list does not reload the directory at every step. The checked row wears
 * the sand selection with ink text and a check glyph (D-3, owner override:
 * never the colour alone).
 *
 * At rest the chip says «المحافظة»; with a governorate chosen it says the
 * name in the sand selection, and a × beside it clears it.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, MapPin, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATES } from '../../../lib/governorates';
import { Sheet } from '../../ui/Sheet';
import FilterChip from '../FilterChip';
import { KitIconButton } from '../kit/buttons';
import { useKitStrings } from '../kit/strings';
import { useDirectoryStrings } from './strings';

export default function GovernorateFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { lang, dir } = useLanguage();
  const d = useDirectoryStrings();
  const k = useKitStrings();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(value);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedRef = useRef<HTMLButtonElement | null>(null);
  const key = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const options = [{ id: '', label: d.allGovernorates }, ...GOVERNORATES.map((g) => ({ id: g.id, label: g[key] }))];
  const chosen = value ? options.find((o) => o.id === value) ?? null : null;

  const show = () => {
    setPending(value);
    setOpen(true);
  };
  const apply = (id: string) => {
    setOpen(false);
    if (id !== value) onChange(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(0, options.findIndex((o) => o.id === pending));
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === forward) next = (at + 1) % options.length;
    else if (e.key === 'ArrowUp' || e.key === back) next = (at - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      apply(pending);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    setPending(options[next].id);
    refs.current[next]?.focus();
  };

  return (
    <span className="inline-flex shrink-0 items-center" data-filter-select={value}>
      <FilterChip
        on={!!chosen}
        check={false}
        shape="rect"
        icon={<MapPin aria-hidden="true" className="h-[18px] w-[18px]" />}
        trailing={<ChevronDown aria-hidden="true" className="h-4 w-4" />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chosen ? `${d.governorate}: ${chosen.label}` : d.governorate}
        data-governorate-chip
        onClick={show}
      >
        {chosen ? chosen.label : d.governorate}
      </FilterChip>
      {chosen && <KitIconButton label={`${k.removeFilter}: ${d.governorate}`} icon={<X className="h-4 w-4" />} tone="ghost" onClick={() => onChange('')} />}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        label={d.governorate}
        detents={['medium', 'large']}
        dragHandle
        initialFocus={checkedRef}
        testId="governorate-sheet"
        header={<h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary">{d.governorate}</h2>}
      >
        <div role="radiogroup" aria-label={d.governorate} onKeyDown={onKeyDown} className="flex flex-col gap-1 px-3 pb-4" data-governorate-options>
          {options.map((o, i) => {
            const on = o.id === pending;
            return (
              <button
                key={o.id || 'all'}
                ref={(el) => {
                  refs.current[i] = el;
                  if (on) checkedRef.current = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-governorate={o.id || 'all'}
                onClick={() => apply(o.id)}
                className={`cm-sel flex min-h-12 w-full items-center gap-3 rounded-md border px-3 text-start text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${on ? '' : 'border-transparent text-text-primary hover:bg-surface-selected'}`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {on && <Check aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={2.6} />}
              </button>
            );
          })}
        </div>
      </Sheet>
    </span>
  );
}
