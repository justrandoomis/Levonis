import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

type Props = React.HTMLAttributes<HTMLDivElement> & { count: number; direction: 'rtl' | 'ltr'; onStep: (step: number, animate?: boolean) => void };
type Drag = { id: number; x: number; y: number; horizontal: boolean };

/** Finger travel is opposite the next item's inline direction. Vertical scroll and taps stay native. */
export function gallerySwipeStep(dx: number, dy: number, width: number, direction: 'rtl' | 'ltr'): number {
  const threshold = Math.max(24, Math.min(64, width * .12));
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * 1.2) return 0;
  return (dx < 0 ? 1 : -1) * (direction === 'rtl' ? -1 : 1);
}

/** A horizontal gesture selects a photo; DissolveImage alone owns the visual transition. */
const GallerySurface = forwardRef<HTMLDivElement, Props>(function GallerySurface({ count, direction, onStep, style, children, ...props }, forwardedRef) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(0);
  const step = useRef(onStep);
  useImperativeHandle(forwardedRef, () => root.current!);
  useEffect(() => { step.current = onStep; }, [onStep]);
  useEffect(() => {
    const el = root.current;
    if (!el || count < 2) return;
    let distance = 0, last = 0, lockedUntil = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      if (now < lockedUntil) return;
      if (now - last > 180 || Math.sign(distance) !== Math.sign(event.deltaX)) distance = 0;
      distance += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1);
      last = now;
      const next = gallerySwipeStep(-distance, 0, el.clientWidth, direction);
      if (next) { distance = 0; lockedUntil = now + 300; step.current(next); }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); drag.current = null; };
  }, [count, direction]);
  const cancel = (el: HTMLDivElement, id: number) => {
    drag.current = null;
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
  };
  return <div {...props} ref={root} style={{ ...style, touchAction: 'pan-y pinch-zoom' }}
    onDragStart={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (!event.isPrimary) { drag.current = null; return; }
      suppressClick.current = 0;
      if (count < 2 || event.button !== 0 || (event.target as HTMLElement).closest('button,a,input,select,textarea')) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.horizontal) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { cancel(event.currentTarget, event.pointerId); return; }
        if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
        start.horizontal = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    }}
    onPointerUp={(event) => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      const next = start.horizontal ? gallerySwipeStep(event.clientX - start.x, event.clientY - start.y, event.currentTarget.clientWidth, direction) : 0;
      cancel(event.currentTarget, event.pointerId);
      if (start.horizontal) suppressClick.current = performance.now() + 400;
      if (next) onStep(next);
    }}
    onPointerCancel={(event) => cancel(event.currentTarget, event.pointerId)}
    onLostPointerCapture={(event) => {
      // Touch begins with implicit capture on the image. Its bubbled loss when
      // this surface takes capture is a handoff, not cancellation of the swipe.
      if (event.target === event.currentTarget && !event.currentTarget.hasPointerCapture(event.pointerId)) drag.current = null;
    }}
    onClickCapture={(event) => {
      if (event.detail > 0 && performance.now() < suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
    }}
    onKeyDown={(event) => {
      props.onKeyDown?.(event);
      if (event.defaultPrevented || count < 2 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      onStep((event.key === 'ArrowLeft') === (direction === 'rtl') ? 1 : -1, false);
    }}
  >{children}</div>;
});
export default GallerySurface;
