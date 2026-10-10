/**
 * SEGMENTED — a radio group drawn as one pill, with an indicator that MOVES.
 *
 * The tier selector on /subscription was the only pill control in the app,
 * written inline as a role=tablist grid whose highlight was destroyed under
 * one option and constructed under the next. A tab strip is the wrong role
 * for it anyway: choosing PLUS or PRO does not reveal a panel, it changes a
 * value — that is a radio group, and a screen reader should say so.
 *
 * WHAT THIS DOES.
 *
 *   ONE INDICATOR that travels. `layoutId` makes motion animate the same box
 *   from the old option to the new one as a spring, so it is interruptible:
 *   tap three options quickly and it chases, it does not queue. Under reduced
 *   motion it jumps.
 *
 *   EQUAL COLUMNS, so PLUS / PRIME / PRO fit a 360px phone without wrapping,
 *   and every option is at least 44px tall.
 *
 *   REAL RADIO SEMANTICS: role=radiogroup / role=radio / aria-checked, a
 *   roving tabindex, and arrow keys that follow the writing direction.
 *
 * Each option may carry its own accent (the tier's colour), applied to the
 * label only while that option is chosen.
 *
 * CLAY (docs/DECISIONS.md row 209): the track is a well sunk into its
 * surface, and the indicator is one lifted thumb in the raised fill — the
 * platform's own exception to "selection is a press". One neutral thumb for
 * every option: an accent tints the label, never the thumb. Every label has
 * the same weight, so choosing one never reflows a Sorani row.
 */
import React, { useRef } from 'react';
// `m`, not the `motion` proxy: this control is in the eager chunk (the
// «اللغة والمظهر» sheet), and the layout feature its indicator needs arrives
// through <MotionFeatures> the first time a group renders (src/lib/motionFeatures.tsx).
import * as Motion from 'motion/react-m';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';

export interface SegmentedItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** A small trailing mark, e.g. "current". */
  badge?: React.ReactNode;
  /** Classes for the label while this option is chosen (the thumb stays neutral clay). */
  accent?: { text: string };
  disabled?: boolean;
}

export interface SegmentedProps {
  items: SegmentedItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the whole group. */
  label: string;
  /** Unique per control on a screen — it namespaces the shared-layout indicator. */
  group: string;
  className?: string;
  /** Stamps every option with this data attribute = its id, for probes. */
  dataAttr?: string;
  /**
   * `md` (the default, unchanged): 44px options, 13px black — the tier picker
   * and every control that is the main decision on its screen.
   * `sm`: a 36px TRACK (border and padding included), 12px bold — for a
   * FILTER that sits beside other controls on one row (the wallet's «الكل /
   * إيداع / سحب»), where a 44px pill per option made the list's toolbar
   * taller than the rows it filters. The height is the track's, not the
   * option's: a 36px option inside the 2px padding and 1px border drew a 42px
   * control beside the 36px (`h-9`) select and search button it sits with.
   * The options fill the track, so all three line up.
   */
  size?: 'md' | 'sm';
}

const DEFAULT_ACCENT = { text: 'text-text-primary' };

export function Segmented({ items, value, onChange, label, group, className = '', dataAttr, size = 'md' }: SegmentedProps) {
  const m = useMotion();
  const { dir } = useLanguage();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.filter((it) => !it.disabled);

  // Every keyboard change goes through here: the value AND the focus move
  // together, so the roving tabindex never leaves focus on an unchecked
  // option (Home/End used to change the value and leave focus behind).
  const choose = (id: string) => {
    onChange(id);
    const idx = items.findIndex((it) => it.id === id);
    refs.current[idx]?.focus();
  };

  const move = (from: string, step: number) => {
    if (enabled.length === 0) return;
    const i = Math.max(0, enabled.findIndex((it) => it.id === from));
    choose(enabled[(i + step + enabled.length) % enabled.length].id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // "Forward" is the writing direction: ArrowRight goes back in Arabic.
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward || e.key === 'ArrowDown') {
      e.preventDefault();
      move(value, 1);
    } else if (e.key === back || e.key === 'ArrowUp') {
      e.preventDefault();
      move(value, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (enabled[0]) choose(enabled[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = enabled[enabled.length - 1];
      if (last) choose(last.id);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-segmented={group}
      onKeyDown={onKeyDown}
      className={`grid ${size === 'sm' ? 'h-9 box-border gap-0.5 p-0.5' : 'gap-1 p-1'} rounded-full lv-well border border-border-subtle ${className}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))` }}
    >
      {items.map((it, idx) => {
        const checked = it.id === value;
        const accent = it.accent ?? DEFAULT_ACCENT;
        const stamp = dataAttr ? { [dataAttr]: it.id } : undefined;
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={it.disabled}
            onClick={() => onChange(it.id)}
            {...stamp}
            className={`relative min-w-0 px-2 flex items-center justify-center gap-1.5 rounded-full font-bold press-scale transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 ${
              // `sm` DRAWS 30px and HITS 44px: a transparent ::after reaches 7px past the track above and below (W6).
              size === 'sm' ? "h-full text-[12px] after:absolute after:inset-x-0 after:-inset-y-[7px] after:content-['']" : 'min-h-11 text-[13px]'
            } ${
              checked ? accent.text : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {checked && (
              <MotionFeatures>
                <Motion.span
                  // ONE element shared across the options of this group: motion
                  // animates it from its old box to its new one instead of
                  // fading one out and another in.
                  layoutId={`segmented-${group}`}
                  data-segmented-indicator
                  aria-hidden
                  className="absolute inset-0 rounded-full border border-border-subtle bg-surface-raised shadow-1"
                  transition={m.reduced ? { duration: 0 } : m.spring('quick')}
                />
              </MotionFeatures>
            )}
            <span className="relative z-10 flex items-center justify-center gap-1.5 min-w-0">
              {it.icon}
              <span className="truncate">{it.label}</span>
              {it.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
