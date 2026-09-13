/** One event-driven expression controller. It owns no DOM, routes or business
 * data. The existing anchor registry still owns position; Bloub owns drawing.
 * Persistent work uses leases, short reactions expire by a single timer.
 */
export type MascotState = 'idle' | 'loading' | 'typing' | 'navigating' | 'returning' |
  'success' | 'warning' | 'error' | 'notify' | 'tap' | 'arrival' | 'sleep';
export type MascotWork = 'loading' | 'typing' | 'navigating' | 'returning';
export type MascotDirection = Readonly<{ x: number; y: number }>;
export type MascotSnapshot = Readonly<{ state: MascotState; direction: MascotDirection; sequence: number }>;
export const MASCOT_STATES: Record<MascotState, { priority: number; duration: number; loop: boolean }> = {
  error: { priority: 100, duration: 2100, loop: false },
  warning: { priority: 90, duration: 1400, loop: false },
  // A deliberate Home press responds immediately, except during an alert.
  tap: { priority: 85, duration: 210, loop: false },
  loading: { priority: 80, duration: 0, loop: true },
  typing: { priority: 75, duration: 0, loop: true },
  navigating: { priority: 70, duration: 480, loop: false },
  returning: { priority: 70, duration: 480, loop: false },
  notify: { priority: 60, duration: 720, loop: false },
  success: { priority: 50, duration: 620, loop: false },
  arrival: { priority: 40, duration: 320, loop: false },
  idle: { priority: 0, duration: 0, loop: true },
  sleep: { priority: -1, duration: 0, loop: false },
};
const ZERO: MascotDirection = Object.freeze({ x: 0, y: 0 });
export function movementDirection(dx: number, dy: number): MascotDirection {
  const length = Math.hypot(dx, dy);
  return Number.isFinite(length) && length > 0.5 ? { x: dx / length, y: dy / length } : ZERO;
}
export function isMascotState(value: unknown): value is MascotState {
  return typeof value === 'string' && Object.hasOwn(MASCOT_STATES, value);
}
export interface MascotClock {
  now(): number;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
}
const CLOCK: MascotClock = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout };
type Reaction = { state: MascotState; until: number; sequence: number };

export function createMascotController(clock: MascotClock = CLOCK) {
  const listeners = new Set<() => void>();
  const work = new Map<symbol | string, MascotWork>();
  const reactions = new Map<MascotState, Reaction>();
  let visible = true;
  let sequence = 0;
  let direction = ZERO;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: MascotSnapshot = Object.freeze({ state: 'idle', direction, sequence: 0 });

  function publish() {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
    const now = clock.now();
    for (const [key, item] of reactions) if (item.until <= now) reactions.delete(key);
    let selected: MascotState = 'idle';
    let selectedSequence = 0;
    if (visible) {
      for (const state of work.values()) if (MASCOT_STATES[state].priority > MASCOT_STATES[selected].priority) selected = state;
      for (const item of reactions.values()) {
        if (MASCOT_STATES[item.state].priority >= MASCOT_STATES[selected].priority) {
          selected = item.state; selectedSequence = item.sequence;
        }
      }
      const next = Math.min(...[...reactions.values()].map(r => r.until));
      if (Number.isFinite(next)) timer = clock.setTimer(publish, Math.max(1, next - now));
    } else selected = 'sleep';
    if (snapshot.state === selected && snapshot.sequence === selectedSequence && snapshot.direction === direction) return;
    snapshot = Object.freeze({ state: selected, direction, sequence: selectedSequence });
    for (const listener of listeners) listener();
  }
  const api = {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    snapshot: () => snapshot,
    begin(state: MascotWork) {
      const token = Symbol(state); work.set(token, state); publish();
      return () => { if (work.delete(token)) publish(); };
    },
    /** Named activities are for one app-shell owner, never concurrent requests. */
    activity(owner: string, state: MascotWork | null) {
      if (state === null) { if (work.delete(owner)) publish(); }
      else if (work.get(owner) !== state) { work.set(owner, state); publish(); }
    },
    trigger(state: MascotState, durationMs = MASCOT_STATES[state].duration) {
      if (!visible || state === 'sleep' || state === 'idle') return;
      const duration = Number.isFinite(durationMs) && durationMs > 0 ? Math.max(150, Math.min(durationMs, 5000)) : 650;
      reactions.set(state, { state, until: clock.now() + duration, sequence: ++sequence });
      publish();
    },
    look(dx: number, dy: number) { direction = movementDirection(dx, dy); publish(); },
    navigationComplete() {
      work.delete('anchor-travel');
      reactions.delete('navigating'); reactions.delete('returning');
      api.trigger('arrival');
    },
    setVisible(value: boolean) {
      if (visible === value) return;
      visible = value;
      if (!visible) reactions.clear();
      publish();
    },
    dispose() {
      if (timer !== null) clock.clearTimer(timer);
      timer = null; work.clear(); reactions.clear(); listeners.clear();
    },
  };
  return api;
}
export const mascot = createMascotController();

/** A notification counter needs a baseline: existing unread items on login
 * are not new events. Each caller owns its scope and resets on account change. */
export function createUnreadObserver(onNew: () => void = () => mascot.trigger('notify')) {
  let previous: number | null = null;
  return {
    observe(count: number) {
      if (!Number.isFinite(count) || count < 0) return;
      if (previous !== null && count > previous) onNew();
      previous = count;
    },
    reset() { previous = null; },
  };
}
