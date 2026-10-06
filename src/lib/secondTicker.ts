/**
 * THE ONE 1 Hz HEARTBEAT every live clock on the page shares.
 *
 * It used to live inside `components/ui/Countdown.tsx` (the offer clocks).
 * The Quick Buy countdown needs the same beat in the bottom navigation, which
 * is in every visitor's first paint, and importing the offer clock's module
 * there would have pulled its day-count wording along with it. So the beat
 * lives here, with no words and no React, and both clocks subscribe to it:
 * a page showing an offer card and a Quick Buy session wakes up once a
 * second, not twice.
 *
 * Started by the first subscriber, stopped by the last — a page without a
 * clock never pays for one. The beat only says "a second passed"; every clock
 * computes its own remaining time from an absolute deadline, so a throttled
 * background tab that skips beats still shows the right time on the next one.
 */
type Beat = (now: number) => void;

const subscribers = new Set<Beat>();
let timer: ReturnType<typeof setInterval> | null = null;
let last = Date.now();

/** Subscribe to the shared beat; returns the unsubscribe. */
export function subscribeSecond(fn: Beat): () => void {
  subscribers.add(fn);
  if (timer === null) {
    // A beat that was stopped resumes from now, not from when it last ran.
    last = Date.now();
    timer = setInterval(() => {
      last = Date.now();
      for (const s of subscribers) s(last);
    }, 1000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The time of the latest beat (or of the moment the beat started). */
export function lastSecond(): number {
  return last;
}
