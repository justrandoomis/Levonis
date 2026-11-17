/**
 * THE COMMUNITY CONTROLS (community UI plan B1; tokens.md §6 rows 7–11, 18,
 * 19). Each wraps the house control that already has the semantics and the
 * keyboard (TabStrip, Segmented, Switch, NumberInput, Menu) and gives it the
 * reference look through one `cm-` class of the scope sheet
 * (src/styles/community.css, the one sheet of the whole kit) and the
 * utilities the app already ships:
 *
 *   UnderlineTabs   the 3px gold underline under a gold label, across its
 *                   tab less 16px on each side (tokens.md §6 #7)
 *   SegmentedTrack  a raised track whose thumb is the sand selection (D-3)
 *   Toggle          ON is the sand track with the ink knob (D-3)
 *   Stepper         a well holding the figure, two raised 56px keys
 *   ChoiceTiles     radio or checkbox tiles: icon well, title, subtitle,
 *                   the sand selection and the check badge (D-3)
 *   FilterSelect    a filter chip with its icon and chevron that opens the
 *                   options (a sheet on a phone, a menu from a pointer)
 *
 * The selection is never colour alone: the aria state, plus a thumb, a knob
 * place, a check badge or the chosen value written in the chip.
 */
import React, { useRef } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { Menu } from '../../ui/Menu';
import { NumberInput, type NumberInputProps } from '../../ui/NumberInput';
import { Segmented, type SegmentedProps } from '../../ui/Segmented';
import { Switch, type SwitchProps } from '../../ui/Switch';
import { TabStrip, type TabStripProps } from '../../ui/Tabs';
import FilterChip from '../FilterChip';
import { KitIconButton } from './buttons';
import { useKitStrings } from './strings';

/** A two-tab strip that fills its row: the tabs share the width, as the references draw them. */
export type UnderlineTabsProps = Omit<TabStripProps, 'indicatorClassName' | 'activeClassName' | 'idleClassName' | 'fill'>;

/**
 * «طلبات المجتمع / طلباتي»: tabs on the canvas, the gold label and underline.
 * The references draw the line across the chosen tab less 16px on each side
 * (IMG_8468, IMG_8475, IMG_8483: 146.5px under a 71px label in a tab of
 * about 178px at 390), not the whole tab as the house indicator does, and
 * not the label plus a margin (B1FIX-R3-FID-1). So the house indicator is
 * not drawn, and the line is drawn on the tab itself (`inset-x-4`, the tab
 * the nearest positioned box), with no measuring of the words; the label is
 * centred in the tab, so the line is centred under it. It is still ONE
 * element per strip that travels from tab to tab (`layoutId`, the spring of
 * the house strip) and jumps under reduced motion.
 */
export function UnderlineTabs({ className = '', items, value, group, ...rest }: UnderlineTabsProps) {
  const m = useMotion();
  return (
    <TabStrip
      {...rest}
      group={group}
      value={value}
      items={items.map((t) => ({
        ...t,
        badge: undefined,
        label: (
          <>
            {t.label}
            {t.badge}
            {t.id === value && (
              <motion.span
                layoutId={`cm-tab-line-${group}`}
                aria-hidden="true"
                data-tab-line
                className="cm-tab-line absolute inset-x-4 bottom-0 h-[3px] rounded-full bg-gold"
                transition={m.reduced ? { duration: 0 } : m.spring('move')}
              />
            )}
          </>
        ),
      }))}
      indicatorClassName="hidden"
      activeClassName="text-gold"
      idleClassName="text-text-secondary hover:text-text-primary"
      className={`cm-tabs border-b border-border-subtle ${className}`}
    />
  );
}

/** «سريعة / قياسية / دقيقة / فائقة»: the house radio group in the sand track. */
export function SegmentedTrack({ className = '', ...rest }: SegmentedProps) {
  return <Segmented {...rest} className={`cm-seg ${className}`} />;
}

/** «السماح بتنزيل الملف»: the house switch, ON in sand with the ink knob. */
export function Toggle({ className = '', ...rest }: SwitchProps) {
  return <Switch {...rest} className={`cm-switch ${className}`} />;
}

export type StepperProps = Omit<NumberInputProps, 'kind'>;

/** «الكمية»: the house quantity stepper (Arabic digits typed, min and max held) at 48px. */
export function Stepper(props: StepperProps) {
  return (
    <div className="cm-stepper">
      <NumberInput {...props} kind="quantity" />
    </div>
  );
}

