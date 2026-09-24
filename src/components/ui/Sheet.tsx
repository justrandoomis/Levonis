/**
 * SHEET v2 — the sheet the merchant workspace's filters, row actions and
 * inspectors need. `import { Sheet } from '../ui/Sheet'`.
 *
 * WHY A SECOND MODULE. The sheet in `Overlay.tsx` makes the WHOLE PANEL the
 * drag surface. That is right for a short confirmation and wrong for anything
 * whose body scrolls: the scroll and the drag fight, and a list flicked to its
 * end throws the sheet away — which is why `Addresses.tsx` gave up and used a
 * plain bottom Overlay. Fixing that in place would change twenty-four existing
 * sheets at once, and `Overlay.tsx` is in every visitor's first load while
 * this gesture code is needed only by lazy screens. So: same `Overlay`
 * underneath (the stack, the focus trap, the keyboard-aware viewport, the
 * dirty guard, symmetric motion), new behaviour here, and with none of the v2
 * props this renders exactly the old sheet.
 *
 * WHAT v2 DOES.
 *
 *   DRAGGED BY ITS HANDLE ONLY. The grabber strip and `header` take the drag,
 *   after the 10px hysteresis (`DRAG_THRESHOLD_PX`), so the header's own
 *   buttons still tap. The body is an ordinary scroller with
 *   `overscroll-contain`: reaching the end of a long list neither scrolls the
 *   page behind nor moves the sheet.
 *
 *   DETENTS. On a phone it rests at `medium` (half the visible screen) or
 *   `large` (all of it but the top edge). Between the two the sheet RESIZES
 *   under the finger — the bottom edge stays on the screen's edge, as on iOS —
 *   past `large` it resists (rubber band), and below the smallest it slides
 *   down toward dismissal. On release the resting point is picked from the
 *   PROJECTED extent (`project` + `nearestSnap`), not from where the finger
 *   stopped: a flick up from medium opens it fully, a flick down from large can
 *   close it outright, a slow drag that is slowing down settles where it is.
 *   The settle spring starts at the finger's velocity.
 *
 *   A KEYBOARD PATH TO THE GESTURE. The grabber is a button when there are two
 *   detents: activating it moves between them. Escape and the scrim close, as
 *   on every window.
 *
 *   ENTER AND EXIT ARE ONE SLIDE, from and back to below the screen edge; a
 *   drag that ends in a dismissal leaves at the speed it was thrown.
 *
 *   REDUCED MOTION: no drag and no travel; it cross-fades, and the grabber
 *   still changes the detent, instantly. From `sm` up it is a centred window
 *   with the same header / body / footer and no detents.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { DRAG_THRESHOLD_PX, SPRING, VelocityTracker, nearestSnap, project, rubberband, useMotion } from '../../lib/motion';
import { useIsPhone } from '../../lib/useMediaQuery';
import { Overlay, Sheet as WholePanelSheet, type SheetProps as WholePanelSheetProps } from './Overlay';

/** A resting height: about half the visible screen, or all of it but the top edge. */
export type SheetDetent = 'medium' | 'large';

export interface SheetProps extends WholePanelSheetProps {
  /** Drag only from the grabber and the header; the body scrolls freely. */
  dragHandle?: boolean;
  /** Heights it rests at on a phone, e.g. `['medium', 'large']`. Implies `dragHandle`. */
  detents?: SheetDetent[];
  /** Which detent it opens at. Default: the smallest listed. */
  defaultDetent?: SheetDetent;
  /** A non-scrolling top region (title, close button) — part of the drag handle. */
  header?: React.ReactNode;
  /** An in-flow action bar under the scrolling body, clear of the home indicator. */
  footer?: React.ReactNode;
}

// Only the two words of the grabber button are new; nobody has written them
// in Sorani, so the Arabic stands in.
const STRINGS = {
  ar: { expand: 'توسيع', collapse: 'تصغير' },
  en: { expand: 'Expand', collapse: 'Collapse' },
  // OWNER: Sorani to be written by hand.
  ckb: { expand: 'توسيع', collapse: 'تصغير' },
} as const;

