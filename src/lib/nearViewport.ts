/**
 * «NEAR THE SCREEN» FOR A PICTURE THAT SHOULD NOT LOAD BEFORE IT IS WANTED
 * (speed audit 2026-10-16: /products downloaded 16 of its 26 card pictures
 * before any scroll, 261 KB on a 1.6 Mbit/s phone, while only 6 were on the
 * screen).
 *
 * Native `loading="lazy"` starts a picture 1,250–2,500 px before it scrolls
 * into view, so a two-column grid of 262 px rows fetched eight rows at once,
 * all sharing the link with the first screen. This starts it `NEAR_PX` before
 * — about one grid row (268 px on a phone) — in the SCROLLER it lives in: the app
 * scrolls inside `#main-scroll-container` (or a shell's `[data-scroll-owner]`),
 * and an observer rooted at the document never sees a picture below the fold
 * of a nested scroller until it is already on screen.
 *
 * One IntersectionObserver per scroller, shared by every picture in it. The
 * callback says whether the picture was ON the screen when it was released
 * (not merely near it), so the caller can skip a fade-in nobody would see
 * start. Without IntersectionObserver (an old browser, the unit tests) the
 * picture is released at once.
 */
export const NEAR_PX = 300;

type Release = (onScreen: boolean) => void;
// Keyed weakly: a scroller that is replaced takes its observer with it.
const byRoot = new WeakMap<Element, IntersectionObserver>();
let byDocument: IntersectionObserver | null = null;
const waiting = new WeakMap<Element, Release>();

/** The element a picture scrolls in: the app's main scroller, a shell's own, else the document. */
export function scrollRootOf(el: Element): Element | null {
  return el.closest('#main-scroll-container, [data-scroll-owner]');
}

/** Call `release` once, when `el` comes within NEAR_PX of its scroller's visible box. Returns a cancel. */
export function whenNear(el: Element, release: Release): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    release(true);
    return () => {};
  }
  const root = scrollRootOf(el);
  let io = root ? byRoot.get(root) : byDocument;
  if (!io) {
    io = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const fn = waiting.get(e.target);
          waiting.delete(e.target);
          obs.unobserve(e.target);
          const box = e.rootBounds;
          const r = e.boundingClientRect;
          fn?.(!box || (r.top < box.bottom - NEAR_PX && r.bottom > box.top + NEAR_PX));
        }
      },
      { root, rootMargin: `${NEAR_PX}px 0px` }
    );
    if (root) byRoot.set(root, io);
    else byDocument = io;
  }
  waiting.set(el, release);
  io.observe(el);
  const observer = io;
  return () => {
    waiting.delete(el);
    observer.unobserve(el);
  };
}