export interface ChoiceItem {
  id: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface ChoiceBase {
  items: ChoiceItem[];
  /** The group name read before the options. */
  label: string;
  /** Tiles per row (the reference uses 2 and 3). */
  columns?: 1 | 2 | 3;
  className?: string;
}

export type ChoiceTilesProps =
  | (ChoiceBase & { multiple?: false; value: string | null; onChange: (id: string) => void })
  | (ChoiceBase & { multiple: true; value: string[]; onChange: (ids: string[]) => void });

const COLUMNS = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' } as const;

/**
 * Choice tiles. One answer: a radiogroup, one Tab stop, the arrows move and
 * choose in the writing direction. Several: a group of checkboxes, each its
 * own Tab stop, Space toggles. A chosen tile is the sand fill with ink text
 * and the check badge inside its inline-start top corner, 6px in. A tile with
 * a subtitle holds its icon in a 40px well, the badge over the corner of the
 * well (IMG_8474). A one-line tile centres a bare icon and its title in a body
 * that keeps clear of the badge seat on both sides, so the label stays
 * centred (IMG_8482); the body wraps (the icon above the title, then the
 * title over two lines) when the row is too narrow, a word wider than the
 * body starts beside the seat and runs out at the inline end (the title never
 * shrinks under its longest word), and in a very narrow tile the body starts
 * under the seat instead (`.cm-tile-body`).
 */
export function ChoiceTiles(props: ChoiceTilesProps) {
  const { items, label, columns = 2, className = '' } = props;
  const { dir } = useLanguage();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.filter((it) => !it.disabled);
  const isOn = (id: string) => (props.multiple ? props.value.includes(id) : props.value === id);
  const tabStop = props.multiple ? null : (props.value && enabled.some((it) => it.id === props.value) ? props.value : enabled[0]?.id);

  // TypeScript does not narrow the union through `multiple?: false`, so the
  // two answers are read once, each with its own type.
  const pickOne = props.multiple ? null : (props.onChange as (id: string) => void);
  const press = (id: string) => {
    if (props.multiple) props.onChange(props.value.includes(id) ? props.value.filter((v) => v !== id) : [...props.value, id]);
    else pickOne?.(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.multiple || enabled.length === 0) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const at = Math.max(0, enabled.findIndex((it) => it.id === props.value));
    let next = -1;
    if (e.key === forward || e.key === 'ArrowDown') next = (at + 1) % enabled.length;
    else if (e.key === back || e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = enabled[next].id;
    pickOne?.(id);
    refs.current[items.findIndex((it) => it.id === id)]?.focus();
  };

  return (
    <div
      role={props.multiple ? 'group' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`grid gap-2 ${COLUMNS[columns]} ${className}`}
    >
      {items.map((it, i) => {
        const on = isOn(it.id);
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={props.multiple ? 'checkbox' : 'radio'}
            aria-checked={on}
            tabIndex={props.multiple ? undefined : it.id === tabStop ? 0 : -1}
            disabled={it.disabled}
            data-choice={it.id}
            onClick={() => press(it.id)}
            className={`cm-raised cm-sel relative flex min-h-14 w-full items-center rounded-md px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${it.subtitle ? 'gap-3 text-start' : '@container'}`}
          >
            {it.subtitle ? (
              <>
                {it.icon && (
                  <span aria-hidden="true" className="cm-tile-icon flex size-10 shrink-0 items-center justify-center">
                    {it.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold">{it.title}</span>
                  <span className="cm-sub block text-[12px]">{it.subtitle}</span>
                </span>
              </>
            ) : (
              <span className="cm-tile-body flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-center">
                {it.icon && (
                  <span aria-hidden="true" className="shrink-0">
                    {it.icon}
                  </span>
                )}
                <span className="text-[15px] font-bold leading-tight">{it.title}</span>
              </span>
            )}
            <span aria-hidden="true" className="cm-check absolute size-5 items-center justify-center rounded-full">
              <Check className="h-3 w-3" strokeWidth={3.5} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface FilterOption {
  id: string;
  label: string;
}

export interface FilterSelectProps {
  /** The chip at rest («الحالة») and the list title. */
  label: string;
  icon?: React.ReactNode;
  options: FilterOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  className?: string;
}

/**
 * A filter chip that opens its options. At rest it says the filter («الحالة
 * ⌄»); once a value is chosen it says the value in the sand fill, and a ×
 * beside it clears it. The options are house menu items; the chosen row
 * wears the check and says «محدد» in its name. The options are radio
 * items (`menuitemradio`, the chosen one `aria-checked`, the `radio` field
 * of ui/Menu.tsx), given with the first page that renders a FilterSelect,
 * the requests board (B1FIX-R3-REG-2, community UI plan C3;
 * tests/communityScope.test.ts holds that page to it).
 */
export function FilterSelect({ label, icon, options, value, onChange, className = '' }: FilterSelectProps) {
  const s = useKitStrings();
  const chosen = options.find((o) => o.id === value) ?? null;
  return (
    <span className={`inline-flex items-center ${className}`} data-filter-select={chosen ? chosen.id : ''}>
      <Menu
        label={label}
        align="start"
        items={options.map((o) => ({
          id: o.id,
          label: o.label,
          icon: o.id === value ? <Check className="h-4 w-4" /> : <span className="block h-4 w-4" />,
          hint: o.id === value ? s.selected : undefined,
          radio: { role: 'menuitemradio', 'aria-checked': o.id === value },
          onSelect: () => onChange(o.id),
        }))}
        trigger={(p) => (
          <FilterChip
            {...p}
            on={!!chosen}
            check={false}
            shape="rect"
            icon={icon}
            trailing={<ChevronDown aria-hidden="true" className="h-4 w-4" />}
            aria-label={chosen ? `${label}: ${chosen.label}` : label}
          >
            {chosen ? chosen.label : label}
          </FilterChip>
        )}
      />
      {chosen && <KitIconButton label={`${s.removeFilter}: ${label}`} icon={<X className="h-4 w-4" />} tone="ghost" onClick={() => onChange(null)} />}
    </span>
  );
}