/** The detent heights for the visible viewport, in px. */
export function detentSizes(visibleHeight: number): Record<SheetDetent, number> {
  const H = Math.max(240, visibleHeight);
  return { medium: Math.round(H * 0.5), large: Math.round(H - Math.max(56, H * 0.08)) };
}

function visibleHeight(): number {
  return typeof window === 'undefined' ? 800 : window.visualViewport?.height ?? window.innerHeight;
}

/**
 * Where a released drag comes to rest: 0 means "dismiss", otherwise one of
 * `heights`. `extent` is how much of the sheet shows above the screen edge;
 * `velocity` is px/s with positive meaning the finger was moving DOWN.
 */
export function restingExtent(extent: number, velocity: number, heights: number[]): number {
  return nearestSnap(extent - project(velocity), [0, ...heights]);
}

interface Drag {
  id: number;
  startY: number;
  startExtent: number;
  min: number;
  max: number;
  heights: number[];
  active: boolean;
  tracker: VelocityTracker;
}

export function Sheet(props: SheetProps) {
  const v2 = !!props.dragHandle || !!props.detents?.length || props.header !== undefined || props.footer !== undefined;
  if (v2) return <SheetV2 {...props} />;
  const { dragHandle: _d, detents: _t, defaultDetent: _dd, header: _h, footer: _f, ...legacy } = props;
  return <WholePanelSheet {...legacy} />;
}

