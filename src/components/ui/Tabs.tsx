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
 *   THE KEYBOARD (WAI-ARIA tabs). The strip is ONE Tab stop — the selected tab
 *   (a roving `tabIndex`) — and the arrow keys move along it in the WRITING
 *   direction (→ goes back in Arabic, as in `Segmented`), wrapping; Home / End
 *   jump to the ends. Selection follows focus. With `panels`, each tab names
 *   the panel it controls (`aria-controls`) and `TabPanels` given the same
 *   `group` is that `role="tabpanel"`, labelled by its tab.
 *
 *   LINK MODE. When the tabs ARE the URL (a workspace section's sub-pages),
 *   give items an `href`: the strip becomes a `<nav>` of real links, the
 *   current one `aria-current="page"` — middle-click, copy-link and Back all
 *   work — with the same travelling indicator and the same arrow keys.
 *
 * The indicator's `layoutId` must be unique per strip, or two strips on one
 * screen animate their underlines into each other. `group` is that id.
 */

import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  /** A count or dot rendered after the label. */
  badge?: React.ReactNode;
  show?: boolean;
  /** Link mode: the tab is this in-app URL. */
  href?: string;
}

export interface TabStripProps {
  items: TabItem[];
  value: string;
  /** Called when a tab is chosen. Optional in link mode, where the link navigates. */
  onChange?: (id: string) => void;
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
  /** Wire each tab to its `TabPanels` panel (same `group`) with aria-controls. */
  panels?: boolean;
}

/** The ids that tie a tab to its panel. */
export const tabId = (group: string, id: string) => `tab-${group}-${id}`;
export const panelId = (group: string, id: string) => `tabpanel-${group}-${id}`;

export function TabStrip({
  items,
  value,
  onChange,
  group,
  indicatorClassName = 'bg-olive',
  activeClassName = 'text-white',
  idleClassName = 'text-text-muted hover:text-zinc-300',
  className = '',
  fill = true,
  label,
  panels = false,
}: TabStripProps) {
  const m = useMotion();
  const { dir } = useLanguage();
  const shown = items.filter((t) => t.show !== false);
  const links = shown.length > 0 && shown.every((t) => !!t.href);
  const refs = useRef<Array<HTMLElement | null>>([]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const count = shown.length;
    if (count === 0) return;
    const at = Math.max(
      0,
      refs.current.findIndex((el) => el === document.activeElement)
    );
    // "Forward" is the strip's own direction: ArrowRight goes back in Arabic.
    // Read from the strip, not the language (W6): the classic storefront draws
    // its strip right-to-left in English too, and the keys must follow what
    // the reader sees.
    const rtl = (getComputedStyle(e.currentTarget).direction || dir) === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === forward) next = (at + 1) % count;
    else if (e.key === back) next = (at - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    // Links move focus only (Enter follows one); tabs select as they focus.
    if (!links) onChange?.(shown[next].id);
  };

  const strip = shown.map((t, i) => {
    const active = t.id === value;
    const classes = `relative ${fill ? 'flex-1 px-2' : 'shrink-0 px-3'} py-3 text-sm font-medium text-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
      active ? activeClassName : idleClassName
    }`;
    const inner = (
      <>
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
      </>
    );
    const setRef = (el: HTMLElement | null) => {
      refs.current[i] = el;
    };
    if (links) {
      return (
        <Link
          key={t.id}
          ref={setRef}
          to={t.href!}
          aria-current={active ? 'page' : undefined}
          data-tab={t.id}
          data-tab-active={active || undefined}
          onClick={() => onChange?.(t.id)}
          className={classes}
        >
          {inner}
        </Link>
      );
    }
    return (
      <button
        key={t.id}
        ref={setRef}
        type="button"
        role="tab"
        id={tabId(group, t.id)}
        aria-selected={active}
        // Only the selected tab's panel is mounted, so only it is referenced:
        // an id that is not in the document is a broken reference.
        aria-controls={panels && active ? panelId(group, t.id) : undefined}
        tabIndex={active ? 0 : -1}
        data-tab={t.id}
        data-tab-active={active || undefined}
        onClick={() => onChange?.(t.id)}
        className={classes}
      >
        {inner}
      </button>
    );
  });

  if (links) {
    return (
      <nav aria-label={label} onKeyDown={onKeyDown} className={`flex ${className}`}>
        {strip}
      </nav>
    );
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`flex ${className}`}>
      {strip}
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
  /** The strip's `group`: makes the body the `tabpanel` its tab controls. */
  group?: string;
}

/**
 * The panel area. It animates on the value changing, in the direction the
 * change implies, and it keeps the OLD panel until the new one has arrived
 * (`mode="wait"`) so the two never overlap into a smear.
 */
export function TabPanels({ value, order, children, className = '', group }: TabPanelsProps) {
  const m = useMotion();
  const previous = useRef(value);
  const from = order.indexOf(previous.current);
  const to = order.indexOf(value);
  // Forward when moving to a later tab. Unknown ids (a first render, a tab that
  // was filtered out) mean no direction rather than a guessed one.
  const forward = from < 0 || to < 0 ? 0 : Math.sign(to - from);
  previous.current = value;

  const travel = m.travel(20) * (forward === 0 ? 0 : forward) * m.dir;
  const wiring = group
    ? { role: 'tabpanel', id: panelId(group, value), 'aria-labelledby': tabId(group, value), tabIndex: 0 }
    : {};

  return (
    <div className={`min-w-0 ${className}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={value}
          data-tab-panel={value}
          {...wiring}
          initial={{ opacity: 0, x: travel }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -travel }}
          transition={m.spring('ui')}
          className="min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
