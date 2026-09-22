import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';

/**
 * Marquee — one endless belt for the home page (the ads strip and the brands
 * belt ride the same mechanics).
 *
 * THE BELT IS A SCROLL CONTAINER THAT DRIFTS, NOT AN ANIMATION THAT PAUSES.
 *
 * «في ابرز العلامات ( البراندات ) اجعل المستخدم يسحب البراندات scroll
 * horizontal ليس فقط ان يتوقف — حركه سلسه جدا تكون عند السحب.»
 *
 * It used to be a CSS `translateX` animation inside an `overflow: hidden`
 * box. A finger on it could only PAUSE it: there was no scrollable overflow
 * to drag, so the belt stopped dead under the thumb and went nowhere. The
 * owner asked to be able to move it, and smoothly — and the smoothest
 * horizontal drag on a phone is not one this file can write. It is the one
 * the browser already has: native touch scrolling, with the platform's own
 * momentum, rubber-banding and interruption.
 *
 * So the container scrolls (`overflow-x: auto`, scrollbar hidden), and the
 * drift is `scrollLeft` advanced by a rAF loop instead of a transform. The
 * two are then the same axis rather than two things fighting over the same
 * pixels: a drag interrupts the drift because it moves the very value the
 * drift is writing, a wheel or a trackpad works for free, and the belt
 * resumes from wherever the finger left it rather than snapping back.
 *
 * ENDLESS IS MEASURED, NOT ASSUMED. A fixed copy count broke on the owner's
 * iPad: one brand × 4 copies ≈ 380px of content on a ~2000px screen, so the
 * belt sat in a corner and visibly restarted. The container and one set are
 * measured (and re-measured on resize); enough copies are rendered to cover
 * the widest viewport PLUS one full set, which is what lets the wrap below
 * happen off-screen.
 *
 * THE SEAM IS HIDDEN BY THE STRIDE, exactly as before. Each set supplies its
 * own internal spacing and its own trailing space, so set N+1 begins
 * precisely one measured stride after set N; the track carries no gap of its
 * own. Scrolling past one stride is therefore pixel-identical to being back
 * at zero, and `wrap()` subtracts a whole stride at a moment nothing on
 * screen changes.
 *
 * Speed is pixels per second, not a duration: a two-item belt and a
 * twenty-item belt drift at the same calm pace. Hover, a held finger and
 * focus inside the belt all stop the drift — focus especially, because a
 * keyboard user who lands on a mark that then slides away cannot recover it
 * by moving a finger. `prefers-reduced-motion` stops the drift entirely and
 * leaves a plain, fully usable swipeable rail. Copies after the first are
 * aria-hidden and unfocusable: tests and screen readers meet each real item
 * exactly once.
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
  const strideRef = useRef(0);
  const [stride, setStride] = useState(0);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const firstSet = firstSetRef.current;
    if (!container || !firstSet) return;
    const measure = () => {
      const cw = container.clientWidth;
      const sw = firstSet.getBoundingClientRect().width;
      if (cw <= 0 || sw <= 0) return;
      strideRef.current = sw;
      setStride(sw);
      // Cover the viewport plus one whole set: the spare set is the runway
      // the wrap below consumes, so the jump never happens on screen.
      setCopies(Math.min(60, Math.max(2, Math.ceil(cw / sw) + 1)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(firstSet);
    return () => ro.disconnect();
  }, []);

  /**
   * ONE STRIDE IS THE WHOLE LOOP.
   *
   * Past a full stride the belt is showing set N+1 where it was showing set
   * N — identical pixels — so subtracting a stride from `scrollLeft` changes
   * nothing visible. That is the seam, and it is why the stride has to be the
   * exact measured width of one set rather than a rounded number.
   *
   * `scrollLeft` IS NEGATIVE IN RTL in every browser this ships to, and it is
   * read back through `Math.abs` for that reason alone. Writing it back with
   * the same sign is what keeps the Arabic belt drifting the way the Arabic
   * page reads, rather than mirroring into the English direction.
   */
  const wrap = useCallback((el: HTMLDivElement) => {
    const s = strideRef.current;
    if (s <= 0) return;
    const at = el.scrollLeft;
    if (Math.abs(at) >= s) el.scrollLeft = at - Math.sign(at) * s;
  }, []);

  const drifting = !held && !hovered && !focused;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || stride <= 0) return;
    // The system preference, read once per mount and then watched: a customer
    // can turn it on while the page is open, and a belt that keeps drifting
    // after they did is the setting not working.
    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (() => {
            try {
              return window.matchMedia('(prefers-reduced-motion: reduce)');
            } catch {
              return null;
            }
          })()
        : null;
    let reduced = mq?.matches ?? false;
    const onPref = () => {
      reduced = mq?.matches ?? false;
    };
    mq?.addEventListener?.('change', onPref);

    // RTL scrolls toward negative, LTR toward positive. One sign, used for
    // both the drift and the wrap, so the two can never disagree.
    const sign = dir === 'rtl' ? -1 : 1;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      // `dt` is clamped because a backgrounded tab hands back one enormous
      // delta on return, and an unclamped one would teleport the belt.
      if (drifting && !reduced && dt > 0) el.scrollLeft += sign * speed * dt;
      wrap(el);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      mq?.removeEventListener?.('change', onPref);
    };
  }, [dir, speed, stride, drifting, wrap]);

  const release = () => setHeld(false);

  return (
    <div
      ref={containerRef}
      // `overflow-x-auto` is the feature, not a detail: it is what gives the
      // finger something to pull. `touch-action: pan-x` tells the compositor
      // to own the gesture, which is what keeps the drag at 60fps instead of
      // waiting on a main thread doing anything else.
      className={`lv-mq overflow-x-auto overflow-y-hidden hide-scrollbar ${className}`}
      style={{ touchAction: 'pan-x', overscrollBehaviorX: 'contain' }}
      onPointerDown={() => setHeld(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        release();
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
      // Scrolled by a wheel, a trackpad or a momentum fling the loop is not
      // driving: the wrap has to run on those too, or a hard flick reaches
      // the end of the copies and stops at a hard edge.
      onScroll={(e) => wrap(e.currentTarget)}
    >
      <div className="lv-mq__track flex w-max">
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
