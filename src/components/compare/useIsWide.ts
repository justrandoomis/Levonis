import { useEffect, useState } from 'react';

/**
 * IS THERE ROOM FOR A TABLE? — the one media query this page branches on.
 *
 * THE COMPARISON RENDERS TWO DIFFERENT STRUCTURES, not one structure with
 * different CSS: a real `<table>` when the columns fit, and a card per spec row
 * when they do not (see `SpecTable.tsx` for why). The usual Tailwind trick —
 * render both and hide one with `hidden sm:block` — cannot be used here,
 * because it would put every specification into the DOM twice and read the
 * whole comparison twice to a screen reader. So the branch is made in
 * JavaScript and only one of the two is ever mounted.
 *
 * 640px is Tailwind's `sm`, which is what the rest of this app breaks at.
 *
 * SSR-SAFE AND FIRST-PAINT-SAFE. The initial value is read synchronously from
 * `matchMedia` rather than defaulting to `false` and correcting in an effect:
 * defaulting would flash the phone layout on a desktop for one frame, and on a
 * page whose whole point is a table that is exactly the wrong first impression.
 */
export function useIsWide(minWidthPx = 640): boolean {
  const query = `(min-width: ${minWidthPx}px)`;
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return wide;
}
