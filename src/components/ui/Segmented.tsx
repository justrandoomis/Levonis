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
 * indicator and the label only while that option is chosen.
 */
import React, { useRef } from 'react';
import { motion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';

export interface SegmentedItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** A small trailing mark, e.g. "current". */
  badge?: React.ReactNode;
  /** Classes for the moving indicator and the label while this option is chosen. */
  accent?: { indicator: string; text: string };
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

const DEFAULT_ACCENT = { indicator: 'bg-white/10 border-white/20', text: 'text-white' };

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
      className={`grid ${size === 'sm' ? 'h-9 box-border gap-0.5 p-0.5 rounded-xl' : 'gap-1 p-1 rounded-2xl'} border border-white/10 bg-zinc-900/60 ${className}`}
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
            className={`relative min-w-0 px-2 flex items-center justify-center gap-1.5 press-scale transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 disabled:opacity-40 ${
              size === 'sm' ? 'h-full rounded-[10px] text-[12px] font-bold' : 'min-h-11 rounded-xl text-[13px] font-black'
            } ${
              checked ? accent.text : 'text-zinc-400 hover:text-white'
            }`}
          >
            {checked && (
              <motion.span
                // ONE element shared across the options of this group: motion
                // animates it from its old box to its new one instead of
                // fading one out and another in.
                layoutId={`segmented-${group}`}
                data-segmented-indicator
                aria-hidden
                className={`absolute inset-0 ${size === 'sm' ? 'rounded-[10px]' : 'rounded-xl'} border ${accent.indicator}`}
                transition={m.reduced ? { duration: 0 } : m.spring('quick')}
              />
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