function SheetV2({
  open,
  onClose,
  children,
  panelClassName = '',
  dragHandle: _dragHandle,
  height: _height,
  detents,
  defaultDetent,
  header,
  footer,
  dirty = false,
  ...rest
}: SheetProps) {
  const m = useMotion();
  const { lang } = useLanguage();
  const strings = STRINGS[lang] ?? STRINGS.ar;
  const phone = useIsPhone();
  const draggable = phone && !m.reduced;
  // Smallest first, whatever order the caller listed them in.
  const order = useMemo<SheetDetent[]>(() => (['medium', 'large'] as const).filter((d) => detents?.includes(d)), [detents]);
  const start = defaultDetent && order.includes(defaultDetent) ? defaultDetent : order[0];
  const [sizes, setSizes] = useState(() => detentSizes(visibleHeight()));
  const [detent, setDetent] = useState<SheetDetent | undefined>(start);
  const detentRef = useRef(detent);
  detentRef.current = detent;
  const y = useMotionValue(0);
  const h = useMotionValue<number | string>('auto');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<() => void>(onClose);
  const drag = useRef<Drag | null>(null);
  const setPanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
  }, []);

  // Every opening starts at the default detent, measured for the screen as it
  // is now. (`y` is not touched: the enter slide owns it.)
  useLayoutEffect(() => {
    if (!open) return;
    const next = detentSizes(visibleHeight());
    setSizes(next);
    setDetent(start);
    h.set(phone && start ? next[start] : 'auto');
    // Opening is the only moment this resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A rotation, or the keyboard, changes what "half the screen" is.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setSizes(detentSizes(visibleHeight()));
    const vv = window.visualViewport;
    window.addEventListener('resize', onResize);
    vv?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open || drag.current) return;
    const at = detentRef.current;
    h.stop();
    h.set(phone && at ? sizes[at] : 'auto');
  }, [open, sizes, phone, h]);

  /** Both values spring home together, so the top edge never jumps. */
  const settle = (to: number, fingerVelocity: number, auto: boolean) => {
    const translating = y.get() > 0;
    let pending = 0;
    const finish = () => {
      pending -= 1;
      if (pending === 0 && auto) h.set('auto');
    };
    if (translating) {
      pending += 1;
      animate(y, 0, { ...SPRING.sheet, velocity: fingerVelocity, onComplete: finish });
    }
    const current = h.get();
    if (typeof current === 'number' && current !== to) {
      pending += 1;
      animate(h, to, { ...SPRING.sheet, velocity: translating ? 0 : -fingerVelocity, onComplete: finish });
    }
    if (pending === 0 && auto) h.set('auto');
  };

  const toggle = () => {
    if (order.length < 2) return;
    const next = order[(order.indexOf(detent ?? order[0]) + 1) % order.length];
    setDetent(next);
    if (!phone) return;
    h.stop();
    if (m.reduced) h.set(sizes[next]);
    else animate(h, sizes[next], SPRING.sheet);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!draggable || !panel || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Caught mid-flight, it continues from where it IS (interruptible).
    y.stop();
    h.stop();
    const natural = panel.offsetHeight;
    const heights = order.length ? order.map((d) => sizes[d]) : [natural];
    const current = h.get();
    const height = typeof current === 'number' ? current : natural;
    // An auto-height sheet becomes numeric for the drag and goes back to auto
    // when it settles, so both kinds share one code path.
    if (typeof current !== 'number') h.set(natural);
    const tracker = new VelocityTracker();
    tracker.add(e.clientY, e.timeStamp);
    drag.current = {
      id: e.pointerId,
      startY: e.clientY,
      startExtent: height - y.get(),
      min: heights[0],
      max: heights[heights.length - 1],
      heights,
      active: false,
      tracker,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      // Under the threshold this is still a tap on the header's buttons.
      if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.tracker.add(e.clientY, e.timeStamp);
    const extent = d.startExtent - dy;
    if (extent > d.max) {
      h.set(d.max + rubberband(extent - d.max, d.max));
      y.set(0);
    } else if (extent >= d.min) {
      h.set(extent);
      y.set(0);
    } else {
      h.set(d.min);
      y.set(d.min - extent);
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    const auto = order.length === 0;
    if (!d.active) {
      if (auto) h.set('auto');
      return;
    }
    const velocity = d.tracker.velocity();
    const current = h.get();
    const extent = (typeof current === 'number' ? current : d.max) - y.get();
    const target = restingExtent(extent, velocity, d.heights);
    if (target === 0) {
      // The exit slide takes over from here. A dirty sheet asks first and
      // goes back to rest while it asks.
      closeRef.current();
      if (!dirty) return;
    }
    const to = target === 0 ? d.min : target;
    const next = auto ? undefined : order[d.heights.indexOf(to)];
    if (next) setDetent(next);
    settle(to, velocity, auto);
  };

  const offscreen = sizes.large + 64;
  const panelMotion = phone
    ? {
        ref: setPanel,
        initial: { opacity: m.reduced ? 0 : 1, y: m.reduced ? 0 : offscreen },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: m.reduced ? 0 : 1, y: m.reduced ? 0 : offscreen },
        style: { y, height: h },
      }
    : { ref: setPanel, style: { maxHeight: 'min(85dvh, 44rem)' } };

  const grabber =
    phone && order.length > 1 ? (
      <button
        type="button"
        data-sheet-grabber
        onClick={toggle}
        aria-label={detent === 'large' ? strings.collapse : strings.expand}
        aria-expanded={detent === 'large'}
        className="flex h-7 w-full items-center justify-center rounded-t-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span aria-hidden="true" className="h-1 w-9 rounded-full bg-white/25" />
      </button>
    ) : phone && !m.reduced ? (
      <div className="flex justify-center pt-2.5 pb-1" aria-hidden data-sheet-grabber>
        <span className="h-1 w-9 rounded-full bg-white/25" />
      </div>
    ) : null;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      placement="bottom"
      dirty={dirty}
      panelClassName={`flex w-full flex-col overflow-hidden ${panelClassName}`}
      panelMotion={panelMotion}
      {...rest}
    >
      {(api) => {
        closeRef.current = api.close;
        return (
          <>
            <div
              data-sheet-handle
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              className={`shrink-0 ${draggable ? 'touch-none select-none' : ''}`}
            >
              {grabber}
              {header}
            </div>
            <div
              data-sheet-body
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              style={footer ? undefined : { paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              {typeof children === 'function' ? children(api) : children}
            </div>
            {footer && (
              <div
                data-sheet-footer
                className="shrink-0 border-t border-border-subtle px-4 pt-3"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
              >
                {footer}
              </div>
            )}
          </>
        );
      }}
    </Overlay>
  );
}
