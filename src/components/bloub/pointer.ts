/**
 * WHERE THE USER IS, READ ONCE PER FRAME.
 *
 * The brief's §23 is the hard constraint here: pointer tracking must not touch
 * framework state on a raw pointermove. A `setState` per move is sixty React
 * renders a second on a page that has a thousand other things to do, and it is
 * the single most common way a decorative tracker turns into a performance
 * bug. So this module is a plain object with listeners around it. The rAF loop
 * reads it; nothing subscribes; nothing re-renders.
 *
 * It is equally strict about not interfering. Every listener is PASSIVE, so it
 * can never delay or cancel a scroll, and every one is on the capture phase, so
 * a modal that stops propagation on its own backdrop does not blind the
 * character. Nothing here calls preventDefault, setPointerCapture or
 * stopPropagation — the brief says the tracking must stay passive and must
 * never capture a page gesture, and the way to guarantee that is to have no
 * code capable of it.
 *
 * It also measures nothing. Positions arrive from the events themselves; the
 * character's own position is already known to the loop that draws it.
 */

export type PointerKind = 'mouse' | 'touch';

export interface PointerSample {
  /** Viewport CSS pixels, or null when there is nothing to attend to. */
  x: number;
  y: number;
  /** False before the first event, and after the pointer leaves the window. */
  present: boolean;
  /** A touch device holds its point only while the finger is down; a mouse
   *  leaves its last position behind. See `release` below. */
  kind: PointerKind;
  /** performance.now() of the last real movement. The loop turns this into the
   *  randomised hold-then-fade of §7. */
  movedAt: number;
  /** True while a finger or button is down. */
  down: boolean;
}

const state: PointerSample = { x: 0, y: 0, present: false, kind: 'mouse', movedAt: 0, down: false };

let attached = 0;

/** The current sample. Returned by reference on purpose: this is read once per
 *  animation frame and must not allocate. Treat it as read-only. */
export function readPointer(): Readonly<PointerSample> {
  return state;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function move(event: PointerEvent): void {
  // A coarse pointer that is NOT down is a hover emulated by the browser on
  // tap, which is a lie about where the user's attention is: they touched
  // something and took their finger away. Only a real drag keeps the gaze.
  if (event.pointerType === 'touch' && !state.down) return;
  state.x = event.clientX;
  state.y = event.clientY;
  state.kind = event.pointerType === 'mouse' || event.pointerType === 'pen' ? 'mouse' : 'touch';
  state.present = true;
  state.movedAt = now();
}

function down(event: PointerEvent): void {
  state.down = true;
  state.x = event.clientX;
  state.y = event.clientY;
  state.kind = event.pointerType === 'mouse' || event.pointerType === 'pen' ? 'mouse' : 'touch';
  state.present = true;
  state.movedAt = now();
}

function up(): void {
  state.down = false;
  // The point is LEFT WHERE IT WAS, and `movedAt` is left alone, so the hold
  // in §6 and §7 starts from the last real movement. Clearing it here would
  // snap the eyes back the instant a finger lifted, which is exactly the
  // behaviour the brief rules out.
  state.movedAt = now();
}

function leave(event: PointerEvent): void {
  // relatedTarget is null when the pointer genuinely left the window rather
  // than crossing between two elements inside it.
  if (event.relatedTarget === null) state.present = false;
}

function blur(): void {
  state.present = false;
  state.down = false;
}

/**
 * Start watching. Returns the stopper. Reference-counted, because the
 * character is mounted once but this may reasonably be claimed by more than
 * one owner over a session (the loop, and a test harness).
 */
export function watchPointer(): () => void {
  if (typeof window === 'undefined') return () => {};
  attached += 1;
  if (attached === 1) {
    const passive = { passive: true, capture: true } as const;
    window.addEventListener('pointermove', move, passive);
    window.addEventListener('pointerdown', down, passive);
    window.addEventListener('pointerup', up, passive);
    window.addEventListener('pointercancel', up, passive);
    document.addEventListener('pointerleave', leave, passive);
    window.addEventListener('blur', blur);
  }
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    attached -= 1;
    if (attached > 0) return;
    const passive = { capture: true } as const;
    window.removeEventListener('pointermove', move, passive);
    window.removeEventListener('pointerdown', down, passive);
    window.removeEventListener('pointerup', up, passive);
    window.removeEventListener('pointercancel', up, passive);
    document.removeEventListener('pointerleave', leave, passive);
    window.removeEventListener('blur', blur);
    state.present = false;
    state.down = false;
  };
}

/** Test seam: put the tracker in a known state without dispatching events. */
export function primePointer(next: Partial<PointerSample>): void {
  Object.assign(state, next);
}
