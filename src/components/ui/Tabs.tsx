/**
 * TABS — an indicator that MOVES, and content that arrives from the side it
 * came from.
 *
 * WHAT WAS WRONG. Every tab strip in the app drew its indicator as a child of
 * the active button:
 *
 *   {active === 'products' && <div className="absolute bottom-0 ... bg-olive" />}
 *
 * which means the underline does not move — it is destroyed under one tab and
 * constructed under another. There is no motion at all, so there is nothing to
 * tell a person that these three things are one row and they just moved along
 * it. The bodies were worse: `{tab === 'products' && <ProductsTab/>}` swaps the
 * whole panel in a single frame with no direction, so nothing says whether you
 * went forwards or back.
 *
 * WHAT THIS DOES.
 *
 *   THE INDICATOR IS ONE ELEMENT that travels. `layoutId` makes motion animate
 *   the same box from where it was to where it now is, as a spring — so it is
 *   interruptible: tap three tabs quickly and it chases, it does not queue.
 *
 *   THE BODY HINTS THE DIRECTION. Going forward, the new panel comes in from
 *   the forward side and the old one leaves to the back side; going back, both
 *   reverse. Apple's rule: intermediate motion should telegraph the outcome.
 *   The sign comes from `useMotion().dir`, so in Arabic "forward" is leftward —
 *   a hardcoded positive x would be backwards for most of this app's users.
 *
 *   REDUCED MOTION. The indicator jumps (no layout animation) and the body
 *   cross-fades in place. Both still change, so the tab change is still legible
 *   without anything travelling.
 *
 * The indicator's `layoutId` must be unique per strip, or two strips on one
 * screen animate their underlines into each other. `group` is that id.
 */

import React, { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useMotion } from '../../lib/motion';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  /** A count or dot rendered after the label. */
  badge?: React.ReactNode;
  show?: boolean;
}

export interface TabStripProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Unique per strip — it namespaces the shared-layout indicator. */
  group: string;
  /** Accent classes for the moving indicator. */
  indicatorClassName?: string;
  /** Classes for the active label. */
  activeClassName?: string;
  /** Classes for an inactive label. */
  idleClassName?: string;
  className?: string;
  /** Equal-width tabs (a three-tab row) vs natural width (a scrolling row). */
  fill?: boolean;
  label?: string;
}

export function TabStrip({
  items,
  value,
  onChange,
  group,
  indicatorClassName = 'bg-olive',
  activeClassName = 'text-white',
  idleClassName = 'text-zinc-500 hover:text-zinc-300',
  className = '',
  fill = true,
  label,
}: TabStripProps) {
  const m = useMotion();
  const shown = items.filter((t) => t.show !== false);

  return (
    <div role="tablist" aria-label={label} className={`flex ${className}`}>
      {shown.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-tab={t.id}
            data-tab-active={active || undefined}
            onClick={() => onChange(t.id)}
            className={`relative ${fill ? 'flex-1' : 'shrink-0 px-3'} py-3 text-sm font-medium text-center whitespace-nowrap transition-colors ${
              active ? activeClassName : idleClassName
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {t.badge}
            </span>
            {active && (
              <motion.span
                // ONE element, shared across every tab in this strip: motion
                // animates it from its old box to its new one instead of
                // fading one out and another in.
                layoutId={`tab-indicator-${group}`}
                data-tab-indicator
                className={`absolute bottom-0 start-0 end-0 h-0.5 rounded-t-full ${indicatorClassName}`}
                transition={m.reduced ? { duration: 0 } : m.spring('move')}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- the bodies

export interface TabPanelsProps {
  value: string;
  /** Tab ids in visual order — the delta between two decides the direction. */
  order: string[];
  children: React.ReactNode;
  className?: string;
}

/**
 * The panel area. It animates on the value changing, in the direction the
 * change implies, and it keeps the OLD panel until the new one has arrived
 * (`mode="wait"`) so the two never overlap into a smear.
 */
export function TabPanels({ value, order, children, className = '' }: TabPanelsProps) {
  const m = useMotion();
  const previous = useRef(value);
  const from = order.indexOf(previous.current);
  const to = order.indexOf(value);
  // Forward when moving to a later tab. Unknown ids (a first render, a tab that
  // was filtered out) mean no direction rather than a guessed one.
  const forward = from < 0 || to < 0 ? 0 : Math.sign(to - from);
  previous.current = value;

  const travel = m.travel(20) * (forward === 0 ? 0 : forward) * m.dir;

  return (
    <div className={`min-w-0 ${className}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={value}
          data-tab-panel={value}
          initial={{ opacity: 0, x: travel }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -travel }}
          transition={m.spring('ui')}
          className="min-w-0"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
