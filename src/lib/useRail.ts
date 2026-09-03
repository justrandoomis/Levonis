/**
 * FLICK PHYSICS FOR A HORIZONTAL RAIL — the gesture half of the house motion
 * system, finally attached to something.
 *
 * src/lib/motion.ts has shipped `project()`, `nearestSnap()`, `rubberband()`,
 * `VelocityTracker` and `DRAG_THRESHOLD_PX` since the motion pass. Only
 * `project()` was ever called (by the sheet). The rest were the right values
 * with nothing using them, which is worse than not having them: the app looked
 * like it had gesture physics and did not.
 *
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * On TOUCH, the browser already implements exactly this — projection, then a
 * landing on the nearest snap point — inside its own fling handler, and it
 * does it on the compositor where no JavaScript can compete. So this hook does
 * not touch a touch fling. What it does for touch is give the browser the two
 * things it needs to do the job: scroll-snap points that are ALIGNED with the
 * rail's bleed padding (`scroll-padding-inline-start`, whose absence made a
 * snapped card sit a padding-width past where it rests at position 0), and
 * `overscroll-behavior-x: contain`, whose absence let a flick at the start of a
 * rail navigate the browser BACK out of the page.
 *
 * With a MOUSE there is no native momentum at all: a drag ends where the
 * cursor stopped, dead. That is the case this hook actually animates —
 * follow-the-finger dragging, a release velocity taken from a short history
 * rather than the last noisy frame, `project()` for where the flick was going,
 * `nearestSnap()` for where it should therefore land, and `rubberband()` for
 * the two ends so a boundary reads as "nothing more here" instead of "frozen".
 *
 * THE FOUR THINGS THAT MAKE THIS HARD, each closed in one place:
 *
 *  1. RTL. `scrollLeft` has three incompatible conventions across engines and
 *     this app is Arabic-first, so every read and write goes through
 *     `readPos`/`writePos` and the rest of the hook works in a direction-free
 *     coordinate where 0 is the start and `max` is the end in both languages.
 *  2. Measurement. Snap points are accumulated from `offsetWidth`, never from
 *     bounding rects: the home rail wraps every card in an `AnimatedItem` that
 *     holds `scale: 0.8` until it scrolls into view, and a rect-based
 *     measurement of an unseen card is wrong by a fifth of its width.
 *  3. Tap versus drag. Under `DRAG_THRESHOLD_PX` nothing is captured, nothing
 *     is prevented, and the card underneath stays a link. Past it, the axis is
 *     locked once — a mostly-vertical gesture belongs to the page, forever.
 *  4. Inertness. Several of these rails become a wrapped grid at `sm`. A hook
 *     still listening there would swallow clicks on a layout it does not own,
 *     so it detaches whenever the element is not actually a scroller.
 */

import { useCallback, useEffect, useRef } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import {
  project,
  nearestSnap,
  rubberband,
  VelocityTracker,
  DRAG_THRESHOLD_PX,
  SPRING,
} from './motion';

// --------------------------------------------------------------- direction

type RtlScroll = 'negative' | 'reverse' | 'default';
let rtlScrollCache: RtlScroll | null = null;

const maxPos = (el: HTMLElement) => Math.max(0, el.scrollWidth - el.clientWidth);

/**
 * Which `scrollLeft` convention this engine uses in RTL, MEASURED ON THE RAIL
 * ITSELF rather than on a synthetic element.
 *
 * The textbook probe — a 1px `overflow:scroll` div with `dir="rtl"`, write 1,
 * see whether it clamps — reports `reverse` in this Chromium while the real
 * rail on the page is plainly `negative`: writing −100 to it lands at −134 and
 * writing +100 clamps to 0. A synthetic element with no snap points, no
 * padding and a 1px box is not the thing being scrolled, and trusting it made
 * every write clamp to zero, so an Arabic rail could be dragged and never
 * moved.
 *
 * So the range is measured where it matters: shove the element hard each way,
 * see which side of zero it can actually reach, and put it back. Cached once
 * conclusively detected — it is an engine property, not an element one.
 */
