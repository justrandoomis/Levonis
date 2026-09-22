import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { readPos, writePos } from '../../lib/useRail';

/**
 * Marquee — one endless belt for the home page (the ads strip and the brands
 * belt ride the same mechanics).
 *
 * «الشريط الإعلاني وشريط أبرز العلامات يجب أن يستمر في الحركة لكنه قابل
 *  للتحريك اليدوي — لا تحذف التحريك التلقائي.»
 *
 * BOTH, ALWAYS. The belt drifts on its own AND a finger can move it. The
 * previous version delivered the second and quietly lost the first, and this
 * file is written around the three separate reasons it did.
 *
 * ── 1. NOTHING THAT STOPS THE DRIFT MAY LATCH ──────────────────────────────
 *
 * The drift used to be gated on `!held && !hovered && !focused`, three pieces
 * of React state. Two of them are traps on a touch screen:
 *
 *   * `hovered` was set by `onMouseEnter` and cleared ONLY by `onMouseLeave`.
 *     iPadOS Safari synthesises a mouse-enter for a tap and does not send the
 *     matching leave until the customer taps something ELSE. So the very first
 *     touch — the gesture this belt was rebuilt for — stopped it for good.
 *   * `focused` was set by `onFocusCapture`. Every mark is a link, so a tap
 *     focuses one, and the belt stopped for that reason too.
 *
 * And because `drifting` sat in the effect's dependency array, a latch did not
 * merely pause the loop: it tore the loop down and rebuilt it in a stopped
 * state.
 *
 * So the loop is now mounted ONCE, with an empty dependency array, and reads
 * everything it needs from refs. Hover is honoured only for a real mouse
 * (`pointerType === 'mouse'`). Keyboard focus is read per frame from
 * `:focus-visible` on the active element — a tap does not match it, a Tab
 * does. And "a finger is on it" is not a latch at all but a TIMESTAMP that
 * expires: whatever moves the belt that we did not move ourselves — a drag, a
 * wheel, an iOS momentum fling — refreshes it, and 140 ms after the last such
 * movement the drift simply resumes. A stuck pointer cannot exist because
 * there is no flag to get stuck.
 *
 * ── 2. THE POSITION IS A FLOAT WE KEEP, NOT ONE WE READ BACK ───────────────
 *
 * The drift used to be `el.scrollLeft += speed * dt` — a read-modify-write
 * against the DOM. At 34 px/s that is 0.57 px per frame at 60 Hz and 0.28 px
 * on an iPad's 120 Hz display. An engine that hands `scrollLeft` back
 * quantised to a physical pixel rounds every one of those increments away, the
 * next read returns the same number, and the belt sits still while
 * `requestAnimationFrame` runs happily forever.
 *
 * `posRef` is the real position, in floating point, and it is only ever
 * replaced when something OTHER than us moved the element by more than a
 * pixel. The sub-pixel remainder survives every frame, so the belt moves at
 * the speed it was asked for on any refresh rate.
 *
 * ── 3. DIRECTION IS MEASURED, NOT ASSERTED ─────────────────────────────────
 *
 * This file used to claim "`scrollLeft` IS NEGATIVE IN RTL in every browser
 * this ships to" and derive a sign from the UI language. src/lib/useRail.ts
 * had already disproved that in this same repository: there are THREE
 * incompatible conventions, and it detects which one an engine uses by shoving
 * the real element and watching where it lands, because a synthetic probe
 * lied. `readPos`/`writePos` are that answer, so the drift is written once, in
 * a direction-free space where 0 is the start in both languages, and the
 * Arabic belt cannot silently clamp at zero.
 *
 * ── HOW ENDLESS IS BUILT ───────────────────────────────────────────────────
 *
 * The container and one set are measured (and re-measured on resize). Enough
 * copies are rendered to cover the widest viewport PLUS THREE strides, and the
 * belt parks in the band one stride in. That is what gives a finger a full set
 * of runway in EITHER direction before it can reach a hard edge — and the
 * recentre that recycles it happens only once the gesture is over, never
 * during it, because writing `scrollLeft` mid-fling cancels the fling on iOS.
 *
 * Each set supplies its own internal spacing and its own trailing space, so
 * set N+1 begins precisely one measured stride after set N and the track
 * carries no gap of its own. Moving by a whole stride is therefore
 * pixel-identical to not moving at all, which is what makes the recycle
 * invisible.
 *
 * Speed is pixels per second, not a duration, so a two-item belt and a
 * twenty-item belt drift at the same calm pace. `prefers-reduced-motion` stops
 * the drift entirely and leaves a plain, fully swipeable rail — that is the
 * honest answer and it is not overridden. Copies after the first are
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstSetRef = useRef<HTMLDivElement | null>(null);
  const [copies, setCopies] = useState(3);

  /** One set's width — the stride, and the unit the recycle moves by. */
  const strideRef = useRef(0);
  /** The furthest the scroller can go, cached so the loop reads no layout. */
  const maxRef = useRef(0);
  const rtlRef = useRef(false);
  const speedRef = useRef(speed);
  /** THE position. Float, ours, never replaced by a quantised read-back. */
  const posRef = useRef(0);
  /** What the engine actually took last time we wrote — the baseline that
   *  tells a customer's gesture apart from our own rounding. */
  const wroteRef = useRef(0);
  /** When something we did not cause last moved the belt. */
  const userAtRef = useRef(0);
  const hoverRef = useRef(false);
  /**
   * A FINGER RESTING ON THE BELT, which is not the same fact as a finger
   * MOVING it.
   *
   * The expiring `userAtRef` timestamp below covers every gesture that
   * scrolls — a drag, a wheel, a fling — because those move the element and
   * the loop notices. A finger held STILL scrolls nothing, so that signal
   * never fires, and without this the belt would slide out from under a
   * thumb that is trying to press a mark. The first draft of this rewrite did
   * exactly that.
   *
   * It is a counter cleared from the WINDOW, not a boolean cleared from the
   * element. That is the whole difference between this and the `hovered`
   * latch it replaced: a window-level `pointerup` fires wherever the finger
   * lifts, so it cannot be withheld the way `mouseleave` is. And it expires
   * anyway after five seconds, so even a lost event costs a pause rather
   * than the feature.
   */
  const pressRef = useRef(0);
  const pressAtRef = useRef(0);
  const reducedRef = useRef(false);
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const firstSet = firstSetRef.current;
    if (!container || !firstSet) return;
    const cw = container.clientWidth;
    const sw = firstSet.getBoundingClientRect().width;
    if (cw <= 0 || sw <= 0) return;
    strideRef.current = sw;
    maxRef.current = Math.max(0, container.scrollWidth - cw);
    // The container's OWN direction, not the app language: this is the
    // element `readPos`/`writePos` will be asked about.
    rtlRef.current = getComputedStyle(container).direction === 'rtl';
    // Cover the viewport plus THREE whole sets. One of the spare strides is
    // the runway the recycle consumes off-screen; the other two are what let
    // a finger drag a full set in either direction before meeting an edge.
    setCopies(Math.min(60, Math.max(3, Math.ceil(cw / sw) + 3)));
  }, []);

  useEffect(() => {
    measureRef.current = measure;
  }, [measure]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    const firstSet = firstSetRef.current;
    if (!container || !firstSet) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    ro.observe(firstSet);
    return () => ro.disconnect();
    // `copies` is a dependency because adding sets changes `scrollWidth`, and
    // `maxRef` has to learn the new one. `setCopies` to the same number does
    // not re-render, so this settles after one extra pass rather than looping.
  }, [measure, copies, dir]);

  /**
   * ONE LOOP, MOUNTED ONCE.
   *
   * Empty dependencies on purpose: every value it needs lives in a ref, so
   * nothing a customer does can tear it down and rebuild it stopped. See the
   * header — that teardown was half of why the belt died on the first touch.
   */
  useEffect(() => {
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
    reducedRef.current = mq?.matches ?? false;
    const onPref = () => {
      reducedRef.current = mq?.matches ?? false;
    };
    mq?.addEventListener?.('change', onPref);
    // A window that loses focus cannot still be hovered, and leaving a stale
    // hover behind is exactly the class of bug this rewrite exists to end.
    const onBlur = () => {
      hoverRef.current = false;
      pressRef.current = 0;
    };
    window.addEventListener('blur', onBlur);
    const onRelease = () => {
      pressRef.current = 0;
    };
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);

    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const el = containerRef.current;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!el) return;

      // A stride of zero is a measurement that has not landed yet — an image
      // still loading, a parent still hidden. RETRY from here rather than
      // give up: the old code gated the loop's existence on it, so one early
      // zero left the belt dead with nothing to wake it.
      let stride = strideRef.current;
      if (stride <= 0) {
        measureRef.current();
        stride = strideRef.current;
        if (stride <= 0) return;
      }
      const rtl = rtlRef.current;
      const max = maxRef.current;
      // The band the belt rests in: one stride in, so there is a set of
      // runway on BOTH sides for a finger.
      const lo = Math.min(stride, Math.max(0, (max - stride) / 2));

      const at = readPos(el, rtl);
      // MORE THAN A PIXEL MEANS A HUMAN. Our own write can come back up to one
      // physical pixel away from what we asked for; a drag, a wheel or a fling
      // moves many pixels in a frame. Adopting the position AND the baseline
      // together is what lets the drift resume once they stop — leaving the
      // baseline stale would refresh the timestamp forever.
      if (Math.abs(at - wroteRef.current) > 1) {
        posRef.current = at;
        wroteRef.current = at;
        userAtRef.current = now;
      }

      // A finger that is DOWN owns the belt even while it is perfectly still.
      // Folded into the same timestamp so there is one gate, not two, and so
      // the pause runs on for the same breath after the lift.
      if (pressRef.current > 0 && now - pressAtRef.current < 5000) userAtRef.current = now;

      // The belt belongs to whoever is touching it, and for a breath after —
      // long enough to cover an iOS momentum fling handing back control.
      if (now - userAtRef.current < 140) return;

      // FAILS OPEN. An engine that does not know `:focus-visible` throws here,
      // and the right default is to keep drifting: that is the property the
      // owner asked for, and reduced motion still parks it below.
      let keyboard = false;
      try {
        const active = document.activeElement;
        keyboard = !!active && el.contains(active) && active.matches(':focus-visible');
      } catch {
        keyboard = false;
      }

      if (hoverRef.current || keyboard || reducedRef.current) {
        // Parked, not lost: stay where the belt actually is so resuming does
        // not jump.
        posRef.current = at;
        wroteRef.current = at;
        return;
      }
      if (dt <= 0) return;

      let next = posRef.current + speedRef.current * dt;
      // The recycle, in one expression and off-screen: a whole stride further
      // along is pixel-identical, so folding back into the band changes
      // nothing visible. Modulo rather than a subtraction because an adopted
      // position can be several strides away after a hard fling.
      next = lo + (((next - lo) % stride) + stride) % stride;
      posRef.current = next;
      writePos(el, next, rtl);
      // Record what the engine TOOK, not what we asked for.
      wroteRef.current = readPos(el, rtl);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      mq?.removeEventListener?.('change', onPref);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      // `overflow-x-auto` is the feature, not a detail: it is what gives the
      // finger something to pull.
      className={`lv-mq overflow-x-auto overflow-y-hidden hide-scrollbar ${className}`}
      // `manipulation` is pan-x AND pan-y. This used to be `pan-x` alone,
      // which told the compositor that a touch starting anywhere on the belt
      // could never scroll the PAGE — and the ads strip is a full-width band
      // near the top of the home page, so a customer swiping up from there
      // found it frozen. Horizontal dragging is unaffected.
      style={{ touchAction: 'manipulation', overscrollBehaviorX: 'contain' }}
      onPointerDown={() => {
        // EVERY pointer type, unlike hover: a thumb holding the belt still is
        // exactly the case hover cannot see.
        //
        // `performance.now()` and not `event.timeStamp`: the tick compares
        // this against the timestamp rAF hands it, and older engines put a
        // `Date.now()` epoch on events — which would make the five-second
        // expiry below fire on the first frame, every time.
        pressRef.current += 1;
        pressAtRef.current = performance.now();
      }}
      onPointerEnter={(e) => {
        // A REAL MOUSE ONLY. A touch cannot set this, so it cannot leave it
        // set — which is the defect this whole file was rewritten for.
        if (e.pointerType === 'mouse') hoverRef.current = true;
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') hoverRef.current = false;
      }}
      // NO `onScroll` HANDLER, DELIBERATELY. The recycle used to run from one,
      // writing `scrollLeft` from inside the scroll event — which on iOS
      // cancels a momentum fling, so a hard swipe stopped dead at every stride
      // boundary. The loop notices a customer's scroll by comparing the live
      // position with what it last wrote, which costs nothing and cannot
      // interrupt them.
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
