/**
 * THE PANEL THAT GROWS OUT OF THE SEARCH FIELD — its animated container only.
 *
 * The field, the request, the grey word, the rows and the keyboard all stay
 * in ./LiveSearch.tsx (tests/liveSearchGhost.test.ts pins them there). What
 * lives here is the part that needs the animation library: the surface that
 * grows DOWNWARD from the field's edge with the house spring, follows its
 * rows as they change height, and goes back the way it came. It is a lazy
 * chunk requested the moment the field is touched or focused (`LiveSearch`
 * arms it on `pointerdown`/`focus`), so the header's first paint carries the
 * input and not the motion behind a panel nobody has opened yet.
 *
 * `m` + <MotionFeatures>, not the `motion` proxy: src/lib/motionFeatures.tsx.
 * Under reduced motion it cross-fades and sizes instantly, as before.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import * as Motion from 'motion/react-m';
import { CROSS_FADE, useMotion } from '../../lib/motion';
import { MotionFeatures, useMotionFeaturesFailed } from '../../lib/motionFeatures';

export interface LiveSearchPanelProps {
  /** The field has text and the panel is open. */
  shown: boolean;
  /** The listbox and its footer, rendered by the field. */
  children: React.ReactNode;
}

export default function LiveSearchPanel({ shown, children }: LiveSearchPanelProps) {
  const m = useMotion();
  const atRest = useMotionFeaturesFailed();
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');

  // The panel's height follows its rows, so a new answer grows or shrinks it
  // instead of snapping.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!shown || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  return (
    <MotionFeatures>
      <AnimatePresence>
        {shown && (
          <Motion.div
            key="panel"
            data-testid="search-panel"
            // Grows DOWN out of the field's edge and goes back the way it came.
            initial={atRest ? false : m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height }}
            exit={m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={m.reduced ? { ...CROSS_FADE, height: { duration: 0 } } : m.spring('ui')}
            // Keeps the caret in the field while a row is tapped.
            onMouseDown={(e) => e.preventDefault()}
            className="material pointer-events-auto absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-lg border border-border-subtle shadow-lg"
          >
            <div ref={contentRef}>{children}</div>
          </Motion.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}