function rtlScrollType(el: HTMLElement): RtlScroll {
  if (rtlScrollCache) return rtlScrollCache;
  const max = maxPos(el);
  if (max < 1) return 'negative'; // nothing to learn from a rail that fits
  const saved = el.scrollLeft;
  el.scrollLeft = -1e6;
  const lo = el.scrollLeft;
  el.scrollLeft = 1e6;
  const hi = el.scrollLeft;
  el.scrollLeft = saved;

  if (lo < -1) return (rtlScrollCache = 'negative'); // [−max … 0], 0 is the start
  if (hi < 1) return 'negative'; // it moved nowhere: inconclusive, do not cache

  // The range is [0 … max]; the question left is which END is the start. Park
  // at zero and look at the first item: at the start of an RTL rail it sits
  // flush against the RIGHT inner edge of the scrollport.
  const first = el.firstElementChild as HTMLElement | null;
  if (!first) return 'reverse';
  el.scrollLeft = 0;
  const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
  const flush = Math.abs(first.getBoundingClientRect().right - (el.getBoundingClientRect().right - pad)) < 4;
  el.scrollLeft = saved;
  return (rtlScrollCache = flush ? 'reverse' : 'default');
}

/** The scroll position in a direction-free space: 0 = start, max = end. */
export function readPos(el: HTMLElement, rtl: boolean): number {
  if (!rtl) return el.scrollLeft;
  switch (rtlScrollType(el)) {
    case 'negative':
      return -el.scrollLeft;
    case 'reverse':
      return el.scrollLeft;
    default:
      return maxPos(el) - el.scrollLeft;
  }
}

/** The inverse of `readPos`, clamped — a scroller cannot hold an overshoot. */
export function writePos(el: HTMLElement, pos: number, rtl: boolean): void {
  const max = maxPos(el);
  const p = Math.min(max, Math.max(0, pos));
  if (!rtl) {
    el.scrollLeft = p;
    return;
  }
  switch (rtlScrollType(el)) {
    case 'negative':
      el.scrollLeft = -p;
      break;
    case 'reverse':
      el.scrollLeft = p;
      break;
    default:
      el.scrollLeft = max - p;
      break;
  }
}

// ------------------------------------------------------------- measurement

/**
 * Where a card starts, in the same direction-free space.
 *
 * Accumulated from `offsetWidth` and the computed column gap rather than read
 * from bounding rects: rects are transform-affected, and the flagship home
 * rail animates each card's scale on entry, so a rect measurement of a card
 * that has not been seen yet is simply wrong. `offsetWidth` is layout, which
 * is what a snap point actually is.
 */
export function measureSnapPoints(el: HTMLElement, itemSelector?: string): number[] {
  const cs = getComputedStyle(el);
  const gap = parseFloat(cs.columnGap) || 0;
  const kids = itemSelector
    ? Array.from(el.querySelectorAll<HTMLElement>(`:scope ${itemSelector}`))
    : (Array.from(el.children) as HTMLElement[]);
  const max = maxPos(el);
  const points: number[] = [];
  let run = 0;
  for (const kid of kids) {
    const w = kid.offsetWidth;
    if (w === 0) continue; // a display:none item is not a place to rest
    points.push(Math.min(run, max));
    run += w + gap;
  }
  points.push(max); // the end is always reachable
  // Sorted and deduped to the pixel: two points a fraction apart make
  // `nearestSnap` pick arbitrarily between them.
  const sorted = points.sort((a, b) => a - b);
  const out: number[] = [];
  for (const p of sorted) if (out.length === 0 || p - out[out.length - 1] > 1) out.push(p);
  return out;
}

// -------------------------------------------------------------------- hook

export interface RailOptions {
  /** A selector for the items, when the direct children are not them. */
  items?: string;
  /** Lower decelerates faster — 0.99 suits a short rail, 0.998 a long one. */
  decelerationRate?: number;
  /** Snap the landing to a card. Off leaves a free-scrolling rail. */
  snap?: boolean;
  /** Mouse drag-to-scroll. Off for a rail whose ancestor is sticky. */
  drag?: boolean;
}

export interface Rail {
  ref: (node: HTMLDivElement | null) => void;
  /** Move one viewport-width along, direction-free: +1 forward, −1 back. */
  page: (delta: 1 | -1) => void;
}

/**
 * Attach with one line: `const rail = useRail(); … <div ref={rail.ref} …>`.
 */
