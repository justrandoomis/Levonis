/** One event-driven expression controller. It owns no DOM, routes or business
 * data. The existing anchor registry still owns position; Bloub owns drawing.
 * Persistent work uses leases, short reactions expire by a single timer.
 */
export type MascotState = 'idle' | 'loading' | 'typing' | 'navigating' | 'returning' |
  'success' | 'warning' | 'error' | 'notify' | 'tap' | 'arrival' | 'sleep' |
  /** Noticing something worth noticing: a primary control under the pointer,
   *  or the pointer arriving on the character itself. The quietest reaction
   *  there is — it must be able to happen constantly without becoming noise. */
  'curious' |
  /** Taken aback: a quantity that jumped, an item removed. Short, and never
   *  alarmed — being surprised is not the same as being worried. */
  'surprised' |
  /** The order went through. The one moment the character is allowed to be
   *  more than pleased, and still only just. */
  'celebrate';
/**
 * States that are HELD rather than played.
 *
 * `curious` belongs here and not among the timed reactions: a pointer can rest
 * on a button for as long as it likes, and a character that noticed it for
 * 700ms and then looked away while the pointer was still there would read as
 * having lost interest rather than as paying attention. It is released when
 * the pointer leaves, by the same owner that claimed it.
 */
export type MascotWork = 'loading' | 'typing' | 'navigating' | 'returning' | 'curious';
export type MascotDirection = Readonly<{ x: number; y: number }>;
export type MascotSnapshot = Readonly<{ state: MascotState; direction: MascotDirection; sequence: number }>;
/**
 * THE ORDER REACTIONS ARE ALLOWED TO WIN IN.
 *
 * The brief asks for semantic priority rather than last-writer-wins, and the
 * ladder below is that policy stated once. Reading downwards: a real failure
 * outranks everything, work in progress outranks the journey it interrupts,
 * a journey outranks a deliberate press, a press outranks an outcome, and an
 * outcome outranks merely having noticed something. Curiosity sits one step
 * above idle precisely because it happens all the time — a pointer crossing
 * the screen must never be able to interrupt a success, an error or a page
 * change, and at priority 10 it cannot.
 */
export const MASCOT_STATES: Record<MascotState, { priority: number; duration: number; loop: boolean }> = {
  error: { priority: 100, duration: 2100, loop: false },
  warning: { priority: 90, duration: 1400, loop: false },
  // A deliberate Home press responds immediately, except during an alert.
  tap: { priority: 85, duration: 210, loop: false },
  loading: { priority: 80, duration: 0, loop: true },
  typing: { priority: 75, duration: 0, loop: true },
  navigating: { priority: 70, duration: 480, loop: false },
  returning: { priority: 70, duration: 480, loop: false },
  // An order is the largest thing that happens in this app, so it outranks
  // both the notification it will produce and the ordinary success it is a
  // kind of. It is also the longest: 1.5s of being pleased, then calm.
  celebrate: { priority: 65, duration: 1500, loop: false },
  notify: { priority: 60, duration: 720, loop: false },
  // Surprise is brief by nature. Held any longer it stops being a reaction
  // and becomes a mood, and the character has no business being in a mood.
  surprised: { priority: 55, duration: 760, loop: false },
  success: { priority: 50, duration: 620, loop: false },
  arrival: { priority: 40, duration: 320, loop: false },
  // Noticing. Loops, because a pointer can rest on a button for as long as it
  // likes and the character should go on attending to it — the anticipation
  // §10 describes is a HELD state, not a flash.
  curious: { priority: 10, duration: 0, loop: true },
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
const CLOCK: MascotClock = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id) };
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
  /** The quantity RUN, not the last press — see `quantity` below. */
  const quantityRun = { streak: 0, at: 0, peak: 0 };

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

    /**
     * §11 — QUANTITY, WITH ESCALATION.
     *
     * The brief is precise about what makes this work and what makes it
     * tiresome: «Do not trigger a dramatic reaction on every single + press»
     * and «Use escalation based on interaction context». So the controller
     * remembers the run rather than the press.
     *
     * A single step up is worth a glance and nothing more. It takes a RUN of
     * them, or a jump the user did not arrive at one tap at a time, or a
     * quantity that is simply a lot, before the character is taken aback — and
     * then it is taken aback once. Pressing + a fourth time after that changes
     * nothing, because it has already said the thing it had to say.
     *
     * Stepping DOWN says nothing at all. It lets whatever was on the face
     * expire on its own, which reads as relaxing; a reaction to a decrement
     * would mean the character commenting on every correction the user makes.
     */
    quantity(next: number, previous: number) {
      if (!Number.isFinite(next) || !Number.isFinite(previous)) return;
      const now = clock.now();
      const jump = next - previous;
      // A gap resets the run: two presses a minute apart are not a run.
      if (now - quantityRun.at > 4000 || jump <= 0) quantityRun.streak = 0;
      quantityRun.at = now;
      if (jump <= 0) { quantityRun.peak = next; return; }
      quantityRun.streak += 1;
      const surprising =
        jump >= 3 ||                              // arrived in one move
        next >= 5 ||                              // simply a lot
        (quantityRun.streak >= 3 && next > quantityRun.peak); // kept going
      quantityRun.peak = Math.max(quantityRun.peak, next);
      // Both of these are reactions, so the priority ladder decides whether
      // they are seen at all — a quantity change during a failed request does
      // not get to interrupt the failure.
      api.trigger(surprising ? 'surprised' : 'curious', surprising ? 760 : 420);
    },

    /**
     * WHAT ACTUALLY HAPPENED, as the face should read it.
     *
     * One door for every real application outcome, so a call site says what
     * occurred rather than which animation to play. Which expression that
     * becomes is a decision this module owns and can change; if every caller
     * named a state directly, it could not.
     */
    outcome(kind: 'added' | 'removed' | 'ordered' | 'failed' | 'saved' | 'rejected') {
      switch (kind) {
        case 'added': return api.trigger('success');
        case 'saved': return api.trigger('success', 480);
        // Removing something is a small surprise, not a disappointment: the
        // user asked for it. The character notices; it does not sulk.
        case 'removed': return api.trigger('surprised', 520);
        case 'ordered': return api.trigger('celebrate');
        case 'failed': return api.trigger('error');
        case 'rejected': return api.trigger('warning');
      }
    },
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
      quantityRun.streak = 0; quantityRun.at = 0; quantityRun.peak = 0;
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
