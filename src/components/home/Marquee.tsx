import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';

/**
 * Marquee — one endless belt for the home page (the ads strip and the brands
 * belt ride the same mechanics).
 *
 * ENDLESS IS MEASURED, NOT ASSUMED. A fixed copy count broke on the owner's
 * iPad: one brand × 4 copies ≈ 380px of content on a ~2000px screen, so the
 * belt sat in a corner and visibly restarted. The container and one set are
 * measured (and re-measured on resize); enough copies are rendered to cover
 * the widest viewport plus one full set, and the animation walks EXACTLY one
 * set's stride — so the loop point is pixel-identical and the belt never
 * shows an edge, however few items the store has.
 *
 * The stride must be exact for the seam to vanish: the track itself carries
 * NO gap — each set supplies its own internal spacing and its own trailing
 * space, so set N+1 starts precisely one measured stride after set N.
 *
 * Speed is pixels per second, not a duration: a two-item belt and a
 * twenty-item belt drift at the same calm pace. Hover or a held finger
 * pauses it (stylesheet rules — an inline `animation:` shorthand would beat
 * them with inline-specificity play-state, which bit once already);
 * releasing resumes. prefers-reduced-motion parks it into a plain
 * swipeable rail. Copies after the first are aria-hidden and unfocusable:
 * tests and screen readers meet each real item exactly once.
 */
export default function Marquee({
  renderSet,
  children,
  speed = 36,
  className = '',
}: {
  /** Renders ONE full set of items; `first` marks the only copy that may
   *  carry data attributes and keyboard focus. Use this when copies must
   *  differ (the brands belt); plain `children` otherwise (the ads strip). */
  renderSet?: (first: boolean) => React.ReactNode;
  children?: React.ReactNode;
  /** Belt speed in px/s. */
  speed?: number;
  /** Extra classes for the clipping container (margins, padding). */
  className?: string;
}) {
  const { dir } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const firstSetRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(2);
  const [stride, setStride] = useState(0);
  const [held, setHeld] = useState(false);
  // Two belts share one page; each needs its own keyframes name.
  const anim = `lv-mq-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const firstSet = firstSetRef.current;
    if (!container || !firstSet) return;
    const measure = () => {
      const cw = container.clientWidth;
      const sw = firstSet.getBoundingClientRect().width;
      if (cw <= 0 || sw <= 0) return;
      setStride(sw);
      setCopies(Math.min(60, Math.max(2, Math.ceil(cw / sw) + 1)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(firstSet);
    return () => ro.disconnect();
  }, []);

  const duration = Math.max(10, stride / speed);
  const step = 100 / copies;
  const stop = () => setHeld(false);

  return (
    <div
      ref={containerRef}
      className={`lv-mq overflow-hidden hide-scrollbar${held ? ' is-held' : ''} ${className}`}
      onPointerDown={() => setHeld(true)}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {/* EVERYTHING lives in the stylesheet, duration included: an inline
          `animation:` shorthand carries inline-specificity play-state that
          silently beats the :hover / .is-held pause rules (it did once). */}
      <style>{`
        @keyframes ${anim} { to { transform: translateX(${dir === 'rtl' ? '' : '-'}${step}%); } }
        .${anim} { animation: ${anim} ${duration}s linear infinite; }
        .lv-mq:hover > .lv-mq__track,
        .lv-mq.is-held > .lv-mq__track,
        /* A KEYBOARD USER MUST BE ABLE TO STAY WHERE THEY LANDED. Tabbing into
           the belt focused a mark that then slid out from under the focus
           ring — the ring was correct and the thing it was ringing was gone.
           Hover and hold were handled; focus was not, and focus is the one
           that cannot be recovered by moving a finger. */
        .lv-mq:focus-within > .lv-mq__track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .lv-mq { overflow-x: auto; }
          .lv-mq__track { animation: none !important; }
        }
      `}</style>
      <div className={`lv-mq__track flex w-max${stride > 0 ? ` ${anim}` : ''}`}>
        {Array.from({ length: copies }, (_, c) =>
          c === 0 ? (
            <div key={c} ref={firstSetRef} className="shrink-0">
              {renderSet ? renderSet(true) : children}
            </div>
          ) : (
            <div key={c} aria-hidden className="shrink-0">
              {renderSet ? renderSet(false) : children}
            </div>
          )
        )}
      </div>
    </div>
  );
}