export function useRail(options: RailOptions = {}): Rail {
  const { items, decelerationRate = 0.998, snap = true, drag = true } = options;
  const reduced = !!useReducedMotion();
  const elRef = useRef<HTMLDivElement | null>(null);
  const pointsRef = useRef<number[]>([]);
  const animRef = useRef<{ stop: () => void } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Read inside listeners that are registered once, so they must not close
  // over a stale value.
  const optsRef = useRef({ items, decelerationRate, snap, drag, reduced });
  optsRef.current = { items, decelerationRate, snap, drag, reduced };

  const page = useCallback((delta: 1 | -1) => {
    const el = elRef.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const target = Math.min(
      maxPos(el),
      Math.max(0, readPos(el, rtl) + delta * el.clientWidth * 0.9)
    );
    if (optsRef.current.reduced) {
      writePos(el, target, rtl);
      return;
    }
    animRef.current?.stop();
    animRef.current = animate(readPos(el, rtl), target, {
      type: 'spring',
      bounce: 0,
      duration: SPRING.ui.duration,
      onUpdate: (p: number) => writePos(el, p, rtl),
    });
  }, []);

  const ref = useCallback((node: HTMLDivElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    elRef.current = node;
    if (!node) return;

    const el = node;
    let dragging = false;
    let committed: boolean | undefined;
    let startX = 0;
    let startY = 0;
    let startPos = 0;
    let virtual = 0;
    let tracker: VelocityTracker | null = null;
    let savedSnapType = '';
    let pointer = -1;

    /** A wrapped grid, a clipped marquee or a rail that fits is not a rail. */
    const isLive = () => {
      const cs = getComputedStyle(el);
      return (
        cs.overflowX !== 'visible' &&
        cs.overflowX !== 'hidden' &&
        cs.flexWrap !== 'wrap' &&
        maxPos(el) >= 1
      );
    };

    const remeasure = () => {
      if (!isLive()) {
        el.removeAttribute('data-rail');
        el.removeAttribute('data-rail-snap');
        el.removeAttribute('data-rail-pos');
        pointsRef.current = [];
        return;
      }
      const cs = getComputedStyle(el);
      // CSS snap measures from the SNAPPORT, which is the padding box. These
      // rails bleed to the screen edge with `-mx-4 px-4`, so without this a
      // snapped card lands a padding-width past where card 0 rests, and the
      // browser and this hook disagree about where a card is.
      el.style.scrollPaddingInlineStart = cs.paddingInlineStart;
      // A flick that reaches the start must not become browser back-navigation.
      el.style.overscrollBehaviorX = 'contain';
      // `scroll-behavior: smooth` would animate every write of a spring frame.
      el.style.scrollBehavior = 'auto';
      pointsRef.current = measureSnapPoints(el, optsRef.current.items);
      el.setAttribute('data-rail', '');
      el.setAttribute('data-rail-snap', pointsRef.current.map((p) => Math.round(p)).join(','));
      publish();
    };

    const publish = () => {
      const rtl = getComputedStyle(el).direction === 'rtl';
      el.setAttribute('data-rail-pos', String(Math.round(readPos(el, rtl))));
    };

    const suspendCssSnap = () => {
      savedSnapType = el.style.scrollSnapType;
      // Chrome re-snaps on every programmatic write; the spring would stutter.
      el.style.scrollSnapType = 'none';
    };
    const restoreCssSnap = () => {
      el.style.scrollSnapType = savedSnapType;
    };

    const applyPosition = (pos: number, rtl: boolean, dir: 1 | -1) => {
      const max = maxPos(el);
      const over = pos < 0 ? pos : pos > max ? pos - max : 0;
      if (over === 0) {
        writePos(el, pos, rtl);
        el.style.transform = '';
        publish();
        return;
      }
      writePos(el, over < 0 ? 0 : max, rtl);
      const rb = optsRef.current.reduced ? 0 : rubberband(over, el.clientWidth);
      // Forward in position space is the opposite direction visually.
      el.style.transform = `translateX(${-rb * dir}px)`;
      publish();
    };

    /**
     * THE NATIVE LINK DRAG, which eats the whole gesture.
     *
     * Every card in these rails is an <a> (and several hold an <img>), and
     * both are natively draggable. Press on one and move ~5px and Chromium
     * starts an HTML5 drag: the pointer stream stops dead after the first
     * pointermove, no further move ever reaches this element, and the click
     * the tap was going to produce is discarded too. Symptom with a mouse: the
     * rail does not scroll AND the card does not open — the gesture vanishes.
     *
     * Suppressed only while a press is live on this rail, so dragging an image
     * out of the page from anywhere else is untouched.
     */
    const onDragStart = (e: DragEvent) => {
      if (pointer !== -1) e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!optsRef.current.drag || e.pointerType !== 'mouse' || e.button !== 0) return;
      if (!isLive()) return;
      animRef.current?.stop();
      animRef.current = null;
      const rtl = getComputedStyle(el).direction === 'rtl';
      dragging = false;
      committed = undefined;
      pointer = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      // The PRESENTATION value, so grabbing a moving rail never jumps.
      startPos = readPos(el, rtl);
      virtual = startPos;
      tracker = new VelocityTracker(100);
      tracker.add(virtual, e.timeStamp);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointer !== e.pointerId || !tracker) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return; // still a tap
        // Locked once and never revisited: a mostly-vertical gesture is the
        // page's, and stealing it half-way is how a scroll fights back.
        if (committed === undefined) committed = Math.abs(dx) > Math.abs(dy);
        if (!committed) {
          pointer = -1;
          tracker = null;
          return;
        }
        dragging = true;
        el.setPointerCapture(e.pointerId);
        el.setAttribute('data-rail-dragging', '');
        el.style.userSelect = 'none';
        suspendCssSnap();
      }
      const rtl = getComputedStyle(el).direction === 'rtl';
      const dir: 1 | -1 = rtl ? -1 : 1;
      virtual = startPos + -dx * dir;
      tracker.add(virtual, e.timeStamp);
      applyPosition(virtual, rtl, dir);
      e.preventDefault();
    };

    const endDrag = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      const wasDragging = dragging;
      const t = tracker;
      pointer = -1;
      tracker = null;
      dragging = false;
      committed = undefined;
      if (!wasDragging || !t) return;

      el.removeAttribute('data-rail-dragging');
      el.style.userSelect = '';
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

      // The click the browser is about to synthesise on the card under the
      // cursor belongs to the drag, not to the card. Eaten in the capture
      // phase, once, and removed on the next tick so a later real click lives.
      const eat = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      el.addEventListener('click', eat, { capture: true, once: true });
      window.setTimeout(() => el.removeEventListener('click', eat, true), 0);

      const rtl = getComputedStyle(el).direction === 'rtl';
      const max = maxPos(el);
      // One last sample AT THE MOMENT OF RELEASE, which is what prunes the
      // window. Without it a drag that stops and rests before the finger lifts
      // still throws: no pointermove fires while the hand is still, so the
      // tracker keeps whatever it last saw and reports the velocity of a
      // gesture that ended half a second ago. Holding still means "put it
      // down here", and it has to mean that.
      t.add(virtual, e.timeStamp);
      const velocity = t.velocity();
      const release = Math.min(max, Math.max(0, virtual));
      el.setAttribute('data-rail-release', String(Math.round(release)));

      // WHERE THE FLICK WAS GOING, then the nearest card to THAT — snapping to
      // the nearest card to where the finger stopped would make a hard throw
      // and a slow nudge land in the same place.
      const projected = release + project(velocity, optsRef.current.decelerationRate);
      const points = pointsRef.current;
      const target = Math.min(
        max,
        Math.max(0, optsRef.current.snap && points.length ? nearestSnap(projected, points) : projected)
      );

      el.style.transform = '';
      if (optsRef.current.reduced) {
        // Reduced motion changes HOW it gets there, never WHERE it lands.
        writePos(el, target, rtl);
        restoreCssSnap();
        publish();
        return;
      }
      // Overshoot is invisible at a wall (a scroller clamps), so the two ends
      // land without bounce; an interior landing keeps the thrown feel.
      const atWall = target <= 0.5 || target >= max - 0.5;
      const spring = atWall ? SPRING.ui : SPRING.momentum;
      animRef.current = animate(readPos(el, rtl), target, {
        type: 'spring',
        bounce: spring.bounce,
        duration: spring.duration,
        velocity,
        onUpdate: (p: number) => {
          writePos(el, p, rtl);
          publish();
        },
        onComplete: () => {
          restoreCssSnap();
          publish();
        },
      });
    };

    const onCancel = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = -1;
      tracker = null;
      dragging = false;
      committed = undefined;
      el.removeAttribute('data-rail-dragging');
      el.style.userSelect = '';
      el.style.transform = '';
      restoreCssSnap();
    };

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('scroll', publish, { passive: true });

    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    const mo = new MutationObserver(remeasure);
    mo.observe(el, { childList: true, subtree: false });
    remeasure();

    cleanupRef.current = () => {
      animRef.current?.stop();
      animRef.current = null;
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('scroll', publish);
    };
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { ref, page };
}
